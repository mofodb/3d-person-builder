import { z } from "zod";

/**
 * Schema for `assets/dist/basemesh.manifest.json`, emitted by
 * `pipeline/blender/build_basemesh.py`.
 *
 * This is validated rather than trusted because the manifest and the GLB are
 * generated together and must stay in lockstep. A stale manifest paired with a
 * freshly built mesh is a silent, confusing failure -- morph names would simply
 * not be found and the character would quietly stop responding to sliders.
 */

export const MorphInfoSchema = z.object({
  /** Shape key name, matching the glTF morph target name exactly. */
  name: z.string(),
  /** Macro axis this morph drives, e.g. "height" or "race.asian". */
  macro: z.string(),
  /** Value of that axis when this morph is at full influence. */
  value: z.number(),
  /** Value of that axis in the neutral (Basis) shape. */
  neutral: z.number(),
  /** Largest per-vertex displacement, for sanity checking. */
  max_delta_cm: z.number(),
  /** How much standing height changes when this morph is fully applied. */
  height_delta_cm: z.number(),
});

export const AnimationInfoSchema = z.object({
  /** Clip name, matching the glTF animation name exactly. */
  name: z.string(),
  /** Bone-name coverage against our rig at merge time; see add_animations.py. */
  coverage: z.number().min(0).max(1).optional(),
});

export const BaseMeshManifestSchema = z.object({
  rig: z.object({ name: z.string(), bones: z.number().int().positive() }),
  mesh: z.object({
    vertices: z.number().int().positive(),
    triangles: z.number().int().positive(),
    shape_keys: z.number().int().nonnegative(),
  }),
  morphs: z.array(MorphInfoSchema).min(1),
  /** Standing height of the neutral shape, in centimetres. */
  neutralHeightCm: z.number().positive(),
  ageDial: z.object({
    neutralYears: z.number(),
    minYears: z.number(),
    maxYears: z.number(),
  }),
  /** Empty until pipeline/blender/add_animations.py has been run. */
  animations: z.array(AnimationInfoSchema).default([]),
});

export type MorphInfo = z.infer<typeof MorphInfoSchema>;
export type AnimationInfo = z.infer<typeof AnimationInfoSchema>;
export type BaseMeshManifest = z.infer<typeof BaseMeshManifestSchema>;

export function parseManifest(input: unknown): BaseMeshManifest {
  return BaseMeshManifestSchema.parse(input);
}
