// ─── valuation_data.js — live fundamentals for the DCF model ─────────────────
//
// WHY THIS FILE EXISTS
//
// The valuation endpoint used to call exactly one upstream — FMP
// `/stable/income-statement` — and, when that returned nothing, fell through to
// `buildKnowledgePrompt()`, which instructed Gemini to model the company "from
// your training knowledge". Thirteen of the twenty-six models in the database
// were built that way, and the only trace was a parenthetical in a free-text
// notes string.
//
// ServiceNow is the worked example. The stored FY2025 baseline was 201M shares
// against 1,034M actual (a pre-split count recalled from training data) and
// $2,750M net income against ~$1,660M TTM. That put the model's implied current
// P/E at 8.1x when the stock traded at 69x, and a base-case ~33x exit multiple
// on an EPS eight times too high produced a fair value roughly 4-5x reality.
// The model was not optimistic. It was wrong by construction.
//
// So: the AI no longer supplies actuals. It supplies FORWARD ASSUMPTIONS only.
// Every historical figure the DCF stands on is resolved here, from filings,
// with provenance — the same per-field waterfall the screener rework landed:
//
//   SEC EDGAR companyfacts  → audited, us-gaap AND ifrs-full
//   Yahoo fundamentals-timeseries → gap-fill, and the only path for non-SEC names
//   Yahoo quoteSummary      → live price, market cap, trailing P/E
//
// ── The reconciliation gate ──
//
// Resolving from filings is necessary but not sufficient — a units slip or a
// split-corrupted share count still yields plausible, confident, wrong output.
// So the inputs are checked against the market before anything is saved:
// shares x price must reconcile with reported market cap. That single check
// catches the entire NOW class of failure, because a 5:1 split shows up as a
// ratio of 5.0 and nothing else does.
//
// ── XBRL: three traps, all of which produce confident wrong numbers ──
//
// This file parses SEC companyfacts, as `edgarFacts()` in screener_data.js
// does, and applies the same first two fixes. They are duplicated deliberately
// rather than shared, because screener_data.js does not carry the `op_income`
// tags a DCF needs and rewriting it wholesale to add them is a larger blast
// radius than 30 lines of parsing. If you change the period-keying or the
// split-scoping HERE, change it THERE too — both produce silent wrong numbers,
// not errors. The third trap is valuation-only, because only a DCF cares about
// a share count more recent than the last annual report.
//
//   (a) `fy` is the fiscal year of the REPORT, not of the data point. One NVDA
//       10-K carries three annual periods all tagged fy=2025. Key on the
//       period END date and filter durations to 300-400 days.
//   (b) Per-share quantities are restated across splits, and only WITHIN a
//       filing. Merging filings reads a 10:1 split as 10x dilution. Share
//       counts therefore come from the latest accession's own comparatives.
//   (c) A split can happen AFTER the last annual report, leaving the 10-K
//       self-consistent and stale. See splitFactorSinceAnnual below.
// ────────────────────────────────────────────────────────────────────────

import { cachedJson, TTL, statsSnapshot } from './screener_cache.js';
import { yahooSummary, yahooCrumb, secCik } from './screener_data.js';

const UA = 'InvestTracker/1.0 (labanos@gmail.com)';
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// How far the reported diluted share count may sit from the market-implied
// count before we stop trusting the inputs.
//
// Diluted weighted-average shares and shares outstanding are genuinely
// different quantities — a year of buybacks or heavy SBC moves them a few
// percent apart, and the weighted average lags a year-end count by design. So
// a modest gap is expected and must not block a legitimate model.
//
// A SPLIT, by contrast, shows up as an integer multiple. Nothing benign lands
// at 5.0. The warn band exists so a genuinely unusual capital structure is
// surfaced rather than silently blocked; the fail band exists so the NOW case
// can never be saved again.
const RECON_WARN = 0.20;   // 20% — flag it, still save
const RECON_FAIL = 0.50;   // 50% — refuse to save

