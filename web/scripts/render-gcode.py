#!/usr/bin/env python3
"""Top-down render of a Bambu plate_1.gcode, colored by the active filament.

Walks the G-code, tracks the active tool and XY position, and draws each extrusion move at a chosen
layer in that filament's color (from the `; filament_colour = ...` header). Prime/wipe-tower moves
are skipped. Used by the validator to eyeball that each color lands in the right place.

    python3 -I scripts/render-gcode.py plate_1.gcode out.png [--frac 0.5] [--width 900]   (needs Pillow)
"""
import argparse
import re
import sys
from PIL import Image, ImageDraw


def parse(path):
    colours = []
    moves = []  # (x0,y0,x1,y1,z,tool)
    x = y = z = 0.0
    tool = 0
    e_abs = 0.0
    rel_e = True          # Bambu uses M83 (relative extrusion)
    in_tower = False
    feature_tower = False
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
                feature_tower = "prime tower" in low or "wipe tower" in low
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
        if line.startswith("G90"):
            continue
        if line.startswith("G1") or line.startswith("G0"):
            nx, ny, nz, e = x, y, z, None
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
            extruding = False
            if e is not None:
                if rel_e:
                    extruding = e > 0
                else:
                    extruding = e > e_abs
                    e_abs = v if c == "E" else e_abs
            if extruding and (nx != x or ny != y) and not in_tower and not feature_tower:
                moves.append((x, y, nx, ny, nz, tool))
            x, y, z = nx, ny, nz
    return colours, moves


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("gcode")
    ap.add_argument("out")
    ap.add_argument("--frac", type=float, default=0.45, help="fraction up the part to slice the view")
    ap.add_argument("--width", type=int, default=900)
    args = ap.parse_args()

    colours, moves = parse(args.gcode)
    if not moves:
        sys.exit("no extrusion moves found")
    zs = sorted({round(m[4], 3) for m in moves})
    zpick = zs[max(0, min(len(zs) - 1, int(len(zs) * args.frac)))]
    layer = [m for m in moves if abs(m[4] - zpick) < 0.12]
    if not layer:
        layer = moves

    xs = [m[0] for m in layer] + [m[2] for m in layer]
    ys = [m[1] for m in layer] + [m[3] for m in layer]
    x0, x1, y0, y1 = min(xs), max(xs), min(ys), max(ys)
    pad = 2.0
    x0 -= pad
    x1 += pad
    y0 -= pad
    y1 += pad
    s = args.width / max(1e-6, (x1 - x0))
    H = max(1, int(round((y1 - y0) * s)))
    img = Image.new("RGB", (args.width, H), (245, 245, 245))
    dr = ImageDraw.Draw(img)

    def col(t):
        if t < len(colours):
            c = colours[t].lstrip("#")
            if len(c) >= 6:
                return (int(c[0:2], 16), int(c[2:4], 16), int(c[4:6], 16))
        return (255, 0, 255)

    for (ax, ay, bx, by, _z, t) in layer:
        p0 = ((ax - x0) * s, (y1 - ay) * s)
        p1 = ((bx - x0) * s, (y1 - by) * s)
        dr.line([p0, p1], fill=col(t), width=2)

    img.save(args.out)
    print(f"rendered {len(layer)} moves at z={zpick} ({len(zs)} layers, {len(colours)} colours) -> {args.out}")


if __name__ == "__main__":
    main()
