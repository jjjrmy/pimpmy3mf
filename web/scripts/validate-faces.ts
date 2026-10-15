// End-to-end validation for the PAINT FACE feature (face-skin modifiers).
//
// Drives the REAL geometry pipeline (createPipeline().run) + objectsFromResult + writeBambuProject, then slices
// each project with the Bambu Studio CLI and inspects the G-code per layer.
//
// Cases:
//  (a) 40x40x20 box, 3-color diagonal-stripe camo (axis y), TOP face painted filament 2. Asserts the top layer
//      is 100% that filament, a mid layer's outer wall still uses >=2 tools, and renders both layers. Repeats
//      with perPart on a 2-part object (only one part painted).
//  (b) lay-on-face: a box pre-rotated 30 deg about X, orientation = rotationToDown(sloped-face normal). Asserts
//      the exported model rests on the bed (min z = 0), the picked face lies at z ~ 0, the XY bbox center is
//      unchanged, and it slices. Then paints that face and checks the skin follows it into the new pose.
//  (probe) two overlapping modifier parts (different filaments) with NO subtraction, to see if modifier ORDER
//      alone decides precedence in Bambu (last wins?).
//
//   bun scripts/validate-faces.ts
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { unzipSync } from 'fflate';
import { createPipeline } from '../src/core/pipeline';
import { objectsFromResult, writeBambuProject } from '../src/core/threemf';
import { buildAdjacency, planarRegion, triNormal, rotationToDown } from '../src/core/faces';
import { DEFAULT_PARAMS } from '../src/core/types';
import type { ExportObject, Mesh, Model, PaintedFace, Params, RasterImage, Vec3 } from '../src/core/types';

const BAMBU = process.env.BAMBU_STUDIO ?? '/Applications/BambuStudio.app/Contents/MacOS/BambuStudio';
const ROOT = resolve(import.meta.dir, '..');
const OUT = `${ROOT}/scratch/bambu/faces`;
const RENDER = `${ROOT}/scripts/render-gcode.py`;
const PY = process.env.PYTHON ?? 'python3';
const PLATE = 'Textured PEI Plate';

mkdirSync(OUT, { recursive: true });

// ---------------------------------------------------------------------------------- mesh helpers

/** Axis-aligned box (corner origin), 8 verts / 12 tris, outward CCW. */
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

/** Rotate every vertex by `deg` about X, around the mesh's own bbox center (returns a new mesh). */
function rotateX(mesh: Mesh, deg: number): Mesh {
  const v = mesh.vertices;
  let y0 = Infinity, y1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (let i = 0; i < v.length; i += 3) {
    if (v[i + 1] < y0) y0 = v[i + 1]; if (v[i + 1] > y1) y1 = v[i + 1];
    if (v[i + 2] < z0) z0 = v[i + 2]; if (v[i + 2] > z1) z1 = v[i + 2];
  }
  const cy = (y0 + y1) / 2, cz = (z0 + z1) / 2;
  const t = (deg * Math.PI) / 180, c = Math.cos(t), s = Math.sin(t);
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i += 3) {
    const y = v[i + 1] - cy, z = v[i + 2] - cz;
    out[i] = v[i];
    out[i + 1] = c * y - s * z + cy;
    out[i + 2] = s * y + c * z + cz;
  }
  return { vertices: out, triangles: mesh.triangles };
}

/** Pick the triangle whose outward normal best matches `dir`, then flood its planar region. */
function faceAlong(mesh: Mesh, dir: Vec3): { triangles: number[]; normal: Vec3; area: number } {
  const adj = buildAdjacency(mesh);
  let best = -1, bestDot = -Infinity;
  const nt = mesh.triangles.length / 3;
  for (let tri = 0; tri < nt; tri++) {
    const { n, area } = triNormal(mesh, tri);
    if (area === 0) continue;
    const dot = n[0] * dir[0] + n[1] * dir[1] + n[2] * dir[2];
    if (dot > bestDot) { bestDot = dot; best = tri; }
  }
  const reg = planarRegion(mesh, adj, best)!;
  return { triangles: reg.triangles, normal: reg.normal, area: reg.area };
}

