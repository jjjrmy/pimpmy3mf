// Trace the working grid into per-color closed rings (replaces shapely). Builds the planar graph of
// cell-boundary edges, cuts it into chains between junctions, smooths + simplifies each chain once
// (so a border shared by two colors is the SAME line on both sides), then assembles rings per color.
// Mirrors the design of img2color.py `trace` / `smooth_coverage` / `coverage_simplify`.

export const OUTSIDE = -2;
export const TRANSPARENT = -1;

interface TraceOptions {
  grid: Int32Array;
  ny: number;
  nx: number;
  ncolors: number;
  smooth: boolean;
}

interface Chain {
  xs: Float64Array;
  ys: Float64Array;
  vids: Int32Array; // corner id per point (endpoints used for linking)
  L: number; // color on the left when walked forward
  R: number; // color on the right
  closed: boolean;
  pinned: Uint8Array; // frame or endpoint -> not moved by smoothing
}

/** Returns a map color-index -> list of mm-space rings (flat not needed; arrays of {x,y}). */
export function trace(opts: TraceOptions): Map<number, { x: Float64Array; y: Float64Array }[]> {
  const { grid, ny, nx, smooth } = opts;
  const cornW = nx + 1;
  const labelOf = (r: number, c: number) => (r < 0 || r >= ny || c < 0 || c >= nx ? OUTSIDE : grid[r * nx + c]);
  const vid = (i: number, j: number) => i * cornW + j;

  // ---- 1. boundary edges (canonical direction), adjacency, degree
  const ea: number[] = [], eb: number[] = [], eL: number[] = [], eR: number[] = [];
  const adj = new Map<number, number[]>();
  const pushEdge = (a: number, b: number, L: number, R: number) => {
    const idx = ea.length;
    ea.push(a); eb.push(b); eL.push(L); eR.push(R);
    let la = adj.get(a); if (!la) { la = []; adj.set(a, la); } la.push(idx);
    let lb = adj.get(b); if (!lb) { lb = []; adj.set(b, lb); } lb.push(idx);
  };
  // vertical edges: (i,j)->(i+1,j), left=col j-1, right=col j
  for (let j = 0; j <= nx; j++) {
    for (let i = 0; i < ny; i++) {
      const L = labelOf(i, j - 1), R = labelOf(i, j);
      if (L !== R) pushEdge(vid(i, j), vid(i + 1, j), L, R);
    }
  }
  // horizontal edges: (i,j)->(i,j+1), left=row i, right=row i-1
  for (let i = 0; i <= ny; i++) {
    for (let j = 0; j < nx; j++) {
      const L = labelOf(i, j), R = labelOf(i - 1, j);
      if (L !== R) pushEdge(vid(i, j), vid(i, j + 1), L, R);
    }
  }
  const nE = ea.length;
  const degree = new Map<number, number>();
  for (const [v, list] of adj) degree.set(v, list.length);

  const cornX = (v: number) => v % cornW;
  const cornY = (v: number) => (v - (v % cornW)) / cornW;
  const isFrame = (v: number) => {
    const x = cornX(v), y = cornY(v);
    return x === 0 || x === nx || y === 0 || y === ny;
  };

  // ---- 2+3. chains between junctions, then closed loops
  const used = new Uint8Array(nE);
  const chains: Chain[] = [];
  const other = (e: number, v: number) => (ea[e] === v ? eb[e] : ea[e]);

  const makeChain = (vids: number[], L: number, R: number, closed: boolean): Chain => {
    const n = vids.length;
    const xs = new Float64Array(n), ys = new Float64Array(n), ids = new Int32Array(n);
    const pinned = new Uint8Array(n);
    for (let p = 0; p < n; p++) {
      const v = vids[p];
      xs[p] = cornX(v); ys[p] = cornY(v); ids[p] = v;
      pinned[p] = isFrame(v) ? 1 : 0;
    }
    if (!closed) { pinned[0] = 1; pinned[n - 1] = 1; }
    return { xs, ys, vids: ids, L, R, closed, pinned };
  };

  const walkFrom = (startV: number, startEdge: number): void => {
    used[startEdge] = 1;
    const fromCanon = ea[startEdge] === startV;
    const L = fromCanon ? eL[startEdge] : eR[startEdge];
    const R = fromCanon ? eR[startEdge] : eL[startEdge];
    const vids = [startV];
    let prev = startEdge;
    let cur = other(startEdge, startV);
    vids.push(cur);
    while ((degree.get(cur) || 0) === 2 && cur !== startV) {
      const list = adj.get(cur)!;
      const e2 = list[0] === prev ? list[1] : list[0];
      if (used[e2]) break;
      used[e2] = 1;
      const nxt = other(e2, cur);
      vids.push(nxt);
      prev = e2; cur = nxt;
    }
    chains.push(makeChain(vids, L, R, cur === startV));
  };

  // open chains from junctions
  for (const [v, list] of adj) {
    if ((degree.get(v) || 0) === 2) continue;
    for (const e of list) if (!used[e]) walkFrom(v, e);
  }
  // remaining edges form pure closed loops (all degree 2)
  for (let e = 0; e < nE; e++) {
    if (used[e]) continue;
    const startV = ea[e];
    used[e] = 1;
    const fromCanon = true;
    const L = eL[e], R = eR[e];
    const vids = [startV];
    let prev = e;
    let cur = eb[e];
    vids.push(cur);
    while (cur !== startV) {
      const list = adj.get(cur)!;
      const e2 = list[0] === prev ? list[1] : list[0];
      if (used[e2]) break;
      used[e2] = 1;
      const nxt = other(e2, cur);
      vids.push(nxt);
      prev = e2; cur = nxt;
    }
    void fromCanon;
    chains.push(makeChain(vids, L, R, true));
  }

  // ---- 4. smoothing (per chain), with frame/endpoint pinning + ±0.45 clamp
  if (smooth) for (const ch of chains) smoothChain(ch);

  // ---- 5. Douglas-Peucker simplification, then crossing-safe revert loop
  const tol = smooth ? 0.5 : 0.01;
  const simp: { xs: Float64Array; ys: Float64Array }[] = chains.map((ch) => simplifyChain(ch, tol));
  resolveCrossings(chains, simp, tol);

  // ---- 6. rings per color
  return assembleRings(chains, simp, opts);
}

