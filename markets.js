// markets.js — MarketsView: index overview, index chart, and index movers
// ranked by CONTRIBUTION to the index (weight × return), not by raw % change.
// Data: ?symbols= for the index cards, ?chart= via StockChart, ?index_movers=
// for the constituent breakdown (see cloudflare/markets.js).

const MARKET_INDICES = [
  { key: 'SP500',   symbol: '^GSPC',     name: 'S&P 500',       movers: true  },
  { key: 'NDX',     symbol: '^NDX',      name: 'Nasdaq 100',    movers: true  },
  { key: 'DJI',     symbol: '^DJI',      name: 'Dow Jones',     movers: true  },
  { key: 'OMXC25',  symbol: '^OMXC25',   name: 'OMX C25',       movers: true  },
  { key: 'IXIC',    symbol: '^IXIC',     name: 'Nasdaq Comp.',  movers: false },
  { key: 'STOXX50', symbol: '^STOXX50E', name: 'Euro Stoxx 50', movers: false },
  { key: 'DAX',     symbol: '^GDAXI',    name: 'DAX',           movers: true  },
];

const fmtLevel = (v) => v == null || isNaN(v) ? '–'
  : v.toLocaleString('da-DK', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
// Contribution is a fraction of the index; shown in percentage points.
const fmtPp  = (v) => v == null || isNaN(v) ? '–' : signed(v * 100, 2) + ' pp';
const fmtPts = (v) => v == null || isNaN(v) ? '–' : signed(v, Math.abs(v) >= 10 ? 1 : 2);

const MoverRow = ({ c, mode, maxAbs, owned, onOpen }) => {
  const val = mode === 'impact' ? c.contrib : c.chgPct;
  const w = maxAbs ? Math.min(100, Math.abs(val) / maxAbs * 100) : 0;
  return (
    <button onClick={onOpen}
      className="w-full text-left px-3 py-2 border-b border-gray-50 hover:bg-gray-50 transition-colors">
      <div className="flex items-baseline justify-between gap-2">
        <div className="min-w-0 flex items-baseline gap-1.5">
          <span className="font-semibold text-[13px] text-gray-900">{c.symbol.replace(/\.CO$/, '')}</span>
          {owned && <span className="text-[9px] px-1 rounded bg-blue-50 text-blue-600 font-semibold">OWNED</span>}
          <span className="text-[11px] text-gray-400 truncate">{c.name}</span>
        </div>
        <div className={`mono text-[13px] font-semibold shrink-0 ${clr(val)}`}>
          {mode === 'impact' ? fmtPts(c.contribPts) : pct(c.chgPct)}
        </div>
      </div>
      <div className="flex items-center gap-2 mt-1">
        <div className="flex-1 h-1.5 bg-gray-100 rounded-full overflow-hidden">
          <div className={`h-full rounded-full ${val >= 0 ? 'bg-emerald-400' : 'bg-red-400'}`} style={{ width: `${w}%` }} />
        </div>
        <div className="mono text-[10px] text-gray-400 shrink-0 w-44 text-right">
          {mode === 'impact'
            ? <>{pct(c.chgPct)} × {n(c.weight * 100, 2)}% = {fmtPp(c.contrib)}</>
            : <>weight {n(c.weight * 100, 2)}% · {fmtPts(c.contribPts)} pts</>}
        </div>
      </div>
    </button>
  );
};

const IndexMovers = ({ idx, ownedSet, onOpenTicker }) => {
  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);
  const [mode, setMode]       = useState(() => localStorage.getItem('markets_mode') || 'impact');
  const [count, setCount]     = useState(10);

  useEffect(() => { localStorage.setItem('markets_mode', mode); }, [mode]);

  const load = useCallback((refresh = false) => {
    setLoading(true); setError(null);
    fetch(`${WORKER_URL}?index_movers=${idx.key}${refresh ? '&refresh=1' : ''}`)
      .then(r => r.json())
      .then(d => { if (d.error) throw new Error(d.error); setData(d); })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, [idx.key]);

  useEffect(() => { setData(null); load(false); }, [load]);

  if (loading && !data) return <div className="p-6 text-center text-sm text-gray-400"><span className="spin inline-block">↻</span> Loading constituents…</div>;
  if (error && !data)   return <div className="p-6 text-center text-sm text-red-500">Could not load movers: {error}</div>;
  if (!data) return null;

  const cs = data.constituents || [];
  const key = mode === 'impact' ? 'contrib' : 'chgPct';
  const ups   = [...cs].filter(c => c[key] > 0).sort((a, b) => b[key] - a[key]).slice(0, count);
  const downs = [...cs].filter(c => c[key] < 0).sort((a, b) => a[key] - b[key]).slice(0, count);
  const maxAbs = Math.max(0, ...[...ups, ...downs].map(c => Math.abs(c[key])));

  const isOwned = (s) => ownedSet.has(s.toUpperCase());
  const ownedRows = cs.filter(c => isOwned(c.symbol));
  const ownedContrib = ownedRows.reduce((a, c) => a + c.contrib, 0);
  const ownedWeight  = ownedRows.reduce((a, c) => a + c.weight, 0);

  const st = quoteStamp(data.index?.quoteTime ? new Date(data.index.quoteTime * 1000) : null);
  const open = (c) => onOpenTicker({ ticker: c.symbol, yhTicker: c.symbol, company: c.name, ccy: c.currency, origin: 'markets' });

  const { up, down, unchanged } = data.breadth || {};
  const tot = (up || 0) + (down || 0) + (unchanged || 0);

  const List = ({ title, rows }) => (
    <div className="bg-white rounded-xl border border-gray-100 overflow-hidden">
      <div className="px-3 py-2 text-[10px] uppercase tracking-wide text-gray-400 border-b border-gray-100">{title}</div>
      {rows.length === 0
        ? <div className="px-3 py-4 text-[12px] text-gray-400">None</div>
        : rows.map(c => <MoverRow key={c.symbol} c={c} mode={mode} maxAbs={maxAbs} owned={isOwned(c.symbol)} onOpen={() => open(c)} />)}
    </div>
  );

  return (
    <div className="px-4 py-3 space-y-3">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div>
          <div className="text-[13px] font-semibold text-gray-900">Top / bottom — {idx.name}</div>
          <div className="text-[11px] text-gray-400">
            Session {st.label}{st.stale ? ' (previous session)' : ''}
            {' · '}{data.weighting === 'price' ? 'price-weighted' : 'cap-weighted'}
          </div>
        </div>
        <div className="flex items-center gap-1">
          {[['impact', 'Impact'], ['pct', '% change']].map(([m, l]) => (
            <button key={m} onClick={() => setMode(m)}
              className={`text-[11px] font-semibold px-2.5 py-1 rounded-full ${mode === m ? 'bg-gray-900 text-white' : 'text-gray-500 hover:bg-gray-100'}`}>{l}</button>
          ))}
          <button onClick={() => load(true)} title="Refresh"
            className="text-[11px] px-2 py-1 rounded-full text-gray-500 hover:bg-gray-100">
            {loading ? <span className="spin inline-block">↻</span> : '↻'}
          </button>
        </div>
      </div>

      {/* Summary: what the model explains vs what the index did, breadth, your share */}
      <div className="grid grid-cols-3 bg-white rounded-xl border border-gray-100 text-center">
        <div className="px-2 py-2 border-r border-gray-100">
          <div className="text-[10px] text-gray-400 uppercase tracking-wide">Index</div>
          <div className={`mono font-bold text-[14px] ${clr(data.index?.chgPct)}`}>{pct(data.index?.chgPct)}</div>
          <div className="text-[10px] text-gray-400" title="Sum of weight × return over the constituents priced. The gap to the index move is the approximation error — small with ETF weights, larger where weights are estimated from market cap.">
            model {pct(data.explained)}
          </div>
        </div>
        <div className="px-2 py-2 border-r border-gray-100">
          <div className="text-[10px] text-gray-400 uppercase tracking-wide">Breadth</div>
          <div className="mono text-[13px] font-semibold"><span className="text-emerald-500">{up}↑</span> <span className="text-red-500">{down}↓</span></div>
          {tot > 0 && (
            <div className="mt-1 mx-3 h-1.5 rounded-full bg-red-300 overflow-hidden">
              <div className="h-full bg-emerald-400" style={{ width: `${up / tot * 100}%` }} />
            </div>
          )}
        </div>
        <div className="px-2 py-2">
          <div className="text-[10px] text-gray-400 uppercase tracking-wide">Your holdings</div>
          {ownedRows.length ? (
            <>
              <div className={`mono text-[13px] font-semibold ${clr(ownedContrib)}`}>{fmtPp(ownedContrib)}</div>
              <div className="text-[10px] text-gray-400">{ownedRows.length} names · {n(ownedWeight * 100, 1)}% of index</div>
            </>
          ) : <div className="text-[11px] text-gray-400 mt-1">none in index</div>}
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <List title={mode === 'impact' ? 'Pulling the index up' : 'Biggest gainers'} rows={ups} />
        <List title={mode === 'impact' ? 'Pulling the index down' : 'Biggest losers'} rows={downs} />
      </div>

      <div className="flex items-center justify-between text-[10px] text-gray-400">
        <span title={data.weights?.source || ''}>
          {data.coverage?.priced}/{data.coverage?.listed} constituents priced · {
            ['etf', 'published'].includes(data.weights?.basis) ? `weights from ${data.weights.source}${data.weights.asOf ? ` (${data.weights.asOf})` : ''}`
          : data.weights?.basis === 'price'      ? 'price-weighted'
          : data.weights?.basis === 'cap-capped' ? 'weights ≈ market cap, 15% issuer cap'
          :                                        'weights ≈ market cap'}
        </span>
        <button onClick={() => setCount(c => c === 10 ? 25 : 10)} className="underline">
          {count === 10 ? 'Show 25' : 'Show 10'}
        </button>
      </div>
    </div>
  );
};

const MarketsView = ({ holdings, onOpenTicker }) => {
  const [quotes, setQuotes] = useState({});
  const [selKey, setSelKey] = useState(() => localStorage.getItem('markets_index') || 'SP500');
  useEffect(() => { localStorage.setItem('markets_index', selKey); }, [selKey]);

  useEffect(() => {
    const syms = MARKET_INDICES.map(i => i.symbol).join(',');
    fetch(`${WORKER_URL}?symbols=${encodeURIComponent(syms)}`)
      .then(r => r.json())
      .then(d => {
        const m = {};
        (d?.quoteResponse?.result || []).forEach(q => {
          m[q.symbol] = {
            price: q.regularMarketPrice,
            // ?symbols= returns a percentage; pct() expects a fraction.
            chgPct: q.regularMarketChangePercent != null ? q.regularMarketChangePercent / 100 : null,
            time: q.regularMarketTime ? new Date(q.regularMarketTime * 1000) : null,
          };
        });
        setQuotes(m);
      })
      .catch(() => {});
  }, []);

  // Holdings and Yahoo constituents use different keys (NOVO-B vs NOVO-B.CO);
  // match on the Yahoo symbol, which is what the constituents carry.
  const ownedSet = React.useMemo(
    () => new Set((holdings || []).flatMap(h => [h.yhTicker, h.ticker]).filter(Boolean).map(s => s.toUpperCase())),
    [holdings]);

  const sel = MARKET_INDICES.find(i => i.key === selKey) || MARKET_INDICES[0];

  return (
    <div>
      {/* Index cards */}
      <div className="flex gap-2 overflow-x-auto px-4 py-3 bg-white border-b border-gray-100">
        {MARKET_INDICES.map(i => {
          const q = quotes[i.symbol];
          const s = quoteStamp(q?.time);
          return (
            <button key={i.key} onClick={() => setSelKey(i.key)}
              className={`shrink-0 text-left rounded-xl border px-3 py-2 min-w-[120px] transition-colors ${
                i.key === sel.key ? 'border-gray-900 bg-gray-50' : 'border-gray-100 hover:border-gray-300'}`}>
              <div className="text-[11px] font-semibold text-gray-700">{i.name}</div>
              <div className="mono text-[13px] text-gray-900">{fmtLevel(q?.price)}</div>
              <div className="flex items-baseline justify-between gap-2">
                <span className={`mono text-[12px] font-semibold ${clr(q?.chgPct)}`}>{pct(q?.chgPct)}</span>
                <span className={`mono text-[9px] ${s.stale ? 'text-amber-600' : 'text-gray-300'}`}>{s.label}</span>
              </div>
            </button>
          );
        })}
      </div>

      {/* Chart */}
      <div className="bg-white border-b border-gray-100">
        <StockChart key={sel.symbol} yhTicker={sel.symbol} ccy="" />
      </div>

      {sel.movers
        ? <IndexMovers key={sel.key} idx={sel} ownedSet={ownedSet} onOpenTicker={onOpenTicker} />
        : <div className="px-4 py-6 text-center text-[12px] text-gray-400">
            Constituent breakdown is available for S&P 500, Nasdaq 100, Dow Jones, OMX C25 and DAX.
          </div>}
    </div>
  );
};
