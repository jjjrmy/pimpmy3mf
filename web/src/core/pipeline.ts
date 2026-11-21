// Image (+ optional model) -> one extruded shape per color. Ports img2color.py main()'s frame/grid
// math and wires color.ts / raster.ts / trace.ts / extrude.ts together with per-stage caching so a
// thickness change only re-extrudes.
import type {
  Pipeline, RasterImage, Mesh, Model, ModelObject, ModelPart, Params, Result, ColorRegion, Axis, RGB, RunOptions, FaceSkin,
  Projection, CylinderFrame, Vec3,
} from './types';
import { DEFAULT_PARAMS } from './types';
import { initManifold } from './manifold';
import { quantize, toHex, type QuantizeResult } from './color';
import { resample, despeckle, type Affine } from './raster';
import { trace } from './trace';
import { extrudeRegion, type CropBox } from './extrude';
import { cylFrame, extrudeRegionsCyl } from './cylindrical';
import { orientModelLike, orientPlacement } from './faces';
import { orientPlatesLike } from './plates';
import { buildFaceSkins, subtractSkins, type SkinExtent } from './skins';
import { applyTextures, textureKey } from './texture';
import type { FaceTexture } from './types';
import { ShellCache, clipRegionsToShells, splitTile } from './shell';

const MAX_CELLS = 6_000_000;

