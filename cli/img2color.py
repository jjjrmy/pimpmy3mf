#!/usr/bin/env python3
"""
img2color - turn an image into one 3D shape per color, for multi-color printing in Bambu Studio.

The image is reduced to N colors (k-means in CIELAB, or snapped to your own --palette). Specks too
small to print are cleaned up. Each color is traced into smooth outlines that tile exactly, with no
gaps or overlaps between colors, and then extruded.

Image mode (default) writes <image folder>/<stem>-<N>colors/:
  <stem>-<N>colors.3mf          one object with one part per color. Each part is on its own filament,
                                and that filament carries the part's hex color. This is a ready-to-open
                                Bambu Studio project when Bambu Studio is installed, else a plain 3MF.
  <stem>-<i>-<RRGGBB>.stl       one STL per color. All share one frame, so importing them together
                                ("load as a single object with multiple parts") lines them up.
  <stem>-<N>colors-preview.png  original | simplified, side by side
  colors.txt                    filament # -> hex -> coverage

Paint mode (--apply-to MODEL) colors an existing model instead. The color shapes become tall
modifier volumes projected through the model: from the front by default (--axis y), or --axis z
for top-down and --axis x for the side.
The 3MF holds the model on filament 1 (the most common color) plus one modifier per other color.
A multi-part / multi-object 3MF keeps its parts and objects separate.

--per-part (paint mode) makes every input PART its own top-level object, carrying only its own
modifiers cropped to that part's bounding box. The texture stays exactly where it is in the
assembled pose - same frame, projection, rotation, offset and tile; only the crop box changes - so
you can print each part separately in any orientation and the camo still lines up once reassembled.

--projection cylindrical (paint mode) wraps the pattern around the model as a tube instead of
projecting it flat. The cylinder axis is --axis through the model's center (default z). The image
width wraps once around (u = R0 * angle, R0 = the model's largest radius about the axis); the height
runs along the axis and repeats if it is shorter than the model. Each color becomes a radial wedge.
--size tiles the pattern N times around; --rotate / --offset still apply, and --offset X turns the
pattern around the axis.

Bambu Studio versions: the project is written by the Bambu Studio CLI, so it opens only in that
Studio version or newer (1.10 refuses a project made by 2.x). To build one for an older Studio, point
BAMBU_STUDIO at that version's binary, e.g.
  BAMBU_STUDIO=/path/to/BambuStudio.app/Contents/MacOS/BambuStudio img2color ... --printer "Bambu Lab X1 Carbon 0.4 nozzle"
It then uses only that build's bundled presets. A --process/--filament it lacks, or one made for
another printer, falls back to the printer's defaults; a printer it lacks (P2S, H2 under 1.10)
gives a plain 3MF. If the installed Studio has the same printer, the settings the older one lacks
are filled in from it, so newer Studios slice the project too. Or use --no-bambu for a plain 3MF
that any version opens (Studio 1.10 ignores its per-part filaments, so there it prints in one color).

--depth MM colors only an outer skin MM deep (default: full depth). In paint mode each modifier is
cut to a shell MM thick inside the surface of what it colors (the part, or the object's parts), so
the core prints in filament 1. In image mode (MM < --thickness) the 3MF is one full-thickness slab
on filament 1 with each other color a modifier over its top MM; the STLs are the matching pieces
(color 1 = the base plus its own top, color k = its cap).

--rotate DEG turns the pattern counterclockwise (as seen in the preview) about the center of the
covered area, then --offset X,Y shifts it in mm (+X right, +Y up). A turned or shifted pattern
repeats past the image edges, so nothing is left uncovered; without --size, --apply-to also scales
the image up enough that a rotated copy still covers the whole model.

Examples:
  img2color camo.png --colors=3
  img2color camo.png --colors=4 --size=150 --thickness=1.2
  img2color camo.png --palette="#1E1E1E,#8B3A3A,#9A9A9A"     # snap to the filaments you own
  img2color camo.png --colors=3 --apply-to part.stl --size=60  # paint part.stl, texture tiled every 60 mm
  img2color camo.png --colors=3 --rotate=30 --offset=10,-5     # turn the pattern 30°, shift it 10 mm right, 5 mm down
  img2color camo.png --colors=3 --apply-to assembly.3mf --per-part  # one object per part, texture stays aligned
  img2color camo.png --colors=3 --apply-to can.stl --projection cylindrical  # wrap the pattern around the model
"""
import argparse
import copy
import glob
import json
import math
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import zipfile
import xml.etree.ElementTree as ET
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageOps
from scipy import ndimage
import shapely
import manifold3d as m3d

BAMBU_APP = "/Applications/BambuStudio.app"
DEFAULT_PRINTER = "Bambu Lab P2S 0.4 nozzle"
DEFAULT_PROCESS = "0.20mm Standard @BBL P2S"
DEFAULT_FILAMENT = "Bambu PLA Basic @BBL P2S"
MAX_CELLS = 6_000_000          # working-grid cap (cells); keeps tracing to a few seconds


def log(msg):
    print(msg, flush=True)


# ----------------------------------------------------------------------------------------- color

def srgb_to_lab(rgb):
    """sRGB (0..1, shape (..., 3)) -> CIELAB (D65)."""
    c = np.where(rgb <= 0.04045, rgb / 12.92, ((rgb + 0.055) / 1.055) ** 2.4)
    m = np.array([[0.4124564, 0.3575761, 0.1804375],
                  [0.2126729, 0.7151522, 0.0721750],
                  [0.0193339, 0.1191920, 0.9503041]])
    xyz = (c @ m.T) / np.array([0.95047, 1.0, 1.08883])
    d = 6 / 29
    f = np.where(xyz > d ** 3, np.cbrt(xyz), xyz / (3 * d * d) + 4 / 29)
    return np.stack([116 * f[..., 1] - 16, 500 * (f[..., 0] - f[..., 1]), 200 * (f[..., 1] - f[..., 2])], -1)


def nearest(x, centers):
    out = np.empty(len(x), np.int32)
    step = 1 << 17
    for s in range(0, len(x), step):
        d = ((x[s:s + step, None, :] - centers[None]) ** 2).sum(-1)
        out[s:s + step] = d.argmin(1)
    return out


def kmeans(x, k, seed=0, restarts=4, iters=50):
    """Plain k-means with k-means++ seeding; best of a few restarts (lowest inertia)."""
    rng = np.random.default_rng(seed)
    best, best_inertia = None, np.inf
    for _ in range(restarts):
        c = [x[rng.integers(len(x))]]
        d2 = ((x - c[0]) ** 2).sum(1)
        for _ in range(1, k):
            if d2.sum() <= 0:
                break
            c.append(x[rng.choice(len(x), p=d2 / d2.sum())])
            d2 = np.minimum(d2, ((x - c[-1]) ** 2).sum(1))
        c = np.array(c)
        for _ in range(iters):
            lab = nearest(x, c)
            nc = np.array([x[lab == i].mean(0) if np.any(lab == i) else c[i] for i in range(len(c))])
            done = np.abs(nc - c).max() < 1e-3
            c = nc
            if done:
                break
        inertia = ((x - c[nearest(x, c)]) ** 2).sum()
        if inertia < best_inertia:
            best, best_inertia = c, inertia
    return best


def parse_hex(s):
    s = s.strip().lstrip("#")
    if len(s) == 3:
        s = "".join(ch * 2 for ch in s)
    if not re.fullmatch(r"[0-9a-fA-F]{6}", s):
        raise SystemExit(f"bad hex color: {s!r} (use RRGGBB or #RRGGBB)")
    return tuple(int(s[i:i + 2], 16) for i in (0, 2, 4))


def to_hex(rgb):
    return "#%02X%02X%02X" % tuple(int(round(v)) for v in rgb)


def quantize(rgba, ncolors, palette):
    """Return (labels HxW with -1 = transparent, list of (r,g,b) colors)."""
    rgb = rgba[..., :3].astype(np.float64)
    opaque = rgba[..., 3] >= 128
    if not opaque.any():
        raise SystemExit("image is fully transparent")
    px = rgb[opaque]
    lab = srgb_to_lab(px / 255.0)
    if palette:
        colors = [np.array(c, float) for c in palette]
        idx = nearest(lab, srgb_to_lab(np.array(colors) / 255.0))
        order = list(range(len(colors)))            # keep the user's order (= AMS slot order)
    else:
        rng = np.random.default_rng(0)
        sample = lab if len(lab) <= 150_000 else lab[rng.choice(len(lab), 150_000, replace=False)]
        uniq = np.unique(np.round(sample, 1), axis=0)
        k = min(ncolors, len(uniq))
        if k < ncolors:
            log(f"note: image only has {k} distinct colors; using {k}")
        centers = kmeans(sample, k)
        idx = nearest(lab, centers)
        counts = np.bincount(idx, minlength=len(centers))
        order = [int(i) for i in np.argsort(-counts) if counts[i] > 0]   # most common first
        colors = [px[idx == i].mean(0) if counts[i] else centers[i] for i in range(len(centers))]
    remap = np.full(len(colors), -1, np.int32)
    remap[order] = np.arange(len(order))
    labels = np.full(rgba.shape[:2], -1, np.int32)
    labels[opaque] = remap[idx]
    return labels, [colors[i] for i in order]


# ---------------------------------------------------------------------------- raster -> regions

def disk(r):
    r = max(1, int(round(r)))
    y, x = np.ogrid[-r:r + 1, -r:r + 1]
    return x * x + y * y <= r * r + r * 0.5


def resample(labels, ncolors, shape, matrix, offset, sigma, wrap):
    """Sample the label map onto the working grid. Each color's mask is blurred (sigma, source px),
    interpolated at grid-cell centers, and the winner taken -> smooth, sub-pixel boundaries.
    sigma == 0 keeps hard pixel edges (nearest neighbour)."""
    best = np.full(shape, -np.inf, np.float32)
    out = np.full(shape, -1, np.int32)
    present = [k for k in range(-1, ncolors) if np.any(labels == k)]
    for k in present:
        ch = (labels == k).astype(np.float32)
        if sigma > 0:
            ch = ndimage.gaussian_filter(ch, sigma, mode="wrap" if wrap else "nearest")
        val = ndimage.affine_transform(ch, matrix, offset=offset, output_shape=shape,
                                       order=1 if sigma > 0 else 0,
                                       mode="grid-wrap" if wrap else "nearest")
        win = val > best
        best[win] = val[win]
        out[win] = k
    return out


