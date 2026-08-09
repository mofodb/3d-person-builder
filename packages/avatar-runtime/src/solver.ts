import { clamp01, deriveBodyShape, normalizeAncestry } from "@tpb/recipe";
import type { CharacterRecipe } from "@tpb/recipe";

import type { BaseMeshManifest, MorphInfo } from "./manifest.ts";

/**
 * Turns a CharacterRecipe into morph target influences for the base mesh.
 *
 * Pure and framework-free so it can be unit tested in Node; the Babylon binding
 * lives in `./babylon.ts`.
 *
 * Height is handled differently from every other parameter. The others map
 * straight onto a macro axis, but height is a *requirement*: the user asked for
 * 178 cm and must get 178 cm, even though gender, age and ancestry morphs also
 * change stature. So all other weights are resolved first, their combined effect
 * on height is summed, and the height morph is solved to close the remaining
 * gap. `build_basemesh.py` verifies that height is exactly linear in morph
 * influence, which is what makes this solve valid.
 */

export interface SolveResult {
  /** Morph target name -> influence. Names not present should be left at zero. */
  readonly weights: Record<string, number>;
  /** Height the mesh will actually have, in centimetres. */
  readonly resultingHeightCm: number;
  /**
   * True when the requested height could not be reached and the height morph
   * had to be clamped. Happens at combinations like a 13-year-old at 203 cm.
   */
  readonly heightClamped: boolean;
}

const ANCESTRY_PREFIX = "race.";

/** MakeHuman's age dial is piecewise: 0 -> 1yr, 0.5 -> 25yr, 1 -> 90yr. */
export function yearsToAgeDial(years: number, manifest: BaseMeshManifest): number {
  const { minYears, neutralYears, maxYears } = manifest.ageDial;
  if (years <= neutralYears) {
    return clamp01((years - minYears) / ((neutralYears - minYears) * 2));
  }
  return clamp01(0.5 + (years - neutralYears) / ((maxYears - neutralYears) * 2));
}

/**
 * Bust size implied purely by femininity, in the absence of an explicit
 * recipe control for it.
 *
 * `cupsize_small`/`cupsize_large` are real, sizeable morphs (up to ~8.5 cm of
 * displacement) that previously sat hardcoded at neutral regardless of
 * `gender`, so a fully feminine character never got a fuller bust than an
 * androgynous one.
 *
 * Symmetric around the androgynous midpoint by construction (gender=0.5 must
 * keep giving the same neutral 0.5 cupsize target as before, or every existing
 * default-gender character would visibly change). Deviation from that midpoint
 * is pushed through an ease-out curve (exponent < 1) rather than scaled
 * linearly, so the effect is clearly pronounced well before the slider reaches
 * its extreme rather than only in the last few percent of travel.
 */
function bustTargetFromGender(gender: number): number {
  const femininity = 1 - clamp01(gender);
  const deviation = femininity - 0.5; // -0.5..0.5, zero at androgynous
  const emphasized = Math.sign(deviation) * (Math.abs(deviation) / 0.5) ** 0.6 * 0.5;
  return clamp01(0.5 + emphasized);
}

/** Target value for each macro axis implied by the recipe. */
function macroTargets(recipe: CharacterRecipe, manifest: BaseMeshManifest): Map<string, number> {
  const { body } = recipe;
  const shape = deriveBodyShape({
    heightCm: body.heightCm,
    massKg: body.massKg,
    bodyFatPercent: body.bodyFatPercent,
    gender: body.gender,
  });
  const ancestry = normalizeAncestry(body.ancestry);

  return new Map<string, number>([
    ["gender", body.gender],
    ["age", yearsToAgeDial(body.ageYears, manifest)],
    ["weight", shape.fatMorphWeight],
    ["muscle", shape.muscleMorphWeight],
    // Not yet exposed in the recipe; held at neutral so it contributes nothing.
    ["proportions", 0.5],
    ["cupsize", bustTargetFromGender(body.gender)],
    ["firmness", 0.5],
    ["race.african", ancestry.african],
    ["race.asian", ancestry.asian],
    ["race.caucasian", ancestry.caucasian],
  ]);
}

/**
 * Influence for one morph given its axis target.
 *
 * Single-axis morphs are a simple ratio, clamped so that the morph on the wrong
 * side of neutral contributes nothing.
 *
 * Ancestry is special-cased. Its three morphs are coupled by summing to 1, and
 * the generic ratio would overshoot by 1.5x: reproducing a blend of the three
 * pure shapes requires `weight = target - neutral`, which is intentionally
 * allowed to go negative.
 */
function morphWeight(morph: MorphInfo, target: number): number {
  if (morph.macro.startsWith(ANCESTRY_PREFIX)) return target - morph.neutral;

  const span = morph.value - morph.neutral;
  if (span === 0) return 0;
  return clamp01((target - morph.neutral) / span);
}

export function solveMorphWeights(
  recipe: CharacterRecipe,
  manifest: BaseMeshManifest,
): SolveResult {
  const targets = macroTargets(recipe, manifest);
  const weights: Record<string, number> = {};

  const heightMorphs: MorphInfo[] = [];
  let heightFromOthers = 0;

  for (const morph of manifest.morphs) {
    if (morph.macro === "height") {
      heightMorphs.push(morph);
      weights[morph.name] = 0;
      continue;
    }
    const target = targets.get(morph.macro);
    const weight = target === undefined ? 0 : morphWeight(morph, target);
    weights[morph.name] = weight;
    heightFromOthers += weight * morph.height_delta_cm;
  }

  // Close the remaining height gap with whichever height morph points the right
  // way: the mesh grows with height_tall and shrinks with height_short.
  const baseline = manifest.neutralHeightCm + heightFromOthers;
  const gap = recipe.body.heightCm - baseline;

  let heightClamped = false;
  let achieved = baseline;

  if (Math.abs(gap) > 1e-9) {
    const candidate = heightMorphs.find((m) =>
      gap > 0 ? m.height_delta_cm > 0 : m.height_delta_cm < 0,
    );
    if (candidate) {
      const ideal = gap / candidate.height_delta_cm;
      const applied = clamp01(ideal);
      heightClamped = Math.abs(applied - ideal) > 1e-6;
      weights[candidate.name] = applied;
      achieved = baseline + applied * candidate.height_delta_cm;
    } else {
      heightClamped = true;
    }
  }

  return { weights, resultingHeightCm: achieved, heightClamped };
}
