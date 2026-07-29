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
// ─────────────────────────────────────────────────────────────────────────────

const UA = 'InvestTracker/1.0 (labanos@gmail.com)';
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const timeout = (p, ms) => Promise.race([p, new Promise((_, r) => setTimeout(() => r(new Error('timeout')), ms))]);
const j = async (url, opts = {}, ms = 8000) => {
  const res = await timeout(fetch(url, opts), ms);
  if (!res.ok) throw new Error(`${res.status} ${url.slice(0, 60)}`);
  return res.json();
};

// ─── FX (Frankfurter — ECB, no key) ──────────────────────────────────────────
export async function fxToUsd(ccy) {
  if (!ccy || ccy === 'USD') return 1;
  // Yahoo quotes UK stocks in pence.
  const base = ccy === 'GBp' ? 'GBP' : ccy;
  try {
    const d = await j(`https://api.frankfurter.dev/v1/latest?base=${base}&symbols=USD`, {}, 6000);
    const rate = d?.rates?.USD;
    if (!rate) return null;
    return ccy === 'GBp' ? rate / 100 : rate;
  } catch { return null; }
}

// ─── Yahoo cookie + crumb handshake ──────────────────────────────────────────
// CLAUDE.md says quoteSummary "requires browser session cookies — not feasible
// from serverless". That's true of the naive call, but the documented crumb
// handshake does work from a Worker: fc.yahoo.com sets an A3 cookie, then
// /v1/test/getcrumb exchanges it for a crumb token valid for the session.
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

const YF_MODULES = [
  'financialData', 'defaultKeyStatistics', 'summaryDetail', 'price',
  'incomeStatementHistory', 'balanceSheetHistory', 'cashflowStatementHistory',
  'majorHoldersBreakdown', 'assetProfile',
].join(',');

