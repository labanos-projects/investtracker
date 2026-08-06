# Data sources, XBRL traps and caching

> Part of the InvestTracker agent context. Start at [CLAUDE.md](../CLAUDE.md).
> **Read this when:** touching anything under `cloudflare/` that fetches fundamentals — the screener AND the valuation engine both stand on this.
>
> The three XBRL traps below have each produced confident, wrong numbers in
> production. None of them throws.

## Resolve per FIELD, never per source

Falling back per-source discards good data (EDGAR has audited revenue but no
insider ownership; Yahoo has insider ownership but softer margins). Each metric
walks its own waterfall and records `source` + `confidence`, surfaced in the UI.

| Source | Cost | Covers |
|---|---|---|
| SEC EDGAR `companyfacts` (`us-gaap` **and** `ifrs-full`) | free, unlimited @10 req/s | US filers + 20-F/40-F foreign issuers |
| Yahoo `quoteSummary` (summary modules only) | free | market data, ratios, insider % |
| Yahoo `fundamentals-timeseries` | free | statements, incl. non-SEC names |
| FMP `key-metrics-ttm` | 250/day free | gap-fill only |
| Frankfurter (ECB) | free, no key | FX → USD |
| Gemini 2.5 Flash + `google_search` | included | qualitative judgement only |

EDGAR requires a descriptive `User-Agent` with contact email — that's a
condition of use, not a courtesy.

## Yahoo Finance is proxied via Cloudflare Worker

one.com's shared hosting IP is blocked by Yahoo Finance. All YF API calls must go through the Worker.

## Yahoo can be stale REGIONALLY, and a fresh `Date` header proves nothing

**Incident 2026-08-06.** Every price in the portfolio froze at 09:40 CEST and
stayed there all day. Cause, after six hours: Yahoo's edge serving Denmark
stopped refreshing. Not a cache we own, not the app, not the connection.

The shape of the evidence matters more than the incident, because nothing about
it looks like staleness from the inside:

```
              status  cf-cache  age  date   bytes   regularMarketTime
CPH colo      200     MISS      1    now    32,969  376 minutes old
IAD colo      200     MISS      1    now    38,999  1 minute old
```

Same worker, same URL, same minute. A genuine cache miss, a response generated
now, and hours-old content inside it. **The response was fresh; the data was
not.** Different byte counts, so genuinely different payloads rather than one
object served twice.

Things that were ruled out, in the order they were wrongly suspected:

- **Cloudflare's edge cache.** Yahoo sends `cache-control: public, max-age=10,
  stale-while-revalidate=20`. Ten seconds. It could never have held anything
  for five hours — and that header was readable from the very first probe.
- **Batch size.** `?quote=` is a single chart request on a separate code path
  and was equally stale.
- **A poisoned per-URL entry.** Symbols the app had never once requested
  (ORSTED.CO, VWS.CO, SAP.DE) came back pinned to the same 09:40 boundary,
  across three exchanges. A URL-keyed cache cannot do that.
- **The hostname or the endpoint.** `query1` and `query2`, chart and spark, all
  four identical and all four stale.
- **Anything at all on our side.** Yahoo's own website, opened in a browser on
  the affected connection, displayed `295.55 — As of 9:40:36 AM GMT+2. Market
  Open.` at 16:58. Their consumer product showed the same frozen snapshot.

**Diagnose it in one request, not six hours:** `?symbols=SYM&diag=1` probes
both hosts, both endpoints, with and without caching, plus the fallback
candidates, and reports `request.cf.colo` so an answer is attributable to a
place. Compare two colos and the question answers itself.

Two commits — worker v19 (cap `cacheTtl`) and v20 (minute-bucketed cache
buster) — were shipped against this on a plausible theory and achieved exactly
nothing, because the header disproving that theory had not been read. Both are
harmless hygiene and were kept. The lesson is the ordering: **measure the
upstream before changing anything.** `diag=1` exists so that is cheap.

### There is no free intraday source for `.CO`

Measured 2026-08-06 against live endpoints, not marketing pages:

| Provider | US intraday | Nasdaq Copenhagen | Evidence |
|---|---|---|---|
| Yahoo | free | free | the incumbent — and the one that broke |
| FMP `stable/quote` | works on current plan | **402** "not available under your current subscription" | AAPL 312.59 @ 0 min; DANSKE.CO refused |
| FMP `api/v3/quote` | **403** | **403** | legacy endpoints retired 31 Aug 2025 |
| Finnhub | free tier | **not covered at any tier** | pricing table: market data US-only; international is TSX/LSE/Euronext/Deutsche Börse, and *"other international markets support end-of-day data only"* |
| Twelve Data | free tier | paid only | same pattern |

Intraday Nordic data is licensed and nobody gives it away. A fallback for the
`.CO` half therefore means either paying, or going to the exchange's own feed
(`nasdaqomxnordic.com`, now folded into `nasdaq.com/european-market-activity`) —
which is unverified, not ruled out.

Stooq was probed and returned 404, but with **guessed** symbols (`danske.co`,
`danske.dk`). Its Copenhagen coverage is unverified, not disproven; its symbol
scheme needs looking up before writing it off.

### `regularMarketTime` is the only defence

The worker returns Yahoo's own `regularMarketTime` per symbol (epoch seconds)
and the app renders it next to each price, amber when the quote predates today
in Copenhagen. Before that the header read `new Date()` under the label "Prices
as of", so a quote frozen since Friday was indistinguishable from a live one —
which is why this incident ran for hours before anyone could even name it.

A missing timestamp must render as unknown. Substituting the current time is
the bug, not a fallback.

Note that a US holding legitimately reads 0.00% and yesterday's close until
15:30 CET, because no candle for today exists yet. That is correct and looks
identical to a fault. Only the timestamp separates them.

## Yahoo `quoteSummary` — crumb handshake works; statement modules do not

**Corrected 2026-07.** The old note said quoteSummary "requires browser session
cookies — not feasible from serverless". That is **false**. The documented
handshake works fine from the Worker:

```
GET https://fc.yahoo.com                        → sets the A3 cookie
GET .../v1/test/getcrumb  (with that cookie)    → returns a crumb token
GET .../v10/finance/quoteSummary/SYM?...&crumb= → works
```

Verified on 9 tickers with zero failures. `screener_data.js` caches the crumb
for 30 minutes.

What **is** broken: the statement-history modules
(`incomeStatementHistory`, `balanceSheetHistory`, `cashflowStatementHistory`)
return **empty**. The summary modules (`financialData`, `summaryDetail`,
`price`, `majorHoldersBreakdown`, `assetProfile`) still work. This is why FCF
came back `null` for every ticker on the first live screener run. Statement
data must come from EDGAR or from `ws/fundamentals-timeseries`.

Separately, **`v7/finance/quote` is gone.** As of 2026-08 it returns 401
`"User is unable to access this feature"` from every colo tested. The batch
branch that used it was removed in worker v22; `?symbols=` is now a chart
request per symbol.

## SEC XBRL has THREE traps that silently produce wrong numbers

All three cost a debugging session. (a) and (b) are in `edgarFacts()` in
`screener_data.js` and duplicated in `valuationFacts()` in `valuation_data.js`;
(c) is valuation-only, because only a DCF cares about a share count more recent
than the last annual report.

1. **`fy` is the fiscal year of the REPORT, not of the data point.** A single
   NVDA 10-K carries three annual periods (ending 2023-01-29, 2024-01-28,
   2025-01-26) all tagged `fy: 2025`. Key on the period **`end`** date, and
   filter durations to 300–400 days to exclude quarterly rows.

2. **Per-share quantities are restated across stock splits, and only *within* a
   filing.** NVDA straddles a 4:1 (2021) and a 10:1 (2024). Merging filings
   read those splits as dilution: share CAGR came out **+76.3%** instead of
   **−0.9%**. For share counts, restrict to the latest accession's own
   comparatives — 3 consistent years beat 5 inconsistent ones.

3. **A split can happen AFTER the last annual report.** Fix (2) handles splits
   the latest 10-K has already restated. It does nothing for one announced
   since, because the 10-K is then entirely self-consistent and entirely out of
   date. Mueller Industries split 2-for-1 between its FY2025 10-K (filed
   2026-02-25, 111,492,000 shares) and its Q2 2026 10-Q (filed 2026-07-22,
   221,192,000). The reconciliation gate read 1.98 and refused to save — correct,
   and useless, because the right number was in a 10-Q we weren't reading.

   `splitFactorSinceAnnual()` compares the annual basis against the most
   recently FILED share figure of ANY form. Absent a split they agree within a
   couple of percent; a split is a clean multiple, and only clean multiples are
   applied so a buyback is never mistaken for one.

   **Do not "fix" this by diffing restatements across filings.** That breaks the
   case (2) already handles: NOW's FY2025 10-K restates FY2023 from 205,591,000
   to 1,027,953,000, and the series is ALREADY on that basis — detecting that
   restatement and applying it again multiplies a correct series by five. Anchor
   on the annual basis you actually returned and ask the narrower question: is
   THIS series stale?

None of these failures is loud. All three produce plausible, confident, wrong
output — NVDA's PEG read 4.74 when it should have been ~0.29.

## Gemini: search grounding and structured output are mutually exclusive on 2.5

`tools: [{google_search: {}}]` with `responseMimeType: 'application/json'`
fails: *"controlled generation is not supported with google_search tool"*. Both
engines therefore do a **grounded research pass** (prose + citations) then an
**ungrounded structuring pass** (strict `responseSchema`). Gemini 3 models allow
both in one call — see `MODEL` in `screener_score.js` and `valuation_model.js`.

Two schema traps, both found in production:

- **Every field must be `required`.** Otherwise any of them may simply be absent
  — a scenario came back with no `multiples` array at all.
- **No unbounded free-text field, especially not first.** An uncapped `thesis`
  string led one response object; Gemini filled it with ~22,000 characters,
  exhausted `maxOutputTokens`, and the truncated JSON surfaced as
  `Unterminated string in JSON at position 22419` — an error about the symptom,
  three layers from the cause. Surface `finishReason` so truncation reports
  itself as truncation.

## Caching (`screener_cache.js`)

Used by both engines despite the name.

Two layers: a module-global `Map` (isolate-local, instant) in front of the
Cache API (`caches.default`, colo-local, survives isolate recycling). Both are
best-effort speedups, never correctness assumptions. TTLs match how often each
upstream actually changes — EDGAR/SEC map 24h, timeseries 6h, FX 12h, Yahoo
summary 15m, grounded AI research 24h.

**Cache keys deliberately exclude** the Yahoo crumb, the timeseries
`period2=now`, and the FMP api key. All three rotate; leaving them in makes
every key unique and the cache useless.

Keys carry a version where the shape of the cached value matters — e.g.
`valuation-research:v2:TICKER:DATE`. Bumping the version retires stale-shaped
entries instead of silently degrading for a day.

`?refresh=1` bypasses every layer. Keep it — a cached score would have hidden
the XBRL split bug instead of surfacing it.

**Caching is not the first suspect when data looks old.** See the regional
staleness section above: three separate cache-related fixes were attempted
before anyone checked whether the upstream was simply returning stale content.
