// Shared ring-drawing helpers used by the 2D view, the paint-mode texture and the worker's preview
// PNG. Everything here is pure 2D-canvas code so it runs on both a DOM canvas and an OffscreenCanvas
// (in the worker). Rings come straight from `ColorRegion.rings`: flat [x0,y0,x1,y1,...] in mm, y-up,
// closing point not repeated. Neighbouring colors share boundaries exactly, so filling each region
// with the even-odd rule carves its holes correctly regardless of winding.

import type { Axis, Frame, Mesh, RGB } from '../core/types';

/** Any 2D context — DOM or OffscreenCanvas. We only use the shared subset. */
export type AnyCtx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/** One region to paint: its rings (mm, frame coords) and the fill color to use. */
export interface MapRegion {
  rings: Float32Array[];
  color: string;
}

export function hexToRgb(hex: string): RGB {
  const h = hex.replace('#', '');
  const s = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)];
}

export function rgbToHex(rgb: RGB): string {
  return (
    '#' +
    rgb
      .map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0'))
      .join('')
      .toUpperCase()
  );
}

/** Pixel size of a map rendered at `widthPx`, plus the mm->px scale. */
export function mapScale(frame: Frame, widthPx: number): { s: number; w: number; h: number } {
  const fw = frame.x1 - frame.x0;
  const fh = frame.y1 - frame.y0;
  const s = widthPx / fw;
  return { s, w: Math.max(1, Math.round(widthPx)), h: Math.max(1, Math.round(fh * s)) };
}

/** mm (y-up) -> device px (y-down) for the given frame and scale. */
function toPx(frame: Frame, s: number, x: number, y: number): [number, number] {
  return [(x - frame.x0) * s, (frame.y1 - y) * s];
}

/** Fill each region's rings with its color, using the even-odd rule so holes drop out. */
export function drawColorMap(ctx: AnyCtx, regions: MapRegion[], frame: Frame, s: number): void {
  for (const reg of regions) {
    if (!reg.rings.length) continue;
    const path = new Path2D();
    for (const ring of reg.rings) {
      for (let k = 0; k < ring.length; k += 2) {
        const [px, py] = toPx(frame, s, ring[k], ring[k + 1]);
        if (k === 0) path.moveTo(px, py);
        else path.lineTo(px, py);
      }
      path.closePath();
    }
    ctx.fillStyle = reg.color;
    ctx.fill(path, 'evenodd');
  }
}

/** Planar projection (world xyz -> frame u,v) matching the pipeline for each axis. */
export function projectUV(axis: Axis): (x: number, y: number, z: number) => [number, number] {
  switch (axis) {
    case 'z':
      return (x, y) => [x, y];
    case 'y':
      return (x, _y, z) => [x, z];
    case 'x':
      return (_x, y, z) => [y, z];
  }
}

/**
 * Paint-mode preview nicety: fade everything that falls outside the model's projected silhouette
 * toward white, like the CLI's save_preview. Mutates the given map canvas in place.
 */
export function fadeOutsideSilhouette(
  ctx: AnyCtx,
  w: number,
  h: number,
  meshes: Mesh[],
  frame: Frame,
  axis: Axis,
  makeCanvas: (w: number, h: number) => { canvas: OffscreenCanvas | HTMLCanvasElement; ctx: AnyCtx },
): void {
  const { s } = mapScale(frame, w);
  const proj = projectUV(axis);
  const { canvas: maskCanvas, ctx: mk } = makeCanvas(w, h);
  mk.fillStyle = '#ffffff';
  for (const model of meshes) {
    const tri = model.triangles;
    const pos = model.vertices;
    for (let t = 0; t < tri.length; t += 3) {
      mk.beginPath();
      for (let j = 0; j < 3; j++) {
        const vi = tri[t + j];
        const [u, v] = proj(pos[vi * 3], pos[vi * 3 + 1], pos[vi * 3 + 2]);
        const [px, py] = toPx(frame, s, u, v);
        if (j === 0) mk.moveTo(px, py);
        else mk.lineTo(px, py);
      }
      mk.closePath();
      mk.fill();
    }
  }
  // inside = the full map clipped to the silhouette
  const { canvas: insideCanvas, ctx: ic } = makeCanvas(w, h);
  ic.drawImage(ctx.canvas as CanvasImageSource, 0, 0);
  ic.globalCompositeOperation = 'destination-in';
  ic.drawImage(maskCanvas as CanvasImageSource, 0, 0);
  // fade everything, then paint the crisp inside back on top
  ctx.globalCompositeOperation = 'source-over';
  ctx.fillStyle = 'rgba(255,255,255,0.8)';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(insideCanvas as CanvasImageSource, 0, 0);
}
