// Image (+ optional model) -> one extruded shape per color. Ports img2color.py main()'s frame/grid
// math and wires color.ts / raster.ts / trace.ts / extrude.ts together with per-stage caching so a
// thickness change only re-extrudes.
import type {
  Pipeline, RasterImage, Mesh, Model, ModelObject, Params, Result, ColorRegion, Axis, RGB, RunOptions,
} from './types';
import { initManifold } from './manifold';
import { quantize, toHex, type QuantizeResult } from './color';
import { resample, despeckle, type Affine } from './raster';
import { trace } from './trace';
import { extrudeRegion, type CropBox } from './extrude';

const MAX_CELLS = 6_000_000;

// uvw = xyz @ R (row-major 3x3). det +1. u = image right, v = image up, w = projection depth.
const AXIS_R: Record<Axis, number[]> = {
  z: [1, 0, 0, 0, 1, 0, 0, 0, 1],
  y: [1, 0, 0, 0, 0, -1, 0, 1, 0],
  x: [0, 0, 1, 1, 0, 0, 0, 1, 0],
};

interface Geom {
  mode: 'image' | 'paint';
  bx0: number; by0: number; bx1: number; by1: number;
  tw: number; th: number; tile: boolean;
  qx: number; qy: number; nx: number; ny: number; q: number;
  R: number[]; w0: number; w1: number;
}

/** Area-average (box) downscale of an RGBA image. */
function areaDownscale(img: RasterImage, nw: number, nh: number): RasterImage {
  const { width: W, height: H, data } = img;
  const out = new Uint8ClampedArray(nw * nh * 4);
  const sxr = W / nw, syr = H / nh;
  for (let oy = 0; oy < nh; oy++) {
    const y0 = oy * syr, y1 = (oy + 1) * syr;
    const iy0 = Math.floor(y0), iy1 = Math.min(H - 1, Math.ceil(y1) - 1);
    for (let ox = 0; ox < nw; ox++) {
      const x0 = ox * sxr, x1 = (ox + 1) * sxr;
      const ix0 = Math.floor(x0), ix1 = Math.min(W - 1, Math.ceil(x1) - 1);
      let r = 0, g = 0, b = 0, a = 0, wsum = 0;
      for (let yy = iy0; yy <= iy1; yy++) {
        const wy = Math.min(y1, yy + 1) - Math.max(y0, yy);
        if (wy <= 0) continue;
        for (let xx = ix0; xx <= ix1; xx++) {
          const wx = Math.min(x1, xx + 1) - Math.max(x0, xx);
          if (wx <= 0) continue;
          const wgt = wx * wy, p = (yy * W + xx) * 4;
          r += data[p] * wgt; g += data[p + 1] * wgt; b += data[p + 2] * wgt; a += data[p + 3] * wgt;
          wsum += wgt;
        }
      }
      const o = (oy * nw + ox) * 4;
      if (wsum > 0) { out[o] = r / wsum; out[o + 1] = g / wsum; out[o + 2] = b / wsum; out[o + 3] = a / wsum; }
    }
  }
  return { width: nw, height: nh, data: out };
}

