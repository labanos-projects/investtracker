// ─── screener_engine.js — multibagger screener ───────────────────────────────
//
// Design notes (see PR for full rationale):
//
//  1. Scores are 0 / 1 / 2 / null. `null` means NO DATA and is excluded from
//     BOTH numerator and denominator. The old code did `parseInt(x) || 1`,
//     which silently turned every genuine 0 into a 1 — GME scored 58% because
//     twelve failing criteria were promoted to "partial".
//
//  2. Quantitative criteria are COMPUTED from filings, never asked of an LLM.
//     Data is resolved per FIELD down a waterfall (EDGAR → Yahoo → FMP → AI),
//     not per source, so we never discard a good number because one provider
//     was missing an unrelated one.
//
//  3. Every criterion records `source` + `confidence` so a score is auditable.
//
//  4. The rubric targets 100-baggers. The engine of a 100-bagger is
//     ROIC × reinvestment rate sustained from a small base, so that product
//     (the sustainable growth rate) is a first-class Tier 1 criterion, and
//     market cap is scored as *headroom to 10–100×* rather than a fixed band.
//
//  5. That engine is earnings-based, which cannot see a company reinvesting
//     hard at negative accounting earnings — Amazon would have scored 0 on
//     Tier 1 for most of its best two decades. So ROIC accepts a CASH basis
//     (see screener_data.js) and is labelled when it uses one.
//
// ─────────────────────────────────────────────────────────────────────────────

// ─── Rubric ──────────────────────────────────────────────────────────────────
// weight × 2 = max points for that criterion.
export const RUBRIC = {
  // Tier 1 — the compounding engine (×3)
  reinvestment:  { w: 3, tier: 1, kind: 'computed', label: 'Reinvestment engine (ROIC × retention)' },
  roic:          { w: 3, tier: 1, kind: 'computed', label: 'ROIC ≥ 20%' },
  rev_growth:    { w: 3, tier: 1, kind: 'computed', label: 'Revenue CAGR ≥ 20%' },
  runway:        { w: 3, tier: 1, kind: 'ai',       label: 'TAM headroom / reinvestment runway' },
  moat:          { w: 3, tier: 1, kind: 'ai',       label: 'Durable moat (20yr+)' },
  // Tier 2 — multibagger preconditions (×2)
  size_headroom: { w: 2, tier: 2, kind: 'computed', label: 'Size headroom (room to 10–100×)' },
  insider_own:   { w: 2, tier: 2, kind: 'hybrid',   label: 'Owner-operator (insiders ≥ 10%)' },
  gross_margin:  { w: 2, tier: 2, kind: 'computed', label: 'Gross margin vs sector' },
  fcf:           { w: 2, tier: 2, kind: 'computed', label: 'FCF positive & growing' },
  debt:          { w: 2, tier: 2, kind: 'computed', label: 'Net debt / EBITDA < 1.5×' },
  cap_alloc:     { w: 2, tier: 2, kind: 'ai',       label: 'Capital allocation quality' },
  // Tier 3 — entry & hygiene (×1)
  peg:           { w: 1, tier: 3, kind: 'computed', label: 'PEG < 1 (entry multiple)' },
  eps_growth:    { w: 1, tier: 3, kind: 'computed', label: 'EPS CAGR ≥ 15%' },
  shares:        { w: 1, tier: 3, kind: 'computed', label: 'No dilution' },
  industry:      { w: 1, tier: 3, kind: 'ai',       label: 'Industry stability' },
  disclosure:    { w: 1, tier: 3, kind: 'ai',       label: 'Management transparency' },
  insider_buy:   { w: 1, tier: 3, kind: 'ai',       label: 'Insiders net buying' },
};

export const AI_CRITERIA = Object.keys(RUBRIC).filter(k => RUBRIC[k].kind !== 'computed');

// ─── Scoring helpers ─────────────────────────────────────────────────────────

const num = v => (typeof v === 'number' && isFinite(v)) ? v : null;

/** Band a value into 2/1/0. Returns null (NOT 1) when the input is missing. */
function band(v, hi, mid) {
  const n = num(v);
  if (n === null) return null;
  return n >= hi ? 2 : n >= mid ? 1 : 0;
}

