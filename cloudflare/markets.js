// markets.js — index movers: which constituents actually moved the index.
//
// ?index_movers=SP500|NDX|DJI|OMXC25|DAX[&refresh=1]
//
// "Top/bottom" on most sites ranks constituents by their own % change. That
// answers the wrong question: a 9% move in a 0.02%-weight name moves the
// S&P 500 by less than a 1% move in Nvidia. Here every constituent is ranked by
// its CONTRIBUTION to the index's move over the latest session:
//
//     contribution_i = w_i × r_i        (fraction of the index, i.e. pp / 100)
//
// Where w_i comes from, best first (`weights.basis` in the response):
//   etf        — the index's real weights, from an iShares ETF holdings file
//                (SP500, NDX, DAX). Free-float and capping included.
//   price      — price at previous close (DJI, which is price-weighted).
//   published  — the provider's own monthly weight file, as of its date
//                (OMXC25 — no ETF tracks the plain C25). See PUBLISHED_WEIGHTS.
//   cap-capped — full market cap at previous close, 15% issuer cap. Only a
//                fallback: for C25 it put Nordea at 12% against an actual 1.4%,
//                because Nasdaq weights by free float.
//   cap        — full market cap; fallback when an ETF file is unavailable.
//
// The response returns Σ contribution as `explained` next to the index's own
// move (`index.chgPct`); the gap is the honest measure of the approximation.
//
// Prices: one Yahoo v7 batch quote per ~100 symbols, WITH the cookie+crumb
// handshake. The v7 batch was removed from ?symbols= in v22 because it returned
// 401 — without a crumb. With one it also returns marketCap.

import { yahooCrumb } from './screener_data.js';
import { cachedValue } from './screener_cache.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const MOVERS_TTL = 60;                 // seconds — same as quotes
const CONSTITUENTS_TTL = 24 * 3600;    // FMP constituent list
const CHUNK = 100;

// Second share classes whose Yahoo marketCap is the WHOLE company. Keeping
// both would count Alphabet twice. The secondary's move is dropped; the
// primary row carries the company. Only applies to market-cap weighting —
// an ETF holdings file weights each class on its own, so nothing is dropped.
const DUAL_CLASS_DROP = new Set(['GOOG', 'FOX', 'NWS', 'MAERSK-A.CO']);

