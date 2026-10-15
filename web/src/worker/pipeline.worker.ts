// Pipeline Web Worker. Owns the manifold WASM, the decoded image, the loaded model and the pipeline.
// The main thread never runs the pipeline — it only sends params and receives cloned results.
//
// Cancellation: every run gets a mutable signal object. A new run flips the previous signal's
// `cancelled` to true; the pipeline yields between stages and rejects with an Error named 'Cancelled'.

import wasmUrl from 'manifold-3d/manifold.wasm?url';
import { zipSync } from 'fflate';

import { createPipeline } from '../core/pipeline';
import { initManifold } from '../core/manifold';
import { loadModel, writeStl } from '../core/meshio';
import { objectsFromResult, writeBambuProject, writePlain3mf } from '../core/threemf';
import type { Model, Pipeline, RasterImage, Result } from '../core/types';

import { drawColorMap, fadeOutsideSilhouette, mapScale, type MapRegion } from '../ui/colorMap';
import type { ExportOpts, ExportResult, Request, Response } from './messages';

const ctx = self as unknown as DedicatedWorkerGlobalScope;

let pipeline: Pipeline | null = null;
let image: RasterImage | null = null;
let imageStem = 'image';
let model: Model | null = null;
let modelStem = 'model';
let lastResult: Result | null = null;
let currentSignal: { cancelled: boolean } | null = null;

function post(msg: Response, transfer?: Transferable[]): void {
  ctx.postMessage(msg, transfer ?? []);
}

/** `re.sub(r"[^\w.-]+", "_", stem)` on the filename without its extension, mirroring the CLI. */
function safeStem(name: string): string {
  const base = name.replace(/\.[^./\\]+$/, '').replace(/^.*[\\/]/, '');
  return (base || 'file').replace(/[^\w.-]+/g, '_');
}

async function ensurePipeline(): Promise<Pipeline> {
  if (!pipeline) {
    await initManifold({ wasmUrl });
    pipeline = createPipeline();
  }
  return pipeline;
}

async function decodeImage(blob: Blob): Promise<RasterImage> {
  const bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' });
  const canvas = new OffscreenCanvas(bmp.width, bmp.height);
  const c2d = canvas.getContext('2d');
  if (!c2d) throw new Error('Could not get a 2D canvas to decode the image.');
  c2d.drawImage(bmp, 0, 0);
  const { data } = c2d.getImageData(0, 0, bmp.width, bmp.height);
  const raster: RasterImage = { width: bmp.width, height: bmp.height, data };
  bmp.close();
  return raster;
}

// ---- preview / thumbnail rendering (OffscreenCanvas) -----------------------------------------

function mkOffscreen(w: number, h: number) {
  const canvas = new OffscreenCanvas(w, h);
  const c2d = canvas.getContext('2d');
  if (!c2d) throw new Error('OffscreenCanvas 2D context unavailable.');
  return { canvas, ctx: c2d as OffscreenCanvasRenderingContext2D };
}

function imageToCanvas(img: RasterImage): OffscreenCanvas {
  const { canvas, ctx: c2d } = mkOffscreen(img.width, img.height);
  // Copy into a fresh ArrayBuffer-backed array so ImageData accepts it (not SharedArrayBuffer).
  const bytes = new Uint8ClampedArray(img.data);
  c2d.putImageData(new ImageData(bytes, img.width, img.height), 0, 0);
  return canvas;
}

function mapRegions(result: Result, hexes: string[]): MapRegion[] {
  return result.regions.map((r, i) => ({ rings: r.rings, color: hexes[i] ?? r.hex }));
}

async function toPng(canvas: OffscreenCanvas): Promise<Uint8Array> {
  const blob = await canvas.convertToBlob({ type: 'image/png' });
  return new Uint8Array(await blob.arrayBuffer());
}

async function renderThumbnail(result: Result, hexes: string[]): Promise<Uint8Array> {
  const { s, w, h } = mapScale(result.frame, 320);
  const { canvas, ctx: c2d } = mkOffscreen(w, h);
  c2d.fillStyle = '#ffffff';
  c2d.fillRect(0, 0, w, h);
  drawColorMap(c2d, mapRegions(result, hexes), result.frame, s);
  return toPng(canvas);
}

async function renderPreview(result: Result, hexes: string[], src: RasterImage): Promise<Uint8Array> {
  const { s, w: mapW, h: mapH } = mapScale(result.frame, 900);
  const { canvas: map, ctx: mctx } = mkOffscreen(mapW, mapH);
  mctx.fillStyle = '#ffffff';
  mctx.fillRect(0, 0, mapW, mapH);
  drawColorMap(mctx, mapRegions(result, hexes), result.frame, s);
  // Cylindrical projection unwraps the model, so a planar silhouette fade doesn't apply there.
  if (result.mode === 'paint' && result.model && result.projection !== 'cylindrical') {
    const meshes = result.model.objects.flatMap((o) => o.parts.map((p) => p.mesh));
    fadeOutsideSilhouette(mctx, mapW, mapH, meshes, result.frame, result.axis, mkOffscreen);
  }

  const left = imageToCanvas(src);
  const leftW = Math.max(1, Math.round((left.width * mapH) / left.height));
  const gap = 12;
  const { canvas: sheet, ctx: sctx } = mkOffscreen(leftW + gap + mapW, mapH);
  sctx.fillStyle = '#ffffff';
  sctx.fillRect(0, 0, sheet.width, sheet.height);
  sctx.drawImage(left, 0, 0, leftW, mapH);
  sctx.drawImage(map, leftW + gap, 0);
  return toPng(sheet);
}

