# Valuation model

> Part of the InvestTracker agent context. Start at [CLAUDE.md](../CLAUDE.md).
> **Read this when:** changing `valuation_data.js`, `valuation_model.js`, or the DCF shown on the ticker page.
>
> Fundamentals resolution and the XBRL traps live in
> [DATA_SOURCES.md](DATA_SOURCES.md). Trap (c) exists because of this engine.

## Valuation model (v2)

A bear/base/bull 5-year DCF per ticker. Endpoint:
`?generate_valuation=SYMBOL&portfolio_id=N[&current_price=X][&refresh=1]`
(Bearer-auth). Orchestration in `valuation_model.js`, data in
`valuation_data.js`.

### The one rule

**Filings decide what the company HAS earned. Gemini decides what it MIGHT
earn.**

Before v2 the endpoint called one upstream (FMP `income-statement`) and, when it
returned nothing, fell through to `buildKnowledgePrompt()` — which told Gemini to
model the company "from your training knowledge". **Thirteen of twenty-six stored
models were built that way**, and the only trace was a parenthetical in a notes
string. Two regenerations of ServiceNow 45 minutes apart returned different
"actuals" (FY2025 net income 2,750 then 2,200; shares 201 then 203) against filed
figures of ~1,660 and 1,047M. Filed financials do not change in 45 minutes.

The structural fix is that **the response schema has no field for a historical
figure**. Gemini returns growth, margins, share change, discount rate, an exit
multiple distribution and a rationale — nothing else. It cannot contradict a
10-K because it has nowhere to put one. If no source answers, the endpoint
errors; it never invents.

### Data resolution

Same per-field waterfall as the screener: EDGAR `companyfacts` (`us-gaap` AND
`ifrs-full`) → Yahoo `fundamentals-timeseries` (gap-fill, and the only path for
non-SEC names). `valuationFacts()` carries XBRL traps (a), (b) and (c) — see
[DATA_SOURCES.md](DATA_SOURCES.md) — plus the `op_income` tags a DCF needs and
the screener does not. Trap (d), the currency gate below, is valuation-only.

`field_sources` in diagnostics describes the **baseline year**, not the earliest
year resolved. Recording it during the merge loop reported whichever source
answered the oldest year, so NOW's shares read `yahoo-ts` (only Yahoo had 2019)
while the FY2023-25 figures the model stands on came from EDGAR.

### The currency gate

**A DCF divides a filed earnings figure by a share count and compares the result
to a market price. Those must be the same currency.** For an ADR they are not:
TSMC reports TWD and trades USD, ASML reports EUR and trades USD, Cameco reports
CAD and trades USD.

`resolveValuationInputs` had always returned `currency` (the filing) and
`quote_currency` (the quote) as separate fields, with a comment noting they can
differ — and nothing ever converted between them. Terminal EPS came out in the
reporting currency and was measured against a price in the quote currency, so
every such model was wrong by the exchange rate, in full.

TSM is the loud case and it is not the instructive one: TWD/USD is ~31, so the
model returned a fair value of 13,421 against a price of 416 and
`baseline_pe_diverges_from_market` caught it. **The instructive cases are ASML
and CCJ**, which are wrong by 15-40% — inside every threshold in
`valuation_model.js`. Both shipped as `data_quality: "ok"` with an empty flags
array. CCJ's stored +31% upside was really about +3%, and nothing in the output
said so. That is the failure mode this engine keeps producing: not an error, a
confident number.

So when the filing currency and the quote currency differ, `valuation_data.js`
resolves spot FX and translates revenue, gross profit, operating income and net
income onto the quote basis before anything downstream sees them. Everything
from that point — `actuals`, `history`, the Gemini prompt, the stored model, the
ticker page — speaks one currency.

Three things that are deliberate:

- **Share counts are never converted.** A count is not an amount of money.
- **No rate resolvable means the model errors.** Defaulting to 1 is the original
  bug wearing a different hat.
- **Spot, not per-year historical rates.** The projection compounds ratios off
  the Y0 baseline and applies the exit multiple to terminal EPS, so it is the
  current rate that has to line up with the current price. Restating seven years
  at seven rates would make the growth rates the model reads mean something
  other than the growth the company reported.

Rates come from Yahoo `<PAIR>=X` rather than Frankfurter: Frankfurter serves ECB
reference rates and the ECB does not publish TWD, so it cannot answer the pair
that broke this. The direct pair is tried first and the inverse used as a
fallback.

**The ADR ratio needs no fix, and adding one would break it.** Yahoo reports
`dilutedAverageShares` for an ADR symbol on an ADS basis (TSM: 5,186M, i.e.
25,930M ordinary ÷ 5), and market cap and price are both per-ADS — so the ratio
cancels out of EPS and the reconciliation gate reads ~1.00. FX was the whole of
the discrepancy. If a filer ever resolves shares from EDGAR on an *ordinary*
basis while quoting as an ADR, reconciliation reads 0.2 and blocks it, which is
the correct outcome.

### The reconciliation gate

Resolving from filings is necessary but not sufficient — a units slip or a
split-corrupted share count still yields plausible, confident, wrong output. So
diluted shares x price is checked against reported market cap **before anything
is saved**:

| Drift | Behaviour |
|---|---|
| ≤ 20% | ok — diluted weighted-average vs shares outstanding legitimately differ |
| 20–50% | `share_count_drift`, saved with a warning |
| > 50% | **blocked**, HTTP 422, nothing written |

Nothing benign lands at a ratio of 5.0. The old ServiceNow model read 5.14 and
would never have been saved.

