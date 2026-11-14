// Prime-tower placement validator for writeBambuProject (findTowerSpot).
//
// For every printer x nozzle combo (PRINTERS) builds 3 cases through the real pipeline + writeBambuProject, slices
// them with no settings flags (`--slice 0`, plus `--debug 2` so warnings reach the log) in Bambu Studio 1.10
// (1.10-era printers only) and 2.8, and checks per plate: tower inside the bed, clear of bed_exclude_area, clear of
// the objects (per-object extrusion bboxes), filament colors, every filament extrudes, no -101/-104, no tower
// / exclusion warnings in the CLI log.
//
//   bun scripts/validate-tower.ts                        # everything
//   ONLY=x1c-0.4,a1mini bun scripts/validate-tower.ts    # printer-id substring filter
//   CASES=crowd bun scripts/validate-tower.ts            # case filter (tile, crowd, crowd2)
//
// Pipeline/case/slice helpers copied from validate-studio-compat.ts (not edited).
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { unzipSync } from 'fflate';
import { createPipeline } from '../src/core/pipeline';
import { objectsFromResult, writeBambuProject, PRINTERS } from '../src/core/threemf';
import { DEFAULT_PARAMS } from '../src/core/types';
import type { ExportObject, Mesh, Model, Params, RasterImage, RGB } from '../src/core/types';

const BIN: Record<string, string> = {
  '1.10': process.env.BAMBU_110 ?? '/tmp/bs110/BambuStudio.app/Contents/MacOS/BambuStudio',
  '2.8': process.env.BAMBU_28 ?? '/Applications/BambuStudio.app/Contents/MacOS/BambuStudio',
};
const ROOT = resolve(import.meta.dir, '..');
const OUT = `${ROOT}/scratch/bambu/tower`;
const TOWER_PY = `${ROOT}/scratch/bambu/excl/tower_extents.py`;
const TIMEOUT_MS = 120_000;
const CONCURRENCY = 3;
const PALETTE: RGB[] = [[194, 24, 7], [31, 122, 31], [32, 64, 192], [230, 200, 20]];
const CASES = ['tile', 'crowd', 'crowd2'] as const;
type CaseName = (typeof CASES)[number];

const onlyIds = (process.env.ONLY ?? '').split(',').filter(Boolean);
const wantId = (id: string) => onlyIds.length === 0 || onlyIds.some((f) => id.includes(f));
const onlyCases = (process.env.CASES ?? '').split(',').filter(Boolean);
const wantCase = (c: string) => onlyCases.length === 0 || onlyCases.includes(c);

mkdirSync(OUT, { recursive: true });

// ------------------------------------------------------------------------------------ geometry + cases

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

/** 4-color diagonal stripes. */
function stripeImage(size = 160, band = 24): RasterImage {
  const data = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const c = PALETTE[Math.floor((x + y) / band) % PALETTE.length];
      const o = (y * size + x) * 4;
      data[o] = c[0]; data[o + 1] = c[1]; data[o + 2] = c[2]; data[o + 3] = 255;
    }
  return { width: size, height: size, data };
}

interface Built { objects: ExportObject[]; colors: string[]; note: string }

const P = (extra: Partial<Params>): Params => ({
  ...DEFAULT_PARAMS, colors: PALETTE.length, palette: PALETTE, smooth: 0, minFeature: 0, resolution: 0.3, ...extra,
});

async function runPipeline(image: RasterImage, model: Model | null, params: Params, name: string): Promise<Built> {
  const pipe = createPipeline();
  const result = await pipe.run(image, model, params);
  pipe.dispose();
  const colors = result.regions.map((r) => r.hex.toUpperCase());
  const objects = objectsFromResult(result, colors, name);
  return { objects, colors, note: `${objects.length} obj, ${objects.reduce((s, o) => s + o.parts.length, 0)} parts` };
}

