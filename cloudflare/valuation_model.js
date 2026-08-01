// ─── valuation_model.js — orchestrator for the AI DCF ────────────────────────
//
// The division of labour, which is the entire point of the rework:
//
//   FILINGS decide what the company HAS earned.   (valuation_data.js)
//   GEMINI decides what it MIGHT earn.            (this file)
//
// Previously Gemini supplied both, and when the single data source went quiet
// it supplied both from memory. Every historical figure below is injected by
// us; the model's response schema has no field in which to return an actual,
// so it cannot contradict a filing even if it wants to.
//
// Two passes, for the reason documented in CLAUDE.md: on Gemini 2.5,
// `google_search` grounding and `responseSchema` are mutually exclusive
// ("controlled generation is not supported with google_search tool"). So we
// research grounded and prose, then structure ungrounded and strict. The
// screener already runs this shape; flip both to one call when you move to
// Gemini 3.
//
// The grounded pass is what stops exit multiples being recalled rather than
// observed. That failure mode is documented in screener_score.js — Adobe's P/E
// came back as a 2023-era 46.5 — and it is the same mechanism that made
// ServiceNow look cheap.
// ─────────────────────────────────────────────────────────────────────────────

import { resolveValuationInputs } from './valuation_data.js';
import { cachedValue, TTL, resetStats, statsSnapshot } from './screener_cache.js';

const MODEL = 'gemini-2.5-flash';

// A blended fair value more than this far above the market is not a valuation,
// it is a modelling error until proven otherwise. Kept deliberately loose — a
// genuinely mispriced stock exists, and this flags rather than blocks.
const IMPLAUSIBLE_UPSIDE = 1.0;      // +100%
// Baseline EPS should broadly agree with the market's trailing EPS. A fast
// grower legitimately drifts (a fiscal year-end is not TTM), so this is wide.
const EPS_DRIFT_WARN = 0.40;

async function gemini(env, body) {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${env.GEMINI_API_KEY}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
  );
  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    const code = e?.error?.code || res.status;
    if (code === 429) throw new Error('Gemini quota exceeded — enable billing at aistudio.google.com or wait for quota reset');
    throw new Error(`Gemini ${code}: ${(e?.error?.message || 'unknown').slice(0, 200)}`);
  }
  const d = await res.json();
  const parts = d.candidates?.[0]?.content?.parts || [];
  return {
    text: parts.filter(p => !p.thought).map(p => p.text || '').join(''),
    sources: (d.candidates?.[0]?.groundingMetadata?.groundingChunks || [])
      .map(c => c.web?.uri).filter(Boolean).slice(0, 8),
  };
}

const money = (v, unit) => v == null ? 'n/a' : `${Math.round(v).toLocaleString('en')}${unit}`;

function actualsTable(rows, ccy) {
  return rows.map(r =>
    `  FY${r.fiscal_year}: revenue=${money(r.revenue, 'M')} ${ccy}` +
    `  gross_profit=${money(r.gross_profit, 'M')}` +
    `  EBIT=${money(r.op_income, 'M')}` +
    `  net_income=${money(r.net_income, 'M')}` +
    `  diluted_shares=${money(r.shares, 'M')}` +
    (r.revenue && r.op_income ? `  (OM ${(r.op_income / r.revenue * 100).toFixed(1)}%)` : '')
  ).join('\n');
}

/**
 * Grounded research pass → prose + citations.
 *
 * Cached 24h on ticker+date. This is the expensive half — a live search plus a
 * long generation — and a company's forward outlook does not move hour to
 * hour. The structuring pass below is deliberately NOT cached, so edits to the
 * assumption rules take effect on the next generate.
 */
