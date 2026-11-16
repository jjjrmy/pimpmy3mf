// Surface parameterization of a selected (coarse) mesh patch for face textures: (u, v) in mm along the surface, so a
// pattern keeps its pitch around curved regions instead of stretching like a flat projection.
//   'unwrap'      : least-squares conformal map (LSCM), solved by Jacobi-preconditioned CG on the normal equations.
//   'cylindrical' : v = distance along the region's axis, u = its least-squares conjugate (arc length around the
//                   actual cross-section, not R·angle), so rows of the pattern follow the axis exactly.
// Topology per connected component: an open patch is solved as is; a tube (two boundary loops winding around the
// axis) is cut along the shortest path between them and solved PERIODIC (u jumps by a constant T across the cut, so
// the pattern meets itself once T is a lattice period); a closed genus-0 surface (sphere, capsule) gets the fans
// around its two axis extremes removed first (the relief fades out there). Result: uv per corner of each coarse
// triangle, interpolated barycentrically for the refined vertices.

export type V3 = [number, number, number];
export const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const norm = (a: V3): V3 => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

/** Eigen-decomposition of a symmetric 3x3 (row-major) by Jacobi rotations: eigenvalues + column eigenvectors. */
export function eigSym3(m: number[]): { values: number[]; vectors: V3[] } {
  const a = m.slice();
  const v = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  for (let sweep = 0; sweep < 50; sweep++) {
    const off = a[1] * a[1] + a[2] * a[2] + a[5] * a[5];
    if (off < 1e-24) break;
    for (const [p, q] of [[0, 1], [0, 2], [1, 2]] as const) {
      const apq = a[p * 3 + q];
      if (Math.abs(apq) < 1e-30) continue;
      const theta = (a[q * 3 + q] - a[p * 3 + p]) / (2 * apq);
      const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const c = 1 / Math.sqrt(t * t + 1), s = t * c;
      for (let k = 0; k < 3; k++) {
        const akp = a[k * 3 + p], akq = a[k * 3 + q];
        a[k * 3 + p] = c * akp - s * akq; a[k * 3 + q] = s * akp + c * akq;
      }
      for (let k = 0; k < 3; k++) {
        const apk = a[p * 3 + k], aqk = a[q * 3 + k];
        a[p * 3 + k] = c * apk - s * aqk; a[q * 3 + k] = s * apk + c * aqk;
      }
      for (let k = 0; k < 3; k++) {
        const vkp = v[k * 3 + p], vkq = v[k * 3 + q];
        v[k * 3 + p] = c * vkp - s * vkq; v[k * 3 + q] = s * vkp + c * vkq;
      }
    }
  }
  return { values: [a[0], a[4], a[8]], vectors: [0, 1, 2].map((c) => [v[c], v[3 + c], v[6 + c]] as V3) };
}

/**
 * Axis the normals don't vary along (smallest eigenvalue of Σ a n nᵀ), sign-normalised to its largest component.
 * When it's ambiguous (sphere, hemisphere: near-equal eigenvalues) world Z projected onto the near-minimal
 * eigenspace, so round things get their poles up/down like the part sits on the bed.
 */
export function normalAxis(cov: number[]): V3 {
  const { values, vectors } = eigSym3(cov);
  let mi = 0, ma = 0;
  for (let i = 1; i < 3; i++) { if (values[i] < values[mi]) mi = i; if (values[i] > values[ma]) ma = i; }
  let axis = norm(vectors[mi]);
  const near = [0, 1, 2].filter((i) => values[i] <= values[mi] + 0.15 * values[ma]);
  if (near.length > 1) {
    const z: V3 = [0, 0, 0];
    for (const i of near) { const e = vectors[i], k = e[2]; z[0] += k * e[0]; z[1] += k * e[1]; z[2] += k * e[2]; }
    if (Math.hypot(z[0], z[1], z[2]) > 0.3) axis = norm(z);
  }
  const big = Math.abs(axis[0]) >= Math.abs(axis[1]) && Math.abs(axis[0]) >= Math.abs(axis[2]) ? 0 : Math.abs(axis[1]) >= Math.abs(axis[2]) ? 1 : 2;
  if (axis[big] < 0) axis = [-axis[0], -axis[1], -axis[2]];
  return axis;
}

