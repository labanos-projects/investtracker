// ─── screener_data.js — per-field fundamentals waterfall ─────────────────────
//
// Resolves each metric independently down EDGAR → Yahoo → FMP, recording which
// provider supplied it. Falling back per-SOURCE would throw away good numbers:
// EDGAR has audited revenue but no insider ownership, Yahoo has insider
// ownership but softer margins. So we merge at the field level.
//
// Everything here is free:
//   EDGAR      — no key, unlimited, 10 req/s, requires descriptive User-Agent
//   Yahoo      — no key, needs cookie+crumb handshake
//   Frankfurter— no key, ECB rates
//   FMP        — 250 req/day free tier, endpoint coverage is partial
//
// ── Fixes, each found by testing against production ──
//
//  1. Yahoo's quoteSummary statement modules (incomeStatementHistory,
//     balanceSheetHistory, cashflowStatementHistory) come back EMPTY. The
//     summary modules (financialData, summaryDetail, price, majorHolders)
//     still work. Statement data now comes from EDGAR or from Yahoo's
//     fundamentals-timeseries endpoint, never from quoteSummary.
//
//  2. Series are keyed by period END year and aligned on it. See edgarFacts
//     for the two XBRL traps this cost us (report-year vs period-year, and
//     stock splits corrupting share counts across filings).
//
//  3. CIK resolution falls back to company-name matching. "NOVO-B.CO" reduces
//     to "NOVO" but Novo Nordisk's ADR is "NVO", so the ticker-root lookup
//     missed it and the whole 20-F/IFRS path went unused.
//
//  4. Every upstream goes through screener_cache.js. ?refresh=1 bypasses it.
//
//  5. ROIC accepts a CASH basis when the earnings engine is unproven.
//
//  6. Debt is never defaulted to zero — see the invested-capital block. A
//     missing Yahoo field used to collapse invested capital to equity-only.
// ─────────────────────────────────────────────────────────────────────────────

import { cachedJson, TTL, statsSnapshot } from './screener_cache.js';

const UA = 'InvestTracker/1.0 (labanos@gmail.com)';
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const timeout = (p, ms) => Promise.race([p, new Promise((_, r) => setTimeout(() => r(new Error('timeout')), ms))]);

// ─── Year-keyed series helpers ───────────────────────────────────────────────
// A "series" is a Map<periodEndYear, value>. Aligning on the key rather than
// the index is the whole point — see fix (2) above.

const lastN = (map, n = 5) => {
  if (!map || !map.size) return [];
  return [...map.keys()].sort((a, b) => a - b).slice(-n).map(y => map.get(y));
};

/** Element-wise A/B over the years present in BOTH series. */
const ratioSeries = (a, b) => {
  if (!a || !b) return null;
  const years = [...a.keys()].filter(y => b.has(y) && b.get(y) !== 0).sort((x, y) => x - y);
  if (years.length < 2) return null;
  return years.slice(-5).map(y => a.get(y) / b.get(y));
};

/** Element-wise A-B over shared years (for CFO − capex). */
const diffSeries = (a, b) => {
  if (!a) return null;
  const years = [...a.keys()].sort((x, y) => x - y);
  if (!years.length) return null;
  return years.slice(-5).map(y => a.get(y) - (b?.get(y) ?? 0));
};

const cagrOf = s => {
  const f = (s || []).filter(v => typeof v === 'number' && isFinite(v));
  if (f.length < 2 || f[0] <= 0 || f[f.length - 1] <= 0) return null;
  return Math.pow(f[f.length - 1] / f[0], 1 / (f.length - 1)) - 1;
};

