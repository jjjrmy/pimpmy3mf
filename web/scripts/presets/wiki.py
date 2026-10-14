"""Shared MediaWiki API client for the Call of Duty Fandom wiki.

Polite by design: <=~2 req/s, descriptive User-Agent, maxlag=5 with backoff.
Used by fetch_camos.py (discovery) and build_presets.py (download/convert).
No secrets, no absolute paths -- everything resolves relative to this file.
"""
import json
import os
import time
import urllib.parse
import urllib.request

API = "https://callofduty.fandom.com/api.php"
USER_AGENT = "pimpmy3mf-preset-fetch/1.0 (+https://pimpmy3mf.app)"
MIN_INTERVAL = 0.5  # seconds between requests (~2 req/s)

# web/presets-data (gitignored) lives two levels up from scripts/presets/
_HERE = os.path.dirname(os.path.abspath(__file__))
PRESETS_DATA = os.path.normpath(os.path.join(_HERE, "..", "..", "presets-data"))
RAW_DIR = os.path.join(PRESETS_DATA, "_raw")

_last_call = [0.0]


def _throttle():
    dt = time.time() - _last_call[0]
    if dt < MIN_INTERVAL:
        time.sleep(MIN_INTERVAL - dt)
    _last_call[0] = time.time()


def _request(url, binary=False, retries=5):
    last_err = None
    for attempt in range(retries):
        _throttle()
        req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                data = r.read()
            if binary:
                return data
            d = json.loads(data)
            # maxlag: the API returns an error with code 'maxlag' when replication lag is high
            if isinstance(d, dict) and d.get("error", {}).get("code") == "maxlag":
                wait = 5 * (attempt + 1)
                print(f"    maxlag; backing off {wait}s")
                time.sleep(wait)
                continue
            return d
        except urllib.error.HTTPError as e:
            last_err = e
            if e.code in (429, 503):
                wait = 5 * (attempt + 1)
                print(f"    HTTP {e.code}; backing off {wait}s")
                time.sleep(wait)
                continue
            raise
        except (urllib.error.URLError, TimeoutError) as e:
            last_err = e
            wait = 3 * (attempt + 1)
            print(f"    net error {e}; retry in {wait}s")
            time.sleep(wait)
    raise RuntimeError(f"request failed after {retries} tries: {url} ({last_err})")


def query(params):
    """Single API query (format=json, maxlag=5 injected)."""
    p = dict(params)
    p.setdefault("action", "query")
    p.setdefault("format", "json")
    p.setdefault("maxlag", "5")
    return _request(API + "?" + urllib.parse.urlencode(p))


def query_all(params, cont_key="continue"):
    """Yield each response page, following MediaWiki `continue`."""
    p = dict(params)
    while True:
        d = query(p)
        yield d
        cont = d.get("continue")
        if not cont:
            return
        p.update(cont)


def download(url, dest):
    """Download a binary URL to dest (parent dir must exist)."""
    data = _request(url, binary=True)
    with open(dest, "wb") as f:
        f.write(data)
    return len(data)
