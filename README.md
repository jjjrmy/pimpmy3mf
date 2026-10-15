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
```

**Cylindrical projection** (wrap the pattern around a model) works in both the web app and the CLI
(`--projection cylindrical`). The web app also has two interactive tools that are web-only: **Lay on
face** (click a face to lay the model flat on it) and **Paint face** (brush colors straight onto the
model).

Output goes next to the image in `<name>-<N>colors/`:
- a Bambu Studio project `.3mf`, or a plain 3MF with `--no-bambu`;
- one STL per color;
- a preview PNG;
- `colors.txt`.

## License

[MIT](LICENSE) © 2026 Jeremy Holstein