function computeGeom(img: RasterImage, model: Model | null, params: Params): Geom {
  const W0 = img.width, H0 = img.height;
  let bx0: number, by0: number, bx1: number, by1: number;
  let tw: number, th: number, tile: boolean, ox: number, oy: number;
  let R = AXIS_R.z, w0 = 0, w1 = 0;
  const mode: 'image' | 'paint' = model ? 'paint' : 'image';

  if (model) {
    R = AXIS_R[params.axis];
    let lou = Infinity, lov = Infinity, low = Infinity, hiu = -Infinity, hiv = -Infinity, hiw = -Infinity;
    for (const obj of model.objects) for (const part of obj.parts) {
      const v = part.mesh.vertices;
      for (let i = 0; i < v.length; i += 3) {
        const x = v[i], y = v[i + 1], z = v[i + 2];
        const u = x * R[0] + y * R[3] + z * R[6];
        const vv = x * R[1] + y * R[4] + z * R[7];
        const w = x * R[2] + y * R[5] + z * R[8];
        if (u < lou) lou = u; if (u > hiu) hiu = u;
        if (vv < lov) lov = vv; if (vv > hiv) hiv = vv;
        if (w < low) low = w; if (w > hiw) hiw = w;
      }
    }
    const margin = 1.0;
    bx0 = lou - margin; by0 = lov - margin; bx1 = hiu + margin; by1 = hiv + margin;
    if (params.width != null) {
      tw = params.width; th = params.height ?? tw * H0 / W0; tile = true; ox = bx0; oy = by1;
    } else {
      // rotated fit mode: grow the cover so the rotated image still covers the frame, centered at C
      const fw = bx1 - bx0, fh = by1 - by0;
      const t = params.rotation * Math.PI / 180;
      const ct = Math.abs(Math.cos(t)), st = Math.abs(Math.sin(t));
      const wp = fw * ct + fh * st, hp = fw * st + fh * ct;
      const sCover = Math.max(wp / W0, hp / H0);
      tw = W0 * sCover; th = H0 * sCover; tile = false;
      ox = (bx0 + bx1) / 2 - tw / 2; oy = (by0 + by1) / 2 + th / 2;
    }
    w0 = low - margin; w1 = hiw + margin;
  } else {
    tw = params.width ?? 100; th = params.height ?? tw * H0 / W0;
    bx0 = 0; by0 = 0; bx1 = tw; by1 = th; ox = 0; oy = th; tile = false;
  }

  // grid pitch (integer split of a source pixel when pixels are big, else resolution)
  const srcW = img.width; // may differ after downscale; recomputed by caller before grid
  const pxMm = tw / srcW;
  const q = pxMm >= params.resolution ? pxMm / Math.round(pxMm / params.resolution) : params.resolution;
  let nx = Math.max(1, Math.round((bx1 - bx0) / q));
  let ny = Math.max(1, Math.round((by1 - by0) / q));
  if (nx * ny > MAX_CELLS) {
    const f = Math.sqrt((nx * ny) / MAX_CELLS);
    nx = Math.max(1, Math.round(nx / f)); ny = Math.max(1, Math.round(ny / f));
  }
  const qx = (bx1 - bx0) / nx, qy = (by1 - by0) / ny;
  return { mode, bx0, by0, bx1, by1, tw, th, tile, qx, qy, nx, ny, q, R, w0, w1, ox, oy } as Geom & { ox: number; oy: number };
}

function paletteKey(p: RGB[] | null): string {
  return p ? p.map((c) => c.join(',')).join(';') : '';
}

