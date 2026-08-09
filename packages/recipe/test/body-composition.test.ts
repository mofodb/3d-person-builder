import assert from "node:assert/strict";
import { test } from "node:test";

import {
  deriveBodyShape,
  estimateBodyFatPercent,
  estimateMassKg,
  plausibleMassRangeKg,
  PHYSIOLOGICAL_BF_PERCENT,
} from "../src/body-composition.ts";
import type { BodyMetrics } from "../src/body-composition.ts";

const average: BodyMetrics = {
  heightCm: 175,
  massKg: 72,
  ageYears: 30,
  gender: 0.5,
  muscularity: 0.35,
};

test("an average adult lands in a believable body fat range", () => {
  const bf = estimateBodyFatPercent(average);
  assert.ok(bf > 12 && bf < 30, `got ${bf}%`);
});

test("more mass at the same height means more body fat", () => {
  const lean = estimateBodyFatPercent({ ...average, massKg: 60 });
  const heavy = estimateBodyFatPercent({ ...average, massKg: 110 });
  assert.ok(heavy > lean, `${heavy} should exceed ${lean}`);
});

test("muscularity lowers derived body fat at constant mass", () => {
  const untrained = estimateBodyFatPercent({ ...average, muscularity: 0 });
  const jacked = estimateBodyFatPercent({ ...average, muscularity: 1 });
  assert.ok(jacked < untrained, `${jacked} should be under ${untrained}`);
});

test("body fat is clamped to survivable values", () => {
  // Deliberately impossible bodies, to prove the clamp engages at both ends.
  const absurdlyLight = estimateBodyFatPercent({ ...average, heightCm: 250, massKg: 25 });
  const absurdlyHeavy = estimateBodyFatPercent({ ...average, heightCm: 120, massKg: 300 });
  assert.equal(absurdlyLight, PHYSIOLOGICAL_BF_PERCENT.min);
  assert.equal(absurdlyHeavy, PHYSIOLOGICAL_BF_PERCENT.max);
});

test("mass estimation inverts body fat estimation", () => {
  const bf = estimateBodyFatPercent(average);
  const mass = estimateMassKg({ ...average, bodyFatPercent: bf });
  assert.ok(Math.abs(mass - average.massKg) < 0.01, `got ${mass}, want ${average.massKg}`);
});

test("morph weights stay within 0..1 across the whole design space", () => {
  for (const heightCm of [149.86, 175, 203.2]) {
    for (const massKg of [43.09, 72, 120.2, 300]) {
      for (const muscularity of [0, 0.5, 1]) {
        for (const gender of [0, 0.5, 1]) {
          const shape = deriveBodyShape({
            heightCm,
            massKg,
            muscularity,
            gender,
            ageYears: 30,
          });
          const label = `${heightCm}cm ${massKg}kg m=${muscularity} g=${gender}`;
          assert.ok(
            shape.fatMorphWeight >= 0 && shape.fatMorphWeight <= 1,
            `fat out of range at ${label}: ${shape.fatMorphWeight}`,
          );
          assert.ok(
            shape.muscleMorphWeight >= 0 && shape.muscleMorphWeight <= 1,
            `muscle out of range at ${label}: ${shape.muscleMorphWeight}`,
          );
        }
      }
    }
  }
});

test("visible muscle definition is suppressed by high body fat", () => {
  const defined = deriveBodyShape({ ...average, massKg: 65, muscularity: 1 });
  const covered = deriveBodyShape({ ...average, massKg: 130, muscularity: 1 });
  assert.ok(
    covered.muscleMorphWeight < defined.muscleMorphWeight,
    "a heavy character should read as big, not as defined",
  );
});

test("the intended cast is all flagged plausible", () => {
  const cast: BodyMetrics[] = [
    { heightCm: 149.86, massKg: 43.09, ageYears: 25, gender: 0, muscularity: 0.2 },
    { heightCm: 203.2, massKg: 120.2, ageYears: 28, gender: 1, muscularity: 0.7 },
    { heightCm: 175, massKg: 72, ageYears: 40, gender: 0.5, muscularity: 0.35 },
  ];
  for (const metrics of cast) {
    assert.ok(deriveBodyShape(metrics).plausible, `${metrics.heightCm}cm ${metrics.massKg}kg`);
  }
});

test("impossible combinations are reported, not silently accepted", () => {
  // 6'8" at 30 kg computes to an unremarkable body fat percentage, so this is
  // exactly the case that a fat-percentage-based check would wave through.
  const tooLight = deriveBodyShape({ ...average, heightCm: 203.2, massKg: 30 });
  assert.equal(tooLight.plausible, false);

  const tooHeavy = deriveBodyShape({ ...average, heightCm: 149.86, massKg: 250 });
  assert.equal(tooHeavy.plausible, false);
});

test("plausible mass range is ordered and brackets a normal body", () => {
  const range = plausibleMassRangeKg(average.heightCm);
  assert.ok(range.min < range.max);
  assert.ok(range.min < average.massKg && average.massKg < range.max);
});

test("plausible mass range scales with height", () => {
  const short = plausibleMassRangeKg(149.86);
  const tall = plausibleMassRangeKg(203.2);
  assert.ok(tall.min > short.min && tall.max > short.max);
  // A 95 lb 4'11" character and a 265 lb 6'8" character must both fit.
  assert.ok(short.min <= 43.09 && 43.09 <= short.max);
  assert.ok(tall.min <= 120.2 && 120.2 <= tall.max);
});
