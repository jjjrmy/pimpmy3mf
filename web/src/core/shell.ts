// Pattern depth: clip the color modifiers to an outer shell of the model, or (image mode) split the tile into a
// filament-1 base and per-color caps.
//
// shell(part) = part − erode(part, X). Erosion = minkowskiDifference with an 8-segment ball whose axis-aligned
// half-extents are exactly X, on a simplified copy of the part (minkowski cost grows with triangle count). The
// outer surface of the shell is the original part, so the modifiers' visible boundary stays exact.
import type { ManifoldToplevel, Manifold as ManifoldT } from 'manifold-3d';
import type { ColorRegion, Mesh, Model } from './types';
import { meshFromManifold } from './extrude';

const MAX_ERODE_TRIS = 20_000;

/** Wall time of the last shell (erosion) builds, for scripts. Reset by buildShells on every cache miss. */
export const shellStats = { ms: 0, parts: 0, erodeTris: [] as number[] };

/** Our Mesh -> manifold (merging coincident vertices so unwelded soup still closes). */
export function meshToManifold(wasm: ManifoldToplevel, mesh: Mesh): ManifoldT {
  const m = new wasm.Mesh({ numProp: 3, vertProperties: mesh.vertices, triVerts: mesh.triangles });
  m.merge();
  return wasm.Manifold.ofMesh(m);
}

/** Ball with half-extent exactly `x` along each axis (sphere(1, 8) rescaled per axis by its measured bbox). */
function axisBall(wasm: ManifoldToplevel, x: number): ManifoldT {
  const unit = wasm.Manifold.sphere(1, 8);
  const b = unit.boundingBox();
  const hx = (b.max[0] - b.min[0]) / 2, hy = (b.max[1] - b.min[1]) / 2, hz = (b.max[2] - b.min[2]) / 2;
  const ball = unit.scale([x / hx, x / hy, x / hz]);
  unit.delete();
  return ball;
}

/** One part's shell X mm thick, as a Mesh (null if empty). */
export function partShell(wasm: ManifoldToplevel, mesh: Mesh, x: number): Mesh | null {
  const part = meshToManifold(wasm, mesh);
  if (part.isEmpty()) { part.delete(); return null; }
  let simp = part.simplify(x / 4);
  for (const tol of [x / 2, x]) {
    if (simp.numTri() <= MAX_ERODE_TRIS) break;
    const s2 = part.simplify(tol);
    simp.delete(); simp = s2;
  }
  shellStats.erodeTris.push(simp.numTri());
  const ball = axisBall(wasm, x);
  const eroded = simp.minkowskiDifference(ball);
  simp.delete(); ball.delete();
  const shell = eroded.isEmpty() ? part : part.subtract(eroded);
  const out = !shell.isEmpty() && shell.volume() > 1e-9 ? meshFromManifold(shell) : null;
  if (shell !== part) shell.delete();
  eroded.delete(); part.delete();
  return out;
}

/** Shell cache: per oriented model identity + depth, one Mesh per [object][part]. */
export class ShellCache {
  private model: Model | null = null;
  private depth = -1;
  private shells: (Mesh | null)[][] | null = null;

  /** Cached shells for `model` at depth `x`, or null when they still need building. */
  get(model: Model, x: number): (Mesh | null)[][] | null {
    return this.model === model && this.depth === x ? this.shells : null;
  }

  async build(
    wasm: ManifoldToplevel, model: Model, x: number,
    onPart?: (done: number, total: number) => Promise<void>,
  ): Promise<(Mesh | null)[][]> {
    const hit = this.get(model, x);
    if (hit) return hit;
    const t0 = performance.now();
    shellStats.erodeTris = [];
    const total = model.objects.reduce((s, o) => s + o.parts.length, 0);
    let done = 0;
    const shells: (Mesh | null)[][] = [];
    for (const obj of model.objects) {
      const row: (Mesh | null)[] = [];
      for (const p of obj.parts) {
        if (onPart) await onPart(done, total);
        row.push(partShell(wasm, p.mesh, x));
        done++;
      }
      shells.push(row);
    }
    shellStats.ms = performance.now() - t0; shellStats.parts = total;
    this.model = model; this.depth = x; this.shells = shells;
    return shells;
  }

  clear(): void { this.model = null; this.depth = -1; this.shells = null; }
}

