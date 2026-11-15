// Paint-depth validator. Builds each case through the REAL pipeline + objectsFromResult + writeBambuProject,
// checks the meshes (manifold status, pairwise color overlap), slices with the Bambu CLIs (no settings flags)
// and inspects the G-code: which tools extrude per FEATURE on a mid layer, tool changes / flush / filament / time
// vs Full, and the image-mode base/cap layering. Also times the shell build (and the Yeti part, pipeline only).
//
//   bun scripts/validate-depth.ts            # everything
//   bun scripts/validate-depth.ts A B yeti   # cases: A B C D E yeti
//
// Slice wrapper + extrusion parsing adapted from validate-studio-compat.ts (not edited). Output: scratch/bambu/depth/.
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import type { Manifold as ManifoldT } from 'manifold-3d';
import { initManifold } from '../src/core/manifold';
import { createPipeline } from '../src/core/pipeline';
import { objectsFromResult, writeBambuProject } from '../src/core/threemf';
import { buildAdjacency, planarRegion, triNormal } from '../src/core/faces';
import { partShell, shellStats } from '../src/core/shell';
import { loadModel } from '../src/core/meshio';
import { DEFAULT_PARAMS } from '../src/core/types';
import type { ExportObject, Mesh, Model, PaintedFace, Params, RasterImage, Result, RGB, Vec3 } from '../src/core/types';

const BIN: Record<string, string> = {
  '1.10': process.env.BAMBU_110 ?? '/tmp/bs110/BambuStudio.app/Contents/MacOS/BambuStudio',
  '2.8': process.env.BAMBU_28 ?? '/Applications/BambuStudio.app/Contents/MacOS/BambuStudio',
};
const ROOT = resolve(import.meta.dir, '..');
const OUT = `${ROOT}/scratch/bambu/depth`;
const TIMEOUT_MS = 300_000;
const CONCURRENCY = 3;
const PALETTE: RGB[] = [[194, 24, 7], [31, 122, 31], [32, 64, 192]];
const OVERLAP_TOL = 1e-3;

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
  const man = wasm.Manifold.cylinder(h, r, r, segs, false);
  const gm = man.getMesh();
  const np = gm.numProp, nv = gm.vertProperties.length / np;
  const vertices = new Float32Array(nv * 3);
  for (let i = 0; i < nv; i++) for (let k = 0; k < 3; k++) vertices[i * 3 + k] = gm.vertProperties[i * np + k];
  man.delete();
  return { vertices, triangles: new Uint32Array(gm.triVerts) };
}

function faceAlong(mesh: Mesh, dir: Vec3): { triangles: number[]; area: number } {
  const adj = buildAdjacency(mesh);
  let best = -1, bestDot = -Infinity;
  for (let tri = 0; tri < mesh.triangles.length / 3; tri++) {
    const { n, area } = triNormal(mesh, tri);
    if (area === 0) continue;
    const dot = n[0] * dir[0] + n[1] * dir[1] + n[2] * dir[2];
    if (dot > bestDot) { bestDot = dot; best = tri; }
  }
  const reg = planarRegion(mesh, adj, best)!;
  return { triangles: reg.triangles, area: reg.area };
}

/** 3-color diagonal stripes; with the pattern stretched over a 40 mm box each band is ~6 mm, so every side sees all colors. */
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

/** 3 vertical bands + a horizontal split (seam-continuous) for the cylinder. */
function bandImage(W = 240, H = 120): RasterImage {
  const data = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const k = (Math.floor(((x + W / 6) % W) / (W / 3)) + (y < H / 2 ? 0 : 1)) % 3;
      const o = (y * W + x) * 4;
      data[o] = PALETTE[k][0]; data[o + 1] = PALETTE[k][1]; data[o + 2] = PALETTE[k][2]; data[o + 3] = 255;
    }
  return { width: W, height: H, data };
}

