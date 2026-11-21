// Multi-plate 3MF validation: scratch/inputs/yeti.3mf (a Bambu P2S project, 7 plates, one object each) through
// loadModel -> pipeline (Urban preset, 4 colors, default depth / inside) -> objectsFromResult -> writeBambuProject
// with sourcePlates, for p2s-0.4 and x1c-0.4 (+ a1mini-0.4, whose 180 mm bed is too small for several plates:
// they must warn and re-centre, not crash). Checks:
//   - the loader: 7 plates, plate -> object mapping as in the project's model_settings, plate names;
//   - the export: same plate count, the same object -> plate mapping (by name), plater_name kept, per-plate
//     wipe_tower_x/y; P2S / X1C: each object's XY offset from its plate centre = the source's (0.5 mm), unless
//     that plate records a shift;
//   - per-plate projection: one projection per plate whose frame is that plate's objects' bbox (+1 mm) with the
//     whole image fitted onto it; every lid's color split close to the image's (and to the other lids'); tile mode
//     (40 mm) uses the same tile on every plate;
//   - slicing (`--slice 0 --outputdir DIR FILE`, one at a time): Bambu Studio 2.8 for all three, 1.10 for X1C
//     and P2S. rc 0 and one G-code per plate (A1 mini: reported, not required; P2S in 1.10: must be refused, 1.10
//     has no P2S profile); per plate the prime tower is on the bed, clear of the objects and of the exclusion
//     polygon (validate-tower.ts' checks);
//   - lay-on-face per plate: plate 3's object laid on a big planar face moves only that object, stays inside
//     plate 3's cell, min z = 0; every other object is untouched.
//
//   bun scripts/validate-plates.ts            (outputs in scratch/bambu/plates/)
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { unzipSync } from 'fflate';
import { loadModel } from '../src/core/meshio';
import { createPipeline } from '../src/core/pipeline';
import { PRINTERS, objectsFromResult, writeBambuProject } from '../src/core/threemf';
import { buildAdjacency, planarRegion, rotationToDown, applyMat3 } from '../src/core/faces';
import { plateAt, plateCellOrigin, plateCentre } from '../src/core/plates';
import { DEFAULT_PARAMS } from '../src/core/types';
import type { ExportObject, Model, Params, RasterImage } from '../src/core/types';

const BIN: Record<string, string> = {
  '1.10': process.env.BAMBU_110 ?? '/tmp/bs110/BambuStudio.app/Contents/MacOS/BambuStudio',
  '2.8': process.env.BAMBU_28 ?? '/Applications/BambuStudio.app/Contents/MacOS/BambuStudio',
};
const ROOT = resolve(import.meta.dir, '..');
const OUT = `${ROOT}/scratch/bambu/plates`;
const YETI = `${ROOT}/scratch/inputs/yeti.3mf`;
const URBAN = `${ROOT}/presets-data/urban.webp`;
const TOWER_PY = `${ROOT}/scratch/bambu/excl/tower_extents.py`;
const TIMEOUT_MS = 180_000;
mkdirSync(OUT, { recursive: true });