// --------------------------------------------------------------------------------- smoothing
const SIGMA = 1.5;

function gaussKernel1d(sigma: number): Float64Array {
  const r = Math.floor(4 * sigma + 0.5);
  const k = new Float64Array(2 * r + 1);
  let s = 0;
  for (let i = -r; i <= r; i++) { const v = Math.exp((-0.5 / (sigma * sigma)) * i * i); k[i + r] = v; s += v; }
  for (let i = 0; i < k.length; i++) k[i] /= s;
  return k;
}
const GK = gaussKernel1d(SIGMA);
const GKR = (GK.length - 1) / 2;

/** 1D gaussian convolution of a padded array edge-handled by `mode`. */
function conv1d(a: Float64Array, mode: 'wrap' | 'nearest'): Float64Array {
  const n = a.length;
  const out = new Float64Array(n);
  for (let q = 0; q < n; q++) {
    let acc = 0;
    for (let t = -GKR; t <= GKR; t++) {
      let i = q + t;
      if (mode === 'wrap') i = ((i % n) + n) % n;
      else i = i < 0 ? 0 : i >= n ? n - 1 : i;
      acc += a[i] * GK[t + GKR];
    }
    out[q] = acc;
  }
  return out;
}

function smoothChain(ch: Chain): void {
  const n = ch.xs.length;
  if (n < 4) return;
  const ox = ch.xs.slice(), oy = ch.ys.slice();
  let sx: Float64Array, sy: Float64Array;
  if (ch.closed) {
    // operate on the n-1 distinct points, wrap, re-append
    const m = n - 1;
    const px = ch.xs.slice(0, m), py = ch.ys.slice(0, m);
    const qx = conv1d(px, 'wrap'), qy = conv1d(py, 'wrap');
    sx = new Float64Array(n); sy = new Float64Array(n);
    sx.set(qx); sy.set(qy); sx[m] = qx[0]; sy[m] = qy[0];
  } else {
    // odd-reflect pad by r, gaussian (nearest), crop, force endpoints
    const r = Math.floor(3 * SIGMA + 0.5); // 5
    const padX = oddReflectPad(ox, r), padY = oddReflectPad(oy, r);
    const cx = conv1d(padX, 'nearest'), cy = conv1d(padY, 'nearest');
    sx = cx.slice(r, r + n); sy = cy.slice(r, r + n);
    sx[0] = ox[0]; sy[0] = oy[0]; sx[n - 1] = ox[n - 1]; sy[n - 1] = oy[n - 1];
  }
  // pin frame/endpoint points, then clamp displacement to ±0.45 per axis
  for (let p = 0; p < n; p++) {
    if (ch.pinned[p]) { sx[p] = ox[p]; sy[p] = oy[p]; continue; }
    sx[p] = clamp(sx[p], ox[p] - 0.45, ox[p] + 0.45);
    sy[p] = clamp(sy[p], oy[p] - 0.45, oy[p] + 0.45);
  }
  ch.xs = sx; ch.ys = sy;
}

