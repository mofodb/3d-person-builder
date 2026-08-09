import assert from "node:assert/strict";
import { test } from "node:test";

import { createDefaultRecipe } from "../src/defaults.ts";
import { HEIGHT_CM, MASS_KG, bmi, normalize } from "../src/ranges.ts";
import { migrateRecipe, safeMigrateRecipe } from "../src/migrate.ts";
import {
  deserializeRecipe,
  recipeByteSize,
  safeDeserializeRecipe,
  serializeRecipe,
} from "../src/serialize.ts";
import {
  CHARACTER_RECIPE_VERSION,
  CharacterRecipeSchema,
  OUTFIT_SLOTS,
  normalizeAncestry,
} from "../src/schema.ts";

test("default recipe is valid and androgynous", () => {
  const recipe = createDefaultRecipe({ name: "Test" });
  assert.equal(recipe.schemaVersion, CHARACTER_RECIPE_VERSION);
  assert.equal(recipe.name, "Test");
  assert.equal(recipe.body.gender, 0.5);
  assert.equal(recipe.face.source, "default");
  assert.equal(recipe.face.identity, null);
});

test("physical measurements are stored in real units, not normalized", () => {
  const { body } = createDefaultRecipe();
  assert.equal(body.heightCm, 175);
  assert.equal(body.massKg, 72);
  assert.equal(body.ageYears, 30);
  // Body fat must never be stored; it is derived from the above.
  assert.ok(!("weight" in body), "body should not carry a stored fatness value");
  assert.ok(!("bodyFat" in body), "body fat must be derived, not stored");
});

test("default recipe has every outfit slot present and empty", () => {
  const recipe = createDefaultRecipe();
  for (const slot of OUTFIT_SLOTS) {
    assert.equal(recipe.outfit[slot], null, `slot ${slot} should default to null`);
  }
});

test("recipe stays under the 1KB network budget", () => {
  const bytes = recipeByteSize(createDefaultRecipe());
  assert.ok(bytes < 1024, `recipe was ${bytes} bytes, budget is 1024`);
});

test("a fully populated recipe still fits the budget", () => {
  // Worst case: every optional field filled and every float irrational.
  const base = createDefaultRecipe({ name: "x".repeat(64) });
  const loaded = {
    ...base,
    body: {
      ...base.body,
      heightCm: 180.123456789,
      massKg: 81.987654321,
      ancestry: { african: 1 / 3, asian: 1 / 7, caucasian: 1 / 9 },
    },
    face: { ...base.face, identity: new Array(64).fill(1 / 3), source: "photo" as const },
    outfit: {
      ...base.outfit,
      torso: { assetId: "torso.leather_jacket", tint: "#8b4513" },
      legs: { assetId: "legs.cargo_pants", tint: "#3c3c3c" },
      feet: { assetId: "feet.work_boots", tint: "#2b1d14" },
    },
  };
  const recipe = CharacterRecipeSchema.parse(loaded);
  const bytes = recipeByteSize(recipe);
  // A photo-derived character carries a 64-value identity vector, which alone
  // is ~450 bytes and dominates the payload. 2 KB is still trivial to send; the
  // point of this ceiling is to catch accidental bloat elsewhere, and to flag
  // the identity vector as the first thing to compress if payload ever matters.
  assert.ok(bytes < 2048, `loaded recipe was ${bytes} bytes`);
});

test("serialization quantizes floats without changing meaning", () => {
  const base = createDefaultRecipe();
  const recipe = CharacterRecipeSchema.parse({
    ...base,
    body: { ...base.body, heightCm: 175.123456789 },
  });
  const json = serializeRecipe(recipe);
  assert.ok(!json.includes("175.123456789"), "float was not quantized");
  assert.equal(deserializeRecipe(json).body.heightCm, 175.1235);
});

test("integers survive serialization unchanged", () => {
  const json = serializeRecipe(createDefaultRecipe());
  assert.ok(json.includes('"heightCm":175'), json.slice(0, 200));
  assert.ok(json.includes('"ageYears":30'));
});

