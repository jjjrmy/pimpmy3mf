#!/usr/bin/env python3
"""Unroll a cylindrical Bambu plate_1.gcode and compare it to the expected (u,v) color map.

Walks the G-code, keeps only `; FEATURE: Outer wall` extrusion moves, and maps each point to the
cylinder frame: angle phi around the object's own center (-> u = R0*phi) and height v along the axis.
Draws the actual unrolled result (phi vs v, colored by the active tool) next to the expected map
(the per-color rings from the pipeline, filled by region), and reports:
  - agreement %  : fraction of outer-wall samples whose tool == the region the (u,v) point lands in,
                   excluding a small band around color boundaries,
  - seam %       : agreement between the phi~=0 and phi~=2*pi columns (continuity across the seam),
  - streak %     : fraction of (phi,v) cells whose tool differs from BOTH phi-neighbors (streaking).

    python3 -I scripts/render-unrolled.py plate_1.gcode out.png --map map.json   (needs Pillow + numpy)

map.json is written by validate-cylindrical.ts:
  { axis, R0, center:[x,y,z], vmin, vmax, circumference,
    regions:[ { index, tool, hex, rings:[ [[u,v],...], ... ] }, ... ] }
"""
import argparse
import json
import math
import re
import sys

import numpy as np
from PIL import Image, ImageDraw

# perpendicular-plane basis (e1,e2) and axis (a) per axis -- mirrors CYL_BASIS in src/core/cylinder.ts
CYL_BASIS = {
    "z": {"e1": (1, 0, 0), "e2": (0, 1, 0), "a": (0, 0, 1)},
    "y": {"e1": (0, 0, 1), "e2": (1, 0, 0), "a": (0, 1, 0)},
    "x": {"e1": (0, 1, 0), "e2": (0, 0, 1), "a": (1, 0, 0)},
}
TAU = 2 * math.pi


def parse_outer_wall(path):
    """Return (colours, pts) where pts = list of (x,y,z,tool) sampled at outer-wall extrusion moves."""
    colours = []
    pts = []
    x = y = z = 0.0
    tool = 0
    e_abs = 0.0
    rel_e = True
    in_tower = False
    feature = ""
    for raw in open(path, "r", errors="ignore"):
        line = raw.strip()
        if line.startswith(";"):
            low = line.lower()
            if line.startswith("; filament_colour =") and not colours:
                val = line.split("=", 1)[1].strip()
                colours = [c.strip() for c in val.split(";") if c.strip()]
            elif line == "; WIPE_TOWER_START":
                in_tower = True
            elif line == "; WIPE_TOWER_END":
                in_tower = False
            elif low.startswith("; feature:"):
                feature = low.split(":", 1)[1].strip()
            continue
        if line.startswith("M82"):
            rel_e = False
            continue
        if line.startswith("M83"):
            rel_e = True
            continue
        m = re.match(r"T(\d+)\b", line)
        if m:
            tool = int(m.group(1))
            continue
        is_arc = line.startswith("G2") or line.startswith("G3")
        if line.startswith("G1") or line.startswith("G0") or is_arc:
            nx, ny, nz, e, I, J = x, y, z, None, 0.0, 0.0
            for tok in line.split()[1:]:
                c = tok[0]
                try:
                    v = float(tok[1:])
                except ValueError:
                    continue
                if c == "X":
                    nx = v
                elif c == "Y":
                    ny = v
                elif c == "Z":
                    nz = v
                elif c == "E":
                    e = v
                elif c == "I":
                    I = v
                elif c == "J":
                    J = v
            extruding = (e is not None and e > 0) if rel_e else (e is not None and e > e_abs)
            if not rel_e and e is not None:
                e_abs = e
            keep = extruding and not in_tower and feature == "outer wall"
            if keep and is_arc:
                # interpolate ~1 mm points along the arc (I,J = center offset from start; G2=cw, G3=ccw)
                cx, cy = x + I, y + J
                r = math.hypot(I, J)
                a0 = math.atan2(y - cy, x - cx)
                a1 = math.atan2(ny - cy, nx - cx)
                da = a1 - a0
                if line.startswith("G2"):
                    da -= TAU if da >= 0 else 0.0
                else:
                    da += TAU if da <= 0 else 0.0
                n = max(2, int(abs(da) * r))
                for s in range(1, n + 1):
                    ang = a0 + da * (s / n)
                    pts.append((cx + r * math.cos(ang), cy + r * math.sin(ang), nz, tool))
            elif keep and (nx != x or ny != y):
                # densify straight moves to ~1 mm so flat faces sample as well as curved walls
                n = max(1, int(math.hypot(nx - x, ny - y)))
                for s in range(1, n + 1):
                    t = s / n
                    pts.append((x + (nx - x) * t, y + (ny - y) * t, nz, tool))
            x, y, z = nx, ny, nz
    return colours, pts


