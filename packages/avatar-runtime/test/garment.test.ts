import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { parseGarmentManifest } from "../src/garment.ts";
import { parseManifest } from "../src/manifest.ts";

/**
 * Tests run against the real generated garment manifests, same policy as
 * solver.test.ts: they fail if the clothing pipeline changes shape, which is
 * exactly when this needs revisiting.
 */
const DIST_DIR = fileURLToPath(new URL("../../../assets/dist/", import.meta.url));

function loadGarmentManifest(filename: string) {
  return parseGarmentManifest(JSON.parse(readFileSync(DIST_DIR + filename, "utf8")));
}

const bodyManifest = parseManifest(
  JSON.parse(readFileSync(DIST_DIR + "basemesh.manifest.json", "utf8")),
);

test("the t-shirt manifest is well formed", () => {
  const manifest = loadGarmentManifest("clothing.torso.tshirt.manifest.json");
  assert.equal(manifest.slot, "torso");
  assert.ok(manifest.mesh.vertices > 0);
  assert.ok(manifest.morphs.length >= 19);
});

test("the cargo pants manifest is well formed", () => {
  const manifest = loadGarmentManifest("clothing.legs.cargo_pants.manifest.json");
  assert.equal(manifest.slot, "legs");
});

test("every garment morph name exists on the body too", () => {
  // This is the whole point of the design: the body's solved weights can be
  // applied directly to a garment because the names line up exactly.
  const bodyNames = new Set(bodyManifest.morphs.map((m) => m.name));
  for (const file of ["clothing.torso.tshirt.manifest.json", "clothing.legs.cargo_pants.manifest.json"]) {
    const garment = loadGarmentManifest(file);
    for (const morph of garment.morphs) {
      assert.ok(bodyNames.has(morph.name), `${file}: ${morph.name} has no body counterpart`);
    }
  }
});

test("pants do not respond to bust morphs, t-shirt does", () => {
  const pants = loadGarmentManifest("clothing.legs.cargo_pants.manifest.json");
  const shirt = loadGarmentManifest("clothing.torso.tshirt.manifest.json");

  const pantsCup = pants.morphs.find((m) => m.name === "cupsize_large");
  const shirtCup = shirt.morphs.find((m) => m.name === "cupsize_large");

  assert.equal(pantsCup?.max_delta_cm, 0);
  assert.ok(shirtCup && shirtCup.max_delta_cm > 1, `shirt cupsize delta was ${shirtCup?.max_delta_cm}`);
});

test("garments respond to height roughly like the body does", () => {
  for (const file of ["clothing.torso.tshirt.manifest.json", "clothing.legs.cargo_pants.manifest.json"]) {
    const garment = loadGarmentManifest(file);
    const tall = garment.morphs.find((m) => m.name === "height_tall");
    assert.ok(tall && tall.max_delta_cm > 10, `${file}: height_tall delta was ${tall?.max_delta_cm}`);
  }
});
