// Inside skin for paint depth: the solid within R mm of the part's inside surface (openness.ts labels, split
// triangles included), on both sides of the surface, and nearer to the inside surface than to the outside one.
// Subtracted from a part's shell it leaves the inside surfaces in filament 1 while every outside face keeps its
// full paint depth.
//
// Surface samples (every h/2) carry their triangle and barycentric position, so a threshold only relabels
// them. Two label-restricted wavefronts on a voxel grid give each cell its distance to the nearest inside sample
// (d_in) and to the nearest outside sample (d_out). The skin is the level set of
//   F = min(R − d_in, d_out − d_in)
// which is continuous across the inside/outside boundary (unlike a nearest-label Voronoi indicator), so the
// cut between the colors is a smooth sheet through the label boundary curve, not a voxel staircase.
import type { ManifoldToplevel, Manifold as ManifoldT } from 'manifold-3d';
import type { Mesh } from './types';

/** Voxel size (mm), coarsened for big parts so the grid stays under MAX_CELLS. */
const H = 1;
const MAX_CELLS = 6_000_000;

export interface NearField {
  h: number; x0: number; y0: number; z0: number; nx: number; ny: number; nz: number;
  /** How far (mm) the grid reaches beyond the part (skins up to this radius fit). */
  radius: number;
  /** Surface samples: position, triangle, barycentric weights of corners 1 and 2, containing cell. */
  sp: Float32Array; sTri: Int32Array; sU: Float32Array; sV: Float32Array; sCell: Int32Array;
}

const cache = new WeakMap<Mesh, NearField>();

/** Surface samples of `mesh` on a grid reaching at least `radius` mm beyond it (cached per mesh object). */
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

  // samples every h/2 on every triangle: rows parallel to its longest edge, h/2 apart, points h/2 apart along
  // each row (cost follows area + perimeter, so long slivers stay cheap)
  const nTri = t.length / 3;
  const step = h / 2;
  let cap = 1 << 16, ns = 0;
  let P = new Float32Array(cap * 3), T = new Int32Array(cap), U = new Float32Array(cap), W = new Float32Array(cap), C = new Int32Array(cap);
  const grow = () => {
    cap *= 2;
    const P2 = new Float32Array(cap * 3); P2.set(P); P = P2;
    const T2 = new Int32Array(cap); T2.set(T); T = T2;
    const U2 = new Float32Array(cap); U2.set(U); U = U2;
    const W2 = new Float32Array(cap); W2.set(W); W = W2;
    const C2 = new Int32Array(cap); C2.set(C); C = C2;
  };
  const bw = [0, 0, 0];
  for (let f = 0; f < nTri; f++) {
    const id = [t[f * 3] * 3, t[f * 3 + 1] * 3, t[f * 3 + 2] * 3];
    const len = (i: number, j: number) => Math.hypot(v[id[j]] - v[id[i]], v[id[j] + 1] - v[id[i] + 1], v[id[j] + 2] - v[id[i] + 2]);
    const l01 = len(0, 1), l12 = len(1, 2), l20 = len(2, 0);
    // corners (ia, ib) = longest edge, ic = apex
    const [ia, ib, ic] = l01 >= l12 && l01 >= l20 ? [0, 1, 2] : l12 >= l20 ? [1, 2, 0] : [2, 0, 1];
    const L = Math.max(l01, l12, l20);
    const A = id[ia], B = id[ib], Cc = id[ic];
    // apex height over the base
    const ex = v[B] - v[A], ey = v[B + 1] - v[A + 1], ez = v[B + 2] - v[A + 2];
    const cx = v[Cc] - v[A], cy = v[Cc + 1] - v[A + 1], cz = v[Cc + 2] - v[A + 2];
    const H = L > 0 ? Math.hypot(ey * cz - ez * cy, ez * cx - ex * cz, ex * cy - ey * cx) / L : 0;
    const rows = Math.max(1, Math.ceil(H / step));
    for (let j = 0; j < rows; j++) {
      const tau = (j + 0.5) / rows;
      const cols = Math.max(1, Math.ceil(((1 - tau) * L) / step));
      for (let i = 0; i < cols; i++) {
        const sg = (i + 0.5) / cols;
        bw[ia] = (1 - tau) * (1 - sg); bw[ib] = (1 - tau) * sg; bw[ic] = tau;
        const px = bw[0] * v[id[0]] + bw[1] * v[id[1]] + bw[2] * v[id[2]];
        const py = bw[0] * v[id[0] + 1] + bw[1] * v[id[1] + 1] + bw[2] * v[id[2] + 1];
        const pz = bw[0] * v[id[0] + 2] + bw[1] * v[id[1] + 2] + bw[2] * v[id[2] + 2];
        const ci = Math.floor((px - x0) / h), cj = Math.floor((py - y0) / h), ck = Math.floor((pz - z0) / h);
        if (ns === cap) grow();
        P[ns * 3] = px; P[ns * 3 + 1] = py; P[ns * 3 + 2] = pz; T[ns] = f; U[ns] = bw[1]; W[ns] = bw[2];
        C[ns] = (ck * ny + cj) * nx + ci;
        ns++;
      }
    }
  }
  return {
    h, x0, y0, z0, nx, ny, nz, radius,
    sp: P.slice(0, ns * 3), sTri: T.slice(0, ns), sU: U.slice(0, ns), sV: W.slice(0, ns), sCell: C.slice(0, ns),
  };
}

