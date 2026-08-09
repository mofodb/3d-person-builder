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

const MIGRATIONS: Record<number, Migration> = {
  // 1: (r) => ({ ...r, schemaVersion: 2, newField: defaultValue }),
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
