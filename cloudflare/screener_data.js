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
// ── v2 fixes, after the first live run returned fcf=null on all 9 tickers ──
//
//  1. Yahoo's quoteSummary statement modules (incomeStatementHistory,
//     balanceSheetHistory, cashflowStatementHistory) come back EMPTY. The
//     summary modules (financialData, summaryDetail, price, majorHolders)
//     still work. Statement data now comes from EDGAR or from Yahoo's
//     fundamentals-timeseries endpoint, never from quoteSummary.
//
//  2. Series are keyed by FISCAL YEAR and aligned on it. v1 zipped
//     net_income[i] / shares[i] by index, so two arrays of equal length
//     covering different years produced a silently wrong EPS CAGR — that's
//     what made NVDA's EPS CAGR read 6.2% and its PEG 4.75.
//
//  3. CIK resolution falls back to company-name matching. "NOVO-B.CO" reduces
//     to "NOVO" but Novo Nordisk's ADR is "NVO", so the ticker-root lookup
//     missed it and the whole 20-F/IFRS path went unused.
// ─────────────────────────────────────────────────────────────────────────────

const UA = 'InvestTracker/1.0 (labanos@gmail.com)';
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const timeout = (p, ms) => Promise.race([p, new Promise((_, r) => setTimeout(() => r(new Error('timeout')), ms))]);
const j = async (url, opts = {}, ms = 8000) => {
  const res = await timeout(fetch(url, opts), ms);
  if (!res.ok) throw new Error(`${res.status} ${url.slice(0, 60)}`);
  return res.json();
};

// ─── Year-keyed series helpers ───────────────────────────────────────────────
// A "series" is a Map<fiscalYear, value>. Aligning on the key rather than the
// index is the whole point — see fix (2) above.

const lastN = (map, n = 5) => {
  if (!map || !map.size) return [];
  return [...map.keys()].sort((a, b) => a - b).slice(-n).map(y => map.get(y));
};

/** Element-wise A/B over the fiscal years present in BOTH series. */
const ratioSeries = (a, b) => {
  if (!a || !b) return null;
  const years = [...a.keys()].filter(y => b.has(y) && b.get(y) !== 0).sort((x, y) => x - y);
  if (years.length < 2) return null;
  return years.slice(-5).map(y => a.get(y) / b.get(y));
};

/** Element-wise A-B over shared fiscal years (for CFO − capex). */
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
const avg = a => (a && a.length) ? a.reduce((x, y) => x + y, 0) / a.length : null;

// ─── FX (Frankfurter — ECB, no key) ──────────────────────────────────────────
export async function fxToUsd(ccy) {
  if (!ccy || ccy === 'USD') return 1;
  const base = ccy === 'GBp' ? 'GBP' : ccy;   // Yahoo quotes UK stocks in pence
  try {
    const d = await j(`https://api.frankfurter.dev/v1/latest?base=${base}&symbols=USD`, {}, 6000);
    const rate = d?.rates?.USD;
    if (!rate) return null;
    return ccy === 'GBp' ? rate / 100 : rate;
  } catch { return null; }
}

// ─── Yahoo cookie + crumb handshake ──────────────────────────────────────────
// Confirmed working from the Worker across all 9 tickers in the first live run,
// which contradicts the CLAUDE.md gotcha. Keep an eye on it — it's undocumented.
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

export async function yahooSummary(symbol) {
  const { crumb, cookie } = await yahooCrumb();
  const url = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}` +
              `?modules=${YF_MODULES}&crumb=${encodeURIComponent(crumb)}`;
  const d = await j(url, { headers: { 'User-Agent': BROWSER_UA, 'Cookie': cookie } }, 10000);
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
];

export async function yahooTimeseries(symbol) {
  const { crumb, cookie } = await yahooCrumb();
  const now = Math.floor(Date.now() / 1000);
  const url = `https://query2.finance.yahoo.com/ws/fundamentals-timeseries/v1/finance/timeseries/${encodeURIComponent(symbol)}` +
              `?symbol=${encodeURIComponent(symbol)}&type=${TS_FIELDS.join(',')}` +
              `&period1=0&period2=${now}&crumb=${encodeURIComponent(crumb)}`;
  const d = await j(url, { headers: { 'User-Agent': BROWSER_UA, 'Cookie': cookie } }, 12000);
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
  return out; // { totalRevenue: Map, netIncome: Map, freeCashFlow: Map, ... }
}

// ─── SEC EDGAR ───────────────────────────────────────────────────────────────
let _tickerMap = null, _nameMap = null;

const normName = s => String(s || '').toUpperCase()
  .replace(/\b(INC|CORP|CORPORATION|COMPANY|CO|LTD|PLC|A\/S|AB|NV|SA|SE|AG|HOLDINGS?|GROUP|THE)\b/g, '')
  .replace(/[^A-Z0-9]/g, '');