/** 3-color diagonal-stripe RasterImage (so the camo lands all 3 filaments on the model's faces). */
function stripeImage(size = 120, band = 24): RasterImage {
  const pal = [[194, 24, 7], [31, 122, 31], [32, 64, 192]];
  const data = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const c = pal[Math.floor((x + y) / band) % 3];
      const o = (y * size + x) * 4;
      data[o] = c[0]; data[o + 1] = c[1]; data[o + 2] = c[2]; data[o + 3] = 255;
    }
  return { width: size, height: size, data };
}
const STRIPE_PALETTE: Vec3[] = [[194, 24, 7], [31, 122, 31], [32, 64, 192]];

// ----------------------------------------------------------------------------------- CLI + gcode

interface Move { z: number; tool: number; feature: string }

/** Walk a plate_N.gcode: declared filament colors + every extrusion move (z, active tool, current feature),
 * skipping prime/wipe-tower moves. Layer z is taken from `; Z_HEIGHT:` (fallback: G1/G0 Z tokens). */
function parseGcodeMoves(path: string): { colors: string[]; moves: Move[] } {
  const text = readFileSync(path, 'utf8');
  const colors: string[] = [];
  const moves: Move[] = [];
  let tool = 0, z = 0, feature = '', inTower = false, featureTower = false;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line.startsWith(';')) {
      const low = line.toLowerCase();
      if (!colors.length && line.startsWith('; filament_colour =')) {
        for (const c of line.split('=')[1].split(';')) if (c.trim()) colors.push(c.trim().toUpperCase());
      } else if (line.startsWith('; Z_HEIGHT:')) z = parseFloat(line.split(':')[1]);
      else if (line === '; WIPE_TOWER_START') inTower = true;
      else if (line === '; WIPE_TOWER_END') inTower = false;
      else if (low.startsWith('; feature:')) { feature = low.slice('; feature:'.length).trim(); featureTower = feature.includes('prime tower') || feature.includes('wipe tower'); }
      continue;
    }
    const tm = line.match(/^T(\d+)\b/);
    if (tm) { tool = parseInt(tm[1], 10); continue; }
    if (line.startsWith('G1') || line.startsWith('G0')) {
      const zm = line.match(/\bZ(-?[0-9.]+)/);
      if (zm) z = parseFloat(zm[1]);
      const em = line.match(/\bE(-?[0-9.]+)/);
      const moved = /\b[XY]-?[0-9.]/.test(line);
      if (em && moved && parseFloat(em[1]) > 0 && !inTower && !featureTower) moves.push({ z, tool, feature });
    }
  }
  return { colors, moves };
}

function runSlice(file: string, tag: string): { dir: string; returnCode: number; error: string } {
  const dir = `${OUT}/${tag}-slice`;
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  try {
    execFileSync(BAMBU, ['--slice', '0', '--outputdir', dir, file], { encoding: 'utf8', timeout: 300000 });
  } catch {
    /* non-zero exit still writes result.json */
  }
  let returnCode = -999, error = 'no result.json';
  if (existsSync(`${dir}/result.json`)) {
    const j = JSON.parse(readFileSync(`${dir}/result.json`, 'utf8'));
    returnCode = j.return_code;
    error = j.error_string ?? '';
  }
  return { dir, returnCode, error };
}

/** Render one layer of a sliced plate (frac up the part) to a PNG. */
function render(tag: string, frac: number, suffix: string): string | null {
  const gcode = `${OUT}/${tag}-slice/plate_1.gcode`;
  if (!existsSync(gcode)) return null;
  const png = `${OUT}/${tag}-${suffix}.png`;
  try {
    const log = execFileSync(PY, ['-I', RENDER, gcode, png, '--frac', String(frac)], { encoding: 'utf8' });
    console.log('   ' + log.trim());
    return png;
  } catch (e: any) {
    console.log('   render failed:', e.message);
    return null;
  }
}