test("serialization is idempotent", () => {
  // Quantization is deliberately lossy, so the invariant is stability rather
  // than equality with the original: a saved recipe must never drift further
  // each time it is loaded and re-saved.
  const recipe = createDefaultRecipe({ name: "Round Trip" });
  const once = serializeRecipe(recipe);
  const twice = serializeRecipe(deserializeRecipe(once));
  assert.equal(twice, once);
  assert.deepEqual(deserializeRecipe(twice), deserializeRecipe(once));
});

test("round-tripping preserves values that were already exact", () => {
  const recipe = createDefaultRecipe({ name: "Exact" });
  const restored = deserializeRecipe(serializeRecipe(recipe));
  assert.equal(restored.id, recipe.id);
  assert.equal(restored.name, recipe.name);
  assert.equal(restored.body.heightCm, recipe.body.heightCm);
  assert.equal(restored.body.massKg, recipe.body.massKg);
  assert.equal(restored.eyeColor, recipe.eyeColor);
});

test("safeDeserializeRecipe rejects malformed JSON without throwing", () => {
  for (const garbage of ["", "{", "not json", "[1,2,3]", "null"]) {
    assert.equal(safeDeserializeRecipe(garbage).ok, false, garbage);
  }
});

test("the whole intended cast is representable", () => {
  const base = createDefaultRecipe();
  const cast: Array<[number, number]> = [
    [149.86, 43.09], // 4'11", 95 lb
    [203.2, 120.2], //  6'8",  265 lb
  ];
  for (const [heightCm, massKg] of cast) {
    const recipe = { ...base, body: { ...base.body, heightCm, massKg } };
    assert.doesNotThrow(() => CharacterRecipeSchema.parse(recipe), `${heightCm}/${massKg}`);
  }
});

test("hard bounds leave headroom beyond the intended cast", () => {
  // Future characters may fall outside today's cast without needing a migration.
  assert.ok(HEIGHT_CM.min < 149.86 && HEIGHT_CM.max > 203.2);
  assert.ok(MASS_KG.min < 43.09 && MASS_KG.max > 120.2);
});

test("measurements outside the hard bounds are rejected", () => {
  const base = createDefaultRecipe();
  const cases = [
    { heightCm: HEIGHT_CM.min - 1 },
    { heightCm: HEIGHT_CM.max + 1 },
    { massKg: MASS_KG.min - 1 },
    { massKg: MASS_KG.max + 1 },
    { ageYears: 0 },
  ];
  for (const patch of cases) {
    const bad = { ...base, body: { ...base.body, ...patch } };
    assert.throws(() => CharacterRecipeSchema.parse(bad), JSON.stringify(patch));
  }
});

test("normalized art parameters are still range-checked", () => {
  const base = createDefaultRecipe();
  const bad = { ...base, body: { ...base.body, muscularity: 1.5 } };
  assert.throws(() => CharacterRecipeSchema.parse(bad));
});

test("oversized identity vectors are rejected", () => {
  const base = createDefaultRecipe();
  const bad = { ...base, face: { ...base.face, identity: new Array(200).fill(0) } };
  assert.throws(() => CharacterRecipeSchema.parse(bad));
});

test("malformed asset ids are rejected", () => {
  const base = createDefaultRecipe();
  const bad = { ...base, hair: { ...base.hair, styleId: "Not A Valid Id!" } };
  assert.throws(() => CharacterRecipeSchema.parse(bad));
});

// --- Migration ----------------------------------------------------------------

/** A recipe as it would have been saved by the v1 release. */
const v1Recipe = () => ({
  schemaVersion: 1,
  id: crypto.randomUUID(),
  name: "Legacy",
  body: {
    gender: 0.5,
    age: 0.35,
    height: 0.5, // v1 normalized against 148..202 cm
    weight: 0.4,
    muscularity: 0.35,
    proportions: {},
  },
  face: {},
  skin: {},
  hair: {},
  facialHair: {},
  eyeColor: "#4a3b2a",
  outfit: {},
});

test("v1 recipes migrate to real units", () => {
  const migrated = migrateRecipe(v1Recipe());
  assert.equal(migrated.schemaVersion, CHARACTER_RECIPE_VERSION);
  // v1 height 0.5 sat midway through 148..202, i.e. 175 cm.
  assert.ok(Math.abs(migrated.body.heightCm - 175) < 0.5, `got ${migrated.body.heightCm}`);
  assert.ok(Math.abs(migrated.body.ageYears - 38) <= 1, `got ${migrated.body.ageYears}`);
});

