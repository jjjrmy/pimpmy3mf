// Face-texture validator. Builds each case through the REAL pipeline + objectsFromResult + writeBambuProject (x1c-0.4,
// 3-color camo), checks the textured parts (manifold status, self-intersections, volume change vs the expected
// mean(h)·height·area, triangle count, camo/skin coverage of the relief), slices with Bambu Studio 2.8 and 1.10 (no
// settings flags) and renders one G-code layer (textured vs untextured outer wall) for cases a and c.
//
//   bun scripts/validate-textures.ts            # everything
//   bun scripts/validate-textures.ts a c g      # cases: a b c d0 d45 e f g h
//   NO_SLICE=1 bun scripts/validate-textures.ts # mesh checks only
//
// Output: scratch/bambu/textures/.
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Manifold as ManifoldT } from 'manifold-3d';
import { initManifold } from '../src/core/manifold';
import { createPipeline } from '../src/core/pipeline';
import { objectsFromResult, writeBambuProject } from '../src/core/threemf';
import { buildAdjacency, planarRegion, smoothRegion, triNormal } from '../src/core/faces';
import { meanHeight, textureStats } from '../src/core/texture';
import { DEFAULT_PARAMS } from '../src/core/types';
import type {
  ExportObject, FaceTexture, HeightMap, Mesh, Model, PaintedFace, Params, RasterImage, Result, RGB, Vec3,
} from '../src/core/types';

const BIN: Record<string, string> = {
  '1.10': process.env.BAMBU_110 ?? '/tmp/bs110/BambuStudio.app/Contents/MacOS/BambuStudio',
  '2.8': process.env.BAMBU_28 ?? '/Applications/BambuStudio.app/Contents/MacOS/BambuStudio',
};
const ROOT = resolve(import.meta.dir, '..');
const OUT = `${ROOT}/scratch/bambu/textures`;
const TIMEOUT_MS = 400_000;
const CONCURRENCY = 3;
const PALETTE: RGB[] = [[194, 24, 7], [31, 122, 31], [32, 64, 192]];
const VOL_TOL = 0.35;
const NO_SLICE = !!process.env.NO_SLICE;

const args = process.argv.slice(2);
const want = (c: string) => args.length === 0 || args.includes(c);
mkdirSync(OUT, { recursive: true });
const wasm = await initManifold();
let failures = 0;
const fail = (msg: string) => { failures++; console.log(`  FAIL ${msg}`); };
const ok = (msg: string) => console.log(`  ok   ${msg}`);

// ------------------------------------------------------------------------------------ geometry

function box(ox: number, oy: number, w: number, d: number, h: number, z0 = 0): Mesh {
  const v = [
    ox, oy, z0, ox + w, oy, z0, ox + w, oy + d, z0, ox, oy + d, z0,
    ox, oy, z0 + h, ox + w, oy, z0 + h, ox + w, oy + d, z0 + h, ox, oy + d, z0 + h,
  ];
  const t = [
    0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4,
    1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7,
  ];
  return { vertices: new Float32Array(v), triangles: new Uint32Array(t) };
}

function cylinderMesh(r: number, h: number, segs: number): Mesh {
  const man = wasm.Manifold.cylinder(h, r, r, segs, false).translate([40, 40, 0]);
  const gm = man.getMesh();
  const np = gm.numProp, nv = gm.vertProperties.length / np;
  const vertices = new Float32Array(nv * 3);
  for (let i = 0; i < nv; i++) for (let k = 0; k < 3; k++) vertices[i * 3 + k] = gm.vertProperties[i * np + k];
  man.delete();
  return { vertices, triangles: new Uint32Array(gm.triVerts) };
}

const one = (mesh: Mesh, name = 'part'): Model => ({ objects: [{ name, parts: [{ name, mesh }] }] });

