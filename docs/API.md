# API endpoints

> Part of the InvestTracker agent context. Start at [CLAUDE.md](../CLAUDE.md).
> **Read this when:** calling or adding an endpoint on either the PHP backend or the Cloudflare Worker.

## PHP backend (https://labanos.dk/)

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
| **`sql.php`** | **POST** | (Bearer `CLAUDE_SQL_TOKEN`) | **Claude's admin SQL proxy — see [BACKEND.md](BACKEND.md)** |

## Cloudflare Worker (https://yf-proxy.labanos.workers.dev/)

| Query Param | Description |
|---|---|
| `?symbols=AAPL,NVDA,NOVO-B.CO` | Batch real-time prices |
| `?quote=NVDA` | Full ticker snapshot for the ticker page: price, chgPct, currency, company, sector, industry, market cap, P/E |
| `?chart=AAPL&range=1y` | Historical chart data |
| `?search=novo nordisk` | Ticker autocomplete |
| `?news=AAPL` | Latest news headlines |
| `?generate_valuation=AAPL&portfolio_id=1[&current_price=...][&refresh=1]` | AI DCF valuation (Bearer-auth). Actuals from filings, assumptions from grounded Gemini. 422 = inputs failed the reconciliation gate and nothing was saved. See [VALUATION.md](VALUATION.md). |
| `?score_ticker=NVDA[&refresh=1]` | Screener score (Bearer-auth). `refresh=1` bypasses all caches. See [SCREENER.md](SCREENER.md). |

Chart ranges: `1d`, `5d`, `1mo`, `3mo`, `6mo`, `1y`, `2y`, `5y`, `max`.

Note: `chgPct` is returned as a **fraction** from `?quote=` and as a
**percentage** from `?symbols=`. See [FRONTEND.md](FRONTEND.md#display-traps).
