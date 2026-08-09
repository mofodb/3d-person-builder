/**
 * Maps normalized recipe values onto physical/human-readable units.
 *
 * Kept separate from the schema on purpose: tweaking these ranges changes how
 * a recipe is *displayed and built*, never what a recipe *means*. Saved
 * characters therefore survive art-direction changes.
 */

export interface Range {
  readonly min: number;
  readonly max: number;
  readonly unit: string;
}

export const HEIGHT_CM: Range = { min: 148, max: 202, unit: "cm" };
export const AGE_YEARS: Range = { min: 18, max: 75, unit: "years" };

export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

export const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

/** Normalized 0..1 -> physical value. */
export const denormalize = (range: Range, t: number): number =>
  lerp(range.min, range.max, clamp01(t));

/** Physical value -> normalized 0..1. */
export const normalize = (range: Range, value: number): number =>
  clamp01((value - range.min) / (range.max - range.min));

export const heightCm = (t: number): number => denormalize(HEIGHT_CM, t);
export const ageYears = (t: number): number => Math.round(denormalize(AGE_YEARS, t));

/**
 * Formats a normalized value for UI display.
 * e.g. formatHeight(0.5) -> "175 cm (5'9\")"
 */
export function formatHeight(t: number): string {
  const cm = Math.round(heightCm(t));
  const totalInches = cm / 2.54;
  const feet = Math.floor(totalInches / 12);
  const inches = Math.round(totalInches - feet * 12);
  // Rounding inches can hit 12; roll it into the feet value.
  const [ft, inch] = inches === 12 ? [feet + 1, 0] : [feet, inches];
  return `${cm} cm (${ft}'${inch}")`;
}
