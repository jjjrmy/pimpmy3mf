// Inside skin for paint depth: the region within R mm of the part's inside-labelled triangles (openness.ts),
// on both sides of the surface, cut off where another (outside) triangle is nearer. Subtracted from a part's
// shell it leaves those faces in filament 1 while every outside face keeps its full paint depth.
//
// A voxel grid carries, per cell, the nearest surface point (dense samples on every triangle) found by a
// label-correcting wavefront over the 26-neighbourhood, limited to R + 2 cells. The nearest-point field does
// not depend on the labels, so moving the "what counts as inside" threshold only rebuilds the level set.
import type { ManifoldToplevel, Manifold as ManifoldT } from 'manifold-3d';
import type { Mesh } from './types';

/** Voxel size (mm), coarsened for big parts so the grid stays under MAX_CELLS. */
const H = 1;
const MAX_CELLS = 6_000_000;

export interface NearField {
  h: number; x0: number; y0: number; z0: number; nx: number; ny: number; nz: number;
  /** How far (mm) the field was propagated from the surface. */
  radius: number;
  /** Distance from each cell center to its nearest surface sample (Infinity = beyond radius). */
  dist: Float32Array;
  /** Triangle the nearest sample lies on (-1 = none). */
  tri: Int32Array;
}

const cache = new WeakMap<Mesh, NearField>();

/** Nearest-surface field of `mesh` out to at least `radius` mm (cached per mesh object). */
export function nearField(mesh: Mesh, radius: number): NearField {
  const hit = cache.get(mesh);
  if (hit && hit.radius >= radius) return hit;
  const f = buildNearField(mesh, Math.max(radius, hit?.radius ?? 0));
  cache.set(mesh, f);
  return f;
}

function buildNearField(mesh: Mesh, radius: number): NearField {
  const v = mesh.vertices, t = mesh.triangles;
  let mnx = Infinity, mny = Infinity, mnz = Infinity, mxx = -Infinity, mxy = -Infinity, mxz = -Infinity;
  for (let i = 0; i < v.length; i += 3) {
    if (v[i] < mnx) mnx = v[i]; if (v[i] > mxx) mxx = v[i];
    if (v[i + 1] < mny) mny = v[i + 1]; if (v[i + 1] > mxy) mxy = v[i + 1];
    if (v[i + 2] < mnz) mnz = v[i + 2]; if (v[i + 2] > mxz) mxz = v[i + 2];
  }
  let h = H;
  const dims = (s: number) => {
    const pad = Math.ceil(radius / s) + 3;
    return [Math.ceil((mxx - mnx) / s) + 2 * pad, Math.ceil((mxy - mny) / s) + 2 * pad, Math.ceil((mxz - mnz) / s) + 2 * pad, pad];
  };
  while (dims(h)[0] * dims(h)[1] * dims(h)[2] > MAX_CELLS) h *= 1.25;
  const [nx, ny, nz, pad] = dims(h);
  const x0 = mnx - pad * h, y0 = mny - pad * h, z0 = mnz - pad * h;
  const n = nx * ny * nz;
  const dist = new Float32Array(n).fill(Infinity);
  const tri = new Int32Array(n).fill(-1);
  const sp = new Float32Array(n * 3);
  const limit = radius + 2 * h;
  // ring buffer: a cell is queued at most once at a time, so n slots suffice
  const queue = new Int32Array(n);
  let qHead = 0, qLen = 0;
  const push = (i: number) => { queue[(qHead + qLen) % n] = i; qLen++; };
  const queued = new Uint8Array(n);
  const sxy = nx * ny;

  // seeds: sub-triangle centroids every h/2 on every triangle
  const nTri = t.length / 3;
  const step = h / 2;
  for (let f = 0; f < nTri; f++) {
    const a = t[f * 3] * 3, b = t[f * 3 + 1] * 3, c = t[f * 3 + 2] * 3;
    const ux = v[b] - v[a], uy = v[b + 1] - v[a + 1], uz = v[b + 2] - v[a + 2];
    const wx = v[c] - v[a], wy = v[c + 1] - v[a + 1], wz = v[c + 2] - v[a + 2];
    const edge = Math.max(Math.hypot(ux, uy, uz), Math.hypot(wx, wy, wz), Math.hypot(v[c] - v[b], v[c + 1] - v[b + 1], v[c + 2] - v[b + 2]));
    const k = Math.min(400, Math.max(1, Math.ceil(edge / step)));
    for (let i = 0; i < k; i++) for (let j = 0; j < k - i; j++) {
      for (let up = 0; up < (j < k - i - 1 ? 2 : 1); up++) {
        const bi = up ? (i + 2 / 3) / k : (i + 1 / 3) / k;
        const bj = up ? (j + 2 / 3) / k : (j + 1 / 3) / k;
        const px = v[a] + bi * ux + bj * wx, py = v[a + 1] + bi * uy + bj * wy, pz = v[a + 2] + bi * uz + bj * wz;
        const ci = Math.floor((px - x0) / h), cj = Math.floor((py - y0) / h), ck = Math.floor((pz - z0) / h);
        const idx = (ck * ny + cj) * nx + ci;
        const ddx = x0 + (ci + 0.5) * h - px, ddy = y0 + (cj + 0.5) * h - py, ddz = z0 + (ck + 0.5) * h - pz;
        const d = Math.sqrt(ddx * ddx + ddy * ddy + ddz * ddz);
        if (d < dist[idx]) {
          dist[idx] = d; tri[idx] = f; sp[idx * 3] = px; sp[idx * 3 + 1] = py; sp[idx * 3 + 2] = pz;
          if (!queued[idx]) { queued[idx] = 1; push(idx); }
        }
      }
    }
  }

  // wavefront: hand each cell's nearest point to its neighbours while it improves them
  while (qLen > 0) {
    const idx = queue[qHead]; qHead = (qHead + 1) % n; qLen--;
    queued[idx] = 0;
    const ck = Math.floor(idx / sxy), rem = idx - ck * sxy, cj = Math.floor(rem / nx), ci = rem - cj * nx;
    const px = sp[idx * 3], py = sp[idx * 3 + 1], pz = sp[idx * 3 + 2], f = tri[idx];
    for (let dk = -1; dk <= 1; dk++) {
      const kk = ck + dk; if (kk < 0 || kk >= nz) continue;
      const cz = z0 + (kk + 0.5) * h - pz;
      for (let dj = -1; dj <= 1; dj++) {
        const jj = cj + dj; if (jj < 0 || jj >= ny) continue;
        const cy = y0 + (jj + 0.5) * h - py;
        for (let di = -1; di <= 1; di++) {
          const ii = ci + di; if (ii < 0 || ii >= nx) continue;
          const u = (kk * ny + jj) * nx + ii;
          if (u === idx) continue;
          const cx = x0 + (ii + 0.5) * h - px;
          const d = Math.sqrt(cx * cx + cy * cy + cz * cz);
          if (d > limit || d >= dist[u] - 1e-6) continue;
          dist[u] = d; tri[u] = f; sp[u * 3] = px; sp[u * 3 + 1] = py; sp[u * 3 + 2] = pz;
          if (!queued[u]) { queued[u] = 1; push(u); }
        }
      }
    }
  }
  return { h, x0, y0, z0, nx, ny, nz, radius, dist, tri };
}

