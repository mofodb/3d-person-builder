import { ImportMeshAsync } from "@babylonjs/core/Loading/sceneLoader.js";
import { Space } from "@babylonjs/core/Maths/math.axis.js";
import { Vector3 } from "@babylonjs/core/Maths/math.vector.js";
import { MorphTargetManager } from "@babylonjs/core/Morph/morphTargetManager.js";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh.js";
import type { AnimationGroup } from "@babylonjs/core/Animations/animationGroup.js";
import type { Bone } from "@babylonjs/core/Bones/bone.js";
import type { Mesh } from "@babylonjs/core/Meshes/mesh.js";
import type { Scene } from "@babylonjs/core/scene.js";
import type { Skeleton } from "@babylonjs/core/Bones/skeleton.js";

import type { CharacterRecipe } from "@tpb/recipe";

import { parseGarmentManifest } from "./garment.ts";
import type { GarmentManifest, GarmentSlot } from "./garment.ts";
import { parseManifest } from "./manifest.ts";
import type { BaseMeshManifest } from "./manifest.ts";
import { solveMorphWeights } from "./solver.ts";
import type { SolveResult } from "./solver.ts";

/**
 * Babylon binding for the avatar system.
 *
 * Babylon stores morph target data in a texture on WebGL2, which lifts the
 * classic four-targets-per-mesh limit. That matters here: this project needs all
 * 19 body morphs active simultaneously, and eventually face morphs on top. Both
 * `EnableTextureStorage` and an explicit `numMaxInfluencers` are required --
 * without the latter, Babylon falls back to the vertex-attribute path and
 * silently caps the number of simultaneously active targets.
 */

export interface LoadedAvatar {
  readonly mesh: Mesh;
  readonly skeleton: Skeleton | null;
  readonly manifest: BaseMeshManifest;
  /** Morph target name -> index into the MorphTargetManager. */
  readonly morphIndex: ReadonlyMap<string, number>;
  readonly allMeshes: readonly AbstractMesh[];
  /** Animation clip name (e.g. "Idle", "Walking") -> playable group. */
  readonly animations: ReadonlyMap<string, AnimationGroup>;
  /**
   * Each corrected bone's ORIGINAL local position, captured once at load time.
   * Corrections are always computed as `original + weightedDeltaSum`, never
   * incrementally from whatever the bone's position currently is -- bones get
   * repositioned every time the recipe changes, so "currently" would already
   * be a previously-corrected value and compound.
   */
  readonly boneRestPositions: ReadonlyMap<string, Vector3>;
}

export interface LoadAvatarOptions {
  /** URL of the base GLB, e.g. "/assets/basemesh.glb". */
  readonly meshUrl: string;
  /** URL of the manifest emitted alongside it. */
  readonly manifestUrl: string;
  readonly scene: Scene;
}

/**
 * Removes every "position"-animating track from a loaded clip except the
 * Hips bone's.
 *
 * `pipeline/blender/add_animations.py`'s strip_redundant_location_curves()
 * tries to remove these on the Blender side, but Blender's glTF exporter
 * bakes a translation channel for every animated bone via NLA sampling
 * regardless of whether the source action has a location fcurve for it, so
 * the no-op channels reappear in the exported GLB anyway. They must be
 * removed here instead: `applyBoneCorrections()` repositions non-Hips bones
 * once per recipe change, and a keyframed property always overrides a value
 * set before playback starts, so without this an AnimationGroup would reset
 * every correction back to the uncorrected rest position on the next frame.
 */
function stripNonHipsPositionTracks(group: AnimationGroup): number {
  let removed = 0;
  for (const targeted of [...group.targetedAnimations]) {
    if (targeted.animation.targetProperty !== "position") continue;
    const target = targeted.target as Bone | undefined;
    if (target?.name?.endsWith(":Hips")) continue;
    group.removeTargetedAnimation(targeted.animation);
    removed++;
  }
  return removed;
}

function configureMorphs(mesh: Mesh): ReadonlyMap<string, number> {
  const manager = mesh.morphTargetManager;
  const index = new Map<string, number>();
  if (!manager) return index;

  MorphTargetManager.EnableTextureStorage = true;
  // Keep every target influenceable at once. Left unset, Babylon reverts to the
  // vertex-attribute path and quietly drops targets beyond its limit.
  manager.numMaxInfluencers = manager.numTargets;
  // Influences change on nearly every slider tick, so do not skip zero-weight
  // targets; that would force a shader recompile as sliders cross zero.
  manager.optimizeInfluencers = false;

  for (let i = 0; i < manager.numTargets; i++) {
    index.set(manager.getTarget(i).name, i);
  }
  return index;
}