async function research(inputs, env, refresh) {
  const day = new Date().toISOString().slice(0, 10);
  const { symbol, currency: ccy } = inputs;

  return cachedValue(`valuation-research:${symbol}:${day}`, TTL.AI_RESEARCH, refresh, async () => {
    const { text, sources } = await gemini(env, {
      contents: [{ parts: [{ text:
`You are an equity analyst preparing the forward assumptions for a 5-year DCF on ${symbol}${inputs.company ? ` (${inputs.company})` : ''}. Today is ${day}.

The historical financials below are already resolved from SEC filings. They are NOT up for debate — do not restate, correct or re-derive them. Your job is only to research what happens NEXT.

## Filed history (${ccy} millions)
${actualsTable(inputs.history, ccy)}

## Live market data (as of ${day})
- Share price: ${inputs.price ?? 'n/a'} ${inputs.quote_currency || ''}
- Market cap: ${money(inputs.mktcap_native / 1e6, 'M')} ${inputs.quote_currency || ''}
- Trailing P/E: ${inputs.pe_trailing != null ? inputs.pe_trailing.toFixed(1) + 'x' : 'n/a'}
- Market-implied TTM EPS: ${inputs.implied_ttm_eps != null ? inputs.implied_ttm_eps.toFixed(2) : 'n/a'}
- Most recent fiscal year ended ${inputs.y0_period_end} — ${inputs.months_since_y0} months ago.

## Research these, citing recent sources
1. What has been REPORTED SINCE FY${inputs.actuals[inputs.actuals.length - 1].fiscal_year} ended — quarterly results, and the direction versus that year. ${inputs.months_since_y0 >= 6 ? 'This is important: the last full year is stale, so the baseline understates or overstates where the company is now.' : ''}
2. Current management guidance for the current and next fiscal year — revenue, margins, and any medium-term targets.
3. Sell-side consensus revenue growth and margin trajectory over the next 2-3 years.
4. The multiple. What P/E has this company actually traded at over the last 3-5 years — the range, not a point — and where does today's ${inputs.pe_trailing != null ? inputs.pe_trailing.toFixed(1) + 'x' : 'multiple'} sit within it? What do comparable companies trade at today?
5. What would have to go WRONG for the bear case: competition, pricing, regulation, end-market, customer concentration, expiries.
6. What would have to go RIGHT for the bull case, and how much of it is already in the price.
7. Buybacks or issuance: is the share count rising or falling, and at what rate?

Be concrete and quantitative. If a figure is disputed or unavailable, say so rather than supplying a confident number.` }] }],
      tools: [{ google_search: {} }],
      generationConfig: { temperature: 0.2, maxOutputTokens: 4096 },
    });
    return { notes: text, sources };
  });
}

// Only forward assumptions. There is deliberately no field here for revenue,
// earnings or share count in a historical year — those come from filings, and
// a schema that cannot express them cannot get them wrong.
const SCENARIO_PROPS = {
  scenario:        { type: 'STRING' },
  scenario_weight: { type: 'NUMBER' },
  rev_growth:      { type: 'NUMBER' },
  tgt_gm:          { type: 'NUMBER' },
  tgt_om:          { type: 'NUMBER' },
  op_conv:         { type: 'NUMBER' },
  shr_chg:         { type: 'NUMBER' },
  disc_rt:         { type: 'NUMBER' },
  mos:             { type: 'NUMBER' },
  multiples: {
    type: 'ARRAY',
    items: { type: 'OBJECT', properties: { multiple: { type: 'NUMBER' }, weight: { type: 'NUMBER' } } },
  },
  rationale: { type: 'STRING' },
};

