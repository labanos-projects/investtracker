// v7 – fix stale intraday change%: don't trust Yahoo's regularMarketChangePercent
// v8 – add ?score_ticker= endpoint: YF quoteSummary + Gemini qual scoring
// v9 – fix YF 401: use v7/quote (no auth) instead of v10/quoteSummary
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

      try {
        const symbol    = genTicker.toUpperCase();
        const fmpSymbol = symbol.replace(/\.[A-Z]{1,3}$/, '');
        const fmpKey    = env.FMP_API_KEY;

        const fmpRes = await fetch(
          `https://financialmodelingprep.com/stable/income-statement?symbol=${encodeURIComponent(fmpSymbol)}&limit=5&apikey=${fmpKey}`,
          { headers: { 'User-Agent': 'Mozilla/5.0' } }
        );
        const fmpText = await fmpRes.text();
        let fmpData = null;
        try { fmpData = JSON.parse(fmpText); } catch (e) {}

        const today = new Date().toISOString().split('T')[0];
        let prompt;

        if (Array.isArray(fmpData) && fmpData.length > 0) {
          const annuals  = fmpData.filter(r => !r.period || r.period === 'FY').sort((a, b) => a.date.localeCompare(b.date));
          const stmts    = annuals.slice(-3);
          const currency = fmpData[0]?.reportedCurrency || 'USD';
          prompt = buildValuationPrompt(symbol, stmts, currentPrice, currency, today);
        } else {
          prompt = buildKnowledgePrompt(symbol, currentPrice, today);
        }

        const geminiKey = env.GEMINI_API_KEY;
        const geminiRes = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${geminiKey}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [{ parts: [{ text: prompt }] }],
              generationConfig: { responseMimeType: 'application/json', temperature: 0.3, maxOutputTokens: 8192 },
            }),
          }
        );

        if (!geminiRes.ok) {
          const errJson = await geminiRes.json().catch(() => null);
          const errMsg  = errJson?.error?.message || 'Unknown Gemini error';
          const errCode = errJson?.error?.code || geminiRes.status;
          const friendly = errCode === 429
            ? 'Gemini quota exceeded — enable billing at aistudio.google.com or wait for quota reset'
            : `Gemini error ${errCode}: ${errMsg.slice(0, 200)}`;
          return new Response(JSON.stringify({ error: friendly }), { status: 502, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
        }

        const geminiData = await geminiRes.json();
        const parts   = geminiData.candidates?.[0]?.content?.parts || [];
        const rawJson = (parts.find(p => !p.thought) || parts[parts.length - 1])?.text;

        if (!rawJson) {
          return new Response(JSON.stringify({ error: 'No content from Gemini', raw: JSON.stringify(geminiData).slice(0, 400) }), { status: 502, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
        }

        let payload;
        try {
          const cleaned = rawJson.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
          payload = JSON.parse(cleaned);
        } catch (e) {
          return new Response(JSON.stringify({ error: 'Gemini returned invalid JSON', raw: rawJson.slice(0, 500) }), { status: 502, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
        }

        payload.portfolio_id = portfolioId;

        const saveRes = await fetch('https://labanos.dk/valuations.php', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': authHeader },
          body: JSON.stringify(payload),
        });

        const saveData = await saveRes.json();
        return new Response(JSON.stringify(saveData), { headers: { 'Content-Type': 'application/json', ...corsHeaders } });

      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
      }
    }

    // ── News endpoint ─────────────────────────────────────────────────────────────────────
    const newsSymbol = url.searchParams.get('news');
    if (newsSymbol) {
      const yfUrl = `https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(newsSymbol)}&quotesCount=0&newsCount=10&listsCount=0`;
      const res  = await fetch(yfUrl, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' } });
      const data = await res.json();
      const news = (data?.news || []).map(n => ({
        title: n.title, publisher: n.publisher, time: n.providerPublishTime,
        link: n.link, thumbnail: n.thumbnail?.resolutions?.[0]?.url ?? null,
      }));
      return new Response(JSON.stringify({ news }), { headers: { 'Content-Type': 'application/json', ...corsHeaders } });
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
        return new Response(JSON.stringify({ error: 'Authentication required' }), {
          status: 401, headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
      }
      const symbol = scoreTickerSym.toUpperCase().trim();
      try {
        // 1. Fetch via v7/quote — no auth required, works from CF Workers
        const YF_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
        const fields = [
          'regularMarketPrice','marketCap','longName','shortName',
          'sector','industry','quoteType',
          'returnOnEquity','revenueGrowth','grossMargins','operatingMargins',
          'profitMargins','debtToEquity','freeCashflow','earningsGrowth',
          'pegRatio','dividendYield','payoutRatio','trailingPegRatio',
          'heldPercentInsiders','epsTrailingTwelveMonths','epsForward',
          'ebitda','totalDebt','totalCash','returnOnAssets','bookValue',
          'sharesOutstanding','floatShares','currency',
        ].join(',');
        const quoteUrl = `https://query2.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(symbol)}&fields=${encodeURIComponent(fields)}`;
        const quoteRes = await fetch(quoteUrl, {
          headers: { 'User-Agent': YF_UA, 'Accept': 'application/json', 'Referer': 'https://finance.yahoo.com/' },
        });
        if (!quoteRes.ok) throw new Error(`Yahoo Finance ${quoteRes.status} for ${symbol}`);
        const quoteData = await quoteRes.json();
        const q = quoteData?.quoteResponse?.result?.[0];
        if (!q) throw new Error(`Ticker ${symbol} not found — check symbol`);

        // 2. Extract fields
        const sector    = q.sector   || '';
        const industry  = q.industry || '';
        const company   = q.longName || q.shortName || symbol;
        const marketCap = q.marketCap ?? null;

        const SECTOR_GM = {
          'Technology': 55, 'Communication Services': 55, 'Healthcare': 55,
          'Financial Services': 50, 'Consumer Cyclical': 35, 'Consumer Defensive': 35,
          'Industrials': 30, 'Basic Materials': 28, 'Energy': 25, 'Real Estate': 45, 'Utilities': 40,
        };
        const sectorBM = SECTOR_GM[sector] ?? 40;

        // 3. Score quant criteria from v7/quote fields
        const criteria = {};

        // ROE
        const roe = q.returnOnEquity != null ? q.returnOnEquity * 100 : null;
        criteria.roe = { score: roe != null ? (roe >= 20 ? 2 : roe >= 15 ? 1 : 0) : 0, note: roe != null ? `ROE ${roe.toFixed(1)}%` : 'No data', weight: 3, tier: 1 };

        // Revenue growth
        const revG = q.revenueGrowth != null ? q.revenueGrowth * 100 : null;
        criteria.rev_growth = { score: revG != null ? (revG >= 10 ? 2 : revG >= 5 ? 1 : 0) : 0, note: revG != null ? `Revenue growth ${revG.toFixed(1)}% YoY` : 'No data', weight: 3, tier: 1 };

        // Gross margin vs sector
        const gm = q.grossMargins != null ? q.grossMargins * 100 : null;
        if (gm != null) {
          const diff = gm - sectorBM;
          criteria.gross_margin = { score: diff >= 5 ? 2 : diff >= -5 ? 1 : 0, note: `GM ${gm.toFixed(1)}% vs sector ~${sectorBM}% (${diff >= 0 ? '+' : ''}${diff.toFixed(1)}pp)`, weight: 3, tier: 1 };
        } else {
          criteria.gross_margin = { score: 0, note: 'No gross margin data', weight: 3, tier: 1 };
        }

        // Insider ownership
        const ins = q.heldPercentInsiders;
        criteria.insider_own = ins != null
          ? { score: ins >= 0.10 ? 2 : ins >= 0.05 ? 1 : 0, note: `Insider ownership ${(ins * 100).toFixed(1)}%`, weight: 3, tier: 1 }
          : { score: 1, note: 'Insider data unavailable', weight: 3, tier: 1 };

        // EPS growth
        const epsG = q.earningsGrowth != null ? q.earningsGrowth * 100 : null;
        criteria.eps_growth = { score: epsG != null ? (epsG >= 10 ? 2 : epsG >= 5 ? 1 : 0) : 0, note: epsG != null ? `EPS growth ${epsG.toFixed(1)}% YoY` : 'No data', weight: 2, tier: 2 };

        // FCF
        const fcf = q.freeCashflow ?? null;
        criteria.fcf = fcf != null
          ? { score: fcf > 0 ? 1 : 0, note: `FCF $${(fcf / 1e6).toFixed(0)}M`, weight: 2, tier: 2 }
          : { score: 0, note: 'No FCF data', weight: 2, tier: 2 };

        // Debt
        const de = q.debtToEquity ?? null;
        const totalDebt = q.totalDebt ?? 0;
        const totalCash = q.totalCash ?? 0;
        const ebitda    = q.ebitda ?? null;
        if (ebitda && ebitda > 0 && totalDebt !== null) {
          const ratio = (totalDebt - totalCash) / ebitda;
          criteria.debt = { score: ratio <= 0 ? 2 : ratio <= 2 ? 2 : ratio <= 3 ? 1 : 0, note: ratio <= 0 ? 'Net cash position' : `Net debt/EBITDA ${ratio.toFixed(1)}x`, weight: 2, tier: 2 };
        } else if (de != null) {
          criteria.debt = { score: de <= 0 ? 2 : de <= 50 ? 2 : de <= 100 ? 1 : 0, note: `Debt/equity ${de.toFixed(0)}%`, weight: 2, tier: 2 };
        } else {
          criteria.debt = { score: 1, note: 'Debt data unavailable', weight: 2, tier: 2 };
        }

        // Market cap
        criteria.mktcap = marketCap != null
          ? { score: marketCap >= 0.5e9 && marketCap <= 3e9 ? 2 : marketCap >= 0.3e9 && marketCap <= 5e9 ? 1 : 0, note: `Market cap $${(marketCap / 1e9).toFixed(2)}B`, weight: 2, tier: 2 }
          : { score: 0, note: 'Market cap unavailable', weight: 2, tier: 2 };

        // Share count trend (v7/quote only has current shares, not history — default neutral)
        criteria.shares = { score: 1, note: 'Share trend requires historical data (scored neutral)', weight: 1, tier: 3 };

        // PEG
        const peg = q.pegRatio ?? q.trailingPegRatio ?? null;
        criteria.peg = peg != null ? { score: peg <= 0 ? 1 : peg < 1 ? 2 : peg < 2 ? 1 : 0, note: `PEG ${peg.toFixed(2)}`, weight: 1, tier: 3 } : { score: 1, note: 'PEG not available', weight: 1, tier: 3 };

        // Dividend
        const payout   = q.payoutRatio ?? null;
        const divYield = q.dividendYield ?? 0;
        if ((!payout || payout === 0) && (!divYield || divYield === 0)) {
          criteria.dividend = { score: 2, note: 'No dividend — capital compounds internally', weight: 1, tier: 3 };
        } else {
          criteria.dividend = { score: (payout || 0) < 0.15 ? 2 : (payout || 0) < 0.40 ? 1 : 0, note: `Payout ${((payout || 0) * 100).toFixed(0)}%, yield ${((divYield || 0) * 100).toFixed(1)}%`, weight: 1, tier: 3 };
        }

        // ROIC (approximated from returnOnAssets if available)
        const roa = q.returnOnAssets != null ? q.returnOnAssets * 100 : null;
        criteria.roic = roa != null
          ? { score: roa >= 10 ? 2 : roa >= 6 ? 1 : 0, note: `ROA ${roa.toFixed(1)}% (ROIC proxy)`, weight: 1, tier: 3 }
          : { score: 0, note: 'Insufficient data for ROIC', weight: 1, tier: 3 };

        // 4. Qual scoring via Gemini
        const QUAL_IDS  = ['moat', 'runway', 'cap_alloc', 'industry', 'disclosure', 'insider_buy'];
        const QUAL_META = { moat: { weight: 3, tier: 1 }, runway: { weight: 3, tier: 1 }, cap_alloc: { weight: 2, tier: 2 }, industry: { weight: 2, tier: 2 }, disclosure: { weight: 1, tier: 3 }, insider_buy: { weight: 1, tier: 3 } };

        const qualPrompt = `You are a professional equity analyst. Assess ${company} (ticker: ${symbol}, sector: ${sector}, industry: ${industry}) on 6 qualitative criteria. Score each 0, 1, or 2 (2=clearly meets bar, 1=partial/uncertain, 0=fails/red flag).

Respond ONLY with flat JSON, no markdown:
{"moat_score":1,"moat_why":"brief reason","runway_score":1,"runway_why":"brief reason","cap_alloc_score":1,"cap_alloc_why":"brief reason","industry_score":1,"industry_why":"brief reason","disclosure_score":1,"disclosure_why":"brief reason","insider_buy_score":1,"insider_buy_why":"brief reason"}

Criteria:
moat: 2=wide durable moat 20+ yrs, 1=narrow ~10 yrs, 0=no moat
runway: 2=large underpenetrated TAM, 1=some growth left, 0=market saturated
cap_alloc: 2=excellent value-creating buybacks/M&A, 1=mixed, 0=value-destroying
industry: 2=slow-changing stable for decades, 1=some flux stable 5-10yr, 0=rapid disruption risk within 5 yrs
disclosure: 2=clear candid management, 1=adequate, 0=opaque or prior restatements
insider_buy: 2=net open-market buying recently, 1=neutral/insufficient data, 0=net sellers while promoting stock`;

        const qualScores = {};
        try {
          const gRes = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${env.GEMINI_API_KEY}`,
            { method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ contents: [{ parts: [{ text: qualPrompt }] }], generationConfig: { temperature: 0.2, maxOutputTokens: 8192 } }) }
          );
          const gData   = await gRes.json();
          const gParts  = gData.candidates?.[0]?.content?.parts || [];
          const rawText = gParts.filter(p => !p.thought).map(p => p.text || '').join('');
          let parsed = null;
          const cleaned = rawText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
          try { parsed = JSON.parse(cleaned); } catch {
            const m = cleaned.match(/\{[\s\S]*\}/);
            if (m) { try { parsed = JSON.parse(m[0]); } catch { try { parsed = JSON.parse(m[0].replace(/,\s*([}\]])/g, '$1')); } catch {} } }
          }
          for (const cid of QUAL_IDS) {
            let score = 1, note = 'AI assessed';
            if (parsed?.[`${cid}_score`] !== undefined) { score = parseInt(parsed[`${cid}_score`]); note = parsed[`${cid}_why`] || 'AI assessed'; }
            else {
              const sm = rawText.match(new RegExp(`"${cid}_score"\\s*:\\s*(\\d)`)); if (sm) score = parseInt(sm[1]);
              const nm = rawText.match(new RegExp(`"${cid}_why"\\s*:\\s*"([^"]*)"`));  if (nm) note  = nm[1];
            }
            qualScores[cid] = { score: Math.min(2, Math.max(0, score)), note, ...QUAL_META[cid] };
          }
        } catch (e) {
          for (const cid of QUAL_IDS) qualScores[cid] = { score: 1, note: `Gemini error: ${String(e.message).slice(0, 60)}`, ...QUAL_META[cid] };
        }

        // 5. Combine scores
        const allCriteria = { ...criteria, ...qualScores };
        const QUAL_SET    = new Set(QUAL_IDS);
        let quantScore = 0, qualScore = 0, quantMax = 0, qualMax = 0;
        for (const [id, c] of Object.entries(allCriteria)) {
          if (QUAL_SET.has(id)) { qualScore  += c.score * c.weight; qualMax  += c.weight * 2; }
          else                   { quantScore += c.score * c.weight; quantMax += c.weight * 2; }
        }
        const total      = quantScore + qualScore;
        const maxTotal   = quantMax + qualMax;
        const pctVal     = maxTotal > 0 ? (total / maxTotal) * 100 : 0;
        const conviction = pctVal >= 75 ? 'STRONG BUY' : pctVal >= 56 ? 'WATCH' : 'PASS';

        const redFlags = [];
        if ((allCriteria.roe?.score        || 0) === 0) redFlags.push('ROE below 15%');
        if ((allCriteria.rev_growth?.score || 0) === 0) redFlags.push('Revenue growth < 5%');
        if ((allCriteria.debt?.score       || 0) === 0) redFlags.push('High debt load');
        if (marketCap && marketCap > 5e9)              redFlags.push('Market cap > $5B');
        if ((allCriteria.moat?.score       || 0) === 0) redFlags.push('No identifiable moat');

        const scoreResult = {
          ticker: symbol, company, sector, industry,
          criteria: allCriteria,
          quant_score: quantScore, quant_max: quantMax,
          qual_score: qualScore, qual_max: qualMax,
          total, max: maxTotal,
          pct: Math.round(pctVal * 10) / 10,
          conviction, red_flags: redFlags,
          scored_at: new Date().toISOString().split('T')[0],
        };

        // 6. Persist to DB (non-fatal)
        try {
          await fetch('https://labanos.dk/screener.php', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': authHeader },
            body: JSON.stringify(scoreResult),
          });
        } catch (_) {}

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
      return fetch(url, { ...opts, signal: ctrl.signal }).finally(() => clearTimeout(timer));
    };

    const fmtDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Copenhagen' });
    const getRobustPrevClose = async (symbol) => {
      try {
        const yfUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=5m&range=5d`;
        const res   = await fetchWithTimeout(yfUrl, { headers: yfHeaders }, 6000);
        const data  = await res.json();
        const result     = data?.chart?.result?.[0];
        const meta       = result?.meta;
        if (!meta) return null;
        const timestamps = result?.timestamp ?? [];
        const closes     = result?.indicators?.quote?.[0]?.close ?? [];
        const today      = fmtDate.format(new Date());
        for (let i = timestamps.length - 1; i >= 0; i--) {
          if (closes[i] != null && fmtDate.format(new Date(timestamps[i] * 1000)) !== today) return closes[i];
        }
        return meta.chartPreviousClose ?? meta.previousClose ?? null;
      } catch { return null; }
    };

    try {
      const safeSymbols = symbolsParam.replace(/=/g, '%3D');
      const batchUrl = `https://query2.finance.yahoo.com/v7/finance/quote?symbols=${safeSymbols}&fields=regularMarketPrice,regularMarketChangePercent`;
      const batchRes = await fetchWithTimeout(batchUrl, { headers: yfHeaders }, 8000);
      if (batchRes.ok) {
        const data = await batchRes.json();
        const batchResults = data?.quoteResponse?.result || [];
        if (batchResults.length > 0) {
          const corrected = await Promise.all(batchResults.map(async q => {
            const price = q.regularMarketPrice;
            const prevClose = await getRobustPrevClose(q.symbol);
            const changePercent = (prevClose && price != null)
              ? ((price - prevClose) / prevClose) * 100
              : (q.regularMarketChangePercent ?? 0);
            return { symbol: q.symbol, regularMarketPrice: price, regularMarketChangePercent: changePercent };
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
        const res  = await fetchWithTimeout(yfUrl, { headers: yfHeaders }, 6000);
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
        return { symbol, regularMarketPrice: price, regularMarketChangePercent: changePercent };
      } catch { return null; }
    }));

    return new Response(JSON.stringify({ quoteResponse: { result: results.filter(Boolean), error: null } }), { headers: { 'Content-Type': 'application/json', ...corsHeaders } });
  },
};

// ── Gemini prompt builders ──────────────────────────────────────────────────────────────────
function buildValuationPrompt(symbol, stmts, currentPrice, currency, today) {
  const toM = v => (v != null && v !== 0) ? Math.round(v / 1e6) : null;
  const toMShares = v => (v != null && v !== 0) ? Math.round(v / 1e6) : null;

  const rows = stmts.map(s => ({
    year:         parseInt(s.calendarYear || s.date.slice(0, 4)),
    revenue:      toM(s.revenue),
    gross_profit: toM(s.grossProfit),
    op_income:    toM(s.operatingIncome),
    net_income:   toM(s.netIncome),
    shares:       toMShares(s.weightedAverageShsOutDil || s.weightedAverageShsOut),
  }));

  const y2 = rows[0] || {}, y1 = rows[1] || {}, y0 = rows[2] || {};
  const latRevGr  = (y0.revenue && y1.revenue) ? (((y0.revenue / y1.revenue) - 1) * 100).toFixed(1) + '%' : 'N/A';
  const latGM     = (y0.revenue && y0.gross_profit) ? ((y0.gross_profit / y0.revenue) * 100).toFixed(1) + '%' : 'N/A';
  const latOM     = (y0.revenue && y0.op_income) ? ((y0.op_income / y0.revenue) * 100).toFixed(1) + '%' : 'N/A';
  const latNM     = (y0.revenue && y0.net_income) ? ((y0.net_income / y0.revenue) * 100).toFixed(1) + '%' : 'N/A';
  const latOpConv = (y0.op_income && y0.net_income) ? ((y0.net_income / y0.op_income) * 100).toFixed(1) + '%' : 'N/A';
  const histText  = rows.map(r => `  FY${r.year}: Rev=${r.revenue}M  GP=${r.gross_profit}M  EBIT=${r.op_income}M  NI=${r.net_income}M  Shares=${r.shares}M`).join('\n');

  return `You are a professional equity analyst. Generate a bear/base/bull 5-year DCF valuation model for ${symbol} as a single JSON object.\n\n## Financial Data (${currency} millions, most recent 3 fiscal years)\n${histText}\n\n## Current Market Price: ${currentPrice} ${currency}  |  Date: ${today}\n\n## Key Ratios (FY${y0.year})\n- Revenue growth YoY: ${latRevGr}\n- Gross margin: ${latGM}\n- Operating margin: ${latOM}\n- Net margin: ${latNM}\n- Operating-to-net conversion: ${latOpConv}\n\n## Requirements\n- 3 scenarios: bear (pessimistic), base (realistic), bull (optimistic)\n- scenario_weight: bear=0.25, base=0.45, bull=0.30\n- proj_years: 5 for all scenarios\n- disc_rt: 0.09 for bear, 0.08 for base, 0.08 for bull\n- 10 exit P/E multiples per scenario with probability weights summing exactly to 1.0\n- mos (margin of safety): ~0.30 bear, ~0.20 base, ~0.15 bull\n- All monetary values in millions of ${currency}\n- shares = shares outstanding in millions (negative shr_chg = buybacks)\n- current_price must be ${currentPrice} in all scenarios\n\n## Output JSON Schema (return ONLY valid JSON, no markdown, no explanation)\n{\n  \"ticker\": \"${symbol}\",\n  \"model_date\": \"${today}\",\n  \"currency\": \"${currency}\",\n  \"notes\": \"AI-generated by Gemini on ${today}\",\n  \"actuals\": [\n    {\"label\":\"Y-2\",\"fiscal_year\":${y2.year || 0},\"revenue\":${y2.revenue || 0},\"gross_profit\":${y2.gross_profit || 0},\"op_income\":${y2.op_income || 0},\"net_income\":${y2.net_income || 0},\"shares\":${y2.shares || 0}},\n    {\"label\":\"Y-1\",\"fiscal_year\":${y1.year || 0},\"revenue\":${y1.revenue || 0},\"gross_profit\":${y1.gross_profit || 0},\"op_income\":${y1.op_income || 0},\"net_income\":${y1.net_income || 0},\"shares\":${y1.shares || 0}},\n    {\"label\":\"Y0\",\"fiscal_year\":${y0.year || 0},\"revenue\":${y0.revenue || 0},\"gross_profit\":${y0.gross_profit || 0},\"op_income\":${y0.op_income || 0},\"net_income\":${y0.net_income || 0},\"shares\":${y0.shares || 0}}\n  ],\n  \"scenarios\": [\n    {\"scenario\":\"bear\",\"scenario_weight\":0.25,\"current_price\":${currentPrice},\"rev_growth\":<n>,\"tgt_gm\":<n>,\"tgt_om\":<n>,\"op_conv\":<n>,\"shr_chg\":<n>,\"proj_years\":5,\"disc_rt\":0.09,\"mos\":0.30,\"multiples\":[{\"multiple\":<int>,\"weight\":<float>},...10 entries weight=1.0]},\n    {\"scenario\":\"base\",\"scenario_weight\":0.45,\"current_price\":${currentPrice},\"rev_growth\":<n>,\"tgt_gm\":<n>,\"tgt_om\":<n>,\"op_conv\":<n>,\"shr_chg\":<n>,\"proj_years\":5,\"disc_rt\":0.08,\"mos\":0.20,\"multiples\":[...10 entries weight=1.0]},\n    {\"scenario\":\"bull\",\"scenario_weight\":0.30,\"current_price\":${currentPrice},\"rev_growth\":<n>,\"tgt_gm\":<n>,\"tgt_om\":<n>,\"op_conv\":<n>,\"shr_chg\":<n>,\"proj_years\":5,\"disc_rt\":0.08,\"mos\":0.15,\"multiples\":[...10 entries weight=1.0]}\n  ],\n  \"history\": [\n    {\"fiscal_year\":${y2.year || 0},\"revenue\":${y2.revenue || 0},\"gross_profit\":${y2.gross_profit || 0},\"op_income\":${y2.op_income || 0},\"net_income\":${y2.net_income || 0},\"shares\":${y2.shares || 0}},\n    {\"fiscal_year\":${y1.year || 0},\"revenue\":${y1.revenue || 0},\"gross_profit\":${y1.gross_profit || 0},\"op_income\":${y1.op_income || 0},\"net_income\":${y1.net_income || 0},\"shares\":${y1.shares || 0}},\n    {\"fiscal_year\":${y0.year || 0},\"revenue\":${y0.revenue || 0},\"gross_profit\":${y0.gross_profit || 0},\"op_income\":${y0.op_income || 0},\"net_income\":${y0.net_income || 0},\"shares\":${y0.shares || 0}}\n  ]\n}`;
}

function buildKnowledgePrompt(symbol, currentPrice, today) {
  return `You are a professional equity analyst. Generate a bear/base/bull 5-year DCF valuation model for ${symbol} as a single JSON object.\n\n## Instructions\nUse your training knowledge of ${symbol}'s publicly reported financials (most recent 3 fiscal years available to you).\nExpress all monetary values in millions of the company's reporting currency.\nThe notes field must say \"AI-generated by Gemini on ${today} (financials from training data)\".\n\n## Current Market Price: ${currentPrice}  |  Date: ${today}\n\n## Requirements\n- 3 scenarios: bear (pessimistic), base (realistic), bull (optimistic)\n- scenario_weight: bear=0.25, base=0.45, bull=0.30\n- proj_years: 5 for all scenarios\n- disc_rt: 0.09 for bear, 0.08 for base, 0.08 for bull\n- 10 exit P/E multiples per scenario with probability weights summing exactly to 1.0\n- mos (margin of safety): ~0.30 bear, ~0.20 base, ~0.15 bull\n- shares = shares outstanding in millions (negative shr_chg = buybacks)\n- current_price must be ${currentPrice} in all scenarios\n\n## Output JSON Schema (return ONLY valid JSON, no markdown, no explanation)\n{\n  \"ticker\": \"${symbol}\",\n  \"model_date\": \"${today}\",\n  \"currency\": \"<reporting currency>\",\n  \"notes\": \"AI-generated by Gemini on ${today} (financials from training data)\",\n  \"actuals\": [\n    {\"label\":\"Y-2\",\"fiscal_year\":<int>,\"revenue\":<int>,\"gross_profit\":<int>,\"op_income\":<int>,\"net_income\":<int>,\"shares\":<int>},\n    {\"label\":\"Y-1\",\"fiscal_year\":<int>,\"revenue\":<int>,\"gross_profit\":<int>,\"op_income\":<int>,\"net_income\":<int>,\"shares\":<int>},\n    {\"label\":\"Y0\",\"fiscal_year\":<int>,\"revenue\":<int>,\"gross_profit\":<int>,\"op_income\":<int>,\"net_income\":<int>,\"shares\":<int>}\n  ],\n  \"scenarios\": [\n    {\"scenario\":\"bear\",\"scenario_weight\":0.25,\"current_price\":${currentPrice},\"rev_growth\":<n>,\"tgt_gm\":<n>,\"tgt_om\":<n>,\"op_conv\":<n>,\"shr_chg\":<n>,\"proj_years\":5,\"disc_rt\":0.09,\"mos\":0.30,\"multiples\":[{\"multiple\":<int>,\"weight\":<float>},...10 entries weight=1.0]},\n    {\"scenario\":\"base\",\"scenario_weight\":0.45,\"current_price\":${currentPrice},\"rev_growth\":<n>,\"tgt_gm\":<n>,\"tgt_om\":<n>,\"op_conv\":<n>,\"shr_chg\":<n>,\"proj_years\":5,\"disc_rt\":0.08,\"mos\":0.20,\"multiples\":[...10 entries weight=1.0]},\n    {\"scenario\":\"bull\",\"scenario_weight\":0.30,\"current_price\":${currentPrice},\"rev_growth\":<n>,\"tgt_gm\":<n>,\"tgt_om\":<n>,\"op_conv\":<n>,\"shr_chg\":<n>,\"proj_years\":5,\"disc_rt\":0.08,\"mos\":0.15,\"multiples\":[...10 entries weight=1.0]}\n  ],\n  \"history\": [\n    {\"fiscal_year\":<int>,\"revenue\":<int>,\"gross_profit\":<int>,\"op_income\":<int>,\"net_income\":<int>,\"shares\":<int>},\n    {\"fiscal_year\":<int>,\"revenue\":<int>,\"gross_profit\":<int>,\"op_income\":<int>,\"net_income\":<int>,\"shares\":<int>},\n    {\"fiscal_year\":<int>,\"revenue\":<int>,\"gross_profit\":<int>,\"op_income\":<int>,\"net_income\":<int>,\"shares\":<int>}\n  ]\n}`;
}
