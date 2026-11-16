// Face textures: real surface relief (knurl, stipple, ridges, honeycomb, custom height map) displaced into a part's
// mesh. Runs in AS-LOADED space, before re-orientation. Per texture: weld, refine the selected region watertight
// (edges split in both neighbours, so no T-junctions), then move vertices along the region's smoothed normal by a
// periodic height field in a local (u, v) parameterization in mm along the surface: planar for flat regions, else an
// arc-length cylinder or a conformal unwrap of the coarse patch (unwrap.ts), so the pitch holds all the way around.
// Topology never changes after refinement and the region boundary never moves, so the part stays a closed manifold.
import type { ManifoldToplevel } from 'manifold-3d';
import type { FaceTexture, Mesh, Model, TextureMapping, TexturePattern } from './types';
import { cross, dot, norm, solvePatch, type PatchUV, type V3 } from './unwrap';

/** Projected triangle budget for the whole model (all parts) after texturing. */
export const MAX_TEXTURE_TRIS = 600_000;
/** Hard stop while refining (the estimate can undershoot on long thin triangles). */
const HARD_TRIS = 1_500_000;
/** Target edge length L = pitch / DIV. Finer for patterns with thin features (hex walls, image pixels). */
const DIV: Record<TexturePattern, number> = { knurl: 6, ridges: 6, stipple: 6, hex: 8, image: 12 };
const MIN_EDGE = 0.1;
const SQRT3_2 = Math.sqrt(3) / 2;

/** Wall time of the last applyTextures call, per texture, for scripts. */
export const textureStats = {
  ms: 0,
  perTexture: [] as {
    id: string; ms: number; triangles: number; edge: number;
    /** The parameterization used ('planar' | 'cylindrical' | 'unwrap'); `mapping` = what was asked for. */
    projection: string; mapping: TextureMapping;
    /** Area-weighted 90th percentile of the map's stretch max(σ1, 1/σ2) (1 = none; planar maps: not measured, 0). */
    distortion: number;
  }[],
};

// ------------------------------------------------------------------------------------ height fields

export interface HeightField {
  /** h(x, y) in [0, 1] at pattern coordinates (units of the pitch). */
  h: (x: number, y: number) => number;
  /** Lattice basis [a1x, a1y, a2x, a2y] in pattern units: h(p + a1) = h(p + a2) = h(p). */
  lattice: [number, number, number, number];
  /** Only depends on x (ridges). */
  oneD: boolean;
  /** Stipple ignores rotation. */
  rotates: boolean;
}

const smooth01 = (t: number) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

/** Nearest hex-lattice point (a1 = (1,0), a2 = (1/2, √3/2)) to (x, y): returns the offset from it. */
function hexOffset(x: number, y: number): [number, number] {
  const j = y / SQRT3_2, i = x - j / 2;
  const i0 = Math.floor(i), j0 = Math.floor(j);
  let bx = 0, by = 0, bd = Infinity;
  for (let di = 0; di <= 1; di++) for (let dj = 0; dj <= 1; dj++) {
    const ci = i0 + di, cj = j0 + dj;
    const dx = x - (ci + cj / 2), dy = y - cj * SQRT3_2;
    const d = dx * dx + dy * dy;
    if (d < bd) { bd = d; bx = dx; by = dy; }
  }
  return [bx, by];
}

export function heightField(tex: Pick<FaceTexture, 'pattern' | 'image'>): HeightField {
  switch (tex.pattern) {
    case 'knurl':
      // diamond pyramids: a square grid rotated 45°
      return {
        h: (x, y) => {
          const a = x + y, b = x - y;
          const s = a - Math.round(a), t = b - Math.round(b);
          return 1 - 2 * Math.max(Math.abs(s), Math.abs(t));
        },
        lattice: [1, 0, 0, 1], oneD: false, rotates: true,
      };
    case 'ridges':
      return { h: (x) => 0.5 + 0.5 * Math.cos(2 * Math.PI * x), lattice: [1, 0, 0, 1], oneD: true, rotates: true };
    case 'stipple': {
      const rho = 0.35;
      return {
        h: (x, y) => {
          const [dx, dy] = hexOffset(x, y);
          const r2 = (dx * dx + dy * dy) / (rho * rho);
          return r2 >= 1 ? 0 : Math.sqrt(1 - r2);
        },
        lattice: [1, 0, 0.5, SQRT3_2], oneD: false, rotates: false,
      };
    }
    case 'hex': {
      // raised hexagonal cells (centres 1 apart) with ~0.18-wide grooves between them
      const edge = 0.5 - 0.09;
      const c60 = 0.5, s60 = SQRT3_2;
      return {
        h: (x, y) => {
          const [dx, dy] = hexOffset(x, y);
          const dh = Math.max(Math.abs(dx), Math.abs(dx * c60 + dy * s60), Math.abs(-dx * c60 + dy * s60));
          return smooth01((edge - dh) / 0.06);
        },
        lattice: [1, 0, 0.5, SQRT3_2], oneD: false, rotates: true,
      };
    }
    case 'image': {
      const img = tex.image;
      if (!img || !img.width || !img.height) return { h: () => 0, lattice: [1, 0, 0, 1], oneD: false, rotates: true };
      const W = img.width, H = img.height, d = img.data, aspect = H / W;
      const px = (i: number, j: number) => d[(((j % H) + H) % H) * W + (((i % W) + W) % W)] / 255;
      return {
        h: (x, y) => {
          // tile = 1 wide, aspect tall; first data row = top of the tile
          const fx = x - Math.floor(x), fy = y / aspect - Math.floor(y / aspect);
          const sx = fx * W - 0.5, sy = (1 - fy) * H - 0.5;
          const i0 = Math.floor(sx), j0 = Math.floor(sy), tx = sx - i0, ty = sy - j0;
          return (px(i0, j0) * (1 - tx) + px(i0 + 1, j0) * tx) * (1 - ty) + (px(i0, j0 + 1) * (1 - tx) + px(i0 + 1, j0 + 1) * tx) * ty;
        },
        lattice: [1, 0, 0, aspect], oneD: false, rotates: true,
      };
    }
  }
}

