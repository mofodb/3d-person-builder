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

test("bone corrections cover most of the rig, excluding Hips", () => {
  // Hips carries genuine positional animation (root motion) and is corrected
  // by a different mechanism, so it must never appear here; see
  // bone_local_offset() in build_basemesh.py and applyBoneCorrections() in
  // babylon.ts.
  const boneNames = Object.keys(manifest.boneCorrections);
  assert.ok(boneNames.length >= 40, `only ${boneNames.length} bones have corrections`);
  assert.ok(!boneNames.some((name) => name.endsWith(":Hips")));
});

test("height dominates a limb bone's correction, matching the body's own height response", () => {
  const forearm = manifest.boneCorrections["mixamorig:LeftForeArm"];
  assert.ok(forearm, "LeftForeArm should have corrections");
  const [, tallY] = forearm!["height_tall"]!;
  const [, shortY] = forearm!["height_short"]!;
  // A taller body must reach the forearm further out; a shorter one closer in.
  assert.ok(tallY! > 0, `height_tall should extend the forearm, got ${tallY}`);
  assert.ok(shortY! < 0, `height_short should shorten the forearm, got ${shortY}`);
});

test("bone corrections point along the bone's own local axis", () => {
  // Verifies the parent-relative-offset convention (see bone_local_offset in
  // build_basemesh.py): for this rig's straight FK chains, a correction should
  // be concentrated on one axis (Y), not spread arbitrarily across all three.
  const forearm = manifest.boneCorrections["mixamorig:LeftForeArm"]!;
  for (const [morphName, [dx, dy, dz]] of Object.entries(forearm)) {
    const dominant = Math.max(Math.abs(dx!), Math.abs(dy!), Math.abs(dz!));
    assert.equal(dominant, Math.abs(dy!), `${morphName}: expected Y to dominate, got [${dx},${dy},${dz}]`);
  }
});

