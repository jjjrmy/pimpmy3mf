// Texture stretch validator: does a face texture keep its pitch (mm along the surface) all the way around curved
// regions? Builds round/oval/rounded-rect/cone/sphere/capsule shapes with manifold (off-origin), selects the curved
// side the way the Texture face tool does (smoothRegion from a +x click), applies 'ridges' (pitch 3, height 0.5)
// through applyTextures, then measures the relief on the OUTPUT mesh: a plane section of the textured mesh is
// matched to the same section of the original (arc length s, signed offset d), and the ridge spacing is measured
// per sector (front = the clicked +x side at 0°, sides at 90°/270°, back at 180°, ±30° windows).
//   ring  : ridges along the axis (rotation 0), section ⊥ axis  -> circumferential pitch
//   axial : ridges around (rotation 90), section through the axis -> axial pitch (front and side meridians)
//
//   bun scripts/validate-texture-stretch.ts                    # all shapes, every mapping (HEAD: its own)
//   bun scripts/validate-texture-stretch.ts ellipse grip       # some shapes
//   MAPPINGS=auto bun scripts/validate-texture-stretch.ts      # only these mappings
//   LABEL=before bun scripts/validate-texture-stretch.ts       # tag for the JSON/STL output
//
// The user's grip (scratch/user/tailgunner-grip.stl) is used when present. Output: scratch/stretch/.
// Exit 1 when a developable shape (cylinder, ellipse, rounded rect, cone) under auto deviates > 10 % around a ring.
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Manifold as ManifoldT } from 'manifold-3d';
import { initManifold } from '../src/core/manifold';
import { applyTextures, textureStats } from '../src/core/texture';
import { buildAdjacency, smoothRegion, triNormal } from '../src/core/faces';
import { loadMesh, writeStl } from '../src/core/meshio';
import type { FaceTexture, Mesh, Model } from '../src/core/types';

const ROOT = resolve(import.meta.dir, '..');
const OUT = `${ROOT}/scratch/stretch`;
const GRIP = `${ROOT}/scratch/user/tailgunner-grip.stl`;
const LABEL = process.env.LABEL ?? 'run';
const PITCH = 3, HEIGHT = 0.5;
const args = process.argv.slice(2);
const want = (c: string) => args.length === 0 || args.includes(c);
mkdirSync(OUT, { recursive: true });
const wasm = await initManifold();