function bestTri(mesh: Mesh, dir: Vec3): number {
  let best = -1, bestDot = -Infinity;
  for (let tri = 0; tri < mesh.triangles.length / 3; tri++) {
    const { n, area } = triNormal(mesh, tri);
    if (area === 0) continue;
    const d = n[0] * dir[0] + n[1] * dir[1] + n[2] * dir[2];
    if (d > bestDot) { bestDot = d; best = tri; }
  }
  return best;
}

function topFace(mesh: Mesh): { triangles: number[]; area: number } {
  const r = planarRegion(mesh, buildAdjacency(mesh), bestTri(mesh, [0, 0, 1]))!;
  return { triangles: r.triangles, area: r.area };
}

function sideRegion(mesh: Mesh): { triangles: number[]; area: number } {
  const r = smoothRegion(mesh, buildAdjacency(mesh), bestTri(mesh, [1, 0, 0]))!;
  return { triangles: r.triangles, area: r.area };
}

function stripeImage(size = 120, band = 12): RasterImage {
  const data = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const c = PALETTE[Math.floor((x + y) / band) % 3];
      const o = (y * size + x) * 4;
      data[o] = c[0]; data[o + 1] = c[1]; data[o + 2] = c[2]; data[o + 3] = 255;
    }
  return { width: size, height: size, data };
}

function radialMap(n = 64): HeightMap {
  const data = new Uint8Array(n * n);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const r = Math.hypot(x + 0.5 - n / 2, y + 0.5 - n / 2) / (n / 2);
    data[y * n + x] = Math.round(255 * Math.max(0, 1 - r));
  }
  return { width: n, height: n, data };
}

const P = (extra: Partial<Params>): Params => ({
  ...DEFAULT_PARAMS, colors: 3, palette: PALETTE, smooth: 0, minFeature: 0, resolution: 0.3, ...extra,
});

let texId = 0;
const T = (o: Partial<FaceTexture> & Pick<FaceTexture, 'triangles' | 'area' | 'pattern'>): FaceTexture => ({
  id: `t${++texId}`, objectIndex: 0, partIndex: 0, mode: 'raised', height: 0.6, pitch: 2, rotation: 0, image: null, patternRef: null, ...o,
} as FaceTexture);

// ------------------------------------------------------------------------------------ mesh checks

function toMan(m: Mesh, merge = false): ManifoldT {
  const mm = new wasm.Mesh({ numProp: 3, vertProperties: m.vertices, triVerts: m.triangles });
  if (merge) mm.merge();
  return wasm.Manifold.ofMesh(mm);
}

function status(m: Mesh): string {
  try { const man = toMan(m); const s = man.status(); man.delete(); return s; }
  catch (e) { return `throws ${(e as Error).message}`; }
}

const vol = (m: Mesh) => { const M = toMan(m, true); const v = M.volume(); M.delete(); return v; };