// ─── Year-keyed series helpers ───────────────────────────────────────────────
// A series is a Map<periodEndYear, value>. Aligning on the key rather than the
// index is the whole point: a company that changes fiscal year-end, or a source
// that skips a year, must not silently shift revenue against share count.

const yearsOf = (...maps) => {
  const s = new Set();
  for (const m of maps) if (m) for (const y of m.keys()) s.add(y);
  return [...s].sort((a, b) => a - b);
};

// ─── SEC EDGAR ───────────────────────────────────────────────────────────────

// Companies rotate tags between filings and IFRS filers use a different
// taxonomy entirely, so each field is an ordered alias list — first hit wins.
// `op_income` is the addition over the screener's set: a DCF interpolates
// operating margin toward a target, so EBIT is load-bearing here and unused
// there.
const TAGS = {
  revenue: [
    ['us-gaap', 'RevenueFromContractWithCustomerExcludingAssessedTax'],
    ['us-gaap', 'Revenues'],
    ['us-gaap', 'SalesRevenueNet'],
    ['ifrs-full', 'Revenue'],
    ['ifrs-full', 'RevenueFromContractsWithCustomers'],
  ],
  gross_profit: [
    ['us-gaap', 'GrossProfit'],
    ['ifrs-full', 'GrossProfit'],
  ],
  op_income: [
    ['us-gaap', 'OperatingIncomeLoss'],
    ['ifrs-full', 'ProfitLossFromOperatingActivities'],
  ],
  net_income: [
    ['us-gaap', 'NetIncomeLoss'],
    ['ifrs-full', 'ProfitLoss'],
  ],
  shares: [
    ['us-gaap', 'WeightedAverageNumberOfDilutedSharesOutstanding'],
    ['us-gaap', 'WeightedAverageNumberOfSharesOutstandingBasic'],
    ['ifrs-full', 'WeightedAverageNumberOfDilutedSharesOutstanding'],
  ],
};

// Split-restated quantities: scope to a single filing. See trap (b) above.
const SPLIT_SENSITIVE = new Set(['shares']);

// ─── Trap (c): a split that happens AFTER the last annual report ──────────────
//
// Scoping share counts to one filing fixes splits the latest 10-K has already
// restated. It does nothing for a split announced since, because the 10-K is
// then entirely self-consistent and entirely out of date.
//
// Mueller Industries split 2-for-1 between its FY2025 10-K (filed 2026-02-25,
// 111,492,000 shares) and its Q2 2026 10-Q (filed 2026-07-22, 221,192,000).
// Nothing inside the 10-K hints at it; the market cap implied 221M against a
// filed 111M, the reconciliation gate read 1.98 and refused to save. Correct,
// and useless — the right number was sitting in a 10-Q we weren't reading.
//
// So: compare the annual basis against the most recently FILED share figure of
// ANY form. Absent a split those agree within a couple of percent; a split
// shows up as a clean multiple.
//
// Why not simply diff restatements across filings? Because that breaks the case
// trap (b) already handles. ServiceNow's FY2025 10-K restates FY2023 from
// 205,591,000 to 1,027,953,000 — a genuine 5:1 — and our annual series is
// ALREADY on the restated basis. Detecting that restatement and applying it
// again would multiply a correct series by five. Anchoring on the annual basis
// we actually returned asks the only question that matters: is THIS series
// stale? For NOW it is not (1,039.9M latest vs 1,046.7M annual, ratio 0.99).
const SPLIT_CANDIDATES = [1.5, 2, 3, 4, 5, 6, 7, 8, 10, 15, 20];
const SPLIT_RATIOS = [...SPLIT_CANDIDATES, ...SPLIT_CANDIDATES.map(c => 1 / c)];
const SPLIT_TOLERANCE = 0.02;

