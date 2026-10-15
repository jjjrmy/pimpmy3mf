import { useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { Axis, Params, Projection, Result } from '../core/types';
import { Slider } from './Slider';

/** What the UI knows about a loaded model: its name, size and object/part structure. */
export interface ModelSummary {
  name: string;
  triangles: number;
  objects: { name: string; parts: string[] }[];
}

interface DesignTabProps {
  params: Params;
  onParams: (patch: Partial<Params>) => void;
  mode: 'image' | 'paint';
  model: ModelSummary | null;
  /** Hidden parts, keyed `${objectIndex}:${partIndex}`. */
  hiddenParts: Set<string>;
  onTogglePart: (key: string) => void;
  lockAspect: boolean;
  onLockAspect: (v: boolean) => void;
  result: Result | null;
  /** Current palette colors ('#RRGGBB'), filament order — for the painted-face chips. */
  hexes: string[];
  onRemoveFace: (id: string) => void;
  onClearFaces: () => void;
}

/** Planar: projection direction. */
const AXES: { value: Axis; label: string }[] = [
  { value: 'z', label: 'Top-down (z)' },
  { value: 'y', label: 'Front (y)' },
  { value: 'x', label: 'Side (x)' },
];
/** Cylindrical: the cylinder axis the image wraps around. */
const CYL_AXES: { value: Axis; label: string }[] = [
  { value: 'z', label: 'Vertical (z)' },
  { value: 'y', label: 'Front–back (y)' },
  { value: 'x', label: 'Side (x)' },
];

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
    </label>
  );
}

/** Objects and their parts, each with a show/hide checkbox (checked = visible). Shown when >1 part. */
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
                  <input
                    type="checkbox"
                    className="vis-check"
                    checked={!isHidden}
                    aria-label={`Show ${p}`}
                    title={isHidden ? 'Show part' : 'Hide part'}
                    onChange={() => onToggle(key)}
                  />
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

/** Painted faces (paint-face tool): a color chip, label, area and remove ✕, plus Clear all. */
function PaintedFaces(props: DesignTabProps) {
  const { params, model, hexes, onRemoveFace, onClearFaces } = props;
  const faces = params.paintedFaces;
  const n = hexes.length;
  const totalParts = model ? model.objects.reduce((c, o) => c + o.parts.length, 0) : 0;
  const multiPart = totalParts > 1;
  return (
    <section className="control-group">
      <h3 className="tab-subhead">Painted faces</h3>
      {faces.length === 0 ? (
        <p className="hint">Use Paint face in the 3D view to print a face in one color.</p>
      ) : (
        <>
          <ul className="face-list">
            {faces.map((f, i) => {
              const ci = Math.min(Math.max(f.color, 0), Math.max(0, n - 1));
              const partName = multiPart ? model?.objects[f.objectIndex]?.parts[f.partIndex] : undefined;
              return (
                <li key={f.id} className="face-row">
                  <span className="face-chip" style={{ background: hexes[ci] ?? '#cccccc' }} aria-hidden />
                  <span className="face-label">
                    Face {i + 1}
                    {partName && <span className="face-part" title={partName}> · {partName}</span>}
                  </span>
                  <span className="face-area">{f.area.toFixed(1)} mm²</span>
                  <button type="button" className="icon-x" aria-label={`Remove face ${i + 1}`} title="Remove" onClick={() => onRemoveFace(f.id)}>
                    ✕
                  </button>
                </li>
              );
            })}
          </ul>
          <button type="button" className="btn-ghost" onClick={onClearFaces}>
            Clear all
          </button>
        </>
      )}
    </section>
  );
}

