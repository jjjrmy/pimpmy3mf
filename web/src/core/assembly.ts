// Assemble mode: several loaded model files placed by rigid transforms, composed into the one Model the pipeline
// paints and exports. Also the face-to-face mate solver (ported from BuildBench's solveMate / seatStart). Pure: no
// DOM, no worker, so the worker, the UI and the headless scripts share it.
import { IDENTITY3, mulMat3 } from './faces';
import type { Mesh, Model, Vec3 } from './types';

/** Rigid motion x' = R·x + t, R row-major 3x3. */
export interface Rigid {
  R: number[];
  t: Vec3;
}

export interface AssemblyItem {
  id: string;
  fileName: string;
  /** The file as loaded (its own world coordinates). */
  model: Model;
  /** Placement of the file in assembly space. */
  transform: Rigid;
}

/** Where one composed part came from: the item and its object / part index inside that file. */
export interface PartSource {
  itemId: string;
  object: number;
  part: number;
}

export interface ComposedAssembly {
  model: Model;
  /** Aligned with model.objects[j].parts[k]. */
  sources: PartSource[][];
  /** Flattened part order (only meaningful for the single "Assembly" object): part index -> item index. */
  partItem: number[];
}

export const IDENTITY_RIGID: Rigid = { R: IDENTITY3.slice(), t: [0, 0, 0] };

// ---- small vector helpers --------------------------------------------------------------------

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
function normalize(a: Vec3): Vec3 | null {
  const l = Math.hypot(a[0], a[1], a[2]);
  return l > 1e-12 ? [a[0] / l, a[1] / l, a[2] / l] : null;
}
/** A unit vector perpendicular to unit n. */
function perpendicular(n: Vec3): Vec3 {
  const ax = Math.abs(n[0]), ay = Math.abs(n[1]), az = Math.abs(n[2]);
  const other: Vec3 = ax <= ay && ax <= az ? [1, 0, 0] : ay <= az ? [0, 1, 0] : [0, 0, 1];
  return normalize(cross(n, other))!;
}

export function applyRigid(m: Rigid, p: Vec3): Vec3 {
  const R = m.R;
  return [
    R[0] * p[0] + R[1] * p[1] + R[2] * p[2] + m.t[0],
    R[3] * p[0] + R[4] * p[1] + R[5] * p[2] + m.t[1],
    R[6] * p[0] + R[7] * p[1] + R[8] * p[2] + m.t[2],
  ];
}
function rotate(R: number[], p: Vec3): Vec3 {
  return [R[0] * p[0] + R[1] * p[1] + R[2] * p[2], R[3] * p[0] + R[4] * p[1] + R[5] * p[2], R[6] * p[0] + R[7] * p[1] + R[8] * p[2]];
}

/** a∘b: apply b first, then a. */
export function composeRigid(a: Rigid, b: Rigid): Rigid {
  return { R: mulMat3(a.R, b.R), t: add(rotate(a.R, b.t), a.t) };
}

export function invertRigid(m: Rigid): Rigid {
  const R = m.R;
  const Rt = [R[0], R[3], R[6], R[1], R[4], R[7], R[2], R[5], R[8]];
  return { R: Rt, t: scale(rotate(Rt, m.t), -1) };
}

/** Rotation by `angle` radians about unit axis k (Rodrigues), row-major. */
export function axisAngle(k: Vec3, angle: number): number[] {
  const c = Math.cos(angle), s = Math.sin(angle), t = 1 - c;
  const [x, y, z] = k;
  return [
    t * x * x + c, t * x * y - s * z, t * x * z + s * y,
    t * x * y + s * z, t * y * y + c, t * y * z - s * x,
    t * x * z - s * y, t * y * z + s * x, t * z * z + c,
  ];
}

/** Shortest rotation taking unit a onto unit b (180° about a perpendicular when antiparallel). */
export function rotationFromTo(a: Vec3, b: Vec3): number[] {
  const c = Math.max(-1, Math.min(1, dot(a, b)));
  if (c > 1 - 1e-12) return IDENTITY3.slice();
  if (c < -1 + 1e-12) return axisAngle(perpendicular(a), Math.PI);
  const k = normalize(cross(a, b))!;
  return axisAngle(k, Math.acos(c));
}

