// Bambu Studio version-compatibility matrix for the Bambu project writer.
//
// Builds every case through the REAL pipeline (createPipeline().run) + objectsFromResult + writeBambuProject,
// then slices each project with no settings flags (`--slice 0`, all plates) in Bambu Studio 1.10 and 2.8 and
// asserts: exit code 0, every plate's `; filament_colour =` equals the requested colors in order, and every
// filament extrudes somewhere in the project (union across plates).
//
//   1.10-era printers (x1c/x1/x1e/p1s/p1p/a1/a1mini x 4 nozzles) x all cases       -> sliced in 1.10 AND 2.8
//   2.8-only printers (p2s/h2s x 4 nozzles) x paint + multiplate                    -> 2.8 only
//   + one p2s project in 1.10 (expected to be refused)
//   + plain .3mf (writePlain3mf) in 1.10 with flattened X1C 0.4 presets: do part extruders survive?
//
//   bun scripts/validate-studio-compat.ts                 # everything
//   bun scripts/validate-studio-compat.ts matrix          # sections: matrix, p28, refuse, plain
//   ONLY=x1c-0.4,a1mini bun scripts/validate-studio-compat.ts matrix   # printer-id substring filter
//
// G-code parsing + slice wrapper are copied from validate-bambu.ts (not edited).
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { unzipSync } from 'fflate';
import type { ManifoldToplevel } from 'manifold-3d';
import { initManifold } from '../src/core/manifold';
import { createPipeline } from '../src/core/pipeline';
import { objectsFromResult, writeBambuProject, writePlain3mf, PRINTERS } from '../src/core/threemf';
import { buildAdjacency, planarRegion, triNormal } from '../src/core/faces';
import { DEFAULT_PARAMS } from '../src/core/types';
import type { ExportObject, Mesh, Model, PaintedFace, Params, RasterImage, RGB, Vec3 } from '../src/core/types';

const BIN: Record<string, string> = {
  '1.10': process.env.BAMBU_110 ?? '/tmp/bs110/BambuStudio.app/Contents/MacOS/BambuStudio',
  '2.8': process.env.BAMBU_28 ?? '/Applications/BambuStudio.app/Contents/MacOS/BambuStudio',
};
const ROOT = resolve(import.meta.dir, '..');
const OUT = `${ROOT}/scratch/bambu/compat-matrix`;
const TIMEOUT_MS = 120_000;
const CONCURRENCY = 3;
const PALETTE: RGB[] = [[194, 24, 7], [31, 122, 31], [32, 64, 192]];
const OLD_PRINTERS = ['x1c', 'x1', 'x1e', 'p1s', 'p1p', 'a1', 'a1mini'];
const NEW_PRINTERS = ['p2s', 'h2s'];
const NOZZLES = ['0.2', '0.4', '0.6', '0.8'];
const ALL_CASES = ['image', 'paint', 'perpart', 'cyl', 'faces', 'multiobj', 'multiplate'] as const;
type CaseName = (typeof ALL_CASES)[number];

const sections = process.argv.slice(2);
const wantSection = (s: string) => sections.length === 0 || sections.includes(s);
const onlyIds = (process.env.ONLY ?? '').split(',').filter(Boolean);
const wantId = (id: string) => onlyIds.length === 0 || onlyIds.some((f) => id.includes(f));

mkdirSync(OUT, { recursive: true });

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

function cylinderMesh(wasm: ManifoldToplevel, r: number, h: number, segs: number): Mesh {
  const man = wasm.Manifold.cylinder(h, r, r, segs, true);
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

/** 3-color diagonal stripes. */
function stripeImage(size = 120, band = 24): RasterImage {
  const data = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const c = PALETTE[Math.floor((x + y) / band) % 3];
      const o = (y * size + x) * 4;
      data[o] = c[0]; data[o + 1] = c[1]; data[o + 2] = c[2]; data[o + 3] = 255;
    }
  return { width: size, height: size, data };
}

/** 3 vertical bands (seam-continuous) for the cylinder. */
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

// ------------------------------------------------------------------------------------ cases

interface Built { objects: ExportObject[]; colors: string[]; note: string }

const P = (extra: Partial<Params>): Params => ({
  ...DEFAULT_PARAMS, colors: 3, palette: PALETTE, smooth: 0, minFeature: 0, resolution: 0.3, ...extra,
});

