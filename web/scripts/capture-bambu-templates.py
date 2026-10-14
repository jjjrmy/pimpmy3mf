#!/usr/bin/env python3
"""Capture Bambu Studio project templates for pimpmy3mf.

For each candidate printer this script:
  1. Flattens its machine + "0.20mm Standard" process + "Bambu PLA Basic" filament
     presets (resolving `inherits` + `include`, exactly like Bambu's CLI).
  2. Builds a tiny N-part 3MF and exports it through the Bambu Studio CLI with N
     filaments, for several N, capturing the real project_settings.config,
     model_settings.config, slice_info.config, filament_sequence.json and the model XML.
  3. Classifies every project_settings key as constant / per-filament (length N) /
     N x N matrix / other N-dependent, and writes a compact template to
     src/core/bambu/templates/<printerId>.json that the TypeScript writer resizes at runtime.

Run read-only against the app bundle:

    python3 -I scripts/capture-bambu-templates.py                 # all printers
    python3 -I scripts/capture-bambu-templates.py --printer p2s-0.4
    python3 -I scripts/capture-bambu-templates.py --keep          # keep raw captures in scratch

Requires only the stdlib. Safe to re-run; it overwrites the templates it owns.
"""
import argparse
import glob
import json
import os
import shutil
import struct
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
TEMPLATES_DIR = ROOT / "src" / "core" / "bambu" / "templates"
CAPTURE_DIR = ROOT / "scratch" / "bambu" / "capture"
BAMBU_APP = "/Applications/BambuStudio.app"

# printerId -> exact system preset names (verified present in the 2.8 profiles dir).
# printer model (as it appears in "Bambu Lab <model> <nozzle> nozzle") -> template-id slug.
MODEL_SLUG = {
    "P2S": "p2s", "X1 Carbon": "x1c", "X1": "x1", "X1E": "x1e", "P1S": "p1s",
    "P1P": "p1p", "A1": "a1", "A1 mini": "a1mini", "H2S": "h2s", "H2C": "h2c", "H2D": "h2d",
}
NOZZLES = ["0.2", "0.4", "0.6", "0.8"]
# Combos whose machine preset omits default_print_profile / default_filament_profile (H2D 0.4 only).
FALLBACK_PROC = {("H2D", "0.4"): "0.20mm Standard @BBL H2D"}
FALLBACK_FIL = {("H2D", "0.4"): "Bambu PLA Basic @BBL H2D"}


def filament_for(idx, machine_name):
    """A 'Bambu PLA Basic' filament preset whose compatible_printers lists this machine (fallback
    when the machine preset omits default_filament_profile)."""
    for n, d in idx.items():
        if n.startswith("Bambu PLA Basic @BBL") and machine_name in (d.get("compatible_printers") or []):
            return n
    return None


def enumerate_combos(idx):
    """id -> {label, machine, process, filament, printer, nozzle, dual}. Process/filament come from the
    machine preset's default_print_profile / default_filament_profile, falling back to a hardcoded gap
    and then to the PLA Basic variant whose compatible_printers lists the machine."""
    def first(v):
        return v[0] if isinstance(v, list) and v else v
    combos = {}
    for model, slug in MODEL_SLUG.items():
        for nz in NOZZLES:
            mname = f"Bambu Lab {model} {nz} nozzle"
            m = idx.get(mname)
            if not m:
                continue
            proc = first(m.get("default_print_profile")) or FALLBACK_PROC.get((model, nz))
            fil = first(m.get("default_filament_profile")) or FALLBACK_FIL.get((model, nz)) or filament_for(idx, mname)
            nd = m.get("nozzle_diameter") or []
            combos[f"{slug}-{nz}"] = dict(
                label=mname, machine=mname, process=proc, filament=fil,
                printer=f"Bambu Lab {model}", nozzle=nz, dual=len(nd) > 1,
            )
    return combos


