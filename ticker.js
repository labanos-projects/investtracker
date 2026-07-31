// ─── ticker.js — the shared company page ────────────────────────────────────
//
// One page per company, reachable from Holdings, Watchlist and Screener.
// Previously the rich view (chart, news, valuation, notes) existed only for
// tickers you already owned, and the screener had a parallel, score-only page.
// That split meant the research view was unavailable exactly when you were
// doing research — before buying.
//
// Sections are driven by what EXISTS for the ticker, not by which tab you came
// from:
//   position present  → position stats, transactions, remove-holding
//   screener result   → score block (and an offer to score when absent)
//   always            → quote header, chart, valuation model, news, notes
//
// `position` is the enriched row from App (price, shares, G/L, fx). When it is
// null the page fetches its own snapshot from the Worker's ?quote= endpoint,
// which is the only source of currency/company/sector for a symbol that has no
// row in `portfolio`.

function TickerPage({
  ctx, position, initialTxns, portfolioId, baseCcy, isLive, user,
  onBack, backLabel, onTxnsChanged, onRemoveHolding, onRequireLogin,
  watchlists, watchlistId, onAddedToWatchlist, onAddedHolding,
}) {
  const p        = position || null;
  const isHolding = !!p;
  const ticker   = ctx.ticker;
  const yhTicker = ctx.yhTicker || ctx.ticker;

  // ── Snapshot (currency, company, sector, market cap, P/E) ────────────────
  // Fetched for holdings too: `portfolio` rows carry no fundamentals, so this
  // is what puts market cap and P/E on the holding view as well.
  const [snap,     setSnap]     = useState(null);
  const [snapFail, setSnapFail] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setSnap(null); setSnapFail(false);
    fetch(`${WORKER_URL}?quote=${encodeURIComponent(yhTicker)}`)
      .then(r => r.ok ? r.json() : Promise.reject(new Error('no quote')))
      .then(d => { if (!cancelled) { if (d.error) setSnapFail(true); else setSnap(d); } })
      .catch(() => { if (!cancelled) setSnapFail(true); });
    return () => { cancelled = true; };
  }, [yhTicker]);

  // Live portfolio prices win over the snapshot — they're refreshed on a timer
  // and already FX-aware; the snapshot is the fallback for un-held tickers.
  const price    = isHolding ? p.price   : (snap?.price  ?? null);
  const chgPct   = isHolding ? p.chgPct  : (snap?.chgPct ?? null);
  const ccy      = ctx.ccy || p?.ccy || snap?.currency || '';
  const company  = p?.company || ctx.company || snap?.company || '';
  const sector   = p?.sector  || ctx.sector  || snap?.sector  || null;
  const industry = snap?.industry || null;

  const priceStr = price == null ? '–' : (price >= 1000 ? n(price, 0) : n(price, 2));
  const capStr   = (() => {
    const v = snap?.mktcap;
    if (v == null) return '–';
    if (v >= 1e12) return (v / 1e12).toFixed(2) + 'T';
    if (v >= 1e9)  return (v / 1e9).toFixed(1)  + 'B';
    if (v >= 1e6)  return (v / 1e6).toFixed(0)  + 'M';
    return n(v, 0);
  })();

  // ── Transactions (holdings only) ─────────────────────────────────────────
  const [txns,         setTxns]         = useState(initialTxns || []);
  const [addingTxn,    setAddingTxn]    = useState(false);
  const [editingTxnId, setEditingTxnId] = useState(null);
  const [txnForm,      setTxnForm]      = useState({ date:'', type:'buy', shares:'', price:'', fees:'0', note:'' });
  const [savingTxn,    setSavingTxn]    = useState(false);
  const [txnError,     setTxnError]     = useState(null);
  const [removing,     setRemoving]     = useState(false);

  // `initialTxns` is a fresh array on every App render, so it can't be a
  // dependency directly — that's an infinite loop. Key on the id list instead:
  // it changes exactly when the underlying transactions do, which is also what
  // makes the "add as holding" flow show its opening transaction immediately.
  const txnSig = (initialTxns || []).map(t => t.id).join(',');
  useEffect(() => { setTxns(initialTxns || []); }, [ticker, txnSig]);

  const todayStrT = () => new Date().toISOString().split('T')[0];
  const sortTxns  = arr => [...arr].sort((a,b) => b.date.localeCompare(a.date) || b.id - a.id);

  const openAddTxn = () => {
    setAddingTxn(true); setEditingTxnId(null);
    setTxnForm({ date: todayStrT(), type:'buy', shares:'', price:'', fees:'0', note:'' });
    setTxnError(null);
  };
  const openEditTxn = (t) => {
    setEditingTxnId(t.id); setAddingTxn(false);
    setTxnForm({ date:t.date, type:t.type, shares:String(t.shares), price:String(t.price), fees:String(t.fees), note:t.note||'' });
    setTxnError(null);
  };
  const cancelTxn = () => { setAddingTxn(false); setEditingTxnId(null); setTxnError(null); };

  const saveTxn = async () => {
    if (!txnForm.shares || !txnForm.price) return;
    setSavingTxn(true); setTxnError(null);
    const payload = {
      ticker, portfolio_id: portfolioId,
      date:   txnForm.date,
      type:   txnForm.type,
      shares: parseFloat(txnForm.shares),
      price:  parseFloat(txnForm.price),
      fees:   parseFloat(txnForm.fees || 0),
      note:   txnForm.note.trim(),
    };
    try {
      if (addingTxn) {
        const res = await fetch(TRANSACTIONS_API, {
          method: 'POST', headers: authHeaders(), body: JSON.stringify(payload),
        });
        if (!res.ok) throw new Error();
        const created = await res.json();
        const next = sortTxns([...txns, created]);
        setTxns(next); onTxnsChanged(ticker, next);
      } else {
        const res = await fetch(`${TRANSACTIONS_API}?id=${editingTxnId}&_method=PUT`, {
          method: 'POST', headers: authHeaders(), body: JSON.stringify(payload),
        });
        if (!res.ok) throw new Error();
        const next = sortTxns(txns.map(t => t.id === editingTxnId ? { ...t, ...payload, id: editingTxnId } : t));
        setTxns(next); onTxnsChanged(ticker, next);
      }
      cancelTxn();
    } catch (_) { setTxnError('Could not save — check your connection.'); }
    setSavingTxn(false);
  };

  const deleteTxn = async (id) => {
    if (!window.confirm('Delete this transaction?')) return;
    try {
      await fetch(`${TRANSACTIONS_API}?id=${id}&_method=DELETE`, { method: 'POST' });
      const next = txns.filter(t => t.id !== id);
      setTxns(next); onTxnsChanged(ticker, next);
    } catch (_) { setTxnError('Could not delete — check your connection.'); }
  };

  const removeHolding = async () => {
    const txnCount = txns.length;
    const msg = txnCount > 0
      ? `Remove ${ticker} from your portfolio?\n\nThis will also permanently delete ${txnCount} transaction${txnCount !== 1 ? 's' : ''} for this holding. This cannot be undone.`
      : `Remove ${ticker} from your portfolio? This cannot be undone.`;
    if (!window.confirm(msg)) return;
    setRemoving(true);
    try {
      if (txnCount > 0) {
        await fetch(`${TRANSACTIONS_API}?ticker=${encodeURIComponent(ticker)}&_method=DELETE`, { method: 'POST' });
      }
      if (p.id) {
        await fetch(`${PORTFOLIO_API}?id=${p.id}&_method=DELETE`, { method: 'POST' });
      }
      onRemoveHolding(ticker);
    } catch (_) {
      setRemoving(false);
      alert('Could not remove holding — check your connection.');
    }
  };

  // ── Notes ────────────────────────────────────────────────────────────────
  // Ticker-scoped (see notes.php): a note written from the screener must still
  // be there when the company later becomes a holding.
  const [notes,      setNotes]      = useState([]);
  const [notesReady, setNotesReady] = useState(false);
  const [addingNote, setAddingNote] = useState(false);
  const [editingId,  setEditingId]  = useState(null);
  const [noteForm,   setNoteForm]   = useState({ date: '', text: '' });
  const [saving,     setSaving]     = useState(false);
  const [noteError,  setNoteError]  = useState(null);
  const textareaRef = React.useRef(null);

  useEffect(() => {
    setNotesReady(false);
    fetch(`${NOTES_API}?ticker=${encodeURIComponent(ticker)}`)
      .then(r => r.ok ? r.json() : [])
      .then(data => { setNotes(Array.isArray(data) ? data : []); setNotesReady(true); })
      .catch(()  => { setNotes([]); setNotesReady(true); });
  }, [ticker]);

  const todayStr  = () => new Date().toISOString().split('T')[0];
  const sortNotes = arr => [...arr].sort((a,b) => b.date.localeCompare(a.date) || b.id - a.id);

  const openAdd = () => {
    setAddingNote(true); setEditingId(null);
    setNoteForm({ date: todayStr(), text: '' }); setNoteError(null);
    setTimeout(() => textareaRef.current?.focus(), 60);
  };
  const openEdit = (note) => {
    setEditingId(note.id); setAddingNote(false);
    setNoteForm({ date: note.date, text: note.text }); setNoteError(null);
  };
  const cancelNote = () => {
    setAddingNote(false); setEditingId(null);
    setNoteForm({ date: '', text: '' }); setNoteError(null);
  };

  const saveNote = async () => {
    if (!noteForm.text.trim()) return;
    setSaving(true); setNoteError(null);
    try {
      if (addingNote) {
        const res = await fetch(NOTES_API, {
          method: 'POST', headers: authHeaders(),
          body: JSON.stringify({
            ticker,
            // 0 when the company isn't held — notes.php accepts that now.
            portfolio_id: isHolding ? portfolioId : 0,
            date: noteForm.date,
            text: noteForm.text.trim(),
          }),
        });
        if (!res.ok) throw new Error();
        const created = await res.json();
        setNotes(prev => sortNotes([...prev, created]));
      } else {
        const res = await fetch(`${NOTES_API}?id=${editingId}&_method=PUT`, {
          method: 'POST', headers: authHeaders(),
          body: JSON.stringify({ date: noteForm.date, text: noteForm.text.trim() }),
        });
        if (!res.ok) throw new Error();
        setNotes(prev => sortNotes(prev.map(x =>
          x.id === editingId ? { ...x, date: noteForm.date, text: noteForm.text.trim() } : x
        )));
      }
      cancelNote();
    } catch (_) {
      setNoteError('Could not save — check your connection and try again.');
    }
    setSaving(false);
  };

  const deleteNote = async (id) => {
    if (!window.confirm('Delete this note?')) return;
    try {
      await fetch(`${NOTES_API}?id=${id}&_method=DELETE`, { method: 'POST' });
      setNotes(prev => prev.filter(x => x.id !== id));
    } catch (_) { setNoteError('Could not delete — check your connection.'); }
  };

  // ── Add to watchlist / portfolio (un-held tickers) ───────────────────────
  const [showWlModal, setShowWlModal] = useState(false);
  const [showPfModal, setShowPfModal] = useState(false);
  const [wlAdded,     setWlAdded]     = useState(false);

  const prefill = {
    ticker:   ticker.replace(/\.[A-Z]{1,3}$/, ''),
    yhTicker,
    company:  company || ticker,
    ccy:      ccy || 'USD',
  };

  const totalBought = txns.filter(t=>t.type==='buy').reduce((s,t)=>s+(t.shares*t.price+t.fees),0);
  const totalSold   = txns.filter(t=>t.type==='sell').reduce((s,t)=>s+(t.shares*t.price-t.fees),0);

  const fmtDate = (d) => { const [y,m,day] = d.split('-'); return `${day}.${m}.${y}`; };

  const typeTag = (type) => type === 'buy'
    ? <span className="inline-block px-1.5 py-0.5 rounded text-[10px] font-semibold bg-emerald-100 text-emerald-700">BUY</span>
    : <span className="inline-block px-1.5 py-0.5 rounded text-[10px] font-semibold bg-red-100 text-red-600">SELL</span>;

  // Holdings get position economics; un-held tickers get the fundamentals that
  // would otherwise be the emptiest part of the page.
  const statCards = isHolding
    ? [
        { label: 'Price',    value: priceStr, sub: ccy },
        { label: 'Today',    value: pct(chgPct), sub: signed(p.todayBase,0)+' '+baseCcy, color: clr(chgPct) },
        { label: 'Total G/L',value: pct(p.glPct), sub: signed(p.glBase,0)+' '+baseCcy, color: clr(p.glPct) },
        { label: 'Position', value: p.shares+' shares', sub: 'avg '+n(p.avgCost,2)+' '+ccy },
      ]
    : [
        { label: 'Price',      value: priceStr, sub: ccy || '—' },
        { label: 'Today',      value: chgPct == null ? '–' : pct(chgPct), sub: '', color: clr(chgPct) },
        { label: 'Market cap', value: capStr, sub: ccy || '' },
        { label: 'P/E (ttm)',  value: snap?.pe != null ? n(snap.pe, 1) : '–', sub: snap?.gross_margin != null ? `GM ${(snap.gross_margin*100).toFixed(0)}%` : '' },
      ];

  return (
    <div className="min-h-screen bg-gray-50 pb-12">

      {/* ── Header ── */}
      <div className="bg-gray-900 text-white px-4 py-3 flex items-center gap-3 sticky top-0 z-20">
        <button onClick={onBack} className="text-gray-400 hover:text-white transition-colors text-sm flex items-center gap-1 shrink-0">
          ← {backLabel || 'Back'}
        </button>
        <div className="flex-1 flex items-center gap-2 min-w-0">
          <span className="font-bold text-lg">{ticker}</span>
          <span className="text-gray-400 text-sm truncate">{company}</span>
        </div>
        {isHolding ? (
          <span className={`text-[11px] px-2 py-0.5 rounded-full shrink-0 ${isLive ? 'bg-emerald-500 text-white' : 'bg-gray-600 text-gray-300'}`}>
            {isLive ? 'live' : 'cached'}
          </span>
        ) : (
          <span className="text-[11px] px-2 py-0.5 rounded-full bg-gray-700 text-gray-300 shrink-0">not held</span>
        )}
      </div>

      {/* ── Sector / industry strip ── */}
      {(sector || industry) && (
        <div className="px-4 pt-3 flex items-center gap-1.5 flex-wrap">
          {sector   && <span className="text-[10px] px-2 py-0.5 rounded-full bg-white border border-gray-200 text-gray-500">{sector}</span>}
          {industry && <span className="text-[10px] px-2 py-0.5 rounded-full bg-white border border-gray-200 text-gray-500">{industry}</span>}
          {isHolding && snap?.mktcap != null && (
            <span className="text-[10px] px-2 py-0.5 rounded-full bg-white border border-gray-200 text-gray-500 mono">
              cap {capStr} {ccy}
            </span>
          )}
          {isHolding && snap?.pe != null && (
            <span className="text-[10px] px-2 py-0.5 rounded-full bg-white border border-gray-200 text-gray-500 mono">
              P/E {n(snap.pe, 1)}
            </span>
          )}
        </div>
      )}

      {/* ── Stats row ── */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 p-4">
        {statCards.map(({ label, value, sub, color }) => (
          <div key={label} className="bg-white rounded-xl px-4 py-3 shadow-sm border border-gray-100">
            <div className="text-[11px] text-gray-400 mb-1">{label}</div>
            <div className={`font-semibold text-[16px] mono ${color||'text-gray-900'}`}>{value}</div>
            <div className={`text-[11px] mono mt-0.5 ${color||'text-gray-400'}`}>{sub}</div>
          </div>
        ))}
      </div>

      {/* Quote lookup failed — don't leave four dashes unexplained. */}
      {!isHolding && snapFail && (
        <div className="mx-4 mb-3 text-[11px] text-amber-700 bg-amber-50 border border-amber-100 rounded-lg px-3 py-2">
          Could not load market data for {yhTicker}. The chart and valuation below may still work.
        </div>
      )}

      {/* ── Not held: add to watchlist / portfolio ── */}
      {!isHolding && user && (
        <div className="mx-4 mb-4 flex gap-2">
          <button
            onClick={() => setShowWlModal(true)}
            disabled={wlAdded || !watchlistId}
            title={watchlistId ? 'Add to a watchlist' : 'Create a watchlist first'}
            className="flex-1 text-[12px] font-medium bg-white border border-gray-200 text-gray-700 rounded-lg py-2 hover:border-gray-400 disabled:opacity-40 transition-colors">
            {wlAdded ? '✓ On watchlist' : '👁 Add to watchlist'}
          </button>
          <button
            onClick={() => setShowPfModal(true)}
            className="flex-1 text-[12px] font-medium bg-gray-900 text-white rounded-lg py-2 hover:bg-gray-700 transition-colors">
            + Add as holding
          </button>
        </div>
      )}

      {showWlModal && (
        <WatchlistAddModal
          watchlistId={watchlistId}
          watchlists={watchlists}
          prefill={prefill}
          onClose={() => setShowWlModal(false)}
          onAdded={(item) => { setWlAdded(true); if (onAddedToWatchlist) onAddedToWatchlist(item); }}
        />
      )}
      {showPfModal && (
        <AddHoldingModal
          portfolioId={portfolioId}
          prefill={prefill}
          onClose={() => setShowPfModal(false)}
          onAdded={(pfRow, txn) => { if (onAddedHolding) onAddedHolding(pfRow, txn); }}
        />
      )}

      {/* ── Chart ── */}
      <div className="mx-4 mb-2">
        <StockChart yhTicker={yhTicker} ccy={ccy} />
      </div>

      {/* ── Screener score ── */}
      {/* The screener keys results on the Yahoo symbol (NOVO-B.CO) while
          holdings key on the internal ticker (NOVO-B), so look up both. */}
      <ScoreBlock
        ticker={yhTicker}
        altTicker={ticker}
        user={user}
        onRequireLogin={onRequireLogin}
      />

      {/* ── Valuation model ── */}
      {/* portfolio_id 0 for un-held tickers: valuation_models is unique on
          (ticker, model_date) and stores portfolio_id for audit only. */}
      <ValuationPanel
        ticker={ticker}
        portfolioId={isHolding ? portfolioId : 0}
        currentPrice={price}
        currency={ccy}
        user={user}
        onRequireLogin={onRequireLogin}
      />

      {/* ── News ── */}
      <NewsPanel yhTicker={yhTicker} />

      {/* ── Transactions (holdings only) ── */}
      {isHolding && (
      <div className="mx-4 mb-6">
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-[13px] font-semibold text-gray-600 uppercase tracking-wide">Transactions</h2>
          {!addingTxn && user && (
            <button onClick={openAddTxn}
              className="text-[12px] text-blue-500 hover:text-blue-600 font-medium px-2 py-1 rounded-lg hover:bg-blue-50 transition-colors">
              + Add
            </button>
          )}
        </div>

        {addingTxn && (
          <TransactionForm form={txnForm} onChange={setTxnForm} onSave={saveTxn}
            onCancel={cancelTxn} saving={savingTxn} error={txnError} />
        )}

        {txns.length === 0 && !addingTxn ? (
          <div className="bg-white rounded-xl border border-gray-100 shadow-sm px-4 py-6 text-center text-gray-400 text-sm">
            No transactions yet{user ? (
              <> — <button onClick={openAddTxn} className="text-blue-400 font-medium hover:underline">add one</button></>
            ) : '.'}
          </div>
        ) : txns.length > 0 && (
          <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
            {txnError && !addingTxn && !editingTxnId && (
              <div className="px-4 py-2 text-[11px] text-red-500 bg-red-50">{txnError}</div>
            )}
            <table className="w-full text-[12px]">
              <thead>
                <tr className="border-b border-gray-100 text-gray-400 text-[11px] uppercase tracking-wide">
                  <th className="px-3 py-2 text-left">Date</th>
                  <th className="px-3 py-2 text-left">Type</th>
                  <th className="px-3 py-2 text-right">Shares</th>
                  <th className="px-3 py-2 text-right">Price</th>
                  <th className="px-3 py-2 text-right">Fees</th>
                  <th className="px-3 py-2 text-right">Value</th>
                  <th className="px-3 py-2 text-left">Note</th>
                  <th className="px-2 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {txns.map((t, i) =>
                  editingTxnId === t.id ? (
                    <tr key={t.id}>
                      <td colSpan={8} className="p-2">
                        <TransactionForm form={txnForm} onChange={setTxnForm} onSave={saveTxn}
                          onCancel={cancelTxn} saving={savingTxn} error={txnError} />
                      </td>
                    </tr>
                  ) : (
                    <tr key={t.id} className={`border-b border-gray-50 ${i%2===0?'bg-white':'bg-gray-50/40'}`}>
                      <td className="px-3 py-2 mono text-gray-500">{fmtDate(t.date)}</td>
                      <td className="px-3 py-2">{typeTag(t.type)}</td>
                      <td className="px-3 py-2 text-right mono text-gray-700">{n(t.shares,0)}</td>
                      <td className="px-3 py-2 text-right mono text-gray-700">{n(t.price,2)}</td>
                      <td className="px-3 py-2 text-right mono text-gray-400">{t.fees ? n(t.fees,2) : '–'}</td>
                      <td className={`px-3 py-2 text-right mono font-medium ${t.type==='buy'?'text-gray-700':'text-emerald-600'}`}>
                        {t.type==='buy' ? '−'+n(t.shares*t.price+(t.fees||0),0) : '+'+n(t.shares*t.price-(t.fees||0),0)}
                      </td>
                      <td className="px-3 py-2 text-gray-500 max-w-[140px] truncate">{t.note||''}</td>
                      <td className="px-2 py-2 whitespace-nowrap">
                        {user && (<><button onClick={() => openEditTxn(t)} title="Edit"
                          className="text-gray-300 hover:text-blue-400 transition-colors text-[13px] px-1">✎</button>
                        <button onClick={() => deleteTxn(t.id)} title="Delete"
                          className="text-gray-300 hover:text-red-400 transition-colors text-[13px] px-1">✕</button></>)}
                      </td>
                    </tr>
                  )
                )}
              </tbody>
              {txns.length > 1 && (
                <tfoot className="border-t border-gray-200 bg-gray-50 text-[11px] text-gray-500">
                  <tr>
                    <td colSpan={5} className="px-3 py-2">Total invested / received</td>
                    <td className="px-3 py-2 text-right mono font-semibold text-gray-700">
                      {totalBought > 0 && <span className="text-gray-700">−{n(totalBought,0)}</span>}
                      {totalSold > 0 && <span className="text-emerald-600 ml-2">+{n(totalSold,0)}</span>}
                    </td>
                    <td /><td />
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        )}
      </div>
      )}

      {/* ── Notes & Diary ── */}
      <div className="mx-4">
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-[13px] font-semibold text-gray-600 uppercase tracking-wide">Notes & Diary</h2>
          {!addingNote && user && (
            <button onClick={openAdd}
              className="text-[12px] text-blue-500 hover:text-blue-600 font-medium px-2 py-1 rounded-lg hover:bg-blue-50 transition-colors">
              + Add note
            </button>
          )}
        </div>

        {addingNote && (
          <NoteForm form={noteForm} onChange={setNoteForm} onSave={saveNote}
            onCancel={cancelNote} saving={saving} error={noteError} textareaRef={textareaRef} />
        )}

        {!notesReady ? (
          <div className="text-center text-gray-400 text-sm py-6">Loading notes…</div>
        ) : notes.length === 0 && !addingNote ? (
          <div className="bg-white rounded-xl border border-gray-100 shadow-sm px-4 py-6 text-center text-gray-400 text-sm">
            No notes yet{user ? (
              <> — <button onClick={openAdd} className="text-blue-400 font-medium hover:underline">add one</button></>
            ) : '.'}
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {notes.map((note) =>
              editingId === note.id ? (
                <NoteForm key={note.id} form={noteForm} onChange={setNoteForm} onSave={saveNote}
                  onCancel={cancelNote} saving={saving} error={noteError} />
              ) : (
                <div key={note.id} className="bg-white rounded-xl border border-gray-100 shadow-sm px-4 py-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="text-[11px] text-gray-400 mono">{fmtDate(note.date)}</div>
                    <div className="flex gap-1 shrink-0 -mt-0.5">
                      {user && (<><button onClick={() => openEdit(note)} title="Edit"
                        className="text-gray-300 hover:text-blue-400 transition-colors text-[14px] px-1 leading-none">✎</button>
                      <button onClick={() => deleteNote(note.id)} title="Delete"
                        className="text-gray-300 hover:text-red-400 transition-colors text-[14px] px-1 leading-none">✕</button></>)}
                    </div>
                  </div>
                  <p className="text-[13px] text-gray-700 leading-relaxed whitespace-pre-wrap mt-1">{note.text}</p>
                </div>
              )
            )}
          </div>
        )}
      </div>

      {/* ── Remove holding ── */}
      {isHolding && user && (
        <div className="px-4 pt-6 pb-2">
          <button onClick={removeHolding} disabled={removing}
            className="text-[12px] text-red-400 hover:text-red-600 transition-colors disabled:opacity-40">
            {removing ? 'Removing…' : '✕ Remove this holding'}
          </button>
        </div>
      )}

    </div>
  );
}
