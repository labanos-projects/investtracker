// v7 – fix stale intraday change%: don't trust Yahoo's regularMarketChangePercent
// v8 – add ?score_ticker= endpoint
// v10 – Gemini scores all 18 criteria (YF blocks fundamental data from CF Workers)
// v11 – screener rework: computed fundamentals (EDGAR/Yahoo/FMP) + grounded AI,
//       0/1/2/null scoring with a dynamic denominator, multibagger rubric.
// v12 – screener upstreams cached; ?refresh=1 bypasses every layer.
// v13 – screener: verify the token before scoring, and report whether the
//       result actually persisted instead of swallowing the failure.
// v14 – add ?quote= : the full ticker snapshot the shared company page needs.
// v15 – valuation rework. Actuals from filings via the per-field waterfall;
//       Gemini supplies forward assumptions only, reconciled against market cap.
// v16 – ?generate_valuation= and ?yh_symbol= are two different symbols: a
//       storage key ("ASML") and a listing ("ASML.AS").
// v17 – news rework. ?news= passed the exchange-suffixed listing symbol to a
//       free-text search endpoint; NOVO-B.CO matched nothing.
// v18 – ?symbols= returns WHEN each price is from. It returned price and
//       change% and nothing else, so the client used `new Date()` under the
//       label "Prices as of" and every quote looked current.
// v19 – capped edge caching at 60s. Achieved nothing.
// v20 – added a minute-bucketed cache buster. Also achieved nothing.
// v21 – ?symbols=SYM&diag=1, and with it the answer both attempts lacked:
//
//         CPH   chart 200, cf-cache MISS, age 1, date now, 32,969 bytes,
//               regularMarketTime 376 MINUTES old
//         IAD   chart 200, cf-cache MISS, age 1, date now, 38,999 bytes,
//               regularMarketTime 1 minute old
//
//       Yahoo's Copenhagen edge stopped refreshing at ~09:40 and kept serving
//       one snapshot — website included. Not a cache we own; Yahoo's own header
//       says max-age=10.
// v22 – removed the v7 batch branch (401 everywhere) and probed FMP rather
//       than wiring it in blind.
// v23 – probed alternate hosts and third parties. Every Yahoo surface stale
//       together; FMP 402 on .CO; Finnhub and Twelve Data US-only on free
//       tiers. No free API quotes Nasdaq Copenhagen.
// v24 – GOOGLEFINANCE does, so google-sheets/ publishes a sheet as a JSON
//       endpoint and this file falls back to it.
//
//       The selection rule is per symbol: take whichever source has the newer
//       quote time, Yahoo winning ties and anything inside FRESHER_BY_SECONDS.
//       Yahoo therefore stays primary while healthy and loses every row today.
//
//       Comparing the two sources against each other — rather than asking "is
//       this stale?" — is the point. That question has no wall-clock answer: a
//       US quote timestamped yesterday 22:00 is correct at 09:00 CET and broken
//       at 17:00, and separating those needs market calendars, holidays and
//       half-days. Comparison needs none, and unwinds itself when Yahoo
//       recovers, with no flag left set.
//
//       FX pairs carry no tradetime from Google and cannot be compared, so they
//       follow a batch-level verdict instead. Without it, base-currency
//       conversion would have run on frozen rates all afternoon while every
//       equity row was fresh.
import { scoreTicker } from './screener_score.js';
import { yahooSummary } from './screener_data.js';
import { generateValuation } from './valuation_model.js';
import { companyNews } from './news.js';

// How long a Cloudflare colo may reuse a Yahoo quote response.
const QUOTE_CACHE_TTL = 60;

// Minute-bucketed cache buster. Kept as hygiene — it is correct, it just was
// never the problem. See v21.
const bust = () => `&_cb=${Math.floor(Date.now() / 60000)}`;

