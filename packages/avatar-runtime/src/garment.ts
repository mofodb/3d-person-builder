import { z } from "zod";

/**
 * Schema for `assets/dist/clothing.<slot>.<name>.manifest.json`, emitted by
 * `pipeline/blender/build_clothing.py`.
 *
 * Deliberately lighter than BaseMeshManifestSchema (no rig/ageDial): a garment
 * has no age dial of its own, and its "rig" is always the shared body
 * skeleton, not something the garment file needs to declare.
 */
export const GarmentMorphInfoSchema = z.object({
  name: z.string(),
  macro: z.string(),
  max_delta_cm: z.number(),
});

export const GarmentSlotSchema = z.enum([
  "head",
  "torso",
  "legs",
  "feet",
  "hands",
  "back",
  "accessory",
]);

export const GarmentManifestSchema = z.object({
  slot: GarmentSlotSchema,
  sourceMhclo: z.string(),
  mesh: z.object({
    vertices: z.number().int().positive(),
    triangles: z.number().int().positive(),
  }),
  morphs: z.array(GarmentMorphInfoSchema).min(1),
});

export type GarmentSlot = z.infer<typeof GarmentSlotSchema>;
export type GarmentManifest = z.infer<typeof GarmentManifestSchema>;

export function parseGarmentManifest(input: unknown): GarmentManifest {
  return GarmentManifestSchema.parse(input);
}
