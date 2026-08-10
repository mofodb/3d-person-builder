/**
 * Loads the REAL basemesh.glb through REAL Babylon.js (NullEngine, no
 * browser/GPU needed) and measures actual skinned vertex positions, applying
 * the exact runtime code path (loadAvatar/applyRecipe) rather than inspecting
 * Blender source data or trusting the TypeScript types. This exists because
 * two previous fixes for the same "hands distort at extreme heights" bug
 * looked correct from Blender-side measurement and passed typecheck, but were
 * still wrong at runtime -- the actual skinning composition is the only thing
 * that matters, and this is the only way to test it without a browser.
 *
 * Run: node packages/avatar-runtime/scripts/verify-runtime.mjs
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera.js";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine.js";
import { Vector3 } from "@babylonjs/core/Maths/math.vector.js";
import { Scene } from "@babylonjs/core/scene.js";
import "@babylonjs/loaders/glTF/2.0/index.js";

import { createDefaultRecipe, feetInchesToCm } from "@tpb/recipe";
import { applyRecipe, loadAvatar } from "@tpb/avatar-runtime/babylon";

const DIST_DIR = fileURLToPath(new URL("../../../assets/dist/", import.meta.url));
const GLB_BYTES = readFileSync(DIST_DIR + "basemesh.glb");
const MANIFEST_JSON = readFileSync(DIST_DIR + "basemesh.manifest.json", "utf8");

// Babylon fetches the manifest via the standard `fetch` (Node has this
// natively) but loads the GLB itself through its own WebRequest wrapper around
// XMLHttpRequest, which Node has no global for at all. Both are shimmed here
// to serve the local file bytes for whatever URL we hand them, sidestepping
// the need for an actual HTTP server for what is otherwise a pure Node script.
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, ...rest) => {
  const href = String(url);
  if (href.endsWith("basemesh.glb")) return new Response(GLB_BYTES, { status: 200 });
  if (href.endsWith("basemesh.manifest.json")) return new Response(MANIFEST_JSON, { status: 200 });
  return originalFetch(url, ...rest);
};

class NodeXMLHttpRequest {
  static DONE = 4;
  readyState = 0;
  status = 0;
  response = null;
  responseType = "";
  #listeners = new Map();
  #url = "";

  addEventListener(type, handler) {
    if (!this.#listeners.has(type)) this.#listeners.set(type, new Set());
    this.#listeners.get(type).add(handler);
  }
  removeEventListener(type, handler) {
    this.#listeners.get(type)?.delete(handler);
  }
  #emit(type) {
    for (const handler of this.#listeners.get(type) ?? []) handler();
  }
  open(_method, url) {
    this.#url = url;
    this.readyState = 1;
  }
  abort() {
    this.readyState = 0;
  }
  getResponseHeader() {
    return null;
  }
  getAllResponseHeaders() {
    return "";
  }
  send() {
    queueMicrotask(() => {
      const bytes = this.#url.endsWith("basemesh.glb") ? GLB_BYTES : null;
      if (!bytes) {
        this.status = 404;
        this.readyState = NodeXMLHttpRequest.DONE;
        this.#emit("readystatechange");
        this.#emit("loadend");
        return;
      }
      this.status = 200;
      this.response =
        this.responseType === "arraybuffer"
          ? bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
          : bytes.toString("utf8");
      this.readyState = NodeXMLHttpRequest.DONE;
      this.#emit("readystatechange");
      this.#emit("loadend");
    });
  }
}
globalThis.XMLHttpRequest = NodeXMLHttpRequest;

/** World-space distance between two bones -- the actual "reach" of a chain. */
function boneDistance(mesh, skeleton, nameA, nameB) {
  const a = skeleton.bones.find((b) => b.name === nameA).getAbsolutePosition(mesh);
  const b = skeleton.bones.find((b) => b.name === nameB).getAbsolutePosition(mesh);
  return a.subtract(b).length();
}

async function measureAt(scene, avatar, heightCm, frame) {
  const base = createDefaultRecipe();
  const recipe = { ...base, body: { ...base.body, heightCm, gender: 0 } };
  const solved = applyRecipe(avatar, recipe);

  const idle = scene.getAnimationGroupByName("Idle");
  idle.start(true);
  idle.goToFrame(frame);
  scene.render();

  const shoulderToElbowCm = boneDistance(avatar.mesh, avatar.skeleton, "mixamorig:LeftArm", "mixamorig:LeftForeArm") * 100;
  const elbowToWristCm = boneDistance(avatar.mesh, avatar.skeleton, "mixamorig:LeftForeArm", "mixamorig:LeftHand") * 100;
  const hipToKneeCm = boneDistance(avatar.mesh, avatar.skeleton, "mixamorig:LeftUpLeg", "mixamorig:LeftLeg") * 100;

  console.log(
    `height=${heightCm.toFixed(0)}cm frame=${frame}  resulting=${solved.resultingHeightCm.toFixed(1)}  ` +
      `upperArm=${shoulderToElbowCm.toFixed(2)}cm  forearm=${elbowToWristCm.toFixed(2)}cm  ` +
      `thigh(unaffected, for scale)=${hipToKneeCm.toFixed(2)}cm`,
  );
  return { shoulderToElbowCm, elbowToWristCm, hipToKneeCm };
}

async function main() {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  new FreeCamera("camera", new Vector3(0, 1, -3), scene);

  const avatar = await loadAvatar({
    meshUrl: "basemesh.glb",
    manifestUrl: "basemesh.manifest.json",
    scene,
  });

  const heights = {
    short: feetInchesToCm(4, 11),
    normal: feetInchesToCm(5, 9),
    tall: feetInchesToCm(6, 11),
  };

  console.log("=== Idle, frame 0 (rest-ish) ===");
  const rest = {};
  for (const [label, cm] of Object.entries(heights)) {
    rest[label] = await measureAt(scene, avatar, cm, 0);
  }

  console.log("\n=== Idle, frame 15 (mid-cycle, posed) ===");
  const posed = {};
  for (const [label, cm] of Object.entries(heights)) {
    posed[label] = await measureAt(scene, avatar, cm, 15);
  }

  console.log("\n=== Sanity checks ===");
  const forearmGrows = posed.tall.elbowToWristCm > posed.normal.elbowToWristCm
    && posed.normal.elbowToWristCm > posed.short.elbowToWristCm;
  console.log("Forearm length increases monotonically with height:", forearmGrows);

  const restVsPosedDrift = Math.abs(posed.tall.elbowToWristCm - rest.tall.elbowToWristCm);
  console.log(
    `Tall forearm length, rest vs posed: ${rest.tall.elbowToWristCm.toFixed(2)}cm vs ` +
      `${posed.tall.elbowToWristCm.toFixed(2)}cm (drift ${restVsPosedDrift.toFixed(2)}cm; ` +
      "a real bone-length property must not change between rest and posed)",
  );

  if (!forearmGrows || restVsPosedDrift > 0.5) {
    console.error("\nFAILED: runtime bone correction is not behaving as intended.");
    process.exitCode = 1;
  } else {
    console.log("\nOK");
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
