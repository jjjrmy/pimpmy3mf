// Validation for cylindrical projection (paint mode). Builds two synthetic models (a fine cylinder
// r=25 h=50 and a 40x30x50 box) + a 3-color diagonal-checkerboard image (seam-continuous), runs them
// through the pipeline with projection='cylindrical', axis='z', and checks:
//   - each color's modifier is a valid manifold (Manifold.ofMesh status NoError),
//   - pairwise color intersection volume < 1e-3 mm^3 (colors don't overlap, incl. across the seam),
//   - export (objectsFromResult + writeBambuProject P2S 0.4) slices rc0 and every filament extrudes,
//   - render-unrolled.py agreement between the printed outer wall and the expected (u,v) map,
//     seam continuity (phi~=0 vs phi~=2pi), and vertical streaking,
//   - tile-mode width-snap (width 30): report snapped tile width + wraps.
// Slice helpers are copied from validate-bambu.ts (that file is not edited).
//
//   bun scripts/validate-cylindrical.ts
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ManifoldToplevel, Manifold as ManifoldT } from 'manifold-3d';
import { initManifold } from '../src/core/manifold';
import { createPipeline } from '../src/core/pipeline';
import { objectsFromResult, writeBambuProject } from '../src/core/threemf';
import { cylPoint } from '../src/core/cylinder';
import { warpInsetRings, partitionWedges } from '../src/core/cylindrical';
import { DEFAULT_PARAMS, type CylinderFrame, type Mesh, type Model, type Params, type RasterImage, type RGB, type Result } from '../src/core/types';

const BAMBU = process.env.BAMBU_STUDIO ?? '/Applications/BambuStudio.app/Contents/MacOS/BambuStudio';
const PY = process.env.PYTHON ?? 'python3';
const ROOT = resolve(import.meta.dir, '..');
const OUT = `${ROOT}/scratch/bambu/cyl`;
const RENDER = `${ROOT}/scripts/render-unrolled.py`;
const PALETTE: RGB[] = [[194, 24, 7], [31, 122, 31], [32, 64, 192]]; // red / green / blue
const HEXES = ['#C21807', '#1F7A1F', '#2040C0'];

mkdirSync(OUT, { recursive: true });

// ----------------------------------------------------------------------------- assertions
let passed = 0, failed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) { passed++; console.log(`   ✓ ${name}`); }
  else { failed++; failures.push(`${name} ${detail}`); console.log(`   ✗ ${name} ${detail}`); }
}

// ----------------------------------------------------------------------------- mesh helpers
function ourMesh(man: { getMesh: () => { numProp: number; vertProperties: Float32Array; triVerts: Uint32Array } }): Mesh {
  const gm = man.getMesh();
  const np = gm.numProp;
  const nv = gm.vertProperties.length / np;
  const vertices = new Float32Array(nv * 3);
  for (let i = 0; i < nv; i++) {
    vertices[i * 3] = gm.vertProperties[i * np];
    vertices[i * 3 + 1] = gm.vertProperties[i * np + 1];
    vertices[i * 3 + 2] = gm.vertProperties[i * np + 2];
  }
  return { vertices, triangles: new Uint32Array(gm.triVerts) };
}

function cylinderModel(wasm: ManifoldToplevel, r: number, h: number, segs: number): Model {
  const man = wasm.Manifold.cylinder(h, r, r, segs, true); // centered on origin
  const mesh = ourMesh(man); man.delete();
  return { objects: [{ name: 'cyl', parts: [{ name: 'cyl', mesh }] }] };
}

function boxModel(wasm: ManifoldToplevel, w: number, d: number, h: number): Model {
  const man = wasm.Manifold.cube([w, d, h], true); // centered on origin
  const mesh = ourMesh(man); man.delete();
  return { objects: [{ name: 'box', parts: [{ name: 'box', mesh }] }] };
}

/**
 * Test image: 3 vertical bands (120deg each around the circumference) offset by W/6 so ONE band
 * straddles the x=0/x=W wrap seam (col 0 and col W-1 share a color -> the seam is continuous for
 * rotation 0), plus a mid-height color shift so the pattern also varies along v. Few, large regions
 * -> plentiful samples away from boundaries while still exercising the seam, v-variation and 3 colors.
 */
