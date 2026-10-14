import type { ReactNode } from 'react';
import type { Params, RGB } from '../core/types';
import { Slider } from './Slider';
import { hexToRgb, rgbToHex } from './colorMap';

interface ColorsTabProps {
  params: Params;
  onParams: (patch: Partial<Params>) => void;
  paletteMode: 'auto' | 'custom';
  onPaletteMode: (m: 'auto' | 'custom') => void;
  customPalette: RGB[];
  onCustomPalette: (p: RGB[]) => void;
  /** The rendered color-row list + filament matcher (App builds <Legend/>). */
  legend: ReactNode;
}

function PaletteEditor({ palette, onChange }: { palette: RGB[]; onChange: (p: RGB[]) => void }) {
  const set = (i: number, hex: string) => {
    const next = palette.slice();
    next[i] = hexToRgb(hex);
    onChange(next);
  };
  const remove = (i: number) => onChange(palette.filter((_, j) => j !== i));
  const add = () => onChange([...palette, [128, 128, 128]]);

  return (
    <div className="palette">
      <ol className="palette-list">
        {palette.map((rgb, i) => {
          const hex = rgbToHex(rgb);
          return (
            <li key={i} className="palette-item">
              <span className="palette-num">{i + 1}</span>
              <input type="color" value={hex} aria-label={`Filament ${i + 1}`} onChange={(e) => set(i, e.target.value)} />
              <input
                className="palette-hex"
                type="text"
                value={hex}
                spellCheck={false}
                onChange={(e) => {
                  if (/^#?[0-9a-fA-F]{6}$/.test(e.target.value.trim())) set(i, e.target.value.trim());
                }}
              />
              <button type="button" className="icon-x" title="Remove" aria-label={`Remove filament ${i + 1}`} disabled={palette.length <= 1} onClick={() => remove(i)}>
                ✕
              </button>
            </li>
          );
        })}
      </ol>
      <button type="button" className="btn-ghost" disabled={palette.length >= 16} onClick={add}>
        + Add filament
      </button>
    </div>
  );
}

export function ColorsTab(props: ColorsTabProps) {
  const { params, onParams, paletteMode } = props;
  return (
    <div className="tab-body">
      {paletteMode === 'auto' && (
        <section className="control-group">
          <Slider label="Number of colors" min={1} max={12} step={1} value={params.colors} onChange={(v) => onParams({ colors: Math.round(v) })} />
        </section>
      )}

      <div className="segmented segmented-sm">
        <button type="button" className={paletteMode === 'auto' ? 'is-active' : ''} onClick={() => props.onPaletteMode('auto')}>
          Auto
        </button>
        <button type="button" className={paletteMode === 'custom' ? 'is-active' : ''} onClick={() => props.onPaletteMode('custom')}>
          Custom
        </button>
      </div>

      {paletteMode === 'custom' && (
        <section className="control-group">
          <PaletteEditor palette={props.customPalette} onChange={props.onCustomPalette} />
        </section>
      )}

      {props.legend}
    </div>
  );
}