/** Neutral base color of a model shown before any camo is picked (a plain grey filament). */
export const PLAIN_RGB: RGB = [154, 158, 164];

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
  ox: number; oy: number;
  /** Paint projection used to build this frame ('planar' in image mode). */
  projection: Projection;
  /** Cylindrical frame (center/axis/R0) when projection === 'cylindrical', else null. */
  cyl: CylinderFrame | null;
  /** Cylindrical: copies around the circumference (1 fit, n tile); null for planar/image. */
  wraps: number | null;
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
  let projection: Projection = 'planar';
  let cyl: CylinderFrame | null = null;
  let wraps: number | null = null;
  const mode: 'image' | 'paint' = model ? 'paint' : 'image';

  if (model && params.projection === 'cylindrical') {
    // ---- cylindrical frame: wrap the image around `axis` through the model's bbox center ----
    projection = 'cylindrical';
    R = AXIS_R[params.axis]; // retained for uvw crop fallbacks; the wedge builder uses cyl + cylPoint
    const f = cylFrame(model, params.axis);
    cyl = { center: f.center, axis: params.axis, R0: f.R0 };
    const circ = 2 * Math.PI * f.R0;
    bx0 = 0; bx1 = circ;              // u ∈ [0, 2π·R0] exactly (no margin in u)
    by0 = f.vmin - 1; by1 = f.vmax + 1;
    if (params.width != null) {
      // tile mode: snap tile width so n copies wrap the 360° seam seamlessly; anchor u=0 and the top
      const n = Math.max(1, Math.round(circ / params.width));
      tw = circ / n; th = params.height ?? tw * H0 / W0; tile = true; ox = 0; oy = by1; wraps = n;
    } else {
      // fit mode: one image wraps exactly once; centre it vertically (frame v-centre is 0)
      tw = circ; th = tw * H0 / W0; tile = false; ox = 0; oy = th / 2; wraps = 1;
    }
    w0 = 0; w1 = 0; // depth range is unused for cylindrical (r range is derived in the wedge builder)
  } else if (model) {
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
  const qx = (bx1 - bx0) / nx, qy = (by1 - by0) / ny; // cylindrical: qx = 2π·R0/nx exactly
  return { mode, bx0, by0, bx1, by1, tw, th, tile, qx, qy, nx, ny, q, R, w0, w1, ox, oy, projection, cyl, wraps };
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
  // stage 0 (textures, then orientation) and stage 4 (painted-face skins)
  let tIn: Model | null = null; let tKey = ''; let tSrc: Model | null = null;
  let tChanged: boolean[][] | null = null; let tApplied: FaceTexture[] = []; let tWarn: string[] = [];
  let oSrc: Model | null = null; let oKey = ''; let oModel: Model | null = null; let oOrig: Model | null = null;
  let oPlace: { R: number[]; t: Vec3 } | null = null;
  let sKey = ''; let sRegions: ColorRegion[] | null = null; let sSkins: FaceSkin[] = [];
  // depth stage (between 3 and 4): shell-clipped modifiers (paint) / base + caps (image)
  const shellCache = new ShellCache();
  let dKey = ''; let dRegions: ColorRegion[] | null = null; let dBase: Mesh | null = null;
  let dInner: (Uint32Array | null)[][] | null = null;
  let dInnerMesh: (Mesh | null)[][] | null = null;

  const run = async (image: RasterImage | null, srcModel: Model | null, params: Params, opts?: RunOptions): Promise<Result> => {
    const t0 = performance.now();
    const wasm = await initManifold();

    const tick = async (stage: string, frac?: number) => {
      opts?.onProgress?.(stage, frac);
      await new Promise((r) => setTimeout(r, 0));
      if (opts?.signal?.cancelled) { const e = new Error('Cancelled'); e.name = 'Cancelled'; throw e; }
    };

    // ---- stage 0a: surface textures, in as-loaded space (no textures keeps the loaded model object) ----
    const textures = srcModel ? (params.textures ?? []) : [];
    const texKey = textureKey(textures);
    if (srcModel !== tIn || texKey !== tKey) {
      if (srcModel && textures.length) {
        await tick('texture', 0);
        const tr = await applyTextures(wasm, srcModel, textures, (done, total) => tick('texture', total ? done / total : undefined));
        tSrc = tr.model; tChanged = tr.model === srcModel ? null : tr.changed; tApplied = tr.applied; tWarn = tr.warnings;
      } else {
        tSrc = srcModel; tChanged = null; tApplied = []; tWarn = [];
      }
      tIn = srcModel; tKey = texKey;
    }

    // ---- stage 0b: re-orient (lay-on-face). Textured and original share one transform, placed from the textured
    // shape; everything geometric uses the textured model, result.model / picking / skins the original ----
    // a multi-plate model lays each plate on its own (plateOrientations); params.orientation is not used there
    const plates = srcModel?.plates;
    const plateRs = plates ? (params.plateOrientations ?? null) : null;
    const mat = (R: number[] | null | undefined) => (R ? R.map((x) => x.toFixed(9)).join(',') : '');
    const orientKey = plates ? `plates:${(plateRs ?? []).map(mat).join('|')}` : mat(params.orientation);
    if (tSrc !== oSrc || orientKey !== oKey) {
      if (plates) {
        oModel = tSrc ? orientPlatesLike(tSrc, tSrc, plates, plateRs) : null;
        oOrig = srcModel && tSrc && tSrc !== srcModel ? orientPlatesLike(srcModel, tSrc, plates, plateRs) : oModel;
        oPlace = null; // only the assemble tool reads it, and plates never come with an assembly
      } else {
        oModel = tSrc ? orientModelLike(tSrc, tSrc, params.orientation) : null;
        oOrig = srcModel && tSrc && tSrc !== srcModel ? orientModelLike(srcModel, tSrc, params.orientation) : oModel;
        oPlace = tSrc ? orientPlacement(tSrc, params.orientation) : null;
      }
      oSrc = tSrc; oKey = orientKey;
    }
    const model = oModel; // textured shape (geometry)
    const origModel = oOrig; // as-loaded triangles (result.model, picking, painted faces)

    if (!image) {
      if (!model || !origModel) throw new Error('Load an image first.');
      return plainResult(model, origModel, params, t0);
    }

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
    const g2Key = `${qVer}|${model ? 'M' : 'I'}|${params.width}|${params.height}|${params.smooth}|${params.minFeature}|${params.resolution}|${params.axis}|${geom.projection}|${params.rotation}|${params.offsetX}|${params.offsetY}`;
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
      // planar wraps both axes together (tile or rotate/offset); cylindrical always wraps u (the
      // circumference seam) and v (fit repeats vertically, tile repeats) — independent of planar.
      const planarWrap = g.tile || rot !== 0 || dx !== 0 || dy !== 0;
      const cylMode2 = geom.projection === 'cylindrical';
      const wrapX = cylMode2 ? true : planarWrap;
      const wrapY = cylMode2 ? true : planarWrap;
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
      let grid = resample(qRes!.labels, H, W, ncol, ny, nx, affine, sigma, wrapX, wrapY);
      await tick('despeckle');
      // despeckle wraps horizontally (u) only for cylindrical; planar keeps the old both-axes behaviour
      grid = despeckle(grid, ny, nx, (params.minFeature / 2) / Math.min(qx, qy), cylMode2 ? true : g.tile, cylMode2 ? false : g.tile);
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
    const cyl = g.cyl;
    const cylMode = geom.mode === 'paint' && geom.projection === 'cylindrical' && cyl != null;
    const e3Key = `${gVer}|${geom.mode}|${geom.projection}|${cylMode ? cyl!.R0.toFixed(6) : (geom.mode === 'image' ? params.thickness : heightRange)}|${params.perPart ? 'P' : ''}`;
    if (eKey !== e3Key || !eRegions) {
      await tick('extrude');
      // per-object crop boxes: a Bambu modifier only acts on its own object. Planar crops in uvw;
      // cylindrical crops the warped wedge in xyz (the model's axis-aligned bbox ± 1 mm).
      const cropBoxes: CropBox[] | null = geom.mode === 'paint' && model
        ? model.objects.map((obj) => cylMode ? objectBoxXYZ(obj) : objectBoxUVW(obj, g.R)) : null;
      // per-part crop boxes, [objectIndex][partIndex], only when perPart is on
      const partCropBoxes: CropBox[][] | null = geom.mode === 'paint' && model && params.perPart
        ? model.objects.map((obj) => obj.parts.map((p) => cylMode ? partBoxXYZ(p) : partBoxUVW(p, g.R))) : null;
      const regions: ColorRegion[] = [];
      const areas: number[] = [];
      // cylindrical builds all colors together so it can partition them (lower index wins) before crops
      const cylResults = cylMode
        ? extrudeRegionsCyl(wasm, Array.from({ length: ncol }, (_, k) => gRings!.get(k) ?? []), cyl!, cropBoxes, partCropBoxes)
        : null;
      for (let k = 0; k < ncol; k++) {
        const rings = gRings!.get(k) ?? [];
        const res = geom.mode === 'image'
          ? extrudeRegion(wasm, rings, params.thickness, 0)
          : cylMode
            ? cylResults![k]
            : extrudeRegion(wasm, rings, heightRange, g.w0, g.R, cropBoxes, partCropBoxes);
        areas.push(res.area);
        regions.push({
          index: k, rgb: colors[k], hex: toHex(colors[k]),
          coverage: 0, rings: res.rings, mesh: res.mesh, objectMeshes: res.objectMeshes, partMeshes: res.partMeshes,
        });
      }
      const total = areas.reduce((s, a) => s + a, 0) || 1;
      for (let k = 0; k < ncol; k++) regions[k].coverage = areas[k] / total;
      eRegions = regions; eKey = e3Key;
    }

    // ---- stage 3b: paint depth. Paint: clip every modifier to the parts' outer shell (Full: to the parts minus
    // a skin under their inside surfaces). Image: base + caps ----
    const want = params.depth != null && Number.isFinite(params.depth) && params.depth > 0 ? params.depth : null;
    const depth = geom.mode === 'image' ? (want != null && want < params.thickness ? want : null) : want;
    const inside = geom.mode === 'paint' && !!params.paintInside;
    const threshold = Number.isFinite(params.insideThreshold) ? params.insideThreshold : DEFAULT_PARAMS.insideThreshold;
    const d3Key = `${e3Key}|${depth ?? 'F'}|${inside ? 'in' : `out:${threshold}`}`;
    if (dKey !== d3Key || !dRegions) {
      dInner = null; dInnerMesh = null;
      const shelled = geom.mode === 'paint' && model && (depth != null || !inside);
      if (shelled) {
        const set = shellCache.get(model!, depth, inside, threshold)
          ?? await shellCache.build(wasm, model!, depth, inside, threshold, (stage, done, total) => tick(stage, total ? done / total : undefined));
        await tick('shell', 1);
        const anyInner = set.innerMesh.some((row) => row.some((r) => !!r));
        dInner = anyInner ? set.inner : null;
        dInnerMesh = anyInner ? set.innerMesh : null;
        // Full with nothing inside: the modifiers stay as they are
        dRegions = depth == null && !dInner ? eRegions! : clipRegionsToShells(wasm, eRegions!, set.shells);
        dBase = null;
      } else if (depth == null || geom.mode === 'paint') {
        dRegions = eRegions!; dBase = null;
      } else {
        const sp = splitTile(wasm, eRegions!, params.thickness, depth);
        dRegions = sp.regions; dBase = sp.base;
      }
      dKey = d3Key;
    }

    // ---- stage 4: painted-face skins (paint mode); the camo modifiers give way to them ----
    const faces = geom.mode === 'paint' ? params.paintedFaces : [];
    const s4Key = `${d3Key}|${faces.map((f) => `${f.id}:${f.objectIndex}:${f.partIndex}:${f.color}:${f.triangles.length}`).join(';')}|${tApplied.length ? textureKey(tApplied) : ''}`;
    if (sKey !== s4Key || !sRegions) {
      if (faces.length && origModel) {
        await tick('paint');
        const skinDepth = depth == null ? 1 : Math.min(1, depth);
        sSkins = buildFaceSkins(wasm, origModel, faces, ncol, skinDepth, skinExtents(faces, tApplied, skinDepth));
        sRegions = subtractSkins(wasm, dRegions!, sSkins);
      } else {
        sSkins = []; sRegions = dRegions!;
      }
      sKey = s4Key;
    }

    const ms = performance.now() - t0;
    // deep-copy regions so callers can't mutate the cache
    const cloneMesh = (m: Mesh | null): Mesh | null =>
      m ? { vertices: m.vertices.slice(), triangles: m.triangles.slice() } : null;
    const outRegions: ColorRegion[] = sRegions!.map((r) => ({
      index: r.index, rgb: [...r.rgb] as RGB, hex: r.hex, coverage: r.coverage,
      rings: r.rings.map((ring) => ring.slice()),
      mesh: cloneMesh(r.mesh),
      objectMeshes: r.objectMeshes ? r.objectMeshes.map(cloneMesh) : null,
      partMeshes: r.partMeshes ? r.partMeshes.map((o) => o.map(cloneMesh)) : null,
    }));

    return {
      mode: geom.mode,
      regions: outRegions,
      frame: { x0: g.bx0, y0: g.by0, x1: g.bx1, y1: g.by1 },
      tile: { w: g.tw, h: g.th, repeat: g.tile, wraps: g.wraps },
      axis: params.axis,
      projection: geom.mode === 'paint' ? params.projection : 'planar',
      cylinder: g.cyl,
      orientation: geom.mode === 'paint' && !plates ? params.orientation : null,
      plateOrientations: geom.mode === 'paint' && plates ? plateRs : null,
      orientPlace: geom.mode === 'paint' && oPlace ? { R: oPlace.R.slice(), t: [...oPlace.t] as Vec3 } : null,
      model: geom.mode === 'paint' ? origModel : null,
      faceSkins: sSkins.map((k) => ({ ...k, mesh: cloneMesh(k.mesh)! })),
      depth,
      innerFaces: dInner ? dInner.map((row) => row.map((r) => (r ? r.slice() : null))) : null,
      innerMeshes: dInnerMesh ? dInnerMesh.map((row) => row.map(cloneMesh)) : null,
      base: cloneMesh(dBase),
      shaped: geom.mode === 'paint' && tChanged && model
        ? model.objects.map((o, j) => o.parts.map((p, k) => (tChanged![j]?.[k] ? cloneMesh(p.mesh) : null)))
        : null,
      stats: { imageW: image.width, imageH: image.height, gridW: g.nx, gridH: g.ny, pitch: g.qx, ms },
      warnings: geom.mode === 'paint' && tWarn.length ? [...gWarn, ...tWarn] : gWarn.slice(),
    };
  };

  /** No image yet: the (textured, oriented) model in one base color, framed like a square image would be. */
  const plainResult = (model: Model, origModel: Model, params: Params, t0: number): Result => {
    const plates = origModel.plates;
    const geom = computeGeom({ width: 64, height: 64, data: new Uint8ClampedArray(64 * 64 * 4) }, model, params);
    const cloneMesh = (m: Mesh): Mesh => ({ vertices: m.vertices.slice(), triangles: m.triangles.slice() });
    return {
      mode: 'paint',
      regions: [{ index: 0, rgb: [...PLAIN_RGB] as RGB, hex: toHex(PLAIN_RGB), coverage: 1, rings: [], mesh: null, objectMeshes: null, partMeshes: null }],
      frame: { x0: geom.bx0, y0: geom.by0, x1: geom.bx1, y1: geom.by1 },
      tile: { w: geom.tw, h: geom.th, repeat: geom.tile, wraps: geom.wraps },
      axis: params.axis,
      projection: params.projection,
      cylinder: geom.cyl,
      orientation: plates ? null : params.orientation,
      plateOrientations: plates ? (params.plateOrientations ?? null) : null,
      orientPlace: oPlace ? { R: oPlace.R.slice(), t: [...oPlace.t] as Vec3 } : null,
      model: origModel,
      faceSkins: [],
      depth: null,
      innerFaces: null,
      innerMeshes: null,
      base: null,
      shaped: tChanged ? model.objects.map((o, j) => o.parts.map((p, k) => (tChanged![j]?.[k] ? cloneMesh(p.mesh) : null))) : null,
      stats: { imageW: 0, imageH: 0, gridW: 0, gridH: 0, pitch: 0, ms: performance.now() - t0 },
      warnings: tWarn.slice(),
      plain: true,
    };
  };

  const dispose = () => {
    cImage = null; cModel = null; qRes = null; qSrc = null; gRings = null; gGeom = null; eRegions = null;
    qKey = ''; gKey = ''; eKey = '';
    oSrc = null; oModel = null; oOrig = null; oKey = '';
    tIn = null; tSrc = null; tKey = ''; tChanged = null; tApplied = []; tWarn = []; sRegions = null; sSkins = []; sKey = '';
    shellCache.clear(); dRegions = null; dBase = null; dInner = null; dInnerMesh = null; dKey = '';
    void gGeom; void gColors;
  };

  return { run, dispose };
}

