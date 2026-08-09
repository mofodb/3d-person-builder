import { clamp01 } from "./ranges.ts";
import type { SkinParams } from "./schema.ts";

/**
 * Maps skin.tone (0..1) and skin.tint onto an actual RGB color.
 *
 * Framework-free by design: this returns plain 0..1 RGB so any renderer can
 * consume it. The Babylon binding lives in avatar-runtime/babylon.ts.
 */

export interface RgbColor {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

/**
 * Perceptually-ordered skin tone ramp, lightest to darkest. Values are
 * approximate melanin-range references, not tied to any ethnicity -- tone is a
 * single slider along a gradient, with `body.ancestry` and photo-derived
 * identity separately driving facial structure.
 */
const SKIN_TONE_RAMP: readonly RgbColor[] = [
  { r: 0.94, g: 0.8, b: 0.69 },
  { r: 0.87, g: 0.68, b: 0.55 },
  { r: 0.76, g: 0.57, b: 0.44 },
  { r: 0.6, g: 0.43, b: 0.32 },
  { r: 0.44, g: 0.31, b: 0.22 },
  { r: 0.29, g: 0.2, b: 0.14 },
  { r: 0.17, g: 0.12, b: 0.09 },
];

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

function lerpColor(a: RgbColor, b: RgbColor, t: number): RgbColor {
  return { r: lerp(a.r, b.r, t), g: lerp(a.g, b.g, t), b: lerp(a.b, b.b, t) };
}

/** Samples the skin tone ramp at a normalized position. */
export function sampleSkinToneRamp(tone: number): RgbColor {
  const t = clamp01(tone);
  const scaled = t * (SKIN_TONE_RAMP.length - 1);
  const index = Math.min(SKIN_TONE_RAMP.length - 2, Math.floor(scaled));
  return lerpColor(SKIN_TONE_RAMP[index]!, SKIN_TONE_RAMP[index + 1]!, scaled - index);
}

export function hexToRgb(hex: string): RgbColor {
  const match = /^#?([0-9a-fA-F]{6})$/.exec(hex);
  if (!match) throw new Error(`Not a 6-digit hex color: ${hex}`);
  const value = match[1]!;
  return {
    r: parseInt(value.slice(0, 2), 16) / 255,
    g: parseInt(value.slice(2, 4), 16) / 255,
    b: parseInt(value.slice(4, 6), 16) / 255,
  };
}

/**
 * The final skin color for a character: ramp sample multiplied by the tint.
 * A tint of #ffffff (the schema default) is the identity element, so untinted
 * characters get exactly the ramp color.
 */
export function computeSkinColor(skin: SkinParams): RgbColor {
  const base = sampleSkinToneRamp(skin.tone);
  const tint = hexToRgb(skin.tint);
  return { r: base.r * tint.r, g: base.g * tint.g, b: base.b * tint.b };
}
