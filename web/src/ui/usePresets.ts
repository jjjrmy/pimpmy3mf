import { useEffect, useState } from 'react';
import { isManifest, type PresetManifest } from '../shared/presets';

/** The camo preset manifest, or null when there is none (no R2 binding, local dev, error): the picker then hides. */
export function usePresets(): PresetManifest | null {
  const [manifest, setManifest] = useState<PresetManifest | null>(null);
  useEffect(() => {
    let alive = true;
    // revalidate every load (the edge cache keeps it fast), so a replaced preset set shows up right away
    fetch('/api/presets', { cache: 'no-cache', signal: AbortSignal.timeout(15000) })
      .then(async (res) => {
        if (!res.ok || !(res.headers.get('content-type') ?? '').includes('json')) return null;
        const data: unknown = await res.json();
        return isManifest(data) && data.items.length ? data : null;
      })
      .catch(() => null)
      .then((m) => alive && setManifest(m));
    return () => {
      alive = false;
    };
  }, []);
  return manifest;
}