def despeckle(grid, radius_px, wrap):
    """Remove features narrower than ~2*radius (an opening per color). Removed cells are given the
    color of the nearest surviving cell, so the result is still a full partition.
    wrap: True = both axes periodic (planar tile), "u" = columns only (cylindrical seam, not the
    open axial ends), False = no wrap."""
    if radius_px < 0.75:
        return grid
    se = disk(radius_px)
    pad = se.shape[0]
    if wrap == "u":
        padded = np.pad(np.pad(grid, ((0, 0), (pad, pad)), mode="wrap"),
                        ((pad, pad), (0, 0)), mode="edge")
    else:
        padded = np.pad(grid, pad, mode="wrap" if wrap else "edge")
    keep = np.zeros(padded.shape, bool)
    for k in np.unique(grid):
        keep |= ndimage.binary_opening(padded == k, structure=se)
    keep = keep[pad:-pad, pad:-pad]
    if keep.all() or not keep.any():
        return grid
    idx = ndimage.distance_transform_edt(~keep, return_distances=False, return_indices=True)
    return grid[idx[0], idx[1]]


def smooth_coverage(polys, owner, grid, sigma=1.5):
    """Smooth the borders of a polygon coverage (grid units, a vertex at every cell) without
    breaking it. The borders are cut into edges between junctions. Each edge gets a Gaussian blur
    along its length (sigma in cells): the grid's staircase steps go, and the shapes stay.
    Edge end points and anything on the outer frame stay put. Edges that would end up crossing are
    left unsmoothed. The faces are then rebuilt from the edges, so neighbours still share one line.
    Returns (polygons, labels), or None if the rebuilt faces don't tile the frame."""
    ny, nx = grid.shape
    lines = shapely.line_merge(shapely.union_all(shapely.boundary(polys)))
    edges = shapely.segmentize(np.array(shapely.get_parts(lines), dtype=object), 1.0)
    r = int(3 * sigma + 0.5)
    smoothed = edges.copy()
    for i, e in enumerate(edges):
        p = shapely.get_coordinates(e)
        if len(p) < 4:
            continue
        on_frame = (p[:, 0] <= 1e-9) | (p[:, 0] >= nx - 1e-9) | (p[:, 1] <= 1e-9) | (p[:, 1] >= ny - 1e-9)
        if e.is_closed:
            q = ndimage.gaussian_filter1d(p[:-1], sigma, axis=0, mode="wrap")
            q = np.vstack([q, q[:1]])
        else:
            pad = np.pad(p, ((r, r), (0, 0)), mode="reflect", reflect_type="odd")
            q = ndimage.gaussian_filter1d(pad, sigma, axis=0, mode="nearest")[r:-r]
            q[0], q[-1] = p[0], p[-1]
        q[on_frame] = p[on_frame]
        smoothed[i] = shapely.linestrings(q)
    for _ in range(4):
        bad = ~shapely.is_simple(smoothed)
        a, b = shapely.STRtree(smoothed).query(smoothed, predicate="crosses")
        bad[a] = True
        bad[b] = True
        if not bad.any():
            break
        smoothed[bad] = edges[bad]
    else:
        return None
    faces = np.array(shapely.get_parts(shapely.polygonize(smoothed)), dtype=object)
    if len(faces) == 0 or abs(shapely.area(faces).sum() - nx * ny) > 1e-6 * nx * ny:
        return None
    # label each face from the grid under an interior point; near-boundary points use the
    # original polygon the face overlaps most
    pts = shapely.point_on_surface(faces)
    xy = shapely.get_coordinates(pts)
    labels = grid[np.clip(xy[:, 1].astype(int), 0, ny - 1), np.clip(xy[:, 0].astype(int), 0, nx - 1)]
    unsure = np.nonzero(shapely.distance(pts, shapely.boundary(faces)) < 1.5)[0]
    if len(unsure):
        tree = shapely.STRtree(polys)
        own = np.asarray(owner)
        for f in unsure:
            cand = tree.query(faces[f], predicate="intersects")
            if len(cand):
                ov = shapely.area(shapely.intersection(faces[f], polys[cand]))
                labels[f] = own[cand[np.argmax(ov)]]
    return faces, [int(k) for k in labels]


def trace(grid, smooth):
    """Exact pixel-edge polygons per color, optionally border-smoothed, then one shared coverage
    simplification so every border between two colors is the SAME line on both sides (no gaps,
    no overlaps). Returns {label: [shapely Polygon in grid units]}."""
    ny, nx = grid.shape
    start = np.ones((ny, nx), bool)
    start[:, 1:] = grid[:, 1:] != grid[:, :-1]
    rows, x0 = np.nonzero(start)
    x1 = np.empty_like(x0)
    x1[:-1] = x0[1:]
    last = np.append(rows[1:] != rows[:-1], True)
    x1[last] = nx
    labs = grid[rows, x0]
    # merge identical runs in consecutive rows into taller boxes (fewer inputs for the union)
    order = np.lexsort((rows, x1, x0, labs))
    r, a, b, l = rows[order], x0[order], x1[order], labs[order]
    new = np.ones(len(r), bool)
    new[1:] = (a[1:] != a[:-1]) | (b[1:] != b[:-1]) | (l[1:] != l[:-1]) | (r[1:] != r[:-1] + 1)
    gid = np.cumsum(new) - 1
    y0 = r[new]
    y1 = np.zeros(gid[-1] + 1, r.dtype)
    np.maximum.at(y1, gid, r + 1)
    a, b, l = a[new], b[new], l[new]

    polys, owner = [], []
    for k in np.unique(l):
        if k < 0:
            continue
        sel = l == k
        merged = shapely.union_all(shapely.box(a[sel], y0[sel], b[sel], y1[sel]))
        for p in shapely.get_parts(merged):
            if p.geom_type == "Polygon" and not p.is_empty:
                polys.append(p)
                owner.append(int(k))
    # transparent areas take part in the coverage too (as holes), so their edges stay matched
    if np.any(l < 0):
        sel = l < 0
        merged = shapely.union_all(shapely.box(a[sel], y0[sel], b[sel], y1[sel]))
        for p in shapely.get_parts(merged):
            polys.append(p)
            owner.append(-1)
    arr = shapely.segmentize(np.array(polys, dtype=object), 1.0)   # vertex at every grid corner
    if smooth:
        sm = smooth_coverage(arr, owner, grid)
        if sm is None:
            log("note: edge smoothing skipped (borders too tight); edges keep the tracing grid's steps")
        else:
            arr, owner = sm
    arr = shapely.coverage_simplify(arr, 0.5 if smooth else 0.01, simplify_boundary=False)
    out = {}
    for p, k in zip(arr, owner):
        if k >= 0 and not p.is_empty:
            out.setdefault(k, []).append(p)
    return out


# --------------------------------------------------------------------------------------- meshes

def extrude(polys, height, z0=0.0):
    """Polygons (any orientation, holes allowed) -> watertight prism mesh (V float64, T int)."""
    rings = []
    for p in polys:
        for g in shapely.get_parts(p):
            if g.is_empty:
                continue
            rings.append(np.asarray(g.exterior.coords)[:-1])
            rings.extend(np.asarray(h.coords)[:-1] for h in g.interiors)
    rings = [r for r in rings if len(r) >= 3]
    if not rings:
        return None
    # A 0.5 µm inset splits same-color blobs that touch only at a corner; otherwise that point
    # becomes a non-manifold edge that slicers flag for repair.
    cs = m3d.CrossSection(rings, m3d.FillRule.EvenOdd).offset(-0.0005, m3d.JoinType.Miter, 4.0)
    if cs.is_empty() or cs.area() <= 0:
        return None
    man = m3d.Manifold.extrude(cs, height).translate((0.0, 0.0, z0))
    mesh = man.to_mesh()
    v = np.asarray(mesh.vert_properties, dtype=np.float64)[:, :3]
    t = np.asarray(mesh.tri_verts, dtype=np.int64)
    return v, t


# Cylinder frame per --axis: angle phi runs e1 -> e2 (right-handed, e1 x e2 = a), axis a.
CYL_BASIS = {
    "z": (np.array([1.0, 0.0, 0.0]), np.array([0.0, 1.0, 0.0]), np.array([0.0, 0.0, 1.0])),
    "y": (np.array([0.0, 0.0, 1.0]), np.array([1.0, 0.0, 0.0]), np.array([0.0, 1.0, 0.0])),
    "x": (np.array([0.0, 1.0, 0.0]), np.array([0.0, 0.0, 1.0]), np.array([1.0, 0.0, 0.0])),
}


def extrude_cyl(polys, cyl, r_lo, r_hi):
    """Polygons in (u, v) -> a radial-wedge Manifold wrapped onto the cylinder, in xyz.
    Each polygon fills the slab r in [r_lo, r_hi] over its (phi = u / R0, v) footprint:
      (u, v, r) -> center + r*cos(u/R0)*e1 + r*sin(u/R0)*e2 + v*a
    The ring edges are densified so adjacent colors split their shared border identically (matched
    facets that cannot cross after warping); then the extruded caps are refined so the warped arcs
    stay smooth (chord error <= 0.05 mm at r_hi), while the radial walls keep a single span - no
    needless triangles. Because the ring step (L/2) and slab stay below the refine length, refine
    touches only the caps, never the matched walls. The same 0.5 um inset as extrude() keeps colors
    from overlapping, across the 0/360 seam too. Returns a Manifold, or None if nothing is left."""
    center, e1, e2, a, R0 = cyl
    L = R0 * 2.0 * math.acos(max(-1.0, 1.0 - 0.05 / r_hi))    # longest u step within the chord error
    L = max(L, 1e-3)
    seg = 0.5 * L                                            # matched, finer-than-caps wall densify
    arr = shapely.segmentize(np.array(list(polys), dtype=object), seg) if len(polys) else []
    rings = []
    for p in arr:
        for g in shapely.get_parts(p):
            if g.is_empty:
                continue
            rings.append(np.asarray(g.exterior.coords)[:-1])
            rings.extend(np.asarray(h.coords)[:-1] for h in g.interiors)
    rings = [r for r in rings if len(r) >= 3]
    if not rings:
        return None
    cs = m3d.CrossSection(rings, m3d.FillRule.EvenOdd).offset(-0.0005, m3d.JoinType.Miter, 4.0)
    if cs.is_empty() or cs.area() <= 0:
        return None
    slab = 0.5 * L                                           # wall diagonals < L, so only caps refine
    man = m3d.Manifold.extrude(cs, slab).refine_to_length(L)

    def warp(p):
        u, v, z = p[:, 0], p[:, 1], p[:, 2]
        r = r_lo + (z / slab) * (r_hi - r_lo)
        phi = u / R0
        return (center[None, :] + (r * np.cos(phi))[:, None] * e1[None, :]
                + (r * np.sin(phi))[:, None] * e2[None, :] + v[:, None] * a[None, :])

    man = man.warp_batch(warp)
    return man if not man.is_empty() else None


def to_manifold(v, t):
    """(V, T) mesh -> Manifold, or None if it isn't a closed manifold."""
    man = m3d.Manifold(m3d.Mesh(np.ascontiguousarray(v, np.float32), np.ascontiguousarray(t, np.uint32)))
    return None if man.status() != m3d.Error.NoError or man.is_empty() else man


def from_manifold(man):
    mesh = man.to_mesh()
    return np.asarray(mesh.vert_properties, np.float64)[:, :3], np.asarray(mesh.tri_verts, np.int64)