// ─── FX (Frankfurter — ECB, no key) ──────────────────────────────────────────
export async function fxToUsd(ccy, refresh = false) {
  if (!ccy || ccy === 'USD') return 1;
  const base = ccy === 'GBp' ? 'GBP' : ccy;   // Yahoo quotes UK stocks in pence
  try {
    const d = await cachedJson(`https://api.frankfurter.dev/v1/latest?base=${base}&symbols=USD`, {},
      { ttl: TTL.FX, ms: 6000, refresh, key: `fx:${base}` });
    const rate = d?.rates?.USD;
    if (!rate) return null;
    return ccy === 'GBp' ? rate / 100 : rate;
  } catch { return null; }
}

// ─── Yahoo cookie + crumb handshake ──────────────────────────────────────────
// Confirmed working from the Worker across all 9 tickers, which contradicts the
// old CLAUDE.md gotcha. Keep an eye on it — it's undocumented.
let _crumb = null, _cookie = null, _crumbAt = 0;

export async function yahooCrumb() {
  if (_crumb && Date.now() - _crumbAt < 30 * 60 * 1000) return { crumb: _crumb, cookie: _cookie };
  const seed = await timeout(fetch('https://fc.yahoo.com', {
    headers: { 'User-Agent': BROWSER_UA }, redirect: 'manual',
  }), 6000).catch(() => null);
  const setCookie = seed?.headers?.get('set-cookie') || '';
  _cookie = setCookie.split(',').map(c => c.split(';')[0].trim()).filter(Boolean).join('; ');
  const res = await timeout(fetch('https://query1.finance.yahoo.com/v1/test/getcrumb', {
    headers: { 'User-Agent': BROWSER_UA, 'Cookie': _cookie, 'Accept': 'text/plain' },
  }), 6000);
  _crumb = (await res.text()).trim();
  _crumbAt = Date.now();
  if (!_crumb || _crumb.length > 32) throw new Error('crumb handshake failed');
  return { crumb: _crumb, cookie: _cookie };
}

// Only the summary modules — the statement-history modules return empty.
const YF_MODULES = [
  'financialData', 'defaultKeyStatistics', 'summaryDetail', 'price',
  'majorHoldersBreakdown', 'assetProfile',
].join(',');

export async function yahooSummary(symbol, refresh = false) {
  const { crumb, cookie } = await yahooCrumb();
  const url = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}` +
              `?modules=${YF_MODULES}&crumb=${encodeURIComponent(crumb)}`;
  // The crumb rotates, so it must not be part of the cache key.
  const d = await cachedJson(url, { headers: { 'User-Agent': BROWSER_UA, 'Cookie': cookie } },
    { ttl: TTL.YF_SUMMARY, ms: 10000, refresh, key: `yf-summary:${symbol}` });
  const r = d?.quoteSummary?.result?.[0];
  if (!r) throw new Error('no quoteSummary result');
  const raw = v => (v && typeof v === 'object' && 'raw' in v) ? v.raw : (typeof v === 'number' ? v : null);

  return {
    currency: r.price?.currency || r.summaryDetail?.currency || 'USD',
    longName: r.price?.longName || r.price?.shortName || null,
    sector: r.assetProfile?.sector || null,
    industry: r.assetProfile?.industry || null,
    price: raw(r.price?.regularMarketPrice),
    mktcap_native: raw(r.price?.marketCap) ?? raw(r.summaryDetail?.marketCap),
    pe_trailing: raw(r.summaryDetail?.trailingPE),
    insider_own: raw(r.majorHoldersBreakdown?.insidersPercentHeld),
    payout_ratio: raw(r.summaryDetail?.payoutRatio),
    gross_margin: raw(r.financialData?.grossMargins),
    total_debt: raw(r.financialData?.totalDebt),
    total_cash: raw(r.financialData?.totalCash),
    ebitda: raw(r.financialData?.ebitda),
  };
}

// ─── Yahoo fundamentals-timeseries ───────────────────────────────────────────
// The replacement for the dead quoteSummary statement modules, and the only
// statement source for names with no SEC presence (DANSKE.CO, most of Europe).
const TS_FIELDS = [
  'annualTotalRevenue', 'annualNetIncome', 'annualGrossProfit',
  'annualStockholdersEquity', 'annualDilutedAverageShares',
  'annualOperatingCashFlow', 'annualCapitalExpenditure', 'annualFreeCashFlow',
  'annualTotalDebt',
];

export async function yahooTimeseries(symbol, refresh = false) {
  const { crumb, cookie } = await yahooCrumb();
  const now = Math.floor(Date.now() / 1000);
  const url = `https://query2.finance.yahoo.com/ws/fundamentals-timeseries/v1/finance/timeseries/${encodeURIComponent(symbol)}` +
              `?symbol=${encodeURIComponent(symbol)}&type=${TS_FIELDS.join(',')}` +
              `&period1=0&period2=${now}&crumb=${encodeURIComponent(crumb)}`;
  // period2 is "now" and the crumb rotates — neither belongs in the cache key.
  const d = await cachedJson(url, { headers: { 'User-Agent': BROWSER_UA, 'Cookie': cookie } },
    { ttl: TTL.YF_TIMESERIES, ms: 12000, refresh, key: `yf-ts:${symbol}` });
  const results = d?.timeseries?.result || [];

  const out = {};
  for (const r of results) {
    const key = (r.meta?.type || [])[0];
    if (!key || !Array.isArray(r[key])) continue;
    const map = new Map();
    for (const point of r[key]) {
      if (!point?.asOfDate || point.reportedValue?.raw == null) continue;
      map.set(parseInt(point.asOfDate.slice(0, 4)), point.reportedValue.raw);
    }
    if (map.size) out[key.replace(/^annual/, '').replace(/^./, c => c.toLowerCase())] = map;
  }
  return out; // { totalRevenue: Map, netIncome: Map, freeCashFlow: Map, totalDebt: Map, ... }
}