/** Compound annual growth rate from first→last across (n-1) periods. */
export function cagr(series) {
  const s = (series || []).filter(v => num(v) !== null);
  if (s.length < 2) return null;
  const first = s[0], last = s[s.length - 1], yrs = s.length - 1;
  // CAGR is undefined across a sign change or from a zero base.
  if (first <= 0 || last <= 0) return null;
  return Math.pow(last / first, 1 / yrs) - 1;
}

/**
 * Size headroom — the multibagger-specific replacement for the old
 * "market cap $500M–$3B" band.
 *
 * We don't care about absolute size, we care whether the *terminal* cap
 * implied by a 10× or 100× is a number that has ever existed. ~$3T is a
 * defensible ceiling for "very large but not the largest company on earth".
 *
 *   ≤ $30B   → a 100× lands under the ceiling  → 2
 *   ≤ $300B  → a 10×  lands under the ceiling  → 1
 *   > $300B  → even a 10× implies > $3T        → 0
 */
export function scoreSizeHeadroom(mcapUsd) {
  const m = num(mcapUsd);
  if (m === null || m <= 0) return null;
  const CEILING = 3e12;
  if (m * 100 <= CEILING) return 2;
  if (m * 10 <= CEILING) return 1;
  return 0;
}

/**
 * Sustainable growth rate = ROIC × retention ratio.
 *
 * This is the single most important number in the model. A company can only
 * compound intrinsic value as fast as it can redeploy capital at its return
 * on capital. Coca-Cola earns a fine ROIC but pays most of it out, so its
 * engine runs at ~6%/yr. NVIDIA retains essentially everything at a far
 * higher ROIC. That difference is exactly why one can still multibag and the
 * other cannot, and it falls out of the arithmetic rather than an AI opinion.
 *
 * `roic` may be earnings- or cash-based; see screener_data.js. The basis is
 * carried separately and surfaced in the notes, because an unproven engine
 * must never be presented as a proven one.
 */
export function sustainableGrowth(roic, payoutRatio) {
  const r = num(roic), p = num(payoutRatio);
  if (r === null) return null;
  const retention = 1 - (p === null ? 0 : Math.min(1, Math.max(0, p)));
  return r * retention;
}

/** Years to 10× at a given compounding rate — the headline output. */
export function yearsToMultiple(rate, multiple = 10) {
  const r = num(rate);
  if (r === null || r <= 0) return null;
  return Math.log(multiple) / Math.log(1 + r);
}

/**
 * Band a free-cash-flow series.
 *
 * The inflection case is deliberately scored as highly as a long positive
 * run. A company crossing from cash-burning to strongly cash-generative
 * while growing is the single most interesting shape a multibagger screen
 * can find — Cloudflare went -28M → 287M and the old rule scored it 1, the
 * same as a business that had been flatly, boringly positive for five years.
 *
 * Requires the last TWO points positive so a single good year doesn't count
 * as an inflection.
 */
export function scoreFcf(series) {
  if (!Array.isArray(series) || series.length < 2) return { score: null, inflected: false };
  const first = series[0], last = series[series.length - 1];
  const prev = series[series.length - 2];
  const allPos = series.every(v => v > 0);
  const growing = last > first;
  const inflected = first <= 0 && last > 0 && prev > 0 && growing;

  if (inflected) return { score: 2, inflected: true };
  if (allPos && growing) return { score: 2, inflected: false };
  if (last > 0) return { score: 1, inflected: false };
  return { score: 0, inflected: false };
}

// ─── Computed criteria ───────────────────────────────────────────────────────

/**
 * Build the 11 computed criteria from a resolved metrics bag.
 * Every metric carries {value, source}; a missing metric yields score null.
 */