// --------------------------------------------------------------------------------- 3MF inspection

/** model_settings.config -> [{ name, parts: [{name, extruder, subtype}] }]. */
function readModelSettings(bytes: Uint8Array): { name: string; parts: { name: string; extruder: string; subtype: string }[] }[] {
  const xml = new TextDecoder().decode(unzipSync(bytes)['Metadata/model_settings.config']);
  const out: { name: string; parts: { name: string; extruder: string; subtype: string }[] }[] = [];
  const objRe = /<object id="\d+">([\s\S]*?)<\/object>/g;
  let m: RegExpExecArray | null;
  while ((m = objRe.exec(xml))) {
    const body = m[1];
    const nm = body.match(/key="name" value="([^"]*)"/);
    const parts: { name: string; extruder: string; subtype: string }[] = [];
    const partRe = /<part id="\d+" subtype="(\w+)">([\s\S]*?)<\/part>/g;
    let pm: RegExpExecArray | null;
    while ((pm = partRe.exec(body))) {
      const pn = pm[2].match(/key="name" value="([^"]*)"/);
      const pe = pm[2].match(/key="extruder" value="(\d+)"/);
      parts.push({ name: pn ? pn[1] : '', extruder: pe ? pe[1] : '', subtype: pm[1] });
    }
    out.push({ name: nm ? nm[1] : '', parts });
  }
  return out;
}

/** Build-item transforms (12-number strings) from a project's 3D/3dmodel.model. */
function readBuildTransforms(bytes: Uint8Array): number[][] {
  const xml = new TextDecoder().decode(unzipSync(bytes)['3D/3dmodel.model']);
  return [...xml.matchAll(/<item objectid="\d+"[^>]*transform="([^"]*)"/g)].map((mm) => mm[1].split(/\s+/).map(Number));
}

/** Apply a 3MF build transform (row-major 3x3 then translation) to an xyz point. */
function applyTf(T: number[], x: number, y: number, z: number): Vec3 {
  return [
    T[0] * x + T[1] * y + T[2] * z + T[9],
    T[3] * x + T[4] * y + T[5] * z + T[10],
    T[6] * x + T[7] * y + T[8] * z + T[11],
  ];
}

// ------------------------------------------------------------------------------------- assertions

let passed = 0, failed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) { passed++; console.log(`   ✓ ${name}`); }
  else { failed++; failures.push(`${name} ${detail}`); console.log(`   ✗ ${name} ${detail}`); }
}

async function writeProject(objects: ExportObject[], colors: string[], name: string): Promise<{ file: string; bytes: Uint8Array; warnings: string[] }> {
  const { bytes, warnings } = await writeBambuProject(objects, { printerId: 'p2s-0.4', filamentColors: colors, plate: PLATE });
  const file = `${OUT}/${name}.3mf`;
  writeFileSync(file, bytes);
  return { file, bytes, warnings };
}

function paintParams(faces: PaintedFace[], extra: Partial<Params> = {}): Params {
  return { ...DEFAULT_PARAMS, palette: STRIPE_PALETTE, axis: 'y', paintedFaces: faces, ...extra };
}

// ------------------------------------------------------------------------------------------- cases

