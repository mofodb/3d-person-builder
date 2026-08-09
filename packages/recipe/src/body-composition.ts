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

import { bmi, clamp, clamp01, denormalize, isWithin, normalize } from "./ranges.ts";
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
 *
 * No longer used to shape characters -- body fat is an explicit input now. This
 * remains as an *initializer*: it produces a sensible starting body fat for a
 * new character, for a photo-derived one, and for migrating recipes saved before
 * body fat became a field. Do not reintroduce it into the shape path; being a
 * population-average fit, it cannot represent athletic bodies.
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

// --- Muscularity from FFMI ----------------------------------------------------

/**
 * Fat-Free Mass Index: lean mass divided by height squared. Unlike BMI it is
 * blind to fat, which makes it the honest measure of how muscular someone is.
 *
 * Reference points for men: ~16 untrained, ~19 average, ~21 athletic,
 * ~23 very muscular, ~25 the rough ceiling for a natural athlete. Women run
 * roughly three points lower, so the range is interpolated across `gender`.
 */
export const FFMI_FEMININE: Range = { min: 13, max: 21, unit: "kg/m^2" };
export const FFMI_MASCULINE: Range = { min: 16, max: 25, unit: "kg/m^2" };

/** Beyond this band, the implied lean mass is not a real human body. */
export const PLAUSIBLE_FFMI: Range = { min: 11, max: 30, unit: "kg/m^2" };

export function ffmiRange(gender: number): Range {
  const t = clamp01(gender);
  return {
    min: FFMI_FEMININE.min + (FFMI_MASCULINE.min - FFMI_FEMININE.min) * t,
    max: FFMI_FEMININE.max + (FFMI_MASCULINE.max - FFMI_FEMININE.max) * t,
    unit: "kg/m^2",
  };
}

export const ffmi = (heightCm: number, leanMassKg: number): number =>
  leanMassKg / (heightCm / 100) ** 2;

/** Normalized 0..1 muscularity from an FFMI value. */
export const ffmiToMuscularity = (value: number, gender: number): number =>
  normalize(ffmiRange(gender), value);

/** FFMI implied by a normalized muscularity dial. */
export const muscularityToFfmi = (muscularity: number, gender: number): number =>
  denormalize(ffmiRange(gender), muscularity);

/**
 * Body fat percentage that would produce a given muscularity, holding height and
 * mass fixed. Lets the UI offer a muscularity slider that writes back to the
 * canonical body fat value, so the two can never disagree.
 */
export function bodyFatForMuscularity(input: {
  heightCm: number;
  massKg: number;
  gender: number;
  muscularity: number;
}): number {
  const targetFfmi = muscularityToFfmi(clamp01(input.muscularity), input.gender);
  const leanMassKg = targetFfmi * (input.heightCm / 100) ** 2;
  const percent = (1 - leanMassKg / input.massKg) * 100;
  return clamp(percent, PHYSIOLOGICAL_BF_PERCENT.min, PHYSIOLOGICAL_BF_PERCENT.max);
}

// --- The shape a character actually gets --------------------------------------

/** Height, mass and body fat fully determine composition; gender scales FFMI. */
export interface BodyComposition {
  readonly heightCm: number;
  readonly massKg: number;
  readonly bodyFatPercent: number;
  /** 0 = fully feminine, 1 = fully masculine. Only shifts the FFMI reference. */
  readonly gender: number;
}

export interface DerivedBodyShape {
  readonly bmi: number;
  readonly bodyFatPercent: number;
  readonly fatMassKg: number;
  readonly leanMassKg: number;
  readonly ffmi: number;
  /** 0..1 muscularity implied by the lean mass. Derived, never stored. */
  readonly muscularity: number;
  /** 0..1 weight for the body fat morph target. */
  readonly fatMorphWeight: number;
  /** 0..1 weight for the muscle definition morph target. */
  readonly muscleMorphWeight: number;
  /** False when this combination is not a real body. Shape is still built. */
  readonly plausible: boolean;
  /** Human-readable reasons, for the UI to surface. */
  readonly warnings: readonly string[];
}

/**
 * The single entry point callers should use. Everything downstream -- the
 * Babylon runtime, the exporter, the Blender pipeline -- consumes this rather
 * than reimplementing the physiology.
 *
 * Body fat is an INPUT here, not a derivation. An earlier version derived it
 * from a muscularity dial via the Deurenberg equation, which made athletic
 * compositions unreachable: that formula is fitted to a general population, so
 * no amount of muscularity would let a 188 cm, 92 kg character sit at 10% body
 * fat, even though that is an entirely real body. Muscularity is now derived
 * from FFMI instead, which measures it directly.
 */
export function deriveBodyShape(composition: BodyComposition): DerivedBodyShape {
  const { heightCm, massKg, gender } = composition;
  const bodyFatPercent = clamp(
    composition.bodyFatPercent,
    PHYSIOLOGICAL_BF_PERCENT.min,
    PHYSIOLOGICAL_BF_PERCENT.max,
  );

  const fatMassKg = massKg * (bodyFatPercent / 100);
  const leanMassKg = massKg - fatMassKg;
  const bodyMassIndex = bmi(heightCm, massKg);
  const fatFreeIndex = ffmi(heightCm, leanMassKg);
  const muscularity = ffmiToMuscularity(fatFreeIndex, gender);
  const fatNormalized = normalize(VISUAL_BF_PERCENT, bodyFatPercent);

  const warnings: string[] = [];
  if (!isWithin(PLAUSIBLE_BMI, bodyMassIndex)) {
    warnings.push(
      `A BMI of ${bodyMassIndex.toFixed(1)} is outside the believable range for this height.`,
    );
  }
  if (!isWithin(PLAUSIBLE_FFMI, fatFreeIndex)) {
    warnings.push(
      `That weight at ${bodyFatPercent.toFixed(1)}% body fat implies an FFMI of ` +
        `${fatFreeIndex.toFixed(1)}, which is not a real amount of lean mass.`,
    );
  } else if (fatFreeIndex > FFMI_MASCULINE.max) {
    warnings.push(
      `An FFMI of ${fatFreeIndex.toFixed(1)} is beyond what is typically achievable naturally.`,
    );
  }

  return {
    bmi: bodyMassIndex,
    bodyFatPercent,
    fatMassKg,
    leanMassKg,
    ffmi: fatFreeIndex,
    muscularity,
    fatMorphWeight: fatNormalized,
    // Visible muscle definition needs both muscle mass and low enough fat to see
    // it. A very muscular character at 40% body fat should read as big, not cut.
    muscleMorphWeight: muscularity * (1 - 0.6 * fatNormalized),
    plausible: warnings.length === 0,
    warnings,
  };
}
