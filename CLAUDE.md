# CLAUDE.md — InvestTracker

> Canonical agent-context index. Read this first, then the one or two topic docs
> your change actually touches (see "Where to read next").
> Supersedes the older `.github/AI_CONTEXT.md` (now a stub).

## Project overview

**InvestTracker** is a personal investment portfolio tracker built and hosted by Peter (labanos@gmail.com).

- Live app: https://tracker.labanos.dk
- GitHub repo: https://github.com/labanos-projects/investtracker (default branch: `master`)
- GitHub access token: stored in your `~/.claude/CLAUDE.md` on your local machine — never commit it here

The app lets a logged-in user manage multiple investment portfolios, track holdings and transactions, view live price charts (Yahoo Finance), maintain a watchlist of candidate symbols, run AI-generated DCF valuation models, and score companies against a multibagger screener.

## Where to read next

This file is the index: overview, layout, deployment, and how I work. Everything
else is split by the kind of change you are making, so a frontend tweak does not
require reading the XBRL parser and vice versa.

| Changing... | Read |
|---|---|
| Any `*.js` at the repo root, `index.html` | [docs/FRONTEND.md](docs/FRONTEND.md) |
| `php/**`, the schema, auth | [docs/BACKEND.md](docs/BACKEND.md) |
| `cloudflare/screener_*.js` | [docs/SCREENER.md](docs/SCREENER.md) |
| `cloudflare/valuation_*.js` | [docs/VALUATION.md](docs/VALUATION.md) |
| Anything that fetches fundamentals (EDGAR, Yahoo, Gemini, caching) | [docs/DATA_SOURCES.md](docs/DATA_SOURCES.md) |
| Adding or calling an endpoint | [docs/API.md](docs/API.md) |

**Read [docs/DATA_SOURCES.md](docs/DATA_SOURCES.md) before editing either
engine's data layer.** The screener and the valuation model both resolve
fundamentals per-field from EDGAR and Yahoo, and both carry the same XBRL traps.
Every one of those traps produced plausible, confident, wrong output in
production without throwing — which is the only reason they are written down at
all.

## Architecture overview

Three independently deployed components:

```
[ Browser ]
    │
    ├─→ GitHub Pages (tracker.labanos.dk)
    │     index.html   ← React SPA shell (no build step, Babel in-browser)
    │     app.js       ← App: state, routing, price/FX fetching
    │     ticker.js    ← TickerPage — the ONE company page
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
          `sql.php` — admin SQL proxy for Claude
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
| AI valuation | SEC EDGAR + Yahoo + Gemini 2.5 Flash (search-grounded) | Actuals from filings, assumptions from AI |
| Screener | SEC EDGAR + Yahoo + FMP + Gemini (search-grounded) | |

## Repository structure

```
/
├── CLAUDE.md               # This file — index; overview, layout, deploy, workflow
├── docs/
│   ├── FRONTEND.md         # SPA conventions, ticker page, display traps
│   ├── BACKEND.md          # PHP endpoints, DB schema, auth, migrations
│   ├── DATA_SOURCES.md     # EDGAR/Yahoo waterfall, XBRL traps, caching, Gemini
│   ├── SCREENER.md         # Multibagger rubric and scoring
│   ├── VALUATION.md        # DCF: filed actuals + grounded assumptions
│   └── API.md              # PHP + Worker endpoint reference
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

## Backlog

Tracked entirely in **GitHub Issues**: https://github.com/labanos-projects/investtracker/issues

> `TODO.md` is no longer used. Do not update it. All feature requests and bugs live in GitHub Issues.

At the start of each session, fetch the current open issues via the GitHub MCP tool to get the up-to-date backlog.

## Development workflow for me (Claude)

### Starting a session from a GitHub issue
1. **Read this file first**, then the topic doc(s) your change touches.
2. **Fetch the issue** via the GitHub MCP tool (or `WebFetch`) for the full title, description, and checklist.
3. **Check open Issues** for related backlog context.
4. **Identify which component(s)** are involved: frontend (root `*.js`), PHP backend (`php/`), or Cloudflare Worker (`cloudflare/`).

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
all. After deploying, actually exercise the endpoint and read `diagnostics` — it
exists precisely so a wrong result can be explained instead of guessed at. Use
`?refresh=1` so you are testing live data rather than a cache hit.

Each engine doc carries its own test set and, for the valuation model, the
expected DIRECTION of the answer. Absence of errors is not evidence of
correctness: the valuation engine returned a large positive upside for every
company for five months without once throwing.

### Step-by-step for a typical feature
1. Read this `CLAUDE.md`, then the relevant `docs/*.md`
2. Fetch the relevant Issue
3. Implement via MCP file edits
4. For PHP changes: keep `%%placeholder%%` credentials — never fill them in
5. For DB schema: append an idempotent migration to `php/db_migrate.php`
6. For new write endpoints: use `require_auth($pdo)` from `auth_check.php`
7. Commit with a message referencing the issue (e.g. `fix: ... closes #N`)
8. GitHub Actions deploys automatically (worker: ~1.5–2 min, see Deployment)
9. **Verify live** (see above) before calling it done

### Never expose real credentials
DB credentials only exist in GitHub Secrets. PHP files in the repo use `%%placeholder%%` strings substituted at deploy time. Never fill them in, log them, or include them in any file.