SHELL_MAX_TRI = 20_000          # erode a simplified copy: Minkowski cost grows with triangle count


def carve_shell(man, depth):
    """The outer depth-mm skin of a solid: man - erode(man, depth). The erosion runs on a simplified
    copy (tolerance depth/4, coarser if still > SHELL_MAX_TRI triangles); the outer surface stays
    the original's, exactly."""
    ball = m3d.Manifold.sphere(1.0, 8)
    b = np.asarray(ball.bounding_box(), float)
    half = (b[3:] - b[:3]) / 2
    ball = ball.scale((depth / half).tolist())        # half-extent along each axis = depth exactly
    for tol in (depth / 4, depth / 2, depth):
        core = man.simplify(tol)
        if core.num_tri() <= SHELL_MAX_TRI:
            break
    core = core.minkowski_difference(ball)
    return man if core.is_empty() else man - core


def weld(tris):
    flat = tris.reshape(-1, 3)
    v, inv = np.unique(np.round(flat, 5), axis=0, return_inverse=True)
    t = inv.reshape(-1, 3)
    ok = (t[:, 0] != t[:, 1]) & (t[:, 1] != t[:, 2]) & (t[:, 0] != t[:, 2])
    return v, t[ok]


def load_stl(path):
    data = path.read_bytes()
    if len(data) >= 84:
        n = int.from_bytes(data[80:84], "little")
        if 84 + 50 * n == len(data):
            rec = np.frombuffer(data, np.dtype([("n", "<f4", 3), ("v", "<f4", (3, 3)), ("a", "<u2")]),
                                count=n, offset=84)
            return weld(rec["v"].astype(np.float64))
    nums = re.findall(rb"vertex\s+(\S+)\s+(\S+)\s+(\S+)", data)
    if not nums:
        raise SystemExit(f"could not read STL: {path}")
    return weld(np.array(nums, dtype=np.float64).reshape(-1, 3, 3))


def load_obj(path):
    vs, fs = [], []
    for line in path.read_text(errors="ignore").splitlines():
        if line.startswith("v "):
            vs.append([float(x) for x in line.split()[1:4]])
        elif line.startswith("f "):
            idx = []
            for tok in line.split()[1:]:
                i = int(tok.split("/")[0])
                idx.append(i - 1 if i > 0 else len(vs) + i)
            fs.extend([idx[0], idx[j], idx[j + 1]] for j in range(1, len(idx) - 1))
    if not fs:
        raise SystemExit(f"could not read OBJ: {path}")
    v = np.array(vs, float)
    return weld(v[np.array(fs)])


def _tf(s):
    m = np.eye(4)
    if s:
        n = [float(x) for x in s.split()]
        m[:3, :3] = np.array(n[:9]).reshape(3, 3)
        m[3, :3] = n[9:12]
    return m


def load_3mf(path):
    """The printable parts of a 3MF, kept apart: one entry per build item (object), each holding its
    parts in world space. Components, build transforms and the production extension's external
    object files are resolved; each first-level component is one part. Part and object names come
    from Bambu/Orca's model_settings.config or PrusaSlicer's Slic3r_PE_model.config (which also
    splits one mesh into volumes), else from the 3MF object names. Modifier, negative and support
    volumes are skipped."""
    z = zipfile.ZipFile(path)
    names = set(z.namelist())
    root = "3D/3dmodel.model"
    if "_rels/.rels" in names:
        m = re.search(rb'Target="/?([^"]+\.model)"', z.read("_rels/.rels"))
        if m:
            root = m.group(1).decode()
    meta_name = lambda el: next((md.get("value") for md in el.findall("metadata") if md.get("key") == "name"), None)
    skip, obj_names, part_names = {}, {}, {}
    if "Metadata/model_settings.config" in names:
        cfg = ET.fromstring(z.read("Metadata/model_settings.config"))
        for obj in cfg.iter("object"):
            oid = obj.get("id")
            obj_names[oid] = meta_name(obj)
            for part in obj.iter("part"):
                part_names[(oid, part.get("id"))] = meta_name(part)
                if part.get("subtype", "normal_part") != "normal_part":
                    skip.setdefault(oid, set()).add(part.get("id"))
    volumes = {}            # PrusaSlicer: mesh object id -> [(first tri, last tri, name, printable)]
    if "Metadata/Slic3r_PE_model.config" in names:
        cfg = ET.fromstring(z.read("Metadata/Slic3r_PE_model.config"))
        for obj in cfg.iter("object"):
            obj_names.setdefault(obj.get("id"), meta_name(obj))
            vols = []
            for vol in obj.iter("volume"):
                md = {m.get("key"): m.get("value") for m in vol.iter("metadata")}
                keep = md.get("modifier", "0") != "1" and md.get("volume_type", "ModelPart") == "ModelPart"
                vols.append((int(vol.get("firstid")), int(vol.get("lastid")), md.get("name"), keep))
            if vols:
                volumes[obj.get("id")] = vols
    cache = {}
    unit_scale = {"micron": 0.001, "millimeter": 1, "centimeter": 10, "inch": 25.4, "foot": 304.8, "meter": 1000}

    def parse(mp):
        if mp in cache:
            return cache[mp]
        objs, build, scale = {}, [], 1.0
        cur_v, cur_t, comps = [], [], []
        for ev, el in ET.iterparse(z.open(mp), events=("start", "end")):
            tag = el.tag.rsplit("}", 1)[-1]
            if ev == "start":
                if tag == "model":
                    scale = unit_scale.get(el.get("unit", "millimeter"), 1.0)
                elif tag == "object":
                    cur_v, cur_t, comps = [], [], []
                continue
            if tag == "vertex":
                cur_v.append((float(el.get("x")), float(el.get("y")), float(el.get("z"))))
                el.clear()
            elif tag == "triangle":
                cur_t.append((int(el.get("v1")), int(el.get("v2")), int(el.get("v3"))))
                el.clear()
            elif tag == "component":
                p = None
                for k, v in el.attrib.items():
                    if k.endswith("}path") or k == "path":
                        p = v.lstrip("/")
                comps.append((p or mp, el.get("objectid"), _tf(el.get("transform"))))
            elif tag == "object":
                o = {"name": el.get("name"), "type": el.get("type", "model")}
                if cur_t:
                    o.update(kind="mesh", v=np.array(cur_v) * scale, t=np.array(cur_t, np.int64))
                elif comps:
                    o.update(kind="comps", comps=comps)
                else:
                    o = None
                if o:
                    objs[el.get("id")] = o
                el.clear()
            elif tag == "item":
                build.append((el.get("objectid"), _tf(el.get("transform"))))
        cache[mp] = (objs, build)
        return cache[mp]

    def gather(mp, oid, mat, out):
        """All meshes under an object, in world space, as triangle soup."""
        o = parse(mp)[0].get(oid)
        if o is None or o["type"] != "model":          # support / other objects don't print
            return
        if o["kind"] == "mesh":
            out.append((o["v"] @ mat[:3, :3] + mat[3, :3])[o["t"]])
        else:
            for cp, cid, cm in o["comps"]:
                gather(cp, cid, cm @ mat, out)

    _, build = parse(root)
    objects = []
    for i, (oid, mat) in enumerate(build):
        o = parse(root)[0].get(oid)
        if o is None or o["type"] != "model":
            continue
        oname = obj_names.get(oid) or o["name"] or f"{path.stem} {i + 1}"
        pieces = []                                    # (name, triangle soup)
        if o["kind"] == "mesh":
            tri = (o["v"] @ mat[:3, :3] + mat[3, :3])[o["t"]]
            if oid in volumes:
                for j, (a, b, vname, keep) in enumerate(volumes[oid]):
                    if keep:
                        pieces.append((vname or f"{oname} part {j + 1}", tri[a:b + 1]))
            else:
                pieces.append((oname, tri))
        else:
            for j, (cp, cid, cm) in enumerate(o["comps"]):
                if cid in skip.get(oid, ()):
                    continue
                soup = []
                gather(cp, cid, cm @ mat, soup)
                if soup:
                    sub = parse(cp)[0].get(cid) or {}
                    pname = part_names.get((oid, cid)) or sub.get("name") or f"{oname} part {j + 1}"
                    pieces.append((pname, np.concatenate(soup)))
        parts = []
        for pname, soup in pieces:
            v, t = weld(soup)
            if len(t):
                parts.append({"name": pname, "v": v, "t": t})
        if parts:
            objects.append({"name": oname, "parts": parts, "id": oid})
    if not objects:
        raise SystemExit(f"no meshes found in {path}")
    return objects


def load_mesh(path):
    """-> [{"name": object name, "parts": [{"name", "v", "t"}, ...]}, ...] in world space (mm).
    STL and OBJ files are one object with one part."""
    ext = path.suffix.lower()
    if ext == ".3mf":
        return load_3mf(path)
    if ext == ".stl":
        v, t = load_stl(path)
    elif ext == ".obj":
        v, t = load_obj(path)
    else:
        raise SystemExit(f"--apply-to: unsupported model type {ext} (use .stl, .3mf or .obj)")
    return [{"name": path.stem, "parts": [{"name": path.stem, "v": v, "t": t}]}]


# -------------------------------------------------------------------------------------- writers

def write_stl(path, v, t):
    tri = v[t].astype(np.float32)
    n = np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0])
    ln = np.linalg.norm(n, axis=1, keepdims=True)
    n = np.divide(n, ln, out=np.zeros_like(n), where=ln > 0)
    rec = np.zeros(len(t), np.dtype([("n", "<f4", 3), ("v", "<f4", (3, 3)), ("a", "<u2")]))
    rec["n"], rec["v"] = n, tri
    with open(path, "wb") as f:
        f.write(b"img2color".ljust(80, b" "))
        f.write(np.uint32(len(t)).tobytes())
        f.write(rec.tobytes())


def _mesh_xml(v, t):
    verts = "".join('<vertex x="%.4f" y="%.4f" z="%.4f"/>' % tuple(p) for p in v)
    tris = "".join('<triangle v1="%d" v2="%d" v3="%d"/>' % tuple(f) for f in t)
    return f"<mesh><vertices>{verts}</vertices><triangles>{tris}</triangles></mesh>"


