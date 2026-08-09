import { useEffect, useState } from "react";

/**
 * Numeric field for a physical measurement.
 *
 * Typed text is only committed on blur or Enter, so a partially typed value like
 * `6'` never gets parsed as something surprising mid-keystroke. Unparseable
 * input reverts to the last good value rather than writing NaN into the recipe.
 */
export interface MeasurementFieldProps {
  label: string;
  /** Canonical value in SI units. */
  value: number;
  /** Formats the SI value for display in the user's chosen units. */
  format: (value: number) => string;
  /** Parses user text back to SI units, or null if unintelligible. */
  parse: (text: string) => number | null;
  /** Hard bounds; values outside are rejected. */
  min: number;
  max: number;
  /** Slider working range, which may be narrower than the hard bounds. */
  sliderMin: number;
  sliderMax: number;
  step?: number;
  hint?: string;
  onChange: (value: number) => void;
}

export function MeasurementField(props: MeasurementFieldProps) {
  const { label, value, format, parse, min, max, sliderMin, sliderMax, step, hint, onChange } =
    props;

  const [text, setText] = useState(() => format(value));
  const [invalid, setInvalid] = useState(false);

  // Re-sync when the value changes elsewhere, e.g. unit toggle or a preset,
  // but never while the user is mid-edit.
  useEffect(() => {
    setText(format(value));
    setInvalid(false);
  }, [value, format]);

  const commit = () => {
    const parsed = parse(text);
    if (parsed === null || parsed < min || parsed > max) {
      setInvalid(true);
      setText(format(value));
      window.setTimeout(() => setInvalid(false), 1200);
      return;
    }
    onChange(parsed);
  };

  return (
    <label className="field">
      <span className="field-label">
        {label}
        {hint ? <em className="field-hint">{hint}</em> : null}
      </span>
      <div className="field-row">
        <input
          className={invalid ? "text-input invalid" : "text-input"}
          value={text}
          onChange={(event) => setText(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Enter") commit();
            if (event.key === "Escape") setText(format(value));
          }}
          spellCheck={false}
        />
        <input
          className="range-input"
          type="range"
          min={sliderMin}
          max={sliderMax}
          step={step ?? 0.1}
          value={Math.min(sliderMax, Math.max(sliderMin, value))}
          onChange={(event) => onChange(Number(event.target.value))}
        />
      </div>
    </label>
  );
}