export function createPipeline(): Pipeline {
  // cached stages
  let cImage: RasterImage | null = null;
  let cModel: Model | null = null;
  let qKey = ''; let qVer = 0; let qRes: QuantizeResult | null = null; let qSrc: RasterImage | null = null;
  let gKey = ''; let gVer = 0;
  let gRings: Map<number, { x: Float64Array; y: Float64Array }[]> | null = null;
  let gGeom: (Geom & { ox: number; oy: number }) | null = null;
  let gColors: RGB[] = []; let gWarn: string[] = [];
  let eKey = ''; let eRegions: ColorRegion[] | null = null;

  const run = async (image: RasterImage, model: Model | null, params: Params, opts?: RunOptions): Promise<Result> => {
    const t0 = performance.now();
    const wasm = await initManifold();

    const tick = async (stage: string, frac?: number) => {
      opts?.onProgress?.(stage, frac);
      await new Promise((r) => setTimeout(r, 0));
      if (opts?.signal?.cancelled) { const e = new Error('Cancelled'); e.name = 'Cancelled'; throw e; }
    };

    const geom = computeGeom(image, model, params) as Geom & { ox: number; oy: number };

    // ---- stage 1: downscale + quantize ----
    // downscale when the image is far finer than the grid
    let src = image;
    const pxMm0 = geom.tw / image.width;
    if (pxMm0 < params.resolution / 2) {
      const f = (params.resolution / 2) / pxMm0;
      const nw = Math.max(1, Math.round(image.width / f));
      const nh = Math.max(1, Math.round(image.height / f));
      src = areaDownscale(image, nw, nh);
    }
    const q1Key = `${params.colors}|${paletteKey(params.palette)}|${src.width}x${src.height}`;
    if (cImage !== image || qKey !== q1Key || !qRes) {
      await tick('quantize');
      qRes = quantize(src, params.colors, params.palette);
      qSrc = src; cImage = image; qKey = q1Key; qVer++;
    }
    const colors = qRes.colors;
    const ncol = colors.length;

    // geometry depends on the actually-used src dims, so recompute grid metrics with src
    const g = recomputeGrid(geom, src, params);

    // ---- stage 2: resample + despeckle + trace ----
    const g2Key = `${qVer}|${model ? 'M' : 'I'}|${params.width}|${params.height}|${params.smooth}|${params.minFeature}|${params.resolution}|${params.axis}|${params.rotation}|${params.offsetX}|${params.offsetY}`;
    if (cModel !== model || gKey !== g2Key || !gRings) {
      await tick('grid');
      const { nx, ny, bx0, bx1, by0, by1, qx, qy } = g;
      const th = g.th, tw = g.tw, W = qSrc!.width, H = qSrc!.height;
      const sy = qy / (th / H), sx = qx / (tw / W);
      const row0 = (g.oy - (by1 - 0.5 * qy)) / (th / H) - 0.5;
      const col0 = ((bx0 + 0.5 * qx) - g.ox) / (tw / W) - 0.5;
      let sigma = params.smooth;
      if (sigma > 0) sigma = Math.max(sigma, 0.5 * Math.max(sx, sy));
      // sampling affine: diagonal (byte-identical to before) unless rotation/offset is set
      const rot = params.rotation, dx = params.offsetX, dy = params.offsetY;
      const wrap = g.tile || rot !== 0 || dx !== 0 || dy !== 0;
      let affine: Affine;
      if (rot === 0 && dx === 0 && dy === 0) {
        affine = { arx: 0, ary: sy, r0: row0, acx: sx, acy: 0, c0: col0 };
      } else {
        // P' = Rot(-θ)·(P - C - d) + C, then P' -> source px with origin (ox,oy), pixel size (tw/W, th/H)
        const px = tw / W, py = th / H;
        const Cx = (bx0 + bx1) / 2, Cy = (by0 + by1) / 2;
        const U0 = bx0 + 0.5 * qx - Cx - dx; // u term at gx=0
        const V0 = by1 - 0.5 * qy - Cy - dy; // v term at gy=0
        const t = rot * Math.PI / 180, ct = Math.cos(t), stt = Math.sin(t);
        affine = {
          acx: ct * qx / px, acy: -stt * qy / px, c0: (ct * U0 + stt * V0 + Cx - g.ox) / px - 0.5,
          arx: stt * qx / py, ary: ct * qy / py, r0: (g.oy - (-stt * U0 + ct * V0 + Cy)) / py - 0.5,
        };
      }
      let grid = resample(qRes!.labels, H, W, ncol, ny, nx, affine, sigma, wrap);
      await tick('despeckle');
      grid = despeckle(grid, ny, nx, (params.minFeature / 2) / Math.min(qx, qy), g.tile);
      await tick('trace');
      const ringsGrid = trace({ grid, ny, nx, ncolors: ncol, smooth: params.smooth > 0 });
      // map grid coords -> mm (x = bx0 + gx*qx, y = by1 - gy*qy)
      const mm = new Map<number, { x: Float64Array; y: Float64Array }[]>();
      for (const [k, rings] of ringsGrid) {
        mm.set(k, rings.map((r) => {
          const x = new Float64Array(r.x.length), y = new Float64Array(r.y.length);
          for (let i = 0; i < r.x.length; i++) { x[i] = bx0 + r.x[i] * qx; y[i] = by1 - r.y[i] * qy; }
          return { x, y };
        }));
      }
      gRings = mm; gGeom = g; gColors = colors; gWarn = qRes!.warnings.slice();
      cModel = model; gKey = g2Key; gVer++;
    }

    // ---- stage 3: extrude ----
    const heightRange = g.w1 - g.w0;
    const e3Key = `${gVer}|${geom.mode}|${geom.mode === 'image' ? params.thickness : heightRange}`;
    if (eKey !== e3Key || !eRegions) {
      await tick('extrude');
      // per-object crop boxes (uvw): a Bambu modifier only acts on its own object
      const cropBoxes: CropBox[] | null = geom.mode === 'paint' && model
        ? model.objects.map((obj) => objectBoxUVW(obj, g.R)) : null;
      const regions: ColorRegion[] = [];
      const areas: number[] = [];
      for (let k = 0; k < ncol; k++) {
        const rings = gRings!.get(k) ?? [];
        const res = geom.mode === 'image'
          ? extrudeRegion(wasm, rings, params.thickness, 0)
          : extrudeRegion(wasm, rings, heightRange, g.w0, g.R, cropBoxes);
        areas.push(res.area);
        regions.push({
          index: k, rgb: colors[k], hex: toHex(colors[k]),
          coverage: 0, rings: res.rings, mesh: res.mesh, objectMeshes: res.objectMeshes,
        });
      }
      const total = areas.reduce((s, a) => s + a, 0) || 1;
      for (let k = 0; k < ncol; k++) regions[k].coverage = areas[k] / total;
      eRegions = regions; eKey = e3Key;
    }

    const ms = performance.now() - t0;
    // deep-copy regions so callers can't mutate the cache
    const cloneMesh = (m: Mesh | null): Mesh | null =>
      m ? { vertices: m.vertices.slice(), triangles: m.triangles.slice() } : null;
    const outRegions: ColorRegion[] = eRegions.map((r) => ({
      index: r.index, rgb: [...r.rgb] as RGB, hex: r.hex, coverage: r.coverage,
      rings: r.rings.map((ring) => ring.slice()),
      mesh: cloneMesh(r.mesh),
      objectMeshes: r.objectMeshes ? r.objectMeshes.map(cloneMesh) : null,
    }));

    return {
      mode: geom.mode,
      regions: outRegions,
      frame: { x0: g.bx0, y0: g.by0, x1: g.bx1, y1: g.by1 },
      tile: { w: g.tw, h: g.th, repeat: g.tile },
      axis: params.axis,
      model: geom.mode === 'paint' ? model : null,
      stats: { imageW: image.width, imageH: image.height, gridW: g.nx, gridH: g.ny, pitch: g.qx, ms },
      warnings: gWarn.slice(),
    };
  };

  const dispose = () => {
    cImage = null; cModel = null; qRes = null; qSrc = null; gRings = null; gGeom = null; eRegions = null;
    qKey = ''; gKey = ''; eKey = '';
    void gGeom; void gColors;
  };

  return { run, dispose };
}