/** Mean of h over one period (numeric), used by scripts to predict the volume change. */
export function meanHeight(tex: Pick<FaceTexture, 'pattern' | 'image'>, n = 200): number {
  const f = heightField(tex);
  const [ax, ay, bx, by] = f.lattice;
  let s = 0;
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    const a = (i + 0.5) / n, b = (j + 0.5) / n;
    s += f.h(a * ax + b * bx, a * ay + b * by);
  }
  return s / (n * n);
}

// ------------------------------------------------------------------------------------ working mesh

interface Work {
  pos: number[]; // xyz, float64
  tris: number[];
  origin: number[]; // per triangle: as-loaded triangle index
  /** While refining for one texture: per triangle, the pre-refinement triangle it came from (uv lookup). */
  parent?: number[];
}

/** Weld by quantized position (1e-4 mm, like buildAdjacency); triangle order is kept. */
function weld(mesh: Mesh): Work {
  const v = mesh.vertices, t = mesh.triangles;
  const nv = v.length / 3;
  const remap = new Int32Array(nv);
  const seen = new Map<string, number>();
  const pos: number[] = [];
  for (let i = 0; i < nv; i++) {
    const k = `${Math.round(v[i * 3] * 1e4)},${Math.round(v[i * 3 + 1] * 1e4)},${Math.round(v[i * 3 + 2] * 1e4)}`;
    let id = seen.get(k);
    if (id === undefined) { id = pos.length / 3; seen.set(k, id); pos.push(v[i * 3], v[i * 3 + 1], v[i * 3 + 2]); }
    remap[i] = id;
  }
  const tris = new Array<number>(t.length);
  for (let i = 0; i < t.length; i++) tris[i] = remap[t[i]];
  const origin = new Array<number>(t.length / 3);
  for (let i = 0; i < origin.length; i++) origin[i] = i;
  return { pos, tris, origin };
}

/**
 * Conforming longest-edge (Rivara) bisection of the selected region. Each pass marks the longest edge of every
 * selected triangle longer than L, then propagates so every selected triangle with a marked edge also has its longest
 * edge marked. Selected triangles bisect their longest edge first, then the other marked edges inside the children
 * (bounded angles, no slivers). Unselected neighbours split whatever edges they share (1→2, 2→3 or 1→4), so there
 * are no T-junctions. Children inherit selection and origin. Returns false if the triangle budget was hit.
 */