def write_3mf(path, objects, offset=(0.0, 0.0, 0.0)):
    """Objects made of parts: [dict(name, parts=[dict(name, v, t, extruder, subtype, color)])], one
    build item each, every vertex shifted by offset. Part filaments/types go in Bambu's
    Metadata/model_settings.config (Bambu Studio and OrcaSlicer read it); colors are also stored as
    standard 3MF base materials for other viewers."""
    esc = lambda s: (s.replace("&", "&amp;").replace('"', "&quot;").replace("<", "&lt;"))
    offset = np.asarray(offset, float)
    hexes = list(dict.fromkeys(p["color"] for o in objects for p in o["parts"]))
    mats = "".join(f'<base name="{h}" displaycolor="{h}FF"/>' for h in hexes)
    res, items, cfg, nid = [], [], [], 2
    for o in objects:
        ids = []
        for p in o["parts"]:
            res.append(f'<object id="{nid}" type="model" name="{esc(p["name"])}" pid="1" '
                       f'pindex="{hexes.index(p["color"])}">' + _mesh_xml(p["v"] + offset, p["t"]) + "</object>")
            ids.append(nid)
            nid += 1
        comps = "".join(f'<component objectid="{i}"/>' for i in ids)
        res.append(f'<object id="{nid}" type="model" name="{esc(o["name"])}"><components>{comps}</components></object>')
        items.append(f'<item objectid="{nid}"/>')
        cfg += [f' <object id="{nid}">', f'  <metadata key="name" value="{esc(o["name"])}"/>',
                f'  <metadata key="extruder" value="{o["parts"][0]["extruder"]}"/>']
        for i, p in zip(ids, o["parts"]):
            cfg += [f'  <part id="{i}" subtype="{p["subtype"]}">',
                    f'   <metadata key="name" value="{esc(p["name"])}"/>',
                    f'   <metadata key="extruder" value="{p["extruder"]}"/>', "  </part>"]
        cfg.append(" </object>")
        nid += 1
    model = ('<?xml version="1.0" encoding="UTF-8"?>\n'
             '<model unit="millimeter" xml:lang="en-US" '
             'xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">\n'
             '<metadata name="Application">img2color</metadata>\n'
             f'<resources><basematerials id="1">{mats}</basematerials>\n' + "\n".join(res) +
             f'\n</resources><build>{"".join(items)}</build></model>\n')
    settings = '<?xml version="1.0" encoding="UTF-8"?>\n<config>\n' + "\n".join(cfg) + "\n</config>\n"
    ct = ('<?xml version="1.0" encoding="UTF-8"?>\n'
          '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
          '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
          '<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>'
          '<Default Extension="config" ContentType="text/xml"/></Types>')
    rels = ('<?xml version="1.0" encoding="UTF-8"?>\n'
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Target="/3D/3dmodel.model" Id="rel0" '
            'Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>')
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("[Content_Types].xml", ct)
        zf.writestr("_rels/.rels", rels)
        zf.writestr("3D/3dmodel.model", model)
        zf.writestr("Metadata/model_settings.config", settings)


# ------------------------------------------------------------------------- Bambu Studio project

def bambu_binary():
    for p in (os.environ.get("BAMBU_STUDIO"), BAMBU_APP + "/Contents/MacOS/BambuStudio",
              shutil.which("bambu-studio"), shutil.which("BambuStudio")):
        if p and os.path.isfile(p) and os.access(p, os.X_OK):
            return p
    return None


def studio_version(binary):
    """Bundle version of the Studio that owns binary, e.g. '01.10.01.50', or '' if unknown."""
    try:
        import plistlib
        plist = Path(binary).resolve().parents[1] / "Info.plist"
        return plistlib.load(open(plist, "rb")).get("CFBundleShortVersionString", "")
    except Exception:
        return ""


def preset_index(binary):
    """name -> preset dict, from Bambu's bundled system profiles and the user's own presets."""
    roots = []
    app = Path(binary).resolve().parents[1]
    roots += glob.glob(str(app / "Resources/profiles/*/*/*.json"))
    roots += glob.glob(str(app / "Resources/profiles/*/*/*/*.json"))
    # ~/Library presets belong to the INSTALLED Studio. Another build (e.g. an extracted 1.10 via
    # BAMBU_STUDIO) uses only its own bundled profiles, or newer presets leak in and fail its checks.
    installed = Path(BAMBU_APP).resolve()
    user = []
    if installed == app.parent or installed in app.parents:
        user = glob.glob(os.path.expanduser("~/Library/Application Support/BambuStudio/user/*/*/*.json"))
        user += glob.glob(os.path.expanduser("~/Library/Application Support/BambuStudio/system/*/*/*.json"))
    idx = {}
    for f in user + roots:          # user presets win over system ones with the same name
        try:
            d = json.load(open(f))
        except Exception:
            continue
        if isinstance(d, dict) and "name" in d:
            idx.setdefault(d["name"], d)
    return idx


def resolve_preset(idx, name, kind):
    if name not in idx:
        close = [n for n in idx if name.lower() in n.lower()][:8]
        hint = ("; close matches: " + ", ".join(close)) if close else ""
        raise RuntimeError(f"Bambu {kind} preset not found: {name!r}{hint}")
    skip = ("name", "type", "from", "inherits", "include", "instantiation", "setting_id")

    def rec(n):
        d = idx[n]
        out = {}
        if d.get("inherits") and d["inherits"] in idx:
            out.update(rec(d["inherits"]))
        inc = d.get("include") or []
        if isinstance(inc, str):
            inc = [s.strip(" '\"") for s in inc.strip("[]").split(",") if s.strip(" '\"")]
        for i in inc:
            if i in idx:
                out.update({k: v for k, v in rec(i).items() if k not in skip})
        out.update({k: v for k, v in d.items() if k not in ("inherits", "include")})
        return out

    d = {k: v for k, v in rec(name).items() if k not in (
        "version", "is_custom_defined", "setting_id", "updated_time", "base_id", "user_id", "instantiation")}
    d["from"] = "system" if idx[name].get("from", "system") == "system" else "User"
    return d


def plate_size(machine):
    try:
        pts = [[float(c) for c in p.split("x")] for p in machine["printable_area"]]
        return max(p[0] for p in pts) - min(p[0] for p in pts), max(p[1] for p in pts) - min(p[1] for p in pts)
    except Exception:
        return 256.0, 256.0


def parse_poly(v):
    """A Bambu point list ['0x0', '18x0', ...] as [(x, y), ...]; [] if empty / malformed / < 3 points."""
    if not isinstance(v, list):
        return []
    pts = []
    for s in v:
        try:
            p = [float(c) for c in str(s).split("x")]
        except ValueError:
            continue
        if len(p) == 2 and all(math.isfinite(c) for c in p):
            pts.append((p[0], p[1]))
    return pts if len(pts) >= 3 else []


def point_in_poly(x, y, poly):
    inside, j = False, len(poly) - 1
    for i in range(len(poly)):
        (xi, yi), (xj, yj) = poly[i], poly[j]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
            inside = not inside
        j = i
    return inside


def segments_cross(a, b, c, d):
    def o(p, q, r):
        v = (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])
        return (v > 0) - (v < 0)
    return o(a, b, c) != o(a, b, d) and o(c, d, a) != o(c, d, b)


def rect_hits_poly(r, poly):
    """Does the axis-aligned rect (x0, y0, x1, y1) touch the polygon (overlap, containment, crossing edges)?"""
    x0, y0, x1, y1 = r
    corners = [(x0, y0), (x1, y0), (x1, y1), (x0, y1)]
    if any(x0 <= x <= x1 and y0 <= y <= y1 for x, y in poly):
        return True
    if any(point_in_poly(x, y, poly) for x, y in corners):
        return True
    return any(segments_cross(poly[i], poly[(i + 1) % len(poly)], corners[k], corners[(k + 1) % 4])
               for i in range(len(poly)) for k in range(4))


def tower_spec(machine, process, filament, ncolors):
    """What the prime tower needs: {'size': [x, y] extent incl. brim from its brim corner ([0, 0] for one
    color), 'brim', 'bed': printable_area bbox (x0, y0, x1, y1), 'exclude': no-print polygons}.
    The tower takes prime volume per tool change; area ~ changes/layer x prime volume x 1.5 / layer height.
    Studio 2.x rib-wall towers are square; 1.10 towers are prime_tower_width wide (measured)."""
    cfg = {**machine, **filament, **process}

    def num(k, d):
        v = cfg.get(k)
        try:
            f = float(v[0] if isinstance(v, list) else v)
        except (TypeError, ValueError, IndexError):
            return d
        return f if math.isfinite(f) else d

    def max_of(k):
        v = cfg.get(k)
        fs = []
        for x in (v if isinstance(v, list) else [v]):
            try:
                fs.append(float(x))
            except (TypeError, ValueError):
                pass
        return max(fs) if fs else 0.0

    brim = num("prime_tower_brim_width", 3)
    size = [0.0, 0.0]
    if ncolors > 1:
        width = num("prime_tower_width", 35)
        lh = min(num("layer_height", 0.2), num("initial_layer_print_height", 0.2)) or 0.2
        prime = max(45, max_of("filament_prime_volume"), max_of("prime_volume"))
        area = (ncolors - 1) * prime * 1.5 / lh
        walls = 6 + 2 * brim
        side = math.sqrt(area) + walls + max(0, num("prime_tower_extra_rib_length", 0))
        size = [max(width + 2 * brim, side), max(area / width + walls, side)]
    pa = parse_poly(machine.get("printable_area"))
    bed = ((min(p[0] for p in pa), min(p[1] for p in pa), max(p[0] for p in pa), max(p[1] for p in pa))
           if pa else (0.0, 0.0, 256.0, 256.0))
    ex = parse_poly(machine.get("bed_exclude_area"))
    return {"size": size, "brim": brim, "bed": bed, "exclude": [ex] if ex else []}


def tower_rect(x, y, t):
    """Footprint of a tower whose origin (wipe_tower_x/y) is (x, y), with a 3 mm margin all round.
    Measured: Studio draws the brim ~3-5 mm left of / below the origin and the body up to size beyond it."""
    lo = t["brim"] + 3
    return (x - lo, y - lo, x - t["brim"] + t["size"][0] + 3, y - t["brim"] + t["size"][1] + 3)


def find_tower_spot(t, occupied):
    """Plate-local tower origin (x, y) on the bed, 2 mm clear of every exclusion polygon and 3 mm clear of
    the occupied rects (x0, y0, x1, y1). Tries the back-left and back-right corners, the left and right
    strips back to front, the back strip, the front strip (right first), then a grid. None if nothing fits."""
    bx0, by0, bx1, by1 = t["bed"]
    if t["size"][0] <= 0:
        return bx0 + 15, by0 + 15
    m, lo = 2, t["brim"] + 3
    xmin, ymin = bx0 + m + lo, by0 + m + lo
    xmax = bx1 - m - (t["size"][0] - t["brim"] + 3)
    ymax = by1 - m - (t["size"][1] - t["brim"] + 3)
    if xmax < xmin or ymax < ymin:
        return None

    def fits(x, y):
        r = tower_rect(x, y, t)
        grown = (r[0] - 2, r[1] - 2, r[2] + 2, r[3] + 2)
        if any(rect_hits_poly(grown, p) for p in t["exclude"]):
            return False
        return not any(r[0] < o[2] + 3 and o[0] - 3 < r[2] and r[1] < o[3] + 3 and o[1] - 3 < r[3]
                       for o in occupied)

    def steps(a, b, s):
        out, v = [], a
        if a <= b:
            while v < b:
                out.append(v)
                v += s
        else:
            while v > b:
                out.append(v)
                v -= s
        return out + [b]

    cands = [(xmin, ymax), (xmax, ymax)]
    cands += [(xmin, y) for y in steps(ymax, ymin, 2)] + [(xmax, y) for y in steps(ymax, ymin, 2)]
    cands += [(x, ymax) for x in steps(xmin, xmax, 2)] + [(x, ymin) for x in steps(xmax, xmin, 2)]
    cands += [(x, y) for y in steps(ymax, ymin, 4) for x in steps(xmin, xmax, 4)]
    hit = next((c for c in cands if fits(*c)), None)
    return (round(hit[0], 2), round(hit[1], 2)) if hit else None


