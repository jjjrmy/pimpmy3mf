"""Discover Call of Duty camouflage flat-swatch images from the Fandom wiki.

Strategy (MediaWiki API only, no HTML scraping):
  1. Enumerate the per-game subcategories of Category:Camouflages.
  2. For each game category, list its camo article pages -> map article -> {games}.
  3. For each article, list every image on the page (prop=images) and keep the
     ones whose filename denotes a FLAT SWATCH (not a gun render):
       (a) "camo"/"camouflage" sits next to "menu"/"icon"  (menu swatches), or
       (b) the filename starts with the camo's own name + "camo"/"camouflage".
  4. Fetch imageinfo (url/size/mime/sha1) for the candidates.
  5. Filter (drop gif / tiny / non-image), dedupe by sha1, and pick the single
     best swatch per camo. Write presets-data/_discovery.json.

Re-runnable: pass --refresh to re-hit the API; otherwise a cached discovery is reused.
"""
import json
import os
import re
import sys
from collections import defaultdict

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import wiki  # noqa: E402

DISCOVERY = os.path.join(wiki.PRESETS_DATA, "_discovery.json")
ROOT_CAT = "Category:Camouflages"
WIKI_BASE = "https://callofduty.fandom.com/wiki/"

# "camo"/"camouflage" adjacent to "menu"/"icon", or the classic prefix families.
MENU_RE = re.compile(
    r"(camo|camouflage)[ _]?(menu[ _]?)?icon"
    r"|camo[ _]menu"
    r"|menu[ _]mp[ _]weapons[ _]camo",
    re.IGNORECASE,
)
# obvious non-swatch markers to always reject (gun renders, store banners, UI chrome)
REJECT_RE = re.compile(
    r"third[ _]person|first[ _]person|topright|icontr|_tr\b|challenge|calling[ _]card"
    r"|emblem|reticle|website|\bpack\b|\bpsn\b|\bxbl\b|bundle|promo|wallpaper|poster"
    r"|\bdlc\b|loadout|create[ _]a[ _]class",
    re.IGNORECASE,
)
# rule-(b) swatch files (named "<Camo> Camouflage <game>") are flat textures only when
# roughly square/2:1; wider frames are gun renders on a background. Menu/icon files are
# exempt (they are reliably flat regardless of aspect).
MAX_RULEB_ASPECT = 2.85
GAME_SUFFIX_RE = re.compile(
    r"\b(bo(?:ii|iii)?|bo\d|mwr|mwii|mwiii|mw\d?|cod4|ghosts|iw|waw|ww2|wwii|aw|vg|cw|codm|online)\b",
    re.IGNORECASE,
)
MIN_DIM = 64

# Confirmed-bad via visual inspection: Ghosts "locked" menu placeholders
# (padlock + camo-name overlay, 178x126) rather than a usable flat texture.
BLOCKLIST = {
    "File:Brush Camouflage CoDG.png",
    "File:Caustic Camouflage CoDG.png",
    "File:Scale Camouflage CoDG.png",
}


def norm_name(file_title):
    """'File:Weapon camo menu red urban.png' -> 'weapon camo menu red urban'."""
    base = file_title.split(":", 1)[-1]
    base = re.sub(r"\.[a-z0-9]+$", "", base, flags=re.IGNORECASE)
    return base.replace("_", " ").strip().lower()


def camo_base(article_title):
    """'Blue Tiger Camouflage' -> 'blue tiger'."""
    t = re.sub(r"\s+Camouflages?$", "", article_title, flags=re.IGNORECASE)
    t = re.sub(r"\s+Camo$", "", t, flags=re.IGNORECASE)
    return t.strip()


def slugify(name):
    s = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
    return s or "camo"


def get_game_categories():
    out = []
    for d in wiki.query_all({"list": "categorymembers", "cmtitle": ROOT_CAT,
                             "cmtype": "subcat", "cmlimit": "500"}):
        for m in d.get("query", {}).get("categorymembers", []):
            out.append(m["title"])
    return out


def get_articles(cat):
    out = []
    for d in wiki.query_all({"list": "categorymembers", "cmtitle": cat,
                             "cmnamespace": "0", "cmlimit": "500"}):
        for m in d.get("query", {}).get("categorymembers", []):
            out.append(m["title"])
    return out


def get_page_images(titles):
    """title -> [File:... titles]. Batches of 20 titles; follows imcontinue."""
    result = defaultdict(list)
    for i in range(0, len(titles), 20):
        batch = titles[i:i + 20]
        for d in wiki.query_all({"titles": "|".join(batch), "prop": "images",
                                 "imlimit": "500"}):
            for p in d.get("query", {}).get("pages", {}).values():
                for im in p.get("images", []):
                    result[p["title"]].append(im["title"])
    return result


def get_imageinfo(file_titles):
    info = {}
    titles = sorted(file_titles)
    for i in range(0, len(titles), 50):
        batch = titles[i:i + 50]
        d = wiki.query({"titles": "|".join(batch), "prop": "imageinfo",
                        "iiprop": "url|size|mime|sha1"})
        for p in d.get("query", {}).get("pages", {}).values():
            ii = (p.get("imageinfo") or [None])[0]
            if ii:
                info[p["title"]] = ii
    return info


