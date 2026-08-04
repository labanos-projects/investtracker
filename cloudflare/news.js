// ─── news.js — company news: resolution, fan-out, relevance ─────────────────
//
// The old ?news= handler was one line of URL construction:
//
//   /v1/finance/search?q=${newsSymbol}&newsCount=10
//
// and it was wrong in a way that produced garbage rather than an error. `q` on
// that endpoint is a FREE-TEXT field, not a symbol lookup. It was being handed
// the app's Yahoo LISTING symbol — the same identifier that correctly picks the
// exchange for a price — and exchange-suffixed listings are not text Yahoo's
// news index knows anything about.
//
// Measured against production, on the same afternoon:
//
//   ?news=NOVO-B.CO   → Tesla/China, Miami-Dade early voting, Google Earth's
//                       AI misadventure, Tibetan antelopes. Ten items, zero
//                       about Novo Nordisk.
//   ?news=NOVO-B      → {"news":[]}
//   ?news=NVO         → actual Novo Nordisk news
//   ?news=Novo Nordisk→ actual Novo Nordisk news
//
// So the failure mode depends on how badly the string misses: a total miss
// returns empty, a partial miss returns Yahoo's general market firehose. The
// second is much worse, because NewsPanel rendered it as company news and
// nothing in the response said otherwise. Every non-US holding was affected —
// ASML.AS, CSU.TO, CHG.DE all take this path.
//
// Fixing the identifier is necessary and NOT sufficient. Querying NVO — the
// symbol that works — the ZEUS ziltivekimab failure that took the stock down
// 9.3% and erased $30bn on 31 July was already out of the top ten by 3 August.
// One query, newsCount=10, recency-sorted, no importance weighting: the biggest
// event of the quarter falls off the page in seventy-two hours. Depth is a
// separate defect from correctness and both are fixed here.
//
// ── What this module does ──
//
//   1. RESOLVE  the listing into an identity: company name, the company's other
//               listings (notably the US one, whose news coverage on Yahoo is
//               far richer than the local line's), sector/industry, and peers.
//   2. FAN OUT  several queries built from that identity, deeper than before,
//               and union the results.
//   3. CLASSIFY every article as `company`, `related`, or drop-it. An article
//               that matches nothing is discarded rather than displayed. This
//               is the part that kills the firehose: it does not matter what
//               Yahoo pads the response with if nothing unrelated survives.
//
// Everything is cached through screener_cache.js — identity for 24h (a
// company's name and listings do not change intraday), headlines for 15
// minutes. ?refresh=1 bypasses both, same contract as the screener.

import { cachedJson, cachedValue } from './screener_cache.js';
import { yahooSummary } from './screener_data.js';

const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const YF_HEADERS = {
  'User-Agent': BROWSER_UA,
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer': 'https://finance.yahoo.com/',
};

const NEWS_TTL     = 15 * 60;        // headlines move; fundamentals do not
const IDENTITY_TTL = 24 * 3600;      // names, listings, peers: effectively static
const MAX_COMPANY  = 30;             // the panel paginates; give it room
const MAX_RELATED  = 10;
const MAX_AGE_DAYS = 21;

// ─── Text normalisation ─────────────────────────────────────────────────────

