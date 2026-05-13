# CLAUDE.md — investtracker

Personal investment tracker. Static HTML/JS frontend hosted on GitHub Pages with
a custom domain (`CNAME`), backed by PHP endpoints on `labanos.dk` that talk to a
shared MySQL database. Also includes a Python uploader for end-of-day valuations
and a Cloudflare Workers folder.

## Stack
- **Frontend:** plain HTML/JS at the repo root. No build step. Entry: `index.html`.
  - Modules: `app.js`, `chart.js`, `components.js`, `constants.js`, `detail.js`, `valuations.js`.
- **Backend:** PHP under `php/`. Each endpoint is a self-contained `*.php` file. Currently each file defines its own DB connection — there's a tracked task to extract a shared `db_connect.php` matching the DI repo pattern.
- **Database:** MySQL on `labanos.dk`. Shared instance with `di` and `fitness_buddy` (one schema, all tables together). See "Database" below.
- **Python:** `upload_valuation.py` — script for posting valuation rows. Runs from a local machine, not on the server.
- **Cloudflare:** `cloudflare/` — Workers / config (separate from the PHP backend). Read it before touching.
- **Default branch:** `master` (note: the other two repos use `main`).
- **Deploy:** static files served from GitHub Pages; PHP is uploaded to one.com's web root manually (no CI).

## File layout
- `index.html` — single-page entry
- `app.js`, `chart.js`, `components.js`, `constants.js`, `detail.js`, `valuations.js` — UI/state
- `upload_valuation.py` — Python uploader (uses `API_TOKEN` env var for bearer auth)
- `php/auth.php` — login / token issuance against `users`
- `php/auth_check.php` — `require_auth($pdo)` helper (identical to `fitness_buddy/php/fb_auth_check.php`)
- `php/db_migrate.php` — idempotent schema migrations, called from endpoints
- `php/portfolios.php`, `php/portfolio.php` *(via `portfolios.php` patterns)*, `php/portfolio_history.php`, `php/transactions.php`, `php/notes.php`, `php/meta.php`, `php/valuations.php`
- `php/.htaccess` — forwards `Authorization` header into PHP on shared hosting
- `cloudflare/` — Workers/config (read before changing)
- `TODO.md` — current backlog. Read before suggesting new work.

## Tables this app owns
(Schema lives in `php/db_migrate.php` plus a few `ALTER`s added over time.)
- `users` — shared auth table (also used by `fitness_buddy`). Columns: `id, name, email, password_hash, api_token, created_at`.
- `portfolios` — top-level portfolio per user. Columns include `name`, `base_currency`, `user_id`.
- `portfolio` — holdings; `portfolio_id` FK + `ticker` (`UNIQUE (portfolio_id, ticker)`).
- `transactions` — buy/sell rows; `portfolio_id` + `ticker` indexed.
- `investment_notes` — per-(portfolio,ticker) notes.
- `portfolio_snapshots` — daily total-value history (`portfolio_id, snapshot_date, total_value, base_ccy`).

## Conventions
- PHP endpoints use **PDO** with `utf8mb4`, exception mode.
- All responses are **JSON**; CORS is wide open.
- Auth: bearer token in `Authorization` header against `users.api_token`. Reads can be public; writes call `require_auth($pdo)`.
- Method override via `?_method=PUT` / `?_method=DELETE` over POST (see `portfolios.php` for the pattern).
- `db_migrate.php :: run_migrations($pdo)` is called from endpoints to keep schema current. Add new migrations there as idempotent `CREATE TABLE IF NOT EXISTS` / guarded `ALTER`s.
- The `cloudflare/` folder is separate from the PHP backend — don't refactor it casually.
- Default branch is `master` (not `main`). Open PRs against `master`.

## Database — how I (Claude) work with it
- The DB is shared across all three projects on labanos.dk MySQL. Credentials live in each `php/*.php` file on the server (filled in from `%%PLACEHOLDERS%%` at deploy time). Once the shared `db_connect.php` refactor lands, only that file will carry the connection. **Never commit real credentials to this repo.**
- For my own ad-hoc access I use a **dedicated MySQL user**, separate from the app user, connected via SSH tunnel from your local machine. Connection details (host/user/db, key path) live in env vars on your machine and in your global CLAUDE.md — not in this repo.
- **Safety rule (I follow this every session):**
  - `SELECT` queries — I run them freely.
  - `INSERT` / `UPDATE` / `DELETE` — I first show you the matching rows (`SELECT … WHERE …` preview) and the exact write statement, and wait for your explicit "yes" in chat before executing.
  - `DROP` / `ALTER` / `TRUNCATE` / `GRANT` — I refuse to run these from chat; raise as a PR or migration instead.
- Schema changes go in `php/db_migrate.php` as idempotent `CREATE TABLE IF NOT EXISTS` / guarded `ALTER`s.

## Working agreements
- **Branch & PR flow:** I branch from `master` as `claude/<short-topic>`, commit small focused changes, open a PR, and wait for your review. I never push directly to `master`.
- **Issues:** if I find something worth doing but out of scope, I open a GitHub issue rather than expanding the PR.
- **TODO.md:** I read it at the start of any non-trivial session and update it (move done items, add discoveries) at the end.

## Quick start for me
1. Read `TODO.md` for current state.
2. If the task touches the DB, peek at `php/db_migrate.php` for schema and a relevant endpoint (e.g., `portfolios.php`) for query patterns.
3. Open a branch from `master`, make the change, push, open a PR.