// ---- composition -----------------------------------------------------------------------------

function transformMesh(mesh: Mesh, m: Rigid): Mesh {
  const v = mesh.vertices;
  const R = m.R, t = m.t;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i += 3) {
    const x = v[i], y = v[i + 1], z = v[i + 2];
    out[i] = R[0] * x + R[1] * y + R[2] * z + t[0];
    out[i + 1] = R[3] * x + R[4] * y + R[5] * z + t[1];
    out[i + 2] = R[6] * x + R[7] * y + R[8] * z + t[2];
  }
  return { vertices: out, triangles: mesh.triangles };
}

const isIdentity = (m: Rigid) => m.t.every((x) => x === 0) && m.R.every((x, i) => x === IDENTITY3[i]);

/**
 * The model the pipeline sees. One item keeps its file's own object / part structure (exactly what a single
 * upload always gave). Two or more become ONE object named "Assembly" whose parts are every item's parts in item
 * order, each placed by its item's transform. Part names: the file name, or "file / part" when a file has several.
 * `skip` leaves items out (their parts are omitted, so later part indices shift).
 */
export function composeAssembly(items: AssemblyItem[], skip?: Set<string>): ComposedAssembly {
  const used = skip ? items.filter((it) => !skip.has(it.id)) : items;
  if (used.length === 1) {
    const it = used[0];
    const ident = isIdentity(it.transform);
    return {
      model: {
        objects: it.model.objects.map((o) => ({
          name: o.name,
          parts: o.parts.map((p) => ({ name: p.name, mesh: ident ? p.mesh : transformMesh(p.mesh, it.transform) })),
        })),
        // build plates only hold while the file sits where it was loaded (a moved file no longer lines up)
        ...(it.model.plates && ident ? { plates: it.model.plates } : {}),
      },
      sources: it.model.objects.map((o, j) => o.parts.map((_, k) => ({ itemId: it.id, object: j, part: k }))),
      partItem: it.model.objects.flatMap((o) => o.parts.map(() => items.indexOf(it))),
    };
  }
  const parts: Model['objects'][number]['parts'] = [];
  const sources: PartSource[] = [];
  const partItem: number[] = [];
  for (const it of used) {
    const total = it.model.objects.reduce((n, o) => n + o.parts.length, 0);
    it.model.objects.forEach((o, j) =>
      o.parts.forEach((p, k) => {
        parts.push({ name: total > 1 ? `${it.fileName} / ${p.name}` : it.fileName, mesh: transformMesh(p.mesh, it.transform) });
        sources.push({ itemId: it.id, object: j, part: k });
        partItem.push(items.indexOf(it));
      }),
    );
  }
  return { model: { objects: parts.length ? [{ name: 'Assembly', parts }] : [] }, sources: parts.length ? [sources] : [], partItem };
}

export interface Bbox {
  min: Vec3;
  max: Vec3;
}

export function modelBbox(model: Model, m?: Rigid): Bbox | null {
  const min: Vec3 = [Infinity, Infinity, Infinity], max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const o of model.objects)
    for (const p of o.parts) {
      const v = p.mesh.vertices;
      for (let i = 0; i < v.length; i += 3) {
        const q: Vec3 = m ? applyRigid(m, [v[i], v[i + 1], v[i + 2]]) : [v[i], v[i + 1], v[i + 2]];
        for (let a = 0; a < 3; a++) {
          if (q[a] < min[a]) min[a] = q[a];
          if (q[a] > max[a]) max[a] = q[a];
        }
      }
    }
  return min[0] <= max[0] ? { min, max } : null;
}

/**
 * Placement for a newly added file: beside the current assembly along +X with `gap` mm between bboxes, its min z on
 * the assembly's min z, Y centred on the assembly. The first file keeps its own coordinates.
 */
