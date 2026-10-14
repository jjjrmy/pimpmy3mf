// Raster -> working-grid sampling and speckle removal.
// Ports img2color.py `disk`, `resample`, `despeckle` (scipy gaussian_filter / affine_transform /
// distance_transform_edt / binary_opening) to plain typed-array code.

const INF = 1e20;

// --------------------------------------------------------------------------------- gaussian blur
/** scipy-style 1D Gaussian kernel: radius = floor(truncate*sigma + 0.5), normalised. */
function gaussianKernel(sigma: number): Float64Array {
  const radius = Math.floor(4.0 * sigma + 0.5);
  const k = new Float64Array(2 * radius + 1);
  const s2 = sigma * sigma;
  let sum = 0;
  for (let i = -radius; i <= radius; i++) {
    const v = Math.exp((-0.5 / s2) * i * i);
    k[i + radius] = v; sum += v;
  }
  for (let i = 0; i < k.length; i++) k[i] /= sum;
  return k;
}

/** Separable Gaussian blur of a HxW Float32 image. wrap = periodic, else replicate edge. */
export function gaussianFilter2D(src: Float32Array, H: number, W: number, sigma: number, wrap: boolean): Float32Array {
  if (sigma <= 0) return src.slice();
  const k = gaussianKernel(sigma);
  const r = (k.length - 1) / 2;
  const tmp = new Float32Array(H * W);
  const out = new Float32Array(H * W);
  // horizontal pass
  for (let y = 0; y < H; y++) {
    const row = y * W;
    for (let x = 0; x < W; x++) {
      let acc = 0;
      for (let t = -r; t <= r; t++) {
        let xx = x + t;
        if (wrap) { xx = ((xx % W) + W) % W; } else { if (xx < 0) xx = 0; else if (xx >= W) xx = W - 1; }
        acc += src[row + xx] * k[t + r];
      }
      tmp[row + x] = acc;
    }
  }
  // vertical pass
  for (let x = 0; x < W; x++) {
    for (let y = 0; y < H; y++) {
      let acc = 0;
      for (let t = -r; t <= r; t++) {
        let yy = y + t;
        if (wrap) { yy = ((yy % H) + H) % H; } else { if (yy < 0) yy = 0; else if (yy >= H) yy = H - 1; }
        acc += tmp[yy * W + x];
      }
      out[y * W + x] = acc;
    }
  }
  return out;
}

// ------------------------------------------------------------------------------ affine resample
/**
 * Full 2x2 affine from grid (gx,gy) to source (row,col):
 *   row = arx*gx + ary*gy + r0 ;  col = acx*gx + acy*gy + c0.
 * A pure scale (no rotation/offset) is arx=acy=0, ary=sy, acx=sx, r0=row0, c0=col0 — which reduces to
 * the old diagonal mapping bit-for-bit (0*gx adds nothing, same add order).
 */
export interface Affine { arx: number; ary: number; r0: number; acx: number; acy: number; c0: number }

/**
 * Sample HxW source onto a ny x nx grid using a full affine. order 1 = bilinear, 0 = nearest.
 * wrap = periodic else clamp.
 */
function affineResample(
  src: Float32Array, H: number, W: number, A: Affine,
  ny: number, nx: number, order: 0 | 1, wrap: boolean,
): Float32Array {
  const out = new Float32Array(ny * nx);
  const cy = (v: number) => { if (wrap) return ((v % H) + H) % H; return v < 0 ? 0 : v >= H ? H - 1 : v; };
  const cx = (v: number) => { if (wrap) return ((v % W) + W) % W; return v < 0 ? 0 : v >= W ? W - 1 : v; };
  for (let gy = 0; gy < ny; gy++) {
    const rowBaseR = A.ary * gy + A.r0;
    const rowBaseC = A.acy * gy + A.c0;
    for (let gx = 0; gx < nx; gx++) {
      const iy = A.arx * gx + rowBaseR;
      const ix = A.acx * gx + rowBaseC;
      if (order === 0) {
        const yy = cy(Math.floor(iy + 0.5));
        const xx = cx(Math.floor(ix + 0.5));
        out[gy * nx + gx] = src[yy * W + xx];
      } else {
        const y0 = Math.floor(iy), x0 = Math.floor(ix);
        const fy = iy - y0, fx = ix - x0;
        const ya = cy(y0), yb = cy(y0 + 1), xa = cx(x0), xb = cx(x0 + 1);
        const v00 = src[ya * W + xa], v01 = src[ya * W + xb];
        const v10 = src[yb * W + xa], v11 = src[yb * W + xb];
        out[gy * nx + gx] = (1 - fy) * ((1 - fx) * v00 + fx * v01) + fy * ((1 - fx) * v10 + fx * v11);
      }
    }
  }
  return out;
}

