# CLAUDE.md — InvestTracker

> Canonical agent-context document. Read this before touching any code.
> Supersedes the older `.github/AI_CONTEXT.md` (now a stub).

## Project overview

**InvestTracker** is a personal investment portfolio tracker built and hosted by Peter (labanos@gmail.com).

- Live app: https://tracker.labanos.dk
- GitHub repo: https://github.com/labanos-projects/investtracker (default branch: `master`)
- GitHub access token: stored in your `~/.claude/CLAUDE.md` on your local machine — never commit it here

The app lets a logged-in user manage multiple investment portfolios, track holdings and transactions, view live price charts (Yahoo Finance), maintain a watchlist of candidate symbols, run AI-generated DCF valuation models, and score companies against a multibagger screener.

## Architecture overview

Three independently deployed components:

```
[ Browser ]
    │
    ├─→ GitHub Pages (tracker.labanos.dk)
    │     index.html   ← React SPA shell (no build step, Babel in-browser)
    │     app.js       ← App: state, routing, price/FX fetching
    │     ticker.js    ← TickerPage — the ONE company page (see below)
    │     chart.js     ← StockChart + PortfolioChart components
    │     screener.js  ← ScreenerView + ScoreCard + ScoreBreakdown + ScoreBlock
    │
    ├─→ Cloudflare Worker (yf-proxy.labanos.workers.dev)
    │     Proxies all Yahoo Finance API calls
    │     Runs the AI valuation (filed actuals + grounded Gemini assumptions)
    │     Runs the screener (EDGAR + Yahoo + FMP + grounded Gemini)
    │
    └─→ PHP API (labanos.dk)
          Shared hosting on one.com
          MySQL database (shared with `di` and `fitness_buddy`)
          All CRUD endpoints for portfolios, holdings, transactions, notes, valuations, watchlists, screener
          `sql.php` — admin SQL proxy for Claude (see "Database" below)
```

## Tech stack

| Layer | Technology | Notes |
|---|---|---|
| Frontend | React 18 (UMD CDN) + Babel Standalone | No build step — JSX compiled in-browser |
| Styling | Tailwind CSS (CDN) | |
| Charts | Custom React components in chart.js | StockChart, PortfolioChart |
| Hosting | GitHub Pages | CNAME → tracker.labanos.dk |
| API proxy | Cloudflare Worker (yf-proxy) | ES modules, bundled by wrangler/esbuild |
| Backend | PHP 8 on one.com shared hosting | REST JSON API |
| Database | MySQL on one.com | Shared with `di` and `fitness_buddy`. Credentials injected at deploy time. |
| CI/CD | GitHub Actions | Auto-deploy on push to `master` |
| AI valuation | SEC EDGAR + Yahoo + Gemini 2.5 Flash (search-grounded) | Actuals from filings, assumptions from AI. See "Valuation model" below. |
| Screener | SEC EDGAR + Yahoo + FMP + Gemini (search-grounded) | See "Screener" below |

## Repository structure