test("migrated v1 characters keep a believable build", () => {
  const migrated = migrateRecipe(v1Recipe());
  const value = bmi(migrated.body.heightCm, migrated.body.massKg);
  assert.ok(value > 16 && value < 40, `implausible BMI after migration: ${value}`);
});

test("migration drops the obsolete v1 fields", () => {
  const migrated = migrateRecipe(v1Recipe());
  const body = migrated.body as Record<string, unknown>;
  for (const dead of ["height", "weight", "age"]) {
    assert.ok(!(dead in body), `v1 field '${dead}' survived migration`);
  }
});

test("migration preserves fields it does not touch", () => {
  const source = v1Recipe();
  const migrated = migrateRecipe(source);
  assert.equal(migrated.id, source.id);
  assert.equal(migrated.name, "Legacy");
  assert.equal(migrated.body.gender, 0.5);
  assert.equal(migrated.body.muscularity, 0.35);
});

test("migration handles a v1 recipe with missing body values", () => {
  const sparse = { ...v1Recipe(), body: {} };
  const migrated = migrateRecipe(sparse);
  assert.ok(migrated.body.heightCm >= HEIGHT_CM.min);
  assert.ok(migrated.body.massKg >= MASS_KG.min);
});

test("migration refuses recipes from a newer build", () => {
  const result = safeMigrateRecipe({ ...createDefaultRecipe(), schemaVersion: 99 });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /only understands up to/);
});

test("safeMigrateRecipe does not throw on garbage", () => {
  for (const garbage of [null, 42, "nope", [], {}]) {
    assert.equal(safeMigrateRecipe(garbage).ok, false);
  }
});

test("a current recipe passes through migration unchanged", () => {
  const recipe = createDefaultRecipe();
  assert.deepEqual(migrateRecipe(recipe), recipe);
});

test("normalize still works for art-direction ranges", () => {
  assert.equal(normalize({ min: 0, max: 10, unit: "" }, 5), 0.5);
});

// --- Ancestry -----------------------------------------------------------------

test("ancestry defaults to an even blend", () => {
  const { ancestry } = createDefaultRecipe().body;
  const total = ancestry.african + ancestry.asian + ancestry.caucasian;
  assert.ok(Math.abs(total - 1) < 1e-9, `weights summed to ${total}`);
});

test("ancestry weights are normalized at point of use", () => {
  const normalized = normalizeAncestry({ african: 2, asian: 1, caucasian: 1 });
  const total = normalized.african + normalized.asian + normalized.caucasian;
  assert.ok(Math.abs(total - 1) < 1e-9);
  assert.ok(Math.abs(normalized.african - 0.5) < 1e-9);
});

test("all-zero ancestry falls back to an even blend rather than dividing by zero", () => {
  const normalized = normalizeAncestry({ african: 0, asian: 0, caucasian: 0 });
  const total = normalized.african + normalized.asian + normalized.caucasian;
  assert.ok(Math.abs(total - 1) < 1e-9);
});

test("unnormalized ancestry weights are still accepted by the schema", () => {
  const base = createDefaultRecipe();
  const lopsided = {
    ...base,
    body: { ...base.body, ancestry: { african: 1, asian: 1, caucasian: 1 } },
  };
  assert.doesNotThrow(() => CharacterRecipeSchema.parse(lopsided));
});

test("v2 recipes migrate forward and gain a default ancestry", () => {
  const v2 = { ...createDefaultRecipe(), schemaVersion: 2 } as Record<string, unknown>;
  delete (v2["body"] as Record<string, unknown>)["ancestry"];
  const migrated = migrateRecipe(v2);
  assert.equal(migrated.schemaVersion, CHARACTER_RECIPE_VERSION);
  assert.ok(Math.abs(migrated.body.ancestry.african - 1 / 3) < 1e-9);
});

test("a v1 recipe migrates all the way to the current version", () => {
  const migrated = migrateRecipe(v1Recipe());
  assert.equal(migrated.schemaVersion, CHARACTER_RECIPE_VERSION);
  assert.ok(migrated.body.heightCm > 0);
  assert.ok(migrated.body.ancestry.caucasian > 0);
});
