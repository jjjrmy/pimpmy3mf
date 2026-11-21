// Plate-centring validation for the Bambu project writer (layoutObjects / centreGroup in src/core/threemf.ts).
// Four cases go through the real pipeline (3-colour REDURBAN camo) + objectsFromResult + writeBambuProject:
//   perpart     a 3-part assembly (one object, three 30x30x20 boxes side by side), params.perPart = true
//   yeti        scratch/centering/yeti.3mf, a 7-plate Bambu project, exported like the app does (sourcePlates: every
//               object stays on its source plate at its offset from the plate centre, which is <= 0.4 mm here). Its
//               deepest lids (up to 230 mm) don't fit the A1 mini's 180 mm bed: there the export must warn and Bambu
//               Studio must refuse to slice it; the centring checks run on X1C / P2S
//   big-a1mini  one 130x100x15 box (may need a shift for the tower on the A1 mini)
//   single      one 40 mm box, single plate (regression: still centred)
// Each is exported for x1c-0.4 (sliced in Bambu Studio 2.8 and 1.10), p2s-0.4 and a1mini-0.4 (2.8), sliced with
// `--slice 0 --outputdir DIR FILE` (no settings flags), at most 3 at a time, 120 s timeout (a timed-out slice is
// re-run once alone). Per plate it checks: rc 0, filament colours, every filament extrudes, tower on the bed, clear
// of the objects and the exclusion polygon, and the object group's centre vs the printable-area centre, measured
// from the 3MF (build-item transforms + normal-part meshes - plate origin) and from the G-code (non-tower,
// non-skirt/brim extrusion bbox). |offset| <= 0.5 mm when plateShifts[k] = 0, else |offset| = shift +- 1 mm.
//
//   bun scripts/validate-centering.ts            (outputs in scratch/bambu/centering/)
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { unzipSync } from 'fflate';
import { loadModel } from '../src/core/meshio';
import { createPipeline } from '../src/core/pipeline';
import { PRINTERS, objectsFromResult, writeBambuProject } from '../src/core/threemf';
import { DEFAULT_PARAMS } from '../src/core/types';
import type { ExportObject, Mesh, Model, Params, RasterImage } from '../src/core/types';

const BIN: Record<string, string> = {
  '1.10': process.env.BAMBU_110 ?? '/tmp/bs110/BambuStudio.app/Contents/MacOS/BambuStudio',
  '2.8': process.env.BAMBU_28 ?? '/Applications/BambuStudio.app/Contents/MacOS/BambuStudio',
};
const ROOT = resolve(import.meta.dir, '..');
const OUT = `${ROOT}/scratch/bambu/centering`;
const TOWER_PY = `${ROOT}/scratch/bambu/excl/tower_extents.py`;
const YETI = `${ROOT}/scratch/centering/yeti.3mf`;
const CAMO = `${ROOT}/scratch/rgba/REDURBAN.rgba`;
const TIMEOUT_MS = 120_000;
const PARALLEL = 3;
const PLATE_GAP = 1.2;
const REUSE = process.env.REUSE === '1'; // re-check existing slice dirs (written by a previous run) without re-slicing
mkdirSync(OUT, { recursive: true });

let passed = 0, failed = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) passed++;
  else failed++;
  console.log(`   ${ok ? '✓' : '✗'} ${name}${detail ? ` ${detail}` : ''}`);
}

// ---- inputs -------------------------------------------------------------------------------------------------

function box(ox: number, oy: number, oz: number, w: number, d: number, h: number): Mesh {
  const v = [ox, oy, oz, ox + w, oy, oz, ox + w, oy + d, oz, ox, oy + d, oz, ox, oy, oz + h, ox + w, oy, oz + h, ox + w, oy + d, oz + h, ox, oy + d, oz + h];
  const t = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7];
  return { vertices: new Float32Array(v), triangles: new Uint32Array(t) };
}
function camoImage(): RasterImage {
  const buf = readFileSync(CAMO);
  const width = buf.readUInt32LE(4), height = buf.readUInt32LE(8);
  const data = new Uint8ClampedArray(width * height * 4);
  data.set(buf.subarray(12, 12 + width * height * 4));
  return { width, height, data };
}

