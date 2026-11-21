// Multi-plate (Bambu / Orca project) helpers: the plate grid, and lay-on-face per plate.
import type { Model, ModelPlates } from './types';
import { orientModelLike } from './faces';

/** Bambu lays plates out on a grid this many bed sizes apart. */
export const PLATE_PITCH = 1.2;

/** Grid columns Bambu uses for `count` plates. */
export const plateCols = (count: number): number => Math.max(1, Math.ceil(Math.sqrt(count)));

/** World origin of plate p's cell (plate-local (0, 0)) for a `bed`-sized printer. */
export function plateCellOrigin(p: number, count: number, bed: [number, number]): [number, number] {
  const cols = plateCols(count);
  return [(p % cols) * PLATE_PITCH * bed[0], -Math.floor(p / cols) * PLATE_PITCH * bed[1]];
}

/** World centre of plate p's printable area in the source project. */
export function plateCentre(plates: Omit<ModelPlates, 'objectPlate'>, p: number): [number, number] {
  const [ox, oy] = plateCellOrigin(p, plates.count, plates.bed);
  return [ox + plates.bedOrigin[0] + plates.bed[0] / 2, oy + plates.bedOrigin[1] + plates.bed[1] / 2];
}

/** Which plate cell holds the world point (x, y), or -1 when it falls outside every cell. */
export function plateAt(plates: Omit<ModelPlates, 'objectPlate'>, x: number, y: number): number {
  const cols = plateCols(plates.count);
  const px = PLATE_PITCH * plates.bed[0], py = PLATE_PITCH * plates.bed[1];
  const col = Math.floor((x - plates.bedOrigin[0] + (px - plates.bed[0]) / 2) / px);
  const row = Math.floor(-(y - plates.bedOrigin[1] - plates.bed[1] - (py - plates.bed[1]) / 2) / py);
  if (col < 0 || col >= cols || row < 0) return -1;
  const p = row * cols + col;
  return p < plates.count ? p : -1;
}

/**
 * Lay-on-face per plate: each plate with a rotation has its objects rotated together about their bbox centre, kept
 * at their XY centre and dropped to min z = 0 (placement from `ref`, applied to `model`, like orientModelLike).
 * Plates without one, and the model's object order, stay as they are. All-null returns `model` itself.
 */
export function orientPlatesLike(model: Model, ref: Model, plates: ModelPlates, R: (number[] | null)[] | null | undefined): Model {
  if (!R || !R.some(Boolean)) return model;
  const objects = model.objects.slice();
  for (let p = 0; p < plates.count; p++) {
    const Rp = R[p];
    if (!Rp) continue;
    const idx = plates.objectPlate.flatMap((q, j) => (q === p ? [j] : []));
    if (!idx.length) continue;
    const subM: Model = { objects: idx.map((j) => model.objects[j]) };
    const subR: Model = model === ref ? subM : { objects: idx.map((j) => ref.objects[j]) };
    const sub = orientModelLike(subM, subR, Rp);
    idx.forEach((j, i) => (objects[j] = sub.objects[i]));
  }
  return { objects, plates };
}
