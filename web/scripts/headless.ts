// Headless driver for the geometry pipeline (runs under bun, no browser/UI).
// Usage:
//   bun scripts/headless.ts in.rgba [--model file] [--colors N] [--palette '#..,#..']
//        [--width W] [--height H] [--thickness T] [--smooth S] [--min-feature M]
//        [--resolution R] [--axis z|y|x] [--rotation DEG] [--offset-x MM] [--offset-y MM] [--per-part] --out DIR
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createPipeline } from '../src/core/pipeline';
import { loadModel, writeStl } from '../src/core/meshio';
import { DEFAULT_PARAMS, type Params, type RasterImage, type RGB, type Mesh, type Model } from '../src/core/types';
import { parseHex } from '../src/core/color';

function readRgba(path: string): RasterImage {
  const buf = readFileSync(path);
  if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'RGBA') throw new Error(`not a .rgba file: ${path}`);
  const width = buf.readUInt32LE(4), height = buf.readUInt32LE(8);
  const data = new Uint8ClampedArray(width * height * 4);
  data.set(buf.subarray(12, 12 + width * height * 4));
  return { width, height, data };
}

function parseArgs(argv: string[]) {
  const a: Record<string, string> = {};
  let input = '';
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t.startsWith('--')) {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) { a[t.slice(2)] = ''; } // boolean flag
      else { a[t.slice(2)] = next; i++; }
    } else if (!input) input = t;
  }
  return { input, a };
}

function buildParams(a: Record<string, string>): Params {
  const num = (k: string, d: number) => (a[k] != null ? parseFloat(a[k]) : d);
  const palette: RGB[] | null = a.palette
    ? a.palette.split(/[,\s]+/).filter(Boolean).map(parseHex)
    : null;
  return {
    colors: a.colors != null ? parseInt(a.colors, 10) : DEFAULT_PARAMS.colors,
    palette,
    width: a.width != null ? parseFloat(a.width) : null,
    height: a.height != null ? parseFloat(a.height) : null,
    thickness: num('thickness', DEFAULT_PARAMS.thickness),
    smooth: num('smooth', DEFAULT_PARAMS.smooth),
    minFeature: num('min-feature', DEFAULT_PARAMS.minFeature),
    resolution: num('resolution', DEFAULT_PARAMS.resolution),
    axis: (a.axis as Params['axis']) ?? DEFAULT_PARAMS.axis,
    rotation: num('rotation', DEFAULT_PARAMS.rotation),
    offsetX: num('offset-x', DEFAULT_PARAMS.offsetX),
    offsetY: num('offset-y', DEFAULT_PARAMS.offsetY),
    perPart: 'per-part' in a ? true : DEFAULT_PARAMS.perPart,
  };
}

function triCount(m: Mesh | null): number { return m ? m.triangles.length / 3 : 0; }

