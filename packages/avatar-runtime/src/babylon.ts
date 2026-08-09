import { ImportMeshAsync } from "@babylonjs/core/Loading/sceneLoader.js";
import { MorphTargetManager } from "@babylonjs/core/Morph/morphTargetManager.js";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh.js";
import type { AnimationGroup } from "@babylonjs/core/Animations/animationGroup.js";
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
}

export interface LoadAvatarOptions {
  /** URL of the base GLB, e.g. "/assets/basemesh.glb". */
  readonly meshUrl: string;
  /** URL of the manifest emitted alongside it. */
  readonly manifestUrl: string;
  readonly scene: Scene;
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
    animations.set(clip.name, group);
  }

  return {
    mesh,
    skeleton: result.skeletons[0] ?? null,
    manifest,
    morphIndex,
    allMeshes: result.meshes,
    animations,
  };
}

/** Plays one clip looped, stopping any others so exactly one is ever active. */
export function playAnimation(avatar: LoadedAvatar, name: string): void {
  for (const [clipName, group] of avatar.animations) {
    if (clipName === name) group.start(true);
    else group.stop();
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