type V = [number, number, number];
const sub = (a: V, b: V): V => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V, b: V) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V, b: V): V => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const nrm = (a: V): V => { const l = Math.hypot(...a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

// ------------------------------------------------------------------------------------ shapes

const OFF: V = [120, 80, 30];
function toMesh(man: ManifoldT): Mesh {
  const m = man.translate(OFF);
  const gm = m.getMesh();
  const np = gm.numProp, nv = gm.vertProperties.length / np;
  const vertices = new Float32Array(nv * 3);
  for (let i = 0; i < nv; i++) for (let k = 0; k < 3; k++) vertices[i * 3 + k] = gm.vertProperties[i * np + k];
  m.delete(); man.delete();
  return { vertices, triangles: new Uint32Array(gm.triVerts) };
}

interface Shape {
  name: string; mesh: Mesh; developable: boolean;
  /** Region pick: smoothRegion from the +x-most triangle, optionally filtered (e.g. a drag-painted cap). */
  filter?: (c: V) => boolean;
  axis: V; center: V;
  /** Ring sections: offsets along the axis from center. Axial windows: [lo, hi] along the axis. */
  rings: { at: number; tag: string }[];
  axial: [number, number];
}

function shapes(): Shape[] {
  const M = wasm.Manifold;
  const z: V = [0, 0, 1];
  const c = (h: number): V => [OFF[0], OFF[1], OFF[2] + h];
  const out: Shape[] = [];
  if (want('cylinder')) out.push({ name: 'cylinder r20', developable: true, mesh: toMesh(M.cylinder(60, 20, 20, 96)), axis: z, center: c(30), rings: [{ at: 0, tag: 'mid' }], axial: [-18, 18] });
  if (want('ellipse')) out.push({ name: 'ellipse 40x25', developable: true, mesh: toMesh(M.cylinder(60, 1, 1, 128).scale([20, 12.5, 1])), axis: z, center: c(30), rings: [{ at: 0, tag: 'mid' }], axial: [-18, 18] });
  if (want('rrect')) {
    const parts = [[10, 2.5], [-10, 2.5], [10, -2.5], [-10, -2.5]].map(([x, y]) => M.cylinder(60, 10, 10, 64).translate([x, y, 0]));
    const h = M.hull(parts); parts.forEach((p) => p.delete());
    out.push({ name: 'rounded rect 40x25 r10', developable: true, mesh: toMesh(h), axis: z, center: c(30), rings: [{ at: 0, tag: 'mid' }], axial: [-18, 18] });
  }
  if (want('cone')) out.push({ name: 'cone r20->r14', developable: true, mesh: toMesh(M.cylinder(60, 20, 14, 96)), axis: z, center: c(30), rings: [{ at: 0, tag: 'mid' }, { at: -20, tag: 'low' }, { at: 20, tag: 'high' }], axial: [-18, 18] });
  if (want('sphere')) out.push({ name: 'sphere r20 (whole)', developable: false, mesh: toMesh(M.sphere(20, 96)), axis: z, center: c(0), rings: [{ at: 0, tag: 'equator' }, { at: 10, tag: 'lat30' }], axial: [-12, 12] });
  if (want('spherecap')) out.push({ name: 'sphere r20 (upper cap)', developable: false, mesh: toMesh(M.sphere(20, 96)), filter: (p) => p[2] > OFF[2] + 2, axis: z, center: c(0), rings: [{ at: 10, tag: 'lat30' }], axial: [6, 16] });
  if (want('capsule')) {
    const a = M.sphere(15, 96).translate([0, 0, -20]), b = M.sphere(15, 96).translate([0, 0, 20]);
    const h = M.hull([a, b]); a.delete(); b.delete();
    out.push({ name: 'capsule r15 x70', developable: false, mesh: toMesh(h), axis: z, center: c(0), rings: [{ at: 0, tag: 'mid' }, { at: 20 + 15 * Math.SQRT1_2, tag: 'cap45' }], axial: [-15, 15] });
  }
  if (want('grip') && existsSync(GRIP)) {
    const mesh = loadMesh(new Uint8Array(readFileSync(GRIP)), 'grip.stl');
    // the wrap-around side panel (smooth region seeded on the grip's +x side); its axis from the normals
    const sel = pickRegion(mesh, [1, 0, 0]);
    const { axis, center } = regionFrame(mesh, sel);
    out.push({ name: 'user grip (side panel)', developable: false, mesh, axis, center, rings: [{ at: 0, tag: 'mid' }, { at: -12, tag: 'low' }, { at: 12, tag: 'high' }], axial: [-15, 15] });
  }
  return out;
}

function bestTri(mesh: Mesh, dir: V): number {
  let best = -1, bd = -Infinity;
  for (let t = 0; t < mesh.triangles.length / 3; t++) {
    const { n, area } = triNormal(mesh, t);
    if (!area) continue;
    const d = n[0] * dir[0] + n[1] * dir[1] + n[2] * dir[2];
    if (d > bd) { bd = d; best = t; }
  }
  return best;
}

function triCentroid(mesh: Mesh, t: number): V {
  const v = mesh.vertices, T = mesh.triangles, c: V = [0, 0, 0];
  for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) c[k] += v[T[t * 3 + j] * 3 + k] / 3;
  return c;
}

function pickRegion(mesh: Mesh, dir: V, filter?: (c: V) => boolean): number[] {
  const r = smoothRegion(mesh, buildAdjacency(mesh), bestTri(mesh, dir))!;
  return filter ? r.triangles.filter((t) => filter(triCentroid(mesh, t))) : r.triangles;
}

/** Region axis = least-varying normal direction (Jacobi on Σ a n nᵀ), centre = area centroid. */
function regionFrame(mesh: Mesh, tris: number[]): { axis: V; center: V } {
  const cov = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  const c: V = [0, 0, 0];
  let A = 0;
  for (const t of tris) {
    const { n, area } = triNormal(mesh, t);
    const p = triCentroid(mesh, t);
    for (let i = 0; i < 3; i++) { c[i] += area * p[i]; for (let j = 0; j < 3; j++) cov[i * 3 + j] += area * n[i] * n[j]; }
    A += area;
  }
  // power iteration on (tr·I - cov) for the smallest eigenvector
  const tr = cov[0] + cov[4] + cov[8];
  let x: V = [0.3, 0.5, 0.8];
  for (let it = 0; it < 500; it++) {
    const y: V = [0, 0, 0];
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) y[i] += ((i === j ? tr : 0) - cov[i * 3 + j]) * x[j];
    x = nrm(y);
  }
  if (x[2] < 0) x = [-x[0], -x[1], -x[2]];
  return { axis: x, center: [c[0] / A, c[1] / A, c[2] / A] };
}

