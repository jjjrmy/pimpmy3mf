// Filament swatch data, slimmed to the fields the app uses, from two sources merged into one catalog:
//   - filamentcolors.xyz (public API, CORS *): lab-MEASURED colors  -> source 'measured'
//   - SpoolmanDB (MIT, github.com/Donkie/SpoolmanDB): MANUFACTURER-listed colors -> source 'maker'
// Shared by the Cloudflare Worker routes (/api/filaments: slims + edge-caches one filamentcolors.xyz page per
// request; /api/filaments?source=spoolman: proxies the SpoolmanDB dump) and the browser (which falls back to
// fetching each upstream directly, e.g. under `vite dev`, where both allow CORS).

export const UPSTREAM = 'https://filamentcolors.xyz/api/swatch/';
/** The API caps page_size at 100. */
export const PAGE_SIZE = 100;
/** SpoolmanDB compiled dump: one JSON array of manufacturer-listed filaments (MIT, CORS *, ~4.6 MB). */
export const SPOOLMAN_URL = 'https://donkie.github.io/SpoolmanDB/filaments.json';

/** Where a swatch's color came from: 'measured' = filamentcolors.xyz, 'maker' = SpoolmanDB (manufacturer-listed). */
export type FilamentSource = 'measured' | 'maker';

/** One swatch, slimmed. */
export interface Filament {
  /** Unique id. filamentcolors.xyz slug (swatch page https://filamentcolors.xyz/swatch/<slug>/), or 'sm:<id>'. */
  slug: string;
  /** '#RRGGBB' */
  hex: string;
  name: string;
  brand: string;
  /** Material as the brand sells it, e.g. 'Matte PLA' (filamentcolors.xyz `type` or SpoolmanDB `material`). */
  type: string;
  /** Material family, e.g. 'PLA', 'PETG', 'ABS / ASA', 'TPU / TPE', 'Exotics'. '' for maker swatches. */
  family: string;
  td: number | null;
  available: boolean;
  /** Purchase link (manufacturer, else Amazon), if any. */
  url: string | null;
  /** Which source the color came from (drives the "measured" / "maker color" badge). */
  source: FilamentSource;
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
      source: 'measured',
    });
  }
  const count = raw.count ?? results.length;
  return { count, pages: Math.max(1, Math.ceil(count / PAGE_SIZE)), page, results };
}

// ---------------------------------------------------------------------- SpoolmanDB (maker colors)

/** One SpoolmanDB entry (the fields we read). The dump repeats each color per weight/diameter. */
export interface SpoolmanRaw {
  id?: string;
  manufacturer?: string;
  name?: string;
  material?: string;
  color_hex?: string | null;
  /** Multi-color spools list several hexes here; we skip those (a single hex would misrepresent them). */
  color_hexes?: string[] | null;
}

/**
 * SpoolmanDB array → slim Filament[] (source 'maker'). Drops multi-color (`color_hexes`) and bad-hex entries,
 * and dedupes the dump's per-weight / per-diameter repeats by manufacturer + name + material + hex.
 * Returns the slim list plus the number of multi-color entries skipped.
 */