function refine(w: Work, sel: number[], L: number, triBudget: number): boolean {
  const L2 = L * L;
  const { pos } = w;
  const len2 = (a: number, b: number) => {
    const dx = pos[a * 3] - pos[b * 3], dy = pos[a * 3 + 1] - pos[b * 3 + 1], dz = pos[a * 3 + 2] - pos[b * 3 + 2];
    return dx * dx + dy * dy + dz * dz;
  };
  for (let pass = 0; pass < 80; pass++) {
    const T = w.tris;
    const nv = pos.length / 3, nt = T.length / 3;
    const ekey = (a: number, b: number) => Math.min(a, b) * nv + Math.max(a, b);
    const longest = (t: number): number => {
      let be = 0, bl = -1;
      for (let e = 0; e < 3; e++) {
        const l = len2(T[t * 3 + e], T[t * 3 + ((e + 1) % 3)]);
        if (l > bl) { bl = l; be = e; }
      }
      return be;
    };
    const mid = new Map<number, number>(); // marked edge -> midpoint vertex (-1 until created)
    for (let t = 0; t < nt; t++) {
      if (!sel[t]) continue;
      const e = longest(t);
      const a = T[t * 3 + e], b = T[t * 3 + ((e + 1) % 3)];
      if (a !== b && len2(a, b) > L2) mid.set(ekey(a, b), -1);
    }
    if (!mid.size) return true;
    // edge -> selected triangles using it, for propagation
    const users = new Map<number, number[]>();
    for (let t = 0; t < nt; t++) {
      if (!sel[t]) continue;
      for (let e = 0; e < 3; e++) {
        const k = ekey(T[t * 3 + e], T[t * 3 + ((e + 1) % 3)]);
        const l = users.get(k); if (l) l.push(t); else users.set(k, [t]);
      }
    }
    const queue: number[] = [];
    for (const k of mid.keys()) for (const t of users.get(k) ?? []) queue.push(t);
    while (queue.length) {
      const t = queue.pop()!;
      const e = longest(t);
      const k = ekey(T[t * 3 + e], T[t * 3 + ((e + 1) % 3)]);
      if (mid.has(k)) continue;
      mid.set(k, -1); // t was queued because one of its edges is marked
      for (const u of users.get(k) ?? []) queue.push(u);
    }
    if (nt + mid.size * 3 > triBudget) return false;
    const getMid = (a: number, b: number): number => {
      const key = ekey(a, b);
      const m = mid.get(key);
      if (m === undefined) return -1;
      if (m >= 0) return m;
      const id = pos.length / 3;
      pos.push((pos[a * 3] + pos[b * 3]) / 2, (pos[a * 3 + 1] + pos[b * 3 + 1]) / 2, (pos[a * 3 + 2] + pos[b * 3 + 2]) / 2);
      mid.set(key, id);
      return id;
    };
    const tris: number[] = [], origin: number[] = [], nsel: number[] = [], parent: number[] = [];
    let par = 0;
    const emit = (a: number, b: number, c: number, o: number, s: number) => { tris.push(a, b, c); origin.push(o); nsel.push(s); parent.push(par); };
    for (let t = 0; t < nt; t++) {
      const vs = [T[t * 3], T[t * 3 + 1], T[t * 3 + 2]];
      const ms = [getMid(vs[0], vs[1]), getMid(vs[1], vs[2]), getMid(vs[2], vs[0])];
      const o = w.origin[t], s = sel[t];
      par = w.parent ? w.parent[t] : 0;
      const cnt = (ms[0] >= 0 ? 1 : 0) + (ms[1] >= 0 ? 1 : 0) + (ms[2] >= 0 ? 1 : 0);
      if (cnt === 0) { emit(vs[0], vs[1], vs[2], o, s); continue; }
      if (s) {
        // bisect the longest edge a→b at m (marked by propagation), then split b→c / c→a inside the children
        const k = longest(t);
        const a = vs[k], b = vs[(k + 1) % 3], c = vs[(k + 2) % 3], m = ms[k];
        const mbc = ms[(k + 1) % 3], mca = ms[(k + 2) % 3];
        if (mca >= 0) { emit(a, m, mca, o, s); emit(m, c, mca, o, s); } else emit(a, m, c, o, s);
        if (mbc >= 0) { emit(m, b, mbc, o, s); emit(m, mbc, c, o, s); } else emit(m, b, c, o, s);
        continue;
      }
      if (cnt === 3) {
        emit(vs[0], ms[0], ms[2], o, s); emit(ms[0], vs[1], ms[1], o, s); emit(ms[2], ms[1], vs[2], o, s); emit(ms[0], ms[1], ms[2], o, s);
        continue;
      }
      if (cnt === 1) {
        const k = ms[0] >= 0 ? 0 : ms[1] >= 0 ? 1 : 2;
        const a = vs[k], b = vs[(k + 1) % 3], c = vs[(k + 2) % 3], m = ms[k];
        emit(a, m, c, o, s); emit(m, b, c, o, s);
        continue;
      }
      // two split edges: rotate so the unsplit one is c→a
      const k = ms[0] < 0 ? 0 : ms[1] < 0 ? 1 : 2;
      const c = vs[k], a = vs[(k + 1) % 3], b = vs[(k + 2) % 3];
      const m1 = ms[(k + 1) % 3], m2 = ms[(k + 2) % 3]; // m1 on a→b, m2 on b→c
      emit(m1, b, m2, o, s);
      if (len2(a, m2) <= len2(m1, c)) { emit(a, m1, m2, o, s); emit(a, m2, c, o, s); }
      else { emit(a, m1, c, o, s); emit(m1, m2, c, o, s); }
    }
    w.tris = tris; w.origin = origin;
    if (w.parent) w.parent = parent;
    sel.length = 0;
    for (const x of nsel) sel.push(x);
    if (tris.length / 3 > triBudget) return false;
    delaunayFlips(w, sel);
  }
  return true;
}

/** Flips across two different original triangles only when they are this close to coplanar (6°). */
const COS_FLIP = Math.cos((6 * Math.PI) / 180);

/** cos of the angle between the normals of (a,b,c) and (b,a,d). */
function dihedralCos(pos: number[], a: number, b: number, c: number, d: number): number {
  const n = (p: number, q: number, r: number): V3 => {
    const ux = pos[q * 3] - pos[p * 3], uy = pos[q * 3 + 1] - pos[p * 3 + 1], uz = pos[q * 3 + 2] - pos[p * 3 + 2];
    const vx = pos[r * 3] - pos[p * 3], vy = pos[r * 3 + 1] - pos[p * 3 + 1], vz = pos[r * 3 + 2] - pos[p * 3 + 2];
    return norm([uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx]);
  };
  return dot(n(a, b, c), n(b, a, d));
}

/**
 * Lawson edge flips between selected triangles that are (nearly) coplanar: always within one original triangle,
 * across originals only under 6° (the surface barely changes; the flipped pair keeps their origins). Fixes the
 * needles that bisecting long slivers (e.g. a cylinder's side strips) leaves behind.
 */
