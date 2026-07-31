// ─── TransactionForm ───────────────────────────────────────────────────────
function TransactionForm({ form, onChange, onSave, onCancel, saving, error }) {
  return (
    <div className="bg-white rounded-xl border border-blue-100 shadow-sm px-4 py-3 mb-2">
      <div className="grid grid-cols-2 gap-2 mb-2">
        <div>
          <div className="text-[10px] text-gray-400 uppercase tracking-wide mb-0.5">Date</div>
          <input type="date" value={form.date}
            onChange={e => onChange(f => ({ ...f, date: e.target.value }))}
            className="w-full text-[12px] border border-gray-200 rounded-md px-2 py-1 outline-none focus:border-blue-300" />
        </div>
        <div>
          <div className="text-[10px] text-gray-400 uppercase tracking-wide mb-0.5">Type</div>
          <div className="flex gap-1">
            {['buy','sell'].map(t => (
              <button key={t} onClick={() => onChange(f => ({ ...f, type: t }))}
                className={`flex-1 text-[11px] font-semibold py-1 rounded-md border transition-colors ${
                  form.type === t
                    ? t === 'buy' ? 'bg-emerald-500 text-white border-emerald-500' : 'bg-red-500 text-white border-red-500'
                    : 'border-gray-200 text-gray-500 hover:bg-gray-50'
                }`}>{t.toUpperCase()}</button>
            ))}
          </div>
        </div>
      </div>
      <div className="grid grid-cols-3 gap-2 mb-2">
        {[['Shares','shares','1'],['Price','price','0.0001'],['Fees','fees','0.01']].map(([label,key,step]) => (
          <div key={key}>
            <div className="text-[10px] text-gray-400 uppercase tracking-wide mb-0.5">{label}</div>
            <input type="number" step={step} value={form[key]}
              onChange={e => onChange(f => ({ ...f, [key]: e.target.value }))}
              placeholder={key === 'fees' ? '0' : ''}
              className="w-full text-[12px] border border-gray-200 rounded-md px-2 py-1 outline-none focus:border-blue-300 mono" />
          </div>
        ))}
      </div>
      <div className="mb-2">
        <div className="text-[10px] text-gray-400 uppercase tracking-wide mb-0.5">Note <span className="normal-case">(optional)</span></div>
        <input type="text" value={form.note}
          onChange={e => onChange(f => ({ ...f, note: e.target.value }))}
          placeholder="Optional note…"
          className="w-full text-[12px] border border-gray-200 rounded-md px-2 py-1 outline-none focus:border-blue-300" />
      </div>
      {error && <div className="text-[11px] text-red-500 mb-1">{error}</div>}
      <div className="flex gap-2 justify-end">
        <button onClick={onCancel}
          className="text-[12px] text-gray-400 hover:text-gray-600 px-3 py-1 rounded-lg hover:bg-gray-100 transition-colors">Cancel</button>
        <button onClick={onSave} disabled={saving || !form.shares || !form.price}
          className="text-[12px] font-medium bg-gray-900 text-white px-3 py-1.5 rounded-lg disabled:opacity-40 hover:bg-gray-700 transition-colors">
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>
  );
}

