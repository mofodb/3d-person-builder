import { migrateRecipe, safeMigrateRecipe } from "./migrate.ts";
import type { CharacterRecipe } from "./schema.ts";

/**
 * Wire format for recipes.
 *
 * Recipes are meant to be cheap to transmit -- a game sends a character as JSON
 * instead of shipping a model -- so serialization quantizes floats. Full IEEE
 * precision is pure waste here: `1/3` stringifies to `0.3333333333333333`, and
 * nobody can see the difference between a morph weight of 0.3333 and 0.33333333.
 */

/**
 * Decimal places kept for fractional values. At 1e-4, a height is precise to a
 * hundredth of a millimetre and a morph weight to far below perceptual
 * threshold, so this is lossless in every way that matters.
 */
const DECIMALS = 4;
const FACTOR = 10 ** DECIMALS;

const quantize = (value: number): number =>
  Number.isInteger(value) ? value : Math.round(value * FACTOR) / FACTOR;

/** Compact JSON for storage or network transmission. */
export function serializeRecipe(recipe: CharacterRecipe): string {
  return JSON.stringify(recipe, (_key, value) =>
    typeof value === "number" ? quantize(value) : value,
  );
}

/** Byte length on the wire. Used to police the payload budget. */
export function recipeByteSize(recipe: CharacterRecipe): number {
  return new TextEncoder().encode(serializeRecipe(recipe)).length;
}

/** Parses and migrates a serialized recipe. Throws on malformed input. */
export function deserializeRecipe(json: string): CharacterRecipe {
  return migrateRecipe(JSON.parse(json) as unknown);
}

/**
 * Non-throwing parse for untrusted input: uploaded files, network messages,
 * localStorage that a user may have edited by hand.
 */
export function safeDeserializeRecipe(
  json: string,
): { ok: true; recipe: CharacterRecipe } | { ok: false; error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Invalid JSON" };
  }
  return safeMigrateRecipe(parsed);
}
