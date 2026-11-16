// Openness: how much of the sky each triangle of a part can see, used to decide which surfaces are "inside"
// (bores, cavities, recessed mounting pockets) and print in filament 1 with a paint depth.
//
// Per surface sample (a triangle, or several on big triangles), cast K cosine-weighted rays around the outward
// normal through a voxel occupancy grid. A ray is BLOCKED only if its first hit on the part is at least R_MIN
// away; escapes and closer hits (local relief, grooves, self-hits on coarse meshes) count as open.
// openness = open / K, area-smoothed over SMOOTH_R mm among samples whose normals agree, per triangle.
// inside(f) = openness(f) < threshold, then islands under ISLAND_AREA mm² are flipped.
//
// Samples are bucketed by (grid cell × one of 42 normal directions): each bucket is ray-cast once.
// The score is cached per mesh object, so moving the threshold only re-runs the cheap labelling.
import type { Mesh } from './types';

/** Rays whose first hit is closer than this count as open (mm). */
const R_MIN = 3;
/** Smoothing radius (mm) and the normal agreement it needs. */
const SMOOTH_R = 1.5;
const SMOOTH_DOT = 0.3;
/** Connected inside / outside islands smaller than this (mm²) take their neighbours' label. */
const ISLAND_AREA = 20;
/** Triangles with an edge longer than this (mm) get several samples. */
const SAMPLE_EDGE = 3;
const MAX_SPLIT = 8;
/** Occupancy cells (1 mm, coarsened for big parts so the grid stays under this). */
const MAX_CELLS = 4_000_000;

export interface Openness {
  /** Smoothed openness per triangle, 0 (enclosed) .. 1 (open sky). */
  score: Float32Array;
  /** Triangle areas (mm²). */
  area: Float32Array;
  /** Edge adjacency, CSR: neighbours of t are adj[adjStart[t] .. adjStart[t + 1]). */
  adjStart: Uint32Array;
  adj: Uint32Array;
  /** Timings (ms) and sizes of the computation, for scripts. */
  stats: { ms: number; grid: number; voxel: number; samples: number; buckets: number; rays: number };
}

const cache = new WeakMap<Mesh, Openness>();

/** Openness of `mesh`, computed once per mesh object. */
export function meshOpenness(mesh: Mesh): Openness {
  let o = cache.get(mesh);
  if (!o) { o = computeOpenness(mesh); cache.set(mesh, o); }
  return o;
}

/** Whether a mesh's openness is already cached (so a progress stage can be skipped). */
export function hasOpenness(mesh: Mesh): boolean {
  return cache.has(mesh);
}

/** 42 unit directions: icosahedron vertices + edge midpoints. */
function normalClasses(): Float64Array {
  const p = (1 + Math.sqrt(5)) / 2;
  const v: number[][] = [
    [-1, p, 0], [1, p, 0], [-1, -p, 0], [1, -p, 0], [0, -1, p], [0, 1, p],
    [0, -1, -p], [0, 1, -p], [p, 0, -1], [p, 0, 1], [-p, 0, -1], [-p, 0, 1],
  ];
  const len = Math.hypot(1, p);
  const out: number[][] = v.map((a) => a.map((x) => x / len));
  const edge = 2 / len;
  for (let i = 0; i < 12; i++) for (let j = i + 1; j < 12; j++) {
    const d = Math.hypot(out[i][0] - out[j][0], out[i][1] - out[j][1], out[i][2] - out[j][2]);
    if (Math.abs(d - edge) < 1e-6) {
      const m = [out[i][0] + out[j][0], out[i][1] + out[j][1], out[i][2] + out[j][2]];
      const l = Math.hypot(m[0], m[1], m[2]);
      out.push(m.map((x) => x / l));
    }
  }
  return Float64Array.from(out.flat());
}
const CLASSES = normalClasses();

