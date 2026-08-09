/**
 * Measures real body dimensions from the shipped GLB for a set of archetypes.
 *
 * This reads the actual asset the browser loads, applies the morph influences the
 * solver would choose, and reports torso and limb sizes in centimetres. It exists
 * because "the body does not change enough" is a visual complaint that needs
 * numbers to fix and to keep fixed.
 *
 * Run: pnpm --filter @tpb/avatar-runtime measure
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { createDefaultRecipe, feetInchesToCm, poundsToKg } from "@tpb/recipe";
import { parseManifest, solveMorphWeights } from "@tpb/avatar-runtime";

const GLB_PATH = fileURLToPath(new URL("../../../assets/dist/basemesh.glb", import.meta.url));
const MANIFEST_PATH = fileURLToPath(
  new URL("../../../assets/dist/basemesh.manifest.json", import.meta.url),
);

// --- Minimal GLB reader -------------------------------------------------------

function readGlb(path) {
  const buffer = readFileSync(path);
  const jsonLength = buffer.readUInt32LE(12);
  const json = JSON.parse(buffer.subarray(20, 20 + jsonLength).toString("utf8"));
  // Skip the BIN chunk's 8-byte header.
  const binStart = 20 + jsonLength + 8;
  return { json, bin: buffer.subarray(binStart) };
}

const INDEX_READERS = {
  5121: (buf, at) => buf.readUInt8(at),
  5123: (buf, at) => buf.readUInt16LE(at),
  5125: (buf, at) => buf.readUInt32LE(at),
};
const INDEX_SIZES = { 5121: 1, 5123: 2, 5125: 4 };

/**
 * Reads a vec3 float accessor, including sparse ones.
 *
 * Morph targets are commonly sparse: Blender emits a sparse accessor whenever a
 * morph moves only part of the mesh, which is true of every localized morph like
 * belly or arm thickness. Ignoring `accessor.sparse` makes those morphs look
 * empty, which is exactly the false alarm this comment exists to prevent.
 */
function readAccessor(glb, index) {
  const accessor = glb.json.accessors[index];
  if (accessor.componentType !== 5126) {
    throw new Error(`Expected float accessor, got componentType ${accessor.componentType}`);
  }

  const out = new Float32Array(accessor.count * 3);

  // A missing bufferView means the dense base is all zeros.
  if (accessor.bufferView !== undefined) {
    const view = glb.json.bufferViews[accessor.bufferView];
    const offset = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
    for (let i = 0; i < accessor.count * 3; i++) {
      out[i] = glb.bin.readFloatLE(offset + i * 4);
    }
  }

  if (accessor.sparse) {
    const { count, indices, values } = accessor.sparse;
    const indexView = glb.json.bufferViews[indices.bufferView];
    const indexBase = (indexView.byteOffset ?? 0) + (indices.byteOffset ?? 0);
    const readIndex = INDEX_READERS[indices.componentType];
    const indexSize = INDEX_SIZES[indices.componentType];
    if (!readIndex) {
      throw new Error(`Unsupported sparse index componentType ${indices.componentType}`);
    }

    const valueView = glb.json.bufferViews[values.bufferView];
    const valueBase = (valueView.byteOffset ?? 0) + (values.byteOffset ?? 0);

    for (let i = 0; i < count; i++) {
      const vertex = readIndex(glb.bin, indexBase + i * indexSize);
      for (let axis = 0; axis < 3; axis++) {
        out[vertex * 3 + axis] = glb.bin.readFloatLE(valueBase + (i * 3 + axis) * 4);
      }
    }
  }

  return out;
}

// --- Measurement --------------------------------------------------------------

/**
 * Extent of the body at a fraction of its height, ignoring the arms.
 *
 * The base mesh is in an A-pose, so a naive horizontal slice spans fingertip to
 * fingertip and never changes with body shape. Restricting to vertices near the
 * centre line keeps the measurement on the torso.
 */