function splitFactorSinceAnnual(allRows, annualBasis) {
  if (!(annualBasis > 0) || !allRows?.length) return 1;
  const dated = allRows.filter(r => r.filed && r.end && r.val > 0);
  if (!dated.length) return 1;
  const maxFiled = dated.reduce((a, r) => (r.filed > a ? r.filed : a), '');
  const newest = dated.filter(r => r.filed === maxFiled)
                      .sort((a, b) => a.end.localeCompare(b.end)).pop();
  if (!newest) return 1;
  const ratio = newest.val / annualBasis;
  // Buybacks and issuance move the count a few percent a year. Only a clean
  // multiple is a split; anything else unexplained is left alone, so the
  // reconciliation gate still gets to refuse it.
  if (Math.abs(ratio - 1) <= SPLIT_TOLERANCE) return 1;
  for (const c of SPLIT_RATIOS) if (Math.abs(ratio / c - 1) <= SPLIT_TOLERANCE) return c;
  return 1;
}

export async function valuationFacts(cik, refresh = false) {
  const padded = String(cik).padStart(10, '0');
  // Same cache key as screener_data.js `edgarFacts` on purpose — companyfacts
  // is the slowest call in either chain (multi-MB, changes four times a year),
  // so a ticker that was screened today gets its valuation payload for free.
  const d = await cachedJson(`https://data.sec.gov/api/xbrl/companyfacts/CIK${padded}.json`,
    { headers: { 'User-Agent': UA } },
    { ttl: TTL.EDGAR, ms: 15000, refresh, key: `edgar:${padded}` });

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

      // Later filings restate earlier ones; iterating filed-ascending means the
      // most recently filed value for a given period end wins.
      const map = new Map();
      const ends = new Map();
      for (const r of rows) {
        const y = parseInt(r.end.slice(0, 4));
        map.set(y, r.val);
        ends.set(y, r.end);
      }
      // `all` is every row for this unit, unfiltered by form — the 10-Qs are
      // where a split that post-dates the last 10-K becomes visible.
      return { unit: unitKey, map, ends, all: units[unitKey] || [] };
    }
    return null;
  };

  const out = { currency: null, entityName: d.entityName, ends: new Map(), split_adjustment: 1 };
  for (const [field, aliases] of Object.entries(TAGS)) {
    const got = pull(aliases, SPLIT_SENSITIVE.has(field));
    if (!got) continue;
    if (SPLIT_SENSITIVE.has(field) && got.map.size) {
      const latestYear = [...got.map.keys()].sort((a, b) => a - b).pop();
      const factor = splitFactorSinceAnnual(got.all, got.map.get(latestYear));
      if (factor !== 1) {
        for (const [y, v] of got.map) got.map.set(y, v * factor);
        out.split_adjustment = factor;
      }
    }
    out[field] = got.map;
    for (const [y, e] of got.ends) if (!out.ends.has(y)) out.ends.set(y, e);
    // Share counts carry a "shares" unit, not a currency — don't let them set
    // the reporting currency.
    if (/^[A-Z]{3}$/.test(got.unit) && !out.currency && field !== 'shares') out.currency = got.unit;
  }
  return out;
}

// ─── Yahoo fundamentals-timeseries ───────────────────────────────────────────
// The valuation field set differs from the screener's: no cash-flow or balance
// items, but operating income is required. Requested separately rather than
// widening the screener's list, so a change here cannot slow down scoring.
const TS_FIELDS = [
  'annualTotalRevenue', 'annualGrossProfit', 'annualOperatingIncome',
  'annualNetIncome', 'annualDilutedAverageShares',
];

export async function valuationTimeseries(symbol, refresh = false) {
  const { crumb, cookie } = await yahooCrumb();
  const now = Math.floor(Date.now() / 1000);
  const url = `https://query2.finance.yahoo.com/ws/fundamentals-timeseries/v1/finance/timeseries/${encodeURIComponent(symbol)}` +
              `?symbol=${encodeURIComponent(symbol)}&type=${TS_FIELDS.join(',')}` +
              `&period1=0&period2=${now}&crumb=${encodeURIComponent(crumb)}`;
  // period2 is "now" and the crumb rotates — neither belongs in the cache key,
  // or every key is unique and the cache does nothing.
  const d = await cachedJson(url, { headers: { 'User-Agent': BROWSER_UA, 'Cookie': cookie } },
    { ttl: TTL.YF_TIMESERIES, ms: 12000, refresh, key: `yf-ts-val:${symbol}` });
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
  return out;
}