/**
 * Distance from each cell center to the nearest seed sample (`seed[s]` = 1), propagated by a label-correcting
 * wavefront over the 26-neighbourhood out to `limit` mm, only into cells where `allow` is finite (null = all).
 * Unreached cells stay Infinity.
 */
function wave(F: NearField, seed: Uint8Array, limit: number, allow: Float32Array | null): Float32Array {
  const { h, x0, y0, z0, nx, ny, nz, sp, sCell } = F;
  const n = nx * ny * nz, sxy = nx * ny;
  const dist = new Float32Array(n).fill(Infinity);
  const near = new Float32Array(n * 3);
  const queued = new Uint8Array(n);
  let queue = new Int32Array(1 << 16), qHead = 0, qLen = 0;
  const push = (i: number) => {
    if (qLen === queue.length) {
      const q2 = new Int32Array(queue.length * 2);
      for (let k = 0; k < qLen; k++) q2[k] = queue[(qHead + k) % queue.length];
      queue = q2; qHead = 0;
    }
    queue[(qHead + qLen) % queue.length] = i; qLen++;
  };
  for (let s = 0; s < seed.length; s++) {
    if (!seed[s]) continue;
    const idx = sCell[s];
    if (allow && !(allow[idx] < Infinity)) continue;
    const ck = Math.floor(idx / sxy), rem = idx - ck * sxy, cj = Math.floor(rem / nx), ci = rem - cj * nx;
    const px = sp[s * 3], py = sp[s * 3 + 1], pz = sp[s * 3 + 2];
    const ddx = x0 + (ci + 0.5) * h - px, ddy = y0 + (cj + 0.5) * h - py, ddz = z0 + (ck + 0.5) * h - pz;
    const d = Math.sqrt(ddx * ddx + ddy * ddy + ddz * ddz);
    if (d < dist[idx]) {
      dist[idx] = d; near[idx * 3] = px; near[idx * 3 + 1] = py; near[idx * 3 + 2] = pz;
      if (!queued[idx]) { queued[idx] = 1; push(idx); }
    }
  }
  while (qLen > 0) {
    const idx = queue[qHead]; qHead = (qHead + 1) % queue.length; qLen--;
    queued[idx] = 0;
    const ck = Math.floor(idx / sxy), rem = idx - ck * sxy, cj = Math.floor(rem / nx), ci = rem - cj * nx;
    const px = near[idx * 3], py = near[idx * 3 + 1], pz = near[idx * 3 + 2];
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
          if (allow && !(allow[u] < Infinity)) continue;
          const cx = x0 + (ii + 0.5) * h - px;
          const d = Math.sqrt(cx * cx + cy * cy + cz * cz);
          if (d > limit || d >= dist[u] - 1e-6) continue;
          dist[u] = d; near[u * 3] = px; near[u * 3 + 1] = py; near[u * 3 + 2] = pz;
          if (!queued[u]) { queued[u] = 1; push(u); }
        }
      }
    }
  }
  return dist;
}

/**
 * Solid of everything within `r` mm of the inside surface (`inside[s]` = 1 per surface sample) and nearer to it
 * than to the outside surface, as a manifold (caller deletes; null when empty). `r` must be ≤ the field's radius.
 */
export function insideSkin(wasm: ManifoldToplevel, field: NearField, inside: Uint8Array, r: number): ManifoldT | null {
  const { h, x0, y0, z0, nx, ny, nz } = field;
  const n = nx * ny * nz;
  const reach = r + 2 * h;
  const dIn = wave(field, inside, reach, null);
  const outside = Uint8Array.from(inside, (x) => 1 - x);
  // d_out matters only where d_in is in reach: the other cells are outside the skin whatever d_out is
  const dOut = wave(field, outside, reach, dIn);
  const F = new Float32Array(n);
  let i0 = nx, i1 = -1, j0 = ny, j1 = -1, k0 = nz, k1 = -1;
  for (let idx = 0; idx < n; idx++) {
    const di = dIn[idx];
    if (!(di < Infinity)) { F[idx] = -2 * h; continue; }
    const g = Math.max(dOut[idx] - di, -2 * h);
    const val = Math.min(r - di, g);
    F[idx] = val;
    if (val > 0) {
      const k = Math.floor(idx / (nx * ny)), rem = idx - k * nx * ny, j = Math.floor(rem / nx), i = rem - j * nx;
      if (i < i0) i0 = i; if (i > i1) i1 = i; if (j < j0) j0 = j; if (j > j1) j1 = j; if (k < k0) k0 = k; if (k > k1) k1 = k;
    }
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