// ─── SEC EDGAR ───────────────────────────────────────────────────────────────
let _tickerMap = null, _nameMap = null;

const normName = s => String(s || '').toUpperCase()
  .replace(/\b(INC|CORP|CORPORATION|COMPANY|CO|LTD|PLC|A\/S|AB|NV|SA|SE|AG|HOLDINGS?|GROUP|THE)\b/g, '')
  .replace(/[^A-Z0-9]/g, '');

async function loadSecMaps(refresh = false) {
  if (_tickerMap && !refresh) return;
  const d = await cachedJson('https://www.sec.gov/files/company_tickers_exchange.json',
    { headers: { 'User-Agent': UA } },
    { ttl: TTL.SEC_MAP, ms: 12000, refresh, key: 'sec:ticker-map' });
  const iT = d.fields.indexOf('ticker'), iC = d.fields.indexOf('cik'), iN = d.fields.indexOf('name');
  _tickerMap = {}; _nameMap = {};
  for (const row of d.data) {
    _tickerMap[String(row[iT]).toUpperCase()] = row[iC];
    const n = normName(row[iN]);
    if (n && !_nameMap[n]) _nameMap[n] = row[iC];
  }
}

/**
 * Resolve a CIK. Exact ticker first, then ticker root, then company name.
 *
 * The name fallback is what makes European 20-F filers reachable: "NOVO-B.CO"
 * roots to "NOVO", but Novo Nordisk lists in the US as "NVO". Matching on
 * "NOVONORDISK" finds CIK 353278 and unlocks the IFRS branch.
 */
export async function secCik(symbol, companyName, refresh = false) {
  await loadSecMaps(refresh);
  const up = symbol.toUpperCase();
  if (_tickerMap[up]) return _tickerMap[up];
  const root = up.replace(/[-.].*$/, '');
  if (_tickerMap[root]) return _tickerMap[root];
  if (companyName) {
    const n = normName(companyName);
    if (n && _nameMap[n]) return _nameMap[n];
    // SEC writes "NOVO NORDISK A S" (space-separated), which normalises to
    // NOVONORDISKAS, while Yahoo's "Novo Nordisk A/S" gives NOVONORDISK.
    // Allow a short prefix overhang so the two meet.
    if (n && n.length >= 8) {
      for (const k of Object.keys(_nameMap)) {
        if (k.startsWith(n) && k.length - n.length <= 3) return _nameMap[k];
      }
    }
  }
  return null;
}

