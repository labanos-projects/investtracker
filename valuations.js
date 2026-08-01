// ─── Valuation calculation engine ─────────────────────────────────────
//
// NOTE: projectScenario/calcScenarioFV are mirrored server-side in
// cloudflare/valuation_model.js, which runs the same projection BEFORE saving so
// it can flag an implausible result. If you change the maths here, change it
// there — a divergence shows up as a model the sanity gate approved and this
// panel then renders differently.

// Project 5-year financials for a scenario, interpolating margins from Y0 to targets.
function projectScenario(sc, y0) {
  const n    = sc.proj_years || 5;
  const gm0  = y0.gross_profit / y0.revenue;
  const om0  = y0.op_income   / y0.revenue;
  let rev    = Number(y0.revenue);
  let shares = Number(y0.shares);
  const rows = [];
  for (let i = 1; i <= n; i++) {
    rev    = rev    * (1 + Number(sc.rev_growth));
    shares = shares * (1 + Number(sc.shr_chg));
    const t  = i / n;
    const gm = gm0 + (Number(sc.tgt_gm) - gm0) * t;
    const om = om0 + (Number(sc.tgt_om) - om0) * t;
    const ni = rev * om * Number(sc.op_conv);
    rows.push({ year: i, rev, gm, om, ni, shares, eps: ni / shares });
  }
  return rows;
}

// Compute weighted fair value (discounted terminal EPS × exit multiple) and buy target.
function calcScenarioFV(sc, projRows) {
  const termEPS = projRows[projRows.length - 1].eps;
  const n = sc.proj_years || 5;
  const r = Number(sc.disc_rt) || 0.08;
  const multiples = Array.isArray(sc.multiples) ? sc.multiples : [];
  let wFV = 0, wSum = 0;
  for (const m of multiples) {
    const px = termEPS * Number(m.multiple) / Math.pow(1 + r, n);
    wFV  += px * Number(m.weight);
    wSum += Number(m.weight);
  }
  const fv = wSum > 0 ? wFV / wSum : 0;
  return { fv, buyTarget: fv * (1 - Number(sc.mos || 0.20)), termEPS };
}

// ─── NewsPanel ─────────────────────────────────────────────────────
const NEWS_PREVIEW = 5;

