import { useEffect, useMemo, useRef, useState } from 'react';
import type { PrinterPreset } from '../core/types';
import type { ExportKind } from '../worker/messages';

interface DownloadsProps {
  disabled: boolean;
  busy: ExportKind | null;
  warnings: string[];
  /** `printerId` is passed for the Bambu project so the export uses the popover's choice right away. */
  onExport: (kind: ExportKind, printerId?: string) => void;
  /** Validated printer + nozzle combos (first = default). */
  printers: PrinterPreset[];
  printerId: string;
  onPrinterId: (id: string) => void;
}

const OTHER: { kind: ExportKind; label: string }[] = [
  { kind: 'plain-3mf', label: 'Plain .3mf' },
  { kind: 'stl-zip', label: 'STLs (.zip)' },
  { kind: 'preview-png', label: 'Preview .png' },
];

/** Bambu project button with a printer/nozzle popover, plus the plain downloads. */
export function Downloads({ disabled, busy, warnings, onExport, printers, printerId, onPrinterId }: DownloadsProps) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  const current = printers.find((p) => p.id === printerId) ?? printers[0];
  const models = useMemo(() => [...new Set(printers.map((p) => p.printer))], [printers]);
  const nozzles = printers.filter((p) => p.printer === current.printer);

  // close on outside click / Escape
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const pickPrinter = (printer: string) => {
    const combos = printers.filter((p) => p.printer === printer);
    // keep the nozzle size when the new printer has it, else prefer 0.4
    const next =
      combos.find((p) => p.nozzle === current.nozzle) ?? combos.find((p) => p.nozzle === '0.4') ?? combos[0];
    if (next) onPrinterId(next.id);
  };

  const busyAny = busy !== null;

  return (
    <div className="downloads">
      <div className="downloads-grid">
        <div className="bambu-wrap" ref={wrapRef}>
          <button
            type="button"
            className="btn btn-primary bambu-btn"
            disabled={disabled || busyAny}
            aria-haspopup="dialog"
            aria-expanded={open}
            onClick={() => setOpen((o) => !o)}
          >
            {busy === 'bambu-3mf' ? 'Preparing…' : 'Bambu project .3mf'}
            <span className="bambu-btn-sub">
              {current.printer.replace(/^Bambu Lab /, '')} · {current.nozzle} mm
            </span>
          </button>
          {open && (
            <div className="popover" role="dialog" aria-label="Bambu project options">
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
                <select aria-label="Nozzle" value={current.id} onChange={(e) => onPrinterId(e.target.value)}>
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
                className="btn btn-primary"
                disabled={disabled || busyAny}
                onClick={() => {
                  setOpen(false);
                  onExport('bambu-3mf', current.id);
                }}
              >
                Download
              </button>
            </div>
          )}
        </div>
        {OTHER.map((b) => (
          <button key={b.kind} type="button" className="btn" disabled={disabled || busyAny} onClick={() => onExport(b.kind)}>
            {busy === b.kind ? 'Preparing…' : b.label}
          </button>
        ))}
      </div>
      {warnings.length > 0 && (
        <ul className="downloads-warnings">
          {warnings.map((w, i) => (
            <li key={i}>⚠ {w}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
