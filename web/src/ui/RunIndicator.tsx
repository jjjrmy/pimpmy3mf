// Compact "updating" pill in the viewport's bottom-right corner. Shown instead of the full loading overlay
// while a re-run is in flight, so the previous result stays visible and orbitable underneath.
import { Icon } from './Icons';

interface RunIndicatorProps {
  label: string;
  /** 0..1 when the worker reports how far the stage is, else null (no bar). */
  fraction: number | null;
  /** Stops the run; omitted for loads that can't be cancelled (image decode, model load). */
  onCancel?: () => void;
  /** Extra short status shown under the label, e.g. that the viewport tools are paused. */
  note?: string;
}

export function RunIndicator({ label, fraction, onCancel, note }: RunIndicatorProps) {
  const pct = fraction == null ? null : Math.round(Math.min(1, Math.max(0, fraction)) * 100);
  return (
    <div className="run-pill" role="status" aria-live="polite">
      <span className="run-pill-spin" aria-hidden>
        <Icon name="spinner" className="icon-spin" />
      </span>
      <span className="run-pill-body">
        <span className="run-pill-label">{label}</span>
        {note && <span className="run-pill-note">{note}</span>}
        {pct != null && (
          <span className="run-pill-bar" aria-hidden>
            <span className="run-pill-fill" style={{ width: `${pct}%` }} />
          </span>
        )}
      </span>
      {onCancel && (
        <button type="button" className="run-pill-cancel" onClick={onCancel} aria-label="Cancel the update" title="Cancel the update">
          <Icon name="close" />
          <span>Cancel</span>
        </button>
      )}
    </div>
  );
}