/**
 * Solid of everything within `r` mm of an inside-labelled triangle (`mask[tri] = 1`) and nearer to it than to
 * any outside triangle, as a manifold (caller deletes; null when empty). `r` must be ≤ the field's radius.
 */
export function insideSkin(wasm: ManifoldToplevel, field: NearField, mask: Uint8Array, r: number): ManifoldT | null {
  const { h, x0, y0, z0, nx, ny, nz, dist, tri } = field;
  const n = nx * ny * nz;
  const F = new Float32Array(n);
  let i0 = nx, i1 = -1, j0 = ny, j1 = -1, k0 = nz, k1 = -1;
  for (let idx = 0; idx < n; idx++) {
    const f = tri[idx];
    if (f < 0) { F[idx] = -h; continue; }
    const d = dist[idx];
    if (mask[f]) {
      F[idx] = r - d;
      if (d < r) {
        const k = Math.floor(idx / (nx * ny)), rem = idx - k * nx * ny, j = Math.floor(rem / nx), i = rem - j * nx;
        if (i < i0) i0 = i; if (i > i1) i1 = i; if (j < j0) j0 = j; if (j > j1) j1 = j; if (k < k0) k0 = k; if (k > k1) k1 = k;
      }
    } else F[idx] = -Math.max(r - d, 0.5 * h);
  }
  if (i1 < 0) return null;
  const sample = (p: [number, number, number] | number[]): number => {
    const fx = (p[0] - x0) / h - 0.5, fy = (p[1] - y0) / h - 0.5, fz = (p[2] - z0) / h - 0.5;
    const i = Math.floor(fx), j = Math.floor(fy), k = Math.floor(fz);
    if (i < 0 || j < 0 || k < 0 || i + 1 >= nx || j + 1 >= ny || k + 1 >= nz) return -h;
    const tx = fx - i, ty = fy - j, tz = fz - k;
    const b = (k * ny + j) * nx + i, sx = 1, sy = nx, sz = nx * ny;
    const c00 = F[b] * (1 - tx) + F[b + sx] * tx, c10 = F[b + sy] * (1 - tx) + F[b + sy + sx] * tx;
    const c01 = F[b + sz] * (1 - tx) + F[b + sz + sx] * tx, c11 = F[b + sz + sy] * (1 - tx) + F[b + sz + sy + sx] * tx;
    return (c00 * (1 - ty) + c10 * ty) * (1 - tz) + (c01 * (1 - ty) + c11 * ty) * tz;
  };
  const m = 2;
  const bounds = {
    min: [x0 + (i0 - m) * h, y0 + (j0 - m) * h, z0 + (k0 - m) * h] as [number, number, number],
    max: [x0 + (i1 + 1 + m) * h, y0 + (j1 + 1 + m) * h, z0 + (k1 + 1 + m) * h] as [number, number, number],
  };
  const skin = wasm.Manifold.levelSet(sample, bounds, h, 0);
  if (skin.isEmpty()) { skin.delete(); return null; }
  return skin;
}