function NewsPanel({ yhTicker }) {
  const [news,     setNews]     = useState(null);  // null = loading
  const [error,    setError]    = useState(false);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setNews(null); setError(false); setExpanded(false);
    fetch(`${WORKER_URL}?news=${encodeURIComponent(yhTicker)}`)
      .then(r => r.json())
      .then(d => { if (!cancelled) setNews(d.news || []); })
      .catch(() => { if (!cancelled) setError(true); });
    return () => { cancelled = true; };
  }, [yhTicker]);

  const timeAgo = (unix) => {
    const diff = Math.floor((Date.now() / 1000) - unix);
    if (diff < 3600)  return Math.floor(diff / 60) + 'm ago';
    if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
    return Math.floor(diff / 86400) + 'd ago';
  };

  const visible = news ? (expanded ? news : news.slice(0, NEWS_PREVIEW)) : [];
  const hasMore = news && news.length > NEWS_PREVIEW;

  return (
    <div className="mx-4 mb-6">
      <h2 className="text-[13px] font-semibold text-gray-600 uppercase tracking-wide mb-2">News</h2>

      {news === null && !error && (
        <div className="flex items-center gap-2 text-gray-400 text-[13px] py-4">
          <svg className="spin w-4 h-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/>
          </svg>
          Loading news…
        </div>
      )}

      {error && (
        <div className="text-[13px] text-gray-400 py-4">Could not load news.</div>
      )}

      {news && news.length === 0 && (
        <div className="bg-white rounded-xl border border-gray-100 shadow-sm px-4 py-6 text-center text-gray-400 text-sm">
          No recent news found.
        </div>
      )}

      {news && news.length > 0 && (
        <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
          {visible.map((item, i) => (
            <a key={i} href={item.link} target="_blank" rel="noopener noreferrer"
              className={`flex gap-3 items-start px-4 py-3 hover:bg-gray-50 transition-colors group ${i < visible.length - 1 || hasMore ? 'border-b border-gray-100' : ''}`}>
              {item.thumbnail && (
                <img src={item.thumbnail} alt="" className="w-12 h-12 rounded-lg object-cover shrink-0 mt-0.5 bg-gray-100" />
              )}
              <div className="flex-1 min-w-0">
                <p className="text-[13px] text-gray-800 font-medium leading-snug group-hover:text-blue-700 transition-colors line-clamp-2">
                  {item.title}
                </p>
                <div className="flex items-center gap-2 mt-1">
                  <span className="text-[11px] text-gray-400">{item.publisher}</span>
                  <span className="text-gray-300 text-[10px]">·</span>
                  <span className="text-[11px] text-gray-400 mono">{timeAgo(item.time)}</span>
                </div>
              </div>
              <span className="text-gray-300 group-hover:text-gray-400 text-[13px] shrink-0 mt-0.5 transition-colors">↗</span>
            </a>
          ))}

          {hasMore && (
            <button onClick={() => setExpanded(e => !e)}
              className="w-full px-4 py-2.5 text-[12px] text-blue-500 hover:text-blue-700 hover:bg-blue-50 transition-colors flex items-center justify-center gap-1 font-medium">
              {expanded
                ? <>Show less <span className="text-[10px]">▲</span></>
                : <>Show {news.length - NEWS_PREVIEW} more <span className="text-[10px]">▼</span></>}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Model provenance ────────────────────────────────────────────────
//
// The panel used to render a fair value and an upside percentage with nothing
// to say where they came from, so a model built from a language model's memory
// was indistinguishable from one built from a 10-K. That is how ServiceNow came
// to show a large upside off a pre-split share count for months.
//
// Models generated before the rework carry no `data_quality`; their only tell
// was a parenthetical in the notes. Match it, and mark them unverified until
// they are regenerated.
const LEGACY_TRAINING_RE = /financials from training data/i;

const FLAG_TEXT = {
  share_count_reconciliation_failed:
    'Reported share count could not be reconciled with market cap ÷ price.',
  share_count_drift:
    'Diluted shares sit more than 20% from the market-implied count — check for a split or a restatement.',
  implausible_upside:
    'Blended fair value is more than double the current price. Treat the upside as a hypothesis, not a finding.',
  baseline_pe_diverges_from_market:
    'Baseline earnings imply an entry P/E well away from the market’s trailing P/E.',
  base_exit_multiple_above_current_pe:
    'The base case exits above today’s multiple, so it assumes a re-rating on top of growth.',
  baseline_year_stale:
    'The last full fiscal year is 9+ months old — results reported since it closed are not in the baseline.',
};

function ValuationQualityBanner({ model }) {
  const [open, setOpen] = React.useState(false);

  const flags   = Array.isArray(model.flags) ? model.flags : [];
  const diag    = (model.diagnostics && typeof model.diagnostics === 'object') ? model.diagnostics : null;
  const legacy  = !model.data_quality && LEGACY_TRAINING_RE.test(model.notes || '');
  const manual  = !model.data_quality && !legacy;

  // A clean generated model and a hand-built one both earn silence. Only
  // something actually worth knowing gets a banner.
  if (!legacy && !flags.length && !diag) return null;
  if (manual && !flags.length && !diag) return null;

  const tone = (legacy || flags.length)
    ? { box: 'bg-amber-50 border-amber-200', text: 'text-amber-800', sub: 'text-amber-700', icon: '⚠' }
    : { box: 'bg-gray-50 border-gray-200',   text: 'text-gray-600',  sub: 'text-gray-500',  icon: '✓' };

  const srcs = diag?.field_sources || {};
  const srcLabel = Object.keys(srcs).length
    ? Object.entries(srcs).map(([k, v]) => `${k.replace(/_/g, ' ')} ← ${v}`).join(' · ')
    : null;

  return (
    <div className={`rounded-xl border ${tone.box} px-3 py-2 mb-2`}>
      <div className="flex items-start gap-2">
        <span className={`text-[12px] leading-4 ${tone.text}`}>{tone.icon}</span>
        <div className="flex-1 min-w-0">
          {legacy && (
            <div className={`text-[11px] font-semibold ${tone.text}`}>
              Unverified — built from recalled financials, not filings
            </div>
          )}
          {legacy && (
            <div className={`text-[10px] ${tone.sub} leading-relaxed mt-0.5`}>
              This model predates the filings-backed generator. Its historical figures were
              never checked against a 10-K. Regenerate before trusting the fair value.
            </div>
          )}

          {flags.map(f => (
            <div key={f} className={`text-[10px] ${tone.sub} leading-relaxed ${legacy ? 'mt-1' : ''}`}>
              {FLAG_TEXT[f] || f}
            </div>
          ))}

          {!legacy && !flags.length && diag && (
            <div className={`text-[10px] ${tone.sub}`}>Actuals resolved from filings; sanity checks passed.</div>
          )}

          {diag && (
            <button onClick={() => setOpen(o => !o)}
              className={`text-[10px] ${tone.sub} underline underline-offset-2 hover:opacity-70 mt-1`}>
              {open ? 'Hide provenance' : 'Show provenance'}
            </button>
          )}

          {open && diag && (
            <div className="mt-1.5 space-y-0.5">
              {srcLabel && (
                <div className="text-[10px] text-gray-500 mono break-words">{srcLabel}</div>
              )}
              {diag.baseline_pe != null && diag.market_pe != null && (
                <div className="text-[10px] text-gray-500 mono">
                  baseline P/E {diag.baseline_pe}x vs market {Number(diag.market_pe).toFixed(1)}x
                </div>
              )}
              {diag.years_resolved?.length > 0 && (
                <div className="text-[10px] text-gray-500 mono">
                  fiscal years {diag.years_resolved[0]}–{diag.years_resolved[diag.years_resolved.length - 1]}
                  {diag.edgar_cik ? ` · EDGAR CIK ${diag.edgar_cik}` : ''}
                </div>
              )}
              {Array.isArray(diag.sources) && diag.sources.length > 0 && (
                <div className="flex flex-wrap gap-1 pt-0.5">
                  {diag.sources.slice(0, 5).map((u, i) => (
                    <a key={i} href={u} target="_blank" rel="noopener noreferrer"
                      className="text-[9px] text-blue-500 hover:text-blue-700 bg-white border border-gray-200 rounded px-1.5 py-0.5">
                      source {i + 1} ↗
                    </a>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── ValuationPanel component ─────────────────────────────────────────
function ValuationPanel({ ticker, portfolioId, currentPrice, currency, user, onRequireLogin }) {
  const { useState, useEffect, useCallback } = React;
  const [model,      setModel]     = useState(null);
  const [loading,    setLoading]   = useState(true);
  const [expanded,   setExpanded]  = useState(false);
  const [activeTab,  setActiveTab] = useState('base');
  const [generating, setGenerating]= useState(false);
  const [genError,   setGenError]  = useState(null);
  const [editMode,   setEditMode]  = useState(false);
  const [originalModel, setOriginalModel] = useState(null);
  const [showActuals, setShowActuals] = useState(false);
  const [saving, setSaving] = useState(false);

  const handleActualsChange = (field, value) => {
    setModel(prevModel => {
      const newModel = { ...prevModel };
      const actualsY0 = newModel.actuals.find(a => a.label === 'Y0');
      if (actualsY0) {
        actualsY0[field] = value;
      }
      return newModel;
    });
  };

  const handleSave = async () => {
    setSaving(true);
    setGenError(null);
    try {
      const today = new Date().toISOString().split('T')[0];
      const payload = {
        ...model,
        model_date: today,
        notes: `Model with manuel user input on ${today}`,
        portfolio_id: portfolioId,
      };
      const res = await fetch(VALUATIONS_API, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok || data.error) {
        setGenError(data.error || 'Save failed');
        setSaving(false);
      } else {
        setEditMode(false);
        setSaving(false);
        loadModel();
      }
    } catch (e) {
      setGenError(e.message);
      setSaving(false);
    }
  };

  const handleCancel = () => {
    setModel(originalModel);
    setEditMode(false);
  };

  const handleScenarioChange = (field, value) => {
    setModel(prevModel => {
      const newModel = { ...prevModel };
      const scenario = newModel.scenarios.find(s => s.scenario === activeTab);
      if (scenario) {
        scenario[field] = value;
      }
      return newModel;
    });
  };

  const loadModel = useCallback(() => {
    if (!ticker) return;
    setLoading(true);
    setEditMode(false);
    fetch(`${VALUATIONS_API}?ticker=${encodeURIComponent(ticker)}`)
      .then(r => r.json())
      .then(data => {
        setModel(data || null);
        setOriginalModel(data ? JSON.parse(JSON.stringify(data)) : null); // Deep copy
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [ticker, portfolioId]);

  useEffect(() => { loadModel(); }, [loadModel]);

  const generateValuation = async () => {
    const token = localStorage.getItem('auth_token');
    if (!token) { onRequireLogin(() => generateValuation()); return; }
    setGenerating(true);
    setGenError(null);
    try {
      const params = new URLSearchParams({
        generate_valuation: ticker,
        portfolio_id:       portfolioId,
        current_price:      currentPrice || 0,
      });
      const res = await fetch(`${WORKER_URL}?${params}`, {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      const data = await res.json();
      if (!res.ok || data.error) {
        // A 422 means the inputs failed to reconcile with the market and
        // nothing was saved. The reason is the useful part — show it whole
        // rather than collapsing it to "Generation failed".
        setGenError(data.error || 'Generation failed');
      } else {
        // Reload model from DB
        await new Promise(r => setTimeout(r, 400));
        loadModel();
      }
    } catch (e) {
      setGenError(e.message);
    } finally {
      setGenerating(false);
    }
  };

  if (loading) return null;

  // ── No model yet — show empty state with Generate button ─────────────────
  if (!model) {
    return (
      <div className="mx-4 mb-4">
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-[13px] font-semibold text-gray-600 uppercase tracking-wide">Valuation Model</h2>
        </div>
        <div className="bg-white rounded-xl border border-dashed border-gray-200 px-4 py-6 text-center">
          <div className="text-[13px] text-gray-400 mb-3">No valuation model yet</div>
          {genError && <div className="text-[11px] text-red-500 mb-2 text-left leading-relaxed">{genError}</div>}
          <button
            onClick={generateValuation}
            disabled={generating}
            className="inline-flex items-center gap-1.5 bg-gray-900 text-white text-[12px] font-medium px-4 py-2 rounded-lg hover:bg-gray-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors">
            {generating
              ? <><span className="animate-spin inline-block w-3 h-3 border border-white border-t-transparent rounded-full"></span> Generating…</>
              : '✦ Generate with AI'}
          </button>
        </div>
      </div>
    );
  }

  const y0 = (model.actuals || []).find(a => a.label === 'Y0');
  if (!y0 || !model.scenarios?.length) return null;

  // Per-scenario calculations
  const sdMap = {};
  let blendedFV = 0, blendedWt = 0;
  for (const sc of model.scenarios) {
    const proj = projectScenario(sc, y0);
    const { fv, buyTarget, termEPS } = calcScenarioFV(sc, proj);
    sdMap[sc.scenario] = { sc, proj, fv, buyTarget, termEPS };
    blendedFV += fv * Number(sc.scenario_weight);
    blendedWt += Number(sc.scenario_weight);
  }
  if (blendedWt > 0) blendedFV /= blendedWt;
  const baseMOS      = Number(sdMap['base']?.sc?.mos || 0.20);
  const blendedBuy   = blendedFV * (1 - baseMOS);
  const upside       = currentPrice > 0 ? (blendedFV - currentPrice) / currentPrice : null;

  // Formatting helpers
  const f0 = v => v == null ? '—' : v.toLocaleString('en', {minimumFractionDigits:0, maximumFractionDigits:0});
  const f2 = v => v == null ? '—' : v.toLocaleString('en', {minimumFractionDigits:2, maximumFractionDigits:2});
  const fv_fmt = v => v >= 100 ? f0(v) : f2(v);
  const pct_fmt = v => v == null ? '—' : `${v >= 0 ? '+' : ''}${(v*100).toFixed(1)}%`;
  const rev_fmt = v => v >= 1e6 ? `${(v/1e6).toFixed(1)}T` : v >= 1e3 ? `${(v/1e3).toFixed(0)}B` : `${v.toFixed(0)}M`;
  const p_fmt   = v => v == null || isNaN(v) ? '—' : `${(v*100).toFixed(1)}%`;


  const EditableField = ({ label, value, isPct, onChange }) => (
    <div className="px-3 py-2 border-b border-r border-gray-50 last:border-r-0">
      <div className="text-[9px] text-gray-400 uppercase tracking-wide">{label}</div>
      {editMode ? (
        <input
          type="number"
          step={isPct ? "0.001" : "1"}
          value={isPct ? (value * 100).toFixed(1) : value}
          onChange={e => onChange(isPct ? parseFloat(e.target.value) / 100 : parseFloat(e.target.value))}
          className="w-full text-[12px] font-semibold mono text-gray-800 bg-gray-50 border border-gray-200 rounded-md px-1 py-0.5"
        />
      ) : (
        <div className="text-[12px] font-semibold mono text-gray-800">{isPct ? p_fmt(value) : value}</div>
      )}
    </div>
  );

  const SC_LABEL = { bear:'Bear', base:'Base', bull:'Bull' };
  const SC_BADGE = {
    bear: 'bg-red-50 text-red-600',
    base: 'bg-blue-50 text-blue-600',
    bull: 'bg-emerald-50 text-emerald-600',
  };
  const SC_BORDER = {
    bear: 'border-red-200',
    base: 'border-blue-200',
    bull: 'border-emerald-200',
  };

  return (
    <div className="mx-4 mb-4">
      {/* ── Section header ── */}
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-[13px] font-semibold text-gray-600 uppercase tracking-wide">Valuation Model</h2>
        <div className="flex items-center gap-2">
          {genError && <span className="text-[10px] text-red-400">{genError}</span>}

          {editMode ? (
            <>
              <button onClick={handleCancel} className="text-[11px] text-gray-500 hover:text-gray-700 px-2 py-1 rounded-md hover:bg-gray-100">Cancel</button>
              <button onClick={handleSave} disabled={saving} className="text-[11px] font-semibold bg-blue-600 text-white px-3 py-1 rounded-md hover:bg-blue-500 disabled:opacity-50">
                {saving ? 'Saving…' : 'Save'}
              </button>
            </>
          ) : (
            <>
              {user && (
                <button
                  onClick={() => onRequireLogin(() => setEditMode(true))}
                  title="Edit model"
                  className="text-[10px] text-gray-400 hover:text-gray-700 disabled:opacity-40 transition-colors flex items-center gap-1">
                  <span>✎</span>
                  <span>Edit</span>
                </button>
              )}
              <button
                onClick={generateValuation}
                disabled={generating}
                title="Regenerate with AI"
                className="text-[10px] text-gray-400 hover:text-gray-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors flex items-center gap-1">
                {generating
                  ? <><span className="animate-spin inline-block w-2.5 h-2.5 border border-gray-500 border-t-transparent rounded-full"></span> <span>Generating…</span></>
                  : <><span>✦</span> <span>Regenerate</span></>}
              </button>
            </>
          )}

          <span className="text-[10px] text-gray-300">·</span>
          <span className="text-[10px] text-gray-400">{model.model_date}</span>
        </div>
      </div>

      {/* ── Provenance / sanity banner — above the number it qualifies ── */}
      <ValuationQualityBanner model={model} />

      {/* ── Edit Y0 Actuals (collapsible) ── */}
      {editMode && (
        <div className="bg-white rounded-xl border border-gray-100 shadow-sm mb-2">
          <button onClick={() => setShowActuals(s => !s)} className="w-full text-left px-4 py-3 text-[12px] font-semibold text-gray-700 hover:bg-gray-50 flex justify-between items-center">
            <span>Edit Y0 Baseline Actuals</span>
            <span className={`transition-transform transform ${showActuals ? 'rotate-180' : ''}`}>▼</span>
          </button>
          {showActuals && y0 && (
            <div className="px-4 pb-3 border-t border-gray-100">
              <div className="grid grid-cols-2 gap-2 pt-2">
                <EditableField label="Revenue" value={y0.revenue} onChange={v => handleActualsChange('revenue', v)} />
                <EditableField label="Gross Profit" value={y0.gross_profit} onChange={v => handleActualsChange('gross_profit', v)} />
                <EditableField label="Op. Income" value={y0.op_income} onChange={v => handleActualsChange('op_income', v)} />
                <EditableField label="Shares" value={y0.shares} onChange={v => handleActualsChange('shares', v)} />
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Blended fair value summary card ── */}
      <div className="bg-white rounded-xl border border-gray-100 shadow-sm px-4 py-3 mb-2">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-[10px] text-gray-400 mb-0.5 uppercase tracking-wide">Blended Fair Value</div>
            <div className="text-[22px] font-bold text-gray-900 mono">
              {fv_fmt(blendedFV)} <span className="text-[12px] font-normal text-gray-400">{currency}</span>
            </div>
            <div className="text-[11px] text-gray-400 mt-0.5">
              Buy target: <span className="mono font-medium text-gray-700">{fv_fmt(blendedBuy)}</span>
              <span className="mx-1">·</span>MOS {(baseMOS*100).toFixed(0)}%
            </div>
          </div>
          <div className="text-right">
            <div className="text-[10px] text-gray-400 mb-0.5 uppercase tracking-wide">vs Current</div>
            <div className={`text-[20px] font-bold mono ${(upside||0) >= 0 ? 'text-emerald-500' : 'text-red-500'}`}>
              {upside != null ? pct_fmt(upside) : '—'}
            </div>
            <div className="text-[11px] text-gray-400 mono">{fv_fmt(currentPrice)} {currency}</div>
          </div>
        </div>
      </div>

      {/* ── Scenario cards ── */}
      <div className="grid grid-cols-3 gap-2 mb-1">
        {['bear','base','bull'].map(key => {
          const sd = sdMap[key]; if (!sd) return null;
          const { sc, fv, buyTarget } = sd;
          const scUpside = currentPrice > 0 ? (fv - currentPrice) / currentPrice : null;
          const isActive = expanded && activeTab === key;
          return (
            <div key={key}
              onClick={() => { if (!editMode) { setActiveTab(key); setExpanded(true); } }}
              className={`bg-white rounded-xl border shadow-sm px-3 py-2.5 transition-all ${isActive ? SC_BORDER[key] : 'border-gray-100'} ${editMode ? 'cursor-default' : 'cursor-pointer hover:shadow'}`}>
              <span className={`inline-block text-[9px] font-bold rounded px-1.5 py-0.5 mb-1.5 ${SC_BADGE[key]}`}>{SC_LABEL[key]}</span>
              <div className="text-[15px] font-bold mono text-gray-900">{fv_fmt(fv)}</div>
              <div className={`text-[11px] font-semibold mono ${(scUpside||0) >= 0 ? 'text-emerald-500' : 'text-red-500'}`}>{pct_fmt(scUpside)}</div>
              <div className="text-[10px] text-gray-400 mono mt-0.5">buy &lt; {fv_fmt(buyTarget)}</div>
            </div>
          );
        })}
      </div>

      {/* ── Expand / collapse toggle ── */}
      <button onClick={() => setExpanded(e => !e)}
        className="w-full text-[11px] text-gray-400 hover:text-gray-600 text-center py-1.5 transition-colors">
        {expanded ? '▲ Hide details' : '▼ Show projection'}
      </button>

      {/* ── Detail panel ── */}
      {expanded && (() => {
        const sd = sdMap[activeTab]; if (!sd) return null;
        const { sc, proj } = sd;
        const rationale = model.diagnostics?.rationales?.[activeTab];
        return (
          <div className="bg-white rounded-xl border border-gray-100 shadow-sm mt-1 overflow-hidden">
            {/* Scenario tabs */}
            <div className="flex border-b border-gray-100">
              {['bear','base','bull'].map(k => (
                <button key={k} onClick={() => setActiveTab(k)}
                  className={`flex-1 text-[11px] font-semibold py-2 transition-colors ${activeTab===k ? 'text-gray-900 border-b-2 border-gray-900 -mb-px' : 'text-gray-400 hover:text-gray-600'}`}>
                  {SC_LABEL[k]}
                </button>
              ))}
            </div>

            {/* Why this scenario looks like it does — the grounded rationale,
                so an assumption can be argued with rather than just accepted. */}
            {rationale && (
              <div className="px-3 py-2 border-b border-gray-50 bg-gray-50/50">
                <div className="text-[10px] text-gray-500 leading-relaxed">{rationale}</div>
              </div>
            )}

            {/* Assumptions chips */}
            <div className="grid grid-cols-3 border-b border-gray-100">
                <EditableField label="Rev Growth" value={sc.rev_growth} isPct={true} onChange={v => handleScenarioChange('rev_growth', v)} />
                <EditableField label="Target GM"  value={sc.tgt_gm}     isPct={true} onChange={v => handleScenarioChange('tgt_gm', v)} />
                <EditableField label="Target OM"  value={sc.tgt_om}     isPct={true} onChange={v => handleScenarioChange('tgt_om', v)} />
                <EditableField label="Op→Net"     value={sc.op_conv}    isPct={true} onChange={v => handleScenarioChange('op_conv', v)} />
                <EditableField label="Shr Δ/yr"   value={sc.shr_chg}    isPct={true} onChange={v => handleScenarioChange('shr_chg', v)} />
                <EditableField label="Discount"   value={sc.disc_rt}    isPct={true} onChange={v => handleScenarioChange('disc_rt', v)} />
            </div>

            {/* Projection table */}
            <table className="w-full text-[11px]">
              <thead>
                <tr className="border-b border-gray-100 text-gray-400 text-[10px] uppercase tracking-wide">
                  <th className="px-3 py-2 text-left font-medium">Year</th>
                  <th className="px-3 py-2 text-right font-medium">Revenue</th>
                  <th className="px-3 py-2 text-right font-medium">GM%</th>
                  <th className="px-3 py-2 text-right font-medium">OM%</th>
                  <th className="px-3 py-2 text-right font-medium">NI</th>
                  <th className="px-3 py-2 text-right font-medium">EPS</th>
                </tr>
              </thead>
              <tbody>
                {proj.map(row => (
                  <tr key={row.year} className="border-b border-gray-50 last:border-b-0 hover:bg-gray-50">
                    <td className="px-3 py-1.5 text-gray-500 font-semibold">Y+{row.year}</td>
                    <td className="px-3 py-1.5 text-right mono text-gray-700">{rev_fmt(row.rev)}</td>
                    <td className="px-3 py-1.5 text-right mono text-gray-500">{(row.gm*100).toFixed(1)}%</td>
                    <td className="px-3 py-1.5 text-right mono text-gray-500">{(row.om*100).toFixed(1)}%</td>
                    <td className="px-3 py-1.5 text-right mono text-gray-700">{rev_fmt(row.ni)}</td>
                    <td className="px-3 py-1.5 text-right mono font-semibold text-gray-900">{row.eps >= 100 ? f0(row.eps) : f2(row.eps)}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            {/* Model notes */}
            {editMode ? (
              <div className="px-3 py-2 border-t border-gray-50">
                <textarea
                  value={model.notes || ''}
                  onChange={e => setModel(m => ({ ...m, notes: e.target.value }))}
                  placeholder="Model notes..."
                  rows={2}
                  className="w-full text-[10px] text-gray-700 leading-relaxed bg-gray-50 border border-gray-200 rounded-lg px-2 py-1 outline-none focus:border-blue-300 resize-none"
                />
              </div>
            ) : model.notes && (
              <div className="px-3 py-2 border-t border-gray-50">
                <div className="text-[10px] text-gray-400 leading-relaxed">{model.notes}</div>
              </div>
            )}
          </div>
        );
      })()}
    </div>
  );
}
