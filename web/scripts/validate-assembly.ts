// End-to-end validation for ASSEMBLE MODE with three files: two boxes and a hex prism (STL, written to the
// git-ignored scratch/assembly/), composed into one assembly the way the worker does it, mated face to face, one part
// moved / rotated by a gizmo-equivalent rigid transform, the whole assembly laid on a face, painted with a 3-color
// camo at paint depth 0.6 mm and exported as Bambu projects with Per-part ON and OFF.
//
// Slice matrix (`--slice 0 --outputdir DIR FILE`, no settings flags): X1C 0.4 in Bambu Studio 2.8 and 1.10, P2S 0.4
// in 2.8, each Per-part ON and OFF. Every slice must give result.json return_code 0, extrude every filament (G-code
// filament usage + per-tool extrusion), and keep the prime tower on the bed, clear of the model and of the bed
// exclusion area (the validate-tower.ts checks). Also checks the export file names ("first+second+N" stems).
//
//   bun scripts/validate-assembly.ts
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { unzipSync } from 'fflate';
import {
  assemblyStem,
  composeAssembly,
  composeRigid,
  conjugateRigid,
  exportFilename,
  faceFeature,
  invertRigid,
  placeBeside,
  rotateAboutRigid,
  rotateVec,
  safeStem,
  snapGizmo,
  solveFaceMate,
  translateRigid,
  type AssemblyItem,
  type Rigid,
} from '../src/core/assembly';
import { buildAdjacency, orientPlacement, planarRegion, rotationToDown, triNormal } from '../src/core/faces';
import { loadModel, writeStl } from '../src/core/meshio';
import { createPipeline } from '../src/core/pipeline';
import { PRINTERS, objectsFromResult, writeBambuProject } from '../src/core/threemf';
import { DEFAULT_PARAMS } from '../src/core/types';
import type { Mesh, Model, Params, RasterImage, RGB, Vec3 } from '../src/core/types';

const BIN: Record<string, string> = {
  '1.10': process.env.BAMBU_110 ?? '/tmp/bs110/BambuStudio.app/Contents/MacOS/BambuStudio',
  '2.8': process.env.BAMBU_28 ?? '/Applications/BambuStudio.app/Contents/MacOS/BambuStudio',
};
const ROOT = resolve(import.meta.dir, '..');
const OUT = `${ROOT}/scratch/assembly`;
const TOWER_PY = `${ROOT}/scratch/bambu/excl/tower_extents.py`;
const PLATE = 'Textured PEI Plate';
const TIMEOUT_MS = 300_000;
mkdirSync(OUT, { recursive: true });

let passed = 0, failed = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) passed++;
  else failed++;
  console.log(`   ${ok ? '✓' : '✗'} ${name}${detail ? ` ${detail}` : ''}`);
}
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

// ---- shapes ------------------------------------------------------------------------------------------------

