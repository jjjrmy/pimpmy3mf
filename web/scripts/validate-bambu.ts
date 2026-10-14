// End-to-end validation for the Bambu 3MF writers (multi-object API).
//
// Builds plain 3MFs and Bambu projects from synthetic ExportObjects, the example meshes, and (when
// the pipeline lane's loadModel/objectMeshes and fixtures exist) the full pipeline path. Slices each
// project with the Bambu Studio CLI (no settings flags) and asserts return_code 0, the gcode
// filament_colour equals the requested colors in order, and every filament actually extrudes. The
// 200x200 case must surface the no-room-for-tower warning. Multi-object cases additionally assert the
// model_settings object/part structure. A few plates are rendered top-down for eyeballing; a
// ~1M-triangle mesh exercises the chunked writer.
//
//   bun scripts/validate-bambu.ts            # everything
//   bun scripts/validate-bambu.ts syn sweep  # only cases whose name contains "syn" or "sweep"
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { unzipSync } from 'fflate';
import { objectsFromResult, writeBambuProject, writePlain3mf, PRINTERS } from '../src/core/threemf';
import { loadTemplate, TEMPLATE_IDS } from '../src/core/bambu/template';
import type { ColorRegion, ExportObject, Mesh, Model, Part, Result } from '../src/core/types';

// Local-only paths. Fixtures live in scratch/ (git-ignored); override with env vars as needed:
//   BAMBU_STUDIO  Bambu Studio binary
//   PYTHON        a python with Pillow (for the G-code renders)
//   EXAMPLES      folder of example STL sets (REDURBAN-3colors/, wide-urban-4colors/, paint-example/)
const BAMBU = process.env.BAMBU_STUDIO ?? '/Applications/BambuStudio.app/Contents/MacOS/BambuStudio';
const ROOT = resolve(import.meta.dir, '..');
const OUT = `${ROOT}/scratch/bambu/out`;
const RENDER = `${ROOT}/scripts/render-gcode.py`;
const PY = process.env.PYTHON ?? 'python3';
const EXAMPLES = process.env.EXAMPLES ?? `${ROOT}/scratch/examples`;
const PALETTE = ['#C21807', '#1F7A1F', '#2040C0', '#E0B000', '#7A3FA0', '#17A2A2', '#E06A00', '#303030'];

const filter = process.argv.slice(2);
const want = (name: string) => filter.length === 0 || filter.some((f) => name.includes(f));

mkdirSync(OUT, { recursive: true });

// --------------------------------------------------------------------------------- mesh helpers

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

const obj = (name: string, parts: Part[]): ExportObject => ({ name, parts });

/** N adjacent strips spanning totalW x depth, each its own normal part / filament -> one object. */
function stripObject(name: string, n: number, totalW: number, depth: number, h: number): ExportObject {
  const w = totalW / n;
  const parts: Part[] = Array.from({ length: n }, (_, i) => {
    const c = PALETTE[i % PALETTE.length];
    return { name: c, mesh: box(i * w, 0, w, depth, h), extruder: i + 1, subtype: 'normal_part', color: c } as Part;
  });
  return obj(name, parts);
}

/** Welded binary-STL reader (independent of the meshio lane). */
function readBinaryStl(buf: Uint8Array): Mesh {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const n = dv.getUint32(80, true);
  const map = new Map<string, number>();
  const verts: number[] = [];
  const tris: number[] = [];
  let off = 84;
  for (let i = 0; i < n; i++) {
    off += 12; // skip normal
    const idx: number[] = [];
    for (let k = 0; k < 3; k++) {
      const x = dv.getFloat32(off, true);
      const y = dv.getFloat32(off + 4, true);
      const z = dv.getFloat32(off + 8, true);
      off += 12;
      const key = `${Math.round(x * 1e5)},${Math.round(y * 1e5)},${Math.round(z * 1e5)}`;
      let vi = map.get(key);
      if (vi === undefined) {
        vi = verts.length / 3;
        map.set(key, vi);
        verts.push(x, y, z);
      }
      idx.push(vi);
    }
    off += 2;
    if (idx[0] !== idx[1] && idx[1] !== idx[2] && idx[0] !== idx[2]) tris.push(idx[0], idx[1], idx[2]);
  }
  return { vertices: new Float32Array(verts), triangles: new Uint32Array(tris) };
}

const loadStl = (p: string): Mesh => readBinaryStl(new Uint8Array(readFileSync(p)));

