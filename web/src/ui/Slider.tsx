import { useState } from 'react';
import type { CSSProperties } from 'react';

/** An extra notch one step past `max` that means "no limit" (e.g. Full depth). */
export interface SliderFull {
  /** Shown in the number box at the notch, e.g. "Full". Typing it (or clearing the box) selects it. */
  label: string;
  /** Whether the value is currently at the notch. */
  active: boolean;
  onSelect: () => void;
}

interface SliderProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit?: string;
  disabled?: boolean;
  full?: SliderFull;
  onChange: (value: number) => void;
}

/** A labelled range slider paired with a small numeric input, both driving the same value. */
export function Slider({ label, value, min, max, step, unit, disabled, full, onChange }: SliderProps) {
  const clamp = (v: number) => Math.min(max, Math.max(min, v));
  // text being typed into the full-notch box (it shows a word, so it can't be a plain controlled number)
  const [draft, setDraft] = useState<string | null>(null);
  const rangeMax = full ? Number((max + step).toFixed(6)) : max;
  const rangeValue = full?.active ? rangeMax : value;
  // percentage of the track that's filled, exposed as --pct so the yellow fill works on WebKit too
  const pct = rangeMax > min ? Math.min(100, Math.max(0, ((rangeValue - min) / (rangeMax - min)) * 100)) : 0;

  const onText = (text: string) => {
    setDraft(text);
    if (!full) return;
    const t = text.trim().toLowerCase();
    const word = full.label.toLowerCase();
    if (t === '' || t === word) return full.onSelect();
    if (word.startsWith(t)) return; // still typing the word
    const v = parseFloat(t);
    if (Number.isNaN(v)) return;
    if (v > max + 1e-9) full.onSelect(); // past the last step is the notch
    else onChange(clamp(v));
  };

  return (
    <label className={`slider${disabled ? ' is-disabled' : ''}${full?.active ? ' is-full' : ''}`}>
      <span className="slider-head">
        <span className="slider-label">{label}</span>
        <span className="slider-value">
          {full ? (
            <input
              type="text"
              inputMode="decimal"
              value={draft ?? (full.active ? full.label : String(value))}
              disabled={disabled}
              onChange={(e) => onText(e.target.value)}
              onBlur={() => setDraft(null)}
            />
          ) : (
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
          )}
          {unit && !full?.active && <span className="slider-unit">{unit}</span>}
        </span>
      </span>
      <input
        type="range"
        min={min}
        max={rangeMax}
        step={step}
        value={rangeValue}
        disabled={disabled}
        style={{ ['--pct' as string]: `${pct}%` } as CSSProperties}
        onChange={(e) => {
          setDraft(null);
          const v = parseFloat(e.target.value);
          if (full && v > max + step / 2) full.onSelect();
          else onChange(clamp(v));
        }}
      />
    </label>
  );
}