export function computeQuantCriteria(m) {
  const out = {};
  const put = (id, score, note, src) => {
    out[id] = {
      score,
      note,
      source: score === null ? 'none' : (src || 'computed'),
      confidence: score === null ? 'none' : 'high',
      ...RUBRIC[id],
    };
  };
  const pct = v => (num(v) === null ? '—' : (v * 100).toFixed(1) + '%');
  const src = k => m[k]?.source || 'unknown';
  const val = k => num(m[k]?.value);

  // ── Tier 1 ──
  const roic = val('roic');
  const payout = val('payout_ratio');
  const cashBasis = m.roic?.basis === 'fcf';
  const roicLabel = cashBasis ? 'cash ROIC' : 'ROIC';
  const sgr = sustainableGrowth(roic, payout);
  const y10 = yearsToMultiple(sgr, 10);

  put('reinvestment', band(sgr, 0.20, 0.10),
    sgr === null
      ? 'ROIC unavailable — cannot compute reinvestment rate'
      : `SGR ${pct(sgr)} = ${roicLabel} ${pct(roic)} × retention ${pct(1 - (payout ?? 0))}` +
        (y10 ? ` → ~${y10.toFixed(0)}yr to 10×` : '') +
        (cashBasis ? ' · cash basis, accounting earnings still negative' : ''),
    src('roic'));

  put('roic', band(roic, 0.20, 0.12),
    roic === null
      ? 'No ROIC data'
      : cashBasis
        ? `Cash ROIC ${pct(roic)} (FCF ÷ invested capital) — earnings basis is negative`
        : `ROIC ${pct(roic)} (3yr avg)`,
    src('roic'));

  const rg = val('rev_cagr');
  put('rev_growth', band(rg, 0.20, 0.10),
    rg === null ? 'No revenue history' : `Revenue CAGR ${pct(rg)}`, src('rev_cagr'));

  // ── Tier 2 ──
  const mcap = val('mktcap_usd');
  put('size_headroom', scoreSizeHeadroom(mcap),
    mcap === null
      ? 'No market cap'
      : `$${(mcap / 1e9).toFixed(1)}B — 10× ⇒ $${(mcap * 10 / 1e12).toFixed(2)}T, ` +
        `100× ⇒ $${(mcap * 100 / 1e12).toFixed(1)}T`,
    src('mktcap_usd'));

  const ins = val('insider_own');
  put('insider_own', band(ins, 0.10, 0.03),
    ins === null ? 'No insider ownership data' : `Insiders hold ${pct(ins)}`, src('insider_own'));

  const gm = val('gross_margin'), gmSector = val('sector_gross_margin');
  const gmScore = (gm === null || gmSector === null)
    ? band(gm, 0.60, 0.40)                       // absolute fallback
    : band(gm - gmSector, 0.05, -0.05);          // sector-relative when we have it
  put('gross_margin', gmScore,
    gm === null ? 'No margin data'
      : `GM ${pct(gm)}` + (gmSector !== null ? ` vs sector ${pct(gmSector)}` : ' (no sector benchmark)'),
    src('gross_margin'));

  const fcfSeries = m.fcf_series?.value;
  const fcfBand = scoreFcf(fcfSeries);
  let fcfNote = 'No cash-flow data';
  if (Array.isArray(fcfSeries) && fcfSeries.length >= 2) {
    fcfNote = `FCF ${fcfSeries.map(v => (v / 1e6).toFixed(0) + 'M').join(' → ')}` +
              (fcfBand.inflected ? ' · inflected positive' : '');
  }
  put('fcf', fcfBand.score, fcfNote, src('fcf_series'));

  const nd = val('net_debt_ebitda');
  let debtScore = null;
  if (nd !== null) debtScore = nd <= 1.5 ? 2 : nd <= 3 ? 1 : 0;
  put('debt', debtScore,
    nd === null ? 'No leverage data'
      : nd < 0 ? `Net cash (${nd.toFixed(1)}× EBITDA)` : `Net debt/EBITDA ${nd.toFixed(1)}×`,
    src('net_debt_ebitda'));

  // ── Tier 3 ──
  // PEG is an indication, not a precision instrument — sources disagree
  // (0.58 / 0.65 / 0.98 for ADBE) because they use different growth inputs.
  // We define ours explicitly: trailing P/E ÷ 3yr historical EPS CAGR (in %).
  const pe = val('pe_trailing');
  const epsG = val('eps_cagr');
  let peg = null;
  if (pe !== null && epsG !== null && epsG > 0 && pe > 0) peg = pe / (epsG * 100);
  put('peg', peg === null ? null : (peg < 1 ? 2 : peg <= 2 ? 1 : 0),
    peg === null
      ? (epsG !== null && epsG <= 0 ? 'EPS not growing — PEG undefined' : 'Insufficient data for PEG')
      : `PEG ${peg.toFixed(2)} (P/E ${pe.toFixed(1)} ÷ EPS CAGR ${pct(epsG)})`,
    src('pe_trailing'));

  put('eps_growth', band(epsG, 0.15, 0.07),
    epsG === null ? 'No EPS history' : `EPS CAGR ${pct(epsG)}`, src('eps_cagr'));

  const shChg = val('share_change');
  let shScore2 = null;
  if (shChg !== null) shScore2 = shChg <= -0.01 ? 2 : shChg <= 0.02 ? 1 : 0;
  put('shares', shScore2,
    shChg === null ? 'No share-count history' : `Share count ${shChg >= 0 ? '+' : ''}${pct(shChg)}/yr`,
    src('share_change'));

  return out;
}

