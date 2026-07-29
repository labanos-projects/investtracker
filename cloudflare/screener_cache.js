// ─── screener_cache.js — two-layer cache for screener upstreams ──────────────
//
// Scoring took ~30s, almost all of it waiting on upstreams that change roughly
// four times a year. The provenance fields added in v11 (fcf_source,
// eps_source) told us exactly which calls are on the hot path:
//
//   sec ticker->cik map   ~1MB, changes weekly          → 24h
//   EDGAR companyfacts    multi-MB, changes quarterly   → 24h
//   Yahoo timeseries      changes quarterly             → 6h
//   Yahoo summary         price/mktcap, wants freshness → 15m
//   Frankfurter FX        ECB fixes once daily          → 12h
//   Gemini grounded pass  expensive, qualitative        → 24h
//
// Two layers because they fail differently:
//
//   1. Module-global Map — isolate-local, instant, dies when CF recycles the
//      isolate. For a low-traffic hobby app most requests hit a warm isolate.
//   2. Cache API (caches.default) — colo-local, survives isolate recycling.
//      Best-effort: Cloudflare may evict at any time, and it's per-datacenter,
//      so this is a speedup, never a correctness assumption.
//
// Every entry is bypassable via ?refresh=1 so the debugging loop that found
// the XBRL split bug still works against live data.
// ─────────────────────────────────────────────────────────────────────────────

const MEM = new Map();

const memGet = (k) => {
  const e = MEM.get(k);
  if (!e) return null;
  if (Date.now() > e.exp) { MEM.delete(k); return null; }
  return e.data;
};
const memPut = (k, data, ttl) => {
  // Keep the isolate's footprint bounded — companyfacts payloads are large.
  if (MEM.size > 40) MEM.delete(MEM.keys().next().value);
  MEM.set(k, { exp: Date.now() + ttl * 1000, data });
};

/** Cache API keys must be valid https URLs; synthesise one for non-URL keys. */
const asRequest = (key) =>
  new Request(key.startsWith('http') ? key : `https://screener.cache/${encodeURIComponent(key)}`);

async function edgeGet(key) {
  try {
    const res = await caches.default.match(asRequest(key));
    return res ? await res.json() : null;
  } catch { return null; }
}

async function edgePut(key, data, ttl) {
  try {
    await caches.default.put(asRequest(key), new Response(JSON.stringify(data), {
      headers: { 'Content-Type': 'application/json', 'Cache-Control': `max-age=${ttl}` },
    }));
  } catch { /* cache unavailable — non-fatal by design */ }
}

// Per-request counters, surfaced in diagnostics so a suspiciously fast or
// suspiciously stale score can be explained without guessing.
export const STATS = { mem: 0, edge: 0, miss: 0 };
export const resetStats = () => { STATS.mem = 0; STATS.edge = 0; STATS.miss = 0; };
export const statsSnapshot = () => ({ ...STATS });

/** Read-through cache for a JSON GET. */
export async function cachedJson(url, opts = {}, { ttl = 86400, ms = 10000, refresh = false, key } = {}) {
  const k = key || url;
  if (!refresh) {
    const hot = memGet(k);
    if (hot) { STATS.mem++; return hot; }
    const warm = await edgeGet(k);
    if (warm) { STATS.edge++; memPut(k, warm, ttl); return warm; }
  }
  STATS.miss++;
  const res = await Promise.race([
    fetch(url, opts),
    new Promise((_, rj) => setTimeout(() => rj(new Error('timeout')), ms)),
  ]);
  if (!res.ok) throw new Error(`${res.status} ${String(url).slice(0, 60)}`);
  const data = await res.json();
  memPut(k, data, ttl);
  await edgePut(k, data, ttl);
  return data;
}

/** Cache an arbitrary computed value (used for the grounded AI research pass). */
export async function cachedValue(key, ttl, refresh, produce) {
  if (!refresh) {
    const hot = memGet(key);
    if (hot) { STATS.mem++; return hot; }
    const warm = await edgeGet(key);
    if (warm) { STATS.edge++; memPut(key, warm, ttl); return warm; }
  }
  STATS.miss++;
  const data = await produce();
  memPut(key, data, ttl);
  await edgePut(key, data, ttl);
  return data;
}

export const TTL = {
  SEC_MAP: 24 * 3600,
  EDGAR: 24 * 3600,
  YF_TIMESERIES: 6 * 3600,
  YF_SUMMARY: 15 * 60,
  FX: 12 * 3600,
  AI_RESEARCH: 24 * 3600,
};
