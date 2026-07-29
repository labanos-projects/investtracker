// v7 – fix stale intraday change%: don't trust Yahoo's regularMarketChangePercent
// v8 – add ?score_ticker= endpoint
// v10 – Gemini scores all 18 criteria (YF blocks fundamental data from CF Workers)
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
        // Single Gemini call scores all 18 criteria + provides company metadata
        const scoringPrompt = `You are a professional equity analyst. Using your knowledge of publicly available financial data, assess the stock with ticker "${symbol}" on 18 investment criteria.

First identify the company. Then score each criterion 0, 1, or 2:
- 2 = clearly meets the bar
- 1 = partial / uncertain / insufficient data
- 0 = fails or red flag

Quantitative criteria (based on recent financials, last 3 years where possible):
- roe: Return on equity. 2=avg>=20%, 1=avg>=15%, 0=<15%
- rev_growth: Revenue CAGR. 2=>=10%/yr, 1=5-10%, 0=<5%
- gross_margin: Gross margin vs sector benchmark. 2=>5pp above sector, 1=within 5pp, 0=>5pp below
- insider_own: Insider ownership %. 2=>=10%, 1=5-10%, 0=<5%
- eps_growth: EPS growth. 2=>=10%/yr, 1=5-10%, 0=<5% or negative
- fcf: Free cash flow. 2=positive & growing, 1=positive, 0=negative
- debt: Leverage. 2=net cash or net debt/EBITDA<=2x, 1=2-3x, 0=>3x
- mktcap: Market cap. 2=$500M-$3B, 1=$300M-$5B, 0=outside range
- shares: Share count trend. 2=declining (buybacks), 1=stable, 0=diluting
- peg: PEG ratio. 2=<1, 1=1-2, 0=>2 or N/A
- dividend: Payout ratio (compounders prefer low/no dividend). 2=no dividend, 1=payout<40%, 0=payout>=40%
- roic: Return on invested capital. 2=>=15%, 1=10-15%, 0=<10%

Qualitative criteria:
- moat: Competitive moat durability. 2=wide 20+yr, 1=narrow ~10yr, 0=no moat
- runway: Growth runway / TAM. 2=large underpenetrated TAM, 1=some growth left, 0=saturated
- cap_alloc: Capital allocation quality. 2=excellent, 1=mixed, 0=value-destroying
- industry: Industry stability. 2=slow-changing for decades, 1=some flux but stable 5-10yr, 0=disruption risk within 5yr
- disclosure: Management transparency. 2=clear & candid, 1=adequate, 0=opaque or restatements
- insider_buy: Insider buying behaviour. 2=net open-market buyers, 1=neutral, 0=net sellers

Respond ONLY with flat JSON (no markdown, no extra text):
{"company":"...","sector":"...","industry":"...","roe_score":1,"roe_why":"...","rev_growth_score":1,"rev_growth_why":"...","gross_margin_score":1,"gross_margin_why":"...","insider_own_score":1,"insider_own_why":"...","eps_growth_score":1,"eps_growth_why":"...","fcf_score":1,"fcf_why":"...","debt_score":1,"debt_why":"...","mktcap_score":1,"mktcap_why":"...","shares_score":1,"shares_why":"...","peg_score":1,"peg_why":"...","dividend_score":1,"dividend_why":"...","roic_score":1,"roic_why":"...","moat_score":1,"moat_why":"...","runway_score":1,"runway_why":"...","cap_alloc_score":1,"cap_alloc_why":"...","industry_score":1,"industry_why":"...","disclosure_score":1,"disclosure_why":"...","insider_buy_score":1,"insider_buy_why":"..."}`;

        const gRes = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${env.GEMINI_API_KEY}`,
          { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ contents: [{ parts: [{ text: scoringPrompt }] }], generationConfig: { temperature: 0.2, maxOutputTokens: 8192 } }) }
        );
        if (!gRes.ok) {
          const e = await gRes.json().catch(() => ({}));
          throw new Error(`Gemini ${gRes.status}: ${e?.error?.message || 'unknown'}`);
        }
        const gData  = await gRes.json();
        const gParts = gData.candidates?.[0]?.content?.parts || [];
        const rawText = gParts.filter(p => !p.thought).map(p => p.text || '').join('');

        let parsed = null;
        const cleaned = rawText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
        try { parsed = JSON.parse(cleaned); } catch {
          const m = cleaned.match(/\{[\s\S]*\}/);
          if (m) { try { parsed = JSON.parse(m[0]); } catch { try { parsed = JSON.parse(m[0].replace(/,\s*([}\]])/g, '$1')); } catch {} } }
        }
        if (!parsed) throw new Error('Gemini returned unparseable JSON');

        // Build structured criteria from parsed response
        const QUANT_META = {
          roe:          { weight: 3, tier: 1 }, rev_growth:  { weight: 3, tier: 1 },
          gross_margin: { weight: 3, tier: 1 }, insider_own: { weight: 3, tier: 1 },
          eps_growth:   { weight: 2, tier: 2 }, fcf:         { weight: 2, tier: 2 },
          debt:         { weight: 2, tier: 2 }, mktcap:      { weight: 2, tier: 2 },
          shares:       { weight: 1, tier: 3 }, peg:         { weight: 1, tier: 3 },
          dividend:     { weight: 1, tier: 3 }, roic:        { weight: 1, tier: 3 },
        };
        const QUAL_META = {
          moat:       { weight: 3, tier: 1 }, runway:     { weight: 3, tier: 1 },
          cap_alloc:  { weight: 2, tier: 2 }, industry:   { weight: 2, tier: 2 },
          disclosure: { weight: 1, tier: 3 }, insider_buy:{ weight: 1, tier: 3 },
        };

        const criteria = {};
        for (const [id, meta] of Object.entries({ ...QUANT_META, ...QUAL_META })) {
          const score = Math.min(2, Math.max(0, parseInt(parsed[`${id}_score`]) || 1));
          const note  = parsed[`${id}_why`] || 'AI assessed';
          criteria[id] = { score, note, ...meta };
        }

        const QUAL_SET = new Set(Object.keys(QUAL_META));
        let quantScore = 0, qualScore = 0, quantMax = 0, qualMax = 0;
        for (const [id, c] of Object.entries(criteria)) {
          if (QUAL_SET.has(id)) { qualScore  += c.score * c.weight; qualMax  += c.weight * 2; }
          else                   { quantScore += c.score * c.weight; quantMax += c.weight * 2; }
        }
        const total    = quantScore + qualScore;
        const maxTotal = quantMax + qualMax;
        const pctVal   = maxTotal > 0 ? (total / maxTotal) * 100 : 0;
        const conviction = pctVal >= 75 ? 'STRONG BUY' : pctVal >= 56 ? 'WATCH' : 'PASS';
        const company  = parsed.company || symbol;
        const sector   = parsed.sector  || '';
        const industry = parsed.industry || '';

        const redFlags = [];
        if ((criteria.roe?.score        || 0) === 0) redFlags.push('ROE below 15%');
        if ((criteria.rev_growth?.score || 0) === 0) redFlags.push('Revenue growth < 5%');
        if ((criteria.debt?.score       || 0) === 0) redFlags.push('High debt load');
        if ((criteria.moat?.score       || 0) === 0) redFlags.push('No identifiable moat');

        const scoreResult = {
          ticker: symbol, company, sector, industry,
          criteria,
          quant_score: quantScore, quant_max: quantMax,
          qual_score: qualScore,  qual_max: qualMax,
          total, max: maxTotal,
          pct: Math.round(pctVal * 10) / 10,
          conviction, red_flags: redFlags,
          scored_at: new Date().toISOString().split('T')[0],
        };

        // Persist to DB (non-fatal)
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