const cache = new Map<string, Built>();
async function buildCase(c: CaseName, bed: [number, number]): Promise<Built> {
  const key = `${c}-${c === 'tile' ? '' : bed.join('x')}`;
  if (cache.has(key)) return cache.get(key)!;
  const stripes = stripeImage();
  let b: Built;
  if (c === 'tile') {
    b = await runPipeline(stripes, null, P({}), 'tile'); // image mode, default size
  } else if (c === 'crowd') {
    const w = Math.round(0.72 * bed[0]), d = Math.round(0.72 * bed[1]);
    b = await runPipeline(stripes, { objects: [{ name: 'crowd', parts: [{ name: 'crowd', mesh: box(0, 0, w, d, 15) }] }] },
      P({ axis: 'y', resolution: 0.5 }), 'crowd');
    b.note += `, ${w}x${d}x15 box`;
  } else {
    // 3 overlapping footprints (forces re-arrange): one big + two small -> big+small on plate 1, small on plate 2
    const sz: [number, number][] = [[0.7, 0.5], [0.4, 0.4], [0.4, 0.4]];
    b = await runPipeline(stripes, { objects: sz.map(([fx, fy], k) => ({
      name: `c${k}`, parts: [{ name: `c${k}`, mesh: box(0, 0, Math.round(fx * bed[0]), Math.round(fy * bed[1]), 3) }],
    })) }, P({ axis: 'y', resolution: 0.5 }), 'crowd2');
    b.note += `, ${sz.map(([fx, fy]) => `${Math.round(fx * bed[0])}x${Math.round(fy * bed[1])}`).join('+')}x3`;
  }
  cache.set(key, b);
  return b;
}

// ------------------------------------------------------------------------------------ gcode

interface BBox { x0: number; y0: number; x1: number; y1: number }
interface PlateG {
  colors: string[]; extrudePerTool: Map<number, number>; objects: Map<string, BBox>; tower: BBox | null;
}

const grow = (b: BBox | undefined, x: number, y: number): BBox =>
  b ? { x0: Math.min(b.x0, x), y0: Math.min(b.y0, y), x1: Math.max(b.x1, x), y1: Math.max(b.y1, y) } : { x0: x, y0: y, x1: x, y1: y };

/** Colors, extrusion per tool (non-tower), per-object extrusion bboxes (non-tower, non-Custom moves inside a
 * "start printing object" block). */
function parseGcodeFile(gcode: string): Omit<PlateG, 'tower'> {
  const colors: string[] = [];
  const extrudePerTool = new Map<number, number>();
  const objects = new Map<string, BBox>();
  let tool = 0, inTower = false, feat = '', obj: string | null = null, x = 0, y = 0;
  for (const raw of readFileSync(gcode, 'utf8').split('\n')) {
    const line = raw.trim();
    if (line.startsWith(';')) {
      const low = line.toLowerCase();
      if (colors.length === 0 && line.startsWith('; filament_colour =')) {
        for (const c of line.split('=')[1].split(';')) if (c.trim()) colors.push(c.trim().toUpperCase());
      } else if (line === '; WIPE_TOWER_START') inTower = true;
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
        // Studio only labels objects when a plate has more than one; unlabelled extrusion goes under '*'
        if (feat && feat !== 'custom') objects.set(obj ?? '*', grow(grow(objects.get(obj ?? '*'), px, py), x, y));
      }
    }
  }
  if (objects.size > 1) objects.delete('*'); // labelled plates: '*' would be stray non-object moves
  return { colors, extrudePerTool, objects };
}

function towerBoxes(files: string[]): (BBox | null)[] {
  if (!files.length) return [];
  const out = execFileSync('python3', ['-I', TOWER_PY, ...files], { encoding: 'utf8' }).trim().split('\n');
  return out.map((l) => {
    const m = l.match(/\(([-\d.]+), ([-\d.]+), ([-\d.]+), ([-\d.]+)\)\s*$/);
    return m ? { x0: +m[1], y0: +m[2], x1: +m[3], y1: +m[4] } : null;
  });
}

// ------------------------------------------------------------------------------------ CLI

interface Slice {
  exit: number | null; timedOut: boolean; returnCode: number | null; error: string; ms: number;
  plates: PlateG[]; logTail: string; badLog: string[]; otherLog: string[];
}

const BENIGN = [/can not find system preset file/i, /no filament colors found in project/i, /building nozzle list/i];
const BAD = /exclu|too close|wipe.?tower|prime tower/i;

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
      const files: string[] = [];
      for (let p = 1; existsSync(`${dir}/plate_${p}.gcode`); p++) files.push(`${dir}/plate_${p}.gcode`);
      const towers = towerBoxes(files);
      const plates = files.map((f, i) => ({ ...parseGcodeFile(f), tower: towers[i] }));
      const badLog: string[] = [], otherLog: string[] = [];
      for (const l of log.split('\n')) {
        if (!/\[(warning|error|fatal)\]/.test(l)) continue;
        const msg = l.replace(/^.*\[(warning|error|fatal)\]\s*/, '[$1] ').slice(0, 240);
        if (BENIGN.some((r) => r.test(l))) continue;
        (BAD.test(l) ? badLog : otherLog).push(msg);
      }
      const tail = log.trim().split('\n').slice(-6).join('\n');
      res({ exit: code ?? (signal ? -1 : null), timedOut, returnCode, error, ms: Date.now() - t0, plates, logTail: tail, badLog, otherLog });
    });
  });
}