function testImage(W: number, H: number): RasterImage {
  const data = new Uint8ClampedArray(W * H * 4);
  const third = W / 3;
  for (let y = 0; y < H; y++) {
    const shift = y < H / 2 ? 0 : 1;
    for (let x = 0; x < W; x++) {
      const band = Math.floor(((x + W / 6) % W) / third);
      const k = (band + shift) % 3;
      const o = (y * W + x) * 4;
      data[o] = PALETTE[k][0]; data[o + 1] = PALETTE[k][1]; data[o + 2] = PALETTE[k][2]; data[o + 3] = 255;
    }
  }
  return { width: W, height: H, data };
}

// ----------------------------------------------------------------------------- manifold checks
interface ManInfo { status: string; volume: number; tris: number; }
function manInfo(wasm: ManifoldToplevel, mesh: Mesh): ManInfo {
  const m = new wasm.Mesh({ numProp: 3, vertProperties: mesh.vertices, triVerts: mesh.triangles });
  const man = wasm.Manifold.ofMesh(m);
  const info = { status: man.status(), volume: man.volume(), tris: man.numTri() };
  man.delete();
  return info;
}

/** Intersection volume of two region meshes (0 if either empty / non-overlapping). */
function intersectVol(wasm: ManifoldToplevel, a: Mesh, b: Mesh): number {
  const ma = wasm.Manifold.ofMesh(new wasm.Mesh({ numProp: 3, vertProperties: a.vertices, triVerts: a.triangles }));
  const mb = wasm.Manifold.ofMesh(new wasm.Mesh({ numProp: 3, vertProperties: b.vertices, triVerts: b.triangles }));
  const inter = ma.intersect(mb);
  const vol = inter.isEmpty() ? 0 : Math.abs(inter.volume());
  inter.delete(); ma.delete(); mb.delete();
  return vol;
}

/** Max pairwise intersection volume across a list of Manifolds (nulls skipped). */
function pairMaxVol(ws: (ManifoldT | null)[]): number {
  let m = 0;
  for (let i = 0; i < ws.length; i++) {
    for (let j = i + 1; j < ws.length; j++) {
      const a = ws[i], b = ws[j];
      if (!a || !b) continue;
      const it = a.intersect(b);
      const v = it.isEmpty() ? 0 : Math.abs(it.volume());
      it.delete();
      if (v > m) m = v;
    }
  }
  return m;
}

/** Flat (u,v) ring -> polygon list for warpInsetRings. */
function ringsToPolys(rings: Float32Array[]): [number, number][][] {
  return rings.map((flat) => {
    const p: [number, number][] = [];
    for (let i = 0; i < flat.length; i += 2) p.push([flat[i], flat[i + 1]]);
    return p;
  });
}

// ----------------------------------------------------------------------------- geometric coverage
/** Even-odd point-in-polygon over a region's flat (u,v) rings (CCW outer / CW holes). */
function pointInRings(u: number, v: number, rings: Float32Array[]): boolean {
  let inside = false;
  for (const r of rings) {
    const n = r.length / 2;
    for (let i = 0; i < n; i++) {
      const ux0 = r[2 * i], vy0 = r[2 * i + 1];
      const j = (i + 1) % n, ux1 = r[2 * j], vy1 = r[2 * j + 1];
      if ((ux0 > u) !== (ux1 > u)) {
        const vt = vy0 + (u - ux0) * (vy1 - vy0) / (ux1 - ux0);
        if (v < vt) inside = !inside;
      }
    }
  }
  return inside;
}