// ------------------------------------------------------------------------------------ sections

interface Seg { a: V; b: V; n: V } // n: source triangle normal

function section(mesh: Mesh, pn: V, pd: number): Seg[] {
  const v = mesh.vertices, T = mesh.triangles, out: Seg[] = [];
  const P = (i: number): V => [v[i * 3], v[i * 3 + 1], v[i * 3 + 2]];
  for (let t = 0; t < T.length / 3; t++) {
    const p = [P(T[t * 3]), P(T[t * 3 + 1]), P(T[t * 3 + 2])];
    const d = p.map((q) => dot(q, pn) - pd);
    const pts: V[] = [];
    for (let e = 0; e < 3; e++) {
      const d0 = d[e], d1 = d[(e + 1) % 3];
      if ((d0 < 0) !== (d1 < 0)) {
        const f = d0 / (d0 - d1), q0 = p[e], q1 = p[(e + 1) % 3];
        pts.push([q0[0] + (q1[0] - q0[0]) * f, q0[1] + (q1[1] - q0[1]) * f, q0[2] + (q1[2] - q0[2]) * f]);
      }
    }
    if (pts.length === 2) out.push({ a: pts[0], b: pts[1], n: nrm(cross(sub(p[1], p[0]), sub(p[2], p[0]))) });
  }
  return out;
}

/** Chains the original section into polylines with cumulative arc length (loops get separate s ranges). */
function chain(segs: Seg[]): { a: V; b: V; n: V; s0: number; len: number }[] {
  const key = (p: V) => `${Math.round(p[0] * 1e4)},${Math.round(p[1] * 1e4)},${Math.round(p[2] * 1e4)}`;
  const byStart = new Map<string, number[]>();
  segs.forEach((s, i) => { for (const k of [key(s.a), key(s.b)]) { const l = byStart.get(k); if (l) l.push(i); else byStart.set(k, [i]); } });
  const used = new Uint8Array(segs.length);
  const out: { a: V; b: V; n: V; s0: number; len: number }[] = [];
  let s = 0;
  for (let i0 = 0; i0 < segs.length; i0++) {
    if (used[i0]) continue;
    let cur = i0, from = segs[i0].a;
    for (;;) {
      used[cur] = 1;
      const sg = segs[cur];
      const fwd = key(sg.a) === key(from);
      const a = fwd ? sg.a : sg.b, b = fwd ? sg.b : sg.a;
      const len = Math.hypot(...sub(b, a));
      out.push({ a, b, n: sg.n, s0: s, len });
      s += len;
      const nxt = (byStart.get(key(b)) ?? []).find((j) => !used[j]);
      if (nxt === undefined) break;
      cur = nxt; from = b;
    }
    s += 1000; // gap between loops
  }
  return out;
}

interface Sample { s: number; d: number; p: V }

function signal(orig: Mesh, tex: Mesh, pn: V, pd: number): Sample[] {
  const base = chain(section(orig, pn, pd));
  const out: Sample[] = [];
  for (const sg of section(tex, pn, pd)) {
    for (const q of [sg.a, sg.b]) {
      let best = Infinity, bs = 0, bd = 0, bp: V = q;
      for (const b of base) {
        const ab = sub(b.b, b.a), L2 = dot(ab, ab) || 1e-12;
        const f = Math.max(0, Math.min(1, dot(sub(q, b.a), ab) / L2));
        const foot: V = [b.a[0] + ab[0] * f, b.a[1] + ab[1] * f, b.a[2] + ab[2] * f];
        const r = sub(q, foot), dist = Math.hypot(...r);
        if (dist < best) { best = dist; bs = b.s0 + f * b.len; bd = Math.sign(dot(r, b.n)) * dist; bp = foot; }
      }
      out.push({ s: bs, d: bd, p: bp });
    }
  }
  return out;
}