/** K cosine-weighted directions in a local frame (z = normal), Hammersley-stratified. */
function cosineDirs(k: number): Float64Array {
  const out = new Float64Array(k * 3);
  for (let i = 0; i < k; i++) {
    let bits = i, inv = 0, f = 0.5;
    while (bits) { if (bits & 1) inv += f; bits >>= 1; f /= 2; }
    const u = (i + 0.5) / k, r = Math.sqrt(u), ph = 2 * Math.PI * inv;
    out[i * 3] = r * Math.cos(ph); out[i * 3 + 1] = r * Math.sin(ph); out[i * 3 + 2] = Math.sqrt(Math.max(0, 1 - u));
  }
  return out;
}

/** Solid occupancy of `mesh` on a regular grid, filled per z column by crossing winding. */
export interface Occupancy {
  h: number; x0: number; y0: number; z0: number; nx: number; ny: number; nz: number;
  occ: Uint8Array;
}

export function occupancyGrid(mesh: Mesh, h0 = 1, pad = 2): Occupancy {
  const v = mesh.vertices, t = mesh.triangles;
  let mnx = Infinity, mny = Infinity, mnz = Infinity, mxx = -Infinity, mxy = -Infinity, mxz = -Infinity;
  for (let i = 0; i < v.length; i += 3) {
    if (v[i] < mnx) mnx = v[i]; if (v[i] > mxx) mxx = v[i];
    if (v[i + 1] < mny) mny = v[i + 1]; if (v[i + 1] > mxy) mxy = v[i + 1];
    if (v[i + 2] < mnz) mnz = v[i + 2]; if (v[i + 2] > mxz) mxz = v[i + 2];
  }
  let h = h0;
  const cells = (s: number) => (Math.ceil((mxx - mnx) / s) + 2 * pad) * (Math.ceil((mxy - mny) / s) + 2 * pad) * (Math.ceil((mxz - mnz) / s) + 2 * pad);
  while (cells(h) > MAX_CELLS) h *= 1.25;
  // a small irrational offset keeps column centers off vertices and edges
  const x0 = mnx - pad * h + 1e-3 * h * 0.6180339, y0 = mny - pad * h + 1e-3 * h * 0.4142135, z0 = mnz - pad * h;
  const nx = Math.ceil((mxx - mnx) / h) + 2 * pad, ny = Math.ceil((mxy - mny) / h) + 2 * pad, nz = Math.ceil((mxz - mnz) / h) + 2 * pad;
  const nTri = t.length / 3;
  // pass 1: count crossings per column; pass 2: store (z, sign)
  const count = new Uint32Array(nx * ny + 1);
  const visit = (store: Float64Array | null, sgn: Int8Array | null, fill: Uint32Array | null) => {
    for (let f = 0; f < nTri; f++) {
      const a = t[f * 3] * 3, b = t[f * 3 + 1] * 3, c = t[f * 3 + 2] * 3;
      const ax = v[a], ay = v[a + 1], bx = v[b], by = v[b + 1], cx = v[c], cy = v[c + 1];
      const area2 = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
      if (area2 === 0) continue;
      const i0 = Math.max(0, Math.ceil((Math.min(ax, bx, cx) - x0) / h - 0.5));
      const i1 = Math.min(nx - 1, Math.floor((Math.max(ax, bx, cx) - x0) / h - 0.5));
      const j0 = Math.max(0, Math.ceil((Math.min(ay, by, cy) - y0) / h - 0.5));
      const j1 = Math.min(ny - 1, Math.floor((Math.max(ay, by, cy) - y0) / h - 0.5));
      for (let j = j0; j <= j1; j++) {
        const py = y0 + (j + 0.5) * h;
        for (let i = i0; i <= i1; i++) {
          const px = x0 + (i + 0.5) * h;
          const w0 = ((bx - px) * (cy - py) - (by - py) * (cx - px)) / area2;
          const w1 = ((cx - px) * (ay - py) - (cy - py) * (ax - px)) / area2;
          const w2 = 1 - w0 - w1;
          if (w0 < 0 || w1 < 0 || w2 < 0) continue;
          const col = j * nx + i;
          if (!store) { count[col]++; continue; }
          const k = fill![col]++;
          store[k] = w0 * v[a + 2] + w1 * v[b + 2] + w2 * v[c + 2];
          // outward normal pointing down = the upward ray enters the solid here
          sgn![k] = area2 < 0 ? 1 : -1;
        }
      }
    }
  };
  visit(null, null, null);
  const start = new Uint32Array(nx * ny + 1);
  for (let c = 0; c < nx * ny; c++) start[c + 1] = start[c] + count[c];
  const zs = new Float64Array(start[nx * ny]);
  const sg = new Int8Array(start[nx * ny]);
  const fill = start.slice(0, nx * ny);
  visit(zs, sg, fill);
  const occ = new Uint8Array(nx * ny * nz);
  const order: number[] = [];
  for (let col = 0; col < nx * ny; col++) {
    const s = start[col], e = start[col + 1];
    if (e - s < 2) continue;
    order.length = 0;
    for (let k = s; k < e; k++) order.push(k);
    order.sort((p, q) => zs[p] - zs[q]);
    const base = col, sxy = nx * ny;
    let wind = 0;
    for (let n = 0; n + 1 < order.length; n++) {
      wind += sg[order[n]];
      if (wind <= 0) continue;
      // solid between this crossing and the next: fill the cells whose centers lie there
      const k0 = Math.max(0, Math.ceil((zs[order[n]] - z0) / h - 0.5));
      const k1 = Math.min(nz - 1, Math.floor((zs[order[n + 1]] - z0) / h - 0.5));
      for (let kz = k0; kz <= k1; kz++) occ[kz * sxy + base] = 1;
    }
  }
  return { h, x0, y0, z0, nx, ny, nz, occ };
}