export function placeBeside(existing: AssemblyItem[], model: Model, gap = 10): Rigid {
  let asm: Bbox | null = null;
  for (const it of existing) {
    const b = modelBbox(it.model, it.transform);
    if (!b) continue;
    if (!asm) asm = { min: [...b.min] as Vec3, max: [...b.max] as Vec3 };
    else for (let a = 0; a < 3; a++) { asm.min[a] = Math.min(asm.min[a], b.min[a]); asm.max[a] = Math.max(asm.max[a], b.max[a]); }
  }
  const own = modelBbox(model);
  if (!asm || !own) return { R: IDENTITY3.slice(), t: [0, 0, 0] };
  return {
    R: IDENTITY3.slice(),
    t: [
      asm.max[0] + gap - own.min[0],
      (asm.min[1] + asm.max[1]) / 2 - (own.min[1] + own.max[1]) / 2,
      asm.min[2] - own.min[2],
    ],
  };
}

// ---- face regions ----------------------------------------------------------------------------

export interface FaceFeature {
  /** Unit outward normal. */
  normal: Vec3;
  /** Area-weighted centroid. */
  centroid: Vec3;
  /** Region vertices, deduplicated (for the in-plane principal direction). */
  points: Vec3[];
}

/** Normal / centroid / points of some triangles of a mesh, in the mesh's coordinates. Null when degenerate. */
export function faceFeature(mesh: Mesh, triangles: number[]): FaceFeature | null {
  const v = mesh.vertices, t = mesh.triangles;
  let nx = 0, ny = 0, nz = 0, cx = 0, cy = 0, cz = 0, area = 0;
  const points: Vec3[] = [];
  const seen = new Set<string>();
  const keep = (P: Vec3) => {
    const k = `${Math.round(P[0] * 1e4)},${Math.round(P[1] * 1e4)},${Math.round(P[2] * 1e4)}`;
    if (!seen.has(k)) { seen.add(k); points.push(P); }
  };
  for (const tri of triangles) {
    const a = t[tri * 3] * 3, b = t[tri * 3 + 1] * 3, c = t[tri * 3 + 2] * 3;
    const A: Vec3 = [v[a], v[a + 1], v[a + 2]], B: Vec3 = [v[b], v[b + 1], v[b + 2]], C: Vec3 = [v[c], v[c + 1], v[c + 2]];
    const n = cross(sub(B, A), sub(C, A));
    const ar = Math.hypot(n[0], n[1], n[2]) / 2;
    nx += n[0] / 2; ny += n[1] / 2; nz += n[2] / 2;
    cx += ((A[0] + B[0] + C[0]) / 3) * ar; cy += ((A[1] + B[1] + C[1]) / 3) * ar; cz += ((A[2] + B[2] + C[2]) / 3) * ar;
    area += ar;
    keep(A); keep(B); keep(C);
  }
  const normal = normalize([nx, ny, nz]);
  if (!normal || area <= 0) return null;
  return { normal, centroid: [cx / area, cy / area, cz / area], points };
}

// ---- face mate solver ------------------------------------------------------------------------

/** Principal (long) in-plane direction of a face's points, or null when the patch is too round to have one. */
export function principalInPlane(normal: Vec3, centroid: Vec3, pts: Vec3[]): Vec3 | null {
  if (pts.length < 3) return null;
  const n = normalize(normal);
  if (!n) return null;
  const u = perpendicular(n);
  const w = cross(n, u);
  let suu = 0, suw = 0, sww = 0;
  for (const p of pts) {
    const r = sub(p, centroid);
    const a = dot(r, u), b = dot(r, w);
    suu += a * a; suw += a * b; sww += b * b;
  }
  // 2x2 symmetric eigen-decomposition
  const tr = suu + sww, det = suu * sww - suw * suw;
  const disc = Math.sqrt(Math.max(0, (tr * tr) / 4 - det));
  const hi = tr / 2 + disc, lo = tr / 2 - disc;
  if (!(hi > 1.3 * Math.max(lo, 1e-12))) return null;
  // eigenvector for hi
  let ex: number, ey: number;
  if (Math.abs(suw) > 1e-12) { ex = hi - sww; ey = suw; } else if (suu >= sww) { ex = 1; ey = 0; } else { ex = 0; ey = 1; }
  return normalize(add(scale(u, ex), scale(w, ey)));
}

