// Inner-surface validator for paint depth: with a depth set, bores, blind holes and cavities print in filament 1
// and only the outer surfaces get the camo shell ("Paint inside surfaces" restores the old behavior).
//
// Shell probes check points 0.25 mm into the material behind a bore wall and behind an outer wall. Slices run the
// REAL pipeline + writeBambuProject through the Bambu CLIs, then read one mid layer of G-code: the wall
// perimeters around the hole must be filament 1 only, while the outer walls carry several colors.
//
//   bun scripts/validate-inner.ts             # probes + every slice case
//   bun scripts/validate-inner.ts probes      # shell probes only
//   bun scripts/validate-inner.ts tubeZ tubeX blind cyl inside   # pick slice cases
//
// Slice wrapper + G-code parsing adapted from validate-depth.ts (not edited). Output: scratch/bambu/inner/.
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Manifold as ManifoldT } from 'manifold-3d';
import { initManifold } from '../src/core/manifold';
import { createPipeline } from '../src/core/pipeline';
import { objectsFromResult, writeBambuProject } from '../src/core/threemf';
import { meshToManifold, partShell, shellStats } from '../src/core/shell';
import { DEFAULT_PARAMS } from '../src/core/types';
import type { Mesh, Model, Params, RasterImage, RGB } from '../src/core/types';

const BIN: Record<string, string> = {
  '1.10': process.env.BAMBU_110 ?? '/tmp/bs110/BambuStudio.app/Contents/MacOS/BambuStudio',
  '2.8': process.env.BAMBU_28 ?? '/Applications/BambuStudio.app/Contents/MacOS/BambuStudio',
};
const ROOT = resolve(import.meta.dir, '..');
const OUT = `${ROOT}/scratch/bambu/inner`;
const TIMEOUT_MS = 600_000;
const CONCURRENCY = 3;
const PALETTE: RGB[] = [[194, 24, 7], [31, 122, 31], [32, 64, 192]];
const DEPTH = 0.6;

const args = process.argv.slice(2);
const want = (c: string) => args.length === 0 || args.includes(c);
mkdirSync(OUT, { recursive: true });
const wasm = await initManifold();
let failures = 0;
const fail = (msg: string) => { failures++; console.log(`  FAIL ${msg}`); };
const ok = (msg: string) => console.log(`  ok   ${msg}`);

// ------------------------------------------------------------------------------------ geometry

function toMesh(man: ManifoldT): Mesh {
  const gm = man.getMesh();
  const np = gm.numProp, nv = gm.vertProperties.length / np;
  const vertices = new Float32Array(nv * 3);
  for (let i = 0; i < nv; i++) for (let k = 0; k < 3; k++) vertices[i * 3 + k] = gm.vertProperties[i * np + k];
  return { vertices, triangles: new Uint32Array(gm.triVerts) };
}
const SEGS = 96;
/** OD 40 / ID 30 / 60 mm tube standing on the bed, axis Z, centered on (20, 20). */
function tubeZ(): ManifoldT {
  const o = wasm.Manifold.cylinder(60, 20, 20, SEGS, false);
  const i = wasm.Manifold.cylinder(64, 15, 15, SEGS, false).translate([0, 0, -2]);
  const t = o.subtract(i).translate([20, 20, 0]);
  o.delete(); i.delete();
  return t;
}
/** The same tube lying along X: x 0..60, axis at y = 20, z = 20. */
function tubeX(): ManifoldT {
  const z = tubeZ().translate([-20, -20, 0]);
  const t = z.rotate([0, 90, 0]).translate([0, 20, 20]);
  z.delete();
  const b = t.boundingBox();
  const out = t.translate([-b.min[0], 0, -b.min[2]]);
  t.delete();
  return out;
}
/** 40 × 40 × 30 box with a r6 × 15 mm blind hole drilled into the front face (y = 0) at x = 20, z = 15. */
function blindBox(): ManifoldT {
  const b = wasm.Manifold.cube([40, 40, 30]);
  const h = wasm.Manifold.cylinder(16, 6, 6, SEGS, false).rotate([-90, 0, 0]).translate([20, -1, 15]);
  const out = b.subtract(h);
  b.delete(); h.delete();
  return out;
}
/** 40 × 40 × 30 L-bracket (30 mm arms, 10 mm thick): its inside corner is an OUTER surface and keeps camo. */
function lBracket(): ManifoldT {
  const a = wasm.Manifold.cube([40, 10, 30]);
  const b = wasm.Manifold.cube([10, 40, 30]);
  const out = a.add(b);
  a.delete(); b.delete();
  return out;
}
/** 40 mm cube with a sealed 20 mm cavity in the middle. */
function cavityBox(): ManifoldT {
  const b = wasm.Manifold.cube([40, 40, 40]);
  const c = wasm.Manifold.cube([20, 20, 20]).translate([10, 10, 10]);
  const out = b.subtract(c);
  b.delete(); c.delete();
  return out;
}
const asModel = (name: string, man: ManifoldT): Model => {
  const mesh = toMesh(man);
  man.delete();
  return { objects: [{ name, parts: [{ name, mesh }] }] };
};

