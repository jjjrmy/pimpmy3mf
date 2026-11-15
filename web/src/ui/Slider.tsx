import { useState } from 'react';
import type { CSSProperties, KeyboardEvent } from 'react';

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
  /**
   * Heavy settings (paint depth, texture relief, resolution) regenerate geometry on every change, so the
   * value is only committed when the drag is released (or the number box is blurred / Enter is pressed).
   * The thumb and number still track the pointer live.
   */
  commitOnRelease?: boolean;
  onChange: (value: number) => void;
}

/** Pending (uncommitted) slider position: a number, or the Full notch. */
type Pending = number | 'full';

/** A labelled range slider paired with a small numeric input, both driving the same value. */
export function Slider({ label, value, min, max, step, unit, disabled, full, commitOnRelease, onChange }: SliderProps) {
  const clamp = (v: number) => Math.min(max, Math.max(min, v));
  // text being typed into the number box (the full-notch box shows a word, so it can't be a plain number)
  const [draft, setDraft] = useState<string | null>(null);
  // commitOnRelease: where the thumb is while dragging, before it's committed
  const [pending, setPending] = useState<Pending | null>(null);
  const rangeMax = full ? Number((max + step).toFixed(6)) : max;

  const pendingFull = pending === 'full';
  const isFull = pending != null ? pendingFull : !!full?.active;
  const shownValue = typeof pending === 'number' ? pending : value;
  const rangeValue = isFull ? rangeMax : shownValue;
  // percentage of the track that's filled, exposed as --pct so the yellow fill works on WebKit too
  const pct = rangeMax > min ? Math.min(100, Math.max(0, ((rangeValue - min) / (rangeMax - min)) * 100)) : 0;

  const apply = (p: Pending) => {
    if (p === 'full') full?.onSelect();
    else onChange(clamp(p));
  };
  /** Live mode applies right away; commit mode just moves the pending thumb. */
  const move = (p: Pending) => {
    if (commitOnRelease) setPending(p);
    else apply(p);
  };
  const commit = () => {
    if (pending == null) return;
    const unchanged = pending === 'full' ? !!full?.active : !full?.active && Math.abs(pending - value) < 1e-9;
    setPending(null);
    if (!unchanged) apply(pending);
  };

  /** Parse the number box text; null = not a usable value yet. */
  const parse = (text: string): Pending | null => {
    const t = text.trim().toLowerCase();
    if (full) {
      const word = full.label.toLowerCase();
      if (t === '' || t === word) return 'full';
      if (word.startsWith(t)) return null; // still typing the word
    }
    const v = parseFloat(t);
    if (Number.isNaN(v)) return null;
    if (full && v > max + 1e-9) return 'full'; // past the last step is the notch
    return clamp(v);
  };
  const onText = (text: string) => {
    setDraft(text);
    if (commitOnRelease) return; // committed on blur / Enter
    const p = parse(text);
    if (p != null) apply(p);
  };
  const commitText = () => {
    if (draft != null && commitOnRelease) {
      const p = parse(draft);
      if (p != null) {
        const unchanged = p === 'full' ? !!full?.active : !full?.active && Math.abs(p - value) < 1e-9;
        if (!unchanged) apply(p);
      }
    }
    setDraft(null);
  };
  const onTextKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      commitText();
      (e.target as HTMLInputElement).blur();
    } else if (e.key === 'Escape') {
      setDraft(null);
      (e.target as HTMLInputElement).blur();
    }
  };

  const boxText = draft ?? (isFull && full ? full.label : String(shownValue));

  return (
    <label className={`slider${disabled ? ' is-disabled' : ''}${isFull ? ' is-full' : ''}`}>
      <span className="slider-head">
        <span className="slider-label">{label}</span>
        <span className="slider-value">
          {full || commitOnRelease ? (
            <input
              type="text"
              inputMode="decimal"
              value={boxText}
              disabled={disabled}
              onChange={(e) => onText(e.target.value)}
              onBlur={commitText}
              onKeyDown={onTextKey}
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
          {unit && !isFull && <span className="slider-unit">{unit}</span>}
        </span>
      </span>
      <input
        type="range"
        min={min}
        max={rangeMax}
        step={step}
        value={rangeValue}
        disabled={disabled}
        aria-label={label}
        style={{ ['--pct' as string]: `${pct}%` } as CSSProperties}
        onChange={(e) => {
          setDraft(null);
          const v = parseFloat(e.target.value);
          move(full && v > max + step / 2 ? 'full' : v);
        }}
        onPointerUp={commit}
        onTouchEnd={commit}
        onKeyUp={commit}
        onBlur={commit}
      />
    </label>
  );
}