/**
 * Sample the label map onto the ny x nx working grid. Each present label's one-hot mask (including
 * transparent = -1) is blurred (sigma, source px), interpolated at cell centres, and the winner
 * taken. sigma == 0 keeps hard pixel edges (nearest neighbour). Ports `resample`.
 */
export function resample(
  labels: Int32Array, H: number, W: number, ncolors: number,
  ny: number, nx: number, affine: Affine,
  sigma: number, wrap: boolean,
): Int32Array {
  const best = new Float32Array(ny * nx).fill(-Infinity);
  const out = new Int32Array(ny * nx).fill(-1);
  const mask = new Float32Array(H * W);
  for (let k = -1; k < ncolors; k++) {
    let present = false;
    for (let i = 0; i < H * W; i++) { const m = labels[i] === k ? 1 : 0; mask[i] = m; if (m) present = true; }
    if (!present) continue;
    const blurred = sigma > 0 ? gaussianFilter2D(mask, H, W, sigma, wrap) : mask;
    const val = affineResample(blurred, H, W, affine, ny, nx, sigma > 0 ? 1 : 0, wrap);
    for (let i = 0; i < ny * nx; i++) {
      if (val[i] > best[i]) { best[i] = val[i]; out[i] = k; }
    }
  }
  return out;
}

// ------------------------------------------------------------------- exact squared EDT (Felzenszwalb)
/** 1D squared distance transform of f (length n). Writes d (and optional argmin arg). */
function edt1d(f: Float64Array, n: number, d: Float64Array, arg: Int32Array | null): void {
  const v = new Int32Array(n);
  const z = new Float64Array(n + 1);
  let k = 0;
  v[0] = 0; z[0] = -INF; z[1] = INF;
  for (let q = 1; q < n; q++) {
    let s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) { k--; s = ((f[q] + q * q) - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]); }
    k++; v[k] = q; z[k] = s; z[k + 1] = INF;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    const p = v[k];
    d[q] = (q - p) * (q - p) + f[p];
    if (arg) arg[q] = p;
  }
}

/**
 * 2D squared EDT. `seed[i] != 0` marks seed cells. Returns distance^2 to nearest seed and, if
 * `withArg`, the (row,col) of that nearest seed per cell.
 */
export function edt2dSq(seed: Uint8Array, H: number, W: number, withArg: boolean): {
  dist: Float64Array; fy: Int32Array | null; fx: Int32Array | null;
} {
  const g = new Float64Array(H * W);
  const rowArg = withArg ? new Int32Array(H * W) : null;
  // vertical pass (per column)
  {
    const f = new Float64Array(H), d = new Float64Array(H), arg = withArg ? new Int32Array(H) : null;
    for (let x = 0; x < W; x++) {
      for (let y = 0; y < H; y++) f[y] = seed[y * W + x] ? 0 : INF;
      edt1d(f, H, d, arg);
      for (let y = 0; y < H; y++) { g[y * W + x] = d[y]; if (rowArg && arg) rowArg[y * W + x] = arg[y]; }
    }
  }
  const dist = new Float64Array(H * W);
  const fy = withArg ? new Int32Array(H * W) : null;
  const fx = withArg ? new Int32Array(H * W) : null;
  // horizontal pass (per row)
  {
    const f = new Float64Array(W), d = new Float64Array(W), arg = withArg ? new Int32Array(W) : null;
    for (let y = 0; y < H; y++) {
      const row = y * W;
      for (let x = 0; x < W; x++) f[x] = g[row + x];
      edt1d(f, W, d, arg);
      for (let x = 0; x < W; x++) {
        dist[row + x] = d[x];
        if (fy && fx && arg && rowArg) {
          const sx = arg[x];
          fx[row + x] = sx;
          fy[row + x] = rowArg[row + sx];
        }
      }
    }
  }
  return { dist, fy, fx };
}