/** Axis-aligned box, outward CCW. */
function box(ox: number, oy: number, oz: number, w: number, d: number, h: number): Mesh {
  const v = [ox, oy, oz, ox + w, oy, oz, ox + w, oy + d, oz, ox, oy + d, oz, ox, oy, oz + h, ox + w, oy, oz + h, ox + w, oy + d, oz + h, ox, oy + d, oz + h];
  const t = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7];
  return { vertices: new Float32Array(v), triangles: new Uint32Array(t) };
}
/** Hexagonal prism along Z (corners every 60° from +X, flat sides facing 30° + k·60°), outward CCW. */
function hexPrism(cx: number, cy: number, z0: number, r: number, h: number): Mesh {
  const v: number[] = [];
  for (const z of [z0, z0 + h]) for (let i = 0; i < 6; i++) v.push(cx + r * Math.cos((i * Math.PI) / 3), cy + r * Math.sin((i * Math.PI) / 3), z);
  v.push(cx, cy, z0, cx, cy, z0 + h);
  const t: number[] = [];
  for (let i = 0; i < 6; i++) {
    const j = (i + 1) % 6;
    t.push(12, j, i); // bottom (looks down)
    t.push(13, 6 + i, 6 + j); // top
    t.push(i, j, 6 + j, i, 6 + j, 6 + i); // side
  }
  return { vertices: new Float32Array(v), triangles: new Uint32Array(t) };
}
/** Rotate about Z by deg around the origin (so a file arrives turned and off-axis). */
function rotZ(m: Mesh, deg: number): Mesh {
  const a = (deg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  const v = new Float32Array(m.vertices.length);
  for (let i = 0; i < v.length; i += 3) {
    const x = m.vertices[i], y = m.vertices[i + 1];
    v[i] = c * x - s * y; v[i + 1] = s * x + c * y; v[i + 2] = m.vertices[i + 2];
  }
  return { vertices: v, triangles: m.triangles };
}
function faceAlong(mesh: Mesh, dir: Vec3): number[] {
  let best = -1, bestDot = -Infinity;
  for (let tri = 0; tri < mesh.triangles.length / 3; tri++) {
    const { n, area } = triNormal(mesh, tri);
    if (area && dot(n, dir) > bestDot) { bestDot = dot(n, dir); best = tri; }
  }
  return planarRegion(mesh, buildAdjacency(mesh), best)!.triangles;
}
function vertsOf(mesh: Mesh): Vec3[] {
  const out: Vec3[] = [];
  for (let i = 0; i < mesh.vertices.length; i += 3) out.push([mesh.vertices[i], mesh.vertices[i + 1], mesh.vertices[i + 2]]);
  return out;
}
/** Max distance of `pts` from the plane (n, c). */
function planeGap(pts: Vec3[], n: Vec3, c: Vec3): number {
  let g = 0;
  for (const p of pts) g = Math.max(g, Math.abs(dot(n, p) - dot(n, c)));
  return g;
}

/** 3-color diagonal stripes so every filament lands on the assembly. */
const PALETTE: RGB[] = [[194, 24, 7], [31, 122, 31], [32, 64, 192]];
function stripeImage(size = 120, band = 20): RasterImage {
  const data = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const c = PALETTE[Math.floor((x + y) / band) % 3];
      const o = (y * size + x) * 4;
      data[o] = c[0]; data[o + 1] = c[1]; data[o + 2] = c[2]; data[o + 3] = 255;
    }
  return { width: size, height: size, data };
}

// ---- G-code / slicing (checks from validate-tower.ts) -------------------------------------------------------

interface BBox { x0: number; y0: number; x1: number; y1: number }
interface PlateG { colors: string[]; extrudePerTool: Map<number, number>; usedMm: number[]; objects: Map<string, BBox>; tower: BBox | null }
const grow = (b: BBox | undefined, x: number, y: number): BBox =>
  b ? { x0: Math.min(b.x0, x), y0: Math.min(b.y0, y), x1: Math.max(b.x1, x), y1: Math.max(b.y1, y) } : { x0: x, y0: y, x1: x, y1: y };

function parseGcodeFile(gcode: string): Omit<PlateG, 'tower'> {
  const colors: string[] = [];
  let usedMm: number[] = [];
  const extrudePerTool = new Map<number, number>();
  const objects = new Map<string, BBox>();
  let tool = 0, inTower = false, feat = '', obj: string | null = null, x = 0, y = 0;
  for (const raw of readFileSync(gcode, 'utf8').split('\n')) {
    const line = raw.trim();
    if (line.startsWith(';')) {
      const low = line.toLowerCase();
      if (colors.length === 0 && line.startsWith('; filament_colour =')) {
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
        if (feat && feat !== 'custom') objects.set(obj ?? '*', grow(grow(objects.get(obj ?? '*'), px, py), x, y));
      }
    }
  }
  if (objects.size > 1) objects.delete('*');
  return { colors, extrudePerTool, usedMm, objects };
}
function towerBoxes(files: string[]): (BBox | null)[] {
  if (!files.length || !existsSync(TOWER_PY)) return files.map(() => null);
  const out = execFileSync('python3', ['-I', TOWER_PY, ...files], { encoding: 'utf8' }).trim().split('\n');
  return out.map((l) => {
    const m = l.match(/\(([-\d.]+), ([-\d.]+), ([-\d.]+), ([-\d.]+)\)\s*$/);
    return m ? { x0: +m[1], y0: +m[2], x1: +m[3], y1: +m[4] } : null;
  });
}
interface Slice { exit: number | null; timedOut: boolean; returnCode: number | null; error: string; ms: number; plates: PlateG[] }
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
      let returnCode: number | null = null, error = '';
      if (existsSync(`${dir}/result.json`)) {
        try { const j = JSON.parse(readFileSync(`${dir}/result.json`, 'utf8')); returnCode = j.return_code; error = j.error_string ?? ''; } catch { /* */ }
      }
      const files: string[] = [];
      for (let p = 1; existsSync(`${dir}/plate_${p}.gcode`); p++) files.push(`${dir}/plate_${p}.gcode`);
      const towers = towerBoxes(files);
      res({ exit: code ?? (signal ? -1 : null), timedOut, returnCode, error, ms: Date.now() - t0, plates: files.map((f, i) => ({ ...parseGcodeFile(f), tower: towers[i] })) });
    });
  });
}
type Pt = [number, number];
const parsePoly = (v: unknown): Pt[] =>
  (Array.isArray(v) ? v : []).map((s) => String(s).split('x').map(parseFloat) as Pt).filter((p) => p.length === 2 && p.every(Number.isFinite));