export function DesignTab(props: DesignTabProps) {
  const { params, onParams, mode, model, result } = props;
  const [tileWidth, setTileWidth] = useState<number>(params.width ?? 60);
  const repeat = mode === 'paint' && params.width != null;

  // remember the axis per projection (planar defaults to y, cylindrical to z)
  const axisMemo = useRef<Record<Projection, Axis>>({ planar: 'y', cylindrical: 'z' });
  const onProjection = (projection: Projection) => {
    if (projection === params.projection) return;
    axisMemo.current[params.projection] = params.axis; // keep what we're leaving
    onParams({ projection, axis: axisMemo.current[projection] });
  };
  const onAxis = (axis: Axis) => {
    axisMemo.current[params.projection] = axis;
    onParams({ axis });
  };

  const widthValue = params.width ?? 100;
  const heightValue = params.height ?? (result ? Number(result.tile.h.toFixed(2)) : Math.round(widthValue * 0.75));
  // offsets wrap, so ± one frame (or tile) size reaches every placement; keep the current value reachable
  const frameSpan = result ? Math.max(result.frame.x1 - result.frame.x0, result.frame.y1 - result.frame.y0, result.tile.w, result.tile.h) : 100;
  const offsetRange = Math.ceil(Math.max(frameSpan, Math.abs(params.offsetX), Math.abs(params.offsetY), 10));

  const parts = model ? model.objects.reduce((n, o) => n + o.parts.length, 0) : 0;
  const cylindrical = params.projection === 'cylindrical';
  const axisOptions = cylindrical ? CYL_AXES : AXES;

  return (
    <div className="tab-body">
      {/* ---- parts (model with >1 part) ---- */}
      {model && parts > 1 && (
        <section className="control-group">
          <h3 className="tab-subhead">Parts</h3>
          <PartsList model={model} hidden={props.hiddenParts} onToggle={props.onTogglePart} />
        </section>
      )}

      {/* ---- projection (paint mode) ---- */}
      {mode === 'paint' && model && (
        <section className="control-group">
          <h3 className="tab-subhead">Projection</h3>
          <div className="segmented segmented-sm">
            <button type="button" className={cylindrical ? '' : 'is-active'} onClick={() => onProjection('planar')}>
              Planar
            </button>
            <button type="button" className={cylindrical ? 'is-active' : ''} onClick={() => onProjection('cylindrical')}>
              Cylindrical
            </button>
          </div>
          <Field label={cylindrical ? 'Cylinder axis' : 'Projection axis'}>
            <select value={params.axis} onChange={(e) => onAxis(e.target.value as Axis)}>
              {axisOptions.map((a) => (
                <option key={a.value} value={a.value}>
                  {a.label}
                </option>
              ))}
            </select>
          </Field>
        </section>
      )}

      {/* ---- size (tile mode) ---- */}
      {mode === 'image' && (
        <section className="control-group">
          <h3 className="tab-subhead">Size</h3>
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

      {/* ---- pattern size (paint mode) ---- */}
      {mode === 'paint' && (
        <section className="control-group">
          <h3 className="tab-subhead">Pattern size</h3>
          <label className="toggle">
            <input
              type="checkbox"
              checked={repeat}
              onChange={(e) => onParams({ width: e.target.checked ? tileWidth : null, height: null })}
            />
            <span>Repeat pattern (tile)</span>
          </label>
          {repeat ? (
            <>
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
              {cylindrical && result?.tile.wraps != null && (
                <p className="hint">
                  Snapped to {result.tile.w.toFixed(1)} mm · {result.tile.wraps} around
                </p>
              )}
            </>
          ) : (
            <p className="hint">Stretching one copy of the image to cover the model.</p>
          )}
        </section>
      )}

      {/* ---- pattern placement ---- */}
      <section className="control-group">
        <h3 className="tab-subhead">Pattern</h3>
        <Slider label="Rotation" unit="°" min={-180} max={180} step={1} value={params.rotation} onChange={(v) => onParams({ rotation: v })} />
        <Slider label="Offset X" unit="mm" min={-offsetRange} max={offsetRange} step={0.5} value={params.offsetX} onChange={(v) => onParams({ offsetX: v })} />
        <Slider label="Offset Y" unit="mm" min={-offsetRange} max={offsetRange} step={0.5} value={params.offsetY} onChange={(v) => onParams({ offsetY: v })} />
        <button
          type="button"
          className="btn-ghost pattern-reset"
          disabled={params.rotation === 0 && params.offsetX === 0 && params.offsetY === 0}
          onClick={() => onParams({ rotation: 0, offsetX: 0, offsetY: 0 })}
        >
          Reset pattern
        </button>
      </section>

      {/* ---- painted faces (paint mode) ---- */}
      {mode === 'paint' && model && <PaintedFaces {...props} />}

      {/* ---- advanced ---- */}
      <details className="advanced">
        <summary>Advanced</summary>
        {mode === 'image' && (
          <Slider label="Thickness" unit="mm" min={0.4} max={10} step={0.1} value={params.thickness} onChange={(v) => onParams({ thickness: v })} />
        )}
        <Slider label="Edge smoothing" unit="px" min={0} max={4} step={0.5} value={params.smooth} onChange={(v) => onParams({ smooth: v })} />
        <Slider label="Min feature" unit="mm" min={0} max={2} step={0.1} value={params.minFeature} onChange={(v) => onParams({ minFeature: v })} />
        <Slider label="Resolution" unit="mm" min={0.05} max={0.3} step={0.01} value={params.resolution} onChange={(v) => onParams({ resolution: v })} />
      </details>
    </div>
  );
}