/** Ridge spacing (mm along the original surface) from the up/down crossings of d through the window's mid level. */
function pitchOf(samples: Sample[]): { pitch: number; n: number; stretched: boolean } | null {
  if (samples.length < 20) return null;
  let ss = samples.slice().sort((a, b) => a.s - b.s);
  // windows that straddle s = 0 of a loop: rotate at the largest gap
  let gi = -1, gap = 0;
  for (let i = 1; i < ss.length; i++) if (ss[i].s - ss[i - 1].s > gap) { gap = ss[i].s - ss[i - 1].s; gi = i; }
  if (gap > 4 * PITCH) {
    const shift = ss[ss.length - 1].s - ss[0].s + 1;
    ss = ss.slice(gi).concat(ss.slice(0, gi).map((x) => ({ ...x, s: x.s + shift })));
    ss.sort((a, b) => a.s - b.s);
  }
  let lo = Infinity, hi = -Infinity;
  for (const x of ss) { if (x.d < lo) lo = x.d; if (x.d > hi) hi = x.d; }
  if (hi - lo < HEIGHT * 0.3) return null; // no relief here
  const mid = (lo + hi) / 2;
  // contiguous runs of the section (a window can hold pieces of several loops); ridge spacings only within a run
  let sum = 0, cnt = 0, longest = 0, runStart = ss[0].s, peaks = 0;
  let up = NaN, last = NaN;
  for (let i = 1; i <= ss.length; i++) {
    const a = ss[i - 1], b = ss[i];
    if (!b || b.s - a.s > 1.5) { longest = Math.max(longest, a.s - runStart); if (b) runStart = b.s; up = NaN; last = NaN; continue; }
    const x = a.s + ((mid - a.d) / ((b.d - a.d) || 1e-12)) * (b.s - a.s);
    if (a.d < mid && b.d >= mid) up = x;
    else if (a.d >= mid && b.d < mid && !Number.isNaN(up)) {
      const pk = (up + x) / 2;
      peaks++;
      if (!Number.isNaN(last)) { sum += pk - last; cnt++; }
      last = pk; up = NaN;
    }
  }
  // relief but (almost) no ridges across the window: stretched past it; report the lower bound run / ridges
  if (cnt < 2) return { pitch: longest / Math.max(1, peaks), n: peaks, stretched: true };
  return { pitch: sum / cnt, n: peaks, stretched: false };
}

function frame(axis: V): [V, V] {
  const ref: V = Math.abs(axis[0]) > 0.9 ? [0, 1, 0] : [1, 0, 0];
  const e1 = nrm(sub(ref, axis.map((x) => x * dot(ref, axis)) as V));
  return [e1, cross(axis, e1)];
}

/** Stretched-past-the-window lower bounds are stored negative ('>x' in the table). */
const enc = (r: ReturnType<typeof pitchOf>) => (r ? (r.stretched ? -r.pitch : r.pitch) : null);

const SECTORS = [{ tag: 'front', a: 0 }, { tag: 'side90', a: 90 }, { tag: 'back', a: 180 }, { tag: 'side270', a: 270 }];

/** Overwrites c with the length-weighted centroid of the longest loop of the original section (sector angles). */
function ringCenter(orig: Mesh, pn: V, pd: number, c: V): void {
  const ch = chain(section(orig, pn, pd));
  const loops: (typeof ch)[] = [];
  for (const sg of ch) { const l = loops[loops.length - 1]; if (l && Math.abs(l[l.length - 1].s0 + l[l.length - 1].len - sg.s0) < 1e-6) l.push(sg); else loops.push([sg]); }
  const best = loops.sort((a, b) => b.reduce((s, x) => s + x.len, 0) - a.reduce((s, x) => s + x.len, 0))[0];
  if (!best) return;
  let L = 0; const m: V = [0, 0, 0];
  for (const sg of best) for (let k = 0; k < 3; k++) { m[k] += ((sg.a[k] + sg.b[k]) / 2) * sg.len; }
  for (const sg of best) L += sg.len;
  for (let k = 0; k < 3; k++) c[k] = m[k] / L;
}