# distinct, repeatable colors (greys + a few tints) so flush matrices stay reproducible.
PALETTE = [
    "#3C3B3B", "#885B5B", "#CCCBCB", "#848282",
    "#B04632", "#2E6E4E", "#3A4FA0", "#D9B23A",
]
# N values exported to classify key scaling (len=N, 3N, N+2, N^2 are all distinguishable) and derive flush min.
CAPTURE_NS = [1, 2, 3, 4]


def log(*a):
    print(*a, flush=True)


# ------------------------------------------------------------------ preset resolution (ported)

def bambu_binary():
    for p in (os.environ.get("BAMBU_STUDIO"),
              BAMBU_APP + "/Contents/MacOS/BambuStudio",
              shutil.which("bambu-studio"), shutil.which("BambuStudio")):
        if p and os.path.isfile(p) and os.access(p, os.X_OK):
            return p
    return None


def preset_index(binary):
    """name -> preset dict, from Bambu's SYSTEM profiles only: the app bundle plus Bambu's downloaded system
    profile cache. Personal presets (~/Library/.../BambuStudio/user) are deliberately ignored, so a re-capture
    never bakes someone's own overrides into the published templates."""
    app = Path(binary).resolve().parents[1]
    roots = glob.glob(str(app / "Resources/profiles/*/*/*.json"))
    roots += glob.glob(str(app / "Resources/profiles/*/*/*/*.json"))
    cache = glob.glob(os.path.expanduser("~/Library/Application Support/BambuStudio/system/*/*/*.json"))
    idx = {}
    for f in cache + roots:         # the downloaded system cache is newer than the bundle when both exist
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
        return (max(p[0] for p in pts) - min(p[0] for p in pts),
                max(p[1] for p in pts) - min(p[1] for p in pts))
    except Exception:
        return 256.0, 256.0


# --------------------------------------------------------------------------- tiny 3MF builder

def _box(ox, oy, w=10.0, d=10.0, h=2.0):
    v = [(ox, oy, 0), (ox + w, oy, 0), (ox + w, oy + d, 0), (ox, oy + d, 0),
         (ox, oy, h), (ox + w, oy, h), (ox + w, oy + d, h), (ox, oy + d, h)]
    t = [(0, 2, 1), (0, 3, 2), (4, 5, 6), (4, 6, 7),
         (0, 1, 5), (0, 5, 4), (1, 2, 6), (1, 6, 5),
         (2, 3, 7), (2, 7, 6), (3, 0, 4), (3, 4, 7)]
    return v, t


def _mesh_xml(v, t):
    verts = "".join('<vertex x="%.4f" y="%.4f" z="%.4f"/>' % p for p in v)
    tris = "".join('<triangle v1="%d" v2="%d" v3="%d"/>' % f for f in t)
    return f"<mesh><vertices>{verts}</vertices><triangles>{tris}</triangles></mesh>"