/** Triangle–triangle intersections over a uniform grid, ignoring pairs that share a vertex. */
function selfIntersections(m: Mesh, limit = 20): number {
  const v = m.vertices, t = m.triangles, nt = t.length / 3;
  let el = 0;
  for (let i = 0; i < nt; i++) for (let e = 0; e < 3; e++) {
    const a = t[i * 3 + e] * 3, b = t[i * 3 + ((e + 1) % 3)] * 3;
    el += Math.hypot(v[a] - v[b], v[a + 1] - v[b + 1], v[a + 2] - v[b + 2]);
  }
  const cs = Math.max((2 * el) / (3 * nt), 1e-3);
  let gx0 = Infinity, gy0 = Infinity, gz0 = Infinity;
  for (let i = 0; i < v.length; i += 3) { gx0 = Math.min(gx0, v[i]); gy0 = Math.min(gy0, v[i + 1]); gz0 = Math.min(gz0, v[i + 2]); }
  const bb = new Float64Array(nt * 6);
  let mx = 0, my = 0, mz = 0;
  for (let i = 0; i < nt; i++) {
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    for (let k = 0; k < 3; k++) {
      const p = t[i * 3 + k] * 3;
      x0 = Math.min(x0, v[p]); x1 = Math.max(x1, v[p]);
      y0 = Math.min(y0, v[p + 1]); y1 = Math.max(y1, v[p + 1]);
      z0 = Math.min(z0, v[p + 2]); z1 = Math.max(z1, v[p + 2]);
    }
    bb.set([x0, y0, z0, x1, y1, z1], i * 6);
    mx = Math.max(mx, Math.floor((x1 - gx0) / cs)); my = Math.max(my, Math.floor((y1 - gy0) / cs)); mz = Math.max(mz, Math.floor((z1 - gz0) / cs));
  }
  const NX = mx + 1, NY = my + 1;
  const cell = (ix: number, iy: number, iz: number) => ix + NX * (iy + NY * iz);
  const grid = new Map<number, number[]>();
  for (let i = 0; i < nt; i++) {
    const ix0 = Math.floor((bb[i * 6] - gx0) / cs), ix1 = Math.floor((bb[i * 6 + 3] - gx0) / cs);
    const iy0 = Math.floor((bb[i * 6 + 1] - gy0) / cs), iy1 = Math.floor((bb[i * 6 + 4] - gy0) / cs);
    const iz0 = Math.floor((bb[i * 6 + 2] - gz0) / cs), iz1 = Math.floor((bb[i * 6 + 5] - gz0) / cs);
    for (let a = ix0; a <= ix1; a++) for (let b = iy0; b <= iy1; b++) for (let c = iz0; c <= iz1; c++) {
      const k = cell(a, b, c);
      const l = grid.get(k); if (l) l.push(i); else grid.set(k, [i]);
    }
  }
  const P3 = (i: number): [number, number, number] => [v[i * 3], v[i * 3 + 1], v[i * 3 + 2]];
  const sub = (a: number[], b: number[]) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const crs = (a: number[], b: number[]) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const dt = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const EPS = 1e-7;
  const segTri = (p: number[], q: number[], a: number[], b: number[], c: number[]): boolean => {
    const d = sub(q, p), e1 = sub(b, a), e2 = sub(c, a), h = crs(d, e2), det = dt(e1, h);
    if (Math.abs(det) < 1e-14) return false;
    const f = 1 / det, s = sub(p, a), u = f * dt(s, h);
    if (u < EPS || u > 1 - EPS) return false;
    const qv = crs(s, e1), w = f * dt(d, qv);
    if (w < EPS || u + w > 1 - EPS) return false;
    const tt = f * dt(e2, qv);
    return tt > EPS && tt < 1 - EPS;
  };
  const triTri = (i: number, j: number): boolean => {
    const A = [P3(t[i * 3]), P3(t[i * 3 + 1]), P3(t[i * 3 + 2])], B = [P3(t[j * 3]), P3(t[j * 3 + 1]), P3(t[j * 3 + 2])];
    for (let e = 0; e < 3; e++) {
      if (segTri(A[e], A[(e + 1) % 3], B[0], B[1], B[2])) return true;
      if (segTri(B[e], B[(e + 1) % 3], A[0], A[1], A[2])) return true;
    }
    return false;
  };
  let hits = 0;
  for (const [key, list] of grid) {
    for (let x = 0; x < list.length; x++) for (let y = x + 1; y < list.length; y++) {
      const i = list[x], j = list[y];
      const ti = [t[i * 3], t[i * 3 + 1], t[i * 3 + 2]];
      if (ti.includes(t[j * 3]) || ti.includes(t[j * 3 + 1]) || ti.includes(t[j * 3 + 2])) continue;
      // bbox overlap + test each pair once (in the cell holding the overlap's min corner)
      const ox = Math.max(bb[i * 6], bb[j * 6]), oy = Math.max(bb[i * 6 + 1], bb[j * 6 + 1]), oz = Math.max(bb[i * 6 + 2], bb[j * 6 + 2]);
      if (ox > Math.min(bb[i * 6 + 3], bb[j * 6 + 3]) || oy > Math.min(bb[i * 6 + 4], bb[j * 6 + 4]) || oz > Math.min(bb[i * 6 + 5], bb[j * 6 + 5])) continue;
      if (cell(Math.floor((ox - gx0) / cs), Math.floor((oy - gy0) / cs), Math.floor((oz - gz0) / cs)) !== key) continue;
      if (triTri(i, j)) { hits++; if (hits >= limit) return hits; }
    }
  }
  return hits;
}