Note that this gate is untouched by the currency conversion above, and cannot
substitute for it: market cap, price and share count are all already on the
quote basis, so a currency mismatch reconciles perfectly while the valuation is
off by 30x.

### Sanity flags

Computed on the assembled model before saving, and rendered in plain English by
`ValuationQualityBanner` in `valuations.js`. Any flag sets `data_quality: warn`.

| Flag | Fires when |
|---|---|
| `implausible_upside` | blended FV > 2x price |
| `baseline_pe_diverges_from_market` | baseline P/E more than 40% from trailing P/E |
| `base_exit_multiple_above_current_pe` | base exit multiple above the ceiling |
| `exit_multiple_ignores_margin_expansion` | margin expansion AND a near-peak multiple |
| `share_count_drift` | reconciliation in the 20–50% band |
| `baseline_year_stale` | last full fiscal year 9+ months old |

`baseline_pe_diverges_from_market` is the flag that eventually caught the
currency bug, and it is worth understanding why it caught only one of three
cases: a 40% band is wide enough to swallow EUR/USD and CAD/USD entirely. A
sanity flag calibrated for a fast grower's fiscal-year-vs-TTM drift is not a
units check, and should not be relied on as one.

### Exit multiple discipline — where the optimism actually lives

Getting the actuals right removed the arithmetic error and left a judgement
error, which took four attempts to calibrate. Both rules below exist because a
specific wrong number shipped without them:

1. **Ceiling = min(today's trailing P/E, the 5-year median).** The research pass
   returns the range on a machine-readable `PE_RANGE_5Y:` line, because a range
   buried in prose is a range the structuring pass ignores — and did, exiting at
   72.5x against a trailing 69.1x.

   A median-ONLY ceiling was tried and is actively dangerous: a trailing P/E is
   meaningless when the denominator is near zero, and NOW's five-year GAAP range
   came back low 91x / median 164x / high 584x. Handed a 164x ceiling the model
   exited at 154x and produced **+1000%**. `min()` also caps the de-rated case
   (Novo at ~10x against a ~30x history) — that is intended: a base case holding
   the depressed multiple and growing earnings is the honest base case, and the
   re-rating belongs in the bull case, which may exceed base.

2. **Deflate the ceiling by the margin expansion assumed:**
   `ceiling / (tgt_om / today's OM)`. A trailing P/E is high partly BECAUSE
   earnings are depressed; expanding the margin inside terminal EPS counts that
   recovery once in the numerator and again in the multiple. For NOW that turns
   69.5x into ~30x and the base fair value from 402 (+262%) into 207 (+86%).
   Only ever deflates — assuming margin COMPRESSION does not earn a higher
   multiple.

Calibration history, all on the same ticker: **+1038%** (training data) → +212%
→ **+1000%** (the median-only regression) → +328% → +163% → **+77%, no flags**.

### Two Gemini passes

Same shape as the screener — see [DATA_SOURCES.md](DATA_SOURCES.md) for why, and
for the two schema traps (`required` on every field; no unbounded free-text
field). Grounded research is cached 24h under
`valuation-research:v2:TICKER:DATE`; the structuring pass is never cached, so
rule edits take effect on the next generate.

The structuring pass retries once on an incomplete response, naming what was
wrong, rather than discarding a completed grounded search.

### Verifying a change here

Regenerate and read `diagnostics`, not the fair value: `field_sources`,
`split_adjustment`, `fx`, `reconciliation`, `baseline_pe` vs `market_pe`,
`margin_uplift`, `margin_adjusted_ceiling`, `per_scenario`. A good test set,
covering every path:

| Ticker | Exercises |
|---|---|
| `NOW` | split already restated in the 10-K; depressed GAAP margins expanding |
| `MLI` | split AFTER the last 10-K — trap (c) |
| `V` | mature margins, so the margin deflation should barely bite |
| `TSM` | 20-F / `ifrs-full`; TWD filings vs a USD ADR — trap (d), loud |
| `CCJ` | 40-F; CAD filings vs a USD quote — trap (d), quiet enough to pass every flag |
| `NOVO-B` | 20-F / `ifrs-full`, de-rated multiple |
| `DANSKE` | no SEC presence → timeseries-only path |

> `NOVO-B` used to be listed here as the "DKK reporting vs USD quote" case. It
> is not one: the app holds `NOVO-B.CO`, which quotes in DKK, so reporting and
> quote currency agree and the conversion never runs. No ticker in the old test
> set exercised trap (d) at all, which is why it survived to production. If you
> add a case to this table, check what it actually runs, not what it sounds
> like it runs.

Sanity check the direction, not just the absence of errors: as of 2026-08-03
these produce NOW +77%, V +8.2%, MLI −9.2%. A pipeline that returns a large
positive upside for everything is broken even when nothing throws.

For a trap (d) ticker also check that `diagnostics.fx.applied` is `true`, that
`fx.rate` is the right order of magnitude, and that `baseline_pe` now lands near
`market_pe` — before the fix TSM read 1.3x against 36.5x.

## Valuation models are portfolio-agnostic

`valuation_models` is unique on `(ticker, model_date)` — not per portfolio.
`portfolio_id` is stored for audit only. Regenerating twice in one day therefore
UPSERTS the same row rather than creating a second one.

## A hand-edited valuation carries no provenance

`handleSave` in `valuations.js` spreads `...model`, which would carry the
generator's `data_quality`, `flags` and `diagnostics` onto a model a human has
since changed by hand — the banner would then assert filings-backed sources over
edited figures. All three are explicitly nulled on manual save. A NULL
`data_quality` means "a human owns this", which is a different claim from "a
pipeline produced it and these checks passed".
