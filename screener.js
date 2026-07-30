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
        if (!r.ok) {
          const err = new Error(data.error || 'Scoring failed');
          err.status = r.status;
          err.code = data.code;
          throw err;
        }
        return data;
      })
      .then(data => {
        setResult(data);
        setLoading(false);
        // Merge into history list (most-recent first). `persisted` tells us
        // whether the row actually reached the DB — if not, it will disappear
        // on reload, so don't let the list imply otherwise.
        setHistory(prev => [
          {
            ticker: data.ticker, company: data.company, sector: data.sector,
            quant_score: data.quant_score, quant_max: data.quant_max,
            qual_score: data.qual_score,   qual_max: data.qual_max,
            total_score: data.total, max_score: data.max,
            pct: data.pct, coverage_pct: data.coverage,
            sgr: data.sgr, years_to_10x: data.years_to_10x,
            conviction: data.conviction, roic_basis: data.roic_basis,
            red_flags: data.red_flags, scored_at: data.scored_at,
            _unsaved: data.persisted === false,
          },
          ...prev.filter(h => h.ticker !== data.ticker),
        ]);
      })
      .catch(err => {
        setLoading(false);
        // auth.php rotates api_token on every login, so a token left in
        // localStorage after signing in elsewhere is stale. The app looked
        // logged in, scoring appeared to work, and the save failed silently.
        // Clear it and re-prompt rather than leaving that state in place.
        if (err.status === 401 || err.code === 'token_invalid') {
          try { localStorage.removeItem('auth_token'); } catch {}
          setError('Session expired — please sign in again.');
          if (onRequireLogin) onRequireLogin(doAnalyze);
          return;
        }
        setError(err.message || 'Scoring failed');
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
            Pulling filings (EDGAR / Yahoo) + grounded AI research — ~10–30 seconds
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
              const stale  = h.conviction?.includes('STALE');
              const barCls  = stale ? 'bg-gray-300'
                : pctNum >= 70 ? 'bg-emerald-500' : pctNum >= 50 ? 'bg-amber-400' : 'bg-red-400';
              return (
                <div
                  key={h.ticker}
                  className="px-4 py-3 flex items-center gap-3 hover:bg-gray-50 cursor-pointer"
                  onClick={() => handleViewDetail(h.ticker)}
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5 mb-0.5 flex-wrap">
                      <span className="font-semibold text-gray-900 text-sm">{h.ticker}</span>
                      {h.conviction && (
                        <span className={`text-[9px] font-semibold uppercase px-1.5 py-0.5 rounded-full ${badgeColour(h.conviction)}`}>
                          {h.conviction}
                        </span>
                      )}
                      <BasisBadge basis={h.roic_basis} />
                      {h._unsaved && (
                        <span className="text-[9px] font-semibold uppercase px-1.5 py-0.5 rounded-full bg-red-50 text-red-500">
                          not saved
                        </span>
                      )}
                      {h.red_flags?.length > 0 && <span className="text-amber-400 text-[10px]">⚠</span>}
                    </div>
                    <div className="text-[11px] text-gray-400 truncate mb-1.5">
                      {h.company}{h.sector ? ` · ${h.sector}` : ''}
                      {h.years_to_10x ? ` · ~${h.years_to_10x}yr to 10×` : ''}
                    </div>
                    <div className="w-full bg-gray-100 rounded-full h-1">
                      <div className={`${barCls} h-1 rounded-full`} style={{ width: `${Math.min(100, pctNum)}%` }} />
                    </div>
                  </div>
                  <div className="text-right shrink-0">
                    <div className="font-bold mono text-sm text-gray-800">{stale ? '—' : `${pctNum.toFixed(0)}%`}</div>
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

// ─── Shared presentation helpers ──────────────────────────────────────────────
// A criterion with score === null had NO DATA. It is excluded from both the
// numerator and the denominator, so it must not render like a failure — that
// conflation is exactly what the old model got wrong.
const SCORE_SYM = { 2: '✓', 1: '∼', 0: '✗', null: '–' };
const SCORE_CLS = { 2: 'text-emerald-500', 1: 'text-amber-500', 0: 'text-red-400', null: 'text-gray-300' };

const SOURCE_LABEL = {
  edgar: 'EDGAR', 'edgar+yahoo': 'EDGAR', yahoo: 'Yahoo', 'yahoo-ts': 'Yahoo', fmp: 'FMP',
  'ai-grounded': 'AI', computed: 'calc', none: 'no data',
  'edgar/fcf': 'EDGAR', 'edgar+yahoo/fcf': 'EDGAR', 'yahoo-ts/fcf': 'Yahoo',
};
const SOURCE_CLS = {
  edgar: 'bg-emerald-50 text-emerald-600', 'edgar+yahoo': 'bg-emerald-50 text-emerald-600',
  yahoo: 'bg-blue-50 text-blue-500', 'yahoo-ts': 'bg-blue-50 text-blue-500', fmp: 'bg-blue-50 text-blue-500',
  'ai-grounded': 'bg-purple-50 text-purple-500', computed: 'bg-gray-100 text-gray-500',
  none: 'bg-gray-50 text-gray-300',
  'edgar/fcf': 'bg-emerald-50 text-emerald-600', 'edgar+yahoo/fcf': 'bg-emerald-50 text-emerald-600',
  'yahoo-ts/fcf': 'bg-blue-50 text-blue-500',
};

/**
 * Marks a score whose compounding engine was measured on CASH rather than
 * accounting earnings — i.e. the company is not yet profitable and the engine
 * is a candidate, not a track record. Renders nothing in the normal case;
 * it's an exception marker, not decoration.
 */
function BasisBadge({ basis }) {
  if (basis !== 'fcf') return null;
  return (
    <span
      className="text-[9px] font-semibold uppercase px-1.5 py-0.5 rounded-full bg-indigo-50 text-indigo-600"
      title="ROIC measured as FCF ÷ invested capital — accounting earnings are still negative, so the compounding engine is unproven"
    >
      cash roic
    </span>
  );
}

function pctColour(pct, conviction) {
  if (conviction?.includes('INSUFFICIENT') || conviction?.includes('STALE')) return 'text-gray-400';
  return pct >= 70 ? 'text-emerald-500' : pct >= 50 ? 'text-amber-500' : 'text-red-400';
}
function barColour(pct, conviction) {
  if (conviction?.includes('INSUFFICIENT') || conviction?.includes('STALE')) return 'bg-gray-300';
  return pct >= 70 ? 'bg-emerald-500' : pct >= 50 ? 'bg-amber-400' : 'bg-red-400';
}
function badgeColour(conviction) {
  if (conviction?.includes('STRONG')) return 'bg-emerald-100 text-emerald-600';
  if (conviction?.includes('WATCH')) return 'bg-amber-100 text-amber-600';
  if (conviction?.includes('INSUFFICIENT') || conviction?.includes('STALE')) return 'bg-gray-100 text-gray-500';
  return 'bg-red-50 text-red-400';
}

// ─── ScoreCard — compact inline result ─────────────────────────────────────────────────────
function ScoreCard({ result, onViewFull }) {
  const pct     = result.pct || 0;
  const barCls  = barColour(pct, result.conviction);
  const textCls = pctColour(pct, result.conviction);
  const badgeCls = badgeColour(result.conviction);
  const lowCoverage = (result.coverage ?? 100) < 70;
  const notSaved = result.persisted === false;

  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-4 mb-4">
      <div className="flex items-start justify-between mb-2">
        <div>
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-bold text-gray-900 text-base">{result.ticker}</span>
            <span className={`text-[9px] font-semibold uppercase px-1.5 py-0.5 rounded-full ${badgeCls}`}>
              {result.conviction}
            </span>
            <BasisBadge basis={result.roic_basis} />
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

      {/* Multibagger headline — the numbers this screen actually exists to surface */}
      <div className="flex gap-2 mb-3">
        {[
          ['Compounding', result.sgr != null ? `${result.sgr.toFixed(0)}%/yr` : '—'],
          ['→ 10×', result.years_to_10x ? `~${result.years_to_10x} yrs` : '—'],
          ['→ 100×', result.years_to_100x ? `~${result.years_to_100x} yrs` : '—'],
          ['Coverage', `${(result.coverage ?? 0).toFixed(0)}%`],
        ].map(([label, val]) => (
          <div key={label} className="flex-1 bg-gray-50 rounded-lg px-2 py-2 text-center overflow-hidden">
            <div className="text-[9px] text-gray-400 uppercase tracking-wide">{label}</div>
            <div className="font-semibold text-gray-800 mono text-[11px] truncate mt-0.5">{val}</div>
          </div>
        ))}
      </div>

      {/* A score that didn't reach the DB used to look identical to one that
          did, then vanish on reload. Say so instead. */}
      {notSaved && (
        <div className="text-xs text-red-600 bg-red-50 border border-red-200 rounded px-2 py-1.5 mb-3">
          ⚠ <strong>Not saved.</strong> Scored fine, but the database rejected it
          {result.persist_status ? ` (HTTP ${result.persist_status})` : ''}.
          {result.persist_status === 401
            ? ' Your session expired — sign in again and re-score.'
            : ' This result will disappear on reload.'}
        </div>
      )}

      {result.roic_basis === 'fcf' && (
        <div className="text-xs text-indigo-700 bg-indigo-50 border border-indigo-100 rounded px-2 py-1.5 mb-3">
          Compounding measured on <strong>cash</strong>, not earnings — this company isn't
          profitable yet, so the engine is a candidate rather than a track record.
        </div>
      )}

      {lowCoverage && (
        <div className="text-xs text-gray-600 bg-gray-50 border border-gray-200 rounded px-2 py-1.5 mb-3">
          Only {(result.coverage ?? 0).toFixed(0)}% of the rubric had data behind it — score withheld.
        </div>
      )}

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

  // Order and labels mirror cloudflare/screener_engine.js RUBRIC.
  const CRITERIA_ORDER = [
    // Tier 1 — the compounding engine (weight 3)
    { id: 'reinvestment',  label: 'Reinvestment engine (ROIC × retention)', weight: 3, tier: 1 },
    { id: 'roic',          label: 'ROIC ≥ 20%',                             weight: 3, tier: 1 },
    { id: 'rev_growth',    label: 'Revenue CAGR ≥ 20%',                     weight: 3, tier: 1 },
    { id: 'runway',        label: 'TAM headroom / reinvestment runway',     weight: 3, tier: 1 },
    { id: 'moat',          label: 'Durable moat (20yr+)',                   weight: 3, tier: 1 },
    // Tier 2 — multibagger preconditions (weight 2)
    { id: 'size_headroom', label: 'Size headroom (room to 10–100×)',        weight: 2, tier: 2 },
    { id: 'insider_own',   label: 'Owner-operator (insiders ≥ 10%)',        weight: 2, tier: 2 },
    { id: 'gross_margin',  label: 'Gross margin vs sector',                 weight: 2, tier: 2 },
    { id: 'fcf',           label: 'FCF positive & growing',                 weight: 2, tier: 2 },
    { id: 'debt',          label: 'Net debt / EBITDA < 1.5×',               weight: 2, tier: 2 },
    { id: 'cap_alloc',     label: 'Capital allocation quality',             weight: 2, tier: 2 },
    // Tier 3 — entry & hygiene (weight 1)
    { id: 'peg',           label: 'PEG < 1 (entry multiple)',               weight: 1, tier: 3 },
    { id: 'eps_growth',    label: 'EPS CAGR ≥ 15%',                         weight: 1, tier: 3 },
    { id: 'shares',        label: 'No dilution',                            weight: 1, tier: 3 },
    { id: 'industry',      label: 'Industry stability',                     weight: 1, tier: 3 },
    { id: 'disclosure',    label: 'Management transparency',                weight: 1, tier: 3 },
    { id: 'insider_buy',   label: 'Insiders net buying',                    weight: 1, tier: 3 },
  ];

  const TIER_LABEL = {
    1: 'Tier 1 — Compounding engine  (×3)',
    2: 'Tier 2 — Multibagger preconditions  (×2)',
    3: 'Tier 3 — Entry & hygiene  (×1)',
  };

  // Criteria come from fresh result (data.criteria) or DB load (data.score_data)
  const criteria = data.score_data || data.criteria || {};
  const pct      = parseFloat(data.pct) || 0;
  const total    = data.total_score ?? data.total ?? 0;
  const max      = data.max_score   ?? data.max   ?? 0;
  const coverage = parseFloat(data.coverage_pct ?? data.coverage ?? 0);
  const sgr      = data.sgr != null ? parseFloat(data.sgr) : null;
  const y10      = data.years_to_10x ?? null;
  const basis    = data.roic_basis || data.diagnostics?.roic_basis || 'earnings';
  const barCls   = barColour(pct, data.conviction);
  const textCls  = pctColour(pct, data.conviction);
  const badgeCls = badgeColour(data.conviction);
  const sources  = data.sources || [];

  let lastTier = null;

  return (
    <div className="max-w-xl mx-auto">
      {/* Sticky header */}
      <div className="bg-white border-b border-gray-100 px-4 py-3 flex items-center gap-3 sticky top-0 z-10">
        <button onClick={onBack} className="text-gray-400 hover:text-gray-700 text-sm shrink-0">← Back</button>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="font-bold text-gray-900">{data.ticker}</span>
            {data.conviction && (
              <span className={`text-[9px] font-semibold uppercase px-1.5 py-0.5 rounded-full ${badgeCls}`}>
                {data.conviction}
              </span>
            )}
            <BasisBadge basis={basis} />
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
        <div className="grid grid-cols-4 gap-2 mb-4">
          {[
            ['Compounding', sgr != null ? `${sgr.toFixed(0)}%/yr` : '—'],
            ['→ 10×',       y10 ? `~${y10} yrs` : '—'],
            ['Coverage',    coverage ? `${coverage.toFixed(0)}%` : '—'],
            ['Verdict',     data.conviction || '—'],
          ].map(([label, val]) => (
            <div key={label} className="bg-gray-50 rounded-lg px-2 py-2 text-center overflow-hidden">
              <div className="text-[9px] text-gray-400 uppercase tracking-wide">{label}</div>
              <div className={`font-semibold text-[11px] mt-0.5 truncate ${label === 'Verdict' ? textCls : 'text-gray-800 mono'}`}>{val}</div>
            </div>
          ))}
        </div>

        {basis === 'fcf' && (
          <div className="text-xs text-indigo-700 bg-indigo-50 border border-indigo-100 rounded-lg px-3 py-2 mb-4">
            <strong>Cash basis.</strong> Accounting earnings are still negative, so the
            compounding engine is measured as FCF ÷ invested capital. Treat it as a
            candidate to investigate, not a demonstrated track record.
          </div>
        )}

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
            const scoreKey = (c.score === null || c.score === undefined) ? null : c.score;
            const isNull   = scoreKey === null;
            const srcKey   = c.source || 'none';
            return (
              <React.Fragment key={def.id}>
                {showTier && (
                  <div className="pt-4 pb-1.5 text-[9px] font-bold text-gray-400 uppercase tracking-widest">
                    {TIER_LABEL[def.tier]}
                  </div>
                )}
                <div className={`flex items-start gap-2 py-2 border-b border-gray-50 last:border-0 ${isNull ? 'opacity-60' : ''}`}>
                  <span className={`${SCORE_CLS[scoreKey]} font-bold text-sm w-4 shrink-0 mt-px leading-tight`}>
                    {SCORE_SYM[scoreKey]}
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="text-[11px] font-medium text-gray-700 leading-tight flex items-center gap-1.5">
                      {def.label}
                      <span className={`text-[8px] px-1 py-px rounded uppercase tracking-wide ${SOURCE_CLS[srcKey] || SOURCE_CLS.none}`}>
                        {SOURCE_LABEL[srcKey] || srcKey}
                      </span>
                    </div>
                    <div className="text-[10px] text-gray-400 leading-snug mt-0.5">{c.note}</div>
                  </div>
                  <span className="text-[10px] text-gray-300 mono shrink-0">
                    {isNull ? 'n/a' : `${c.score * def.weight}/${def.weight * 2}`}
                  </span>
                </div>
              </React.Fragment>
            );
          })}
        </div>

        {/* Grounding citations — what the AI half actually read */}
        {sources.length > 0 && (
          <div className="pt-4">
            <div className="text-[9px] font-bold text-gray-400 uppercase tracking-widest pb-1.5">Sources</div>
            <div className="flex flex-wrap gap-1">
              {sources.map((s, i) => (
                <a key={i} href={s} target="_blank" rel="noopener noreferrer"
                   className="text-[9px] text-blue-500 hover:text-blue-700 bg-blue-50 rounded px-1.5 py-0.5 truncate max-w-[46%]">
                  {(() => { try { return new URL(s).hostname.replace(/^www\./, ''); } catch { return s; } })()}
                </a>
              ))}
            </div>
          </div>
        )}

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
