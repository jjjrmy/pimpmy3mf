import { useEffect, useMemo, useRef, useState } from 'react';

interface BrandFilterProps {
  /** All catalog brands, alphabetical. */
  brands: string[];
  /** Brands always listed first, in this order (the defaults), above a divider. */
  pinned: string[];
  selected: Set<string>;
  onChange: (next: Set<string>) => void;
  onResetDefaults: () => void;
}

/** "Brand: N" button opening a searchable checkbox list with Select all / Clear / Reset to defaults. */
export function BrandFilter({ brands, pinned, selected, onChange, onResetDefaults }: BrandFilterProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const wrapRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  // the legend scrolls (overflow: auto), so the popover is fixed to the viewport, opening above the button
  const [pos, setPos] = useState<{ right: number; bottom: number } | null>(null);
  const place = () => {
    const r = btnRef.current?.getBoundingClientRect();
    if (r) setPos({ right: Math.max(8, window.innerWidth - r.right), bottom: window.innerHeight - r.top + 6 });
  };

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
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

  // pinned (defaults, in their order) first, then everything else alphabetically; search keeps the grouping
  const { top, rest, shown } = useMemo(() => {
    const q = query.trim().toLowerCase();
    const match = (b: string) => !q || b.toLowerCase().includes(q);
    const pin = new Set(pinned);
    const top = pinned.filter((b) => brands.includes(b) && match(b));
    const rest = brands.filter((b) => !pin.has(b) && match(b));
    return { top, rest, shown: [...top, ...rest] };
  }, [brands, pinned, query]);

  const toggle = (b: string) => {
    const next = new Set(selected);
    if (next.has(b)) next.delete(b);
    else next.add(b);
    onChange(next);
  };

  // "Select all" / "Clear" act on what the search shows
  const selectShown = () => onChange(new Set([...selected, ...shown]));
  const clearShown = () => {
    const hide = new Set(shown);
    onChange(new Set([...selected].filter((b) => !hide.has(b))));
  };

  return (
    <div className="brand-filter" ref={wrapRef}>
      <button
        ref={btnRef}
        type="button"
        className="menu-field"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => {
          place();
          setOpen((o) => !o);
        }}
      >
        <span className="menu-field-value">Brand: {selected.size === brands.length ? 'All' : selected.size}</span>
      </button>
      {open && pos && (
        <div className="brand-pop" role="dialog" aria-label="Filter brands" style={{ right: pos.right, bottom: pos.bottom }}>
          <input
            type="text"
            className="brand-search"
            placeholder="Search brands…"
            aria-label="Search brands"
            value={query}
            autoFocus
            onChange={(e) => setQuery(e.target.value)}
          />
          <div className="brand-actions">
            <button type="button" onClick={selectShown}>
              Select all
            </button>
            <button type="button" onClick={clearShown}>
              Clear
            </button>
            <button type="button" onClick={onResetDefaults}>
              Reset to defaults
            </button>
          </div>
          <ul className="brand-list">
            {top.map((b) => (
              <li key={b}>
                <label>
                  <input type="checkbox" checked={selected.has(b)} onChange={() => toggle(b)} />
                  <span>{b}</span>
                </label>
              </li>
            ))}
            {top.length > 0 && rest.length > 0 && <li className="brand-divider" role="separator" aria-hidden />}
            {rest.map((b) => (
              <li key={b}>
                <label>
                  <input type="checkbox" checked={selected.has(b)} onChange={() => toggle(b)} />
                  <span>{b}</span>
                </label>
              </li>
            ))}
            {!shown.length && <li className="dim">No brands match “{query}”.</li>}
          </ul>
        </div>
      )}
    </div>
  );
}