function unionMeshes(meshes: Mesh[]): ManifoldT | null {
  const mans = meshes.map((m) => toMan(m, true));
  if (!mans.length) return null;
  const u = wasm.Manifold.union(mans);
  for (const m of mans) m.delete();
  return u;
}

// ------------------------------------------------------------------------------------ gcode + slicing

interface LayerInfo { z: number; moves: [number, number, number, number, number, string][] }
interface Gcode { colors: string[]; extrudePerTool: Map<number, number>; layers: LayerInfo[] }

function parseGcode(path: string): Gcode {
  const colors: string[] = [];
  const extrudePerTool = new Map<number, number>();
  const layers: LayerInfo[] = [];
  let tool = -1, inTower = false, feature = '', x = 0, y = 0;
  let cur: LayerInfo | null = null;
  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    const line = raw.trim();
    if (line.startsWith(';')) {
      if (colors.length === 0 && line.startsWith('; filament_colour =')) {
        for (const c of line.split('=')[1].split(';')) if (c.trim()) colors.push(c.trim().toUpperCase());
      } else if (line === '; WIPE_TOWER_START') inTower = true;
      else if (line === '; WIPE_TOWER_END') inTower = false;
      else if (line.startsWith('; FEATURE:')) feature = line.slice(10).trim();
      else if (line === '; CHANGE_LAYER') { cur = { z: 0, moves: [] }; layers.push(cur); }
      else if (line.startsWith('; Z_HEIGHT:') && cur) cur.z = parseFloat(line.slice(11));
      continue;
    }
    const tm = line.match(/^T(\d+)\b/);
    if (tm) { const t = parseInt(tm[1], 10); if (t < 16) tool = t; continue; }
    if (/^G[0-3]\b/.test(line)) {
      const xm = line.match(/\bX(-?[0-9.]+)/), ym = line.match(/\bY(-?[0-9.]+)/), em = line.match(/\bE(-?[0-9.]+)/);
      const nx = xm ? parseFloat(xm[1]) : x, ny = ym ? parseFloat(ym[1]) : y;
      const tower = inTower || /prime tower|wipe tower/i.test(feature);
      if (em && (xm || ym) && parseFloat(em[1]) > 0 && !tower && tool >= 0) {
        extrudePerTool.set(tool, (extrudePerTool.get(tool) ?? 0) + 1);
        cur?.moves.push([x, y, nx, ny, tool, feature]);
      }
      x = nx; y = ny;
    }
  }
  return { colors, extrudePerTool, layers };
}

interface Slice { exit: number | null; timedOut: boolean; returnCode: number | null; error: string; ms: number; gcode: Gcode | null; logTail: string }

function slice(ver: string, file: string, dir: string): Promise<Slice> {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const t0 = Date.now();
  return new Promise((res) => {
    const ch = spawn(BIN[ver], ['--slice', '0', '--outputdir', dir, file], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = '';
    ch.stdout.on('data', (d) => { log += d; });
    ch.stderr.on('data', (d) => { log += d; });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; ch.kill('SIGKILL'); }, TIMEOUT_MS);
    ch.on('close', (code, signal) => {
      clearTimeout(timer);
      writeFileSync(`${dir}/cli.log`, log);
      let returnCode: number | null = null, error = '';
      if (existsSync(`${dir}/result.json`)) {
        try { const r = JSON.parse(readFileSync(`${dir}/result.json`, 'utf8')); returnCode = r.return_code; error = r.error_string ?? ''; } catch { /* */ }
      }
      const gcode = existsSync(`${dir}/plate_1.gcode`) ? parseGcode(`${dir}/plate_1.gcode`) : null;
      res({ exit: code ?? (signal ? -1 : null), timedOut, returnCode, error, ms: Date.now() - t0, gcode, logTail: log.trim().split('\n').slice(-6).join('\n') });
    });
  });
}