/** Union of meshes as one manifold (caller deletes). null when nothing. */
function unionOf(wasm: ManifoldToplevel, meshes: (Mesh | null)[]): ManifoldT | null {
  const mans = meshes.filter((m): m is Mesh => !!m).map((m) => meshToManifold(wasm, m));
  if (!mans.length) return null;
  if (mans.length === 1) return mans[0];
  const u = wasm.Manifold.union(mans);
  for (const m of mans) m.delete();
  return u;
}

/**
 * Paint mode: every camo modifier ∩ its scope's shell (region.mesh ∩ all shells, objectMeshes[j] ∩ object j's
 * shells, partMeshes[j][k] ∩ shell(j,k)). Intersecting a partition with one solid keeps it a partition.
 */
export function clipRegionsToShells(wasm: ManifoldToplevel, regions: ColorRegion[], shells: (Mesh | null)[][]): ColorRegion[] {
  const all = unionOf(wasm, shells.flat());
  const perObj = shells.map((row) => unionOf(wasm, row));
  const perPart = shells.map((row) => row.map((m) => (m ? meshToManifold(wasm, m) : null)));

  const clip = (mesh: Mesh | null, sh: ManifoldT | null): Mesh | null => {
    if (!mesh || !sh) return null;
    const m = meshToManifold(wasm, mesh);
    const r = m.intersect(sh);
    const out = !r.isEmpty() && r.volume() > 1e-9 ? meshFromManifold(r) : null;
    r.delete(); m.delete();
    return out;
  };

  const out = regions.map((r) => ({
    ...r,
    mesh: clip(r.mesh, all),
    objectMeshes: r.objectMeshes ? r.objectMeshes.map((m, j) => clip(m, perObj[j] ?? null)) : null,
    partMeshes: r.partMeshes ? r.partMeshes.map((o, j) => o.map((m, k) => clip(m, perPart[j]?.[k] ?? null))) : null,
  }));

  all?.delete();
  for (const m of perObj) m?.delete();
  for (const row of perPart) for (const m of row) m?.delete();
  return out;
}

/** A region's output rings (flat, CCW outer / CW holes) as a CrossSection. */
function ringsCs(wasm: ManifoldToplevel, rings: Float32Array[]) {
  const polys: [number, number][][] = [];
  for (const flat of rings) {
    if (flat.length < 6) continue;
    const ring: [number, number][] = [];
    for (let i = 0; i < flat.length; i += 2) ring.push([flat[i], flat[i + 1]]);
    polys.push(ring);
  }
  return polys.length ? new wasm.CrossSection(polys, 'EvenOdd') : null;
}

/**
 * Image mode with depth: base = all colors' footprint z 0..thickness; caps (k >= 1) = footprint k z
 * thickness-depth..thickness; regions[0].mesh = base − ∪ caps. Returns new regions + the base mesh.
 */
export function splitTile(
  wasm: ManifoldToplevel, regions: ColorRegion[], thickness: number, depth: number,
): { regions: ColorRegion[]; base: Mesh | null } {
  const { Manifold, CrossSection } = wasm;
  const css = regions.map((r) => ringsCs(wasm, r.rings));
  const present = css.filter((c): c is NonNullable<typeof c> => !!c);
  if (!present.length) return { regions, base: null };
  const footprint = present.length === 1 ? present[0] : CrossSection.union(present);
  const slab = Manifold.extrude(footprint, thickness);
  const base = meshFromManifold(slab);

  const caps: (ManifoldT | null)[] = css.map((cs, k) =>
    k >= 1 && cs ? Manifold.extrude(cs, depth).translate([0, 0, thickness - depth]) : null);
  const capList = caps.filter((c): c is ManifoldT => !!c);
  let piece0: ManifoldT = slab;
  if (capList.length) {
    const capU = capList.length === 1 ? capList[0] : Manifold.union(capList);
    piece0 = slab.subtract(capU);
    if (capList.length > 1) capU.delete();
  }

  const out = regions.map((r, k) => {
    let mesh: Mesh | null;
    if (k === 0) mesh = !piece0.isEmpty() && piece0.volume() > 1e-9 ? meshFromManifold(piece0) : null;
    else mesh = caps[k] ? meshFromManifold(caps[k]!) : null;
    return { ...r, mesh };
  });

  if (piece0 !== slab) piece0.delete();
  slab.delete();
  for (const c of capList) c.delete();
  if (present.length > 1) footprint.delete();
  for (const c of present) c.delete();
  return { regions: out, base };
}