def is_flat_swatch(file_title, cbase):
    norm = norm_name(file_title)
    if REJECT_RE.search(norm):
        return False
    if MENU_RE.search(norm):
        return True
    # (b) filename begins with the camo's own name + camo/camouflage
    cb = cbase.lower()
    if norm.startswith(cb):
        rest = norm[len(cb):].lstrip()
        if re.match(r"(camo|camouflage)\b", rest):
            return True
    return False


def discover():
    game_cats = get_game_categories()
    print(f"game categories: {len(game_cats)}")

    article_games = defaultdict(set)  # article title -> {game names}
    for cat in game_cats:
        game = re.sub(r"\s+Camouflages$", "", cat.split(":", 1)[1])
        arts = get_articles(cat)
        print(f"  {game}: {len(arts)} articles")
        for a in arts:
            article_games[a].add(game)

    # drop list/subpage articles (e.g. "Weapon Camouflage/Call of Duty: ...")
    for a in [a for a in article_games if "/" in a]:
        del article_games[a]

    articles = sorted(article_games)
    print(f"unique camo articles: {len(articles)}")

    # images per article -> candidate flat swatches
    page_images = get_page_images(articles)
    cand_files = set()
    file_articles = defaultdict(set)  # File: -> {article titles}
    for art in articles:
        cb = camo_base(art)
        for ft in page_images.get(art, []):
            if ft in BLOCKLIST:
                continue
            if is_flat_swatch(ft, cb):
                cand_files.add(ft)
                file_articles[ft].add(art)
    print(f"candidate swatch files: {len(cand_files)}")

    info = get_imageinfo(cand_files)

    # per-article: collect valid swatch files, pick the best one
    per_article = defaultdict(list)
    skip_counts = defaultdict(int)
    seen_sha1 = {}
    for ft in sorted(cand_files):
        ii = info.get(ft)
        if not ii:
            skip_counts["no_imageinfo"] += 1
            continue
        mime = ii.get("mime", "")
        w, h = ii.get("width", 0), ii.get("height", 0)
        if mime == "image/gif":
            skip_counts["animated_gif"] += 1
            continue
        if mime not in ("image/png", "image/jpeg", "image/webp"):
            skip_counts["bad_mime"] += 1
            continue
        if min(w, h) < MIN_DIM:
            skip_counts["too_small"] += 1
            continue
        is_menu = bool(MENU_RE.search(norm_name(ft)))
        aspect = max(w, h) / max(1, min(w, h))
        if not is_menu and aspect > MAX_RULEB_ASPECT:
            skip_counts["wide_gun_render"] += 1
            continue
        rec = {
            "file_title": ft,
            "url": ii["url"],
            "mime": mime,
            "w": w,
            "h": h,
            "size": ii.get("size", 0),
            "sha1": ii.get("sha1", ""),
            "is_menu": is_menu,
        }
        for art in file_articles[ft]:
            per_article[art].append(rec)

    # choose best swatch per camo, dedupe by sha1 across the whole set
    items = []
    for art in sorted(per_article):
        cands = per_article[art]
        # rank: prefer canonical menu/icon swatches, then png>webp>jpg, then larger area
        mime_rank = {"image/png": 2, "image/webp": 1, "image/jpeg": 0}
        cands.sort(key=lambda r: (r["is_menu"], mime_rank.get(r["mime"], 0), r["w"] * r["h"]),
                   reverse=True)
        chosen = cands[0]
        sha1 = chosen["sha1"]
        if sha1 in seen_sha1:
            # byte-identical to an already-chosen camo: merge games, skip new item
            seen_sha1[sha1]["games"].update(article_games[art])
            skip_counts["dup_sha1"] += 1
            continue
        name = camo_base(art)
        item = {
            "id": slugify(name),
            "name": name,
            "games": set(article_games[art]),
            "source": WIKI_BASE + art.replace(" ", "_"),
            "file_title": chosen["file_title"],
            "url": chosen["url"],
            "mime": chosen["mime"],
            "w": chosen["w"],
            "h": chosen["h"],
            "sha1": sha1,
        }
        items.append(item)
        seen_sha1[sha1] = item

    # resolve id collisions (different camo names slugging the same)
    used = {}
    for it in items:
        base = it["id"]
        i = base
        n = 2
        while i in used:
            i = f"{base}-{n}"
            n += 1
        used[i] = True
        it["id"] = i

    for it in items:
        it["games"] = sorted(it["games"])
    items.sort(key=lambda r: r["name"].lower())

    out = {
        "generated_from": wiki.API,
        "root_category": ROOT_CAT,
        "counts": {
            "game_categories": len(game_cats),
            "articles": len(articles),
            "candidate_files": len(cand_files),
            "items": len(items),
        },
        "skipped": dict(skip_counts),
        "items": items,
    }
    return out


def main():
    refresh = "--refresh" in sys.argv
    os.makedirs(wiki.PRESETS_DATA, exist_ok=True)
    if os.path.exists(DISCOVERY) and not refresh:
        print(f"discovery cached at {DISCOVERY} (use --refresh to rebuild)")
        with open(DISCOVERY) as f:
            d = json.load(f)
        print(json.dumps(d["counts"], indent=2))
        print("skipped:", json.dumps(d.get("skipped", {})))
        return
    out = discover()
    with open(DISCOVERY, "w") as f:
        json.dump(out, f, indent=2)
    print(f"\nwrote {DISCOVERY}")
    print("counts:", json.dumps(out["counts"], indent=2))
    print("skipped:", json.dumps(out["skipped"]))


if __name__ == "__main__":
    main()