async function pool<T>(jobs: (() => Promise<T>)[], n: number): Promise<T[]> {
  const out: T[] = new Array(jobs.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, jobs.length) }, async () => {
    while (next < jobs.length) { const i = next++; out[i] = await jobs[i](); }
  }));
  return out;
}

function assess(label: string, s: Slice, ncolors: number): void {
  const why: string[] = [];
  if (s.timedOut) why.push('TIMEOUT');
  if (s.exit !== 0) why.push(`exit ${s.exit}`);
  if (s.returnCode !== null && s.returnCode !== 0) why.push(`return_code ${s.returnCode} "${s.error}"`);
  if (!s.gcode) why.push('no gcode');
  const missing = Array.from({ length: ncolors }, (_, i) => i).filter((t) => !(s.gcode?.extrudePerTool.get(t)));
  if (s.gcode && missing.length) why.push(`no extrusion T${missing.join(',T')}`);
  const tools = s.gcode ? [...s.gcode.extrudePerTool.entries()].sort((a, b) => a[0] - b[0]).map(([t, n]) => `T${t}:${n}`).join(' ') : '';
  if (why.length) fail(`${label}: ${why.join('; ')}\n       ${s.logTail.split('\n').join('\n       ')}`);
  else ok(`${label}: exit 0, ${(s.ms / 1000).toFixed(0)}s, ${tools}`);
}

const nearestLayer = (g: Gcode, z: number) => g.layers.reduce((b, l) => (Math.abs(l.z - z) < Math.abs(b.z - z) ? l : b));

const RENDER_PY = `
import json, sys
from PIL import Image, ImageDraw
d = json.load(open(sys.argv[1])); out = sys.argv[2]
tex, org = d["textured"], d["original"]
allm = tex["moves"] + org["moves"]
xs = [v for m in allm for v in (m[0], m[2])]; ys = [v for m in allm for v in (m[1], m[3])]
x0, x1, y0, y1 = min(xs) - 2, max(xs) + 2, min(ys) - 2, max(ys) + 2
S = 900 / max(x1 - x0, y1 - y0); W = int((x1 - x0) * S); H = int((y1 - y0) * S)
img = Image.new("RGB", (W, H + 60), "white"); dr = ImageDraw.Draw(img)
P = lambda x, y: (( x - x0) * S, H - (y - y0) * S)
for m in tex["moves"]:
    if m[5] != "Outer wall": dr.line([P(m[0], m[1]), P(m[2], m[3])], fill=(215, 215, 215), width=1)
for m in org["moves"]:
    if m[5] == "Outer wall": dr.line([P(m[0], m[1]), P(m[2], m[3])], fill=(38, 139, 210), width=2)
for m in tex["moves"]:
    if m[5] == "Outer wall": dr.line([P(m[0], m[1]), P(m[2], m[3])], fill=(220, 50, 47), width=2)
dr.text((6, H + 6), f"{d['title']}", fill="black")
dr.text((6, H + 22), f"red = textured outer wall z={tex['z']}   blue = untextured outer wall z={org['z']}   gray = textured other features", fill="black")
img.save(out)
`;

function renderCompare(title: string, tex: LayerInfo, org: LayerInfo, png: string): void {
  const json = `${png}.json`;
  writeFileSync(json, JSON.stringify({ title, textured: tex, original: org }));
  const py = `${OUT}/render-compare.py`;
  writeFileSync(py, RENDER_PY);
  const pyBin = existsSync(`${ROOT}/../cli/.venv/bin/python3`) ? `${ROOT}/../cli/.venv/bin/python3` : 'python3';
  try { execFileSync(pyBin, ['-I', py, json, png], { stdio: 'pipe' }); console.log(`  render: ${png}`); }
  catch (e) { fail(`render ${png}: ${(e as Error).message.split('\n')[0]}`); }
}

// ------------------------------------------------------------------------------------ cases

