// Cloudflare Worker: serves the built app (static assets) plus one API route.
//
//   GET /api/filaments?page=N   one slimmed page of filamentcolors.xyz swatches ({ count, pages, page, results })
//
// The upstream API sends `no-store`, so to be a polite client each page is slimmed and kept in the edge cache:
// served as-is for 24 h (upstream sees at most one request per page per day per colo), and kept up to 7 days as a
// fallback for when filamentcolors.xyz is down. One page per request keeps each invocation's CPU tiny (the full
// list is ~6.7 MB of JSON upstream).
import { slimPage, upstreamPageUrl } from '../src/shared/filaments';

interface Env {
  ASSETS: Fetcher;
}

const APEX = 'pimpmy3mf.app';

/** Serve from the edge cache without asking upstream for this long. */
const TTL = 24 * 60 * 60;
/** Keep the cached copy this long so it can stand in while filamentcolors.xyz is down. */
const STALE_TTL = 7 * 24 * 60 * 60;
const CACHE_VERSION = 'v1';

function json(body: unknown, status: number, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*', ...extra },
  });
}

async function filaments(url: URL, ctx: ExecutionContext): Promise<Response> {
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

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    // www.pimpmy3mf.app -> https://pimpmy3mf.app (same path + query)
    if (url.hostname === 'www.' + APEX) {
      return Response.redirect(`https://${APEX}${url.pathname}${url.search}`, 301);
    }
    if (url.pathname === '/api/filaments' && request.method === 'GET') return filaments(url, ctx);
    if (url.pathname.startsWith('/api/')) return json({ error: 'not found' }, 404);
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