export function slimSpoolman(raw: SpoolmanRaw[]): { results: Filament[]; multiColor: number } {
  const results: Filament[] = [];
  const seen = new Set<string>();
  let multiColor = 0;
  for (const r of raw) {
    if (r.color_hexes && r.color_hexes.length) {
      multiColor++;
      continue;
    }
    const hex = (r.color_hex ?? '').replace('#', '').trim();
    if (!/^[0-9a-fA-F]{6}$/.test(hex)) continue;
    const brand = (r.manufacturer ?? 'Unknown').trim();
    const name = (r.name ?? '').trim();
    const material = (r.material ?? '').trim();
    const dedupe = `${brand}|${name}|${material}|${hex}`.toLowerCase();
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    results.push({
      slug: 'sm:' + (r.id ?? dedupe),
      hex: '#' + hex.toUpperCase(),
      name,
      brand,
      type: material,
      family: '',
      td: null,
      available: true,
      url: null,
      source: 'maker',
    });
  }
  return { results, multiColor };
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
 * Normalized-key aliases to fold the same maker spelled differently across the two sources onto ONE catalog
 * brand. Keys/values are `normBrand(...)` forms. The only pairs the data needs (every other shared brand already
 * matches once punctuation/case is stripped): SpoolmanDB "FlashForge" -> filamentcolors "Flashforge 3D", and
 * SpoolmanDB "ZIRO 3D" -> filamentcolors "Ziro".
 */
const BRAND_ALIAS: Record<string, string> = {
  flashforge: 'flashforge3d',
  ziro3d: 'ziro',
};

/** Canonical brand key: normalized, then folded through BRAND_ALIAS so cross-source spellings collapse. */
export function canonBrand(name: string): string {
  const n = normBrand(name);
  return BRAND_ALIAS[n] ?? n;
}

/** Tidy an all-caps SpoolmanDB-only brand (e.g. "SMARTFIL" -> "Smartfil"); leave mixed/numbered names as-is. */
function tidyBrand(name: string): string {
  const n = name.trim();
  return /^[A-Z]+$/.test(n) ? n[0] + n.slice(1).toLowerCase() : n;
}

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

// ---------------------------------------------------------------------- material classes

export type MaterialClass =
  | 'PLA basic'
  | 'PLA+ / Pro / Tough'
  | 'PETG'
  | 'ABS'
  | 'ASA'
  | 'TPU'
  | 'Other';

/**
 * The Material dropdown's options. 'Any' = no filter; 'PLA (all)' spans both PLA classes; the rest map 1:1 to a
 * `MaterialClass`. 'PLA (all)' is the default (closest to the old 'PLA' family filter).
 */
export const MATERIAL_CLASSES = [
  'Any',
  'PLA (all)',
  'PLA basic',
  'PLA+ / Pro / Tough',
  'PETG',
  'ABS',
  'ASA',
  'TPU',
  'Other',
] as const;

export type MaterialFilter = (typeof MATERIAL_CLASSES)[number];
export const DEFAULT_MATERIAL: MaterialFilter = 'PLA (all)';

/** Migrate a saved material value onto the current options; unknown/old values (incl. the old 'PLA') -> default. */
export function normalizeMaterial(saved: string | null | undefined): MaterialFilter {
  return (MATERIAL_CLASSES as readonly string[]).includes(saved ?? '') ? (saved as MaterialFilter) : DEFAULT_MATERIAL;
}

/**
 * Normalized material class from a swatch's `type` (filamentcolors.xyz) or `material` (SpoolmanDB), plus its
 * filamentcolors `family` when present. `family` lets us keep brand PLA lines whose name lacks "pla" (Polymaker
 * Panchroma, BioFusion, Textura…) in the PLA family; SpoolmanDB has no family but its `material` is always generic.
 * Order matters: PC/ABS and PC/PBT blends are pulled out before ABS; PLA splits into enhanced vs basic.
 *
 * Decisions (documented): PCTG / PETG-CF / PETG-HF/HS / CPE -> PETG. PET / PET-CF / HTPET -> Other. ABS incl. ABS+
 * and ABS blends with glass/CF; PC-ABS and PC/PBT blends -> Other. TPU incl. TPE / TPC / FilaFlex. Carbon-fiber,
 * wood-filled, matte, silk and glow PLA count as "PLA basic" (the enhanced group is the +/Pro/Tough strength grades).
 */
export function materialClass(f: Filament): MaterialClass {
  const t = (f.type || '').toLowerCase();
  const fam = (f.family || '').toLowerCase();
  if (/pc.*abs|abs.*pc|pcabs|pc\+?pbt|pcpbt/.test(t)) return 'Other'; // PC/ABS & PC/PBT blends
  if (fam === 'pla' || /pla/.test(t)) {
    const enhanced = /(pla\s*\+|\+\s*pla|htpla|plus|\bpro\b|tough|super)/.test(t) && !/wood/.test(t);
    return enhanced ? 'PLA+ / Pro / Tough' : 'PLA basic';
  }
  if (/petg|pctg|\bcpe\b/.test(t) || fam === 'petg') return 'PETG';
  if (/asa/.test(t)) return 'ASA';
  if (/abs/.test(t)) return 'ABS';
  if (/tpu|tpe|\btpc\b|flex|rubber/.test(t) || fam === 'tpu / tpe') return 'TPU';
  return 'Other';
}

/** Does filament `f` pass the Material dropdown value `sel`? */
export function materialMatches(sel: string, f: Filament): boolean {
  if (sel === 'Any') return true;
  const c = materialClass(f);
  if (sel === 'PLA (all)') return c === 'PLA basic' || c === 'PLA+ / Pro / Tough';
  return c === sel;
}

// ---------------------------------------------------------------------- merge the two sources

const normName = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Merge the measured (filamentcolors.xyz) and maker (SpoolmanDB) catalogs into one:
 *   - Brand names are folded onto a canonical key ({@link canonBrand}); the display name prefers the
 *     filamentcolors spelling when a brand exists in both, else a tidied SpoolmanDB name. Every swatch's `brand`
 *     is rewritten to that display name, so the brand filter / pinned defaults / saved selections keep working.
 *   - Cross-source dedupe: same canonical brand + same normalized color name + same material class -> keep the
 *     MEASURED swatch and drop the maker one.
 */
export function mergeCatalog(measured: Filament[], maker: Filament[]): Filament[] {
  // canonical brand key -> display name; filamentcolors wins when a brand is in both sources
  const display = new Map<string, string>();
  for (const f of measured) display.set(canonBrand(f.brand), f.brand);
  for (const f of maker) {
    const k = canonBrand(f.brand);
    if (!display.has(k)) display.set(k, tidyBrand(f.brand));
  }
  const withDisplay = (f: Filament): Filament => {
    const name = display.get(canonBrand(f.brand));
    return name && name !== f.brand ? { ...f, brand: name } : f;
  };
  const dedupeKey = (f: Filament) => `${canonBrand(f.brand)}|${normName(f.name)}|${materialClass(f)}`;

  const out: Filament[] = [];
  const taken = new Set<string>();
  for (const f of measured) {
    const d = withDisplay(f);
    out.push(d);
    taken.add(dedupeKey(d));
  }
  let merged = 0;
  for (const f of maker) {
    const d = withDisplay(f);
    const k = dedupeKey(d);
    if (taken.has(k)) {
      merged++;
      continue;
    }
    taken.add(k);
    out.push(d);
  }
  void merged;
  return out;
}

export interface Suggestion {
  filament: Filament;
  deltaE: number;
}

/**
 * Ranked suggestions for one target color: each brand's single closest swatch (CIEDE2000), brands ordered
 * by that distance, so position 0 is the overall closest filament. `material` is a Material-dropdown value
 * ({@link materialMatches}; 'Any' = no filter). Unavailable swatches are skipped.
 */
export function rankSuggestions(
  targetHex: string,
  filaments: { f: Filament; lab: Lab }[],
  material: string,
  brands: Set<string> | null = null,
  limit = 60,
): Suggestion[] {
  const target = hexToLab(targetHex);
  const bestByBrand = new Map<string, Suggestion>();
  for (const { f, lab } of filaments) {
    if (!f.available) continue;
    if (!materialMatches(material, f)) continue;
    if (brands && !brands.has(f.brand)) continue;
    const dE = deltaE2000(target, lab);
    const cur = bestByBrand.get(f.brand);
    if (!cur || dE < cur.deltaE) bestByBrand.set(f.brand, { filament: f, deltaE: dE });
  }
  return [...bestByBrand.values()].sort((a, b) => a.deltaE - b.deltaE).slice(0, limit);
}
