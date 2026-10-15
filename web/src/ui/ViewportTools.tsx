// Paint-mode viewport toolbar: Lay-on-face and Paint-face tools, plus orientation Undo / Reset.
// Sits as a small overlay inside the 3D viewport (themed "Pimp My Ride" chips). Purely presentational:
// the active tool, hover highlighting and picking live in Viewer3D / App.

export type ViewportTool = 'lay' | 'paint';

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
}

/** Toggle a tool: clicking the active one exits (null). */
export function ViewportTools({ activeTool, onToolChange, hasOrientation, canUndo, onUndo, onReset, colors, brush, onBrush }: ViewportToolsProps) {
  const toggle = (tool: ViewportTool) => onToolChange(activeTool === tool ? null : tool);
  return (
    <div className="viewport-tools" role="toolbar" aria-label="Paint tools">
      <button
        type="button"
        className={`vtool${activeTool === 'lay' ? ' is-active' : ''}`}
        onClick={() => toggle('lay')}
        aria-pressed={activeTool === 'lay'}
        title="Lay a face flat on the bed"
      >
        <span className="vtool-icon" aria-hidden>
          ⬓
        </span>
        <span className="vtool-label">Lay on face</span>
      </button>
      <button
        type="button"
        className={`vtool${activeTool === 'paint' ? ' is-active' : ''}`}
        onClick={() => toggle('paint')}
        aria-pressed={activeTool === 'paint'}
        title="Paint a face in one color"
      >
        <span className="vtool-icon" aria-hidden>
          🖌
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
            ⌫
          </button>
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
