import { ImportMeshAsync } from "@babylonjs/core/Loading/sceneLoader.js";
import { MorphTargetManager } from "@babylonjs/core/Morph/morphTargetManager.js";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh.js";
import type { Mesh } from "@babylonjs/core/Meshes/mesh.js";
import type { Scene } from "@babylonjs/core/scene.js";
import type { Skeleton } from "@babylonjs/core/Bones/skeleton.js";

import type { CharacterRecipe } from "@tpb/recipe";

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

  return {
    mesh,
    skeleton: result.skeletons[0] ?? null,
    manifest,
    morphIndex,
    allMeshes: result.meshes,
  };
}

/** Applies a recipe to a loaded avatar, returning what the solver decided. */
export function applyRecipe(avatar: LoadedAvatar, recipe: CharacterRecipe): SolveResult {
  const solved = solveMorphWeights(recipe, avatar.manifest);
  const manager = avatar.mesh.morphTargetManager;
  if (!manager) return solved;

  for (const [name, weight] of Object.entries(solved.weights)) {
    const index = avatar.morphIndex.get(name);
    if (index !== undefined) manager.getTarget(index).influence = weight;
  }
  return solved;
}