/** One model object's bounding box in uvw (projected by R), expanded by a 1 mm margin each side. */
function objectBoxUVW(obj: ModelObject, R: number[]): CropBox {
  let lou = Infinity, lov = Infinity, low = Infinity, hiu = -Infinity, hiv = -Infinity, hiw = -Infinity;
  for (const part of obj.parts) {
    const v = part.mesh.vertices;
    for (let i = 0; i < v.length; i += 3) {
      const x = v[i], y = v[i + 1], z = v[i + 2];
      const u = x * R[0] + y * R[3] + z * R[6];
      const vv = x * R[1] + y * R[4] + z * R[7];
      const w = x * R[2] + y * R[5] + z * R[8];
      if (u < lou) lou = u; if (u > hiu) hiu = u;
      if (vv < lov) lov = vv; if (vv > hiv) hiv = vv;
      if (w < low) low = w; if (w > hiw) hiw = w;
    }
  }
  const m = 1.0;
  return { min: [lou - m, lov - m, low - m], max: [hiu + m, hiv + m, hiw + m] };
}

/** Recompute grid metrics once the real (possibly downscaled) source size is known. */
function recomputeGrid(geom: Geom & { ox: number; oy: number }, src: RasterImage, params: Params): Geom & { ox: number; oy: number } {
  const pxMm = geom.tw / src.width;
  const q = pxMm >= params.resolution ? pxMm / Math.round(pxMm / params.resolution) : params.resolution;
  let nx = Math.max(1, Math.round((geom.bx1 - geom.bx0) / q));
  let ny = Math.max(1, Math.round((geom.by1 - geom.by0) / q));
  if (nx * ny > MAX_CELLS) {
    const f = Math.sqrt((nx * ny) / MAX_CELLS);
    nx = Math.max(1, Math.round(nx / f)); ny = Math.max(1, Math.round(ny / f));
  }
  const qx = (geom.bx1 - geom.bx0) / nx, qy = (geom.by1 - geom.by0) / ny;
  return { ...geom, q, nx, ny, qx, qy };
}
