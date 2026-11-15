// Shaded swatch thumbnails for the built-in grip patterns, drawn from (approximate copies of) the core height
// functions on a small canvas.
import type { TexturePattern } from '../core/types';

export type BuiltinPattern = Exclude<TexturePattern, 'image'>;

const SQRT3_2 = Math.sqrt(3) / 2;
const smooth01 = (t: number) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

function hexOffset(x: number, y: number): [number, number] {
  const j = y / SQRT3_2, i = x - j / 2;
  const i0 = Math.floor(i), j0 = Math.floor(j);
  let bx = 0, by = 0, bd = Infinity;
  for (let di = 0; di <= 1; di++)
    for (let dj = 0; dj <= 1; dj++) {
      const ci = i0 + di, cj = j0 + dj;
      const dx = x - (ci + cj / 2), dy = y - cj * SQRT3_2;
      const d = dx * dx + dy * dy;
      if (d < bd) {
        bd = d;
        bx = dx;
        by = dy;
      }
    }
  return [bx, by];
}

/** Height in 0..1 at (x, y), in pitch units. */
const FIELDS: Record<BuiltinPattern, (x: number, y: number) => number> = {
  knurl: (x, y) => {
    const a = x + y, b = x - y;
    return 1 - 2 * Math.max(Math.abs(a - Math.round(a)), Math.abs(b - Math.round(b)));
  },
  ridges: (x) => 0.5 + 0.5 * Math.cos(2 * Math.PI * x),
  stipple: (x, y) => {
    const [dx, dy] = hexOffset(x, y);
    const r2 = (dx * dx + dy * dy) / (0.35 * 0.35);
    return r2 >= 1 ? 0 : Math.sqrt(1 - r2);
  },
  hex: (x, y) => {
    const [dx, dy] = hexOffset(x, y);
    const dh = Math.max(Math.abs(dx), Math.abs(dx * 0.5 + dy * SQRT3_2), Math.abs(-dx * 0.5 + dy * SQRT3_2));
    return smooth01((0.41 - dh) / 0.06);
  },
};

const cache = new Map<string, string>();

/** PNG data URL of a lit grayscale render of a built-in pattern (cached). */
export function builtinThumbUrl(pattern: BuiltinPattern, size = 96, periods = 4): string {
  const key = `${pattern}:${size}:${periods}`;
  const hit = cache.get(key);
  if (hit) return hit;
  if (typeof document === 'undefined') return '';
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return '';
  const f = FIELDS[pattern];
  const s = periods / size;
  const e = 0.5 * s;
  const img = ctx.createImageData(size, size);
  for (let py = 0; py < size; py++)
    for (let px = 0; px < size; px++) {
      const x = (px + 0.5) * s, y = (py + 0.5) * s;
      const h = f(x, y);
      // light from the upper left: brighter where the surface faces it
      const slope = (f(x - e, y - e) - f(x + e, y + e)) * 1.6;
      const v = Math.max(0, Math.min(1, 0.22 + 0.5 * h + slope));
      const p = (py * size + px) * 4;
      img.data[p] = Math.round(v * 236);
      img.data[p + 1] = Math.round(v * 240);
      img.data[p + 2] = Math.round(v * 244 + 8);
      img.data[p + 3] = 255;
    }
  ctx.putImageData(img, 0, 0);
  const url = canvas.toDataURL('image/png');
  cache.set(key, url);
  return url;
}