// ── Static constituent lists ────────────────────────────────────────────────
// Fallback for SP500/NDX when the ETF holdings file is unavailable, the only
// source for DJI (price-weighted — membership is all it needs) and for OMXC25
// (no free source publishes its weights). Stale or delisted
// symbols are harmless — Yahoo returns nothing and they drop out of `coverage`.
const STATIC = {
  // Official membership from Nasdaq GIW (indexes.nasdaq.com/Index/Weighting/OMXC25),
  // checked 2026-11-20. Changes at the semi-annual reviews — update by hand.
  // MAERSK-A is a member but is folded into MAERSK-B (one issuer, see
  // DUAL_CLASS_DROP and the 15% issuer cap).
  OMXC25: [
    'MAERSK-A','MAERSK-B','ALSYDB','AMBU-B','CARL-B','COLO-B','DANSKE','DEMANT','DSV','FLS',
    'GMAB','GN','ISS','JYSK','NKT','NDA-DK','NOVO-B','NSIS-B','ORSTED','PNDORA',
    'ROCK-B','RBREW','TRYG','VWS','ZEAL',
  ].map(s => `${s}.CO`),

  DJI: [
    'AAPL','AMGN','AMZN','AXP','BA','CAT','CRM','CSCO','CVX','DIS','GS','HD','HON','IBM','JNJ',
    'JPM','KO','MCD','MMM','MRK','MSFT','NKE','NVDA','PG','SHW','TRV','UNH','V','VZ','WMT',
  ],

  NDX: [
    'AAPL','MSFT','NVDA','AMZN','AVGO','META','GOOGL','GOOG','TSLA','COST','NFLX','PLTR','ASML',
    'TMUS','CSCO','AMD','AZN','LIN','PEP','INTU','ISRG','TXN','QCOM','BKNG','AMGN','ADBE','AMAT',
    'HON','SHOP','ARM','PDD','GILD','CMCSA','PANW','MU','LRCX','ADP','KLAC','ADI','CRWD','VRTX',
    'APP','SBUX','INTC','MELI','CEG','DASH','MSTR','CDNS','SNPS','ORLY','CTAS','MAR','ABNB',
    'MDLZ','PYPL','FTNT','REGN','MRVL','ADSK','WDAY','CSX','AXON','ROP','MNST','NXPI','PCAR',
    'AEP','CHTR','FAST','DDOG','PAYX','ZS','KDP','ROST','CPRT','IDXX','EA','TTWO','XEL','EXC',
    'VRSK','BKR','CCEP','FANG','CTSH','GEHC','KHC','ODFL','LULU','DXCM','CSGP','TTD','ON',
    'MCHP','BIIB','CDW','GFS','WBD','TRI','TEAM','MDB',
  ],

  SP500: [
    'AAPL','MSFT','NVDA','AMZN','META','GOOGL','GOOG','BRK-B','AVGO','TSLA','LLY','JPM','V','UNH',
    'XOM','MA','COST','WMT','PG','JNJ','HD','ORCL','ABBV','NFLX','BAC','CRM','KO','CVX','MRK',
    'AMD','PEP','TMO','LIN','ADBE','CSCO','ACN','MCD','WFC','ABT','PM','IBM','GE','DHR','TXN',
    'QCOM','INTU','NOW','CAT','AMGN','VZ','ISRG','DIS','PFE','NEE','CMCSA','GS','UNP','SPGI',
    'RTX','AXP','T','LOW','HON','AMAT','BKNG','PGR','UBER','MS','COP','ETN','BLK','SYK','TJX',
    'ELV','C','BSX','VRTX','LMT','SCHW','MDT','PLD','REGN','ADP','MMC','CB','PANW','ADI','BX',
    'DE','KLAC','LRCX','MU','SBUX','GILD','BMY','CI','FI','MDLZ','SO','AMT','TMUS','ANET','INTC',
    'MO','DUK','ICE','SHW','CME','ZTS','PH','PLTR','CRWD','APH','KKR','EQIX','TT','WM','MCK',
    'CDNS','SNPS','ABNB','CTAS','PYPL','MSI','AON','ITW','CL','USB','PNC','HCA','GD','NOC',
    'MMM','EOG','CMG','ORLY','TDG','WELL','BDX','FDX','APD','CSX','MAR','ECL','EMR','AJG','MCO',
    'CVS','SLB','TGT','NSC','PSX','MPC','FCX','HLT','RCL','CARR','DLR','COF','TFC','GM','ROP',
    'AFL','OKE','WMB','SRE','AZO','TRV','ADSK','PCAR','NXPI','SPG','AEP','BK','PSA','FTNT','MET',
    'CEG','ALL','JCI','O','GWW','DHI','KMB','AMP','URI','FAST','CPRT','KMI','PAYX','D','LHX',
    'MSCI','PWR','HWM','ROST','FICO','AIG','OXY','CCI','PRU','LEN','VLO','KVUE','F','COR','PEG',
    'GEV','DASH','AXON','VST','TEL','KDP','IT','EW','CTVA','CMI','IR','A','OTIS','EA',
    'ODFL','ACGL','IDXX','KR','EXC','VRSK','NUE','YUM','GIS','SYY','CBRE','XEL','CTSH',
    'GEHC','HPQ','KHC','DOW','LULU','MNST','IQV','RMD','MCHP','GLW','ED','DD','MLM','VMC','EXR',
    'BKR','HIG','FANG','DAL','CSGP','WAB','EIX','HUM','XYL','AVB','TRGP','EFX','WTW','NDAQ',
    'IRM','EBAY','ROK','CAH','ON','MTB','LYV','DXCM','WEC','FITB','TSCO','CHTR','PPG',
    'GPN','EQR','BRO','DECK','HPE','KEYS','MPWR','NVR','AWK','DOV','STT','VTR','PHM','FTV','TTWO',
    'ETR','RJF','HAL','BR','SBAC','CDW','TYL','VICI','IFF','DTE','UAL','ADM','LDOS','CHD','HSY',
    'TROW','GDDY','WST','BIIB','NTAP','FE','CCL','PPL','EXPE','STE','ES','HUBB','SW','ZBH','LYB',
    'AEE','TPL','CINF','WDC','PTC','WY','STX','HBAN','RF','INVH','CPAY','K','CBOE','ATO','SMCI',
    'BLDR','WAT','ERIE','LH','MKC','CNP','CMS','CLX','BBY','NTRS','DRI','ESS','OMC','PKG','TDY',
    'ZBRA','STLD','LUV','MAA','CFG','PFG','ULTA','CTRA','IP','EQT','FDS','LVS','GPC','SNA','HOLX',
    'DGX','WRB','J','BALL','KIM','MOH','EXPD','ARE','TSN','L','MAS','AVY','IEX','FSLR','TER','DPZ',
    'NI','TRMB','EG','ALGN','LNT','PNR','BAX','VTRS','DLTR','CF','JBL','KEY','DG','VRSN','AMCR',
    'APTV','EVRG','RVTY','POOL','UDR','NDSN','SWKS','ROL','CPT','JBHT','INCY','EL','AKAM','SWK',
    'CAG','DVA','CPB','CHRW','REG','EPAM','HST','JKHY','BXP','ALLE','SJM','KMX','NCLH','TECH',
    'UHS','FFIV','EMN','LKQ','DAY','IPG','TAP','BG','AIZ','TPR','PAYC','SOLV','NWSA',
    'NWS','HRL','CRL','GNRC','LW','ENPH','AOS','HAS','FRT','HII','MGM','CZR','MKTX','AES',
    'GL','TFX','MTCH','BWA','HSIC','APA','RL','WYNN','MOS','IVZ','MHK','FMC','BEN','QRVO',
    'FOXA','FOX','WBD','DVN','MRNA','ALB','BF-B','PSKY','NRG','HUBB','COO','ZM','DELL','APP','WSM','TKO',
    'EXE','LII','DDOG','COIN','HOOD','IBKR','XYZ','TTD','WDAY',
  ],
};

