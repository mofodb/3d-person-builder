import { z } from "zod";

/**
 * A CharacterRecipe is the single source of truth for a character.
 *
 * Design rules:
 *  - Every tunable value is NORMALIZED (0..1, or -1..1 when symmetric around a
 *    neutral midpoint). Physical units (cm, kg) live in `ranges.ts`, never here.
 *    This keeps recipes independent of the base mesh, so re-authoring the mesh
 *    does not invalidate saved characters.
 *  - Cosmetics are referenced by stable string ID, never by file path.
 *  - The whole thing must stay small enough to send over a network as JSON
 *    (target < 1 KB) so a game can transmit a character instead of a model.
 */

/** Normalized 0..1. Neutral is usually 0.5 unless documented otherwise. */
const unit = () => z.number().min(0).max(1);

/** Normalized -1..1, symmetric around a neutral 0. */
const bipolar = () => z.number().min(-1).max(1);

const hexColor = () =>
  z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, "must be a 6-digit hex color like #a1b2c3");

/** Stable cosmetic asset identifier, e.g. "hair.bob_short". */
const assetId = () =>
  z.string().regex(/^[a-z0-9]+(\.[a-z0-9_]+)+$/, "must look like 'category.asset_name'");

export const BodyProportionsSchema = z.object({
  shoulderWidth: bipolar().default(0),
  chestSize: bipolar().default(0),
  waist: bipolar().default(0),
  hips: bipolar().default(0),
  armLength: bipolar().default(0),
  legLength: bipolar().default(0),
  neckLength: bipolar().default(0),
  handSize: bipolar().default(0),
  footSize: bipolar().default(0),
});

export const BodySchema = z.object({
  /** 0 = fully feminine, 1 = fully masculine. 0.5 is androgynous. */
  gender: unit().default(0.5),
  /** 0..1 maps onto an age range; see ranges.ts. */
  age: unit().default(0.35),
  /** 0..1 maps onto a height range in cm; see ranges.ts. */
  height: unit().default(0.5),
  /** Body fat. 0 = very lean, 1 = heavy. */
  weight: unit().default(0.4),
  /** 0 = untrained, 1 = heavily muscled. */
  muscularity: unit().default(0.35),
  proportions: BodyProportionsSchema.prefault({}),
});

/**
 * Manual face controls, layered ON TOP of any photo-derived identity.
 * These exist because single-photo fitting is imperfect and users must be able
 * to correct it. Applied after `identity`, additively.
 */
export const FaceOverridesSchema = z.object({
  noseSize: bipolar().default(0),
  noseWidth: bipolar().default(0),
  noseBridge: bipolar().default(0),
  jawWidth: bipolar().default(0),
  chinLength: bipolar().default(0),
  chinProtrusion: bipolar().default(0),
  cheekbones: bipolar().default(0),
  cheekFullness: bipolar().default(0),
  eyeSize: bipolar().default(0),
  eyeSpacing: bipolar().default(0),
  eyeDepth: bipolar().default(0),
  browHeight: bipolar().default(0),
  browThickness: bipolar().default(0),
  mouthWidth: bipolar().default(0),
  lipFullness: bipolar().default(0),
  earSize: bipolar().default(0),
  foreheadHeight: bipolar().default(0),
});

export const FaceSchema = z.object({
  /**
   * Identity coefficients from a 3DMM fit of a photo, projected onto our head
   * morph basis. Null when the face was not photo-derived.
   * Bounded length so a malicious client cannot send a huge payload.
   */
  identity: z.array(z.number().min(-5).max(5)).max(64).nullable().default(null),
  /**
   * Scales the identity vector. >1 exaggerates distinctive features, which
   * counterintuitively tends to INCREASE perceived likeness in stylized art.
   */
  identityStrength: z.number().min(0).max(2).default(1),
  overrides: FaceOverridesSchema.prefault({}),
  source: z.enum(["default", "photo", "manual"]).default("default"),
});

export const SkinSchema = z.object({
  /** Position along a curated, perceptually-ordered skin tone ramp. */
  tone: unit().default(0.5),
  /** Optional hue shift applied over the ramp sample. */
  tint: hexColor().default("#ffffff"),
  roughness: unit().default(0.55),
  /** Freckles, blemishes, scars, tattoos. */
  overlays: z
    .array(z.object({ id: assetId(), opacity: unit().default(1) }))
    .max(8)
    .default([]),
});

export const HairSchema = z.object({
  styleId: assetId().nullable().default(null),
  color: hexColor().default("#3b2417"),
  /** Secondary color for roots/highlights; null disables the effect. */
  accentColor: hexColor().nullable().default(null),
});

export const OutfitSlotSchema = z.object({
  assetId: assetId(),
  /** Per-slot recolor. */
  tint: hexColor().default("#ffffff"),
});

export const OUTFIT_SLOTS = [
  "head",
  "torso",
  "legs",
  "feet",
  "hands",
  "back",
  "accessory",
] as const;

export const OutfitSchema = z.object(
  Object.fromEntries(
    OUTFIT_SLOTS.map((slot) => [slot, OutfitSlotSchema.nullable().default(null)]),
  ) as Record<(typeof OUTFIT_SLOTS)[number], z.ZodDefault<z.ZodNullable<typeof OutfitSlotSchema>>>,
);

export const CHARACTER_RECIPE_VERSION = 1;

export const CharacterRecipeSchema = z.object({
  schemaVersion: z.literal(CHARACTER_RECIPE_VERSION),
  id: z.uuid(),
  name: z.string().min(1).max(64).default("Unnamed"),
  body: BodySchema.prefault({}),
  face: FaceSchema.prefault({}),
  skin: SkinSchema.prefault({}),
  hair: HairSchema.prefault({}),
  facialHair: HairSchema.prefault({}),
  eyeColor: hexColor().default("#4a3b2a"),
  outfit: OutfitSchema.prefault({}),
});

export type BodyParams = z.infer<typeof BodySchema>;
export type FaceParams = z.infer<typeof FaceSchema>;
export type FaceOverrides = z.infer<typeof FaceOverridesSchema>;
export type SkinParams = z.infer<typeof SkinSchema>;
export type HairParams = z.infer<typeof HairSchema>;
export type OutfitSlot = (typeof OUTFIT_SLOTS)[number];
export type Outfit = z.infer<typeof OutfitSchema>;
export type CharacterRecipe = z.infer<typeof CharacterRecipeSchema>;