function delaunayFlips(w: Work, sel: number[]): void {
  const { pos } = w, T = w.tris, nt = T.length / 3, nv = pos.length / 3;
  const ekey = (a: number, b: number) => Math.min(a, b) * nv + Math.max(a, b);
  const angle = (o: number, p: number, q: number) => {
    const ux = pos[p * 3] - pos[o * 3], uy = pos[p * 3 + 1] - pos[o * 3 + 1], uz = pos[p * 3 + 2] - pos[o * 3 + 2];
    const vx = pos[q * 3] - pos[o * 3], vy = pos[q * 3 + 1] - pos[o * 3 + 1], vz = pos[q * 3 + 2] - pos[o * 3 + 2];
    const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
    return Math.atan2(Math.hypot(cx, cy, cz), ux * vx + uy * vy + uz * vz);
  };
  const edges = new Map<number, number>(); // edge -> half-edge slot t*3+e of a selected triangle (or -2 if 2 seen)
  const other = new Map<number, number>();
  const all = new Set<number>();
  for (let t = 0; t < nt; t++) for (let e = 0; e < 3; e++) {
    const k = ekey(T[t * 3 + e], T[t * 3 + ((e + 1) % 3)]);
    all.add(k);
    if (!sel[t]) continue;
    if (edges.has(k)) other.set(k, t * 3 + e); else edges.set(k, t * 3 + e);
  }
  for (let sweep = 0; sweep < 6; sweep++) {
    let flips = 0;
    const dirty = new Uint8Array(nt);
    for (const [k, s2] of other) {
      const s1 = edges.get(k)!;
      const t1 = (s1 / 3) | 0, t2 = (s2 / 3) | 0;
      if (dirty[t1] || dirty[t2]) continue;
      const e1 = s1 % 3, e2 = s2 % 3;
      const a = T[t1 * 3 + e1], b = T[t1 * 3 + ((e1 + 1) % 3)], c = T[t1 * 3 + ((e1 + 2) % 3)];
      if (T[t2 * 3 + e2] !== b || T[t2 * 3 + ((e2 + 1) % 3)] !== a) continue; // inconsistent orientation
      const d = T[t2 * 3 + ((e2 + 2) % 3)];
      if (c === d || angle(c, a, b) + angle(d, b, a) <= Math.PI + 1e-9) continue;
      if (w.origin[t1] !== w.origin[t2] && dihedralCos(pos, a, b, c, d) < COS_FLIP) continue;
      const kn = ekey(c, d);
      if (all.has(kn)) continue;
      // (a,b,c) + (b,a,d) -> (a,d,c) + (d,b,c)
      T[t1 * 3] = a; T[t1 * 3 + 1] = d; T[t1 * 3 + 2] = c;
      T[t2 * 3] = d; T[t2 * 3 + 1] = b; T[t2 * 3 + 2] = c;
      dirty[t1] = dirty[t2] = 1;
      all.delete(k); all.add(kn);
      flips++;
    }
    if (!flips) return;
    // rebuild the selected half-edge maps for the next sweep
    edges.clear(); other.clear();
    for (let t = 0; t < nt; t++) {
      if (!sel[t]) continue;
      for (let e = 0; e < 3; e++) {
        const k = ekey(T[t * 3 + e], T[t * 3 + ((e + 1) % 3)]);
        if (edges.has(k)) other.set(k, t * 3 + e); else edges.set(k, t * 3 + e);
      }
    }
  }
}

// ------------------------------------------------------------------------------------ parameterization

interface UVMap {
  kind: 'planar' | 'cylindrical' | 'unwrap';
  /** Planar: (u, v) in mm of a point. */
  uv?: (x: number, y: number, z: number) => [number, number];
  /** Cylindrical / unwrap: uv + amplitude per corner of the (pre-refinement) working triangles. */
  patch?: PatchUV;
  /** Full wrap: the u period (around the part), else 0. */
  circ: number;
  distortion: number;
}

function planarMap(n: V3, cx: number, cy: number, cz: number): UVMap {
  let ref: V3 = [1, 0, 0];
  if (Math.abs(n[0]) > 0.9) ref = [0, 1, 0];
  const e1 = norm([ref[0] - n[0] * dot(ref, n), ref[1] - n[1] * dot(ref, n), ref[2] - n[2] * dot(ref, n)]);
  const e2 = cross(n, e1);
  return {
    kind: 'planar', circ: 0, distortion: 0,
    uv: (x, y, z) => {
      const dx = x - cx, dy = y - cy, dz = z - cz;
      return [dx * e1[0] + dy * e1[1] + dz * e1[2], dx * e2[0] + dy * e2[1] + dz * e2[2]];
    },
  };
}

/** Auto keeps the axis-true cylinder when it is (nearly) stretch-free, else whichever of the two stretches less. */
const CYL_OK = 1.03;

/**
 * Region frame from the selected triangles. Auto: planar if the normals stay within 15° of the mean, else the
 * arc-length cylinder when it barely stretches, else the conformal unwrap. Explicit mappings are honoured.
 */
