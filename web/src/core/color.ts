// Color quantisation: sRGB -> CIELAB, k-means++ (seeded) or palette snapping.
// Ports img2color.py `srgb_to_lab`, `nearest`, `kmeans`, `parse_hex`, `to_hex`, `quantize`.
import type { RGB, RasterImage } from './types';

export interface QuantizeResult {
  /** HxW label map, -1 = transparent, 0..k-1 = color index (ordered most-common-first). */
  labels: Int32Array;
  /** Mean RGB (0..255) per color, in label order. */
  colors: RGB[];
  warnings: string[];
}

// -------------------------------------------------------------------- seeded PRNG (mulberry32)
// Deterministic across runs; NOT numpy-bit-identical (not required — results only need to match
// the CLI closely, and k-means on photo colours converges to the same clusters regardless of seed).
export function makeRng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    random: next,
    /** integer in [0, n) */
    int: (n: number) => Math.min(n - 1, Math.floor(next() * n)),
    /** k distinct indices in [0, n) via partial Fisher-Yates */
    sample: (n: number, k: number): Int32Array => {
      const idx = new Int32Array(n);
      for (let i = 0; i < n; i++) idx[i] = i;
      const m = Math.min(k, n);
      for (let i = 0; i < m; i++) {
        const j = i + Math.min(n - 1 - i, Math.floor(next() * (n - i)));
        const tmp = idx[i]; idx[i] = idx[j]; idx[j] = tmp;
      }
      return idx.subarray(0, m);
    },
  };
}
type Rng = ReturnType<typeof makeRng>;

// --------------------------------------------------------------------------------------- color
/** sRGB (0..1) triple -> CIELAB (D65). */
function srgbToLab(r: number, g: number, b: number): [number, number, number] {
  const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  const R = lin(r), G = lin(g), B = lin(b);
  // XYZ (D65) normalised by the white point
  let x = (0.4124564 * R + 0.3575761 * G + 0.1804375 * B) / 0.95047;
  let y = (0.2126729 * R + 0.7151522 * G + 0.0721750 * B) / 1.0;
  let z = (0.0193339 * R + 0.1191920 * G + 0.9503041 * B) / 1.08883;
  const d = 6 / 29, d3 = d * d * d;
  const f = (t: number) => (t > d3 ? Math.cbrt(t) : t / (3 * d * d) + 4 / 29);
  x = f(x); y = f(y); z = f(z);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}