// Companies rotate tags between filings and IFRS filers use a different
// taxonomy entirely, so each field is an ordered alias list — first hit wins.
const TAGS = {
  revenue: [
    ['us-gaap', 'RevenueFromContractWithCustomerExcludingAssessedTax'],
    ['us-gaap', 'Revenues'], ['us-gaap', 'SalesRevenueNet'],
    ['ifrs-full', 'Revenue'], ['ifrs-full', 'RevenueFromContractsWithCustomers'],
  ],
  net_income: [['us-gaap', 'NetIncomeLoss'], ['ifrs-full', 'ProfitLoss']],
  equity: [
    ['us-gaap', 'StockholdersEquity'],
    ['us-gaap', 'StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest'],
    ['ifrs-full', 'Equity'],
  ],
  gross_profit: [['us-gaap', 'GrossProfit'], ['ifrs-full', 'GrossProfit']],
  shares: [
    ['us-gaap', 'WeightedAverageNumberOfDilutedSharesOutstanding'],
    ['us-gaap', 'WeightedAverageNumberOfSharesOutstandingBasic'],
    ['ifrs-full', 'WeightedAverageNumberOfDilutedSharesOutstanding'],
  ],
  // Cash flow — absent originally, which is why FCF was null for every ticker
  // even where EDGAR answered fine.
  cfo: [
    ['us-gaap', 'NetCashProvidedByUsedInOperatingActivities'],
    ['us-gaap', 'NetCashProvidedByUsedInOperatingActivitiesContinuingOperations'],
    ['ifrs-full', 'CashFlowsFromUsedInOperatingActivities'],
  ],
  capex: [
    ['us-gaap', 'PaymentsToAcquirePropertyPlantAndEquipment'],
    ['us-gaap', 'PaymentsToAcquireProductiveAssets'],
    ['ifrs-full', 'PurchaseOfPropertyPlantAndEquipment'],
  ],
  // Debt, for the invested-capital denominator. This used to come ONLY from
  // Yahoo's optional financialData.totalDebt, and a missing field was coerced
  // to zero — collapsing invested capital to equity-only and inflating ROIC.
  // For NET that read 19.7% instead of 5.8% and moved the score 21 points
  // between two otherwise identical runs.
  debt: [
    ['us-gaap', 'DebtLongtermAndShorttermCombinedAmount'],
    ['us-gaap', 'LongTermDebt'],
    ['us-gaap', 'LongTermDebtNoncurrent'],
    ['us-gaap', 'ConvertibleNotesPayableNoncurrent'],
    ['us-gaap', 'ConvertibleLongTermNotesPayable'],
    ['ifrs-full', 'Borrowings'],
    ['ifrs-full', 'NoncurrentPortionOfNoncurrentBorrowings'],
  ],
};