def to_uv(pts, axis, R0):
    """Map gcode (x,y,z) -> (u, v) in the cylinder frame, phi measured about the points' own center."""
    P = np.array([[p[0], p[1], p[2]] for p in pts], dtype=float)
    center = 0.5 * (P.min(axis=0) + P.max(axis=0))
    d = P - center
    e1 = np.array(CYL_BASIS[axis]["e1"], float)
    e2 = np.array(CYL_BASIS[axis]["e2"], float)
    a = np.array(CYL_BASIS[axis]["a"], float)
    axial = d @ a
    phi = np.arctan2(d @ e2, d @ e1)
    phi = np.mod(phi, TAU)
    u = R0 * phi
    return u, axial, phi


def crossings_inside(u, v, ring):
    """Even-odd ray cast (vertical ray in +v) for one ring of (u,v) vertices; returns bool array."""
    n = len(ring)
    inside = np.zeros(u.shape, dtype=bool)
    for i in range(n):
        ux0, vy0 = ring[i]
        ux1, vy1 = ring[(i + 1) % n]
        # edge straddles the sample's u?
        cond = ((ux0 > u) != (ux1 > u))
        with np.errstate(divide="ignore", invalid="ignore"):
            vt = vy0 + (u - ux0) * (vy1 - vy0) / (ux1 - ux0)
        inside ^= cond & (v < vt)
    return inside


def region_of(u, v, regions):
    """Index into `regions` of the region whose rings (even-odd over all its rings) contain each point;
    -1 where none (gap) or several (shouldn't happen -- partition)."""
    nreg = len(regions)
    hit = np.full(u.shape, -1, dtype=int)
    count = np.zeros(u.shape, dtype=int)
    for ri, reg in enumerate(regions):
        ins = np.zeros(u.shape, dtype=bool)
        for ring in reg["rings"]:
            if len(ring) >= 3:
                ins ^= crossings_inside(u, v, np.array(ring, float))
        hit = np.where(ins & (count == 0), ri, hit)
        count += ins.astype(int)
    hit = np.where(count == 1, hit, -1)
    return hit


def min_edge_dist(u, v, regions):
    """Min distance from each (u,v) to any region ring edge (for boundary-band exclusion)."""
    best = np.full(u.shape, np.inf)
    for reg in regions:
        for ring in reg["rings"]:
            r = np.array(ring, float)
            n = len(r)
            if n < 2:
                continue
            for i in range(n):
                ax, ay = r[i]
                bx, by = r[(i + 1) % n]
                dx, dy = bx - ax, by - ay
                L2 = dx * dx + dy * dy
                if L2 == 0:
                    d = np.hypot(u - ax, v - ay)
                else:
                    t = np.clip(((u - ax) * dx + (v - ay) * dy) / L2, 0.0, 1.0)
                    d = np.hypot(u - (ax + t * dx), v - (ay + t * dy))
                best = np.minimum(best, d)
    return best


