export interface SliderProps {
  label: string;
  value: number;
  min?: number;
  max?: number;
  step?: number;
  /** Right-aligned readout, e.g. a percentage or a descriptive word. */
  readout?: string;
  /** Labels for the two ends, shown under the track. */
  ends?: readonly [string, string];
  onChange: (value: number) => void;
}

export function Slider(props: SliderProps) {
  const { label, value, min = 0, max = 1, step = 0.01, readout, ends, onChange } = props;
  return (
    <label className="field">
      <span className="field-label">
        {label}
        {readout ? <em className="field-hint">{readout}</em> : null}
      </span>
      <input
        className="range-input full"
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      {ends ? (
        <span className="field-ends">
          <span>{ends[0]}</span>
          <span>{ends[1]}</span>
        </span>
      ) : null}
    </label>
  );
}