async function runPipeline(image: RasterImage, model: Model | null, params: Params, name: string): Promise<Built> {
  const pipe = createPipeline();
  const result = await pipe.run(image, model, params);
  pipe.dispose();
  const colors = result.regions.map((r) => r.hex.toUpperCase());
  const objects = objectsFromResult(result, colors, name);
  const nMod = objects.reduce((s, o) => s + o.parts.filter((p) => p.subtype === 'modifier_part').length, 0);
  return { objects, colors, note: `${objects.length} obj, ${objects.reduce((s, o) => s + o.parts.length, 0)} parts (${nMod} mod), skins=${result.faceSkins.length}` };
}

const bedCache = new Map<string, Built>();
let wasmP: Promise<ManifoldToplevel> | null = null;

async function buildCase(c: CaseName, bed: [number, number]): Promise<Built> {
  const stripes = stripeImage();
  switch (c) {
    case 'image':
      return runPipeline(stripes, null, P({ width: 60, height: null, thickness: 1.5 }), 'tile');
    case 'paint':
      return runPipeline(stripes, { objects: [{ name: 'box', parts: [{ name: 'box', mesh: box(0, 0, 40, 30, 20) }] }] }, P({ axis: 'y' }), 'box');
    case 'perpart':
      return runPipeline(stripes, { objects: [{ name: 'asm', parts: [
        { name: 'p0', mesh: box(0, 0, 30, 30, 15) }, { name: 'p1', mesh: box(40, 0, 30, 30, 15) },
      ] }] }, P({ axis: 'y', perPart: true }), 'asm');
    case 'cyl': {
      wasmP ??= initManifold();
      const mesh = cylinderMesh(await wasmP, 20, 40, 96);
      return runPipeline(bandImage(), { objects: [{ name: 'cyl', parts: [{ name: 'cyl', mesh }] }] },
        P({ axis: 'z', projection: 'cylindrical', resolution: 0.4 }), 'cyl');
    }
    case 'faces': {
      const m = box(0, 0, 40, 30, 20);
      const top = faceAlong(m, [0, 0, 1]);
      const face: PaintedFace = { id: 'top', objectIndex: 0, partIndex: 0, triangles: top.triangles, color: 1, area: top.area };
      return runPipeline(stripes, { objects: [{ name: 'box', parts: [{ name: 'box', mesh: m }] }] }, P({ axis: 'y', paintedFaces: [face] }), 'box');
    }
    case 'multiobj':
      return runPipeline(stripes, { objects: [0, 1, 2].map((k) => ({ name: `o${k}`, parts: [{ name: `o${k}`, mesh: box(k * 40, 0, 30, 30, 10) }] })) },
        P({ axis: 'y' }), 'multi');
    case 'multiplate': {
      // 3 objects with identical (overlapping) footprints, each 0.6 x the short bed side -> re-arranged, 1 per plate.
      const key = bed.join('x');
      if (bedCache.has(key)) return bedCache.get(key)!;
      const s = Math.floor(0.6 * Math.min(bed[0], bed[1]));
      const b = await runPipeline(stripes, { objects: [0, 1, 2].map((k) => ({ name: `mp${k}`, parts: [{ name: `mp${k}`, mesh: box(0, 0, s, s, 3) }] })) },
        P({ axis: 'y', resolution: 0.5 }), 'mp');
      b.note += `, ${s}mm squares`;
      bedCache.set(key, b);
      return b;
    }
  }
}

// ------------------------------------------------------------------------------------ gcode + CLI

/** Copied from validate-bambu.ts: declared filament colors + extrusion-move count per active tool. */
function parseGcodeFile(gcode: string): { colors: string[]; extrudePerTool: Map<number, number> } {
  const colors: string[] = [];
  const extrudePerTool = new Map<number, number>();
  const text = readFileSync(gcode, 'utf8');
  let tool = 0, inTower = false, featureTower = false;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line.startsWith(';')) {
      const low = line.toLowerCase();
      if (colors.length === 0 && line.startsWith('; filament_colour =')) {
        for (const c of line.split('=')[1].split(';')) if (c.trim()) colors.push(c.trim().toUpperCase());
      } else if (line === '; WIPE_TOWER_START') inTower = true;
      else if (line === '; WIPE_TOWER_END') inTower = false;
      else if (low.startsWith('; feature:')) featureTower = low.includes('prime tower') || low.includes('wipe tower');
      continue;
    }
    const tm = line.match(/^T(\d+)\b/);
    if (tm) { tool = parseInt(tm[1], 10); continue; }
    if ((line.startsWith('G1') || line.startsWith('G0')) && !inTower && !featureTower) {
      const em = line.match(/\bE(-?[0-9.]+)/);
      const moved = /\b[XY]-?[0-9.]/.test(line);
      if (em && moved && parseFloat(em[1]) > 0) extrudePerTool.set(tool, (extrudePerTool.get(tool) ?? 0) + 1);
    }
  }
  return { colors, extrudePerTool };
}