```
/
├── CLAUDE.md               # This file — canonical agent context
├── index.html              # React SPA shell — loads every script below, in order
├── constants.js            # API URLs, formatters, CACHED_FX, computePosition
├── components.js           # Shared UI: forms, modals, login, portfolio switcher
├── app.js                  # App — state, view routing, price/FX fetching
├── ticker.js               # TickerPage — the shared company page
├── chart.js                # StockChart + PortfolioChart React components
├── insights.js             # PieChart + InsightsPanel (portfolio allocation)
├── valuations.js           # NewsPanel + ValuationPanel (DCF model UI)
├── watchlist.js            # WatchlistView, WatchlistItemRow, WatchlistAddModal
├── screener.js             # ScreenerView, ScoreCard, ScoreBreakdown, ScoreBlock
├── detail.js               # DEAD — superseded by ticker.js, not loaded by
│                           # index.html. Carries stale copies of PieChart and
│                           # InsightsPanel that would collide with insights.js
│                           # if anything ever loaded both. Delete on sight.
├── CNAME                   # tracker.labanos.dk
├── upload_valuation.py     # CLI script to seed valuation models into the DB
│
├── cloudflare/
│   ├── worker.js           # Router — Yahoo proxy, AI valuation, screener endpoint
│   ├── screener_engine.js  # Rubric + scoring maths (pure, no I/O)
│   ├── screener_data.js    # Per-field fundamentals waterfall (EDGAR/Yahoo/FMP)
│   ├── screener_score.js   # Orchestrator — data + grounded AI → score
│   ├── screener_cache.js   # Two-layer cache (module Map + Cache API)
│   ├── valuation_data.js   # Filed actuals for the DCF (EDGAR/Yahoo) + split
│   │                       # detection + market reconciliation gate
│   ├── valuation_model.js  # DCF orchestrator — grounded research, then
│   │                       # structured assumptions, then sanity flags
│   ├── wrangler.toml       # Wrangler config (worker name: yf-proxy)
│   └── README.md           # Cloudflare Worker endpoint documentation
│
├── php/
│   ├── auth.php            # Login / logout / verify token / first-user setup
│   ├── auth_check.php      # Shared middleware: require_auth($pdo)
│   ├── .htaccess           # Passes Authorization header through Apache CGI
│   ├── db_migrate.php      # Idempotent schema migrations (run on every request)
│   ├── portfolio.php       # Holdings CRUD
│   ├── portfolios.php      # Portfolio CRUD
│   ├── transactions.php    # Buy/sell transaction history
│   ├── notes.php           # Investment notes per ticker
│   ├── meta.php            # Sector/industry/country metadata (static map + FMP)
│   ├── portfolio_history.php # Portfolio value snapshot history
│   ├── valuations.php      # DCF valuation model CRUD
│   ├── watchlists.php      # Watchlist CRUD (named lists, no transactions)
│   ├── watchlist_items.php # Watchlist item CRUD (ticker, target_price, note)
│   ├── screener.php        # Screener result CRUD
│   └── sql.php             # Admin SQL proxy for Claude (Bearer-auth, blocks DDL)
│
└── .github/
    ├── workflows/
    │   ├── deploy-php.yml      # Auto-deploy PHP to labanos.dk on push
    │   └── deploy-worker.yml   # Auto-deploy Cloudflare Worker on push
    └── ISSUE_TEMPLATE/
        ├── bug_report.md
        └── feature_request.md
```

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

### Data sources — resolved per FIELD, never per source

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
| Gemini 2.5 Flash + `google_search` | included | the 6 qualitative criteria only |

EDGAR requires a descriptive `User-Agent` with contact email — that's a
condition of use, not a courtesy.

### Caching (`screener_cache.js`)

Two layers: a module-global `Map` (isolate-local, instant) in front of the
Cache API (`caches.default`, colo-local, survives isolate recycling). Both are
best-effort speedups, never correctness assumptions. TTLs match how often each
upstream actually changes — EDGAR/SEC map 24h, timeseries 6h, FX 12h, Yahoo
summary 15m, grounded AI research 24h.

**Cache keys deliberately exclude** the Yahoo crumb, the timeseries
`period2=now`, and the FMP api key. All three rotate; leaving them in makes
every key unique and the cache useless.

`?refresh=1` bypasses every layer. Keep it — a cached score would have hidden
the XBRL split bug below rather than surfacing it.

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
"SEC XBRL has THREE traps" below — plus the `op_income` tags a DCF needs and the
screener does not.

`field_sources` in diagnostics describes the **baseline year**, not the earliest
year resolved. Recording it during the merge loop reported whichever source
answered the oldest year, so NOW's shares read `yahoo-ts` (only Yahoo had 2019)
while the FY2023-25 figures the model stands on came from EDGAR.

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

Same shape as the screener, for the same reason: `google_search` and
`responseSchema` are mutually exclusive on 2.5. Grounded research (cached 24h,
key `valuation-research:v2:TICKER:DATE`) then ungrounded structuring (never
cached, so rule edits take effect on the next generate).

