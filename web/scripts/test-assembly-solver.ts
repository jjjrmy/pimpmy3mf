// Unit checks for the assemble-mode face-mate solver (src/core/assembly.ts): two boxes, mate a face of one onto a
// face of the other, then assert coplanar faces, opposed (or, flipped, equal) normals, the offset gap and the spin.
//   bun scripts/test-assembly-solver.ts
import { applyRigid, composeAssembly, composeRigid, faceFeature, invertRigid, placeBeside, solveFaceMate, type AssemblyItem, type Rigid } from '../src/core/assembly';
import { buildAdjacency, planarRegion, triNormal } from '../src/core/faces';
import type { Mesh, Model, Vec3 } from '../src/core/types';

let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures++;
}
const near = (a: number, b: number, eps = 1e-4) => Math.abs(a - b) <= eps;
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

function box(ox: number, oy: number, oz: number, w: number, d: number, h: number): Mesh {
  const v = [ox, oy, oz, ox + w, oy, oz, ox + w, oy + d, oz, ox, oy + d, oz, ox, oy, oz + h, ox + w, oy, oz + h, ox + w, oy + d, oz + h, ox, oy + d, oz + h];
  const t = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7];
  return { vertices: new Float32Array(v), triangles: new Uint32Array(t) };
}
const modelOf = (m: Mesh): Model => ({ objects: [{ name: 'box', parts: [{ name: 'box', mesh: m }] }] });

function faceAlong(mesh: Mesh, dir: Vec3): number[] {
  let best = -1, bestDot = -Infinity;
  for (let tri = 0; tri < mesh.triangles.length / 3; tri++) {
    const { n, area } = triNormal(mesh, tri);
    if (area && dot(n, dir) > bestDot) { bestDot = dot(n, dir); best = tri; }
  }
  return planarRegion(mesh, buildAdjacency(mesh), best)!.triangles;
}

// A: 40x20x10 at the origin. B: 30x10x6 placed beside, then rotated 30° about Z so the solve has real work.
const A = box(0, 0, 0, 40, 20, 10);
const B = box(0, 0, 0, 30, 10, 6);
const items: AssemblyItem[] = [{ id: 'a', fileName: 'a.stl', model: modelOf(A), transform: { R: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0] } }];
const beside = placeBeside(items, modelOf(B));
check('placeBeside: +X with 10 mm gap', near(beside.t[0], 50) && near(beside.t[2], 0) && near(beside.t[1], 5), JSON.stringify(beside.t));
const c = Math.cos(Math.PI / 6), s = Math.sin(Math.PI / 6);
items.push({ id: 'b', fileName: 'b.stl', model: modelOf(B), transform: composeRigid({ R: [c, -s, 0, s, c, 0, 0, 0, 1], t: [0, 0, 0] }, beside) });

const composed = composeAssembly(items);
check('compose: one Assembly object with 2 parts', composed.model.objects.length === 1 && composed.model.objects[0].parts.length === 2);
check('compose: part names', composed.model.objects[0].parts.map((p) => p.name).join('|') === 'a.stl|b.stl');
check('compose: partItem map', composed.partItem.join(',') === '0,1');
const single = composeAssembly(items.slice(0, 1));
check('compose: one item keeps its own structure', single.model.objects[0].name === 'box' && single.model.objects[0].parts.length === 1);

const meshA = composed.model.objects[0].parts[0].mesh, meshB = composed.model.objects[0].parts[1].mesh;
// moving = B's bottom (-Z) face; target = A's top (+Z) face
const mTris = faceAlong(meshB, [0, 0, -1]);
const tTris = faceAlong(meshA, [0, 0, 1]);
const mf = faceFeature(meshB, mTris)!, tf = faceFeature(meshA, tTris)!;

function solve(offset: number, flip: boolean, angle: number, seat = true): Rigid {
  return solveFaceMate({
    movingNormal: mf.normal, movingCentroid: mf.centroid, movingRegionPts: mf.points,
    targetNormal: tf.normal, targetCentroid: tf.centroid, targetRegionPts: tf.points,
    offset, flip, angle, seat,
  })!;
}
/** Moved face: normal, centroid, and the max distance of its points from the target plane + offset. */
function after(M: Rigid, offset: number) {
  const n = [0, 1, 2].map((r) => M.R[r * 3] * mf.normal[0] + M.R[r * 3 + 1] * mf.normal[1] + M.R[r * 3 + 2] * mf.normal[2]) as Vec3;
  const cen = applyRigid(M, mf.centroid);
  let planeErr = 0;
  for (const p of mf.points) planeErr = Math.max(planeErr, Math.abs(dot(tf.normal, applyRigid(M, p)) - dot(tf.normal, tf.centroid) - offset));
  return { n, cen, planeErr };
}