def build_npart_3mf(path, n, colors):
    """One object made of n small boxes, each a normal part on its own filament."""
    parts = []
    for i in range(n):
        v, t = _box((i % 4) * 15.0, (i // 4) * 15.0)
        parts.append(dict(name=colors[i], v=v, t=t, extruder=i + 1,
                          subtype="normal_part", color=colors[i]))
    esc = lambda s: s.replace("&", "&amp;").replace('"', "&quot;").replace("<", "&lt;")
    mats = "".join(f'<base name="{esc(p["name"])}" displaycolor="{p["color"]}FF"/>' for p in parts)
    objs = []
    for i, p in enumerate(parts):
        objs.append(f'<object id="{i + 2}" type="model" name="{esc(p["name"])}" pid="1" pindex="{i}">'
                    + _mesh_xml(p["v"], p["t"]) + "</object>")
    cid = len(parts) + 2
    comps = "".join(f'<component objectid="{i + 2}"/>' for i in range(len(parts)))
    objs.append(f'<object id="{cid}" type="model" name="obj"><components>{comps}</components></object>')
    model = ('<?xml version="1.0" encoding="UTF-8"?>\n'
             '<model unit="millimeter" xml:lang="en-US" '
             'xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">\n'
             '<metadata name="Application">pimpmy3mf</metadata>\n'
             f'<resources><basematerials id="1">{mats}</basematerials>\n' + "\n".join(objs) +
             f'\n</resources><build><item objectid="{cid}"/></build></model>\n')
    cfg = [f' <object id="{cid}">', '  <metadata key="name" value="obj"/>',
           f'  <metadata key="extruder" value="{parts[0]["extruder"]}"/>']
    for i, p in enumerate(parts):
        cfg += [f'  <part id="{i + 2}" subtype="{p["subtype"]}">',
                f'   <metadata key="name" value="{esc(p["name"])}"/>',
                f'   <metadata key="extruder" value="{p["extruder"]}"/>', "  </part>"]
    cfg.append(" </object>")
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


# ------------------------------------------------------------------------------- CLI exporter

def export_project(binary, machine, process, filament, colors, in_3mf, out_3mf):
    """Export a real Bambu project; returns (ok, tail)."""
    with tempfile.TemporaryDirectory() as tmp:
        json.dump(machine, open(f"{tmp}/machine.json", "w"))
        json.dump(process, open(f"{tmp}/process.json", "w"))
        fils = []
        for i, h in enumerate(colors):
            f = dict(filament)
            f["filament_colour"] = [h]
            fils.append(f"{tmp}/filament{i + 1}.json")
            json.dump(f, open(fils[-1], "w"))
        out_abs = str(Path(out_3mf).resolve())
        cmd = [binary, "--orient", "0", "--arrange", "1",
               "--load-settings", f"{tmp}/machine.json;{tmp}/process.json",
               "--load-filaments", ";".join(fils),
               "--export-3mf", out_abs, str(Path(in_3mf).resolve())]
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=600, cwd=tmp)
        tail = "\n".join((r.stdout + r.stderr).strip().splitlines()[-4:])
        return (r.returncode == 0 and os.path.isfile(out_abs)), tail


def read_member(zf_path, name):
    with zipfile.ZipFile(zf_path) as z:
        if name in z.namelist():
            return z.read(name)
    return None


# ----------------------------------------------------------------------------- key classifier

# ------------------------------------------------------------------ flush volume (self-check)
# Port of BambuStudio FlushVolCalculator::calc_flush_vol_rgb + the matrix build (min=110, max=900).
# Mirrors the C++ 32-bit float math (via struct) so results match the CLI byte-for-byte.
import math
import struct


def _f(x):
    return struct.unpack("f", struct.pack("f", x))[0]


def _hex2rgb(h):
    h = h.lstrip("#")
    return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16))


def _rgb2hsv(r, g, b):
    mx, mn = max(r, g, b), min(r, g, b)
    d = _f(mx - mn)
    v = mx
    s = 0.0 if mx == 0 else _f(d / mx)
    if d == 0:
        h = 0.0
    elif mx == r:
        h = _f(60 * _f(_f((g - b) / d) % 6))
    elif mx == g:
        h = _f(60 * _f(_f((b - r) / d) + 2))
    else:
        h = _f(60 * _f(_f((r - g) / d) + 4))
    if h < 0:
        h = _f(h + 360)
    return h, s, v


def _luminance(r, g, b):
    return _f(r * 0.3 + g * 0.59 + b * 0.11)


def _rad(d):
    return _f(d / 180.0 * math.pi)