function torsoSection(positions, fraction, torsoHalfWidth = 0.22) {
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    const z = positions[i + 1]; // glTF is Y-up
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  const target = minZ + (maxZ - minZ) * fraction;
  const band = (maxZ - minZ) * 0.015;

  let minX = Infinity;
  let maxX = -Infinity;
  let minD = Infinity;
  let maxD = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i];
    const y = positions[i + 1];
    const d = positions[i + 2];
    if (Math.abs(y - target) > band) continue;
    if (Math.abs(x) > torsoHalfWidth) continue; // exclude arms
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (d < minD) minD = d;
    if (d > maxD) maxD = d;
  }
  return {
    width: (maxX - minX) * 100,
    depth: (maxD - minD) * 100,
    heightCm: (maxZ - minZ) * 100,
  };
}

/** Thickness of the upper arm, measured away from the centre line. */
function upperArmThickness(positions, fraction = 0.72) {
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    const z = positions[i + 1];
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  const target = minZ + (maxZ - minZ) * fraction;
  const band = (maxZ - minZ) * 0.015;

  let minD = Infinity;
  let maxD = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i];
    const y = positions[i + 1];
    const d = positions[i + 2];
    if (Math.abs(y - target) > band) continue;
    if (x < 0.24) continue; // right arm only
    if (d < minD) minD = d;
    if (d > maxD) maxD = d;
  }
  return (maxD - minD) * 100;
}

function applyWeights(base, targets, targetNames, weights) {
  const out = Float32Array.from(base);
  targetNames.forEach((name, index) => {
    const influence = weights[name] ?? 0;
    if (influence === 0) return;
    const delta = targets[index];
    for (let i = 0; i < out.length; i++) out[i] += delta[i] * influence;
  });
  return out;
}

// --- Main ---------------------------------------------------------------------

const glb = readGlb(GLB_PATH);
const manifest = parseManifest(JSON.parse(readFileSync(MANIFEST_PATH, "utf8")));

const primitive = glb.json.meshes[0].primitives[0];
const basePositions = readAccessor(glb, primitive.attributes.POSITION);
const targetNames = glb.json.meshes[0].extras.targetNames;
const targetDeltas = primitive.targets.map((t) => readAccessor(glb, t.POSITION));

const tall = feetInchesToCm(6, 2);
const archetypes = [
  ["skinny   150lb 12%", { heightCm: tall, massKg: poundsToKg(150), bodyFatPercent: 12 }],
  ["average  190lb 20%", { heightCm: tall, massKg: poundsToKg(190), bodyFatPercent: 20 }],
  ["muscular 240lb 12%", { heightCm: tall, massKg: poundsToKg(240), bodyFatPercent: 12 }],
  ["fat      240lb 35%", { heightCm: tall, massKg: poundsToKg(240), bodyFatPercent: 35 }],
  ["obese    300lb 45%", { heightCm: tall, massKg: poundsToKg(300), bodyFatPercent: 45 }],
];

const base = createDefaultRecipe();
const rows = [];

for (const [label, patch] of archetypes) {
  const recipe = { ...base, body: { ...base.body, gender: 1, ...patch } };
  const solved = solveMorphWeights(recipe, manifest);
  const positions = applyWeights(basePositions, targetDeltas, targetNames, solved.weights);

  const waist = torsoSection(positions, 0.55);
  const chest = torsoSection(positions, 0.72);
  rows.push({
    label,
    height: waist.heightCm,
    waistW: waist.width,
    waistD: waist.depth,
    chestW: chest.width,
    arm: upperArmThickness(positions),
  });
}

console.log(
  "archetype".padEnd(20),
  "height".padStart(8),
  "waistW".padStart(8),
  "waistD".padStart(8),
  "chestW".padStart(8),
  "armThk".padStart(8),
);
for (const r of rows) {
  console.log(
    r.label.padEnd(20),
    r.height.toFixed(1).padStart(8),
    r.waistW.toFixed(1).padStart(8),
    r.waistD.toFixed(1).padStart(8),
    r.chestW.toFixed(1).padStart(8),
    r.arm.toFixed(1).padStart(8),
  );
}

const skinny = rows[0];
const obese = rows[rows.length - 1];
console.log("\nwaist depth span skinny -> obese:", (obese.waistD - skinny.waistD).toFixed(1), "cm");
console.log("waist width span skinny -> obese:", (obese.waistW - skinny.waistW).toFixed(1), "cm");
console.log(
  "arm thickness span skinny -> muscular:",
  (rows[2].arm - skinny.arm).toFixed(1),
  "cm",
);