export async function edgarFacts(cik, refresh = false) {
  const padded = String(cik).padStart(10, '0');
  // The slowest call in the chain — multi-MB, and changes four times a year.
  const d = await cachedJson(`https://data.sec.gov/api/xbrl/companyfacts/CIK${padded}.json`,
    { headers: { 'User-Agent': UA } },
    { ttl: TTL.EDGAR, ms: 15000, refresh, key: `edgar:${padded}` });

  /**
   * @param {boolean} singleFiling  Restrict to the most recent accession.
   *
   * Two traps in the XBRL frames data, both found the hard way:
   *
   *  (a) `fy` is the fiscal year of the REPORT, not of the data point. One
   *      NVDA 10-K carries three annual periods (ending 2023-01-29,
   *      2024-01-28, 2025-01-26) all tagged fy=2025. Keying on `fy` kept
   *      whichever happened to be iterated last. Key on the period END.
   *
   *  (b) Per-share quantities are restated across stock splits, and only
   *      WITHIN a filing. NVDA's pre-2024 filings report pre-split counts;
   *      the FY2025 10-K restates its own comparatives post-split. Merging
   *      filings therefore reads a 10:1 split as 10x dilution — share CAGR
   *      came out +76.3% instead of -0.9%. For share counts we take one
   *      filing's comparatives: 3 consistent years beat 5 inconsistent ones.
   */
  const pull = (aliases, singleFiling = false) => {
    for (const [taxonomy, tag] of aliases) {
      const units = d.facts?.[taxonomy]?.[tag]?.units;
      if (!units) continue;
      const unitKey = Object.keys(units).find(u => /^[A-Z]{3}$/.test(u)) || Object.keys(units)[0];
      let rows = (units[unitKey] || []).filter(r => {
        if (!['10-K', '20-F', '40-F'].includes(r.form) || !r.end) return false;
        if (!r.start) return true;                       // instant concept
        const days = (new Date(r.end) - new Date(r.start)) / 864e5;
        return days > 300 && days < 400;                 // annual duration only
      });
      if (!rows.length) continue;

      rows.sort((a, b) => (a.filed || '').localeCompare(b.filed || '') || a.end.localeCompare(b.end));

      if (singleFiling) {
        const latestAccn = rows[rows.length - 1].accn;
        const scoped = rows.filter(r => r.accn === latestAccn);
        if (scoped.length >= 2) rows = scoped;
      }

      const map = new Map();
      for (const r of rows) map.set(parseInt(r.end.slice(0, 4)), r.val);
      return { unit: unitKey, map };
    }
    return null;
  };

  const SPLIT_SENSITIVE = new Set(['shares']);

  const out = { currency: null, entityName: d.entityName };
  for (const [field, aliases] of Object.entries(TAGS)) {
    const got = pull(aliases, SPLIT_SENSITIVE.has(field));
    if (got) {
      out[field] = got.map;                     // Map<periodEndYear, value>
      if (/^[A-Z]{3}$/.test(got.unit) && !out.currency) out.currency = got.unit;
    }
  }
  return out;
}

// ─── Merge into a metrics bag with provenance ────────────────────────────────