/** First distance (from the ray origin) at which the ray enters a solid cell, after leaving the solid it
 *  starts in; Infinity when it escapes the grid. 3D-DDA. */
function march(g: Occupancy, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxT: number): number {
  const { h, nx, ny, nz, occ } = g;
  const fx = (ox - g.x0) / h, fy = (oy - g.y0) / h, fz = (oz - g.z0) / h;
  let ix = Math.floor(fx), iy = Math.floor(fy), iz = Math.floor(fz);
  if (ix < 0 || iy < 0 || iz < 0 || ix >= nx || iy >= ny || iz >= nz) return Infinity;
  const sx = dx > 0 ? 1 : -1, sy = dy > 0 ? 1 : -1, sz = dz > 0 ? 1 : -1;
  const tdx = dx !== 0 ? h / Math.abs(dx) : Infinity, tdy = dy !== 0 ? h / Math.abs(dy) : Infinity, tdz = dz !== 0 ? h / Math.abs(dz) : Infinity;
  let tmx = dx !== 0 ? ((dx > 0 ? ix + 1 - fx : fx - ix) * h) / Math.abs(dx) : Infinity;
  let tmy = dy !== 0 ? ((dy > 0 ? iy + 1 - fy : fy - iy) * h) / Math.abs(dy) : Infinity;
  let tmz = dz !== 0 ? ((dz > 0 ? iz + 1 - fz : fz - iz) * h) / Math.abs(dz) : Infinity;
  let left = occ[(iz * ny + iy) * nx + ix] === 0;
  const sxy = nx * ny;
  let idx = (iz * ny + iy) * nx + ix;
  for (;;) {
    let t: number;
    if (tmx < tmy && tmx < tmz) {
      ix += sx; if (ix < 0 || ix >= nx) return Infinity; idx += sx; t = tmx; tmx += tdx;
    } else if (tmy < tmz) {
      iy += sy; if (iy < 0 || iy >= ny) return Infinity; idx += sy * nx; t = tmy; tmy += tdy;
    } else {
      iz += sz; if (iz < 0 || iz >= nz) return Infinity; idx += sz * sxy; t = tmz; tmz += tdz;
    }
    if (occ[idx]) { if (left) return t; }
    else left = true;
    if (t > maxT) return Infinity;
  }
}