// ── Published index weights ──────────────────────────────────────────────────
// Nasdaq publishes C25's weights once a month for UCITS compliance:
// https://www.nasdaq.com/docs/global-indexes/OMXC25 ("Data as of"). Checked
// against 2026-11-20: these weights explained −1.281% of a −1.273% day, where
// capped market cap explained −1.203%. Refresh monthly; when this goes stale
// the error grows with price drift but stays far below the market-cap estimate.
const PUBLISHED_WEIGHTS = {
  OMXC25: {
    asOf: '2026-11-02',
    source: 'Nasdaq OMXC25 weights',
    suffix: '.CO',
    weights: {
      'MAERSK-A': 3.54, 'MAERSK-B': 3.25, 'ALSYDB': 2.52, 'AMBU-B': 0.69, 'CARL-B': 4.21,
      'COLO-B': 3.37, 'DANSKE': 9.69, 'DEMANT': 1.45, 'DSV': 12.50, 'FLS': 1.05,
      'GMAB': 10.42, 'GN': 0.66, 'ISS': 1.63, 'JYSK': 2.00, 'NKT': 2.06,
      'NDA-DK': 1.42, 'NOVO-B': 12.70, 'NSIS-B': 7.28, 'ORSTED': 3.31, 'PNDORA': 2.94,
      'ROCK-B': 0.87, 'RBREW': 0.86, 'TRYG': 2.21, 'VWS': 8.72, 'ZEAL': 0.68,
    },
  },
};

// FMP constituent lists — second fallback for the US indices, behind the ETF
// holdings file. A 402/403 (plan) or an implausibly short list falls through
// to STATIC, and `diagnostics.source` says which ran.
const FMP_CONSTITUENTS = {
  SP500: { path: 'sp500-constituent',   min: 450 },
  NDX:   { path: 'nasdaq-constituent',  min: 90  },
  DJI:   { path: 'dowjones-constituent', min: 28 },
};

// ── ETF holdings: the index's REAL weights ────────────────────────────────────
// A physically replicating ETF holds the index at the provider's own weights —
// free-float adjusted and capped — and publishes them daily. iShares' product
// page offers a "full fund data" download (an XML spreadsheet) whose Holdings
// sheet has issuer ticker and weight. It is the same file behind the page's
// public "Herunterladen" button; no login, no key.
//
//   SP500 → iShares Core S&P 500 UCITS (CSPX)   253743
//   NDX   → iShares NASDAQ 100 UCITS (CNDX)     253741
//   DAX   → iShares Core DAX UCITS (DE) (EXS1)  251464
//
// The file is T-1/T-2. Weights drift with prices in between; over one or two
// sessions that is far smaller than the error of guessing free float.
const ISHARES_DOC = 'https://www.blackrock.com/varnish-api/uk-retail01-product-data/product-data/api/v1/get-fund-document' +
  '?appSubType=ISHARES&appType=PRODUCT_PAGE&component=fundDownloadV2&locale=de_DE&targetSite=de-ishares-v2&userType=individual&portfolioId=';