const slice = (ver: string, file: string, dir: string) =>
  runCli(BIN[ver], ['--debug', '2', '--slice', '0', '--outputdir', dir, file], dir);

async function pool<T>(jobs: (() => Promise<T>)[], n: number): Promise<T[]> {
  const out: T[] = new Array(jobs.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, jobs.length) }, async () => {
    while (next < jobs.length) { const i = next++; out[i] = await jobs[i](); }
  }));
  return out;
}

// ------------------------------------------------------------------------------------ geometry checks

type Pt = [number, number];
const parsePoly = (v: unknown): Pt[] =>
  (Array.isArray(v) ? v : []).map((s) => String(s).split('x').map(parseFloat) as Pt).filter((p) => p.length === 2 && p.every(Number.isFinite));
const polyBox = (p: Pt[]): BBox => ({ x0: Math.min(...p.map((q) => q[0])), y0: Math.min(...p.map((q) => q[1])), x1: Math.max(...p.map((q) => q[0])), y1: Math.max(...p.map((q) => q[1])) });
/** Gap between two rects; negative = overlap depth (min of the two axis penetrations). */
function rectGap(a: BBox, b: BBox): number {
  const dx = Math.max(b.x0 - a.x1, a.x0 - b.x1), dy = Math.max(b.y0 - a.y1, a.y0 - b.y1);
  if (dx < 0 && dy < 0) return Math.max(dx, dy);
  return Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
}
function where(t: BBox, bed: BBox): string {
  const w = bed.x1 - bed.x0, d = bed.y1 - bed.y0, cx = (t.x0 + t.x1) / 2, cy = (t.y0 + t.y1) / 2;
  const h = cx < bed.x0 + w / 3 ? 'L' : cx > bed.x1 - w / 3 ? 'R' : 'C';
  const v = cy > bed.y1 - d / 3 ? 'B' : cy < bed.y0 + d / 3 ? 'F' : 'M';
  return ({ LB: 'back-left', RB: 'back-right', LF: 'front-left', RF: 'front-right', LM: 'left strip', RM: 'right strip', CB: 'back strip', CF: 'front strip', CM: 'middle' } as Record<string, string>)[h + v];
}

// ------------------------------------------------------------------------------------ run

interface Proj { file: string; colors: string[]; nPlates: number; warnings: string[]; wx: string[]; wy: string[]; bed: BBox; excl: BBox | null; note: string }

async function writeProject(id: string, kase: CaseName): Promise<Proj> {
  const pr = PRINTERS.find((p) => p.id === id)!;
  const b = await buildCase(kase, pr.bed as [number, number]);
  const { bytes, warnings } = await writeBambuProject(b.objects, { printerId: id, filamentColors: b.colors });
  const file = `${OUT}/${id}-${kase}.3mf`;
  writeFileSync(file, bytes);
  const z = unzipSync(bytes);
  const settings = JSON.parse(new TextDecoder().decode(z['Metadata/project_settings.config']));
  const xml = new TextDecoder().decode(z['Metadata/model_settings.config']);
  const area = parsePoly(settings.printable_area);
  const ex = parsePoly(settings.bed_exclude_area);
  const exBox = ex.length >= 3 ? polyBox(ex) : null;
  return {
    file, colors: b.colors, nPlates: (xml.match(/<plate>/g) ?? []).length, warnings,
    wx: settings.wipe_tower_x, wy: settings.wipe_tower_y,
    bed: area.length >= 3 ? polyBox(area) : { x0: 0, y0: 0, x1: pr.bed[0], y1: pr.bed[1] },
    excl: exBox && exBox.x1 - exBox.x0 > 0 && exBox.y1 - exBox.y0 > 0 ? exBox : null, note: b.note,
  };
}

interface PlateRow { plate: number; where: string; tower: BBox | null; exGap: number | null; objGap: number | null }
interface Row { id: string; kase: string; ver: string; pass: boolean; why: string[]; plates: PlateRow[]; proj: Proj; s: Slice }
const rows: Row[] = [];
const f1 = (n: number | null) => (n === null ? '-' : n.toFixed(1));