test("merged animations, if present, have full bone coverage", () => {
  // add_animations.py is a separate, optional pipeline stage -- a plain
  // build_basemesh.py run legitimately leaves this empty, so this only
  // asserts something when animations have actually been merged.
  for (const clip of manifest.animations) {
    assert.ok(clip.name.length > 0);
    if (clip.coverage !== undefined) {
      assert.equal(clip.coverage, 1, `${clip.name} coverage was ${clip.coverage}`);
    }
  }
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

test("bust size follows femininity, maxing out at full feminine", () => {
  const feminine = solveMorphWeights(withBody({ gender: 0 }), manifest);
  const masculine = solveMorphWeights(withBody({ gender: 1 }), manifest);
  assert.equal(feminine.weights["cupsize_large"], 1);
  assert.equal(feminine.weights["cupsize_small"], 0);
  assert.equal(masculine.weights["cupsize_small"], 1);
  assert.equal(masculine.weights["cupsize_large"], 0);
});

test("bust size is unchanged at the androgynous default", () => {
  // The bust/gender coupling must not shift the default character's look.
  const androgynous = solveMorphWeights(createDefaultRecipe(), manifest);
  assert.equal(androgynous.weights["cupsize_small"], 0);
  assert.equal(androgynous.weights["cupsize_large"], 0);
});

test("bust size is already pronounced before the feminine extreme", () => {
  // The whole point of the fix: previously this was 0 everywhere except the
  // literal endpoint, so a mostly-feminine character still looked androgynous.
  const mostlyFeminine = solveMorphWeights(withBody({ gender: 0.25 }), manifest);
  assert.ok(
    mostlyFeminine.weights["cupsize_large"]! > 0.5,
    `got ${mostlyFeminine.weights["cupsize_large"]}`,
  );
});

test("bust size responds symmetrically to gender on both sides", () => {
  const feminineSide = solveMorphWeights(withBody({ gender: 0.25 }), manifest);
  const masculineSide = solveMorphWeights(withBody({ gender: 0.75 }), manifest);
  assert.ok(
    Math.abs(feminineSide.weights["cupsize_large"]! - masculineSide.weights["cupsize_small"]!) <
      1e-9,
  );
});

test("fatter characters get more fat morph", () => {
  const lean = solveMorphWeights(withBody({ bodyFatPercent: 8 }), manifest);
  const fat = solveMorphWeights(withBody({ bodyFatPercent: 40 }), manifest);
  assert.ok(fat.weights["weight_heavy"]! > lean.weights["weight_heavy"]!);
});

test("extra weight at constant body fat mostly becomes muscle", () => {
  const light = solveMorphWeights(withBody({ massKg: 65, bodyFatPercent: 15 }), manifest);
  const heavy = solveMorphWeights(withBody({ massKg: 95, bodyFatPercent: 15 }), manifest);

  // A heavier character at the same composition is less thin and more muscular.
  assert.ok(heavy.weights["weight_light"]! < light.weights["weight_light"]!);
  assert.ok(heavy.weights["muscle_high"]! > light.weights["muscle_high"]!);
  // Muscle should gain far more than the barely-above-average starting point.
  assert.ok(light.weights["muscle_high"]! < 0.15, `${light.weights["muscle_high"]}`);
  assert.ok(
    heavy.weights["muscle_high"]! - light.weights["muscle_high"]! > 0.4,
    "the gain should be substantial, not marginal",
  );
});

test("the three body archetypes produce clearly separated morphs", () => {
  // Guards the contrast between skinny, fat and muscular, which was previously
  // far too subtle to see.
  const tall = feetInchesToCm(6, 2);
  const skinny = solveMorphWeights(
    withBody({ heightCm: tall, massKg: poundsToKg(150), bodyFatPercent: 12, gender: 1 }),
    manifest,
  );
  const fat = solveMorphWeights(
    withBody({ heightCm: tall, massKg: poundsToKg(240), bodyFatPercent: 35, gender: 1 }),
    manifest,
  );
  const jacked = solveMorphWeights(
    withBody({ heightCm: tall, massKg: poundsToKg(240), bodyFatPercent: 12, gender: 1 }),
    manifest,
  );

  // Skinny: thin and unmuscled.
  assert.ok(skinny.weights["weight_light"]! > 0.6, `${skinny.weights["weight_light"]}`);
  assert.ok(skinny.weights["muscle_low"]! > 0.5, `${skinny.weights["muscle_low"]}`);

  // Fat: heavy, with only modest muscle.
  assert.ok(fat.weights["weight_heavy"]! > 0.5, `${fat.weights["weight_heavy"]}`);
  assert.ok(fat.weights["muscle_high"]! < 0.3, `${fat.weights["muscle_high"]}`);

  // Muscular: strongly muscled without reading as heavy.
  assert.ok(jacked.weights["muscle_high"]! > 0.8, `${jacked.weights["muscle_high"]}`);
  assert.equal(jacked.weights["weight_heavy"], 0);

  // Same weight, opposite silhouettes.
  assert.ok(fat.weights["weight_heavy"]! - jacked.weights["weight_heavy"]! > 0.5);
  assert.ok(jacked.weights["muscle_high"]! - fat.weights["muscle_high"]! > 0.5);
});

test("a lean muscular 6'2\" 202 lb build reaches a high muscle morph", () => {
  const solved = solveMorphWeights(
    withBody({
      heightCm: feetInchesToCm(6, 2),
      massKg: poundsToKg(202),
      bodyFatPercent: 10,
      gender: 1,
    }),
    manifest,
  );
  // The muscle macro is neutral at 0.5, so a muscularity of ~0.8 lands about
  // halfway between average and maximum on the morph itself.
  assert.ok(solved.weights["muscle_high"]! > 0.45, `got ${solved.weights["muscle_high"]}`);
  assert.equal(solved.weights["muscle_low"], 0);
  // At 10% body fat the character should read lean, not heavy.
  assert.equal(solved.weights["weight_heavy"], 0);
  assert.ok(solved.weights["weight_light"]! > 0.6, `got ${solved.weights["weight_light"]}`);
});