/** 3-color diagonal stripes, ~6 mm bands when stretched over a 40 mm face. */
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

const P = (extra: Partial<Params>): Params => ({
  ...DEFAULT_PARAMS, colors: 3, palette: PALETTE, smooth: 0, minFeature: 0, resolution: 0.3, depth: DEPTH, ...extra,
});

// ------------------------------------------------------------------------------------ shell probes

/** Whether `p` is inside the solid `mesh` (a 0.1 mm probe cube intersects it). */
function contains(mesh: Mesh | null, p: [number, number, number]): boolean {
  if (!mesh) return false;
  const m = meshToManifold(wasm, mesh);
  const c = wasm.Manifold.cube([0.1, 0.1, 0.1], true).translate(p);
  const i = m.intersect(c);
  const v = i.isEmpty() ? 0 : i.volume();
  m.delete(); c.delete(); i.delete();
  return v > 1e-5;
}

interface Probe { name: string; model: Model; inner: [number, number, number] | null; outer: [number, number, number][] }
const probes: Probe[] = [
  // inner = 0.25 mm into the material behind the hole wall; outer = 0.25 mm behind an outside face
  { name: 'tube Z', model: asModel('tubeZ', tubeZ()), inner: [20 + 15.25, 20, 30], outer: [[20 + 19.75, 20, 30], [20, 20 - 19.75, 30]] },
  { name: 'tube X', model: asModel('tubeX', tubeX()), inner: [30, 20, 20 + 15.25], outer: [[30, 20, 20 + 19.75], [30, 20 - 19.75, 20]] },
  { name: 'blind hole', model: asModel('blind', blindBox()), inner: [20 + 6.25, 8, 15], outer: [[20, 0.25, 4], [39.75, 20, 15]] },
  { name: 'L inside corner', model: asModel('L', lBracket()), inner: null, outer: [[25, 9.75, 15], [9.75, 25, 15]] },
  { name: 'sealed cavity', model: asModel('cavity', cavityBox()), inner: [9.75, 20, 20], outer: [[0.25, 20, 20]] },
];

if (want('probes')) {
  console.log(`\n# shell probes, depth ${DEPTH} mm`);
  for (const pr of probes) {
    const mesh = pr.model.objects[0].parts[0].mesh;
    shellStats.ms = 0;
    const t0 = performance.now();
    const outer = partShell(wasm, mesh, DEPTH, false);
    const tOut = performance.now() - t0;
    const inside = partShell(wasm, mesh, DEPTH, true);
    const outsideOk = pr.outer.every((p) => contains(outer, p) && contains(inside, p));
    if (outsideOk) ok(`${pr.name}: outer surfaces shelled in both modes (${tOut.toFixed(0)} ms)`);
    else fail(`${pr.name}: an outer probe is missing from a shell`);
    if (pr.inner) {
      const off = contains(outer, pr.inner), on = contains(inside, pr.inner);
      if (!off && on) ok(`${pr.name}: hole wall skipped by default, shelled with "paint inside surfaces"`);
      else fail(`${pr.name}: hole wall default=${off ? 'shelled' : 'skipped'} inside=${on ? 'shelled' : 'skipped'}`);
    }
  }
}

// ------------------------------------------------------------------------------------ gcode

type Move = [number, number, number, number, number, string];
interface LayerInfo { z: number; moves: Move[] }
interface Gcode { colors: string[]; extrudePerTool: Map<number, number>; layers: LayerInfo[] }

