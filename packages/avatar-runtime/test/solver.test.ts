import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { createDefaultRecipe, feetInchesToCm, poundsToKg } from "@tpb/recipe";
import type { CharacterRecipe } from "@tpb/recipe";

import { parseManifest } from "../src/manifest.ts";
import { solveMorphWeights, yearsToAgeDial } from "../src/solver.ts";

/**
 * Tests run against the real generated manifest rather than a fixture. That is
 * deliberate: it means these tests fail if the asset pipeline changes shape,
 * which is exactly when the solver needs revisiting.
 */
const MANIFEST_PATH = fileURLToPath(
  new URL("../../../assets/dist/basemesh.manifest.json", import.meta.url),
);
const manifest = parseManifest(JSON.parse(readFileSync(MANIFEST_PATH, "utf8")));

const withBody = (patch: Partial<CharacterRecipe["body"]>): CharacterRecipe => {
  const base = createDefaultRecipe();
  return { ...base, body: { ...base.body, ...patch } };
};

test("the generated manifest is well formed", () => {
  assert.equal(manifest.rig.name, "mixamo");
  assert.equal(manifest.rig.bones, 52);
  assert.ok(manifest.morphs.length >= 19);
  assert.ok(manifest.neutralHeightCm > 100 && manifest.neutralHeightCm < 250);
});

test("every morph in the manifest gets a weight", () => {
  const { weights } = solveMorphWeights(createDefaultRecipe(), manifest);
  for (const morph of manifest.morphs) {
    assert.ok(morph.name in weights, `missing weight for ${morph.name}`);
    assert.ok(Number.isFinite(weights[morph.name]), `${morph.name} is not finite`);
  }
});

test("requested height is achieved exactly", () => {
  for (const heightCm of [150, 160, 175, 185, 195, 203.2]) {
    const solved = solveMorphWeights(withBody({ heightCm }), manifest);
    assert.ok(
      Math.abs(solved.resultingHeightCm - heightCm) < 0.01,
      `wanted ${heightCm}, got ${solved.resultingHeightCm}`,
    );
    assert.equal(solved.heightClamped, false, `${heightCm} should be reachable`);
  }
});

test("the intended cast is reachable at its gender extremes", () => {
  const cast: Array<[number, number, number]> = [
    // height cm, mass kg, gender
    [feetInchesToCm(4, 11), poundsToKg(95), 0],
    [feetInchesToCm(6, 8), poundsToKg(265), 1],
    [feetInchesToCm(5, 9), poundsToKg(160), 0.5],
  ];
  for (const [heightCm, massKg, gender] of cast) {
    const solved = solveMorphWeights(withBody({ heightCm, massKg, gender }), manifest);
    assert.equal(solved.heightClamped, false, `${heightCm}cm gender=${gender} clamped`);
    assert.ok(Math.abs(solved.resultingHeightCm - heightCm) < 0.01);
  }
});

test("height compensates for gender changing stature", () => {
  // Gender morphs move height by ~7 cm, so the height morph must differ between
  // a feminine and a masculine character who both asked for 175 cm.
  const feminine = solveMorphWeights(withBody({ gender: 0, heightCm: 175 }), manifest);
  const masculine = solveMorphWeights(withBody({ gender: 1, heightCm: 175 }), manifest);

  assert.ok(Math.abs(feminine.resultingHeightCm - 175) < 0.01);
  assert.ok(Math.abs(masculine.resultingHeightCm - 175) < 0.01);
  assert.notEqual(
    feminine.weights["height_tall"],
    masculine.weights["height_tall"],
    "gender should change how much height morph is needed",
  );
});

test("only one side of each bipolar axis is active at a time", () => {
  for (const gender of [0, 0.25, 0.5, 0.75, 1]) {
    const { weights } = solveMorphWeights(withBody({ gender }), manifest);
    const both = weights["gender_feminine"]! > 0 && weights["gender_masculine"]! > 0;
    assert.ok(!both, `both gender morphs active at gender=${gender}`);
  }
});

