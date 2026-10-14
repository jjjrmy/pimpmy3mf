interface SliderProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit?: string;
  disabled?: boolean;
  onChange: (value: number) => void;
}

/** A labelled range slider paired with a small numeric input, both driving the same value. */
export function Slider({ label, value, min, max, step, unit, disabled, onChange }: SliderProps) {
  const clamp = (v: number) => Math.min(max, Math.max(min, v));
  return (
    <label className={`slider${disabled ? ' is-disabled' : ''}`}>
      <span className="slider-head">
        <span className="slider-label">{label}</span>
        <span className="slider-value">
          <input
            type="number"
            min={min}
            max={max}
            step={step}
            value={value}
            disabled={disabled}
            onChange={(e) => {
              const v = parseFloat(e.target.value);
              if (!Number.isNaN(v)) onChange(clamp(v));
            }}
          />
          {unit && <span className="slider-unit">{unit}</span>}
        </span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(clamp(parseFloat(e.target.value)))}
      />
    </label>
  );
}
