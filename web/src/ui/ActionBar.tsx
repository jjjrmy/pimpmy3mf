import { useEffect, useMemo, useRef, useState } from 'react';
import type { PrinterPreset } from '../core/types';
import type { ExportKind } from '../worker/messages';

interface ActionBarProps {
  /** No result yet: every export is disabled. */
  disabled: boolean;
  busy: ExportKind | null;
  /** `printerId` is passed for the Bambu project so the export uses the popover's choice right away. */
  onExport: (kind: ExportKind, printerId?: string) => void;
  printers: PrinterPreset[];
  printerId: string;
  onPrinterId: (id: string) => void;
  perPart: boolean;
  onPerPart: (v: boolean) => void;
  /** True once a model with a multi-part object is loaded; otherwise the per-part toggle is disabled. */
  perPartAvailable: boolean;
}

/** A popover anchored to a button, fixed to the viewport (so the blue panel never clips it), opening upward. */
function useAnchoredPopover() {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ right: number; bottom: number } | null>(null);
  const place = () => {
    const r = btnRef.current?.getBoundingClientRect();
    if (r) setPos({ right: Math.max(8, window.innerWidth - r.right), bottom: window.innerHeight - r.top + 8 });
  };
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!popRef.current?.contains(t) && !btnRef.current?.contains(t)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    const onMove = () => place();
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', onMove);
    window.addEventListener('scroll', onMove, true);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onMove);
      window.removeEventListener('scroll', onMove, true);
    };
  }, [open]);
  const toggle = () => {
    place();
    setOpen((o) => !o);
  };
  return { open, setOpen, toggle, btnRef, popRef, pos };
}

export function ActionBar(props: ActionBarProps) {
  const { disabled, busy, printers, printerId } = props;
  const busyAny = busy !== null;

  const bambu = useAnchoredPopover();
  const more = useAnchoredPopover();

  const current = printers.find((p) => p.id === printerId) ?? printers[0];
  const models = useMemo(() => [...new Set(printers.map((p) => p.printer))], [printers]);
  const nozzles = printers.filter((p) => p.printer === current.printer);

  const pickPrinter = (printer: string) => {
    const combos = printers.filter((p) => p.printer === printer);
    const next = combos.find((p) => p.nozzle === current.nozzle) ?? combos.find((p) => p.nozzle === '0.4') ?? combos[0];
    if (next) props.onPrinterId(next.id);
  };

  return (
    <div className="actionbar">
      <div className="actionbar-row">
        <button
          type="button"
          className={`toggle-btn${props.perPart && props.perPartAvailable ? ' is-on' : ''}`}
          aria-pressed={props.perPart && props.perPartAvailable}
          disabled={!props.perPartAvailable}
          title={
            props.perPartAvailable
              ? 'Export each part as its own object with its own modifiers, so you can print it on its own plate.'
              : 'Load a model with more than one part to enable per-part modifiers.'
          }
          onClick={() => props.onPerPart(!props.perPart)}
        >
          Per-part: {props.perPart && props.perPartAvailable ? 'ON' : 'OFF'}
        </button>

        <div className="actionbar-actions">
          <button type="button" className="pill" disabled={disabled || busyAny} onClick={() => props.onExport('stl-zip')}>
            {busy === 'stl-zip' ? '…' : '.stl'}
          </button>
          <button type="button" className="pill" disabled={disabled || busyAny} onClick={() => props.onExport('plain-3mf')}>
            {busy === 'plain-3mf' ? '…' : '.3mf'}
          </button>

          <div className="pill-wrap">
            <button
              ref={bambu.btnRef}
              type="button"
              className="pill pill-primary"
              disabled={disabled || busyAny}
              aria-haspopup="dialog"
              aria-expanded={bambu.open}
              onClick={bambu.toggle}
            >
              {busy === 'bambu-3mf' ? 'Preparing…' : 'Bambu .3mf'}
              <span className="pill-sub">{current.printer.replace(/^Bambu Lab /, '')} · {current.nozzle} mm ▾</span>
            </button>
            {bambu.open && bambu.pos && (
              <div
                ref={bambu.popRef}
                className="popover"
                role="dialog"
                aria-label="Bambu project options"
                style={{ right: bambu.pos.right, bottom: bambu.pos.bottom }}
              >
                <label className="field">
                  <span className="field-label">Printer</span>
                  <select aria-label="Printer" value={current.printer} onChange={(e) => pickPrinter(e.target.value)}>
                    {models.map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <span className="field-label">Nozzle</span>
                  <select aria-label="Nozzle" value={current.id} onChange={(e) => props.onPrinterId(e.target.value)}>
                    {nozzles.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.nozzle} mm
                      </option>
                    ))}
                  </select>
                </label>
                <p className="hint">Textured PEI plate · one PLA Basic filament per color</p>
                <button
                  type="button"
                  className="btn-chunky"
                  disabled={disabled || busyAny}
                  onClick={() => {
                    bambu.setOpen(false);
                    props.onExport('bambu-3mf', current.id);
                  }}
                >
                  Download
                </button>
              </div>
            )}
          </div>

          <div className="pill-wrap">
            <button
              ref={more.btnRef}
              type="button"
              className="pill pill-more"
              aria-haspopup="menu"
              aria-expanded={more.open}
              aria-label="More downloads"
              title="More downloads"
              disabled={disabled || busyAny}
              onClick={more.toggle}
            >
              ⋯
            </button>
            {more.open && more.pos && (
              <div
                ref={more.popRef}
                className="popover popover-menu"
                role="menu"
                aria-label="More downloads"
                style={{ right: more.pos.right, bottom: more.pos.bottom }}
              >
                <button
                  type="button"
                  role="menuitem"
                  className="menu-item"
                  disabled={disabled || busyAny}
                  onClick={() => {
                    more.setOpen(false);
                    props.onExport('preview-png');
                  }}
                >
                  {busy === 'preview-png' ? 'Preparing…' : 'Preview .png'}
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