export type PatchMode = 'cylindrical' | 'unwrap';

export interface PatchUV {
  /** Per working-mesh triangle: corner (u, v) in mm, 6 numbers (only where has[t]). */
  uv: Float64Array;
  /** Per corner relief amplitude factor 0..1 (fades where the map compresses the pattern below what the mesh holds). */
  amp: Float64Array;
  has: Uint8Array;
  /** u period of a full wrap (the jump across the cut), 0 if no component wraps. */
  circ: number;
  /** Area-weighted 90th percentile of max(σ1, 1/σ2) of the 3D→uv Jacobian: 1 = no stretch. */
  distortion: number;
  /** Fraction of the selected area that got a map (the rest: removed pole fans, failed components). */
  coverage: number;
  /** Why a component failed (genus > 0, solver), for warnings. */
  failed: string[];
}

interface Comp { tris: number[] }

/** Splits the selected triangles into edge-connected components. */
function components(tris: number[], list: number[]): Comp[] {
  const parent = new Map<number, number>();
  const find = (x: number): number => { let r = x; while (parent.get(r) !== r) r = parent.get(r)!; let y = x; while (parent.get(y) !== r) { const n = parent.get(y)!; parent.set(y, r); y = n; } return r; };
  for (const t of list) parent.set(t, t);
  const edge = new Map<string, number>();
  for (const t of list) for (let e = 0; e < 3; e++) {
    const a = tris[t * 3 + e], b = tris[t * 3 + ((e + 1) % 3)];
    const k = a < b ? `${a},${b}` : `${b},${a}`;
    const o = edge.get(k);
    if (o === undefined) edge.set(k, t); else { const ra = find(o), rb = find(t); if (ra !== rb) parent.set(ra, rb); }
  }
  const groups = new Map<number, number[]>();
  for (const t of list) { const r = find(t); const g = groups.get(r); if (g) g.push(t); else groups.set(r, [t]); }
  return [...groups.values()].map((g) => ({ tris: g }));
}

/** Jacobi-preconditioned CG on a CSR SPD matrix. */
function pcg(n: number, rowPtr: Int32Array, cols: Int32Array, vals: Float64Array, b: Float64Array, x: Float64Array, tol = 1e-6, maxIt = 20000): number {
  const diag = new Float64Array(n);
  for (let i = 0; i < n; i++) for (let k = rowPtr[i]; k < rowPtr[i + 1]; k++) if (cols[k] === i) diag[i] = vals[k];
  const mul = (p: Float64Array, out: Float64Array) => {
    for (let i = 0; i < n; i++) { let s = 0; for (let k = rowPtr[i]; k < rowPtr[i + 1]; k++) s += vals[k] * p[cols[k]]; out[i] = s; }
  };
  const r = new Float64Array(n), z = new Float64Array(n), p = new Float64Array(n), q = new Float64Array(n);
  mul(x, q);
  let bn = 0;
  for (let i = 0; i < n; i++) { r[i] = b[i] - q[i]; bn += b[i] * b[i]; }
  bn = Math.sqrt(bn) || 1;
  for (let i = 0; i < n; i++) { z[i] = diag[i] > 0 ? r[i] / diag[i] : r[i]; p[i] = z[i]; }
  let rz = 0;
  for (let i = 0; i < n; i++) rz += r[i] * z[i];
  let it = 0;
  for (; it < maxIt; it++) {
    mul(p, q);
    let pq = 0;
    for (let i = 0; i < n; i++) pq += p[i] * q[i];
    if (!(Math.abs(pq) > 1e-300)) break;
    const alpha = rz / pq;
    let rn = 0;
    for (let i = 0; i < n; i++) { x[i] += alpha * p[i]; r[i] -= alpha * q[i]; rn += r[i] * r[i]; }
    if (Math.sqrt(rn) < tol * bn) break;
    let rz2 = 0;
    for (let i = 0; i < n; i++) { z[i] = diag[i] > 0 ? r[i] / diag[i] : r[i]; rz2 += r[i] * z[i]; }
    const beta = rz2 / rz;
    rz = rz2;
    for (let i = 0; i < n; i++) p[i] = z[i] + beta * p[i];
  }
  return it;
}