Two traps found the hard way in the structuring pass:

- **Every schema field must be `required`.** Otherwise any of them may simply be
  absent — NOW returned a bear scenario with no `multiples` at all.
- **No unbounded free-text field, especially not first.** A `thesis: STRING`
  property led the object, Gemini filled it with a ~22,000-character essay,
  exhausted `maxOutputTokens` before emitting a single scenario, and the failure
  surfaced as `Unterminated string in JSON at position 22419` — an error about
  the symptom, three layers from the cause. `finishReason` is now surfaced so
  truncation reports itself as truncation.

The structuring pass retries once on an incomplete response, naming what was
wrong, rather than discarding a completed grounded search.

### Verifying a change here

Regenerate and read `diagnostics`, not the fair value: `field_sources`,
`split_adjustment`, `reconciliation`, `baseline_pe` vs `market_pe`,
`margin_uplift`, `margin_adjusted_ceiling`, `per_scenario`. A good test set,
covering every path:

| Ticker | Exercises |
|---|---|
| `NOW` | split already restated in the 10-K; depressed GAAP margins expanding |
| `MLI` | split AFTER the last 10-K — trap (c) |
| `V` | mature margins, so the margin deflation should barely bite |
| `NOVO-B` | 20-F / `ifrs-full`, DKK reporting vs USD quote, de-rated multiple |
| `DANSKE` | no SEC presence → timeseries-only path |

Sanity check the direction, not just the absence of errors: as of 2026-08-03
these produce NOW +77%, V +8.2%, MLI −9.2%. A pipeline that returns a large
positive upside for everything is broken even when nothing throws.

## Database schema

All tables are MySQL on one.com — **shared across investtracker, di, and fitness_buddy** (one database, all tables together). Schema is created/migrated idempotently by `db_migrate.php` on every PHP request.

### `users` (shared with fitness_buddy)
```sql
id INT AUTO_INCREMENT PK
name VARCHAR(100)
email VARCHAR(200) UNIQUE
password_hash VARCHAR(255)   -- bcrypt ($2y$10$...); NOT recoverable
api_token VARCHAR(64)        -- Bearer; rotated on every login; NULL when logged out
created_at TIMESTAMP
```

### `portfolios`
```sql
id INT AUTO_INCREMENT PK
name VARCHAR(100)
user_id INT                  -- FK to users.id
base_currency VARCHAR(3)     -- e.g. 'DKK', 'USD', 'EUR'
created_at TIMESTAMP
```

### `portfolio` (holdings — one row per ticker per portfolio)
```sql
id INT AUTO_INCREMENT PK
portfolio_id INT
ticker VARCHAR(20)           -- Internal ticker key
yh_ticker VARCHAR(30)        -- Yahoo Finance symbol
company VARCHAR(100)
ccy VARCHAR(10)              -- Stock's native currency
sector VARCHAR(100)
country VARCHAR(100)
shares DECIMAL               -- computed from transactions
avg_cost DECIMAL             -- computed from transactions
UNIQUE KEY (portfolio_id, ticker)
```

### `transactions`
```sql
id INT AUTO_INCREMENT PK
portfolio_id INT
ticker VARCHAR(20)
type ENUM('buy','sell')
shares DECIMAL
price DECIMAL
date DATE
created_at TIMESTAMP
```

### `investment_notes`
```sql
id INT AUTO_INCREMENT PK
portfolio_id INT
ticker VARCHAR(20)
content TEXT
created_at / updated_at TIMESTAMP
```

### `portfolio_snapshots`
```sql
id INT AUTO_INCREMENT PK
portfolio_id INT
snapshot_date DATE
total_value DECIMAL(18,4)
base_ccy VARCHAR(10)
UNIQUE KEY (portfolio_id, snapshot_date, base_ccy)
```

### `watchlists`
```sql
id INT AUTO_INCREMENT PK
name VARCHAR(100)
user_id INT                  -- FK to users.id
base_currency VARCHAR(3)     -- display currency for the watchlist
created_at TIMESTAMP
```

