/**
 * Bounds for physical character measurements, and helpers for the normalized
 * art-direction parameters.
 *
 * Two tiers of range, deliberately:
 *
 *  - HARD bounds are enforced by the schema. Generous, so that unusual
 *    characters remain representable and future needs do not require a
 *    migration. Values outside these are rejected as data errors.
 *  - SLIDER bounds are the useful working span for the UI. A slider covers
 *    this range; typing into the numeric field accepts anything within the
 *    hard bounds.
 *
 * Because physical measurements are stored in real units (cm, kg), widening
 * either tier can never change what an already-saved character means. That is
 * the whole reason height and mass are NOT stored normalized.
 */

export interface Range {
  readonly min: number;
  readonly max: number;
  readonly unit: string;
}

/** Schema-enforced limits. Wide on purpose. */
export const HEIGHT_CM: Range = { min: 120, max: 250, unit: "cm" };
export const MASS_KG: Range = { min: 25, max: 300, unit: "kg" };
export const AGE_YEARS: Range = { min: 13, max: 100, unit: "years" };
/** Survivable body fat percentages. Essential fat sets the floor. */
export const BODY_FAT_PERCENT: Range = { min: 3, max: 60, unit: "%" };

/**
 * Working span for UI sliders, covering the intended cast:
 * 4'11"-6'8" and 95-265 lb, with a little headroom.
 */
export const HEIGHT_CM_SLIDER: Range = { min: 145, max: 210, unit: "cm" };
export const MASS_KG_SLIDER: Range = { min: 40, max: 125, unit: "kg" };
export const AGE_YEARS_SLIDER: Range = { min: 18, max: 80, unit: "years" };
/** Working span covering shredded athlete through obese. */
export const BODY_FAT_PERCENT_SLIDER: Range = { min: 5, max: 50, unit: "%" };

export const DEFAULT_HEIGHT_CM = 175;
export const DEFAULT_MASS_KG = 72;
export const DEFAULT_AGE_YEARS = 30;
export const DEFAULT_BODY_FAT_PERCENT = 22;

export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

export const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

export const clamp = (v: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, v));

export const clampToRange = (range: Range, value: number): number =>
  clamp(value, range.min, range.max);

export const isWithin = (range: Range, value: number): boolean =>
  value >= range.min && value <= range.max;

/**
 * A range with an explicit typical value, which need not sit at the midpoint.
 *
 * Needed because MPFB's macro dials treat 0.5 as *average*, while real-world
 * indices are not symmetric about their average: a man's fat mass index runs
 * roughly 1.5 when shredded, 5 when average and 13 when obese. Mapping that
 * linearly onto 0..1 would place an average build at 0.28 and make everyone
 * look thin.
 */
export interface Anchors {
  readonly min: number;
  readonly neutral: number;
  readonly max: number;
  readonly unit: string;
}

/** Maps a value onto 0..1 with `neutral` landing exactly on 0.5. */
export function normalizeAroundNeutral(anchors: Anchors, value: number): number {
  if (value <= anchors.neutral) {
    const span = anchors.neutral - anchors.min;
    return span <= 0 ? 0.5 : clamp01(0.5 * ((value - anchors.min) / span));
  }
  const span = anchors.max - anchors.neutral;
  return span <= 0 ? 0.5 : clamp01(0.5 + 0.5 * ((value - anchors.neutral) / span));
}

/** Inverse of `normalizeAroundNeutral`. */
export function denormalizeAroundNeutral(anchors: Anchors, t: number): number {
  const clamped = clamp01(t);
  return clamped <= 0.5
    ? lerp(anchors.min, anchors.neutral, clamped / 0.5)
    : lerp(anchors.neutral, anchors.max, (clamped - 0.5) / 0.5);
}

/** Blends two anchor sets, used to interpolate references across gender. */
export const lerpAnchors = (a: Anchors, b: Anchors, t: number): Anchors => ({
  min: lerp(a.min, b.min, clamp01(t)),
  neutral: lerp(a.neutral, b.neutral, clamp01(t)),
  max: lerp(a.max, b.max, clamp01(t)),
  unit: a.unit,
});

/** Normalized 0..1 -> value within `range`. */
export const denormalize = (range: Range, t: number): number =>
  lerp(range.min, range.max, clamp01(t));

/** Value within `range` -> normalized 0..1. */
export const normalize = (range: Range, value: number): number =>
  clamp01((value - range.min) / (range.max - range.min));

/**
 * Body Mass Index. Useful as a sanity signal in the UI, though BMI cannot
 * distinguish muscle from fat -- which is exactly why `muscularity` is a
 * separate parameter. See body-composition.ts.
 */
export const bmi = (heightCm: number, massKg: number): number =>
  massKg / (heightCm / 100) ** 2;
