import { CHARACTER_RECIPE_VERSION, CharacterRecipeSchema } from "./schema.ts";
import type { CharacterRecipe } from "./schema.ts";

/**
 * Upgrades an older stored recipe to the current schema version.
 *
 * Migrations exist from day one deliberately: characters get saved by users
 * long before the schema stops changing, and silently dropping their work is
 * far worse than carrying a little migration code.
 *
 * To add a migration, append a function that takes vN and returns vN+1.
 */
type Migration = (input: Record<string, unknown>) => Record<string, unknown>;

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};

const asNumber = (value: unknown, fallback: number): number =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

/**
 * v1 -> v2: physical measurements moved from normalized 0..1 to real units, and
 * the `weight` fatness dial was replaced by an actual `massKg`.
 *
 * v1 normalized values were interpreted against the ranges in force at the
 * time, so those old bounds are hardcoded here. That is the point of a
 * migration: it must reproduce the past, not track the present.
 */
const migrateV1ToV2: Migration = (recipe) => {
  const body = asRecord(recipe["body"]);
  const { age, height, weight, ...restOfBody } = body;

  const V1_HEIGHT_CM = { min: 148, max: 202 };
  const V1_AGE_YEARS = { min: 18, max: 75 };
  const lerp = (r: { min: number; max: number }, t: number) =>
    r.min + (r.max - r.min) * Math.min(1, Math.max(0, t));

  const heightCm = lerp(V1_HEIGHT_CM, asNumber(height, 0.5));
  const ageYears = Math.round(lerp(V1_AGE_YEARS, asNumber(age, 0.35)));

  // v1 `weight` was a 0..1 fatness dial with no absolute meaning. Map it onto a
  // BMI span so previously-saved characters keep roughly their original build.
  const bmi = lerp({ min: 17, max: 38 }, asNumber(weight, 0.4));
  const massKg = Math.round(bmi * (heightCm / 100) ** 2 * 10) / 10;

  return {
    ...recipe,
    schemaVersion: 2,
    body: { ...restOfBody, heightCm: Math.round(heightCm * 10) / 10, ageYears, massKg },
  };
};

const MIGRATIONS: Record<number, Migration> = {
  1: migrateV1ToV2,
};

export class RecipeMigrationError extends Error {}

export function migrateRecipe(input: unknown): CharacterRecipe {
  if (typeof input !== "object" || input === null) {
    throw new RecipeMigrationError("Recipe must be an object");
  }

  let working = { ...(input as Record<string, unknown>) };
  let version = typeof working["schemaVersion"] === "number" ? (working["schemaVersion"] as number) : 0;

  if (version > CHARACTER_RECIPE_VERSION) {
    throw new RecipeMigrationError(
      `Recipe is version ${version} but this build only understands up to ${CHARACTER_RECIPE_VERSION}. Update the app.`,
    );
  }

  // Treat a missing version as v1; the field was present from the first release.
  if (version === 0) {
    working = { ...working, schemaVersion: 1 };
    version = 1;
  }

  while (version < CHARACTER_RECIPE_VERSION) {
    const migration = MIGRATIONS[version];
    if (!migration) {
      throw new RecipeMigrationError(`No migration registered from version ${version}`);
    }
    working = migration(working);
    version += 1;
  }

  return CharacterRecipeSchema.parse(working);
}

/** Non-throwing variant for untrusted input (uploads, network, localStorage). */
export function safeMigrateRecipe(
  input: unknown,
): { ok: true; recipe: CharacterRecipe } | { ok: false; error: string } {
  try {
    return { ok: true, recipe: migrateRecipe(input) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