function parseExampleName(file: string): { idx: number; hex: string } | null {
  const m = file.match(/-(\d+)-([0-9A-Fa-f]{6})(?:-modifier)?\.stl$/);
  return m ? { idx: parseInt(m[1], 10), hex: '#' + m[2].toUpperCase() } : null;
}

/** Example image dir -> one ExportObject of normal parts. */
function imageExampleObject(dir: string, name: string): { object: ExportObject; colors: string[] } {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.stl') && !f.includes('modifier'))
    .map((f) => ({ f, meta: parseExampleName(f) }))
    .filter((x) => x.meta)
    .sort((a, b) => a.meta!.idx - b.meta!.idx);
  const parts: Part[] = files.map(({ f, meta }) => ({
    name: meta!.hex, mesh: loadStl(`${dir}/${f}`), extruder: meta!.idx, subtype: 'normal_part', color: meta!.hex,
  }));
  return { object: obj(name, parts), colors: parts.map((p) => p.color) };
}

/** Example paint dir -> one ExportObject (box as normal + modifiers). */
function paintExampleObject(dir: string): { object: ExportObject; colors: string[] } {
  const mods = readdirSync(dir)
    .filter((f) => f.includes('modifier') && f.endsWith('.stl'))
    .map((f) => ({ f, meta: parseExampleName(f) }))
    .filter((x) => x.meta)
    .sort((a, b) => a.meta!.idx - b.meta!.idx);
  const modelColor = mods[0]!.meta!.hex;
  const parts: Part[] = [
    { name: 'box', mesh: loadStl(`${dir}/box.stl`), extruder: 1, subtype: 'normal_part', color: modelColor },
  ];
  for (const { f, meta } of mods) {
    if (meta!.idx < 2) continue;
    parts.push({ name: meta!.hex, mesh: loadStl(`${dir}/${f}`), extruder: meta!.idx, subtype: 'modifier_part', color: meta!.hex });
  }
  return { object: obj(`${EXAMPLES}`, parts), colors: [modelColor, ...parts.slice(1).map((p) => p.color)] };
}

function gridPlate(targetTris: number): Mesh {
  const g = Math.max(1, Math.round(Math.sqrt(targetTris / 2)));
  const nx = g + 1;
  const verts = new Float32Array(nx * nx * 3);
  const size = 100;
  for (let j = 0; j < nx; j++)
    for (let i = 0; i < nx; i++) {
      const o = (j * nx + i) * 3;
      verts[o] = (i / g) * size;
      verts[o + 1] = (j / g) * size;
      verts[o + 2] = 1;
    }
  const tris = new Uint32Array(g * g * 2 * 3);
  let t = 0;
  for (let j = 0; j < g; j++)
    for (let i = 0; i < g; i++) {
      const a = j * nx + i, b = a + 1, c = a + nx, d = c + 1;
      tris[t++] = a; tris[t++] = c; tris[t++] = b;
      tris[t++] = b; tris[t++] = c; tris[t++] = d;
    }
  return { vertices: verts, triangles: tris };
}

// --------------------------------------------------------------------------------- CLI + gcode

interface SliceResult {
  returnCode: number;
  error: string;
  colors: string[];
  extrudePerTool: Map<number, number>;
}

/** Parse one plate_N.gcode: declared filament colors + extrusion-move count per active tool. */
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

function sliceAndParse(file: string, tag: string): SliceResult {
  const { dir, returnCode, error } = runSlice(file, tag);
  const gcode = `${dir}/plate_1.gcode`;
  const parsed = existsSync(gcode) ? parseGcodeFile(gcode) : { colors: [], extrudePerTool: new Map<number, number>() };
  return { returnCode, error, ...parsed };
}

/** Slice all plates; return the overall rc plus per-plate parse of each plate_N.gcode. */
function sliceAllPlates(file: string, tag: string): { returnCode: number; error: string; plates: { colors: string[]; extrudePerTool: Map<number, number> }[] } {
  const { dir, returnCode, error } = runSlice(file, tag);
  const plates: { colors: string[]; extrudePerTool: Map<number, number> }[] = [];
  for (let p = 1; existsSync(`${dir}/plate_${p}.gcode`); p++) plates.push(parseGcodeFile(`${dir}/plate_${p}.gcode`));
  return { returnCode, error, plates };
}