A watchlist is a **portfolio-like list of candidate symbols with no transactions**. Use it to follow potential buys before committing capital. Holdings/transactions/snapshots are NOT created for items on a watchlist.

### `watchlist_items` (one row per ticker per watchlist)
```sql
id INT AUTO_INCREMENT PK
watchlist_id INT
ticker VARCHAR(20)           -- Internal ticker key
yh_ticker VARCHAR(30)        -- Yahoo Finance symbol
company VARCHAR(100)
ccy VARCHAR(10)              -- Stock's native currency
sector VARCHAR(80)           -- nullable
country VARCHAR(80)          -- nullable
target_price DECIMAL(18,6)   -- nullable; entry/buy price target
note TEXT                    -- nullable; short thesis
date_added TIMESTAMP
UNIQUE KEY (watchlist_id, ticker)
```

### `screener_results` (one row per ticker)
```sql
id INT AUTO_INCREMENT PK
ticker VARCHAR(20) UNIQUE
company / sector / industry VARCHAR
score_data JSON              -- full criteria map: score, note, source, confidence
quant_score / quant_max DECIMAL, INT
qual_score  / qual_max  DECIMAL, INT
total_score DECIMAL
max_score INT                -- DYNAMIC — varies with how many criteria had data
pct DECIMAL(5,2)
coverage_pct DECIMAL(5,2)    -- % of rubric weight that had data behind it
sgr DECIMAL(7,2)             -- sustainable growth rate, %
years_to_10x / years_to_100x SMALLINT
mktcap_usd DECIMAL(20,2)     -- FX-normalised
conviction VARCHAR(50)       -- STRONG BUY / WATCH / PASS / INSUFFICIENT DATA
red_flags JSON
sources JSON                 -- grounding citations from the AI pass
diagnostics JSON             -- which providers answered, cache counters, elapsed_ms
scored_at DATE
created_at / updated_at TIMESTAMP
```

### `valuation_models`
```sql
id INT AUTO_INCREMENT PK
portfolio_id INT             -- stored for audit; NOT used as unique key
ticker VARCHAR(20)
model_date DATE
currency VARCHAR(10)
notes TEXT
data_quality VARCHAR(24)     -- ok | warn | blocked | legacy-unverified | NULL (hand-edited)
flags JSON                   -- which sanity checks fired
diagnostics JSON             -- field_sources, split_adjustment, reconciliation,
                             -- baseline_pe vs market_pe, per_scenario, citations
created_at / updated_at TIMESTAMP
UNIQUE KEY (ticker, model_date)
```

### `valuation_actuals` (child of valuation_models)
```sql
id, model_id INT, label ENUM('Y-2','Y-1','Y0'), fiscal_year SMALLINT
revenue, gross_profit, op_income, net_income, shares DECIMAL
```

### `valuation_scenarios` (child of valuation_models)
```sql
id, model_id INT, scenario ENUM('bear','base','bull')
scenario_weight, current_price, rev_growth, tgt_gm, tgt_om, op_conv, shr_chg DECIMAL
proj_years TINYINT, disc_rt, mos DECIMAL
multiples JSON
```

### `valuation_history` (child of valuation_models)
```sql
id, model_id INT, fiscal_year SMALLINT
revenue, gross_profit, op_income, net_income, shares DECIMAL
```

### Tables owned by sibling apps (also visible via `sql.php`)
- `di`: `players`, `tournaments`, `rounds`, `matches`, `match_results`, `roster_assignments`
- `fitness_buddy`: `exercise_illustrations`

## API endpoints

### PHP backend (https://labanos.dk/)

All endpoints return JSON. Write operations require `Authorization: Bearer <user-token>`.

