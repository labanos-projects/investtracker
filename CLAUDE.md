# CLAUDE.md — InvestTracker

> Canonical agent-context document. Read this before touching any code.
> Supersedes the older `.github/AI_CONTEXT.md` (now a stub).

## Project overview

**InvestTracker** is a personal investment portfolio tracker built and hosted by Peter (labanos@gmail.com).

- Live app: https://tracker.labanos.dk
- GitHub repo: https://github.com/labanos-projects/investtracker (default branch: `master`)
- GitHub access token: stored in your `~/.claude/CLAUDE.md` on your local machine — never commit it here

The app lets a logged-in user manage multiple investment portfolios, track holdings and transactions, view live price charts (Yahoo Finance), maintain a watchlist of candidate symbols, and run AI-generated DCF valuation models.

## Architecture overview

Three independently deployed components:

```
[ Browser ]
    │
    ├─→ GitHub Pages (tracker.labanos.dk)
    │     index.html  ← React SPA (no build step, Babel in-browser)
    │     chart.js    ← StockChart + PortfolioChart components
    │
    ├─→ Cloudflare Worker (yf-proxy.labanos.workers.dev)
    │     Proxies all Yahoo Finance API calls
    │     Runs AI valuation via FMP + Gemini 2.5 Flash
    │
    └─→ PHP API (labanos.dk)
          Shared hosting on one.com
          MySQL database (shared with `di` and `fitness_buddy`)
          All CRUD endpoints for portfolios, holdings, transactions, notes, valuations, watchlists
          `sql.php` — admin SQL proxy for Claude (see "Database" below)
```

## Tech stack

| Layer | Technology | Notes |
|---|---|---|
| Frontend | React 18 (UMD CDN) + Babel Standalone | No build step — JSX compiled in-browser |
| Styling | Tailwind CSS (CDN) | |
| Charts | Custom React components in chart.js | StockChart, PortfolioChart |
| Hosting | GitHub Pages | CNAME → tracker.labanos.dk |
| API proxy | Cloudflare Worker (yf-proxy) | Proxies Yahoo Finance; runs Gemini AI |
| Backend | PHP 8 on one.com shared hosting | REST JSON API |
| Database | MySQL on one.com | Shared with `di` and `fitness_buddy`. Credentials injected at deploy time. |
| CI/CD | GitHub Actions | Auto-deploy on push to `master` |
| AI valuation | Gemini 2.5 Flash + FMP | Triggered from Cloudflare Worker |

## Repository structure

```
/
├── CLAUDE.md               # This file — canonical agent context
├── index.html              # React SPA entry point
├── chart.js                # StockChart + PortfolioChart React components
├── CNAME                   # tracker.labanos.dk
├── upload_valuation.py     # CLI script to seed valuation models into the DB
│
├── cloudflare/
│   ├── worker.js           # Cloudflare Worker — Yahoo Finance proxy + AI valuation
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

## Database schema

All tables are MySQL on one.com — **shared across investtracker, di, and fitness_buddy** (one database, all tables together). Schema is created/migrated idempotently by `db_migrate.php` on every PHP request.

### `users` (shared with fitness_buddy)
```sql
id INT AUTO_INCREMENT PK
name VARCHAR(100)
email VARCHAR(200) UNIQUE
password_hash VARCHAR(255)
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