/** Ungrounded structuring pass → strict JSON. Not cached. */
async function structure(inputs, notes, env) {
  const y0 = inputs.actuals[inputs.actuals.length - 1];
  const gm0 = y0.gross_profit && y0.revenue ? (y0.gross_profit / y0.revenue) : null;
  const om0 = y0.op_income && y0.revenue ? (y0.op_income / y0.revenue) : null;

  const { text } = await gemini(env, {
    contents: [{ parts: [{ text:
`Turn the research notes below into bear/base/bull assumptions for a 5-year DCF on ${inputs.symbol}.

## Baseline (FY${y0.fiscal_year}, filed — fixed, do not restate)
revenue ${money(y0.revenue, 'M')}, EBIT ${money(y0.op_income, 'M')}, net income ${money(y0.net_income, 'M')}, diluted shares ${money(y0.shares, 'M')}
Current gross margin ${gm0 != null ? (gm0 * 100).toFixed(1) + '%' : 'n/a'}, operating margin ${om0 != null ? (om0 * 100).toFixed(1) + '%' : 'n/a'}
Trailing P/E today: ${inputs.pe_trailing != null ? inputs.pe_trailing.toFixed(1) + 'x' : 'unknown'}

## How the numbers are used
Revenue compounds at rev_growth for 5 years. Gross and operating margin move in a straight line from the FY${y0.fiscal_year} figures above to tgt_gm / tgt_om over those 5 years. Net income = revenue x tgt_om x op_conv. Share count compounds at shr_chg (NEGATIVE = buybacks). Terminal EPS is multiplied by the exit multiple distribution and discounted at disc_rt.

## Rules
- Exactly three scenarios: bear, base, bull. scenario_weight across the three must sum to 1.0.
- rev_growth, tgt_gm, tgt_om, op_conv, shr_chg, disc_rt, mos are DECIMAL FRACTIONS (0.12 = 12%).
- tgt_gm and tgt_om must be reachable from today's margins. A 5-year path does not double an operating margin without a specific reason in the notes.
- Exactly 10 exit multiples per scenario, weights summing to 1.0.
- ANCHOR THE MULTIPLES ON THE OBSERVED HISTORICAL RANGE FROM THE NOTES AND ON TODAY'S ${inputs.pe_trailing != null ? inputs.pe_trailing.toFixed(1) + 'x' : 'multiple'} — not on a multiple you remember for this company. A high-growth company should normally exit BELOW its current multiple, because growth decelerates as it scales. Only exceed today's multiple if the notes give a specific reason.
- disc_rt: roughly 0.09 bear, 0.08 base, 0.08 bull; raise it for a genuinely riskier business.
- mos: roughly 0.30 bear, 0.20 base, 0.15 bull.
- rationale: one or two sentences per scenario, referencing the notes — specifically what justifies the growth rate and the exit multiple band.

## Research notes
${notes}` }] }],
    generationConfig: {
      temperature: 0.1,
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'OBJECT',
        properties: {
          thesis: { type: 'STRING' },
          scenarios: { type: 'ARRAY', items: { type: 'OBJECT', properties: SCENARIO_PROPS } },
        },
      },
      maxOutputTokens: 8192,
    },
  });
  return JSON.parse(text);
}

// ─── Local projection, for the pre-save sanity check ─────────────────────────
// Mirrors projectScenario / calcScenarioFV in valuations.js. It is duplicated
// because the check has to run BEFORE the model is written to the database, and
// the frontend only sees it after. If you change the projection maths in one
// place, change it in the other — a divergence here shows up as a fair value
// that the sanity gate approved and the UI then renders differently.

function projectAndValue(sc, y0) {
  const n = sc.proj_years || 5;
  const gm0 = y0.gross_profit / y0.revenue;
  const om0 = y0.op_income / y0.revenue;
  let rev = Number(y0.revenue), shares = Number(y0.shares);
  let eps = null;
  for (let i = 1; i <= n; i++) {
    rev *= (1 + Number(sc.rev_growth));
    shares *= (1 + Number(sc.shr_chg));
    const t = i / n;
    const om = om0 + (Number(sc.tgt_om) - om0) * t;
    eps = (rev * om * Number(sc.op_conv)) / shares;
  }
  const r = Number(sc.disc_rt) || 0.08;
  let wFV = 0, wSum = 0, wMult = 0;
  for (const m of (sc.multiples || [])) {
    wFV += (eps * Number(m.multiple) / Math.pow(1 + r, n)) * Number(m.weight);
    wMult += Number(m.multiple) * Number(m.weight);
    wSum += Number(m.weight);
  }
  return { fv: wSum > 0 ? wFV / wSum : 0, termEPS: eps, avgMultiple: wSum > 0 ? wMult / wSum : null };
}

const normalise = (arr, key) => {
  const sum = arr.reduce((a, x) => a + (Number(x[key]) || 0), 0);
  if (!sum) return arr;
  return arr.map(x => ({ ...x, [key]: Number(x[key]) / sum }));
};

