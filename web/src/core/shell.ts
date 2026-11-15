// Paint depth: clip the color modifiers to an outer shell of the model, or (image mode) split the tile into a
// filament-1 base and per-color caps.
//
// shell(part) = part − erode(E, X), where E is the part's outer envelope: the part with its holes plugged
// (bores, through-holes, blind holes, sealed cavities), so the shell hugs only the outside surfaces and those
// holes print in filament 1. With "paint inside surfaces" E is the part itself. Erosion = minkowskiDifference
// with an 8-segment ball whose axis-aligned half-extents are exactly X, on a simplified copy (minkowski cost
// grows with triangle count). The outer surface of the shell is the original part, so the visible boundary
// stays exact.
//
// Holes: the empty space inside the part's convex hull (hull − part), split into connected pockets. A pocket
// is a hole when the area it opens onto the hull (its mouth) is under HOLE_MOUTH_RATIO of the area it shares
// with the part (its walls): a bore 15 mm in radius and 60 mm long is 0.25, a blind hole 0.2, a sealed
// cavity 0
import type { ManifoldToplevel, Manifold as ManifoldT } from 'manifold-3d';
import type { ColorRegion, Mesh, Model } from './types';
import { meshFromManifold } from './extrude';

const MAX_ERODE_TRIS = 20_000;
/** A pocket of hull − part is a hole (no camo inside) when mouth area < this × wall area. An open L corner or a
 *  finger groove is ~0.6–0.9, so those stay outside surfaces and keep their camo. */
const HOLE_MOUTH_RATIO = 0.5;

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

/** Summed triangle area of a manifold mesh, split by the original mesh each triangle run came from. */
function areaByOrigin(m: ManifoldT): Map<number, number> {
  const mesh = m.getMesh();
  const { vertProperties: v, triVerts: t, numProp } = mesh;
  const runIndex = mesh.runIndex ?? new Uint32Array([0, t.length]);
  const runId = mesh.runOriginalID ?? new Uint32Array([0]);
  const out = new Map<number, number>();
  for (let r = 0; r < runId.length; r++) {
    let a = 0;
    for (let i = runIndex[r]; i < runIndex[r + 1]; i += 3) {
      const p = t[i] * numProp, q = t[i + 1] * numProp, w = t[i + 2] * numProp;
      const ux = v[q] - v[p], uy = v[q + 1] - v[p + 1], uz = v[q + 2] - v[p + 2];
      const wx = v[w] - v[p], wy = v[w + 1] - v[p + 1], wz = v[w + 2] - v[p + 2];
      const cx = uy * wz - uz * wy, cy = uz * wx - ux * wz, cz = ux * wy - uy * wx;
      a += Math.sqrt(cx * cx + cy * cy + cz * cz) / 2;
    }
    out.set(runId[r], (out.get(runId[r]) ?? 0) + a);
  }
  return out;
}

/** Our Mesh -> manifold whose triangles carry their index in `mesh` as faceID, under a fresh original ID, so
 *  boolean results can be traced back to the part's own triangles. */
function taggedManifold(wasm: ManifoldToplevel, mesh: Mesh): { man: ManifoldT; id: number } {
  const id = wasm.Manifold.reserveIDs(1);
  const nTri = mesh.triangles.length / 3;
  const faceID = new Uint32Array(nTri);
  for (let i = 0; i < nTri; i++) faceID[i] = i;
  const m = new wasm.Mesh({
    numProp: 3, vertProperties: mesh.vertices, triVerts: mesh.triangles,
    runIndex: new Uint32Array([0, mesh.triangles.length]), runOriginalID: new Uint32Array([id]), faceID,
  });
  m.merge();
  return { man: wasm.Manifold.ofMesh(m), id };
}

/**
 * Holes and cavities in the part, judged against its convex hull (caller deletes `holes`). `walls` are the
 * indices of the part's triangles that line them (only when the part was built by taggedManifold with `pid`).
 */
export function partHoles(wasm: ManifoldToplevel, part: ManifoldT, pid?: number): { holes: ManifoldT[]; walls: Set<number> } {
  const P = pid == null ? part.asOriginal() : part;
  const partId = pid ?? P.originalID();
  const H = part.hull().asOriginal();
  const hid = H.originalID();
  const voids = H.subtract(P);
  H.delete();
  if (P !== part) P.delete();
  const walls = new Set<number>();
  if (voids.isEmpty()) { voids.delete(); return { holes: [], walls }; }
  const pockets = voids.decompose();
  voids.delete();
  const holes: ManifoldT[] = [];
  for (const c of pockets) {
    const areas = areaByOrigin(c);
    const mouth = areas.get(hid) ?? 0, wallArea = areas.get(partId) ?? 0;
    if (wallArea > 0 && mouth < HOLE_MOUTH_RATIO * wallArea && c.volume() > 1e-6) {
      holes.push(c);
      if (pid != null) {
        const mesh = c.getMesh();
        const runIndex = mesh.runIndex, runId = mesh.runOriginalID, faceID = mesh.faceID;
        if (runIndex && runId && faceID) {
          for (let r = 0; r < runId.length; r++) {
            if (runId[r] !== pid) continue;
            for (let i = runIndex[r]; i < runIndex[r + 1]; i += 3) walls.add(faceID[i / 3]);
          }
        }
      }
    } else c.delete();
  }
  void wasm;
  return { holes, walls };
}

