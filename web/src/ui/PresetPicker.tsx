import { useEffect, useMemo, useRef, useState } from 'react';
import type { PresetItem, PresetManifest } from '../shared/presets';

interface PresetPickerProps {
  manifest: PresetManifest;
  onPick: (item: PresetItem) => void;
  busyId: string | null;
}

/** "Presets" button opening a searchable, game-filterable thumbnail gallery (thumbnails lazy-load). */
export function PresetPicker({ manifest, onPick, busyId }: PresetPickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [game, setGame] = useState('All');
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  // the controls column scrolls, so the gallery is fixed to the viewport next to the button
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const place = () => {
    const r = btnRef.current?.getBoundingClientRect();
    if (!r) return;
    const width = Math.min(560, window.innerWidth - 16);
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

  // games, most camos first
  const games = useMemo(() => {
    const counts = new Map<string, number>();
    for (const it of manifest.items) for (const g of it.games) counts.set(g, (counts.get(g) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([g, n]) => ({ g, n }));
  }, [manifest]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return manifest.items.filter(
      (it) => (game === 'All' || it.games.includes(game)) && (!q || it.name.toLowerCase().includes(q)),
    );
  }, [manifest, query, game]);

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
        🎨 Camo presets <span className="dim">({manifest.items.length})</span>
      </button>
      {open && pos && (
        <div ref={popRef} className="preset-pop" role="dialog" aria-label="Camo presets" style={{ left: pos.left, top: pos.top }}>
          <div className="preset-head">
            <input
              type="text"
              className="preset-search"
              placeholder="Search camos…"
              aria-label="Search camos"
              value={query}
              autoFocus
              onChange={(e) => setQuery(e.target.value)}
            />
            <select aria-label="Game" value={game} onChange={(e) => setGame(e.target.value)}>
              <option value="All">All games</option>
              {games.map(({ g, n }) => (
                <option key={g} value={g}>
                  {g} ({n})
                </option>
              ))}
            </select>
          </div>
          <div className="preset-count dim">
            {shown.length} camo{shown.length === 1 ? '' : 's'}
          </div>
          <ul className="preset-grid">
            {shown.map((it) => (
              <li key={it.id}>
                <button
                  type="button"
                  className={`preset-item${busyId === it.id ? ' is-busy' : ''}`}
                  title={`${it.name}${it.games.length ? ' · ' + it.games.join(', ') : ''}`}
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
            {!shown.length && <li className="dim preset-empty">No camos match.</li>}
          </ul>
        </div>
      )}
    </div>
  );
}