export async function loadAvatar(options: LoadAvatarOptions): Promise<LoadedAvatar> {
  const { meshUrl, manifestUrl, scene } = options;

  const [result, manifestJson] = await Promise.all([
    ImportMeshAsync(meshUrl, scene),
    fetch(manifestUrl).then((response) => {
      if (!response.ok) {
        throw new Error(`Failed to load manifest ${manifestUrl}: ${response.status}`);
      }
      return response.json() as Promise<unknown>;
    }),
  ]);

  const manifest = parseManifest(manifestJson);

  const mesh = result.meshes.find(
    (candidate): candidate is Mesh =>
      (candidate as Mesh).morphTargetManager !== undefined &&
      (candidate as Mesh).morphTargetManager !== null,
  );
  if (!mesh) {
    throw new Error(
      `No mesh with morph targets found in ${meshUrl}. ` +
        "Was the GLB exported with export_morph enabled?",
    );
  }

  const morphIndex = configureMorphs(mesh);

  const missing = manifest.morphs
    .map((morph) => morph.name)
    .filter((name) => !morphIndex.has(name));
  if (missing.length > 0) {
    throw new Error(
      `Manifest lists morphs absent from the mesh: ${missing.join(", ")}. ` +
        "The GLB and manifest are out of sync; rerun the asset pipeline.",
    );
  }

  // ImportMeshAsync loads animation groups onto the scene but does not return
  // them, so they are recovered by name against what the manifest says the GLB
  // should contain, rather than trusting every group already in the scene
  // (which would break once a second avatar is ever loaded).
  const animations = new Map<string, AnimationGroup>();
  for (const clip of manifest.animations) {
    const group = scene.getAnimationGroupByName(clip.name);
    if (!group) {
      throw new Error(
        `Manifest lists animation "${clip.name}" absent from the mesh. ` +
          "The GLB and manifest are out of sync; rerun the asset pipeline.",
      );
    }
    group.stop();
    stripNonHipsPositionTracks(group);
    animations.set(clip.name, group);
  }

  const skeleton = result.skeletons[0] ?? null;
  const boneRestPositions = new Map<string, Vector3>();
  if (skeleton) {
    for (const boneName of Object.keys(manifest.boneCorrections)) {
      const bone = skeleton.bones.find((candidate) => candidate.name === boneName);
      if (bone) boneRestPositions.set(boneName, positionOf(bone).clone());
    }
  }

  return {
    mesh,
    skeleton,
    manifest,
    morphIndex,
    allMeshes: result.meshes,
    animations,
    boneRestPositions,
  };
}

/** Plays one clip looped, stopping any others so exactly one is ever active. */
export function playAnimation(avatar: LoadedAvatar, name: string): void {
  for (const [clipName, group] of avatar.animations) {
    if (clipName === name) group.start(true);
    else group.stop();
  }
}

/**
 * Where a bone's LOCAL position actually lives.
 *
 * Babylon's glTF loader links every imported `Bone` to a `TransformNode` (one
 * per glTF joint node) and glTF animations target that node directly, not the
 * Bone object -- confirmed the hard way, by writing a headless verification
 * script: `Bone.setPosition()` silently had NO effect on the actual skinned
 * result at all, because skinning reads the linked node's position, which
 * `setPosition` never touched. The linked node's `.position` is already
 * expressed in the parent's local space, matching `Space.LOCAL` semantics, so
 * no space conversion is needed once you're looking at the right object.
 */
function positionOf(bone: Bone): Vector3 {
  return bone.getTransformNode()?.position ?? bone.getPosition(Space.LOCAL);
}

/**
 * Repositions each corrected bone to track the current recipe's actual body
 * proportions, closing the gap described on `LoadedAvatar.boneRestPositions`
 * and `BoneCorrectionsSchema`: body-shape morphs reshape the mesh but never
 * move the skeleton that was bound to it at average proportions, which is
 * invisible at rest and increasingly wrong on posed (animated) limbs the
 * further a recipe's height/build sits from that average.
 *
 * Must run AFTER `pipeline/blender/add_animations.py`'s
 * strip_redundant_location_curves has removed the non-Hips bones' no-op
 * location animation channels: otherwise Babylon's AnimationGroup would
 * silently reset these positions to their original (uncorrected) values on
 * every rendered frame, since a keyframed property always overrides a value
 * set before playback started.
 */
function applyBoneCorrections(avatar: LoadedAvatar, weights: Readonly<Record<string, number>>): void {
  if (!avatar.skeleton) return;

  for (const [boneName, deltasByMorph] of Object.entries(avatar.manifest.boneCorrections)) {
    const rest = avatar.boneRestPositions.get(boneName);
    if (!rest) continue;
    const bone: Bone | undefined = avatar.skeleton.bones.find((b) => b.name === boneName);
    if (!bone) continue;

    let dx = 0;
    let dy = 0;
    let dz = 0;
    for (const [morphName, [ddxCm, ddyCm, ddzCm]] of Object.entries(deltasByMorph)) {
      const weight = weights[morphName];
      if (!weight) continue;
      dx += weight * ddxCm!;
      dy += weight * ddyCm!;
      dz += weight * ddzCm!;
    }

    // Deltas are authored in cm (consistent with the rest of the manifest);
    // the scene, like the rest position read from the loaded GLB, is in metres.
    const corrected = new Vector3(rest.x + dx / 100, rest.y + dy / 100, rest.z + dz / 100);
    const linkedNode = bone.getTransformNode();
    if (linkedNode) linkedNode.position = corrected;
    else bone.setPosition(corrected, Space.LOCAL);
  }
}