const ETF_SOURCES = {
  SP500: { portfolioId: '253743', fund: 'iShares CSPX', toYahoo: t => t.replace(/\s+/g, '-') },
  NDX:   { portfolioId: '253741', fund: 'iShares CNDX', toYahoo: t => t.replace(/\s+/g, '-') },
  DAX:   { portfolioId: '251464', fund: 'iShares EXS1', toYahoo: t => `${t.replace(/\s+/g, '-')}.DE` },
};
const ETF_TTL = 12 * 3600;

export const INDEX_DEFS = {
  SP500:  { symbol: '^GSPC',   name: 'S&P 500',    weighting: 'cap'   },
  NDX:    { symbol: '^NDX',    name: 'Nasdaq 100', weighting: 'cap'   },
  DJI:    { symbol: '^DJI',    name: 'Dow Jones',  weighting: 'price' },
  OMXC25: { symbol: '^OMXC25', name: 'OMX C25',    weighting: 'cap', issuerCap: 0.15 },
  DAX:    { symbol: '^GDAXI',  name: 'DAX',        weighting: 'cap'   },
};

async function fetchJson(url, opts = {}, ms = 8000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal });
    return { status: res.status, data: res.ok ? await res.json() : null };
  } catch (e) {
    return { status: 0, data: null, error: String(e.message || e) };
  } finally {
    clearTimeout(timer);
  }
}

const xmlText = s => s.replace(/<[^>]+>/g, '')
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();

// German-locale number: "1.234,56" → 1234.56
const deNum = s => {
  const v = parseFloat(String(s).replace(/\./g, '').replace(',', '.'));
  return isFinite(v) ? v : null;
};

// Parse the Holdings worksheet of an iShares SpreadsheetML workbook.
// Only the Holdings sheet is scanned — the file is ~2–3 MB and the rest of it
// (NAV history, performance) is irrelevant here.
export function parseIsharesHoldings(xml) {
  const start = xml.indexOf('ss:Name="Holdings"');
  if (start < 0) throw new Error('no Holdings sheet');
  const end = xml.indexOf('</ss:Worksheet>', start);
  const sheet = xml.slice(start, end > 0 ? end : undefined);

  const rows = [];
  for (const rm of sheet.matchAll(/<ss:Row[^>]*>([\s\S]*?)<\/ss:Row>/g)) {
    const cells = [];
    for (const cm of rm[1].matchAll(/<ss:Cell([^>]*?)(?:\/>|>([\s\S]*?)<\/ss:Cell>)/g)) {
      const idx = cm[1].match(/ss:Index="(\d+)"/);
      if (idx) while (cells.length < Number(idx[1]) - 1) cells.push('');
      cells.push(cm[2] ? xmlText(cm[2]) : '');
    }
    rows.push(cells);
  }

  let asOf = null;
  const hi = rows.findIndex(r => r.some(c => /^(Emittententicker|Issuer Ticker|Ticker)$/i.test(c)));
  if (hi < 0) throw new Error('no header row');
  for (const r of rows.slice(0, hi)) { const i = r.findIndex(c => /^(Per|As of)$/i.test(c)); if (i >= 0 && r[i + 1]) asOf = r[i + 1]; }
  const h = rows[hi];
  const col = re => h.findIndex(c => re.test(c));
  const cT = col(/^(Emittententicker|Issuer Ticker|Ticker)$/i), cN = col(/^Name$/i),
        cW = col(/^(Gewichtung|Weight) \(%\)$/i), cA = col(/^(Anlageklasse|Asset Class)$/i);
  if (cT < 0 || cW < 0) throw new Error('missing ticker/weight column');

  const holdings = [];
  for (const r of rows.slice(hi + 1)) {
    const t = r[cT], w = deNum(r[cW]);
    if (!t || w == null || w <= 0) continue;
    if (cA >= 0 && !/^(Aktien|Equity)$/i.test(r[cA] || '')) continue;   // drop cash, futures
    holdings.push({ ticker: t, name: cN >= 0 ? r[cN] : t, weight: w / 100 });
  }
  if (holdings.length < 20) throw new Error(`only ${holdings.length} equity rows`);
  return { asOf, holdings };
}