function regionMap(w: Work, sel: number[], mapping: TextureMapping, warn: (s: string) => void, name: string): UVMap | null {
  const { pos, tris } = w;
  let ax = 0, ay = 0, az = 0, A = 0, cx = 0, cy = 0, cz = 0;
  const normals: V3[] = [];
  for (let t = 0; t < sel.length; t++) {
    if (!sel[t]) continue;
    const a = tris[t * 3], b = tris[t * 3 + 1], c = tris[t * 3 + 2];
    const ux = pos[b * 3] - pos[a * 3], uy = pos[b * 3 + 1] - pos[a * 3 + 1], uz = pos[b * 3 + 2] - pos[a * 3 + 2];
    const vx = pos[c * 3] - pos[a * 3], vy = pos[c * 3 + 1] - pos[a * 3 + 1], vz = pos[c * 3 + 2] - pos[a * 3 + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz);
    if (l < 1e-12) continue;
    const ar = l / 2;
    normals.push([nx / l, ny / l, nz / l]);
    ax += (nx / l) * ar; ay += (ny / l) * ar; az += (nz / l) * ar; A += ar;
    cx += ar * (pos[a * 3] + pos[b * 3] + pos[c * 3]) / 3;
    cy += ar * (pos[a * 3 + 1] + pos[b * 3 + 1] + pos[c * 3 + 1]) / 3;
    cz += ar * (pos[a * 3 + 2] + pos[b * 3 + 2] + pos[c * 3 + 2]) / 3;
  }
  if (A <= 0) return null;
  cx /= A; cy /= A; cz /= A;
  const meanLen = Math.hypot(ax, ay, az);
  const mean: V3 = meanLen > 1e-9 ? [ax / meanLen, ay / meanLen, az / meanLen] : [0, 0, 1];
  const cos15 = Math.cos((15 * Math.PI) / 180);
  const flat = meanLen > 1e-9 && normals.every((n) => dot(n, mean) >= cos15);
  if (mapping === 'planar' || (mapping === 'auto' && flat)) return planarMap(mean, cx, cy, cz);

  const solve = (mode: 'cylindrical' | 'unwrap'): UVMap | null => {
    const p = solvePatch(pos, tris, sel, mode);
    if (p?.failed.length) failed.push(...p.failed);
    return p && p.coverage > 0 ? { kind: mode, patch: p, circ: p.circ, distortion: p.distortion } : null;
  };
  const failed: string[] = [];
  let map: UVMap | null;
  if (mapping === 'auto') {
    const cyl = solve('cylindrical');
    if (cyl && cyl.distortion <= CYL_OK) map = cyl;
    else {
      const unw = solve('unwrap');
      map = cyl && unw ? (cyl.distortion <= unw.distortion + 0.01 ? cyl : unw) : (unw ?? cyl);
    }
  } else map = solve(mapping);
  const why = [...new Set(failed)].join('; ');
  if (!map) {
    warn(`Texture "${name}": the region could not be unwrapped (${why || 'degenerate'}); projected flat (may stretch).`);
    return planarMap(mean, cx, cy, cz);
  }
  if (map.patch!.failed.length) warn(`Texture "${name}": part of the region was left plain (${[...new Set(map.patch!.failed)].join('; ')}).`);
  return map;
}

/**
 * Full-wrap cylinders: adjust pitch (and the rotation slightly) so one turn around (Δu = circumference) is a lattice
 * vector of the pattern, i.e. the relief meets itself seamlessly. Returns the effective pitch and rotation (radians).
 */
function snapWrap(f: HeightField, circ: number, pitch: number, theta: number): { pitch: number; theta: number } {
  if (!circ) return { pitch, theta };
  const c = Math.cos(theta), s = Math.sin(theta);
  if (f.oneD) {
    if (Math.abs(c) < 1e-6) return { pitch, theta };
    const m = Math.max(1, Math.round((circ * Math.abs(c)) / pitch));
    return { pitch: (circ * Math.abs(c)) / m, theta };
  }
  // Δq = Rot(-θ)·(circ, 0)/pitch must equal A·k for integers k
  const dx = (circ * c) / pitch, dy = (-circ * s) / pitch;
  const [a1x, a1y, a2x, a2y] = f.lattice;
  const det = a1x * a2y - a2x * a1y;
  const k1 = Math.round((dx * a2y - dy * a2x) / det), k2 = Math.round((a1x * dy - a1y * dx) / det);
  const wx = k1 * a1x + k2 * a2x, wy = k1 * a1y + k2 * a2y;
  const wl = Math.hypot(wx, wy);
  if (wl < 1e-9) return { pitch, theta };
  return { pitch: circ / wl, theta: Math.atan2(-wy, wx) };
}

// ------------------------------------------------------------------------------------ displacement

/** Binary min-heap keyed by distance (Dijkstra). */
class Heap {
  private k: number[] = []; private v: number[] = [];
  get size() { return this.k.length; }
  push(key: number, val: number) {
    const k = this.k, v = this.v;
    let i = k.length; k.push(key); v.push(val);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (k[p] <= key) break;
      k[i] = k[p]; v[i] = v[p]; i = p;
    }
    k[i] = key; v[i] = val;
  }
  pop(): [number, number] {
    const k = this.k, v = this.v;
    const top: [number, number] = [k[0], v[0]];
    const lk = k.pop()!, lv = v.pop()!;
    if (k.length) {
      let i = 0;
      for (;;) {
        const l = i * 2 + 1, r = l + 1;
        let m = i, mk = lk;
        if (l < k.length && k[l] < mk) { m = l; mk = k[l]; }
        if (r < k.length && k[r] < mk) { m = r; }
        if (m === i) break;
        k[i] = k[m]; v[i] = v[m]; i = m;
      }
      k[i] = lk; v[i] = lv;
    }
    return top;
  }
}

