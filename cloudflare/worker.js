// v4 – quotes: try single batch v7/finance/quote first, fall back to per-symbol chart
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

    // ── AI Valuation Generator: ?generate_valuation=SYMBOL&portfolio_id=N&current_price=NNN ──
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
        // 1. Fetch income statements from FMP (last 5 annual reports)
        const symbol    = genTicker.toUpperCase();
        const fmpSymbol = symbol.replace(/\.[A-Z]{1,3}$/, ''); // strip exchange suffix
        const fmpKey    = env.FMP_API_KEY;

        const fmpRes = await fetch(
          `https://financialmodelingprep.com/stable/income-statement?symbol=${encodeURIComponent(fmpSymbol)}&limit=5&apikey=${fmpKey}`,
          { headers: { 'User-Agent': 'Mozilla/5.0' } }
        );
        const fmpText = await fmpRes.text();
        let fmpData = null;
        try { fmpData = JSON.parse(fmpText); } catch (e) { /* fall through to knowledge fallback */ }

        const today = new Date().toISOString().split('T')[0];
        let prompt;

        if (Array.isArray(fmpData) && fmpData.length > 0) {
          // FMP data available — use real financials
          const annuals  = fmpData
            .filter(r => !r.period || r.period === 'FY')
            .sort((a, b) => a.date.localeCompare(b.date));
          const stmts    = annuals.slice(-3);
          const currency = fmpData[0]?.reportedCurrency || 'USD';
          prompt = buildValuationPrompt(symbol, stmts, currentPrice, currency, today);
        } else {
          // FMP unavailable (premium ticker, quota, etc.) — ask Gemini to use its own knowledge
          prompt = buildKnowledgePrompt(symbol, currentPrice, today);
        }

        // 3. Call Gemini
        const geminiKey = env.GEMINI_API_KEY;
        const geminiRes = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${geminiKey}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [{ parts: [{ text: prompt }] }],
              generationConfig: {
                responseMimeType: 'application/json',
                temperature: 0.3,
                maxOutputTokens: 8192,
              },
            }),
          }
        );

        if (!geminiRes.ok) {
          const errJson = await geminiRes.json().catch(() => null);
          const errMsg  = errJson?.error?.message || 'Unknown Gemini error';
          const errCode = errJson?.error?.code || geminiRes.status;
          // Surface quota errors with a readable message
          const friendly = errCode === 429
            ? 'Gemini quota exceeded — enable billing at aistudio.google.com or wait for quota reset'
            : `Gemini error ${errCode}: ${errMsg.slice(0, 200)}`;
          return new Response(JSON.stringify({ error: friendly }), {
            status: 502,
            headers: { 'Content-Type': 'application/json', ...corsHeaders },
          });
        }

        const geminiData = await geminiRes.json();
        // gemini-2.5-flash uses thinking mode: parts[0] is reasoning (thought:true), parts[1] is the actual response
        const parts   = geminiData.candidates?.[0]?.content?.parts || [];
        const rawJson = (parts.find(p => !p.thought) || parts[parts.length - 1])?.text;

        if (!rawJson) {
          return new Response(JSON.stringify({ error: 'No content from Gemini', raw: JSON.stringify(geminiData).slice(0, 400) }), {
            status: 502,
            headers: { 'Content-Type': 'application/json', ...corsHeaders },
          });
        }

        let payload;
        try {
          // Strip markdown code fences if Gemini wrapped the JSON
          const cleaned = rawJson.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
          payload = JSON.parse(cleaned);
        } catch (e) {
          return new Response(JSON.stringify({ error: 'Gemini returned invalid JSON', raw: rawJson.slice(0, 500) }), {
            status: 502,
            headers: { 'Content-Type': 'application/json', ...corsHeaders },
          });
        }

        // Attach portfolio_id (not in Gemini's scope)
        payload.portfolio_id = portfolioId;

        // 4. Save to valuations.php
        const saveRes = await fetch('https://labanos.dk/valuations.php', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': authHeader,
          },
          body: JSON.stringify(payload),
        });

        const saveData = await saveRes.json();
        return new Response(JSON.stringify(saveData), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });

      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), {
          status: 500,
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
      }
    }

    // ── News endpoint: ?news=<symbol> ────────────────────────────────────────
    const newsSymbol = url.searchParams.get('news');
    if (newsSymbol) {
      const yfUrl = `https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(newsSymbol)}&quotesCount=0&newsCount=10&listsCount=0`;
      const res  = await fetch(yfUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      });
      const data = await res.json();
      const news = (data?.news || []).map(n => ({
        title:     n.title,
        publisher: n.publisher,
        time:      n.providerPublishTime,
        link:      n.link,
        thumbnail: n.thumbnail?.resolutions?.[0]?.url ?? null,
      }));
      return new Response(JSON.stringify({ news }), {
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    }

    // ── Search endpoint: ?search=<query> ─────────────────────────────────────
    const searchQ = url.searchParams.get('search');
    if (searchQ) {
      const yfUrl = `https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(searchQ)}&quotesCount=8&newsCount=0&listsCount=0`;
      const res  = await fetch(yfUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      });
      const data = await res.json();
      const quotes = (data?.quotes || [])
        .filter(q => q.isYahooFinance && ['EQUITY', 'ETF', 'MUTUALFUND'].includes(q.quoteType))
        .slice(0, 8)
        .map(q => ({
          symbol:   q.symbol,
          name:     q.shortname || q.longname || q.symbol,
          exchange: q.exchDisp  || q.exchange  || '',
          type:     q.typeDisp  || q.quoteType || '',
        }));
      return new Response(JSON.stringify({ quotes }), {
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    }

    // ── Chart endpoint: ?chart=SYMBOL&range=... ───────────────────────────────
    const chart = url.searchParams.get('chart');
    if (chart) {
      const range = url.searchParams.get('range') || '3mo';
      const intervalMap = {
        '1d':  '5m',
        '5d':  '5m',
        '1mo': '1d',
        '3mo': '1d',
        '6mo': '1d',
        '1y':  '1wk',
        '2y':  '1wk',
        '5y':  '1mo',
        'max': '1mo',
      };
      const interval = intervalMap[range] || '1d';
      const yfUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(chart)}?interval=${interval}&range=${range}`;
      const res  = await fetch(yfUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      });
      const data = await res.json();
      const result = data?.chart?.result?.[0];
      if (!result) {
        return new Response(JSON.stringify({ error: 'No data' }), { status: 404, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
      }
      const timestamps = result.timestamp ?? [];
      const closes     = result.indicators?.quote?.[0]?.close ?? [];
      const currency   = result.meta?.currency ?? null;
      const points = timestamps.map((t, i) => ({ t, c: closes[i] ?? null })).filter(p => p.c !== null);
      const prevClose = result.meta?.chartPreviousClose ?? null;
      return new Response(JSON.stringify({ symbol: chart, currency, points, prevClose }), {
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    }

    // ── Quotes endpoint: ?symbols=X,Y,Z ──────────────────────────────────────
    const symbolsParam = url.searchParams.get('symbols');
    if (!symbolsParam) {
      return new Response(JSON.stringify({ error: 'Missing symbols parameter' }), {
        status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    }
    const symbols = symbolsParam.split(',').map(s => s.trim()).filter(Boolean);

    // Browser-like headers to reduce bot-detection blocks from Yahoo Finance
    const yfHeaders = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept': 'application/json, text/plain, */*',
      'Accept-Language': 'en-US,en;q=0.9',
      'Referer': 'https://finance.yahoo.com/',
    };

    // Strategy 1: single batch request to v7/finance/quote (1 round-trip for all symbols)
    try {
      const batchUrl = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(symbolsParam)}&fields=regularMarketPrice,regularMarketChangePercent`;
      const batchRes = await fetch(batchUrl, { headers: yfHeaders });
      if (batchRes.ok) {
        const data = await batchRes.json();
        const batchResults = data?.quoteResponse?.result || [];
        if (batchResults.length > 0) {
          return new Response(JSON.stringify({ quoteResponse: { result: batchResults, error: null } }), {
            headers: { 'Content-Type': 'application/json', ...corsHeaders },
          });
        }
      }
    } catch { /* fall through to per-symbol */ }

    // Strategy 2: per-symbol chart fetch (original approach, kept as fallback)
    const results = await Promise.all(symbols.map(async symbol => {
      try {
        const yfUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=5d`;
        const res  = await fetch(yfUrl, { headers: yfHeaders });
        const data = await res.json();
        const result     = data?.chart?.result?.[0];
        const meta       = result?.meta;
        if (!meta) return null;
        const price        = meta.regularMarketPrice ?? null;
        const timestamps   = result?.timestamp ?? [];
        const closes       = result?.indicators?.quote?.[0]?.close ?? [];
        const fmtDate      = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Copenhagen' });
        const today        = fmtDate.format(new Date());
        let prevClose = null;
        for (let i = timestamps.length - 1; i >= 0; i--) {
          if (closes[i] != null && fmtDate.format(new Date(timestamps[i] * 1000)) !== today) {
            prevClose = closes[i];
            break;
          }
        }
        prevClose = prevClose ?? meta.chartPreviousClose ?? meta.previousClose ?? null;
        const changePercent = (prevClose && price != null)
          ? ((price - prevClose) / prevClose) * 100
          : 0;
        return { symbol, regularMarketPrice: price, regularMarketChangePercent: changePercent };
      } catch {
        return null;
      }
    }));
    const body = JSON.stringify({ quoteResponse: { result: results.filter(Boolean), error: null } });
    return new Response(body, { headers: { 'Content-Type': 'application/json', ...corsHeaders } });
  },
};

// ── Gemini prompt builder ─────────────────────────────────────────────────────
function buildValuationPrompt(symbol, stmts, currentPrice, currency, today) {
  // Convert raw dollar values to millions
  const toM = v => (v != null && v !== 0) ? Math.round(v / 1e6) : null;
  // Shares: FMP returns actual count — convert to millions
  const toMShares = v => (v != null && v !== 0) ? Math.round(v / 1e6) : null;

  const rows = stmts.map(s => ({
    year:            parseInt(s.calendarYear || s.date.slice(0, 4)),
    revenue:         toM(s.revenue),
    gross_profit:    toM(s.grossProfit),
    op_income:       toM(s.operatingIncome),
    net_income:      toM(s.netIncome),
    shares:          toMShares(s.weightedAverageShsOutDil || s.weightedAverageShsOut),
  }));

  const y2 = rows[0] || {}, y1 = rows[1] || {}, y0 = rows[2] || {};

  const latRevGr   = (y0.revenue && y1.revenue) ? (((y0.revenue / y1.revenue) - 1) * 100).toFixed(1) + '%' : 'N/A';
  const latGM      = (y0.revenue && y0.gross_profit) ? ((y0.gross_profit / y0.revenue) * 100).toFixed(1) + '%' : 'N/A';
  const latOM      = (y0.revenue && y0.op_income) ? ((y0.op_income / y0.revenue) * 100).toFixed(1) + '%' : 'N/A';
  const latNM      = (y0.revenue && y0.net_income) ? ((y0.net_income / y0.revenue) * 100).toFixed(1) + '%' : 'N/A';
  const latOpConv  = (y0.op_income && y0.net_income) ? ((y0.net_income / y0.op_income) * 100).toFixed(1) + '%' : 'N/A';

  // Build compact historical text
  const histText = rows.map(r =>
    `  FY${r.year}: Rev=${r.revenue}M  GP=${r.gross_profit}M  EBIT=${r.op_income}M  NI=${r.net_income}M  Shares=${r.shares}M`
  ).join('\n');

  return `You are a professional equity analyst. Generate a bear/base/bull 5-year DCF valuation model for ${symbol} as a single JSON object.\n\n## Financial Data (${currency} millions, most recent 3 fiscal years)\n${histText}\n\n## Current Market Price: ${currentPrice} ${currency}  |  Date: ${today}\n\n## Key Ratios (FY${y0.year})\n- Revenue growth YoY: ${latRevGr}\n- Gross margin: ${latGM}\n- Operating margin: ${latOM}\n- Net margin: ${latNM}\n- Operating-to-net conversion: ${latOpConv}\n\n## Requirements\n- 3 scenarios: bear (pessimistic), base (realistic), bull (optimistic)\n- scenario_weight: bear=0.25, base=0.45, bull=0.30\n- proj_years: 5 for all scenarios\n- disc_rt: 0.09 for bear, 0.08 for base, 0.08 for bull\n- 10 exit P/E multiples per scenario with probability weights summing exactly to 1.0\n- mos (margin of safety): ~0.30 bear, ~0.20 base, ~0.15 bull\n- All monetary values in millions of ${currency}\n- shares = shares outstanding in millions (negative shr_chg = buybacks)\n- current_price must be ${currentPrice} in all scenarios\n\n## Output JSON Schema (return ONLY valid JSON, no markdown, no explanation)\n{\n  \"ticker\": \"${symbol}\",\n  \"model_date\": \"${today}\",\n  \"currency\": \"${currency}\",\n  \"notes\": \"AI-generated by Gemini on ${today}\",\n  \"actuals\": [\n    {\"label\":\"Y-2\",\"fiscal_year\":${y2.year || 0},\"revenue\":${y2.revenue || 0},\"gross_profit\":${y2.gross_profit || 0},\"op_income\":${y2.op_income || 0},\"net_income\":${y2.net_income || 0},\"shares\":${y2.shares || 0}},\n    {\"label\":\"Y-1\",\"fiscal_year\":${y1.year || 0},\"revenue\":${y1.revenue || 0},\"gross_profit\":${y1.gross_profit || 0},\"op_income\":${y1.op_income || 0},\"net_income\":${y1.net_income || 0},\"shares\":${y1.shares || 0}},\n    {\"label\":\"Y0\",\"fiscal_year\":${y0.year || 0},\"revenue\":${y0.revenue || 0},\"gross_profit\":${y0.gross_profit || 0},\"op_income\":${y0.op_income || 0},\"net_income\":${y0.net_income || 0},\"shares\":${y0.shares || 0}}\n  ],\n  \"scenarios\": [\n    {\n      \"scenario\": \"bear\",\n      \"scenario_weight\": 0.25,\n      \"current_price\": ${currentPrice},\n      \"rev_growth\": <number, e.g. 0.03>,\n      \"tgt_gm\": <number, e.g. 0.44>,\n      \"tgt_om\": <number, e.g. 0.27>,\n      \"op_conv\": <number, e.g. 0.80>,\n      \"shr_chg\": <number, e.g. -0.01>,\n      \"proj_years\": 5,\n      \"disc_rt\": 0.09,\n      \"mos\": 0.30,\n      \"multiples\": [\n        {\"multiple\": <int>, \"weight\": <float>},\n        ... 10 entries totaling weight 1.0\n      ]\n    },\n    {\n      \"scenario\": \"base\",\n      \"scenario_weight\": 0.45,\n      \"current_price\": ${currentPrice},\n      \"rev_growth\": <number>,\n      \"tgt_gm\": <number>,\n      \"tgt_om\": <number>,\n      \"op_conv\": <number>,\n      \"shr_chg\": <number>,\n      \"proj_years\": 5,\n      \"disc_rt\": 0.08,\n      \"mos\": 0.20,\n      \"multiples\": [... 10 entries totaling weight 1.0]\n    },\n    {\n      \"scenario\": \"bull\",\n      \"scenario_weight\": 0.30,\n      \"current_price\": ${currentPrice},\n      \"rev_growth\": <number>,\n      \"tgt_gm\": <number>,\n      \"tgt_om\": <number>,\n      \"op_conv\": <number>,\n      \"shr_chg\": <number>,\n      \"proj_years\": 5,\n      \"disc_rt\": 0.08,\n      \"mos\": 0.15,\n      \"multiples\": [... 10 entries totaling weight 1.0]\n    }\n  ],\n  \"history\": [\n    {\"fiscal_year\":${y2.year || 0},\"revenue\":${y2.revenue || 0},\"gross_profit\":${y2.gross_profit || 0},\"op_income\":${y2.op_income || 0},\"net_income\":${y2.net_income || 0},\"shares\":${y2.shares || 0}},\n    {\"fiscal_year\":${y1.year || 0},\"revenue\":${y1.revenue || 0},\"gross_profit\":${y1.gross_profit || 0},\"op_income\":${y1.op_income || 0},\"net_income\":${y1.net_income || 0},\"shares\":${y1.shares || 0}},\n    {\"fiscal_year\":${y0.year || 0},\"revenue\":${y0.revenue || 0},\"gross_profit\":${y0.gross_profit || 0},\"op_income\":${y0.op_income || 0},\"net_income\":${y0.net_income || 0},\"shares\":${y0.shares || 0}}\n  ]\n}`;
}

function buildKnowledgePrompt(symbol, currentPrice, today) {
  return `You are a professional equity analyst. Generate a bear/base/bull 5-year DCF valuation model for ${symbol} as a single JSON object.\n\n## Instructions\nUse your training knowledge of ${symbol}'s publicly reported financials (most recent 3 fiscal years available to you).\nExpress all monetary values in millions of the company's reporting currency.\nThe notes field must say \"AI-generated by Gemini on ${today} (financials from training data)\".\n\n## Current Market Price: ${currentPrice}  |  Date: ${today}\n\n## Requirements\n- 3 scenarios: bear (pessimistic), base (realistic), bull (optimistic)\n- scenario_weight: bear=0.25, base=0.45, bull=0.30\n- proj_years: 5 for all scenarios\n- disc_rt: 0.09 for bear, 0.08 for base, 0.08 for bull\n- 10 exit P/E multiples per scenario with probability weights summing exactly to 1.0\n- mos (margin of safety): ~0.30 bear, ~0.20 base, ~0.15 bull\n- shares = shares outstanding in millions (negative shr_chg = buybacks)\n- current_price must be ${currentPrice} in all scenarios\n\n## Output JSON Schema (return ONLY valid JSON, no markdown, no explanation)\n{\n  \"ticker\": \"${symbol}\",\n  \"model_date\": \"${today}\",\n  \"currency\": \"<reporting currency>\",\n  \"notes\": \"AI-generated by Gemini on ${today} (financials from training data)\",\n  \"actuals\": [\n    {\"label\":\"Y-2\",\"fiscal_year\":<int>,\"revenue\":<int>,\"gross_profit\":<int>,\"op_income\":<int>,\"net_income\":<int>,\"shares\":<int>},\n    {\"label\":\"Y-1\",\"fiscal_year\":<int>,\"revenue\":<int>,\"gross_profit\":<int>,\"op_income\":<int>,\"net_income\":<int>,\"shares\":<int>},\n    {\"label\":\"Y0\",\"fiscal_year\":<int>,\"revenue\":<int>,\"gross_profit\":<int>,\"op_income\":<int>,\"net_income\":<int>,\"shares\":<int>}\n  ],\n  \"scenarios\": [\n    {\n      \"scenario\": \"bear\",\n      \"scenario_weight\": 0.25,\n      \"current_price\": ${currentPrice},\n      \"rev_growth\": <number>,\n      \"tgt_gm\": <number>,\n      \"tgt_om\": <number>,\n      \"op_conv\": <number>,\n      \"shr_chg\": <number>,\n      \"proj_years\": 5,\n      \"disc_rt\": 0.09,\n      \"mos\": 0.30,\n      \"multiples\": [{\"multiple\": <int>, \"weight\": <float>}, ... 10 entries totaling weight 1.0]\n    },\n    {\n      \"scenario\": \"base\",\n      \"scenario_weight\": 0.45,\n      \"current_price\": ${currentPrice},\n      \"rev_growth\": <number>,\n      \"tgt_gm\": <number>,\n      \"tgt_om\": <number>,\n      \"op_conv\": <number>,\n      \"shr_chg\": <number>,\n      \"proj_years\": 5,\n      \"disc_rt\": 0.08,\n      \"mos\": 0.20,\n      \"multiples\": [... 10 entries totaling weight 1.0]\n    },\n    {\n      \"scenario\": \"bull\",\n      \"scenario_weight\": 0.30,\n      \"current_price\": ${currentPrice},\n      \"rev_growth\": <number>,\n      \"tgt_gm\": <number>,\n      \"tgt_om\": <number>,\n      \"op_conv\": <number>,\n      \"shr_chg\": <number>,\n      \"proj_years\": 5,\n      \"disc_rt\": 0.08,\n      \"mos\": 0.15,\n      \"multiples\": [... 10 entries totaling weight 1.0]\n    }\n  ],\n  \"history\": [\n    {\"fiscal_year\":<int>,\"revenue\":<int>,\"gross_profit\":<int>,\"op_income\":<int>,\"net_income\":<int>,\"shares\":<int>},\n    {\"fiscal_year\":<int>,\"revenue\":<int>,\"gross_profit\":<int>,\"op_income\":<int>,\"net_income\":<int>,\"shares\":<int>},\n    {\"fiscal_year\":<int>,\"revenue\":<int>,\"gross_profit\":<int>,\"op_income\":<int>,\"net_income\":<int>,\"shares\":<int>}\n  ]\n}`;
}