/** Build-item transform strings from a project's 3D/3dmodel.model. */
function readBuildTransforms(bytes: Uint8Array): string[] {
  const xml = new TextDecoder().decode(unzipSync(bytes)['3D/3dmodel.model']);
  return [...xml.matchAll(/<item objectid="\d+"[^>]*transform="([^"]*)"/g)].map((m) => m[1]);
}

/** (#plates, total model_instances across plates) from a project's model_settings.config. */
function readPlateInfo(bytes: Uint8Array): { nPlates: number; instances: number } {
  const xml = new TextDecoder().decode(unzipSync(bytes)['Metadata/model_settings.config']);
  return { nPlates: (xml.match(/<plate>/g) ?? []).length, instances: (xml.match(/key="object_id"/g) ?? []).length };
}

function render(tag: string, frac = 0.45): void {
  const gcode = `${OUT}/${tag}-slice/plate_1.gcode`;
  if (!existsSync(gcode)) return;
  try {
    const log = execFileSync(PY, ['-I', RENDER, gcode, `${OUT}/${tag}-render.png`, '--frac', String(frac)], { encoding: 'utf8' });
    console.log('   ' + log.trim());
  } catch (e: any) {
    console.log('   render failed:', e.message);
  }
}

// ------------------------------------------------------------------------------------ assertions

let passed = 0, failed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) { passed++; console.log(`   ✓ ${name}`); }
  else { failed++; failures.push(`${name} ${detail}`); console.log(`   ✗ ${name} ${detail}`); }
}

