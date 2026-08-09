import assert from "node:assert/strict";
import { test } from "node:test";

import { createDefaultRecipe } from "../src/defaults.ts";
import { HEIGHT_CM, MASS_KG, bmi, normalize } from "../src/ranges.ts";
import { migrateRecipe, safeMigrateRecipe } from "../src/migrate.ts";
import {
  CHARACTER_RECIPE_VERSION,
  CharacterRecipeSchema,
  OUTFIT_SLOTS,
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
  const recipe = createDefaultRecipe();
  const bytes = new TextEncoder().encode(JSON.stringify(recipe)).length;
  assert.ok(bytes < 1024, `recipe was ${bytes} bytes, budget is 1024`);
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
  assert.equal(migrated.schemaVersion, 2);
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
