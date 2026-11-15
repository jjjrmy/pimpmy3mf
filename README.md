# pimpmy3mf

Turn any image into a multi-color 3D print. Simplify a picture to N colors, then either:
- get one 3D shape per color, or
- paint your own model (STL/3MF/OBJ) with it as Bambu Studio modifier volumes.

Either way you download a ready-to-print **Bambu Studio project** with the filament colors already
set.

**Try it: https://pimpmy3mf.app.** It runs entirely in your browser; your files never leave your
machine.

This repo has two tools that use the same algorithm:

| Folder | What | Stack |
|---|---|---|
| [`web/`](web) | The pimpmy3mf web app (live preview, filament suggestions, 36 Bambu printer/nozzle presets). Served by a Cloudflare Worker. | TypeScript, React, three.js, manifold-3d (WASM) |
| [`cli/`](cli) | `img2color`, the original command-line tool. Uses the local Bambu Studio CLI to build projects. | Python (numpy, scipy, shapely, manifold3d) |

## Web app

```sh
cd web
bun install
bun run dev          # http://localhost:5173
bun run worker:dev   # build + serve through wrangler (includes the /api routes) at http://localhost:8787
bun run deploy       # build + wrangler deploy (uses your `wrangler login` account)
```

See [`web/README.md`](web/README.md) for features and code layout.

## CLI: `img2color`

Needs Python 3.10+. It sets up its own virtualenv in `cli/.venv` on first run. Building Bambu
Studio projects (rather than plain 3MFs) needs Bambu Studio installed (macOS:
`/Applications/BambuStudio.app`).

```sh
cli/img2color --help

# optional: put it on your PATH
ln -sfn "$PWD/cli/img2color" ~/.local/bin/img2color

img2color camo.png --colors=3                         # one shape per color, 100 mm wide
img2color camo.png --colors=4 --size=150 --thickness=1.2
img2color camo.png --palette="#1E1E1E,#8B3A3A,#9A9A9A"   # snap to the filaments you own
img2color camo.png --colors=3 --apply-to part.3mf --size=60 --rotate=30 --offset=5,0
img2color camo.png --colors=3 --apply-to part.3mf --axis=z  # project top-down instead of from the front (y)
img2color camo.png --colors=3 --apply-to can.stl --projection cylindrical  # wrap the pattern around the model as a tube
img2color camo.png --colors=3 --apply-to assembly.3mf --per-part  # one object per part, texture stays aligned
img2color camo.png --colors=3 --apply-to part.3mf --depth=0.6      # color only a 0.6 mm skin; the core prints in filament 1
img2color camo.png --colors=3 --thickness=2 --depth=0.4            # one-color 2 mm tile, colors only in its top 0.4 mm
```

**Pattern depth** (`--depth MM`, default full) works in both the web app and the CLI. When painting a
model, only an outer shell MM thick gets the colors, cut to each part's own surface, so the infill
and inner walls print in filament 1. On an image tile thinner than `--thickness`, the 3MF holds one
full-thickness piece on filament 1 with the other colors as modifiers over its top MM, so it prints
as one piece. The per-color STLs are then the matching pieces: color 1 is the base plus its own top,
and every other color is its cap.

**Cylindrical projection** (wrap the pattern around a model) works in both the web app and the CLI
(`--projection cylindrical`). The web app also has three interactive tools that are web-only: **Lay on
face** (click a face to lay the model flat on it), **Paint face** (brush colors straight onto the
model) and **Texture face** (add knurl, stipple, ridges, hex or image relief to a flat or curved
surface). Grip patterns live in the web app's TEXTURE tab, along with a pattern library of your own
height maps that stays in your browser.

Output goes next to the image in `<name>-<N>colors/`:
- a Bambu Studio project `.3mf`, or a plain 3MF with `--no-bambu`;
- one STL per color;
- a preview PNG;
- `colors.txt`.

**Bambu Studio version:** the project opens in the Studio version that built it, or newer (Studio 1.10
refuses a 2.x project). To make one for an older Studio, point `BAMBU_STUDIO` at that version's binary;
it then uses only that build's own presets, and fills in the settings it lacks from the installed
Studio (same printer) so newer Studios slice the project too:

```sh
BAMBU_STUDIO=/path/to/BambuStudio.app/Contents/MacOS/BambuStudio \
  img2color camo.png --colors=3 --printer "Bambu Lab X1 Carbon 0.4 nozzle"
```

Otherwise use `--no-bambu` for a plain 3MF that any version opens (Studio 1.10 ignores its per-part
filaments, though, so it prints in one color there).

## License

[MIT](LICENSE) © 2026 Jeremy Holstein