interface Case {
  tag: string; label: string; model: Model; params: Params;
  /** Expected relief per texture (for the volume check). */
  render?: { z: number };
}

interface Built { result: Result; objects: ExportObject[]; colors: string[]; texMs: number; perTex: typeof textureStats.perTexture }

async function build(c: { model: Model; params: Params }, name: string): Promise<Built> {
  const pipe = createPipeline();
  const result = await pipe.run(stripeImage(), c.model, c.params);
  const texMs = c.params.textures.length ? textureStats.ms : 0;
  const perTex = c.params.textures.length ? textureStats.perTexture.slice() : [];
  pipe.dispose();
  const colors = result.regions.map((r) => r.hex.toUpperCase());
  return { result, objects: objectsFromResult(result, colors, name), colors, texMs, perTex };
}

async function project(b: Built, tag: string): Promise<string> {
  const { bytes } = await writeBambuProject(b.objects, { printerId: 'x1c-0.4', filamentColors: b.colors });
  const file = `${OUT}/${tag}-x1c-0.4.3mf`;
  writeFileSync(file, bytes);
  return file;
}

function checkCase(c: Case, b: Built): void {
  const r = b.result;
  for (const w of r.warnings) console.log(`  note ${w}`);
  console.log(`  texture build ${b.texMs.toFixed(0)} ms (${b.perTex.map((p) => `${p.id}: ${p.ms.toFixed(0)} ms, ${p.projection}, L=${p.edge.toFixed(3)}`).join('; ')})`);
  if (!r.shaped) { fail(`${c.tag}: result.shaped is null`); return; }
  // export uses the shaped mesh
  const flatShaped = r.shaped.flat().filter(Boolean) as Mesh[];
  const exported = b.objects.flatMap((o) => o.parts.filter((p) => p.subtype === 'normal_part').map((p) => p.mesh));
  if (!flatShaped.every((m) => exported.includes(m))) fail(`${c.tag}: export does not use the shaped mesh`);

  r.shaped.forEach((row, j) => row.forEach((shaped, k) => {
    if (!shaped) return;
    const orig = r.model!.objects[j].parts[k].mesh;
    const tag = `${c.tag} part(${j},${k})`;
    const st = status(shaped);
    if (st !== 'NoError') fail(`${tag}: manifold status ${st}`); else ok(`${tag}: manifold NoError`);
    const ts = performance.now();
    const si = selfIntersections(shaped);
    const siMs = performance.now() - ts;
    if (si) fail(`${tag}: ${si}${si >= 20 ? '+' : ''} self-intersecting triangle pairs`);
    else ok(`${tag}: 0 self-intersections (${(siMs / 1000).toFixed(1)} s)`);
    console.log(`       triangles ${orig.triangles.length / 3} -> ${shaped.triangles.length / 3}`);

    // volume change vs Σ ±mean(h)·height·area over this part's textures (applied in order, regions may overlap)
    const texs = c.params.textures.filter((t) => t.objectIndex === j && t.partIndex === k);
    const expect = texs.reduce((s, t) => s + (t.mode === 'raised' ? 1 : -1) * meanHeight(t) * t.height * t.area, 0);
    const dv = vol(shaped) - vol(orig);
    const rel = Math.abs(dv - expect) / Math.abs(expect);
    const msg = `${tag}: ΔV ${dv.toFixed(1)} mm³ vs expected ${expect.toFixed(1)} (${((dv / expect) * 100).toFixed(0)}%)`;
    if (rel > VOL_TOL) fail(msg); else ok(msg);

    // coverage: modifiers of this object (camo incl. region 0, + painted-face skins) contain the relief
    const objIdx = r.regions.some((x) => x.partMeshes) ? null : j;
    const mods: Mesh[] = [];
    for (const reg of r.regions) {
      const m = objIdx == null ? reg.partMeshes?.[j]?.[k] : reg.objectMeshes?.[j];
      if (m) mods.push(m);
    }
    for (const s of r.faceSkins) if (s.objectIndex === j && (objIdx != null || s.partIndex === k)) mods.push(s.mesh);
    const U = unionMeshes(mods);
    if (!U) { fail(`${tag}: no modifiers`); return; }
    const bbU = U.boundingBox();
    let outside = 0;
    const sv = shaped.vertices;
    for (let i = 0; i < sv.length; i += 3)
      for (let a = 0; a < 3; a++) if (sv[i + a] < bbU.min[a] - 1e-3 || sv[i + a] > bbU.max[a] + 1e-3) { outside++; break; }
    if (outside) fail(`${tag}: ${outside} textured vertices outside the modifiers' bbox`);
    else ok(`${tag}: all ${sv.length / 3} textured vertices inside the modifiers' bbox`);
    const S = toMan(shaped, true), O = toMan(orig, true);
    const raised = texs.some((t) => t.mode === 'raised');
    // raised: the relief (shaped − original) must be colored; recessed: the shaped part must be colored where the
    // modifiers reach (Full depth: everything; paint depth: compare against the shell volume the modifiers fill)
    const probe = raised ? S.subtract(O) : S;
    const pv = probe.volume();
    const I = probe.intersect(U);
    const cov = pv > 0 ? I.volume() / pv : 1;
    const m2 = `${tag}: ${raised ? 'relief' : 'part'} volume covered by modifiers ${(cov * 100).toFixed(2)}% (${pv.toFixed(1)} mm³)`;
    if (cov < 0.99 && (raised || c.params.depth == null)) fail(m2); else ok(m2);
    I.delete(); if (probe !== S) probe.delete(); S.delete(); O.delete(); U.delete();
  }));
}