| File | Method | Path / Query | Description |
|---|---|---|---|
| `auth.php` | GET | `?setup_check=1` | Check if first-user setup is needed |
| `auth.php` | GET | (with token) | Verify token → `{id, name, email}` |
| `auth.php` | POST | `?setup=1` | Create first user (one-time) |
| `auth.php` | POST | (login) | `{email, password}` → `{id, name, email, token}` |
| `auth.php` | DELETE | (via POST `?_method=DELETE`) | Logout / invalidate token |
| `portfolios.php` | GET | `?user_id=N` | List portfolios for a user |
| `portfolios.php` | POST | | Create portfolio |
| `portfolios.php` | PUT | `?id=N` | Rename portfolio or change base_currency |
| `portfolios.php` | DELETE | `?id=N` | Delete portfolio |
| `portfolio.php` | GET | `?portfolio_id=N` | List holdings |
| `portfolio.php` | POST | | Add holding |
| `portfolio.php` | POST | `?batch=1&portfolio_id=N` | Bulk seed holdings |
| `portfolio.php` | PUT | `?id=N` | Update holding |
| `portfolio.php` | DELETE | `?id=N` | Remove holding |
| `transactions.php` | GET | `?portfolio_id=N&ticker=X` | List transactions |
| `transactions.php` | POST | | Add transaction |
| `transactions.php` | DELETE | `?id=N` | Delete transaction |
| `notes.php` | GET | `?portfolio_id=N&ticker=X` | Get notes |
| `notes.php` | POST | | Save note |
| `notes.php` | DELETE | `?id=N` | Delete note |
| `meta.php` | GET | `?ticker=X` | Get `{sector, industry, country}` |
| `portfolio_history.php` | GET | `?portfolio_id=N` | Get snapshot history |
| `portfolio_history.php` | POST | | Save snapshot |
| `valuations.php` | GET | `?ticker=X` | Get latest DCF model |
| `valuations.php` | POST | | Upsert full DCF model |
| `valuations.php` | DELETE | `?id=N` | Delete model and child records |
| `watchlists.php` | GET | | List all watchlists |
| `watchlists.php` | POST | | Create watchlist `{name, base_currency?}` |
| `watchlists.php` | PUT | `?id=N` | Rename or change base_currency |
| `watchlists.php` | DELETE | `?id=N` | Delete (only if no items remain) |
| `watchlist_items.php` | GET | `?watchlist_id=N` | List items on a watchlist |
| `watchlist_items.php` | POST | | Add item |
| `watchlist_items.php` | POST | `?batch=1&watchlist_id=N` | Bulk seed items |
| `watchlist_items.php` | PUT | `?id=N` | Update fields |
| `watchlist_items.php` | DELETE | `?id=N` | Remove item |
| `screener.php` | GET | | List all screener results |
| `screener.php` | GET | `?ticker=X` | Full result incl. `score_data` |
| `screener.php` | POST | | Upsert (called by the Worker after scoring) |
| `screener.php` | DELETE | `?ticker=X` | Delete a result |
| **`sql.php`** | **POST** | (Bearer `CLAUDE_SQL_TOKEN`) | **Claude's admin SQL proxy — see Database section** |

### Cloudflare Worker (https://yf-proxy.labanos.workers.dev/)

| Query Param | Description |
|---|---|
| `?symbols=AAPL,NVDA,NOVO-B.CO` | Batch real-time prices |
| `?quote=NVDA` | Full ticker snapshot for the ticker page: price, chgPct, currency, company, sector, industry, market cap, P/E |
| `?chart=AAPL&range=1y` | Historical chart data |
| `?search=novo nordisk` | Ticker autocomplete |
| `?news=AAPL` | Latest news headlines |
| `?generate_valuation=AAPL&portfolio_id=1[&current_price=...][&refresh=1]` | AI DCF valuation (Bearer-auth). Actuals from filings, assumptions from grounded Gemini. 422 = inputs failed the reconciliation gate and nothing was saved. |
| `?score_ticker=NVDA[&refresh=1]` | Screener score (Bearer-auth). `refresh=1` bypasses all caches. |

Chart ranges: `1d`, `5d`, `1mo`, `3mo`, `6mo`, `1y`, `2y`, `5y`, `max`.

## Deployment

Everything deploys automatically on push to `master`.

