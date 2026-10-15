// Paint-face skins: each painted face becomes a solid modifier (the face region extruded ~1 mm into the part),
// printed in its chosen color, and the camo modifiers give way to it.
import type { ManifoldToplevel, Manifold as ManifoldT } from 'manifold-3d';
import type { ColorRegion, FaceSkin, Mesh, Model, PaintedFace, Vec3 } from './types';
import { triNormal } from './faces';

/** A right-handed basis (e1, e2, n) with e1 × e2 = n, e1/e2 spanning the plane normal to n. */
function planeBasis(n: Vec3): { e1: Vec3; e2: Vec3 } {
  const ax = Math.abs(n[0]), ay = Math.abs(n[1]), az = Math.abs(n[2]);
  // reference axis least aligned with n, so t × n is well-conditioned
  const t: Vec3 = ax <= ay && ax <= az ? [1, 0, 0] : ay <= az ? [0, 1, 0] : [0, 0, 1];
  let e1x = t[1] * n[2] - t[2] * n[1], e1y = t[2] * n[0] - t[0] * n[2], e1z = t[0] * n[1] - t[1] * n[0];
  const l1 = Math.hypot(e1x, e1y, e1z) || 1;
  e1x /= l1; e1y /= l1; e1z /= l1;
  // e2 = n × e1 (so e1 × e2 = n)
  const e2x = n[1] * e1z - n[2] * e1y, e2y = n[2] * e1x - n[0] * e1z, e2z = n[0] * e1y - n[1] * e1x;
  return { e1: [e1x, e1y, e1z], e2: [e2x, e2y, e2z] };
}

/** getMesh + map (u,v,w) back to xyz via R (row-major 3x3) or identity. */
function manifoldToMesh(man: ManifoldT, R?: number[] | null): Mesh {
  const gm = man.getMesh();
  const np = gm.numProp;
  const nv = gm.vertProperties.length / np;
  const vertices = new Float32Array(nv * 3);
  if (R) {
    for (let i = 0; i < nv; i++) {
      const u = gm.vertProperties[i * np], v = gm.vertProperties[i * np + 1], w = gm.vertProperties[i * np + 2];
      vertices[i * 3] = R[0] * u + R[1] * v + R[2] * w;
      vertices[i * 3 + 1] = R[3] * u + R[4] * v + R[5] * w;
      vertices[i * 3 + 2] = R[6] * u + R[7] * v + R[8] * w;
    }
  } else {
    for (let i = 0; i < nv; i++) {
      vertices[i * 3] = gm.vertProperties[i * np];
      vertices[i * 3 + 1] = gm.vertProperties[i * np + 1];
      vertices[i * 3 + 2] = gm.vertProperties[i * np + 2];
    }
  }
  return { vertices, triangles: new Uint32Array(gm.triVerts) };
}

/** Our Mesh -> a manifold solid (merging coincident vertices so unwelded soup still closes). */
function meshToManifold(wasm: ManifoldToplevel, mesh: Mesh): ManifoldT {
  const m = new wasm.Mesh({ numProp: 3, vertProperties: mesh.vertices, triVerts: mesh.triangles });
  m.merge();
  return wasm.Manifold.ofMesh(m);
}

/**
 * One skin per painted face, in `model` coordinates (the re-oriented model): the face's planar region extruded
 * 1 mm inward along -normal and 0.05 mm outward. Colors are clamped to `ncolors - 1`. Faces whose triangles no
 * longer exist (stale) are skipped.
 */
