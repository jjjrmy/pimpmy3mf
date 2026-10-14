import { useEffect, useState } from 'react';
import type { ColorRegion, Result } from '../core/types';
import { deltaE2000, hexToLab, MATERIAL_CLASSES, type Filament, type Suggestion } from '../shared/filaments';
import { BrandFilter } from './BrandFilter';
import { MaterialFilter } from './MaterialFilter';

interface LegendProps {
  regions: ColorRegion[];
  hexes: string[];
  hidden: Set<number>;
  mode: 'image' | 'paint';
  onHexChange: (index: number, hex: string) => void;
  onToggle: (index: number) => void;
  /** Restore a row to its detected color. */
  onReset: (index: number) => void;
  filamentStatus: 'loading' | 'error' | 'ready';
  material: string;
  onMaterial: (m: string) => void;
  /** Per row: ranked filament suggestions for the detected color; null while loading / unavailable. */
  suggestions: Suggestion[][] | null;
  /** Per row: the applied filament (it may fall outside the current filters), or null. */
  picks: (Filament | null)[];
  onStep: (index: number, delta: 1 | -1) => void;
  /** All catalog brands (alphabetical) and the current brand filter. */
  brands: string[];
  selectedBrands: Set<string>;
  onBrands: (next: Set<string>) => void;
  onResetBrands: () => void;
  /** The default brands (catalog names, in the user's order), listed first in the brand dropdown. */
  pinnedBrands: string[];
}

/** Small pill marking where a suggestion's color came from. */
function SourceBadge({ source }: { source: Filament['source'] }) {
  return source === 'measured' ? (
    <span className="suggest-badge is-measured" title="Measured color (filamentcolors.xyz)">
      measured
    </span>
  ) : (
    <span className="suggest-badge is-maker" title="Manufacturer-listed color (SpoolmanDB)">
      maker color
    </span>
  );
}

function SuggestionStrip({
  list,
  picked,
  detectedHex,
  onStep,
}: {
  list: Suggestion[];
  picked: Filament | null;
  detectedHex: string;
  onStep: (delta: 1 | -1) => void;
}) {
  const at = picked ? list.findIndex((s) => s.filament.slug === picked.slug) : -1;
  if (!list.length && !picked) return <div className="suggest suggest-empty">No matches; widen filters</div>;
  const dE = picked
    ? at >= 0
      ? list[at].deltaE
      : deltaE2000(hexToLab(detectedHex), hexToLab(picked.hex))
    : 0;
  return (
    <div className="suggest">
      <button
        type="button"
        className="suggest-arrow"
        title="Previous filament"
        aria-label="Previous filament"
        disabled={!list.length}
        onClick={() => onStep(-1)}
      >
        ◀
      </button>
      {picked ? (
        <div className="suggest-body">
          <span className="suggest-swatch" style={{ background: picked.hex }} aria-hidden />
          <span className="suggest-text">
            <span className="suggest-name" title={`${picked.brand} ${picked.name}`}>
              <strong>{picked.brand}</strong> {picked.name} <SourceBadge source={picked.source} />
            </span>
            <span className="suggest-meta">
              {picked.type} · ΔE {dE.toFixed(1)} · {at >= 0 ? `${at + 1}/${list.length}` : 'outside current filters'}
              {picked.source === 'measured' && (
                <>
                  {' · '}
                  <a href={`https://filamentcolors.xyz/swatch/${picked.slug}/`} target="_blank" rel="noreferrer">
                    swatch
                  </a>
                </>
              )}
              {picked.url && (
                <>
                  {' · '}
                  <a href={picked.url} target="_blank" rel="noreferrer">
                    buy
                  </a>
                </>
              )}
            </span>
          </span>
        </div>
      ) : (
        <div className="suggest-body suggest-idle">
          <span className="suggest-swatch" style={{ background: list[0].filament.hex }} aria-hidden />
          <span className="suggest-text">
            <span className="suggest-name">Detected color</span>
            <span className="suggest-meta">
              ▶ {list.length} filament matches · closest {list[0].filament.brand} (ΔE {list[0].deltaE.toFixed(1)}){' '}
              <SourceBadge source={list[0].filament.source} />
            </span>
          </span>
        </div>
      )}
      <button
        type="button"
        className="suggest-arrow"
        title="Next filament"
        aria-label="Next filament"
        disabled={!list.length}
        onClick={() => onStep(1)}
      >
        ▶
      </button>
    </div>
  );
}

const HEX_RE = /^#?[0-9a-fA-F]{6}$/;

function normalizeHex(value: string): string | null {
  const v = value.trim();
  if (!HEX_RE.test(v)) return null;
  return ('#' + v.replace('#', '')).toUpperCase();
}