### `deploy-php.yml`
Triggered when any tracked `php/*.php` file changes:
1. Substitutes `%%DB_HOST%%`, `%%DB_NAME%%`, `%%DB_USER%%`, `%%DB_PASS%%`, `%%CLAUDE_SQL_TOKEN%%` from GitHub Secrets
2. SFTPs the processed files to labanos.dk web root

### `deploy-worker.yml`
Triggered on **any change under `cloudflare/**`**:
1. `wrangler-action@v3` deploys to Cloudflare
2. Injects `GEMINI_API_KEY` and `FMP_API_KEY` as Worker secrets

> **Do not narrow this back to individual filenames.** It used to list
> `cloudflare/worker.js` and `cloudflare/wrangler.toml` explicitly. When the
> screener was split into `screener_*.js` modules, those files were not deploy
> triggers — two fix commits landed on `master` and silently never shipped,
> while the Worker kept serving old code and the repo said otherwise.
> If you add a file under `cloudflare/`, the glob already covers it.

A worker deploy takes roughly 1.5–2 minutes end to end (checkout, wrangler,
propagation). Testing sooner than that silently exercises the OLD code — which
reads exactly like the fix not working.

### Frontend
All frontend files (`index.html` and every `*.js` at the repo root) are served
directly from GitHub Pages — no build step. Adding a new `.js` file means adding
a `<script type="text/babel" src="...">` tag to `index.html`; nothing else picks
it up.

### GitHub Secrets required

| Secret | Used by |
|---|---|
| `DB_HOST` | PHP deploy |
| `DB_NAME` | PHP deploy |
| `DB_USER` | PHP deploy |
| `DB_PASS` | PHP deploy |
| `SFTP_HOST` | PHP deploy |
| `SFTP_PORT` | PHP deploy |
| `SFTP_USER` | PHP deploy |
| `SFTP_PASS` | PHP deploy |
| `CLAUDE_SQL_TOKEN` | PHP deploy (the `sql.php` Bearer token) |
| `CLOUDFLARE_API_TOKEN` | Worker deploy |
| `GEMINI_API_KEY` | Worker runtime |
| `FMP_API_KEY` | Worker runtime |

## Database — how I (Claude) work with it

For ad-hoc queries I POST to `https://labanos.dk/sql.php` with `Authorization: Bearer <CLAUDE_SQL_TOKEN>` and a JSON body:

```json
{ "sql": "SELECT id, name FROM portfolios WHERE user_id = ?", "params": [1] }
```

- The token lives in **your local `~/.claude/CLAUDE.md`**, never in this repo.
- The endpoint **refuses** statements containing `DROP`, `TRUNCATE`, `ALTER`, `GRANT`, `REVOKE`, `CREATE USER`, `DROP USER` (DDL/privilege changes go through `db_migrate.php` and a PR).
- The endpoint **logs every query** to PHP's error log (one.com server-side, not git-tracked) for audit.

### Safety rule (I follow this every session)
- `SELECT` / `SHOW` / `DESCRIBE` / `EXPLAIN` — I run them freely.
- `INSERT` / `UPDATE` / `DELETE` — I first show you the matching rows (a `SELECT … WHERE …` preview) and the exact write statement, and wait for your explicit "yes" in chat before executing.
- `DROP` / `ALTER` / `TRUNCATE` / `GRANT` — endpoint blocks these. Schema changes go in `php/db_migrate.php` and ship through a PR.

### Migrations can only be triggered by a real PHP request
`run_migrations()` runs on every PHP request, so a schema change ships as soon
as *any* endpoint is hit. Note that `labanos.dk/*.php` appears to filter
non-browser clients — automated fetches return an empty body — so the
practical way to apply a migration is to load the app in a browser once.

## Key technical decisions & gotchas

### Yahoo Finance is proxied via Cloudflare Worker
one.com's shared hosting IP is blocked by Yahoo Finance. All YF API calls must go through the Worker.

### Yahoo `quoteSummary` — crumb handshake works; statement modules do not
**Corrected 2026-07.** This file previously said quoteSummary "requires browser
session cookies — not feasible from serverless". That is **false**. The
documented handshake works fine from the Worker:

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

