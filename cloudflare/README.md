# Cloudflare Worker: yf-proxy

Live URL: `https://yf-proxy.labanos.workers.dev/`

Deployed at: Cloudflare Dashboard → Workers & Pages → yf-proxy → Edit Code
Account: labanos@gmail.com

Deploys are triggered by any change under `cloudflare/`, via
`.github/workflows/deploy-worker.yml`. Secrets bound at deploy time:
`GEMINI_API_KEY`, `FMP_API_KEY`, `GSHEET_URL`.

## Endpoints

### `?symbols=X,Y,Z` — Current prices
Returns price, daily % change and **the time the exchange last priced it**, for
one or more tickers.

```
GET https://yf-proxy.labanos.workers.dev/?symbols=AAPL,NVDA,DANSKE.CO
```

Response:
```json
{
  "quoteResponse": {
    "result": [
      { "symbol": "AAPL", "regularMarketPrice": 213.5,
        "regularMarketChangePercent": 1.23,
        "regularMarketTime": 1786023969,
        "exchangeTimezoneName": "America/New_York",
        "source": "yahoo" }
    ],
    "error": null
  }
}
```

Notes:

- `regularMarketTime` is epoch **seconds**, and is `null` when no source gave
  one. Null means unknown and must render as unknown — substituting the current
  time is what hid a seven-hour outage on 2026-08-06.
- `source` is `yahoo` or `gsheet`, so which feed produced a price is visible
  rather than inferred.
- Uses `/v8/finance/chart`, one request per symbol. **`/v7/finance/quote` is
  gone** — it returns 401 `"User is unable to access this feature"` from every
  colo, so the batch branch that used it was removed in v22.
- Shows 0% change for stocks that haven't traded today in CET. That is
  deliberate: a US holding before 15:30 CET has not moved today, and reporting
  yesterday's move as today's is the bug this logic prevents.

### Google Sheets fallback

Since v24, `?symbols=` also fetches a `GOOGLEFINANCE`-backed sheet (see
[`../google-sheets/`](../google-sheets/)) and, **per symbol**, keeps whichever
source has the newer quote time. Yahoo wins ties and anything within 15
minutes, so it stays primary while healthy.

Comparing the two sources against each other avoids the question that has no
wall-clock answer: *is this quote stale?* A US quote timestamped yesterday
22:00 is correct at 09:00 CET and broken at 17:00, and telling those apart
needs a market calendar with holidays and half-days. Comparison needs none of
it, handles a partial recovery symbol-by-symbol, and unwinds itself when Yahoo
returns — no flag to unset.

FX pairs have no `tradetime` from Google and cannot be compared, so they follow
a batch-level verdict: if the sheet is materially newer on at least half the
comparable symbols, it supplies the rates too. Without that, base-currency
conversion runs on frozen rates while every equity beside it is fresh.

Missing `GSHEET_URL`, or any failure fetching it, simply means Yahoo-only.

### `?symbols=SYM&diag=1` — What the upstreams actually say

Every upstream failure in the quote path is swallowed (`if (!res.ok) continue`,
bare `catch {}`), so a 429, a timeout and a parse error are indistinguishable.
This reports what really came back:

```
GET https://yf-proxy.labanos.workers.dev/?symbols=DANSKE.CO&diag=1
```

Probes `query1`/`query2` chart and spark, with and without caching, plus Stooq
and FMP, and returns status, timing, `cf-cache-status`, Yahoo's own `Age`/`Date`
headers and `request.cf.colo`.

**Compare two colos.** That is what identified the 2026-08-06 incident in one
request after six hours of guesswork:

```
CPH   chart 200, cf-cache MISS, age 1, date now, 32,969 bytes, quote 376 min old
IAD   chart 200, cf-cache MISS, age 1, date now, 38,999 bytes, quote  1 min old
```

A genuine cache miss, a freshly generated response, stale content inside it.

### `?quote=SYMBOL` — Full ticker snapshot
Everything the shared ticker page needs for a company with no row in the
`portfolio` table: currency, name, sector, market cap, P/E — plus `quoteTime`
and `timezone`.

Notes:
- Fundamentals come from `yahooSummary()` in `screener_data.js` — same crumb
  handshake and 15-minute cache the screener uses.
- Price and `chgPct` come from the chart series, not quoteSummary, for the same
  stale-intraday-change reason `?symbols=` does it that way.
- `summary_ok: false` means quoteSummary failed — fundamentals are missing
  because of an upstream error, not because the company has none.
- 404 only when *neither* source answered. `&refresh=1` bypasses the cache.

### `?chart=SYMBOL&range=RANGE` — Historical chart data

```
GET https://yf-proxy.labanos.workers.dev/?chart=AAPL&range=1y
```

Ranges: `1d`, `5d`, `1mo`, `3mo` (default), `6mo`, `1y`, `2y`, `5y`, `max`.
Deliberately *not* cache-busted — a 1-year chart does not go stale the way a
live quote does.

## Why this exists

The one.com shared hosting IP is blocked by Yahoo Finance for all API calls
(both `file_get_contents` and `curl` return 502/500). This Worker runs on
Cloudflare IPs, which Yahoo does not block.

## Yahoo can be stale REGIONALLY

On 2026-08-06 Yahoo served one 09:40 snapshot to Copenhagen all day — every
endpoint, both hostnames, and its own website — while returning live data
everywhere else. Nothing in the caching chain explains it; Yahoo's own header
says `max-age=10`. Three cache-related fixes were attempted before anyone
checked whether the upstream was simply returning stale content.

Full write-up, and the measured coverage of every alternative provider, in
[`../docs/DATA_SOURCES.md`](../docs/DATA_SOURCES.md).

## Notes on metadata (sector/industry/country)

**Corrected 2026-07.** This file used to say the `quoteSummary` crumb handshake
"cannot be reliably obtained from a serverless Worker". That is false — see the
same correction in `CLAUDE.md`. `yahooSummary()` in `screener_data.js` does the
handshake and the summary modules work; only the statement-history modules
return empty.

`php/meta.php` (static ticker map + FMP) is still what the portfolio list uses
for sector/country. The ticker page and the screener take sector/industry from
Yahoo's `assetProfile` module via the Worker instead.