function ringPitch(sh: Shape, orig: Mesh, tex: Mesh, at: number, front: V): Record<string, number | null> {
  const c: V = [sh.center[0] + sh.axis[0] * at, sh.center[1] + sh.axis[1] * at, sh.center[2] + sh.axis[2] * at];
  const sig = signal(orig, tex, sh.axis, dot(c, sh.axis) + 1.234e-4);
  ringCenter(orig, sh.axis, dot(c, sh.axis) + 1.234e-4, c);
  const e1 = front, e2 = cross(sh.axis, e1);
  const out: Record<string, number | null> = {};
  for (const sec of SECTORS) {
    const w = sig.filter((x) => {
      const r = sub(x.p, c);
      const ang = (Math.atan2(dot(r, e2), dot(r, e1)) * 180) / Math.PI;
      let dd = Math.abs(((ang - sec.a) % 360 + 540) % 360 - 180);
      return dd <= 30;
    });
    out[sec.tag] = enc(pitchOf(w));
  }
  return out;
}

function axialPitch(sh: Shape, orig: Mesh, tex: Mesh, front: V): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  const e1 = front, e2 = cross(sh.axis, e1);
  for (const sec of SECTORS) {
    const a = (sec.a * Math.PI) / 180;
    const dir: V = [e1[0] * Math.cos(a) + e2[0] * Math.sin(a), e1[1] * Math.cos(a) + e2[1] * Math.sin(a), e1[2] * Math.cos(a) + e2[2] * Math.sin(a)];
    const pn = nrm(cross(sh.axis, dir));
    const sig = signal(orig, tex, pn, dot(sh.center, pn) + 1.234e-4);
    const w = sig.filter((x) => {
      const r = sub(x.p, sh.center), h = dot(r, sh.axis);
      return dot(r, dir) > 0 && h >= sh.axial[0] && h <= sh.axial[1];
    });
    out[sec.tag] = enc(pitchOf(w));
  }
  return out;
}

// ------------------------------------------------------------------------------------ run

const MAPPINGS = (process.env.MAPPINGS ?? 'auto,planar,cylindrical,unwrap').split(',');
const one = (mesh: Mesh): Model => ({ objects: [{ name: 'p', parts: [{ name: 'p', mesh }] }] });
const fmt = (x: number | null | undefined) => (x == null ? '   -  ' : x < 0 ? ('>' + (-x).toFixed(1)).padStart(6) : x.toFixed(2).padStart(6));

interface Row { shape: string; mapping: string; picked: string; kind: string; ring: string; front: number | null; side: number | null; back: number | null; dev: number | null; ms: number }
const rows: Row[] = [];
let failures = 0;

async function texture(mesh: Mesh, tris: number[], area: number, mapping: string, rotation: number, pattern: FaceTexture['pattern'] = 'ridges') {
  const tex = {
    id: 't', objectIndex: 0, partIndex: 0, triangles: tris, pattern, mode: 'raised', height: HEIGHT, pitch: PITCH,
    rotation, image: null, patternRef: null, area, mapping,
  } as FaceTexture;
  const r = await applyTextures(wasm, one(mesh), [tex]);
  const st = textureStats.perTexture[0] as (typeof textureStats.perTexture)[0] & { mapping?: string; distortion?: number };
  const kind = st ? `${st.projection}${st.distortion ? ` D${st.distortion.toFixed(2)}` : ''}` : '-';
  return { mesh: r.applied.length ? r.model.objects[0].parts[0].mesh : null, warnings: r.warnings, kind, picked: (st?.mapping ?? '-') as string, ms: st?.ms ?? 0 };
}

/** Mean of the two side sectors (a stretched side wins: negative = lower bound). */
const sideOf = (p: Record<string, number | null>): number | null => {
  const a = p.side90, b = p.side270;
  if (a == null || b == null) return a ?? b;
  if (a < 0 || b < 0) return -Math.max(Math.abs(a), Math.abs(b));
  return (a + b) / 2;
};
const dev = (vals: (number | null)[]) => {
  const v = vals.filter((x): x is number => x != null).map(Math.abs);
  if (v.length < 2) return null;
  return (Math.max(...v) / Math.min(...v) - 1) * 100;
};