async function caseA(): Promise<void> {
  console.log('\n# (a) box: paint TOP face filament 2, camo on the sides');
  const image = stripeImage();
  const model: Model = { objects: [{ name: 'box', parts: [{ name: 'box', mesh: box(0, 0, 40, 40, 20) }] }] };
  const top = faceAlong(model.objects[0].parts[0].mesh, [0, 0, 1]);
  const face: PaintedFace = { id: 'top', objectIndex: 0, partIndex: 0, triangles: top.triangles, color: 1, area: top.area };

  const pipe = createPipeline();
  const result = await pipe.run(image, model, paintParams([face]));
  pipe.dispose();
  check('a: pipeline produced exactly one face skin', result.faceSkins.length === 1, `(got ${result.faceSkins.length})`);
  check('a: 3 camo colors', result.regions.length === 3, `(got ${result.regions.length})`);

  const colors = result.regions.map((r) => r.hex);
  const objects = objectsFromResult(result, colors, 'box');
  const nSkinParts = objects.reduce((s, o) => s + o.parts.filter((p) => p.name.startsWith('Painted face')).length, 0);
  check('a: one "Painted face" modifier part emitted', nSkinParts === 1, `(got ${nSkinParts})`);
  const { file } = await writeProject(objects, colors, 'a-top');

  const { dir, returnCode, error } = runSlice(file, 'a-top');
  check('a: slice return_code 0', returnCode === 0, `(got ${returnCode}: ${error})`);
  const gc = `${dir}/plate_1.gcode`;
  if (existsSync(gc)) {
    const { moves } = parseGcodeMoves(gc);
    const zs = [...new Set(moves.map((m) => Math.round(m.z * 100) / 100))].sort((a, b) => a - b);
    const topZ = zs[zs.length - 1], midZ = zs[Math.floor(zs.length * 0.45)];
    const topMoves = moves.filter((m) => Math.abs(m.z - topZ) < 0.12);
    const topTools = new Set(topMoves.map((m) => m.tool));
    check('a: top layer is 100% filament 2 (tool 1)',
      topMoves.length > 0 && topTools.size === 1 && topTools.has(1),
      `(z=${topZ}, tools=${JSON.stringify([...topTools])}, n=${topMoves.length})`);
    const midMoves = moves.filter((m) => Math.abs(m.z - midZ) < 0.12);
    const midOuter = midMoves.filter((m) => m.feature.includes('outer wall'));
    const midPool = midOuter.length ? midOuter : midMoves;
    const midTools = new Set(midPool.map((m) => m.tool));
    check('a: mid layer outer wall uses >=2 tools (camo on the sides)', midTools.size >= 2,
      `(z=${midZ}, tools=${JSON.stringify([...midTools])}, n=${midPool.length})`);
    console.log(`   top layer tools=${JSON.stringify([...topTools])} @ z=${topZ}; mid outer-wall tools=${JSON.stringify([...midTools])} @ z=${midZ}`);
    render('a-top', 0.98, 'toplayer');
    render('a-top', 0.45, 'midlayer');
  }

  // perPart: 2-part object, paint only part 0's top face
  console.log('\n# (a) perPart: 2-part object, only part 0 painted');
  const pp: Model = { objects: [{ name: 'asm', parts: [
    { name: 'p0', mesh: box(0, 0, 40, 40, 20) },
    { name: 'p1', mesh: box(60, 0, 40, 40, 20) },
  ] }] };
  const top0 = faceAlong(pp.objects[0].parts[0].mesh, [0, 0, 1]);
  const face0: PaintedFace = { id: 'p0-top', objectIndex: 0, partIndex: 0, triangles: top0.triangles, color: 1, area: top0.area };
  const pipe2 = createPipeline();
  const res2 = await pipe2.run(image, pp, paintParams([face0], { perPart: true }));
  pipe2.dispose();
  check('a/pp: one face skin (objectIndex 0, partIndex 0)',
    res2.faceSkins.length === 1 && res2.faceSkins[0].objectIndex === 0 && res2.faceSkins[0].partIndex === 0,
    `(${JSON.stringify(res2.faceSkins.map((s) => [s.objectIndex, s.partIndex]))})`);
  const colors2 = res2.regions.map((r) => r.hex);
  const objs2 = objectsFromResult(res2, colors2, 'asm');
  const { file: file2, bytes: bytes2 } = await writeProject(objs2, colors2, 'a-perpart');
  const ms = readModelSettings(bytes2);
  const p0skins = (ms[0]?.parts ?? []).filter((p) => p.name.startsWith('Painted face'));
  const p1skins = (ms[1]?.parts ?? []).filter((p) => p.name.startsWith('Painted face'));
  check('a/pp: skin lands in part 0 object only',
    ms.length === 2 && p0skins.length === 1 && p0skins[0].extruder === '2' && p1skins.length === 0,
    `(objects=${ms.length}, p0 skins=${p0skins.length}@ext${p0skins[0]?.extruder}, p1 skins=${p1skins.length})`);
  const { returnCode: rc2, error: err2 } = runSlice(file2, 'a-perpart');
  check('a/pp: slice return_code 0', rc2 === 0, `(got ${rc2}: ${err2})`);
}