function oddReflectPad(a: Float64Array, r: number): Float64Array {
  const n = a.length;
  const out = new Float64Array(n + 2 * r);
  for (let i = 0; i < n; i++) out[r + i] = a[i];
  for (let i = 1; i <= r; i++) {
    out[r - i] = 2 * a[0] - a[Math.min(i, n - 1)];
    out[r + n - 1 + i] = 2 * a[n - 1] - a[Math.max(0, n - 1 - i)];
  }
  return out;
}

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

// ------------------------------------------------------------------- Douglas-Peucker simplify
function simplifyChain(ch: Chain, tol: number): { xs: Float64Array; ys: Float64Array } {
  const n = ch.xs.length;
  if (n <= 2) return { xs: ch.xs.slice(), ys: ch.ys.slice() };
  const keep = new Uint8Array(n);
  keep[0] = 1; keep[n - 1] = 1;
  const stack: [number, number][] = [[0, n - 1]];
  const xs = ch.xs, ys = ch.ys;
  while (stack.length) {
    const [a, b] = stack.pop()!;
    if (b <= a + 1) continue;
    const ax = xs[a], ay = ys[a], bx = xs[b], by = ys[b];
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let maxD = -1, maxI = -1;
    for (let i = a + 1; i < b; i++) {
      let d: number;
      if (len2 === 0) { const ex = xs[i] - ax, ey = ys[i] - ay; d = Math.sqrt(ex * ex + ey * ey); }
      else { d = Math.abs((xs[i] - ax) * dy - (ys[i] - ay) * dx) / Math.sqrt(len2); }
      if (d > maxD) { maxD = d; maxI = i; }
    }
    if (maxD > tol) { keep[maxI] = 1; stack.push([a, maxI]); stack.push([maxI, b]); }
  }
  let cnt = 0; for (let i = 0; i < n; i++) if (keep[i]) cnt++;
  const ox = new Float64Array(cnt), oy = new Float64Array(cnt);
  let p = 0; for (let i = 0; i < n; i++) if (keep[i]) { ox[p] = xs[i]; oy[p] = ys[i]; p++; }
  return { xs: ox, ys: oy };
}

