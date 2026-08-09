import { useCallback } from "react";

import {
  AGE_YEARS,
  AGE_YEARS_SLIDER,
  HEIGHT_CM,
  HEIGHT_CM_SLIDER,
  MASS_KG,
  MASS_KG_SLIDER,
  formatHeight,
  formatMass,
  parseHeightToCm,
  parseMassToKg,
  plausibleMassRangeKg,
} from "@tpb/recipe";
import type { SolveResult } from "@tpb/avatar-runtime";

import { useCharacter } from "../state/useCharacter.ts";
import { MeasurementField } from "./MeasurementField.tsx";
import { Slider } from "./Slider.tsx";

const describeMuscle = (value: number): string => {
  if (value < 0.2) return "untrained";
  if (value < 0.45) return "average";
  if (value < 0.7) return "athletic";
  if (value < 0.9) return "muscular";
  return "bodybuilder";
};

export function Controls({ solve }: { solve: SolveResult | null }) {
  const recipe = useCharacter((s) => s.recipe);
  const units = useCharacter((s) => s.units);
  const setUnits = useCharacter((s) => s.setUnits);
  const patchBody = useCharacter((s) => s.patchBody);
  const setAncestry = useCharacter((s) => s.setAncestry);
  const shape = useCharacter((s) => s.shape)();

  const { body } = recipe;

  const formatHeightValue = useCallback((cm: number) => formatHeight(cm, units), [units]);
  const parseHeightValue = useCallback((text: string) => parseHeightToCm(text, units), [units]);
  const formatMassValue = useCallback((kg: number) => formatMass(kg, units), [units]);
  const parseMassValue = useCallback((text: string) => parseMassToKg(text, units), [units]);

  const massRange = plausibleMassRangeKg(body.heightCm);

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

        {!shape.plausible ? (
          <p className="warning">
            That weight is outside the believable range for this height (
            {formatMass(massRange.min, units)}&ndash;{formatMass(massRange.max, units)}). The model
            is still built, but it will not look like the number you typed.
          </p>
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

        <Slider
          label="Muscularity"
          value={body.muscularity}
          readout={describeMuscle(body.muscularity)}
          ends={["untrained", "bodybuilder"]}
          onChange={(muscularity) => patchBody({ muscularity })}
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

          <dt>Body fat</dt>
          <dd>{shape.bodyFatPercent.toFixed(1)}%</dd>

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
          Body fat is derived from height, weight, age, gender and muscularity &mdash; it is never
          stored directly, so mass and build can never contradict each other.
        </p>
      </section>
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