// ---- exports ---------------------------------------------------------------------------------

function baseName(result: Result): string {
  return result.mode === 'paint' ? `${modelStem}-${imageStem}` : imageStem;
}

async function doExport(result: Result, kind: string, opts: ExportOpts): Promise<ExportResult> {
  const n = result.regions.length;
  const hexes = opts.hexes;
  const base = baseName(result);

  switch (kind) {
    case 'stl-zip': {
      const files: Record<string, Uint8Array> = {};
      result.regions.forEach((r, i) => {
        if (!r.mesh) return;
        const hex = (hexes[i] ?? r.hex).slice(1);
        const suffix = result.mode === 'paint' ? '-modifier' : '';
        files[`${imageStem}-${i + 1}-${hex}${suffix}.stl`] = writeStl(r.mesh);
      });
      // one STL per painted-face skin (paint mode): <imageStem>-face-<n>-<HEX>.stl
      result.faceSkins.forEach((s, i) => {
        const hex = (hexes[s.color] ?? result.regions[s.color]?.hex ?? '#FFFFFF').slice(1);
        files[`${imageStem}-face-${i + 1}-${hex}.stl`] = writeStl(s.mesh);
      });
      const bytes = zipSync(files, { level: 6 });
      return { filename: `${base}-${n}colors-stls.zip`, bytes, mime: 'application/zip', warnings: [] };
    }
    case 'plain-3mf': {
      // paint mode: one object per input object, its parts kept separate and named, modifiers per object
      const objects = objectsFromResult(result, hexes, imageStem);
      const bytes = writePlain3mf(objects);
      return { filename: `${base}-${n}colors-plain.3mf`, bytes, mime: 'model/3mf', warnings: [] };
    }
    case 'bambu-3mf': {
      const objects = objectsFromResult(result, hexes, imageStem);
      const thumbnailPng = await renderThumbnail(result, hexes);
      const { bytes, warnings } = await writeBambuProject(objects, {
        printerId: opts.printerId,
        filamentColors: hexes,
        plate: opts.plate,
        thumbnailPng,
      });
      return { filename: `${base}-${n}colors.3mf`, bytes, mime: 'model/3mf', warnings };
    }
    case 'preview-png': {
      if (!image) throw new Error('No image loaded to build a preview.');
      const bytes = await renderPreview(result, hexes, image);
      return { filename: `${base}-${n}colors-preview.png`, bytes, mime: 'image/png', warnings: [] };
    }
    default:
      throw new Error(`Unknown export kind: ${kind}`);
  }
}

// ---- message loop ----------------------------------------------------------------------------

ctx.onmessage = async (e: MessageEvent<Request>) => {
  const msg = e.data;
  try {
    switch (msg.type) {
      case 'setImage': {
        imageStem = safeStem(msg.name);
        image = await decodeImage(msg.blob);
        lastResult = null;
        post({ type: 'setImage:ok', reqId: msg.reqId, info: { width: image.width, height: image.height } });
        break;
      }
      case 'setModel': {
        modelStem = safeStem(msg.filename);
        const loaded: Model = loadModel(new Uint8Array(msg.bytes), msg.filename);
        model = loaded;
        lastResult = null;
        let triangles = 0;
        for (const o of loaded.objects) for (const p of o.parts) triangles += p.mesh.triangles.length / 3;
        const objects = loaded.objects.map((o) => ({ name: o.name, parts: o.parts.map((p) => p.name) }));
        post({ type: 'setModel:ok', reqId: msg.reqId, info: { triangles, objects } });
        break;
      }
      case 'clearModel': {
        model = null;
        lastResult = null;
        post({ type: 'clearModel:ok', reqId: msg.reqId });
        break;
      }
      case 'run': {
        if (!image) throw new Error('Load an image first.');
        if (currentSignal) currentSignal.cancelled = true;
        const signal = { cancelled: false };
        currentSignal = signal;
        const pipe = await ensurePipeline();
        const result = await pipe.run(image, msg.useModel ? model : null, msg.params, {
          signal,
          onProgress: (stage, fraction) => {
            if (!signal.cancelled) post({ type: 'progress', reqId: msg.reqId, stage, fraction });
          },
        });
        if (signal.cancelled) {
          // superseded by a newer run: drop the result, but settle the caller's promise
          post({ type: 'error', reqId: msg.reqId, name: 'Cancelled', message: 'Cancelled' });
          break;
        }
        lastResult = result;
        post({ type: 'run:ok', reqId: msg.reqId, result }); // structured clone, arrays not transferred
        break;
      }
      case 'export': {
        if (!lastResult) throw new Error('Nothing to export yet — generate a result first.');
        const result = await doExport(lastResult, msg.kind, msg.opts);
        const buf = result.bytes.buffer as ArrayBuffer;
        post({ type: 'export:ok', reqId: msg.reqId, result }, [buf]);
        break;
      }
      case 'dispose': {
        pipeline?.dispose();
        pipeline = null;
        image = null;
        model = null;
        lastResult = null;
        post({ type: 'dispose:ok', reqId: msg.reqId });
        break;
      }
    }
  } catch (err) {
    const error = err as Error;
    post({ type: 'error', reqId: msg.reqId, name: error?.name ?? 'Error', message: error?.message ?? String(err) });
  }
};