function readRgba(path: string): RasterImage {
  const buf = readFileSync(path);
  const width = buf.readUInt32LE(4), height = buf.readUInt32LE(8);
  const data = new Uint8ClampedArray(width * height * 4);
  data.set(buf.subarray(12, 12 + width * height * 4));
  return { width, height, data };
}

const P = (extra: Partial<Params>): Params => ({
  ...DEFAULT_PARAMS, colors: 3, palette: PALETTE, smooth: 0, minFeature: 0, resolution: 0.3, ...extra,
});

// ------------------------------------------------------------------------------------ mesh checks

function toMan(m: Mesh): ManifoldT {
  const mm = new wasm.Mesh({ numProp: 3, vertProperties: m.vertices, triVerts: m.triangles });
  return wasm.Manifold.ofMesh(mm); // no merge: the mesh must already be a closed manifold
}

function manifoldStatus(m: Mesh): string {
  try {
    const man = toMan(m);
    const s = man.status();
    man.delete();
    return s;
  } catch (e) { return `throws ${(e as Error).message}`; }
}

function overlap(a: Mesh, b: Mesh): number {
  const A = toMan(a), B = toMan(b);
  const I = A.intersect(B);
  const v = I.isEmpty() ? 0 : I.volume();
  A.delete(); B.delete(); I.delete();
  return v;
}

const vol = (m: Mesh) => { const M = toMan(m); const v = M.volume(); M.delete(); return v; };

/** Manifold status of every part + pairwise overlap of the colored parts in each object (modifiers, and in
 *  image mode the normal part's printed piece vs the caps). */
function checkObjects(label: string, objects: ExportObject[], extraPieces?: { name: string; mesh: Mesh }[]): void {
  let bad = 0, worst = 0, pairs = 0;
  for (const o of objects) {
    for (const p of o.parts) {
      const s = manifoldStatus(p.mesh);
      if (s !== 'NoError') { bad++; fail(`${label}: ${o.name}/${p.name} (${p.subtype}) status ${s}`); }
    }
    const mods = extraPieces ?? o.parts.filter((p) => p.subtype === 'modifier_part').map((p) => ({ name: p.name, mesh: p.mesh }));
    for (let i = 0; i < mods.length; i++) for (let j = i + 1; j < mods.length; j++) {
      const v = overlap(mods[i].mesh, mods[j].mesh);
      pairs++; worst = Math.max(worst, v);
      if (v >= OVERLAP_TOL) fail(`${label}: ${o.name} overlap ${mods[i].name} ∩ ${mods[j].name} = ${v.toExponential(2)} mm³`);
    }
  }
  if (!bad) ok(`${label}: ${objects.reduce((s, o) => s + o.parts.length, 0)} parts all manifold (NoError)`);
  ok(`${label}: ${pairs} color pairs, max overlap ${worst.toExponential(2)} mm³ (< ${OVERLAP_TOL})`);
}

/** Every part's shell is a valid manifold too. */
function checkShells(label: string, model: Model, depth: number): void {
  for (const [j, o] of model.objects.entries()) for (const [k, p] of o.parts.entries()) {
    const sh = partShell(wasm, p.mesh, depth);
    if (!sh) { fail(`${label}: shell(${j},${k}) empty`); continue; }
    const s = manifoldStatus(sh);
    if (s !== 'NoError') fail(`${label}: shell(${j},${k}) status ${s}`);
    else ok(`${label}: shell(${j},${k}) manifold, ${(vol(sh) / vol(p.mesh) * 100).toFixed(1)}% of part volume`);
  }
}

// ------------------------------------------------------------------------------------ gcode

interface LayerInfo { z: number; features: Map<string, Map<number, number>>; moves: [number, number, number, number, number, string][] }
interface Gcode {
  colors: string[];
  extrudePerTool: Map<number, number>;
  toolChanges: number;
  layers: LayerInfo[];
  header: Record<string, string>;
}