/**
 * Displaces the selected region in place. Patch maps: each refined vertex takes the uv of its pre-refinement
 * triangle (`coarse` = the triangle list before refine, `w.parent` the lineage) by barycentric interpolation;
 * refinement keeps vertices on those flat triangles. Across a wrap's cut either branch is fine (the jump is a period).
 */
function displace(w: Work, sel: number[], tex: FaceTexture, map: UVMap, field: HeightField, coarse: number[]): void {
  const { pos, tris } = w;
  const nv = pos.length / 3, nt = tris.length / 3;
  const nrm = new Float64Array(nv * 3);
  const inSel = new Uint8Array(nv), onBound = new Uint8Array(nv);
  for (let t = 0; t < nt; t++) {
    const a = tris[t * 3], b = tris[t * 3 + 1], c = tris[t * 3 + 2];
    if (!sel[t]) { onBound[a] = onBound[b] = onBound[c] = 1; continue; }
    inSel[a] = inSel[b] = inSel[c] = 1;
    const ux = pos[b * 3] - pos[a * 3], uy = pos[b * 3 + 1] - pos[a * 3 + 1], uz = pos[b * 3 + 2] - pos[a * 3 + 2];
    const vx = pos[c * 3] - pos[a * 3], vy = pos[c * 3 + 1] - pos[a * 3 + 1], vz = pos[c * 3 + 2] - pos[a * 3 + 2];
    // cross product = normal × 2·area: area-weighted accumulation
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    for (const i of [a, b, c]) { nrm[i * 3] += nx; nrm[i * 3 + 1] += ny; nrm[i * 3 + 2] += nz; }
  }

  // feather: Dijkstra distance over the region's edges from its boundary vertices
  const band = tex.pitch / 2;
  const dist = new Float64Array(nv).fill(Infinity);
  const deg = new Int32Array(nv + 1);
  for (let t = 0; t < nt; t++) if (sel[t]) for (let e = 0; e < 3; e++) { deg[tris[t * 3 + e] + 1] += 2; }
  for (let i = 0; i < nv; i++) deg[i + 1] += deg[i];
  const nbr = new Int32Array(deg[nv]);
  const fill = deg.slice(0, nv);
  for (let t = 0; t < nt; t++) {
    if (!sel[t]) continue;
    for (let e = 0; e < 3; e++) {
      const a = tris[t * 3 + e], b = tris[t * 3 + ((e + 1) % 3)];
      nbr[fill[a]++] = b; nbr[fill[b]++] = a;
    }
  }
  const heap = new Heap();
  for (let i = 0; i < nv; i++) if (inSel[i] && onBound[i]) { dist[i] = 0; heap.push(0, i); }
  while (heap.size) {
    const [d, i] = heap.pop();
    if (d > dist[i] || d >= band) continue;
    for (let k = deg[i]; k < deg[i + 1]; k++) {
      const j = nbr[k];
      const nd = d + Math.hypot(pos[i * 3] - pos[j * 3], pos[i * 3 + 1] - pos[j * 3 + 1], pos[i * 3 + 2] - pos[j * 3 + 2]);
      if (nd < dist[j]) { dist[j] = nd; heap.push(nd, j); }
    }
  }

  // pattern coordinates (+ amplitude factor for patch maps)
  let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
  const uvs = new Float64Array(nv * 2);
  const ampv = new Float64Array(nv).fill(1);
  if (map.patch) {
    const pt = map.patch, par = w.parent!;
    const src = new Int32Array(nv).fill(-1); // a coarse triangle with uv containing the vertex
    for (let t = 0; t < nt; t++) {
      if (!sel[t]) continue;
      const p = par[t];
      if (!pt.has[p]) continue;
      for (let e = 0; e < 3; e++) { const i = tris[t * 3 + e]; if (src[i] < 0) src[i] = p; }
    }
    for (let i = 0; i < nv; i++) {
      if (!inSel[i]) continue;
      const p = src[i];
      if (p < 0) { ampv[i] = 0; continue; }
      const a = coarse[p * 3], b = coarse[p * 3 + 1], c = coarse[p * 3 + 2];
      const e1x = pos[b * 3] - pos[a * 3], e1y = pos[b * 3 + 1] - pos[a * 3 + 1], e1z = pos[b * 3 + 2] - pos[a * 3 + 2];
      const e2x = pos[c * 3] - pos[a * 3], e2y = pos[c * 3 + 1] - pos[a * 3 + 1], e2z = pos[c * 3 + 2] - pos[a * 3 + 2];
      const qx = pos[i * 3] - pos[a * 3], qy = pos[i * 3 + 1] - pos[a * 3 + 1], qz = pos[i * 3 + 2] - pos[a * 3 + 2];
      const d11 = e1x * e1x + e1y * e1y + e1z * e1z, d12 = e1x * e2x + e1y * e2y + e1z * e2z, d22 = e2x * e2x + e2y * e2y + e2z * e2z;
      const q1 = qx * e1x + qy * e1y + qz * e1z, q2 = qx * e2x + qy * e2y + qz * e2z;
      const det = d11 * d22 - d12 * d12 || 1e-30;
      const l1 = (d22 * q1 - d12 * q2) / det, l2 = (d11 * q2 - d12 * q1) / det, l0 = 1 - l1 - l2;
      const U = pt.uv, o = p * 6;
      uvs[i * 2] = l0 * U[o] + l1 * U[o + 2] + l2 * U[o + 4];
      uvs[i * 2 + 1] = l0 * U[o + 1] + l1 * U[o + 3] + l2 * U[o + 5];
      ampv[i] = Math.max(0, Math.min(1, l0 * pt.amp[p * 3] + l1 * pt.amp[p * 3 + 1] + l2 * pt.amp[p * 3 + 2]));
    }
  } else {
    for (let i = 0; i < nv; i++) {
      if (!inSel[i]) continue;
      const [u, v] = map.uv!(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]);
      uvs[i * 2] = u; uvs[i * 2 + 1] = v;
    }
  }
  for (let i = 0; i < nv; i++) {
    if (!inSel[i] || ampv[i] <= 0) continue;
    const u = uvs[i * 2], v = uvs[i * 2 + 1];
    if (u < u0) u0 = u; if (u > u1) u1 = u; if (v < v0) v0 = v; if (v > v1) v1 = v;
  }
  const theta0 = field.rotates ? (tex.rotation * Math.PI) / 180 : 0;
  const { pitch, theta } = snapWrap(field, map.circ, tex.pitch, theta0);
  const ct = Math.cos(theta), st = Math.sin(theta);
  const cu = (u0 + u1) / 2, cv = (v0 + v1) / 2;
  const sign = tex.mode === 'raised' ? 1 : -1;
  const amp = sign * tex.height;
  for (let i = 0; i < nv; i++) {
    if (!inSel[i] || onBound[i]) continue;
    const d = dist[i];
    const wgt = d >= band ? 1 : smooth01(d / band);
    if (wgt <= 0) continue;
    const l = Math.hypot(nrm[i * 3], nrm[i * 3 + 1], nrm[i * 3 + 2]);
    if (l < 1e-12) continue;
    const du = uvs[i * 2] - cu, dv = uvs[i * 2 + 1] - cv;
    const h = field.h((ct * du + st * dv) / pitch, (-st * du + ct * dv) / pitch);
    const s = (amp * h * wgt * ampv[i]) / l;
    pos[i * 3] += nrm[i * 3] * s; pos[i * 3 + 1] += nrm[i * 3 + 1] * s; pos[i * 3 + 2] += nrm[i * 3 + 2] * s;
  }
}