### SEC XBRL has THREE traps that silently produce wrong numbers
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

### Gemini: search grounding and structured output are mutually exclusive on 2.5
`tools: [{google_search: {}}]` with `responseMimeType: 'application/json'`
fails: *"controlled generation is not supported with google_search tool"*. The
screener therefore does a **grounded research pass** (prose + citations) then
an **ungrounded structuring pass** (strict `responseSchema`). Gemini 3 models
allow both in one call — see `MODEL` in `screener_score.js`.

### `chgPct` is a fraction on the frontend, a percentage from `?symbols=`
`?symbols=` returns `regularMarketChangePercent` as a percentage (1.34) and
`app.js` divides by 100 on arrival, because `pct()` in `constants.js` multiplies
by 100. `?quote=` therefore returns `chgPct` **already as a fraction** (0.0134)
— it is consumed directly, with no division. Getting this wrong is a silent
100× error in the "Today" figure, not a crash.

### Yahoo Finance timestamps are in Unix seconds
Normalize: `t < 1e12 ? t * 1000 : t`. Both `StockChart` and `PortfolioChart` apply this fix.

### Apache strips Authorization header on shared hosting
`auth_check.php` uses a 3-fallback approach: `HTTP_AUTHORIZATION` → `REDIRECT_HTTP_AUTHORIZATION` → `getallheaders()`. `.htaccess` also adds `SetEnvIf Authorization "(.*)" HTTP_AUTHORIZATION=$1`. New PHP endpoints doing auth must use `require_auth($pdo)` from `auth_check.php` (or, for `sql.php`, the dedicated `CLAUDE_SQL_TOKEN` check).

### `api_token` rotates on every login
`auth.php` issues a fresh token each time you sign in, so a browser tab left
open while you log in elsewhere holds a stale token. The Worker verifies the
token BEFORE doing ~30s of work and returns "Session expired — please sign in
again"; reload the page. This looks like a bug and is not one.

