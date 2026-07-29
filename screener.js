// ─── ScreenerView ────────────────────────────────────────────────────────────────────────────────
function ScreenerView({ user, onRequireLogin }) {
  const [query,        setQuery]        = useState('');
  const [suggestions,  setSuggestions]  = useState([]);
  const [selected,     setSelected]     = useState(null);
  const [loading,      setLoading]      = useState(false);
  const [result,       setResult]       = useState(null);
  const [error,        setError]        = useState(null);
  const [history,      setHistory]      = useState([]);
  const [histLoading,  setHistLoading]  = useState(true);
  const [detailTicker, setDetailTicker] = useState(null);
  const [detailData,   setDetailData]   = useState(null);
  const [detailLoad,   setDetailLoad]   = useState(false);
  const debounceRef = React.useRef(null);

  // Load history on mount
  useEffect(() => {
    fetch(SCREENER_API)
      .then(r => r.ok ? r.json() : [])
      .then(rows => { setHistory(Array.isArray(rows) ? rows : []); setHistLoading(false); })
      .catch(() => setHistLoading(false));
  }, []);

  // Search autocomplete (debounced 300ms)
  const handleQueryChange = (val) => {
    setQuery(val);
    setSelected(null);
    clearTimeout(debounceRef.current);
    if (val.length < 1) { setSuggestions([]); return; }
    debounceRef.current = setTimeout(async () => {
      try {
        const res  = await fetch(`${WORKER_URL}?search=${encodeURIComponent(val)}`);
        const data = res.ok ? await res.json() : {};
        setSuggestions(data.quotes || []);
      } catch { setSuggestions([]); }
    }, 300);
  };

  const handleSelectSuggestion = (q) => {
    setSelected(q);
    setQuery(`${q.symbol} — ${q.name}`);
    setSuggestions([]);
  };

  // Core analysis call (runs after auth check)
  const doAnalyze = () => {
    const sym = selected
      ? selected.symbol
      : query.trim().split(/[\s—–-]/)[0].toUpperCase();
    if (!sym) return;
    setLoading(true);
    setError(null);
    setResult(null);
    fetch(`${WORKER_URL}?score_ticker=${encodeURIComponent(sym)}`, { headers: authHeaders() })
      .then(async r => {
        const data = await r.json();
        if (!r.ok) throw new Error(data.error || 'Scoring failed');
        return data;
      })
      .then(data => {
        setResult(data);
        setLoading(false);
        // Merge into history list (most-recent first)
        setHistory(prev => [
          {
            ticker: data.ticker, company: data.company, sector: data.sector,
            quant_score: data.quant_score, quant_max: data.quant_max,
            qual_score: data.qual_score,   qual_max: data.qual_max,
            total_score: data.total, max_score: data.max,
            pct: data.pct, conviction: data.conviction,
            red_flags: data.red_flags, scored_at: data.scored_at,
          },
          ...prev.filter(h => h.ticker !== data.ticker),
        ]);
      })
      .catch(err => {
        setError(err.message || 'Scoring failed');
        setLoading(false);
      });
  };

  const handleAnalyze = () => {
    if (!user) { onRequireLogin(doAnalyze); return; }
    doAnalyze();
  };

  const handleViewDetail = async (ticker) => {
    setDetailTicker(ticker);
    setDetailData(null);
    setDetailLoad(true);
    try {
      const res  = await fetch(`${SCREENER_API}?ticker=${encodeURIComponent(ticker)}`);
      const data = res.ok ? await res.json() : null;
      setDetailData(data);
    } catch { setDetailData(null); }
    setDetailLoad(false);
  };

  const handleDelete = async (ticker) => {
    if (!user || !confirm(`Delete analysis for ${ticker}?`)) return;
    try {
      await fetch(`${SCREENER_API}?ticker=${encodeURIComponent(ticker)}&_method=DELETE`, {
        method: 'POST', headers: authHeaders(),
      });
      setHistory(prev => prev.filter(h => h.ticker !== ticker));
      if (detailTicker === ticker) { setDetailTicker(null); setDetailData(null); }
      if (result?.ticker === ticker) setResult(null);
    } catch {}
  };

  // ── Detail view (full page) ────────────────────────────────────────────────
  if (detailTicker) {
    if (detailLoad || !detailData) {
      return (
        <div className="flex items-center justify-center h-64 gap-2 text-gray-400">
          <span className="spin text-xl">↻</span>
          <span className="text-sm">Loading {detailTicker}…</span>
        </div>
      );
    }
    return (
      <ScoreDetail
        data={detailData}
        onBack={() => { setDetailTicker(null); setDetailData(null); }}
        onDelete={handleDelete}
        user={user}
      />
    );
  }

  // ── Main view ──────────────────────────────────────────────────────────────
  return (
    <div className="max-w-xl mx-auto px-4 py-4">

      {/* ── Search card ── */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-4 mb-4">
        <div className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide mb-2">Score a company</div>
        <div className="relative">
          <input
            type="text"
            value={query}
            onChange={e => handleQueryChange(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') handleAnalyze(); }}
            onBlur={() => setTimeout(() => setSuggestions([]), 150)}
            placeholder="Ticker or company name…"
            className="w-full border border-gray-200 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-gray-300 pr-24"
          />
          <button
            onClick={handleAnalyze}
            disabled={loading || !query.trim()}
            className="absolute right-1.5 top-1.5 bottom-1.5 px-3 bg-gray-900 text-white text-xs font-semibold rounded-md disabled:opacity-40 hover:bg-gray-700 transition-colors"
          >
            {loading ? <span className="spin inline-block">↻</span> : 'Analyze'}
          </button>

          {/* Autocomplete dropdown */}
          {suggestions.length > 0 && (
            <div className="absolute left-0 right-0 top-full mt-1 bg-white border border-gray-200 rounded-lg shadow-lg z-20 overflow-hidden">
              {suggestions.slice(0, 6).map(q => (
                <button
                  key={q.symbol}
                  onMouseDown={() => handleSelectSuggestion(q)}
                  className="w-full text-left px-3 py-2.5 hover:bg-gray-50 flex items-center gap-2 border-b border-gray-50 last:border-0"
                >
                  <span className="font-semibold text-gray-900 text-sm w-16 shrink-0">{q.symbol}</span>
                  <span className="text-gray-500 text-xs truncate flex-1">{q.name}</span>
                  <span className="text-gray-300 text-[10px] shrink-0">{q.exchange}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        {error && (
          <div className="mt-2 text-xs text-red-500 bg-red-50 rounded px-2 py-1.5">{error}</div>
        )}
        {loading && (
          <div className="mt-2.5 text-xs text-gray-400 flex items-center gap-1.5">
            <span className="spin inline-block">↻</span>
            Fetching financials + AI assessment — ~15–20 seconds
          </div>
        )}
        {!user && (
          <div className="mt-2 text-[10px] text-gray-400">
            <span className="text-amber-500">⚠</span> Sign in to analyze and save results
          </div>
        )}
      </div>

      {/* ── Score result card ── */}
      {result && !loading && (
        <ScoreCard result={result} onViewFull={() => handleViewDetail(result.ticker)} />
      )}

      {/* ── History list ── */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
        <div className="px-4 py-2.5 border-b border-gray-50 flex items-center justify-between">
          <span className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide">Previously analyzed</span>
          <span className="text-[10px] text-gray-300">{history.length} {history.length === 1 ? 'company' : 'companies'}</span>
        </div>

        {histLoading ? (
          <div className="flex items-center justify-center h-20 text-gray-300 text-sm">
            <span className="spin mr-2">↻</span> Loading…
          </div>
        ) : history.length === 0 ? (
          <div className="flex items-center justify-center h-20 text-gray-300 text-xs">
            Search above to start scoring companies
          </div>
        ) : (
          <div className="divide-y divide-gray-50">
            {history.map(h => {
              const pctNum = parseFloat(h.pct) || 0;
              const barCls  = pctNum >= 75 ? 'bg-emerald-500' : pctNum >= 56 ? 'bg-amber-400' : 'bg-red-400';
              const badgeCls = h.conviction?.includes('STRONG')
                ? 'bg-emerald-100 text-emerald-600'
                : h.conviction?.includes('WATCH')
                  ? 'bg-amber-100 text-amber-600'
                  : 'bg-red-50 text-red-400';
              return (
                <div
                  key={h.ticker}
                  className="px-4 py-3 flex items-center gap-3 hover:bg-gray-50 cursor-pointer"
                  onClick={() => handleViewDetail(h.ticker)}
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5 mb-0.5">
                      <span className="font-semibold text-gray-900 text-sm">{h.ticker}</span>
                      {h.conviction && (
                        <span className={`text-[9px] font-semibold uppercase px-1.5 py-0.5 rounded-full ${badgeCls}`}>
                          {h.conviction}
                        </span>
                      )}
                      {h.red_flags?.length > 0 && <span className="text-amber-400 text-[10px]">⚠</span>}
                    </div>
                    <div className="text-[11px] text-gray-400 truncate mb-1.5">
                      {h.company}{h.sector ? ` · ${h.sector}` : ''}
                    </div>
                    <div className="w-full bg-gray-100 rounded-full h-1">
                      <div className={`${barCls} h-1 rounded-full`} style={{ width: `${Math.min(100, pctNum)}%` }} />
                    </div>
                  </div>
                  <div className="text-right shrink-0">
                    <div className="font-bold mono text-sm text-gray-800">{pctNum.toFixed(0)}%</div>
                    <div className="text-[10px] text-gray-300 mono">{h.total_score}/{h.max_score}</div>
                  </div>
                  {user && (
                    <button
                      onClick={e => { e.stopPropagation(); handleDelete(h.ticker); }}
                      className="text-gray-200 hover:text-red-400 transition-colors text-lg ml-0.5 shrink-0 leading-none"
                      title="Delete"
                    >×</button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── ScoreCard — compact inline result ─────────────────────────────────────────────────────
function ScoreCard({ result, onViewFull }) {
  const pct     = result.pct || 0;
  const barCls  = pct >= 75 ? 'bg-emerald-500'  : pct >= 56 ? 'bg-amber-400'  : 'bg-red-400';
  const textCls = pct >= 75 ? 'text-emerald-500' : pct >= 56 ? 'text-amber-500' : 'text-red-400';
  const badgeCls = result.conviction?.includes('STRONG')
    ? 'bg-emerald-100 text-emerald-600'
    : result.conviction?.includes('WATCH') ? 'bg-amber-100 text-amber-600' : 'bg-red-50 text-red-400';

  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-4 mb-4">
      <div className="flex items-start justify-between mb-2">
        <div>
          <div className="flex items-center gap-2">
            <span className="font-bold text-gray-900 text-base">{result.ticker}</span>
            <span className={`text-[9px] font-semibold uppercase px-1.5 py-0.5 rounded-full ${badgeCls}`}>
              {result.conviction}
            </span>
          </div>
          <div className="text-[11px] text-gray-400 mt-0.5">{result.company} · {result.sector}</div>
        </div>
        <div className="text-right shrink-0">
          <div className={`text-2xl font-bold mono ${textCls}`}>{pct.toFixed(0)}%</div>
          <div className="text-[10px] text-gray-400 mono">{result.total}/{result.max}</div>
        </div>
      </div>

      <div className="w-full bg-gray-100 rounded-full h-1.5 mb-3">
        <div className={`${barCls} h-1.5 rounded-full`} style={{ width: `${pct}%` }} />
      </div>

      <div className="flex gap-2 mb-3">
        {[
          ['Quant', `${result.quant_score} / ${result.quant_max}`],
          ['AI Qual', `${result.qual_score} / ${result.qual_max}`],
          ['Sector', result.sector || '—'],
        ].map(([label, val]) => (
          <div key={label} className="flex-1 bg-gray-50 rounded-lg px-2 py-2 text-center overflow-hidden">
            <div className="text-[9px] text-gray-400 uppercase tracking-wide">{label}</div>
            <div className="font-semibold text-gray-800 mono text-[11px] truncate mt-0.5">{val}</div>
          </div>
        ))}
      </div>

      {result.red_flags?.length > 0 && (
        <div className="text-xs text-amber-700 bg-amber-50 border border-amber-100 rounded px-2 py-1.5 mb-3">
          ⚠ {result.red_flags.join(' · ')}
        </div>
      )}

      <button
        onClick={onViewFull}
        className="w-full text-xs text-gray-400 hover:text-gray-700 transition-colors py-1 border-t border-gray-50 mt-1"
      >
        View full breakdown →
      </button>
    </div>
  );
}

// ─── ScoreDetail — full criteria breakdown ───────────────────────────────────────────────────
function ScoreDetail({ data, onBack, onDelete, user }) {
  if (!data) {
    return <div className="flex items-center justify-center h-48 text-gray-400 text-sm">No data</div>;
  }

  const CRITERIA_ORDER = [
    // Tier 1 — Must-Haves (weight 3)
    { id: 'roe',          label: 'ROE ≥ 20% avg',                weight: 3, tier: 1 },
    { id: 'rev_growth',   label: 'Revenue CAGR ≥ 10%',           weight: 3, tier: 1 },
    { id: 'gross_margin', label: 'Gross margin vs sector',        weight: 3, tier: 1 },
    { id: 'moat',         label: 'Durable economic moat',         weight: 3, tier: 1 },
    { id: 'insider_own',  label: 'Insider ownership ≥ 10%',      weight: 3, tier: 1 },
    { id: 'runway',       label: 'TAM / reinvestment runway',     weight: 3, tier: 1 },
    // Tier 2 — Important (weight 2)
    { id: 'eps_growth',   label: 'EPS CAGR ≥ 10%',               weight: 2, tier: 2 },
    { id: 'fcf',          label: 'FCF positive & growing',        weight: 2, tier: 2 },
    { id: 'debt',         label: 'Net debt / EBITDA < 2×',       weight: 2, tier: 2 },
    { id: 'mktcap',       label: 'Market cap $500M–$3B',          weight: 2, tier: 2 },
    { id: 'cap_alloc',    label: 'Capital allocation quality',    weight: 2, tier: 2 },
    { id: 'industry',     label: 'Stable, slow-changing sector',  weight: 2, tier: 2 },
    // Tier 3 — Supporting (weight 1)
    { id: 'shares',       label: 'Share count declining / flat',  weight: 1, tier: 3 },
    { id: 'peg',          label: 'PEG ratio < 1.0',               weight: 1, tier: 3 },
    { id: 'dividend',     label: 'Low / no dividend',             weight: 1, tier: 3 },
    { id: 'insider_buy',  label: 'Insiders net buying (AI)',      weight: 1, tier: 3 },
    { id: 'disclosure',   label: 'Clear management disclosures',  weight: 1, tier: 3 },
    { id: 'roic',         label: 'ROIC ≥ 10% avg',                weight: 1, tier: 3 },
  ];

  const SCORE_SYM  = { 2: '✓', 1: '∼', 0: '✗' };
  const SCORE_CLS  = { 2: 'text-emerald-500', 1: 'text-amber-500', 0: 'text-red-400' };
  const TIER_LABEL = {
    1: 'Tier 1 — Must-Haves  (×3)',
    2: 'Tier 2 — Important  (×2)',
    3: 'Tier 3 — Supporting  (×1)',
  };

  // Criteria come from fresh result (data.criteria) or DB load (data.score_data)
  const criteria = data.score_data || data.criteria || {};
  const pct      = parseFloat(data.pct) || 0;
  const total    = data.total_score ?? data.total ?? 0;
  const max      = data.max_score   ?? data.max   ?? 72;
  const qScore   = data.quant_score ?? 0;
  const qMax     = data.quant_max   ?? 48;
  const alScore  = data.qual_score  ?? 0;
  const alMax    = data.qual_max    ?? 24;
  const barCls   = pct >= 75 ? 'bg-emerald-500' : pct >= 56 ? 'bg-amber-400' : 'bg-red-400';
  const textCls  = pct >= 75 ? 'text-emerald-500' : pct >= 56 ? 'text-amber-500' : 'text-red-400';
  const badgeCls = data.conviction?.includes('STRONG')
    ? 'bg-emerald-100 text-emerald-600'
    : data.conviction?.includes('WATCH') ? 'bg-amber-100 text-amber-600' : 'bg-red-50 text-red-400';

  let lastTier = null;

  return (
    <div className="max-w-xl mx-auto">
      {/* Sticky header */}
      <div className="bg-white border-b border-gray-100 px-4 py-3 flex items-center gap-3 sticky top-0 z-10">
        <button onClick={onBack} className="text-gray-400 hover:text-gray-700 text-sm shrink-0">← Back</button>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="font-bold text-gray-900">{data.ticker}</span>
            {data.conviction && (
              <span className={`text-[9px] font-semibold uppercase px-1.5 py-0.5 rounded-full ${badgeCls}`}>
                {data.conviction}
              </span>
            )}
          </div>
          <div className="text-[10px] text-gray-400 truncate">{data.company}</div>
        </div>
        <div className="text-right shrink-0">
          <div className={`font-bold mono text-base ${textCls}`}>{pct.toFixed(0)}%</div>
          <div className="text-[10px] text-gray-300 mono">{total}/{max}</div>
        </div>
      </div>

      <div className="px-4 py-4">
        {/* Score bar */}
        <div className="w-full bg-gray-100 rounded-full h-2 mb-4">
          <div className={`${barCls} h-2 rounded-full`} style={{ width: `${pct}%` }} />
        </div>

        {/* Summary row */}
        <div className="grid grid-cols-3 gap-2 mb-4">
          {[
            ['Quant',   `${qScore} / ${qMax}`],
            ['AI Qual', `${alScore} / ${alMax}`],
            ['Verdict', data.conviction || '—'],
          ].map(([label, val]) => (
            <div key={label} className="bg-gray-50 rounded-lg px-2 py-2 text-center overflow-hidden">
              <div className="text-[9px] text-gray-400 uppercase tracking-wide">{label}</div>
              <div className={`font-semibold text-[11px] mt-0.5 truncate ${label === 'Verdict' ? textCls : 'text-gray-800 mono'}`}>{val}</div>
            </div>
          ))}
        </div>

        {/* Red flags */}
        {data.red_flags?.length > 0 && (
          <div className="text-xs text-amber-700 bg-amber-50 border border-amber-100 rounded-lg px-3 py-2 mb-4">
            ⚠ <strong>Red flags:</strong> {data.red_flags.join(' · ')}
          </div>
        )}

        {/* Criteria list */}
        <div>
          {CRITERIA_ORDER.map(def => {
            const c = criteria[def.id];
            if (!c) return null;
            const showTier = def.tier !== lastTier;
            lastTier = def.tier;
            return (
              <React.Fragment key={def.id}>
                {showTier && (
                  <div className="pt-4 pb-1.5 text-[9px] font-bold text-gray-400 uppercase tracking-widest">
                    {TIER_LABEL[def.tier]}
                  </div>
                )}
                <div className="flex items-start gap-2 py-2 border-b border-gray-50 last:border-0">
                  <span className={`${SCORE_CLS[c.score]} font-bold text-sm w-4 shrink-0 mt-px leading-tight`}>
                    {SCORE_SYM[c.score]}
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="text-[11px] font-medium text-gray-700 leading-tight">{def.label}</div>
                    <div className="text-[10px] text-gray-400 leading-snug mt-0.5">{c.note}</div>
                  </div>
                  <span className="text-[10px] text-gray-300 mono shrink-0">{c.score * def.weight}/{def.weight * 2}</span>
                </div>
              </React.Fragment>
            );
          })}
        </div>

        <div className="pt-4 text-[10px] text-gray-300 text-center">
          Scored {data.scored_at} · {data.sector} · {data.industry}
        </div>

        {user && (
          <button
            onClick={() => onDelete(data.ticker)}
            className="w-full mt-3 text-xs text-red-300 hover:text-red-500 transition-colors py-2 border-t border-gray-50"
          >
            Delete analysis
          </button>
        )}
      </div>
    </div>
  );
}
