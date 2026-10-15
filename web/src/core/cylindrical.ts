// Cylindrical paint-mode geometry. Each color's (u,v) cross-section (after the shared 0.5 µm inset)
// becomes a radial wedge wrapped around `axis`: the frame u = R0·φ maps to an angle, v = height along
// the axis, and the extrusion runs radially from r_min to R0+1. The (u,v) <-> xyz maps come from
// cylinder.ts (CYL_BASIS / cylPoint) so this and the 3D preview shader agree exactly.
//
// Build recipe (keeps triangle counts sane and the walls radially un-refined):
//   1. inset the rings 0.5 µm (same as the planar path) and densify each ring edge in u so no edge
//      spans more than L = R0·Δφ (keeps the lateral color-boundary walls within chord error),
//   2. extrude a THIN slab (height h < L) from the densified polygons,
//   3. refineToLength(L): because the radial edges are h < L they are never split, so only the caps
//      subdivide (smoothing the inner/outer skins) while the walls keep a single radial division,
//   4. warpBatch: z in [0,h] -> r in [r_min, R0+1] linearly (radial lines stay straight, so this is
//      exact) and (u,v,r) -> xyz via cylPoint.
//
// manifold's offset() re-vertexes each color's shared border independently, so after the warp the
// chords of neighbouring colors can cross despite the 0.5 µm inset. To guarantee a true partition we
// subtract incrementally (lower index wins: each wedge minus the union of the earlier wedges) BEFORE
// the xyz crops, so the crops inherit non-overlapping modifiers.
import type { ManifoldToplevel, Manifold as ManifoldT } from 'manifold-3d';
import type { Axis, CylinderFrame, Mesh, Model, Vec3 } from './types';
import { CYL_BASIS, cylPoint } from './cylinder';
import { meshFromManifold, cropToBox, type CropBox, type ExtrudeResult } from './extrude';

type Ring = { x: Float64Array; y: Float64Array };

/**
 * Cylinder frame for a model about `axis` through its bbox center: center, reference radius R0 (the
 * max radial distance of any vertex from the axis), and the axial span [vmin, vmax] = (p-center)·a
 * (symmetric about 0 because center is the bbox center).
 */
export function cylFrame(model: Model, axis: Axis): { center: Vec3; R0: number; vmin: number; vmax: number } {
  let lx = Infinity, ly = Infinity, lz = Infinity, hx = -Infinity, hy = -Infinity, hz = -Infinity;
  for (const obj of model.objects) for (const part of obj.parts) {
    const v = part.mesh.vertices;
    for (let i = 0; i < v.length; i += 3) {
      const x = v[i], y = v[i + 1], z = v[i + 2];
      if (x < lx) lx = x; if (x > hx) hx = x;
      if (y < ly) ly = y; if (y > hy) hy = y;
      if (z < lz) lz = z; if (z > hz) hz = z;
    }
  }
  const center: Vec3 = [(lx + hx) / 2, (ly + hy) / 2, (lz + hz) / 2];
  const a = CYL_BASIS[axis].a;
  let r0sq = 0, vmin = Infinity, vmax = -Infinity;
  for (const obj of model.objects) for (const part of obj.parts) {
    const v = part.mesh.vertices;
    for (let i = 0; i < v.length; i += 3) {
      const dx = v[i] - center[0], dy = v[i + 1] - center[1], dz = v[i + 2] - center[2];
      const axial = dx * a[0] + dy * a[1] + dz * a[2];
      if (axial < vmin) vmin = axial; if (axial > vmax) vmax = axial;
      const perp2 = dx * dx + dy * dy + dz * dz - axial * axial;
      if (perp2 > r0sq) r0sq = perp2;
    }
  }
  const R0 = r0sq > 0 ? Math.sqrt(r0sq) : 1; // all verts on the axis -> avoid a zero-radius frame
  return { center, R0, vmin, vmax };
}

/** Max arc segment angle (rad): chord error ≤ 0.05 mm at r = R0+1, or ≤ 1°, whichever is cheaper. */
function maxSegAngle(R0: number): number {
  const rMax = R0 + 1;
  const c = Math.max(-1, Math.min(1, 1 - 0.05 / rMax));
  return Math.max(2 * Math.acos(c), Math.PI / 180);
}

