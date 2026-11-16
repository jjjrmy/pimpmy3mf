// Unit checks for the assemble-mode face-mate solver (src/core/assembly.ts): two boxes, mate a face of one onto a
// face of the other, then assert coplanar faces, opposed (or, flipped, equal) normals, the offset gap and the spin.
//   bun scripts/test-assembly-solver.ts
import {
  angleDelta,
  applyRigid,
  assemblyStem,
  composeAssembly,
  composeRigid,
  conjugateRigid,
  faceFeature,
  invertRigid,
  placeBeside,
  planeBasis,
  rayAngleAbout,
  rayLineParam,
  rotateAboutRigid,
  rotateVec,
  snapGizmo,
  solveFaceMate,
  translateRigid,
  type AssemblyItem,
  type Rigid,
} from '../src/core/assembly';
import { buildAdjacency, mulMat3, orientModel, orientPlacement, planarRegion, rotationToDown, triNormal } from '../src/core/faces';
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

{
  // slide: the mate gizmo arrows move the seated face within the target plane by exactly (u, v) mm
  const M0 = solve(0, false, 0);
  const Ms = solveFaceMate({
    movingNormal: mf.normal, movingCentroid: mf.centroid, movingRegionPts: mf.points,
    targetNormal: tf.normal, targetCentroid: tf.centroid, targetRegionPts: tf.points,
    offset: 0, flip: false, angle: 0, seat: true, slide: [3, -2],
  })!;
  const [u, v] = planeBasis(tf.normal);
  const c0 = applyRigid(M0, mf.centroid), c1 = applyRigid(Ms, mf.centroid);
  const d: Vec3 = [c1[0] - c0[0], c1[1] - c0[1], c1[2] - c0[2]];
  check('slide: in-plane offset along the target basis', near(dot(d, u), 3) && near(dot(d, v), -2) && near(dot(d, tf.normal), 0), `d=${d.map((x) => x.toFixed(4))}`);
  check('slide: still coplanar', after(Ms, 0).planeErr < 1e-4);
}

