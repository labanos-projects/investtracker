// ─── App ─────────────────────────────────────────────────────────────────────────────
function App() {
  const [prices, setPrices]           = useState({});
  const [fx, setFx]                   = useState(CACHED_FX);
  const [loading, setLoading]         = useState(true);
  const [refreshing, setRefreshing]   = useState(false);
  const [isLive, setIsLive]           = useState(false);
  const [lastUpdated, setLastUpdated] = useState(null);
  const [sortBy, setSortBy]           = useState('value');
  const [sortDir, setSortDir]         = useState('desc');
  const [notice, setNotice]           = useState(null);
  const [selectedTicker, setSelectedTicker] = useState(null);
  const [showClosed,    setShowClosed]    = useState(false);
  const [showAddModal,  setShowAddModal]  = useState(false);
  const [showInsights,  setShowInsights]  = useState(false);
  const [showHistory,   setShowHistory]   = useState(false);
  const [metaLoading,   setMetaLoading]   = useState(0);
  const metaAttempted      = React.useRef(new Set());
  const snapshotRecorded   = React.useRef(new Set());

  // ── Portfolios state ──
  const [portfolios,    setPortfolios]    = useState([]);
  const [portfolioId,   setPortfolioId]   = useState(null);
  const [baseCcy,       setBaseCcy]       = useState('DKK');
  const [pfListLoaded,  setPfListLoaded]  = useState(false);

  // ── View / Watchlist state ──
  const [view,         setView]         = useState(() => localStorage.getItem('tracker_view') || 'portfolio');
  const [watchlists,   setWatchlists]   = useState([]);
  const [watchlistId,  setWatchlistId]  = useState(null);

  // ── Auth state ──
  const [user,         setUser]         = useState(null);
  const [authChecked,  setAuthChecked]  = useState(false);
  const [setupNeeded,  setSetupNeeded]  = useState(false);
  const [showLogin,    setShowLogin]    = useState(false);
  const [pendingAction, setPendingAction] = useState(null);

  // ── Portfolio from DB ────────────────────────────────────────────────────────────────
  const portfolioRef = React.useRef([]);
  const [portfolio,       setPortfolio]       = useState([]);
  const [portfolioLoaded, setPortfolioLoaded] = useState(false);

  useEffect(() => {
    if (!portfolioId) return;
    fetch(`${PORTFOLIO_API}?portfolio_id=${portfolioId}`)
      .then(r => r.ok ? r.json() : [])
      .then(async rows => {
        const pf = rows.map(normalizePfRow);
        portfolioRef.current = pf;
        setPortfolio(pf);
        setPortfolioLoaded(true);
      })
      .catch(() => {
        portfolioRef.current = [];
        setPortfolio([]);
        setPortfolioLoaded(true);
      });
  }, [portfolioId]);

  useEffect(() => { if (portfolio.length > 0) portfolioRef.current = portfolio; }, [portfolio]);
  useEffect(() => { localStorage.setItem('tracker_view', view); }, [view]);

  // ── Fetch + cache sector/country metadata ──
  useEffect(() => {
    if (!portfolioLoaded || portfolio.length === 0) return;
    const missing = portfolio.filter(p =>
      p.id && (p.sector == null || p.sector === 'Unknown' || !p.company) && !metaAttempted.current.has(p.id)
    );
    if (missing.length === 0) return;
    missing.forEach(h => metaAttempted.current.add(h.id));
    let cancelled = false;
    setMetaLoading(missing.length);
    missing.forEach(async (holding) => {
      try {
        const c = new AbortController();
        const t = setTimeout(() => c.abort(), 10000);
        let metaJson = null;
        try {
          const res = await fetch(`${META_API}?ticker=${encodeURIComponent(holding.yhTicker)}`, { signal: c.signal });
          clearTimeout(t);
          if (res.ok) metaJson = await res.json();
        } catch (e) { clearTimeout(t); }
        if (cancelled) return;
        const sector  = metaJson?.sector  || 'Unknown';
        const country = metaJson?.country || 'Unknown';
        const update  = { sector, country };
        if (!holding.company && metaJson?.companyName) update.company = metaJson.companyName;
        setPortfolio(prev => prev.map(p => p.id === holding.id ? { ...p, ...update } : p));
        fetch(`${PORTFOLIO_API}?_method=PUT&id=${holding.id}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...authHeaders() },
          body: JSON.stringify(update),
        }).catch(() => {});
      } catch (e) {
        if (!cancelled) {
          setPortfolio(prev => prev.map(p => p.id === holding.id ? { ...p, sector: 'Unknown', country: 'Unknown' } : p));
          if (holding.sector == null || holding.sector === 'Unknown') {
            fetch(`${PORTFOLIO_API}?_method=PUT&id=${holding.id}`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', ...authHeaders() },
              body: JSON.stringify({ sector: 'Unknown', country: 'Unknown' }),
            }).catch(() => {});
          }
        }
      } finally {
        if (!cancelled) setMetaLoading(prev => Math.max(0, prev - 1));
      }
    });
    return () => { cancelled = true; setMetaLoading(0); };
  }, [portfolioLoaded, portfolioId]);

  // ── Load portfolio list on mount ──
  useEffect(() => {
    fetch(PORTFOLIOS_API)
      .then(r => r.ok ? r.json() : [])
      .then(pfs => {
        if (pfs.length > 0) {
          setPortfolios(pfs);
          const saved = parseInt(localStorage.getItem('selected_portfolio_id'));
          const found = pfs.find(p => p.id === saved);
          const activePf = found || pfs[0];
          setPortfolioId(activePf.id);
          setBaseCcy(activePf.base_currency || 'DKK');
        }
        setPfListLoaded(true);
      })
      .catch(() => setPfListLoaded(true));
  }, []);

  // ── Load watchlists on mount ──
  useEffect(() => {
    fetch(WATCHLISTS_API)
      .then(r => r.ok ? r.json() : [])
      .then(wls => {
        if (wls.length > 0) {
          setWatchlists(wls);
          const saved = parseInt(localStorage.getItem('selected_watchlist_id'));
          const found = wls.find(w => w.id === saved);
          setWatchlistId((found || wls[0]).id);
        }
      })
      .catch(() => {});
  }, []);

  const switchWatchlist = useCallback((id) => {
    setWatchlistId(id);
    localStorage.setItem('selected_watchlist_id', id);
  }, []);

  // ── Auth: check setup + restore session on mount ──
  useEffect(() => {
    const token = localStorage.getItem('auth_token');
    fetch(`${AUTH_API}?setup_check=1`)
      .then(r => r.ok ? r.json() : { setupNeeded: false })
      .then(data => {
        if (data.setupNeeded) {
          setSetupNeeded(true);
          setAuthChecked(true);
          return;
        }
        if (token) {
          return fetch(AUTH_API, { headers: { Authorization: `Bearer ${token}` } })
            .then(r => { if (!r.ok) { localStorage.removeItem('auth_token'); return null; } return r.json(); })
            .then(u => { if (u) setUser(u); })
            .finally(() => setAuthChecked(true));
        }
        setAuthChecked(true);
      })
      .catch(() => setAuthChecked(true));
  }, []);

  const handlePortfolioAction = useCallback((pf) => {
    if (pf._deleted) {
      setPortfolios(prev => {
        const next = prev.filter(p => p.id !== pf.id);
        if (portfolioId === pf.id && next.length > 0) switchPortfolio(next[0].id, next[0].base_currency);
        return next;
      });
    } else if (pf._rename) {
      setPortfolios(prev => prev.map(p => p.id === pf.id ? { ...p, name: pf.name } : p));
    } else {
      setPortfolios(prev => [...prev, pf]);
      switchPortfolio(pf.id, pf.base_currency);
    }
  }, [portfolioId]);

  const switchPortfolio = useCallback((id, ccy) => {
    setPortfolioId(id);
    if (ccy) setBaseCcy(ccy);
    localStorage.setItem('selected_portfolio_id', id);
    setPortfolio([]);
    setPortfolioLoaded(false);
    setAllTxns({});
    setTxnsLoaded(false);
    setPrices({});
    setIsLive(false);
    setSelectedTicker(null);
    portfolioRef.current = [];
  }, []);

  const requireLogin = useCallback((action) => {
    if (user) { action(); }
    else { setPendingAction(() => action); setShowLogin(true); }
  }, [user]);

  const handleLogin = useCallback((data) => {
    localStorage.setItem('auth_token', data.token);
    setUser({ id: data.id, name: data.name, email: data.email });
    setShowLogin(false);
    setPendingAction(prev => { if (prev) { prev(); return null; } return null; });
  }, []);

  const handleSetupComplete = useCallback((data) => {
    localStorage.setItem('auth_token', data.token);
    setUser({ id: data.id, name: data.name, email: data.email });
    setSetupNeeded(false);
  }, []);

  const handleCcyChange = useCallback(async (pfId, ccy) => {
    await fetch(`${PORTFOLIOS_API}?_method=PUT&id=${pfId}`, {
      method: 'POST', headers: authHeaders(),
      body: JSON.stringify({ base_currency: ccy }),
    });
    setBaseCcy(ccy);
    setPortfolios(prev => prev.map(p => p.id === pfId ? { ...p, base_currency: ccy } : p));
  }, []);

  const handleLogout = useCallback(async () => {
    const token = localStorage.getItem('auth_token');
    if (token) {
      fetch(`${AUTH_API}?_method=DELETE`, {
        method: 'POST', headers: { Authorization: `Bearer ${token}` },
      }).catch(() => {});
    }
    localStorage.removeItem('auth_token');
    setUser(null);
  }, []);

  // ── Transactions from DB ────────────────────────────────────────────────────────────────
  const [allTxns,    setAllTxns]    = useState({});
  const [txnsLoaded, setTxnsLoaded] = useState(false);

  useEffect(() => {
    if (!portfolioId) return;
    fetch(`${TRANSACTIONS_API}?portfolio_id=${portfolioId}`)
      .then(r => r.ok ? r.json() : [])
      .then(async rows => {
        const grouped = {};
        rows.forEach(t => { (grouped[t.ticker] = grouped[t.ticker] || []).push(t); });
        setAllTxns(grouped);
        setTxnsLoaded(true);
      })
      .catch(() => { setAllTxns({}); setTxnsLoaded(true); });
  }, [portfolioId]);

  const handleTxnsChanged = useCallback((ticker, updatedTxns) => {
    setAllTxns(prev => ({ ...prev, [ticker]: updatedTxns }));
  }, []);

  const handleRemoveHolding = useCallback((ticker) => {
    setPortfolio(prev => {
      const next = prev.filter(p => p.ticker !== ticker);
      portfolioRef.current = next;
      return next;
    });
    setAllTxns(prev => { const next = { ...prev }; delete next[ticker]; return next; });
    setSelectedTicker(null);
  }, []);

  const handlePortfolioChanged = useCallback((newPfItem, firstTxn) => {
    setPortfolio(prev => {
      const next = [...prev, newPfItem];
      portfolioRef.current = next;
      return next;
    });
    if (firstTxn) setAllTxns(prev => ({ ...prev, [newPfItem.ticker]: [firstTxn] }));
    setTimeout(() => fetchPrices(true), 200);
  }, []);

  const fetchPrices = useCallback(async (silent=false) => {
    const pf = portfolioRef.current;
    if (!silent) setLoading(true);
    setRefreshing(true);

    const stockSyms = pf.map(p => p.yhTicker);
    const fxSyms    = ['USDDKK=X','EURDKK=X','CADDKK=X'];
    const symbols   = [...stockSyms, ...fxSyms].join(',');
    const workerUrl = `${WORKER_URL}?symbols=${symbols}`;
    const apiUrl    = `https://query2.finance.yahoo.com/v7/finance/quote?symbols=${symbols}&fields=regularMarketPrice,regularMarketChangePercent`;

    const sources = [
      workerUrl,
      apiUrl,
      `https://corsproxy.io/?${encodeURIComponent(apiUrl)}`,
    ];

    let rows = null;
    for (const url of sources) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 8000);
        const res = await fetch(url, { signal: controller.signal });
        clearTimeout(timeout);
        if (!res.ok) continue;
        const json = await res.json();
        const result = json?.quoteResponse?.result || [];
        if (result.length > 0) { rows = result; break; }
      } catch (e) { continue; }
    }

    if (rows) {
      const newPrices = {};
      const newFx = { ...CACHED_FX };
      rows.forEach(q => {
        const price  = q.regularMarketPrice;
        const chgPct = (q.regularMarketChangePercent ?? 0) / 100;
        if      (q.symbol === 'USDDKK=X') newFx.USD = price;
        else if (q.symbol === 'EURDKK=X') newFx.EUR = price;
        else if (q.symbol === 'CADDKK=X') newFx.CAD = price;
        else newPrices[q.symbol] = { price, chgPct };
      });
      setPrices(newPrices);
      setFx(newFx);
      setIsLive(true);
      setLastUpdated(new Date());
    } else {
      setIsLive(false);
      setLastUpdated(CACHED_AS_OF);
      if (Object.keys(prices).length === 0) {
        const cached = {};
        pf.forEach(p => { cached[p.yhTicker] = { price: p.cachedPrice || 0, chgPct: p.cachedChg || 0 }; });
        setPrices(cached);
        setFx(CACHED_FX);
      }
    }
    setLoading(false);
    setRefreshing(false);
  }, []);

  useEffect(() => {
    if (!portfolioLoaded) return;
    fetchPrices();
    const iv = setInterval(() => fetchPrices(true), 5 * 60 * 1000);
    return () => clearInterval(iv);
  }, [portfolioLoaded]);

  const enriched = portfolio.map(p => {
    const { shares, avgCost } = computePosition(allTxns[p.ticker] || []);
    const pd         = prices[p.yhTicker] || { price: p.cachedPrice, chgPct: p.cachedChg };
    const fxToBase   = (fx[p.ccy] || 1) / (fx[baseCcy] || 1);
    const costBase   = shares * avgCost * fxToBase;
    const valueBase  = shares * pd.price * fxToBase;
    const glBase     = valueBase - costBase;
    const glPct      = costBase > 0 ? glBase / costBase : 0;
    const prevPrice  = pd.chgPct !== -1 ? pd.price / (1 + pd.chgPct) : pd.price;
    const todayBase  = shares * (pd.price - prevPrice) * fxToBase;
    return { ...p, shares, avgCost, price: pd.price, chgPct: pd.chgPct, fxToBase, costBase, valueBase, glBase, glPct, todayBase };
  });

  const totalValue  = enriched.reduce((s,p) => s + p.valueBase, 0);
  const totalCost   = enriched.reduce((s,p) => s + p.costBase, 0);
  const totalGL     = totalValue - totalCost;
  const totalGLPct  = totalCost > 0 ? totalGL / totalCost : 0;
  const todayTotal  = enriched.reduce((s,p) => s + p.todayBase, 0);
  const prevTotal   = totalValue - todayTotal;
  const todayPct    = prevTotal > 0 ? todayTotal / prevTotal : 0;

  const withWeight = enriched.map(p => ({ ...p, weight: totalValue > 0 ? p.valueBase / totalValue : 0 }));

  useEffect(() => {
    if (!user || !portfolioId || !isLive || totalValue <= 0) return;
    if (snapshotRecorded.current.has(portfolioId)) return;
    snapshotRecorded.current.add(portfolioId);
    fetch(HISTORY_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ portfolio_id: portfolioId, total_value: totalValue, base_ccy: baseCcy }),
    }).catch(() => {});
  }, [user, portfolioId, isLive, totalValue, baseCcy]);

  const activePositions = withWeight.filter(p => p.shares > 0);
  const closedPositions = withWeight.filter(p => p.shares === 0);

  if (selectedTicker) {
    const pos = withWeight.find(p => p.ticker === selectedTicker);
    if (pos) return (
      <DetailPage
        position={pos}
        initialTxns={(allTxns[selectedTicker] || []).slice().sort((a,b) => b.date.localeCompare(a.date) || b.id - a.id)}
        onBack={() => setSelectedTicker(null)}
        onTxnsChanged={handleTxnsChanged}
        onRemoveHolding={handleRemoveHolding}
        user={user}
        onRequireLogin={requireLogin}
        portfolioId={portfolioId}
        isLive={isLive}
        lastUpdated={lastUpdated}
        baseCcy={baseCcy}
      />
    );
  }

  const sortFn = (a, b) => {
    let diff = 0;
    if (sortBy === 'value') diff = b.valueBase - a.valueBase;
    if (sortBy === 'today') diff = b.chgPct - a.chgPct;
    if (sortBy === 'gl')    diff = b.glPct - a.glPct;
    return sortDir === 'asc' ? -diff : diff;
  };
  const sortedActive = [...activePositions].sort(sortFn);
  const sortedClosed = [...closedPositions].sort(sortFn);

  const handleSort = (col) => {
    if (col === sortBy) { setSortDir(d => d === 'desc' ? 'asc' : 'desc'); }
    else { setSortBy(col); setSortDir('desc'); }
  };

  const SortBtn = ({ col, label }) => (
    <th
      className={`px-3 py-2 text-right cursor-pointer select-none text-xs ${sortBy===col ? 'text-gray-700 font-semibold' : 'text-gray-400 font-normal'}`}
      onClick={() => handleSort(col)}
    >
      {label}{sortBy===col ? (sortDir === 'desc' ? ' ↓' : ' ↑') : ''}
    </th>
  );

  const priceStr = (p) => {
    const v = p.price;
    if (v == null) return '–';
    if (v >= 1000) return v.toLocaleString('da-DK', {maximumFractionDigits:0});
    if (v >= 10)   return v.toLocaleString('da-DK', {minimumFractionDigits:2, maximumFractionDigits:2});
    return v.toLocaleString('da-DK', {minimumFractionDigits:2, maximumFractionDigits:2});
  };

  const handleAddClick = () => {
    if (view === 'watchlist') { requireLogin(() => setShowAddModal(true)); }
    else { setShowAddModal(true); }
  };

  return (
    <div className="min-h-screen bg-gray-50 pb-10">

      {/* ── Header ── */}
      <div className="bg-gray-900 text-white px-4 py-3 flex items-center justify-between sticky top-0 z-20">
        <div className="flex items-center gap-2">
          {view === 'portfolio' ? (
            pfListLoaded && portfolios.length > 0 ? (
              <PortfolioSwitcher
                portfolios={portfolios}
                portfolioId={portfolioId}
                onSwitch={switchPortfolio}
                onCreateNew={handlePortfolioAction}
                onCcyChange={handleCcyChange}
                user={user}
              />
            ) : (
              <span className="font-semibold text-[15px]">Portfolio</span>
            )
          ) : view === 'screener' ? (
            <span className="font-semibold text-[15px]">Screener</span>
          ) : (
            <span className="font-semibold text-[15px]">Watchlist</span>
          )}
          {view === 'portfolio' && (
            <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${isLive ? 'bg-emerald-500/20 text-emerald-400' : 'bg-gray-700 text-gray-400'}`}>
              {isLive ? '● live' : '○ cached'}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {user ? (
            <div className="flex items-center gap-2">
              <span className="text-[11px] text-gray-400 hidden sm:block">{user.name}</span>
              <button onClick={handleLogout}
                className="text-[11px] text-gray-400 hover:text-white transition-colors px-2 py-1 rounded-lg border border-gray-700 hover:border-gray-500">
                Sign out
              </button>
            </div>
          ) : authChecked ? (
            <button onClick={() => setShowLogin(true)}
              className="text-xs bg-gray-700 hover:bg-gray-600 transition-colors px-3 py-1.5 rounded-full font-medium">
              Sign in
            </button>
          ) : null}
          {user && view !== 'screener' && (
          <button
            onClick={handleAddClick}
            title={view === 'watchlist' ? 'Add symbol to watchlist' : 'Add new holding'}
            className="text-xs bg-blue-600 hover:bg-blue-500 active:bg-blue-700 transition-colors px-3 py-1.5 rounded-full font-semibold"
          >
            + New
          </button>
          )}
          {view === 'portfolio' && (
            <button
              onClick={() => fetchPrices()}
              className="text-xs bg-gray-700 hover:bg-gray-600 active:bg-gray-500 transition-colors px-3 py-1.5 rounded-full"
            >
              {refreshing ? <span className="inline-block spin">↻</span> : '↻'}
            </button>
          )}
        </div>
      </div>

      {/* ── View tab strip ── */}
      <div className="bg-white border-b border-gray-100 px-4 py-1.5 flex items-center gap-1">
        {[
          ['portfolio', 'Holdings'],
          ['watchlist', 'Watchlist'],
          ['screener',  'Screener'],
        ].map(([v, label]) => (
          <button key={v} onClick={() => setView(v)}
            className={`text-[11px] font-semibold px-2.5 py-1 rounded-full transition-colors ${
              view === v ? 'bg-gray-900 text-white' : 'text-gray-500 hover:bg-gray-100'
            }`}>
            {label}
          </button>
        ))}
      </div>

      {/* ── Add Holding Modal (portfolio view only) ── */}
      {showAddModal && view === 'portfolio' && (
        <AddHoldingModal
          onClose={() => setShowAddModal(false)}
          onAdded={handlePortfolioChanged}
          user={user}
          portfolioId={portfolioId}
        />
      )}

      {/* ── Login Modal ── */}
      {showLogin && (
        <LoginModal onLogin={handleLogin} onClose={() => { setShowLogin(false); setPendingAction(null); }} />
      )}

      {/* ── First-time Setup Modal ── */}
      {setupNeeded && (
        <SetupModal onComplete={handleSetupComplete} />
      )}

      {/* ── Watchlist view ── */}
      {view === 'watchlist' && (
        watchlists.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-64 gap-3 text-gray-400 px-4 text-center">
            <span className="text-3xl">👁</span>
            <span className="text-sm">No watchlist yet.</span>
            {user && (
              <p className="text-[12px] max-w-xs">
                Once you have a watchlist set up on the server, this is where it'll show up.
              </p>
            )}
          </div>
        ) : (
          <WatchlistView
            user={user}
            onRequireLogin={requireLogin}
            watchlists={watchlists}
            watchlistId={watchlistId}
            onSwitchWatchlist={switchWatchlist}
            showAddModal={showAddModal}
            setShowAddModal={setShowAddModal}
          />
        )
      )}

      {/* ── Screener view ── */}
      {view === 'screener' && (
        <ScreenerView user={user} onRequireLogin={requireLogin} />
      )}

      {/* ── Portfolio view ── */}
      {view === 'portfolio' && (
        <>
          {/* Price timestamp bar */}
          {lastUpdated && (
            <div className={`px-4 py-1.5 flex items-center justify-between text-[11px] border-b ${isLive ? 'bg-emerald-50 border-emerald-100 text-emerald-700' : 'bg-amber-50 border-amber-200 text-amber-700'}`}>
              <span>
                {isLive ? '● Prices as of' : '⚠ Cached prices from'}{' '}
                <span className="font-semibold mono">
                  {lastUpdated.toLocaleTimeString('da-DK', {hour:'2-digit', minute:'2-digit', second:'2-digit'})}
                </span>
                {' '}
                <span className="opacity-70">
                  {lastUpdated.toLocaleDateString('da-DK', {day:'2-digit', month:'2-digit', year:'numeric'})}
                </span>
              </span>
              {!isLive && <span className="font-medium">Live data unavailable</span>}
            </div>
          )}

          {loading ? (
            <div className="flex flex-col items-center justify-center h-64 gap-2 text-gray-400">
              <span className="text-2xl spin">↻</span>
              <span className="text-sm">Fetching prices…</span>
            </div>
          ) : (
            <>
              {/* ── Summary row ── */}
              <div className="grid bg-white border-b border-gray-100" style={{ gridTemplateColumns: '1fr 1fr 1fr auto' }}>
                <div className="px-4 py-3 border-r border-gray-100">
                  <div className="text-[10px] text-gray-400 uppercase tracking-wide mb-1">Portfolio</div>
                  <div className="font-bold text-gray-900 mono text-base leading-tight">
                    {n(totalValue, 0)}<span className="text-xs font-normal text-gray-400"> {baseCcy}</span>
                  </div>
                </div>
                <div className="px-4 py-3 border-r border-gray-100">
                  <div className="text-[10px] text-gray-400 uppercase tracking-wide mb-1">Today</div>
                  <div className={`font-bold mono text-base leading-tight ${clr(todayTotal)}`}>{pct(todayPct)}</div>
                  <div className={`text-[11px] mono ${clr(todayTotal)}`}>{signed(todayTotal,0)} {baseCcy}</div>
                </div>
                <div className="px-4 py-3 border-r border-gray-100">
                  <div className="text-[10px] text-gray-400 uppercase tracking-wide mb-1">Total G/L</div>
                  <div className={`font-bold mono text-base leading-tight ${clr(totalGL)}`}>{pct(totalGLPct)}</div>
                  <div className={`text-[11px] mono ${clr(totalGL)}`}>{signed(totalGL,0)} {baseCcy}</div>
                </div>
                <div className="flex flex-col border-l border-gray-100 divide-y divide-gray-100">
                  <button
                    onClick={() => { setShowHistory(v => !v); setShowInsights(false); }}
                    title="Portfolio value history"
                    className={`flex-1 px-4 flex flex-col items-center justify-center gap-0.5 transition-colors ${
                      showHistory ? 'bg-gray-900 text-white' : 'text-gray-400 hover:text-gray-700 hover:bg-gray-50'
                    }`}
                  >
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>
                    </svg>
                    <span className="text-[9px] uppercase tracking-wide font-medium">History</span>
                  </button>
                  <button
                    onClick={() => { setShowInsights(v => !v); setShowHistory(false); }}
                    title="Portfolio insights"
                    className={`flex-1 px-4 flex flex-col items-center justify-center gap-0.5 transition-colors ${
                      showInsights ? 'bg-gray-900 text-white' : 'text-gray-400 hover:text-gray-700 hover:bg-gray-50'
                    }`}
                  >
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M21.21 15.89A10 10 0 1 1 8 2.83"/><path d="M22 12A10 10 0 0 0 12 2v10z"/>
                    </svg>
                    <span className="text-[9px] uppercase tracking-wide font-medium">Insights</span>
                  </button>
                </div>
              </div>

              {/* ── History panel ── */}
              {showHistory && (
                <div className="px-4 pt-3 pb-1 bg-gray-50 border-b border-gray-100">
                  <PortfolioChart positions={withWeight} allTxns={allTxns} baseCcy={baseCcy} />
                </div>
              )}

              {/* ── Insights panel ── */}
              {showInsights && (
                <InsightsPanel
                  positions={withWeight}
                  baseCcy={baseCcy}
                  metaLoading={metaLoading}
                />
              )}

              {/* ── Table ── */}
              <div className="overflow-x-auto">
                <table className="w-full border-collapse">
                  <thead>
                    <tr className="bg-gray-100 border-b border-gray-200">
                      <th className="px-4 py-2 text-left text-xs text-gray-400 font-normal">Stock</th>
                      <SortBtn col="value" label="Value" />
                      <SortBtn col="today" label="Today" />
                      <SortBtn col="gl"    label="G/L" />
                      <th className="px-3 py-2 text-right text-xs text-gray-400 font-normal">Wt</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sortedActive.map((p, i) => (
                      <tr key={p.ticker} onClick={() => setSelectedTicker(p.ticker)} className={`border-b border-gray-100 cursor-pointer transition-colors ${i%2===0 ? 'bg-white hover:bg-blue-50' : 'bg-gray-50/60 hover:bg-blue-50'}`}>
                        <td className="px-4 py-2.5 min-w-[110px]">
                          <div className="font-semibold text-gray-900 text-[13px]">{p.ticker}</div>
                          <div className="text-[11px] text-gray-400 truncate max-w-[110px]">{p.company}</div>
                        </td>
                        <td className="px-3 py-2.5 text-right">
                          <div className="font-medium text-gray-800 mono text-[13px]">{n(p.valueBase,0)}</div>
                          <div className="text-[11px] text-gray-400 mono">{priceStr(p)} <span className="text-[10px]">{p.ccy}</span></div>
                        </td>
                        <td className={`px-3 py-2.5 text-right mono ${clr(p.chgPct)}`}>
                          <div className="text-[13px] font-semibold">{pct(p.chgPct)}</div>
                          <div className="text-[11px] opacity-80">{signed(p.todayBase,0)}</div>
                        </td>
                        <td className={`px-3 py-2.5 text-right mono ${clr(p.glPct)}`}>
                          <div className="text-[13px] font-semibold">{pct(p.glPct)}</div>
                          <div className="text-[11px] opacity-80">{signed(p.glBase,0)}</div>
                        </td>
                        <td className="px-3 py-2.5 text-right text-[11px] text-gray-400 mono">
                          {n(p.weight*100,1)}%
                        </td>
                      </tr>
                    ))}

                    {closedPositions.length > 0 && (
                      <tr className="border-t border-gray-200 bg-gray-50/50">
                        <td colSpan={5}>
                          <button
                            onClick={() => setShowClosed(s => !s)}
                            className="w-full px-4 py-2.5 text-left text-[12px] text-gray-400 hover:text-gray-600 flex items-center gap-1.5"
                          >
                            <span className="text-[10px]">{showClosed ? '▾' : '▸'}</span>
                            {showClosed ? 'Hide' : 'Show'} {closedPositions.length} closed position{closedPositions.length !== 1 ? 's' : ''}
                          </button>
                        </td>
                      </tr>
                    )}

                    {showClosed && sortedClosed.map((p) => (
                      <tr key={p.ticker} onClick={() => setSelectedTicker(p.ticker)}
                        className="border-b border-gray-50 cursor-pointer bg-gray-50/30 hover:bg-blue-50 opacity-50">
                        <td className="px-4 py-2.5 min-w-[110px]">
                          <div className="flex items-center gap-1.5">
                            <span className="font-semibold text-gray-500 text-[13px]">{p.ticker}</span>
                            <span className="text-[9px] text-gray-400 bg-gray-100 px-1 py-0.5 rounded uppercase tracking-wide">closed</span>
                          </div>
                          <div className="text-[11px] text-gray-400 truncate max-w-[110px]">{p.company}</div>
                        </td>
                        <td className="px-3 py-2.5 text-right">
                          <div className="text-[11px] text-gray-400 italic">—</div>
                          <div className="text-[11px] text-gray-300 mono">{priceStr(p)} <span className="text-[10px]">{p.ccy}</span></div>
                        </td>
                        <td className="px-3 py-2.5 text-right mono text-gray-300">
                          <div className="text-[13px]">{pct(p.chgPct)}</div>
                        </td>
                        <td className="px-3 py-2.5 text-right mono text-gray-300 text-[13px]">—</td>
                        <td className="px-3 py-2.5 text-right text-[11px] text-gray-300 mono">—</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* ── Footer: FX rates ── */}
              <div className="px-4 py-3 text-[11px] text-gray-400 text-center border-t border-gray-100 bg-white mt-0">
                FX → {baseCcy}: &nbsp;
                {baseCcy !== 'USD' && <>USD {(fx.USD/(fx[baseCcy]||1)).toFixed(4)}&nbsp;·&nbsp;</>}
                {baseCcy !== 'EUR' && <>EUR {(fx.EUR/(fx[baseCcy]||1)).toFixed(4)}&nbsp;·&nbsp;</>}
                {baseCcy !== 'DKK' && <>DKK {(1/(fx[baseCcy]||1)).toFixed(4)}&nbsp;·&nbsp;</>}
                {baseCcy !== 'CAD' && <>CAD {(fx.CAD/(fx[baseCcy]||1)).toFixed(4)}</>}
                {!isLive && <span className="ml-2 text-amber-500">cached</span>}
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<App />);
