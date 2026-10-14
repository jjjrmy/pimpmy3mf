# pimpmy3mf: web app

The browser app behind https://pimpmy3mf.app. See the [root README](../README.md) for the
project overview and the Python CLI.

Turn any image into a multi-color 3D print. Upload a picture, simplify it to N colors, and get one 3D
shape per color, with a live 3D preview. You can also paint your own model (STL/3MF/OBJ) with the
image as Bambu Studio modifier volumes. Downloads include a ready-to-print **Bambu Studio project**
with the filament colors already set.

**Live: https://pimpmy3mf.app**

Everything runs in your browser: a Web Worker with TypeScript plus the
[manifold-3d](https://github.com/elalish/manifold) WASM build. Your images and models never leave
your machine. The Cloudflare Worker only serves the static files and one small cached API route
for filament data.

The geometry pipeline is a TypeScript port of the Python CLI in [`../cli`](../cli) (`img2color`).
Both use the same algorithm.

## Features

- **Image tile:** one flat, gap-free shape per color.
  - Colors come from k-means in CIELAB, or are snapped to your own palette in AMS slot order.
  - Edges are smoothed and specks too small to print are removed.
- **Paint a model:** the color map is projected top-down, from the front or from the side, either
  stretched over the model or tiled every N mm.
  - Each color becomes a Bambu modifier volume.
  - Multi-part and multi-object 3MFs keep their structure: parts stay separate and named, and
    every object gets its own modifiers.
- **Pattern rotation and offset** in both modes. The pattern wraps, so nothing is ever left
  uncovered.
- **Filament suggestions:** ◀ ▶ through real filaments from [filamentcolors.xyz](https://filamentcolors.xyz)
  for each color.
  - The list is each brand's closest swatch (CIEDE2000), closest brand first, with material and
    brand filters.
  - Picking one sets that color everywhere, and Reset brings back the detected color.
- **Downloads:**

  | Button | File |
  |---|---|
  | Bambu project .3mf | A full Bambu Studio project: printer/process presets, one PLA Basic filament per color carrying its hex, flush volumes, the object centered, and the prime tower placed so it fits. |
  | Plain .3mf | Objects and parts with per-part filament and subtype, for any slicer that reads Bambu/Orca metadata. |
  | STLs (.zip) | One STL per color, sharing one frame, so they line up when imported together. |
  | Preview .png | The original image next to the simplified color map. |

- **Printers:** the Bambu button lets you pick printer and nozzle. There are 36 combos: P2S,
  X1 Carbon, X1, X1E, P1S, P1P, A1, A1 mini and H2S, each with 0.2 / 0.4 / 0.6 / 0.8.
  - Each template was captured from Bambu Studio's own CLI exports and checked by slicing a
    generated project: return code 0, the right filament colors, and every filament extruding.
  - The dual-nozzle H2C and H2D aren't supported yet.

## Run it

From this `web/` folder:

```sh
bun install
bun run dev          # http://localhost:5173 (Vite, hot reload; filament data comes straight from filamentcolors.xyz)
bun run worker:dev   # build, then serve dist/ + the API route through wrangler at http://localhost:8787
bun run typecheck    # app + worker
bun run deploy       # build + wrangler deploy (uses your `wrangler login` account)
```

## Layout

```
src/core/         geometry + file formats (no DOM; runs in the Web Worker and under bun)
  types.ts          shared contract between core, worker and UI
  pipeline.ts       staged + cached run(): quantize -> grid -> despeckle -> trace -> extrude
  color.ts          CIELAB k-means++ / palette snapping
  raster.ts         blur + affine resample, EDT despeckle
  trace.ts          planar-graph boundary chains, smoothing, simplification, rings
  extrude.ts        manifold extrusion (0.5 µm inset), paint-mode prisms
  meshio.ts         STL/OBJ/3MF loading (structure kept), STL writing
  threemf.ts        plain 3MF + Bambu project writer
  bambu/            per printer × nozzle project templates, flush volumes
src/shared/       filament data: slimming, CIELAB, CIEDE2000, ranking (used by app + worker)
src/worker/       pipeline Web Worker + typed client
src/ui/           React components (controls, three.js viewer, 2D map, legend, downloads)
worker/           Cloudflare Worker: static assets + /api/filaments (edge-cached filamentcolors.xyz pages)
scripts/
  headless.ts                 run the pipeline under bun: bun scripts/headless.ts in.rgba --out dir [...]
  decode-image.py             image -> .rgba for headless.ts
  capture-bambu-templates.py  regenerate the Bambu templates from a local Bambu Studio (system presets only)
  validate-bambu.ts           build projects and slice them with the Bambu Studio CLI
  render-gcode.py             top-down G-code render colored by filament (used by the validator)
```

Test fixtures live in the git-ignored `scratch/` folder.

## Notes

- A thickness or color change doesn't re-run tracing. A new image, color count, size, smoothing
  value or pattern transform does: about 0.5 s for a 512 px image at 100 mm.
- The templates come from Bambu Studio 2.8. Run `scripts/capture-bambu-templates.py` again after a
  Bambu Studio update.

## Credits

- Filament color data: [filamentcolors.xyz](https://filamentcolors.xyz).
- Geometry: [manifold-3d](https://github.com/elalish/manifold).
- 3D preview: [three.js](https://threejs.org).
- Zip/3MF packaging: [fflate](https://github.com/101arrowz/fflate).

## License

[MIT](../LICENSE) © 2026 Jeremy Holstein