const cases: Case[] = [];
const boxM = () => one(box(0, 0, 40, 40, 40), 'box');
const cylM = () => one(cylinderMesh(25, 40, 256), 'cylinder');
{
  const m = boxM(); const top = topFace(m.objects[0].parts[0].mesh);
  cases.push({ tag: 'a', label: 'box top, knurl raised 0.6, pitch 2', model: m, render: { z: 40.3 },
    params: P({ axis: 'z', textures: [T({ ...top, pattern: 'knurl', mode: 'raised', height: 0.6, pitch: 2 })] }) });
}
{
  const m = boxM(); const top = topFace(m.objects[0].parts[0].mesh);
  cases.push({ tag: 'b', label: 'box top, knurl recessed 0.6, pitch 2', model: m,
    params: P({ axis: 'z', textures: [T({ ...top, pattern: 'knurl', mode: 'recessed', height: 0.6, pitch: 2 })] }) });
}
{
  const m = cylM(); const side = sideRegion(m.objects[0].parts[0].mesh);
  cases.push({ tag: 'c', label: 'cylinder r25 side, stipple raised 0.5, pitch 3', model: m, render: { z: 20 },
    params: P({ axis: 'y', textures: [T({ ...side, pattern: 'stipple', mode: 'raised', height: 0.5, pitch: 3 })] }) });
  for (const rot of [0, 45]) {
    const m2 = cylM(); const s2 = sideRegion(m2.objects[0].parts[0].mesh);
    cases.push({ tag: `d${rot}`, label: `cylinder side, ridges rot ${rot}, recessed 0.6, pitch 2.5`, model: m2,
      params: P({ axis: 'y', textures: [T({ ...s2, pattern: 'ridges', mode: 'recessed', height: 0.6, pitch: 2.5, rotation: rot })] }) });
  }
  const m3 = cylM(); const s3 = sideRegion(m3.objects[0].parts[0].mesh);
  cases.push({ tag: 'e', label: 'cylinder side, hex raised 0.6, pitch 4', model: m3,
    params: P({ axis: 'y', textures: [T({ ...s3, pattern: 'hex', mode: 'raised', height: 0.6, pitch: 4 })] }) });
  const m4 = cylM(); const s4 = sideRegion(m4.objects[0].parts[0].mesh);
  cases.push({ tag: 'h', label: 'cylinder side, stipple raised 0.5, pitch 3, CYLINDRICAL projection', model: m4,
    params: P({ axis: 'z', projection: 'cylindrical', textures: [T({ ...s4, pattern: 'stipple', mode: 'raised', height: 0.5, pitch: 3 })] }) });
}
{
  const m = boxM(); const top = topFace(m.objects[0].parts[0].mesh);
  cases.push({ tag: 'f', label: 'box top, image height map (radial 64x64), pitch 10, raised 0.8', model: m,
    params: P({ axis: 'z', textures: [T({ ...top, pattern: 'image', image: radialMap(), mode: 'raised', height: 0.8, pitch: 10 })] }) });
}
{
  const a = box(0, 0, 40, 40, 40), bb = box(45, 0, 20, 40, 30);
  const m: Model = { objects: [{ name: 'pair', parts: [{ name: 'textured', mesh: a }, { name: 'plain', mesh: bb }] }] };
  const top = topFace(a);
  const face: PaintedFace = { id: 'pf1', objectIndex: 0, partIndex: 0, triangles: top.triangles, color: 1, area: top.area };
  cases.push({ tag: 'g', label: 'case a + depth 0.6 + per-part (2 parts) + painted face on the textured face', model: m,
    params: P({ axis: 'z', depth: 0.6, perPart: true, paintedFaces: [face],
      textures: [T({ ...top, pattern: 'knurl', mode: 'raised', height: 0.6, pitch: 2 })] }) });
}

