import assert from "node:assert/strict";
import { test } from "node:test";

import {
  FFMI_MASCULINE,
  PHYSIOLOGICAL_BF_PERCENT,
  bodyFatForMuscularity,
  deriveBodyShape,
  estimateBodyFatPercent,
  estimateMassKg,
  ffmi,
  ffmiToMuscularity,
  muscularityToFfmi,
  plausibleMassRangeKg,
} from "../src/body-composition.ts";
import type { BodyComposition } from "../src/body-composition.ts";
import { feetInchesToCm, poundsToKg } from "../src/units.ts";

const average: BodyComposition = {
  heightCm: 175,
  massKg: 72,
  bodyFatPercent: 22,
  gender: 0.5,
};

test("composition splits mass into fat and lean", () => {
  const shape = deriveBodyShape({ ...average, massKg: 100, bodyFatPercent: 25 });
  assert.equal(shape.fatMassKg, 25);
  assert.equal(shape.leanMassKg, 75);
});

test("body fat is an input and is honoured exactly", () => {
  for (const bodyFatPercent of [5, 10, 18, 25, 40]) {
    const shape = deriveBodyShape({ ...average, bodyFatPercent });
    assert.equal(shape.bodyFatPercent, bodyFatPercent);
  }
});

/**
 * The case that motivated inverting the model: a 6'2", 202 lb, muscular man at
 * 10% body fat. The previous design derived body fat from a muscularity dial via
 * the Deurenberg equation, which topped out around 21% and could never express
 * this body at all.
 */
test("a lean muscular build at 6'2\" and 202 lb is reachable", () => {
  const shape = deriveBodyShape({
    heightCm: feetInchesToCm(6, 2),
    massKg: poundsToKg(202),
    bodyFatPercent: 10,
    gender: 1,
  });

  assert.equal(shape.bodyFatPercent, 10);
  assert.ok(Math.abs(shape.leanMassKg - 82.5) < 0.5, `lean mass ${shape.leanMassKg}`);
  assert.ok(Math.abs(shape.ffmi - 23.3) < 0.2, `FFMI ${shape.ffmi}`);
  // Very muscular, but short of the natural ceiling, so not maxed out.
  assert.ok(shape.muscularity > 0.7, `muscularity ${shape.muscularity}`);
  assert.ok(shape.muscularity < 1, "should not be pinned at the maximum");
  assert.ok(shape.plausible, `warnings: ${shape.warnings.join("; ")}`);
});

test("the same body at higher body fat reads as less muscular", () => {
  const base = { heightCm: feetInchesToCm(6, 2), massKg: poundsToKg(202), gender: 1 };
  const lean = deriveBodyShape({ ...base, bodyFatPercent: 10 });
  const soft = deriveBodyShape({ ...base, bodyFatPercent: 28 });

  assert.ok(lean.muscularity > soft.muscularity);
  assert.ok(lean.ffmi > soft.ffmi);
  // Same weight, so the difference is purely composition.
  assert.equal(lean.bmi.toFixed(3), soft.bmi.toFixed(3));
});

test("at constant body fat, more weight means more of both tissues", () => {
  // Percentage is relative, so scaling mass at fixed percentage scales fat and
  // lean mass together. Both indices must rise; this is why the weight macro is
  // driven by fat mass index rather than by percentage.
  const base = { heightCm: 180, bodyFatPercent: 12, gender: 1 };
  const lighter = deriveBodyShape({ ...base, massKg: 70 });
  const heavier = deriveBodyShape({ ...base, massKg: 95 });

  assert.ok(heavier.muscularity > lighter.muscularity, "muscularity should rise");
  assert.ok(heavier.fmi > lighter.fmi, "fat mass index should rise");
  assert.ok(
    heavier.fatMorphWeight > lighter.fatMorphWeight,
    "fat morph should rise even at identical body fat percentage",
  );
});

test("the muscle macro is not reduced by body fat", () => {
  // Suppressing muscle by fat was the bug that made heavy muscular characters
  // look unremarkable. A fat strong person still has large muscles; only their
  // visible separation is hidden, which is what `definition` is for.
  const lean = deriveBodyShape({ heightCm: 180, massKg: 80, bodyFatPercent: 10, gender: 1 });
  const fat = deriveBodyShape({
    heightCm: 180,
    // Same lean mass as above (72 kg), just with far more fat on top.
    massKg: 72 / (1 - 0.35),
    bodyFatPercent: 35,
    gender: 1,
  });

  assert.ok(Math.abs(fat.leanMassKg - lean.leanMassKg) < 0.5, "lean mass should match");
  assert.ok(
    Math.abs(fat.muscleMorphWeight - lean.muscleMorphWeight) < 0.01,
    "equal lean mass must give equal muscle, regardless of fat",
  );
  assert.ok(fat.fatMorphWeight > lean.fatMorphWeight, "the fat morph carries the difference");
});

test("muscularity and FFMI round-trip", () => {
  for (const gender of [0, 0.5, 1]) {
    for (const muscularity of [0, 0.25, 0.5, 0.75, 1]) {
      const value = muscularityToFfmi(muscularity, gender);
      assert.ok(Math.abs(ffmiToMuscularity(value, gender) - muscularity) < 1e-9);
    }
  }
});

test("women reach a given muscularity at a lower FFMI", () => {
  assert.ok(muscularityToFfmi(0.8, 0) < muscularityToFfmi(0.8, 1));
});