def _calc_flush_vol_rgb(src, dst):
    sr, sg, sb = [_f(x / 255.0) for x in src]
    dr, dg, db = [_f(x / 255.0) for x in dst]
    fh, fs, fv = _rgb2hsv(sr, sg, sb)
    th, ts, tv = _rgb2hsv(dr, dg, db)
    dx = _f(_f(_f(math.cos(_rad(fh))) * fs * fv) - _f(_f(math.cos(_rad(th))) * ts * tv))
    dy = _f(_f(_f(math.sin(_rad(fh))) * fs * fv) - _f(_f(math.sin(_rad(th))) * ts * tv))
    hs_dist = _f(min(1.2, _f(math.hypot(dx, dy))))
    fl, tl = _luminance(sr, sg, sb), _luminance(dr, dg, db)
    if tl >= fl:
        lumi = _f(_f(math.pow(_f(tl - fl), 0.7)) * 560.0)
    else:
        lumi = _f(_f(fl - tl) * 80.0)
        hs_dist = _f(min(_f(0.67 * tv + 0.33 * fv), hs_dist))
    hs_flush = _f(230.0 * hs_dist)
    cos120 = _f(math.cos(_rad(120.0)))
    val = _f(math.sqrt(_f(_f(hs_flush * hs_flush) + _f(lumi * lumi) - _f(_f(2 * hs_flush * lumi) * cos120))))
    return _f(max(val, 60.0))


def flush_matrix(rgbs, min_vol=110, max_vol=900):
    n = len(rgbs)
    out = []
    for i in range(n):
        for j in range(n):
            if i == j:
                out.append("0")
            else:
                v = int(min(_f(_calc_flush_vol_rgb(rgbs[i], rgbs[j]) + min_vol), max_vol))
                out.append(str(v))
    return out


def classify(configs_by_n):
    """configs_by_n: {N: dict}. Returns (base, resize, debug).

    `base` is the full N=1 project_settings dict. `resize` maps every key whose value
    depends on the filament count N to a rule the TypeScript writer applies:
      repeat   - the N=1 value (a block of length B = len(base[k])) repeated N times.
                 Covers both length-N per-filament keys (B=1) and the length-3N
                 extruder-variant keys (B=3) when every filament uses the same preset.
      selfIndex- like repeat, but each filament f (1-based) contributes str(f) x B
                 (e.g. filament_self_index = [1,1,1, 2,2,2, ...]).
      padEmpty - a list of length N + (B-1), filled with base[k]'s last value (here "").
                 Covers different_settings_to_system / inherits_group.
      matrix   - an N x N flush-volume matrix, computed from the colors at runtime.
    `debug` records anything that didn't fit a clean rule (should be empty)."""
    ns = sorted(configs_by_n)
    base = dict(configs_by_n[ns[0]])
    all_keys = set()
    for c in configs_by_n.values():
        all_keys.update(c.keys())
    resize, debug = {}, {}
    for k in sorted(all_keys):
        if any(k not in configs_by_n[n] for n in ns):
            continue                       # present only in some N -> keep base value
        vals = {n: configs_by_n[n].get(k) for n in ns}
        if all(json.dumps(vals[n], sort_keys=True) == json.dumps(vals[ns[0]], sort_keys=True) for n in ns):
            continue                       # constant across N -> keep base value
        if not all(isinstance(vals[n], list) for n in ns):
            debug[k] = f"scalar_varies:{vals}"
            continue
        lens = {n: len(vals[n]) for n in ns}
        b = lens[ns[0]]                     # block size at N=1
        if all(lens[n] == n * n for n in ns):
            resize[k] = "matrix"
        elif all(lens[n] == 2 * n * n for n in ns):
            # dual-nozzle flush matrix: the same N x N matrix once per nozzle (identical halves).
            resize[k] = "matrixDual"
        elif all(lens[n] == b * n for n in ns):
            # repeat vs self_index: does block f equal block 0, or an incremented copy?
            big = vals[ns[-1]]
            nbig = ns[-1]
            numeric = bool(base[k]) and all(str(x).lstrip("-").isdigit() for x in base[k])
            if big == base[k] * nbig:
                resize[k] = "repeat"
            elif numeric and all(big[f * b:(f + 1) * b] == [str(int(x) + f) for x in base[k]]
                                 for f in range(nbig)):
                resize[k] = "selfIndex"
            elif k == "filament_colour":
                resize[k] = "repeat"      # distinct per filament, but the writer sets it to the colors
            else:
                debug[k] = f"scaled_block(B={b}) but neither repeat nor selfIndex"
        elif all(lens[n] == n + (b - 1) for n in ns):
            resize[k] = "padEmpty"
        else:
            debug[k] = f"list_len:{lens}"
    return base, resize, debug