let passed = 0, failed = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` ${detail}` : ''}`);
};

// ------------------------------------------------------------------------------------ inputs

/** urban.webp -> RGBA via dwebp's PAM output (header + raw RGBA rows). */
function decodeWebp(path: string): RasterImage {
  const pam = `${OUT}/urban.pam`;
  execFileSync('dwebp', [path, '-pam', '-o', pam], { stdio: 'ignore' });
  const buf = readFileSync(pam);
  const end = buf.indexOf('ENDHDR\n');
  const head = buf.subarray(0, end).toString('ascii');
  const width = +head.match(/WIDTH (\d+)/)![1], height = +head.match(/HEIGHT (\d+)/)![1];
  const data = new Uint8ClampedArray(buf.subarray(end + 7, end + 7 + width * height * 4));
  return { width, height, data };
}

interface Box { x0: number; y0: number; x1: number; y1: number; z0: number }
function bboxOf(meshes: { vertices: Float32Array }[], dx = 0, dy = 0, dz = 0): Box {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, z0 = Infinity;
  for (const m of meshes) {
    const v = m.vertices;
    for (let i = 0; i < v.length; i += 3) {
      x0 = Math.min(x0, v[i] + dx); x1 = Math.max(x1, v[i] + dx);
      y0 = Math.min(y0, v[i + 1] + dy); y1 = Math.max(y1, v[i + 1] + dy);
      z0 = Math.min(z0, v[i + 2] + dz);
    }
  }
  return { x0, y0, x1, y1, z0 };
}
const centreOf = (b: Box): [number, number] => [(b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2];
const objBox = (m: Model, j: number) => bboxOf(m.objects[j].parts.map((p) => p.mesh));

// ------------------------------------------------------------------------------------ 1. loader

const model = loadModel(new Uint8Array(readFileSync(YETI)), 'yeti.3mf');
const plates = model.plates;
check('loader: plates present', !!plates);
if (!plates) process.exit(1);
check('loader: 7 plates', plates.count === 7, `(${plates.count})`);
check('loader: 7 objects', model.objects.length === 7, `(${model.objects.length})`);
// build items are objects 2,4,...,14; plate1->2, 2->4, 3->6, 4->8, 5->14, 6->10, 7->12
check('loader: object -> plate mapping', JSON.stringify(plates.objectPlate) === JSON.stringify([0, 1, 2, 3, 5, 6, 4]), JSON.stringify(plates.objectPlate));
check('loader: source bed 256x256 at 0,0', plates.bed.join() === '256,256' && plates.bedOrigin.join() === '0,0', `${plates.bed} @ ${plates.bedOrigin}`);
check('loader: plate names', plates.names[0] === '2 lids' && plates.names.length === 7, JSON.stringify(plates.names));
const srcPlateByName = new Map(model.objects.map((o, j) => [o.name, plates.objectPlate[j]]));
const srcOffset = model.objects.map((_, j) => {
  const [cx, cy] = centreOf(objBox(model, j));
  const [px, py] = plateCentre(plates, plates.objectPlate[j]);
  return [cx - px, cy - py];
});

// ------------------------------------------------------------------------------------ 2. lay on face (plate 3)

{
  const j = plates.objectPlate.indexOf(2);
  const mesh = model.objects[j].parts[0].mesh;
  const adj = buildAdjacency(mesh);
  const seen = new Uint8Array(mesh.triangles.length / 3);
  let best: { normal: [number, number, number]; area: number; tris: number[] } | null = null;
  for (let t = 0; t < seen.length; t++) {
    if (seen[t]) continue;
    const r = planarRegion(mesh, adj, t);
    if (!r) continue;
    for (const k of r.triangles) seen[k] = 1;
    if (r.normal[2] < -0.98) continue; // already the bottom: laying on it moves nothing
    if (!best || r.area > best.area) best = { normal: r.normal, area: r.area, tris: r.triangles };
  }
  const R = rotationToDown(best!.normal);
  const plateOrientations = Array.from({ length: plates.count }, (_, p) => (p === 2 ? R : null));
  const pipe = createPipeline();
  const res = await pipe.run(null, model, { ...DEFAULT_PARAMS, plateOrientations });
  pipe.dispose();
  const out = res.model!;
  check('lay: result keeps plates', !!out.plates && out.plates.count === 7);
  check('lay: result echoes plateOrientations', !!res.plateOrientations?.[2] && res.plateOrientations.filter(Boolean).length === 1);
  const others = model.objects.every((o, k) => k === j || o.parts.every((p, i) => p.mesh.vertices === out.objects[k].parts[i].mesh.vertices
    || p.mesh.vertices.every((v, q) => v === out.objects[k].parts[i].mesh.vertices[q])));
  check('lay: other plates untouched', others);
  const before = objBox(model, j), after = objBox(out, j);
  const [bx, by] = centreOf(before), [ax, ay] = centreOf(after);
  check('lay: plate-3 object moved', Math.abs(after.x1 - after.x0 - (before.x1 - before.x0)) > 1 || Math.abs(after.y1 - after.y0 - (before.y1 - before.y0)) > 1,
    `(${(before.x1 - before.x0).toFixed(1)}x${(before.y1 - before.y0).toFixed(1)} -> ${(after.x1 - after.x0).toFixed(1)}x${(after.y1 - after.y0).toFixed(1)})`);
  check('lay: min z = 0', Math.abs(after.z0) < 1e-3, `(${after.z0.toFixed(4)})`);
  check('lay: XY centre kept', Math.hypot(ax - bx, ay - by) < 0.01, `(${(ax - bx).toFixed(3)}, ${(ay - by).toFixed(3)})`);
  check('lay: still in plate 3 cell', plateAt(plates, ax, ay) === 2 && plateAt(plates, after.x0, after.y0) === 2 && plateAt(plates, after.x1, after.y1) === 2);
  const n = applyMat3(R, best!.normal);
  check('lay: picked face now faces down', n[2] < -0.999, `(normal ${best!.normal.map((x) => x.toFixed(3))} area ${best!.area.toFixed(0)} mm²)`);
}

// ------------------------------------------------------------------------------------ 3. pipeline + exports

const image = decodeWebp(URBAN);
const params: Params = { ...DEFAULT_PARAMS, colors: 4 };
const t0 = Date.now();
const pipe = createPipeline();
const result = await pipe.run(image, model, params);
const hexes = result.regions.map((r) => r.hex.toUpperCase());
console.log(`pipeline: ${((Date.now() - t0) / 1000).toFixed(1)} s, colors ${hexes.join(' ')}, warnings ${result.warnings.length}`);
check('pipeline: result.model keeps plates', result.model?.plates?.count === 7);
const objects: ExportObject[] = objectsFromResult(result, hexes, 'urban');
check('export objects carry plates', objects.every((o, j) => o.plate === plates.objectPlate[j]));
const sourcePlates = { count: plates.count, bed: plates.bed, bedOrigin: plates.bedOrigin, names: plates.names };

// ------------------------------------------------------------------------------------ 3b. per-plate projection
// Every plate gets its own full pattern: its frame is its objects' bbox (+ 1 mm) in the projection plane, the image
// is fitted (cover) onto it, the palette is shared. Before (one image stretched over the whole 723.8 x 269.7 mm
// plate grid) the lids got very different splits: color 3 was 0.7 % of plate 5's lid and 1.3 % of plate 2's, color
// 4 was 57 % of plates 3 / 6 (image share 15 %).

const AXIS_R = { z: [1, 0, 0, 0, 1, 0, 0, 0, 1], y: [1, 0, 0, 0, 0, -1, 0, 1, 0], x: [0, 0, 1, 1, 0, 0, 0, 1, 0] };
/** uv bbox (+ margin) of some objects of m, like the pipeline's frame. */
function uvFrame(m: Model, objs: number[], R: number[], margin = 1) {
  let u0 = Infinity, v0 = Infinity, u1 = -Infinity, v1 = -Infinity;
  for (const j of objs) for (const part of m.objects[j].parts) {
    const v = part.mesh.vertices;
    for (let i = 0; i < v.length; i += 3) {
      const u = v[i] * R[0] + v[i + 1] * R[3] + v[i + 2] * R[6], w = v[i] * R[1] + v[i + 1] * R[4] + v[i + 2] * R[7];
      u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, w); v1 = Math.max(v1, w);
    }
  }
  return { x0: u0 - margin, y0: v0 - margin, x1: u1 + margin, y1: v1 + margin };
}
const meshVolume = (m: { vertices: Float32Array; triangles: Uint32Array } | null) => {
  if (!m) return 0;
  const v = m.vertices, t = m.triangles;
  let s = 0;
  for (let i = 0; i < t.length; i += 3) {
    const a = t[i] * 3, b = t[i + 1] * 3, c = t[i + 2] * 3;
    s += v[a] * (v[b + 1] * v[c + 2] - v[b + 2] * v[c + 1]) - v[a + 1] * (v[b] * v[c + 2] - v[b + 2] * v[c]) + v[a + 2] * (v[b] * v[c + 1] - v[b + 1] * v[c]);
  }
  return Math.abs(s / 6);
};
{
  const R = AXIS_R[params.axis];
  const pp = result.plateProjections ?? [];
  check('per-plate: one projection per plate', pp.length === plates.count, `(${pp.length})`);
  check('per-plate: projection objects = plate mapping', pp.every((p) => p.objects.every((j) => plates.objectPlate[j] === p.plate))
    && pp.reduce((n, p) => n + p.objects.length, 0) === model.objects.length);
  check('per-plate: regions carry rings per plate', result.regions.every((r) => r.plateRings?.length === pp.length));
  const aspect = image.width / image.height;
  let frameWorst = 0, fitOk = true;
  const rows: string[] = [];
  for (const p of pp) {
    const f = uvFrame(result.model!, p.objects, R);
    const d = Math.max(Math.abs(f.x0 - p.frame.x0), Math.abs(f.y0 - p.frame.y0), Math.abs(f.x1 - p.frame.x1), Math.abs(f.y1 - p.frame.y1));
    frameWorst = Math.max(frameWorst, d);
    // fit (cover): the whole image (its aspect) scaled to just cover this plate's frame
    const fw = p.frame.x1 - p.frame.x0, fh = p.frame.y1 - p.frame.y0;
    const covers = p.tile.w >= fw - 1e-6 && p.tile.h >= fh - 1e-6 && (Math.abs(p.tile.w - fw) < 1e-6 || Math.abs(p.tile.h - fh) < 1e-6);
    if (!covers || Math.abs(p.tile.w / p.tile.h - aspect) > 1e-6 || p.tile.repeat) fitOk = false;
    rows.push(`p${p.plate + 1}: frame ${fw.toFixed(1)} x ${fh.toFixed(1)} mm, image ${p.tile.w.toFixed(1)} x ${p.tile.h.toFixed(1)} mm, grid ${p.gridW}x${p.gridH}`);
  }
  console.log(`   ${rows.join('\n   ')}`);
  check('per-plate: frame = that plate\'s objects\' bbox (+1 mm)', frameWorst < 1e-3, `(worst ${frameWorst.toExponential(1)} mm)`);
  check('per-plate: full image fitted (cover) onto each plate', fitOk);

  // per lid: each color's share of the modifier volume vs the image's color shares (same palette, image mode)
  const ip = createPipeline();
  const imgShares = (await ip.run(image, null, params)).regions.map((r) => r.coverage);
  ip.dispose();
  console.log(`   image shares ${imgShares.map((x) => x.toFixed(3)).join(' ')}`);
  let minRatio = Infinity, maxDev = 0;
  const shares: number[][] = [];
  for (let j = 0; j < model.objects.length; j++) {
    const v = result.regions.map((r) => meshVolume(r.objectMeshes?.[j] ?? null));
    const tot = v.reduce((a, b) => a + b, 0) || 1;
    const sh = v.map((x) => x / tot);
    shares.push(sh);
    sh.forEach((x, k) => { minRatio = Math.min(minRatio, x / imgShares[k]); maxDev = Math.max(maxDev, Math.abs(x - imgShares[k])); });
    console.log(`   object ${j} (plate ${plates.objectPlate[j] + 1}): ${sh.map((x) => x.toFixed(3)).join(' ')}`);
  }
  const spread = Math.max(...imgShares.map((_, k) => Math.max(...shares.map((s) => s[k])) - Math.min(...shares.map((s) => s[k]))));
  check('per-plate: every color on every lid (>= 40 % of its image share)', minRatio >= 0.4, `(min ratio ${minRatio.toFixed(2)})`);
  check('per-plate: lid shares near the image shares (<= 0.12)', maxDev <= 0.12, `(max |Δ| ${maxDev.toFixed(3)})`);
  check('per-plate: the lids match each other (spread <= 0.05)', spread <= 0.05, `(max spread ${spread.toFixed(3)})`);

  // tile mode: one tile size (mm) on every plate, each tiled from its own frame corner
  const tiled = await pipe.run(image, model, { ...params, width: 40 });
  const tp = tiled.plateProjections ?? [];
  const sameTile = tp.length === plates.count && tp.every((p) => p.tile.repeat && Math.abs(p.tile.w - 40) < 1e-9 && Math.abs(p.tile.h - tp[0].tile.h) < 1e-9);
  check('tile: same 40 mm tile on every plate', sameTile, `(${tp.map((p) => `${p.tile.w.toFixed(2)}x${p.tile.h.toFixed(2)}`).join(', ')})`);
  check('tile: colors on every lid', model.objects.every((_, j) => tiled.regions.every((r) => meshVolume(r.objectMeshes?.[j] ?? null) > 0)));
}
pipe.dispose();

type Pt = [number, number];
const parsePoly = (v: unknown): Pt[] =>
  (Array.isArray(v) ? v : []).map((s) => String(s).split('x').map(parseFloat) as Pt).filter((p) => p.length === 2 && p.every(Number.isFinite));

interface Proj { id: string; file: string; nPlates: number; shifts: number[]; warnings: string[]; bed: Box; excl: Box | null }
const projs: Proj[] = [];
for (const id of ['p2s-0.4', 'x1c-0.4', 'a1mini-0.4']) {
  const pr = PRINTERS.find((p) => p.id === id)!;
  let out: Awaited<ReturnType<typeof writeBambuProject>>;
  try {
    out = await writeBambuProject(objects, { printerId: id, filamentColors: hexes, sourcePlates });
  } catch (e) {
    check(`${id}: writeBambuProject`, false, (e as Error).message);
    continue;
  }
  const { bytes, warnings, plateShifts } = out;
  const file = `${OUT}/${id}-yeti.3mf`;
  writeFileSync(file, bytes);
  console.log(`${id}: shifts [${plateShifts.join(', ')}]${warnings.length ? `; warnings: ${warnings.join(' | ')}` : ''}`);
  const z = unzipSync(bytes);
  const dec = (k: string) => new TextDecoder().decode(z[k]);
  const xml = dec('Metadata/model_settings.config');
  const settings = JSON.parse(dec('Metadata/project_settings.config'));
  const rootModel = dec('3D/3dmodel.model');
  const nameById = new Map<string, string>();
  for (const m of xml.matchAll(/<object id="(\d+)">\s*<metadata key="name" value="([^"]*)"/g)) nameById.set(m[1], m[2].replace(/&amp;/g, '&'));
  const plateBlocks = [...xml.matchAll(/<plate>([\s\S]*?)<\/plate>/g)].map((m) => m[1]);
  check(`${id}: ${plates.count} plates written`, plateBlocks.length === plates.count, `(${plateBlocks.length})`);
  const expPlateByName = new Map<string, number>();
  const names: string[] = [];
  plateBlocks.forEach((b, p) => {
    names.push(b.match(/key="plater_name" value="([^"]*)"/)?.[1] ?? '');
    for (const m of b.matchAll(/key="object_id" value="(\d+)"/g)) expPlateByName.set(nameById.get(m[1]) ?? '?', p);
  });
  const mapOk = [...srcPlateByName].every(([n, p]) => expPlateByName.get(n) === p) && expPlateByName.size === srcPlateByName.size;
  check(`${id}: object -> plate mapping by name`, mapOk);
  check(`${id}: plate names`, JSON.stringify(names) === JSON.stringify(plates.names), JSON.stringify(names));
  check(`${id}: one tower position per plate`, settings.wipe_tower_x.length === plates.count && settings.wipe_tower_y.length === plates.count);
  check(`${id}: plateShifts per plate`, plateShifts.length === plates.count);

  // offsets from each plate centre, from the written build-item translations + the exported normal-part meshes
  const area = parsePoly(settings.printable_area);
  const bed: Box = { x0: Math.min(...area.map((p) => p[0])), y0: Math.min(...area.map((p) => p[1])), x1: Math.max(...area.map((p) => p[0])), y1: Math.max(...area.map((p) => p[1])), z0: 0 };
  const tc: [number, number] = [(bed.x0 + bed.x1) / 2, (bed.y0 + bed.y1) / 2];
  const items = [...rootModel.matchAll(/<item [^>]*transform="([^"]+)"/g)].map((m) => m[1].split(' ').map(Number));
  const rows: string[] = [];
  let worst = 0, offOk = true, onBed = true, zOk = true;
  objects.forEach((o, j) => {
    const t = items[j];
    const b = bboxOf(o.parts.filter((p) => p.subtype === 'normal_part').map((p) => p.mesh), t[9], t[10], t[11]);
    const p = plates.objectPlate[j];
    const [ox, oy] = plateCellOrigin(p, plates.count, pr.bed);
    const [cx, cy] = centreOf(b);
    const off = [cx - ox - tc[0], cy - oy - tc[1]];
    const d = Math.hypot(off[0] - srcOffset[j][0], off[1] - srcOffset[j][1]);
    worst = Math.max(worst, plateShifts[p] > 0 ? 0 : d);
    if (plateShifts[p] === 0 && d > 0.5) offOk = false;
    if (plateShifts[p] > 0 && Math.abs(d - plateShifts[p]) > 0.5) offOk = false;
    if (b.x0 - ox < bed.x0 - 0.01 || b.y0 - oy < bed.y0 - 0.01 || b.x1 - ox > bed.x1 + 0.01 || b.y1 - oy > bed.y1 + 0.01) onBed = false;
    if (Math.abs(b.z0) > 1e-3) zOk = false;
    rows.push(`p${p + 1} off (${off[0].toFixed(2)}, ${off[1].toFixed(2)}) src (${srcOffset[j][0].toFixed(2)}, ${srcOffset[j][1].toFixed(2)}) Δ ${d.toFixed(2)} shift ${plateShifts[p]}`);
  });
  console.log(`   ${rows.join('\n   ')}`);
  check(`${id}: objects dropped to z = 0`, zOk);
  if (id !== 'a1mini-0.4') {
    check(`${id}: offsets from plate centre = source (0.5 mm, unless shifted)`, offOk, `(worst unshifted Δ ${worst.toFixed(3)} mm)`);
    check(`${id}: every object inside its plate`, onBed);
    check(`${id}: no warnings`, warnings.length === 0, warnings.join(' | '));
  } else {
    check(`${id}: too-big plates warn`, warnings.some((w) => /bigger than the 180/.test(w)), warnings.join(' | '));
  }
  const ex = parsePoly(settings.bed_exclude_area);
  const exBox = ex.length >= 3 ? { x0: Math.min(...ex.map((p) => p[0])), y0: Math.min(...ex.map((p) => p[1])), x1: Math.max(...ex.map((p) => p[0])), y1: Math.max(...ex.map((p) => p[1])), z0: 0 } : null;
  projs.push({ id, file, nPlates: plateBlocks.length, shifts: plateShifts, warnings, bed, excl: exBox && exBox.x1 > exBox.x0 && exBox.y1 > exBox.y0 ? exBox : null });
}

// ------------------------------------------------------------------------------------ 4. slicing

interface BBox { x0: number; y0: number; x1: number; y1: number }
const grow = (b: BBox | undefined, x: number, y: number): BBox =>
  b ? { x0: Math.min(b.x0, x), y0: Math.min(b.y0, y), x1: Math.max(b.x1, x), y1: Math.max(b.y1, y) } : { x0: x, y0: y, x1: x, y1: y };
/** Non-tower object extrusion bbox of one plate's G-code (validate-tower.ts' parse, objects merged). */
function objectExtents(gcode: string): BBox | null {
  let inTower = false, feat = '', x = 0, y = 0, box: BBox | undefined;
  for (const raw of readFileSync(gcode, 'utf8').split('\n')) {
    const line = raw.trim();
    if (line.startsWith(';')) {
      if (line === '; WIPE_TOWER_START') inTower = true;
      else if (line === '; WIPE_TOWER_END') inTower = false;
      else if (line.toLowerCase().startsWith('; feature:')) feat = line.slice(10).trim().toLowerCase();
      continue;
    }
    if (!/^G[0-3] /.test(line)) continue;
    const px = x, py = y;
    const mx = line.match(/X(-?[0-9.]+)/), my = line.match(/Y(-?[0-9.]+)/);
    if (mx) x = parseFloat(mx[1]);
    if (my) y = parseFloat(my[1]);
    const em = line.match(/\bE(-?[0-9.]+)/);
    if (em && (mx || my) && parseFloat(em[1]) > 0 && !inTower && !feat.includes('tower') && feat && feat !== 'custom') box = grow(grow(box, px, py), x, y);
  }
  return box ?? null;
}
function towerBoxes(files: string[]): (BBox | null)[] {
  if (!files.length || !existsSync(TOWER_PY)) return files.map(() => null);
  const out = execFileSync('python3', ['-I', TOWER_PY, ...files], { encoding: 'utf8' }).trim().split('\n');
  return out.map((l) => {
    const m = l.match(/\(([-\d.]+), ([-\d.]+), ([-\d.]+), ([-\d.]+)\)\s*$/);
    return m ? { x0: +m[1], y0: +m[2], x1: +m[3], y1: +m[4] } : null;
  });
}
function rectGap(a: BBox, b: BBox): number {
  const dx = Math.max(b.x0 - a.x1, a.x0 - b.x1), dy = Math.max(b.y0 - a.y1, a.y0 - b.y1);
  if (dx < 0 && dy < 0) return Math.max(dx, dy);
  return Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
}

function slice(ver: string, file: string, dir: string): Promise<{ exit: number | null; rc: number | null; err: string; gcodes: string[]; ms: number; timedOut: boolean }> {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const t = Date.now();
  return new Promise((res) => {
    const ch = spawn(BIN[ver], ['--slice', '0', '--outputdir', dir, file], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = '';
    ch.stdout.on('data', (d) => (log += d));
    ch.stderr.on('data', (d) => (log += d));
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; ch.kill('SIGKILL'); }, TIMEOUT_MS);
    ch.on('close', (code) => {
      clearTimeout(timer);
      writeFileSync(`${dir}/cli.log`, log);
      let rc: number | null = null, err = '';
      if (existsSync(`${dir}/result.json`)) {
        try { const j = JSON.parse(readFileSync(`${dir}/result.json`, 'utf8')); rc = j.return_code; err = j.error_string ?? ''; } catch { /* */ }
      }
      const gcodes: string[] = [];
      for (let p = 1; existsSync(`${dir}/plate_${p}.gcode`); p++) gcodes.push(`${dir}/plate_${p}.gcode`);
      res({ exit: code, rc, err, gcodes, ms: Date.now() - t, timedOut });
    });
  });
}

// 1.10 has no P2S profile: its P2S slice must be refused (as in validate-studio-compat), X1C must slice in both
const jobs: { p: Proj; ver: string }[] = [];
for (const p of projs) for (const ver of p.id === 'a1mini-0.4' ? ['2.8'] : ['2.8', '1.10']) jobs.push({ p, ver });
const missing = Object.entries(BIN).filter(([, b]) => !existsSync(b)).map(([v]) => v);
if (missing.length) console.log(`(Bambu Studio ${missing.join(', ')} missing: those slices are skipped)`);
// one slice at a time (the machine is shared; parallel slices hit timeouts)
const results: { p: Proj; ver: string; s: Awaited<ReturnType<typeof slice>> }[] = [];
for (const { p, ver } of jobs.filter((j) => existsSync(BIN[j.ver]))) results.push({ p, ver, s: await slice(ver, p.file, `${OUT}/${p.id}-${ver}`) });
for (const { p, ver, s } of results) {
  const tag = `${p.id} slice ${ver}`;
  const required = p.id !== 'a1mini-0.4';
  const summary = `exit ${s.exit}, return_code ${s.rc}${s.err ? ` "${s.err}"` : ''}, ${s.gcodes.length} plate G-codes, ${(s.ms / 1000).toFixed(0)} s${s.timedOut ? ', TIMEOUT' : ''}`;
  if (!required) {
    console.log(`INFO ${tag}: ${summary} (A1 mini: oversized plates, not required)`);
    continue;
  }
  if (p.id === 'p2s-0.4' && ver === '1.10') {
    check(`${tag}: refused (1.10 has no P2S profile)`, !(s.rc === 0 && s.gcodes.length === p.nPlates), summary);
    continue;
  }
  check(`${tag}: return_code 0`, s.rc === 0 || (ver === '1.10' && s.rc === null && s.exit === 0), summary);
  check(`${tag}: ${p.nPlates} plates sliced`, s.gcodes.length === p.nPlates, `(${s.gcodes.length})`);
  const towers = towerBoxes(s.gcodes);
  const rows: string[] = [];
  let towerOk = true;
  s.gcodes.forEach((g, i) => {
    const t = towers[i], o = objectExtents(g);
    if (!t) { towerOk = false; rows.push(`p${i + 1}: no tower`); return; }
    const b = p.bed;
    const onBed = t.x0 >= b.x0 && t.y0 >= b.y0 && t.x1 <= b.x1 && t.y1 <= b.y1;
    const og = o ? rectGap(t, o) : null;
    const eg = p.excl ? rectGap(t, p.excl) : null;
    if (!onBed || (og !== null && og <= 0) || (eg !== null && eg <= 0)) towerOk = false;
    rows.push(`p${i + 1}: tower [${t.x0},${t.y0}-${t.x1},${t.y1}] obj gap ${og?.toFixed(1) ?? '-'} excl gap ${eg?.toFixed(1) ?? '-'}${onBed ? '' : ' OFF BED'}`);
  });
  console.log(`   ${rows.join('\n   ')}`);
  check(`${tag}: towers on the bed, clear of objects and exclusion`, towerOk);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