export interface FaceMateInput {
  movingNormal: Vec3;
  movingCentroid: Vec3;
  movingRegionPts: Vec3[];
  targetNormal: Vec3;
  targetCentroid: Vec3;
  targetRegionPts: Vec3[];
  /** Gap between the face planes, mm, along the target normal. */
  offset: number;
  /** Normals point the same way instead of opposing. */
  flip: boolean;
  /** Spin about the target normal, degrees. */
  angle: number;
  /** In-plane slide along the target face's planeBasis(normal) [u, v], mm (mate gizmo arrows). */
  slide?: [number, number];
  /**
   * First placement: centroid on centroid and the long in-plane directions lined up (BuildBench seatStart). Without
   * it the moving face only drops onto the target plane, keeping its in-plane position.
   */
  seat: boolean;
}

/**
 * Face mate in assembly space: the rigid motion to apply to the moving part (on top of its current placement) so its
 * face normal opposes the target's (same direction with `flip`), the two face planes are `offset` apart along the
 * target normal, spun `angle`° about the target normal. Null when a normal is degenerate.
 */
export function solveFaceMate(i: FaceMateInput): Rigid | null {
  const mN = normalize(i.movingNormal), tN = normalize(i.targetNormal);
  if (!mN || !tN) return null;
  const desired = i.flip ? tN : scale(tN, -1);
  let R = rotationFromTo(mN, desired);
  let point: Vec3;
  if (i.seat) {
    const mu = principalInPlane(mN, i.movingCentroid, i.movingRegionPts);
    const tu = principalInPlane(tN, i.targetCentroid, i.targetRegionPts);
    if (mu && tu) {
      const a = rotate(R, mu);
      const theta = Math.atan2(dot(tN, cross(a, tu)), dot(a, tu));
      // either end of the long direction is as good; take the smaller turn
      const spin = Math.abs(theta) > Math.PI / 2 ? theta - Math.sign(theta) * Math.PI : theta;
      R = mulMat3(axisAngle(tN, spin), R);
    }
    point = add(i.targetCentroid, scale(tN, i.offset));
  } else {
    const rel = sub(i.movingCentroid, i.targetCentroid);
    point = sub(i.movingCentroid, scale(tN, dot(tN, rel) - i.offset));
  }
  if (i.slide && (i.slide[0] || i.slide[1])) {
    const [u, w] = planeBasis(tN);
    point = add(point, add(scale(u, i.slide[0]), scale(w, i.slide[1])));
  }
  // the spin turns about the moving face's final centroid, so it stays put
  R = mulMat3(axisAngle(tN, (i.angle * Math.PI) / 180), R);
  return { R, t: sub(point, rotate(R, i.movingCentroid)) };
}

// ---- gizmo math (ported from BuildBench gizmoMath.ts) ----------------------------------------