export async function yahooFundamentals(symbol) {
  const { crumb, cookie } = await yahooCrumb();
  const url = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}` +
              `?modules=${YF_MODULES}&crumb=${encodeURIComponent(crumb)}`;
  const d = await j(url, { headers: { 'User-Agent': BROWSER_UA, 'Cookie': cookie } }, 10000);
  const r = d?.quoteSummary?.result?.[0];
  if (!r) throw new Error('no quoteSummary result');

  const raw = v => (v && typeof v === 'object' && 'raw' in v) ? v.raw : (typeof v === 'number' ? v : null);
  const inc = (r.incomeStatementHistory?.incomeStatementHistory || []).slice().reverse();
  const bal = (r.balanceSheetHistory?.balanceSheetStatements || []).slice().reverse();
  const cf = (r.cashflowStatementHistory?.cashflowStatements || []).slice().reverse();

  return {
    currency: r.price?.currency || r.summaryDetail?.currency || 'USD',
    sector: r.assetProfile?.sector || null,
    industry: r.assetProfile?.industry || null,
    price: raw(r.price?.regularMarketPrice),
    mktcap_native: raw(r.price?.marketCap) ?? raw(r.summaryDetail?.marketCap),
    pe_trailing: raw(r.summaryDetail?.trailingPE),
    insider_own: raw(r.majorHoldersBreakdown?.insidersPercentHeld),
    payout_ratio: raw(r.summaryDetail?.payoutRatio),
    gross_margin: raw(r.financialData?.grossMargins),
    revenue_series: inc.map(s => raw(s.totalRevenue)).filter(v => v != null),
    netincome_series: inc.map(s => raw(s.netIncome)).filter(v => v != null),
    fcf_series: cf.map(s => {
      const op = raw(s.totalCashFromOperatingActivities), cx = raw(s.capitalExpenditures);
      return (op == null) ? null : op + (cx || 0); // capex is reported negative
    }).filter(v => v != null),
    total_debt: raw(r.financialData?.totalDebt),
    total_cash: raw(r.financialData?.totalCash),
    ebitda: raw(r.financialData?.ebitda),
    equity_series: bal.map(s => raw(s.totalStockholderEquity)).filter(v => v != null),
    shares_series: inc.map(s => raw(s.weightedAverageShsOutDil ?? s.weightedAverageShsOut)).filter(v => v != null),
  };
}

// ─── SEC EDGAR ───────────────────────────────────────────────────────────────
// Covers US filers AND foreign private issuers filing 20-F (Novo Nordisk is
// CIK 353278, tagged with ifrs-full rather than us-gaap — hence the alias map).
let _tickerMap = null;

export async function secCik(symbol) {
  if (!_tickerMap) {
    const d = await j('https://www.sec.gov/files/company_tickers_exchange.json',
      { headers: { 'User-Agent': UA } }, 10000);
    const iT = d.fields.indexOf('ticker'), iC = d.fields.indexOf('cik');
    _tickerMap = {};
    for (const row of d.data) _tickerMap[String(row[iT]).toUpperCase()] = row[iC];
  }
  // NOVO-B.CO → try the bare root, then the common ADR mapping.
  const root = symbol.toUpperCase().replace(/[-.].*$/, '');
  return _tickerMap[symbol.toUpperCase()] ?? _tickerMap[root] ?? null;
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
  dividends: [['us-gaap', 'PaymentsOfDividendsCommonStock'], ['ifrs-full', 'DividendsPaid']],
};

export async function edgarFacts(cik) {
  const padded = String(cik).padStart(10, '0');
  const d = await j(`https://data.sec.gov/api/xbrl/companyfacts/CIK${padded}.json`,
    { headers: { 'User-Agent': UA } }, 12000);

  const pull = (aliases) => {
    for (const [taxonomy, tag] of aliases) {
      const units = d.facts?.[taxonomy]?.[tag]?.units;
      if (!units) continue;
      // Prefer a monetary unit; fall back to shares/pure.
      const unitKey = Object.keys(units).find(u => /^[A-Z]{3}$/.test(u)) || Object.keys(units)[0];
      const rows = (units[unitKey] || [])
        .filter(r => r.form === '10-K' || r.form === '20-F' || r.form === '40-F')
        .filter(r => r.fp === 'FY' && r.fy)
        .sort((a, b) => a.fy - b.fy);
      if (!rows.length) continue;
      // De-dup by fiscal year, keeping the latest-filed restatement.
      const byYear = new Map();
      for (const r of rows) byYear.set(r.fy, r.val);
      const years = [...byYear.keys()].sort();
      return {
        unit: unitKey,
        years: years.slice(-5),
        values: years.slice(-5).map(y => byYear.get(y)),
        tag,
      };
    }
    return null;
  };

  const out = { currency: null, entityName: d.entityName };
  for (const [field, aliases] of Object.entries(TAGS)) {
    const got = pull(aliases);
    if (got) {
      out[field] = got.values;
      out[`${field}_tag`] = got.tag;
      if (/^[A-Z]{3}$/.test(got.unit) && !out.currency) out.currency = got.unit;
    }
  }
  return out;
}

// ─── Merge into a metrics bag with provenance ────────────────────────────────

const avg = a => (a && a.length) ? a.reduce((x, y) => x + y, 0) / a.length : null;
const cagrOf = s => {
  const f = (s || []).filter(v => typeof v === 'number' && isFinite(v));
  if (f.length < 2 || f[0] <= 0 || f[f.length - 1] <= 0) return null;
  return Math.pow(f[f.length - 1] / f[0], 1 / (f.length - 1)) - 1;
};

/**
 * Resolve every metric the rubric needs, per-field, recording provenance.
 * Any field that no provider supplies simply stays absent → criterion null.
 */