// ─── Resolve ─────────────────────────────────────────────────────────────────

const FIELDS = ['revenue', 'gross_profit', 'op_income', 'net_income', 'shares'];

// EDGAR and Yahoo both report in absolute units. The schema and the whole UI
// speak millions, so convert once, here, at the boundary.
const toM = v => (typeof v === 'number' && isFinite(v)) ? v / 1e6 : null;

/**
 * Everything the valuation prompt and the saved model need, resolved from
 * filings with per-field provenance.
 *
 * Throws only when NOTHING resolved. A partial answer is still useful — the
 * caller decides whether the gaps are tolerable — but a model with no actuals
 * has nothing to stand on and must not reach Gemini, because Gemini will
 * cheerfully invent the missing years.
 */
export async function resolveValuationInputs(symbol, env, refresh = false) {
  const summary = await yahooSummary(symbol, refresh).catch(e => ({ _err: String(e.message) }));
  const marketOk = summary && !summary._err;

  // Name-based CIK resolution needs the company name, so this runs after
  // summary. It is what makes European 20-F filers reachable: "NOVO-B.CO"
  // roots to "NOVO", but Novo Nordisk lists in the US as "NVO".
  const cik = await secCik(symbol, marketOk ? summary.longName : null, refresh).catch(() => null);
  const [edgar, ts] = await Promise.all([
    cik ? valuationFacts(cik, refresh).catch(() => null) : Promise.resolve(null),
    valuationTimeseries(symbol, refresh).catch(() => null),
  ]);

  // ── Merge per field, per year. EDGAR first: it is audited. ──
  const tsAlias = {
    revenue: 'totalRevenue',
    gross_profit: 'grossProfit',
    op_income: 'operatingIncome',
    net_income: 'netIncome',
    shares: 'dilutedAverageShares',
  };

  // Provenance is recorded PER YEAR and collapsed to the baseline year at the
  // end. Recording it during the loop reported whichever source answered the
  // EARLIEST year — NOW's shares read "yahoo-ts" because only Yahoo had 2019,
  // while the FY2023-25 figures the model actually stands on came from EDGAR.
  const rowSources = new Map();
  const years = yearsOf(
    edgar?.revenue, edgar?.net_income,
    ts?.totalRevenue, ts?.netIncome,
  );

  const rows = [];
  for (const y of years) {
    const row = { fiscal_year: y };
    let any = false;
    for (const f of FIELDS) {
      let v = null, src = null;
      if (edgar?.[f]?.has(y)) { v = edgar[f].get(y); src = 'edgar'; }
      else if (ts?.[tsAlias[f]]?.has(y)) { v = ts[tsAlias[f]].get(y); src = 'yahoo-ts'; }
      row[f] = toM(v);
      if (row[f] !== null) {
        any = true;
        if (!rowSources.has(y)) rowSources.set(y, {});
        rowSources.get(y)[f] = src;
      }
    }
    if (any) rows.push(row);
  }

  // Keep the last 7 fiscal years: 3 become the Y-2/Y-1/Y0 baseline, the rest
  // give the model (and the chart) a trend to reason about.
  const history = rows.slice(-7);

  if (history.length < 2) {
    throw new Error(
      `No filed financials for ${symbol} (edgar=${!!edgar} cik=${cik || 'none'} timeseries=${!!ts}). ` +
      `Refusing to model from recalled figures.`
    );
  }

  // ── Baseline: the three most recent years with a usable revenue AND share
  // count. A year missing either cannot anchor a projection — projectScenario()
  // divides by both.
  const usable = history.filter(r => r.revenue > 0 && r.shares > 0 && r.net_income !== null);
  const actuals = usable.slice(-3);

  if (!actuals.length) {
    throw new Error(`Resolved ${history.length} fiscal years for ${symbol} but none had revenue, shares and net income together.`);
  }

  const y0 = actuals[actuals.length - 1];

  // Collapse provenance to the baseline year, and say so when the share count
  // had to be rebased for a split the annual report predates.
  const sources = { ...(rowSources.get(y0.fiscal_year) || {}) };
  const splitAdj = edgar?.split_adjustment ?? 1;
  if (splitAdj !== 1 && sources.shares) {
    sources.shares = `${sources.shares}(split-adjusted ${splitAdj}x)`;
  }

  // ── Reconciliation against the market ──────────────────────────────────────
  // The check that would have stopped the ServiceNow model. Everything above
  // can be individually plausible and still collectively wrong; this compares
  // the result against a number nobody had to derive.
  const impliedShares = (marketOk && summary.mktcap_native && summary.price)
    ? summary.mktcap_native / summary.price / 1e6
    : null;

  let recon = { ok: true, status: 'unchecked', ratio: null, implied_shares: impliedShares, reported_shares: y0.shares };
  if (impliedShares && y0.shares > 0) {
    const ratio = impliedShares / y0.shares;
    const drift = Math.abs(ratio - 1);
    const status = drift > RECON_FAIL ? 'fail' : drift > RECON_WARN ? 'warn' : 'ok';
    recon = {
      ok: status !== 'fail',
      status,
      ratio: Math.round(ratio * 1000) / 1000,
      implied_shares: Math.round(impliedShares * 10) / 10,
      reported_shares: y0.shares,
      note: status === 'ok'
        ? 'Reported diluted shares reconcile with market cap / price.'
        : `Reported diluted shares (${y0.shares.toFixed(0)}M) imply a market cap ${ratio.toFixed(2)}x away from the reported one ` +
          `(${impliedShares.toFixed(0)}M implied). A near-integer ratio means an unadjusted stock split; ` +
          `anything else means a units or period mismatch.`,
    };
  }

  // How stale is Y0? At the time of writing this comment the app was being used
  // in August, when a December-year-end company's last 10-K is eight months old
  // and two quarters have been reported since. The prompt is told, so the
  // scenarios can start from where the company actually is rather than treating
  // a stale year-end as today.
  const y0End = edgar?.ends?.get(y0.fiscal_year) || `${y0.fiscal_year}-12-31`;
  const monthsStale = Math.round((Date.now() - new Date(y0End).getTime()) / 864e5 / 30.44);

  // Derived market anchors. `pe_trailing` is the one that matters most: it is
  // what stops the exit-multiple distribution being recalled from whatever the
  // stock traded at during training, which is how Adobe's P/E came back as a
  // 2023-era 46.5 in the screener.
  const impliedTtmEps = (marketOk && summary.price && summary.pe_trailing)
    ? summary.price / summary.pe_trailing
    : null;

  return {
    symbol,
    company: marketOk ? summary.longName : null,
    sector: marketOk ? summary.sector : null,
    industry: marketOk ? summary.industry : null,
    // Reporting currency comes from the filing, NOT from the quote: a company
    // can report in one currency and trade in another (Novo reports DKK; the
    // ADR trades USD). Getting this backwards scales the whole model.
    currency: edgar?.currency || (marketOk ? summary.currency : 'USD'),
    quote_currency: marketOk ? summary.currency : null,
    price: marketOk ? summary.price : null,
    mktcap_native: marketOk ? summary.mktcap_native : null,
    pe_trailing: marketOk ? summary.pe_trailing : null,
    gross_margin_ttm: marketOk ? summary.gross_margin : null,
    implied_ttm_eps: impliedTtmEps,
    actuals,
    history,
    reconciliation: recon,
    y0_period_end: y0End,
    months_since_y0: monthsStale,
    diagnostics: {
      edgar_cik: cik || null,
      edgar_ok: !!edgar,
      ts_ok: !!ts,
      ts_fields: ts ? Object.keys(ts) : [],
      market_ok: marketOk,
      market_err: summary?._err || null,
      field_sources: sources,
      split_adjustment: splitAdj,
      years_resolved: history.map(r => r.fiscal_year),
      reconciliation: recon.status,
      refresh,
      cache: statsSnapshot(),
    },
  };
}
