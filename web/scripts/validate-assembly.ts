// End-to-end validation for ASSEMBLE MODE: two STL files composed into one assembly, mated face to face, painted
// with a 3-color camo on the assembled pose, exported as Bambu projects (X1C 0.4) with Per-part ON and OFF and
// sliced with the Bambu Studio CLI.
//
// Checks: the mate puts box B's bottom face on box A's top face (coplanar, opposed normals); the pipeline paints the
// assembly (3 colors, a painted face on part 2 by its assembly index); both projects slice (result.json return_code
// 0); model_settings.config has 2 objects each with its own modifiers (Per-part ON) or 1 object with 2 parts (OFF).
//
//   bun scripts/validate-assembly.ts
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { unzipSync } from 'fflate';
import { applyRigid, composeAssembly, composeRigid, faceFeature, placeBeside, solveFaceMate, type AssemblyItem } from '../src/core/assembly';
import { buildAdjacency, planarRegion, triNormal } from '../src/core/faces';
import { loadModel, writeStl } from '../src/core/meshio';
import { createPipeline } from '../src/core/pipeline';
import { objectsFromResult, writeBambuProject } from '../src/core/threemf';
import { DEFAULT_PARAMS } from '../src/core/types';
import type { Mesh, Model, PaintedFace, Params, RasterImage, RGB, Vec3 } from '../src/core/types';

const BAMBU = process.env.BAMBU_STUDIO ?? '/Applications/BambuStudio.app/Contents/MacOS/BambuStudio';
const ROOT = resolve(import.meta.dir, '..');
const OUT = `${ROOT}/scratch/assembly`;
const PRINTER = 'x1c-0.4';
const PLATE = 'Textured PEI Plate';
mkdirSync(OUT, { recursive: true });

