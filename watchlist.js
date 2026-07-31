// ─── Watchlist module ─────────────────────────────────────────────────────
// Watchlists are portfolio-like lists of candidate symbols you're following
// but don't own. No transactions, no totals — just {ticker, target_price, note}.
//
// Provides:
//   WatchlistView       — the whole watchlist screen (table + add button)
//   WatchlistAddModal   — search ticker + set target/note
//   WatchlistSwitcher   — dropdown when the user has more than one watchlist
//
// Wired into App in app.js via the view='watchlist' branch.

// ─── WatchlistAddModal ────────────────────────────────────────────────────
// `prefill` is passed by TickerPage: you are already looking at the company, so
// re-typing its name into a search box is pure friction. When it is present the
// search step is skipped entirely and the form opens ready to save.
function WatchlistAddModal({ watchlistId, watchlists, prefill, onClose, onAdded }) {
  const { useState, useEffect, useRef } = React;

  const [query,    setQuery]    = useState('');
  const [results,  setResults]  = useState([]);
  const [searching, setSearching] = useState(false);
  const [selected, setSelected] = useState(prefill ? { symbol: prefill.yhTicker } : null);
  const debounceRef = useRef(null);

  // With several watchlists, "add to watchlist" from a ticker page is ambiguous
  // — offer the choice rather than silently picking the active one.
  const [targetWl, setTargetWl] = useState(watchlistId);
  useEffect(() => { setTargetWl(watchlistId); }, [watchlistId]);

  const [form, setForm] = useState({
    ticker:   prefill?.ticker   || '',
    yhTicker: prefill?.yhTicker || '',
    company:  prefill?.company  || '',
    ccy:      prefill?.ccy      || 'USD',
    target_price: '', note: '',
  });
  const [saving, setSaving] = useState(false);
  const [error,  setError]  = useState(null);

  const set = (key, val) => setForm(f => ({ ...f, [key]: val }));

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
      } catch { setResults([]); }
      setSearching(false);
    }, 300);
    return () => clearTimeout(debounceRef.current);
  }, [query]);

  const handleSelect = (q) => {
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
    if (!ticker || !form.company.trim()) {
      setError('Please pick a ticker first.'); return;
    }
    setSaving(true); setError(null);
    try {
      const res = await fetch(WATCHLIST_ITEMS_API, {
        method: 'POST', headers: authHeaders(),
        body: JSON.stringify({
          watchlist_id: targetWl,
          ticker,
          yhTicker: form.yhTicker.trim() || ticker,
          company:  form.company.trim(),
          ccy:      form.ccy,
          target_price: form.target_price === '' ? null : parseFloat(form.target_price),
          note:     form.note.trim() || null,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || 'Could not add item');
      }
      const item = await res.json();
      onAdded(item);
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
          <h2 className="text-[15px] font-bold text-gray-900">Add to Watchlist</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl leading-none px-1">✕</button>
        </div>

        {/* Which watchlist — only worth asking when there is more than one */}
        {prefill && Array.isArray(watchlists) && watchlists.length > 1 && (
          <div className="mb-4">
            <label className="text-[10px] text-gray-400 uppercase tracking-wide block mb-0.5">Watchlist</label>
            <select value={targetWl || ''} onChange={e => setTargetWl(parseInt(e.target.value))}
              className="w-full text-[13px] border border-gray-200 rounded-lg px-3 py-2 outline-none focus:border-blue-300 bg-white">
              {watchlists.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
            </select>
          </div>
        )}

        {/* Ticker search — skipped entirely when the company is already known */}
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
            <input type="text" value={query} onChange={e => setQuery(e.target.value)}
              placeholder="Search by name or ticker…" autoFocus
              className="w-full text-[13px] border border-gray-200 rounded-lg px-3 py-2 outline-none focus:border-blue-300 pr-8" />
            {searching && <span className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400 text-[11px]">…</span>}
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

        {/* Manual edit fields (pre-filled by ticker search) */}
        <div className="border-t border-gray-100 pt-3 mb-3">
          <div className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide mb-2">Details</div>
          <div className="grid grid-cols-2 gap-2 mb-3">
            <div>
              <label className="text-[10px] text-gray-400 uppercase tracking-wide block mb-0.5">Ticker *</label>
              <input type="text" value={form.ticker}
                onChange={e => set('ticker', e.target.value.toUpperCase())}
                placeholder="e.g. AAPL"
                className="w-full text-[13px] font-semibold border border-gray-200 rounded-lg px-3 py-2 outline-none focus:border-blue-300 uppercase" />
            </div>
            <div>
              <label className="text-[10px] text-gray-400 uppercase tracking-wide block mb-0.5">Currency</label>
              <select value={form.ccy} onChange={e => set('ccy', e.target.value)}
                className="w-full text-[13px] border border-gray-200 rounded-lg px-3 py-2 outline-none focus:border-blue-300 bg-white">
                {['USD','DKK','EUR','CAD','GBP','SEK','NOK'].map(c => <option key={c}>{c}</option>)}
              </select>
            </div>
          </div>
          <div className="mb-3">
            <label className="text-[10px] text-gray-400 uppercase tracking-wide block mb-0.5">Company *</label>
            <input type="text" value={form.company} onChange={e => set('company', e.target.value)}
              className="w-full text-[13px] border border-gray-200 rounded-lg px-3 py-2 outline-none focus:border-blue-300" />
          </div>
          <div className="mb-3">
            <label className="text-[10px] text-gray-400 uppercase tracking-wide block mb-0.5">Yahoo Finance Ticker</label>
            <input type="text" value={form.yhTicker} onChange={e => set('yhTicker', e.target.value)}
              placeholder={form.ticker || 'Leave blank if same as ticker'}
              className="w-full text-[13px] border border-gray-200 rounded-lg px-3 py-2 outline-none focus:border-blue-300 mono" />
          </div>
        </div>

        {/* Target + note */}
        <div className="border-t border-gray-100 pt-3 mb-3">
          <div className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide mb-2">Thesis</div>
          <div className="mb-3">
            <label className="text-[10px] text-gray-400 uppercase tracking-wide block mb-0.5">Target Price (optional)</label>
            <input type="number" step="0.0001" value={form.target_price}
              onChange={e => set('target_price', e.target.value)}
              placeholder="What price would tempt you to buy?"
              className="w-full text-[12px] border border-gray-200 rounded-lg px-2 py-2 outline-none focus:border-blue-300 mono" />
          </div>
          <div>
            <label className="text-[10px] text-gray-400 uppercase tracking-wide block mb-0.5">Note (optional)</label>
            <textarea rows={2} value={form.note} onChange={e => set('note', e.target.value)}
              placeholder="Short thesis…"
              className="w-full text-[12px] border border-gray-200 rounded-lg px-2 py-2 outline-none focus:border-blue-300 resize-none" />
          </div>
        </div>

        {error && <div className="text-[12px] text-red-500 mb-3 bg-red-50 px-3 py-2 rounded-lg">{error}</div>}
        <button onClick={handleSave} disabled={saving}
          className="w-full py-3 bg-gray-900 text-white font-semibold rounded-xl text-[14px] hover:bg-gray-700 disabled:opacity-40 transition-colors">
          {saving ? 'Adding…' : 'Add to Watchlist'}
        </button>
      </div>
    </div>
  );
}

// ─── WatchlistItemRow ─────────────────────────────────────────────────────
// The row keeps its inline target/note editor on click — that is the whole
// point of a watchlist — so opening the company page hangs off the ticker cell
// and a link in the expanded drawer, rather than stealing the row click.
function WatchlistItemRow({ item, price, onSave, onDelete, onOpen, user, onRequireLogin }) {
  const { useState } = React;
  const [expanded, setExpanded] = useState(false);
  const [editTarget, setEditTarget] = useState(item.target_price ?? '');
  const [editNote,   setEditNote]   = useState(item.note ?? '');
  const [saving, setSaving] = useState(false);

  const dirty =
    String(editTarget) !== String(item.target_price ?? '') ||
    (editNote ?? '') !== (item.note ?? '');

  const handleSave = async () => {
    setSaving(true);
    await onSave(item.id, {
      target_price: editTarget === '' ? null : parseFloat(editTarget),
      note: editNote.trim() === '' ? null : editNote.trim(),
    });
    setSaving(false);
    setExpanded(false);
  };

  const handleDelete = async () => {
    if (!window.confirm(`Remove ${item.ticker} from watchlist?`)) return;
    setSaving(true);
    await onDelete(item.id);
    // No setSaving(false) — row is unmounted on success
  };

  const target = item.target_price != null ? Number(item.target_price) : null;
  const toTarget = (target && price?.price)
    ? (price.price - target) / target   // >0 means above target, <0 means below (closer to buy)
    : null;
  const targetClr = toTarget == null
    ? 'text-gray-400'
    : toTarget <= 0 ? 'text-emerald-500' : 'text-amber-500';

  return (
    <>
      <tr onClick={() => setExpanded(e => !e)}
        className="border-b border-gray-100 cursor-pointer transition-colors bg-white hover:bg-blue-50">
        <td className="px-4 py-2.5 min-w-[110px]">
          {onOpen ? (
            <button onClick={e => { e.stopPropagation(); onOpen(); }}
              title={`Open ${item.ticker}`}
              className="text-left group">
              <div className="font-semibold text-[13px] text-gray-900 group-hover:text-blue-600 group-hover:underline transition-colors">
                {item.ticker}
              </div>
              <div className="text-[11px] text-gray-400 truncate max-w-[140px]">{item.company}</div>
            </button>
          ) : (
            <>
              <div className="font-semibold text-gray-900 text-[13px]">{item.ticker}</div>
              <div className="text-[11px] text-gray-400 truncate max-w-[140px]">{item.company}</div>
            </>
          )}
        </td>
        <td className="px-3 py-2.5 text-right mono">
          {price?.price != null ? (
            <>
              <div className="text-[13px] font-medium text-gray-800">
                {Number(price.price).toLocaleString('da-DK', { maximumFractionDigits: 2 })}
              </div>
              <div className={`text-[11px] ${clr(price.chgPct)}`}>{price.chgPct != null ? pct_format(price.chgPct) : ''}</div>
            </>
          ) : <div className="text-[12px] text-gray-300">–</div>}
        </td>
        <td className="px-3 py-2.5 text-right mono">
          {target != null ? (
            <div className="text-[13px] text-gray-700">
              {target.toLocaleString('da-DK', { maximumFractionDigits: 2 })}
            </div>
          ) : <div className="text-[12px] text-gray-300 italic">set</div>}
        </td>
        <td className={`px-3 py-2.5 text-right mono ${targetClr}`}>
          {toTarget != null
            ? <div className="text-[13px] font-semibold">{(toTarget >= 0 ? '+' : '−') + Math.abs(toTarget * 100).toFixed(1) + '%'}</div>
            : <div className="text-[12px] text-gray-300">–</div>}
        </td>
        <td className="px-3 py-2.5 text-[10px] text-gray-400 text-right whitespace-nowrap">
          {item.date_added ? new Date(item.date_added).toLocaleDateString('da-DK', {day:'2-digit', month:'2-digit', year:'2-digit'}) : '–'}
        </td>
      </tr>
      {expanded && (
        <tr className="bg-blue-50/40 border-b border-gray-100">
          <td colSpan={5} className="px-4 py-3">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <div className="text-[10px] text-gray-400 uppercase tracking-wide mb-0.5">Target Price ({item.ccy})</div>
                <input type="number" step="0.0001" value={editTarget}
                  onChange={e => setEditTarget(e.target.value)}
                  onClick={e => e.stopPropagation()}
                  className="w-full text-[12px] border border-gray-200 rounded-md px-2 py-1 outline-none focus:border-blue-300 mono bg-white" />
              </div>
              <div>
                <div className="text-[10px] text-gray-400 uppercase tracking-wide mb-0.5">Note</div>
                <textarea rows={2} value={editNote}
                  onChange={e => setEditNote(e.target.value)}
                  onClick={e => e.stopPropagation()}
                  placeholder="Short thesis…"
                  className="w-full text-[12px] border border-gray-200 rounded-md px-2 py-1 outline-none focus:border-blue-300 resize-none bg-white" />
              </div>
            </div>
            <div className="flex items-center justify-between mt-2">
              <div className="flex items-center gap-1">
                <button onClick={e => { e.stopPropagation(); user ? handleDelete() : onRequireLogin(handleDelete); }}
                  disabled={saving}
                  className="text-[11px] text-red-400 hover:text-red-600 px-2 py-1 rounded-md hover:bg-red-50 transition-colors">
                  Remove
                </button>
                {onOpen && (
                  <button onClick={e => { e.stopPropagation(); onOpen(); }}
                    className="text-[11px] text-blue-500 hover:text-blue-700 px-2 py-1 rounded-md hover:bg-blue-50 transition-colors">
                    Open ticker page →
                  </button>
                )}
              </div>
              <div className="flex gap-2">
                <button onClick={e => { e.stopPropagation(); setExpanded(false); setEditTarget(item.target_price ?? ''); setEditNote(item.note ?? ''); }}
                  className="text-[12px] text-gray-400 hover:text-gray-600 px-3 py-1 rounded-lg hover:bg-gray-100 transition-colors">
                  Cancel
                </button>
                <button onClick={e => { e.stopPropagation(); dirty && (user ? handleSave() : onRequireLogin(handleSave)); }}
                  disabled={!dirty || saving}
                  className="text-[12px] font-medium bg-gray-900 text-white px-3 py-1.5 rounded-lg disabled:opacity-40 hover:bg-gray-700 transition-colors">
                  {saving ? 'Saving…' : 'Save'}
                </button>
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

// Local helper — duplicates pct() from constants.js but with no leading sign on zero.
function pct_format(v) {
  if (v == null || isNaN(v)) return '–';
  return (v >= 0 ? '+' : '−') + Math.abs(v * 100).toFixed(2) + '%';
}

// ─── WatchlistView ────────────────────────────────────────────────────────
function WatchlistView({
  user, onRequireLogin,
  watchlists, watchlistId, onSwitchWatchlist,
  showAddModal, setShowAddModal,
  onOpenTicker,
}) {
  const { useState, useEffect, useCallback } = React;
  const [items,   setItems]   = useState([]);
  const [loaded,  setLoaded]  = useState(false);
  const [prices,  setPrices]  = useState({});
  const [refreshing, setRefreshing] = useState(false);

  // Load items whenever the active watchlist changes
  useEffect(() => {
    if (!watchlistId) return;
    setLoaded(false);
    fetch(`${WATCHLIST_ITEMS_API}?watchlist_id=${watchlistId}`)
      .then(r => r.ok ? r.json() : [])
      .then(rows => { setItems(rows); setLoaded(true); })
      .catch(() => { setItems([]); setLoaded(true); });
  }, [watchlistId]);

  // Fetch live prices for the watchlist's tickers via the Cloudflare Worker
  const fetchWatchlistPrices = useCallback(async () => {
    if (items.length === 0) return;
    setRefreshing(true);
    const symbols = items.map(it => it.yh_ticker).join(',');
    try {
      const res = await fetch(`${WORKER_URL}?symbols=${symbols}`);
      const json = await res.json();
      const result = json?.quoteResponse?.result || [];
      const next = {};
      result.forEach(q => {
        next[q.symbol] = {
          price:  q.regularMarketPrice,
          chgPct: (q.regularMarketChangePercent ?? 0) / 100,
        };
      });
      setPrices(next);
    } catch (e) { /* keep stale prices */ }
    setRefreshing(false);
  }, [items]);

  useEffect(() => { if (items.length > 0) fetchWatchlistPrices(); }, [items.length]);

  const handleAdded = useCallback((item) => {
    setItems(prev => [...prev, item]);
    // Trigger price refresh so the new ticker gets a quote
    setTimeout(fetchWatchlistPrices, 200);
  }, [fetchWatchlistPrices]);

  const handleSave = useCallback(async (id, patch) => {
    const res = await fetch(`${WATCHLIST_ITEMS_API}?_method=PUT&id=${id}`, {
      method: 'POST', headers: authHeaders(),
      body: JSON.stringify(patch),
    });
    if (!res.ok) { alert('Could not save'); return; }
    setItems(prev => prev.map(it => it.id === id ? { ...it, ...patch } : it));
  }, []);

  const handleDelete = useCallback(async (id) => {
    const res = await fetch(`${WATCHLIST_ITEMS_API}?_method=DELETE&id=${id}`, {
      method: 'POST', headers: authHeaders(),
    });
    if (!res.ok) { alert('Could not remove'); return; }
    setItems(prev => prev.filter(it => it.id !== id));
  }, []);

  // A watchlist row is a company you are researching, so it opens the same
  // TickerPage as a holding or a screener result. `origin` only sets the back
  // button label, so you return to the watchlist you came from.
  const openTicker = useCallback((it) => {
    if (!onOpenTicker) return;
    onOpenTicker({
      ticker:   it.ticker,
      yhTicker: it.yh_ticker || it.ticker,
      company:  it.company || null,
      ccy:      it.ccy || null,
      sector:   it.sector || null,
      origin:   'watchlist',
    });
  }, [onOpenTicker]);

  const activeWl = watchlists.find(w => w.id === watchlistId);

  return (
    <div>
      {/* Sub-header: watchlist switcher + refresh */}
      <div className="px-4 py-2 flex items-center justify-between border-b border-gray-100 bg-white">
        <div className="flex items-center gap-2 min-w-0">
          {watchlists.length > 1 ? (
            <select value={watchlistId || ''} onChange={e => onSwitchWatchlist(parseInt(e.target.value))}
              className="text-[13px] font-semibold text-gray-800 bg-transparent border border-gray-200 rounded-lg px-2 py-1 outline-none focus:border-blue-300">
              {watchlists.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
            </select>
          ) : (
            <span className="text-[13px] font-semibold text-gray-800 truncate">{activeWl?.name || 'Watchlist'}</span>
          )}
          {loaded && <span className="text-[11px] text-gray-400">· {items.length} item{items.length === 1 ? '' : 's'}</span>}
        </div>
        <button onClick={fetchWatchlistPrices} title="Refresh prices"
          className="text-[11px] text-gray-400 hover:text-gray-700 px-2 py-1 rounded-lg hover:bg-gray-50 transition-colors">
          {refreshing ? <span className="inline-block spin">↻</span> : '↻ refresh'}
        </button>
      </div>

      {showAddModal && (
        <WatchlistAddModal
          watchlistId={watchlistId}
          onClose={() => setShowAddModal(false)}
          onAdded={handleAdded}
        />
      )}

      {!loaded ? (
        <div className="flex flex-col items-center justify-center h-48 gap-2 text-gray-400">
          <span className="text-2xl spin">↻</span>
          <span className="text-sm">Loading watchlist…</span>
        </div>
      ) : items.length === 0 ? (
        <div className="flex flex-col items-center justify-center h-48 gap-3 text-gray-400 px-4 text-center">
          <span className="text-3xl">👁</span>
          <span className="text-sm">Your watchlist is empty.</span>
          {user && (
            <button onClick={() => setShowAddModal(true)}
              className="text-xs bg-gray-900 hover:bg-gray-700 text-white px-3 py-1.5 rounded-full font-semibold transition-colors">
              + Add your first symbol
            </button>
          )}
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse">
            <thead>
              <tr className="bg-gray-100 border-b border-gray-200">
                <th className="px-4 py-2 text-left text-xs text-gray-400 font-normal">Stock</th>
                <th className="px-3 py-2 text-right text-xs text-gray-400 font-normal">Price</th>
                <th className="px-3 py-2 text-right text-xs text-gray-400 font-normal">Target</th>
                <th className="px-3 py-2 text-right text-xs text-gray-400 font-normal">Δ Target</th>
                <th className="px-3 py-2 text-right text-xs text-gray-400 font-normal">Added</th>
              </tr>
            </thead>
            <tbody>
              {items.map(it => (
                <WatchlistItemRow
                  key={it.id}
                  item={it}
                  price={prices[it.yh_ticker]}
                  onSave={handleSave}
                  onDelete={handleDelete}
                  onOpen={onOpenTicker ? () => openTicker(it) : null}
                  user={user}
                  onRequireLogin={onRequireLogin}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