function parseGcode(path: string): Gcode {
  const colors: string[] = [];
  const extrudePerTool = new Map<number, number>();
  const layers: LayerInfo[] = [];
  let tool = -1, inTower = false, feature = '';
  let x = 0, y = 0;
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

interface Slice { exit: number | null; returnCode: number | null; error: string; ms: number; gcode: Gcode | null; logTail: string }

function slice(ver: string, file: string, dir: string): Promise<Slice> {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const t0 = Date.now();
  return new Promise((res) => {
    const ch = spawn(BIN[ver], ['--slice', '0', '--outputdir', dir, file], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = '';
    ch.stdout.on('data', (d) => { log += d; });
    ch.stderr.on('data', (d) => { log += d; });
    const timer = setTimeout(() => ch.kill('SIGKILL'), TIMEOUT_MS);
    ch.on('close', (code, signal) => {
      clearTimeout(timer);
      writeFileSync(`${dir}/cli.log`, log);
      let returnCode: number | null = null, error = '';
      if (existsSync(`${dir}/result.json`)) {
        try { const r = JSON.parse(readFileSync(`${dir}/result.json`, 'utf8')); returnCode = r.return_code; error = r.error_string ?? ''; } catch { /* */ }
      }
      const gcode = existsSync(`${dir}/plate_1.gcode`) ? parseGcode(`${dir}/plate_1.gcode`) : null;
      res({ exit: code ?? (signal ? -1 : null), returnCode, error, ms: Date.now() - t0, gcode, logTail: log.trim().split('\n').slice(-5).join('\n') });
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

const WALL = /wall/i;
const nearestLayer = (g: Gcode, z: number) => g.layers.reduce((b, l) => (Math.abs(l.z - z) < Math.abs(b.z - z) ? l : b));

/** Tools that print wall perimeters on `layer`, split into the hole side and the outside by `isHole(x, y)`,
 *  judged at both ends of each segment relative to the layer's wall bounding box (min corner = 0, 0). Ends
 *  rather than the midpoint because arc-fitted walls (G2/G3) are read as straight chords; a segment with an
 *  end in a skipped zone is judged at its midpoint. */
function wallTools(layer: LayerInfo, isHole: (mx: number, my: number) => boolean | null) {
  const walls = layer.moves.filter((m) => WALL.test(m[5]));
  const xs = walls.flatMap((m) => [m[0], m[2]]), ys = walls.flatMap((m) => [m[1], m[3]]);
  const x0 = Math.min(...xs), y0 = Math.min(...ys);
  const hole = new Map<number, number>(), outside = new Map<number, number>();
  for (const m of walls) {
    const a = isHole(m[0] - x0, m[1] - y0), b = isHole(m[2] - x0, m[3] - y0);
    // a long straight wall can run from one skipped zone to the other: judge it at its midpoint
    const side = a != null && b != null ? (a === b ? a : null) : isHole((m[0] + m[2]) / 2 - x0, (m[1] + m[3]) / 2 - y0);
    if (side == null) continue;
    const bucket = side ? hole : outside;
    bucket.set(m[4], (bucket.get(m[4]) ?? 0) + 1);
  }
  return { hole, outside };
}
const fmt = (m: Map<number, number>) => [...m.entries()].sort((a, b) => a[0] - b[0]).map(([t, n]) => `T${t}:${n}`).join(' ') || '-';

interface Case {
  tag: string; label: string; model: () => Model; params: Params; layerZ: number;
  isHole: (mx: number, my: number) => boolean | null;
  /** true = hole walls must be filament 1 only; false = they must carry several colors ("paint inside" on). */
  holeBase: boolean;
}
const tubeHole = (mx: number, my: number) => {
  // the layer's wall bbox is the 40 mm OD square: center (20, 20)
  const r = Math.hypot(mx - 20, my - 20);
  return r < 17 ? true : r > 18 ? false : null;
};
const tubeXHole = (mx: number, my: number) => {
  // a horizontal slice through the axis is two 5 mm strips (y 0..5 and 35..40): the hole walls face y = 20.
  // The open ends (x 0 / 60) are outside faces, so the bore wall within the depth of them is colored by design.
  if (mx < 1.5 || mx > 58.5) return null;
  const d = Math.abs(my - 20);
  return d < 17 ? true : d > 18 ? false : null;
};
const blindHole = (mx: number, my: number) => {
  // hole walls run x = 14 / 26, y 0..15 (plus its end at y = 15); skip the first 1.5 mm behind the mouth
  if (my > 1.5 && my < 16 && Math.abs(mx - 20) < 7.2) return true;
  if (mx < 1 || mx > 39 || my > 39) return false;
  return null;
};
const cases: Case[] = [
  { tag: 'tubeZ', label: 'tube OD40/ID30 standing, planar front, depth 0.6', model: () => asModel('tubeZ', tubeZ()), params: P({ axis: 'y' }), layerZ: 30, isHole: tubeHole, holeBase: true },
  { tag: 'cyl', label: 'tube standing, cylindrical, depth 0.6', model: () => asModel('tubeZ', tubeZ()), params: P({ axis: 'z', projection: 'cylindrical' }), layerZ: 30, isHole: tubeHole, holeBase: true },
  { tag: 'tubeX', label: 'tube lying along X, planar front, depth 0.6', model: () => asModel('tubeX', tubeX()), params: P({ axis: 'y' }), layerZ: 20, isHole: tubeXHole, holeBase: true },
  { tag: 'blind', label: 'box with a blind hole in the front face, planar front, depth 0.6', model: () => asModel('blind', blindBox()), params: P({ axis: 'y' }), layerZ: 15, isHole: blindHole, holeBase: true },
  { tag: 'inside', label: 'tube standing, planar front, depth 0.6, paint inside surfaces ON', model: () => asModel('tubeZ', tubeZ()), params: P({ axis: 'y', paintInside: true }), layerZ: 30, isHole: tubeHole, holeBase: false },
];

const stripes = stripeImage();
const VERSIONS = ['2.8', '1.10'];
for (const c of cases.filter((c) => want(c.tag))) {
  console.log(`\n# ${c.tag}: ${c.label}`);
  const pipe = createPipeline();
  shellStats.ms = 0;
  const result = await pipe.run(stripes, c.model(), c.params);
  pipe.dispose();
  const colors = result.regions.map((r) => r.hex.toUpperCase());
  const objects = objectsFromResult(result, colors, c.tag);
  console.log(`  shell build ${shellStats.ms.toFixed(0)} ms, ${objects[0].parts.length} parts`);
  const { bytes } = await writeBambuProject(objects, { printerId: 'x1c-0.4', filamentColors: colors });
  const file = `${OUT}/${c.tag}-x1c-0.4.3mf`;
  writeFileSync(file, bytes);
  const res = await pool(VERSIONS.map((ver) => async () => ({ ver, s: await slice(ver, file, `${OUT}/${c.tag}-x1c-0.4-${ver}`) })), CONCURRENCY);
  for (const { ver, s } of res) {
    const label = `${c.tag} x1c-0.4 ${ver}`;
    if (s.exit !== 0 || (s.returnCode != null && s.returnCode !== 0) || !s.gcode) {
      fail(`${label}: exit ${s.exit} return ${s.returnCode} "${s.error}"\n       ${s.logTail.split('\n').join('\n       ')}`);
      continue;
    }
    const missing = [0, 1, 2].filter((t) => !s.gcode!.extrudePerTool.get(t));
    if (missing.length) fail(`${label}: no extrusion on T${missing.join(',T')}`);
    const layer = nearestLayer(s.gcode, c.layerZ);
    const { hole, outside } = wallTools(layer, c.isHole);
    const detail = `z=${layer.z} hole walls ${fmt(hole)} | outer walls ${fmt(outside)}`;
    const holeTools = [...hole.keys()], outTools = [...outside.keys()];
    if (!holeTools.length || !outTools.length) { fail(`${label}: couldn't find both wall groups (${detail})`); continue; }
    if (outTools.length < 2) fail(`${label}: outer walls show only ${fmt(outside)} (${detail})`);
    else if (c.holeBase && !(holeTools.length === 1 && holeTools[0] === 0)) fail(`${label}: hole walls not filament 1 only (${detail})`);
    else if (!c.holeBase && holeTools.length < 2) fail(`${label}: paint inside ON but hole walls are one color (${detail})`);
    else ok(`${label}: exit 0, ${(s.ms / 1000).toFixed(0)}s, ${detail}`);
  }
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nall inner-surface checks passed');
process.exit(failures ? 1 : 0);
