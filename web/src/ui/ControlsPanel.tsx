import { useState } from 'react';
import type { ReactNode } from 'react';
import type { Axis, Params, Result, RGB } from '../core/types';
import { DropZone } from './DropZone';
import { Slider } from './Slider';
import { hexToRgb, rgbToHex } from './colorMap';

interface ControlsPanelProps {
  params: Params;
  onParams: (patch: Partial<Params>) => void;
  mode: 'image' | 'paint';
  onMode: (m: 'image' | 'paint') => void;
  image: { url: string; width: number; height: number } | null;
  onImage: (f: File) => void;
  model: ModelSummary | null;
  onModel: (f: File) => void;
  onClearModel: () => void;
  /** Hidden parts, keyed `${objectIndex}:${partIndex}`. */
  hiddenParts: Set<string>;
  onTogglePart: (key: string) => void;
  paletteMode: 'auto' | 'custom';
  onPaletteMode: (m: 'auto' | 'custom') => void;
  customPalette: RGB[];
  onCustomPalette: (p: RGB[]) => void;
  lockAspect: boolean;
  onLockAspect: (v: boolean) => void;
  result: Result | null;
}

/** What the UI knows about a loaded model: its name, size and object/part structure. */
export interface ModelSummary {
  name: string;
  triangles: number;
  objects: { name: string; parts: string[] }[];
}

/** Objects and their parts, each with a show/hide toggle. Only shown when there is more than one part. */
function PartsList({ model, hidden, onToggle }: { model: ModelSummary; hidden: Set<string>; onToggle: (key: string) => void }) {
  const multiObject = model.objects.length > 1;
  return (
    <ul className="parts-list">
      {model.objects.map((o, j) => (
        <li key={j}>
          {multiObject && (
            <div className="parts-object" title={o.name}>
              {o.name}
            </div>
          )}
          <ul>
            {o.parts.map((p, k) => {
              const key = `${j}:${k}`;
              const isHidden = hidden.has(key);
              return (
                <li key={key} className={`parts-row${isHidden ? ' is-hidden' : ''}`}>
                  <button
                    type="button"
                    className="legend-eye"
                    aria-pressed={!isHidden}
                    title={isHidden ? 'Show part' : 'Hide part'}
                    onClick={() => onToggle(key)}
                  >
                    {isHidden ? '🚫' : '👁'}
                  </button>
                  <span className="parts-name" title={p}>
                    {p}
                  </span>
                </li>
              );
            })}
          </ul>
        </li>
      ))}
    </ul>
  );
}

const AXES: { value: Axis; label: string }[] = [
  { value: 'z', label: 'Top-down (z)' },
  { value: 'y', label: 'Front (y)' },
  { value: 'x', label: 'Side (x)' },
];

const IMAGE_ACCEPT = '.png,.jpg,.jpeg,.webp,.gif,.bmp,image/*';
const MODEL_ACCEPT = '.stl,.3mf,.obj';

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
    </label>
  );
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
              <button
                type="button"
                className="palette-remove"
                title="Remove"
                disabled={palette.length <= 1}
                onClick={() => remove(i)}
              >
                ✕
              </button>
            </li>
          );
        })}
      </ol>
      <button type="button" className="btn btn-ghost" disabled={palette.length >= 16} onClick={add}>
        + Add filament
      </button>
    </div>
  );
}

