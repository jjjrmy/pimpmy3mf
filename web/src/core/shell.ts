// Paint depth: clip the color modifiers to an outer shell of the model, or (image mode) split the tile into a
// filament-1 base and per-color caps.
//
// shell(part) = part − erode(part, X) − insideSkin, where erode = minkowskiDifference with an 8-segment ball
// whose axis-aligned half-extents are exactly X, on a simplified copy (minkowski cost grows with triangle
// count). The outer surface of the shell is the original part, so the visible boundary stays exact.
//
// Inside surfaces (bores, cavities, recessed pockets) print in filament 1: openness.ts scores every triangle
// by how much sky it sees and labels the ones under the "what counts as inside" threshold (whole crease patches
// where they're one-sided, otherwise split along a smooth iso-line), and plug.ts builds the solid within reach of
// that surface (and nearer to it than to the outside surface). Subtracting it removes the shell under inside
// faces while outside faces keep the full depth; the color boundary follows the label boundary. At Full depth the shell is the whole
// part minus a FULL_SKIN mm skin under the inside faces. "Paint inside surfaces" skips the labelling.
import type { ManifoldToplevel, Manifold as ManifoldT } from 'manifold-3d';
import type { ColorRegion, Mesh, Model } from './types';
import { meshFromManifold } from './extrude';
import { meshOpenness, hasOpenness, insideAt, insideLabels, insideSurface, type InsideLabels } from './openness';
import { insideSkin, nearField } from './plug';

const MAX_ERODE_TRIS = 20_000;
/** Full depth: at least this much filament 1 lies under inside faces (mm); several wall loops' worth. */
export const FULL_SKIN = 2;
/** Default "what counts as inside" threshold (openness below it = inside). */
export const DEFAULT_INSIDE_THRESHOLD = 0.6;

/** Wall time of the last shell builds, for scripts. Reset by ShellCache.build on every cache miss. */
export const shellStats = { ms: 0, parts: 0, erodeTris: [] as number[], insideMs: 0, skinMs: 0, erodeMs: 0 };

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

/** The part's shell X thick under every face, and the simplify tolerance it used (so the shell can reach up to
 *  X + tol deep). Cached per mesh object and depth: moving the inside threshold doesn't erode again. */
interface Eroded { shell: Mesh | null; tol: number }
const erodeCache = new WeakMap<Mesh, Map<number, Eroded>>();
const ERODE_CACHE_SIZE = 4;

function erodedShell(wasm: ManifoldToplevel, mesh: Mesh, x: number): Eroded {
  let per = erodeCache.get(mesh);
  const hit = per?.get(x);
  if (hit) { per!.delete(x); per!.set(x, hit); return hit; }
  const t0 = performance.now();
  const part = meshToManifold(wasm, mesh);
  let out: Eroded = { shell: null, tol: 0 };
  if (!part.isEmpty()) {
    let tol = x / 4;
    let simp = part.simplify(tol);
    for (const t of [x / 2, x]) {
      if (simp.numTri() <= MAX_ERODE_TRIS) break;
      const s2 = part.simplify(t);
      simp.delete(); simp = s2; tol = t;
    }
    shellStats.erodeTris.push(simp.numTri());
    const ball = axisBall(wasm, x);
    const eroded = simp.minkowskiDifference(ball);
    simp.delete(); ball.delete();
    const shell = eroded.isEmpty() ? part : part.subtract(eroded);
    out = { shell: !shell.isEmpty() && shell.volume() > 1e-9 ? meshFromManifold(shell) : null, tol };
    if (shell !== part) shell.delete();
    eroded.delete();
  }
  part.delete();
  if (!per) { per = new Map(); erodeCache.set(mesh, per); }
  per.set(x, out);
  while (per.size > ERODE_CACHE_SIZE) per.delete(per.keys().next().value!);
  shellStats.erodeMs += performance.now() - t0;
  return out;
}

/** One part's paint-depth shell, and the part's triangles that stay filament 1. */
export interface PartShell {
  /** The solid the color modifiers are clipped to (Full with no inside faces: the part mesh itself). */
  shell: Mesh | null;
  /** Indices into the part mesh's triangles that print in filament 1 (inside surfaces). null = none. */
  inner: Uint32Array | null;
  /** The inside surface itself: whole inside triangles plus the inside pieces of split ones. null = none. */
  innerMesh: Mesh | null;
  /** Inside share of each part triangle's area (split triangles in between). null = none. */
  innerFrac: Float32Array | null;
}

/** The part's inside labels at `threshold` (null = nothing inside). */
export function insideFaces(mesh: Mesh, threshold: number): InsideLabels | null {
  const t0 = performance.now();
  const lab = insideLabels(meshOpenness(mesh), threshold);
  shellStats.insideMs += performance.now() - t0;
  return lab.tri.some((m) => m !== 0) ? lab : null;
}

/** Inside share of each triangle's area at `threshold` (scripts: agreement with reference labels). */
export function insideFraction(mesh: Mesh, threshold: number): Float32Array {
  return insideLabels(meshOpenness(mesh), threshold).frac;
}

/**
 * One part's shell X mm thick, as a Mesh (null if empty). Only the outer surfaces are shelled unless
 * `paintInside`, which shells the hole and cavity walls too.
 */