// ------------------------------------------------------------------------------------ entry points

/** Cache key over everything applyTextures reads (triangle sets and height maps are hashed). */
export function textureKey(textures: FaceTexture[]): string {
  return textures.map((t) => {
    let h = 0;
    for (const i of t.triangles) h = (Math.imul(h, 31) + i) | 0;
    let ih = 0;
    if (t.image) for (let i = 0; i < t.image.data.length; i++) ih = (Math.imul(ih, 31) + t.image.data[i]) | 0;
    const img = t.image ? `${t.image.width}x${t.image.height}#${ih}` : '';
    return `${t.id}:${t.objectIndex}:${t.partIndex}:${t.triangles.length}#${h}:${t.pattern}:${t.mode}:${t.height}:${t.pitch}:${t.rotation}:${t.mapping ?? 'auto'}:${img}`;
  }).join(';');
}

export interface TextureResult {
  /** The textured model (as-loaded space). === the input model when nothing was applied; untextured parts are shared. */
  model: Model;
  /** [object][part]: true where the part's mesh was replaced. */
  changed: boolean[][];
  /** Textures that were actually applied (skipped ones are named in warnings). */
  applied: FaceTexture[];
  warnings: string[];
}

function toManifoldOk(wasm: ManifoldToplevel, mesh: Mesh): boolean {
  let man = null;
  try {
    const m = new wasm.Mesh({ numProp: 3, vertProperties: mesh.vertices, triVerts: mesh.triangles });
    m.merge();
    man = wasm.Manifold.ofMesh(m);
    return man.status() === 'NoError' && !man.isEmpty();
  } catch {
    return false;
  } finally {
    man?.delete();
  }
}

/**
 * Applies `textures` (in order) to `model` in its as-loaded coordinates. Each texture's triangle indices refer to the
 * ORIGINAL part mesh; an origin map carried through refinement finds them again after earlier textures.
 */
