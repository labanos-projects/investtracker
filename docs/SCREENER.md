# Screener

> Part of the InvestTracker agent context. Start at [CLAUDE.md](../CLAUDE.md).
> **Read this when:** changing `screener_engine.js`, `screener_score.js`, the rubric, or how a company is scored.
>
> Fundamentals resolution and the XBRL traps live in
> [DATA_SOURCES.md](DATA_SOURCES.md) — read that first if you are touching
> `screener_data.js`.

## Screener (v12)

Scores a company 0–100% against a rubric aimed at **multibaggers** — 10× and
100× candidates, not generically "good" companies. Endpoint:
`?score_ticker=SYMBOL[&refresh=1]` (Bearer-auth).

### Scoring model

Criteria score **0 / 1 / 2 / null**. `null` means *no data* and is excluded
from **both numerator and denominator**, so `max_score` is dynamic — the same
ticker can be scored out of 66 one day and 54 the next. A `coverage_pct`
records how much of the rubric had data; below 70% the conviction is forced to
`INSUFFICIENT DATA` so a thinly-scored company can never read STRONG BUY.

> Historical note: the pre-v11 scorer did `parseInt(x) || 1`, which silently
> promoted every genuine `0` to a `1`. That put a hard floor of 50% under every
> score and meant the red-flag checks (which trigger on `0`) never once fired.
> GME scored 58% WATCH; it now scores ~42% PASS with 5 flags.

### The compounding engine

The rubric's Tier 1 is built around the arithmetic of a 100-bagger (25.9% CAGR
for 20 years):

```
SGR (sustainable growth rate) = ROIC × (1 − payout ratio)
years to 10×                  = ln(10) / ln(1 + SGR)
```

This is why Coca-Cola scores far below NVIDIA despite being a third the size:
a ~70% payout caps Coke's engine near 6%/yr (≈39 years to 10×), while NVIDIA
retains nearly everything at a much higher ROIC (≈4 years). Market cap is
scored as **headroom** — whether a 10× or 100× implies a terminal cap that has
ever existed (~$3T ceiling) — not as a fixed band.

### Data sources

Per-field waterfall, shared with the valuation engine — see
[DATA_SOURCES.md](DATA_SOURCES.md). Only the six qualitative criteria go to
Gemini, search-grounded. Missing data scores `null` and drops out of the
denominator rather than defaulting to a passing `1`.

### Caching

Shared with the valuation engine — see
[DATA_SOURCES.md](DATA_SOURCES.md#caching-screener_cachejs).

### Test set

| Ticker | Exercises |
|---|---|
| `NVDA` | US 10-K, stock splits, huge growth |
| `ADBE` | US 10-K, buybacks, no dividend |
| `NOVO-B.CO` | 20-F + `ifrs-full` tags, CIK-by-name, DKK→USD |
| `DANSKE.CO` | No SEC presence at all → timeseries-only path |
| `KO` | High payout → the low-SGR / long-years-to-10× case |

After deploying, score a ticker and read `diagnostics` — `edgar_ok`, `ts_ok`,
`fcf_source`, `eps_source`, `cache`, `elapsed_ms` exist precisely so a wrong
result can be explained instead of guessed at.
