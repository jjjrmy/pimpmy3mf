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
  - **Per-part modifiers** (checkbox, shown for multi-part models): every part becomes its own object
    with its own cropped modifiers, so each part can go on its own plate in any orientation. The camo
    stays exactly where it was in the assembled pose, so the seams line up after assembly.
  - **Cylindrical projection:** wrap the pattern around the model as a tube instead of projecting it
    flat. The image width wraps once around the axis and each color becomes a radial wedge. Also in
    the CLI (`--projection cylindrical`).
  - **Lay on face** (web-only): click a face to lay the model flat on it before projecting. Undo and
    Reset orientation bring it back.
  - **Paint face** (web-only): pick a palette color, then click or drag across faces. Painted faces
    print solid in that color, ~1 mm deep, instead of the camo. The eraser removes them.
  - **Texture face** (web-only): real grip relief on flat or curved faces. Pick diamond knurl,
    stipple, ridges, hex or a pattern from your library, raised or recessed, 0.2–1.5 mm deep, with a
    pitch and angle. All of it is set in the TEXTURE tab; turning the tool on opens that tab. The selected surface is subdivided and pushed along its normals, fading out at the
    edge, so it stays one watertight part. The camo still colors it.
  - **Mapping** (per area, TEXTURE tab): Auto / Planar / Cylindrical / Unwrap. Auto projects flat
    faces straight on. On curved ones it measures the pitch along the surface: an arc-length cylinder
    around the region's axis when that doesn't stretch, otherwise a conformal unwrap of the surface.
    Full wraps meet seamlessly. Ovals, rounded rectangles, cones and free-form grips keep the same
    pitch on the sides as on the front. On domes (spheres, capsule ends) the cells stay square but
    get smaller toward the poles, and the relief fades out at the poles. Areas saved without a
    mapping use Auto.
  - `bun scripts/validate-texture-stretch.ts` measures the ridge pitch around each test shape.
- **UI:** "The 3MF Pimper", styled after the MTV *Pimp My Ride* Flash game.
  - Drag an image or a model anywhere on the page. Loading a model switches to paint mode.
  - The PAINT / DESIGN / COLORS / TEXTURE tabs hold the controls. PAINT picks the model and the camo
    (or your own image); TEXTURE holds the grip patterns and the list of textured areas.
  - **Pattern library** (TEXTURE tab): "+ Upload pattern" (or drop an image on it) turns any image
    into a grayscale height map, at most 512 px, white = high. It is saved in the browser's IndexedDB,
    never uploaded, and stays across visits. Your patterns can be renamed or deleted. A textured area
    keeps its own copy of the map, so deleting a pattern doesn't change it. An image dropped anywhere
    else on the page still becomes the camo.
  - The green buttons export.
  - Headings use [Lilita One](https://fonts.google.com/specimen/Lilita+One) (SIL OFL, self-hosted
    in `public/fonts/`).
- **MW2 camo presets:** glossy round swatches of the Call of Duty: Modern Warfare 2 (2009) camos on
  the PAINT tab. Picking one loads it like an upload.
  - The images are third-party artwork. They are NOT in this repo; they live in a Cloudflare R2
    bucket served by the Worker (`/api/presets`, `/presets/<file>`).
  - `scripts/presets/` collects them through the Fandom MediaWiki API, converts them to WebP,
    writes a manifest and uploads to R2, all from a git-ignored `presets-data/` folder.
  - Without the R2 binding or data (forks, `vite dev`), the picker simply doesn't show.
- **Pattern rotation and offset** in both modes. The pattern wraps, so nothing is ever left
  uncovered.
- **Paint depth** in both modes, in the web app and the CLI (`--depth MM`; default full). On a
  painted model only an outer shell that deep is colored, so the core prints in filament 1. On an
  image tile the colors fill only its top over a one-color base, and it prints as one piece.
  - Only the outside surfaces are colored. Inside surfaces (bores, holes, sealed cavities, recessed
    mounting pockets) print in filament 1, at a set depth and at Full. A triangle is inside when its
    *openness* is under the **What counts as inside** threshold (0.30 deep holes only … 0.90 shallow dips
    too; default 0.70). Openness is the share of cosine-weighted rays from the face that escape or hit the
    part within 3 mm, voxel-marched and smoothed over 1.5 mm, with islands under 20 mm² flipped
    (`src/core/openness.ts`). Finger grooves, open corners and shallow dishes stay outside at the default.
    The shell then loses a skin under the inside faces (`src/core/plug.ts`; at Full a 2 mm skin).
    **Paint inside surfaces** colors them too (`scripts/validate-inner.ts` checks both).
  - The heavy sliders (paint depth, resolution, texture height / pitch / rotation) regenerate when you let
    go. A run stuck behind a long shell or texture build is stopped by replacing the worker.
