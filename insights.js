// ─── insights.js — portfolio composition donut ──────────────────────────────
//
// The per-ticker DetailPage that used to live here is now the shared
// TickerPage in ticker.js, opened from Holdings, Watchlist and Screener alike.
// What remains is the portfolio-level composition view: PieChart +
// InsightsPanel.

// ─── Insights: colour palette ─────────────────────────────────────────────
const INSIGHT_PALETTE = [
  '#6366f1','#10b981','#f59e0b','#3b82f6','#ef4444',
  '#8b5cf6','#14b8a6','#f97316','#ec4899','#84cc16',
];

// ─── PieChart — pure SVG donut ─────────────────────────────────────────────
const PIE_LEGEND_MAX = 10;

function PieChart({ data }) {
  const [hovered,   setHovered]   = React.useState(null);
  const [collapsed, setCollapsed] = React.useState(true);

  const size = 200, cx = 100, cy = 100, R = 80, r = 50;
  const total = data.reduce((s, d) => s + d.value, 0);
  if (total === 0) return null;

  let angle = -Math.PI / 2;
  const slices = data.map((d) => {
    const sweep = (d.value / total) * Math.PI * 2;
    const s = { ...d, start: angle, end: angle + sweep };
    angle += sweep;
    return s;
  });

  const pt = (a, rad) => ({ x: cx + rad * Math.cos(a), y: cy + rad * Math.sin(a) });
  const arc = (s, e, outerR) => {
    const p1 = pt(s, outerR), p2 = pt(e, outerR), p3 = pt(e, r), p4 = pt(s, r);
    const lg = e - s > Math.PI ? 1 : 0;
    return `M${p1.x} ${p1.y} A${outerR} ${outerR} 0 ${lg} 1 ${p2.x} ${p2.y} L${p3.x} ${p3.y} A${r} ${r} 0 ${lg} 0 ${p4.x} ${p4.y}Z`;
  };

  const hSlice = hovered !== null ? slices[hovered] : null;
  const visibleSlices = collapsed ? slices.slice(0, PIE_LEGEND_MAX) : slices;
  const hiddenCount   = slices.length - PIE_LEGEND_MAX;

  return (
    <div className="flex flex-col sm:flex-row items-start gap-6" style={{ maxWidth: 560 }}>
      <svg width={size} height={size} style={{ flexShrink: 0 }}>
        {slices.map((s, i) => (
          <path key={i}
            d={arc(s.start, s.end, hovered === i ? R + 7 : R)}
            fill={s.color}
            opacity={hovered !== null && hovered !== i ? 0.55 : 1}
            style={{ cursor: 'pointer', transition: 'all 0.12s ease' }}
            onMouseEnter={() => setHovered(i)}
            onMouseLeave={() => setHovered(null)}
          />
        ))}
        {hSlice ? (
          <>
            <text x={cx} y={cy - 7} textAnchor="middle" fontSize="14" fontWeight="700" fill="#111827">
              {(hSlice.value / total * 100).toFixed(1)}%
            </text>
            <text x={cx} y={cy + 10} textAnchor="middle" fontSize="9.5" fill="#6b7280">
              {hSlice.label.length > 13 ? hSlice.label.slice(0, 13) + '…' : hSlice.label}
            </text>
          </>
        ) : (
          <text x={cx} y={cy + 5} textAnchor="middle" fontSize="11" fill="#d1d5db">
            {data.length} {data.length === 1 ? 'item' : 'items'}
          </text>
        )}
      </svg>

      {/* Legend */}
      <div className="flex flex-col gap-0.5 min-w-0" style={{ width: 300 }}>
        {visibleSlices.map((s, i) => (
          <div key={i}
            className="flex items-center gap-2 cursor-default py-0.5"
            onMouseEnter={() => setHovered(i)}
            onMouseLeave={() => setHovered(null)}
          >
            <div className="w-2.5 h-2.5 rounded-sm flex-shrink-0" style={{ backgroundColor: s.color }} />
            <span className={`text-[12px] truncate transition-colors ${hovered === i ? 'font-semibold text-gray-900' : 'text-gray-600'}`}
                  style={{ maxWidth: 180 }}>
              {s.label}
            </span>
            <span className="text-[11px] text-gray-400 ml-auto flex-shrink-0 mono">
              {(s.value / total * 100).toFixed(1)}%
            </span>
          </div>
        ))}
        {slices.length > PIE_LEGEND_MAX && (
          <button
            onClick={() => setCollapsed(v => !v)}
            className="mt-1 text-[11px] text-gray-400 hover:text-gray-600 text-left transition-colors"
          >
            {collapsed
              ? `▸ Show ${hiddenCount} more`
              : `▴ Show less`}
          </button>
        )}
      </div>
    </div>
  );
}

// ─── InsightsPanel ─────────────────────────────────────────────────────────
function InsightsPanel({ positions, baseCcy, metaLoading }) {
  const [view, setView] = React.useState('ticker');

  const active = positions.filter(p => p.shares > 0 && p.valueBase > 0);

  const groupBy = (field) => {
    const acc = {};
    active.forEach(p => {
      const key = (p[field] && p[field] !== 'Unknown' ? p[field] : 'Unknown');
      acc[key] = (acc[key] || 0) + p.valueBase;
    });
    return Object.entries(acc)
      .sort((a, b) => b[1] - a[1])
      .map(([label, value], i) => ({
        label,
        value,
        color: i < INSIGHT_PALETTE.length ? INSIGHT_PALETTE[i] : '#9ca3af',
      }));
  };

  const tickerData = active
    .slice()
    .sort((a, b) => b.valueBase - a.valueBase)
    .map((p, i) => ({
      label: p.ticker,
      value: p.valueBase,
      color: i < INSIGHT_PALETTE.length ? INSIGHT_PALETTE[i] : '#9ca3af',
    }));

  const views = [
    { key: 'ticker',   label: 'Ticker'   },
    { key: 'currency', label: 'Currency' },
    { key: 'sector',   label: 'Sector'   },
    { key: 'country',  label: 'Country'  },
  ];

  const needsMeta = view === 'sector' || view === 'country';
  const data = view === 'ticker'   ? tickerData
             : view === 'currency' ? groupBy('ccy')
             : view === 'sector'   ? groupBy('sector')
             :                       groupBy('country');

  return (
    <div className="bg-white border-b border-gray-100 px-4 pt-4 pb-5">
      {/* View toggle */}
      <div className="flex items-center gap-2 mb-4 flex-wrap">
        <span className="text-[10px] text-gray-400 uppercase tracking-widest mr-1">Composition</span>
        {views.map(v => (
          <button key={v.key}
            onClick={() => setView(v.key)}
            className={`text-[12px] px-3 py-1 rounded-full border transition-colors ${
              view === v.key
                ? 'bg-gray-900 text-white border-gray-900'
                : 'bg-white text-gray-500 border-gray-200 hover:border-gray-400 hover:text-gray-700'
            }`}>
            {v.label}
          </button>
        ))}
        {needsMeta && metaLoading > 0 && (
          <span className="text-[11px] text-gray-400 ml-1 flex items-center gap-1">
            <span className="inline-block spin">↻</span>
            fetching metadata ({metaLoading} left)…
          </span>
        )}
      </div>

      {data.length === 0 ? (
        <div className="text-[12px] text-gray-400 text-center py-6">
          {needsMeta && metaLoading > 0 ? 'Loading…' : 'No data'}
        </div>
      ) : (
        <PieChart data={data} />
      )}
    </div>
  );
}