/** Two unit vectors spanning the plane perpendicular to `n` (right-handed: u × v = n). */
export function planeBasis(n: Vec3): [Vec3, Vec3] {
  const nn = normalize(n) ?? [0, 0, 1];
  const helper: Vec3 = Math.abs(nn[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  const u = normalize(cross(helper, nn))!;
  return [u, cross(nn, u)];
}

/** Where a ray meets the plane through `centre` with `normal`, or null (parallel / behind). */
export function rayPlanePoint(centre: Vec3, normal: Vec3, rayO: Vec3, rayD: Vec3): Vec3 | null {
  const denom = dot(normal, rayD);
  if (Math.abs(denom) < 1e-6) return null;
  const t = dot(normal, sub(centre, rayO)) / denom;
  return t < 0 ? null : add(rayO, scale(rayD, t));
}

/** Angle (radians, right-handed about `axis`) of where the ray meets the plane through `centre`. */
export function rayAngleAbout(centre: Vec3, axis: Vec3, rayO: Vec3, rayD: Vec3): number | null {
  const p = rayPlanePoint(centre, axis, rayO, rayD);
  if (!p) return null;
  const [u, v] = planeBasis(axis);
  const d = sub(p, centre);
  return Math.atan2(dot(d, v), dot(d, u));
}

/** Parameter along the line (origin + t·dir) of its closest point to the ray. */
export function rayLineParam(lineO: Vec3, lineD: Vec3, rayO: Vec3, rayD: Vec3): number | null {
  const d1 = normalize(lineD), d2 = normalize(rayD);
  if (!d1 || !d2) return null;
  const r = sub(lineO, rayO);
  const b = dot(d1, d2);
  const denom = 1 - b * b;
  if (denom < 1e-6) return null;
  return (b * dot(d2, r) - dot(d1, r)) / denom;
}

/** Shortest signed angle difference, radians. */
export function angleDelta(from: number, to: number): number {
  let d = to - from;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return d;
}

/** Gizmo snapping: translate 1 mm, rotate 15°; `free` (Shift held) keeps the raw value. */
export function snapGizmo(kind: 'translate' | 'rotate', value: number, free: boolean): number {
  if (free) return value;
  const step = kind === 'translate' ? 1 : 15;
  return Math.round(value / step) * step;
}

/** Rigid motion: translate `mm` along unit `axis`. */
export function translateRigid(axis: Vec3, mm: number): Rigid {
  return { R: IDENTITY3.slice(), t: scale(axis, mm) };
}

/** Rigid motion: rotate `deg` about unit `axis` through `centre`. */
export function rotateAboutRigid(axis: Vec3, centre: Vec3, deg: number): Rigid {
  const R = axisAngle(normalize(axis) ?? [0, 0, 1], (deg * Math.PI) / 180);
  return { R, t: sub(centre, rotate(R, centre)) };
}

/** a ∘ m ∘ a⁻¹: a motion `m` expressed in frame `a`'s target space (e.g. assembly -> displayed). */
export function conjugateRigid(a: Rigid, m: Rigid): Rigid {
  return composeRigid(a, composeRigid(m, invertRigid(a)));
}

export function isIdentityRigid(m: Rigid, eps = 1e-9): boolean {
  return m.t.every((x) => Math.abs(x) <= eps) && m.R.every((x, i) => Math.abs(x - IDENTITY3[i]) <= eps);
}

/** Rotate a direction (no translation). */
export function rotateVec(m: Rigid, v: Vec3): Vec3 {
  return rotate(m.R, v);
}

// ---- export naming ---------------------------------------------------------------------------

/** A file name without its folder and extension, made safe for a download name. */
export function safeStem(name: string): string {
  const base = name.replace(/\.[^./\\]+$/, '').replace(/^.*[\\/]/, '');
  return (base || 'file').replace(/[^\w.-]+/g, '_');
}

/**
 * The export stem of the loaded files: the file's own stem for one, `first+second` for two, `first+second+N` when
 * N more follow. Capped to `max` chars (the stems shrink, the "+N" count stays).
 */
export function assemblyStem(fileNames: string[], max = 60): string {
  if (!fileNames.length) return 'model';
  const stems = fileNames.slice(0, 2).map(safeStem);
  const more = fileNames.length > 2 ? `+${fileNames.length - 2}` : '';
  if (stems.length === 1) return stems[0].slice(0, max) || 'model';
  const room = Math.max(2, max - more.length - 1);
  let [a, b] = stems;
  while (a.length + b.length > room) {
    if (a.length >= b.length) a = a.slice(0, -1);
    else b = b.slice(0, -1);
  }
  return `${a}+${b}${more}`;
}

export type ExportFileKind = 'stl-zip' | 'plain-3mf' | 'bambu-3mf' | 'preview-png';

/** Download name for an export: `<base>-<n>colors` plus the kind's suffix (base = "<model stem>-<image stem>"). */
export function exportFilename(kind: ExportFileKind, base: string, n: number): string {
  switch (kind) {
    case 'stl-zip':
      return `${base}-${n}colors-stls.zip`;
    case 'plain-3mf':
      return `${base}-${n}colors-plain.3mf`;
    case 'bambu-3mf':
      return `${base}-${n}colors.3mf`;
    case 'preview-png':
      return `${base}-${n}colors-preview.png`;
  }
}