for (const sh of shapes()) {
  const tris = pickRegion(sh.mesh, [1, 0, 0], sh.filter);
  let area = 0;
  for (const t of tris) area += triNormal(sh.mesh, t).area;
  // front = the region's mean normal projected ⊥ axis (the clicked side)
  let fn: V = [0, 0, 0];
  for (const t of tris) { const { n, area: a } = triNormal(sh.mesh, t); fn = [fn[0] + n[0] * a, fn[1] + n[1] * a, fn[2] + n[2] * a]; }
  fn = sub(fn, sh.axis.map((x) => x * dot(fn, sh.axis)) as V);
  const front: V = Math.hypot(...fn) > 1e-3 * area ? nrm(fn) : frame(sh.axis)[0];
  console.log(`\n== ${sh.name}: ${tris.length} tris, ${area.toFixed(0)} mm², axis ${sh.axis.map((x) => x.toFixed(2)).join(',')}`);
  for (const mapping of MAPPINGS) {
    const ring = await texture(sh.mesh, tris, area, mapping, 0);
    if (!ring.mesh) { console.log(`  ${mapping}: not applied (${ring.warnings.join(' | ')})`); continue; }
    for (const w of ring.warnings) console.log(`  note ${w}`);
    const slug = `${sh.name.split(' ')[0]}${sh.filter ? '-cap' : ''}-${mapping}-${LABEL}`;
    writeFileSync(`${OUT}/${slug}-ridges.stl`, writeStl(ring.mesh));
    for (const rg of sh.rings) {
      const p = ringPitch(sh, sh.mesh, ring.mesh, rg.at, front);
      const side = sideOf(p);
      const d = dev([p.front, p.side90, p.back, p.side270]);
      rows.push({ shape: sh.name, mapping, picked: ring.picked, kind: ring.kind, ring: `ring ${rg.tag}`, front: p.front, side, back: p.back, dev: d, ms: ring.ms });
      console.log(`  ${mapping.padEnd(11)} -> ${ring.kind.padEnd(17)} ring ${rg.tag.padEnd(7)} front ${fmt(p.front)}  side90 ${fmt(p.side90)}  back ${fmt(p.back)}  side270 ${fmt(p.side270)}  dev ${d == null ? '-' : d.toFixed(1) + '%'}  (${ring.ms.toFixed(0)} ms)`);
      if (sh.developable && mapping === 'auto' && rg.tag === 'mid' && (d == null || d > 10)) { failures++; console.log(`  FAIL ${sh.name} auto ring deviation ${d?.toFixed(1)}%`); }
    }
    const ax = await texture(sh.mesh, tris, area, mapping, 90);
    if (ax.mesh && sh.filter) {
      // open cap: straight ridges can't follow every meridian; check the ring with ridges turned 90° too (sides)
      for (const rg of sh.rings) {
        const p = ringPitch(sh, sh.mesh, ax.mesh, rg.at, front);
        const d = dev([p.side90, p.side270]);
        rows.push({ shape: sh.name, mapping, picked: ax.picked, kind: ax.kind, ring: `ring ${rg.tag} rot90`, front: p.front, side: sideOf(p), back: p.back, dev: d, ms: ax.ms });
        console.log(`  ${mapping.padEnd(11)} -> ${ax.kind.padEnd(17)} ring ${rg.tag} rot90 front ${fmt(p.front)}  side90 ${fmt(p.side90)}  back ${fmt(p.back)}  side270 ${fmt(p.side270)}`);
      }
    }
    if (ax.mesh) {
      const p = axialPitch(sh, sh.mesh, ax.mesh, front);
      const side = sideOf(p);
      const d = dev([p.front, p.side90, p.back, p.side270]);
      rows.push({ shape: sh.name, mapping, picked: ax.picked, kind: ax.kind, ring: 'axial', front: p.front, side, back: p.back, dev: d, ms: ax.ms });
      console.log(`  ${mapping.padEnd(11)} -> ${ax.kind.padEnd(17)} axial        front ${fmt(p.front)}  side90 ${fmt(p.side90)}  back ${fmt(p.back)}  side270 ${fmt(p.side270)}  dev ${d == null ? '-' : d.toFixed(1) + '%'}`);
    }
    if (sh.name.startsWith('user grip') || sh.name.startsWith('ellipse')) {
      const kn = await texture(sh.mesh, tris, area, mapping, 0, 'knurl');
      if (kn.mesh) writeFileSync(`${OUT}/${slug.replace(/-ridges$/, '')}-knurl.stl`, writeStl(kn.mesh));
    }
    if (process.env.MAPPINGS === undefined && ring.picked === '-') break; // HEAD has no mapping field: one pass
  }
}

writeFileSync(`${OUT}/stretch-${LABEL}.json`, JSON.stringify(rows, null, 1));
console.log(`\n${rows.length} rows -> ${OUT}/stretch-${LABEL}.json`);
console.log(failures ? `\n${failures} FAILURE(S)` : '\nall developable shapes within 10 % under auto');
process.exit(failures ? 1 : 0);
