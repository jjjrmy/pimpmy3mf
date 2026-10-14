// Extrude per-color rings into watertight prisms via manifold-3d.
// Ports img2color.py `extrude`: EvenOdd cross-section, a mandatory 0.5 µm inset (splits same-color
// blobs that touch only at a corner, which would otherwise be a non-manifold edge), then extrude.
// Paint mode also crops the prism to each model object's bbox (a Bambu modifier only acts on its
// own object), done in uvw space then mapped to xyz.
import type { ManifoldToplevel, Manifold as ManifoldT } from 'manifold-3d';
import type { Mesh } from './types';

export interface CropBox { min: [number, number, number]; max: [number, number, number] } // uvw space

export interface ExtrudeResult {
  mesh: Mesh | null;
  /** toPolygons() of the offset cross-section (uv/frame plane), CCW outer / CW holes. */
  rings: Float32Array[];
  /** cross-section area in mm². */
  area: number;
  /** Paint mode: the prism cropped to each cropBox (same order), null where nothing survived. */
  objectMeshes: (Mesh | null)[] | null;
  /** Paint mode + perPart: the prism cropped to each part box, indexed [objectIndex][partIndex]. */
  partMeshes: (Mesh | null)[][] | null;
}

type Ring = { x: Float64Array; y: Float64Array };

/** getMesh + map the (u,v,w) vertices back to xyz via R (row-major 3x3) or identity. */
function meshFromManifold(man: ManifoldT, R?: number[] | null): Mesh {
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

/** Intersect the prism with one uvw box and return the cropped mesh (mapped to xyz by R), or null. */
function cropToBox(man: ManifoldT, b: CropBox, R: number[] | null | undefined, Manifold: ManifoldToplevel['Manifold']): Mesh | null {
  const dx = b.max[0] - b.min[0], dy = b.max[1] - b.min[1], dz = b.max[2] - b.min[2];
  if (dx <= 0 || dy <= 0 || dz <= 0) return null;
  const cube = Manifold.cube([dx, dy, dz], false).translate([b.min[0], b.min[1], b.min[2]]);
  const crop = man.intersect(cube);
  let out: Mesh | null = null;
  if (!crop.isEmpty() && crop.volume() > 1e-9) out = meshFromManifold(crop, R);
  crop.delete(); cube.delete();
  return out;
}

/**
 * @param R optional 3x3 row-major matrix mapping the extruded (u,v,w) vertices back to model xyz
 *          (paint mode: xyz = R·uvw). Omit in image mode.
 * @param cropBoxes paint mode: per-object uvw bounding boxes (± margin already applied). The prism is
 *          intersected with each; with one box the uncropped prism is reused (no boolean).
 * @param partCropBoxes paint mode + perPart: per-part uvw boxes, indexed [objectIndex][partIndex]. A
 *          single-part object reuses its object crop (no extra boolean).
 */
export function extrudeRegion(
  wasm: ManifoldToplevel,
  rings: Ring[],
  height: number,
  z0: number,
  R?: number[] | null,
  cropBoxes?: CropBox[] | null,
  partCropBoxes?: CropBox[][] | null,
): ExtrudeResult {
  const { CrossSection, Manifold } = wasm;
  const emptyParts = () => (partCropBoxes ? partCropBoxes.map((o) => o.map(() => null)) : null);
  const polys: [number, number][][] = [];
  for (const r of rings) {
    if (r.x.length < 3) continue;
    const ring: [number, number][] = new Array(r.x.length);
    for (let i = 0; i < r.x.length; i++) ring[i] = [r.x[i], r.y[i]];
    polys.push(ring);
  }
  if (polys.length === 0) {
    return { mesh: null, rings: [], area: 0, objectMeshes: cropBoxes ? cropBoxes.map(() => null) : null, partMeshes: emptyParts() };
  }

  const cs = new CrossSection(polys, 'EvenOdd').offset(-0.0005, 'Miter', 4);
  const area = cs.area();
  if (cs.isEmpty() || area <= 0) {
    cs.delete();
    return { mesh: null, rings: [], area: 0, objectMeshes: cropBoxes ? cropBoxes.map(() => null) : null, partMeshes: emptyParts() };
  }

  const outPolys = cs.toPolygons();
  const outRings: Float32Array[] = outPolys.map((poly) => {
    const flat = new Float32Array(poly.length * 2);
    for (let i = 0; i < poly.length; i++) { flat[i * 2] = poly[i][0]; flat[i * 2 + 1] = poly[i][1]; }
    return flat;
  });

  const man = Manifold.extrude(cs, height).translate([0, 0, z0]);
  const mesh = meshFromManifold(man, R);

  let objectMeshes: (Mesh | null)[] | null = null;
  if (cropBoxes) {
    if (cropBoxes.length === 1) {
      objectMeshes = [mesh]; // single object: the uncropped prism is the crop
    } else {
      objectMeshes = cropBoxes.map((b) => cropToBox(man, b, R, Manifold));
    }
  }

  let partMeshes: (Mesh | null)[][] | null = null;
  if (partCropBoxes) {
    partMeshes = partCropBoxes.map((boxesForObj, j) => {
      // a single-part object: its part box equals its object box -> reuse the object crop
      if (boxesForObj.length === 1 && objectMeshes) return [objectMeshes[j] ?? null];
      return boxesForObj.map((pb) => cropToBox(man, pb, R, Manifold));
    });
  }

  cs.delete(); man.delete();
  return { mesh, rings: outRings, area, objectMeshes, partMeshes };
}
