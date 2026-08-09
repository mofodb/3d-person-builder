import { CHARACTER_RECIPE_VERSION, CharacterRecipeSchema } from "./schema.ts";
import type { CharacterRecipe } from "./schema.ts";

/**
 * Builds a neutral, androgynous starting character.
 * Every field is populated by the schema's own defaults so there is exactly
 * one definition of "neutral" in the codebase.
 */
export function createDefaultRecipe(
  overrides: { id?: string; name?: string } = {},
): CharacterRecipe {
  return CharacterRecipeSchema.parse({
    schemaVersion: CHARACTER_RECIPE_VERSION,
    id: overrides.id ?? crypto.randomUUID(),
    name: overrides.name ?? "Unnamed",
  });
}