async function main() {
  const { input, a } = parseArgs(process.argv.slice(2));
  if (!input || !a.out) throw new Error('usage: headless.ts in.rgba [...flags] --out DIR');
  const outDir = a.out;
  mkdirSync(outDir, { recursive: true });

  const image = readRgba(input);
  let model: Model | null = null;
  let loadMs = 0;
  if (a.model) {
    const lt = performance.now();
    model = loadModel(new Uint8Array(readFileSync(a.model)), a.model);
    loadMs = performance.now() - lt;
  }

  const params = buildParams(a);
  const pipe = createPipeline();

  const t0 = performance.now();
  const result = await pipe.run(image, model, params);
  const fullMs = performance.now() - t0;

  // write per-region STLs (full uncropped prism)
  const files: (string | null)[] = [];
  for (const reg of result.regions) {
    if (!reg.mesh) { files.push(null); continue; }
    const name = `${reg.index + 1}-${reg.hex.slice(1)}${model ? '-modifier' : ''}.stl`;
    writeFileSync(join(outDir, name), writeStl(reg.mesh));
    files.push(name);
  }

  // paint mode: print model structure + write per-object cropped modifier STLs
  if (result.model) {
    console.log(`model: ${result.model.objects.length} object(s)`);
    result.model.objects.forEach((obj, j) => {
      const tris = obj.parts.reduce((s, p) => s + p.mesh.triangles.length / 3, 0);
      console.log(`  object ${j + 1} "${obj.name}": ${obj.parts.length} part(s), ${tris} tris`
        + ` [${obj.parts.map((p) => p.name).join(', ')}]`);
    });
    for (const reg of result.regions) {
      if (!reg.objectMeshes) continue;
      reg.objectMeshes.forEach((m, j) => {
        if (!m) return;
        writeFileSync(join(outDir, `obj${j + 1}-${reg.index + 1}-${reg.hex.slice(1)}-modifier.stl`), writeStl(m));
      });
    }
    // per-part cropped modifier STLs: obj<j>-part<k>-<i>-<HEX>-modifier.stl
    if (params.perPart && result.regions.some((r) => r.partMeshes)) {
      console.log('per-part modifiers:');
      result.model.objects.forEach((obj, j) => {
        obj.parts.forEach((p, k) => {
          const cnt = result.regions.filter((r) => r.partMeshes?.[j]?.[k]).length;
          console.log(`  obj ${j + 1} part ${k + 1} "${p.name}": ${cnt} color modifier(s)`);
        });
      });
      for (const reg of result.regions) {
        if (!reg.partMeshes) continue;
        reg.partMeshes.forEach((parts, j) => parts.forEach((m, k) => {
          if (!m) return;
          writeFileSync(join(outDir, `obj${j + 1}-part${k + 1}-${reg.index + 1}-${reg.hex.slice(1)}-modifier.stl`), writeStl(m));
        }));
      }
    }
  }

  // thickness-only re-run to demonstrate the cache (image mode: changes extrude only)
  const t1 = performance.now();
  await pipe.run(image, model, { ...params, thickness: params.thickness + 0.5 });
  const reRunMs = performance.now() - t1;

  const summary = {
    mode: result.mode,
    frame: result.frame,
    tile: result.tile,
    axis: result.axis,
    stats: result.stats,
    warnings: result.warnings,
    timings: { loadMs: +loadMs.toFixed(1), fullMs: +fullMs.toFixed(1), thicknessRerunMs: +reRunMs.toFixed(1) },
    model: result.model ? result.model.objects.map((obj) => ({
      name: obj.name,
      parts: obj.parts.map((p) => ({ name: p.name, triangles: p.mesh.triangles.length / 3 })),
    })) : null,
    regions: result.regions.map((r, i) => ({
      filament: r.index + 1,
      hex: r.hex,
      rgb: r.rgb.map((v) => Math.round(v)),
      coverage: +(r.coverage * 100).toFixed(1),
      triangles: triCount(r.mesh),
      objectTriangles: r.objectMeshes ? r.objectMeshes.map(triCount) : null,
      partTriangles: r.partMeshes ? r.partMeshes.map((o) => o.map(triCount)) : null,
      rings: r.rings.length,
      file: files[i],
    })),
  };
  writeFileSync(join(outDir, 'summary.json'), JSON.stringify(summary, null, 2));

  // dump rings (mm/uv frame) for the top-down PNG
  const ringsDump = {
    frame: result.frame,
    regions: result.regions.map((r) => ({
      hex: r.hex,
      rings: r.rings.map((flat) => Array.from(flat)),
    })),
  };
  writeFileSync(join(outDir, 'rings.json'), JSON.stringify(ringsDump));

  // best-effort top-down ring PNG via the Python helper (needs PIL)
  const drawPy = join(dirname(fileURLToPath(import.meta.url)), '..', 'scratch', 'check', 'draw_rings.py');
  const py = process.env.IMG2COLOR_PY ?? 'python3';
  try {
    execFileSync(py, ['-I', drawPy, join(outDir, 'rings.json'), join(outDir, 'rings.png')], { stdio: 'ignore' });
  } catch {
    console.log('  (rings.png skipped: no python3/PIL; run scratch/check/draw_rings.py manually)');
  }

  pipe.dispose();

  // console summary
  console.log(`${input}: ${result.stats.imageW}x${result.stats.imageH}px -> ${result.regions.length} colors, `
    + `${result.tile.w.toFixed(1)} x ${result.tile.h.toFixed(1)} mm, grid ${result.stats.gridW}x${result.stats.gridH} @ ${result.stats.pitch.toFixed(3)} mm`);
  for (const r of summary.regions) {
    console.log(`  filament ${r.filament}: ${r.hex}  ${r.coverage.toFixed(1)}%  ${r.triangles} tris  ${r.file ?? '(none)'}`);
  }
  for (const w of result.warnings) console.log(`  note: ${w}`);
  console.log(`${a.model ? `model load ${loadMs.toFixed(0)}ms, ` : ''}full run ${fullMs.toFixed(0)}ms, thickness-only re-run ${reRunMs.toFixed(0)}ms`);
  console.log(`wrote ${outDir}/ (summary.json, rings.json, ${files.filter(Boolean).length} STL files)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