// ------------------------------------------------------------------- crossing verification
function resolveCrossings(
  chains: Chain[],
  simp: { xs: Float64Array; ys: Float64Array }[],
  _tol: number,
): void {
  for (let iter = 0; iter < 8; iter++) {
    const bad = findCrossingChains(simp);
    if (bad.size === 0) break;
    for (const ci of bad) simp[ci] = { xs: chains[ci].xs.slice(), ys: chains[ci].ys.slice() };
    if (iter === 7) {
      // last resort: revert everything still crossing to unsimplified (already done above)
    }
  }
}

/** Returns the set of chain indices involved in a proper crossing. Spatial hash on segment cells. */
function findCrossingChains(simp: { xs: Float64Array; ys: Float64Array }[]): Set<number> {
  const bad = new Set<number>();
  // build buckets keyed by integer cell; store [chainIdx, segIdx]
  const buckets = new Map<number, number[]>();
  const segChain: number[] = [];
  const segA: number[] = []; // index into flat coords via chain/seg lookup — store coords directly
  const segData: { ci: number; x1: number; y1: number; x2: number; y2: number }[] = [];
  const bucketKey = (cx: number, cy: number) => cx * 73856093 + cy * 19349663;
  for (let ci = 0; ci < simp.length; ci++) {
    const { xs, ys } = simp[ci];
    for (let s = 0; s + 1 < xs.length; s++) {
      const si = segData.length;
      segData.push({ ci, x1: xs[s], y1: ys[s], x2: xs[s + 1], y2: ys[s + 1] });
      const minx = Math.floor(Math.min(xs[s], xs[s + 1])), maxx = Math.floor(Math.max(xs[s], xs[s + 1]));
      const miny = Math.floor(Math.min(ys[s], ys[s + 1])), maxy = Math.floor(Math.max(ys[s], ys[s + 1]));
      for (let cx = minx; cx <= maxx; cx++) for (let cy = miny; cy <= maxy; cy++) {
        const key = bucketKey(cx, cy);
        let arr = buckets.get(key); if (!arr) { arr = []; buckets.set(key, arr); } arr.push(si);
      }
      segChain.push(ci); segA.push(si);
    }
  }
  for (const arr of buckets.values()) {
    for (let a = 0; a < arr.length; a++) for (let b = a + 1; b < arr.length; b++) {
      const s1 = segData[arr[a]], s2 = segData[arr[b]];
      if (properCross(s1.x1, s1.y1, s1.x2, s1.y2, s2.x1, s2.y1, s2.x2, s2.y2)) {
        bad.add(s1.ci); bad.add(s2.ci);
      }
    }
  }
  return bad;
}

const orient = (ax: number, ay: number, bx: number, by: number, cx: number, cy: number) =>
  (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);

/** True only for a proper interior crossing (shared endpoints / mere touching are allowed). */
function properCross(ax: number, ay: number, bx: number, by: number, cx: number, cy: number, dx: number, dy: number): boolean {
  // shared endpoints are legal junction meetings
  const eq = (x1: number, y1: number, x2: number, y2: number) => Math.abs(x1 - x2) < 1e-9 && Math.abs(y1 - y2) < 1e-9;
  if (eq(ax, ay, cx, cy) || eq(ax, ay, dx, dy) || eq(bx, by, cx, cy) || eq(bx, by, dx, dy)) return false;
  const d1 = orient(cx, cy, dx, dy, ax, ay);
  const d2 = orient(cx, cy, dx, dy, bx, by);
  const d3 = orient(ax, ay, bx, by, cx, cy);
  const d4 = orient(ax, ay, bx, by, dx, dy);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;
  // vertex strictly inside the other segment (T-junction)
  const onSeg = (px: number, py: number, qx: number, qy: number, rx: number, ry: number) =>
    Math.abs(orient(px, py, qx, qy, rx, ry)) < 1e-9 &&
    rx > Math.min(px, qx) - 1e-9 && rx < Math.max(px, qx) + 1e-9 &&
    ry > Math.min(py, qy) - 1e-9 && ry < Math.max(py, qy) + 1e-9;
  const strictlyInside = (px: number, py: number, qx: number, qy: number, rx: number, ry: number) =>
    onSeg(px, py, qx, qy, rx, ry) && !eq(px, py, rx, ry) && !eq(qx, qy, rx, ry);
  if (strictlyInside(ax, ay, bx, by, cx, cy) || strictlyInside(ax, ay, bx, by, dx, dy)) return true;
  if (strictlyInside(cx, cy, dx, dy, ax, ay) || strictlyInside(cx, cy, dx, dy, bx, by)) return true;
  return false;
}