function parseGcode(path: string): Gcode {
  const colors: string[] = [];
  const extrudePerTool = new Map<number, number>();
  const header: Record<string, string> = {};
  const layers: LayerInfo[] = [];
  let tool = -1, toolChanges = 0, inTower = false, feature = '', inHeader = false;
  let x = 0, y = 0;
  let cur: LayerInfo | null = null;
  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    const line = raw.trim();
    if (line.startsWith(';')) {
      if (line === '; HEADER_BLOCK_START') inHeader = true;
      else if (line === '; HEADER_BLOCK_END') inHeader = false;
      else if (inHeader) {
        for (const part of line.slice(1).split(';')) {
          const i = part.indexOf(':');
          if (i > 0) header[part.slice(0, i).trim()] = part.slice(i + 1).trim();
        }
      }
      if (colors.length === 0 && line.startsWith('; filament_colour =')) {
        for (const c of line.split('=')[1].split(';')) if (c.trim()) colors.push(c.trim().toUpperCase());
      } else if (line === '; WIPE_TOWER_START') inTower = true;
      else if (line === '; WIPE_TOWER_END') inTower = false;
      else if (line.startsWith('; FEATURE:')) feature = line.slice(10).trim();
      else if (line === '; CHANGE_LAYER') { cur = { z: 0, features: new Map(), moves: [] }; layers.push(cur); }
      else if (line.startsWith('; Z_HEIGHT:') && cur) cur.z = parseFloat(line.slice(11));
      continue;
    }
    const tm = line.match(/^T(\d+)\b/);
    if (tm) {
      const t = parseInt(tm[1], 10);
      if (t < 16) { if (tool >= 0 && t !== tool) toolChanges++; tool = t; }
      continue;
    }
    if (line.startsWith('G1') || line.startsWith('G0') || line.startsWith('G2') || line.startsWith('G3')) {
      const xm = line.match(/\bX(-?[0-9.]+)/), ym = line.match(/\bY(-?[0-9.]+)/), em = line.match(/\bE(-?[0-9.]+)/);
      const nx = xm ? parseFloat(xm[1]) : x, ny = ym ? parseFloat(ym[1]) : y;
      const tower = inTower || /prime tower|wipe tower/i.test(feature);
      if (em && (xm || ym) && parseFloat(em[1]) > 0 && !tower && tool >= 0) {
        extrudePerTool.set(tool, (extrudePerTool.get(tool) ?? 0) + 1);
        if (cur) {
          let f = cur.features.get(feature);
          if (!f) { f = new Map(); cur.features.set(feature, f); }
          f.set(tool, (f.get(tool) ?? 0) + 1);
          cur.moves.push([x, y, nx, ny, tool, feature]);
        }
      }
      x = nx; y = ny;
    }
  }
  return { colors, extrudePerTool, toolChanges, layers, header };
}

interface Slice {
  exit: number | null; timedOut: boolean; returnCode: number | null; error: string; ms: number;
  gcode: Gcode | null; result: any; logTail: string; dir: string;
}

function runCli(bin: string, cliArgs: string[], dir: string): Promise<Slice> {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const t0 = Date.now();
  return new Promise((res) => {
    const ch = spawn(bin, cliArgs, { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = '';
    ch.stdout.on('data', (d) => { log += d; });
    ch.stderr.on('data', (d) => { log += d; });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; ch.kill('SIGKILL'); }, TIMEOUT_MS);
    ch.on('close', (code, signal) => {
      clearTimeout(timer);
      writeFileSync(`${dir}/cli.log`, log);
      let returnCode: number | null = null, error = '', result: any = null;
      if (existsSync(`${dir}/result.json`)) {
        try { result = JSON.parse(readFileSync(`${dir}/result.json`, 'utf8')); returnCode = result.return_code; error = result.error_string ?? ''; } catch { /* */ }
      }
      const gcode = existsSync(`${dir}/plate_1.gcode`) ? parseGcode(`${dir}/plate_1.gcode`) : null;
      res({ exit: code ?? (signal ? -1 : null), timedOut, returnCode, error, ms: Date.now() - t0, gcode, result, logTail: log.trim().split('\n').slice(-6).join('\n'), dir });
    });
  });
}

