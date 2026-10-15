// Cylindrical projection geometry shared by the pipeline (modifier wedges), the 3D preview (UVs) and exports.
// The image wraps around `axis` through the model's bbox center: u = R0·φ (arc length on the reference radius),
// v = height along the axis from the center. φ runs from e1 toward e2 (counter-clockwise looking down the axis),
// so seen from outside the image reads left to right, not mirrored. (e1, e2, a) is right-handed.
import type { Axis, CylinderFrame, Vec3 } from './types';

export const CYL_BASIS: Record<Axis, { e1: Vec3; e2: Vec3; a: Vec3 }> = {
  z: { e1: [1, 0, 0], e2: [0, 1, 0], a: [0, 0, 1] },
  y: { e1: [0, 0, 1], e2: [1, 0, 0], a: [0, 1, 0] },
  x: { e1: [0, 1, 0], e2: [0, 0, 1], a: [1, 0, 0] },
};

const TAU = Math.PI * 2;

/** (u, v) of a point: u ∈ [0, 2π·R0) arc length at R0, v = height along the axis from the center. */
export function cylUV(x: number, y: number, z: number, cyl: CylinderFrame): [number, number] {
  const { e1, e2, a } = CYL_BASIS[cyl.axis];
  const dx = x - cyl.center[0], dy = y - cyl.center[1], dz = z - cyl.center[2];
  let phi = Math.atan2(dx * e2[0] + dy * e2[1] + dz * e2[2], dx * e1[0] + dy * e1[1] + dz * e1[2]);
  if (phi < 0) phi += TAU;
  return [cyl.R0 * phi, dx * a[0] + dy * a[1] + dz * a[2]];
}

/** Inverse map: (u, v, r) -> xyz. u is arc length at R0, r the radius from the axis. */
export function cylPoint(u: number, v: number, r: number, cyl: CylinderFrame): Vec3 {
  const { e1, e2, a } = CYL_BASIS[cyl.axis];
  const phi = u / cyl.R0, c = Math.cos(phi) * r, s = Math.sin(phi) * r;
  return [
    cyl.center[0] + c * e1[0] + s * e2[0] + v * a[0],
    cyl.center[1] + c * e1[1] + s * e2[1] + v * a[1],
    cyl.center[2] + c * e1[2] + s * e2[2] + v * a[2],
  ];
}