function assess(id: string, kase: CaseName, ver: string, p: Proj, s: Slice): void {
  const why: string[] = [];
  if (s.timedOut) why.push(`TIMEOUT ${TIMEOUT_MS / 1000}s`);
  if (s.exit !== 0) why.push(`exit ${s.exit}`);
  if (s.returnCode !== null && s.returnCode !== 0) why.push(`return_code ${s.returnCode} "${s.error}"`);
  if (ver === '2.8' && s.returnCode === null && !s.timedOut) why.push('no result.json');
  if (s.plates.length === 0) why.push('no gcode');
  if (s.plates.length && s.plates.length !== p.nPlates) why.push(`plates ${s.plates.length}/${p.nPlates}`);
  if (kase === 'crowd2' && p.nPlates < 2) why.push(`crowd2 wrote ${p.nPlates} plate(s)`);
  if (s.badLog.length) why.push(`log: ${s.badLog.slice(0, 3).join(' | ')}`);
  const want = JSON.stringify(p.colors);
  const prs: PlateRow[] = [];
  s.plates.forEach((pl, i) => {
    const n = i + 1;
    if (JSON.stringify(pl.colors) !== want) why.push(`plate${n} colors ${JSON.stringify(pl.colors)}`);
    const t = pl.tower;
    if (!t) { why.push(`plate${n} no tower`); prs.push({ plate: n, where: '-', tower: null, exGap: null, objGap: null }); return; }
    const b = p.bed;
    if (t.x0 < b.x0 || t.y0 < b.y0 || t.x1 > b.x1 || t.y1 > b.y1) why.push(`plate${n} tower off bed ${JSON.stringify(t)}`);
    const exGap = p.excl ? rectGap(t, p.excl) : null;
    if (exGap !== null && exGap <= 0) why.push(`plate${n} tower in exclusion (gap ${exGap.toFixed(1)})`);
    const objs = [...pl.objects.values()];
    const objGap = objs.length ? Math.min(...objs.map((o) => rectGap(t, o))) : null;
    if (objGap !== null && objGap <= 0) why.push(`plate${n} tower overlaps object (gap ${objGap.toFixed(1)})`);
    if (!objs.length) why.push(`plate${n} no object extrusion`);
    prs.push({ plate: n, where: where(t, b), tower: t, exGap, objGap });
  });
  const union = new Set<number>();
  for (const pl of s.plates) for (const [t, n] of pl.extrudePerTool) if (n > 0) union.add(t);
  const missing = p.colors.map((_, i) => i).filter((t) => !union.has(t));
  if (s.plates.length && missing.length) why.push(`no extrusion T${missing.join(',T')}`);
  const r: Row = { id, kase, ver, pass: why.length === 0, why, plates: prs, proj: p, s };
  rows.push(r);
  const pls = prs.map((q) => `p${q.plate} ${q.where} [${q.tower ? `${q.tower.x0},${q.tower.y0}-${q.tower.x1},${q.tower.y1}` : '-'}] ex ${f1(q.exGap)} obj ${f1(q.objGap)}`).join('; ');
  console.log(`${r.pass ? 'PASS' : 'FAIL'} ${id.padEnd(11)} ${kase.padEnd(6)} ${ver.padEnd(4)} ${(s.ms / 1000).toFixed(0).padStart(3)}s  ${pls}`);
  if (!r.pass) {
    console.log(`     why: ${why.join('; ')}`);
    console.log('     log tail:\n       ' + s.logTail.split('\n').join('\n       '));
  }
}

const OLD = ['x1c', 'x1', 'x1e', 'p1s', 'p1p', 'a1', 'a1mini'];
const jobs: (() => Promise<void>)[] = [];
console.log('# case builds');
for (const pr of PRINTERS) {
  if (!wantId(pr.id)) continue;
  const family = pr.id.split('-')[0];
  const vers = OLD.includes(family) ? ['1.10', '2.8'] : ['2.8'];
  for (const c of CASES) {
    if (!wantCase(c)) continue;
    const p = await writeProject(pr.id, c);
    console.log(`  ${pr.id.padEnd(11)} ${c.padEnd(6)} ${p.note}; plates ${p.nPlates}; tower x=${p.wx} y=${p.wy}${p.warnings.length ? `; warnings: ${p.warnings.join(' | ')}` : ''}`);
    for (const ver of vers) jobs.push(async () => assess(pr.id, c, ver, p, await slice(ver, p.file, `${OUT}/${pr.id}-${c}-${ver}`)));
  }
}
console.log(`\n# ${jobs.length} slices, ${CONCURRENCY} parallel`);
await pool(jobs, CONCURRENCY);