const slice = (ver: string, file: string, dir: string) => runCli(BIN[ver], ['--slice', '0', '--outputdir', dir, file], dir);

async function pool<T>(jobs: (() => Promise<T>)[], n: number): Promise<T[]> {
  const out: T[] = new Array(jobs.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, jobs.length) }, async () => {
    while (next < jobs.length) { const i = next++; out[i] = await jobs[i](); }
  }));
  return out;
}

/** exit 0 + every filament extrudes. */
function assess(label: string, s: Slice, ncolors: number): boolean {
  const why: string[] = [];
  if (s.timedOut) why.push('TIMEOUT');
  if (s.exit !== 0) why.push(`exit ${s.exit}`);
  if (s.returnCode !== null && s.returnCode !== 0) why.push(`return_code ${s.returnCode} "${s.error}"`);
  if (!s.gcode) why.push('no gcode');
  const missing = Array.from({ length: ncolors }, (_, i) => i).filter((t) => !(s.gcode?.extrudePerTool.get(t)));
  if (s.gcode && missing.length) why.push(`no extrusion T${missing.join(',T')}`);
  const tools = s.gcode ? [...s.gcode.extrudePerTool.entries()].sort((a, b) => a[0] - b[0]).map(([t, n]) => `T${t}:${n}`).join(' ') : '';
  if (why.length) { fail(`${label}: ${why.join('; ')}\n       ${s.logTail.split('\n').join('\n       ')}`); return false; }
  ok(`${label}: exit 0, ${(s.ms / 1000).toFixed(0)}s, ${tools}`);
  return true;
}

function nearestLayer(g: Gcode, z: number): LayerInfo {
  return g.layers.reduce((b, l) => (Math.abs(l.z - z) < Math.abs(b.z - z) ? l : b));
}

function featureReport(layer: LayerInfo): string[] {
  return [...layer.features.entries()].sort().map(([f, m]) =>
    `${f.padEnd(24)} ${[...m.entries()].sort((a, b) => a[0] - b[0]).map(([t, n]) => `T${t}:${n}`).join(' ')}`);
}

const RENDER_PY = `
import json, sys
from PIL import Image, ImageDraw
d = json.load(open(sys.argv[1])); out = sys.argv[2]
moves = d["moves"]; tools = sorted(set(m[4] for m in moves)) or [0]
feats = sorted(set(m[5] for m in moves))
pal = [(220,50,47),(38,139,210),(133,153,0),(181,137,0),(108,113,196),(42,161,152),(211,54,130),(120,120,120)]
fc = {f: pal[i % len(pal)] for i, f in enumerate(feats)}
xs = [v for m in moves for v in (m[0], m[2])]; ys = [v for m in moves for v in (m[1], m[3])]
x0, x1, y0, y1 = min(xs) - 2, max(xs) + 2, min(ys) - 2, max(ys) + 2
S = 560 / max(x1 - x0, y1 - y0); W = int((x1 - x0) * S); H = int((y1 - y0) * S)
img = Image.new("RGB", (W * len(tools) + 10 * (len(tools) - 1), H + 30 + 16 * len(feats)), "white")
dr = ImageDraw.Draw(img)
for i, t in enumerate(tools):
    ox = i * (W + 10)
    dr.rectangle([ox, 0, ox + W - 1, H - 1], outline=(200,200,200))
    dr.text((ox + 4, 4), f"T{t} ({d['colors'][t] if t < len(d['colors']) else '?'})  z={d['z']}", fill="black")
    for m in moves:
        if m[4] != t: continue
        dr.line([ox + (m[0]-x0)*S, H - (m[1]-y0)*S, ox + (m[2]-x0)*S, H - (m[3]-y0)*S], fill=fc[m[5]], width=2)
for j, f in enumerate(feats):
    yy = H + 10 + 16 * j
    dr.rectangle([4, yy, 16, yy + 10], fill=fc[f]); dr.text((22, yy - 1), f, fill="black")
img.save(out)
`;