async function etfHoldings(key, refresh) {
  const src = ETF_SOURCES[key];
  if (!src) return null;
  return cachedValue(`etf-holdings:${src.portfolioId}`, ETF_TTL, refresh, async () => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    try {
      const res = await fetch(ISHARES_DOC + src.portfolioId, { headers: { 'User-Agent': UA }, signal: ctrl.signal });
      if (!res.ok) throw new Error(`ishares ${res.status}`);
      const { asOf, holdings } = parseIsharesHoldings(await res.text());
      return {
        fund: src.fund, asOf,
        holdings: holdings.map(h => ({ symbol: src.toYahoo(h.ticker), name: h.name, weight: h.weight })),
      };
    } finally {
      clearTimeout(timer);
    }
  });
}

async function constituents(key, env, refresh) {
  const fmp = FMP_CONSTITUENTS[key];
  if (fmp && env?.FMP_API_KEY) {
    try {
      const list = await cachedValue(`idx-constituents:${key}`, CONSTITUENTS_TTL, refresh, async () => {
        const r = await fetchJson(`https://financialmodelingprep.com/stable/${fmp.path}?apikey=${env.FMP_API_KEY}`);
        const syms = Array.isArray(r.data) ? r.data.map(x => String(x.symbol || '').replace(/\./g, '-')).filter(Boolean) : [];
        if (syms.length < fmp.min) throw new Error(`fmp ${r.status} (${syms.length} symbols)`);
        return syms;
      });
      return { symbols: list, source: 'fmp' };
    } catch (e) {
      if (STATIC[key]) return { symbols: STATIC[key], source: `static (fmp: ${String(e.message).slice(0, 60)})` };
    }
  }
  if (!STATIC[key]) throw new Error(`no constituent source for ${key}`);
  return { symbols: STATIC[key], source: 'static' };
}

