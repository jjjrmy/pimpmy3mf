// Filament swatch data from filamentcolors.xyz (public API, CORS *), slimmed to the fields the app uses.
// Shared by the Cloudflare Worker route (/api/filaments, slims + edge-caches one upstream page per request)
// and the browser (falls back to fetching upstream directly, e.g. under `vite dev`).

export const UPSTREAM = 'https://filamentcolors.xyz/api/swatch/';
/** The API caps page_size at 100. */
export const PAGE_SIZE = 100;

/** One swatch, slimmed. */
export interface Filament {
  /** filamentcolors.xyz slug; swatch page is https://filamentcolors.xyz/swatch/<slug>/ */
  slug: string;
  /** '#RRGGBB' */
  hex: string;
  name: string;
  brand: string;
  /** Material as the brand sells it, e.g. 'Matte PLA'. */
  type: string;
  /** Material family, e.g. 'PLA', 'PETG', 'ABS / ASA', 'TPU / TPE', 'Exotics'. */
  family: string;
  td: number | null;
  available: boolean;
  /** Purchase link (manufacturer, else Amazon), if any. */
  url: string | null;
}

export interface FilamentPage {
  count: number;
  pages: number;
  page: number;
  results: Filament[];
}

interface RawSwatch {
  slug?: string;
  hex_color?: string;
  color_name?: string;
  manufacturer?: { name?: string } | null;
  filament_type?: { name?: string; parent_type?: { name?: string } | null } | null;
  td?: number | null;
  is_available?: boolean | null;
  mfr_purchase_link?: string | null;
  amazon_purchase_link?: string | null;
}

export function upstreamPageUrl(page: number): string {
  return `${UPSTREAM}?format=json&page_size=${PAGE_SIZE}&page=${page}`;
}

/** Upstream page JSON → slim page. Drops swatches without a usable hex. */
export function slimPage(raw: { count?: number; results?: RawSwatch[] }, page: number): FilamentPage {
  const results: Filament[] = [];
  for (const r of raw.results ?? []) {
    const hex = (r.hex_color ?? '').replace('#', '').trim();
    if (!/^[0-9a-fA-F]{6}$/.test(hex) || !r.slug) continue;
    results.push({
      slug: r.slug,
      hex: '#' + hex.toUpperCase(),
      name: r.color_name ?? '',
      brand: r.manufacturer?.name ?? 'Unknown',
      type: r.filament_type?.name ?? '',
      family: r.filament_type?.parent_type?.name ?? r.filament_type?.name ?? '',
      td: typeof r.td === 'number' ? r.td : null,
      available: r.is_available !== false,
      url: r.mfr_purchase_link || r.amazon_purchase_link || null,
    });
  }
  const count = raw.count ?? results.length;
  return { count, pages: Math.max(1, Math.ceil(count / PAGE_SIZE)), page, results };
}

// ---------------------------------------------------------------------------------- color math

export type Lab = [number, number, number];

