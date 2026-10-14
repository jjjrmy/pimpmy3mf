// Camo preset manifest (manifest.json in the PRESETS R2 bucket, served by the Worker at /api/presets).
// Images are served from /presets/<file>. Produced by scripts/presets/ (the images never live in the repo).

export interface PresetItem {
  id: string;
  name: string;
  /** Game titles the camo appears in (may be empty when unknown). */
  games: string[];
  /** Object key / file name, e.g. 'red-urban.webp'; fetch from /presets/<file>. */
  file: string;
  /** Wiki page the camo came from. */
  source: string;
  w?: number;
  h?: number;
}

export interface PresetManifest {
  version: number;
  generated: string;
  source: string;
  items: PresetItem[];
}

export function isManifest(x: unknown): x is PresetManifest {
  const m = x as PresetManifest;
  return !!m && Array.isArray(m.items) && m.items.every((i) => typeof i?.file === 'string' && typeof i?.name === 'string');
}