function renderLayer(g: Gcode, layer: LayerInfo, png: string): void {
  const json = `${png}.json`;
  writeFileSync(json, JSON.stringify({ z: layer.z, colors: g.colors, moves: layer.moves }));
  const py = `${OUT}/render-layer.py`;
  writeFileSync(py, RENDER_PY);
  const pyBin = process.env.IMG2COLOR_PY ?? (existsSync(`${ROOT}/../cli/.venv/bin/python3`) ? `${ROOT}/../cli/.venv/bin/python3` : 'python3');
  try { execFileSync(pyBin, ['-I', py, json, png], { stdio: 'pipe' }); console.log(`  render: ${png}`); }
  catch (e) { console.log(`  render skipped: ${(e as Error).message.split('\n')[0]}`); }
}

function sliceSummary(s: Slice) {
  const g = s.gcode!, plate = s.result?.sliced_plates?.[0];
  const fil = (plate?.filaments ?? []) as { id: number; main_used_g: number; total_used_g: number }[];
  return {
    toolChanges: g.toolChanges,
    filamentChangeTimes: plate?.filament_change_times ?? null,
    flushTimeS: plate?.feature_type_times?.Flush ?? null,
    primeTowerTimeS: plate?.feature_type_times?.['Prime tower'] ?? null,
    wasteG: fil.map((f) => +(f.total_used_g - f.main_used_g).toFixed(2)),
    usedG: g.header['total filament weight [g]'] ?? fil.map((f) => f.total_used_g.toFixed(2)).join(','),
    modelG: fil.map((f) => +f.main_used_g.toFixed(2)),
    time: g.header['total estimated time'] ?? null,
  };
}

// ------------------------------------------------------------------------------------ cases

interface Built { result: Result; objects: ExportObject[]; colors: string[]; shellMs: number }

async function build(image: RasterImage, model: Model | null, params: Params, name: string): Promise<Built> {
  const pipe = createPipeline();
  shellStats.ms = 0;
  const result = await pipe.run(image, model, params);
  const shellMs = shellStats.ms;
  pipe.dispose();
  const colors = result.regions.map((r) => r.hex.toUpperCase());
  return { result, objects: objectsFromResult(result, colors, name), colors, shellMs };
}

async function project(b: Built, printer: string, tag: string): Promise<string> {
  const { bytes } = await writeBambuProject(b.objects, { printerId: printer, filamentColors: b.colors });
  const file = `${OUT}/${tag}-${printer}.3mf`;
  writeFileSync(file, bytes);
  return file;
}

async function paintCase(tag: string, label: string, image: RasterImage, model: Model, params: Params, slices: [string, string][]) {
  console.log(`\n# ${tag}: ${label}`);
  const b = await build(image, model, params, tag);
  console.log(`  shell build ${b.shellMs.toFixed(0)} ms (erode tris ${shellStats.erodeTris.join(',')}), depth=${b.result.depth}, `
    + `${b.objects.length} obj, ${b.objects.reduce((s, o) => s + o.parts.length, 0)} parts, skins=${b.result.faceSkins.length}`);
  checkObjects(tag, b.objects);
  if (params.depth != null) checkShells(tag, model, params.depth);
  const jobs = slices.map(([printer, ver]) => async () => {
    const file = await project(b, printer, tag);
    return { printer, ver, s: await slice(ver, file, `${OUT}/${tag}-${printer}-${ver}`) };
  });
  const res = await pool(jobs, CONCURRENCY);
  for (const r of res) assess(`${tag} ${r.printer} ${r.ver}`, r.s, b.colors.length);
  return { b, res };
}

const stripes = stripeImage();
const boxModel = (): Model => ({ objects: [{ name: 'box', parts: [{ name: 'box', mesh: box(0, 0, 40, 40, 40) }] }] });