async function caseB(): Promise<void> {
  console.log('\n# (b) lay-on-face: box pre-rotated 30 deg about X');
  const image = stripeImage();
  const tilted = rotateX(box(0, 0, 40, 40, 20), 30);
  const asLoaded: Model = { objects: [{ name: 'tilt', parts: [{ name: 'tilt', mesh: tilted }] }] };

  // pick the sloped face that used to be the top (largest +Z component after the 30 deg tilt)
  const sloped = faceAlong(tilted, [0, -Math.sin(Math.PI / 6), Math.cos(Math.PI / 6)]);
  const R = rotationToDown(sloped.normal);

  // as-loaded XY bbox center (over the part mesh)
  const xyCenter = (mesh: Mesh): [number, number] => {
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    const v = mesh.vertices;
    for (let i = 0; i < v.length; i += 3) {
      if (v[i] < x0) x0 = v[i]; if (v[i] > x1) x1 = v[i];
      if (v[i + 1] < y0) y0 = v[i + 1]; if (v[i + 1] > y1) y1 = v[i + 1];
    }
    return [(x0 + x1) / 2, (y0 + y1) / 2];
  };
  const [cx0, cy0] = xyCenter(tilted);

  // --- b1: orientation only (no painted faces) ---
  const pipe = createPipeline();
  const res = await pipe.run(image, asLoaded, paintParams([], { orientation: R }));
  pipe.dispose();
  const om = res.model!.objects[0].parts[0].mesh;

  // face vertices should now sit at z ~ 0 (in result.model coordinates)
  const faceVerts = new Set<number>();
  for (const tri of sloped.triangles) for (let e = 0; e < 3; e++) faceVerts.add(om.triangles[tri * 3 + e]);
  let faceMaxAbsZ = 0;
  for (const vi of faceVerts) faceMaxAbsZ = Math.max(faceMaxAbsZ, Math.abs(om.vertices[vi * 3 + 2]));
  check('b: picked face lies at z ~ 0 after lay-on-face', faceMaxAbsZ < 1e-3, `(max |z| = ${faceMaxAbsZ.toExponential(2)})`);

  const [cx1, cy1] = xyCenter(om);
  check('b: XY bbox center unchanged by orientation', Math.abs(cx1 - cx0) < 1e-3 && Math.abs(cy1 - cy0) < 1e-3,
    `(was [${cx0.toFixed(3)}, ${cy0.toFixed(3)}], now [${cx1.toFixed(3)}, ${cy1.toFixed(3)}])`);

  const colors = res.regions.map((r) => r.hex);
  const objects = objectsFromResult(res, colors, 'tilt');
  const { file, bytes } = await writeProject(objects, colors, 'b-oriented');

  // exported model (normal parts) rests on the bed: apply build transform, min z == 0
  const T = readBuildTransforms(bytes)[0];
  let minZ = Infinity;
  for (const p of objects[0].parts) {
    if (p.subtype !== 'normal_part') continue;
    const v = p.mesh.vertices;
    for (let i = 0; i < v.length; i += 3) minZ = Math.min(minZ, applyTf(T, v[i], v[i + 1], v[i + 2])[2]);
  }
  check('b: exported model min z = 0 (rests on bed)', Math.abs(minZ) < 1e-3, `(min z = ${minZ.toExponential(2)})`);
  const { returnCode, error } = runSlice(file, 'b-oriented');
  check('b: slice return_code 0', returnCode === 0, `(got ${returnCode}: ${error})`);

  // --- b2: paint the sloped face, then orient; the skin must follow it to the bottom ---
  console.log('\n# (b) paint the sloped face, then lay it down — skin follows');
  const face: PaintedFace = { id: 'sloped', objectIndex: 0, partIndex: 0, triangles: sloped.triangles, color: 1, area: sloped.area };
  const pipe2 = createPipeline();
  const res2 = await pipe2.run(image, asLoaded, paintParams([face], { orientation: R }));
  pipe2.dispose();
  check('b2: one face skin after lay-on-face', res2.faceSkins.length === 1, `(got ${res2.faceSkins.length})`);
  if (res2.faceSkins.length === 1) {
    const sv = res2.faceSkins[0].mesh.vertices;
    let sz0 = Infinity, sz1 = -Infinity;
    for (let i = 2; i < sv.length; i += 3) { if (sv[i] < sz0) sz0 = sv[i]; if (sv[i] > sz1) sz1 = sv[i]; }
    // laid face is at z~0 facing -Z: skin spans 0.05 below (outward) to ~1.0 above (inward)
    check('b2: skin sits on the laid-down face (z from ~-0.05 to ~1.0)',
      sz0 > -0.2 && sz0 < 0.01 && sz1 > 0.9 && sz1 < 1.2, `(skin z range [${sz0.toFixed(3)}, ${sz1.toFixed(3)}])`);
    const colors2 = res2.regions.map((r) => r.hex);
    const objs2 = objectsFromResult(res2, colors2, 'tilt');
    const { file: file2 } = await writeProject(objs2, colors2, 'b-painted');
    const { returnCode: rc2, error: err2 } = runSlice(file2, 'b-painted');
    check('b2: slice return_code 0', rc2 === 0, `(got ${rc2}: ${err2})`);
  }
}