let passed = 0, failed = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) passed++;
  else failed++;
  console.log(`   ${ok ? '✓' : '✗'} ${name}${detail ? ` ${detail}` : ''}`);
}
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Axis-aligned box, outward CCW. */
function box(ox: number, oy: number, oz: number, w: number, d: number, h: number): Mesh {
  const v = [ox, oy, oz, ox + w, oy, oz, ox + w, oy + d, oz, ox, oy + d, oz, ox, oy, oz + h, ox + w, oy, oz + h, ox + w, oy + d, oz + h, ox, oy + d, oz + h];
  const t = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7];
  return { vertices: new Float32Array(v), triangles: new Uint32Array(t) };
}
/** Rotate about Z by deg around the origin (so the second file arrives turned and off-axis). */
function rotZ(m: Mesh, deg: number): Mesh {
  const a = (deg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  const v = new Float32Array(m.vertices.length);
  for (let i = 0; i < v.length; i += 3) {
    const x = m.vertices[i], y = m.vertices[i + 1];
    v[i] = c * x - s * y; v[i + 1] = s * x + c * y; v[i + 2] = m.vertices[i + 2];
  }
  return { vertices: v, triangles: m.triangles };
}
function faceAlong(mesh: Mesh, dir: Vec3): { triangles: number[]; area: number } {
  let best = -1, bestDot = -Infinity;
  for (let tri = 0; tri < mesh.triangles.length / 3; tri++) {
    const { n, area } = triNormal(mesh, tri);
    if (area && dot(n, dir) > bestDot) { bestDot = dot(n, dir); best = tri; }
  }
  const r = planarRegion(mesh, buildAdjacency(mesh), best)!;
  return { triangles: r.triangles, area: r.area };
}
function zRange(mesh: Mesh): [number, number] {
  let lo = Infinity, hi = -Infinity;
  for (let i = 2; i < mesh.vertices.length; i += 3) { lo = Math.min(lo, mesh.vertices[i]); hi = Math.max(hi, mesh.vertices[i]); }
  return [lo, hi];
}

/** 3-color diagonal stripes so every filament lands on the assembly. */
const PALETTE: RGB[] = [[194, 24, 7], [31, 122, 31], [32, 64, 192]];
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

function runSlice(file: string, tag: string): { returnCode: number; error: string } {
  const dir = `${OUT}/${tag}-slice`;
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  try {
    execFileSync(BAMBU, ['--slice', '0', '--outputdir', dir, file], { encoding: 'utf8', timeout: 300000, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch {
    /* a non-zero exit still writes result.json */
  }
  if (!existsSync(`${dir}/result.json`)) return { returnCode: -999, error: 'no result.json' };
  const j = JSON.parse(readFileSync(`${dir}/result.json`, 'utf8'));
  return { returnCode: j.return_code, error: j.error_string ?? '' };
}

/** model_settings.config -> [{ name, parts: [{ name, subtype }] }]. */
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

type Box = { min: Vec3; max: Vec3 };
function meshBox(v: ArrayLike<number>, off: Vec3 = [0, 0, 0]): Box {
  const min: Vec3 = [Infinity, Infinity, Infinity], max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < v.length; i += 3)
    for (let a = 0; a < 3; a++) { min[a] = Math.min(min[a], v[i + a] + off[a]); max[a] = Math.max(max[a], v[i + a] + off[a]); }
  return { min, max };
}

/**
 * Per exported object: its parts' bboxes on the plate (component meshes + build-item translation), in part order.
 * The writer uses identity component transforms and translation-only build items.
 */
function exportedPartBoxes(bytes: Uint8Array): { boxes: Box[]; translation: Vec3 }[] {
  const z = unzipSync(bytes);
  const root = new TextDecoder().decode(z['3D/3dmodel.model']);
  const sub = new TextDecoder().decode(z['3D/Objects/object_1.model']);
  const meshes = new Map<string, number[]>();
  for (const m of sub.matchAll(/<object id="(\d+)"[\s\S]*?<\/object>/g)) {
    const v: number[] = [];
    for (const vm of m[0].matchAll(/<vertex x="([^"]+)" y="([^"]+)" z="([^"]+)"/g)) v.push(+vm[1], +vm[2], +vm[3]);
    meshes.set(m[1], v);
  }
  const comps = new Map<string, string[]>();
  for (const m of root.matchAll(/<object id="(\d+)"[^>]*>([\s\S]*?)<\/object>/g))
    comps.set(m[1], [...m[2].matchAll(/objectid="(\d+)"/g)].map((c) => c[1]));
  return [...root.matchAll(/<item objectid="(\d+)"[^>]*transform="([^"]*)"/g)].map((it) => {
    const T = it[2].split(/\s+/).map(Number);
    const translation: Vec3 = [T[9], T[10], T[11]];
    return { translation, boxes: (comps.get(it[1]) ?? []).map((id) => meshBox(meshes.get(id) ?? [], translation)) };
  });
}

async function main() {
  // ---- two STL files, as the browser would get them
  console.log('\n# files');
  const aPath = `${OUT}/box-a.stl`, bPath = `${OUT}/box-b.stl`;
  writeFileSync(aPath, writeStl(box(0, 0, 0, 40, 30, 12)));
  writeFileSync(bPath, writeStl(rotZ(box(-10, -8, 5, 24, 16, 14), 35)));
  const load = (p: string): Model => loadModel(new Uint8Array(readFileSync(p)), p);

  // ---- worker flow: add A, add B beside it
  const items: AssemblyItem[] = [];
  for (const [id, p, name] of [['a', aPath, 'box-a.stl'], ['b', bPath, 'box-b.stl']] as const) {
    const model = load(p);
    items.push({ id, fileName: name, model, transform: placeBeside(items, model) });
  }
  let composed = composeAssembly(items);
  const placedB = composed.model.objects[0].parts[1].mesh;
  check('add: B placed with min z on the assembly min z', Math.abs(zRange(placedB)[0]) < 1e-4, `(min z ${zRange(placedB)[0].toFixed(4)})`);
  check('compose: 1 object "Assembly" with 2 parts', composed.model.objects.length === 1 && composed.model.objects[0].name === 'Assembly' && composed.model.objects[0].parts.length === 2);

  // ---- mate: B's bottom face onto A's top face, 0 gap, seated
  console.log('\n# mate');
  const meshA = composed.model.objects[0].parts[0].mesh, meshB = composed.model.objects[0].parts[1].mesh;
  const mFace = faceAlong(meshB, [0, 0, -1]), tFace = faceAlong(meshA, [0, 0, 1]);
  const mf = faceFeature(meshB, mFace.triangles)!, tf = faceFeature(meshA, tFace.triangles)!;
  const M = solveFaceMate({
    movingNormal: mf.normal, movingCentroid: mf.centroid, movingRegionPts: mf.points,
    targetNormal: tf.normal, targetCentroid: tf.centroid, targetRegionPts: tf.points,
    offset: 0, flip: false, angle: 0, seat: true,
  })!;
  items[1] = { ...items[1], transform: composeRigid(M, items[1].transform) };
  composed = composeAssembly(items);
  const matedB = composed.model.objects[0].parts[1].mesh;
  const [bz0] = zRange(matedB), [, az1] = zRange(composed.model.objects[0].parts[0].mesh);
  check('mate: B bottom on A top (coplanar)', Math.abs(bz0 - az1) < 1e-3, `(B min z ${bz0.toFixed(4)}, A max z ${az1.toFixed(4)})`);
  const n = applyRigid({ R: M.R, t: [0, 0, 0] }, mf.normal);
  check('mate: normals opposed', Math.abs(dot(n, tf.normal) + 1) < 1e-6);
  const c = applyRigid(M, mf.centroid);
  check('mate: centroid on centroid', Math.hypot(c[0] - tf.centroid[0], c[1] - tf.centroid[1]) < 1e-3);
  writeFileSync(`${OUT}/assembled.stl`, writeStl({
    vertices: new Float32Array([...meshA.vertices, ...matedB.vertices]),
    triangles: new Uint32Array([...meshA.triangles, ...[...matedB.triangles].map((i) => i + meshA.vertices.length / 3)]),
  }));

  // ---- pipeline + export, Per-part ON and OFF
  const top = faceAlong(matedB, [0, 0, 1]);
  const face: PaintedFace = { id: 'b-top', objectIndex: 0, partIndex: 1, triangles: top.triangles, color: 2, area: top.area };
  const image = stripeImage();
  for (const perPart of [true, false]) {
    const tag = perPart ? 'perpart-on' : 'perpart-off';
    console.log(`\n# pipeline + export (${tag})`);
    const params: Params = { ...DEFAULT_PARAMS, palette: PALETTE, axis: 'y', perPart, paintedFaces: [face] };
    const pipe = createPipeline();
    const result = await pipe.run(image, composed.model, params);
    pipe.dispose();
    check(`${tag}: 3 colors`, result.regions.length === 3, `(got ${result.regions.length})`);
    check(`${tag}: painted face on part 2 became a skin`, result.faceSkins.length === 1 && result.faceSkins[0].partIndex === 1);
    const hexes = result.regions.map((r) => r.hex);
    const objects = objectsFromResult(result, hexes, 'stripes');
    const { bytes, warnings } = await writeBambuProject(objects, { printerId: PRINTER, filamentColors: hexes, plate: PLATE });
    const file = `${OUT}/assembly-${tag}.3mf`;
    writeFileSync(file, bytes);
    if (warnings.length) console.log(`   warnings: ${warnings.join(' | ')}`);

    if (perPart) {
      // the re-arrange moves whole objects: every modifier must keep its place relative to its own part
      const before = objects.map((o) => o.parts.map((p) => meshBox(p.mesh.vertices)));
      const after = exportedPartBoxes(bytes);
      let worst = 0;
      let moved = false;
      before.forEach((parts, i) => {
        const got = after[i]?.boxes ?? [];
        if (got.length !== parts.length) worst = Infinity;
        parts.forEach((b, k) => {
          if (!got[k]) return;
          for (let a = 0; a < 3; a++) {
            // offset of each part / modifier from the object's first (printed) part, before vs after
            const rel0 = b.min[a] - parts[0].min[a], rel1 = got[k].min[a] - got[0].min[a];
            const size0 = b.max[a] - b.min[a], size1 = got[k].max[a] - got[k].min[a];
            worst = Math.max(worst, Math.abs(rel0 - rel1), Math.abs(size0 - size1));
            if (Math.abs(got[0].min[a] - parts[0].min[a]) > 1e-3) moved = true;
          }
        });
      });
      console.log(`   objects moved by the re-arrange: ${moved ? 'yes' : 'no'}; worst modifier drift vs its part: ${worst.toExponential(2)} mm`);
      check('per-part ON: each object\'s modifiers keep their place on its own part after the re-arrange', worst < 1e-3, `(worst ${worst.toExponential(2)} mm)`);
    }

    const settings = readModelSettings(bytes);
    const summary = settings.map((o) => `${o.name}[${o.parts.map((p) => p.subtype).join(',')}]`).join(' ');
    if (perPart) {
      const ok = settings.length === 2 && settings.every((o) => o.parts.filter((p) => p.subtype === 'normal_part').length === 1 && o.parts.some((p) => p.subtype === 'modifier_part'));
      check('per-part ON: 2 objects, each 1 part + its own modifiers', ok, `(${summary})`);
    } else {
      const ok = settings.length === 1 && settings[0].parts.filter((p) => p.subtype === 'normal_part').length === 2 && settings[0].parts.some((p) => p.subtype === 'modifier_part');
      check('per-part OFF: 1 object with 2 parts (+ modifiers)', ok, `(${summary})`);
    }

    const sliced = runSlice(file, tag);
    check(`${tag}: Bambu Studio slices it (return_code 0)`, sliced.returnCode === 0, `(return_code ${sliced.returnCode}${sliced.error ? `: ${sliced.error}` : ''})`);
  }

  console.log(`\n${passed} passed, ${failed} failed  (outputs in ${OUT})`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