/** Per-triangle area-smoothed openness of a part mesh (see the file header). */
export function computeOpenness(mesh: Mesh, opts?: { rays?: number; h?: number }): Openness {
  const t0 = performance.now();
  const v = mesh.vertices, t = mesh.triangles;
  const nTri = t.length / 3;
  const K = opts?.rays ?? (nTri > 200_000 ? 32 : 64);
  const g = occupancyGrid(mesh, opts?.h ?? 1);
  const tGrid = performance.now() - t0;
  const h = g.h;

  // samples: k² sub-triangle centroids per triangle, bucketed by (cell, normal class)
  const area = new Float32Array(nTri);
  const triNormal = new Float32Array(nTri * 3);
  const sampTri: number[] = [], sampBucket: number[] = [], sampArea: number[] = [];
  const bucketOf = new Map<number, number>();
  const bx: number[] = [], by: number[] = [], bz: number[] = [], bnx: number[] = [], bny: number[] = [], bnz: number[] = [];
  const bArea: number[] = [], bCx: number[] = [], bCy: number[] = [], bCz: number[] = [];
  for (let f = 0; f < nTri; f++) {
    const a = t[f * 3] * 3, b = t[f * 3 + 1] * 3, c = t[f * 3 + 2] * 3;
    const ux = v[b] - v[a], uy = v[b + 1] - v[a + 1], uz = v[b + 2] - v[a + 2];
    const wx = v[c] - v[a], wy = v[c + 1] - v[a + 1], wz = v[c + 2] - v[a + 2];
    let nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
    const l = Math.hypot(nx, ny, nz);
    area[f] = l / 2;
    if (l === 0) continue;
    nx /= l; ny /= l; nz /= l;
    triNormal[f * 3] = nx; triNormal[f * 3 + 1] = ny; triNormal[f * 3 + 2] = nz;
    let cls = 0, best = -2;
    for (let q = 0; q < 42; q++) {
      const d = nx * CLASSES[q * 3] + ny * CLASSES[q * 3 + 1] + nz * CLASSES[q * 3 + 2];
      if (d > best) { best = d; cls = q; }
    }
    const vx = v[c] - v[b], vy = v[c + 1] - v[b + 1], vz = v[c + 2] - v[b + 2];
    const edge = Math.max(Math.hypot(ux, uy, uz), Math.hypot(wx, wy, wz), Math.hypot(vx, vy, vz));
    const k = Math.min(MAX_SPLIT, Math.max(1, Math.ceil(edge / SAMPLE_EDGE)));
    const sa = area[f] / (k * k);
    // sub-triangles of the k×k barycentric grid: up (i, j) and down ones
    for (let i = 0; i < k; i++) for (let j = 0; j < k - i; j++) {
      for (let up = 0; up < (j < k - i - 1 ? 2 : 1); up++) {
        const bi = up ? (i + 2 / 3) / k : (i + 1 / 3) / k;
        const bj = up ? (j + 2 / 3) / k : (j + 1 / 3) / k;
        const px = v[a] + bi * ux + bj * wx, py = v[a + 1] + bi * uy + bj * wy, pz = v[a + 2] + bi * uz + bj * wz;
        const ci = Math.floor((px - g.x0) / h), cj = Math.floor((py - g.y0) / h), ck = Math.floor((pz - g.z0) / h);
        const key = ((ck * g.ny + cj) * g.nx + ci) * 42 + cls;
        let bk = bucketOf.get(key);
        if (bk === undefined) {
          bk = bx.length; bucketOf.set(key, bk);
          bx.push(px); by.push(py); bz.push(pz); bnx.push(nx); bny.push(ny); bnz.push(nz);
          bArea.push(0); bCx.push(0); bCy.push(0); bCz.push(0);
        }
        bArea[bk] += sa; bCx[bk] += px * sa; bCy[bk] += py * sa; bCz[bk] += pz * sa;
        sampTri.push(f); sampBucket.push(bk); sampArea.push(sa);
      }
    }
  }
  const nB = bx.length;

  // ray-cast each bucket once, from its first sample, lifted half a cell off the surface
  const dirs = cosineDirs(K);
  const raw = new Float32Array(nB);
  const maxT = Math.hypot(g.nx, g.ny, g.nz) * h;
  for (let q = 0; q < nB; q++) {
    const nx = bnx[q], ny = bny[q], nz = bnz[q];
    // tangent frame, rotated per bucket so neighbours don't share one ray pattern
    let ex: number, ey: number, ez: number;
    if (Math.abs(nx) < 0.9) { ex = 0; ey = nz; ez = -ny; } else { ex = -nz; ey = 0; ez = nx; }
    const el = Math.hypot(ex, ey, ez); ex /= el; ey /= el; ez /= el;
    let fx = ny * ez - nz * ey, fy = nz * ex - nx * ez, fz = nx * ey - ny * ex;
    const rot = ((q * 2654435761) >>> 0) / 4294967296 * 2 * Math.PI, cr = Math.cos(rot), sr = Math.sin(rot);
    const e2x = cr * ex + sr * fx, e2y = cr * ey + sr * fy, e2z = cr * ez + sr * fz;
    fx = -sr * ex + cr * fx; fy = -sr * ey + cr * fy; fz = -sr * ez + cr * fz;
    ex = e2x; ey = e2y; ez = e2z;
    const ox = bx[q] + 0.5 * h * nx, oy = by[q] + 0.5 * h * ny, oz = bz[q] + 0.5 * h * nz;
    let open = 0;
    for (let r = 0; r < K; r++) {
      const lx = dirs[r * 3], ly = dirs[r * 3 + 1], lz = dirs[r * 3 + 2];
      const dx = lx * ex + ly * fx + lz * nx, dy = lx * ey + ly * fy + lz * ny, dz = lx * ez + ly * fz + lz * nz;
      const d = march(g, ox, oy, oz, dx, dy, dz, maxT);
      if (d === Infinity || d + 0.5 * h < R_MIN) open++;
    }
    raw[q] = open / K;
  }
  const tRay = performance.now() - t0 - tGrid;

  // smooth over buckets: area-weighted mean within SMOOTH_R among agreeing normals
  for (let q = 0; q < nB; q++) { bCx[q] /= bArea[q] || 1; bCy[q] /= bArea[q] || 1; bCz[q] /= bArea[q] || 1; }
  const cs = SMOOTH_R;
  const hash = new Map<number, number[]>();
  const hk = (i: number, j: number, k: number) => (i * 73856093) ^ (j * 19349663) ^ (k * 83492791);
  for (let q = 0; q < nB; q++) {
    const key = hk(Math.floor(bCx[q] / cs), Math.floor(bCy[q] / cs), Math.floor(bCz[q] / cs));
    const l = hash.get(key);
    if (l) l.push(q); else hash.set(key, [q]);
  }
  const smooth = new Float32Array(nB);
  const r2 = SMOOTH_R * SMOOTH_R;
  for (let q = 0; q < nB; q++) {
    const ci = Math.floor(bCx[q] / cs), cj = Math.floor(bCy[q] / cs), ck = Math.floor(bCz[q] / cs);
    let sw = 0, s = 0;
    for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) for (let dk = -1; dk <= 1; dk++) {
      const l = hash.get(hk(ci + di, cj + dj, ck + dk));
      if (!l) continue;
      for (const p of l) {
        const ddx = bCx[p] - bCx[q], ddy = bCy[p] - bCy[q], ddz = bCz[p] - bCz[q];
        if (ddx * ddx + ddy * ddy + ddz * ddz > r2) continue;
        if (bnx[p] * bnx[q] + bny[p] * bny[q] + bnz[p] * bnz[q] <= SMOOTH_DOT) continue;
        sw += bArea[p]; s += bArea[p] * raw[p];
      }
    }
    smooth[q] = sw > 0 ? s / sw : raw[q];
  }

  // per triangle: area-weighted mean of its samples' buckets
  const score = new Float32Array(nTri).fill(1);
  const wsum = new Float32Array(nTri);
  const acc = new Float32Array(nTri);
  for (let s = 0; s < sampTri.length; s++) {
    const f = sampTri[s];
    acc[f] += sampArea[s] * smooth[sampBucket[s]]; wsum[f] += sampArea[s];
  }
  for (let f = 0; f < nTri; f++) if (wsum[f] > 0) score[f] = acc[f] / wsum[f];

  const { adjStart, adj } = triAdjacency(mesh);
  const ms = performance.now() - t0;
  return {
    score, area, adjStart, adj,
    stats: { ms, grid: tGrid, voxel: h, samples: sampTri.length, buckets: nB, rays: tRay },
  };
}

