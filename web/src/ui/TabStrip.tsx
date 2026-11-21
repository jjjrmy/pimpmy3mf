import { useRef } from 'react';

export type TabId = 'paint' | 'design' | 'colors' | 'texture';

export const TABS: { id: TabId; label: string }[] = [
  { id: 'paint', label: 'Paint' },
  { id: 'design', label: 'Design' },
  { id: 'colors', label: 'Colors' },
  { id: 'texture', label: 'Texture' },
];

/** The chunky yellow tab strip. Full `role=tablist` with roving focus + arrow-key navigation. */
/** `attention`: a tab to nudge toward (a small pulsing dot), e.g. Paint while a model has no camo yet. */
export function TabStrip({ active, onChange, attention = null }: { active: TabId; onChange: (id: TabId) => void; attention?: TabId | null }) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);

  const onKeyDown = (e: React.KeyboardEvent, i: number) => {
    let next = i;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (i + 1) % TABS.length;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = (i - 1 + TABS.length) % TABS.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = TABS.length - 1;
    else return;
    e.preventDefault();
    onChange(TABS[next].id);
    refs.current[next]?.focus();
  };

  return (
    <div className="tabstrip" role="tablist" aria-label="Design Your Print">
      {TABS.map((t, i) => {
        const selected = t.id === active;
        return (
          <button
            key={t.id}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="tab"
            id={`tab-${t.id}`}
            aria-selected={selected}
            aria-controls={`panel-${t.id}`}
            tabIndex={selected ? 0 : -1}
            className={`tab${selected ? ' is-active' : ''}${attention === t.id ? ' has-attention' : ''}`}
            onClick={() => onChange(t.id)}
            onKeyDown={(e) => onKeyDown(e, i)}
          >
            {t.label}
            {attention === t.id && <span className="tab-dot" aria-label="(pick a camo here)" />}
          </button>
        );
      })}
    </div>
  );
}