// How much newer the sheet must be before it displaces Yahoo. Generous on
// purpose: Google's feed is 15 minutes delayed on AMS/ETR/TSE and the sheet's
// own refresh trigger adds up to five more, so a smaller margin would have the
// two sources trading places all day for no benefit.
const FRESHER_BY_SECONDS = 900;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-cache',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          ...corsHeaders,
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': '*',
        },
      });
    }

    // ── AI Valuation Generator ───────────────────────────────────────────────────────────
    // Every historical figure is resolved from filings, and Gemini's response
    // schema has no field in which to return one, so it cannot contradict a 10-K.
    const genTicker = url.searchParams.get('generate_valuation');
    if (genTicker) {
      const authHeader = request.headers.get('Authorization') || '';
      if (!authHeader.startsWith('Bearer ')) {
        return new Response(JSON.stringify({ error: 'Authentication required' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
      }

      const portfolioId  = parseInt(url.searchParams.get('portfolio_id') || '0');
      const currentPrice = parseFloat(url.searchParams.get('current_price') || '0');
      const refresh      = url.searchParams.get('refresh') === '1';

      try {
        // storeAs — the app's own ticker ("ASML"), the STORAGE key.
        // symbol  — the Yahoo listing ("ASML.AS"), the RESOLUTION key, which
        //           decides exchange, price and therefore currency.
        const storeAs  = genTicker.toUpperCase().trim();
        const yhParam  = (url.searchParams.get('yh_symbol') || '').toUpperCase().trim();
        const symbol   = yhParam || storeAs;

        const result = await generateValuation(symbol, env, { currentPrice, portfolioId, refresh });

        // A model that survives the reconciliation gate is wrong in its
        // judgement; one that fails it is wrong in its arithmetic, and only the
        // second kind is silently unrecoverable.
        if (result.blocked) {
          return new Response(JSON.stringify({
            error: `Valuation blocked: ${result.message}`,
            code: result.blocked,
            flags: result.flags,
            diagnostics: result.diagnostics,
            inputs_preview: result.inputs_preview,
          }), { status: 422, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
        }

        result.payload.ticker = storeAs;
        if (result.diagnostics) {
          result.diagnostics.resolved_symbol = symbol;
          result.diagnostics.stored_as = storeAs;
        }

        const saveRes = await fetch('https://labanos.dk/valuations.php', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': authHeader },
          body: JSON.stringify(result.payload),
        });

        // A 401/500 here is a RESOLVED fetch, not an exception. The screener
        // learned this the hard way — every failed save vanished silently.
        const saveText = await saveRes.text();
        let saveData = null;
        try { saveData = JSON.parse(saveText); } catch { /* non-JSON error page */ }

        if (!saveRes.ok) {
          return new Response(JSON.stringify({
            error: saveData?.error || `Save failed (${saveRes.status})`,
            persisted: false,
            persist_status: saveRes.status,
            diagnostics: result.diagnostics,
          }), { status: 502, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
        }

        return new Response(JSON.stringify({
          ...(saveData || {}),
          persisted: true,
          data_quality: result.quality,
          flags: result.flags,
          diagnostics: result.diagnostics,
        }), { headers: { 'Content-Type': 'application/json', ...corsHeaders } });

      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
      }
    }

    // ── Ticker snapshot: ?quote=SYMBOL ────────────────────────────────────────────────────
    // Price + chgPct from the chart series, fundamentals from yahooSummary().
    // Either half can fail alone, so we only 404 when NEITHER answered.
    const quoteSym = url.searchParams.get('quote');
    if (quoteSym) {
      const refreshQuote = url.searchParams.get('refresh') === '1';
      const [seriesSettled, summarySettled] = await Promise.allSettled([
        chartSnapshot(quoteSym),
        yahooSummary(quoteSym, refreshQuote),
      ]);
      const series  = seriesSettled.status  === 'fulfilled' ? seriesSettled.value  : null;
      const summary = summarySettled.status === 'fulfilled' ? summarySettled.value : null;

      if (!series && !summary) {
        return new Response(JSON.stringify({ error: `No data for ${quoteSym}` }), {
          status: 404, headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
      }

      return new Response(JSON.stringify({
        symbol:       quoteSym,
        price:        series?.price ?? summary?.price ?? null,
        chgPct:       series?.chgPct ?? null,
        quoteTime:    series?.quoteTime ?? null,
        timezone:     series?.timezone ?? null,
        currency:     summary?.currency ?? series?.currency ?? null,
        company:      summary?.longName ?? null,
        sector:       summary?.sector ?? null,
        industry:     summary?.industry ?? null,
        mktcap:       summary?.mktcap_native ?? null,
        pe:           summary?.pe_trailing ?? null,
        gross_margin: summary?.gross_margin ?? null,
        payout_ratio: summary?.payout_ratio ?? null,
        insider_own:  summary?.insider_own ?? null,
        summary_ok:   !!summary,
      }), { headers: { 'Content-Type': 'application/json', ...corsHeaders } });
    }

    // ── News endpoint ─────────────────────────────────────────────────────────────────────
    // &debug=1 reports what each source contributed and how much was dropped,
    // because "no news" and "everything was filtered out" look identical from
    // the outside and are very different bugs.
    const newsSymbol = url.searchParams.get('news');
    if (newsSymbol) {
      try {
        const payload = await companyNews(newsSymbol, url.searchParams.get('name'), {
          refresh: url.searchParams.get('refresh') === '1',
          debug:   url.searchParams.get('debug') === '1',
        });
        return new Response(JSON.stringify(payload), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
      } catch (e) {
        return new Response(JSON.stringify({ news: [], related: [], error: String(e.message) }), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
      }
    }

    // ── Search endpoint ───────────────────────────────────────────────────────────────────
    const searchQ = url.searchParams.get('search');
    if (searchQ) {
      const yfUrl = `https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(searchQ)}&quotesCount=8&newsCount=0&listsCount=0`;
      const res  = await fetch(yfUrl, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' } });
      const data = await res.json();
      const quotes = (data?.quotes || [])
        .filter(q => q.isYahooFinance && ['EQUITY', 'ETF', 'MUTUALFUND'].includes(q.quoteType))
        .slice(0, 8)
        .map(q => ({ symbol: q.symbol, name: q.shortname || q.longname || q.symbol, exchange: q.exchDisp || q.exchange || '', type: q.typeDisp || q.quoteType || '' }));
      return new Response(JSON.stringify({ quotes }), { headers: { 'Content-Type': 'application/json', ...corsHeaders } });
    }

    // ── Chart endpoint ────────────────────────────────────────────────────────────────────
    // Historical series only — deliberately not cache-busted.
    const chart = url.searchParams.get('chart');
    if (chart) {
      const range = url.searchParams.get('range') || '3mo';
      const intervalMap = { '1d':'5m','5d':'5m','1mo':'1d','3mo':'1d','6mo':'1d','1y':'1wk','2y':'1wk','5y':'1mo','max':'1mo' };
      const interval = intervalMap[range] || '1d';
      const yfUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(chart)}?interval=${interval}&range=${range}`;
      const res  = await fetch(yfUrl, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' } });
      const data = await res.json();
      const result = data?.chart?.result?.[0];
      if (!result) {
        return new Response(JSON.stringify({ error: 'No data' }), { status: 404, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
      }
      const timestamps = result.timestamp ?? [];
      const closes     = result.indicators?.quote?.[0]?.close ?? [];
      const currency   = result.meta?.currency ?? null;
      const points     = timestamps.map((t, i) => ({ t, c: closes[i] ?? null })).filter(p => p.c !== null);
      const prevClose  = result.meta?.chartPreviousClose ?? null;
      return new Response(JSON.stringify({ symbol: chart, currency, points, prevClose }), { headers: { 'Content-Type': 'application/json', ...corsHeaders } });
    }

    // ── Screener: score a ticker ───────────────────────────────────────────────────────────
    const scoreTickerSym = url.searchParams.get('score_ticker');
    if (scoreTickerSym) {
      const authHeader = request.headers.get('Authorization') || '';
      if (!authHeader.startsWith('Bearer ')) {
        return new Response(JSON.stringify({ error: 'Authentication required', code: 'no_token' }), {
          status: 401, headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
      }

      // Verify the token BEFORE doing ~30s of work. `startsWith('Bearer ')`
      // accepts any string. Fails OPEN on a network error.
      try {
        const verify = await fetch('https://labanos.dk/auth.php', {
          headers: { 'Authorization': authHeader },
        });
        if (verify.status === 401) {
          return new Response(JSON.stringify({
            error: 'Session expired — please sign in again',
            code: 'token_invalid',
          }), { status: 401, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
        }
      } catch (_) { /* unreachable — fall through and score */ }

      const symbol = scoreTickerSym.toUpperCase().trim();
      const refresh = url.searchParams.get('refresh') === '1';
      try {
        const scoreResult = await scoreTicker(symbol, env, refresh);

        let persisted = false, persistStatus = null, persistError = null;
        try {
          const saveRes = await fetch('https://labanos.dk/screener.php', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': authHeader },
            body: JSON.stringify(scoreResult),
          });
          persistStatus = saveRes.status;
          persisted = saveRes.ok;
          if (!persisted) persistError = (await saveRes.text().catch(() => '')).slice(0, 200);
        } catch (e) {
          persistError = String(e.message);
        }

        scoreResult.persisted = persisted;
        scoreResult.persist_status = persistStatus;
        if (persistError) scoreResult.persist_error = persistError;

        return new Response(JSON.stringify(scoreResult), { headers: { 'Content-Type': 'application/json', ...corsHeaders } });
      } catch (e) {
        return new Response(JSON.stringify({ error: String(e.message) }), { status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
      }
    }

    // ── Quotes endpoint: ?symbols=X,Y,Z ────────────────────────────────────────────────
    const symbolsParam = url.searchParams.get('symbols');
    if (!symbolsParam) {
      return new Response(JSON.stringify({ error: 'Missing symbols parameter' }), { status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
    }
    const symbols = symbolsParam.split(',').map(s => s.trim()).filter(Boolean);

    const yfHeaders = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept': 'application/json, text/plain, */*',
      'Accept-Language': 'en-US,en;q=0.9',
      'Referer': 'https://finance.yahoo.com/',
    };

    const fetchWithTimeout = (url, opts, ms = 6000) => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), ms);
      return fetch(url, { ...opts, cf: { cacheTtl: QUOTE_CACHE_TTL, cacheEverything: true }, signal: ctrl.signal })
        .finally(() => clearTimeout(timer));
    };

    // Cache-busted first, plain URL as the fallback, so a rejected parameter
    // degrades to stale-but-present rather than to an empty table.
    const fetchYf = async (baseUrl, ms) => {
      const busted = await fetchWithTimeout(baseUrl + bust(), { headers: yfHeaders }, ms).catch(() => null);
      if (busted && busted.ok) return busted;
      return await fetchWithTimeout(baseUrl, { headers: yfHeaders }, ms).catch(() => null);
    };

    // One request returns every symbol the sheet knows about. Failure is
    // non-fatal by design: no sheet simply means Yahoo-only, which is what
    // this endpoint did for its first twenty-three versions.
    const fetchSheet = async () => {
      if (!env.GSHEET_URL) return null;
      try {
        const res = await fetchWithTimeout(env.GSHEET_URL, {}, 8000);
        if (!res || !res.ok) return null;
        const data = await res.json();
        const rows = data?.quoteResponse?.result || [];
        const map = new Map();
        rows.forEach(r => { if (r && r.symbol) map.set(String(r.symbol).toUpperCase(), r); });
        return map.size ? map : null;
      } catch { return null; }
    };

    const fmtDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Copenhagen' });
    const todayCph = fmtDate.format(new Date());
    const isTodayCph = (epochSec) =>
      !!epochSec && fmtDate.format(new Date(epochSec * 1000)) === todayCph;

    // One chart request per symbol. This used to sit behind a v7 batch call;
    // since v22 it is the only Yahoo path, because the batch endpoint returns
    // 401 everywhere.
    const [yahooSettled, sheet] = await Promise.all([
      Promise.all(symbols.map(async symbol => {
        try {
          const yfUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=5m&range=5d`;
          const res  = await fetchYf(yfUrl, 6000);
          if (!res) return null;
          const data = await res.json();
          const result     = data?.chart?.result?.[0];
          const meta       = result?.meta;
          if (!meta) return null;
          const price        = meta.regularMarketPrice ?? null;
          const timestamps   = result?.timestamp ?? [];
          const closes       = result?.indicators?.quote?.[0]?.close ?? [];
          // Walk back to the most recent close that is not today in Copenhagen.
          // This is what keeps a US holding at 0.00% before the US open instead
          // of reporting yesterday's move as today's.
          let prevClose = null;
          for (let i = timestamps.length - 1; i >= 0; i--) {
            if (closes[i] != null && fmtDate.format(new Date(timestamps[i] * 1000)) !== todayCph) { prevClose = closes[i]; break; }
          }
          prevClose = prevClose ?? meta.chartPreviousClose ?? meta.previousClose ?? null;
          const changePercent = (prevClose && price != null) ? ((price - prevClose) / prevClose) * 100 : 0;
          return {
            symbol,
            regularMarketPrice: price,
            regularMarketChangePercent: changePercent,
            // Epoch SECONDS. Null when Yahoo gave none — the client renders that
            // as unknown and must never substitute the current time.
            regularMarketTime: meta.regularMarketTime ?? null,
            exchangeTimezoneName: meta.exchangeTimezoneName ?? null,
            source: 'yahoo',
          };
        } catch { return null; }
      })),
      fetchSheet(),
    ]);

    const yahooRows = yahooSettled.filter(Boolean);
    const result = sheet ? mergeWithSheet(yahooRows, sheet, symbols, isTodayCph) : yahooRows;

    return new Response(JSON.stringify({ quoteResponse: { result, error: null } }), { headers: { 'Content-Type': 'application/json', ...corsHeaders } });
  },
};

// ── Source selection ────────────────────────────────────────────────────────────────────────
// Per symbol, whichever source has the newer quote time wins, with Yahoo
// keeping anything inside FRESHER_BY_SECONDS so it stays primary while healthy.
//
// This deliberately avoids asking "is this quote stale?", which has no
// wall-clock answer — a US quote timestamped yesterday 22:00 is correct at
// 09:00 CET and broken at 17:00, and telling those apart needs a market
// calendar with holidays and half-days. Two sources compared against each other
// need none of that, and the arrangement unwinds itself when Yahoo recovers.
function mergeWithSheet(yahooRows, sheet, symbols, isTodayCph) {
  // Currency pairs have no tradetime from Google, so they cannot be compared
  // individually. Judge the batch on the symbols that CAN be compared, then let
  // the untimed ones follow that verdict — otherwise FX rates stay frozen while
  // every equity beside them is fresh, and the portfolio total is wrong in a way
  // no single row explains.
  let comparable = 0, sheetNewer = 0;
  for (const y of yahooRows) {
    const g = sheet.get(y.symbol.toUpperCase());
    if (!g || !g.regularMarketTime || !y.regularMarketTime) continue;
    comparable++;
    if (g.regularMarketTime > y.regularMarketTime + FRESHER_BY_SECONDS) sheetNewer++;
  }
  const yahooUnhealthy = comparable > 0 && sheetNewer * 2 >= comparable;

  const fromSheet = (symbol, g, fallbackTz) => {
    const price = g.regularMarketPrice;
    const prev  = g.previousClose;
    // Same Copenhagen rule the Yahoo path applies: a quote that is not from
    // today in CET has not moved today, whatever its previous close says.
    const chg = (isTodayCph(g.regularMarketTime) && prev) ? ((price - prev) / prev) * 100 : 0;
    return {
      symbol,
      regularMarketPrice: price,
      regularMarketChangePercent: chg,
      regularMarketTime: g.regularMarketTime ?? null,
      exchangeTimezoneName: g.exchangeTimeZone ?? fallbackTz ?? null,
      source: 'gsheet',
    };
  };

  const merged = yahooRows.map(y => {
    const g = sheet.get(y.symbol.toUpperCase());
    if (!g || g.regularMarketPrice == null) return y;

    const comparableRow = g.regularMarketTime && y.regularMarketTime;
    const takeSheet = comparableRow
      ? g.regularMarketTime > y.regularMarketTime + FRESHER_BY_SECONDS
      : (!y.regularMarketPrice || !y.regularMarketTime || yahooUnhealthy);

    return takeSheet ? fromSheet(y.symbol, g, y.exchangeTimezoneName) : y;
  });

  // Symbols Yahoo dropped entirely. Before the sheet existed these silently
  // vanished from the table; now they are simply sourced elsewhere.
  const seen = new Set(yahooRows.map(r => r.symbol.toUpperCase()));
  for (const s of symbols) {
    const key = s.toUpperCase();
    if (seen.has(key)) continue;
    const g = sheet.get(key);
    if (g && g.regularMarketPrice != null) merged.push(fromSheet(s, g, null));
  }

  return merged;
}

// ── Chart-derived price and today's change ──────────────────────────────────────────────────
// Yahoo's regularMarketChangePercent goes stale intraday, so the change is
// rebuilt from the 5-day/5-minute series: walk back to the most recent close
// that is not today in Copenhagen time and treat that as the previous close.
// Lifted to module scope so ?quote= can reuse it.
//
// Returns chgPct as a FRACTION (0.0134), not a percentage. The frontend's pct()
// multiplies by 100, which is why app.js divides the ?symbols= value by 100.
async function chartSnapshot(symbol) {
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/plain, */*',
    'Referer': 'https://finance.yahoo.com/',
  };
  const opts = { headers, cf: { cacheTtl: QUOTE_CACHE_TTL, cacheEverything: true }, signal: ctrl.signal };
  try {
    const yfUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=5m&range=5d`;
    let res = await fetch(yfUrl + bust(), opts).catch(() => null);
    if (!res || !res.ok) res = await fetch(yfUrl, opts).catch(() => null);
    if (!res || !res.ok) return null;
    const data   = await res.json();
    const result = data?.chart?.result?.[0];
    const meta   = result?.meta;
    if (!meta) return null;

    const timestamps = result.timestamp ?? [];
    const closes     = result.indicators?.quote?.[0]?.close ?? [];

    // Thinly traded names can have a null final candle; fall back to the last
    // close that exists rather than reporting no price at all.
    let last = null;
    for (let i = closes.length - 1; i >= 0; i--) { if (closes[i] != null) { last = closes[i]; break; } }
    const price = meta.regularMarketPrice ?? last ?? null;

    const fmt   = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Copenhagen' });
    const today = fmt.format(new Date());
    let prevClose = null;
    for (let i = timestamps.length - 1; i >= 0; i--) {
      if (closes[i] != null && fmt.format(new Date(timestamps[i] * 1000)) !== today) { prevClose = closes[i]; break; }
    }
    prevClose = prevClose ?? meta.chartPreviousClose ?? meta.previousClose ?? null;

    return {
      price,
      chgPct:    (prevClose && price != null) ? (price - prevClose) / prevClose : null,
      currency:  meta.currency ?? null,
      quoteTime: meta.regularMarketTime ?? null,
      timezone:  meta.exchangeTimezoneName ?? null,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
