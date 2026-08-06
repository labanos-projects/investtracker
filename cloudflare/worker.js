// v7 – fix stale intraday change%: don't trust Yahoo's regularMarketChangePercent
// v8 – add ?score_ticker= endpoint
// v10 – Gemini scores all 18 criteria (YF blocks fundamental data from CF Workers)
// v11 – screener rework: computed fundamentals (EDGAR/Yahoo/FMP) + grounded AI,
//       0/1/2/null scoring with a dynamic denominator, multibagger rubric.
//       Scoring logic now lives in screener_{engine,data,score,cache}.js.
// v12 – screener upstreams cached; ?refresh=1 bypasses every layer.
// v13 – screener: verify the token before scoring, and report whether the
//       result actually persisted instead of swallowing the failure.
// v14 – add ?quote= : the full ticker snapshot the shared company page needs
//       for a symbol with no row in `portfolio`.
// v15 – valuation rework. The DCF used to take its history from ONE source
//       (FMP income-statement) and, when that returned nothing, fall through to
//       a prompt that told Gemini to model the company from training data.
//       Thirteen of twenty-six stored models were built that way. ServiceNow
//       carried a pre-split 201M share count against 1,034M actual, putting its
//       implied entry P/E at 8x against a market 69x — which is where the
//       "suspiciously cheap" fair values came from.
//
//       Actuals now come from filings via the screener's per-field waterfall
//       (valuation_data.js) and Gemini supplies forward assumptions only,
//       search-grounded (valuation_model.js). Inputs are reconciled against
//       market cap before anything is saved, and buildKnowledgePrompt is gone:
//       when no source answers, the endpoint now returns an error instead of an
//       invented model.
// v16 – ?generate_valuation= and ?yh_symbol= are now two different symbols.
//       They always were two different things; the endpoint just used one
//       string for both. The app's ticker is a storage key ("ASML"), the Yahoo
//       symbol is a listing ("ASML.AS"), and for anything not listed in the US
//       those name different securities. ASML was being valued on Nasdaq in USD
//       while every other number on its page came from Amsterdam in EUR.
// v17 – news rework. ?news= handed the exchange-suffixed LISTING symbol to
//       Yahoo's free-text search endpoint. NOVO-B.CO matched nothing, so the
//       response fell back to the general market firehose — Tesla, Miami-Dade
//       early voting, Tibetan antelopes — and the panel rendered all of it as
//       Novo Nordisk's news. NOVO-B returned empty; only bare US-resolvable
//       symbols ever worked, which is to say: every non-US holding was broken.
//
//       Correcting the identifier was necessary and not sufficient. Querying
//       NVO, the symbol that does work, the ZEUS ziltivekimab failure that took
//       the stock down 9.3% and erased $30bn on 31 July was already outside
//       newsCount=10 by 3 August. Depth is a second, independent defect.
//
//       news.js now resolves the listing to a company identity (name, sibling
//       listings, sector, peers), fans out across several queries, and drops
//       every article that matches neither the company nor its sector.
// v18 – ?symbols= now returns WHEN each price is from. It returned price and
//       change% and nothing else, so the client had no timestamp to show and
//       used `new Date()` — the moment the fetch resolved — under the label
//       "Prices as of". Every quote therefore looked current, including the
//       twenty US holdings that do not trade at all before 15:30 CET and sit
//       frozen at yesterday's close all morning. "Stuck prices" and "working
//       correctly, market shut" were indistinguishable from the UI.
//
//       regularMarketTime was already present in the chart `meta` both paths
//       parse; it was simply discarded. It is now passed through, with
//       exchangeTimezoneName so the client can name the market. A symbol whose
//       timestamp is missing returns null and must render as unknown — never
//       as now.
//
//       Nothing about price or change% changed. prevClose is still the last
//       candle that is not today in Copenhagen.
// v19 – cap edge caching of Yahoo responses at 60 seconds. A Worker's outbound
//       fetch() is cached at the colo that ran it, honouring whatever cache
//       headers the origin sent, and this file never set a TTL.
// v20 – v19 did not work: cacheTtl applies when Cloudflare STORES a response,
//       so entries already held kept their original lifetime. Added a
//       minute-bucketed cache buster so each minute gets its own key.
//
//       That did not work either, and the reason matters. Probing symbols the
//       app had never requested — ORSTED.CO, VWS.CO, SAP.DE — returned data
//       pinned to the same ~09:40 boundary as everything else, across three
//       exchanges. A per-URL cache cannot do that. Whatever is serving this
//       region is serving a frozen view of the entire dataset.
// v21 – so stop guessing and look. Every upstream failure here is swallowed:
//       `if (!res.ok) continue`, bare `catch {}`. A 429, Yahoo's 999 rate-limit
//       code, a timeout and a parse error are all indistinguishable from the
//       outside, which is exactly the information needed to explain why one
//       region goes stale while another does not.
//
//       ?symbols=SYM&diag=1 probes the same URLs the quote path uses and
//       reports status, timing, Cloudflare's cf-cache-status and Yahoo's own
//       Age/Date/X-Cache headers, alongside request.cf.colo. Read-only and
//       opt-in; without diag=1 nothing behaves differently.
import { scoreTicker } from './screener_score.js';
import { yahooSummary } from './screener_data.js';
import { generateValuation } from './valuation_model.js';
import { companyNews } from './news.js';