// ---- mates while the assembly is laid on a face ---------------------------------------------------------------
// The app picks faces on the DISPLAYED (oriented) result and maps them back into assembly space by the inverse of
// the lay-on-face transform; item transforms stay unoriented. Mate, then un-orient: the faces must be coincident.
{
  const layItems: AssemblyItem[] = items.map((it) => ({ ...it }));
  const asm = composeAssembly(layItems).model;
  // lay the assembly on A's -Y side face, then a turn about Z on top so every axis is involved
  const layR = mulMat3([Math.cos(0.4), -Math.sin(0.4), 0, Math.sin(0.4), Math.cos(0.4), 0, 0, 0, 1], rotationToDown([0, -1, 0]));
  const shown = orientModel(asm, layR);
  const O = orientPlacement(asm, layR)!;
  // orientPlacement is exactly the motion orientModel applied
  let placeErr = 0;
  asm.objects[0].parts.forEach((p, k) => {
    const q = shown.objects[0].parts[k].mesh.vertices;
    for (let i = 0; i < p.mesh.vertices.length; i += 3) {
      const r = applyRigid(O, [p.mesh.vertices[i], p.mesh.vertices[i + 1], p.mesh.vertices[i + 2]]);
      placeErr = Math.max(placeErr, Math.abs(r[0] - q[i]), Math.abs(r[1] - q[i + 1]), Math.abs(r[2] - q[i + 2]));
    }
  });
  check('orient: orientPlacement reproduces orientModel', placeErr < 1e-4, `err=${placeErr.toExponential(2)}`);

  // pick B's bottom and A's top on the shown pose (their displayed normals are no longer ±Z)
  const shownA = shown.objects[0].parts[0].mesh, shownB = shown.objects[0].parts[1].mesh;
  const dn = (n: Vec3) => rotateVec(O, n);
  const pickB = faceAlong(shownB, dn([0, 0, -1])), pickA = faceAlong(shownA, dn([0, 0, 1]));
  const toAsm = invertRigid(O); // + Tcur ∘ Tres⁻¹ = identity: the result shows the current layout
  const feat = (mesh: Mesh, tris: number[]) => {
    const f = faceFeature(mesh, tris)!;
    return { normal: rotateVec(toAsm, f.normal), centroid: applyRigid(toAsm, f.centroid), points: f.points.map((p) => applyRigid(toAsm, p)) };
  };
  const fm = feat(shownB, pickB), ft = feat(shownA, pickA);
  const M = solveFaceMate({
    movingNormal: fm.normal, movingCentroid: fm.centroid, movingRegionPts: fm.points,
    targetNormal: ft.normal, targetCentroid: ft.centroid, targetRegionPts: ft.points,
    offset: 0, flip: false, angle: 20, seat: true,
  })!;
  layItems[1] = { ...layItems[1], transform: composeRigid(M, layItems[1].transform) };
  // un-orient: the composed (unoriented) assembly has B's bottom flush on A's top
  const asm2 = composeAssembly(layItems).model;
  const a2 = asm2.objects[0].parts[0].mesh, b2 = asm2.objects[0].parts[1].mesh;
  const fa = faceFeature(a2, pickA)!, fb = faceFeature(b2, pickB)!;
  let gap = 0;
  for (const p of fb.points) gap = Math.max(gap, Math.abs(dot(fa.normal, p) - dot(fa.normal, fa.centroid)));
  check('orient: mate solved on the laid pose -> normals opposed in assembly space', near(dot(fa.normal, fb.normal), -1, 1e-6), `dot=${dot(fa.normal, fb.normal).toFixed(6)}`);
  check('orient: faces coincident after un-orienting', gap < 1e-3, `gap=${gap.toExponential(2)}`);
  check('orient: A top is still +Z in assembly space (transforms stay unoriented)', near(fa.normal[2], 1, 1e-6));
  check('orient: seated centroid on centroid', Math.hypot(fb.centroid[0] - fa.centroid[0], fb.centroid[1] - fa.centroid[1], fb.centroid[2] - fa.centroid[2]) < 1e-3);
  // re-orient: still flush in the displayed pose too
  const shown2 = orientModel(asm2, layR);
  const sa = faceFeature(shown2.objects[0].parts[0].mesh, pickA)!, sb = faceFeature(shown2.objects[0].parts[1].mesh, pickB)!;
  let gap2 = 0;
  for (const p of sb.points) gap2 = Math.max(gap2, Math.abs(dot(sa.normal, p) - dot(sa.normal, sa.centroid)));
  check('orient: faces coincident in the laid pose as well', gap2 < 1e-3 && near(dot(sa.normal, sb.normal), -1, 1e-6), `gap=${gap2.toExponential(2)}`);

  // a stale view: B moved since the shown result (Tcur ≠ Tres). Picks on the old view still solve correctly.
  const moved: AssemblyItem[] = layItems.map((it) => ({ ...it }));
  const nudge = composeRigid(translateRigid([1, 0, 0], 7), rotateAboutRigid([0, 0, 1], [60, 10, 0], 25));
  moved[1] = { ...moved[1], transform: composeRigid(nudge, moved[1].transform) };
  const Tres = layItems[1].transform, Tcur = moved[1].transform;
  // the old view is shown2, laid with ITS own placement (the bbox centre moved with the mate)
  const O2 = orientPlacement(asm2, layR)!;
  const staleA = composeRigid(Tcur, composeRigid(invertRigid(Tres), invertRigid(O2)));
  const f2 = faceFeature(shown2.objects[0].parts[1].mesh, faceAlong(shown2.objects[0].parts[1].mesh, dn([0, 0, 1])))!; // B's top on the old view
  const n2 = rotateVec(staleA, f2.normal), c2 = applyRigid(staleA, f2.centroid);
  const b3 = composeAssembly(moved).model.objects[0].parts[1].mesh;
  const fTop = faceFeature(b3, faceAlong(composeAssembly(moved).model.objects[0].parts[1].mesh, rotateVec(nudge, [0, 0, 1])))!;
  check('stale view: a pick maps through Tcur ∘ Tres⁻¹ ∘ O⁻¹ onto the current pose', near(dot(n2, fTop.normal), 1, 1e-6) && Math.hypot(c2[0] - fTop.centroid[0], c2[1] - fTop.centroid[1], c2[2] - fTop.centroid[2]) < 1e-3);

  // a displayed gizmo move G becomes O⁻¹ ∘ G ∘ O in assembly space: the laid pose shows B moved by exactly G
  const G = composeRigid(translateRigid(rotateVec(O, [0, 0, 1]), 5), rotateAboutRigid([0, 0, 1], [3, 4, 5], 45));
  const Gasm = conjugateRigid(invertRigid(O), G);
  const before = applyRigid(O, applyRigid(Tcur, [1, 2, 3]));
  const afterP = applyRigid(O, applyRigid(composeRigid(Gasm, Tcur), [1, 2, 3]));
  const want = applyRigid(G, before);
  check('gizmo: O ∘ (O⁻¹ G O) ∘ T = G ∘ O ∘ T', Math.hypot(afterP[0] - want[0], afterP[1] - want[1], afterP[2] - want[2]) < 1e-9);
}

