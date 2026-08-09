/**
 * Unit conversion, formatting, and parsing for physical character measurements.
 *
 * Recipes always store SI (cm, kg). Imperial exists only at the UI boundary.
 * Display preference is a *user* setting, not character data, so it lives in
 * editor state rather than in the recipe.
 */

export type UnitSystem = "metric" | "imperial";

const CM_PER_INCH = 2.54;
const INCHES_PER_FOOT = 12;
const KG_PER_POUND = 0.45359237;

// --- Conversion ---------------------------------------------------------------

export const cmToInches = (cm: number): number => cm / CM_PER_INCH;
export const inchesToCm = (inches: number): number => inches * CM_PER_INCH;
export const kgToPounds = (kg: number): number => kg / KG_PER_POUND;
export const poundsToKg = (lb: number): number => lb * KG_PER_POUND;

export interface FeetInches {
  readonly feet: number;
  readonly inches: number;
}

/** Splits centimetres into feet and whole inches, rolling 12" up into a foot. */
export function cmToFeetInches(cm: number): FeetInches {
  const totalInches = Math.round(cmToInches(cm));
  return {
    feet: Math.floor(totalInches / INCHES_PER_FOOT),
    inches: totalInches % INCHES_PER_FOOT,
  };
}

export const feetInchesToCm = (feet: number, inches: number): number =>
  inchesToCm(feet * INCHES_PER_FOOT + inches);

// --- Formatting --------------------------------------------------------------

export function formatHeight(cm: number, system: UnitSystem): string {
  if (system === "metric") return `${Math.round(cm)} cm`;
  const { feet, inches } = cmToFeetInches(cm);
  return `${feet}'${inches}"`;
}

export function formatMass(kg: number, system: UnitSystem): string {
  return system === "metric"
    ? `${Math.round(kg)} kg`
    : `${Math.round(kgToPounds(kg))} lb`;
}

/** Both systems at once, for tooltips: `175 cm (5'9")`. */
export function formatHeightBoth(cm: number): string {
  return `${formatHeight(cm, "metric")} (${formatHeight(cm, "imperial")})`;
}

export function formatMassBoth(kg: number): string {
  return `${formatMass(kg, "metric")} (${formatMass(kg, "imperial")})`;
}

// --- Parsing -----------------------------------------------------------------

/**
 * Parses free-text height into centimetres. Returns null if unparseable.
 *
 * Accepts: `178`, `178cm`, `1.78m`, `6'8"`, `6' 8`, `6ft8in`, `6 feet 8`,
 * `70in`, `70"`.
 *
 * A bare number is ambiguous, so it is interpreted using `assume`: values that
 * look like metres (< 3) are always treated as metres regardless.
 */
export function parseHeightToCm(
  input: string,
  assume: UnitSystem = "metric",
): number | null {
  const text = input.trim().toLowerCase();
  if (!text) return null;

  // Feet and optional inches: 6'8", 6ft 8in, 6 feet 8
  const feetInches = text.match(
    /^(\d+(?:\.\d+)?)\s*(?:'|’|ft|feet|foot)\s*(?:(\d+(?:\.\d+)?)\s*(?:"|”|in|inch|inches)?)?$/,
  );
  if (feetInches?.[1] !== undefined) {
    return feetInchesToCm(Number(feetInches[1]), Number(feetInches[2] ?? 0));
  }

  // Inches only: 70in, 70"
  const inchesOnly = text.match(/^(\d+(?:\.\d+)?)\s*(?:"|”|in|inch|inches)$/);
  if (inchesOnly?.[1] !== undefined) return inchesToCm(Number(inchesOnly[1]));

  const cm = text.match(/^(\d+(?:\.\d+)?)\s*(?:cm|centimet(?:er|re)s?)$/);
  if (cm?.[1] !== undefined) return Number(cm[1]);

  const metres = text.match(/^(\d+(?:\.\d+)?)\s*(?:m|met(?:er|re)s?)$/);
  if (metres?.[1] !== undefined) return Number(metres[1]) * 100;

  const bare = text.match(/^(\d+(?:\.\d+)?)$/);
  if (bare?.[1] !== undefined) {
    const value = Number(bare[1]);
    // "1.78" can only sensibly mean metres.
    if (value > 0 && value < 3) return value * 100;
    return assume === "metric" ? value : inchesToCm(value);
  }

  return null;
}

/**
 * Parses free-text mass into kilograms. Returns null if unparseable.
 * Accepts: `72`, `72kg`, `160lb`, `160 lbs`, `160 pounds`, `11st 4`.
 */
export function parseMassToKg(
  input: string,
  assume: UnitSystem = "metric",
): number | null {
  const text = input.trim().toLowerCase();
  if (!text) return null;

  // Stone (and optional pounds), still common in the UK: 11st 4
  const stone = text.match(
    /^(\d+(?:\.\d+)?)\s*(?:st|stone)\s*(?:(\d+(?:\.\d+)?)\s*(?:lb|lbs|pounds?)?)?$/,
  );
  if (stone?.[1] !== undefined) {
    return poundsToKg(Number(stone[1]) * 14 + Number(stone[2] ?? 0));
  }

  const kg = text.match(/^(\d+(?:\.\d+)?)\s*(?:kg|kilo(?:gram)?s?)$/);
  if (kg?.[1] !== undefined) return Number(kg[1]);

  const pounds = text.match(/^(\d+(?:\.\d+)?)\s*(?:lb|lbs|pounds?|#)$/);
  if (pounds?.[1] !== undefined) return poundsToKg(Number(pounds[1]));

  const bare = text.match(/^(\d+(?:\.\d+)?)$/);
  if (bare?.[1] !== undefined) {
    const value = Number(bare[1]);
    return assume === "metric" ? value : poundsToKg(value);
  }

  return null;
}