/** Sparse least squares Σ (row·x - rhs)² accumulated straight into the normal equations. */
class LSQ {
  private rows: Map<number, number>[];
  readonly b: Float64Array;
  constructor(readonly n: number) { this.rows = Array.from({ length: n }, () => new Map()); this.b = new Float64Array(n); }
  /** One residual row: Σ coef[i]·x[col[i]] - rhs, weighted by w (applied squared). */
  add(cols: number[], coefs: number[], rhs: number, w: number) {
    for (let i = 0; i < cols.length; i++) {
      const ci = cols[i];
      if (ci < 0) continue;
      const row = this.rows[ci], a = coefs[i] * w;
      this.b[ci] += a * rhs;
      for (let j = 0; j < cols.length; j++) {
        const cj = cols[j];
        if (cj < 0) continue;
        row.set(cj, (row.get(cj) ?? 0) + a * coefs[j]);
      }
    }
  }
  solve(x: Float64Array): number {
    const n = this.n;
    const rowPtr = new Int32Array(n + 1);
    for (let i = 0; i < n; i++) rowPtr[i + 1] = rowPtr[i] + this.rows[i].size;
    const cols = new Int32Array(rowPtr[n]), vals = new Float64Array(rowPtr[n]);
    for (let i = 0; i < n; i++) { let k = rowPtr[i]; for (const [c, v] of this.rows[i]) { cols[k] = c; vals[k] = v; k++; } }
    // a column nobody touches (cannot happen for a connected patch) would make the matrix singular: pin it
    for (let i = 0; i < n; i++) if (rowPtr[i + 1] === rowPtr[i]) return -1;
    return pcg(n, rowPtr, cols, vals, this.b, x);
  }
}

const smooth01 = (t: number) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

/**
 * Parameterizes the selected triangles of (pos, tris). `sel[t]` marks the patch. Returns null when it has no area;
 * coverage 0 when every component failed.
 */