// ---- gizmo math -----------------------------------------------------------------------------------------------
{
  for (const n of [[0, 0, 1], [1, 0, 0], [0.3, -0.8, 0.52]] as Vec3[]) {
    const l = Math.hypot(...n), nn = n.map((x) => x / l) as Vec3;
    const [u, v] = planeBasis(nn);
    const cr: Vec3 = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    check(`planeBasis(${n.join(',')}): orthonormal, u × v = n`, near(dot(u, u), 1, 1e-9) && near(dot(v, v), 1, 1e-9) && near(dot(u, v), 0, 1e-9) && near(dot(cr, nn), 1, 1e-9));
  }
  // a ray straight down at (7, 0, 0) onto the X axis line through the origin: param 7
  check('rayLineParam: closest point on the axis', near(rayLineParam([0, 0, 0], [1, 0, 0], [7, 3, 10], [0, 0, -1])!, 7, 1e-9));
  check('rayLineParam: parallel ray -> null', rayLineParam([0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 0, 0]) === null);
  const a0 = rayAngleAbout([0, 0, 0], [0, 0, 1], [5, 0, 10], [0, 0, -1])!;
  const a1 = rayAngleAbout([0, 0, 0], [0, 0, 1], [0, 5, 10], [0, 0, -1])!;
  check('rayAngleAbout: a quarter turn is +90° about +Z', near((angleDelta(a0, a1) * 180) / Math.PI, 90, 1e-9));
  check('angleDelta: wraps across ±π', near(angleDelta(3, -3), 2 * Math.PI - 6, 1e-12));
  check('snap: 1 mm and 15° steps, Shift = free', snapGizmo('translate', 2.6, false) === 3 && snapGizmo('rotate', 22, false) === 15 && snapGizmo('rotate', 23, false) === 30 && snapGizmo('translate', 2.6, true) === 2.6);
  const Rz = rotateAboutRigid([0, 0, 1], [10, 0, 0], 90);
  const p = applyRigid(Rz, [11, 0, 0]);
  check('rotateAboutRigid: turns about the given centre', near(p[0], 10, 1e-9) && near(p[1], 1, 1e-9) && near(applyRigid(Rz, [10, 0, 0])[0], 10, 1e-9));
}

// ---- export naming --------------------------------------------------------------------------------------------
{
  check('stem: one file keeps its own stem', assemblyStem(['grip.stl']) === 'grip');
  check('stem: two files -> first+second', assemblyStem(['grip.stl', 'mount.3mf']) === 'grip+mount');
  check('stem: four files -> first+second+2', assemblyStem(['grip.stl', 'mount.3mf', 'a.obj', 'b.stl']) === 'grip+mount+2');
  const long = assemblyStem(['a-very-long-file-name-for-a-pistol-grip-v12-final.stl', 'another extremely long mount name (copy).3mf', 'c.stl']);
  check('stem: sanitized and capped at 60 chars', long.length <= 60 && /^[\w.+-]+$/.test(long) && long.endsWith('+1'), long);
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