type CaseName = 'perpart' | 'yeti' | 'big-a1mini' | 'single';
const CASES: CaseName[] = ['perpart', 'yeti', 'big-a1mini', 'single'];
function caseModel(c: CaseName): { model: Model; params: Partial<Params> } {
  switch (c) {
    case 'perpart':
      // offset from the origin on purpose so a kept layout must be moved to be centred
      return { model: { objects: [{ name: 'asm', parts: [0, 1, 2].map((k) => ({ name: `p${k}`, mesh: box(10 + k * 32, 20, 0, 30, 30, 20) })) }] }, params: { perPart: true } };
    case 'yeti':
      return { model: loadModel(new Uint8Array(readFileSync(YETI)), YETI), params: {} };
    case 'big-a1mini':
      return { model: { objects: [{ name: 'big', parts: [{ name: 'big', mesh: box(5, 5, 0, 130, 100, 15) }] }] }, params: {} };
    case 'single':
      return { model: { objects: [{ name: 'cube', parts: [{ name: 'cube', mesh: box(3, 7, 0, 40, 40, 40) }] }] }, params: {} };
  }
}

// ---- 3MF reading --------------------------------------------------------------------------------------------

interface BBox { x0: number; y0: number; x1: number; y1: number }
const grow = (b: BBox | undefined, x: number, y: number): BBox =>
  b ? { x0: Math.min(b.x0, x), y0: Math.min(b.y0, y), x1: Math.max(b.x1, x), y1: Math.max(b.y1, y) } : { x0: x, y0: y, x1: x, y1: y };