/** Point-in-mesh by ray casting along +x (Möller–Trumbore), counting triangle crossings (odd = inside). */
function insideMesh(px: number, py: number, pz: number, mesh: Mesh): boolean {
  const V = mesh.vertices, T = mesh.triangles;
  let crossings = 0;
  for (let t = 0; t < T.length; t += 3) {
    const a = T[t] * 3, b = T[t + 1] * 3, c = T[t + 2] * 3;
    const e1x = V[b] - V[a], e1y = V[b + 1] - V[a + 1], e1z = V[b + 2] - V[a + 2];
    const e2x = V[c] - V[a], e2y = V[c + 1] - V[a + 1], e2z = V[c + 2] - V[a + 2];
    // h = dir × e2, dir = (1,0,0) -> (0, -e2z, e2y)
    const hx = 0, hy = -e2z, hz = e2y;
    const det = e1x * hx + e1y * hy + e1z * hz;
    if (det > -1e-12 && det < 1e-12) continue;
    const inv = 1 / det;
    const sx = px - V[a], sy = py - V[a + 1], sz = pz - V[a + 2];
    const uu = (sx * hx + sy * hy + sz * hz) * inv;
    if (uu < 0 || uu > 1) continue;
    const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
    const vv = qx * inv; // dir·q = q.x
    if (vv < 0 || uu + vv > 1) continue;
    const tt = (e2x * qx + e2y * qy + e2z * qz) * inv;
    if (tt > 1e-9) crossings++;
  }
  return (crossings & 1) === 1;
}

/**
 * Geometric correctness, no slicer: sample points on the cylinder surface (radius rSurf), and for each
 * check it is inside the modifier of the region its (u,v) lands in, and NOT inside any other region's
 * modifier. Returns coverage % (expected modifier contains the point) and exclusivity violations.
 */
function surfaceCoverage(result: Result, cyl: CylinderFrame, rSurf: number): { coverage: number; exclViol: number; tested: number } {
  const nPhi = 240, nV = 40;
  const vmin = result.frame.y0 + 1.5, vmax = result.frame.y1 - 1.5;
  let tested = 0, covered = 0, exclViol = 0;
  for (let iv = 0; iv < nV; iv++) {
    const v = vmin + (vmax - vmin) * (iv + 0.5) / nV;
    for (let ip = 0; ip < nPhi; ip++) {
      const phi = 2 * Math.PI * (ip + 0.5) / nPhi;
      const u = cyl.R0 * phi;
      // which region owns (u,v)? skip gaps/boundaries (no region or on inset gap)
      let owner = -1, owners = 0;
      for (const reg of result.regions) { if (pointInRings(u, v, reg.rings)) { owner = reg.index; owners++; } }
      if (owners !== 1) continue; // boundary / inset gap -> skip
      tested++;
      const [x, y, z] = cylPoint(u, v, rSurf, cyl);
      for (const reg of result.regions) {
        if (!reg.mesh) continue;
        const inside = insideMesh(x, y, z, reg.mesh);
        if (reg.index === owner) { if (inside) covered++; }
        else if (inside) exclViol++;
      }
    }
  }
  return { coverage: tested ? covered / tested * 100 : 0, exclViol, tested };
}

// ----------------------------------------------------------------------------- slicing (copied from validate-bambu.ts)
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
  } catch { /* non-zero exit still writes result.json */ }
  let returnCode = -999, error = 'no result.json';
  if (existsSync(`${dir}/result.json`)) {
    const j = JSON.parse(readFileSync(`${dir}/result.json`, 'utf8'));
    returnCode = j.return_code; error = j.error_string ?? '';
  }
  return { dir, returnCode, error };
}

// ----------------------------------------------------------------------------- map dump for render-unrolled.py
function writeMap(path: string, result: Result): void {
  const cyl = result.cylinder!;
  const map = {
    axis: result.axis,
    R0: cyl.R0,
    center: cyl.center,
    circumference: result.tile.w * (result.tile.wraps ?? 1),
    regions: result.regions.map((r) => ({
      index: r.index, tool: r.index, hex: r.hex,
      rings: r.rings.map((flat) => {
        const pts: [number, number][] = [];
        for (let i = 0; i < flat.length; i += 2) pts.push([flat[i], flat[i + 1]]);
        return pts;
      }),
    })),
  };
  writeFileSync(path, JSON.stringify(map));
}