async function loadSecMaps() {
  if (_tickerMap) return;
  const d = await j('https://www.sec.gov/files/company_tickers_exchange.json',
    { headers: { 'User-Agent': UA } }, 12000);
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
export async function secCik(symbol, companyName) {
  await loadSecMaps();
  const up = symbol.toUpperCase();
  if (_tickerMap[up]) return _tickerMap[up];
  const root = up.replace(/[-.].*$/, '');
  if (_tickerMap[root]) return _tickerMap[root];
  if (companyName) {
    const n = normName(companyName);
    if (n && _nameMap[n]) return _nameMap[n];
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
  // Cash flow — absent in v1, which is why FCF was null for every ticker even
  // where EDGAR answered fine.
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
};

export async function edgarFacts(cik) {
  const padded = String(cik).padStart(10, '0');
  const d = await j(`https://data.sec.gov/api/xbrl/companyfacts/CIK${padded}.json`,
    { headers: { 'User-Agent': UA } }, 15000);

  const pull = (aliases) => {
    for (const [taxonomy, tag] of aliases) {
      const units = d.facts?.[taxonomy]?.[tag]?.units;
      if (!units) continue;
      const unitKey = Object.keys(units).find(u => /^[A-Z]{3}$/.test(u)) || Object.keys(units)[0];
      const rows = (units[unitKey] || [])
        .filter(r => ['10-K', '20-F', '40-F'].includes(r.form) && r.fp === 'FY' && r.fy);
      if (!rows.length) continue;
      // Keyed by fiscal year, latest-filed restatement wins.
      const map = new Map();
      for (const r of rows.sort((a, b) => (a.filed || '').localeCompare(b.filed || ''))) {
        map.set(r.fy, r.val);
      }
      return { unit: unitKey, map };
    }
    return null;
  };

  const out = { currency: null, entityName: d.entityName };
  for (const [field, aliases] of Object.entries(TAGS)) {
    const got = pull(aliases);
    if (got) {
      out[field] = got.map;                     // Map<fiscalYear, value>
      if (/^[A-Z]{3}$/.test(got.unit) && !out.currency) out.currency = got.unit;
    }
  }
  return out;
}

// ─── Merge into a metrics bag with provenance ────────────────────────────────

export async function resolveMetrics(symbol, env) {
  const m = {};
  const set = (k, v, source) => {
    if (v === null || v === undefined || (typeof v === 'number' && !isFinite(v))) return;
    if (m[k]) return;                      // first provider in the waterfall wins
    m[k] = { value: v, source };
  };

  const summary = await yahooSummary(symbol).catch(e => ({ _err: String(e.message) }));
  const ok = summary && !summary._err;

  // Name-based CIK resolution needs the company name, so this runs after summary.
  const cik = await secCik(symbol, ok ? summary.longName : null).catch(() => null);
  const [edgar, ts] = await Promise.all([
    cik ? edgarFacts(cik).catch(() => null) : Promise.resolve(null),
    yahooTimeseries(symbol).catch(() => null),
  ]);

  // ── EDGAR first for anything audited ──
  if (edgar) {
    set('rev_cagr', cagrOf(lastN(edgar.revenue)), 'edgar');
    set('eps_cagr', cagrOf(ratioSeries(edgar.net_income, edgar.shares)), 'edgar');
    set('share_change', cagrOf(lastN(edgar.shares)), 'edgar');
    const gm = ratioSeries(edgar.gross_profit, edgar.revenue);
    if (gm) set('gross_margin', gm[gm.length - 1], 'edgar');
    // FCF = CFO − capex, aligned on fiscal year. capex is filed positive here.
    const fcf = diffSeries(edgar.cfo, edgar.capex);
    if (fcf && fcf.length >= 2) m.fcf_series = { value: fcf, source: 'edgar' };
    // ROIC proxy: NI / (equity + debt). Debt is Yahoo's, hence the blend.
    if (edgar.net_income?.size && edgar.equity?.size) {
      const yrs = [...edgar.net_income.keys()].filter(y => edgar.equity.has(y)).sort();
      const y = yrs[yrs.length - 1];
      if (y != null) {
        const eq = edgar.equity.get(y), debt = ok ? (summary.total_debt || 0) : 0;
        if (eq + debt > 0) set('roic', edgar.net_income.get(y) / (eq + debt), debt ? 'edgar+yahoo' : 'edgar');
      }
    }
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
    if (!m.roic && ts.netIncome?.size && ts.stockholdersEquity?.size) {
      const yrs = [...ts.netIncome.keys()].filter(y => ts.stockholdersEquity.has(y)).sort();
      const y = yrs[yrs.length - 1];
      if (y != null) {
        const eq = ts.stockholdersEquity.get(y), debt = ok ? (summary.total_debt || 0) : 0;
        if (eq + debt > 0) set('roic', ts.netIncome.get(y) / (eq + debt), 'yahoo-ts');
      }
    }
  }

  // ── Yahoo summary: market data and ratios ──
  if (ok) {
    set('insider_own', summary.insider_own, 'yahoo');
    set('payout_ratio', summary.payout_ratio, 'yahoo');
    set('gross_margin', summary.gross_margin, 'yahoo');
    set('pe_trailing', summary.pe_trailing, 'yahoo');
    if (summary.ebitda) {
      const netDebt = (summary.total_debt || 0) - (summary.total_cash || 0);
      set('net_debt_ebitda', netDebt / summary.ebitda, 'yahoo');
    }
    if (summary.mktcap_native) {
      const fx = await fxToUsd(summary.currency);
      if (fx) set('mktcap_usd', summary.mktcap_native * fx, `yahoo+fx(${summary.currency})`);
    }
    m._meta = { currency: summary.currency, sector: summary.sector, industry: summary.industry, price: summary.price };
  }

  // ── FMP last: free tier, partial endpoint coverage, so gap-fill only ──
  if (env?.FMP_API_KEY && !m.roic) {
    try {
      const fmpSym = symbol.replace(/\.[A-Z]{1,3}$/, '');
      const km = await j(`https://financialmodelingprep.com/stable/key-metrics-ttm?symbol=${fmpSym}&apikey=${env.FMP_API_KEY}`, {}, 8000);
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
  };
  return m;
}
