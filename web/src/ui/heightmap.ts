// Custom texture height maps: decode an uploaded image on the main thread into a small 8-bit grayscale
// HeightMap (white = high), and turn one back into a data URL for thumbnails.
import type { HeightMap } from '../core/types';

const MAX_SIDE = 256;

/** Decode an image file to grayscale, downscaled so the longest side is at most 256 px. */
export async function decodeHeightMap(file: Blob): Promise<HeightMap> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error("Couldn't read that image. Try a PNG or JPG.");
  }
  try {
    const s = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * s));
    const height = Math.max(1, Math.round(bitmap.height * s));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('Canvas 2D is not available.');
    // transparent pixels read as black (low) rather than whatever color they hide
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, width, height);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, 0, 0, width, height);
    const rgba = ctx.getImageData(0, 0, width, height).data;
    const data = new Uint8Array(width * height);
    for (let i = 0, p = 0; i < data.length; i++, p += 4) {
      data[i] = Math.round(0.2126 * rgba[p] + 0.7152 * rgba[p + 1] + 0.0722 * rgba[p + 2]);
    }
    return { width, height, data };
  } finally {
    bitmap.close();
  }
}

const urlCache = new WeakMap<HeightMap, string>();

/** PNG data URL of a height map (cached per map object). */
export function heightMapUrl(map: HeightMap): string {
  const hit = urlCache.get(map);
  if (hit) return hit;
  const canvas = document.createElement('canvas');
  canvas.width = map.width;
  canvas.height = map.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return '';
  const img = ctx.createImageData(map.width, map.height);
  for (let i = 0, p = 0; i < map.data.length; i++, p += 4) {
    img.data[p] = img.data[p + 1] = img.data[p + 2] = map.data[i];
    img.data[p + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  const url = canvas.toDataURL('image/png');
  urlCache.set(map, url);
  return url;
}
