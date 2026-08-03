# PHP backend and database

> Part of the InvestTracker agent context. Start at [CLAUDE.md](../CLAUDE.md).
> **Read this when:** changing anything under `php/`, the schema, or auth.

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

## PHP gotchas

### Apache strips Authorization header on shared hosting

`auth_check.php` uses a 3-fallback approach: `HTTP_AUTHORIZATION` → `REDIRECT_HTTP_AUTHORIZATION` → `getallheaders()`. `.htaccess` also adds `SetEnvIf Authorization "(.*)" HTTP_AUTHORIZATION=$1`. New PHP endpoints doing auth must use `require_auth($pdo)` from `auth_check.php` (or, for `sql.php`, the dedicated `CLAUDE_SQL_TOKEN` check).

### `api_token` rotates on every login

`auth.php` issues a fresh token each time you sign in, so a browser tab left
open while you log in elsewhere holds a stale token. The Worker verifies the
token BEFORE doing ~30s of work and returns "Session expired — please sign in
again"; reload the page. This looks like a bug and is not one.

### Auth token lifecycle

- 32-byte random hex; rotated on every login
- Stored in `localStorage` as `auth_token`
- NULL'd in DB on logout
- Cleared from `localStorage` on any 401 (stale token handling)
- `users.password_hash` is bcrypt — **not recoverable**. To act as the user
  against an authed endpoint, read `api_token` (or `localStorage.auth_token`).

### Method override for DELETE/PUT

PHP on Apache shared hosting sometimes has issues with `DELETE`/`PUT`. Endpoints support `POST?_method=DELETE` and `POST?_method=PUT`.

### DB migrations are idempotent

`db_migrate.php` runs on every PHP request and checks `INFORMATION_SCHEMA` before altering. Adding new migrations means appending to this file. `valuations.php` additionally bootstraps its own tables and columns inline, in the same idempotent style.

### Sector/industry/country metadata

`meta.php` uses a static ticker map with FMP fallback. (The screener gets
sector/industry from Yahoo's `assetProfile` module instead, which does work.)

### Watchlists vs portfolios

A `watchlist` is a list of candidate symbols you're *thinking* about; a `portfolio` is what you actually own. Watchlists have no transactions, no snapshots, no holdings — just `{ticker, target_price, note}` rows. They share the user-scoped naming model (`watchlists.user_id`, `watchlists.base_currency`) so the frontend can render them the same way as portfolios.