/**
 * Painted faces that overlap a texture region (same part, shared as-loaded triangles) get a deeper/taller skin so the
 * paint covers the raised relief and the groove floors. null = default extents.
 */
function skinExtents(faces: Params['paintedFaces'], textures: FaceTexture[], skinDepth: number): (SkinExtent | null)[] | undefined {
  if (!textures.length) return undefined;
  let any = false;
  const out = faces.map((f) => {
    let up = 0, down = 0;
    const tris = new Set(f.triangles);
    for (const t of textures) {
      if (t.objectIndex !== f.objectIndex || t.partIndex !== f.partIndex) continue;
      if (!t.triangles.some((i) => tris.has(i))) continue;
      if (t.mode === 'raised') up = Math.max(up, t.height); else down = Math.max(down, t.height);
    }
    if (!up && !down) return null;
    any = true;
    return { outward: 0.05 + up, inward: skinDepth + down };
  });
  return any ? out : undefined;
}

// Accumulate a uvw bounding box over several vertex arrays (projected by R).
function boxUVW(meshes: Float32Array[], R: number[]): CropBox {
  let lou = Infinity, lov = Infinity, low = Infinity, hiu = -Infinity, hiv = -Infinity, hiw = -Infinity;
  for (const v of meshes) {
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

/** One model object's bounding box in uvw (all its parts), expanded by a 1 mm margin each side. */
function objectBoxUVW(obj: ModelObject, R: number[]): CropBox {
  return boxUVW(obj.parts.map((p) => p.mesh.vertices), R);
}

/** One part's bounding box in uvw, expanded by a 1 mm margin each side. */
function partBoxUVW(part: ModelPart, R: number[]): CropBox {
  return boxUVW([part.mesh.vertices], R);
}

/** Accumulate an xyz (model-space) bounding box over several vertex arrays, + a 1 mm margin each side.
 *  Cylindrical modifiers are warped straight into xyz, so their crops are axis-aligned xyz boxes. */
function boxXYZ(meshes: Float32Array[]): CropBox {
  let lx = Infinity, ly = Infinity, lz = Infinity, hx = -Infinity, hy = -Infinity, hz = -Infinity;
  for (const v of meshes) {
    for (let i = 0; i < v.length; i += 3) {
      const x = v[i], y = v[i + 1], z = v[i + 2];
      if (x < lx) lx = x; if (x > hx) hx = x;
      if (y < ly) ly = y; if (y > hy) hy = y;
      if (z < lz) lz = z; if (z > hz) hz = z;
    }
  }
  const m = 1.0;
  return { min: [lx - m, ly - m, lz - m], max: [hx + m, hy + m, hz + m] };
}

/** One model object's xyz bounding box (all its parts), expanded by a 1 mm margin each side. */
function objectBoxXYZ(obj: ModelObject): CropBox {
  return boxXYZ(obj.parts.map((p) => p.mesh.vertices));
}

/** One part's xyz bounding box, expanded by a 1 mm margin each side. */
function partBoxXYZ(part: ModelPart): CropBox {
  return boxXYZ([part.mesh.vertices]);
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