### `valuation_models`
```sql
id INT AUTO_INCREMENT PK
portfolio_id INT             -- stored for audit; NOT used as unique key
ticker VARCHAR(20)
model_date DATE
currency VARCHAR(10)
notes TEXT
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
| `watchlist_items.php` | POST | | Add item `{watchlist_id, ticker, company, ccy, target_price?, note?, ...}` |
| `watchlist_items.php` | POST | `?batch=1&watchlist_id=N` | Bulk seed items |
| `watchlist_items.php` | PUT | `?id=N` | Update fields (target_price, note, ticker meta) |
| `watchlist_items.php` | DELETE | `?id=N` | Remove item |
| **`sql.php`** | **POST** | (Bearer `CLAUDE_SQL_TOKEN`) | **Claude's admin SQL proxy — see Database section** |

### Cloudflare Worker (https://yf-proxy.labanos.workers.dev/)

| Query Param | Description |
|---|---|
| `?symbols=AAPL,NVDA,NOVO-B.CO` | Batch real-time prices |
| `?chart=AAPL&range=1y` | Historical chart data |
| `?search=novo nordisk` | Ticker autocomplete |
| `?news=AAPL` | Latest news headlines |
| `?generate_valuation=AAPL&portfolio_id=1&current_price=...` | AI DCF valuation (Bearer-auth) |

Chart ranges: `1d`, `5d`, `1mo`, `3mo`, `6mo`, `1y`, `2y`, `5y`, `max`.

## Deployment

Everything deploys automatically on push to `master`.

### `deploy-php.yml`
Triggered when any tracked `php/*.php` file changes:
1. Substitutes `%%DB_HOST%%`, `%%DB_NAME%%`, `%%DB_USER%%`, `%%DB_PASS%%`, `%%CLAUDE_SQL_TOKEN%%` from GitHub Secrets
2. SFTPs the processed files to labanos.dk web root

### `deploy-worker.yml`
Triggered when `cloudflare/worker.js` or `cloudflare/wrangler.toml` changes:
1. `wrangler-action@v3` deploys to Cloudflare
2. Injects `GEMINI_API_KEY` and `FMP_API_KEY` as Worker secrets

### Frontend
`index.html` and `chart.js` are served directly from GitHub Pages — no build step.

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

## Key technical decisions & gotchas

### PHP credential placeholders
PHP files contain `%%DB_HOST%%`, `%%DB_NAME%%`, `%%DB_USER%%`, `%%DB_PASS%%`, `%%CLAUDE_SQL_TOKEN%%` placeholder strings. These are **never real credentials** — GitHub Actions injects the real values at deploy time via `sed`. Never hardcode real credentials in these files.

### Yahoo Finance is proxied via Cloudflare Worker
one.com's shared hosting IP is blocked by Yahoo Finance. All YF API calls must go through the Worker.

### Yahoo Finance timestamps are in Unix seconds
Normalize: `t < 1e12 ? t * 1000 : t`. Both `StockChart` and `PortfolioChart` apply this fix.

### Apache strips Authorization header on shared hosting
`auth_check.php` uses a 3-fallback approach: `HTTP_AUTHORIZATION` → `REDIRECT_HTTP_AUTHORIZATION` → `getallheaders()`. `.htaccess` also adds `SetEnvIf Authorization "(.*)" HTTP_AUTHORIZATION=$1`. New PHP endpoints doing auth must use `require_auth($pdo)` from `auth_check.php` (or, for `sql.php`, the dedicated `CLAUDE_SQL_TOKEN` check).

### Sector/industry/country metadata
Yahoo Finance's `quoteSummary` requires browser session cookies — not feasible from serverless. `meta.php` uses a static ticker map with FMP fallback.

### Method override for DELETE/PUT
PHP on Apache shared hosting sometimes has issues with `DELETE`/`PUT`. Endpoints support `POST?_method=DELETE` and `POST?_method=PUT`.

### DB migrations are idempotent
`db_migrate.php` runs on every PHP request and checks `INFORMATION_SCHEMA` before altering. Adding new migrations means appending to this file.

### Watchlists vs portfolios
A `watchlist` is a list of candidate symbols you're *thinking* about; a `portfolio` is what you actually own. Watchlists have no transactions, no snapshots, no holdings — just `{ticker, target_price, note}` rows. They share the user-scoped naming model (`watchlists.user_id`, `watchlists.base_currency`) so the frontend can render them the same way as portfolios.

### Valuation models are portfolio-agnostic
`valuation_models` is unique on `(ticker, model_date)` — not per portfolio. `portfolio_id` is stored for audit only.

### Portfolio history chart reconstructs from transactions
`PortfolioChart` does NOT use `portfolio_snapshots` for chart data — it reconstructs share counts from transaction history and fetches historical prices via the Worker.

### FX conversion
FX rates are applied client-side: `fxToBase = fx[stockCcy] / fx[baseCcy]`. Rates are hardcoded as `CACHED_FX` in `index.html` (tracked in GitHub Issues as a future improvement).

### Auth token lifecycle
- 32-byte random hex; rotated on every login
- Stored in `localStorage` as `auth_token`
- NULL'd in DB on logout
- Cleared from `localStorage` on any 401 (stale token handling)

## Backlog

Tracked entirely in **GitHub Issues**: https://github.com/labanos-projects/investtracker/issues

> `TODO.md` is no longer used. Do not update it. All feature requests and bugs live in GitHub Issues.

At the start of each session, fetch the current open issues via the GitHub MCP tool to get the up-to-date backlog.

## Development workflow for me (Claude)

### Starting a session from a GitHub issue
1. **Read this file first** before writing any code.
2. **Fetch the issue** via the GitHub MCP tool (or `WebFetch`) for the full title, description, and checklist.
3. **Check open Issues** for related backlog context.
4. **Identify which component(s)** are involved: frontend (`index.html` / `chart.js`), PHP backend (`php/`), or Cloudflare Worker (`cloudflare/worker.js`).

### GitHub access — MCP first
When the GitHub MCP is available, use it directly — no cloning needed:
- Read: `get_file_contents`
- Write: `create_or_update_file` (always include the current `sha`)
- Issues: `list_issues` / `get_issue`

Only fall back to `git clone` if the MCP is unavailable. In that case, use the PAT from `~/.claude/CLAUDE.md`. **Never commit a token** — GitHub push protection blocks it and the token becomes compromised.

### Step-by-step for a typical feature
1. Read this `CLAUDE.md` via MCP
2. Fetch the relevant Issue
3. Implement via MCP file edits
4. For PHP changes: keep `%%placeholder%%` credentials — never fill them in
5. For DB schema: append an idempotent migration to `php/db_migrate.php`
6. For new write endpoints: use `require_auth($pdo)` from `auth_check.php`
7. Commit with a message referencing the issue (e.g. `fix: ... closes #N`)
8. GitHub Actions deploys automatically within ~30 seconds

### Never expose real credentials
DB credentials only exist in GitHub Secrets. PHP files in the repo use `%%placeholder%%` strings substituted at deploy time. Never fill them in, log them, or include them in any file.
