import assert from "node:assert/strict";
import { test } from "node:test";

import { createDefaultRecipe } from "../src/defaults.ts";
import { formatHeight, heightCm, normalize, HEIGHT_CM } from "../src/ranges.ts";
import { migrateRecipe, safeMigrateRecipe } from "../src/migrate.ts";
import { CharacterRecipeSchema, OUTFIT_SLOTS } from "../src/schema.ts";

test("default recipe is valid and androgynous", () => {
  const recipe = createDefaultRecipe({ name: "Test" });
  assert.equal(recipe.schemaVersion, 1);
  assert.equal(recipe.name, "Test");
  assert.equal(recipe.body.gender, 0.5);
  assert.equal(recipe.face.source, "default");
  assert.equal(recipe.face.identity, null);
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

test("out-of-range values are rejected", () => {
  const recipe = createDefaultRecipe();
  const bad = { ...recipe, body: { ...recipe.body, height: 1.5 } };
  assert.throws(() => CharacterRecipeSchema.parse(bad));
});

test("oversized identity vectors are rejected", () => {
  const recipe = createDefaultRecipe();
  const bad = {
    ...recipe,
    face: { ...recipe.face, identity: new Array(200).fill(0) },
  };
  assert.throws(() => CharacterRecipeSchema.parse(bad));
});

test("malformed asset ids are rejected", () => {
  const recipe = createDefaultRecipe();
  const bad = {
    ...recipe,
    hair: { ...recipe.hair, styleId: "Not A Valid Id!" },
  };
  assert.throws(() => CharacterRecipeSchema.parse(bad));
});

test("migration accepts a versionless recipe as v1", () => {
  const { schemaVersion, ...versionless } = createDefaultRecipe();
  void schemaVersion;
  const migrated = migrateRecipe(versionless);
  assert.equal(migrated.schemaVersion, 1);
});

test("migration refuses recipes from a newer build", () => {
  const result = safeMigrateRecipe({ ...createDefaultRecipe(), schemaVersion: 99 });
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /only understands up to/);
});

test("safeMigrateRecipe does not throw on garbage", () => {
  for (const garbage of [null, 42, "nope", [], {}]) {
    const result = safeMigrateRecipe(garbage);
    assert.equal(result.ok, false);
  }
});

test("height mapping round-trips", () => {
  const t = normalize(HEIGHT_CM, 175);
  assert.ok(Math.abs(heightCm(t) - 175) < 0.001);
});

test("formatHeight never renders 12 inches", () => {
  for (let i = 0; i <= 100; i++) {
    assert.doesNotMatch(formatHeight(i / 100), /'12"/);
  }
});