// timeouts stay failures; a serial re-run only tells a concurrency hang from a real one
const retried = new Map<Row, string>();
for (const r of rows.filter((x) => x.s.timedOut)) {
  const s = await slice(r.ver, r.proj.file, `${OUT}/${r.id}-${r.kase}-${r.ver}-serial`);
  const note = s.timedOut ? 'serial re-run also timed out' : `serial re-run: exit ${s.exit}, rc ${s.returnCode}, ${s.plates.length} plates, ${(s.ms / 1000).toFixed(0)}s`;
  retried.set(r, note);
  console.log(`  RETRY ${r.id} ${r.kase} ${r.ver}: ${note}`);
}

// ------------------------------------------------------------------------------------ report

const order = (r: Row) => [PRINTERS.findIndex((p) => p.id === r.id), CASES.indexOf(r.kase as CaseName), r.ver === '1.10' ? 0 : 1];
rows.sort((a, b) => { const x = order(a), y = order(b); return x[0] - y[0] || x[1] - y[1] || x[2] - y[2]; });
const md: string[] = ['# Prime-tower placement validation', ''];
const families = [...new Set(rows.map((r) => r.id.split('-')[0]))];
for (const fam of families) {
  md.push(`## ${fam}`, '', '| combo | case | ver | ok | writer x,y | plate: where (tower bbox) | min gap excl | min gap obj | writer warnings |', '|---|---|---|---|---|---|---|---|---|');
  for (const r of rows.filter((x) => x.id.split('-')[0] === fam)) {
    const wxy = r.proj.wx.map((x, i) => `${x},${r.proj.wy[i]}`).join(' / ');
    const pl = r.plates.map((q) => `p${q.plate}: ${q.where} (${q.tower ? `${q.tower.x0},${q.tower.y0}–${q.tower.x1},${q.tower.y1}` : '-'})`).join('<br>');
    const ex = r.plates.map((q) => f1(q.exGap)).join(' / ');
    const ob = r.plates.map((q) => f1(q.objGap)).join(' / ');
    const w = r.proj.warnings.map((s) => (s.includes('no free spot') ? 'NO FREE SPOT' : s.includes('re-arranged') ? 're-arranged' : s.slice(0, 40))).join(', ');
    md.push(`| ${r.id} | ${r.kase} | ${r.ver} | ${r.pass ? 'PASS' : `**FAIL**: ${r.why.join('; ').replace(/\|/g, '/')}`} | ${wxy} | ${pl} | ${ex} | ${ob} | ${w} |`);
  }
  md.push('');
}
const nPass = rows.filter((r) => r.pass).length;
md.push(`**${nPass}/${rows.length} slices passed**`, '');
for (const v of ['1.10', '2.8']) { const rr = rows.filter((r) => r.ver === v); md.push(`- ${v}: ${rr.filter((r) => r.pass).length}/${rr.length}`); }
for (const c of CASES) { const rr = rows.filter((r) => r.kase === c); md.push(`- ${c}: ${rr.filter((r) => r.pass).length}/${rr.length}`); }
const exs = rows.flatMap((r) => r.plates.map((q) => q.exGap)).filter((x): x is number => x !== null);
const obs = rows.flatMap((r) => r.plates.map((q) => q.objGap)).filter((x): x is number => x !== null);
if (exs.length) md.push(`- min tower↔exclusion gap over all X1/P1 plates: ${Math.min(...exs).toFixed(1)} mm`);
if (obs.length) md.push(`- min tower↔object gap over all plates: ${Math.min(...obs).toFixed(1)} mm`);
const other = new Map<string, number>();
for (const r of rows) for (const l of r.s.otherLog) other.set(l.replace(/\d+(\.\d+)?/g, '#'), (other.get(l.replace(/\d+(\.\d+)?/g, '#')) ?? 0) + 1);
if (other.size) {
  md.push('', '## other [warning]/[error] log lines (digits → #)', '');
  for (const [l, n] of [...other.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40)) md.push(`- ${n}× \`${l.replace(/`/g, "'")}\``);
}
const fails = rows.filter((r) => !r.pass);
if (fails.length) {
  md.push('', '## failures', '');
  for (const r of fails) md.push(`### ${r.id} ${r.kase} ${r.ver}`, '', `- ${r.why.join('\n- ')}`, ...(retried.has(r) ? [`- ${retried.get(r)}`] : []), '', '```', r.s.logTail, '```', '');
}
writeFileSync(`${OUT}/report.md`, md.join('\n'));
console.log(`\n${nPass}/${rows.length} slices passed; report: ${OUT}/report.md`);
process.exit(fails.length ? 1 : 0);
