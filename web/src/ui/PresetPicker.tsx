import { useEffect, useRef, useState } from 'react';
import type { PresetItem, PresetManifest } from '../shared/presets';

interface PresetPickerProps {
  manifest: PresetManifest;
  onPick: (item: PresetItem) => void;
  busyId: string | null;
}

/** "MW2 camos (N)" button opening a small thumbnail grid of the Modern Warfare 2 (2009) camos. */
export function PresetPicker({ manifest, onPick, busyId }: PresetPickerProps) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  // the controls column scrolls, so the grid is fixed to the viewport next to the button
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const place = () => {
    const r = btnRef.current?.getBoundingClientRect();
    if (!r) return;
    const width = Math.min(440, window.innerWidth - 16);
    const left = Math.min(Math.max(8, r.left), window.innerWidth - width - 8);
    setPos({ left, top: Math.min(r.bottom + 6, window.innerHeight - 200) });
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

  return (
    <div className="preset-picker">
      <button
        ref={btnRef}
        type="button"
        className="btn preset-btn"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => {
          place();
          setOpen((o) => !o);
        }}
      >
        🎨 MW2 camos <span className="dim">({manifest.items.length})</span>
      </button>
      {open && pos && (
        <div ref={popRef} className="preset-pop" role="dialog" aria-label="MW2 camos" style={{ left: pos.left, top: pos.top }}>
          <ul className="preset-grid">
            {manifest.items.map((it) => (
              <li key={it.id}>
                <button
                  type="button"
                  className={`preset-item${busyId === it.id ? ' is-busy' : ''}`}
                  title={it.name}
                  onClick={() => {
                    onPick(it);
                    setOpen(false);
                  }}
                >
                  <img src={`/presets/${it.file}`} alt="" loading="lazy" decoding="async" width={96} height={96} />
                  <span className="preset-name">{it.name}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