/** Writes a solved weight map onto any mesh's morph targets by name. */
function applyMorphWeights(
  mesh: Mesh,
  morphIndex: ReadonlyMap<string, number>,
  weights: Readonly<Record<string, number>>,
): void {
  const manager = mesh.morphTargetManager;
  if (!manager) return;
  for (const [name, weight] of Object.entries(weights)) {
    const index = morphIndex.get(name);
    if (index !== undefined) manager.getTarget(index).influence = weight;
  }
}

/** Applies a recipe to a loaded avatar, returning what the solver decided. */
export function applyRecipe(avatar: LoadedAvatar, recipe: CharacterRecipe): SolveResult {
  const solved = solveMorphWeights(recipe, avatar.manifest);
  applyMorphWeights(avatar.mesh, avatar.morphIndex, solved.weights);
  applyBoneCorrections(avatar, solved.weights);
  return solved;
}

// --- Garments -------------------------------------------------------------

export interface LoadedGarment {
  readonly mesh: Mesh;
  readonly slot: GarmentSlot;
  readonly manifest: GarmentManifest;
  readonly morphIndex: ReadonlyMap<string, number>;
}

export interface LoadGarmentOptions {
  readonly meshUrl: string;
  readonly manifestUrl: string;
  readonly scene: Scene;
  /**
   * The avatar this garment is worn on. Its skeleton is REUSED for the
   * garment rather than the garment's own imported one, so the garment
   * actually deforms with Idle/Walking instead of sitting on a second,
   * never-animated skeleton copy that every garment GLB otherwise carries.
   */
  readonly avatar: LoadedAvatar;
}

export async function loadGarment(options: LoadGarmentOptions): Promise<LoadedGarment> {
  const { meshUrl, manifestUrl, scene, avatar } = options;

  const [result, manifestJson] = await Promise.all([
    ImportMeshAsync(meshUrl, scene),
    fetch(manifestUrl).then((response) => {
      if (!response.ok) {
        throw new Error(`Failed to load manifest ${manifestUrl}: ${response.status}`);
      }
      return response.json() as Promise<unknown>;
    }),
  ]);

  const manifest = parseGarmentManifest(manifestJson);

  const mesh = result.meshes.find(
    (candidate): candidate is Mesh =>
      (candidate as Mesh).morphTargetManager !== undefined &&
      (candidate as Mesh).morphTargetManager !== null,
  );
  if (!mesh) {
    throw new Error(`No mesh with morph targets found in ${meshUrl}.`);
  }

  const morphIndex = configureMorphs(mesh);
  const missing = manifest.morphs.map((m) => m.name).filter((name) => !morphIndex.has(name));
  if (missing.length > 0) {
    throw new Error(
      `Garment manifest lists morphs absent from the mesh: ${missing.join(", ")}. ` +
        "The GLB and manifest are out of sync; rerun the asset pipeline.",
    );
  }

  const garmentSkeleton = result.skeletons[0] ?? null;
  if (!avatar.skeleton) {
    throw new Error("Cannot attach a garment to an avatar with no skeleton.");
  }
  if (!garmentSkeleton) {
    throw new Error(`${meshUrl} has no skeleton; it was expected to be rigged.`);
  }

  const bodyBones = avatar.skeleton.bones.map((b) => b.name);
  const garmentBones = garmentSkeleton.bones.map((b) => b.name);
  if (bodyBones.length !== garmentBones.length || bodyBones.some((n, i) => n !== garmentBones[i])) {
    throw new Error(
      `${meshUrl}'s skeleton does not match the avatar's bone-for-bone ` +
        `(${garmentBones.length} vs ${bodyBones.length} bones). Garments must be built ` +
        "against the same rig as the base mesh for skeleton sharing to be valid.",
    );
  }

  // The bone match above is exact by name and order, so it is safe to point the
  // garment at the avatar's already-animated skeleton and discard its own.
  mesh.skeleton = avatar.skeleton;
  garmentSkeleton.dispose();

  return { mesh, slot: manifest.slot, manifest, morphIndex };
}

/** Applies the SAME solved weights the body used to a worn garment. */
export function applyGarmentWeights(
  garment: LoadedGarment,
  weights: Readonly<Record<string, number>>,
): void {
  applyMorphWeights(garment.mesh, garment.morphIndex, weights);
}