{
  const M = solve(0, false, 0);
  const r = after(M, 0);
  check('mate: normals opposed', near(dot(r.n, tf.normal), -1), `dot=${dot(r.n, tf.normal).toFixed(6)}`);
  check('mate: faces coplanar', r.planeErr < 1e-4, `err=${r.planeErr.toExponential(2)}`);
  check('mate: seat puts centroid on centroid', near(r.cen[0], tf.centroid[0]) && near(r.cen[1], tf.centroid[1]) && near(r.cen[2], tf.centroid[2]));
  // seat lines up the long directions: B's long edge (its local X, now turned 30°) should be along A's long edge (X)
  const bx = [M.R[0] * c + M.R[1] * s, M.R[3] * c + M.R[4] * s, M.R[6] * c + M.R[7] * s] as Vec3;
  check('mate: seat aligns long in-plane directions', near(Math.abs(bx[0]), 1, 1e-4), `bx=${bx.map((x) => x.toFixed(4))}`);
  // the moved B rests on A's top: min z of the moved part = 10
  let minZ = Infinity;
  for (let i = 0; i < meshB.vertices.length; i += 3) minZ = Math.min(minZ, applyRigid(M, [meshB.vertices[i], meshB.vertices[i + 1], meshB.vertices[i + 2]])[2]);
  check('mate: moved part sits on top of the target', near(minZ, 10, 1e-4), `minZ=${minZ}`);
}
{
  const M = solve(2.5, false, 0);
  const r = after(M, 2.5);
  check('offset: plane gap honoured (2.5 mm)', r.planeErr < 1e-4, `err=${r.planeErr.toExponential(2)}`);
  check('offset: centroid 2.5 mm above target', near(r.cen[2] - tf.centroid[2], 2.5));
}
{
  const M = solve(0, true, 0);
  const r = after(M, 0);
  check('flip: normals the same direction', near(dot(r.n, tf.normal), 1), `dot=${dot(r.n, tf.normal).toFixed(6)}`);
  check('flip: faces coplanar', r.planeErr < 1e-4);
}
{
  const M0 = solve(0, false, 0), M90 = solve(0, false, 90);
  // the difference M90 ∘ M0^-1 is a pure 90° turn about the target normal through the target centroid
  const D = composeRigid(M90, invertRigid(M0));
  const cosA = (D.R[0] + D.R[4] + D.R[8] - 1) / 2;
  check('angle: +90° spin about the target normal', near(cosA, 0, 1e-6) && near(D.R[8], 1, 1e-6), `cos=${cosA.toFixed(6)}`);
  const r = after(M90, 0);
  check('angle: still coplanar and centred', r.planeErr < 1e-4 && near(r.cen[0], tf.centroid[0]) && near(r.cen[1], tf.centroid[1]));
}
{
  // no seat: drops onto the plane, keeps its in-plane position
  const M = solve(0, false, 0, false);
  const r = after(M, 0);
  check('no seat: coplanar', r.planeErr < 1e-4);
  check('no seat: keeps in-plane position', near(r.cen[0], mf.centroid[0], 1e-3) && near(r.cen[1], mf.centroid[1], 1e-3));
}
{
  // side faces: B's +X face onto A's -X face (normals not along Z)
  const m2 = faceFeature(meshB, faceAlong(meshB, [c, s, 0]))!;
  const t2 = faceFeature(meshA, faceAlong(meshA, [-1, 0, 0]))!;
  const M = solveFaceMate({ movingNormal: m2.normal, movingCentroid: m2.centroid, movingRegionPts: m2.points, targetNormal: t2.normal, targetCentroid: t2.centroid, targetRegionPts: t2.points, offset: 1, flip: false, angle: 0, seat: true })!;
  let err = 0;
  for (const p of m2.points) err = Math.max(err, Math.abs(dot(t2.normal, applyRigid(M, p)) - dot(t2.normal, t2.centroid) - 1));
  const n = [0, 1, 2].map((rr) => M.R[rr * 3] * m2.normal[0] + M.R[rr * 3 + 1] * m2.normal[1] + M.R[rr * 3 + 2] * m2.normal[2]) as Vec3;
  check('side mate: opposed + 1 mm gap', near(dot(n, t2.normal), -1) && err < 1e-4, `err=${err.toExponential(2)}`);
}
{
  const M = solve(1, false, 37);
  const I = composeRigid(M, invertRigid(M));
  check('invert: M ∘ M⁻¹ = identity', I.R.every((x, i) => near(x, [1, 0, 0, 0, 1, 0, 0, 0, 1][i], 1e-9)) && I.t.every((x) => near(x, 0, 1e-9)));
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