// ------------------------------------------------------------------------------------- despeckle
/** disk(r) radius -> SE half-size and squared radius threshold (x²+y² <= r²+0.5r). */
function diskParams(radius: number): { r: number; r2: number } {
  const r = Math.max(1, Math.round(radius));
  return { r, r2: r * r + r * 0.5 };
}

function padLabels(grid: Int32Array, ny: number, nx: number, pad: number, wrap: boolean): { p: Int32Array; pw: number; ph: number } {
  const pw = nx + 2 * pad, ph = ny + 2 * pad;
  const p = new Int32Array(ph * pw);
  for (let y = 0; y < ph; y++) {
    let sy = y - pad;
    if (wrap) sy = ((sy % ny) + ny) % ny; else sy = sy < 0 ? 0 : sy >= ny ? ny - 1 : sy;
    for (let x = 0; x < pw; x++) {
      let sx = x - pad;
      if (wrap) sx = ((sx % nx) + nx) % nx; else sx = sx < 0 ? 0 : sx >= nx ? nx - 1 : sx;
      p[y * pw + x] = grid[sy * nx + sx];
    }
  }
  return { p, pw, ph };
}

/**
 * Remove features narrower than ~2*radius (a morphological opening per color). Removed cells take
 * the label of the nearest surviving cell (so the grid stays a full partition). Ports `despeckle`.
 */
export function despeckle(grid: Int32Array, ny: number, nx: number, radiusPx: number, wrap: boolean): Int32Array {
  if (radiusPx < 0.75) return grid;
  const { r, r2 } = diskParams(radiusPx);
  const pad = 2 * r + 1;
  const { p, pw, ph } = padLabels(grid, ny, nx, pad, wrap);
  const N = ph * pw;

  // unique labels in the original grid
  const uniq = new Set<number>();
  for (let i = 0; i < ny * nx; i++) uniq.add(grid[i]);

  const keepPadded = new Uint8Array(N);
  const maskComplement = new Uint8Array(N); // seeds = NOT this label (for erosion)
  const erodedSeed = new Uint8Array(N);      // seeds = eroded cells (for dilation)
  for (const k of uniq) {
    for (let i = 0; i < N; i++) maskComplement[i] = p[i] === k ? 0 : 1;
    const er = edt2dSq(maskComplement, ph, pw, false).dist; // dist^2 to nearest non-k
    let anyEroded = false;
    for (let i = 0; i < N; i++) { const e = er[i] > r2 ? 1 : 0; erodedSeed[i] = e; if (e) anyEroded = true; }
    if (!anyEroded) continue;
    const dl = edt2dSq(erodedSeed, ph, pw, false).dist; // dist^2 to nearest eroded cell
    for (let i = 0; i < N; i++) if (dl[i] <= r2) keepPadded[i] = 1;
  }

  // crop keep back to original grid
  const keep = new Uint8Array(ny * nx);
  let allKeep = true, anyKeep = false;
  for (let y = 0; y < ny; y++) {
    for (let x = 0; x < nx; x++) {
      const v = keepPadded[(y + pad) * pw + (x + pad)];
      keep[y * nx + x] = v;
      if (v) anyKeep = true; else allKeep = false;
    }
  }
  if (allKeep || !anyKeep) return grid;

  // fill removed cells with nearest kept cell's label (EDT argmin over ~keep)
  const notKeep = new Uint8Array(ny * nx);
  for (let i = 0; i < ny * nx; i++) notKeep[i] = keep[i] ? 1 : 0; // seeds = kept cells
  const { fy, fx } = edt2dSq(notKeep, ny, nx, true);
  const out = new Int32Array(ny * nx);
  for (let i = 0; i < ny * nx; i++) out[i] = grid[fy![i] * nx + fx![i]];
  return out;
}
