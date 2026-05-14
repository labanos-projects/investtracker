const { useState, useEffect, useCallback } = React;

// ─── APIs ──────────────────────────────────────────────────────────────────
const NOTES_API           = 'https://labanos.dk/notes.php';
const TRANSACTIONS_API    = 'https://labanos.dk/transactions.php';
const PORTFOLIO_API       = 'https://labanos.dk/portfolio.php';
const META_API            = 'https://labanos.dk/meta.php';
const AUTH_API            = 'https://labanos.dk/auth.php';
const PORTFOLIOS_API      = 'https://labanos.dk/portfolios.php';
const HISTORY_API         = 'https://labanos.dk/portfolio_history.php';
const VALUATIONS_API      = 'https://labanos.dk/valuations.php';
const WATCHLISTS_API      = 'https://labanos.dk/watchlists.php';
const WATCHLIST_ITEMS_API = 'https://labanos.dk/watchlist_items.php';
const WORKER_URL          = 'https://yf-proxy.labanos.workers.dev/';

// Returns fetch headers including auth token if logged in
const authHeaders = () => {
  const token = localStorage.getItem('auth_token');
  const h = { 'Content-Type': 'application/json' };
  if (token) h['Authorization'] = `Bearer ${token}`;
  return h;
};

// ─── normalizePfRow — DB row → app format ─────────────────────────────────
const normalizePfRow = (row) => {
  const seed = {};  // seed data removed — DB is source of truth
  return {
    id:           row.id ? Number(row.id) : undefined,
    ticker:       row.ticker,
    yhTicker:     row.yh_ticker || row.yhTicker || row.ticker,
    company:      row.company,
    ccy:          row.ccy || seed.ccy || 'USD',
    sector:       row.sector  || null,
    country:      row.country || null,
    cachedPrice:  seed.cachedPrice  || 0,
    cachedChg:    seed.cachedChg    || 0,
  };
};

const CACHED_FX = { USD: 6.32546, EUR: 7.471825, CAD: 4.6206, DKK: 1.0 };
// ↑ Update CACHED_AS_OF whenever you refresh the cached prices/FX above
const CACHED_AS_OF = new Date('2026-02-26T17:00:00');

// ─── Formatters ────────────────────────────────────────────────────────────
const n = (v, d=0) => isNaN(v)||v==null ? '–' : Math.abs(v).toLocaleString('da-DK', {minimumFractionDigits:d, maximumFractionDigits:d});
const pct = (v) => v==null||isNaN(v) ? '–' : (v>=0?'+':'−') + n(Math.abs(v*100),2) + '%';
const signed = (v, d=0) => v==null||isNaN(v) ? '–' : (v>=0?'+':'−') + n(Math.abs(v),d);
const clr = (v) => Math.abs(v || 0) < 0.00005 ? 'text-gray-400' : v > 0 ? 'text-emerald-500' : 'text-red-500';

// ─── computePosition ───────────────────────────────────────────────────────
// Derives shares held and average cost from a transaction array
function computePosition(txns) {
  const buys  = txns.filter(t => t.type === 'buy');
  const sells = txns.filter(t => t.type === 'sell');
  const buyShares  = buys.reduce((s, t) => s + Number(t.shares), 0);
  const sellShares = sells.reduce((s, t) => s + Number(t.shares), 0);
  const buyCost    = buys.reduce((s, t) => s + Number(t.shares) * Number(t.price) + Number(t.fees || 0), 0);
  return {
    shares:  buyShares - sellShares,
    avgCost: buyShares > 0 ? buyCost / buyShares : 0,
  };
}