- **Filament suggestions:** ◀ ▶ through real filaments for each color, from two merged catalogs:
  [filamentcolors.xyz](https://filamentcolors.xyz) (lab-**measured** colors) and
  [SpoolmanDB](https://github.com/Donkie/SpoolmanDB) (manufacturer-listed **maker** colors). Each
  suggestion carries a small `measured` / `maker color` badge. Multi-color SpoolmanDB spools are skipped
  (a single hex would misrepresent them); brands are folded across both sources, keeping the
  filamentcolors spelling when a brand appears in both.
  - The list is each brand's closest swatch (CIEDE2000), closest brand first, with brand and material
    filters. The material dropdown is normalized across both sources: **Any · PLA (all) · PLA basic ·
    PLA+ / Pro / Tough · PETG · ABS · ASA · TPU · Other** (`materialClass` in `src/shared/filaments.ts`).
    `PLA+ / Pro / Tough` is the +/Pro/Tough/Super/HTPLA strength grades; matte/silk/glow, wood-filled and
    carbon-fiber PLA count as `PLA basic`. PCTG/PETG-CF/HF and CPE fold into PETG; PET/PET-CF and PC/ABS
    blends fall to Other. Default is `PLA (all)`.
  - Picking one sets that color everywhere, and Reset brings back the detected color. Changing the
    material filter resets every row to its detected color (changing brands leaves picks alone).
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
  - **Studio versions:** projects for the printers that Bambu Studio 1.10 ships (X1 Carbon, X1, X1E, P1S,
    P1P, A1, A1 mini) are built from 1.10 templates, so they open in Studio 1.10 and every newer version.
    P2S and H2S only exist in Studio 2.x, so their projects need Studio 2.8 or newer. (Studio 1.10
    opens the plain .3mf but ignores its per-part filaments, so it prints in one color there.)
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
worker/           Cloudflare Worker: static assets, /api/filaments (edge-cached filamentcolors.xyz pages;
                  ?source=spoolman proxies the SpoolmanDB dump unparsed), /api/presets + /presets/*
                  (camo presets from R2), www -> apex redirect
scripts/
  headless.ts                 run the pipeline under bun: bun scripts/headless.ts in.rgba --out dir [...]
  decode-image.py             image -> .rgba for headless.ts
  capture-bambu-templates.py  regenerate the Bambu templates from a local Bambu Studio (system presets only)
  validate-bambu.ts           build projects and slice them with the Bambu Studio CLI
  validate-studio-compat.ts   every printer x case, sliced in Bambu Studio 1.10 and 2.8
  validate-tower.ts           prime tower vs the no-print area, beds and models, every printer x nozzle
  render-gcode.py             top-down G-code render colored by filament (used by the validator)
  presets/                    camo presets: fetch_camos.py (discover) -> build_presets.py (WebP + manifest)
                              -> upload_r2.py (to the R2 bucket); output in git-ignored presets-data/
```

Test fixtures live in the git-ignored `scratch/` folder.

## Notes

- A thickness or color change doesn't re-run tracing. A new image, color count, size, smoothing
  value or pattern transform does: about 0.5 s for a 512 px image at 100 mm.
- The templates come from Bambu Studio 1.10 (the printers it ships) and 2.8 (P2S, H2S), so older
  Studios can open the projects. To re-capture, run `scripts/capture-bambu-templates.py` with
  `BAMBU_STUDIO` pointing at a 1.10 binary for the 1.10 printers, and with the installed Studio for the
  rest. `scripts/validate-studio-compat.ts` slices every case in both versions.
- The prime tower goes where it fits: clear of the printer's no-print area (the X1/P1 purge chute at
  the front-left) and of the model, preferring a back corner. Its size is estimated from the color
  count and layer height. If nothing fits, the export warns you.

## Credits

- Filament color data: [filamentcolors.xyz](https://filamentcolors.xyz) (CC BY 4.0) and
  [SpoolmanDB](https://github.com/Donkie/SpoolmanDB) (MIT).
- Geometry: [manifold-3d](https://github.com/elalish/manifold).
- 3D preview: [three.js](https://threejs.org).
- Zip/3MF packaging: [fflate](https://github.com/101arrowz/fflate).

See [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md) for their licenses.

## License

[PolyForm Noncommercial 1.0.0](../LICENSE). Copyright 2026 Jeremy Holstein.
Free for noncommercial use; redistributions and derivatives must credit Jeremy Holstein and link
https://github.com/jjjrmy/pimpmy3mf. Files you make with the app are yours, including selling the
prints. For commercial licensing, open an issue or contact [@jjjrmy](https://github.com/jjjrmy) on
GitHub. See the [root README](../README.md#license) for details.