interface Slice {
  exit: number | null; timedOut: boolean; returnCode: number | null; error: string; ms: number;
  plates: { colors: string[]; extrudePerTool: Map<number, number> }[]; logTail: string; dir: string;
}

function runCli(bin: string, args: string[], dir: string): Promise<Slice> {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const t0 = Date.now();
  return new Promise((res) => {
    const ch = spawn(bin, args, { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
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
        try { const j = JSON.parse(readFileSync(`${dir}/result.json`, 'utf8')); returnCode = j.return_code; error = j.error_string ?? ''; } catch { /* */ }
      }
      const plates: Slice['plates'] = [];
      for (let p = 1; existsSync(`${dir}/plate_${p}.gcode`); p++) plates.push(parseGcodeFile(`${dir}/plate_${p}.gcode`));
      const tail = log.trim().split('\n').slice(-6).join('\n');
      res({ exit: code ?? (signal ? -1 : null), timedOut, returnCode, error, ms: Date.now() - t0, plates, logTail: tail, dir });
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

function plateCount(bytes: Uint8Array): number {
  const xml = new TextDecoder().decode(unzipSync(bytes)['Metadata/model_settings.config']);
  return (xml.match(/<plate>/g) ?? []).length;
}

// ------------------------------------------------------------------------------------ assertions

interface Row { id: string; kase: string; ver: string; pass: boolean; detail: string }
const rows: Row[] = [];

function assess(s: Slice, colors: string[], expectPlates: number): { pass: boolean; detail: string } {
  const why: string[] = [];
  if (s.timedOut) why.push(`TIMEOUT ${TIMEOUT_MS / 1000}s`);
  if (s.exit !== 0) why.push(`exit ${s.exit}`);
  if (s.returnCode !== null && s.returnCode !== 0) why.push(`return_code ${s.returnCode} "${s.error}"`);
  if (s.plates.length === 0) why.push('no gcode');
  if (s.plates.length && s.plates.length !== expectPlates) why.push(`plates ${s.plates.length}/${expectPlates}`);
  const want = JSON.stringify(colors);
  s.plates.forEach((p, i) => { if (JSON.stringify(p.colors) !== want) why.push(`plate${i + 1} colors ${JSON.stringify(p.colors)}`); });
  const union = new Set<number>();
  for (const p of s.plates) for (const [t, n] of p.extrudePerTool) if (n > 0) union.add(t);
  const missing = colors.map((_, i) => i).filter((t) => !union.has(t));
  if (s.plates.length && missing.length) why.push(`no extrusion T${missing.join(',T')}`);
  const tools = s.plates.map((p) => [...p.extrudePerTool.entries()].sort().map(([t, n]) => `T${t}:${n}`).join(' ')).join(' | ');
  return { pass: why.length === 0, detail: why.length ? why.join('; ') : `${s.plates.length}pl ${(s.ms / 1000).toFixed(0)}s ${tools}` };
}

function record(id: string, kase: string, ver: string, s: Slice, colors: string[], expectPlates: number): void {
  const a = assess(s, colors, expectPlates);
  rows.push({ id, kase, ver, ...a });
  console.log(`${a.pass ? 'PASS' : 'FAIL'} ${id.padEnd(11)} ${kase.padEnd(10)} ${ver.padEnd(4)} ${a.detail}`);
  if (!a.pass) console.log('     log tail:\n       ' + s.logTail.split('\n').join('\n       '));
}

function table(): void {
  const vers = ['1.10', '2.8'];
  const ids = [...new Set(rows.map((r) => r.id))];
  const cases = [...new Set(rows.map((r) => r.kase))];
  console.log('\n==== matrix (cell = 1.10/2.8; P pass, F fail, - not run)');
  console.log('  ' + 'printer'.padEnd(12) + cases.map((c) => c.padEnd(11)).join(''));
  for (const id of ids) {
    const cells = cases.map((c) => vers.map((v) => {
      const r = rows.find((x) => x.id === id && x.kase === c && x.ver === v);
      return r ? (r.pass ? 'P' : 'F') : '-';
    }).join('/').padEnd(11));
    console.log('  ' + id.padEnd(12) + cells.join(''));
  }
  const nPass = rows.filter((r) => r.pass).length;
  console.log(`\n  ${nPass}/${rows.length} slices passed`);
  const fails = rows.filter((r) => !r.pass);
  if (fails.length) console.log('  FAILURES:\n' + fails.map((r) => `   - ${r.id} ${r.kase} ${r.ver}: ${r.detail}`).join('\n'));
}

// ------------------------------------------------------------------------------------ sections

async function writeProject(id: string, kase: CaseName): Promise<{ file: string; colors: string[]; nPlates: number; warnings: string[] }> {
  const pr = PRINTERS.find((p) => p.id === id)!;
  const b = await buildCase(kase, pr.bed as [number, number]);
  const { bytes, warnings } = await writeBambuProject(b.objects, { printerId: id, filamentColors: b.colors });
  const file = `${OUT}/${id}-${kase}.3mf`;
  writeFileSync(file, bytes);
  return { file, colors: b.colors, nPlates: plateCount(bytes), warnings };
}

async function matrix(): Promise<void> {
  console.log('\n# case builds');
  for (const c of ALL_CASES) {
    const b = await buildCase(c, [256, 256]);
    console.log(`  ${c.padEnd(10)} colors=${b.colors.join(',')} ${b.note}`);
  }
  const jobs: (() => Promise<void>)[] = [];
  for (const m of OLD_PRINTERS) for (const nz of NOZZLES) {
    const id = `${m}-${nz}`;
    if (!wantId(id)) continue;
    for (const c of ALL_CASES) {
      const w = await writeProject(id, c);
      if (c === 'multiplate' && w.nPlates < 2) console.log(`  WARN ${id} multiplate wrote ${w.nPlates} plate(s): ${w.warnings.join('|')}`);
      for (const ver of ['1.10', '2.8']) {
        jobs.push(async () => record(id, c, ver, await slice(ver, w.file, `${OUT}/${id}-${c}-${ver}`), w.colors, w.nPlates));
      }
    }
  }
  console.log(`\n# matrix: ${jobs.length} slices, ${CONCURRENCY} parallel`);
  await pool(jobs, CONCURRENCY);
}

async function p28(): Promise<void> {
  const jobs: (() => Promise<void>)[] = [];
  for (const m of NEW_PRINTERS) for (const nz of NOZZLES) {
    const id = `${m}-${nz}`;
    if (!wantId(id)) continue;
    for (const c of ['paint', 'multiplate'] as CaseName[]) {
      const w = await writeProject(id, c);
      if (c === 'multiplate' && w.nPlates < 2) console.log(`  WARN ${id} multiplate wrote ${w.nPlates} plate(s)`);
      jobs.push(async () => record(id, c, '2.8', await slice('2.8', w.file, `${OUT}/${id}-${c}-2.8`), w.colors, w.nPlates));
    }
  }
  console.log(`\n# 2.8-only printers: ${jobs.length} slices`);
  await pool(jobs, CONCURRENCY);
}

async function refuse(): Promise<void> {
  console.log('\n# 1.10 vs a p2s-0.4 project (expected refusal)');
  const w = await writeProject('p2s-0.4', 'paint');
  const s = await slice('1.10', w.file, `${OUT}/p2s-0.4-paint-1.10-refuse`);
  const a = assess(s, w.colors, w.nPlates);
  const refused = !a.pass;
  console.log(`  ${refused ? 'REFUSED (expected)' : 'UNEXPECTEDLY SLICED'}: exit ${s.exit}, rc ${s.returnCode} "${s.error}", gcode plates ${s.plates.length}, ${(s.ms / 1000).toFixed(0)}s`);
  console.log('  log tail:\n    ' + s.logTail.split('\n').join('\n    '));
}

/** Flatten 1.10's X1C 0.4 machine/process/PLA Basic via capture-bambu-templates.py helpers. */
function flatten110(dir: string, colors: string[]): { machine: string; process: string; filaments: string[] } {
  mkdirSync(dir, { recursive: true });
  const py = `
import importlib.util, json, os, sys
spec = importlib.util.spec_from_file_location("cap", sys.argv[1]); cap = importlib.util.module_from_spec(spec); spec.loader.exec_module(cap)
out, colors = sys.argv[2], sys.argv[3].split(",")
idx = cap.preset_index(os.environ["BAMBU_STUDIO"]); c = cap.enumerate_combos(idx)["x1c-0.4"]
m = cap.resolve_preset(idx, c["machine"], "machine"); p = cap.resolve_preset(idx, c["process"], "process"); f = cap.resolve_preset(idx, c["filament"], "filament")
json.dump(m, open(out + "/machine.json", "w")); json.dump(p, open(out + "/process.json", "w"))
for i, h in enumerate(colors):
    d = dict(f); d["filament_colour"] = [h]; json.dump(d, open(f"{out}/filament{i+1}.json", "w"))
print(c["machine"], "|", c["process"], "|", c["filament"])
`;
  const helper = `${dir}/flatten.py`;
  writeFileSync(helper, py);
  const log = execFileSync('python3', ['-I', helper, `${ROOT}/scripts/capture-bambu-templates.py`, dir, colors.join(',')],
    { encoding: 'utf8', env: { ...process.env, BAMBU_STUDIO: BIN['1.10'] } });
  console.log(`  presets: ${log.trim()}`);
  return { machine: `${dir}/machine.json`, process: `${dir}/process.json`, filaments: colors.map((_, i) => `${dir}/filament${i + 1}.json`) };
}

async function plain(): Promise<void> {
  console.log('\n# plain .3mf in 1.10 (X1C 0.4 flattened presets) vs Bambu project (x1c-0.4) in 1.10');
  for (const c of ['paint', 'perpart'] as CaseName[]) {
    const b = await buildCase(c, [256, 256]);
    const pf = `${OUT}/plain-${c}.3mf`;
    writeFileSync(pf, writePlain3mf(b.objects));
    const pre = flatten110(`${OUT}/plain-presets`, b.colors);
    const dir = `${OUT}/plain-${c}-1.10`;
    const s = await runCli(BIN['1.10'], ['--load-settings', `${pre.machine};${pre.process}`, '--load-filaments', pre.filaments.join(';'),
      '--slice', '0', '--outputdir', dir, pf], dir);
    const w = await writeProject('x1c-0.4', c);
    const sp = await slice('1.10', w.file, `${OUT}/x1c-0.4-${c}-1.10-ref`);
    const fmt = (x: Slice) => x.plates.map((p) => [...p.extrudePerTool.entries()].sort().map(([t, n]) => `T${t}:${n}`).join(' ')).join(' | ') || '(no gcode)';
    const tools = new Set(s.plates.flatMap((p) => [...p.extrudePerTool.keys()]));
    const modTools = b.objects.flatMap((o) => o.parts.filter((p) => p.subtype === 'modifier_part').map((p) => p.extruder - 1));
    const modsLand = [...new Set(modTools)].every((t) => tools.has(t));
    console.log(`  ${c}: plain exit ${s.exit}${s.timedOut ? ' TIMEOUT' : ''}, colors ${JSON.stringify(s.plates[0]?.colors ?? [])}`);
    console.log(`     plain   per-tool: ${fmt(s)}`);
    console.log(`     project per-tool: ${fmt(sp)} (exit ${sp.exit})`);
    console.log(`     >1 tool extrudes: ${tools.size > 1 ? 'YES' : 'NO'}; modifier tools ${JSON.stringify([...new Set(modTools)])} land: ${modsLand ? 'YES' : 'NO'}`);
    if (s.exit !== 0) console.log('     log tail:\n       ' + s.logTail.split('\n').join('\n       '));
  }
}

if (wantSection('matrix')) await matrix();
if (wantSection('p28')) await p28();
if (rows.length) table();
if (wantSection('refuse')) await refuse();
if (wantSection('plain')) await plain();
process.exit(rows.some((r) => !r.pass) ? 1 : 0);
