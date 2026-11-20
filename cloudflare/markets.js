// markets.js — index movers: which constituents actually moved the index.
//
// ?index_movers=SP500|NDX|DJI|OMXC25[&refresh=1]
//
// "Top/bottom" on most sites ranks constituents by their own % change. That
// answers the wrong question: a 9% move in a 0.02%-weight name moves the
// S&P 500 by less than a 1% move in Nvidia. Here every constituent is ranked by
// its CONTRIBUTION to the index's move over the latest session:
//
//     contribution_i = w_i × r_i        (fraction of the index, i.e. pp / 100)
//     w_i            = cap_i(prev) / Σ cap_j(prev)     (cap-weighted indices)
//                    = price_i(prev) / Σ price_j(prev) (Dow — price-weighted)
//
// Weights are taken at the PREVIOUS close (cap now / (1 + r)), so Σ contribution
// is exactly the cap-weighted return of the basket. The response returns that
// sum next to the index's own reported move as `explained` vs `index.chgPct`;
// the gap is the honest measure of how good the approximation is, because
// these weights are full market cap — not the free-float, capped weights the
// index providers actually use (OMXC25 and Nasdaq-100 are both capped).
//
// Data: one Yahoo v7 batch quote per ~100 symbols, WITH the cookie+crumb
// handshake. The v7 batch was removed from ?symbols= in v22 because it returned
// 401 — without a crumb. With one it returns marketCap, which the chart
// endpoint never carries, so there is no cheaper way to weight 500 names.

import { yahooCrumb } from './screener_data.js';
import { cachedValue } from './screener_cache.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const MOVERS_TTL = 60;                 // seconds — same as quotes
const CONSTITUENTS_TTL = 24 * 3600;    // FMP constituent list
const CHUNK = 100;

// Second share classes whose Yahoo marketCap is the WHOLE company. Keeping
// both would count Alphabet twice. The secondary's move is dropped; the
// primary row carries the company.
const DUAL_CLASS_DROP = new Set(['GOOG', 'FOX', 'NWS', 'MAERSK-A.CO']);

// ── Static constituent lists ────────────────────────────────────────────────
// Fallback for SP500/NDX/DJI when FMP's constituent endpoint is unavailable,
// and the only source for OMXC25 (no free API publishes it). Stale or delisted
// symbols are harmless — Yahoo returns nothing and they drop out of `coverage`.
const STATIC = {
  OMXC25: [
    'NOVO-B','DSV','NSIS-B','DANSKE','MAERSK-B','CARL-B','COLO-B','GMAB','ORSTED','VWS',
    'PNDORA','DEMANT','GN','ISS','JYSK','NDA-DK','RBREW','ROCK-B','TRYG','ZEAL',
    'BAVA','AMBU-B','NKT','FLS',
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

// FMP endpoints for the three US indices. A 402/403 (plan) or an implausibly
// short list falls back to STATIC, and `diagnostics.source` says which ran.
const FMP_CONSTITUENTS = {
  SP500: { path: 'sp500-constituent',   min: 450 },
  NDX:   { path: 'nasdaq-constituent',  min: 90  },
  DJI:   { path: 'dowjones-constituent', min: 28 },
};

export const INDEX_DEFS = {
  SP500:  { symbol: '^GSPC',   name: 'S&P 500',    weighting: 'cap'   },
  NDX:    { symbol: '^NDX',    name: 'Nasdaq 100', weighting: 'cap'   },
  DJI:    { symbol: '^DJI',    name: 'Dow Jones',  weighting: 'price' },
  OMXC25: { symbol: '^OMXC25', name: 'OMX C25',    weighting: 'cap'   },
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
      return { symbols: STATIC[key], source: `static (fmp: ${String(e.message).slice(0, 60)})` };
    }
  }
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

export async function indexMovers(key, env, refresh = false) {
  const def = INDEX_DEFS[key];
  if (!def) throw new Error(`Unknown index ${key}`);

  return cachedValue(`idx-movers:${key}`, MOVERS_TTL, refresh, async () => {
    const { symbols: rawSyms, source } = await constituents(key, env, refresh);
    const syms = [...new Set(rawSyms)].filter(s => !DUAL_CLASS_DROP.has(s));
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
    const items = [];
    for (const s of syms) {
      const q = bySym.get(s.toUpperCase());
      if (!q) continue;
      const price = q.regularMarketPrice, prev = q.regularMarketPreviousClose;
      if (price == null || !prev) continue;
      // Delisted / acquired symbols can still return a frozen quote. Anything
      // last priced more than a week before the index is not a live member.
      if (index.quoteTime && q.regularMarketTime && index.quoteTime - q.regularMarketTime > 7 * 86400) continue;
      const r = price / prev - 1;
      let base;
      if (def.weighting === 'price') base = prev;
      else {
        if (!q.marketCap) continue;
        base = q.marketCap / (1 + r);          // cap at previous close
      }
      items.push({
        symbol: s,
        name: q.shortName || q.longName || s,
        currency: q.currency || null,
        price, prevClose: prev, chgPct: r,
        mcap: q.marketCap ?? null,
        quoteTime: q.regularMarketTime ?? null,
        _base: base,
      });
    }

    const total = items.reduce((a, x) => a + x._base, 0);
    let explained = 0, up = 0, down = 0;
    for (const x of items) {
      x.weight  = total ? x._base / total : 0;
      x.contrib = x.weight * x.chgPct;
      x.contribPts = index.prevClose != null ? x.contrib * index.prevClose : null;
      explained += x.contrib;
      if (x.chgPct > 0) up++; else if (x.chgPct < 0) down++;
      delete x._base;
    }
    items.sort((a, b) => b.contrib - a.contrib);

    return {
      key,
      weighting: def.weighting,
      index,
      explained,
      breadth: { up, down, unchanged: items.length - up - down },
      coverage: { priced: items.length, listed: syms.length },
      constituents: items,
      generatedAt: Date.now(),
      diagnostics: { source, yahooStatuses: statuses, rows: rows.length },
    };
  });
}