def tower_fallback(t):
    """The old fixed spot, for when no free spot exists (the user moves the tower in Studio)."""
    top = max((p[1] for poly in t["exclude"] for p in poly), default=0)
    return 5.0, (top + t["brim"] + 5 if top > 0 else 10.0)


def pad_filament_lists(project, binary, filament, n):
    """Studio 1.10's CLI saves some per-filament settings (filament_shrink, ...) with one entry
    however many filaments there are; both 1.10 and 2.x then slice every part with filament 1.
    Repeat those single entries once per filament."""
    keys = set(filament)
    try:        # every filament option this Studio knows, not just the ones the preset sets
        common = Path(binary).resolve().parents[1] / "Resources/profiles/BBL/filament/fdm_filament_common.json"
        keys |= set(json.load(open(common)))
    except Exception:
        pass
    z = zipfile.ZipFile(project)
    cfg = json.loads(z.read("Metadata/project_settings.config"))
    short = [k for k in keys if isinstance(cfg.get(k), list) and len(cfg[k]) == 1 and n > 1]
    if not short:
        z.close()
        return
    for k in short:
        cfg[k] = cfg[k] * n
    tmp = project + ".tmp"
    with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as out:
        for info in z.infolist():
            data = z.read(info.filename)
            if info.filename == "Metadata/project_settings.config":
                data = json.dumps(cfg, indent=4).encode()
            out.writestr(info, data)
    z.close()
    os.replace(tmp, project)