export function ControlsPanel(props: ControlsPanelProps) {
  const { params, onParams, mode, result } = props;
  const [tileWidth, setTileWidth] = useState<number>(params.width ?? 60);
  const repeat = mode === 'paint' && params.width != null;

  const widthValue = params.width ?? 100;
  const heightValue = params.height ?? (result ? Number(result.tile.h.toFixed(2)) : Math.round(widthValue * 0.75));
  // offsets wrap, so ± one frame (or tile) size reaches every placement; keep the current value reachable
  const frameSpan = result ? Math.max(result.frame.x1 - result.frame.x0, result.frame.y1 - result.frame.y0, result.tile.w, result.tile.h) : 100;
  const offsetRange = Math.ceil(Math.max(frameSpan, Math.abs(params.offsetX), Math.abs(params.offsetY), 10));

  return (
    <div className="controls">
      {/* ---- image ---- */}
      <section className="panel-section">
        <h2>Image</h2>
        <DropZone accept={IMAGE_ACCEPT} label="Drop an image or click to browse" hint="png · jpg · webp · gif · bmp" onFile={props.onImage}>
          {props.image ? (
            <div className="thumb-row">
              <img className="thumb" src={props.image.url} alt="" />
              <div className="thumb-meta">
                <div>Click or drop to replace</div>
                <div className="dim">
                  {props.image.width} × {props.image.height} px
                </div>
              </div>
            </div>
          ) : undefined}
        </DropZone>
      </section>

      {/* ---- mode ---- */}
      <section className="panel-section">
        <div className="segmented" role="tablist" aria-label="Mode">
          <button type="button" role="tab" aria-selected={mode === 'image'} className={mode === 'image' ? 'is-active' : ''} onClick={() => props.onMode('image')}>
            Image tile
          </button>
          <button type="button" role="tab" aria-selected={mode === 'paint'} className={mode === 'paint' ? 'is-active' : ''} onClick={() => props.onMode('paint')}>
            Paint a model
          </button>
        </div>
      </section>

      {/* ---- paint extras ---- */}
      {mode === 'paint' && (
        <section className="panel-section">
          <h2>Model</h2>
          <DropZone accept={MODEL_ACCEPT} compact label="Drop a model or click to browse" hint="stl · 3mf · obj" onFile={props.onModel}>
            {props.model ? (
              <div className="thumb-row">
                <div className="model-icon" aria-hidden>
                  ◆
                </div>
                <div className="thumb-meta">
                  <div className="model-name" title={props.model.name}>
                    {props.model.name}
                  </div>
                  <div className="dim">
                    {props.model.objects.length > 1 && `${props.model.objects.length} objects · `}
                    {(() => {
                      const parts = props.model.objects.reduce((n, o) => n + o.parts.length, 0);
                      return parts > 1 ? `${parts} parts · ` : '';
                    })()}
                    {props.model.triangles.toLocaleString()} triangles
                  </div>
                </div>
                <button
                  type="button"
                  className="palette-remove"
                  title="Remove model"
                  onClick={(e) => {
                    e.stopPropagation();
                    props.onClearModel();
                  }}
                >
                  ✕
                </button>
              </div>
            ) : undefined}
          </DropZone>
          {props.model && props.model.objects.reduce((n, o) => n + o.parts.length, 0) > 1 && (
            <PartsList model={props.model} hidden={props.hiddenParts} onToggle={props.onTogglePart} />
          )}

          <Field label="Projection axis">
            <select value={params.axis} onChange={(e) => onParams({ axis: e.target.value as Axis })}>
              {AXES.map((a) => (
                <option key={a.value} value={a.value}>
                  {a.label}
                </option>
              ))}
            </select>
          </Field>

          <label className="toggle">
            <input
              type="checkbox"
              checked={repeat}
              onChange={(e) => onParams({ width: e.target.checked ? tileWidth : null, height: null })}
            />
            <span>Repeat pattern (tile)</span>
          </label>
          {repeat && (
            <Slider
              label="Tile width"
              unit="mm"
              min={5}
              max={300}
              step={1}
              value={params.width ?? tileWidth}
              onChange={(v) => {
                setTileWidth(v);
                onParams({ width: v });
              }}
            />
          )}
          {!repeat && <p className="hint">Stretching one copy of the image to cover the model.</p>}
        </section>
      )}

      {/* ---- colors ---- */}
      <section className="panel-section">
        <h2>Colors</h2>
        <div className="segmented segmented-sm">
          <button type="button" className={props.paletteMode === 'auto' ? 'is-active' : ''} onClick={() => props.onPaletteMode('auto')}>
            Auto
          </button>
          <button type="button" className={props.paletteMode === 'custom' ? 'is-active' : ''} onClick={() => props.onPaletteMode('custom')}>
            Custom
          </button>
        </div>
        {props.paletteMode === 'auto' ? (
          <Slider label="Number of colors" min={1} max={12} step={1} value={params.colors} onChange={(v) => onParams({ colors: Math.round(v) })} />
        ) : (
          <PaletteEditor palette={props.customPalette} onChange={props.onCustomPalette} />
        )}
      </section>

      {/* ---- size ---- */}
      {mode === 'image' && (
        <section className="panel-section">
          <h2>Size</h2>
          <Slider label="Width" unit="mm" min={10} max={256} step={1} value={widthValue} onChange={(v) => onParams({ width: v })} />
          <label className="toggle">
            <input type="checkbox" checked={props.lockAspect} onChange={(e) => props.onLockAspect(e.target.checked)} />
            <span>Lock aspect ratio</span>
          </label>
          {!props.lockAspect && (
            <Slider label="Height" unit="mm" min={10} max={256} step={1} value={heightValue} onChange={(v) => onParams({ height: v })} />
          )}
          {result && (
            <p className="hint">
              Result: {result.tile.w.toFixed(1)} × {result.tile.h.toFixed(1)} mm
            </p>
          )}
        </section>
      )}

      {/* ---- pattern placement (both modes) ---- */}
      <section className="panel-section">
        <h2>Pattern</h2>
        <Slider
          label="Rotation"
          unit="°"
          min={-180}
          max={180}
          step={1}
          value={params.rotation}
          onChange={(v) => onParams({ rotation: v })}
        />
        <Slider
          label="Offset X"
          unit="mm"
          min={-offsetRange}
          max={offsetRange}
          step={0.5}
          value={params.offsetX}
          onChange={(v) => onParams({ offsetX: v })}
        />
        <Slider
          label="Offset Y"
          unit="mm"
          min={-offsetRange}
          max={offsetRange}
          step={0.5}
          value={params.offsetY}
          onChange={(v) => onParams({ offsetY: v })}
        />
        <button
          type="button"
          className="btn btn-ghost pattern-reset"
          disabled={params.rotation === 0 && params.offsetX === 0 && params.offsetY === 0}
          onClick={() => onParams({ rotation: 0, offsetX: 0, offsetY: 0 })}
        >
          Reset pattern
        </button>
      </section>

      {/* ---- geometry ---- */}
      <section className="panel-section">
        <h2>Geometry</h2>
        {mode === 'image' && (
          <Slider label="Thickness" unit="mm" min={0.4} max={10} step={0.1} value={params.thickness} onChange={(v) => onParams({ thickness: v })} />
        )}
        <Slider label="Edge smoothing" unit="px" min={0} max={4} step={0.5} value={params.smooth} onChange={(v) => onParams({ smooth: v })} />
        <details className="advanced">
          <summary>Advanced</summary>
          <Slider label="Min feature" unit="mm" min={0} max={2} step={0.1} value={params.minFeature} onChange={(v) => onParams({ minFeature: v })} />
          <Slider label="Resolution" unit="mm" min={0.05} max={0.3} step={0.01} value={params.resolution} onChange={(v) => onParams({ resolution: v })} />
        </details>
      </section>
    </div>
  );
}
