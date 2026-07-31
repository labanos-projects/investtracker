# Cloudflare Worker: yf-proxy

Live URL: `https://yf-proxy.labanos.workers.dev/`

Deployed at: Cloudflare Dashboard → Workers & Pages → yf-proxy → Edit Code
Account: labanos@gmail.com

## Endpoints

### `?symbols=X,Y,Z` — Current prices
Returns real-time price and daily % change for one or more tickers.

```
GET https://yf-proxy.labanos.workers.dev/?symbols=AAPL,NVDA,DANSKE.CO
```

Response:
```json
{
  "quoteResponse": {
    "result": [
      { "symbol": "AAPL", "regularMarketPrice": 213.5, "regularMarketChangePercent": 1.23 }
    ],
    "error": null
  }
}
```

Notes:
- Uses Yahoo Finance `/v8/finance/chart` (not v7/quote) to avoid IP blocks
- Shows 0% change for stocks that haven't traded today in CET timezone (Danish stocks on weekends/holidays)

### `?quote=SYMBOL` — Full ticker snapshot
Everything the shared ticker page needs for a company that has no row in the
`portfolio` table: currency, name, sector, market cap, P/E.

```
GET https://yf-proxy.labanos.workers.dev/?quote=NVDA
```

Response:
```json
{
  "symbol": "NVDA", "price": 178.2, "chgPct": 0.0134,
  "currency": "USD", "company": "NVIDIA Corporation",
  "sector": "Technology", "industry": "Semiconductors",
  "mktcap": 4.3e12, "pe": 52.1,
  "gross_margin": 0.75, "payout_ratio": 0.01, "insider_own": 0.042,
  "summary_ok": true
}
```

Notes:
- Fundamentals come from `yahooSummary()` in `screener_data.js` — the same
  crumb handshake and 15-minute cache the screener uses, so opening a ticker
  page costs nothing extra once it's warm.
- Price and `chgPct` come from the chart series, not from quoteSummary, for the
  same stale-intraday-change reason `?symbols=` does it that way.
- `summary_ok: false` means the quoteSummary call failed — the fundamentals are
  missing because of an upstream error, not because the company has none.
- 404 only when *neither* source answered.
- `&refresh=1` bypasses the summary cache, the same way the screener's does.

### `?chart=SYMBOL&range=RANGE` — Historical chart data
Returns OHLC close prices for charting.

```
GET https://yf-proxy.labanos.workers.dev/?chart=AAPL&range=1y
```

Supported ranges: `1d`, `5d`, `1mo`, `3mo` (default), `6mo`, `1y`, `2y`, `5y`, `max`

Response:
```json
{ "symbol": "AAPL", "currency": "USD", "points": [{ "t": 1700000000, "c": 189.5 }, ...] }
```

## Why this exists

The one.com shared hosting server IP is blocked by Yahoo Finance for all API calls
(both `file_get_contents` and `curl` return 502/500). This Cloudflare Worker runs
on Cloudflare's IP ranges which Yahoo Finance does not block.

## Notes on metadata (sector/industry/country)

**Corrected 2026-07.** This file used to say the `quoteSummary` crumb handshake
"cannot be reliably obtained from a serverless Worker". That is false — see the
same correction in `CLAUDE.md`. `yahooSummary()` in `screener_data.js` does the
handshake and the summary modules work; only the statement-history modules
return empty.

`php/meta.php` (static ticker map + FMP) is still what the portfolio list uses
for sector/country. The ticker page and the screener take sector/industry from
Yahoo's `assetProfile` module via the Worker instead.