const norm = (s) => String(s || '')
  .toLowerCase()
  .replace(/&amp;/g, '&')
  .replace(/&#39;|&rsquo;|[‘’]/g, "'")
  .replace(/[“”]/g, '"')
  .replace(/[^a-z0-9&'./\s-]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

// Trailing legal forms only. Stripping these anywhere in the string would
// mangle real names — "Coca-Cola Company" must lose "company" but a company
// called "Co-operative" must not lose its head.
const LEGAL_TOKENS = new Set([
  'a/s', 'as', 'asa', 'ab', 'ag', 'sa', 'se', 'nv', 'bv', 'oyj', 'spa', 'kgaa',
  'inc', 'incorporated', 'corp', 'corporation', 'company', 'co', 'ltd',
  'limited', 'llc', 'lp', 'plc', 'holding', 'holdings', 'group', 'adr', 'ads',
  'and',   // left dangling by "Eli Lilly and Company" once "company" is gone
]);

/**
 * "Novo Nordisk A/S"      → "novo nordisk"
 * "Alphabet Inc. Class A" → "alphabet"
 * "The Coca-Cola Company" → "coca-cola"
 */
export function coreName(name) {
  let toks = norm(name).replace(/\./g, '').split(' ').filter(Boolean);
  if (toks[0] === 'the') toks = toks.slice(1);
  if (toks.length > 2 && toks[toks.length - 2] === 'class') toks = toks.slice(0, -2);
  while (toks.length > 1 && LEGAL_TOKENS.has(toks[toks.length - 1])) toks = toks.slice(0, -1);
  return toks.join(' ');
}

// A headline usually says "Novo", not "Novo Nordisk A/S", so the leading token
// earns its own alias — that single word is what matches the Financial Times'
// "'Arrogance kills': Novo chief injects risk-taking into Ozempic maker".
//
// It is also the most dangerous alias in the file. "American", "United" and
// "Global" as standalone words match half the financial press, so words that
// carry no identifying information are refused the promotion. When the leading
// token is generic the full name still matches; we simply lose the short form.
const GENERIC_HEAD = new Set([
  'american', 'united', 'general', 'national', 'international', 'global',
  'first', 'new', 'old', 'pacific', 'atlantic', 'standard', 'royal', 'imperial',
  'western', 'eastern', 'northern', 'southern', 'central', 'continental',
  'allied', 'premier', 'superior', 'universal', 'advanced', 'applied',
  'integrated', 'digital', 'micro', 'macro', 'tech', 'data', 'capital',
  'pioneer', 'summit', 'liberty', 'freedom', 'sun', 'star', 'crown', 'apex',
  'alpha', 'omega', 'delta', 'prime', 'core', 'next', 'open', 'true', 'real',
]);

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Whole-word phrase match against an already-normalised haystack.
 *
 * Plain `includes()` is not good enough at this length. The alias "novo" has to
 * match "Novo chief injects risk-taking" while NOT matching Novozymes — a
 * different company that Yahoo will cheerfully return for the same query.
 * Trailing possessives still match, because the apostrophe is a boundary:
 * "Lilly's Q2 results" matches the alias "lilly".
 */
function phraseInText(hay, phrase) {
  if (!phrase) return false;
  return new RegExp(`(^|[^a-z0-9])${escapeRe(phrase)}($|[^a-z0-9])`).test(hay);
}

/**
 * Ticker symbols are matched against the ORIGINAL-CASE title, as isolated
 * tokens. Lowercasing first would let "NVO" match inside a word and let short
 * symbols match ordinary English — this is why symbols under three characters
 * are refused outright. Headlines write them as "Novo Nordisk (NVO)" or
 * "(NYSE: NVO)", so the surrounding punctuation is part of the signal.
 */
function symbolInText(text, symbol) {
  if (!symbol || symbol.length < 3) return false;
  return new RegExp(`(^|[\\s(\\[:,"'])${escapeRe(symbol)}($|[\\s)\\]:,.;!?"'])`).test(text);
}

// The other half of the alias problem. Once a multi-word name is broken into
// tokens, the descriptive ones are worthless as identifiers — "Constellation
// Software" must answer to "Constellation" and never to "Software", which
// would match most of the technology press. Blocked wherever they appear.
const GENERIC_TOKEN = new Set([
  'software', 'systems', 'technologies', 'technology', 'industries',
  'industrial', 'energy', 'motors', 'pharmaceuticals', 'pharma', 'bank',
  'banking', 'financial', 'finance', 'resources', 'materials', 'brands',
  'foods', 'food', 'airlines', 'airways', 'communications', 'media',
  'entertainment', 'partners', 'ventures', 'labs', 'laboratories',
  'therapeutics', 'biosciences', 'bioscience', 'health', 'healthcare',
  'solutions', 'services', 'products', 'stores', 'retail', 'mining',
  'petroleum', 'chemical', 'chemicals', 'electric', 'electronics', 'motor',
  'insurance', 'trust', 'properties', 'realty', 'america', 'europe', 'asia',
]);

/**
 * A company's aliases: its cleaned full name, plus every token in that name
 * that could plausibly identify it on its own.
 *
 * Headlines almost never use the legal name after the first reference, and the
 * useful short form is not always the leading word. "Novo Nordisk A/S" answers
 * to "Novo"; "Eli Lilly and Company" answers to "Lilly's", where the leading
 * token is a three-letter given name that identifies nothing. Taking only the
 * head token dropped every Lilly headline on the floor — which was visible in
 * testing as an empty Related bucket.
 *
 * Tokens must therefore be filtered on what they mean, not on where they sit.
 */
function nameAliases(name) {
  const core = coreName(name);
  if (!core) return [];
  const out = [core];
  if (core.includes(' ')) {
    for (const tok of core.split(' ')) {
      if (tok.length >= 4 && !GENERIC_HEAD.has(tok) && !GENERIC_TOKEN.has(tok)) out.push(tok);
    }
  }
  return [...new Set(out)];
}

// ─── Yahoo search ───────────────────────────────────────────────────────────

function yfSearch(q, { news = 0, quotes = 0 }, refresh) {
  const url = `https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q)}`
            + `&quotesCount=${quotes}&newsCount=${news}&listsCount=0&enableFuzzyQuery=false`;
  return cachedJson(url, { headers: YF_HEADERS }, {
    ttl: news ? NEWS_TTL : IDENTITY_TTL,
    ms: 8000,
    refresh,
    key: `yf-news-search:${news ? 'n' : 'q'}:${q.toLowerCase()}`,
  });
}

/**
 * Yahoo's per-symbol RSS headline feed. Genuinely symbol-keyed rather than
 * text-matched, so it recalls differently from /finance/search and is worth
 * unioning in — this is the source most likely to still be carrying a story
 * that the search index has already aged out.
 *
 * Best-effort by design. It is an undocumented feed, it may return nothing,
 * and Workers have no DOM parser so the XML is picked apart with regex. If any
 * of that fails the function returns [] and the other sources carry the
 * request. Its contribution is reported in ?debug=1 so you can tell whether it
 * is actually pulling its weight rather than assuming.
 */
async function rssHeadlines(symbol, refresh) {
  if (!symbol) return [];
  return cachedValue(`yf-news-rss:${symbol}`, NEWS_TTL, refresh, async () => {
    try {
      const res = await fetch(
        `https://feeds.finance.yahoo.com/rss/2.0/headline?s=${encodeURIComponent(symbol)}&region=US&lang=en-US`,
        { headers: { 'User-Agent': BROWSER_UA, 'Accept': 'application/rss+xml, application/xml, text/xml' } },
      );
      if (!res.ok) return [];
      const xml = await res.text();
      const out = [];
      const items = xml.match(/<item>[\s\S]*?<\/item>/g) || [];
      for (const block of items) {
        const pick = (tag) => {
          const m = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`).exec(block);
          if (!m) return null;
          return m[1].replace(/^\s*<!\[CDATA\[/, '').replace(/\]\]>\s*$/, '').trim() || null;
        };
        const title = pick('title');
        const link  = pick('link');
        if (!title || !link) continue;
        const pub = pick('pubDate');
        const ts  = pub ? Math.floor(Date.parse(pub) / 1000) : null;
        out.push({
          title,
          link,
          publisher: 'Yahoo Finance',
          providerPublishTime: Number.isFinite(ts) ? ts : null,
        });
      }
      return out;
    } catch {
      return [];
    }
  });
}

/**
 * Peer companies, used only to decide what counts as `related`.
 *
 * Without names this is useless: matching the symbol "LLY" does not match the
 * headline "Will Mounjaro & Zepbound Drive Lilly's Q2 Results". So the
 * recommended symbols are resolved to display names in one batched quote call,
 * and both forms become aliases. Two extra upstream calls, cached for a day,
 * and every failure path degrades to an empty peer list — which costs a
 * `related` classification, never a `company` one.
 */
async function resolvePeers(symbol, refresh) {
  const empty = { symbols: [], names: [] };
  if (!symbol) return empty;
  try {
    const d = await cachedJson(
      `https://query2.finance.yahoo.com/v6/finance/recommendationsbysymbol/${encodeURIComponent(symbol)}`,
      { headers: YF_HEADERS },
      { ttl: IDENTITY_TTL, ms: 6000, refresh, key: `yf-peers:${symbol}` },
    );
    const syms = (d?.finance?.result?.[0]?.recommendedSymbols || [])
      .map(r => r?.symbol).filter(Boolean).slice(0, 8);
    if (!syms.length) return empty;

    let names = [];
    try {
      const q = await cachedJson(
        `https://query2.finance.yahoo.com/v7/finance/quote?symbols=${syms.map(encodeURIComponent).join(',')}&fields=shortName,longName`,
        { headers: YF_HEADERS },
        { ttl: IDENTITY_TTL, ms: 6000, refresh, key: `yf-peer-names:${syms.join(',')}` },
      );
      names = (q?.quoteResponse?.result || [])
        .flatMap(r => nameAliases(r?.longName || r?.shortName))
        .filter(n => n && n.length >= 4);
    } catch { /* v7/quote is crumb-gated some days — symbols alone still help */ }

    return { symbols: syms.filter(s => !s.includes('.') && s.length >= 3), names: [...new Set(names)] };
  } catch {
    return empty;
  }
}

// Industry strings are marketing copy ("Drug Manufacturers—General"), so only
// the tokens carrying meaning survive. These are the weakest signal in the
// file and are used exclusively to promote an article into `related` — never
// into `company`.
const INDUSTRY_STOP = new Set([
  'general', 'specialty', 'diversified', 'other', 'and', 'the', 'services',
  'products', 'equipment', 'manufacturers', 'manufacturing', 'companies',
  'systems', 'solutions', 'holding', 'holdings', 'group', 'industry',
]);

function sectorTerms(sector, industry) {
  return [...new Set(
    norm(`${industry || ''} ${sector || ''}`).split(/[\s\-—/&]+/),
  )].filter(t => t.length >= 4 && !INDUSTRY_STOP.has(t));
}

// ─── Identity ───────────────────────────────────────────────────────────────

/**
 * Turn a listing symbol into everything needed to find and vet its news.
 *
 * `hintName` is the company name the page is already displaying. Passing it
 * makes the common path work even when quoteSummary is having a bad day, which
 * matters: the company name is the single most valuable query in the fan-out,
 * and the one that made ?news=Novo%20Nordisk work when the symbol did not.
 */
export async function resolveIdentity(yhTicker, hintName, refresh = false) {
  const listing = String(yhTicker || '').toUpperCase().trim();
  const cacheKey = `news-identity:${listing}:${coreName(hintName) || '-'}`;

  return cachedValue(cacheKey, IDENTITY_TTL, refresh, async () => {
    const base = listing.replace(/\.[A-Z]{1,4}$/, '');   // NOVO-B.CO → NOVO-B
    const root = base.replace(/[-.][A-Z0-9]$/, '');      // NOVO-B    → NOVO

    // quoteSummary carries the authoritative name plus the sector/industry the
    // `related` bucket needs. It is cached for 15 minutes and the ?quote= path
    // that renders this same page has almost always warmed it already.
    const summary = await yahooSummary(listing, refresh).catch(() => null);
    const longName = summary?.longName || hintName || null;
    const core = coreName(longName);

    // The company's other listings. The US line is the prize: Yahoo's news
    // coverage of NVO is an order of magnitude better than of NOVO-B.CO, and
    // it is the same company.
    let listings = [];
    try {
      const q = await yfSearch(core || listing, { quotes: 8 }, refresh);
      listings = (q?.quotes || [])
        .filter(x => x?.isYahooFinance && ['EQUITY', 'ETF'].includes(x.quoteType))
        .filter((x) => {
          // Same-company test, not a fuzzy-match test. Yahoo will happily
          // return "Novozymes" for "novo nordisk"; requiring one cleaned name
          // to contain the other keeps siblings and drops neighbours.
          const n = coreName(x.longname || x.shortname);
          if (!n || !core) return false;
          return n === core || n.startsWith(core) || core.startsWith(n);
        })
        .map(x => String(x.symbol).toUpperCase());
    } catch { /* identity degrades to the listing itself */ }

    if (!listings.includes(listing)) listings.unshift(listing);
    const usListings = listings.filter(s => !s.includes('.'));
    const primary = usListings[0] || listing;

    // Queries, best first. The company name is the workhorse; a US symbol adds
    // the wire copy that files against the ticker rather than the name.
    const queries = [];
    if (core) queries.push(core);
    for (const s of usListings.slice(0, 2)) queries.push(s);
    if (!queries.length) queries.push(listing);

    // Aliases that make an article THIS COMPANY's news.
    const names = new Set([...nameAliases(longName), ...nameAliases(hintName)].filter(Boolean));

    const symbols = new Set([listing, base, ...listings].filter(s => s && s.length >= 3));
    // `root` is the share-class-stripped stem ("NOVO"). Useful, but only when
    // it is long enough not to collide with ordinary prose.
    if (root && root.length >= 4) symbols.add(root);

    const peers = await resolvePeers(primary, refresh);

    return {
      listing,
      primary,
      company: longName,
      queries,
      aliases: { names: [...names], symbols: [...symbols] },
      peers,
      sector_terms: sectorTerms(summary?.sector, summary?.industry),
      sector: summary?.sector || null,
      industry: summary?.industry || null,
    };
  });
}

// ─── Classification ─────────────────────────────────────────────────────────

/**
 * `company` | `related` | null (drop).
 *
 * Order matters: a headline naming both Novo and Lilly is Novo's news, so the
 * company aliases are tested first and win. Returning null for everything else
 * is the whole fix — Yahoo can pad the response with whatever it likes and
 * none of it reaches the panel.
 */
export function classify(item, id) {
  const title = String(item?.title || '');
  if (!title) return null;
  const hay = norm(`${title} ${item?.publisher || ''}`);

  for (const n of id.aliases.names)   if (phraseInText(hay, n))   return 'company';
  for (const s of id.aliases.symbols) if (symbolInText(title, s)) return 'company';

  for (const n of id.peers.names)     if (phraseInText(hay, n))   return 'related';
  for (const s of id.peers.symbols)   if (symbolInText(title, s)) return 'related';
  for (const t of id.sector_terms)    if (phraseInText(hay, t))   return 'related';

  return null;
}

const shape = (n) => ({
  title:     n.title,
  publisher: n.publisher || null,
  time:      n.providerPublishTime || null,
  link:      n.link,
  thumbnail: n.thumbnail?.resolutions?.[0]?.url ?? null,
});

// ─── Entry point ────────────────────────────────────────────────────────────

export async function companyNews(yhTicker, hintName, { refresh = false, debug = false } = {}) {
  const id = await resolveIdentity(yhTicker, hintName, refresh);

  // Every source is allowed to fail alone. A dead RSS feed must not cost us the
  // search results, and vice versa — this is the same allSettled discipline the
  // ?quote= endpoint uses for exactly the same reason.
  const jobs = [
    ...id.queries.map(q => ({ label: `search:${q}`, p: yfSearch(q, { news: 20 }, refresh).then(d => d?.news || []) })),
    { label: `rss:${id.primary}`, p: rssHeadlines(id.primary, refresh) },
  ];
  const settled = await Promise.allSettled(jobs.map(j => j.p));

  const pool = new Map();
  const sources = [];
  settled.forEach((res, i) => {
    const items = res.status === 'fulfilled' ? res.value : [];
    sources.push({
      source: jobs[i].label,
      ok: res.status === 'fulfilled',
      returned: items.length,
      error: res.status === 'rejected' ? String(res.reason?.message || res.reason) : null,
    });
    for (const n of items) {
      // Dedupe on the link, falling back to the normalised title: syndicated
      // wire copy reaches us under several Yahoo URLs with identical headlines.
      const key = n?.link || norm(n?.title);
      if (!key || pool.has(key)) continue;
      pool.set(key, n);
    }
  });

  const cutoff = Math.floor(Date.now() / 1000) - MAX_AGE_DAYS * 86400;
  const company = [], related = [];
  let droppedIrrelevant = 0, droppedStale = 0;

  for (const n of pool.values()) {
    if (n.providerPublishTime && n.providerPublishTime < cutoff) { droppedStale++; continue; }
    const cls = classify(n, id);
    if (!cls) { droppedIrrelevant++; continue; }
    (cls === 'company' ? company : related).push(shape(n));
  }

  const byTime = (a, b) => (b.time || 0) - (a.time || 0);
  company.sort(byTime);
  related.sort(byTime);

  const payload = {
    // `news` keeps its name and its shape. An un-deployed frontend keeps
    // working against this endpoint; it just stops being lied to.
    news: company.slice(0, MAX_COMPANY),
    related: related.slice(0, MAX_RELATED),
    resolved: {
      symbol: id.primary,
      company: id.company,
      matched_on: id.aliases.names,
    },
  };

  if (debug) {
    payload.diagnostics = {
      identity: id,
      sources,
      pooled: pool.size,
      dropped_irrelevant: droppedIrrelevant,
      dropped_stale: droppedStale,
      refresh,
    };
  }
  return payload;
}
