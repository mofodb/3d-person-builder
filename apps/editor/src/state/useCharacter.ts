import { create } from "zustand";

import {
  bodyFatForMuscularity,
  createDefaultRecipe,
  deriveBodyShape,
  serializeRecipe,
  safeDeserializeRecipe,
} from "@tpb/recipe";
import type { Ancestry, CharacterRecipe, UnitSystem } from "@tpb/recipe";
import type { DerivedBodyShape } from "@tpb/recipe";

interface CharacterStore {
  recipe: CharacterRecipe;
  /** Display preference only. Never stored in the recipe. */
  units: UnitSystem;

  setUnits: (units: UnitSystem) => void;
  patchBody: (patch: Partial<CharacterRecipe["body"]>) => void;
  setAncestry: (patch: Partial<Ancestry>) => void;
  setName: (name: string) => void;
  reset: () => void;

  /** Writes back to bodyFatPercent, since muscularity is derived. */
  setMuscularity: (muscularity: number) => void;

  /** Derived body composition for the current recipe. */
  shape: () => DerivedBodyShape;

  exportJson: () => string;
  importJson: (json: string) => { ok: true } | { ok: false; error: string };
}

export const useCharacter = create<CharacterStore>((set, get) => ({
  recipe: createDefaultRecipe({ name: "New Character" }),
  units: "imperial",

  setUnits: (units) => set({ units }),

  patchBody: (patch) =>
    set((state) => ({ recipe: { ...state.recipe, body: { ...state.recipe.body, ...patch } } })),

  setAncestry: (patch) =>
    set((state) => ({
      recipe: {
        ...state.recipe,
        body: {
          ...state.recipe.body,
          ancestry: { ...state.recipe.body.ancestry, ...patch },
        },
      },
    })),

  setName: (name) => set((state) => ({ recipe: { ...state.recipe, name } })),

  reset: () => set({ recipe: createDefaultRecipe({ name: "New Character" }) }),

  shape: () => {
    const { body } = get().recipe;
    return deriveBodyShape({
      heightCm: body.heightCm,
      massKg: body.massKg,
      bodyFatPercent: body.bodyFatPercent,
      gender: body.gender,
    });
  },

  /**
   * Lets the UI offer a muscularity slider even though muscularity is derived.
   * Dragging it back-solves the body fat that would produce that muscularity at
   * the current height and mass, so the two can never disagree.
   */
  setMuscularity: (muscularity) => {
    const { body } = get().recipe;
    const bodyFatPercent = bodyFatForMuscularity({
      heightCm: body.heightCm,
      massKg: body.massKg,
      gender: body.gender,
      muscularity,
    });
    get().patchBody({ bodyFatPercent: Math.round(bodyFatPercent * 10) / 10 });
  },

  exportJson: () => serializeRecipe(get().recipe),

  importJson: (json) => {
    const result = safeDeserializeRecipe(json);
    if (!result.ok) return { ok: false, error: result.error };
    set({ recipe: result.recipe });
    return { ok: true };
  },
}));