export async function applyTextures(
  wasm: ManifoldToplevel, model: Model, textures: FaceTexture[],
  onProgress?: (done: number, total: number) => Promise<void> | void,
): Promise<TextureResult> {
  const t0 = performance.now();
  textureStats.perTexture = [];
  const warnings: string[] = [];
  const applied: FaceTexture[] = [];
  const work = new Map<string, Work>(); // "j:k" -> current working mesh
  let total = 0;
  for (const o of model.objects) for (const p of o.parts) total += p.mesh.triangles.length / 3;

  for (let ti = 0; ti < textures.length; ti++) {
    const tex = textures[ti];
    if (onProgress) await onProgress(ti, textures.length);
    const PATTERN_NAMES: Record<string, string> = { knurl: 'Diamond knurl', stipple: 'Stipple', ridges: 'Ridges', hex: 'Hex', image: 'Pattern' };
    const name = `${tex.patternRef?.name ?? PATTERN_NAMES[tex.pattern] ?? tex.pattern} (area ${ti + 1})`;
    const part = model.objects[tex.objectIndex]?.parts[tex.partIndex];
    if (!part || !tex.triangles.length || !(tex.pitch > 0) || !(tex.height > 0)) continue;
    const nt0 = part.mesh.triangles.length / 3;
    if (tex.triangles.some((i) => i < 0 || i >= nt0)) continue; // stale indices
    if (tex.pattern === 'image' && !tex.image) continue;
    const ts = performance.now();
    const key = `${tex.objectIndex}:${tex.partIndex}`;
    const prev = work.get(key);
    const w: Work = prev
      ? { pos: prev.pos.slice(), tris: prev.tris.slice(), origin: prev.origin.slice() }
      : weld(part.mesh);
    const curTris = w.tris.length / 3;

    const region = new Uint8Array(nt0);
    for (const i of tex.triangles) region[i] = 1;
    const sel: number[] = w.origin.map((o) => region[o]);
    const field = heightField(tex);
    const mapping: TextureMapping = tex.mapping ?? 'auto';
    const map = regionMap(w, sel, mapping, (s) => warnings.push(s), name);
    if (!map) continue;

    // triangle budget on top of what the model already has. Bisection to "longest edge <= L" lands near L²/5 per
    // triangle (measured ~2.4x the area / (L²/2) estimate), so budget with that.
    let area = 0;
    for (let t = 0; t < sel.length; t++) {
      if (!sel[t]) continue;
      const a = w.tris[t * 3], b = w.tris[t * 3 + 1], c = w.tris[t * 3 + 2], p = w.pos;
      const ux = p[b * 3] - p[a * 3], uy = p[b * 3 + 1] - p[a * 3 + 1], uz = p[b * 3 + 2] - p[a * 3 + 2];
      const vx = p[c * 3] - p[a * 3], vy = p[c * 3 + 1] - p[a * 3 + 1], vz = p[c * 3 + 2] - p[a * 3 + 2];
      area += Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2;
    }
    const L0 = Math.max(MIN_EDGE, tex.pitch / DIV[tex.pattern]);
    let L = 0;
    for (const f of [1, 4 / 3, 2, 3]) {
      if (total + area / ((L0 * f) ** 2 / 5) <= MAX_TEXTURE_TRIS) { L = L0 * f; break; }
    }
    if (!L) {
      warnings.push(`Texture "${name}" skipped: it would need too many triangles (region ${area.toFixed(0)} mm² at pitch ${tex.pitch} mm). Use a larger pitch or a smaller region.`);
      continue;
    }
    if (L > L0) warnings.push(`Texture "${name}": coarser mesh (${L.toFixed(2)} mm edges) to keep the triangle count down.`);

    const coarse = w.tris.slice();
    w.parent = coarse.map((_, i) => i).slice(0, coarse.length / 3);
    const refined = refine(w, sel, L, HARD_TRIS);
    if (!refined) {
      warnings.push(`Texture "${name}" skipped: too many triangles. Use a larger pitch or a smaller region.`);
      continue;
    }
    displace(w, sel, tex, map, field, coarse);
    delete w.parent;
    const mesh: Mesh = { vertices: Float32Array.from(w.pos), triangles: Uint32Array.from(w.tris) };
    if (!toManifoldOk(wasm, mesh)) {
      warnings.push(`Texture "${name}" skipped: the relief did not produce a valid solid (try a smaller height).`);
      continue;
    }
    total += w.tris.length / 3 - curTris;
    work.set(key, w);
    applied.push(tex);
    textureStats.perTexture.push({ id: tex.id, ms: performance.now() - ts, triangles: w.tris.length / 3, edge: L, projection: map.kind, mapping, distortion: map.distortion });
  }
  if (onProgress) await onProgress(textures.length, textures.length);
  if (total > MAX_TEXTURE_TRIS * 0.8 && applied.length) {
    warnings.push(`Textured model has ${Math.round(total / 1000)}k triangles; slicing and export may be slow.`);
  }

  const changed = model.objects.map((o, j) => o.parts.map((_, k) => work.has(`${j}:${k}`)));
  textureStats.ms = performance.now() - t0;
  if (!work.size) return { model, changed, applied, warnings };
  return {
    model: {
      objects: model.objects.map((o, j) => ({
        name: o.name,
        parts: o.parts.map((p, k) => {
          const w = work.get(`${j}:${k}`);
          return w ? { name: p.name, mesh: { vertices: Float32Array.from(w.pos), triangles: Uint32Array.from(w.tris) } } : p;
        }),
      })),
    },
    changed, applied, warnings,
  };
}