def capture_printer(binary, idx, pid, cfg, keep):
    log(f"\n=== {pid}: {cfg['label']} ({'dual' if cfg['dual'] else 'single'} nozzle) ===")
    if not cfg.get("process") or not cfg.get("filament"):
        log(f"  SKIP: could not resolve process/filament ({cfg.get('process')}, {cfg.get('filament')})")
        return None
    try:
        machine = resolve_preset(idx, cfg["machine"], "printer")
        process = resolve_preset(idx, cfg["process"], "process")
        filament = resolve_preset(idx, cfg["filament"], "filament")
    except RuntimeError as e:
        log(f"  SKIP: {e}")
        return None
    process["curr_bed_type"] = "Textured PEI Plate"
    bedw, bedd = plate_size(machine)
    log(f"  bed {bedw:.0f} x {bedd:.0f} mm; machine keys={len(machine)} process keys={len(process)} filament keys={len(filament)}")

    cap_dir = CAPTURE_DIR / pid
    cap_dir.mkdir(parents=True, exist_ok=True)
    configs_by_n = {}
    extras = {}
    with tempfile.TemporaryDirectory() as tmp:
        for n in CAPTURE_NS:
            colors = PALETTE[:n]
            in_3mf = Path(tmp) / f"in_{n}.3mf"
            out_3mf = cap_dir / f"out_{n}.3mf"
            build_npart_3mf(in_3mf, n, colors)
            ok, tail = export_project(binary, machine, process, filament, colors, in_3mf, out_3mf)
            if not ok:
                log(f"  N={n}: EXPORT FAILED\n    " + tail.replace("\n", "\n    "))
                return None
            ps = read_member(out_3mf, "Metadata/project_settings.config")
            configs_by_n[n] = json.loads(ps)
            log(f"  N={n}: ok  project_settings={len(ps)} bytes  colors={colors}")
            if n == 4:
                for m in ("Metadata/model_settings.config", "Metadata/slice_info.config",
                          "Metadata/filament_sequence.json", "3D/3dmodel.model",
                          "3D/Objects/object_1.model", "3D/_rels/3dmodel.model.rels",
                          "_rels/.rels", "[Content_Types].xml", "Metadata/cut_information.xml"):
                    b = read_member(out_3mf, m)
                    if b is not None:
                        extras[m] = b.decode("utf-8", "replace")

    base, resize, debug = classify(configs_by_n)
    # dump analysis for inspection
    (cap_dir / "resize.json").write_text(json.dumps(resize, indent=2, sort_keys=True))
    (cap_dir / "base.json").write_text(json.dumps(base, indent=2, sort_keys=True))
    for m, txt in extras.items():
        safe = m.replace("/", "__")
        (cap_dir / safe).write_text(txt)

    counts = {}
    for v in resize.values():
        counts[v] = counts.get(v, 0) + 1
    log(f"  resize classes: {counts}")
    if debug:
        log(f"  WARNING unclassified keys: {debug}")
    # Flush min offset is printer-dependent (gt[i][j] = min + floor(raw(i,j))); derive it exactly
    # from the N=4 matrix, then confirm it reproduces that matrix. (The RGB formula itself was verified
    # against extreme CLI palettes earlier; the N=4 self-check pins the per-printer min.)
    want = configs_by_n[4]["flush_volumes_matrix"]
    rgb4 = [_hex2rgb(h) for h in PALETTE[:4]]
    flush_min = int(want[1]) - int(math.floor(_calc_flush_vol_rgb(rgb4[0], rgb4[1])))
    single = flush_matrix(rgb4, min_vol=flush_min)
    got = single * 2 if resize.get("flush_volumes_matrix") == "matrixDual" else single
    log(f"  flush min={flush_min}; matrix N=4 match: {got == want}")
    return dict(id=pid, label=cfg["label"], printer=cfg["printer"], nozzle=cfg["nozzle"],
                dual=cfg["dual"], bed=[round(bedw, 3), round(bedd, 3)],
                base=base, resize=resize, debug=debug, flush_min=flush_min)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--printer", action="append", help="printerId (default: all)")
    ap.add_argument("--keep", action="store_true", help="keep raw captures in scratch/bambu/capture")
    ap.add_argument("--analyze-only", action="store_true", help="capture + classify, skip template writing")
    args = ap.parse_args()

    binary = bambu_binary()
    if not binary:
        sys.exit("Bambu Studio CLI not found")
    idx = preset_index(binary)
    combos = enumerate_combos(idx)
    explicit = bool(args.printer)
    pids = args.printer or list(combos)
    TEMPLATES_DIR.mkdir(parents=True, exist_ok=True)
    results = {}
    for pid in pids:
        if pid not in combos:
            log(f"\n=== {pid}: UNKNOWN combo (not enumerated) ===")
            continue
        # Dual-nozzle H2 series (H2C/H2D) cannot be validated: even Bambu's own CLI-exported project
        # fails the no-settings-flags slice with "No valid nozzle found. Please check nozzle count."
        # Skip them unless explicitly requested with --printer.
        if combos[pid]["dual"] and not explicit:
            log(f"\n=== {pid}: SKIP dual-nozzle (not sliceable headless; see notes) ===")
            continue
        r = capture_printer(binary, idx, pid, combos[pid], args.keep)
        if r:
            results[pid] = r
    log("\n==== captured:", ", ".join(sorted(results)) or "(none)")
    if not args.analyze_only:
        write_templates(results)
        write_loaders()
    if not args.keep and not args.analyze_only:
        shutil.rmtree(CAPTURE_DIR, ignore_errors=True)