test("the muscularity slider back-solves body fat consistently", () => {
  for (const muscularity of [0.2, 0.5, 0.8]) {
    const bodyFatPercent = bodyFatForMuscularity({
      heightCm: 180,
      massKg: 85,
      gender: 1,
      muscularity,
    });
    const shape = deriveBodyShape({
      heightCm: 180,
      massKg: 85,
      bodyFatPercent,
      gender: 1,
    });
    assert.ok(
      Math.abs(shape.muscularity - muscularity) < 0.01,
      `wanted ${muscularity}, got ${shape.muscularity}`,
    );
  }
});

test("body fat is clamped to survivable values", () => {
  assert.equal(deriveBodyShape({ ...average, bodyFatPercent: 0 }).bodyFatPercent, 3);
  assert.equal(deriveBodyShape({ ...average, bodyFatPercent: 90 }).bodyFatPercent, 60);
});

test("impossible lean mass is reported, not silently accepted", () => {
  // 250 kg at 5% body fat implies 237 kg of lean mass on a 150 cm frame.
  const shape = deriveBodyShape({
    heightCm: 149.86,
    massKg: 250,
    bodyFatPercent: 5,
    gender: 1,
  });
  assert.equal(shape.plausible, false);
  assert.ok(shape.warnings.length > 0);
});

test("beyond-natural lean mass earns a warning but stays buildable", () => {
  // 92 kg of lean mass at 180 cm is an FFMI of ~28: above the natural ceiling of
  // 25, yet still a body that exists, so it warns rather than being rejected.
  const shape = deriveBodyShape({
    heightCm: 180,
    massKg: 100,
    bodyFatPercent: 8,
    gender: 1,
  });
  assert.ok(shape.ffmi > FFMI_MASCULINE.max, `FFMI ${shape.ffmi}`);
  assert.ok(
    shape.warnings.some((w) => w.includes("naturally")),
    `warnings: ${shape.warnings.join("; ")}`,
  );
});

test("morph weights stay within 0..1 across the whole design space", () => {
  for (const heightCm of [149.86, 175, 203.2]) {
    for (const massKg of [43.09, 72, 120.2]) {
      for (const bodyFatPercent of [3, 10, 25, 45, 60]) {
        for (const gender of [0, 0.5, 1]) {
          const shape = deriveBodyShape({ heightCm, massKg, bodyFatPercent, gender });
          const label = `${heightCm}cm ${massKg}kg ${bodyFatPercent}% g=${gender}`;
          for (const [name, value] of [
            ["fat", shape.fatMorphWeight],
            ["muscle", shape.muscleMorphWeight],
            ["muscularity", shape.muscularity],
          ] as const) {
            assert.ok(value >= 0 && value <= 1, `${name}=${value} out of range at ${label}`);
          }
        }
      }
    }
  }
});

test("visible definition, unlike muscle size, is suppressed by fat", () => {
  const base = { heightCm: 180, massKg: 95, gender: 1 };
  const cut = deriveBodyShape({ ...base, bodyFatPercent: 8 });
  const bulky = deriveBodyShape({ ...base, bodyFatPercent: 35 });
  assert.ok(
    bulky.definition < cut.definition,
    "a fat strong character should read as big, not as defined",
  );
});

test("an average build sits at the middle of both macros", () => {
  // MPFB treats 0.5 as average, so the mapping must agree or every character
  // drifts toward one extreme. Real-world indices are not symmetric about their
  // average, which is why anchored normalization exists.
  const shape = deriveBodyShape({
    heightCm: 178,
    massKg: 80,
    bodyFatPercent: 20,
    gender: 1,
  });
  assert.ok(
    Math.abs(shape.fatMorphWeight - 0.5) < 0.15,
    `fat macro ${shape.fatMorphWeight} should be near average`,
  );
  assert.ok(
    Math.abs(shape.muscleMorphWeight - 0.5) < 0.2,
    `muscle macro ${shape.muscleMorphWeight} should be near average`,
  );
});

test("the intended cast is all plausible", () => {
  const cast: BodyComposition[] = [
    { heightCm: 149.86, massKg: 43.09, bodyFatPercent: 24, gender: 0 },
    { heightCm: 203.2, massKg: 120.2, bodyFatPercent: 18, gender: 1 },
    { heightCm: 175, massKg: 72, bodyFatPercent: 22, gender: 0.5 },
  ];
  for (const metrics of cast) {
    const shape = deriveBodyShape(metrics);
    assert.ok(shape.plausible, `${metrics.heightCm}cm: ${shape.warnings.join("; ")}`);
  }
});

test("plausible mass range scales with height", () => {
  const short = plausibleMassRangeKg(149.86);
  const tall = plausibleMassRangeKg(203.2);
  assert.ok(tall.min > short.min && tall.max > short.max);
  assert.ok(short.min <= 43.09 && 43.09 <= short.max);
  assert.ok(tall.min <= 120.2 && 120.2 <= tall.max);
});

test("ffmi helper matches a hand calculation", () => {
  // 80 kg lean at 2 m is 80 / 4 = 20.
  assert.equal(ffmi(200, 80), 20);
});

// --- The retained Deurenberg initializer --------------------------------------

test("the legacy estimator still gives a sane starting body fat", () => {
  const percent = estimateBodyFatPercent({
    heightCm: 175,
    massKg: 72,
    ageYears: 30,
    gender: 0.5,
    muscularity: 0.35,
  });
  assert.ok(percent > 12 && percent < 32, `got ${percent}%`);
  assert.ok(percent >= PHYSIOLOGICAL_BF_PERCENT.min);
});

test("the legacy estimator inverts to mass", () => {
  const metrics = { heightCm: 175, ageYears: 30, gender: 0.5, muscularity: 0.35 };
  const percent = estimateBodyFatPercent({ ...metrics, massKg: 72 });
  assert.ok(Math.abs(estimateMassKg({ ...metrics, bodyFatPercent: percent }) - 72) < 0.01);
});