const jobs: (() => Promise<{ tag: string; ver: string; s: Slice }>)[] = [];
const renders: { c: Case; built: Built }[] = [];
for (const c of cases) {
  if (!want(c.tag)) continue;
  console.log(`\n== ${c.tag}: ${c.label}`);
  const built = await build(c, c.tag);
  checkCase(c, built);
  if (c.tag === 'g') {
    const sk = built.result.faceSkins[0];
    if (!sk) fail('g: no face skin');
    else {
      let z1 = -Infinity, z0 = Infinity;
      for (let i = 2; i < sk.mesh.vertices.length; i += 3) { z1 = Math.max(z1, sk.mesh.vertices[i]); z0 = Math.min(z0, sk.mesh.vertices[i]); }
      const m = `g: painted-face skin z ${z0.toFixed(2)}..${z1.toFixed(2)} (relief top 40.6, shell depth 0.6)`;
      if (z1 >= 40.6 - 1e-3 && z0 <= 39.4 + 1e-3) ok(m); else fail(m);
    }
  }
  if (NO_SLICE) continue;
  const file = await project(built, c.tag);
  for (const ver of ['2.8', '1.10']) jobs.push(async () => ({ tag: c.tag, ver, s: await slice(ver, file, `${OUT}/${c.tag}-x1c-0.4-${ver}`) }));
  if (c.render) {
    renders.push({ c, built });
    const orig = await build({ model: c.model, params: { ...c.params, textures: [] } }, `${c.tag}-orig`);
    const of = await project(orig, `${c.tag}-orig`);
    jobs.push(async () => ({ tag: `${c.tag}-orig`, ver: '2.8', s: await slice('2.8', of, `${OUT}/${c.tag}-orig-x1c-0.4-2.8`) }));
  }
}

if (jobs.length) {
  console.log(`\n== slicing ${jobs.length} projects`);
  const res = await pool(jobs, CONCURRENCY);
  for (const { tag, ver, s } of res) assess(`${tag} x1c-0.4 Studio ${ver}`, s, 3);
  for (const { c } of renders) {
    const t = res.find((x) => x.tag === c.tag && x.ver === '2.8')?.s.gcode;
    const o = res.find((x) => x.tag === `${c.tag}-orig`)?.s.gcode;
    if (!t || !o) { fail(`${c.tag}: no gcode to render`); continue; }
    const lt = nearestLayer(t, c.render!.z), lo = nearestLayer(o, c.render!.z);
    renderCompare(`${c.tag}: ${c.label}`, lt, lo, `${OUT}/${c.tag}-layer-z${c.render!.z}.png`);
  }
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nall checks passed');
process.exit(failures ? 1 : 0);
