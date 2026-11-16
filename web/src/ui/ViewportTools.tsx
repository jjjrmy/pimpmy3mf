// Paint-mode viewport toolbar: Lay-on-face, Paint-face, Texture-face and Assemble tools, plus orientation Undo / Reset.
// Assemble shows its face-mate panel (flip / offset / rotate, Apply / Cancel mate, Undo, Done) under the button.
// Leaving a tool: click its button again, press Esc (a pending mate / stroke / drag is cancelled first), or Done / ✕.
// Sits as a small overlay inside the 3D viewport (themed "Pimp My Ride" chips). Purely presentational:
// the active tool, hover highlighting and picking live in Viewer3D / App. The Texture face tool's settings
// live in the TEXTURE tab; here it only has the Add / Eraser toggle.

import { useState } from 'react';
import { Icon } from './Icons';
import { Slider } from './Slider';

export type ViewportTool = 'lay' | 'paint' | 'texture' | 'assemble';

/** Assemble tool: where the face-to-face mate flow is, and the preview's settings. */
export interface MatePanel {
  step: 'pickMoving' | 'pickTarget' | 'preview';
  /** File name of the moving part, once chosen. */
  movingName: string | null;
  targetName: string | null;
  offset: number;
  flip: boolean;
  angle: number;
  /** The view is catching up with the last change: picks are paused. */
  updating: boolean;
  /** A file is selected and shown, so the move / rotate gizmo is on it. */
  canMove?: boolean;
}

/** Number box committing on blur / Enter (the angle of a mate preview). */
function AngleBox({ value, onCommit }: { value: number; onCommit: (v: number) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft == null) return;
    const v = parseFloat(draft);
    setDraft(null);
    if (Number.isFinite(v)) onCommit(((((v + 180) % 360) + 360) % 360) - 180);
  };
  return (
    <input
      type="number"
      className="mate-angle"
      step={1}
      value={draft ?? String(Number(value.toFixed(2)))}
      aria-label="Rotate angle in degrees"
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit();
      }}
    />
  );
}

interface ViewportToolsProps {
  activeTool: ViewportTool | null;
  onToolChange: (tool: ViewportTool | null) => void;
  /** An orientation is set (lay-on-face applied): show Undo + Reset. */
  hasOrientation: boolean;
  /** There is at least one step to pop. */
  canUndo: boolean;
  onUndo: () => void;
  onReset: () => void;
  /** Current palette colors ('#RRGGBB'), filament order — the paint-face brush swatches. */
  colors: string[];
  /** Active brush: palette index to paint with, or null = eraser. */
  brush: number | null;
  onBrush: (brush: number | null) => void;
  /** Texture-face tool in eraser mode (a stroke removes textures instead of adding one). */
  textureErase: boolean;
  onTextureErase: (erase: boolean) => void;
  /** A pipeline run is in flight: picking is off in Viewer3D, so say so. */
  paused?: boolean;
  /** Assemble needs two or more files loaded. */
  assembleAvailable: boolean;
  mate: MatePanel | null;
  onMateParams: (patch: Partial<Pick<MatePanel, 'offset' | 'flip' | 'angle'>>) => void;
  onMateApply: () => void;
  onMateCancel: () => void;
  /** Done / ✕: leave the Assemble tool (applied changes stay; an unapplied mate is discarded). */
  onAssembleDone: () => void;
  canUndoAssembly: boolean;
  onUndoAssembly: () => void;
}

const MATE_HINT: Record<MatePanel['step'], string> = {
  pickMoving: 'Click a face on the part to move.',
  pickTarget: 'Now click the face to put it against, on another file.',
  preview: 'Adjust, or drag the ring to spin and the arrows to slide, then Apply.',
};

const wrapAngle = (a: number) => ((((a + 180) % 360) + 360) % 360) - 180;

