/**
 * Turns real-world measurements into mesh morph weights.
 *
 * The problem this solves: mass alone does not determine appearance. Two people
 * at 180 cm and 80 kg look completely different if one is lean and muscular and
 * the other is soft. So the user supplies height, mass, and `muscularity`
 * (how that mass is distributed), and body fat is DERIVED from those three.
 * Body fat is therefore never stored in a recipe -- it is always computed.
 *
 * The estimator below is the Deurenberg et al. (1991) body-fat equation, which
 * predicts body fat percentage from BMI, age, and sex. It is a population-level
 * approximation, not a measurement, and it is knowingly blind to muscle mass --
 * hence the explicit muscularity correction.
 *
 * TODO(phase-4): replace this with a lookup calibrated against the real base
 * mesh. Sampling actual mesh volume across the morph space in Blender and
 * fitting a response surface would let us report mass that genuinely matches
 * the rendered body. Callers should depend only on `deriveBodyShape`, so that
 * substitution stays contained.
 */

import { bmi, clamp, clamp01, isWithin, normalize } from "./ranges.ts";
import type { Range } from "./ranges.ts";

/** Body fat percentages outside this band are not survivable; clamp to it. */
export const PHYSIOLOGICAL_BF_PERCENT: Range = { min: 3, max: 60, unit: "%" };

/**
 * BMI band used to judge whether a height/mass pair describes a real body.
 *
 * Plausibility is deliberately checked on BMI rather than on derived body fat.
 * Body fat percentage cannot express the fact that a skeleton and organs have a
 * minimum mass: a 203 cm character at 30 kg computes to a perfectly ordinary
 * ~5% body fat, yet is obviously impossible. BMI catches it immediately.
 *
 * The bounds are wide -- roughly severe-anorexia to extreme-obesity -- because
 * this is a "did you fat-finger the number" check, not a health judgement.
 */
export const PLAUSIBLE_BMI: Range = { min: 13, max: 65, unit: "kg/m^2" };

/**
 * The body fat span the fat morph target is authored across. A character at or
 * below 5% reads as shredded; at or above 50% the morph is fully applied.
 */
export const VISUAL_BF_PERCENT: Range = { min: 5, max: 50, unit: "%" };

/**
 * Muscularity that the Deurenberg equation implicitly assumes, since it was
 * fitted on a general population rather than on athletes. Corrections are
 * applied relative to this, so a default character matches the raw formula.
 */
export const BASELINE_MUSCULARITY = 0.35;

/**
 * Percentage points of body fat subtracted when going from baseline muscularity
 * to fully muscled at constant BMI. Muscle is denser than fat, so a muscular
 * person at a given BMI carries meaningfully less fat.
 */
const MUSCULARITY_BF_SWING = 7;

export interface BodyMetrics {
  readonly heightCm: number;
  readonly massKg: number;
  readonly ageYears: number;
  /** 0 = fully feminine, 1 = fully masculine. */
  readonly gender: number;
  readonly muscularity: number;
}

/**
 * Deurenberg body fat estimate, corrected for muscularity.
 * `gender` is interpolated continuously rather than treated as binary.
 */
export function estimateBodyFatPercent(metrics: BodyMetrics): number {
  const { heightCm, massKg, ageYears, gender, muscularity } = metrics;

  const raw =
    1.2 * bmi(heightCm, massKg) +
    0.23 * ageYears -
    10.8 * clamp01(gender) -
    5.4 -
    (clamp01(muscularity) - BASELINE_MUSCULARITY) * MUSCULARITY_BF_SWING;

  return clamp(raw, PHYSIOLOGICAL_BF_PERCENT.min, PHYSIOLOGICAL_BF_PERCENT.max);
}

/**
 * Inverse of `estimateBodyFatPercent`: the mass that would yield a given body
 * fat percentage. Used when the UI drives fatness with a slider instead of a
 * mass field, and to compute plausible mass bounds for a given height.
 */
export function estimateMassKg(
  metrics: Omit<BodyMetrics, "massKg"> & { bodyFatPercent: number },
): number {
  const { heightCm, ageYears, gender, muscularity, bodyFatPercent } = metrics;

  const targetBmi =
    (bodyFatPercent -
      0.23 * ageYears +
      10.8 * clamp01(gender) +
      5.4 +
      (clamp01(muscularity) - BASELINE_MUSCULARITY) * MUSCULARITY_BF_SWING) /
    1.2;

  return Math.max(0, targetBmi * (heightCm / 100) ** 2);
}

/**
 * The mass range that describes a real body at a given height.
 * Depends only on height, since the BMI band already accounts for build.
 * Useful for clamping UI input and for sizing a mass slider.
 */
export function plausibleMassRangeKg(heightCm: number): Range {
  const squareMetres = (heightCm / 100) ** 2;
  return {
    min: PLAUSIBLE_BMI.min * squareMetres,
    max: PLAUSIBLE_BMI.max * squareMetres,
    unit: "kg",
  };
}

export interface DerivedBodyShape {
  readonly bmi: number;
  readonly bodyFatPercent: number;
  /** 0..1 weight for the body fat morph target. */
  readonly fatMorphWeight: number;
  /** 0..1 weight for the muscle definition morph target. */
  readonly muscleMorphWeight: number;
  /**
   * False when the requested mass is impossible for this height, age, and
   * muscularity. The shape is still built (clamped), but the UI should say so
   * rather than silently producing something that does not match the number
   * the user typed.
   */
  readonly plausible: boolean;
}

/**
 * The single entry point callers should use. Everything downstream -- the
 * Babylon runtime, the exporter, the Blender pipeline -- consumes this rather
 * than reimplementing the physiology.
 */
export function deriveBodyShape(metrics: BodyMetrics): DerivedBodyShape {
  const bodyFatPercent = estimateBodyFatPercent(metrics);
  const bodyMassIndex = bmi(metrics.heightCm, metrics.massKg);

  return {
    bmi: bodyMassIndex,
    bodyFatPercent,
    fatMorphWeight: normalize(VISUAL_BF_PERCENT, bodyFatPercent),
    // Visible muscle definition requires both muscle mass and low enough fat to
    // see it. A very muscular character at 40% body fat should read as big, not
    // as defined.
    muscleMorphWeight:
      clamp01(metrics.muscularity) *
      (1 - 0.6 * normalize(VISUAL_BF_PERCENT, bodyFatPercent)),
    plausible: isWithin(PLAUSIBLE_BMI, bodyMassIndex),
  };
}