/** The part with its holes plugged (caller deletes; null when it has none) and the part triangles that line them. */
function outerEnvelope(wasm: ManifoldToplevel, part: ManifoldT, pid: number): { env: ManifoldT | null; walls: Set<number> } {
  const { holes, walls } = partHoles(wasm, part, pid);
  if (!holes.length) return { env: null, walls };
  const env = wasm.Manifold.union([part, ...holes]);
  for (const h of holes) h.delete();
  return { env, walls };
}

/** One part's paint-depth shell, and (outside-only shells) the part's triangles that line its holes. */
export interface PartShell {
  shell: Mesh | null;
  /** Indices into the part mesh's triangles that print in filament 1 (hole / cavity walls). null = none. */
  inner: Uint32Array | null;
}

/**
 * One part's shell X mm thick, as a Mesh (null if empty). Only the outer surfaces are shelled unless
 * `paintInside`, which shells the hole and cavity walls too.
 */
export function partShell(wasm: ManifoldToplevel, mesh: Mesh, x: number, paintInside = false): Mesh | null {
  return partShellInfo(wasm, mesh, x, paintInside).shell;
}

export function partShellInfo(wasm: ManifoldToplevel, mesh: Mesh, x: number, paintInside = false): PartShell {
  const { man: part, id } = taggedManifold(wasm, mesh);
  if (part.isEmpty()) { part.delete(); return { shell: null, inner: null }; }
  const { env, walls } = paintInside ? { env: null, walls: new Set<number>() } : outerEnvelope(wasm, part, id);
  const inner = walls.size ? Uint32Array.from([...walls].sort((a, b) => a - b)) : null;
  // per-triangle faceIDs (for tracing hole walls) would stop simplify() from merging anything: erode a copy
  // without them
  const src = (env ?? part).asOriginal();
  let simp = src.simplify(x / 4);
  for (const tol of [x / 2, x]) {
    if (simp.numTri() <= MAX_ERODE_TRIS) break;
    const s2 = src.simplify(tol);
    simp.delete(); simp = s2;
  }
  src.delete();
  env?.delete();
  shellStats.erodeTris.push(simp.numTri());
  const ball = axisBall(wasm, x);
  const eroded = simp.minkowskiDifference(ball);
  simp.delete(); ball.delete();
  const shell = eroded.isEmpty() ? part : part.subtract(eroded);
  const out = !shell.isEmpty() && shell.volume() > 1e-9 ? meshFromManifold(shell) : null;
  if (shell !== part) shell.delete();
  eroded.delete(); part.delete();
  return { shell: out, inner };
}

/** How many depth settings stay cached per model, so stepping back to a recent depth is instant. */
const SHELL_CACHE_SIZE = 4;

/** One build: per [object][part], the shell and the hole-wall triangles. */
export interface ShellSet {
  shells: (Mesh | null)[][];
  inner: (Uint32Array | null)[][];
}

/** Shell cache: per oriented model identity, the last few (depth, paintInside) builds. */
export class ShellCache {
  private model: Model | null = null;
  private entries = new Map<string, ShellSet>();

  private static key(x: number, paintInside: boolean): string {
    return `${x}|${paintInside ? 'in' : 'out'}`;
  }

  /** Cached shells for `model` at depth `x`, or null when they still need building. */
  get(model: Model, x: number, paintInside = false): ShellSet | null {
    if (this.model !== model) return null;
    const k = ShellCache.key(x, paintInside);
    const hit = this.entries.get(k);
    if (!hit) return null;
    this.entries.delete(k); this.entries.set(k, hit); // most recent last
    return hit;
  }

  async build(
    wasm: ManifoldToplevel, model: Model, x: number, paintInside = false,
    onPart?: (done: number, total: number) => Promise<void>,
  ): Promise<ShellSet> {
    const hit = this.get(model, x, paintInside);
    if (hit) return hit;
    const t0 = performance.now();
    shellStats.erodeTris = [];
    const total = model.objects.reduce((s, o) => s + o.parts.length, 0);
    let done = 0;
    const set: ShellSet = { shells: [], inner: [] };
    for (const obj of model.objects) {
      const row: (Mesh | null)[] = [];
      const innerRow: (Uint32Array | null)[] = [];
      for (const p of obj.parts) {
        if (onPart) await onPart(done, total);
        const info = partShellInfo(wasm, p.mesh, x, paintInside);
        row.push(info.shell);
        innerRow.push(info.inner);
        done++;
      }
      set.shells.push(row);
      set.inner.push(innerRow);
    }
    shellStats.ms = performance.now() - t0; shellStats.parts = total;
    if (this.model !== model) { this.model = model; this.entries.clear(); }
    this.entries.set(ShellCache.key(x, paintInside), set);
    while (this.entries.size > SHELL_CACHE_SIZE) this.entries.delete(this.entries.keys().next().value!);
    return set;
  }

  clear(): void { this.model = null; this.entries.clear(); }
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