test("a neutral gender activates neither gender morph", () => {
  const { weights } = solveMorphWeights(withBody({ gender: 0.5 }), manifest);
  assert.equal(weights["gender_feminine"], 0);
  assert.equal(weights["gender_masculine"], 0);
});

test("even ancestry activates no ancestry morph", () => {
  const { weights } = solveMorphWeights(createDefaultRecipe(), manifest);
  for (const name of ["ancestry_african", "ancestry_asian", "ancestry_caucasian"]) {
    assert.ok(Math.abs(weights[name]!) < 1e-9, `${name} was ${weights[name]}`);
  }
});

test("ancestry weights sum to zero, so the blend is not double counted", () => {
  const { weights } = solveMorphWeights(
    withBody({ ancestry: { african: 1, asian: 0, caucasian: 0 } }),
    manifest,
  );
  const total =
    weights["ancestry_african"]! + weights["ancestry_asian"]! + weights["ancestry_caucasian"]!;
  assert.ok(Math.abs(total) < 1e-9, `ancestry weights summed to ${total}`);
  assert.ok(weights["ancestry_african"]! > 0);
});

test("height stays exact even when ancestry shifts stature", () => {
  // The ancestry morphs move height by +8 and -10 cm, so this is a real test of
  // the height solve rather than a no-op.
  const solved = solveMorphWeights(
    withBody({ heightCm: 180, ancestry: { african: 1, asian: 0, caucasian: 0 } }),
    manifest,
  );
  assert.ok(
    Math.abs(solved.resultingHeightCm - 180) < 0.01,
    `got ${solved.resultingHeightCm}`,
  );
});

test("unreachable heights are clamped and reported, not silently wrong", () => {
  // A 13-year-old body cannot be stretched to 240 cm.
  const solved = solveMorphWeights(withBody({ ageYears: 13, heightCm: 249 }), manifest);
  assert.equal(solved.heightClamped, true);
  assert.ok(solved.resultingHeightCm < 249);
});

test("weights stay within the range Babylon expects", () => {
  for (const gender of [0, 0.5, 1]) {
    for (const heightCm of [145, 175, 205]) {
      for (const massKg of [45, 75, 120]) {
        const { weights } = solveMorphWeights(
          withBody({ gender, heightCm, massKg }),
          manifest,
        );
        for (const [name, weight] of Object.entries(weights)) {
          // Ancestry may legitimately go negative; everything else is 0..1.
          const floor = name.startsWith("ancestry_") ? -1 : 0;
          assert.ok(
            weight >= floor && weight <= 1,
            `${name}=${weight} out of range at ${gender}/${heightCm}/${massKg}`,
          );
        }
      }
    }
  }
});

test("age maps onto MakeHuman's piecewise dial", () => {
  assert.ok(Math.abs(yearsToAgeDial(25, manifest) - 0.5) < 1e-9, "25 years is the midpoint");
  assert.ok(Math.abs(yearsToAgeDial(13, manifest) - 0.25) < 1e-9, "13 years sits at 0.25");
  assert.equal(yearsToAgeDial(90, manifest), 1);
  assert.ok(yearsToAgeDial(120, manifest) <= 1, "clamped above the max");
  assert.ok(yearsToAgeDial(0, manifest) >= 0, "clamped below the min");
});

test("age dial is monotonic", () => {
  let previous = -1;
  for (let years = 13; years <= 100; years++) {
    const dial = yearsToAgeDial(years, manifest);
    assert.ok(dial >= previous, `dial went backwards at ${years}`);
    previous = dial;
  }
});

test("heavier characters get more fat morph", () => {
  const light = solveMorphWeights(withBody({ massKg: 55 }), manifest);
  const heavy = solveMorphWeights(withBody({ massKg: 110 }), manifest);
  assert.ok(heavy.weights["weight_heavy"]! > light.weights["weight_heavy"]!);
});