/** Triangle edge adjacency over welded vertex positions (unwelded soup still connects). */
function triAdjacency(mesh: Mesh): { adjStart: Uint32Array; adj: Uint32Array } {
  const v = mesh.vertices, t = mesh.triangles;
  const nTri = t.length / 3;
  const weld = new Map<string, number>();
  const id = new Uint32Array(v.length / 3);
  for (let i = 0; i < id.length; i++) {
    const key = `${Math.round(v[i * 3] * 1e4)},${Math.round(v[i * 3 + 1] * 1e4)},${Math.round(v[i * 3 + 2] * 1e4)}`;
    let w = weld.get(key);
    if (w === undefined) { w = weld.size; weld.set(key, w); }
    id[i] = w;
  }
  const nv = weld.size;
  const edges = new Map<number, number[]>();
  for (let f = 0; f < nTri; f++) {
    for (let e = 0; e < 3; e++) {
      const a = id[t[f * 3 + e]], b = id[t[f * 3 + ((e + 1) % 3)]];
      if (a === b) continue;
      const key = a < b ? a * nv + b : b * nv + a;
      const l = edges.get(key);
      if (l) l.push(f); else edges.set(key, [f]);
    }
  }
  const deg = new Uint32Array(nTri + 1);
  for (const l of edges.values()) if (l.length > 1) for (const f of l) deg[f] += l.length - 1;
  const adjStart = new Uint32Array(nTri + 1);
  for (let f = 0; f < nTri; f++) adjStart[f + 1] = adjStart[f] + deg[f];
  const adj = new Uint32Array(adjStart[nTri]);
  const fill = adjStart.slice(0, nTri);
  for (const l of edges.values()) {
    if (l.length < 2) continue;
    for (const f of l) for (const g of l) if (g !== f) adj[fill[f]++] = g;
  }
  return { adjStart, adj };
}