const polyBox = (p: Pt[]): BBox => ({ x0: Math.min(...p.map((q) => q[0])), y0: Math.min(...p.map((q) => q[1])), x1: Math.max(...p.map((q) => q[0])), y1: Math.max(...p.map((q) => q[1])) });
function rectGap(a: BBox, b: BBox): number {
  const dx = Math.max(b.x0 - a.x1, a.x0 - b.x1), dy = Math.max(b.y0 - a.y1, a.y0 - b.y1);
  if (dx < 0 && dy < 0) return Math.max(dx, dy);
  return Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
}

function readModelSettings(bytes: Uint8Array): { name: string; parts: { name: string; subtype: string }[] }[] {
  const xml = new TextDecoder().decode(unzipSync(bytes)['Metadata/model_settings.config']);
  const out: { name: string; parts: { name: string; subtype: string }[] }[] = [];
  for (const m of xml.matchAll(/<object id="\d+">([\s\S]*?)<\/object>/g)) {
    const nm = m[1].match(/key="name" value="([^"]*)"/);
    const parts = [...m[1].matchAll(/<part id="\d+" subtype="(\w+)">([\s\S]*?)<\/part>/g)].map((pm) => ({
      name: pm[2].match(/key="name" value="([^"]*)"/)?.[1] ?? '',
      subtype: pm[1],
    }));
    out.push({ name: nm ? nm[1] : '', parts });
  }
  return out;
}

// ---- run ----------------------------------------------------------------------------------------------------

