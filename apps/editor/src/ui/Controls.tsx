import { useCallback } from "react";

import {
  AGE_YEARS,
  AGE_YEARS_SLIDER,
  BODY_FAT_PERCENT,
  BODY_FAT_PERCENT_SLIDER,
  HEIGHT_CM,
  HEIGHT_CM_SLIDER,
  MASS_KG,
  MASS_KG_SLIDER,
  formatHeight,
  formatMass,
  parseHeightToCm,
  parseMassToKg,
} from "@tpb/recipe";
import type { SolveResult } from "@tpb/avatar-runtime";

import { useCharacter } from "../state/useCharacter.ts";
import { MeasurementField } from "./MeasurementField.tsx";
import { Outfit } from "./Outfit.tsx";
import type { OutfitProps } from "./Outfit.tsx";
import { SaveLoad } from "./SaveLoad.tsx";
import { Slider } from "./Slider.tsx";

const describeMuscle = (value: number): string => {
  if (value < 0.2) return "untrained";
  if (value < 0.45) return "average";
  if (value < 0.7) return "athletic";
  if (value < 0.9) return "muscular";
  return "elite";
};

/** Rough descriptive bands. Women carry more essential fat than men. */
const describeBodyFat = (percent: number, gender: number): string => {
  const shift = 8 * (1 - Math.min(1, Math.max(0, gender)));
  if (percent < 6 + shift) return "competition lean";
  if (percent < 14 + shift) return "athletic";
  if (percent < 19 + shift) return "fit";
  if (percent < 25 + shift) return "average";
  if (percent < 32 + shift) return "overweight";
  return "obese";
};

export interface ControlsProps {
  solve: SolveResult | null;
  onExportGlb: () => Promise<void>;
  outfit: OutfitProps;
}