const union = (bs: BBox[]): BBox | null => (bs.length ? { x0: Math.min(...bs.map((b) => b.x0)), y0: Math.min(...bs.map((b) => b.y0)), x1: Math.max(...bs.map((b) => b.x1)), y1: Math.max(...bs.map((b) => b.y1)) } : null);
const centre = (b: BBox): [number, number] => [(b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2];
type Pt = [number, number];
const parsePoly = (v: unknown): Pt[] =>
  (Array.isArray(v) ? v : []).map((s) => String(s).split('x').map(parseFloat) as Pt).filter((p) => p.length === 2 && p.every(Number.isFinite));
const polyBox = (p: Pt[]): BBox => ({ x0: Math.min(...p.map((q) => q[0])), y0: Math.min(...p.map((q) => q[1])), x1: Math.max(...p.map((q) => q[0])), y1: Math.max(...p.map((q) => q[1])) });
function rectGap(a: BBox, b: BBox): number {
  const dx = Math.max(b.x0 - a.x1, a.x0 - b.x1), dy = Math.max(b.y0 - a.y1, a.y0 - b.y1);
  if (dx < 0 && dy < 0) return Math.max(dx, dy);
  return Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
}

interface ProjectInfo { nPlates: number; centre: Pt; bed: BBox; excl: BBox | null; plateBoxes: (BBox | null)[]; instances: number }
/** Per plate: the plate-local XY bbox of its objects' NORMAL parts, from the 3MF itself. */
function readProject(bytes: Uint8Array, bedDims: [number, number]): ProjectInfo {
  const z = unzipSync(bytes);
  const dec = (k: string) => new TextDecoder().decode(z[k]);
  const ps = JSON.parse(dec('Metadata/project_settings.config'));
  const area = parsePoly(ps.printable_area), ex = parsePoly(ps.bed_exclude_area);
  const bed = area.length >= 3 ? polyBox(area) : { x0: 0, y0: 0, x1: bedDims[0], y1: bedDims[1] };
  const exBox = ex.length >= 3 ? polyBox(ex) : null;
  const excl = exBox && exBox.x1 - exBox.x0 > 0 && exBox.y1 - exBox.y0 > 0 ? exBox : null;

  // mesh bbox (xy) per geometry object id in object_1.model
  const meshBox = new Map<number, BBox>();
  for (const m of dec('3D/Objects/object_1.model').matchAll(/<object id="(\d+)"[^>]*>([\s\S]*?)<\/object>/g)) {
    let b: BBox | undefined;
    for (const v of m[2].matchAll(/<vertex x="([-\d.eE+]+)" y="([-\d.eE+]+)"/g)) b = grow(b, +v[1], +v[2]);
    if (b) meshBox.set(+m[1], b);
  }
  // root object -> component ids (+ their transforms), and build-item transform per root
  const root = dec('3D/3dmodel.model');
  const comps = new Map<number, { id: number; t: number[] }[]>();
  for (const m of root.matchAll(/<object id="(\d+)"[^>]*>([\s\S]*?)<\/object>/g))
    comps.set(+m[1], [...m[2].matchAll(/<component[^>]*objectid="(\d+)"[^>]*transform="([^"]+)"/g)].map((c) => ({ id: +c[1], t: c[2].split(/\s+/).map(Number) })));
  const itemT = new Map<number, number[]>();
  for (const m of root.matchAll(/<item objectid="(\d+)"[^>]*transform="([^"]+)"/g)) itemT.set(+m[1], m[2].split(/\s+/).map(Number));

  // subtypes + plates from model_settings
  const msx = dec('Metadata/model_settings.config');
  const subtype = new Map<number, string>();
  for (const m of msx.matchAll(/<part id="(\d+)" subtype="(\w+)">/g)) subtype.set(+m[1], m[2]);
  const plates = [...msx.matchAll(/<plate>([\s\S]*?)<\/plate>/g)].map((m) => [...m[1].matchAll(/key="object_id" value="(\d+)"/g)].map((o) => +o[1]));
  const nPlates = plates.length;
  const cols = Math.ceil(Math.sqrt(nPlates));

  const objBox = (rid: number): BBox | null => {
    const T = itemT.get(rid)!;
    const cs = comps.get(rid) ?? [];
    const normal = cs.filter((c) => subtype.get(c.id) === 'normal_part');
    const use = normal.length ? normal : cs;
    const bs: BBox[] = [];
    for (const c of use) {
      const b = meshBox.get(c.id);
      if (!b) continue;
      // only translations are emitted (rotation parts are identity); apply both translations
      const ox = (c.t[9] ?? 0) + T[9], oy = (c.t[10] ?? 0) + T[10];
      if (Math.abs(T[0] - 1) > 1e-9 || Math.abs(T[4] - 1) > 1e-9 || T[1] || T[3]) throw new Error(`item ${rid}: non-translation transform`);
      bs.push({ x0: b.x0 + ox, y0: b.y0 + oy, x1: b.x1 + ox, y1: b.y1 + oy });
    }
    return union(bs);
  };
  const plateBoxes = plates.map((rids, k) => {
    const ox = (k % cols) * PLATE_GAP * bedDims[0], oy = -Math.floor(k / cols) * PLATE_GAP * bedDims[1];
    const u = union(rids.map(objBox).filter((b): b is BBox => !!b));
    return u ? { x0: u.x0 - ox, y0: u.y0 - oy, x1: u.x1 - ox, y1: u.y1 - oy } : null;
  });
  return { nPlates, centre: centre(bed), bed, excl, plateBoxes, instances: plates.flat().length };
}

// ---- G-code / slicing ---------------------------------------------------------------------------------------

interface PlateG { offset: [number, number]; colors: string[]; extrudePerTool: Map<number, number>; usedMm: number[]; objects: Map<string, BBox>; all: BBox | null; tower: BBox | null }
const SKIP_FEAT = ['skirt', 'brim', 'tower', 'custom', 'prime'];
function parseGcodeFile(gcode: string): Omit<PlateG, 'tower'> {
  const colors: string[] = [];
  let usedMm: number[] = [];
  const extrudePerTool = new Map<number, number>();
  const objects = new Map<string, BBox>();
  let all: BBox | undefined;
  let tool = 0, inTower = false, feat = '', obj: string | null = null, x = 0, y = 0;
  let offset: [number, number] = [0, 0];
  for (const raw of readFileSync(gcode, 'utf8').split('\n')) {
    const line = raw.trim();
    if (line.startsWith(';')) {
      const low = line.toLowerCase();
      const eo = line.match(/^; extruder_offset = (-?[\d.]+)x(-?[\d.]+)/);
      if (eo) offset = [+eo[1], +eo[2]];
      else if (colors.length === 0 && line.startsWith('; filament_colour =')) {
        for (const c of line.split('=')[1].split(';')) if (c.trim()) colors.push(c.trim().toUpperCase());
      } else if (!usedMm.length && /^; (total filament length|filament used) \[mm\]\s*[:=]/.test(line)) usedMm = line.split(/[:=]/)[1].split(',').map((v) => parseFloat(v));
      else if (line === '; WIPE_TOWER_START') inTower = true;
      else if (line === '; WIPE_TOWER_END') inTower = false;
      else if (low.startsWith('; feature:')) feat = low.slice(10).trim();
      else if (low.startsWith('; start printing object')) obj = low.split('id:')[1]?.trim() ?? '?';
      else if (low.startsWith('; stop printing object')) obj = null;
      continue;
    }
    const tm = line.match(/^T(\d+)\b/);
    if (tm) { tool = parseInt(tm[1], 10); continue; }
    if (/^G[0-3] /.test(line)) {
      const px = x, py = y;
      const mx = line.match(/X(-?[0-9.]+)/), my = line.match(/Y(-?[0-9.]+)/);
      if (mx) x = parseFloat(mx[1]);
      if (my) y = parseFloat(my[1]);
      const em = line.match(/\bE(-?[0-9.]+)/);
      const towerish = inTower || feat.includes('tower');
      if (em && (mx || my) && parseFloat(em[1]) > 0 && !towerish) {
        extrudePerTool.set(tool, (extrudePerTool.get(tool) ?? 0) + 1);
        if (feat && !SKIP_FEAT.some((s) => feat.includes(s))) {
          objects.set(obj ?? '*', grow(grow(objects.get(obj ?? '*'), px, py), x, y));
          all = grow(grow(all, px, py), x, y);
        }
      }
    }
  }
  if (objects.size > 1) objects.delete('*');
  // Studio writes G-code in nozzle coordinates = plate coordinates - extruder_offset; map back to the plate
  const sh = (b: BBox): BBox => ({ x0: b.x0 + offset[0], y0: b.y0 + offset[1], x1: b.x1 + offset[0], y1: b.y1 + offset[1] });
  for (const [k, b] of objects) objects.set(k, sh(b));
  return { offset, colors, extrudePerTool, usedMm, objects, all: all ? sh(all) : null };
}
function towerBoxes(files: string[]): (BBox | null)[] {
  if (!files.length) return [];
  const out = execFileSync('python3', ['-I', TOWER_PY, ...files], { encoding: 'utf8' }).trim().split('\n');
  return out.map((l) => {
    const m = l.match(/\(([-\d.]+), ([-\d.]+), ([-\d.]+), ([-\d.]+)\)\s*$/);
    return m ? { x0: +m[1], y0: +m[2], x1: +m[3], y1: +m[4] } : null;
  });
}
interface Slice { exit: number | null; timedOut: boolean; returnCode: number | null; error: string; ms: number; plates: PlateG[]; retried: boolean }
function readSlice(dir: string, exit: number | null, timedOut: boolean, ms: number): Slice {
  let returnCode: number | null = null, error = '';
  if (existsSync(`${dir}/result.json`)) {
    try { const j = JSON.parse(readFileSync(`${dir}/result.json`, 'utf8')); returnCode = j.return_code; error = j.error_string ?? ''; } catch { /* */ }
  }
  const files: string[] = [];
  for (let p = 1; existsSync(`${dir}/plate_${p}.gcode`); p++) files.push(`${dir}/plate_${p}.gcode`);
  const towers = timedOut ? files.map(() => null) : towerBoxes(files);
  const plates = timedOut ? [] : files.map((f, i) => {
    const g = parseGcodeFile(f), t = towers[i];
    return { ...g, tower: t ? { x0: t.x0 + g.offset[0], y0: t.y0 + g.offset[1], x1: t.x1 + g.offset[0], y1: t.y1 + g.offset[1] } : null };
  });
  return { exit, timedOut, returnCode, error, ms, retried: false, plates };
}
function slice(bin: string, file: string, dir: string): Promise<Slice> {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const t0 = Date.now();
  return new Promise((res) => {
    const ch = spawn(bin, ['--slice', '0', '--outputdir', dir, file], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = '';
    ch.stdout.on('data', (d) => { log += d; });
    ch.stderr.on('data', (d) => { log += d; });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; ch.kill('SIGKILL'); }, TIMEOUT_MS);
    ch.on('close', (code, signal) => {
      clearTimeout(timer);
      writeFileSync(`${dir}/cli.log`, log);
      res(readSlice(dir, code ?? (signal ? -1 : null), timedOut, Date.now() - t0));
    });
  });
}

// ---- run ----------------------------------------------------------------------------------------------------

interface Job { cse: CaseName; printer: string; ver: string; file: string; colors: string[]; info: ProjectInfo; shifts: number[]; warnings: string[]; expectReject?: boolean }

async function main() {
  for (const p of [TOWER_PY, YETI, CAMO]) if (!existsSync(p)) throw new Error(`missing ${p}`);
  const image = camoImage();
  const printers = ['x1c-0.4', 'p2s-0.4', 'a1mini-0.4'];
  const jobs: Job[] = [];

  for (const cse of CASES) {
    console.log(`\n# ${cse}`);
    const { model, params } = caseModel(cse);
    const pipe = createPipeline();
    const result = await pipe.run(image, model, { ...DEFAULT_PARAMS, colors: 3, ...params });
    pipe.dispose();
    const hexes = result.regions.map((r) => r.hex.toUpperCase());
    const objects: ExportObject[] = objectsFromResult(result, hexes, cse);
    check(`${cse}: 3 colours`, hexes.length === 3, `(${hexes.join(',')})`);
    if (cse === 'perpart') check('perpart: 3 parts -> 3 objects', objects.length === 3, `(${objects.length})`);
    if (cse === 'yeti') check('yeti: 7 objects', objects.length === 7, `(${objects.length})`);
    for (const printer of printers) {
      const bedDims = PRINTERS.find((p) => p.id === printer)!.bed as [number, number];
      const src = result.model?.plates;
      const sourcePlates = src ? { count: src.count, bed: src.bed, bedOrigin: src.bedOrigin, names: src.names } : undefined;
      const { bytes, warnings, plateShifts } = await writeBambuProject(objects, { printerId: printer, filamentColors: hexes, sourcePlates });
      const file = `${OUT}/${cse}-${printer}.3mf`;
      writeFileSync(file, bytes);
      const info = readProject(bytes, bedDims);
      console.log(`   ${printer}: ${info.nPlates} plate(s), shifts [${plateShifts.map((s) => s.toFixed(1)).join(', ')}]${warnings.length ? `, warnings: ${warnings.join(' | ')}` : ''}`);
      check(`${cse} ${printer}: plateShifts has one entry per plate`, plateShifts.length === info.nPlates, `(${plateShifts.length} vs ${info.nPlates})`);
      check(`${cse} ${printer}: every object placed on a plate`, info.instances === objects.length, `(${info.instances}/${objects.length})`);
      if (cse === 'yeti') check(`yeti ${printer}: ${src?.count ?? '?'} source plates kept`, !!src && info.nPlates === src.count, `(${info.nPlates})`);
      const oversize = cse === 'yeti' && printer === 'a1mini-0.4';
      if (oversize) check('yeti a1mini-0.4: warns the lids are bigger than the 180 mm bed', warnings.some((w) => /bigger than the 180/.test(w)), warnings.join(' | '));
      for (const ver of printer === 'x1c-0.4' ? ['2.8', '1.10'] : ['2.8']) jobs.push({ cse, printer, ver, file, colors: hexes, info, shifts: plateShifts, warnings, expectReject: oversize });
    }
  }

  // ---- slice, at most PARALLEL at once; timed-out slices re-run once alone afterwards
  console.log(`\n# slicing ${jobs.length} projects (${PARALLEL} at a time, ${TIMEOUT_MS / 1000}s timeout)`);
  const dirOf = (j: Job) => `${OUT}/slice-${j.cse}-${j.printer}-${j.ver}`;
  const results = new Array<Slice>(jobs.length);
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const i = next++;
      const j = jobs[i];
      const st = `${dirOf(j)}/exit.json`;
      if (REUSE && existsSync(st)) {
        const e = JSON.parse(readFileSync(st, 'utf8'));
        results[i] = readSlice(dirOf(j), e.exit, e.timedOut, e.ms);
      } else results[i] = await slice(BIN[j.ver], j.file, dirOf(j));
      console.log(`   ${j.cse} ${j.printer} ${j.ver}: ${results[i].timedOut ? 'TIMEOUT' : `exit ${results[i].exit}`} (${(results[i].ms / 1000).toFixed(0)}s)`);
    }
  };
  await Promise.all(Array.from({ length: PARALLEL }, worker));
  for (let i = 0; i < jobs.length; i++)
    if (results[i].timedOut) {
      const j = jobs[i];
      console.log(`   re-running ${j.cse} ${j.printer} ${j.ver} alone`);
      results[i] = { ...(await slice(BIN[j.ver], j.file, dirOf(j))), retried: true };
      console.log(`     -> ${results[i].timedOut ? 'TIMEOUT again' : `exit ${results[i].exit}`} (${(results[i].ms / 1000).toFixed(0)}s)`);
    }

  for (let i = 0; i < jobs.length; i++) writeFileSync(`${dirOf(jobs[i])}/exit.json`, JSON.stringify({ exit: results[i].exit, timedOut: results[i].timedOut, ms: results[i].ms }));

  // ---- checks + table
  console.log('\n# checks');
  const rows: string[] = [];
  let platesTotal = 0, platesPass = 0, shiftedPlates = 0;
  const f1 = (n: number) => (n >= 0 ? '+' : '') + n.toFixed(2);
  for (let i = 0; i < jobs.length; i++) {
    const j = jobs[i], s = results[i];
    const label = `${j.cse} ${j.printer} ${j.ver}`;
    if (j.expectReject) {
      const sliced = !s.timedOut && s.exit === 0 && (s.returnCode === 0 || s.returnCode === null) && s.plates.length === j.info.nPlates;
      check(`${label}: oversized plates refused by Bambu Studio`, !sliced,
        `(exit ${s.exit}, return_code ${s.returnCode}${s.error ? ` "${s.error}"` : ''}, ${s.plates.length}/${j.info.nPlates} gcode plates${s.timedOut ? ', timeout' : ''})`);
      j.info.plateBoxes.forEach((_, k) => rows.push(`| ${j.cse} | ${j.printer} | ${j.ver} | ${k + 1} | - | - | ${(j.shifts[k] ?? NaN).toFixed(1)} | - | - | ${sliced ? 'FAIL: sliced' : 'PASS (refused, oversized)'} |`));
      continue;
    }
    const why: string[] = [];
    if (s.timedOut) why.push(`timeout${s.retried ? ' (after a solo re-run)' : ''}`);
    if (s.exit !== 0) why.push(`exit ${s.exit}`);
    if (s.returnCode !== null && s.returnCode !== 0) why.push(`return_code ${s.returnCode} "${s.error}"`);
    if (j.ver === '2.8' && s.returnCode === null && !s.timedOut) why.push('no result.json');
    if (!s.timedOut && s.plates.length !== j.info.nPlates) why.push(`${s.plates.length} gcode plates vs ${j.info.nPlates} in the 3MF`);
    const used = new Set<number>();
    for (const pl of s.plates) {
      pl.usedMm.forEach((mm, t) => mm > 0 && used.add(t));
      for (const [t, n] of pl.extrudePerTool) if (n > 0) used.add(t);
    }
    const missing = j.colors.map((_, t) => t).filter((t) => !used.has(t));
    if (s.plates.length && missing.length) why.push(`filament not used: ${missing.map((t) => `T${t + 1}`).join(',')}`);
    check(`${label}: rc 0, ${j.info.nPlates} plate(s) sliced, all filaments extrude`, why.length === 0, why.length ? `(${why.join('; ')})` : `(${(s.ms / 1000).toFixed(0)}s)`);
    if (s.timedOut || !s.plates.length) {
      j.info.plateBoxes.forEach((a, k) => {
        const o = a ? [centre(a)[0] - j.info.centre[0], centre(a)[1] - j.info.centre[1]] : null;
        rows.push(`| ${j.cse} | ${j.printer} | ${j.ver} | ${k + 1} | ${o ? `${f1(o[0])}, ${f1(o[1])}` : '-'} | - | ${(j.shifts[k] ?? NaN).toFixed(1)} | - | - | FAIL (not sliced): ${why.join('; ')} |`);
      });
      continue;
    }

    for (let k = 0; k < j.info.nPlates; k++) {
      platesTotal++;
      const pl = s.plates[k], shift = j.shifts[k] ?? NaN;
      if (shift > 0) shiftedPlates++;
      const pw: string[] = [];
      if (!pl) { pw.push('no gcode'); rows.push(`| ${j.cse} | ${j.printer} | ${j.ver} | ${k + 1} | - | - | ${shift} | - | - | FAIL: no gcode |`); check(`${label} plate ${k + 1}`, false, '(no gcode)'); continue; }
      if (JSON.stringify(pl.colors) !== JSON.stringify(j.colors)) pw.push(`filament_colour ${JSON.stringify(pl.colors)}`);
      // tower
      let objGap: number | null = null, exGap: number | null = null;
      const t = pl.tower;
      if (!t) pw.push('no tower');
      else {
        const b = j.info.bed;
        if (t.x0 < b.x0 || t.y0 < b.y0 || t.x1 > b.x1 || t.y1 > b.y1) pw.push(`tower off bed [${t.x0},${t.y0}-${t.x1},${t.y1}]`);
        const objs = [...pl.objects.values()];
        objGap = objs.length ? Math.min(...objs.map((o) => rectGap(t, o))) : null;
        if (objGap === null) pw.push('no object extrusion');
        else if (objGap <= 0) pw.push(`tower overlaps objects (${objGap.toFixed(1)})`);
        if (j.info.excl) {
          exGap = rectGap(t, j.info.excl);
          if (exGap <= 0) pw.push(`tower in exclusion (${exGap.toFixed(1)})`);
        }
      }
      // centring, two ways
      const c = j.info.centre;
      const a = j.info.plateBoxes[k], g = pl.all;
      const offA = a ? [centre(a)[0] - c[0], centre(a)[1] - c[1]] : null;
      const offG = g ? [centre(g)[0] - c[0], centre(g)[1] - c[1]] : null;
      const judge = (name: string, off: number[] | null) => {
        if (!off) { pw.push(`${name}: no bbox`); return; }
        if (!(shift > 0)) {
          if (Math.abs(off[0]) > 0.5 || Math.abs(off[1]) > 0.5) pw.push(`${name} off centre (${f1(off[0])}, ${f1(off[1])}) with shift 0`);
        } else if (Math.abs(Math.hypot(off[0], off[1]) - shift) > 1) pw.push(`${name} |offset| ${Math.hypot(off[0], off[1]).toFixed(2)} != shift ${shift.toFixed(2)} ±1`);
      };
      judge('3MF', offA);
      judge('G-code', offG);
      const ok = pw.length === 0;
      if (ok) platesPass++;
      check(`${label} plate ${k + 1}: centred${shift > 0 ? ` (shift ${shift.toFixed(1)})` : ''}, tower clear`, ok,
        `(3MF ${offA ? `${f1(offA[0])},${f1(offA[1])}` : '-'}; G-code ${offG ? `${f1(offG[0])},${f1(offG[1])}` : '-'}; tower gap ${objGap?.toFixed(1) ?? '-'}; excl gap ${exGap?.toFixed(1) ?? '-'}${pw.length ? `; ${pw.join('; ')}` : ''})`);
      rows.push(`| ${j.cse} | ${j.printer} | ${j.ver} | ${k + 1} | ${offA ? `${f1(offA[0])}, ${f1(offA[1])}` : '-'} | ${offG ? `${f1(offG[0])}, ${f1(offG[1])}` : '-'} | ${shift.toFixed(1)} | ${objGap?.toFixed(1) ?? '-'} | ${exGap?.toFixed(1) ?? '-'} | ${[...why, ...pw].length ? `FAIL: ${[...why, ...pw].join('; ')}` : 'PASS'} |`);
    }
  }
  const md = [
    '| case | printer | studio | plate | offset 3MF (dx, dy) | offset G-code (dx, dy) | shift | tower gap to objects | excl gap | result |',
    '|---|---|---|---|---|---|---|---|---|---|',
    ...rows,
    '',
    `plates: ${platesPass}/${platesTotal} pass; ${shiftedPlates} plate-slices needed a shift`,
  ].join('\n') + '\n';
  writeFileSync(`${OUT}/centering-matrix.md`, md);
  console.log(`\n${md}`);
  console.log(`${passed} passed, ${failed} failed  (outputs in ${OUT})`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
