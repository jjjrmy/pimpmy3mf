import { useEffect, useRef, useState } from 'react';

interface MaterialFilterProps {
  options: string[];
  value: string;
  onChange: (v: string) => void;
}

/** Single-select material dropdown: a field button + themed popover listbox, matching BrandFilter.
 *  Keyboard: arrows/Home/End move, Enter/Space choose, Escape closes. */
export function MaterialFilter({ options, value, onChange }: MaterialFilterProps) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const wrapRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  // the legend scrolls, so the popover is fixed to the viewport, opening above the button
  const [pos, setPos] = useState<{ left: number; bottom: number } | null>(null);
  const place = () => {
    const r = btnRef.current?.getBoundingClientRect();
    if (r) setPos({ left: r.left, bottom: window.innerHeight - r.top + 6 });
  };

  useEffect(() => {
    if (!open) return;
    setActive(Math.max(0, options.indexOf(value)));
    const onDown = (e: PointerEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onMove = () => place();
    document.addEventListener('pointerdown', onDown);
    window.addEventListener('resize', onMove);
    window.addEventListener('scroll', onMove, true);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      window.removeEventListener('resize', onMove);
      window.removeEventListener('scroll', onMove, true);
    };
  }, [open, options, value]);

  const choose = (v: string) => {
    onChange(v);
    setOpen(false);
    btnRef.current?.focus();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!open) {
      if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        place();
        setOpen(true);
      }
      return;
    }
    if (e.key === 'Escape') {
      setOpen(false);
      btnRef.current?.focus();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => Math.min(options.length - 1, i + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => Math.max(0, i - 1));
    } else if (e.key === 'Home') {
      e.preventDefault();
      setActive(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      setActive(options.length - 1);
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      choose(options[active]);
    }
  };

  return (
    <div className="menu-filter" ref={wrapRef}>
      <button
        ref={btnRef}
        type="button"
        className="menu-field"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Filament material: ${value}`}
        onClick={() => {
          place();
          setOpen((o) => !o);
        }}
        onKeyDown={onKeyDown}
      >
        <span className="menu-field-value">{value}</span>
      </button>
      {open && pos && (
        <ul
          className="menu-pop"
          role="listbox"
          aria-label="Filament material"
          style={{ left: pos.left, bottom: pos.bottom }}
          onKeyDown={onKeyDown}
        >
          {options.map((o, i) => (
            <li
              key={o}
              role="option"
              aria-selected={o === value}
              className={`menu-option${i === active ? ' is-active' : ''}${o === value ? ' is-selected' : ''}`}
              onMouseEnter={() => setActive(i)}
              onClick={() => choose(o)}
            >
              <span className="menu-check" aria-hidden>
                {o === value ? '✓' : ''}
              </span>
              {o}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