// -------------------------------------------------------------------------- ring assembly
function assembleRings(
  chains: Chain[],
  simp: { xs: Float64Array; ys: Float64Array }[],
  opts: TraceOptions,
): Map<number, { x: Float64Array; y: Float64Array }[]> {
  const out = new Map<number, { x: Float64Array; y: Float64Array }[]>();
  for (let k = 0; k < opts.ncolors; k++) {
    const rings: { x: Float64Array; y: Float64Array }[] = [];
    // oriented open chains (k on left) keyed by start vid; closed chains emitted directly
    const openByStart = new Map<number, number[]>(); // start vid -> oriented-chain record indices
    const recs: { ci: number; rev: boolean; startV: number; endV: number }[] = [];
    for (let ci = 0; ci < chains.length; ci++) {
      const ch = chains[ci];
      const hasL = ch.L === k, hasR = ch.R === k;
      if (!hasL && !hasR) continue;
      const rev = hasR; // if color is on the right, reverse so it's on the left
      if (ch.closed) {
        rings.push(orientedPoints(simp[ci], rev));
        continue;
      }
      const vids = ch.vids;
      const startV = rev ? vids[vids.length - 1] : vids[0];
      const endV = rev ? vids[0] : vids[vids.length - 1];
      const ri = recs.length;
      recs.push({ ci, rev, startV, endV });
      let a = openByStart.get(startV); if (!a) { a = []; openByStart.set(startV, a); } a.push(ri);
    }
    const usedRec = new Uint8Array(recs.length);
    for (let start = 0; start < recs.length; start++) {
      if (usedRec[start]) continue;
      const rx: number[] = [], ry: number[] = [];
      let cur = start;
      const loopStart = recs[start].startV;
      let safe = 0;
      while (cur >= 0 && !usedRec[cur] && safe++ < recs.length + 1) {
        usedRec[cur] = 1;
        const pts = orientedPoints(simp[recs[cur].ci], recs[cur].rev);
        const skip = rx.length > 0 ? 1 : 0; // drop shared vertex
        for (let p = skip; p < pts.x.length; p++) { rx.push(pts.x[p]); ry.push(pts.y[p]); }
        const v = recs[cur].endV;
        if (v === loopStart) break;
        const cand = openByStart.get(v);
        let next = -1;
        if (cand) for (const ri of cand) if (!usedRec[ri]) { next = ri; break; }
        cur = next;
      }
      // drop duplicate closing point if present
      if (rx.length >= 2 && Math.abs(rx[0] - rx[rx.length - 1]) < 1e-9 && Math.abs(ry[0] - ry[ry.length - 1]) < 1e-9) {
        rx.pop(); ry.pop();
      }
      if (rx.length >= 3) rings.push({ x: Float64Array.from(rx), y: Float64Array.from(ry) });
    }
    if (rings.length) out.set(k, rings);
  }
  return out;
}

function orientedPoints(seg: { xs: Float64Array; ys: Float64Array }, rev: boolean): { x: Float64Array; y: Float64Array } {
  const n = seg.xs.length;
  const x = new Float64Array(n), y = new Float64Array(n);
  if (rev) for (let i = 0; i < n; i++) { x[i] = seg.xs[n - 1 - i]; y[i] = seg.ys[n - 1 - i]; }
  else { x.set(seg.xs); y.set(seg.ys); }
  return { x, y };
}