/** Two overlapping modifier parts (different filaments), no subtraction, to probe modifier ordering. */
async function precedenceProbe(): Promise<void> {
  console.log('\n# (probe) modifier ORDER precedence (no subtraction)');
  const colors = ['#C21807', '#1F7A1F', '#2040C0']; // f1 base, f2, f3
  // modA (filament 3) then modB (filament 2) both cover the exact same top slab; B is appended AFTER A.
  const parts = [
    { name: 'base', mesh: box(0, 0, 40, 40, 20), extruder: 1, subtype: 'normal_part' as const, color: colors[0] },
    { name: 'modA f3', mesh: box(-1, -1, 42, 42, 4, 18), extruder: 3, subtype: 'modifier_part' as const, color: colors[2] },
    { name: 'modB f2', mesh: box(-1, -1, 42, 42, 4, 18), extruder: 2, subtype: 'modifier_part' as const, color: colors[1] },
  ];
  const objects: ExportObject[] = [{ name: 'probe', parts }];
  const { file } = await writeProject(objects, colors, 'probe');
  const { dir, returnCode, error } = runSlice(file, 'probe');
  check('probe: slice return_code 0', returnCode === 0, `(got ${returnCode}: ${error})`);
  const gc = `${dir}/plate_1.gcode`;
  if (existsSync(gc)) {
    const { moves } = parseGcodeMoves(gc);
    const zs = [...new Set(moves.map((m) => Math.round(m.z * 100) / 100))].sort((a, b) => a - b);
    const topZ = zs[zs.length - 1];
    const topTools = new Set(moves.filter((m) => Math.abs(m.z - topZ) < 0.12).map((m) => m.tool));
    const lastWins = topTools.size === 1 && topTools.has(1); // tool 1 = filament 2 = modB (appended last)
    const firstWins = topTools.size === 1 && topTools.has(2); // tool 2 = filament 3 = modA (appended first)
    console.log(`   PRECEDENCE: overlap top layer tools=${JSON.stringify([...topTools])} -> ` +
      (lastWins ? 'LAST modifier wins (order alone decides)'
        : firstWins ? 'FIRST modifier wins'
        : 'ambiguous/mixed'));
  }
}

async function main(): Promise<void> {
  await caseA();
  await caseB();
  await precedenceProbe();
  console.log(`\n==== ${passed} passed, ${failed} failed`);
  if (failed) { console.log('FAILURES:\n - ' + failures.join('\n - ')); process.exit(1); }
}

await main();