// ─── Aggregation ─────────────────────────────────────────────────────────────

/**
 * Aggregate criteria into a score with a DYNAMIC denominator.
 * Criteria scored null contribute to neither numerator nor denominator, and
 * instead reduce `coverage`. Conviction is suppressed under low coverage so a
 * company scored on four criteria can never render as STRONG BUY.
 */
export function aggregate(criteria) {
  let quant = 0, quantMax = 0, qual = 0, qualMax = 0;
  let weighted = 0, weightedMax = 0, totalWeight = 0, missing = [];

  for (const [id, c] of Object.entries(criteria)) {
    const meta = RUBRIC[id];
    if (!meta) continue;
    totalWeight += meta.w;
    if (c.score === null || c.score === undefined) { missing.push(id); continue; }
    const pts = c.score * meta.w, max = meta.w * 2;
    weighted += pts; weightedMax += max;
    if (meta.kind === 'ai') { qual += pts; qualMax += max; }
    else { quant += pts; quantMax += max; }
  }

  const coverage = totalWeight > 0 ? (totalWeight - missing.reduce((a, id) => a + RUBRIC[id].w, 0)) / totalWeight : 0;
  const pct = weightedMax > 0 ? (weighted / weightedMax) * 100 : 0;

  let conviction;
  if (coverage < 0.7) conviction = 'INSUFFICIENT DATA';
  else if (pct >= 70) conviction = 'STRONG BUY';
  else if (pct >= 50) conviction = 'WATCH';
  else conviction = 'PASS';

  return {
    quant_score: quant, quant_max: quantMax,
    qual_score: qual, qual_max: qualMax,
    total: weighted, max: weightedMax,
    pct: Math.round(pct * 10) / 10,
    coverage: Math.round(coverage * 1000) / 10,
    missing, conviction,
  };
}

/** Red flags now actually fire, because 0 is reachable. */
export function redFlags(criteria, metrics) {
  const f = [];
  const s = id => criteria[id]?.score;
  if (s('reinvestment') === 0) f.push('Reinvestment engine stalled (<10% SGR)');
  if (s('roic') === 0) f.push('ROIC below 12%');
  if (s('rev_growth') === 0) f.push('Revenue growth < 10%');
  if (s('size_headroom') === 0) f.push('Too large for a 10×');
  if (s('debt') === 0) f.push('Net debt > 3× EBITDA');
  if (s('moat') === 0) f.push('No identifiable moat');
  if (s('shares') === 0) f.push('Shareholders being diluted');
  // A cash-basis engine is a candidate, not a track record. Say so.
  if (metrics?.roicBasis === 'fcf') f.push('Engine unproven — cash basis, earnings still negative');
  const y10 = yearsToMultiple(num(metrics?.sgr), 10);
  if (y10 && y10 > 30) f.push(`~${y10.toFixed(0)}yr to 10× at current SGR`);
  return f;
}
