import { useEffect, useState } from 'react';
import { hexToLab, slimPage, upstreamPageUrl, type Filament, type FilamentPage, type Lab } from '../shared/filaments';

const CACHE_KEY = 'pimpmy3mf.filaments.v1';
const TTL_MS = 24 * 60 * 60 * 1000;

export interface FilamentEntry {
  f: Filament;
  lab: Lab;
}

export type FilamentState =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; items: FilamentEntry[]; families: string[] };

/** One slim page: our Worker route first (edge-cached), else filamentcolors.xyz directly (CORS *), e.g. under vite dev. */
async function fetchPage(page: number, direct: boolean): Promise<{ data: FilamentPage; direct: boolean }> {
  if (!direct) {
    try {
      const res = await fetch(`/api/filaments?page=${page}`, { signal: AbortSignal.timeout(30000) });
      if (res.ok && (res.headers.get('content-type') ?? '').includes('application/json')) {
        return { data: (await res.json()) as FilamentPage, direct: false };
      }
    } catch {
      // fall through to upstream
    }
  }
  const res = await fetch(upstreamPageUrl(page), { signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`filamentcolors.xyz ${res.status}`);
  return { data: slimPage(await res.json(), page), direct: true };
}

async function fetchAll(): Promise<Filament[]> {
  const first = await fetchPage(1, false);
  const all = [...first.data.results];
  const rest = Array.from({ length: first.data.pages - 1 }, (_, i) => i + 2);
  // a few at a time, to stay polite
  for (let i = 0; i < rest.length; i += 4) {
    const batch = await Promise.all(rest.slice(i, i + 4).map((p) => fetchPage(p, first.direct)));
    for (const b of batch) all.push(...b.data.results);
  }
  return all;
}

function readCache(): Filament[] | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const { t, items } = JSON.parse(raw) as { t: number; items: Filament[] };
    return Date.now() - t < TTL_MS && Array.isArray(items) && items.length ? items : null;
  } catch {
    return null;
  }
}

function writeCache(items: Filament[]) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ t: Date.now(), items }));
  } catch {
    // storage full / disabled: just skip caching
  }
}

function toState(items: Filament[]): FilamentState {
  const entries = items.map((f) => ({ f, lab: hexToLab(f.hex) }));
  const counts = new Map<string, number>();
  for (const { f } of entries) if (f.family) counts.set(f.family, (counts.get(f.family) ?? 0) + 1);
  const families = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k);
  return { status: 'ready', items: entries, families };
}

/** The filamentcolors.xyz swatch list, cached ~24 h in localStorage. 'error' when the API is unreachable. */
export function useFilaments(): FilamentState {
  const [state, setState] = useState<FilamentState>(() => {
    const cached = readCache();
    return cached ? toState(cached) : { status: 'loading' };
  });

  useEffect(() => {
    if (state.status !== 'loading') return;
    let alive = true;
    fetchAll()
      .then((items) => {
        if (!alive) return;
        if (!items.length) throw new Error('empty');
        writeCache(items);
        setState(toState(items));
      })
      .catch(() => alive && setState({ status: 'error' }));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return state;
}