def place_towers(project, pw, pd, spec, restore):
    """After Bambu's arrange, give each plate's prime tower a free spot of its own (find_tower_spot
    against that plate's objects and the machine's real exclusion polygons) and put back the project
    settings in restore. Bambu keeps tower positions per plate (wipe_tower_x/y lists). Plates sit in a
    grid of ceil(sqrt(n)) columns, 1.2 plate sizes apart. Returns (plate numbers with no free spot, spots)."""
    z = zipfile.ZipFile(project)
    cfg = json.loads(z.read("Metadata/project_settings.config"))
    cfg.update(restore)
    plates = [re.findall(r'key="object_id" value="(\d+)"', p) for p in
              re.findall(r"<plate>(.*?)</plate>", z.read("Metadata/model_settings.config").decode(), re.S)]
    boxes = {}
    for o in load_3mf(Path(project)):
        v = np.concatenate([p["v"] for p in o["parts"]])
        boxes[o["id"]] = (v[:, :2].min(0), v[:, :2].max(0))
    cols = math.ceil(math.sqrt(len(plates)))
    xs, ys, bad, spots = [], [], [], []
    for i, ids in enumerate(plates):
        origin = np.array([(i % cols) * pw * 1.2, -(i // cols) * pd * 1.2])
        local = [(*(boxes[j][0] - origin), *(boxes[j][1] - origin)) for j in ids if j in boxes]
        spot = find_tower_spot(spec, local)
        if spot is None:
            bad.append(i + 1)
            spot = tower_fallback(spec)
        spots.append(spot)
        xs.append(f"{spot[0]:g}")
        ys.append(f"{spot[1]:g}")
    cfg["wipe_tower_x"], cfg["wipe_tower_y"] = xs, ys
    tmp = project + ".tmp"
    with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as out:
        for info in z.infolist():
            data = z.read(info.filename)
            if info.filename == "Metadata/project_settings.config":
                data = json.dumps(cfg, indent=4).encode()
            out.writestr(info, data)
    z.close()
    os.replace(tmp, project)
    return bad, spots


def fill_from_installed(objects, project, hexes, args, binary, say):
    """An older Studio (BAMBU_STUDIO) writes none of the settings newer Studios added; a newer Studio
    opening the project then uses generic defaults (e.g. 0.45 mm line widths, too narrow for a
    0.8 nozzle: "Too small line width"). When the installed Studio has the same printer, export the
    same input through it too and copy in every project setting the older project lacks. Older
    Studios ignore keys they don't know; the older version stamp and values are kept."""
    installed = BAMBU_APP + "/Contents/MacOS/BambuStudio"
    if not (os.path.isfile(installed) and os.access(installed, os.X_OK)):
        return
    if Path(binary).resolve() == Path(installed).resolve():
        return
    if args.printer not in preset_index(installed):
        return
    with tempfile.TemporaryDirectory() as tmp:
        ref = f"{tmp}/ref.3mf"
        if bambu_project(objects, ref, hexes, copy.copy(args), binary=installed, quiet=True) is None \
                or not os.path.isfile(ref):
            say("note: could not export a reference project with the installed Bambu Studio; "
                "newer Studios may use their defaults for settings this one doesn't have")
            return
        extra = json.loads(zipfile.ZipFile(ref).read("Metadata/project_settings.config"))
    z = zipfile.ZipFile(project)
    cfg = json.loads(z.read("Metadata/project_settings.config"))
    added = {k: v for k, v in extra.items() if k not in cfg}
    if not added:
        z.close()
        return
    cfg.update(added)
    tmpf = project + ".tmp"
    with zipfile.ZipFile(tmpf, "w", zipfile.ZIP_DEFLATED) as out:
        for info in z.infolist():
            data = z.read(info.filename)
            if info.filename == "Metadata/project_settings.config":
                data = json.dumps(cfg, indent=4).encode()
            out.writestr(info, data)
    z.close()
    os.replace(tmpf, project)


def bambu_project(objects, out_3mf, hexes, args, binary=None, quiet=False):
    """Load the objects in Bambu Studio's CLI with one filament per color and save a real project
    (printer/process presets, filament colors, bed plate, thumbnails).
    Returns a short layout note on success, None on failure."""
    say = (lambda m: None) if quiet else log
    binary = binary or bambu_binary()
    if not binary:
        return None
    orig_args = copy.copy(args)
    idx = preset_index(binary)
    if args.printer not in idx:
        ver = studio_version(binary) or "?"
        printers = sorted(n for n, d in idx.items() if d.get("type") == "machine"
                          and d.get("instantiation") == "true" and n.startswith("Bambu Lab"))
        say(f"error: Bambu Studio {ver} ({binary}) has no printer preset {args.printer!r}; "
            f"writing a plain 3MF instead.\n   printers it has: {', '.join(printers) or '(none)'}")
        return None

    def first(v):
        return (v[0] if isinstance(v, list) and v else v) or None

    try:
        machine = resolve_preset(idx, args.printer, "printer")
        # A process/filament name this Studio doesn't ship (e.g. the P2S defaults under 1.10) falls
        # back to the printer's own default_print_profile / default_filament_profile.
        # Same for a system preset made for another printer (the P2S defaults with --printer X1C).
        def unusable(name):
            if name not in idx:
                return "not found"
            ok = resolve_preset(idx, name, "preset").get("compatible_printers") or []
            return "not for this printer" if ok and args.printer not in ok else None

        proc_name, fil_name = args.process, args.filament
        why = unusable(proc_name)
        if why and first(machine.get("default_print_profile")) in idx:
            proc_name = first(machine["default_print_profile"])
            say(f"note: process {args.process!r} {why}; using the printer's default {proc_name!r}")
        why = unusable(fil_name)
        if why and first(machine.get("default_filament_profile")) in idx:
            fil_name = first(machine["default_filament_profile"])
            say(f"note: filament {args.filament!r} {why}; using the printer's default {fil_name!r}")
        process = resolve_preset(idx, proc_name, "process")
        filament = resolve_preset(idx, fil_name, "filament")
        args.process, args.filament = proc_name, fil_name      # so the summary names what was used
    except RuntimeError as e:
        say(f"warning: {e}; writing a plain 3MF instead")
        return None
    process["curr_bed_type"] = args.plate
    pw, pd = plate_size(machine)
    # footprint of each object's printable parts (modifiers don't count)
    boxes = []
    for o in objects:
        v = np.concatenate([p["v"] for p in o["parts"] if p["subtype"] == "normal_part"])
        boxes.append((v.min(0), v.max(0)))
    lo = np.min([b[0] for b in boxes], 0)
    hi = np.max([b[1] for b in boxes], 0)
    footprint = hi[:2] - lo[:2]
    # Prime tower: a free spot on the bed, clear of the objects and of the machine's exclusion area
    # (X1/P1: the purge-chute corner at the front-left), searched over the centered layout.
    multi = len(hexes) > 1
    spec = tower_spec(machine, process, filament, len(hexes))
    center = np.array([pw / 2 - (lo[0] + hi[0]) / 2, pd / 2 - (lo[1] + hi[1]) / 2, -lo[2]])

    def search(off):
        return find_tower_spot(spec, [(b[0][0] + off[0], b[0][1] + off[1], b[1][0] + off[0], b[1][1] + off[1])
                                      for b in boxes])

    # Kept layout: the objects, centered on the plate, are printable as they are: they fit next to
    # the prime tower, don't overlap from above and all stand on the bed. Otherwise (an assembly
    # stacked in place, a multi-plate project) Bambu arranges them; each object carries its own
    # color modifiers, so the paint moves with it. A single object is always kept.
    offset, arrange, note, spot, moved = center, "0", "", None, ""
    keepable = True
    if len(objects) > 1:
        overlap = any(np.all(np.minimum(a[1][:2], b[1][:2]) - np.maximum(a[0][:2], b[0][:2]) > 0.01)
                      for i, a in enumerate(boxes) for b in boxes[i + 1:])
        grounded = all(b[0][2] - lo[2] < 0.01 for b in boxes)
        keepable = footprint[0] <= pw - 10 and footprint[1] <= pd - 10 and not overlap and grounded
    if multi and keepable:
        spot = search(center)
        if not spot:
            # no room when centered: slide the whole group right (then also back / front) and retry
            rx = pw - 5 - hi[0]
            for off, where in ((np.array([rx, center[1], center[2]]), "right"),
                               (np.array([rx, pd - 5 - hi[1], center[2]]), "right and back"),
                               (np.array([rx, 5 - lo[1], center[2]]), "right and front")):
                spot = search(off)
                if spot:
                    offset, moved = off, f"model moved {where} to make room for the prime tower"
                    break
    if len(objects) > 1:
        if keepable and (not multi or spot):
            note = "layout kept"
        else:
            why = ("they overlap from above" if overlap else "some don't sit on the bed" if not grounded
                   else "they don't fit on one plate as laid out")
            offset, arrange, note = np.zeros(3), "1", f"re-arranged by Bambu Studio: {why}"
    if multi and arrange == "0":
        if not spot:
            spot = tower_fallback(spec)
            say(f"note: at {footprint[0]:.0f} x {footprint[1]:.0f} mm there is no free strip on the "
                f"{pw:.0f} mm bed for the prime tower; move it in Bambu Studio or use a smaller --size")
        elif moved:
            say(f"note: {moved}")
        process["wipe_tower_x"], process["wipe_tower_y"] = [f"{spot[0]:g}"], [f"{spot[1]:g}"]
        note = "; ".join(x for x in (note, moved, f"prime tower at ({spot[0]:g}, {spot[1]:g})") if x)
    # Bambu's arrange packs plates edge to edge and ignores the prime tower; while it arranges,
    # fence off a full-depth strip at the left (covering the exclusion area) so every plate keeps
    # room for one; place_towers then finds each plate's real spot.
    fence = multi and arrange == "1"
    keep_exclude = machine.get("bed_exclude_area", [])
    if fence:
        fx, fy = spec["size"][0] + 12, pd     # tower origin >= brim+5 in, 3 mm gap to objects
        for poly in spec["exclude"]:
            fx, fy = max(fx, max(p[0] for p in poly)), max(fy, max(p[1] for p in poly))
        widest = max(min(b[1][0] - b[0][0], b[1][1] - b[0][1]) for b in boxes)
        if widest > pw - fx - 5:
            # an object too big to sit beside the strip would be pushed off the plate; let Bambu
            # use the whole plate (place_towers then reports the plates with no tower spot)
            fence = False
            say("note: an object is too large to leave a prime-tower strip beside it; "
                "Bambu Studio arranges on the full plate")
        else:
            machine["bed_exclude_area"] = ["0x0", f"{fx:g}x0", f"{fx:g}x{fy:g}", f"0x{fy:g}"]
    with tempfile.TemporaryDirectory() as tmp:
        plain = f"{tmp}/plain.3mf"
        write_3mf(plain, objects, offset)
        json.dump(machine, open(f"{tmp}/machine.json", "w"))
        json.dump(process, open(f"{tmp}/process.json", "w"))
        fils = []
        for i, h in enumerate(hexes):
            f = dict(filament)
            f["filament_colour"] = [h]
            fils.append(f"{tmp}/filament{i + 1}.json")
            json.dump(f, open(fils[-1], "w"))
        out_abs = str(Path(out_3mf).resolve())
        cmd = [binary, "--orient", "0", "--arrange", arrange,
               "--load-settings", f"{tmp}/machine.json;{tmp}/process.json",
               "--load-filaments", ";".join(fils),
               "--export-3mf", out_abs, plain]
        try:
            r = subprocess.run(cmd, capture_output=True, text=True, timeout=600, cwd=tmp)
        except subprocess.TimeoutExpired:
            say("warning: Bambu Studio CLI timed out; writing a plain 3MF instead")
            return None
        if r.returncode != 0 or not os.path.isfile(out_abs):
            tail = (r.stdout + r.stderr).strip().splitlines()[-3:]
            say(f"warning: Bambu Studio CLI failed (exit {r.returncode}); writing a plain 3MF instead")
            for line in tail:
                say("   " + line[:200])
            return None
    pad_filament_lists(out_abs, binary, filament, len(hexes))
    fill_from_installed(objects, out_abs, hexes, orig_args, binary, say)
    if multi and arrange == "1":
        bad, spots = place_towers(out_abs, pw, pd, spec, {"bed_exclude_area": keep_exclude})
        note += "; prime tower at " + ", ".join(f"({x:g}, {y:g})" for x, y in spots)
        if bad:
            say(f"note: no free spot for the prime tower on plate {', '.join(map(str, bad))}; "
                f"move it in Bambu Studio")
    return note


# ------------------------------------------------------------------------------------- preview

def render_map(polys_mm, colors, bounds, width_px, bg=(255, 255, 255)):
    x0, y0, x1, y1 = bounds
    s = width_px / (x1 - x0)
    img = Image.new("RGB", (width_px, max(1, int(round((y1 - y0) * s)))), bg)
    dr = ImageDraw.Draw(img)
    items = [(p.area, k, p) for k, ps in polys_mm.items() for p in ps]
    items.sort(key=lambda it: -it[0])          # big first: a hole's contents are always smaller
    for _, k, p in items:
        pts = [((x - x0) * s, (y1 - y) * s) for x, y in p.exterior.coords]
        if len(pts) >= 3:
            dr.polygon(pts, fill=tuple(int(round(c)) for c in colors[k]))
    return img, s


def save_preview(path, src_img, polys_mm, colors, bounds, silhouette=None):
    w = 900
    right, s = render_map(polys_mm, colors, bounds, w)
    if silhouette is not None:
        v2, t = silhouette
        mask = Image.new("L", right.size, 0)
        dm = ImageDraw.Draw(mask)
        x0, _, _, y1 = bounds
        for tri in v2[t]:
            dm.polygon([((x - x0) * s, (y1 - y) * s) for x, y in tri], fill=255)
        faded = Image.blend(right, Image.new("RGB", right.size, (255, 255, 255)), 0.8)
        right = Image.composite(right, faded, mask)
    left = Image.alpha_composite(Image.new("RGBA", src_img.size, (255, 255, 255, 255)),
                                 src_img.convert("RGBA")).convert("RGB")
    left = left.resize((max(1, round(left.width * right.height / left.height)), right.height), Image.LANCZOS)
    gap = 12
    sheet = Image.new("RGB", (left.width + gap + right.width, right.height), (255, 255, 255))
    sheet.paste(left, (0, 0))
    sheet.paste(right, (left.width + gap, 0))
    sheet.save(path)


# ----------------------------------------------------------------------------------------- main

def parse_size(s):
    m = re.fullmatch(r"\s*([0-9.]+)\s*(?:[xX*]\s*([0-9.]+))?\s*(mm)?\s*", s or "")
    if not m:
        raise SystemExit(f"bad --size {s!r}: use e.g. 100 or 100x60 (mm)")
    return float(m.group(1)), (float(m.group(2)) if m.group(2) else None)


def main():
    ap = argparse.ArgumentParser(
        prog="img2color", formatter_class=argparse.RawDescriptionHelpFormatter,
        description="Image -> one 3D shape per color (STL + Bambu-ready 3MF).",
        epilog="Bambu Studio versions:" + __doc__.split("Bambu Studio versions:", 1)[1].split("\n\n", 1)[0]
        + "\n\nExamples:" + __doc__.split("Examples:", 1)[1])
    ap.add_argument("image", help="input image (png, jpg, webp, ...)")
    ap.add_argument("-c", "--colors", type=int, default=3, help="number of colors (default 3)")
    ap.add_argument("-p", "--palette", help='use exactly these colors, in filament order: "#1E1E1E,#8B3A3A,#999"')
    ap.add_argument("-s", "--size", help="mm: image width (keeps aspect) or WxH. Default 100 wide. "
                    "With --apply-to: tile size (texture repeats); omit to stretch one copy over the model")
    ap.add_argument("-t", "--thickness", type=float, default=2.0, help="image mode: extrusion height in mm (default 2)")
    ap.add_argument("--depth", default="full", metavar="MM",
                    help="pattern depth: color only an outer skin this many mm deep (paint: a shell "
                         "inside the model's surface; image: the top MM of the tile over a one-color "
                         "base). Default: full")
    ap.add_argument("--smooth", type=float, default=1.0,
                    help="edge smoothing radius in image pixels (default 1; 0 = keep hard pixel edges)")
    ap.add_argument("--min-feature", type=float, default=0.6,
                    help="drop color specks/slivers thinner than this many mm (default 0.6; 0 = keep all)")
    ap.add_argument("--resolution", type=float, default=0.1, help="tracing grid in mm (default 0.1)")
    ap.add_argument("-r", "--rotate", type=float, default=0.0, metavar="DEG",
                    help="turn the pattern counterclockwise (as seen in the preview) about the center "
                    "of the covered area; it repeats so nothing is left uncovered")
    ap.add_argument("--offset", default="0,0", metavar="X,Y",
                    help="shift the pattern by X,Y mm after rotating (+X right, +Y up in the preview)")
    ap.add_argument("-a", "--apply-to", metavar="MODEL", help="paint this model (.stl/.3mf/.obj) with the colors")
    ap.add_argument("--projection", choices=["planar", "cylindrical"], default="planar",
                    help="--apply-to only: planar = flat projection (default); cylindrical = wrap the "
                    "pattern around the --axis as a tube (u = R0*angle, v = along the axis)")
    ap.add_argument("--axis", choices=["z", "y", "x"], default=None,
                    help="--apply-to axis: y = front, z = top-down, x = side (planar projection direction), "
                    "or the cylinder axis (cylindrical). Default y for planar, z for cylindrical")
    ap.add_argument("--per-part", action="store_true",
                    help="--apply-to only: make each input part its own object with its own modifiers "
                    "cropped to that part (the shared texture stays put), so parts print separately")
    ap.add_argument("-o", "--out", help="output folder (default: next to the image)")
    ap.add_argument("--no-bambu", action="store_true", help="write a plain 3MF; don't build a Bambu Studio project")
    ap.add_argument("--printer", default=DEFAULT_PRINTER, help=f'Bambu printer preset (default "{DEFAULT_PRINTER}")')
    ap.add_argument("--process", default=DEFAULT_PROCESS, help=f'Bambu process preset (default "{DEFAULT_PROCESS}")')
    ap.add_argument("--filament", default=DEFAULT_FILAMENT, help=f'Bambu filament preset (default "{DEFAULT_FILAMENT}")')
    ap.add_argument("--plate", default="Textured PEI Plate",
                    help='Bambu bed plate (default "Textured PEI Plate"; e.g. "Cool Plate", "High Temp Plate")')
    args = ap.parse_args()
    if args.projection == "cylindrical" and not args.apply_to:
        ap.error("--projection cylindrical needs --apply-to (it wraps the pattern around a model)")
    if args.axis is None:
        args.axis = "z" if args.projection == "cylindrical" else "y"

    t_start = time.time()
    src = Path(args.image).expanduser()
    if not src.is_file():
        raise SystemExit(f"image not found: {src}")
    palette = [parse_hex(h) for h in re.split(r"[,\s]+", args.palette.strip()) if h] if args.palette else None
    if not palette and not 1 <= args.colors <= 32:
        raise SystemExit("--colors must be between 1 and 32")
    if args.thickness <= 0:
        raise SystemExit("--thickness must be > 0")
    if str(args.depth).strip().lower() in ("", "full"):
        depth = None
    else:
        try:
            depth = float(str(args.depth).strip().removesuffix("mm"))
        except ValueError:
            raise SystemExit(f"bad --depth {args.depth!r}: use a depth in mm, e.g. 0.6, or full")
        if not depth > 0:
            raise SystemExit("--depth must be > 0 (or full)")
        if not args.apply_to and depth >= args.thickness:
            depth = None                                   # as deep as the tile: same as full
    if args.per_part and not args.apply_to:
        log("note: --per-part only applies with --apply-to; ignoring")

    m = re.fullmatch(r"\s*([-+0-9.]+)\s*[,xX ]\s*([-+0-9.]+)\s*(mm)?\s*", args.offset)
    if not m:
        raise SystemExit(f"bad --offset {args.offset!r}: use X,Y in mm, e.g. 5,-2.5")
    dx, dy = float(m.group(1)), float(m.group(2))
    rot = math.radians(args.rotate)
    transformed = bool(args.rotate or dx or dy)

    im = ImageOps.exif_transpose(Image.open(src))      # phone photos: honour EXIF rotation
    im.load()
    W, H = im.size
    safe = lambda s: re.sub(r"[^\w.-]+", "_", s)
    stem = safe(src.stem)

    # ---- frame: which mm rectangle we cover, and how mm map onto source pixels
    model = None
    if args.apply_to:
        mpath = Path(args.apply_to).expanduser()
        if not mpath.is_file():
            raise SystemExit(f"model not found: {mpath}")
        mobjs = load_mesh(mpath)
        verts = np.concatenate([p["v"] for o in mobjs for p in o["parts"]])
        margin = 1.0
        if args.projection == "cylindrical":
            # Wrap the pattern around the cylinder axis a through the bbox center. phi runs e1 -> e2;
            # u = R0 * phi wraps once in [0, 2*pi*R0]; v is the axial coordinate.
            e1, e2, a = CYL_BASIS[args.axis]
            center = (verts.min(0) + verts.max(0)) / 2
            rel = verts - center
            R0 = float(np.hypot(rel @ e1, rel @ e2).max())
            if R0 <= 0:
                raise SystemExit("--projection cylindrical: the model has no radius about that axis")
            vax = rel @ a
            vmin, vmax = float(vax.min()), float(vax.max())
            circ = 2 * math.pi * R0
            bx0, by0, bx1, by1 = 0.0, vmin - margin, circ, vmax + margin
            if args.size:
                wsz, hsz = parse_size(args.size)
                n = max(1, round(circ / wsz))
                tw = circ / n                              # an exact number of wraps around
                th = hsz or tw * H / W
                tile = True
                ox, oy = bx0, by1
                if abs(tw - wsz) > 1e-6:
                    log(f"note: tile width snapped {wsz:.1f} -> {tw:.2f} mm ({n} around)")
            else:
                tw = circ                                  # one wrap around the cylinder
                th = tw * H / W
                tile = False
                ox, oy = (bx0 + bx1) / 2 - tw / 2, (by0 + by1) / 2 + th / 2
            model = dict(path=mpath, objs=mobjs, proj="cylindrical", margin=margin,
                         cyl=(center, e1, e2, a, R0), r_lo=max(1.0, 0.3 * R0), r_hi=R0 + 1.0)
        else:
            # (u, v, w) = image right, image up, projection depth; R maps uvw -> xyz (det +1)
            R = {"z": np.eye(3),
                 "y": np.array([[1, 0, 0], [0, 0, -1], [0, 1, 0]], float),
                 "x": np.array([[0, 0, 1], [1, 0, 0], [0, 1, 0]], float)}[args.axis]
            uvw = verts @ R   # xyz -> uvw (R^-1 = R^T)
            lo, hi = uvw.min(0), uvw.max(0)
            bx0, by0, bx1, by1 = lo[0] - margin, lo[1] - margin, hi[0] + margin, hi[1] + margin
            if args.size:
                tw, th = parse_size(args.size)
                th = th or tw * H / W
                tile = True
                ox, oy = bx0, by1      # tile origin: top-left of the region
            else:
                # cover scale: big enough that the (rotated) image still covers the whole region
                fw, fh = bx1 - bx0, by1 - by0
                ac, as_ = abs(math.cos(rot)), abs(math.sin(rot))
                s_cover = max((fw * ac + fh * as_) / W, (fw * as_ + fh * ac) / H)
                tw, th = W * s_cover, H * s_cover
                tile = False
                ox, oy = (bx0 + bx1) / 2 - tw / 2, (by0 + by1) / 2 + th / 2
            model = dict(path=mpath, objs=mobjs, proj="planar", margin=margin,
                         R=R, w0=lo[2] - margin, w1=hi[2] + margin)
    else:
        tw, th = parse_size(args.size) if args.size else (100.0, None)
        th = th or tw * H / W
        bx0, by0, bx1, by1 = 0.0, 0.0, tw, th
        ox, oy = 0.0, th
        tile = False

    # a photo far finer than the tracing grid is shrunk first (2 pixels per grid cell is plenty)
    rgba_img = im.convert("RGBA")
    if tw / W < args.resolution / 2:
        f = (args.resolution / 2) / (tw / W)
        rgba_img = rgba_img.resize((max(1, round(W / f)), max(1, round(H / f))), Image.LANCZOS)
    rgba = np.asarray(rgba_img)
    H, W = rgba.shape[:2]
    labels, colors = quantize(rgba, args.colors, palette)
    ncol = len(colors)
    hexes = [to_hex(c) for c in colors]
    if args.out:
        out_dir = Path(args.out).expanduser()
    elif model is not None:
        out_dir = src.parent / f"{safe(model['path'].stem)}-{stem}-{ncol}colors"
    else:
        out_dir = src.parent / f"{stem}-{ncol}colors"

    px_mm = tw / W                                       # mm per source pixel
    # grid pitch: an integer split of a source pixel when pixels are big, else just the resolution
    q = px_mm / round(px_mm / args.resolution) if px_mm >= args.resolution else args.resolution
    nx, ny = max(1, round((bx1 - bx0) / q)), max(1, round((by1 - by0) / q))
    if nx * ny > MAX_CELLS:
        f = math.sqrt(nx * ny / MAX_CELLS)
        nx, ny = max(1, round(nx / f)), max(1, round(ny / f))
    qx, qy = (bx1 - bx0) / nx, (by1 - by0) / ny
    # grid cell (i, j) center in mm -> source pixel index (row, col)
    ph, pw = th / H, tw / W                              # mm per source pixel
    sy, sx = qy / ph, qx / pw
    if transformed:
        # The pattern is turned by rot about the region center C, then shifted by (dx, dy).
        # Sampling inverts that: pattern point p = Rot(-rot) (q - C - d) + C for map point q.
        c, s = math.cos(rot), math.sin(rot)
        cx, cy = (bx0 + bx1) / 2, (by0 + by1) / 2
        ax, ay = bx0 + 0.5 * qx - cx - dx, by1 - 0.5 * qy - cy - dy
        matrix = [[c * sy, s * qx / ph], [-s * qy / pw, c * sx]]
        row0 = (oy - (-s * ax + c * ay + cy)) / ph - 0.5
        col0 = (c * ax + s * ay + cx - ox) / pw - 0.5
    else:
        matrix = [sy, sx]
        row0 = (oy - (by1 - 0.5 * qy)) / ph - 0.5
        col0 = ((bx0 + 0.5 * qx) - ox) / pw - 0.5
    sigma = args.smooth
    if sigma > 0:
        sigma = max(sigma, 0.5 * max(sx, sy))           # anti-alias when shrinking a big image
    # cylindrical sampling is always periodic (u wraps once around, v repeats); despeckle wraps only
    # across the u seam, not the open axial ends. a turned or shifted planar pattern repeats too.
    cylindrical = model is not None and model["proj"] == "cylindrical"
    grid = resample(labels, ncol, (ny, nx), matrix, [row0, col0], sigma,
                    True if cylindrical else (tile or transformed))
    grid = despeckle(grid, (args.min_feature / 2) / min(qx, qy), "u" if cylindrical else tile)
    polys = trace(grid, args.smooth > 0)

    to_mm = lambda xy: np.column_stack([bx0 + xy[:, 0] * qx, by1 - xy[:, 1] * qy])
    polys_mm = {k: [shapely.transform(p, to_mm) for p in ps] for k, ps in polys.items()}
    area = {k: sum(p.area for p in ps) for k, ps in polys_mm.items()}
    total = sum(area.values()) or 1.0

    out_dir.mkdir(parents=True, exist_ok=True)
    objects, rows = [], []
    if model is None and depth is not None:
        # One full-thickness slab (every footprint) prints on filament 1; each other color is a
        # modifier over just the top `depth` mm, so the project prints as one piece. The STLs are
        # the matching pieces: color 1 = slab minus the other caps (base included), color k = cap.
        T = args.thickness
        allp = [p for ps in polys_mm.values() for p in ps]
        slab = extrude([shapely.union_all(allp)], T) if allp else None
        if slab is None:
            raise SystemExit("nothing to export (no color regions survived)")
        caps = {k: m for k in range(1, ncol)
                if (m := extrude(polys_mm.get(k, []), depth, T - depth)) is not None}
        rest = [p for k in caps for p in polys_mm[k]]
        base = to_manifold(*slab)
        if rest:
            rings = [np.asarray(r.coords)[:-1] for p in rest for g in shapely.get_parts(p)
                     for r in [g.exterior, *g.interiors]]
            cut = m3d.Manifold.extrude(m3d.CrossSection(rings, m3d.FillRule.EvenOdd), depth + 1.0)
            base = base - cut.translate((0.0, 0.0, T - depth))
        pieces = {0: from_manifold(base), **caps}
        parts = [dict(name=hexes[0], v=slab[0], t=slab[1], extruder=1, subtype="normal_part",
                      color=hexes[0], k=0)]
        for k in range(ncol):
            fname = f"{stem}-{k + 1}-{hexes[k][1:]}.stl"
            if k not in pieces:
                rows.append((k, None))
                continue
            write_stl(out_dir / fname, *pieces[k])
            rows.append((k, fname))
            if k > 0:
                parts.append(dict(name=hexes[k], v=caps[k][0], t=caps[k][1], extruder=k + 1,
                                  subtype="modifier_part", color=hexes[k], k=k))
        objects.append(dict(name=f"{stem} ({ncol} colors)", parts=parts))
        out_3mf = out_dir / f"{stem}-{ncol}colors.3mf"
    elif model is None:
        parts = []
        for k in range(ncol):
            mesh = extrude(polys_mm.get(k, []), args.thickness)
            fname = f"{stem}-{k + 1}-{hexes[k][1:]}.stl"
            if mesh is None:
                rows.append((k, None))
                continue
            write_stl(out_dir / fname, *mesh)
            parts.append(dict(name=hexes[k], v=mesh[0], t=mesh[1], extruder=k + 1,
                              subtype="normal_part", color=hexes[k], k=k))
            rows.append((k, fname))
        if not parts:
            raise SystemExit("nothing to export (no color regions survived)")
        objects.append(dict(name=f"{stem} ({ncol} colors)", parts=parts))
        out_3mf = out_dir / f"{stem}-{ncol}colors.3mf"
    else:
        mpath, mobjs, margin = model["path"], model["objs"], model["margin"]
        # --depth: only an outer skin of each part gets color; every modifier is cut to the skin of
        # what it colors (shells[o][p] = that part's skin, None = not a closed manifold -> full).
        shells = None
        if depth is not None:
            t0 = time.time()
            npart = sum(len(o["parts"]) for o in mobjs)
            log(f"carving a {depth:g} mm shell ({npart} part{'s' * (npart > 1)})...")
            shells = []
            for o in mobjs:
                row = []
                for p in o["parts"]:
                    man = to_manifold(p["v"], p["t"])
                    if man is None:
                        log(f"  warning: part {p['name']!r} isn't a closed manifold; coloring it full depth")
                    row.append(None if man is None else carve_shell(man, depth))
                shells.append(row)
            log(f"  shell carved in {time.time() - t0:.1f}s")

        def union_shell(ss):
            if not ss or any(s is None for s in ss):
                return None
            return ss[0] if len(ss) == 1 else m3d.Manifold.batch_boolean(ss, m3d.OpType.Add)

        def skin(mesh, shell):
            """A modifier mesh cut to a shell (None = leave it whole); None if nothing is left."""
            if shell is None:
                return mesh
            man = to_manifold(*mesh)
            if man is None:
                return mesh
            out = man ^ shell
            return None if out.is_empty() or out.num_tri() == 0 else from_manifold(out)

        def skin_all(mods, shell):
            return mods if shell is None else \
                {k: r for k, m in mods.items() if (r := skin(m, shell)) is not None}

        shell_all = union_shell([s for row in shells for s in row]) if shells else None
        full = {}                       # color -> whole-model modifier mesh (xyz)
        if model["proj"] == "cylindrical":
            cyl, r_lo, r_hi = model["cyl"], model["r_lo"], model["r_hi"]
            man_full = {}               # color -> whole-model modifier Manifold (for crops)
            # Build every color's warped wedge, then make them a true partition: the lower color
            # index wins any overlap. The warp facets each color's shared border independently, so
            # they can cross despite the 0.5 um inset; subtracting the already-claimed volume keeps
            # the modifiers from ever sharing space (including across the 0/360 seam).
            raw = {k: m for k in range(ncol)
                   if (m := extrude_cyl(polys_mm.get(k, []), cyl, r_lo, r_hi)) is not None}
            claimed = None
            for k in range(ncol):
                man = raw.get(k)
                fname = f"{stem}-{k + 1}-{hexes[k][1:]}-modifier.stl"
                if man is None:
                    rows.append((k, None))
                    continue
                if claimed is not None:
                    man = man - claimed
                if man.is_empty() or man.num_tri() == 0:
                    rows.append((k, None))
                    continue
                claimed = man if claimed is None else claimed + man
                mesh = man.to_mesh()
                full[k] = (np.asarray(mesh.vert_properties, np.float64)[:, :3],
                           np.asarray(mesh.tri_verts, np.int64))
                man_full[k] = man
                write_stl(out_dir / fname, *(skin(full[k], shell_all) or full[k]))
                rows.append((k, fname))

            def crop_mods(verts_xyz):
                """Each color's warped wedge (k >= 1) intersected with the xyz bbox of verts_xyz
                (± margin). The wedge never moves - only the crop box changes - so cropped pieces
                stay registered to the shared pattern. Returns {k: (v_xyz, t)}."""
                lo, hi = verts_xyz.min(0) - margin, verts_xyz.max(0) + margin
                box = m3d.Manifold.cube((hi - lo).tolist(), False).translate(lo.tolist())
                mods = {}
                for k in range(1, ncol):
                    man = man_full.get(k)
                    if man is None:
                        continue
                    clip = man ^ box
                    if clip.is_empty() or clip.num_tri() == 0:
                        continue
                    cm = clip.to_mesh()
                    mods[k] = (np.asarray(cm.vert_properties, np.float64)[:, :3],
                               np.asarray(cm.tri_verts, np.int64))
                return mods
        else:
            R, w0, w1 = model["R"], model["w0"], model["w1"]
            for k in range(ncol):
                mesh = extrude(polys_mm.get(k, []), w1 - w0, w0)
                fname = f"{stem}-{k + 1}-{hexes[k][1:]}-modifier.stl"
                if mesh is None:
                    rows.append((k, None))
                    continue
                full[k] = (mesh[0] @ R.T, mesh[1])                 # uvw -> xyz
                write_stl(out_dir / fname, *(skin(full[k], shell_all) or full[k]))
                rows.append((k, fname))

            def crop_mods(verts_xyz):
                """Each color's modifier prism (k >= 1) cropped to the uvw bbox of verts_xyz (± margin).
                The texture never moves - only the crop box changes - so cropped pieces stay registered
                to the shared global pattern. Returns {k: (v_xyz, t)}."""
                uvw = verts_xyz @ R
                clo, chi = uvw.min(0) - margin, uvw.max(0) + margin
                rect = shapely.box(clo[0], clo[1], chi[0], chi[1])
                mods = {}
                for k in range(1, ncol):
                    ps = polys_mm.get(k, [])
                    clipped = [g for g in shapely.get_parts(shapely.intersection(np.array(ps, dtype=object), rect))
                               if g.geom_type == "Polygon" and not g.is_empty] if ps else []
                    mesh = extrude(clipped, chi[2] - clo[2], clo[2])
                    if mesh is not None:
                        mods[k] = (mesh[0] @ R.T, mesh[1])
                return mods

        # Each input object (or, with --per-part, each input part) stays its own object with its
        # parts on filament 1. A Bambu modifier only colors the object it belongs to, so every
        # object gets its own copy of the color prisms, cropped to its bounding box. Color 1 is the
        # model itself. --per-part writes per-part modifier STLs too (<stem>-part<k>-...).
        if args.per_part:
            pk = 0
            for oi, o in enumerate(mobjs):
                for pi, p in enumerate(o["parts"]):
                    pk += 1
                    parts = [dict(name=p["name"], v=p["v"], t=p["t"], extruder=1,
                                  subtype="normal_part", color=hexes[0], k=None)]
                    for k, (v, t) in sorted(skin_all(crop_mods(p["v"]), shells and shells[oi][pi]).items()):
                        write_stl(out_dir / f"{stem}-part{pk}-{k + 1}-{hexes[k][1:]}-modifier.stl", v, t)
                        parts.append(dict(name=hexes[k], v=v, t=t, extruder=k + 1,
                                          subtype="modifier_part", color=hexes[k], k=k))
                    objects.append(dict(name=p["name"], parts=parts))
        else:
            for oi, o in enumerate(mobjs):
                parts = [dict(name=p["name"], v=p["v"], t=p["t"], extruder=1, subtype="normal_part",
                              color=hexes[0], k=None) for p in o["parts"]]
                if len(mobjs) == 1:
                    mods = {k: m for k, m in full.items() if k > 0}
                else:
                    mods = crop_mods(np.concatenate([p["v"] for p in o["parts"]]))
                mods = skin_all(mods, shells and union_shell(shells[oi]))
                for k, (v, t) in sorted(mods.items()):
                    parts.append(dict(name=hexes[k], v=v, t=t, extruder=k + 1, subtype="modifier_part",
                                      color=hexes[k], k=k))
                objects.append(dict(name=o["name"], parts=parts))
        out_3mf = out_dir / f"{safe(mpath.stem)}-{stem}-{ncol}colors.3mf"

    # ---- 3MF: a Bambu Studio project with the colors preloaded, else a plain 3MF
    kind = "plain 3MF"
    note = None if args.no_bambu else bambu_project(objects, out_3mf, hexes, args)
    if note is not None:
        kind = f"Bambu Studio project: {args.printer}, {ncol}x {args.filament}" + (f"; {note}" if note else "")
    else:
        write_3mf(out_3mf, objects)

    prev = out_dir / f"{out_3mf.stem}-preview.png"
    sil = None
    if model is not None:
        mobjs = model["objs"]
        mparts = [p for o in mobjs for p in o["parts"]]
        if model["proj"] == "planar":      # faded model silhouette under the flat projection
            base = np.cumsum([0] + [len(p["v"]) for p in mparts])
            sil = (np.concatenate([(p["v"] @ model["R"])[:, :2] for p in mparts]),
                   np.concatenate([p["t"] + b for p, b in zip(mparts, base)]))
        structure = (f"{len(mobjs)} object{'s' * (len(mobjs) > 1)}, "
                     f"{len(mparts)} part{'s' * (len(mparts) > 1)}")
        split = "each part its own object (--per-part)" if args.per_part else "kept separate"
    save_preview(prev, im, polys_mm, colors, (bx0, by0, bx1, by1), sil)

    with open(out_dir / "colors.txt", "w") as f:
        f.write(f"# img2color {src.name}  {ncol} colors\n")
        if model is not None:
            how = f"cylindrical, axis {args.axis}" if model["proj"] == "cylindrical" else f"projection axis {args.axis}"
            f.write(f"# painted onto {model['path'].name} ({structure}, {split}); filament 1 = the model, "
                    f"others = modifiers ({how})\n")
        if depth is not None:
            f.write(f"# pattern depth {depth:g} mm: " + ("an outer shell of the model is colored\n" if model is not None
                    else "filament 1 is a full-thickness base, the others color only its top\n"))
        f.write("filament  hex      coverage  file\n")
        for k, fname in rows:
            f.write(f"{k + 1:<9} {hexes[k]}  {100 * area.get(k, 0) / total:6.1f}%   {fname or '(none)'}\n")

    # ---- summary
    cyl = model is not None and model["proj"] == "cylindrical"
    log(f"{src.name}: {W}x{H}px -> {ncol} colors, {tw:.1f} x {th:.1f} mm"
        + (f" tiled around {mpath.name}" if cyl and tile else "")
        + (f" wrapped around {mpath.name}" if cyl and not tile else "")
        + (f" tile over {mpath.name}" if model is not None and not cyl and tile else "")
        + (f" stretched over {mpath.name}" if model is not None and not cyl and not tile else "")
        + (f", rotated {args.rotate:g}°" if args.rotate else "")
        + (f", offset {dx:g},{dy:g} mm" if dx or dy else "")
        + (f", pattern depth {depth:g} mm" if depth is not None else "")
        + f", grid {nx}x{ny} @ {qx:.3f} mm")
    if model is not None:
        log(f"  model: {structure}, {split}")
    for k, fname in rows:
        tri = sum(len(p["t"]) for o in objects for p in o["parts"] if p["k"] == k)
        note = "  = the model itself (no modifier)" if model is not None and k == 0 else \
            (f"  {tri:,} triangles" if tri else "") + ("" if fname else "  (no area left - skipped)")
        log(f"  filament {k + 1}: {hexes[k]}  {100 * area.get(k, 0) / total:5.1f}%{note}")
    log(f"wrote {out_dir}/")
    log(f"  {out_3mf.name}  ({kind})")
    log(f"  {prev.name}, colors.txt, {sum(1 for _, f in rows if f)} STL files")
    log(f"done in {time.time() - t_start:.1f}s")


if __name__ == "__main__":
    main()