def write_templates(results):
    for pid, r in results.items():
        tmpl = build_template(r)
        out = TEMPLATES_DIR / f"{pid}.json"
        out.write_text(json.dumps(tmpl, separators=(",", ":"), ensure_ascii=False))
        log(f"  wrote {out}  ({out.stat().st_size} bytes)")


def write_loaders():
    """Regenerate src/core/bambu/loaders.ts with a static dynamic-import map over every template
    JSON present, so Vite code-splits each into its own chunk and loadTemplate works for any captured
    combo. (PRINTERS in threemf.ts lists only the combos that validated.)"""
    ids = sorted(p.stem for p in TEMPLATES_DIR.glob("*.json"))
    lines = [
        "// AUTO-GENERATED by scripts/capture-bambu-templates.py. Do not edit by hand.",
        "// Static dynamic-import map so the bundler code-splits each printer template into its own chunk.",
        "export const TEMPLATE_LOADERS: Record<string, () => Promise<unknown>> = {",
    ]
    for tid in ids:
        lines.append(f"  {json.dumps(tid)}: () => import('./templates/{tid}.json'),")
    lines.append("};")
    out = HERE.parent / "src" / "core" / "bambu" / "loaders.ts"
    out.write_text("\n".join(lines) + "\n")
    log(f"  wrote {out}  ({len(ids)} templates)")


def build_template(r):
    """Compact per-printer template consumed by src/core/threemf.ts.

    `base` is the full N=1 project_settings dict; `resize` tells the writer how to grow each
    N-dependent key. flush_multiplier/min/max let the writer rebuild the flush matrix."""
    base = dict(r["base"])
    # normalize the fields the writer always overrides so the template is deterministic.
    base["curr_bed_type"] = "Textured PEI Plate"
    base["wipe_tower_x"] = ["15"]
    base["wipe_tower_y"] = ["220"]
    return {
        "id": r["id"],
        "label": r["label"],
        "printer": r["printer"],
        "nozzle": r["nozzle"],
        "dual": r["dual"],
        "bed": r["bed"],
        "plate": "Textured PEI Plate",
        "appVersion": base.get("version", ""),
        "flush": {"min": r["flush_min"], "max": 900},
        "resize": r["resize"],
        "base": base,
    }


if __name__ == "__main__":
    main()