if (want('A')) {
  const slices: [string, string][] = [['x1c-0.4', '1.10'], ['x1c-0.4', '2.8'], ['p2s-0.4', '2.8']];
  const depth = await paintCase('A-depth', '40 mm box, 3 colors, axis y, depth 0.6', stripes, boxModel(), P({ axis: 'y', depth: 0.6 }), slices);
  const full = await paintCase('A-full', '40 mm box, 3 colors, axis y, Full', stripes, boxModel(), P({ axis: 'y' }), slices);
  for (const d of depth.res) {
    if (!d.s.gcode) continue;
    const layer = nearestLayer(d.s.gcode, 20);
    console.log(`\n  A-depth ${d.printer} ${d.ver}: mid layer z=${layer.z} per FEATURE tools:`);
    for (const l of featureReport(layer)) console.log(`    ${l}`);
    const only0 = (f: string) => { const m = layer.features.get(f); return !m || [...m.keys()].every((t) => t === 0); };
    for (const f of ['Sparse infill', 'Internal solid infill']) {
      if (only0(f)) ok(`${f}: tool 0 only`); else fail(`${f}: tools ${[...layer.features.get(f)!.keys()]}`);
    }
    const ow = layer.features.get('Outer wall');
    if (ow && ow.size > 1) ok(`Outer wall: ${ow.size} tools`); else fail(`Outer wall tools: ${ow ? [...ow.keys()] : 'none'}`);
    const iw = layer.features.get('Inner wall');
    console.log(`  Inner wall: ${iw ? (only0('Inner wall') ? 'tool 0 only' : `tools ${[...iw.keys()].sort().join(',')} (NOT tool 0 only)`) : 'none'}`);
    renderLayer(d.s.gcode, layer, `${OUT}/A-depth-${d.printer}-${d.ver}-z${layer.z}.png`);
    const f = full.res.find((r) => r.printer === d.printer && r.ver === d.ver);
    if (f?.s.gcode) {
      const fl = nearestLayer(f.s.gcode, 20);
      renderLayer(f.s.gcode, fl, `${OUT}/A-full-${d.printer}-${d.ver}-z${fl.z}.png`);
      console.log(`  depth vs Full (${d.printer} ${d.ver}):`);
      const a = sliceSummary(d.s), c = sliceSummary(f.s);
      for (const k of Object.keys(a) as (keyof typeof a)[]) console.log(`    ${k.padEnd(20)} depth ${JSON.stringify(a[k])}  |  full ${JSON.stringify(c[k])}`);
    }
  }
}

if (want('B')) {
  console.log('\n# B: tile, 3 colors, thickness 2, depth 0.4');
  const b = await build(stripes, null, P({ width: 60, height: null, thickness: 2, depth: 0.4 }), 'tile');
  console.log(`  depth=${b.result.depth}, base ${b.result.base ? `${b.result.base.triangles.length / 3} tris` : 'null'}, objects ${b.objects.length}, `
    + `parts ${b.objects[0].parts.map((p) => `${p.name}:${p.subtype}:E${p.extruder}`).join(' ')}`);
  if (b.objects.length !== 1 || !b.result.base) fail('B: expected one object with a base');
  // colors as printed pieces: regions[0].mesh (slab − caps) vs the caps
  const pieces = b.result.regions.filter((r) => r.mesh).map((r) => ({ name: `piece${r.index + 1}`, mesh: r.mesh! }));
  checkObjects('B', b.objects, pieces);
  for (const p of pieces) { const s = manifoldStatus(p.mesh); if (s !== 'NoError') fail(`B ${p.name} status ${s}`); }
  const pv = pieces.reduce((s, p) => s + vol(p.mesh), 0), bv = vol(b.result.base!);
  if (Math.abs(pv - bv) / bv < 1e-4) ok(`B: pieces sum ${pv.toFixed(2)} = base ${bv.toFixed(2)} mm³`);
  else fail(`B: pieces sum ${pv.toFixed(2)} vs base ${bv.toFixed(2)} mm³`);
  const res = await pool((['1.10', '2.8'] as const).map((ver) => async () => ({ ver, s: await slice(ver, await project(b, 'x1c-0.4', 'B'), `${OUT}/B-x1c-0.4-${ver}`) })), 2);
  for (const { ver, s } of res) {
    if (!assess(`B x1c-0.4 ${ver}`, s, 3)) continue;
    const g = s.gcode!;
    const toolsOf = (l: LayerInfo) => new Set([...l.features.values()].flatMap((m) => [...m.keys()]));
    const lines = g.layers.filter((l) => l.moves.length).map((l) => `z=${l.z}: T${[...toolsOf(l)].sort().join(',T')}`);
    console.log(`  ${ver} layers: ${lines.join(' | ')}`);
    const low = g.layers.filter((l) => l.moves.length && l.z <= 2 - 0.4 + 1e-6);
    const high = g.layers.filter((l) => l.moves.length && l.z > 2 - 0.4 + 1e-6);
    if (low.every((l) => [...toolsOf(l)].every((t) => t === 0))) ok(`B ${ver}: ${low.length} bottom layers tool 0 only`);
    else fail(`B ${ver}: bottom layers use other tools`);
    if (high.length && high.every((l) => toolsOf(l).size >= 2)) ok(`B ${ver}: ${high.length} top layers use >= 2 tools`);
    else fail(`B ${ver}: top layers tools ${high.map((l) => toolsOf(l).size)}`);
  }
}

