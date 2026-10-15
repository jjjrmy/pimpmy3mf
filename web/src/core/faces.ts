// Face tools shared by the 3D preview (hover / click picking) and the pipeline (re-orientation, face skins):
// planar-region picking like Bambu Studio's lay-on-face, rotation helpers and whole-model re-orientation.
import type { Mesh, Model, Vec3 } from './types';

export const IDENTITY3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

/**
 * Edge adjacency, topology only (reusable across poses): out[t*3 + e] = the triangle sharing edge e
 * (vertices e -> e+1) of triangle t, or -1 on a boundary / non-manifold edge. Vertices are matched by
 * position (quantized to 1e-4 mm), so unwelded meshes work too.
 */
export function buildAdjacency(mesh: Mesh): Int32Array {
  const { vertices: v, triangles: t } = mesh;
  const nv = v.length / 3, nt = t.length / 3;
  // canonical vertex ids by quantized position
  const canon = new Int32Array(nv);
  const seen = new Map<string, number>();
  for (let i = 0; i < nv; i++) {
    const k = `${Math.round(v[i * 3] * 1e4)},${Math.round(v[i * 3 + 1] * 1e4)},${Math.round(v[i * 3 + 2] * 1e4)}`;
    let id = seen.get(k);
    if (id === undefined) { id = i; seen.set(k, i); }
    canon[i] = id;
  }
  const adj = new Int32Array(nt * 3).fill(-1);
  // undirected edge key -> the t*3+e slots using it; only edges with exactly 2 users become links
  // (a non-manifold edge with 3+ triangles stays a boundary for all of them)
  const slots = new Map<number, number[]>();
  for (let tri = 0; tri < nt; tri++) {
    for (let e = 0; e < 3; e++) {
      const a = canon[t[tri * 3 + e]], b = canon[t[tri * 3 + ((e + 1) % 3)]];
      if (a === b) continue;
      const key = Math.min(a, b) * nv + Math.max(a, b); // < 2^53 for any realistic mesh
      const list = slots.get(key);
      if (list) list.push(tri * 3 + e);
      else slots.set(key, [tri * 3 + e]);
    }
  }
  for (const list of slots.values()) {
    if (list.length !== 2) continue;
    adj[list[0]] = (list[1] / 3) | 0;
    adj[list[1]] = (list[0] / 3) | 0;
  }
  return adj;
}

/** Unit normal and area of triangle `tri` (area 0 and normal [0,0,0] when degenerate). */
export function triNormal(mesh: Mesh, tri: number): { n: Vec3; area: number } {
  const { vertices: v, triangles: t } = mesh;
  const a = t[tri * 3] * 3, b = t[tri * 3 + 1] * 3, c = t[tri * 3 + 2] * 3;
  const ux = v[b] - v[a], uy = v[b + 1] - v[a + 1], uz = v[b + 2] - v[a + 2];
  const wx = v[c] - v[a], wy = v[c + 1] - v[a + 1], wz = v[c + 2] - v[a + 2];
  const nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
  const len = Math.hypot(nx, ny, nz);
  if (len < 1e-12) return { n: [0, 0, 0], area: 0 };
  return { n: [nx / len, ny / len, nz / len], area: len / 2 };
}

export interface PlanarRegion {
  /** Triangle indices of the region (seed first). */
  triangles: number[];
  /** Area-weighted unit outward normal, in the mesh's current coordinates. */
  normal: Vec3;
  /** mm² */
  area: number;
}

/**
 * Connected planar region around `seed`: flood over edge-adjacent triangles whose normal is within `tolDeg` of
 * the SEED's normal (so curved surfaces don't creep). Degenerate triangles are skipped. Returns null when the
 * seed itself is degenerate.
 */
export function planarRegion(mesh: Mesh, adj: Int32Array, seed: number, tolDeg = 1.5): PlanarRegion | null {
  const s = triNormal(mesh, seed);
  if (s.area === 0) return null;
  const cosTol = Math.cos((tolDeg * Math.PI) / 180);
  const nt = mesh.triangles.length / 3;
  const visited = new Uint8Array(nt);
  const out: number[] = [];
  const stack = [seed];
  visited[seed] = 1;
  let ax = 0, ay = 0, az = 0, area = 0;
  while (stack.length) {
    const tri = stack.pop()!;
    const { n, area: ar } = triNormal(mesh, tri);
    if (ar === 0) continue;
    if (n[0] * s.n[0] + n[1] * s.n[1] + n[2] * s.n[2] < cosTol) continue;
    out.push(tri);
    ax += n[0] * ar; ay += n[1] * ar; az += n[2] * ar; area += ar;
    for (let e = 0; e < 3; e++) {
      const nb = adj[tri * 3 + e];
      if (nb >= 0 && !visited[nb]) { visited[nb] = 1; stack.push(nb); }
    }
  }
  const len = Math.hypot(ax, ay, az) || 1;
  return { triangles: out, normal: [ax / len, ay / len, az / len], area };
}