/** Split each edge of a closed (u,v) polygon so consecutive points differ by ≤ duMax in u. */
function densifyU(poly: [number, number][], duMax: number): [number, number][] {
  const out: [number, number][] = [];
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    const [u0, v0] = poly[i];
    const [u1, v1] = poly[(i + 1) % n];
    out.push([u0, v0]);
    const segs = Math.ceil(Math.abs(u1 - u0) / duMax);
    for (let s = 1; s < segs; s++) {
      const t = s / segs;
      out.push([u0 + (u1 - u0) * t, v0 + (v1 - v0) * t]);
    }
  }
  return out;
}

/** Diagnostics from one wedge build (triangle count before/after refine). */
export interface CylStats { tris: number; refinedTris: number; segAngleDeg: number; L: number; rMin: number; rMax: number }

/**
 * Warp already-inset (u,v) polygons into one color's radial wedge (xyz). Densify the arcs in u, extrude
 * a thin slab, refineToLength so only the caps subdivide, then warp z->r and (u,v,r)->xyz. Returns the
 * Manifold (caller owns/deletes), or null if the polygons are empty. Shared by the pipeline and the
 * validator so "before/after partition" are measured on identical geometry.
 */
export function warpInsetRings(
  wasm: ManifoldToplevel,
  insetPolys: [number, number][][],
  cyl: CylinderFrame,
  statsOut?: CylStats[],
): ManifoldT | null {
  if (insetPolys.length === 0) return null;
  const { Manifold } = wasm;
  const R0 = cyl.R0;
  const rMin = Math.max(1, 0.3 * R0);
  const rMax = R0 + 1;
  const dphi = maxSegAngle(R0);
  const L = R0 * dphi;                                   // target (u,v) edge length
  const h = Math.min(L * 0.25, (rMax - rMin) * 0.5);     // thin slab, < L so refine won't split radially

  const dense: [number, number][][] = insetPolys.map((p) => densifyU(p, L));
  const slab = Manifold.extrude(dense, h);
  const trisBefore = slab.numTri();
  const refined = slab.refineToLength(L);
  slab.delete();
  const trisAfter = refined.numTri();
  const warped = refined.warpBatch((verts: Float64Array, count: number) => {
    for (let i = 0; i < count; i++) {
      const u = verts[i * 3], v = verts[i * 3 + 1], z = verts[i * 3 + 2];
      const r = rMin + (z / h) * (rMax - rMin);
      const p = cylPoint(u, v, r, cyl);
      verts[i * 3] = p[0]; verts[i * 3 + 1] = p[1]; verts[i * 3 + 2] = p[2];
    }
  });
  refined.delete();
  statsOut?.push({ tris: trisBefore, refinedTris: trisAfter, segAngleDeg: dphi * 180 / Math.PI, L, rMin, rMax });
  return warped;
}

/**
 * Make the wedges a true partition: `out[k] = wedges[k] - union(wedges[0..k-1])` (lower index wins).
 * Inputs are NOT deleted; every returned Manifold is fresh, so the caller deletes inputs and outputs
 * independently. Entries that vanish (fully covered by earlier colors) come back null.
 */
export function partitionWedges(wedges: (ManifoldT | null)[]): (ManifoldT | null)[] {
  const out: (ManifoldT | null)[] = new Array(wedges.length).fill(null);
  let accum: ManifoldT | null = null;
  for (let k = 0; k < wedges.length; k++) {
    const w = wedges[k];
    if (!w) continue;
    const t = accum ? w.subtract(accum) : w.translate([0, 0, 0]); // copy so inputs/outputs free cleanly
    if (t.isEmpty()) t.delete(); else out[k] = t;
    const na: ManifoldT = accum ? accum.add(w) : w.translate([0, 0, 0]); // union = instance add()
    if (accum) accum.delete();
    accum = na;
  }
  if (accum) accum.delete();
  return out;
}