export function partShell(wasm: ManifoldToplevel, mesh: Mesh, x: number, paintInside = false, threshold = DEFAULT_INSIDE_THRESHOLD): Mesh | null {
  return partShellInfo(wasm, mesh, x, paintInside, threshold).shell;
}

/** `x` null = Full depth: the whole part, minus a skin under the inside faces. */
export function partShellInfo(
  wasm: ManifoldToplevel, mesh: Mesh, x: number | null, paintInside = false, threshold = DEFAULT_INSIDE_THRESHOLD,
): PartShell {
  const lab = paintInside ? null : insideFaces(mesh, threshold);
  const base = x == null ? { shell: mesh, tol: 0 } : erodedShell(wasm, mesh, x);
  if (!lab || !base.shell) return { shell: base.shell, inner: null, innerMesh: null, innerFrac: null };
  const inner: number[] = [];
  for (let f = 0; f < lab.tri.length; f++) if (lab.tri[f] === 1) inner.push(f);
  const t0 = performance.now();
  const o = meshOpenness(mesh);
  const innerMesh = insideSurface(mesh, o, lab);
  const reach = x == null ? FULL_SKIN : x + base.tol;
  let field = nearField(mesh, Math.max(reach + 1, FULL_SKIN + 1.5));
  // the skin's inner limit sits within about a cell of the true distance: one cell of margin covers the shell
  const r = x == null ? FULL_SKIN + field.h / 2 : reach + field.h;
  if (r > field.radius) field = nearField(mesh, r);
  const sIn = new Uint8Array(field.sTri.length);
  for (let s = 0; s < sIn.length; s++) sIn[s] = insideAt(o, lab, field.sTri[s], field.sU[s], field.sV[s]) ? 1 : 0;
  const skin = insideSkin(wasm, field, sIn, r);
  let out: Mesh | null = base.shell;
  if (skin) {
    const sh = meshToManifold(wasm, base.shell);
    const cut = sh.subtract(skin);
    out = !cut.isEmpty() && cut.volume() > 1e-9 ? meshFromManifold(cut) : null;
    cut.delete(); sh.delete(); skin.delete();
  }
  shellStats.skinMs += performance.now() - t0;
  return { shell: out, inner: Uint32Array.from(inner), innerMesh, innerFrac: lab.frac };
}

/** How many (depth, inside) settings stay cached per model, so stepping back to a recent one is instant. */
const SHELL_CACHE_SIZE = 4;

/** One build: per [object][part], the shell and the inside triangles. */
export interface ShellSet {
  shells: (Mesh | null)[][];
  inner: (Uint32Array | null)[][];
  innerMesh: (Mesh | null)[][];
}

type ShellProgress = (stage: 'inside' | 'shell', done: number, total: number) => Promise<void>;

/** Shell cache: per oriented model identity, the last few (depth, paintInside, threshold) builds. */
export class ShellCache {
  private model: Model | null = null;
  private entries = new Map<string, ShellSet>();

  private static key(x: number | null, paintInside: boolean, threshold: number): string {
    return `${x ?? 'F'}|${paintInside ? 'in' : `out:${threshold}`}`;
  }

  /** Cached shells for `model` at depth `x` (null = Full), or null when they still need building. */
  get(model: Model, x: number | null, paintInside = false, threshold = DEFAULT_INSIDE_THRESHOLD): ShellSet | null {
    if (this.model !== model) return null;
    const k = ShellCache.key(x, paintInside, threshold);
    const hit = this.entries.get(k);
    if (!hit) return null;
    this.entries.delete(k); this.entries.set(k, hit); // most recent last
    return hit;
  }

  async build(
    wasm: ManifoldToplevel, model: Model, x: number | null, paintInside = false, threshold = DEFAULT_INSIDE_THRESHOLD,
    onProgress?: ShellProgress,
  ): Promise<ShellSet> {
    const hit = this.get(model, x, paintInside, threshold);
    if (hit) return hit;
    const t0 = performance.now();
    shellStats.erodeTris = []; shellStats.insideMs = 0; shellStats.skinMs = 0; shellStats.erodeMs = 0;
    const total = model.objects.reduce((s, o) => s + o.parts.length, 0);
    let done = 0;
    const set: ShellSet = { shells: [], inner: [], innerMesh: [] };
    for (const obj of model.objects) {
      const row: (Mesh | null)[] = [];
      const innerRow: (Uint32Array | null)[] = [];
      const meshRow: (Mesh | null)[] = [];
      for (const p of obj.parts) {
        if (onProgress && !paintInside && !hasOpenness(p.mesh)) await onProgress('inside', done, total);
        if (onProgress) await onProgress('shell', done, total);
        const info = partShellInfo(wasm, p.mesh, x, paintInside, threshold);
        row.push(info.shell);
        innerRow.push(info.inner);
        meshRow.push(info.innerMesh);
        done++;
      }
      set.shells.push(row);
      set.inner.push(innerRow);
      set.innerMesh.push(meshRow);
    }
    shellStats.ms = performance.now() - t0; shellStats.parts = total;
    if (this.model !== model) { this.model = model; this.entries.clear(); }
    this.entries.set(ShellCache.key(x, paintInside, threshold), set);
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