// ─── NoteForm ──────────────────────────────────────────────────────────────
function NoteForm({ form, onChange, onSave, onCancel, saving, error, textareaRef }) {
  return (
    <div className="bg-white rounded-xl border border-blue-100 shadow-sm px-4 py-3 mb-2">
      <input
        type="date"
        value={form.date}
        onChange={e => onChange(f => ({ ...f, date: e.target.value }))}
        className="text-[11px] text-gray-500 mono border border-gray-200 rounded-md px-2 py-1 mb-2 outline-none focus:border-blue-300"
      />
      <textarea
        ref={textareaRef}
        value={form.text}
        onChange={e => onChange(f => ({ ...f, text: e.target.value }))}
        placeholder="Write your note…"
        rows={3}
        className="w-full text-[13px] text-gray-700 leading-relaxed border border-gray-200 rounded-lg px-3 py-2 outline-none focus:border-blue-300 resize-none"
        onKeyDown={e => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') onSave(); }}
      />
      {error && <div className="text-[11px] text-red-500 mt-1">{error}</div>}
      <div className="flex gap-2 mt-2 justify-end">
        <button onClick={onCancel}
          className="text-[12px] text-gray-400 hover:text-gray-600 px-3 py-1 rounded-lg hover:bg-gray-100 transition-colors">
          Cancel
        </button>
        <button onClick={onSave} disabled={saving || !form.text.trim()}
          className="text-[12px] font-medium bg-gray-900 text-white px-3 py-1.5 rounded-lg disabled:opacity-40 hover:bg-gray-700 transition-colors">
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>
  );
}

// ─── Portfolio Switcher ────────────────────────────────────────────────────
function PortfolioSwitcher({ portfolios, portfolioId, onSwitch, onCreateNew, onCcyChange, user }) {
  const [showMenu,   setShowMenu]   = React.useState(false);
  const [creating,   setCreating]   = React.useState(false);
  const [renaming,   setRenaming]   = React.useState(null); // portfolio object
  const [newName,    setNewName]    = React.useState('');
  const [saving,     setSaving]     = React.useState(false);
  const current = portfolios.find(p => p.id === portfolioId);

  const createPortfolio = async () => {
    if (!newName.trim()) return;
    setSaving(true);
    const token = localStorage.getItem('auth_token');
    const res = await fetch(PORTFOLIOS_API, {
      method: 'POST', headers: authHeaders(),
      body: JSON.stringify({ name: newName.trim() }),
    });
    if (res.ok) {
      const pf = await res.json();
      onCreateNew(pf);
      setNewName(''); setCreating(false);
    }
    setSaving(false);
  };

  const renamePortfolio = async () => {
    if (!newName.trim() || !renaming) return;
    setSaving(true);
    const res = await fetch(`${PORTFOLIOS_API}?id=${renaming.id}&_method=PUT`, {
      method: 'POST', headers: authHeaders(),
      body: JSON.stringify({ name: newName.trim() }),
    });
    if (res.ok) { onCreateNew({ ...renaming, name: newName.trim(), _rename: true }); setRenaming(null); setNewName(''); }
    setSaving(false);
  };

  const deletePortfolio = async (pf) => {
    if (!window.confirm(`Delete "${pf.name}"? This only works if the portfolio has no holdings.`)) return;
    const res = await fetch(`${PORTFOLIOS_API}?id=${pf.id}&_method=DELETE`, { method: 'POST', headers: authHeaders() });
    const data = await res.json();
    if (!res.ok) { alert(data.error || 'Could not delete'); return; }
    onCreateNew({ ...pf, _deleted: true });
  };

  if (creating || renaming) {
    return (
      <div className="flex items-center gap-1">
        <input autoFocus value={newName} onChange={e => setNewName(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') creating ? createPortfolio() : renamePortfolio(); if (e.key === 'Escape') { setCreating(false); setRenaming(null); } }}
          placeholder={creating ? 'Portfolio name…' : renaming?.name}
          className="bg-gray-800 text-white text-[12px] rounded-lg px-2 py-1 outline-none border border-gray-600 w-36" />
        <button onClick={creating ? createPortfolio : renamePortfolio} disabled={saving}
          className="text-[11px] bg-blue-600 hover:bg-blue-500 px-2 py-1 rounded-lg text-white disabled:opacity-50">
          {saving ? '…' : 'Save'}
        </button>
        <button onClick={() => { setCreating(false); setRenaming(null); }} className="text-gray-400 hover:text-white text-[11px] px-1">✕</button>
      </div>
    );
  }

  return (
    <div className="relative">
      <button onClick={() => setShowMenu(m => !m)}
        className="flex items-center gap-1 text-[12px] text-gray-200 hover:text-white bg-gray-800 hover:bg-gray-700 px-2.5 py-1 rounded-lg transition-colors max-w-[120px]">
        <span className="truncate">{current?.name || 'Portfolio'}</span>
        <span className="text-gray-400 text-[10px]">▾</span>
      </button>
      {showMenu && (
        <div className="absolute left-0 top-full mt-1 bg-white rounded-xl shadow-xl border border-gray-100 z-50 min-w-[180px] py-1 overflow-hidden">
          {portfolios.map(pf => (
            <div key={pf.id} className={`flex items-center justify-between px-3 py-2 hover:bg-gray-50 ${pf.id === portfolioId ? 'bg-blue-50' : ''}`}>
              <button onClick={() => { onSwitch(pf.id, pf.base_currency); setShowMenu(false); }}
                className={`flex-1 text-left text-[13px] ${pf.id === portfolioId ? 'font-semibold text-blue-700' : 'text-gray-700'}`}>
                {pf.name}
                {pf.id === portfolioId && <span className="ml-1 text-[10px]">✓</span>}
              </button>
              {user && portfolios.length > 1 && (
                <div className="flex gap-0.5 ml-1">
                  <button onClick={() => { setRenaming(pf); setNewName(pf.name); setShowMenu(false); }}
                    className="text-gray-300 hover:text-blue-500 text-[12px] px-1">✎</button>
                  <button onClick={() => { deletePortfolio(pf); setShowMenu(false); }}
                    className="text-gray-300 hover:text-red-500 text-[12px] px-1">✕</button>
                </div>
              )}
            </div>
          ))}
          {user && onCcyChange && (() => {
            const activePf = portfolios.find(p => p.id === portfolioId);
            return (
              <div className="px-3 py-2 flex items-center justify-between border-t border-gray-100">
                <span className="text-[11px] text-gray-400">Display currency</span>
                <select
                  value={activePf?.base_currency || 'DKK'}
                  onClick={e => e.stopPropagation()}
                  onChange={e => { e.stopPropagation(); onCcyChange(portfolioId, e.target.value); setShowMenu(false); }}
                  className="text-[12px] border border-gray-200 rounded px-1.5 py-0.5 bg-white outline-none focus:border-blue-300 cursor-pointer ml-2">
                  {['DKK','USD','EUR','GBP','CAD','SEK','NOK'].map(c => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
            );
          })()}
          {user && (
            <button onClick={() => { setCreating(true); setNewName(''); setShowMenu(false); }}
              className="w-full text-left px-3 py-2 text-[12px] text-blue-600 hover:bg-blue-50 border-t border-gray-100 font-medium">
              + New portfolio
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Login Modal ───────────────────────────────────────────────────────────
function LoginModal({ onLogin, onClose }) {
  const [email,    setEmail]    = useState('');
  const [password, setPassword] = useState('');
  const [error,    setError]    = useState(null);
  const [loading,  setLoading]  = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setLoading(true); setError(null);
    try {
      const res  = await fetch(AUTH_API, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error || 'Login failed'); setLoading(false); return; }
      onLogin(data);
    } catch (_) { setError('Could not connect — check your connection.'); setLoading(false); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="relative bg-white w-full sm:max-w-sm rounded-t-2xl sm:rounded-2xl shadow-2xl px-6 pt-5 pb-8">
        <div className="flex items-center justify-between mb-5">
          <h2 className="font-bold text-gray-900 text-[16px]">Sign in to edit</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl px-1">✕</button>
        </div>
        <form onSubmit={submit} className="space-y-4">
          <div>
            <label className="block text-[11px] text-gray-400 uppercase tracking-wide mb-1">Email</label>
            <input type="email" value={email} onChange={e => setEmail(e.target.value)} required autoFocus
              className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="you@example.com" />
          </div>
          <div>
            <label className="block text-[11px] text-gray-400 uppercase tracking-wide mb-1">Password</label>
            <input type="password" value={password} onChange={e => setPassword(e.target.value)} required
              className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-blue-500" />
          </div>
          {error && <p className="text-red-500 text-[12px] bg-red-50 px-3 py-2 rounded-lg">{error}</p>}
          <button type="submit" disabled={loading}
            className="w-full bg-gray-900 hover:bg-gray-700 text-white font-semibold py-3 rounded-xl text-[14px] disabled:opacity-50 transition-colors">
            {loading ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      </div>
    </div>
  );
}

// ─── First-Time Setup Modal ─────────────────────────────────────────────────
function SetupModal({ onComplete }) {
  const [name,     setName]     = useState('');
  const [email,    setEmail]    = useState('');
  const [password, setPassword] = useState('');
  const [error,    setError]    = useState(null);
  const [loading,  setLoading]  = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setLoading(true); setError(null);
    try {
      const res  = await fetch(`${AUTH_API}?setup=1`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, email, password }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error || 'Setup failed'); setLoading(false); return; }
      onComplete(data);
    } catch (_) { setError('Could not connect — check your connection.'); setLoading(false); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-gray-900/80">
      <div className="relative bg-white w-full sm:max-w-sm rounded-t-2xl sm:rounded-2xl shadow-2xl px-6 pt-5 pb-8">
        <h2 className="font-bold text-gray-900 text-[16px] mb-1">Create your account</h2>
        <p className="text-[12px] text-gray-400 mb-5">First-time setup — only runs once.</p>
        <form onSubmit={submit} className="space-y-4">
          <div>
            <label className="block text-[11px] text-gray-400 uppercase tracking-wide mb-1">Your name</label>
            <input type="text" value={name} onChange={e => setName(e.target.value)} required autoFocus
              className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="Peter" />
          </div>
          <div>
            <label className="block text-[11px] text-gray-400 uppercase tracking-wide mb-1">Email</label>
            <input type="email" value={email} onChange={e => setEmail(e.target.value)} required
              className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="you@example.com" />
          </div>
          <div>
            <label className="block text-[11px] text-gray-400 uppercase tracking-wide mb-1">Password</label>
            <input type="password" value={password} onChange={e => setPassword(e.target.value)} required minLength={6}
              className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="At least 6 characters" />
          </div>
          {error && <p className="text-red-500 text-[12px] bg-red-50 px-3 py-2 rounded-lg">{error}</p>}
          <button type="submit" disabled={loading}
            className="w-full bg-blue-600 hover:bg-blue-500 text-white font-semibold py-3 rounded-xl text-[14px] disabled:opacity-50 transition-colors">
            {loading ? 'Creating account…' : 'Create account'}
          </button>
        </form>
      </div>
    </div>
  );
}

// `prefill` is passed by TickerPage — the company is already on screen, so the
// modal opens on the transaction fields rather than making you search for a
// ticker you are currently looking at.
function AddHoldingModal({ onClose, onAdded, portfolioId, prefill }) {
  const { useState, useEffect, useRef } = React;
  const today = new Date().toISOString().split('T')[0];

  // Search state
  const [query,       setQuery]       = useState('');
  const [results,     setResults]     = useState([]);
  const [searching,   setSearching]   = useState(false);
  const [selected,    setSelected]    = useState(prefill ? { symbol: prefill.yhTicker } : null);
  const debounceRef = useRef(null);

  // Form state (populated from prefill, search result, or manual entry)
  const [form, setForm] = useState({
    ticker:   prefill?.ticker   || '',
    yhTicker: prefill?.yhTicker || '',
    company:  prefill?.company  || '',
    ccy:      prefill?.ccy      || 'USD',
    date: today, type: 'buy', shares: '', price: '', fees: '0', note: '',
  });
  const [saving, setSaving] = useState(false);
  const [error,  setError]  = useState(null);

  const set = (key, val) => setForm(f => ({ ...f, [key]: val }));

  // Debounced search as user types
  useEffect(() => {
    const q = query.trim();
    if (!q) { setResults([]); return; }
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      setSearching(true);
      try {
        const res  = await fetch(`${WORKER_URL}?search=${encodeURIComponent(q)}`);
        const data = await res.json();
        setResults(data.quotes || []);
      } catch {
        setResults([]);
      }
      setSearching(false);
    }, 300);
    return () => clearTimeout(debounceRef.current);
  }, [query]);

  // When user picks a result from the dropdown
  const handleSelect = (q) => {
    // Derive internal ticker: strip exchange suffix (e.g. NOVO-B.CO -> NOVO-B)
    const internalTicker = q.symbol.replace(/\.[A-Z]{1,3}$/, '');
    setSelected(q);
    setQuery('');
    setResults([]);
    setForm(f => ({
      ...f,
      ticker:   internalTicker,
      yhTicker: q.symbol,
      company:  q.name,
    }));
  };

  const handleSave = async () => {
    const ticker = form.ticker.trim().toUpperCase();
    if (!ticker || !form.company.trim() || !form.shares || !form.price) {
      setError('Please fill in all required fields.'); return;
    }
    setSaving(true); setError(null);
    try {
      // 1. Create portfolio entry
      const portRes = await fetch(PORTFOLIO_API, {
        method: 'POST', headers: authHeaders(),
        body: JSON.stringify({
          ticker, company: form.company.trim(),
          yhTicker: form.yhTicker.trim() || ticker, ccy: form.ccy,
          portfolio_id: portfolioId,
        }),
      });
      if (!portRes.ok) {
        const err = await portRes.json().catch(() => ({}));
        throw new Error(err.error || 'Could not add holding');
      }
      const portEntry = await portRes.json();

      // 2. Create opening transaction
      const txnRes = await fetch(TRANSACTIONS_API, {
        method: 'POST', headers: authHeaders(),
        body: JSON.stringify({
          ticker, date: form.date, type: form.type,
          portfolio_id: portfolioId,
          shares: parseFloat(form.shares), price: parseFloat(form.price),
          fees: parseFloat(form.fees) || 0, note: form.note.trim(),
        }),
      });
      if (!txnRes.ok) throw new Error('Could not add opening transaction');
      const txn = await txnRes.json();

      onAdded(normalizePfRow(portEntry), txn);
      onClose();
    } catch (e) {
      setError(e.message || 'Something went wrong.');
    }
    setSaving(false);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative bg-white w-full sm:max-w-md sm:rounded-2xl rounded-t-2xl shadow-2xl px-4 pt-4 pb-8 max-h-[90vh] overflow-y-auto">

        <div className="flex items-center justify-between mb-4">
          <h2 className="text-[15px] font-bold text-gray-900">
            {prefill ? `Add ${prefill.ticker} to Portfolio` : 'Add New Holding'}
          </h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl leading-none px-1">✕</button>
        </div>

        {/* ── Ticker Search — skipped when the company is already known ── */}
        {prefill ? (
          <div className="mb-4 flex items-center gap-1.5 text-[12px] text-blue-600 bg-blue-50 px-2.5 py-2 rounded-lg">
            <span className="font-semibold mono">{form.yhTicker || form.ticker}</span>
            <span className="text-gray-400">·</span>
            <span className="truncate">{form.company}</span>
          </div>
        ) : (
        <div className="mb-4 relative">
          <label className="text-[10px] text-gray-400 uppercase tracking-wide block mb-0.5">Search Ticker</label>
          <div className="relative">
            <input
              type="text"
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="Search by name or ticker…"
              className="w-full text-[13px] border border-gray-200 rounded-lg px-3 py-2 outline-none focus:border-blue-300 pr-8"
              autoFocus
            />
            {searching && (
              <span className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400 text-[11px]">…</span>
            )}
          </div>
          {selected && !query && (
            <div className="mt-1 flex items-center gap-1.5 text-[12px] text-blue-600 bg-blue-50 px-2.5 py-1.5 rounded-lg">
              <span className="font-semibold mono">{selected.symbol}</span>
              <span className="text-gray-400">·</span>
              <span className="truncate">{selected.name}</span>
              <button onClick={() => { setSelected(null); setForm(f => ({ ...f, ticker: '', yhTicker: '', company: '' })); }}
                className="ml-auto text-gray-400 hover:text-red-400 shrink-0">✕</button>
            </div>
          )}
          {results.length > 0 && (
            <div className="absolute left-0 right-0 top-full mt-1 bg-white border border-gray-200 rounded-xl shadow-lg z-10 overflow-hidden">
              {results.map((q, i) => (
                <button key={i} onClick={() => handleSelect(q)}
                  className="w-full flex items-center gap-2 px-3 py-2.5 hover:bg-gray-50 text-left border-b border-gray-100 last:border-0">
                  <span className="font-semibold mono text-[12px] text-gray-800 shrink-0 w-24 truncate">{q.symbol}</span>
                  <span className="text-[12px] text-gray-600 flex-1 truncate">{q.name}</span>
                  <span className="text-[10px] text-gray-400 shrink-0">{q.exchange}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        )}

        {/* ── Manual fields ── */}
        <div className="border-t border-gray-100 pt-3 mb-3">
          <div className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide mb-2">Holding Details</div>

          {/* Ticker + Currency */}
          <div className="grid grid-cols-2 gap-2 mb-3">
            <div>
              <label className="text-[10px] text-gray-400 uppercase tracking-wide block mb-0.5">Ticker *</label>
              <input type="text" value={form.ticker}
                onChange={e => set('ticker', e.target.value.toUpperCase())}
                placeholder="e.g. AAPL"
                className="w-full text-[13px] font-semibold border border-gray-200 rounded-lg px-3 py-2 outline-none focus:border-blue-300 uppercase" />
            </div>
            <div>
              <label className="text-[10px] text-gray-400 uppercase tracking-wide block mb-0.5">Currency *</label>
              <select value={form.ccy} onChange={e => set('ccy', e.target.value)}
                className="w-full text-[13px] border border-gray-200 rounded-lg px-3 py-2 outline-none focus:border-blue-300 bg-white">
                {['USD','DKK','EUR','CAD','GBP','SEK','NOK'].map(c => <option key={c}>{c}</option>)}
              </select>
            </div>
          </div>

          {/* Company */}
          <div className="mb-3">
            <label className="text-[10px] text-gray-400 uppercase tracking-wide block mb-0.5">Company Name *</label>
            <input type="text" value={form.company} onChange={e => set('company', e.target.value)}
              placeholder="e.g. Apple Inc."
              className="w-full text-[13px] border border-gray-200 rounded-lg px-3 py-2 outline-none focus:border-blue-300" />
          </div>

          {/* Yahoo Finance ticker */}
          <div className="mb-4">
            <label className="text-[10px] text-gray-400 uppercase tracking-wide block mb-0.5">Yahoo Finance Ticker</label>
            <input type="text" value={form.yhTicker} onChange={e => set('yhTicker', e.target.value)}
              placeholder={form.ticker || 'Leave blank if same as ticker'}
              className="w-full text-[13px] border border-gray-200 rounded-lg px-3 py-2 outline-none focus:border-blue-300 mono" />
            <p className="text-[10px] text-gray-400 mt-1">e.g. NOVO-B.CO for Danish, CSU.TO for TSX, CHG.DE for Xetra</p>
          </div>
        </div>

        {/* Opening transaction */}
        <div className="border-t border-gray-100 pt-4 mb-3">
          <div className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide mb-3">Opening Transaction</div>

          <div className="grid grid-cols-2 gap-2 mb-2">
            <div>
              <label className="text-[10px] text-gray-400 uppercase tracking-wide block mb-0.5">Date *</label>
              <input type="date" value={form.date} onChange={e => set('date', e.target.value)}
                className="w-full text-[12px] border border-gray-200 rounded-lg px-2 py-2 outline-none focus:border-blue-300" />
            </div>
            <div>
              <label className="text-[10px] text-gray-400 uppercase tracking-wide block mb-0.5">Type</label>
              <div className="flex gap-1">
                {['buy','sell'].map(t => (
                  <button key={t} onClick={() => set('type', t)}
                    className={`flex-1 text-[11px] font-semibold py-2 rounded-lg border transition-colors ${
                      form.type === t
                        ? t === 'buy' ? 'bg-emerald-500 text-white border-emerald-500' : 'bg-red-500 text-white border-red-500'
                        : 'border-gray-200 text-gray-500 hover:bg-gray-50'
                    }`}>{t.toUpperCase()}</button>
                ))}
              </div>
            </div>
          </div>

          <div className="grid grid-cols-3 gap-2 mb-2">
            {[['Shares *','shares','1'],['Price *','price','0.0001'],['Fees','fees','0.01']].map(([label,key,step]) => (
              <div key={key}>
                <label className="text-[10px] text-gray-400 uppercase tracking-wide block mb-0.5">{label}</label>
                <input type="number" step={step} value={form[key]}
                  onChange={e => set(key, e.target.value)}
                  placeholder={key === 'fees' ? '0' : ''}
                  className="w-full text-[12px] border border-gray-200 rounded-lg px-2 py-2 outline-none focus:border-blue-300 mono" />
              </div>
            ))}
          </div>

          <div>
            <label className="text-[10px] text-gray-400 uppercase tracking-wide block mb-0.5">Note (optional)</label>
            <input type="text" value={form.note} onChange={e => set('note', e.target.value)}
              placeholder="Optional note…"
              className="w-full text-[12px] border border-gray-200 rounded-lg px-2 py-2 outline-none focus:border-blue-300" />
          </div>
        </div>

        {error && <div className="text-[12px] text-red-500 mb-3 bg-red-50 px-3 py-2 rounded-lg">{error}</div>}

        <button onClick={handleSave} disabled={saving}
          className="w-full py-3 bg-gray-900 text-white font-semibold rounded-xl text-[14px] hover:bg-gray-700 disabled:opacity-40 transition-colors">
          {saving ? 'Adding…' : 'Add Holding'}
        </button>
      </div>
    </div>
  );
}