function HexField({ value, onCommit }: { value: string; onCommit: (hex: string) => void }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);

  const commit = (raw: string) => {
    const hex = normalizeHex(raw);
    if (hex) onCommit(hex);
    else setText(value);
  };

  return (
    <span className="legend-hex">
      <input
        type="color"
        value={value}
        aria-label="Pick color"
        onChange={(e) => onCommit(e.target.value.toUpperCase())}
      />
      <input
        className="legend-hex-text"
        type="text"
        value={text}
        spellCheck={false}
        aria-label="Hex color"
        onChange={(e) => setText(e.target.value)}
        onBlur={(e) => commit(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && commit((e.target as HTMLInputElement).value)}
      />
    </span>
  );
}

export function Legend(props: LegendProps) {
  const { regions, hexes, hidden, mode, onHexChange, onToggle, onReset, suggestions, picks, onStep } = props;
  if (!regions.length) return null;
  return (
    <div className="legend-wrap">
      {props.filamentStatus !== 'error' && (
        <div className="legend-head">
          <span className="dim">
            Filament matches from{' '}
            <a href="https://filamentcolors.xyz" target="_blank" rel="noreferrer">
              filamentcolors.xyz
            </a>{' '}
            and{' '}
            <a href="https://github.com/Donkie/SpoolmanDB" target="_blank" rel="noreferrer">
              SpoolmanDB
            </a>
            {props.filamentStatus === 'loading' && ' · loading…'}
          </span>
          {props.filamentStatus === 'ready' && (
            <span className="legend-filters">
              <label className="legend-material">
                <span className="dim">Material</span>
                <MaterialFilter options={[...MATERIAL_CLASSES]} value={props.material} onChange={props.onMaterial} />
              </label>
              <BrandFilter
                brands={props.brands}
                pinned={props.pinnedBrands}
                selected={props.selectedBrands}
                onChange={props.onBrands}
                onResetDefaults={props.onResetBrands}
              />
            </span>
          )}
        </div>
      )}
      <ul className="legend">
        {regions.map((r) => {
          const hex = hexes[r.index] ?? r.hex;
          const isHidden = hidden.has(r.index);
          const isBase = mode === 'paint' && r.index === 0;
          const changed = hex.toUpperCase() !== r.hex.toUpperCase();
          const list = suggestions?.[r.index];
          return (
            <li key={r.index} className={`legend-row${isHidden ? ' is-hidden' : ''}`}>
              <div className="legend-line">
                <input
                  type="checkbox"
                  className="vis-check"
                  checked={!isHidden}
                  aria-label={`Show color #${r.index + 1}`}
                  title={isHidden ? 'Show color' : 'Hide color'}
                  onChange={() => onToggle(r.index)}
                />
                <span className="legend-swatch" style={{ background: hex }} aria-hidden />
                <span className="legend-num">#{r.index + 1}</span>
                <HexField value={hex} onCommit={(h) => onHexChange(r.index, h)} />
                {changed && (
                  <button
                    type="button"
                    className="legend-reset"
                    title={`Restore the detected color ${r.hex}`}
                    onClick={() => onReset(r.index)}
                  >
                    Reset
                  </button>
                )}
                <span className="legend-coverage">{(r.coverage * 100).toFixed(1)}%</span>
                {isBase && <span className="legend-tag" title="Painted as the base model (filament 1)">base</span>}
                {!r.mesh && <span className="legend-tag legend-tag-warn" title="No printable area survived">empty</span>}
              </div>
              {list && (
                <SuggestionStrip
                  list={list}
                  picked={picks[r.index] ?? null}
                  detectedHex={r.hex}
                  onStep={(d) => onStep(r.index, d)}
                />
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

interface StatusLineProps {
  running: boolean;
  stage: string | null;
  error: string | null;
  result: Result | null;
}

export function StatusLine({ running, stage, error, result }: StatusLineProps) {
  if (error) return <div className="status status-error">⚠ {error}</div>;
  if (running) return <div className="status status-busy">⏳ {stage ?? 'Working…'}</div>;
  if (!result) return <div className="status">Ready.</div>;
  const { stats, tile } = result;
  // result.warnings surface as toasts now, not inline here
  return (
    <div className="status">
      <span>
        {result.regions.length} colors · {tile.w.toFixed(1)} × {tile.h.toFixed(1)} mm
        {result.mode === 'paint' ? (tile.repeat ? ' (tiled)' : ' (stretched)') : ''}
      </span>
      <span className="status-dim">
        grid {stats.gridW}×{stats.gridH} @ {stats.pitch.toFixed(3)} mm · {Math.round(stats.ms)} ms
      </span>
    </div>
  );
}