export async function resolveMetrics(symbol, env, refresh = false) {
  const m = {};
  const set = (k, v, source) => {
    if (v === null || v === undefined || (typeof v === 'number' && !isFinite(v))) return;
    if (m[k]) return;                      // first provider in the waterfall wins
    m[k] = { value: v, source };
  };

  const summary = await yahooSummary(symbol, refresh).catch(e => ({ _err: String(e.message) }));
  const ok = summary && !summary._err;

  // Name-based CIK resolution needs the company name, so this runs after summary.
  const cik = await secCik(symbol, ok ? summary.longName : null, refresh).catch(() => null);
  const [edgar, ts] = await Promise.all([
    cik ? edgarFacts(cik, refresh).catch(() => null) : Promise.resolve(null),
    yahooTimeseries(symbol, refresh).catch(() => null),
  ]);

  // ── EDGAR first for anything audited ──
  if (edgar) {
    set('rev_cagr', cagrOf(lastN(edgar.revenue)), 'edgar');
    // net_income ∩ shares — shares is single-filing, so this narrows to that
    // filing's comparative years, which is exactly what we want: both sides of
    // the ratio come from one consistently-restated basis.
    set('eps_cagr', cagrOf(ratioSeries(edgar.net_income, edgar.shares)), 'edgar');
    set('share_change', cagrOf(lastN(edgar.shares)), 'edgar');
    const gm = ratioSeries(edgar.gross_profit, edgar.revenue);
    if (gm) set('gross_margin', gm[gm.length - 1], 'edgar');
    // FCF = CFO − capex, aligned on period end. capex is filed positive here.
    const fcf = diffSeries(edgar.cfo, edgar.capex);
    if (fcf && fcf.length >= 2) m.fcf_series = { value: fcf, source: 'edgar' };
  }

  // ── Yahoo timeseries fills statement gaps (and carries non-SEC names) ──
  if (ts) {
    set('rev_cagr', cagrOf(lastN(ts.totalRevenue)), 'yahoo-ts');
    set('eps_cagr', cagrOf(ratioSeries(ts.netIncome, ts.dilutedAverageShares)), 'yahoo-ts');
    set('share_change', cagrOf(lastN(ts.dilutedAverageShares)), 'yahoo-ts');
    const gm = ratioSeries(ts.grossProfit, ts.totalRevenue);
    if (gm) set('gross_margin', gm[gm.length - 1], 'yahoo-ts');
    if (!m.fcf_series) {
      // Yahoo publishes FCF directly; fall back to CFO − capex if absent.
      const direct = lastN(ts.freeCashFlow);
      const derived = diffSeries(ts.operatingCashFlow, ts.capitalExpenditure);
      const series = direct.length >= 2 ? direct : (derived?.length >= 2 ? derived : null);
      if (series) m.fcf_series = { value: series, source: 'yahoo-ts' };
    }
  }

  // ── Invested capital, then ROIC ────────────────────────────────────────────
  //
  // Debt is NEVER defaulted to zero. It used to come only from Yahoo's optional
  // financialData.totalDebt via `(summary.total_debt || 0)`, so a missing field
  // silently became "no debt": invested capital collapsed to equity-only and
  // every return-on-capital figure inflated. For NET that read 19.7% instead of
  // 5.8% and moved the score 21 points between two identical runs.
  //
  // That is the same anti-pattern as the `|| 1` this whole rework began with.
  // If no source reports debt, invested capital stays unresolved and ROIC comes
  // back null — which drops out of the denominator. "No data" is honest;
  // "zero debt" is a fiction.
  {
    const eqMap = edgar?.equity?.size ? edgar.equity : (ts?.stockholdersEquity || null);
    const eqSrc = edgar?.equity?.size ? 'edgar' : 'yahoo-ts';
    const niMap = edgar?.net_income?.size ? edgar.net_income : (ts?.netIncome || null);

    if (eqMap?.size) {
      const y = [...eqMap.keys()].sort().pop();
      const eq = eqMap.get(y);

      // Debt, in order of preference: EDGAR same fiscal year → EDGAR latest
      // filed → Yahoo timeseries → Yahoo summary. Never zero.
      let debt = null, debtSrc = null;
      if (edgar?.debt?.has(y)) {
        debt = edgar.debt.get(y); debtSrc = 'edgar';
      } else if (edgar?.debt?.size) {
        debt = edgar.debt.get([...edgar.debt.keys()].sort().pop()); debtSrc = 'edgar';
      } else if (ts?.totalDebt?.size) {
        debt = ts.totalDebt.get([...ts.totalDebt.keys()].sort().pop()); debtSrc = 'yahoo-ts';
      } else if (ok && typeof summary.total_debt === 'number') {
        debt = summary.total_debt; debtSrc = 'yahoo';
      }

      if (debt !== null && eq + debt > 0) {
        const icSrc = debtSrc.startsWith('yahoo') && eqSrc === 'edgar' ? 'edgar+yahoo' : eqSrc;
        m._ic = { value: eq + debt, source: icSrc, year: y, debt_source: debtSrc };
        if (niMap?.size) {
          const ny = niMap.has(y) ? y : [...niMap.keys()].sort().pop();
          set('roic', niMap.get(ny) / (eq + debt), icSrc);
        }
      }
    }
  }

  // ── Cash-basis ROIC for pre-profitability compounders ──────────────────────
  //
  // The engine (SGR = ROIC × retention) is earnings-based, so a company
  // reinvesting hard at negative accounting earnings reads as a DEAD engine.
  // Amazon would have scored 0 on Tier 1 for most of its best two decades;
  // Cloudflare scored 0 while its FCF went -28M → +287M.
  //
  // The gates below are deliberately strict, because a DYING business also
  // throws off cash — by cutting capex and liquidating working capital.
  // Requiring real revenue growth is what separates "reinvesting for growth"
  // from "harvesting a melting ice cube", and is precisely why GME (revenue
  // flat-to-declining) does not qualify no matter how much net cash it holds.
  {
    const earningsRoic = m.roic?.value ?? null;
    const fcf = m.fcf_series?.value;
    const revG = m.rev_cagr?.value ?? null;
    const ic = m._ic?.value ?? null;

    const engineUnproven = earningsRoic === null || earningsRoic <= 0;
    const haveSeries = Array.isArray(fcf) && fcf.length >= 3;
    const growingRevenue = revG !== null && revG > 0.10;

    if (engineUnproven && haveSeries && growingRevenue && ic > 0) {
      const last = fcf[fcf.length - 1], prev = fcf[fcf.length - 2];
      // Last TWO years positive, and improving overall — one good year is not
      // an inflection.
      if (last > 0 && prev > 0 && last > fcf[0]) {
        m.roic = {
          value: last / ic,
          source: `${m._ic.source}/fcf`,
          basis: 'fcf',
          earnings_roic: earningsRoic,
        };
      }
    }
  }

  // ── Yahoo summary: market data and ratios ──
  if (ok) {
    set('insider_own', summary.insider_own, 'yahoo');
    set('payout_ratio', summary.payout_ratio, 'yahoo');
    set('gross_margin', summary.gross_margin, 'yahoo');
    set('pe_trailing', summary.pe_trailing, 'yahoo');
    // Same coercion trap as invested capital — a missing totalDebt must not be
    // read as a debt-free balance sheet.
    if (summary.ebitda && typeof summary.total_debt === 'number') {
      const netDebt = summary.total_debt - (summary.total_cash || 0);
      set('net_debt_ebitda', netDebt / summary.ebitda, 'yahoo');
    }
    if (summary.mktcap_native) {
      const fx = await fxToUsd(summary.currency, refresh);
      if (fx) set('mktcap_usd', summary.mktcap_native * fx, `yahoo+fx(${summary.currency})`);
    }
    m._meta = { currency: summary.currency, sector: summary.sector, industry: summary.industry, price: summary.price };
  }

  // ── FMP last: free tier, partial endpoint coverage, so gap-fill only ──
  if (env?.FMP_API_KEY && !m.roic) {
    try {
      const fmpSym = symbol.replace(/\.[A-Z]{1,3}$/, '');
      // Cached hardest of all — this is the only metered upstream (250/day),
      // and the api key must stay out of the cache key.
      const km = await cachedJson(
        `https://financialmodelingprep.com/stable/key-metrics-ttm?symbol=${fmpSym}&apikey=${env.FMP_API_KEY}`,
        {}, { ttl: TTL.EDGAR, ms: 8000, refresh, key: `fmp:key-metrics:${fmpSym}` });
      const k = Array.isArray(km) ? km[0] : null;
      if (k) {
        set('roic', k.returnOnInvestedCapitalTTM, 'fmp');
        set('payout_ratio', k.payoutRatioTTM, 'fmp');
      }
    } catch { /* free tier may not expose this endpoint — expected */ }
  }

  m._diag = {
    edgar_cik: cik || null,
    edgar_ok: !!edgar,
    yahoo_ok: ok,
    yahoo_err: summary?._err || null,
    ts_ok: !!ts,
    ts_fields: ts ? Object.keys(ts) : [],
    fcf_source: m.fcf_series?.source || null,
    eps_source: m.eps_cagr?.source || null,
    roic_basis: m.roic?.basis || 'earnings',
    roic_earnings: m.roic?.earnings_roic ?? null,
    invested_capital: m._ic?.value ?? null,
    debt_source: m._ic?.debt_source ?? null,
    refresh,
    cache: statsSnapshot(),
  };
  return m;
}