/** Flip connected components of `label === which` smaller than `minArea` that border the other label. */
function flipIslands(o: Openness, label: Uint8Array, which: number, minArea: number): void {
  const n = label.length;
  const seen = new Uint8Array(n);
  const stack: number[] = [];
  const comp: number[] = [];
  for (let s = 0; s < n; s++) {
    if (seen[s] || label[s] !== which) continue;
    comp.length = 0; stack.length = 0;
    stack.push(s); seen[s] = 1;
    let a = 0, borders = false;
    while (stack.length) {
      const f = stack.pop()!;
      comp.push(f); a += o.area[f];
      for (let k = o.adjStart[f]; k < o.adjStart[f + 1]; k++) {
        const g = o.adj[k];
        if (label[g] !== which) { borders = true; continue; }
        if (!seen[g]) { seen[g] = 1; stack.push(g); }
      }
    }
    if (borders && a < minArea) for (const f of comp) label[f] = 1 - which;
  }
}

/** Inside mask (1 = inside) of the scored triangles at `threshold`, small islands flipped. */
export function insideMask(o: Openness, threshold: number): Uint8Array {
  const n = o.score.length;
  const label = new Uint8Array(n);
  for (let f = 0; f < n; f++) label[f] = o.score[f] < threshold ? 1 : 0;
  flipIslands(o, label, 1, ISLAND_AREA);
  flipIslands(o, label, 0, ISLAND_AREA);
  return label;
}

/** Inside fraction of the surface area for a mask. */
export function insideAreaFraction(o: Openness, mask: Uint8Array): number {
  let a = 0, s = 0;
  for (let f = 0; f < mask.length; f++) { s += o.area[f]; if (mask[f]) a += o.area[f]; }
  return s > 0 ? a / s : 0;
}