export async function resolveMetrics(symbol, env) {
  const m = {};
  const set = (k, v, source) => {
    if (v === null || v === undefined || (typeof v === 'number' && !isFinite(v))) return;
    if (m[k]) return;                      // first provider in the waterfall wins
    m[k] = { value: v, source };
  };

  // Run providers concurrently; each is independently allowed to fail.
  const [yahoo, cik] = await Promise.all([
    yahooFundamentals(symbol).catch(e => ({ _err: String(e.message) })),
    secCik(symbol).catch(() => null),
  ]);
  const edgar = cik ? await edgarFacts(cik).catch(() => null) : null;

  // ── EDGAR first for anything audited ──
  if (edgar) {
    set('rev_cagr', cagrOf(edgar.revenue), 'edgar');
    set('eps_cagr', (edgar.net_income && edgar.shares && edgar.net_income.length === edgar.shares.length)
      ? cagrOf(edgar.net_income.map((n, i) => n / edgar.shares[i])) : null, 'edgar');
    if (edgar.gross_profit && edgar.revenue) {
      const n = Math.min(edgar.gross_profit.length, edgar.revenue.length);
      set('gross_margin', edgar.gross_profit[n - 1] / edgar.revenue[n - 1], 'edgar');
    }
    if (edgar.shares && edgar.shares.length >= 2) {
      set('share_change', cagrOf(edgar.shares), 'edgar');
    }
    // ROIC proxy: NI / (equity + debt). Debt comes from Yahoo, so this is a
    // deliberate cross-source blend — the provenance records 'edgar+yahoo'.
    if (edgar.net_income && edgar.equity) {
      const ni = edgar.net_income[edgar.net_income.length - 1];
      const eq = edgar.equity[edgar.equity.length - 1];
      const debt = yahoo?.total_debt || 0;
      if (eq + debt > 0) set('roic', ni / (eq + debt), debt ? 'edgar+yahoo' : 'edgar');
    }
  }

  // ── Yahoo fills the gaps and supplies market data ──
  if (yahoo && !yahoo._err) {
    set('insider_own', yahoo.insider_own, 'yahoo');
    set('payout_ratio', yahoo.payout_ratio, 'yahoo');
    set('gross_margin', yahoo.gross_margin, 'yahoo');
    set('pe_trailing', yahoo.pe_trailing, 'yahoo');
    set('rev_cagr', cagrOf(yahoo.revenue_series), 'yahoo');
    set('eps_cagr', (yahoo.netincome_series.length === yahoo.shares_series.length)
      ? cagrOf(yahoo.netincome_series.map((n, i) => n / yahoo.shares_series[i])) : null, 'yahoo');
    set('share_change', cagrOf(yahoo.shares_series), 'yahoo');
    if (yahoo.fcf_series?.length) m.fcf_series = { value: yahoo.fcf_series, source: 'yahoo' };
    if (yahoo.ebitda) {
      const netDebt = (yahoo.total_debt || 0) - (yahoo.total_cash || 0);
      set('net_debt_ebitda', netDebt / yahoo.ebitda, 'yahoo');
    }
    if (yahoo.equity_series?.length && yahoo.netincome_series?.length) {
      const eq = avg(yahoo.equity_series), ni = avg(yahoo.netincome_series);
      const debt = yahoo.total_debt || 0;
      if (eq + debt > 0) set('roic', ni / (eq + debt), 'yahoo');
    }
    // Market cap normalised to USD — Novo reports DKK even in its 20-F.
    if (yahoo.mktcap_native) {
      const fx = await fxToUsd(yahoo.currency);
      if (fx) set('mktcap_usd', yahoo.mktcap_native * fx, `yahoo+fx(${yahoo.currency})`);
    }
    m._meta = { currency: yahoo.currency, sector: yahoo.sector, industry: yahoo.industry, price: yahoo.price };
  }

  // ── FMP last: free tier, partial endpoint coverage, so gap-fill only ──
  if (env?.FMP_API_KEY && (!m.roic || !m.mktcap_usd)) {
    try {
      const fmpSym = symbol.replace(/\.[A-Z]{1,3}$/, '');
      const km = await j(`https://financialmodelingprep.com/stable/key-metrics-ttm?symbol=${fmpSym}&apikey=${env.FMP_API_KEY}`, {}, 8000);
      const k = Array.isArray(km) ? km[0] : null;
      if (k) {
        set('roic', k.returnOnInvestedCapitalTTM, 'fmp');
        set('payout_ratio', k.payoutRatioTTM, 'fmp');
      }
    } catch { /* free tier may not expose this endpoint — that's expected */ }
  }

  m._diag = {
    edgar_cik: cik || null,
    edgar_ok: !!edgar,
    yahoo_ok: !!(yahoo && !yahoo._err),
    yahoo_err: yahoo?._err || null,
  };
  return m;
}