// How long a Cloudflare colo may reuse a Yahoo quote response.
const QUOTE_CACHE_TTL = 60;

// Minute-bucketed cache buster — see the v20 note.
const bust = () => `&_cb=${Math.floor(Date.now() / 60000)}`;

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
    // Orchestration lives in valuation_model.js. The split that matters: every
    // historical figure is resolved from filings, and Gemini's response schema
    // has no field in which to return one, so it cannot contradict a 10-K.
    //
    // ?refresh=1 bypasses every cache layer, including the 24h grounded
    // research pass — same contract as the screener.
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
        // ── Two symbols, and they are not interchangeable ──
        //
        //   storeAs — the app's own ticker ("ASML", "NOVO-B"). This is the
        //             STORAGE key: valuation_models is unique on
        //             (ticker, model_date) and the panel loads by
        //             ?ticker=<display ticker>, so writing anything else here
        //             orphans the model.
        //   symbol  — the Yahoo listing ("ASML.AS", "NOVO-B.CO"). This is the
        //             RESOLUTION key: it decides which exchange, which price
        //             and therefore which CURRENCY the model is built in.
        //
        // Using one string for both is why ASML was valued on Nasdaq in USD
        // against a page quoting Amsterdam in EUR — and why regenerating GMAB
        // would have resolved Genmab's US ADR. The fallback keeps an
        // un-migrated caller (or a bookmarked URL) behaving exactly as before.
        const storeAs  = genTicker.toUpperCase().trim();
        const yhParam  = (url.searchParams.get('yh_symbol') || '').toUpperCase().trim();
        const symbol   = yhParam || storeAs;

        const result = await generateValuation(symbol, env, { currentPrice, portfolioId, refresh });

        // Inputs failed to reconcile with the market. Refusing to save is the
        // whole point: a model that survives this gate is wrong in its
        // judgement, one that fails it is wrong in its arithmetic, and only the
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

        // Built against the listing, filed under the app's ticker. Recorded in
        // diagnostics rather than inferred later: "which listing is this model
        // actually about" is not answerable from the stored row otherwise, and
        // that ambiguity is the whole bug.
        //
        // `result.diagnostics` IS `result.payload.diagnostics` — same object —
        // so this reaches the database. Do it before the save, not after.
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
    // Everything the shared ticker page needs for a company that has no row in
    // `portfolio`: currency, name, sector, market cap, P/E. Without this the
    // page renders four dashes for every un-held symbol, which is exactly the
    // case the merged page exists to serve.
    //
    // Two independent sources, deliberately:
    //   price + chgPct  ← the chart series. quoteSummary's
    //                     regularMarketChangePercent goes stale intraday; this
    //                     is the same reconstruction ?symbols= already does.
    //   fundamentals    ← yahooSummary(), which owns the crumb handshake and
    //                     the 15-minute cache the screener already warms, so a
    //                     ticker page costs nothing extra once it is hot.
    //
    // Either half can fail alone, so we only 404 when NEITHER answered. A dead
    // quoteSummary still leaves a priced chart rather than a blank page, and
    // `summary_ok: false` distinguishes "upstream broke" from "no such data".
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
    // Resolution, fan-out and relevance filtering live in news.js. The handler
    // this replaced was a single URL:
    //
    //   /v1/finance/search?q=${newsSymbol}&newsCount=10
    //
    // `q` there is FREE TEXT, not a symbol lookup, and it was being handed the
    // app's Yahoo LISTING symbol. Against production that returned, for
    // ?news=NOVO-B.CO, ten articles about Tesla, Miami-Dade early voting and
    // Tibetan antelopes — and nothing about Novo Nordisk. A total miss came
    // back empty; a partial miss came back as Yahoo's general market firehose,
    // which the panel then rendered as company news. Every non-US listing took
    // this path: ASML.AS, CSU.TO, CHG.DE.
    //
    // &name= is the company name the page already has on screen. It is a hint,
    // not a requirement — it saves a quoteSummary round-trip and keeps the
    // fan-out working when quoteSummary is down, since the company name is the
    // single most productive query of the set.
    //
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
        // 200 with an explicit error: the panel distinguishes "we could not
        // look" from "there is nothing", and neither should take the page down.
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
    // Historical series only — deliberately not cache-busted. A 1-year chart
    // does not go stale the way a live quote does, and letting the colo hold it
    // is the point.
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
    // Scoring lives in screener_score.js. Quantitative criteria are computed
    // from filings (EDGAR → Yahoo → FMP, per field); only the six qualitative
    // criteria go to Gemini, search-grounded. Missing data scores null and is
    // excluded from the denominator rather than defaulting to a passing 1.
    //
    // ?refresh=1 bypasses every cache layer. Keep it — a cached score would
    // have hidden the XBRL stock-split bug instead of surfacing it.
    const scoreTickerSym = url.searchParams.get('score_ticker');
    if (scoreTickerSym) {
      const authHeader = request.headers.get('Authorization') || '';
      if (!authHeader.startsWith('Bearer ')) {
        return new Response(JSON.stringify({ error: 'Authentication required', code: 'no_token' }), {
          status: 401, headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
      }

      // Verify the token BEFORE doing ~30s of work. `startsWith('Bearer ')` is
      // not authentication — it accepts any string. auth.php rotates api_token
      // on every login, so a token left in localStorage after signing in
      // elsewhere is stale, and used to buy a full grounded-search score that
      // could never be saved.
      //
      // Fails OPEN on a network error: a labanos.dk hiccup shouldn't block
      // scoring, and the persist result below reports the truth regardless.
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

        // Persist. A 401/500 here is a RESOLVED fetch, not an exception, so the
        // old `try { await fetch(...) } catch {}` never saw it and every failed
        // save vanished silently. Check the status and report it.
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

    // ── Diagnostics: ?symbols=SYM&diag=1 ──────────────────────────────────────────────────
    // Probes the exact URLs the quote path uses and reports what came back,
    // because everything below this point throws that information away.
    //
    // The five probes are chosen to separate causes that look identical from
    // outside:
    //   chart-plain / batch-plain     what the app actually gets today
    //   chart-busted / batch-busted   does Yahoo accept the _cb parameter, and
    //                                 does a fresh key change the answer?
    //   chart-nocache                 cacheTtl 0, so Cloudflare must not serve
    //                                 a stored copy — if this is STILL stale,
    //                                 the stale copy is Yahoo's, not ours
    //
    // cf-cache-status is Cloudflare's verdict on our subrequest; Age/X-Cache/
    // Via are Yahoo's own CDN talking. `colo` makes the whole thing
    // attributable to a place, which is the one variable that separates a
    // working session from a broken one.
    if (url.searchParams.get('diag') === '1') {
      const sym       = symbols[0] || 'AAPL';
      const chartBase = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=5m&range=5d`;
      const batchBase = `https://query2.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(sym)}&fields=regularMarketPrice,regularMarketChangePercent,regularMarketTime`;

      const probe = async (label, target, cfOpts) => {
        const t0 = Date.now();
        try {
          const res  = await fetch(target, { headers: yfHeaders, cf: cfOpts });
          const text = await res.text();
          let price = null, quoteTime = null, parsed = false;
          try {
            const j    = JSON.parse(text);
            const meta = j?.chart?.result?.[0]?.meta;
            const q    = j?.quoteResponse?.result?.[0];
            price      = meta?.regularMarketPrice ?? q?.regularMarketPrice ?? null;
            quoteTime  = meta?.regularMarketTime  ?? q?.regularMarketTime  ?? null;
            parsed     = true;
          } catch { /* not JSON — bodyHead below will show what it was */ }
          const h = {};
          for (const k of ['cf-cache-status','age','date','expires','cache-control',
                           'x-cache','x-cache-hits','via','server','x-served-by',
                           'retry-after','x-yahoo-request-id','x-envoy-upstream-service-time']) {
            const v = res.headers.get(k);
            if (v) h[k] = v;
          }
          return {
            label,
            status: res.status,
            ms: Date.now() - t0,
            bytes: text.length,
            parsed,
            price,
            quoteTime,
            ageMin: quoteTime ? Math.round((Date.now() / 1000 - quoteTime) / 60) : null,
            headers: h,
            bodyHead: (res.ok && parsed) ? undefined : text.slice(0, 400),
          };
        } catch (e) {
          return { label, error: String((e && e.message) || e), ms: Date.now() - t0 };
        }
      };

      const cfCached = { cacheTtl: QUOTE_CACHE_TTL, cacheEverything: true };
      const cfNone   = { cacheTtl: 0 };

      const probes = [];
      // Sequential on purpose: parallel probes can share a single cache fill
      // and hide exactly the difference we are trying to measure.
      probes.push(await probe('chart-plain',   chartBase,                          cfCached));
      probes.push(await probe('chart-busted',  chartBase + bust(),                 cfCached));
      probes.push(await probe('chart-nocache', chartBase + `&_d=${Date.now()}`,    cfNone));
      probes.push(await probe('batch-plain',   batchBase,                          cfCached));
      probes.push(await probe('batch-busted',  batchBase + bust(),                 cfCached));

      return new Response(JSON.stringify({
        symbol:    sym,
        colo:      request.cf?.colo ?? null,
        country:   request.cf?.country ?? null,
        clientTZ:  request.cf?.timezone ?? null,
        workerNow: Math.floor(Date.now() / 1000),
        probes,
      }, null, 2), { headers: { 'Content-Type': 'application/json', ...corsHeaders } });
    }

    const fetchWithTimeout = (url, opts, ms = 6000) => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), ms);
      return fetch(url, { ...opts, cf: { cacheTtl: QUOTE_CACHE_TTL, cacheEverything: true }, signal: ctrl.signal })
        .finally(() => clearTimeout(timer));
    };

    // Cache-busted first, plain URL as the fallback. If Yahoo ever rejects the
    // extra parameter this degrades to v18 behaviour — stale but present —
    // rather than to an empty table.
    const fetchYf = async (baseUrl, ms) => {
      const busted = await fetchWithTimeout(baseUrl + bust(), { headers: yfHeaders }, ms).catch(() => null);
      if (busted && busted.ok) return busted;
      return await fetchWithTimeout(baseUrl, { headers: yfHeaders }, ms).catch(() => null);
    };

    const fmtDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Copenhagen' });

    // Previous close AND the exchange's own timestamp for one symbol.
    //
    // This returns an object rather than a bare number because the batch path
    // below needs both and only makes this call once. The timestamp is the
    // point: the v7 batch hands back a price with no indication of when the
    // exchange set it, and a client with no timestamp invents one.
    const getQuoteRef = async (symbol) => {
      try {
        const yfUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=5m&range=5d`;
        const res   = await fetchYf(yfUrl, 6000);
        if (!res) return null;
        const data  = await res.json();
        const result     = data?.chart?.result?.[0];
        const meta       = result?.meta;
        if (!meta) return null;
        const timestamps = result?.timestamp ?? [];
        const closes     = result?.indicators?.quote?.[0]?.close ?? [];
        const today      = fmtDate.format(new Date());
        const ref = {
          prevClose: meta.chartPreviousClose ?? meta.previousClose ?? null,
          quoteTime: meta.regularMarketTime ?? null,
          timezone:  meta.exchangeTimezoneName ?? null,
        };
        // Walk back to the most recent close that is not today in Copenhagen.
        // Unchanged behaviour — this is what keeps a US holding at 0.00% before
        // the US open instead of reporting yesterday's move as today's.
        for (let i = timestamps.length - 1; i >= 0; i--) {
          if (closes[i] != null && fmtDate.format(new Date(timestamps[i] * 1000)) !== today) { ref.prevClose = closes[i]; break; }
        }
        return ref;
      } catch { return null; }
    };

    try {
      const safeSymbols = symbolsParam.replace(/=/g, '%3D');
      const batchUrl = `https://query2.finance.yahoo.com/v7/finance/quote?symbols=${safeSymbols}&fields=regularMarketPrice,regularMarketChangePercent,regularMarketTime,exchangeTimezoneName`;
      const batchRes = await fetchYf(batchUrl, 8000);
      if (batchRes && batchRes.ok) {
        const data = await batchRes.json();
        const batchResults = data?.quoteResponse?.result || [];
        if (batchResults.length > 0) {
          const corrected = await Promise.all(batchResults.map(async q => {
            const price = q.regularMarketPrice;
            const ref = await getQuoteRef(q.symbol);
            const prevClose = ref?.prevClose ?? null;
            const changePercent = (prevClose && price != null)
              ? ((price - prevClose) / prevClose) * 100
              : (q.regularMarketChangePercent ?? 0);
            return {
              symbol: q.symbol,
              regularMarketPrice: price,
              regularMarketChangePercent: changePercent,
              // Epoch SECONDS, the unit Yahoo uses in both sources. The batch
              // field wins when present; the chart meta is the fallback. When
              // neither answers this stays null and the client must render it
              // as unknown rather than substituting the current time.
              regularMarketTime: q.regularMarketTime ?? ref?.quoteTime ?? null,
              exchangeTimezoneName: q.exchangeTimezoneName ?? ref?.timezone ?? null,
            };
          }));
          return new Response(JSON.stringify({ quoteResponse: { result: corrected, error: null } }), {
            headers: { 'Content-Type': 'application/json', ...corsHeaders },
          });
        }
      }
    } catch { /* fall through */ }

    const results = await Promise.all(symbols.map(async symbol => {
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
        const today        = fmtDate.format(new Date());
        let prevClose = null;
        for (let i = timestamps.length - 1; i >= 0; i--) {
          if (closes[i] != null && fmtDate.format(new Date(timestamps[i] * 1000)) !== today) { prevClose = closes[i]; break; }
        }
        prevClose = prevClose ?? meta.chartPreviousClose ?? meta.previousClose ?? null;
        const changePercent = (prevClose && price != null) ? ((price - prevClose) / prevClose) * 100 : 0;
        return {
          symbol,
          regularMarketPrice: price,
          regularMarketChangePercent: changePercent,
          regularMarketTime: meta.regularMarketTime ?? null,
          exchangeTimezoneName: meta.exchangeTimezoneName ?? null,
        };
      } catch { return null; }
    }));

    return new Response(JSON.stringify({ quoteResponse: { result: results.filter(Boolean), error: null } }), { headers: { 'Content-Type': 'application/json', ...corsHeaders } });
  },
};

// ── Chart-derived price and today's change ──────────────────────────────────────────────────
// Yahoo's regularMarketChangePercent goes stale intraday, so the change is
// rebuilt from the 5-day/5-minute series: walk back to the most recent close
// that is not today in Copenhagen time and treat that as the previous close.
// This is the ?symbols= logic, lifted to module scope so ?quote= can reuse it —
// the helpers inside the ?symbols= block are `const` and therefore unreachable
// from a handler that runs earlier in the same function.
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