export function Controls({ solve, onExportGlb, outfit }: ControlsProps) {
  const recipe = useCharacter((s) => s.recipe);
  const units = useCharacter((s) => s.units);
  const setUnits = useCharacter((s) => s.setUnits);
  const patchBody = useCharacter((s) => s.patchBody);
  const patchSkin = useCharacter((s) => s.patchSkin);
  const setAncestry = useCharacter((s) => s.setAncestry);
  const setMuscularity = useCharacter((s) => s.setMuscularity);
  const shape = useCharacter((s) => s.shape)();

  const { body, skin } = recipe;

  const formatHeightValue = useCallback((cm: number) => formatHeight(cm, units), [units]);
  const parseHeightValue = useCallback((text: string) => parseHeightToCm(text, units), [units]);
  const formatMassValue = useCallback((kg: number) => formatMass(kg, units), [units]);
  const parseMassValue = useCallback((text: string) => parseMassToKg(text, units), [units]);

  return (
    <div className="controls">
      <header className="panel-header">
        <h1>3D Person Builder</h1>
        <div className="unit-toggle">
          {(["metric", "imperial"] as const).map((system) => (
            <button
              key={system}
              type="button"
              className={units === system ? "active" : ""}
              onClick={() => setUnits(system)}
            >
              {system === "metric" ? "cm / kg" : "ft / lb"}
            </button>
          ))}
        </div>
      </header>

      <section>
        <h2>Body</h2>

        <MeasurementField
          label="Height"
          value={body.heightCm}
          format={formatHeightValue}
          parse={parseHeightValue}
          min={HEIGHT_CM.min}
          max={HEIGHT_CM.max}
          sliderMin={HEIGHT_CM_SLIDER.min}
          sliderMax={HEIGHT_CM_SLIDER.max}
          step={0.5}
          hint={units === "imperial" ? `type 6'2" or 188cm` : `type 188 or 6'2"`}
          onChange={(heightCm) => patchBody({ heightCm })}
        />

        <MeasurementField
          label="Weight"
          value={body.massKg}
          format={formatMassValue}
          parse={parseMassValue}
          min={MASS_KG.min}
          max={MASS_KG.max}
          sliderMin={MASS_KG_SLIDER.min}
          sliderMax={MASS_KG_SLIDER.max}
          step={0.5}
          hint={units === "imperial" ? "type 165lb or 75kg" : "type 75 or 165lb"}
          onChange={(massKg) => patchBody({ massKg })}
        />

        {shape.warnings.length > 0 ? (
          <div className="warning">
            {shape.warnings.map((warning) => (
              <p key={warning}>{warning}</p>
            ))}
          </div>
        ) : null}

        <MeasurementField
          label="Age"
          value={body.ageYears}
          format={(years) => `${Math.round(years)} years`}
          parse={(text) => {
            const match = text.match(/(\d+(?:\.\d+)?)/);
            return match?.[1] !== undefined ? Number(match[1]) : null;
          }}
          min={AGE_YEARS.min}
          max={AGE_YEARS.max}
          sliderMin={AGE_YEARS_SLIDER.min}
          sliderMax={AGE_YEARS_SLIDER.max}
          step={1}
          onChange={(ageYears) => patchBody({ ageYears })}
        />

        <Slider
          label="Gender"
          value={body.gender}
          readout={body.gender === 0.5 ? "androgynous" : undefined}
          ends={["feminine", "masculine"]}
          onChange={(gender) => patchBody({ gender })}
        />

        <MeasurementField
          label="Body fat"
          value={body.bodyFatPercent}
          format={(percent) => `${percent.toFixed(1)}%`}
          parse={(text) => {
            const match = text.match(/(\d+(?:\.\d+)?)/);
            return match?.[1] !== undefined ? Number(match[1]) : null;
          }}
          min={BODY_FAT_PERCENT.min}
          max={BODY_FAT_PERCENT.max}
          sliderMin={BODY_FAT_PERCENT_SLIDER.min}
          sliderMax={BODY_FAT_PERCENT_SLIDER.max}
          step={0.5}
          hint={describeBodyFat(body.bodyFatPercent, body.gender)}
          onChange={(bodyFatPercent) => patchBody({ bodyFatPercent })}
        />

        <Slider
          label="Muscularity"
          value={shape.muscularity}
          readout={`${describeMuscle(shape.muscularity)} · FFMI ${shape.ffmi.toFixed(1)}`}
          ends={["untrained", "elite"]}
          onChange={setMuscularity}
        />
        <p className="note">
          Muscularity is derived from lean mass, so dragging it adjusts body fat at the same
          weight. To get bigger <em>and</em> leaner, raise the weight too.
        </p>
      </section>

      <section>
        <h2>Skin</h2>
        <Slider
          label="Tone"
          value={skin.tone}
          ends={["lightest", "darkest"]}
          onChange={(tone) => patchSkin({ tone })}
        />
        <label className="field">
          <span className="field-label">Tint</span>
          <div className="field-row">
            <input
              type="color"
              className="color-input"
              value={skin.tint}
              onChange={(event) => patchSkin({ tint: event.target.value })}
            />
            <span className="field-hint">multiplies the tone above; white = no tint</span>
          </div>
        </label>
        <Slider
          label="Roughness"
          value={skin.roughness}
          ends={["glossy", "matte"]}
          onChange={(roughness) => patchSkin({ roughness })}
        />
      </section>

      <section>
        <h2>Facial structure</h2>
        <p className="note">
          Blend weights are normalized, so raising one lowers the others proportionally.
        </p>
        {(["african", "asian", "caucasian"] as const).map((group) => (
          <Slider
            key={group}
            label={group[0]!.toUpperCase() + group.slice(1)}
            value={body.ancestry[group]}
            readout={`${Math.round(shapeShare(body.ancestry, group) * 100)}%`}
            onChange={(value) => setAncestry({ [group]: value })}
          />
        ))}
      </section>

      <section>
        <h2>Derived</h2>
        <dl className="readouts">
          <dt>BMI</dt>
          <dd>{shape.bmi.toFixed(1)}</dd>

          <dt>Lean mass</dt>
          <dd>{formatMass(shape.leanMassKg, units)}</dd>

          <dt>Fat mass</dt>
          <dd>{formatMass(shape.fatMassKg, units)}</dd>

          <dt>FFMI</dt>
          <dd>{shape.ffmi.toFixed(1)}</dd>

          <dt>Fat morph</dt>
          <dd>{shape.fatMorphWeight.toFixed(2)}</dd>

          <dt>Muscle morph</dt>
          <dd>{shape.muscleMorphWeight.toFixed(2)}</dd>

          {solve ? (
            <>
              <dt>Mesh height</dt>
              <dd className={solve.heightClamped ? "bad" : "good"}>
                {formatHeight(solve.resultingHeightCm, units)}
                {solve.heightClamped ? " (clamped)" : ""}
              </dd>
            </>
          ) : null}
        </dl>
        <p className="note">
          Height, weight and body fat are the inputs. Lean mass and muscularity follow from them
          via FFMI, so the numbers can never contradict each other.
        </p>
      </section>

      <Outfit {...outfit} />

      <SaveLoad onExportGlb={onExportGlb} />
    </div>
  );
}

function shapeShare(
  ancestry: { african: number; asian: number; caucasian: number },
  group: "african" | "asian" | "caucasian",
): number {
  const total = ancestry.african + ancestry.asian + ancestry.caucasian;
  return total <= 0 ? 1 / 3 : ancestry[group] / total;
}
