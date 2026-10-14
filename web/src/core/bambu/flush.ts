// Flush-volume (purge) calculator — a port of BambuStudio's FlushVolCalculator::calc_flush_vol_rgb
// (src/libslic3r/FlushVolCalc.cpp). Given the filament colors in AMS order it reproduces the
// `flush_volumes_matrix` that Bambu Studio 2.8 writes into a project's project_settings.config.
//
// C++ does this math in 32-bit float; a few results (e.g. black->white) land exactly on a .0 boundary
// that double precision just misses, so every step is rounded with Math.fround to match byte-for-byte.
// Verified against the CLI-exported matrix for the capture palette and a black/white/RGB palette
// (see scripts/capture-bambu-templates.py and scripts/validate-bambu.ts).
// The stored matrix is the base matrix with multiplier 1; Bambu applies `flush_multiplier` at slice time.

const fr = Math.fround;

/** '#RRGGBB' -> [r,g,b] 0..255. */
function hexToRgb(hex: string): [number, number, number] {
  const s = hex.replace('#', '');
  return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)];
}

/** sRGB (float32) -> HSV, h in degrees [0,360), s and v in [0,1]. Matches Bambu's RGB2HSV. */
function rgbToHsv(r: number, g: number, b: number): [number, number, number] {
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  const d = fr(mx - mn);
  const v = mx;
  const s = mx === 0 ? 0 : fr(d / mx);
  let h = 0;
  if (d !== 0) {
    if (mx === r) h = fr(60 * fr(fr((g - b) / d) % 6));
    else if (mx === g) h = fr(60 * fr(fr((b - r) / d) + 2));
    else h = fr(60 * fr(fr((r - g) / d) + 4));
  }
  if (h < 0) h = fr(h + 360);
  return [h, s, v];
}

function toRadians(deg: number): number {
  return fr((deg / 180) * Math.PI);
}

/** Bambu get_luminance: the weighted sum is formed in double, then stored as float. */
function luminance(r: number, g: number, b: number): number {
  return fr(r * 0.3 + g * 0.59 + b * 0.11);
}

/**
 * Color-based purge volume for a src->dst transition (no filament-id dataset / measured-purge
 * overrides, which the 2.8 CLI does not apply when building the default matrix).
 */
export function calcFlushVolRgb(src: string, dst: string): number {
  const srgb = hexToRgb(src).map((x) => fr(x / 255)) as [number, number, number];
  const drgb = hexToRgb(dst).map((x) => fr(x / 255)) as [number, number, number];
  const [sr, sg, sb] = srgb;
  const [dr, dg, db] = drgb;
  const [fh, fs, fv] = rgbToHsv(sr, sg, sb);
  const [th, ts, tv] = rgbToHsv(dr, dg, db);

  const dx = fr(fr(fr(Math.cos(toRadians(fh))) * fs * fv) - fr(fr(Math.cos(toRadians(th))) * ts * tv));
  const dy = fr(fr(fr(Math.sin(toRadians(fh))) * fs * fv) - fr(fr(Math.sin(toRadians(th))) * ts * tv));
  let hsDist = fr(Math.min(1.2, fr(Math.hypot(dx, dy))));

  const fromLumi = luminance(sr, sg, sb);
  const toLumi = luminance(dr, dg, db);
  let lumiFlush: number;
  if (toLumi >= fromLumi) {
    lumiFlush = fr(fr(Math.pow(fr(toLumi - fromLumi), 0.7)) * 560);
  } else {
    lumiFlush = fr(fr(fromLumi - toLumi) * 80);
    const interV = fr(0.67 * tv + 0.33 * fv);
    hsDist = fr(Math.min(interV, hsDist));
  }
  const hsFlush = fr(230 * hsDist);
  // law of cosines, 120 degrees between the hue/saturation and luminance contributions
  const cos120 = fr(Math.cos(toRadians(120)));
  const val = fr(Math.sqrt(fr(fr(hsFlush * hsFlush) + fr(lumiFlush * lumiFlush) - fr(fr(2 * hsFlush * lumiFlush) * cos120))));
  return fr(Math.max(val, 60));
}

/**
 * Row-major N x N flush matrix as strings: entry (i*N + j) = purge FROM filament i TO filament j.
 * Diagonal is 0; off-diagonal = floor(calcFlushVolRgb + min), clamped to max.
 */
export function flushMatrix(colors: string[], min = 110, max = 900): string[] {
  const n = colors.length;
  const out: string[] = new Array(n * n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (i === j) {
        out[i * n + j] = '0';
      } else {
        const v = Math.min(Math.floor(fr(calcFlushVolRgb(colors[i], colors[j]) + min)), max);
        out[i * n + j] = String(v);
      }
    }
  }
  return out;
}