/** '#RRGGBB' → CIELAB (D65). */
export function hexToLab(hex: string): Lab {
  const n = parseInt(hex.replace('#', ''), 16);
  const lin = (c: number) => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const r = lin((n >> 16) & 255), g = lin((n >> 8) & 255), b = lin(n & 255);
  const x = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047;
  const y = 0.2126729 * r + 0.7151522 * g + 0.072175 * b;
  const z = (0.0193339 * r + 0.119192 * g + 0.9503041 * b) / 1.08883;
  const d = 6 / 29;
  const f = (t: number) => (t > d ** 3 ? Math.cbrt(t) : t / (3 * d * d) + 4 / 29);
  const fx = f(x), fy = f(y), fz = f(z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/** CIEDE2000 color difference. */
export function deltaE2000(a: Lab, b: Lab): number {
  const [L1, a1, b1] = a;
  const [L2, a2, b2] = b;
  const rad = Math.PI / 180;
  const C1 = Math.hypot(a1, b1), C2 = Math.hypot(a2, b2);
  const Cm = (C1 + C2) / 2;
  const G = 0.5 * (1 - Math.sqrt(Cm ** 7 / (Cm ** 7 + 25 ** 7)));
  const a1p = (1 + G) * a1, a2p = (1 + G) * a2;
  const C1p = Math.hypot(a1p, b1), C2p = Math.hypot(a2p, b2);
  const h = (bb: number, ap: number) => {
    if (bb === 0 && ap === 0) return 0;
    const t = Math.atan2(bb, ap) / rad;
    return t >= 0 ? t : t + 360;
  };
  const h1p = h(b1, a1p), h2p = h(b2, a2p);
  const dLp = L2 - L1;
  const dCp = C2p - C1p;
  let dhp = 0;
  if (C1p * C2p !== 0) {
    dhp = h2p - h1p;
    if (dhp > 180) dhp -= 360;
    else if (dhp < -180) dhp += 360;
  }
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin((dhp / 2) * rad);
  const Lpm = (L1 + L2) / 2;
  const Cpm = (C1p + C2p) / 2;
  let hpm = h1p + h2p;
  if (C1p * C2p !== 0) {
    if (Math.abs(h1p - h2p) > 180) hpm = h1p + h2p < 360 ? (h1p + h2p + 360) / 2 : (h1p + h2p - 360) / 2;
    else hpm = (h1p + h2p) / 2;
  }
  const T =
    1 -
    0.17 * Math.cos((hpm - 30) * rad) +
    0.24 * Math.cos(2 * hpm * rad) +
    0.32 * Math.cos((3 * hpm + 6) * rad) -
    0.2 * Math.cos((4 * hpm - 63) * rad);
  const dTheta = 30 * Math.exp(-(((hpm - 275) / 25) ** 2));
  const Rc = 2 * Math.sqrt(Cpm ** 7 / (Cpm ** 7 + 25 ** 7));
  const Sl = 1 + (0.015 * (Lpm - 50) ** 2) / Math.sqrt(20 + (Lpm - 50) ** 2);
  const Sc = 1 + 0.045 * Cpm;
  const Sh = 1 + 0.015 * Cpm * T;
  const Rt = -Math.sin(2 * dTheta * rad) * Rc;
  const l = dLp / Sl, c = dCp / Sc, hh = dHp / Sh;
  return Math.sqrt(l * l + c * c + hh * hh + Rt * c * hh);
}

/** The user's default brand list (applies on first visit and after "Reset to defaults"). */
export const DEFAULT_BRANDS = [
  'Bambu Lab',
  'Polymaker',
  'eSun',
  'Sunlu',
  'Elegoo',
  'Siraya Tech',
  'Creality',
  'Overture',
  'Flashforge',
  'YXPolymer',
  'Hatchbox',
];

const normBrand = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Map the default brand list onto the catalog's actual manufacturer names: case/punctuation-insensitive,
 * also accepting a catalog name that extends the wanted one ("Flashforge" → "Flashforge 3D").
 * Returns the matched catalog names and the wanted names the catalog doesn't have.
 */
export function resolveBrands(wanted: string[], catalog: string[]): { matched: string[]; missing: string[] } {
  const matched = new Set<string>();
  const missing: string[] = [];
  for (const w of wanted) {
    const nw = normBrand(w);
    const hits = catalog.filter((b) => {
      const nb = normBrand(b);
      return nb === nw || (nw.length >= 5 && nb.startsWith(nw));
    });
    if (hits.length) hits.forEach((h) => matched.add(h));
    else missing.push(w);
  }
  return { matched: [...matched], missing };
}

export interface Suggestion {
  filament: Filament;
  deltaE: number;
}

/**
 * Ranked suggestions for one target color: each brand's single closest swatch (CIEDE2000), brands ordered
 * by that distance, so position 0 is the overall closest filament. `family` filters by material family
 * ('Any' = no filter). Unavailable swatches are skipped.
 */
export function rankSuggestions(
  targetHex: string,
  filaments: { f: Filament; lab: Lab }[],
  family: string,
  brands: Set<string> | null = null,
  limit = 60,
): Suggestion[] {
  const target = hexToLab(targetHex);
  const bestByBrand = new Map<string, Suggestion>();
  for (const { f, lab } of filaments) {
    if (!f.available) continue;
    if (family !== 'Any' && f.family !== family) continue;
    if (brands && !brands.has(f.brand)) continue;
    const dE = deltaE2000(target, lab);
    const cur = bestByBrand.get(f.brand);
    if (!cur || dE < cur.deltaE) bestByBrand.set(f.brand, { filament: f, deltaE: dE });
  }
  return [...bestByBrand.values()].sort((a, b) => a.deltaE - b.deltaE).slice(0, limit);
}