// ----------------------------------------------------------------------------- one model end-to-end
async function runCase(wasm: ManifoldToplevel, name: string, model: Model, image: RasterImage, doSlice: boolean, surfaceR?: number): Promise<void> {
  console.log(`\n# ${name}`);
  const pipe = createPipeline();
  const params: Params = {
    ...DEFAULT_PARAMS, colors: 3, palette: PALETTE, width: null, height: null,
    axis: 'z', projection: 'cylindrical', smooth: 0, minFeature: 0, resolution: 0.3,
  };
  const t0 = performance.now();
  const result = await pipe.run(image, model, params);
  const ms = performance.now() - t0;
  const cyl = result.cylinder;
  console.log(`   projection=${result.projection}, R0=${cyl?.R0.toFixed(3)}, circ=${(result.tile.w * (result.tile.wraps ?? 1)).toFixed(2)}mm, `
    + `frame v=[${result.frame.y0.toFixed(1)},${result.frame.y1.toFixed(1)}], grid ${result.stats.gridW}x${result.stats.gridH}, ${ms.toFixed(0)}ms`);
  check(`${name}: projection echoed cylindrical`, result.projection === 'cylindrical');
  check(`${name}: cylinder frame present`, cyl != null && cyl.R0 > 0, `(${JSON.stringify(cyl)})`);

  // triangle counts + manifold status per color
  let allManifold = true;
  for (const reg of result.regions) {
    if (!reg.mesh) { check(`${name}: color ${reg.index + 1} has a mesh`, false); allManifold = false; continue; }
    const info = manInfo(wasm, reg.mesh);
    const ok = info.status === 'NoError';
    if (!ok) allManifold = false;
    check(`${name}: color ${reg.index + 1} (${reg.hex}) manifold`, ok, `(status ${info.status}, ${info.tris} tris, vol ${info.volume.toFixed(1)})`);
    console.log(`     color ${reg.index + 1}: ${reg.mesh.triangles.length / 3} tris, status ${info.status}, vol ${info.volume.toFixed(1)}mm^3, coverage ${(reg.coverage * 100).toFixed(1)}%`);
  }
  void allManifold;

  // pairwise intersection BEFORE vs AFTER the partition, on the same warped wedges (rebuilt from the
  // inset rings the pipeline produced), to show the incremental-subtraction fix.
  const raw = cyl ? result.regions.map((r) => (r.rings.length ? warpInsetRings(wasm, ringsToPolys(r.rings), cyl) : null)) : [];
  const beforeMax = pairMaxVol(raw);
  const parted = partitionWedges(raw);
  const afterMax = pairMaxVol(parted);
  raw.forEach((w) => w?.delete());
  parted.forEach((w) => w?.delete());
  console.log(`     pairwise intersection: before partition ${beforeMax.toExponential(2)} mm^3, after ${afterMax.toExponential(2)} mm^3`);
  check(`${name}: partitioned pairwise intersection < 1e-3 mm^3`, afterMax < 1e-3, `(after ${afterMax.toExponential(2)}, before ${beforeMax.toExponential(2)})`);

  // the shipped result meshes (already partitioned by the pipeline) must also be non-overlapping
  let shipMax = 0;
  for (let i = 0; i < result.regions.length; i++) {
    for (let j = i + 1; j < result.regions.length; j++) {
      const a = result.regions[i].mesh, b = result.regions[j].mesh;
      if (!a || !b) continue;
      shipMax = Math.max(shipMax, intersectVol(wasm, a, b));
    }
  }
  check(`${name}: shipped result meshes non-overlapping < 1e-3 mm^3`, shipMax < 1e-3, `(max ${shipMax.toExponential(2)})`);

  // geometric surface coverage (no slicer): every surface point lands in its expected color's modifier
  if (surfaceR != null && cyl) {
    const cov = surfaceCoverage(result, cyl, surfaceR);
    console.log(`     surface coverage: ${cov.coverage.toFixed(2)}% of ${cov.tested} points, ${cov.exclViol} exclusivity violations`);
    check(`${name}: surface coverage >= 99%`, cov.coverage >= 99, `(${cov.coverage.toFixed(2)}% of ${cov.tested})`);
    check(`${name}: no exclusivity violations (colors don't overlap on surface)`, cov.exclViol === 0, `(${cov.exclViol})`);
  }

  pipe.dispose();

  if (!doSlice) return;

  // export + slice
  const objects = objectsFromResult(result, HEXES, name);
  const { bytes, warnings } = await writeBambuProject(objects, { printerId: 'p2s-0.4', filamentColors: HEXES });
  const file = `${OUT}/${name}.3mf`;
  writeFileSync(file, bytes);
  console.log(`   built ${(bytes.length / 1024).toFixed(0)} KB (${objects.length} obj), warnings=${warnings.length ? warnings.join('|') : 'none'}`);
  const { dir, returnCode, error } = runSlice(file, name);
  check(`${name}: slices return_code 0`, returnCode === 0, `(got ${returnCode}: ${error})`);
  const gcode = `${dir}/plate_1.gcode`;
  if (existsSync(gcode)) {
    const { colors, extrudePerTool } = parseGcodeFile(gcode);
    check(`${name}: gcode declares 3 filament colors`, JSON.stringify(colors) === JSON.stringify(HEXES.map((c) => c.toUpperCase())), `(got ${JSON.stringify(colors)})`);
    check(`${name}: every filament extrudes`, [0, 1, 2].every((t) => (extrudePerTool.get(t) ?? 0) > 0), `(moves/tool ${JSON.stringify([...extrudePerTool.entries()])})`);

    // render-unrolled.py: agreement + seam + streak
    const mapPath = `${OUT}/${name}-map.json`;
    writeMap(mapPath, result);
    const png = `${OUT}/${name}-unrolled.png`;
    try {
      const log = execFileSync(PY, ['-I', RENDER, gcode, png, '--map', mapPath, '--band', '1.0'], { encoding: 'utf8' });
      const line = log.split('\n').find((l) => l.startsWith('RESULT '));
      console.log('   ' + log.split('\n').filter((l) => l && !l.startsWith('RESULT ')).join('\n   '));
      if (line) {
        const r = JSON.parse(line.slice('RESULT '.length));
        // slicer perimeter color-assignment is per-segment, so the base color shows through at the ~1 mm
        // level inside non-base regions; the geometric surface-coverage check above is the strict gate.
        check(`${name}: outer-wall agreement >= 80%`, r.agreementPct >= 80, `(${r.agreementPct}% of ${r.validSamples})`);
        check(`${name}: seam agreement >= 80%`, r.seamAgreementPct >= 80, `(${r.seamAgreementPct}% of ${r.seamSamples})`);
        check(`${name}: no fully-wrong phi columns (streak)`, r.streakBadCols === 0, `(${r.streakBadCols} cols, ${r.streakBadColPct}%)`);
        console.log(`   render -> ${png}`);
      } else check(`${name}: render-unrolled produced RESULT`, false);
    } catch (e: any) {
      check(`${name}: render-unrolled ran`, false, e.message?.slice(0, 200));
    }
  }
}