async function main() {
  console.log('\n# files (3)');
  const files = [
    { id: 'a', name: 'box-a.stl', mesh: box(0, 0, 0, 40, 30, 12) },
    { id: 'b', name: 'box-b.stl', mesh: rotZ(box(-10, -8, 5, 24, 16, 14), 35) },
    { id: 'c', name: 'hex-c.stl', mesh: rotZ(hexPrism(0, 0, 0, 9, 18), 10) },
  ];
  for (const f of files) writeFileSync(`${OUT}/${f.name}`, writeStl(f.mesh));
  const load = (name: string): Model => loadModel(new Uint8Array(readFileSync(`${OUT}/${name}`)), name);

  // worker flow: every file added beside the assembly
  const items: AssemblyItem[] = [];
  for (const f of files) {
    const model = load(f.name);
    items.push({ id: f.id, fileName: f.name, model, transform: placeBeside(items, model) });
  }
  let composed = composeAssembly(items);
  check('compose: 1 object "Assembly" with 3 parts', composed.model.objects.length === 1 && composed.model.objects[0].parts.length === 3);
  const part = (k: number) => composed.model.objects[0].parts[k].mesh;

  // ---- mates
  console.log('\n# mates');
  const mate = (moving: number, mDir: Vec3, target: number, tDir: Vec3, angle = 0): { mTris: number[]; tTris: number[] } => {
    const mTris = faceAlong(part(moving), mDir), tTris = faceAlong(part(target), tDir);
    const mf = faceFeature(part(moving), mTris)!, tf = faceFeature(part(target), tTris)!;
    const M = solveFaceMate({
      movingNormal: mf.normal, movingCentroid: mf.centroid, movingRegionPts: mf.points,
      targetNormal: tf.normal, targetCentroid: tf.centroid, targetRegionPts: tf.points,
      offset: 0, flip: false, angle, seat: true,
    })!;
    items[moving] = { ...items[moving], transform: composeRigid(M, items[moving].transform) };
    composed = composeAssembly(items);
    return { mTris, tTris };
  };
  const flush = (label: string, moving: number, target: number, f: { mTris: number[]; tTris: number[] }) => {
    const mf = faceFeature(part(moving), f.mTris)!, tf = faceFeature(part(target), f.tTris)!;
    const gap = planeGap(mf.points, tf.normal, tf.centroid);
    check(`${label}: coplanar + opposed`, gap < 1e-3 && Math.abs(dot(mf.normal, tf.normal) + 1) < 1e-6, `(gap ${gap.toExponential(2)}, dot ${dot(mf.normal, tf.normal).toFixed(6)})`);
  };
  const bOnA = mate(1, [0, 0, -1], 0, [0, 0, 1]);
  flush('B bottom on A top', 1, 0, bOnA);
  // C's flat side (one of its hex faces, turned 10°) onto A's +X side
  const cSide: Vec3 = [Math.cos((40 * Math.PI) / 180), Math.sin((40 * Math.PI) / 180), 0];
  const cOnA = mate(2, rotateVec(items[2].transform, cSide), 0, [1, 0, 0], 30);
  flush('C side on A +X side', 2, 0, cOnA);

  // ---- gizmo-equivalent move of C: ring about X (its mate normal) 2 snaps + 3 mm along Y, through the bbox centre
  console.log('\n# gizmo move');
  const cv = vertsOf(part(2));
  const lo = [0, 1, 2].map((a) => Math.min(...cv.map((p) => p[a]))), hi = [0, 1, 2].map((a) => Math.max(...cv.map((p) => p[a])));
  const centre: Vec3 = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
  const deg = snapGizmo('rotate', 31.2, false), mm = snapGizmo('translate', -2.6, false);
  check('gizmo: snapped to 15° / 1 mm steps', deg === 30 && mm === -3, `(${deg}°, ${mm} mm)`);
  const G = composeRigid(translateRigid([0, 1, 0], mm), rotateAboutRigid([1, 0, 0], centre, deg));
  // nothing is laid yet: display = assembly space (O = identity), so O⁻¹ ∘ G ∘ O = G
  const ident: Rigid = { R: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0] };
  items[2] = { ...items[2], transform: composeRigid(conjugateRigid(invertRigid(ident), G), items[2].transform) };
  composed = composeAssembly(items);
  flush('C still flush after spinning about its mate normal', 2, 0, cOnA);
  const cv2 = vertsOf(part(2));
  const cy2 = (Math.min(...cv2.map((p) => p[1])) + Math.max(...cv2.map((p) => p[1]))) / 2;
  check('gizmo: C moved 3 mm along -Y', Math.abs(cy2 - (centre[1] - 3)) < 0.5, `(centre y ${centre[1].toFixed(2)} -> ${cy2.toFixed(2)})`);

  // ---- lay the whole assembly on A's -Y face; picks / transforms stay in assembly space
  console.log('\n# lay on face');
  const orientation = rotationToDown([0, -1, 0]);
  const O = orientPlacement(composed.model, orientation)!;
  check('lay: A front face lands on the bed', Math.abs(rotateVec(O, [0, -1, 0])[2] + 1) < 1e-9);
  writeFileSync(`${OUT}/assembled.stl`, writeStl({
    vertices: new Float32Array(composed.model.objects[0].parts.flatMap((p) => [...p.mesh.vertices])),
    triangles: new Uint32Array(composed.model.objects[0].parts.flatMap((p, k, all) => {
      const off = all.slice(0, k).reduce((n, q) => n + q.mesh.vertices.length / 3, 0);
      return [...p.mesh.triangles].map((i) => i + off);
    })),
  }));

  // ---- export naming
  console.log('\n# export names');
  const stem = assemblyStem(items.map((it) => it.fileName));
  const imageName = 'stripes.png';
  const base = `${stem}-${safeStem(imageName)}`;
  const names = (['bambu-3mf', 'plain-3mf', 'stl-zip', 'preview-png'] as const).map((k) => exportFilename(k, base, 3));
  check('names: "box-a+box-b+1-stripes-3colors…" for every export kind', names.join(' ') === 'box-a+box-b+1-stripes-3colors.3mf box-a+box-b+1-stripes-3colors-plain.3mf box-a+box-b+1-stripes-3colors-stls.zip box-a+box-b+1-stripes-3colors-preview.png', names.join(' '));
  check('names: single file keeps its stem', exportFilename('bambu-3mf', `${assemblyStem(['box-a.stl'])}-stripes`, 3) === 'box-a-stripes-3colors.3mf');

  // ---- pipeline + export + slice matrix
  const image = stripeImage();
  const jobs: { printer: string; ver: string; perPart: boolean; file: string; colors: string[]; bed: BBox; excl: BBox | null }[] = [];
  for (const perPart of [true, false]) {
    const tag = perPart ? 'perpart-on' : 'perpart-off';
    console.log(`\n# pipeline (${tag}, depth 0.6, laid on a face)`);
    const params: Params = { ...DEFAULT_PARAMS, palette: PALETTE, axis: 'y', perPart, depth: 0.6, orientation };
    const pipe = createPipeline();
    const result = await pipe.run(image, composed.model, params);
    pipe.dispose();
    check(`${tag}: 3 colors`, result.regions.length === 3, `(got ${result.regions.length})`);
    check(`${tag}: depth 0.6 used`, result.depth === 0.6, `(${result.depth})`);
    const rp = result.orientPlace;
    const placeOk = !!rp && rp.R.every((x, i) => Math.abs(x - O.R[i]) < 1e-9) && rp.t.every((x, i) => Math.abs(x - O.t[i]) < 1e-6);
    check(`${tag}: result.orientPlace = the lay-on-face motion (picks map back through it)`, placeOk);
    // B still flush on A in the laid pose (the pipeline's oriented model)
    const rm = result.model!.objects[0].parts;
    const mf = faceFeature(rm[1].mesh, bOnA.mTris)!, tf = faceFeature(rm[0].mesh, bOnA.tTris)!;
    check(`${tag}: B on A still flush in the laid pose`, planeGap(mf.points, tf.normal, tf.centroid) < 1e-3);
    let minZ = Infinity;
    for (const p of rm) for (let i = 2; i < p.mesh.vertices.length; i += 3) minZ = Math.min(minZ, p.mesh.vertices[i]);
    check(`${tag}: laid assembly rests on z = 0`, Math.abs(minZ) < 1e-4, `(min z ${minZ.toExponential(2)})`);

    const hexes = result.regions.map((r) => r.hex);
    const objects = objectsFromResult(result, hexes, 'stripes');
    for (const printer of ['x1c-0.4', 'p2s-0.4']) {
      const { bytes, warnings } = await writeBambuProject(objects, { printerId: printer, filamentColors: hexes, plate: PLATE });
      const file = `${OUT}/${printer}-${tag}-${names[0]}`;
      writeFileSync(file, bytes);
      if (warnings.length) console.log(`   ${printer} warnings: ${warnings.join(' | ')}`);
      const settings = readModelSettings(bytes);
      const summary = settings.map((o) => `${o.name}[${o.parts.map((p) => p.subtype).join(',')}]`).join(' ');
      if (perPart) {
        const ok = settings.length === 3 && settings.every((o) => o.parts.filter((p) => p.subtype === 'normal_part').length === 1 && o.parts.some((p) => p.subtype === 'modifier_part'));
        check(`${printer} per-part ON: 3 objects, each 1 part + its own modifiers`, ok, `(${summary})`);
      } else {
        const ok = settings.length === 1 && settings[0].parts.filter((p) => p.subtype === 'normal_part').length === 3 && settings[0].parts.some((p) => p.subtype === 'modifier_part');
        check(`${printer} per-part OFF: 1 object with 3 parts (+ modifiers)`, ok, `(${summary})`);
      }
      const z = unzipSync(bytes);
      const ps = JSON.parse(new TextDecoder().decode(z['Metadata/project_settings.config']));
      const area = parsePoly(ps.printable_area), ex = parsePoly(ps.bed_exclude_area);
      const bedDims = PRINTERS.find((p) => p.id === printer)!.bed;
      const exBox = ex.length >= 3 ? polyBox(ex) : null;
      const vers = printer === 'x1c-0.4' ? ['2.8', '1.10'] : ['2.8'];
      for (const ver of vers)
        jobs.push({
          printer, ver, perPart, file, colors: hexes.map((h) => h.toUpperCase()),
          bed: area.length >= 3 ? polyBox(area) : { x0: 0, y0: 0, x1: bedDims[0], y1: bedDims[1] },
          excl: exBox && exBox.x1 - exBox.x0 > 0 && exBox.y1 - exBox.y0 > 0 ? exBox : null,
        });
    }
  }

  console.log('\n# slices');
  if (!existsSync(TOWER_PY)) console.log(`   (no ${TOWER_PY}: tower checks can't run)`);
  const matrix: string[] = [];
  for (const j of jobs) {
    const label = `${j.printer} ${j.ver} per-part ${j.perPart ? 'ON' : 'OFF'}`;
    if (!existsSync(BIN[j.ver])) {
      check(`${label}: Bambu Studio ${j.ver} present`, false, `(missing ${BIN[j.ver]})`);
      matrix.push(`| ${j.printer} | ${j.ver} | ${j.perPart ? 'ON' : 'OFF'} | MISSING BINARY | | | |`);
      continue;
    }
    const dir = `${OUT}/slice-${j.printer}-${j.ver}-${j.perPart ? 'on' : 'off'}`;
    const s = await slice(BIN[j.ver], j.file, dir);
    const why: string[] = [];
    if (s.timedOut) why.push('timeout');
    // 1.10 writes no result.json: its process exit code is the return code
    const rc = s.returnCode ?? (j.ver === '1.10' ? s.exit : null);
    if (rc !== 0) why.push(`return_code ${rc}${s.error ? ` "${s.error}"` : ''}`);
    if (!s.plates.length) why.push('no gcode');
    const usedUnion = new Set<number>();
    let towerTxt = '', exTxt = '-', objTxt = '-';
    s.plates.forEach((pl, i) => {
      pl.usedMm.forEach((mmUsed, t) => mmUsed > 0 && usedUnion.add(t));
      for (const [t, n] of pl.extrudePerTool) if (n > 0) usedUnion.add(t);
      if (JSON.stringify(pl.colors) !== JSON.stringify(j.colors)) why.push(`plate${i + 1} colors ${JSON.stringify(pl.colors)}`);
      const t = pl.tower;
      if (!t) { why.push(`plate${i + 1} no tower`); return; }
      if (t.x0 < j.bed.x0 || t.y0 < j.bed.y0 || t.x1 > j.bed.x1 || t.y1 > j.bed.y1) why.push(`plate${i + 1} tower off bed`);
      const exGap = j.excl ? rectGap(t, j.excl) : null;
      if (exGap !== null && exGap <= 0) why.push(`plate${i + 1} tower in exclusion (${exGap.toFixed(1)})`);
      const objs = [...pl.objects.values()];
      const objGap = objs.length ? Math.min(...objs.map((o) => rectGap(t, o))) : null;
      if (objGap === null) why.push(`plate${i + 1} no object extrusion`);
      else if (objGap <= 0) why.push(`plate${i + 1} tower overlaps the model (${objGap.toFixed(1)})`);
      towerTxt += `${towerTxt ? '; ' : ''}[${t.x0},${t.y0}-${t.x1},${t.y1}]`;
      exTxt = exGap === null ? '-' : exGap.toFixed(1);
      objTxt = objGap === null ? '-' : objGap.toFixed(1);
    });
    const missing = j.colors.map((_, t) => t).filter((t) => !usedUnion.has(t));
    if (s.plates.length && missing.length) why.push(`filament not used: ${missing.map((t) => `T${t + 1}`).join(',')}`);
    const used = s.plates.map((pl) => pl.usedMm.map((x) => x.toFixed(0)).join('/')).join(' ; ');
    check(`${label}: rc 0${s.returnCode === null ? ' (exit code)' : ''}, all 3 filaments used, tower clear`, why.length === 0, `(${(s.ms / 1000).toFixed(0)}s, used mm ${used || '-'}, tower ${towerTxt || '-'}, gap model ${objTxt}, gap excl ${exTxt}${why.length ? `; ${why.join('; ')}` : ''})`);
    matrix.push(`| ${j.printer} | ${j.ver} | ${j.perPart ? 'ON' : 'OFF'} | ${why.length ? `FAIL: ${why.join('; ')}` : 'PASS'} | ${rc}${s.returnCode === null ? ' (exit)' : ''} | ${used} | ${objTxt} / ${exTxt} |`);
  }
  writeFileSync(`${OUT}/slice-matrix.md`, ['| printer | studio | per-part | result | rc | filament used mm | tower gap model / excl |', '|---|---|---|---|---|---|---|', ...matrix].join('\n') + '\n');

  console.log(`\n${passed} passed, ${failed} failed  (outputs in ${OUT})`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