/** Convert pipeline rings ({x,y} Float64Arrays) to a (u,v) polygon list, dropping degenerate rings. */
function ringsToPolys(rings: Ring[]): [number, number][][] {
  const polys: [number, number][][] = [];
  for (const r of rings) {
    if (r.x.length < 3) continue;
    const ring: [number, number][] = new Array(r.x.length);
    for (let i = 0; i < r.x.length; i++) ring[i] = [r.x[i], r.y[i]];
    polys.push(ring);
  }
  return polys;
}

/**
 * Build every color's radial wedge modifier from its (u,v) rings, as a true partition (lower index
 * wins), then crop to XYZ boxes. Returns one ExtrudeResult per color (same shape as extrudeRegion).
 * @param cropBoxes   paint mode: per-object XYZ bounding boxes (± margin already applied).
 * @param partCropBoxes paint mode + perPart: per-part XYZ boxes, indexed [objectIndex][partIndex].
 */
export function extrudeRegionsCyl(
  wasm: ManifoldToplevel,
  ringsPerColor: Ring[][],
  cyl: CylinderFrame,
  cropBoxes?: CropBox[] | null,
  partCropBoxes?: CropBox[][] | null,
  statsOut?: CylStats[],
): ExtrudeResult[] {
  const { CrossSection, Manifold } = wasm;
  const n = ringsPerColor.length;
  const emptyParts = () => (partCropBoxes ? partCropBoxes.map((o) => o.map(() => null)) : null);
  const emptyRes = (outRings: Float32Array[], area: number): ExtrudeResult => ({
    mesh: null, rings: outRings, area,
    objectMeshes: cropBoxes ? cropBoxes.map(() => null) : null, partMeshes: emptyParts(),
  });

  const areas = new Array<number>(n).fill(0);
  const outRingsPer: Float32Array[][] = new Array(n);
  const wedges: (ManifoldT | null)[] = new Array(n).fill(null);
  for (let k = 0; k < n; k++) {
    outRingsPer[k] = [];
    const polys = ringsToPolys(ringsPerColor[k]);
    if (polys.length === 0) continue;
    const cs = new CrossSection(polys, 'EvenOdd').offset(-0.0005, 'Miter', 4);
    const area = cs.area();
    if (cs.isEmpty() || area <= 0) { cs.delete(); continue; }
    const insetPolys = cs.toPolygons();
    cs.delete();
    areas[k] = area;
    outRingsPer[k] = insetPolys.map((poly) => {
      const flat = new Float32Array(poly.length * 2);
      for (let i = 0; i < poly.length; i++) { flat[i * 2] = poly[i][0]; flat[i * 2 + 1] = poly[i][1]; }
      return flat;
    });
    wedges[k] = warpInsetRings(wasm, insetPolys, cyl, statsOut);
  }

  // true partition BEFORE the crops, so the crops inherit non-overlapping modifiers
  const parted = partitionWedges(wedges);

  const results: ExtrudeResult[] = new Array(n);
  for (let k = 0; k < n; k++) {
    const man = parted[k];
    if (!man) { results[k] = emptyRes(outRingsPer[k], areas[k]); continue; }
    const mesh = meshFromManifold(man, null);
    let objectMeshes: (Mesh | null)[] | null = null;
    if (cropBoxes) {
      if (cropBoxes.length === 1) objectMeshes = [mesh]; // single object: a Bambu modifier only acts on it
      else objectMeshes = cropBoxes.map((b) => cropToBox(man, b, null, Manifold));
    }
    let partMeshes: (Mesh | null)[][] | null = null;
    if (partCropBoxes) {
      partMeshes = partCropBoxes.map((boxesForObj, j) => {
        if (boxesForObj.length === 1 && objectMeshes) return [objectMeshes[j] ?? null];
        return boxesForObj.map((pb) => cropToBox(man, pb, null, Manifold));
      });
    }
    results[k] = { mesh, rings: outRingsPer[k], area: areas[k], objectMeshes, partMeshes };
  }

  for (const w of wedges) w?.delete();
  for (const t of parted) t?.delete();
  return results;
}