if (want('C')) {
  const model: Model = { objects: [{ name: 'asm', parts: [
    { name: 'p0', mesh: box(0, 0, 30, 30, 15) }, { name: 'p1', mesh: box(40, 0, 30, 30, 15) },
  ] }] };
  await paintCase('C', 'perPart, 2-part object, depth 0.6', stripes, model, P({ axis: 'y', perPart: true, depth: 0.6 }), [['x1c-0.4', '2.8']]);
}

if (want('D')) {
  const model: Model = { objects: [{ name: 'cyl', parts: [{ name: 'cyl', mesh: cylinderMesh(20, 40, 96) }] }] };
  await paintCase('D', 'cylindrical, cylinder r20 h40, depth 0.6', bandImage(), model,
    P({ axis: 'z', projection: 'cylindrical', resolution: 0.4, depth: 0.6 }), [['x1c-0.4', '2.8']]);
}

if (want('E')) {
  const m = box(0, 0, 40, 40, 40);
  const top = faceAlong(m, [0, 0, 1]);
  const face: PaintedFace = { id: 'top', objectIndex: 0, partIndex: 0, triangles: top.triangles, color: 1, area: top.area };
  await paintCase('E', 'box, top face painted, depth 0.6', stripes, { objects: [{ name: 'box', parts: [{ name: 'box', mesh: m }] }] },
    P({ axis: 'y', paintedFaces: [face], depth: 0.6 }), [['x1c-0.4', '2.8']]);
}

if (want('yeti')) {
  const path = `${homedir()}/Downloads/Yeti_Lid_Holder_-_PLA_basic.3mf`;
  console.log('\n# yeti: pipeline only, depth 0.6');
  if (!existsSync(path)) console.log(`  skipped: ${path} not found`);
  else {
    const model = loadModel(new Uint8Array(readFileSync(path)), path);
    const tris = model.objects.map((o) => o.parts.map((p) => p.mesh.triangles.length / 3));
    const image = readRgba(`${ROOT}/scratch/rgba/REDURBAN.rgba`);
    const t0 = performance.now();
    const b = await build(image, model, { ...DEFAULT_PARAMS, depth: 0.6 }, 'yeti');
    console.log(`  parts tris ${JSON.stringify(tris)}, erode tris ${shellStats.erodeTris.join(',')}`);
    console.log(`  shell build ${b.shellMs.toFixed(0)} ms (${shellStats.parts} parts), whole run ${(performance.now() - t0).toFixed(0)} ms`);
    checkObjects('yeti', b.objects);
  }
}

console.log(`\n${failures ? `${failures} FAILURE(S)` : 'ALL PASS'}`);
process.exit(failures ? 1 : 0);