export function buildFaceSkins(
  wasm: ManifoldToplevel,
  model: Model,
  faces: PaintedFace[],
  ncolors: number,
): FaceSkin[] {
  const { CrossSection, Manifold } = wasm;
  const out: FaceSkin[] = [];

  for (const face of faces) {
    const obj = model.objects[face.objectIndex];
    const part = obj?.parts[face.partIndex];
    if (!part || !face.triangles.length) continue; // stale object/part
    const mesh = part.mesh;
    const v = mesh.vertices;
    const nt = mesh.triangles.length / 3;
    if (face.triangles.some((i) => i < 0 || i >= nt)) continue; // stale triangle indices

    // area-weighted outward normal of the face
    let nx = 0, ny = 0, nz = 0;
    for (const tri of face.triangles) {
      const { n, area } = triNormal(mesh, tri);
      nx += n[0] * area; ny += n[1] * area; nz += n[2] * area;
    }
    const nlen = Math.hypot(nx, ny, nz);
    if (nlen < 1e-12) continue; // degenerate region
    const n: Vec3 = [nx / nlen, ny / nlen, nz / nlen];
    const { e1, e2 } = planeBasis(n);

    // project each triangle into (e1, e2), orient CCW, and track the area-weighted face-plane offset d = mean n·p
    const polys: [number, number][][] = [];
    let d = 0, areaSum = 0;
    for (const tri of face.triangles) {
      const a = mesh.triangles[tri * 3] * 3, b = mesh.triangles[tri * 3 + 1] * 3, c = mesh.triangles[tri * 3 + 2] * 3;
      const pa: Vec3 = [v[a], v[a + 1], v[a + 2]];
      const pb: Vec3 = [v[b], v[b + 1], v[b + 2]];
      const pc: Vec3 = [v[c], v[c + 1], v[c + 2]];
      const ua = pa[0] * e1[0] + pa[1] * e1[1] + pa[2] * e1[2], va = pa[0] * e2[0] + pa[1] * e2[1] + pa[2] * e2[2];
      const ub = pb[0] * e1[0] + pb[1] * e1[1] + pb[2] * e1[2], vb = pb[0] * e2[0] + pb[1] * e2[1] + pb[2] * e2[2];
      const uc = pc[0] * e1[0] + pc[1] * e1[1] + pc[2] * e1[2], vc = pc[0] * e2[0] + pc[1] * e2[1] + pc[2] * e2[2];
      const sa = (ub - ua) * (vc - va) - (uc - ua) * (vb - va); // 2x signed area
      if (sa === 0) continue; // degenerate triangle
      polys.push(sa > 0 ? [[ua, va], [ub, vb], [uc, vc]] : [[ua, va], [uc, vc], [ub, vb]]);
      // area-weighted plane offset using the 3D triangle area and its centroid
      const { area } = triNormal(mesh, tri);
      const cw = ((pa[0] + pb[0] + pc[0]) * n[0] + (pa[1] + pb[1] + pc[1]) * n[1] + (pa[2] + pb[2] + pc[2]) * n[2]) / 3;
      d += area * cw; areaSum += area;
    }
    if (!polys.length || areaSum === 0) continue;
    d /= areaSum;

    // union the triangle footprints (Positive winding fuses the shared edges / float cracks), then extrude the
    // slab from 1 mm inward (-n) to 0.05 mm outward (+n) of the face plane, and map (u,v,w) -> xyz.
    const cs = new CrossSection(polys, 'Positive');
    if (cs.isEmpty() || cs.area() <= 0) { cs.delete(); continue; }
    const man = Manifold.extrude(cs, 1.05).translate([0, 0, d - 1.0]);
    const R = [e1[0], e2[0], n[0], e1[1], e2[1], n[1], e1[2], e2[2], n[2]];
    const mesh3d = manifoldToMesh(man, R);
    cs.delete(); man.delete();

    out.push({
      faceId: face.id,
      objectIndex: face.objectIndex,
      partIndex: face.partIndex,
      color: Math.min(face.color, ncolors - 1),
      mesh: mesh3d,
    });
  }
  return out;
}

/**
 * Returns regions whose camo modifiers (mesh, objectMeshes[j], partMeshes[j][k]) have the skins subtracted, so
 * a painted face is solid in its own color with no ambiguity. Input regions are not mutated.
 */
export function subtractSkins(
  wasm: ManifoldToplevel,
  regions: ColorRegion[],
  skins: FaceSkin[],
): ColorRegion[] {
  if (!skins.length) return regions;

  // one manifold per skin (in model xyz); indices grouped by scope for per-object / per-part cuts
  const skinMans = skins.map((s) => meshToManifold(wasm, s.mesh));
  const allIdx = skins.map((_, i) => i);

  /** mesh minus the listed skins; null when nothing survives (or the input was null). */
  const cut = (mesh: Mesh | null, idx: number[]): Mesh | null => {
    if (!mesh) return null;
    if (!idx.length) return mesh; // no skin touches this scope — reuse (the pipeline deep-copies downstream)
    let cur = meshToManifold(wasm, mesh);
    for (const i of idx) {
      const next = cur.subtract(skinMans[i]);
      cur.delete();
      cur = next;
    }
    const out = !cur.isEmpty() && cur.volume() > 1e-9 ? manifoldToMesh(cur) : null;
    cur.delete();
    return out;
  };

  const result = regions.map((r) => ({
    ...r,
    mesh: cut(r.mesh, allIdx),
    objectMeshes: r.objectMeshes
      ? r.objectMeshes.map((m, j) => cut(m, allIdx.filter((i) => skins[i].objectIndex === j)))
      : null,
    partMeshes: r.partMeshes
      ? r.partMeshes.map((o, j) => o.map((m, k) => cut(m, allIdx.filter((i) => skins[i].objectIndex === j && skins[i].partIndex === k))))
      : null,
  }));

  for (const m of skinMans) m.delete();
  return result;
}