/** Row-major 3x3 product a·b. */
export function mulMat3(a: number[], b: number[]): number[] {
  const o = new Array<number>(9);
  for (let r = 0; r < 3; r++)
    for (let c = 0; c < 3; c++) o[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c];
  return o;
}

/** Rotation (row-major 3x3) taking unit vector n to -Z (lay-on-face: the picked face ends up facing the bed). */
export function rotationToDown(n: Vec3): number[] {
  const len = Math.hypot(n[0], n[1], n[2]) || 1;
  const x = n[0] / len, y = n[1] / len, z = n[2] / len;
  // Rodrigues rotating n onto d = (0,0,-1): axis k = n × d, cos = n·d
  const c = -z;
  if (c > 1 - 1e-12) return IDENTITY3.slice();
  if (c < -1 + 1e-12) return [1, 0, 0, 0, -1, 0, 0, 0, -1]; // n = +Z: 180° about X
  const kx = -y, ky = x, kz = 0; // n × (0,0,-1)
  const s = Math.hypot(kx, ky, kz);
  const ux = kx / s, uy = ky / s, uz = kz / s, t = 1 - c;
  return [
    t * ux * ux + c, t * ux * uy - s * uz, t * ux * uz + s * uy,
    t * ux * uy + s * uz, t * uy * uy + c, t * uy * uz - s * ux,
    t * ux * uz - s * uy, t * uy * uz + s * ux, t * uz * uz + c,
  ];
}

/** Applies a row-major 3x3 to a vector. */
export function applyMat3(m: number[], p: Vec3): Vec3 {
  return [
    m[0] * p[0] + m[1] * p[1] + m[2] * p[2],
    m[3] * p[0] + m[4] * p[1] + m[5] * p[2],
    m[6] * p[0] + m[7] * p[1] + m[8] * p[2],
  ];
}

/**
 * Re-orients a whole model: rotate every vertex by R about the model's bbox center, then translate so the XY
 * bbox center is unchanged and min z = 0. Triangle arrays are shared (unchanged); names kept.
 * R null returns the same model object (as loaded, untouched).
 */
export function orientModel(model: Model, R: number[] | null): Model {
  if (!R) return model;
  let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
  for (const o of model.objects) for (const p of o.parts) {
    const v = p.mesh.vertices;
    for (let i = 0; i < v.length; i += 3) {
      if (v[i] < x0) x0 = v[i]; if (v[i] > x1) x1 = v[i];
      if (v[i + 1] < y0) y0 = v[i + 1]; if (v[i + 1] > y1) y1 = v[i + 1];
      if (v[i + 2] < z0) z0 = v[i + 2]; if (v[i + 2] > z1) z1 = v[i + 2];
    }
  }
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, cz = (z0 + z1) / 2;
  // rotate into float64 first, then find the new bbox to place it
  const rotated: Float64Array[] = [];
  let nx0 = Infinity, ny0 = Infinity, nz0 = Infinity, nx1 = -Infinity, ny1 = -Infinity;
  for (const o of model.objects) for (const p of o.parts) {
    const v = p.mesh.vertices;
    const r = new Float64Array(v.length);
    for (let i = 0; i < v.length; i += 3) {
      const dx = v[i] - cx, dy = v[i + 1] - cy, dz = v[i + 2] - cz;
      const X = R[0] * dx + R[1] * dy + R[2] * dz, Y = R[3] * dx + R[4] * dy + R[5] * dz, Z = R[6] * dx + R[7] * dy + R[8] * dz;
      r[i] = X; r[i + 1] = Y; r[i + 2] = Z;
      if (X < nx0) nx0 = X; if (X > nx1) nx1 = X;
      if (Y < ny0) ny0 = Y; if (Y > ny1) ny1 = Y;
      if (Z < nz0) nz0 = Z;
    }
    rotated.push(r);
  }
  const tx = cx - (nx0 + nx1) / 2, ty = cy - (ny0 + ny1) / 2, tz = -nz0;
  let i = 0;
  return {
    objects: model.objects.map((o) => ({
      name: o.name,
      parts: o.parts.map((p) => {
        const r = rotated[i++];
        const out = new Float32Array(r.length);
        for (let k = 0; k < r.length; k += 3) { out[k] = r[k] + tx; out[k + 1] = r[k + 1] + ty; out[k + 2] = r[k + 2] + tz; }
        return { name: p.name, mesh: { vertices: out, triangles: p.mesh.triangles } };
      }),
    })),
  };
}