/**
 * Build a valuation model for `symbol`.
 *
 * Returns `{ payload, quality, flags, blocked, diagnostics, sources }`.
 * `blocked` is a string reason when the inputs failed hard — the caller must
 * NOT persist in that case. Returning the diagnostics anyway is intentional:
 * the old code swallowed failures and the result was thirteen invented models
 * nobody could tell apart from real ones.
 */
export async function generateValuation(symbol, env, { currentPrice = null, portfolioId = 0, refresh = false } = {}) {
  resetStats();
  const t0 = Date.now();
  const today = new Date().toISOString().split('T')[0];

  const inputs = await resolveValuationInputs(symbol, env, refresh);
  const flags = [];

  // Price: prefer the live quote we just resolved over whatever the frontend
  // passed. The caller's `current_price` comes from the ticker page, which may
  // be minutes stale or, for an un-held symbol, absent entirely — and every
  // upside figure in the UI is computed against it.
  const price = inputs.price ?? (currentPrice > 0 ? Number(currentPrice) : null);
  if (!price) throw new Error(`No price available for ${symbol} — cannot value it.`);

  // ── Hard gate: inputs must reconcile with the market before we spend a
  // grounded search on them, and certainly before we save. ──
  if (!inputs.reconciliation.ok) {
    return {
      blocked: 'reconciliation_failed',
      quality: 'blocked',
      flags: ['share_count_reconciliation_failed'],
      message: inputs.reconciliation.note,
      diagnostics: { ...inputs.diagnostics, elapsed_ms: Date.now() - t0 },
      inputs_preview: { actuals: inputs.actuals, price, reconciliation: inputs.reconciliation },
    };
  }
  if (inputs.reconciliation.status === 'warn') flags.push('share_count_drift');

  const { notes, sources } = await research(inputs, env, refresh);
  const parsed = await structure(inputs, notes, env);

  const y0 = inputs.actuals[inputs.actuals.length - 1];

  // ── Assemble. Actuals and history are OURS; only the scenarios are the
  // model's, and each one is normalised and bounds-checked. ──
  const wanted = ['bear', 'base', 'bull'];
  const byName = {};
  for (const sc of (parsed.scenarios || [])) byName[String(sc.scenario || '').toLowerCase()] = sc;
  const missing = wanted.filter(w => !byName[w]);
  if (missing.length) throw new Error(`Gemini returned no ${missing.join('/')} scenario for ${symbol}`);

  const rawWeights = wanted.map(w => ({ scenario: w, scenario_weight: Number(byName[w].scenario_weight) || 0 }));
  const wNorm = normalise(rawWeights, 'scenario_weight');

  const scenarios = wanted.map((name, i) => {
    const sc = byName[name];
    // Weights that do not sum to 1 silently reweight the blend, so normalise
    // rather than trusting the model to have done the arithmetic.
    let multiples = (sc.multiples || [])
      .filter(m => Number(m.multiple) > 0 && Number(m.weight) > 0)
      .map(m => ({ multiple: Number(m.multiple), weight: Number(m.weight) }));
    if (!multiples.length) throw new Error(`No usable exit multiples in the ${name} scenario for ${symbol}`);
    multiples = normalise(multiples, 'weight');

    return {
      scenario: name,
      scenario_weight: wNorm[i].scenario_weight,
      current_price: price,
      rev_growth: Number(sc.rev_growth),
      tgt_gm: Number(sc.tgt_gm),
      tgt_om: Number(sc.tgt_om),
      op_conv: Number(sc.op_conv),
      shr_chg: Number(sc.shr_chg),
      proj_years: 5,
      disc_rt: Number(sc.disc_rt) || (name === 'bear' ? 0.09 : 0.08),
      mos: Number(sc.mos) || (name === 'bear' ? 0.30 : name === 'base' ? 0.20 : 0.15),
      multiples,
      _rationale: sc.rationale || '',
    };
  });

  // ── Post-hoc sanity, on the assembled model ────────────────────────────────
  let blendedFV = 0;
  const perScenario = {};
  for (const sc of scenarios) {
    const v = projectAndValue(sc, y0);
    perScenario[sc.scenario] = {
      fv: Math.round(v.fv * 100) / 100,
      terminal_eps: Math.round(v.termEPS * 100) / 100,
      avg_exit_multiple: v.avgMultiple != null ? Math.round(v.avgMultiple * 10) / 10 : null,
    };
    blendedFV += v.fv * sc.scenario_weight;
  }
  const upside = blendedFV / price - 1;

  // The check that speaks directly to "this valuation looks too positive".
  if (upside > IMPLAUSIBLE_UPSIDE) flags.push('implausible_upside');

  // Baseline earnings vs what the market is capitalising. Independent of the
  // share reconciliation: this catches a wrong NET INCOME even when the share
  // count is right. On the old ServiceNow model these read 8.1x against 69.1x.
  const baselinePe = (y0.net_income > 0 && y0.shares > 0) ? price / (y0.net_income / y0.shares) : null;
  if (baselinePe && inputs.pe_trailing &&
      Math.abs(baselinePe / inputs.pe_trailing - 1) > EPS_DRIFT_WARN) {
    flags.push('baseline_pe_diverges_from_market');
  }

  // A base case that exits above today's multiple is assuming a re-rating, on
  // top of growth. Legal, but it should be visible rather than buried in a
  // distribution.
  const baseMult = perScenario.base?.avg_exit_multiple;
  if (baseMult && inputs.pe_trailing && baseMult > inputs.pe_trailing * 1.5) {
    flags.push('base_exit_multiple_above_current_pe');
  }
  if (inputs.months_since_y0 >= 9) flags.push('baseline_year_stale');

  const quality = flags.length === 0 ? 'ok' : 'warn';

  const srcLine = sources.length ? ` Sources: ${sources.slice(0, 4).join(' ')}` : '';
  const provenance = Object.entries(inputs.diagnostics.field_sources || {})
    .map(([k, v]) => `${k}:${v}`).join(' ');

  const payload = {
    portfolio_id: portfolioId,
    ticker: symbol,
    model_date: today,
    currency: inputs.currency,
    notes:
      `AI-generated ${today} — actuals from filings (${provenance || 'unknown'}), ` +
      `assumptions from search-grounded Gemini. ` +
      `FY${y0.fiscal_year} baseline ended ${inputs.y0_period_end} (${inputs.months_since_y0}m ago). ` +
      `Price ${price} ${inputs.quote_currency || ''}, trailing P/E ` +
      `${inputs.pe_trailing != null ? inputs.pe_trailing.toFixed(1) + 'x' : 'n/a'}. ` +
      (parsed.thesis ? `${parsed.thesis} ` : '') +
      (flags.length ? `FLAGS: ${flags.join(', ')}.` : '') + srcLine,
    data_quality: quality,
    flags,
    diagnostics: {
      ...inputs.diagnostics,
      per_scenario: perScenario,
      blended_fv: Math.round(blendedFV * 100) / 100,
      upside: Math.round(upside * 1000) / 1000,
      baseline_pe: baselinePe ? Math.round(baselinePe * 10) / 10 : null,
      market_pe: inputs.pe_trailing ?? null,
      rationales: Object.fromEntries(scenarios.map(s => [s.scenario, s._rationale])),
      sources,
      elapsed_ms: Date.now() - t0,
      cache: statsSnapshot(),
    },
    actuals: inputs.actuals.map((r, i) => ({
      label: ['Y-2', 'Y-1', 'Y0'][i + (3 - inputs.actuals.length)],
      fiscal_year: r.fiscal_year,
      revenue: r.revenue,
      gross_profit: r.gross_profit,
      op_income: r.op_income,
      net_income: r.net_income,
      shares: r.shares,
    })),
    scenarios: scenarios.map(({ _rationale, ...s }) => s),
    history: inputs.history.map(r => ({
      fiscal_year: r.fiscal_year,
      revenue: r.revenue,
      gross_profit: r.gross_profit,
      op_income: r.op_income,
      net_income: r.net_income,
      shares: r.shares,
    })),
  };

  return { payload, quality, flags, blocked: null, sources, diagnostics: payload.diagnostics };
}
