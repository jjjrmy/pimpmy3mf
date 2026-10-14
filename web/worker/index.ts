// Cloudflare Worker: serves the built app (static assets) plus a few routes.
//
//   GET /api/filaments?page=N          one slimmed page of filamentcolors.xyz swatches ({ count, pages, page, results })
//   GET /api/filaments?source=spoolman  the SpoolmanDB filaments.json dump, proxied unparsed (~4.6 MB)
//   GET /api/presets            the camo preset manifest (manifest.json in the PRESETS R2 bucket)
//   GET /presets/<id>.webp      one preset image from R2
//   www.pimpmy3mf.app/*         301 -> https://pimpmy3mf.app/*
//
// filamentcolors.xyz sends `no-store`, so to be a polite client each page is slimmed and kept in the edge cache:
// served as-is for 24 h (upstream sees at most one request per page per day per colo), and kept up to 7 days as a
// fallback for when filamentcolors.xyz is down. One page per request keeps each invocation's CPU tiny (the full
// list is ~6.7 MB of JSON upstream).
//
// The preset images are third-party artwork and live only in R2 (never in the repo). The PRESETS binding is
// optional: without it (forks, local dev without data) /api/presets 404s and the UI hides the picker.
import { slimPage, upstreamPageUrl, SPOOLMAN_URL } from '../src/shared/filaments';

interface Env {
  ASSETS: Fetcher;
  PRESETS?: R2Bucket;
}

const APEX = 'pimpmy3mf.app';

/** Serve from the edge cache without asking upstream for this long. */
const TTL = 24 * 60 * 60;
/** Keep the cached copy this long so it can stand in while filamentcolors.xyz is down. */
const STALE_TTL = 7 * 24 * 60 * 60;
const CACHE_VERSION = 'v1';
/** Preset manifest: short, so re-uploads show up quickly. Images: a week (keys are stable ids). */
const MANIFEST_TTL = 5 * 60;
const IMAGE_TTL = 7 * 24 * 60 * 60;
/** Bump when the preset set is replaced, so edge-cached manifests/images from the old set are bypassed at once. */
const PRESETS_CACHE_VERSION = 'mw2-1';

function json(body: unknown, status: number, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*', ...extra },
  });
}

/**
 * Proxy the SpoolmanDB dump WITHOUT parsing it (streaming the body keeps each invocation's CPU tiny; parsing
 * 4.6 MB could blow the free-plan limit). Same edge-cache policy as the filamentcolors pages: served as-is for
 * 24 h, kept up to STALE_TTL as a fallback for when SpoolmanDB is unreachable.
 */
async function spoolman(url: URL, ctx: ExecutionContext): Promise<Response> {
  const cache = caches.default;
  const key = new Request(`${url.origin}/api/filaments?source=spoolman&cache=${CACHE_VERSION}`);
  const hit = await cache.match(key);
  const age = hit ? (Date.now() - Number(hit.headers.get('x-fetched-at') ?? 0)) / 1000 : Infinity;
  if (hit && age < TTL) return hit;

  let upstream: Response | null = null;
  try {
    upstream = await fetch(SPOOLMAN_URL, {
      headers: { accept: 'application/json', 'user-agent': 'pimpmy3mf (+https://pimpmy3mf.app)' },
      signal: AbortSignal.timeout(25000),
    });
  } catch {
    upstream = null;
  }
  if (!upstream?.ok || !upstream.body) {
    if (hit) return hit;
    return json({ error: upstream ? `SpoolmanDB returned ${upstream.status}` : 'SpoolmanDB unreachable' }, 502);
  }

  const res = new Response(upstream.body, {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'access-control-allow-origin': '*',
      'cache-control': `public, max-age=${STALE_TTL}`,
      'x-fetched-at': String(Date.now()),
    },
  });
  ctx.waitUntil(cache.put(key, res.clone()));
  return res;
}

async function filaments(url: URL, ctx: ExecutionContext): Promise<Response> {
  if (url.searchParams.get('source') === 'spoolman') return spoolman(url, ctx);
  const page = Number(url.searchParams.get('page') ?? '1');
  if (!Number.isInteger(page) || page < 1 || page > 200) return json({ error: 'bad page' }, 400);

  const cache = caches.default;
  const key = new Request(`${url.origin}/api/filaments?page=${page}&cache=${CACHE_VERSION}`);
  const hit = await cache.match(key);
  const age = hit ? (Date.now() - Number(hit.headers.get('x-fetched-at') ?? 0)) / 1000 : Infinity;
  if (hit && age < TTL) return hit;

  // stale or missing: refresh from upstream; if that fails, a stale copy (kept up to STALE_TTL) beats nothing
  let upstream: Response | null = null;
  try {
    upstream = await fetch(upstreamPageUrl(page), {
      headers: { accept: 'application/json', 'user-agent': 'pimpmy3mf (+https://pimpmy3mf.app)' },
      signal: AbortSignal.timeout(25000),
    });
  } catch {
    upstream = null;
  }
  if (upstream?.status === 404) return json({ error: 'no such page' }, 404);
  if (!upstream?.ok) {
    if (hit) return hit;
    return json({ error: upstream ? `filamentcolors.xyz returned ${upstream.status}` : 'filamentcolors.xyz unreachable' }, 502);
  }

  const slim = slimPage((await upstream.json()) as Parameters<typeof slimPage>[0], page);
  const res = json(slim, 200, { 'cache-control': `public, max-age=${STALE_TTL}`, 'x-fetched-at': String(Date.now()) });
  ctx.waitUntil(cache.put(key, res.clone()));
  return res;
}

/** Serve one R2 object through the edge cache. */
async function fromR2(
  bucket: R2Bucket | undefined,
  objectKey: string,
  cacheUrl: string,
  ttl: number,
  fallbackType: string,
  ctx: ExecutionContext,
): Promise<Response> {
  if (!bucket) return json({ error: 'presets not configured' }, 404);
  const cache = caches.default;
  const key = new Request(cacheUrl);
  const hit = await cache.match(key);
  if (hit) return hit;
  const obj = await bucket.get(objectKey);
  if (!obj) return json({ error: 'not found' }, 404);
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  if (!headers.get('content-type')) headers.set('content-type', fallbackType);
  headers.set('etag', obj.httpEtag);
  headers.set('cache-control', `public, max-age=${ttl}`);
  headers.set('access-control-allow-origin', '*');
  const res = new Response(obj.body, { headers });
  ctx.waitUntil(cache.put(key, res.clone()));
  return res;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    // www.pimpmy3mf.app -> https://pimpmy3mf.app (same path + query)
    if (url.hostname === 'www.' + APEX) {
      return Response.redirect(`https://${APEX}${url.pathname}${url.search}`, 301);
    }
    if (request.method === 'GET') {
      if (url.pathname === '/api/filaments') return filaments(url, ctx);
      if (url.pathname === '/api/presets') {
        const key = `${url.origin}/api/presets?v=${PRESETS_CACHE_VERSION}`;
        return fromR2(env.PRESETS, 'manifest.json', key, MANIFEST_TTL, 'application/json', ctx);
      }
      const m = /^\/presets\/([a-z0-9][a-z0-9._-]{0,120}\.webp)$/.exec(url.pathname);
      if (m) {
        const key = `${url.origin}/presets/${m[1]}?v=${PRESETS_CACHE_VERSION}`;
        return fromR2(env.PRESETS, m[1], key, IMAGE_TTL, 'image/webp', ctx);
      }
    }
    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/presets/')) return json({ error: 'not found' }, 404);
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