// ----------------------------------------------------------------------------- tile-mode snap
async function tileSnap(model: Model, image: RasterImage): Promise<void> {
  console.log('\n# tile-mode snap (width 30)');
  const pipe = createPipeline();
  const result = await pipe.run(image, model, {
    ...DEFAULT_PARAMS, colors: 3, palette: PALETTE, width: 30, height: null,
    axis: 'z', projection: 'cylindrical', smooth: 0, minFeature: 0, resolution: 0.4,
  });
  pipe.dispose();
  const circ = 2 * Math.PI * (result.cylinder?.R0 ?? 0);
  const n = Math.max(1, Math.round(circ / 30));
  console.log(`   circumference ${circ.toFixed(2)}mm, requested tile 30mm -> snapped ${result.tile.w.toFixed(3)}mm x ${result.tile.wraps} wraps (repeat=${result.tile.repeat})`);
  check('tile: wraps = round(circ/30)', result.tile.wraps === n, `(got ${result.tile.wraps}, expected ${n})`);
  check('tile: snapped width = circ/wraps', Math.abs(result.tile.w - circ / n) < 1e-6, `(got ${result.tile.w}, expected ${circ / n})`);
  check('tile: repeat flag set', result.tile.repeat === true);
}

async function main() {
  const wasm = await initManifold();
  const image = testImage(360, 180);

  const cyl = cylinderModel(wasm, 25, 50, 128);
  const box = boxModel(wasm, 40, 30, 50);

  await runCase(wasm, 'cyl-r25-h50', cyl, image, true, 24.5); // outer wall sits ~0.5mm inside r=25
  await runCase(wasm, 'box-40x30x50', box, image, true);
  await tileSnap(cyl, image);

  console.log(`\n==== ${passed} passed, ${failed} failed`);
  if (failed) { console.log('FAILURES:\n - ' + failures.join('\n - ')); process.exit(1); }
}

await main();