def rgb(hexstr):
    c = hexstr.lstrip("#")
    return (int(c[0:2], 16), int(c[2:4], 16), int(c[4:6], 16)) if len(c) >= 6 else (255, 0, 255)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("gcode")
    ap.add_argument("out")
    ap.add_argument("--map", required=True)
    ap.add_argument("--band", type=float, default=2.0, help="mm band around color boundaries to exclude")
    ap.add_argument("--nphi", type=int, default=72)
    ap.add_argument("--nv", type=int, default=48)
    ap.add_argument("--width", type=int, default=520)
    ap.add_argument("--mismatch", action="store_true", help="paint the left panel green=match / red=mismatch / grey=excluded")
    args = ap.parse_args()

    mp = json.load(open(args.map))
    axis = mp["axis"]
    R0 = mp["R0"]
    circ = mp["circumference"]
    regions = mp["regions"]
    tool_of_region = {r["index"]: r["tool"] for r in regions}

    colours, pts = parse_outer_wall(args.gcode)
    if not pts:
        print("RESULT " + json.dumps({"error": "no outer-wall moves"}))
        sys.exit("no outer-wall extrusion moves found")

    u, v, phi = to_uv(pts, axis, R0)
    tool = np.array([p[3] for p in pts], dtype=int)

    exp_region = region_of(u, v, regions)
    exp_tool = np.array([tool_of_region.get(int(r), -1) if r >= 0 else -1 for r in exp_region])
    dist = min_edge_dist(u, v, regions)

    valid = (exp_region >= 0) & (dist >= args.band)
    nvalid = int(valid.sum())
    agree = int((tool[valid] == exp_tool[valid]).sum())
    agreement = (agree / nvalid * 100.0) if nvalid else 0.0

    nphi = args.nphi
    vmin, vmax = float(np.min(v)), float(np.max(v))
    vspan = max(1e-6, vmax - vmin)
    pi = np.clip((phi / TAU * nphi).astype(int), 0, nphi - 1)

    # per-sample match of printed tool vs the expected region's tool
    match = tool == exp_tool

    # seam continuity: agreement of actual vs expected for samples within `seam_deg` of the 0/2pi
    # seam (both sides). If the wrap is handled right, the seam band is as faithful as anywhere else.
    seam_deg = 12.0
    seam_rad = math.radians(seam_deg)
    near_seam = valid & ((phi <= seam_rad) | (phi >= TAU - seam_rad))
    seam_n = int(near_seam.sum())
    seam_pct = (int(match[near_seam].sum()) / seam_n * 100.0) if seam_n else 100.0

    # vertical streaking: a defect would make a whole phi-column print the wrong color. Bin valid
    # samples by phi and count columns whose actual-vs-expected mismatch rate exceeds 50%.
    bad_cols = cols_with_data = 0
    for a_ in range(nphi):
        sel = valid & (pi == a_)
        ns = int(sel.sum())
        if ns < 4:
            continue
        cols_with_data += 1
        if int(match[sel].sum()) / ns < 0.5:
            bad_cols += 1
    streak_pct = (bad_cols / cols_with_data * 100.0) if cols_with_data else 0.0

    # --- render: left = actual (phi vs v), right = expected (u/circ vs v) ---
    W = args.width
    Hpx = int(W * 0.9)
    pad, gap = 10, 24
    panelW = (W - 2 * pad - gap) // 2
    img = Image.new("RGB", (W, Hpx + 28), (250, 250, 250))
    dr = ImageDraw.Draw(img)

    def ax_to_px(uu, vv, x0):
        # uu in [0,circ] -> panel x; vv in [vmin,vmax] -> panel y (v up)
        px = x0 + (uu / max(1e-6, circ)) * panelW
        py = 24 + (1 - (vv - vmin) / vspan) * Hpx
        return px, py

    # left: actual samples (tool color, or match/mismatch in --mismatch mode)
    for i in range(len(u)):
        px, py = ax_to_px(u[i], v[i], pad)
        if args.mismatch:
            c = (120, 120, 120) if not valid[i] else ((40, 170, 40) if match[i] else (220, 30, 30))
        else:
            c = rgb(colours[tool[i]]) if tool[i] < len(colours) else (255, 0, 255)
        dr.ellipse([px - 1, py - 1, px + 1, py + 1], fill=c)
    dr.text((pad, 6), "mismatch (red)" if args.mismatch else "actual outer wall (phi vs v)", fill=(20, 20, 20))

    # right: expected map rasterized on a grid
    x0r = pad + panelW + gap
    gu = np.linspace(0.5, circ - 0.5, panelW)
    gv = np.linspace(vmin, vmax, Hpx)
    UU, VV = np.meshgrid(gu, gv)
    uu = UU.ravel()
    vv = VV.ravel()
    reg = region_of(uu, vv, regions).reshape(VV.shape)
    hexcol = {r["index"]: rgb(r["hex"]) for r in regions}
    arr = np.full((Hpx, panelW, 3), 245, dtype=np.uint8)
    for idx, c in hexcol.items():
        arr[reg == idx] = c
    # v up: flip rows
    sub = Image.fromarray(arr[::-1])
    img.paste(sub, (x0r, 24))
    dr.text((x0r, 6), "expected rings (u vs v)", fill=(20, 20, 20))

    img.save(args.out)

    result = {
        "outerWallSamples": len(u),
        "validSamples": nvalid,
        "agreementPct": round(agreement, 2),
        "seamAgreementPct": round(seam_pct, 2),
        "seamSamples": seam_n,
        "streakBadColPct": round(streak_pct, 2),
        "streakBadCols": bad_cols,
        "band": args.band,
        "colours": colours,
        "vRange": [round(vmin, 2), round(vmax, 2)],
        "png": args.out,
    }
    print(f"unrolled {len(u)} outer-wall samples; agreement {agreement:.1f}% (n={nvalid}), "
          f"seam-agreement {seam_pct:.1f}% (n={seam_n}), bad columns {bad_cols} ({streak_pct:.1f}%) -> {args.out}")
    print("RESULT " + json.dumps(result))


if __name__ == "__main__":
    main()
