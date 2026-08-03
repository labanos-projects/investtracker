# Frontend

> Part of the InvestTracker agent context. Start at [CLAUDE.md](../CLAUDE.md).
> **Read this when:** changing any `*.js` at the repo root, or `index.html`.
>
> No build step: JSX is compiled in-browser by Babel Standalone and every
> root `*.js` shares one global scope via `<script>` tags. Adding a file means
> adding a `<script type="text/babel" src="...">` tag to `index.html`.

## The shared ticker page (`ticker.js`)

There is exactly **one** company page, `TickerPage`, and Holdings, Watchlist and
Screener all open it. Before this, the rich view (chart, news, valuation, notes)
existed only for tickers you already owned and the screener had a parallel
score-only page — so the research view was unavailable precisely when you were
researching, i.e. before buying.

Sections render on what **exists** for the ticker, not on which tab you arrived
from:

| Condition | Section |
|---|---|
| `position` present | position stats, transactions, remove-holding |
| screener result exists | score block (otherwise an offer to score) |
| always | quote header, chart, valuation model, news, notes |

### One route, three origins

App holds a single `tickerCtx`. `origin` (`portfolio` / `watchlist` /
`screener`) *only* sets the back-button label, so you return to the tab you came
from. Every caller goes through `openTicker(ctx)`.

### Ticker identity: two symbols for one company

Holdings key on the **internal** ticker (`NOVO-B`); the screener and Yahoo key
on the **exchange** symbol (`NOVO-B.CO`). App matches a `tickerCtx` against
holdings on ticker, yhTicker, *and* suffix-stripped yhTicker — matching on only
one showed "not held" for companies actually in the portfolio. When a holding
does match, the **holding's** identifiers win, so notes and valuations resolve
to the keys the portfolio view has always used.

### Notes and valuations are ticker-scoped, not portfolio-scoped

`notes.php` GET filters on ticker alone (`?portfolio_id=` is accepted and
ignored, so old clients keep working), and POST accepts `portfolio_id: 0`. A
note written from the screener on a company you don't own yet must still be
there when it later becomes a holding. `valuation_models` already worked this
way — unique on `(ticker, model_date)`, `portfolio_id` for audit only.

## Display traps

### `chgPct` is a fraction on the frontend, a percentage from `?symbols=`

`?symbols=` returns `regularMarketChangePercent` as a percentage (1.34) and
`app.js` divides by 100 on arrival, because `pct()` in `constants.js` multiplies
by 100. `?quote=` therefore returns `chgPct` **already as a fraction** (0.0134)
— it is consumed directly, with no division. Getting this wrong is a silent
100× error in the "Today" figure, not a crash.

### Yahoo Finance timestamps are in Unix seconds

Normalize: `t < 1e12 ? t * 1000 : t`. Both `StockChart` and `PortfolioChart` apply this fix.

### Portfolio history chart reconstructs from transactions

`PortfolioChart` does NOT use `portfolio_snapshots` for chart data — it reconstructs share counts from transaction history and fetches historical prices via the Worker.

### FX conversion

Portfolio FX rates are applied client-side: `fxToBase = fx[stockCcy] / fx[baseCcy]`, with rates hardcoded as `CACHED_FX` in `index.html` (tracked in GitHub Issues as a future improvement). The **screener** does not use `CACHED_FX` — it fetches live ECB rates from Frankfurter server-side, because market-cap thresholds are in USD and Novo reports in DKK.

### The valuation projection maths is mirrored server-side

`projectScenario` / `calcScenarioFV` in `valuations.js` are duplicated in
`cloudflare/valuation_model.js`, which runs the same projection BEFORE saving so
it can flag an implausible result. Change one and you must change the other — a
divergence shows up as a model the sanity gate approved and this panel then
renders differently.
