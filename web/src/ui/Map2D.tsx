import { useEffect, useRef } from 'react';
import type { Result } from '../core/types';
import { drawColorMap, mapScale, type MapRegion } from './colorMap';

interface Map2DProps {
  result: Result | null;
  hexes: string[];
  hidden: Set<number>;
  imageUrl: string | null;
  active: boolean;
}

export function Map2D({ result, hexes, hidden, imageUrl, active }: Map2DProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !result || !active) return;
    const { s, w, h } = mapScale(result.frame, 760);
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, w, h);
    const regions: MapRegion[] = result.regions
      .filter((r) => !hidden.has(r.index))
      .map((r) => ({ rings: r.rings, color: hexes[r.index] ?? r.hex }));
    drawColorMap(ctx, regions, result.frame, s);
  }, [result, hexes, hidden, active]);

  if (!result) return null;
  return (
    <div className="map2d">
      <figure>
        <figcaption>Original</figcaption>
        {imageUrl ? <img src={imageUrl} alt="original" /> : <div className="map2d-empty">—</div>}
      </figure>
      <figure>
        <figcaption>Color map</figcaption>
        <canvas ref={canvasRef} />
      </figure>
    </div>
  );
}