/** Parse model_settings.config from a 3MF: [{ objectName, parts: [{name, extruder, subtype}] }]. */
function readModelSettings(bytes: Uint8Array): { name: string; parts: { name: string; extruder: string; subtype: string }[] }[] {
  const files = unzipSync(bytes);
  const xml = new TextDecoder().decode(files['Metadata/model_settings.config']);
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

async function sliceCase(name: string, objects: ExportObject[], colors: string[], render45 = false): Promise<SliceResult> {
  const { bytes, warnings } = await writeBambuProject(objects, { printerId: 'p2s-0.4', filamentColors: colors });
  const file = `${OUT}/${name}.3mf`;
  writeFileSync(file, bytes);
  const nParts = objects.reduce((s, o) => s + o.parts.length, 0);
  console.log(`   built ${(bytes.length / 1024).toFixed(0)} KB (${objects.length} obj, ${nParts} parts), warnings=${warnings.length ? warnings.join('|') : 'none'}`);
  const r = sliceAndParse(file, name);
  check(`${name}: return_code 0`, r.returnCode === 0, `(got ${r.returnCode}: ${r.error})`);
  check(`${name}: gcode filament_colour matches`, JSON.stringify(r.colors) === JSON.stringify(colors.map((c) => c.toUpperCase())), `(got ${JSON.stringify(r.colors)})`);
  const expectTools = new Set(objects.flatMap((o) => o.parts.map((p) => p.extruder - 1)));
  check(`${name}: every filament extrudes`, [...expectTools].every((t) => (r.extrudePerTool.get(t) ?? 0) > 0), `(moves/tool: ${JSON.stringify([...r.extrudePerTool.entries()])})`);
  if (render45) render(name);
  return r;
}

// ------------------------------------------------------------------------------------------- run

async function main() {
  // ---- objectsFromResult unit checks (no slicing)
  if (want('objectsFromResult')) {
    console.log('\n# objectsFromResult');
    const mk = (): Mesh => box(0, 0, 10, 10, 1);
    const region = (index: number, hex: string, objectMeshes: (Mesh | null)[] | null = null): ColorRegion => ({
      index, rgb: [0, 0, 0], hex, coverage: 1, rings: [], mesh: mk(), objectMeshes,
    });
    const base = { frame: { x0: 0, y0: 0, x1: 10, y1: 10 }, tile: { w: 10, h: 10, repeat: false }, axis: 'z' as const,
      stats: { imageW: 1, imageH: 1, gridW: 1, gridH: 1, pitch: 1, ms: 0 }, warnings: [] };

    const imgRes: Result = { ...base, mode: 'image', regions: [region(0, '#111111'), region(1, '#222222')], model: null };
    const io = objectsFromResult(imgRes, ['#111111', '#222222'], 'pic');
    check('image: one object, 2 normal parts', io.length === 1 && io[0].parts.length === 2 && io[0].parts.every((p) => p.subtype === 'normal_part'));
    check('image: name has color count', io[0].name === 'pic (2 colors)');
    check('image: extruders 1,2 + color override', io[0].parts[0].extruder === 1 && io[0].parts[1].color === '#222222');

    // paint, single model object with 2 parts + 2 modifier regions
    const model1: Model = { objects: [{ name: 'widget', parts: [{ name: 'bodyA', mesh: mk() }, { name: 'bodyB', mesh: mk() }] }] };
    const pRes: Result = { ...base, mode: 'paint',
      regions: [region(0, '#AAAAAA', [mk()]), region(1, '#BBBBBB', [mk()]), region(2, '#CCCCCC', [mk()])], model: model1 };
    const po = objectsFromResult(pRes, ['#AAAAAA', '#BBBBBB', '#CCCCCC'], 'm');
    check('paint1: one object', po.length === 1 && po[0].name === 'widget');
    check('paint1: 2 normal (ext1) + 2 modifiers (ext2,3)',
      po[0].parts.filter((p) => p.subtype === 'normal_part').length === 2 &&
      po[0].parts.filter((p) => p.subtype === 'modifier_part').length === 2 &&
      po[0].parts[0].extruder === 1 && po[0].parts[2].extruder === 2 && po[0].parts[3].extruder === 3);

    // paint, 2 model objects; region 1 only touches object 0, region 2 only object 1
    const model2: Model = { objects: [{ name: 'left', parts: [{ name: 'L', mesh: mk() }] }, { name: 'right', parts: [{ name: 'R', mesh: mk() }] }] };
    const p2: Result = { ...base, mode: 'paint',
      regions: [region(0, '#AAAAAA', [mk(), mk()]), region(1, '#BBBBBB', [mk(), null]), region(2, '#CCCCCC', [null, mk()])], model: model2 };
    const po2 = objectsFromResult(p2, ['#AAAAAA', '#BBBBBB', '#CCCCCC'], 'm');
    check('paint2: two objects named left,right', po2.length === 2 && po2[0].name === 'left' && po2[1].name === 'right');
    check('paint2: left has its modifier (ext2) only', po2[0].parts.length === 2 && po2[0].parts[1].extruder === 2);
    check('paint2: right has its modifier (ext3) only', po2[1].parts.length === 2 && po2[1].parts[1].extruder === 3);
  }

  // ---- plain 3mf sanity (multi-object structure)
  if (want('plain')) {
    console.log('\n# plain 3mf (2 objects)');
    const objects = [stripObject('A', 2, 40, 40, 1), obj('B', [{ name: '#2040C0', mesh: box(60, 0, 20, 40, 1), extruder: 3, subtype: 'normal_part', color: '#2040C0' }])];
    const bytes = writePlain3mf(objects);
    writeFileSync(`${OUT}/plain.3mf`, bytes);
    const ms = readModelSettings(bytes);
    check('plain: 2 objects in model_settings', ms.length === 2 && ms[0].name === 'A' && ms[1].name === 'B');
    check('plain: object A has 2 parts, B has 1', ms[0].parts.length === 2 && ms[1].parts.length === 1);
    const r = sliceAndParse(`${OUT}/plain.3mf`, 'plain');
    check('plain: slices (return_code 0)', r.returnCode === 0, `(got ${r.returnCode}: ${r.error})`);
  }

  // ---- synthetic image N = 1..8
  for (let n = 1; n <= 8; n++) {
    if (!want(`syn-${n}`)) continue;
    console.log(`\n# syn-${n}`);
    await sliceCase(`syn-${n}`, [stripObject(`syn (${n} colors)`, n, Math.min(16 * n, 80), 40, 1)], PALETTE.slice(0, n), n === 4);
  }

  // ---- 200x200 tower-warning case
  if (want('big200')) {
    console.log('\n# big200 (200x200, expect tower warning)');
    const colors = PALETTE.slice(0, 3);
    const { warnings, bytes } = await writeBambuProject([stripObject('big', 3, 200, 200, 1)], { printerId: 'p2s-0.4', filamentColors: colors });
    writeFileSync(`${OUT}/big200.3mf`, bytes);
    check('big200: emits tower warning', warnings.length > 0, `(warnings: ${JSON.stringify(warnings)})`);
  }

  // ---- real example images
  if (want('REDURBAN')) {
    const { object, colors } = imageExampleObject(`${EXAMPLES}/REDURBAN-3colors`, 'REDURBAN (3 colors)');
    await sliceCase('REDURBAN', [object], colors, true);
  }
  if (want('wide-urban')) {
    const { object, colors } = imageExampleObject(`${EXAMPLES}/wide-urban-4colors`, 'wide-urban (4 colors)');
    await sliceCase('wide-urban', [object], colors, true);
  }

  // ---- paint example (single model object)
  if (want('paint-example')) {
    const { object, colors } = paintExampleObject(`${EXAMPLES}/paint-example`);
    await sliceCase('paint-example', [obj('box', object.parts)], colors, true);
  }

  // ---- step 1: synthetic multi-object paint cases
  // (a) ONE object with 3 normal parts + 2 modifiers overlapping them
  if (want('mo-single')) {
    console.log('\n# mo-single (1 object: 3 normal + 2 modifiers)');
    const parts: Part[] = [
      ...stripObject('base', 3, 60, 40, 2).parts, // 3 normals, ext 1..3
      { name: PALETTE[3], mesh: box(5, 5, 20, 12, 4), extruder: 4, subtype: 'modifier_part', color: PALETTE[3] },
      { name: PALETTE[4], mesh: box(35, 20, 20, 15, 4), extruder: 5, subtype: 'modifier_part', color: PALETTE[4] },
    ];
    const r = await sliceCase('mo-single', [obj('assembly', parts)], PALETTE.slice(0, 5), true);
    const ms = readModelSettings(readFileSync(`${OUT}/mo-single.3mf`));
    check('mo-single: 1 object, 5 parts (3 normal + 2 modifier)',
      ms.length === 1 && ms[0].parts.length === 5 &&
      ms[0].parts.filter((p) => p.subtype === 'modifier_part').length === 2, `(${JSON.stringify(ms.map((o) => o.parts.length))})`);
    void r;
  }

  // (b) 3 objects at different positions, each a normal box + its own modifier
  if (want('mo-multi')) {
    console.log('\n# mo-multi (3 objects, each normal + modifier)');
    const objects: ExportObject[] = [0, 1, 2].map((k) => obj(`part${k}`, [
      { name: '#866B6B', mesh: box(k * 40, 0, 25, 25, 5), extruder: 1, subtype: 'normal_part', color: '#866B6B' },
      { name: PALETTE[k + 1], mesh: box(k * 40 + 6, 6, 13, 13, 7, -1), extruder: 2, subtype: 'modifier_part', color: PALETTE[k + 1] },
    ]));
    // colors: filament1 = model base; filament2 = one modifier color (all modifiers share ext2 here)
    const r = await sliceCase('mo-multi', objects, ['#866B6B', '#1F7A1F'], true);
    const ms = readModelSettings(readFileSync(`${OUT}/mo-multi.3mf`));
    check('mo-multi: 3 objects each with 2 parts', ms.length === 3 && ms.every((o) => o.parts.length === 2), `(${JSON.stringify(ms.map((o) => o.parts.length))})`);
    check('mo-multi: object names preserved', ms[0].name === 'part0' && ms[2].name === 'part2');
    void r;
  }

  // ---- combo sweep: 4-color image + 2-object paint for EVERY captured printer x nozzle template.
  // Drives which combos belong in PRINTERS. Prints a pass/fail table at the end.
  if (want('sweep')) {
    const ids = (filter.length > 1 ? TEMPLATE_IDS.filter((id) => filter.some((f) => id.includes(f) && f !== 'sweep')) : TEMPLATE_IDS);
    const target = ids.length ? ids : TEMPLATE_IDS;
    const table: { id: string; printer: string; nozzle: string; image: boolean; paint: boolean; note: string }[] = [];
    for (const id of [...target].sort()) {
      const tmpl = await loadTemplate(id);
      console.log(`\n# sweep ${id} (${tmpl.label}${tmpl.dual ? ', dual' : ''})`);
      const before = failed;
      const imgColors = PALETTE.slice(0, 4);
      const img = await writeBambuProject([stripObject('img (4 colors)', 4, 80, 40, 1)], { printerId: id, filamentColors: imgColors });
      writeFileSync(`${OUT}/sweep-${id}-img.3mf`, img.bytes);
      const ri = sliceAndParse(`${OUT}/sweep-${id}-img.3mf`, `sweep-${id}-img`);
      const imgOk = ri.returnCode === 0 && JSON.stringify(ri.colors) === JSON.stringify(imgColors.map((c) => c.toUpperCase())) &&
        [0, 1, 2, 3].every((t) => (ri.extrudePerTool.get(t) ?? 0) > 0);
      check(`${id} image: rc0 + colors + extrude`, imgOk, `(rc ${ri.returnCode}, colors ${JSON.stringify(ri.colors)}, tools ${JSON.stringify([...ri.extrudePerTool.keys()])})`);

      const objects: ExportObject[] = [0, 1].map((k) => obj(`o${k}`, [
        { name: '#866B6B', mesh: box(k * 30, 0, 20, 20, 4), extruder: 1, subtype: 'normal_part', color: '#866B6B' },
        { name: '#3C3B3B', mesh: box(k * 30 + 5, 5, 10, 10, 6, -1), extruder: 2, subtype: 'modifier_part', color: '#3C3B3B' },
      ]));
      const paint = await writeBambuProject(objects, { printerId: id, filamentColors: ['#866B6B', '#3C3B3B'] });
      writeFileSync(`${OUT}/sweep-${id}-paint.3mf`, paint.bytes);
      const rp = sliceAndParse(`${OUT}/sweep-${id}-paint.3mf`, `sweep-${id}-paint`);
      const paintOk = rp.returnCode === 0 && (rp.extrudePerTool.get(0) ?? 0) > 0 && (rp.extrudePerTool.get(1) ?? 0) > 0;
      check(`${id} paint(2 obj): rc0 + both extrude`, paintOk, `(rc ${rp.returnCode}, tools ${JSON.stringify([...rp.extrudePerTool.keys()])})`);

      const note = imgOk && paintOk ? 'ok' : `img rc ${ri.returnCode}${ri.error ? ' ' + ri.error.slice(0, 40) : ''}; paint rc ${rp.returnCode}`;
      table.push({ id, printer: tmpl.printer, nozzle: tmpl.nozzle, image: imgOk, paint: paintOk, note });
      void before;
    }
    console.log('\n==== combo table (printer x nozzle) ====');
    for (const row of table) {
      console.log(`  ${row.id.padEnd(12)} ${(row.printer + ' ' + row.nozzle).padEnd(28)} image=${row.image ? 'PASS' : 'FAIL'} paint=${row.paint ? 'PASS' : 'FAIL'}  ${row.image && row.paint ? '' : '<< ' + row.note}`);
    }
    const passing = new Set(table.filter((r) => r.image && r.paint).map((r) => r.id));
    console.log(`\n  PASSING combos (${passing.size}/${table.length}): ${[...passing].join(', ')}`);
    // every id listed in PRINTERS must have passed (only validated combos ship)
    const swept = new Set(table.map((r) => r.id));
    for (const pr of PRINTERS) {
      if (swept.has(pr.id)) check(`PRINTERS entry ${pr.id} validated`, passing.has(pr.id));
    }
  }

  // ---- step 2: full pipeline path (guarded on loadModel + objectMeshes + fixtures)
  if (want('pipeline')) await pipelineCases();

  // ---- multi-plate layout (keep vs re-arrange onto Bambu's plate grid)
  if (want('multiplate')) await multiplateCases();

  // ---- large mesh writer perf (build only)
  if (want('perf')) {
    console.log('\n# perf (~1M triangles, build only)');
    const mesh = gridPlate(1_000_000);
    const nt = mesh.triangles.length / 3;
    const object = obj('big', [{ name: '#808080', mesh, extruder: 1, subtype: 'normal_part', color: '#808080' }]);
    const t0 = performance.now();
    const plain = writePlain3mf([object]);
    const t1 = performance.now();
    const { bytes } = await writeBambuProject([object], { printerId: 'p2s-0.4', filamentColors: ['#808080'] });
    const t2 = performance.now();
    console.log(`   ${nt.toLocaleString()} tris: plain ${(plain.length / 1e6).toFixed(1)}MB in ${(t1 - t0).toFixed(0)}ms; project ${(bytes.length / 1e6).toFixed(1)}MB in ${(t2 - t1).toFixed(0)}ms`);
    check('perf: ~1M triangles', nt >= 900_000);
    check('perf: both archives non-trivial', plain.length > 1_000_000 && bytes.length > 1_000_000);
  }

  console.log(`\n==== ${passed} passed, ${failed} failed`);
  if (failed) { console.log('FAILURES:\n - ' + failures.join('\n - ')); process.exit(1); }
}

async function pipelineCases(): Promise<void> {
  console.log('\n# pipeline (full path)');
  let meshio: any, pipelineMod: any;
  try {
    meshio = await import('../src/core/meshio');
    pipelineMod = await import('../src/core/pipeline');
  } catch (e: any) {
    console.log('   SKIP: pipeline modules not importable yet:', e.message);
    return;
  }
  if (typeof meshio.loadModel !== 'function') {
    console.log('   SKIP: meshio.loadModel not implemented yet');
    return;
  }
  const rgbaPath = `${ROOT}/scratch/rgba/REDURBAN.rgba`;
  if (!existsSync(rgbaPath)) { console.log('   SKIP: REDURBAN.rgba fixture missing'); return; }
  // .rgba layout per headless.ts readRgba: "RGBA" magic, Uint32LE width@4, height@8, then RGBA bytes@12
  const buf = readFileSync(rgbaPath);
  const width = buf.readUInt32LE(4), height = buf.readUInt32LE(8);
  const data = new Uint8ClampedArray(width * height * 4);
  data.set(buf.subarray(12, 12 + width * height * 4));
  const image = { width, height, data };

  const fixtures = ['multipart.3mf', 'multiobject.3mf', 'multipart-bambu.3mf', 'multiobject-bambu.3mf'] // yeti handled in multiplateCases
    .map((f) => `${ROOT}/scratch/inputs/${f}`)
    .filter((p) => existsSync(p));
  if (fixtures.length === 0) { console.log('   SKIP: no model fixtures yet'); return; }

  const { createPipeline } = pipelineMod;
  const { DEFAULT_PARAMS } = await import('../src/core/types');
  for (const fx of fixtures) {
    const name = fx.split('/').pop()!.replace('.3mf', '');
    let model: Model;
    try {
      model = meshio.loadModel(new Uint8Array(readFileSync(fx)), fx);
    } catch (e: any) { check(`pipeline ${name}: loadModel`, false, e.message); continue; }
    const pipe = createPipeline();
    let result: Result;
    try {
      result = await pipe.run(image as any, model, { ...DEFAULT_PARAMS, colors: 3 });
    } catch (e: any) { check(`pipeline ${name}: run`, false, e.message); pipe.dispose(); continue; }
    pipe.dispose();
    const colors = result.regions.map((r) => r.hex);
    const objects = objectsFromResult(result, colors, name);
    const plain = writePlain3mf(objects);
    const ms = readModelSettings(plain);
    check(`pipeline ${name}: object count = model objects (${model.objects.length})`, ms.length === model.objects.length, `(got ${ms.length})`);
    const r = await sliceCase(`pipeline-${name}`, objects, colors, true);
    void r;
  }
}

async function multiplateCases(): Promise<void> {
  console.log('\n# multiplate');
  const colors3 = ['#C21807', '#1F7A1F', '#2040C0'];

  // (1) stacked assembly: a box on the bed + a lid floating 10 mm above it -> must re-arrange.
  {
    const objects: ExportObject[] = [
      obj('box', [{ name: colors3[0], mesh: box(0, 0, 40, 40, 10), extruder: 1, subtype: 'normal_part', color: colors3[0] }]),
      obj('lid', [{ name: colors3[1], mesh: box(0, 0, 40, 40, 3, 20), extruder: 2, subtype: 'normal_part', color: colors3[1] }]),
    ];
    const { bytes, warnings } = await writeBambuProject(objects, { printerId: 'p2s-0.4', filamentColors: colors3.slice(0, 2) });
    writeFileSync(`${OUT}/mp-stacked.3mf`, bytes);
    check('stacked: re-arranged (warning)', warnings.some((w) => w.includes('re-arranged')), `(${JSON.stringify(warnings)})`);
    const xf = readBuildTransforms(bytes);
    check('stacked: objects not stacked (distinct transforms)', xf.length === 2 && xf[0] !== xf[1]);
    const r = sliceAllPlates(`${OUT}/mp-stacked.3mf`, 'mp-stacked');
    check('stacked: slices rc0', r.returnCode === 0, `(got ${r.returnCode}: ${r.error})`);
    check('stacked: every plate ok', r.plates.length >= 1 && r.plates.every((p) => p.extrudePerTool.size > 0), `(plates ${r.plates.length})`);
  }

  // pipeline-dependent cases
  let meshio: any, pipelineMod: any, typesMod: any;
  try {
    meshio = await import('../src/core/meshio');
    pipelineMod = await import('../src/core/pipeline');
    typesMod = await import('../src/core/types');
  } catch (e: any) { console.log('   SKIP pipeline cases:', e.message); return; }
  if (typeof meshio.loadModel !== 'function') { console.log('   SKIP: loadModel not ready'); return; }
  const rgbaPath = `${ROOT}/scratch/rgba/REDURBAN.rgba`;
  if (!existsSync(rgbaPath)) { console.log('   SKIP: REDURBAN.rgba missing'); return; }
  const buf = readFileSync(rgbaPath);
  const width = buf.readUInt32LE(4), height = buf.readUInt32LE(8);
  const data = new Uint8ClampedArray(width * height * 4);
  data.set(buf.subarray(12, 12 + width * height * 4));
  const image = { width, height, data };

  const run = async (fixture: string) => {
    const model = meshio.loadModel(new Uint8Array(readFileSync(fixture)), fixture);
    const pipe = pipelineMod.createPipeline();
    const result = await pipe.run(image, model, { ...typesMod.DEFAULT_PARAMS, colors: 3 });
    pipe.dispose();
    return { model, result };
  };

  // (2) multiobject.3mf: side by side, fits -> KEEP layout (single shared translation).
  const moFix = `${ROOT}/scratch/inputs/multiobject.3mf`;
  if (existsSync(moFix)) {
    const { model, result } = await run(moFix);
    const colors = result.regions.map((r: ColorRegion) => r.hex);
    const objects = objectsFromResult(result, colors, 'multiobject');
    const { bytes, warnings } = await writeBambuProject(objects, { printerId: 'p2s-0.4', filamentColors: colors });
    writeFileSync(`${OUT}/mp-multiobject.3mf`, bytes);
    const xf = readBuildTransforms(bytes);
    const info = readPlateInfo(bytes);
    check('multiobject: kept (no re-arrange warning)', !warnings.some((w) => w.includes('re-arranged')), `(${JSON.stringify(warnings)})`);
    check('multiobject: single shared translation', xf.length === model.objects.length && new Set(xf).size === 1, `(${xf.length} items, ${new Set(xf).size} distinct)`);
    check('multiobject: one plate', info.nPlates === 1, `(${info.nPlates})`);
    const r = sliceAllPlates(`${OUT}/mp-multiobject.3mf`, 'mp-multiobject');
    check('multiobject: slices rc0', r.returnCode === 0, `(got ${r.returnCode}: ${r.error})`);
  } else console.log('   SKIP multiobject.3mf (missing)');

  // (3) yeti.3mf: 7 real plates -> re-arranged; slice EVERY plate; 7 objects total across plates.
  const yetiFix = `${ROOT}/scratch/inputs/yeti.3mf`;
  if (existsSync(yetiFix)) {
    const { model, result } = await run(yetiFix);
    const colors = result.regions.map((r: ColorRegion) => r.hex);
    const objects = objectsFromResult(result, colors, 'yeti');
    const { bytes, warnings } = await writeBambuProject(objects, { printerId: 'p2s-0.4', filamentColors: colors });
    writeFileSync(`${OUT}/mp-yeti.3mf`, bytes);
    const info = readPlateInfo(bytes);
    console.log(`   yeti: ${model.objects.length} objects -> ${info.nPlates} plate(s), ${info.instances} instances; warnings=${warnings.join('|') || 'none'}`);
    check('yeti: object count = 7', model.objects.length === 7, `(${model.objects.length})`);
    check('yeti: re-arranged', warnings.some((w) => w.includes('re-arranged')));
    check('yeti: total instances across plates = 7', info.instances === 7, `(${info.instances})`);
    const r = sliceAllPlates(`${OUT}/mp-yeti.3mf`, 'mp-yeti');
    check('yeti: slices rc0 (all plates)', r.returnCode === 0, `(got ${r.returnCode}: ${r.error})`);
    const wantColors = colors.map((c: string) => c.toUpperCase());
    // every plate declares the project colors and prints something
    const perPlateOk = r.plates.length >= 1 && r.plates.every((p) =>
      JSON.stringify(p.colors) === JSON.stringify(wantColors) && p.extrudePerTool.size >= 1);
    check('yeti: each plate declares colors + prints', perPlateOk, `(${r.plates.length} plates)`);
    // across all plates, every filament is used (a single painted object may not contain all colors)
    const union = new Set<number>();
    for (const p of r.plates) for (const t of p.extrudePerTool.keys()) union.add(t);
    check('yeti: all 3 filaments extrude across plates', [0, 1, 2].every((t) => union.has(t)), `(used ${JSON.stringify([...union].sort())})`);
  } else console.log('   SKIP yeti.3mf (missing)');
}

await main();