/** Toggle a tool: clicking the active one exits (null). */
export function ViewportTools({
  activeTool,
  onToolChange,
  hasOrientation,
  canUndo,
  onUndo,
  onReset,
  colors,
  brush,
  onBrush,
  textureErase,
  onTextureErase,
  paused = false,
  assembleAvailable,
  mate,
  onMateParams,
  onMateApply,
  onMateCancel,
  onAssembleDone,
  canUndoAssembly,
  onUndoAssembly,
}: ViewportToolsProps) {
  const toggle = (tool: ViewportTool) => onToolChange(activeTool === tool ? null : tool);
  const tip = (tool: ViewportTool, idle: string) => (activeTool === tool ? 'Click again or press Esc to exit' : idle);
  const matePending = !!mate && mate.step !== 'pickMoving';
  return (
    <div
      className={`viewport-tools${paused ? ' is-paused' : ''}`}
      role="toolbar"
      aria-label="Paint tools"
      title={paused ? 'Updating: tools are paused until it finishes' : undefined}
    >
      <button
        type="button"
        className={`vtool${activeTool === 'lay' ? ' is-active' : ''}`}
        onClick={() => toggle('lay')}
        aria-pressed={activeTool === 'lay'}
        title={tip('lay', 'Lay a face flat on the bed')}
      >
        <span className="vtool-icon" aria-hidden>
          <Icon name="lay" />
        </span>
        <span className="vtool-label">Lay on face</span>
      </button>
      <button
        type="button"
        className={`vtool${activeTool === 'paint' ? ' is-active' : ''}`}
        onClick={() => toggle('paint')}
        aria-pressed={activeTool === 'paint'}
        title={tip('paint', 'Paint a face in one color')}
      >
        <span className="vtool-icon" aria-hidden>
          <Icon name="brush" />
        </span>
        <span className="vtool-label">Paint face</span>
      </button>
      {activeTool === 'paint' && (
        <div className="vtool-brush" role="group" aria-label="Brush color">
          {colors.map((c, i) => (
            <button
              key={i}
              type="button"
              className={`brush-swatch${brush === i ? ' is-active' : ''}`}
              style={{ background: c }}
              title={`Paint filament ${i + 1}`}
              aria-label={`Paint filament ${i + 1}`}
              aria-pressed={brush === i}
              onClick={() => onBrush(i)}
            />
          ))}
          <button
            type="button"
            className={`brush-swatch brush-eraser${brush === null ? ' is-active' : ''}`}
            title="Eraser — removes paint"
            aria-label="Eraser"
            aria-pressed={brush === null}
            onClick={() => onBrush(null)}
          >
            <Icon name="eraser" />
          </button>
        </div>
      )}
      <button
        type="button"
        className={`vtool${activeTool === 'texture' ? ' is-active' : ''}`}
        onClick={() => toggle('texture')}
        aria-pressed={activeTool === 'texture'}
        title={tip('texture', 'Add a grip texture (real surface relief) to a face')}
      >
        <span className="vtool-icon" aria-hidden>
          <Icon name="texture" />
        </span>
        <span className="vtool-label">Texture face</span>
      </button>
      {activeTool === 'texture' && (
        <div className="vtool-panel vtool-panel-sm" role="group" aria-label="Texture brush">
          <div className="segmented segmented-sm">
            <button type="button" className={textureErase ? '' : 'is-active'} aria-pressed={!textureErase} onClick={() => onTextureErase(false)}>
              Add
            </button>
            <button type="button" className={textureErase ? 'is-active' : ''} aria-pressed={textureErase} onClick={() => onTextureErase(true)}>
              <Icon name="eraser" /> Eraser
            </button>
          </div>
          <p className="hint tex-hint">{textureErase ? 'Click or drag over a textured face to remove it.' : 'Pattern & settings: Texture tab.'}</p>
        </div>
      )}
      <button
        type="button"
        className={`vtool${activeTool === 'assemble' ? ' is-active' : ''}`}
        onClick={() => toggle('assemble')}
        aria-pressed={activeTool === 'assemble'}
        disabled={!assembleAvailable && activeTool !== 'assemble'}
        title={assembleAvailable ? tip('assemble', 'Mate two files face to face') : 'Add a second model file to assemble'}
      >
        <span className="vtool-icon" aria-hidden>
          <Icon name="assemble" />
        </span>
        <span className="vtool-label">Assemble</span>
      </button>
      {activeTool === 'assemble' && mate && (
        <div className="vtool-panel mate-panel" role="group" aria-label="Assemble">
          <div className="mate-head">
            <span className="mate-title">Assemble</span>
            <button
              type="button"
              className="mate-close"
              onClick={onAssembleDone}
              aria-label="Exit assemble"
              title={matePending ? 'Exit assemble (the unapplied mate is discarded)' : 'Exit assemble (Esc)'}
            >
              <Icon name="close" />
            </button>
          </div>
          <p className="hint tex-hint mate-step">
            {mate.updating ? 'Updating the assembly…' : MATE_HINT[mate.step]}
          </p>
          {mate.step === 'pickMoving' && mate.canMove && !mate.updating && (
            <p className="hint tex-hint mate-step">Or drag the gizmo to move / rotate the selected file (1 mm, 15° steps; hold Shift for free).</p>
          )}
          {(mate.movingName || mate.targetName) && (
            <ul className="mate-legend">
              {mate.movingName && (
                <li>
                  <span className="mate-dot mate-dot-moving" aria-hidden /> Moving: <span className="mate-file" title={mate.movingName}>{mate.movingName}</span>
                </li>
              )}
              {mate.targetName && (
                <li>
                  <span className="mate-dot mate-dot-target" aria-hidden /> Target: <span className="mate-file" title={mate.targetName}>{mate.targetName}</span>
                </li>
              )}
            </ul>
          )}
          {mate.step === 'preview' && (
            <div className="mate-settings">
              <label className="toggle toggle-inline">
                <input type="checkbox" checked={mate.flip} onChange={(e) => onMateParams({ flip: e.target.checked })} />
                <span>Flip</span>
              </label>
              <Slider label="Offset gap" unit="mm" min={0} max={20} step={0.1} value={mate.offset} commitOnRelease onChange={(v) => onMateParams({ offset: v })} />
              <div className="mate-rotate">
                <span className="field-label">Rotate</span>
                <div className="mate-rotate-row">
                  <button type="button" className="vtool vtool-mini" onClick={() => onMateParams({ angle: wrapAngle(mate.angle - 90) })} title="Rotate −90°">
                    −90°
                  </button>
                  <AngleBox value={mate.angle} onCommit={(v) => onMateParams({ angle: v })} />
                  <button type="button" className="vtool vtool-mini" onClick={() => onMateParams({ angle: wrapAngle(mate.angle + 90) })} title="Rotate +90°">
                    +90°
                  </button>
                </div>
              </div>
              <div className="vtool-sub mate-actions">
                <button type="button" className="vtool mate-apply" onClick={onMateApply}>
                  Apply
                </button>
                <button type="button" className="vtool vtool-mini" onClick={onMateCancel} title="Discard this mate and keep assembling (Esc)">
                  Cancel mate
                </button>
              </div>
            </div>
          )}
          {mate.step === 'pickTarget' && (
            <div className="vtool-sub mate-actions">
              <button type="button" className="vtool vtool-mini" onClick={onMateCancel} title="Discard this mate and keep assembling (Esc)">
                Cancel mate
              </button>
            </div>
          )}
          <div className="mate-foot">
            <div className="vtool-sub mate-footer">
              <button
                type="button"
                className="vtool vtool-mini mate-undo"
                onClick={onUndoAssembly}
                disabled={!canUndoAssembly}
                title="Undo the last assembly change (Ctrl/Cmd+Z)"
              >
                <Icon name="undo" /> Undo
              </button>
              <button
                type="button"
                className="pill mate-done"
                onClick={onAssembleDone}
                title={matePending ? 'Leave Assemble; the unapplied mate is discarded' : 'Leave Assemble; your changes are kept'}
              >
                <Icon name="check" /> Done
              </button>
            </div>
            <p className="hint mate-esc-hint">Esc to cancel · Done to finish</p>
          </div>
        </div>
      )}
      {hasOrientation && (
        <div className="vtool-sub">
          <button type="button" className="vtool vtool-mini" onClick={onUndo} disabled={!canUndo} title="Undo the last lay-on-face">
            Undo
          </button>
          <button type="button" className="vtool vtool-mini" onClick={onReset} title="Clear the orientation (back to as-loaded)">
            Reset
          </button>
        </div>
      )}
    </div>
  );
}
