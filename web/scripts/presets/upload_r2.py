"""Upload the camo WebP presets + manifest to the R2 bucket `pimpmy3mf-presets`.

Only uploads files that are missing or changed since the last run, tracked by
content hash in presets-data/_uploaded.json. Runs `npx wrangler` from web/.

Usage:
  python -I scripts/presets/upload_r2.py          # upload missing/changed
  python -I scripts/presets/upload_r2.py --verify  # re-check remote manifest only
"""
import hashlib
import json
import os
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import wiki  # noqa: E402

WEB_DIR = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))
BUCKET = "pimpmy3mf-presets"
MANIFEST = os.path.join(wiki.PRESETS_DATA, "manifest.json")
UPLOADED = os.path.join(wiki.PRESETS_DATA, "_uploaded.json")


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def wrangler(args):
    return subprocess.run(["npx", "wrangler", *args], cwd=WEB_DIR,
                          capture_output=True, text=True)


def put(key, path, content_type):
    r = wrangler(["r2", "object", "put", f"{BUCKET}/{key}",
                  "--file", path, "--content-type", content_type, "--remote"])
    if r.returncode != 0:
        raise RuntimeError(f"upload failed for {key}:\n{r.stderr}")


def delete(key):
    r = wrangler(["r2", "object", "delete", f"{BUCKET}/{key}", "--remote"])
    if r.returncode != 0:
        raise RuntimeError(f"delete failed for {key}:\n{r.stderr}")


def exists(key):
    r = wrangler(["r2", "object", "get", f"{BUCKET}/{key}", "--remote", "--pipe"])
    return r.returncode == 0


def verify():
    r = wrangler(["r2", "object", "get", f"{BUCKET}/manifest.json", "--remote", "--pipe"])
    if r.returncode != 0:
        print("remote manifest NOT found:\n", r.stderr)
        return False
    remote = json.loads(r.stdout)
    print(f"remote manifest: version={remote.get('version')} items={len(remote.get('items', []))}")
    return True


def main():
    if "--verify" in sys.argv:
        verify()
        return
    dry = "--dry-run" in sys.argv

    with open(MANIFEST) as f:
        manifest = json.load(f)

    state = {}
    if os.path.exists(UPLOADED):
        with open(UPLOADED) as f:
            state = json.load(f)

    # desired bucket contents: every manifest webp + the manifest itself
    jobs = [(it["file"], os.path.join(wiki.PRESETS_DATA, it["file"]), "image/webp")
            for it in manifest["items"]]
    jobs.append(("manifest.json", MANIFEST, "application/json"))
    desired = {key for key, _, _ in jobs}

    # objects we previously uploaded that are no longer wanted -> prune
    stale = sorted(set(state) - desired)
    print("=== prune plan (bucket objects not in manifest) ===")
    for key in stale:
        print(f"  DELETE {key}")
    print(f"  ({len(stale)} object(s) to delete)")

    if dry:
        print("\n=== upload plan (--dry-run) ===")
        for key, path, _ in jobs:
            status = "skip" if state.get(key) == sha256(path) else "put"
            print(f"  {status} {key}")
        print("\n--dry-run: no changes made")
        return

    uploaded = skipped = 0
    for key, path, ctype in jobs:
        digest = sha256(path)
        if state.get(key) == digest:
            skipped += 1
            continue
        put(key, path, ctype)
        state[key] = digest
        uploaded += 1
        print(f"  put {key}")
        with open(UPLOADED, "w") as f:  # persist incrementally (crash-safe)
            json.dump(state, f, indent=2)

    deleted = 0
    for key in stale:
        delete(key)
        state.pop(key, None)
        deleted += 1
        print(f"  deleted {key}")
        with open(UPLOADED, "w") as f:
            json.dump(state, f, indent=2)

    print(f"\nuploaded {uploaded}, skipped {skipped} (current), deleted {deleted}")
    verify()
    if stale:
        k = stale[0]
        print(f"deleted key 404 check: {k} -> {'still present!' if exists(k) else 'gone (404) OK'}")


if __name__ == "__main__":
    main()