export function solvePatch(pos: ArrayLike<number>, tris: ArrayLike<number>, sel: ArrayLike<number>, mode: PatchMode): PatchUV | null {
  const nt = tris.length / 3;
  const P = (i: number): V3 => [pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]];
  const list: number[] = [];
  const triN = new Float64Array(nt * 3), triA = new Float64Array(nt);
  for (let t = 0; t < nt; t++) {
    if (!sel[t]) continue;
    const a = P(tris[t * 3]), b = P(tris[t * 3 + 1]), c = P(tris[t * 3 + 2]);
    const n = cross([b[0] - a[0], b[1] - a[1], b[2] - a[2]], [c[0] - a[0], c[1] - a[1], c[2] - a[2]]);
    const l = Math.hypot(n[0], n[1], n[2]);
    if (l < 1e-12) continue;
    triA[t] = l / 2; triN[t * 3] = n[0] / l; triN[t * 3 + 1] = n[1] / l; triN[t * 3 + 2] = n[2] / l;
    list.push(t);
  }
  if (!list.length) return null;
  const out: PatchUV = {
    uv: new Float64Array(nt * 6), amp: new Float64Array(nt * 3), has: new Uint8Array(nt),
    circ: 0, distortion: 1, coverage: 0, failed: [],
  };
  let totalA = 0;
  for (const t of list) totalA += triA[t];
  const dist: [number, number][] = []; // [D, area]
  let covered = 0;
  for (const comp of components(tris as number[], list)) {
    const r = solveComponent(comp.tris, false);
    if (typeof r === 'string') { out.failed.push(r); continue; }
    for (const [d, a] of r.dist) dist.push([d, a]);
    covered += r.area;
    if (r.circ && !out.circ) out.circ = r.circ;
  }
  if (!covered) return out; // coverage 0: every component failed (reasons in `failed`)
  out.coverage = covered / totalA;
  dist.sort((a, b) => a[0] - b[0]);
  let acc = 0;
  const tot = dist.reduce((s, x) => s + x[1], 0);
  for (const [d, a] of dist) { acc += a; if (acc >= 0.9 * tot) { out.distortion = d; break; } }
  return out;

  function solveComponent(ctris: number[], poled: boolean): { dist: [number, number][]; area: number; circ: number } | string {
    // ---- local indexing, frame
    const vid = new Map<number, number>();
    const verts: number[] = [];
    for (const t of ctris) for (let e = 0; e < 3; e++) { const g = tris[t * 3 + e]; if (!vid.has(g)) { vid.set(g, verts.length); verts.push(g); } }
    const nv = verts.length;
    const cov = [0, 0, 0, 0, 0, 0, 0, 0, 0];
    const ctr: V3 = [0, 0, 0];
    let area = 0;
    for (const t of ctris) {
      const a = triA[t];
      for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) cov[i * 3 + j] += a * triN[t * 3 + i] * triN[t * 3 + j];
      for (let e = 0; e < 3; e++) { const p = P(tris[t * 3 + e]); ctr[0] += (a * p[0]) / 3; ctr[1] += (a * p[1]) / 3; ctr[2] += (a * p[2]) / 3; }
      area += a;
    }
    ctr[0] /= area; ctr[1] /= area; ctr[2] /= area;
    const axis = normalAxis(cov);
    const ref: V3 = Math.abs(axis[0]) > 0.9 ? [0, 1, 0] : [1, 0, 0];
    const b1 = norm([ref[0] - axis[0] * dot(ref, axis), ref[1] - axis[1] * dot(ref, axis), ref[2] - axis[2] * dot(ref, axis)]);
    const b2 = cross(axis, b1);
    const L = (i: number): V3 => { const p = P(verts[i]); return [p[0] - ctr[0], p[1] - ctr[1], p[2] - ctr[2]]; };

    // ---- edges, boundary loops
    const ekey = (a: number, b: number) => (a < b ? a * nv + b : b * nv + a);
    const ecount = new Map<number, number>();
    const tv = (t: number, e: number) => vid.get(tris[t * 3 + e])!;
    for (const t of ctris) for (let e = 0; e < 3; e++) { const k = ekey(tv(t, e), tv(t, (e + 1) % 3)); ecount.set(k, (ecount.get(k) ?? 0) + 1); }
    const isBoundaryEdge = (a: number, b: number) => ecount.get(ekey(a, b)) === 1;
    const nextB = new Map<number, number[]>();
    for (const t of ctris) for (let e = 0; e < 3; e++) {
      const a = tv(t, e), b = tv(t, (e + 1) % 3);
      if (isBoundaryEdge(a, b)) { const l = nextB.get(a); if (l) l.push(b); else nextB.set(a, [b]); }
    }
    const loops: number[][] = [];
    const usedB = new Set<string>();
    for (const [a0, outs] of nextB) for (const b0 of outs) {
      if (usedB.has(`${a0},${b0}`)) continue;
      const loop: number[] = [];
      let a = a0, b = b0;
      for (let guard = 0; guard < 4 * nv + 8; guard++) {
        usedB.add(`${a},${b}`); loop.push(a);
        if (b === a0) break;
        const nb = (nextB.get(b) ?? []).find((x) => !usedB.has(`${b},${x}`));
        if (nb === undefined) break;
        a = b; b = nb;
      }
      loops.push(loop);
    }
    const ne = ecount.size, chi = nv - ne + ctris.length;
    // handles (thin strips looping back, holes through the part) need no special care: least squares spreads the
    // mismatch around them. Only a closed one can't be opened at its poles.
    const genus = (2 - chi - loops.length) / 2;

    // closed surface (sphere, capsule): drop the fans around the two extremes along the axis, then retry
    if (loops.length === 0) {
      if (poled || genus > 0.25) return 'closed region could not be opened';
      let lo = 0, hi = 0, dlo = Infinity, dhi = -Infinity;
      for (let i = 0; i < nv; i++) { const d = dot(L(i), axis); if (d < dlo) { dlo = d; lo = i; } if (d > dhi) { dhi = d; hi = i; } }
      const kept = ctris.filter((t) => { for (let e = 0; e < 3; e++) { const v = tv(t, e); if (v === lo || v === hi) return false; } return true; });
      return solveComponent(kept, true);
    }

    // ---- wrap: two boundary loops winding around the axis -> periodic, cut between them
    const winding = (loop: number[]) => {
      let s = 0, prev = NaN;
      for (let k = 0; k <= loop.length; k++) {
        const p = L(loop[k % loop.length]);
        const ang = Math.atan2(dot(p, b2), dot(p, b1));
        if (!Number.isNaN(prev)) { let d = ang - prev; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; s += d; }
        prev = ang;
      }
      return Math.round(s / (2 * Math.PI));
    };
    const loopLen = (loop: number[]) => { let s = 0; for (let k = 0; k < loop.length; k++) { const a = L(loop[k]), b = L(loop[(k + 1) % loop.length]); s += Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]); } return s; };
    const wrapLoops = loops.filter((l) => winding(l) !== 0).sort((a, b) => loopLen(b) - loopLen(a));
    const periodic = wrapLoops.length >= 2;
    // corner jump flags (1 = u + T at this corner), per triangle corner of ctris
    const jump = new Map<number, number>(); // t*3+e -> 1
    if (periodic) {
      const isB = new Uint8Array(nv);
      for (const l of loops) for (const v of l) isB[v] = 1;
      const src = new Set(wrapLoops[0]), dst = new Set(wrapLoops[1]);
      // vertex adjacency over interior edges
      const adj: number[][] = Array.from({ length: nv }, () => []);
      for (const t of ctris) for (let e = 0; e < 3; e++) {
        const a = tv(t, e), b = tv(t, (e + 1) % 3);
        if (a < b && !isBoundaryEdge(a, b)) { adj[a].push(b); adj[b].push(a); }
      }
      const dist = new Float64Array(nv).fill(Infinity), prev = new Int32Array(nv).fill(-1);
      const heap: [number, number][] = [];
      const push = (d: number, v: number) => { heap.push([d, v]); let i = heap.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (heap[p][0] <= d) break; [heap[i], heap[p]] = [heap[p], heap[i]]; i = p; } };
      const pop = () => { const top = heap[0], last = heap.pop()!; if (heap.length) { heap[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r; if (m === i) break; [heap[i], heap[m]] = [heap[m], heap[i]]; i = m; } } return top; };
      for (const v of src) { dist[v] = 0; push(0, v); }
      let end = -1;
      while (heap.length) {
        const [d, v] = pop();
        if (d > dist[v]) continue;
        if (dst.has(v)) { end = v; break; }
        if (isB[v] && !src.has(v)) continue; // never walk along / through another boundary
        for (const w of adj[v]) {
          if (src.has(w)) continue;
          const a = L(v), b = L(w);
          const nd = d + Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
          if (nd < dist[w]) { dist[w] = nd; prev[w] = v; push(nd, w); }
        }
      }
      if (end < 0) return 'no cut path around the wrap';
      const path: number[] = [];
      for (let v = end; v >= 0; v = prev[v]) path.push(v);
      path.reverse();
      const pathEdge = new Set<number>();
      for (let k = 0; k + 1 < path.length; k++) pathEdge.add(ekey(path[k], path[k + 1]));
      // triangles left of each directed path edge seed a flood through each path vertex's fan
      const fan = new Map<number, number[]>(); // local vertex -> triangles (ctris) using it
      for (const t of ctris) for (let e = 0; e < 3; e++) { const v = tv(t, e); const l = fan.get(v); if (l) l.push(t); else fan.set(v, [t]); }
      const leftOf = (a: number, b: number) => (fan.get(a) ?? []).find((t) => { for (let e = 0; e < 3; e++) if (tv(t, e) === a && tv(t, (e + 1) % 3) === b) return true; return false; });
      const seeds = new Map<number, number[]>();
      for (let k = 0; k + 1 < path.length; k++) {
        const t = leftOf(path[k], path[k + 1]);
        if (t === undefined) return 'cut path is not consistently oriented';
        for (const v of [path[k], path[k + 1]]) { const l = seeds.get(v); if (l) l.push(t); else seeds.set(v, [t]); }
      }
      for (const v of path) {
        const tri = fan.get(v)!;
        const inFan = new Set(tri), done = new Set<number>();
        const stack = [...(seeds.get(v) ?? [])];
        while (stack.length) {
          const t = stack.pop()!;
          if (done.has(t)) continue;
          done.add(t);
          for (let e = 0; e < 3; e++) if (tv(t, e) === v) jump.set(t * 3 + e, 1);
          // cross the two fan edges (v, x) of t unless they're on the cut or the boundary
          for (let e = 0; e < 3; e++) {
            const a = tv(t, e), b = tv(t, (e + 1) % 3);
            if (a !== v && b !== v) continue;
            const x = a === v ? b : a;
            if (pathEdge.has(ekey(v, x)) || isBoundaryEdge(v, x)) continue;
            for (const o of tri) if (inFan.has(o) && !done.has(o) && o !== t) {
              for (let f = 0; f < 3; f++) { const c = tv(o, f), d = tv(o, (f + 1) % 3); if ((c === v && d === x) || (c === x && d === v)) { stack.push(o); break; } }
            }
          }
        }
      }
    }

    // ---- per-triangle gradient operators in a local orthonormal frame
    const G = new Float64Array(ctris.length * 6); // g_c = (gx, gy) per corner
    const F = new Float64Array(ctris.length * 6); // local frame e1, e2 packed as [e1x,e1y,e1z,e2x,e2y,e2z]
    ctris.forEach((t, i) => {
      const p0 = P(tris[t * 3]), p1 = P(tris[t * 3 + 1]), p2 = P(tris[t * 3 + 2]);
      const n: V3 = [triN[t * 3], triN[t * 3 + 1], triN[t * 3 + 2]];
      const e1 = norm([p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]]), e2 = cross(n, e1);
      const q = [p0, p1, p2].map((p) => [dot([p[0] - p0[0], p[1] - p0[1], p[2] - p0[2]], e1), dot([p[0] - p0[0], p[1] - p0[1], p[2] - p0[2]], e2)]);
      const A2 = 2 * triA[t];
      for (let c = 0; c < 3; c++) {
        const a = q[(c + 1) % 3], b = q[(c + 2) % 3];
        G[i * 6 + c * 2] = -(b[1] - a[1]) / A2; G[i * 6 + c * 2 + 1] = (b[0] - a[0]) / A2;
      }
      F.set([...e1, ...e2], i * 6);
    });

    // ---- cylindrical solve (also the warm start of the unwrap: CG needs far fewer iterations from it)
    const u = new Float64Array(nv), v = new Float64Array(nv);
    let T = 0;
    {
      // v = axial distance (known), unknown u (pin vertex 0) and the jump T if periodic
      for (let i = 0; i < nv; i++) v[i] = dot(L(i), axis);
      const n = nv - 1 + (periodic ? 1 : 0);
      const iu = (k: number) => (k === 0 ? -1 : k - 1), iT = nv - 1;
      const lsq = new LSQ(n);
      ctris.forEach((t, i) => {
        const w = triA[t];
        for (const row of [0, 1]) {
          const cols: number[] = [], coefs: number[] = [];
          let rhs = 0, kT = 0;
          for (let c = 0; c < 3; c++) {
            const gx = G[i * 6 + c * 2], gy = G[i * 6 + c * 2 + 1];
            // conformality rows (∇v = n × ∇u): row 0: Σ v_c gx + u_c gy = 0 ; row 1: Σ v_c gy - u_c gx = 0
            const ku = row === 0 ? gy : -gx, kv = row === 0 ? gx : gy;
            const k = tv(t, c);
            rhs -= kv * v[k];
            cols.push(iu(k)); coefs.push(ku);
            if (jump.get(t * 3 + c)) kT += ku;
          }
          if (periodic) { cols.push(iT); coefs.push(kT); }
          lsq.add(cols, coefs, rhs, w);
        }
      });
      const x = new Float64Array(n);
      if (lsq.solve(x) < 0) return 'solver: disconnected unknowns';
      for (let i = 1; i < nv; i++) u[i] = x[i - 1];
      T = periodic ? x[iT] : 0;
      if (periodic && !(Math.abs(T) > 1e-9)) return 'wrap has no circumference';
    }

    if (mode === 'unwrap') {
      // unknowns: u_i -> i, v_i -> nv + i, minus pins. Periodic: pin vertex 0, jump T = 1 (fixes scale + direction).
      // Open: pin the two vertices farthest apart (approx.) at their 3D distance along u.
      let pinA = 0, pinB = -1;
      const pinVal = new Map<number, number>(); // global unknown -> value
      // warm start = the cylindrical map moved onto the pins by a similarity (complex a·z + b)
      let ar = 1, ai = 0, br = 0, bi = 0;
      if (periodic) {
        pinVal.set(0, 0); pinVal.set(nv, 0);
        ar = 1 / T; br = -ar * u[0]; bi = -ar * v[0];
        T = 1;
      } else {
        let far = 0, fd = -1;
        for (let i = 0; i < nv; i++) { const p = L(i), d = dot(p, p); if (d > fd) { fd = d; far = i; } }
        pinA = far; fd = -1;
        for (let i = 0; i < nv; i++) { const a = L(i), b = L(pinA), d = (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2; if (d > fd) { fd = d; pinB = i; } }
        const D = Math.sqrt(fd);
        pinVal.set(pinA, 0); pinVal.set(nv + pinA, 0); pinVal.set(pinB, D); pinVal.set(nv + pinB, 0);
        const dr = u[pinB] - u[pinA], di = v[pinB] - v[pinA], dd = dr * dr + di * di;
        if (dd > 1e-18) { ar = (D * dr) / dd; ai = (-D * di) / dd; }
        br = -(ar * u[pinA] - ai * v[pinA]); bi = -(ar * v[pinA] + ai * u[pinA]);
      }
      const idx = new Int32Array(2 * nv).fill(-1);
      let n = 0;
      for (let i = 0; i < 2 * nv; i++) if (!pinVal.has(i)) idx[i] = n++;
      const lsq = new LSQ(n);
      ctris.forEach((t, i) => {
        const w = triA[t];
        for (const row of [0, 1]) {
          const cols: number[] = [], coefs: number[] = [];
          let rhs = 0;
          for (let c = 0; c < 3; c++) {
            const gx = G[i * 6 + c * 2], gy = G[i * 6 + c * 2 + 1];
            const ku = row === 0 ? gy : -gx, kv = row === 0 ? gx : gy;
            const k = tv(t, c);
            if (jump.get(t * 3 + c)) rhs -= ku * T;
            for (const [g, kk] of [[k, ku], [nv + k, kv]] as const) {
              const pv = pinVal.get(g);
              if (pv !== undefined) rhs -= kk * pv; else { cols.push(idx[g]); coefs.push(kk); }
            }
          }
          lsq.add(cols, coefs, rhs, w);
        }
      });
      const x = new Float64Array(n);
      for (let i = 0; i < nv; i++) {
        if (idx[i] >= 0) x[idx[i]] = ar * u[i] - ai * v[i] + br;
        if (idx[nv + i] >= 0) x[idx[nv + i]] = ar * v[i] + ai * u[i] + bi;
      }
      if (lsq.solve(x) < 0) return 'solver: disconnected unknowns';
      for (let i = 0; i < nv; i++) {
        u[i] = idx[i] >= 0 ? x[idx[i]] : pinVal.get(i)!;
        v[i] = idx[nv + i] >= 0 ? x[idx[nv + i]] : pinVal.get(nv + i)!;
      }
    }
    for (let i = 0; i < nv; i++) if (!Number.isFinite(u[i]) || !Number.isFinite(v[i])) return 'solver did not converge';

    // ---- per-triangle Jacobians (3D tangent -> uv), scale normalisation, orientation
    const corner = (t: number, c: number): [number, number] => {
      const k = tv(t, c);
      return [u[k] + (jump.get(t * 3 + c) ? T : 0), v[k]];
    };
    const jac = (i: number, t: number, s: number) => {
      let a = 0, b = 0, c = 0, d = 0; // [∇u; ∇v] in the local frame
      for (let k = 0; k < 3; k++) {
        const [uu, vv] = corner(t, k);
        const gx = G[i * 6 + k * 2], gy = G[i * 6 + k * 2 + 1];
        a += uu * gx; b += uu * gy; c += vv * gx; d += vv * gy;
      }
      return [a * s, b * s, c * s, d * s];
    };
    let scale = 1;
    if (mode === 'unwrap') {
      // area-weighted MEDIAN of the local scale sqrt|det J| -> 1 (a mean would let polar blow-up shrink everything)
      const sc: [number, number][] = ctris.map((t, i) => { const [a, b, c, d] = jac(i, t, 1); return [Math.sqrt(Math.abs(a * d - b * c)), triA[t]]; });
      sc.sort((x, y) => x[0] - y[0]);
      let acc = 0;
      for (const [s, a] of sc) { acc += a; if (acc >= area / 2) { scale = s > 0 ? 1 / s : 1; break; } }
    }
    // rotate so the axis runs along +v (periodic: the cut fixes the direction, only flip the sign)
    let dx = 0, dy = 0;
    ctris.forEach((t, i) => {
      const [a, b, c, d] = jac(i, t, scale);
      const e1: V3 = [F[i * 6], F[i * 6 + 1], F[i * 6 + 2]], e2: V3 = [F[i * 6 + 3], F[i * 6 + 4], F[i * 6 + 5]];
      const ax = dot(axis, e1), ay = dot(axis, e2);
      dx += triA[t] * (a * ax + b * ay); dy += triA[t] * (c * ax + d * ay);
    });
    let rc = 1, rs = 0;
    if (mode === 'unwrap') {
      if (periodic) { if (dy < 0) { rc = -1; rs = 0; } }
      else if (Math.hypot(dx, dy) > 1e-9) { const ang = Math.PI / 2 - Math.atan2(dy, dx); rc = Math.cos(ang); rs = Math.sin(ang); }
    }
    const uvOf = (t: number, c: number): [number, number] => {
      const [uu, vv] = corner(t, c);
      const x = uu * scale, y = vv * scale;
      return [rc * x - rs * y, rs * x + rc * y];
    };

    // ---- distortion + per-vertex scale (amplitude fade where the pattern gets squeezed below ~1/2 pitch)
    const vScale = new Float64Array(nv), vArea = new Float64Array(nv);
    const dist: [number, number][] = [];
    ctris.forEach((t, i) => {
      const [a, b, c, d] = jac(i, t, scale);
      // singular values of [[a, b], [c, d]]
      const s1 = a * a + b * b + c * c + d * d, det = Math.abs(a * d - b * c);
      const disc = Math.sqrt(Math.max(0, s1 * s1 - 4 * det * det));
      const smax = Math.sqrt((s1 + disc) / 2), smin = Math.sqrt(Math.max(0, (s1 - disc) / 2));
      dist.push([Math.max(smax, smin > 1e-12 ? 1 / smin : 1e6), triA[t]]);
      const ls = Math.sqrt(det);
      for (let k = 0; k < 3; k++) { const q = tv(t, k); vScale[q] += ls * triA[t]; vArea[q] += triA[t]; }
    });
    for (const t of ctris) {
      out.has[t] = 1;
      for (let c = 0; c < 3; c++) {
        const [uu, vv] = uvOf(t, c);
        out.uv[t * 6 + c * 2] = uu; out.uv[t * 6 + c * 2 + 1] = vv;
        const q = tv(t, c), s = vArea[q] > 0 ? vScale[q] / vArea[q] : 1;
        out.amp[t * 3 + c] = 1 - smooth01((s - 2) / 2);
      }
    }
    return { dist, area, circ: periodic ? Math.abs(T * scale) : 0 };
  }
}