### Sector/industry/country metadata
`meta.php` uses a static ticker map with FMP fallback. (The screener gets
sector/industry from Yahoo's `assetProfile` module instead, which does work.)

### Method override for DELETE/PUT
PHP on Apache shared hosting sometimes has issues with `DELETE`/`PUT`. Endpoints support `POST?_method=DELETE` and `POST?_method=PUT`.

### DB migrations are idempotent
`db_migrate.php` runs on every PHP request and checks `INFORMATION_SCHEMA` before altering. Adding new migrations means appending to this file. `valuations.php` additionally bootstraps its own tables and columns inline, in the same idempotent style.

### Watchlists vs portfolios
A `watchlist` is a list of candidate symbols you're *thinking* about; a `portfolio` is what you actually own. Watchlists have no transactions, no snapshots, no holdings — just `{ticker, target_price, note}` rows. They share the user-scoped naming model (`watchlists.user_id`, `watchlists.base_currency`) so the frontend can render them the same way as portfolios.

### Valuation models are portfolio-agnostic
`valuation_models` is unique on `(ticker, model_date)` — not per portfolio. `portfolio_id` is stored for audit only. Regenerating twice in one day therefore UPSERTS the same row rather than creating a second one.

### A hand-edited valuation carries no provenance
`handleSave` in `valuations.js` spreads `...model`, which would carry the
generator's `data_quality`, `flags` and `diagnostics` onto a model a human has
since changed by hand — the banner would then assert filings-backed sources over
edited figures. All three are explicitly nulled on manual save. A NULL
`data_quality` means "a human owns this", which is a different claim from "a
pipeline produced it and these checks passed".

### Portfolio history chart reconstructs from transactions
`PortfolioChart` does NOT use `portfolio_snapshots` for chart data — it reconstructs share counts from transaction history and fetches historical prices via the Worker.

### FX conversion
Portfolio FX rates are applied client-side: `fxToBase = fx[stockCcy] / fx[baseCcy]`, with rates hardcoded as `CACHED_FX` in `index.html` (tracked in GitHub Issues as a future improvement). The **screener** does not use `CACHED_FX` — it fetches live ECB rates from Frankfurter server-side, because market-cap thresholds are in USD and Novo reports in DKK.

### Auth token lifecycle
- 32-byte random hex; rotated on every login
- Stored in `localStorage` as `auth_token`
- NULL'd in DB on logout
- Cleared from `localStorage` on any 401 (stale token handling)
- `users.password_hash` is bcrypt — **not recoverable**. To act as the user
  against an authed endpoint, read `api_token` (or `localStorage.auth_token`).

## Backlog

Tracked entirely in **GitHub Issues**: https://github.com/labanos-projects/investtracker/issues

> `TODO.md` is no longer used. Do not update it. All feature requests and bugs live in GitHub Issues.

At the start of each session, fetch the current open issues via the GitHub MCP tool to get the up-to-date backlog.

## Development workflow for me (Claude)

### Starting a session from a GitHub issue
1. **Read this file first** before writing any code.
2. **Fetch the issue** via the GitHub MCP tool (or `WebFetch`) for the full title, description, and checklist.
3. **Check open Issues** for related backlog context.
4. **Identify which component(s)** are involved: frontend (`index.html` / `chart.js` / `screener.js`), PHP backend (`php/`), or Cloudflare Worker (`cloudflare/`).

### GitHub access — MCP first
When the GitHub MCP is available, use it directly — no cloning needed:
- Read: `get_file_contents`
- Write: `create_or_update_file` (always include the current `sha`)
- Issues: `list_issues` / `get_issue`

Only fall back to `git clone` if the MCP is unavailable. In that case, use the PAT from `~/.claude/CLAUDE.md`. **Never commit a token** — GitHub push protection blocks it and the token becomes compromised.

**The MCP cannot delete files.** `create_or_update_file` and `push_files` both
require `content` as a string; there is no delete tool and no `sha: null` escape
hatch. A change that removes a file therefore cannot ship through the MCP alone —
it needs real git credentials, or the file has to be removed by hand in the web
UI. Plan for this *before* building a branch that deletes something.

**Whole-file writes are the only option**, so an MCP edit means re-sending the
entire file. Verify afterwards with `git hash-object <file>` against the `sha`
the API returns — they are both git blob SHA-1, so a match proves the content is
byte-identical and a mistyped file cannot ship silently.

### Verify against production, not against the diff
The four screener bugs fixed in v11/v12 all looked correct in review. Three of
them produced confident wrong numbers, and one meant the code never shipped at
all. After deploying, actually score a ticker and read `diagnostics` —
`edgar_ok`, `ts_ok`, `fcf_source`, `eps_source`, `cache`, `elapsed_ms` exist
precisely so a wrong result can be explained instead of guessed at. Use
`?refresh=1` so you are testing live data rather than a cache hit.

Good test set, covering every path in one pass:

| Ticker | Exercises |
|---|---|
| `NVDA` | US 10-K, stock splits, huge growth |
| `ADBE` | US 10-K, buybacks, no dividend |
| `NOVO-B.CO` | 20-F + `ifrs-full` tags, CIK-by-name, DKK→USD |
| `DANSKE.CO` | No SEC presence at all → timeseries-only path |
| `KO` | High payout → the low-SGR / long-years-to-10× case |

### Step-by-step for a typical feature
1. Read this `CLAUDE.md` via MCP
2. Fetch the relevant Issue
3. Implement via MCP file edits
4. For PHP changes: keep `%%placeholder%%` credentials — never fill them in
5. For DB schema: append an idempotent migration to `php/db_migrate.php`
6. For new write endpoints: use `require_auth($pdo)` from `auth_check.php`
7. Commit with a message referencing the issue (e.g. `fix: ... closes #N`)
8. GitHub Actions deploys automatically within ~30 seconds
9. **Verify live** (see above) before calling it done

### Never expose real credentials
DB credentials only exist in GitHub Secrets. PHP files in the repo use `%%placeholder%%` strings substituted at deploy time. Never fill them in, log them, or include them in any file.
