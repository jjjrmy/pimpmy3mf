"""Download the chosen camo originals and convert them to WebP presets.

Reads presets-data/_discovery.json (produced by fetch_camos.py), downloads each
original into presets-data/_raw/ (cached), converts to WebP (max dimension 512px,
aspect preserved, quality ~85) at presets-data/<id>.webp, and writes
presets-data/manifest.json (items sorted by name).

Re-runnable: cached downloads and already-built WebPs are skipped.
"""
import datetime
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import wiki  # noqa: E402
from PIL import Image  # noqa: E402

DISCOVERY = os.path.join(wiki.PRESETS_DATA, "_discovery.json")
MANIFEST = os.path.join(wiki.PRESETS_DATA, "manifest.json")
MAX_DIM = 512
QUALITY = 85
SOURCE_SITE = "https://callofduty.fandom.com"


def ext_for(mime):
    return {"image/png": "png", "image/jpeg": "jpg", "image/webp": "webp"}.get(mime, "bin")


def main():
    with open(DISCOVERY) as f:
        disc = json.load(f)
    os.makedirs(wiki.RAW_DIR, exist_ok=True)

    items = []
    for it in disc["items"]:
        raw = os.path.join(wiki.RAW_DIR, f"{it['id']}.{ext_for(it['mime'])}")
        if not os.path.exists(raw):
            wiki.download(it["url"], raw)

        out = os.path.join(wiki.PRESETS_DATA, f"{it['id']}.webp")
        with Image.open(raw) as im:
            im = im.convert("RGBA") if im.mode in ("P", "RGBA", "LA") else im.convert("RGB")
            w, h = im.size
            if max(w, h) > MAX_DIM:  # downscale only; never upscale
                im.thumbnail((MAX_DIM, MAX_DIM), Image.LANCZOS)
            im.save(out, "WEBP", quality=QUALITY, method=6)
            ow, oh = im.size

        items.append({
            "id": it["id"],
            "name": it["name"],
            "games": it["games"],
            "file": f"{it['id']}.webp",
            "source": it["source"],
            "w": ow,
            "h": oh,
        })

    items.sort(key=lambda r: r["name"].lower())

    # prune local webps that are no longer part of the set (keeps presets-data
    # matching the manifest so the uploader's prune mirrors the bucket)
    keep = {it["file"] for it in items}
    for fn in os.listdir(wiki.PRESETS_DATA):
        if fn.endswith(".webp") and fn not in keep:
            os.remove(os.path.join(wiki.PRESETS_DATA, fn))
            print(f"  removed stale {fn}")

    manifest = {
        "version": 1,
        "generated": datetime.datetime.now(datetime.timezone.utc)
        .replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "source": SOURCE_SITE,
        "items": items,
    }
    with open(MANIFEST, "w") as f:
        json.dump(manifest, f, indent=2)

    total = sum(os.path.getsize(os.path.join(wiki.PRESETS_DATA, it["file"])) for it in items)
    print(f"built {len(items)} webp presets")
    print(f"manifest: {MANIFEST} ({os.path.getsize(MANIFEST)} bytes)")
    print(f"total webp size: {total} bytes ({total/1024:.1f} KiB)")


if __name__ == "__main__":
    main()