export function parseHex(s: string): RGB {
  let h = s.trim().replace(/^#/, '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  if (!/^[0-9a-fA-F]{6}$/.test(h)) throw new Error(`bad hex color: "${s}" (use RRGGBB or #RRGGBB)`);
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

export function toHex(rgb: RGB): string {
  return '#' + rgb.map((v) => Math.round(v).toString(16).padStart(2, '0').toUpperCase()).join('');
}

/** For each row of `x` (n x 3), index of the nearest of `centers` (k x 3) by squared L2. */
function nearest(x: Float64Array, n: number, centers: Float64Array, k: number, out: Int32Array): void {
  for (let i = 0; i < n; i++) {
    const x0 = x[i * 3], x1 = x[i * 3 + 1], x2 = x[i * 3 + 2];
    let bi = 0, bd = Infinity;
    for (let c = 0; c < k; c++) {
      const d0 = x0 - centers[c * 3], d1 = x1 - centers[c * 3 + 1], d2 = x2 - centers[c * 3 + 2];
      const d = d0 * d0 + d1 * d1 + d2 * d2;
      if (d < bd) { bd = d; bi = c; }
    }
    out[i] = bi;
  }
}

/** Plain k-means with k-means++ seeding; best of a few restarts (lowest inertia). */
function kmeans(x: Float64Array, n: number, k: number, rng: Rng, restarts = 4, iters = 50): Float64Array {
  let best: Float64Array | null = null;
  let bestInertia = Infinity;
  const lab = new Int32Array(n);
  const d2 = new Float64Array(n);
  for (let r = 0; r < restarts; r++) {
    const c = new Float64Array(k * 3);
    // k-means++ seeding
    let first = rng.int(n);
    c[0] = x[first * 3]; c[1] = x[first * 3 + 1]; c[2] = x[first * 3 + 2];
    for (let i = 0; i < n; i++) {
      const a = x[i * 3] - c[0], b = x[i * 3 + 1] - c[1], e = x[i * 3 + 2] - c[2];
      d2[i] = a * a + b * b + e * e;
    }
    let placed = 1;
    for (let j = 1; j < k; j++) {
      let sum = 0;
      for (let i = 0; i < n; i++) sum += d2[i];
      if (sum <= 0) break;
      // weighted pick
      let target = rng.random() * sum, acc = 0, pick = n - 1;
      for (let i = 0; i < n; i++) { acc += d2[i]; if (acc >= target) { pick = i; break; } }
      c[j * 3] = x[pick * 3]; c[j * 3 + 1] = x[pick * 3 + 1]; c[j * 3 + 2] = x[pick * 3 + 2];
      for (let i = 0; i < n; i++) {
        const a = x[i * 3] - c[j * 3], b = x[i * 3 + 1] - c[j * 3 + 1], e = x[i * 3 + 2] - c[j * 3 + 2];
        const dd = a * a + b * b + e * e;
        if (dd < d2[i]) d2[i] = dd;
      }
      placed++;
    }
    // Lloyd iterations
    const sums = new Float64Array(k * 3);
    const cnt = new Float64Array(k);
    for (let it = 0; it < iters; it++) {
      nearest(x, n, c, placed, lab);
      sums.fill(0); cnt.fill(0);
      for (let i = 0; i < n; i++) {
        const l = lab[i];
        sums[l * 3] += x[i * 3]; sums[l * 3 + 1] += x[i * 3 + 1]; sums[l * 3 + 2] += x[i * 3 + 2];
        cnt[l]++;
      }
      let maxChange = 0;
      for (let c0 = 0; c0 < placed; c0++) {
        if (cnt[c0] === 0) continue; // empty cluster keeps its center
        for (let t = 0; t < 3; t++) {
          const nc = sums[c0 * 3 + t] / cnt[c0];
          maxChange = Math.max(maxChange, Math.abs(nc - c[c0 * 3 + t]));
          c[c0 * 3 + t] = nc;
        }
      }
      if (maxChange < 1e-3) break;
    }
    nearest(x, n, c, placed, lab);
    let inertia = 0;
    for (let i = 0; i < n; i++) {
      const a = x[i * 3] - c[lab[i] * 3], b = x[i * 3 + 1] - c[lab[i] * 3 + 1], e = x[i * 3 + 2] - c[lab[i] * 3 + 2];
      inertia += a * a + b * b + e * e;
    }
    // return the k we actually placed by trimming (rare: fewer than k when duplicate colours)
    if (inertia < bestInertia) { bestInertia = inertia; best = c.slice(0, placed * 3); }
  }
  return best!;
}

/** Returns labels (HxW, -1 = transparent) + the ordered color list. Ports `quantize`. */
export function quantize(img: RasterImage, ncolors: number, palette: RGB[] | null): QuantizeResult {
  const { width: W, height: H, data } = img;
  const npx = W * H;
  const warnings: string[] = [];
  // opaque pixels + their Lab
  const opaqueIdx = new Int32Array(npx);
  let nop = 0;
  for (let i = 0; i < npx; i++) if (data[i * 4 + 3] >= 128) opaqueIdx[nop++] = i;
  if (nop === 0) throw new Error('image is fully transparent');
  const opq = opaqueIdx.subarray(0, nop);
  const lab = new Float64Array(nop * 3);
  for (let i = 0; i < nop; i++) {
    const p = opq[i] * 4;
    const l = srgbToLab(data[p] / 255, data[p + 1] / 255, data[p + 2] / 255);
    lab[i * 3] = l[0]; lab[i * 3 + 1] = l[1]; lab[i * 3 + 2] = l[2];
  }

  const idx = new Int32Array(nop);
  let order: number[];
  let colors: RGB[];

  if (palette && palette.length > 0) {
    const pc = new Float64Array(palette.length * 3);
    for (let i = 0; i < palette.length; i++) {
      const l = srgbToLab(palette[i][0] / 255, palette[i][1] / 255, palette[i][2] / 255);
      pc[i * 3] = l[0]; pc[i * 3 + 1] = l[1]; pc[i * 3 + 2] = l[2];
    }
    nearest(lab, nop, pc, palette.length, idx);
    order = palette.map((_, i) => i); // keep the user's AMS slot order
    colors = palette.map((c) => [c[0], c[1], c[2]] as RGB);
  } else {
    const rng = makeRng(0);
    // sample <= 150k Lab points
    let sN = nop;
    let sLab = lab;
    if (nop > 150000) {
      const pick = rng.sample(nop, 150000);
      sN = 150000;
      sLab = new Float64Array(sN * 3);
      for (let i = 0; i < sN; i++) {
        const j = pick[i];
        sLab[i * 3] = lab[j * 3]; sLab[i * 3 + 1] = lab[j * 3 + 1]; sLab[i * 3 + 2] = lab[j * 3 + 2];
      }
    }
    // distinct colours (Lab rounded to 0.1) -> cap k
    const seen = new Set<number>();
    for (let i = 0; i < sN; i++) {
      const a = Math.round(sLab[i * 3] * 10);
      const b = Math.round(sLab[i * 3 + 1] * 10);
      const c = Math.round(sLab[i * 3 + 2] * 10);
      // pack 3 small ints into one number (ranges fit comfortably for Lab*10)
      seen.add(((a + 2000) * 8000 + (b + 2000)) * 8000 + (c + 2000));
    }
    const k = Math.min(ncolors, seen.size);
    if (k < ncolors) warnings.push(`This image only has ${k} distinct color${k === 1 ? '' : 's'}, so it uses ${k} instead of ${ncolors}.`);
    const centers = kmeans(sLab, sN, k, rng);
    const kActual = centers.length / 3;
    nearest(lab, nop, centers, kActual, idx);
    const counts = new Int32Array(kActual);
    for (let i = 0; i < nop; i++) counts[idx[i]]++;
    order = Array.from({ length: kActual }, (_, i) => i)
      .filter((i) => counts[i] > 0)
      .sort((a, b) => counts[b] - counts[a]); // most common first
    // mean RGB per cluster (fall back to center colour via lab if empty — shouldn't happen for ordered)
    const sumR = new Float64Array(kActual), sumG = new Float64Array(kActual), sumB = new Float64Array(kActual);
    for (let i = 0; i < nop; i++) {
      const l = idx[i], p = opq[i] * 4;
      sumR[l] += data[p]; sumG[l] += data[p + 1]; sumB[l] += data[p + 2];
    }
    colors = [];
    for (let i = 0; i < kActual; i++) {
      colors.push(counts[i] ? [sumR[i] / counts[i], sumG[i] / counts[i], sumB[i] / counts[i]] : [0, 0, 0]);
    }
  }

  // remap cluster index -> output order
  const remap = new Int32Array(colors.length).fill(-1);
  for (let i = 0; i < order.length; i++) remap[order[i]] = i;
  const labels = new Int32Array(npx).fill(-1);
  for (let i = 0; i < nop; i++) labels[opq[i]] = remap[idx[i]];

  return { labels, colors: order.map((i) => colors[i]), warnings };
}