// Yahoo v7 batch quote, crumb-authenticated, chunked.
async function yahooBatch(symbols) {
  const { crumb, cookie } = await yahooCrumb();
  const fields = 'regularMarketPrice,regularMarketPreviousClose,regularMarketChangePercent,marketCap,shortName,longName,currency,regularMarketTime';
  const chunks = [];
  for (let i = 0; i < symbols.length; i += CHUNK) chunks.push(symbols.slice(i, i + CHUNK));
  const statuses = [];
  const results = await Promise.all(chunks.map(async c => {
    const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(c.join(','))}` +
                `&fields=${fields}&crumb=${encodeURIComponent(crumb)}`;
    const r = await fetchJson(url, { headers: { 'User-Agent': UA, 'Cookie': cookie, 'Accept': 'application/json' } });
    statuses.push(r.status);
    return r.data?.quoteResponse?.result || [];
  }));
  return { rows: results.flat(), statuses };
}

// Cap any single weight at `cap` and hand the excess to the uncapped names in
// proportion to their weight, repeating until nothing exceeds it — the
// standard capping step in index methodologies (OMXC25: 15% per issuer).
function applyCap(items, cap) {
  for (let pass = 0; pass < 20; pass++) {
    const over = items.filter(x => x.weight > cap + 1e-12);
    if (!over.length) return;
    const excess = over.reduce((a, x) => a + x.weight - cap, 0);
    over.forEach(x => { x.weight = cap; x.capped = true; });
    const free = items.filter(x => !x.capped);
    const freeW = free.reduce((a, x) => a + x.weight, 0);
    if (!freeW) return;
    free.forEach(x => { x.weight += excess * x.weight / freeW; });
  }
}

export async function indexMovers(key, env, refresh = false) {
  const def = INDEX_DEFS[key];
  if (!def) throw new Error(`Unknown index ${key}`);

  return cachedValue(`idx-movers:${key}`, MOVERS_TTL, refresh, async () => {
    // 1) Weights from the ETF holdings file where there is one.
    let etf = null, etfError = null;
    try { etf = await etfHoldings(key, refresh); } catch (e) { etfError = String(e.message || e).slice(0, 120); }

    // 2) Otherwise the provider's published monthly weights, if we carry them.
    const pub = !etf && PUBLISHED_WEIGHTS[key];

    let syms, source, fileWeight = null, weightsBasis, asOf = null;
    if (etf || pub) {
      const holdings = etf
        ? etf.holdings
        : Object.entries(pub.weights).map(([t, w]) => ({ symbol: t + (pub.suffix || ''), name: t, weight: w / 100 }));
      fileWeight = new Map(holdings.map(h => [h.symbol.toUpperCase(), h]));
      syms = [...fileWeight.keys()];
      source = etf ? `${etf.fund} holdings` : pub.source + (etfError ? ` (etf: ${etfError})` : '');
      weightsBasis = etf ? 'etf' : 'published';
      asOf = etf ? etf.asOf : pub.asOf;
    } else {
      const c = await constituents(key, env, refresh);
      syms = [...new Set(c.symbols)].filter(s => !DUAL_CLASS_DROP.has(s));
      source = c.source + (etfError ? ` (etf: ${etfError})` : '');
      weightsBasis = def.weighting === 'price' ? 'price' : def.issuerCap ? 'cap-capped' : 'cap';
    }

    const { rows, statuses } = await yahooBatch([def.symbol, ...syms]);
    const bySym = new Map(rows.map(r => [String(r.symbol).toUpperCase(), r]));

    const idx = bySym.get(def.symbol.toUpperCase());
    const index = idx ? {
      symbol:    def.symbol,
      name:      def.name,
      price:     idx.regularMarketPrice ?? null,
      prevClose: idx.regularMarketPreviousClose ?? null,
      chgPct:    (idx.regularMarketPrice != null && idx.regularMarketPreviousClose)
                   ? idx.regularMarketPrice / idx.regularMarketPreviousClose - 1 : null,
      quoteTime: idx.regularMarketTime ?? null,
    } : { symbol: def.symbol, name: def.name, price: null, prevClose: null, chgPct: null, quoteTime: null };

    // Per-constituent return from price vs previous close (fraction).
    const items = [], unpriced = [];
    for (const s of syms) {
      const q = bySym.get(s.toUpperCase());
      const price = q?.regularMarketPrice, prev = q?.regularMarketPreviousClose;
      if (!q || price == null || !prev) { unpriced.push(s); continue; }
      // Delisted / acquired symbols can still return a frozen quote. Anything
      // last priced more than a week before the index is not a live member.
      if (index.quoteTime && q.regularMarketTime && index.quoteTime - q.regularMarketTime > 7 * 86400) { unpriced.push(s); continue; }
      const r = price / prev - 1;
      let base;
      if (fileWeight) base = fileWeight.get(s.toUpperCase()).weight;
      else if (weightsBasis === 'price') base = prev;
      else {
        if (!q.marketCap) { unpriced.push(s); continue; }
        base = q.marketCap / (1 + r);          // cap at previous close
      }
      items.push({
        symbol: s,
        name: q.shortName || q.longName || fileWeight?.get(s.toUpperCase())?.name || s,
        currency: q.currency || null,
        price, prevClose: prev, chgPct: r,
        mcap: q.marketCap ?? null,
        quoteTime: q.regularMarketTime ?? null,
        _base: base,
      });
    }

    // Normalise over what was priced, so weights always sum to 1.
    const total = items.reduce((a, x) => a + x._base, 0);
    for (const x of items) { x.weight = total ? x._base / total : 0; delete x._base; }
    if (weightsBasis === 'cap-capped') applyCap(items, def.issuerCap);

    let explained = 0, up = 0, down = 0;
    for (const x of items) {
      x.contrib = x.weight * x.chgPct;
      x.contribPts = index.prevClose != null ? x.contrib * index.prevClose : null;
      explained += x.contrib;
      if (x.chgPct > 0) up++; else if (x.chgPct < 0) down++;
    }
    items.sort((a, b) => b.contrib - a.contrib);

    return {
      key,
      weighting: def.weighting,
      weights: {
        basis: weightsBasis,                       // etf | published | cap | cap-capped | price
        source,
        asOf,
        coveredInFile: fileWeight ? items.reduce((a, x) => a + (fileWeight.get(x.symbol.toUpperCase())?.weight || 0), 0) : null,
      },
      index,
      explained,
      breadth: { up, down, unchanged: items.length - up - down },
      coverage: { priced: items.length, listed: syms.length },
      constituents: items,
      generatedAt: Date.now(),
      diagnostics: { source, yahooStatuses: statuses, rows: rows.length, unpriced: unpriced.slice(0, 40), etfError },
    };
  });
}
