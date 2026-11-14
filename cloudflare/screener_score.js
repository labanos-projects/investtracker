// ─── screener_score.js — orchestrator ────────────────────────────────────────
// Computed criteria come from filings; only the six genuinely qualitative ones
// go to Gemini, and those are search-grounded rather than recalled from
// training data (which is what put Adobe's P/E at a 2023-era 46.5 and produced
// a PEG above 2 when the real figure is comfortably under 1).
// ─────────────────────────────────────────────────────────────────────────────

import { RUBRIC, computeQuantCriteria, aggregate, redFlags, sustainableGrowth, yearsToMultiple } from './screener_engine.js';
import { resolveMetrics, yahooSummary, sameCompany } from './screener_data.js';
import { cachedValue, TTL, resetStats, statsSnapshot } from './screener_cache.js';
import { gemini, parseJson, resolveModel, supportsOnePass } from './gemini.js';

// The model is chosen per call (see gemini.js for DEFAULT_MODEL and the
// allowlist). On 2.5, google_search grounding and responseSchema are mutually
// exclusive, so the AI half is two passes: research grounded, then structure
// ungrounded. On 3.x both fit in one call — `onePass` — but that has to earn
// its place: if it costs the source citations, two passes stay.

const AI_IDS = ['moat', 'runway', 'cap_alloc', 'industry', 'disclosure', 'insider_buy'];

const RUBRIC_TEXT = `
- moat: Durability of competitive advantage. 2=wide, defensible 20+ years. 1=narrow, ~10 years. 0=none or eroding.
- runway: Reinvestment runway / TAM headroom. Judge how much of its addressable market the company has ALREADY captured and whether the market itself is growing. 2=large underpenetrated and expanding TAM. 1=some room left. 0=saturated, or the company already holds a dominant share of a flat market.
- cap_alloc: Capital allocation. 2=excellent, reinvests at high returns. 1=mixed. 0=value-destroying.
- industry: Industry stability over a 15-25 year hold. 2=slow-changing. 1=some flux. 0=disruption risk within 5 years.
- disclosure: Management transparency. 2=clear and candid. 1=adequate. 0=opaque, or restatements.
- insider_buy: Recent insider behaviour. 2=net open-market buyers. 1=neutral. 0=net sellers.`;

/**
 * Who `symbol` actually is, in words a search engine cannot misread.
 *
 * The prompt used to say only "the company with ticker ZEAL.CO". Search
 * grounding read that as "ZEAL" and researched ZEAL Network SE (a German
 * lottery broker, XETRA: TIMA) instead of Zealand Pharma A/S — six confident,
 * well-cited, wrong qualitative scores on top of correct Yahoo numbers, and a
 * STRONG BUY. A bare ticker is not an identity; name + exchange is.
 */
function identityLine(symbol, id) {
  if (!id?.name) return `the company with ticker ${symbol}`;
  return `${id.name} (ticker ${symbol}${id.exchange ? `, listed on ${id.exchange}` : ''}` +
         `${id.currency ? `, quoted in ${id.currency}` : ''})`;
}

/** The research brief — shared by the two-pass and one-pass paths. */
function researchPrompt(symbol, id, day) {
  return `Research ${identityLine(symbol, id)} using current sources. Today is ${day}.\n\n` +
    (id?.name
      ? `IMPORTANT: research ONLY ${id.name}. Other companies may share a similar name or ticker ` +
        `(including on other exchanges) — ignore them. If your sources describe a different company, say so.\n\n`
      : '') +
    `Report concisely on each of these, citing recent facts:\n${RUBRIC_TEXT}\n\n` +
    `Also state the company's full name, GICS sector and industry. ` +
    `Be specific about how much of its addressable market the company has already captured — ` +
    `a dominant share of a mature market is a LOW score on runway even for an excellent business.`;
}

const SCORING_RULES =
  `Use 2, 1 or 0 per the rubric. Use -1 ONLY when the evidence genuinely does not ` +
  `support any judgement — never guess a middle score to fill a gap.\n\n` +
  `In \`company\`, return the full name of the company the evidence actually describes — ` +
  `not the name you were told — so a mismatch can be detected.`;

/**
 * Every field `required`: an optional field in a responseSchema may simply be
 * absent (see DATA_SOURCES.md — a valuation scenario once came back with no
 * multiples at all).
 */
function scoreSchema() {
  const props = { company: { type: 'STRING' }, sector: { type: 'STRING' }, industry: { type: 'STRING' } };
  for (const cid of AI_IDS) {
    // 0/1/2 or -1 for "not enough information". We map -1 → null rather than
    // silently defaulting to 1, which is the bug that inflated every score.
    props[`${cid}_score`] = { type: 'INTEGER' };
    props[`${cid}_why`] = { type: 'STRING' };
  }
  return { type: 'OBJECT', properties: props, required: Object.keys(props) };
}

/**
 * Grounded research pass → prose + citations.
 *
 * Cached for 24h keyed on model + ticker + date. This is the expensive half (a
 * live web search plus a long generation) and qualitative judgements about
 * moats and TAM do not move day to day. The model is in the key so a
 * comparison run can never be served the other model's answer. The
 * structuring pass below is deliberately NOT cached, so edits to the rubric
 * take effect on the next score.
 */
async function research(symbol, id, env, refresh, model) {
  const day = new Date().toISOString().slice(0, 10);
  return cachedValue(`ai-research:v2:${model}:${symbol}:${day}`, TTL.AI_RESEARCH, refresh, async () => {
    const r = await gemini(env, {
      model, prompt: researchPrompt(symbol, id, day), grounded: true,
      temperature: 0.2, thinkingLevel: 'medium', maxOutputTokens: 8192,
    });
    return { notes: r.text, sources: r.sources, searchQueries: r.searchQueries, usage: r.usage };
  });
}

/** Ungrounded structuring pass → strict JSON. Not cached. */
async function structure(symbol, id, notes, env, model) {
  const r = await gemini(env, {
    model,
    prompt:
      `Given these research notes on ${identityLine(symbol, id)}, score each criterion.\n\n` +
      `${SCORING_RULES}\n\nRUBRIC:${RUBRIC_TEXT}\n\nNOTES:\n${notes}`,
    schema: scoreSchema(),
    temperature: 0, thinkingLevel: 'low', maxOutputTokens: 8192,
  });
  return { parsed: parseJson(r), usage: r.usage };
}

/**
 * One grounded call that returns the scores directly (3.x only). Not cached:
 * it IS the research, and caching it would also cache the rubric.
 */
async function researchAndScore(symbol, id, env, model) {
  const day = new Date().toISOString().slice(0, 10);
  const r = await gemini(env, {
    model,
    prompt: `${researchPrompt(symbol, id, day)}\n\nThen score each criterion.\n\n${SCORING_RULES}\n\n` +
            `Each *_why must cite the specific recent facts behind the score.`,
    grounded: true, schema: scoreSchema(),
    thinkingLevel: 'medium', maxOutputTokens: 16384,
  });
  return { parsed: parseJson(r), sources: r.sources, searchQueries: r.searchQueries, usage: r.usage };
}

/**
 * @param {object} [opts]
 * @param {string}  [opts.model]    an ALLOWED_MODELS entry; default otherwise
 * @param {boolean} [opts.onePass]  grounded research + JSON in one call (3.x)
 */
export async function scoreTicker(symbol, env, refresh = false, opts = {}) {
  resetStats();
  const t0 = Date.now();
  const model = resolveModel(opts.model);
  const onePass = !!opts.onePass && supportsOnePass(model);

  // Identity first. yahooSummary is cached (15m) and resolveMetrics calls it
  // again immediately, so this costs one request at most and the second call
  // is a cache hit. Without it the AI half has nothing but a ticker to go on.
  const summary = await yahooSummary(symbol, refresh).catch(() => null);
  const id = summary?.longName
    ? { name: summary.longName, exchange: summary.exchange, currency: summary.currency }
    : null;

  // Data and AI are independent — run them concurrently.
  const [metrics, ai] = await Promise.all([
    resolveMetrics(symbol, env, refresh).catch(e => ({ _diag: { fatal: String(e.message) } })),
    (async () => {
      if (onePass) return await researchAndScore(symbol, id, env, model);
      const rs = await research(symbol, id, env, refresh, model);
      const st = await structure(symbol, id, rs.notes, env, model);
      return { parsed: st.parsed, sources: rs.sources, searchQueries: rs.searchQueries, usage: { research: rs.usage, structure: st.usage } };
    })().catch(e => ({ _err: String(e.message) })),
  ]);

  // ── Did the AI research the company we asked about? ──
  // Grounding can still wander to a namesake. When the name the notes describe
  // clearly disagrees with Yahoo's, the six qualitative scores belong to some
  // other company: drop them rather than blend them into this one's total.
  const aiCompany = ai?.parsed?.company || null;
  const identityMismatch = !!(id?.name && aiCompany && sameCompany(id.name, aiCompany) === false);
  if (identityMismatch) {
    ai.parsed = { company: aiCompany };
    ai._err = `research described "${aiCompany}", not ${id.name} — AI criteria discarded`;
  }

  const criteria = computeQuantCriteria(metrics);

  // Merge the AI half.
  const parsed = ai?.parsed || {};
  for (const cid of AI_IDS) {
    const rawScore = parseInt(parsed[`${cid}_score`]);
    const score = (Number.isInteger(rawScore) && rawScore >= 0 && rawScore <= 2) ? rawScore : null;
    criteria[cid] = {
      score,
      note: parsed[`${cid}_why`] || (ai?._err ? `AI unavailable: ${ai._err}` : 'No assessment'),
      source: score === null ? 'none' : 'ai-grounded',
      confidence: score === null ? 'none' : 'medium',
      ...RUBRIC[cid],
    };
  }

  const agg = aggregate(criteria);
  const sgr = sustainableGrowth(metrics.roic?.value, metrics.payout_ratio?.value);
  const roicBasis = metrics.roic?.basis || 'earnings';

  // yearsToMultiple returns null for a non-positive rate. Guard on the RESULT:
  // a negative SGR is truthy, so `sgr ? Math.round(...) : null` rounded null
  // to 0 and rendered "0 yrs to 10×" for a company that is shrinking.
  const y10 = yearsToMultiple(sgr, 10);
  const y100 = yearsToMultiple(sgr, 100);

  return {
    ticker: symbol,
    // Yahoo's name is the identity; the AI's is only ever a fallback.
    company: id?.name || parsed.company || symbol,
    sector: metrics._meta?.sector || parsed.sector || '',
    industry: metrics._meta?.industry || parsed.industry || '',
    criteria,
    ...agg,
    // roicBasis drives an explicit "engine unproven" flag — a cash-basis score
    // is a candidate for a closer look, not a track record.
    red_flags: [
      ...redFlags(criteria, { sgr, roicBasis }),
      ...(identityMismatch ? [`AI research described a different company (${aiCompany}) — qualitative scores dropped`] : []),
    ],
    // Headline multibagger metrics — the numbers you actually want on the card.
    sgr: sgr === null ? null : Math.round(sgr * 1000) / 10,
    years_to_10x: y10 === null ? null : Math.round(y10),
    years_to_100x: y100 === null ? null : Math.round(y100),
    roic_basis: roicBasis,
    mktcap_usd: metrics.mktcap_usd?.value ?? null,
    sources: ai?.sources || [],
    diagnostics: {
      ...(metrics._diag || {}),
      identity: { yahoo: id?.name || null, exchange: id?.exchange || null, ai: aiCompany, mismatch: identityMismatch },
      ai: {
        model, one_pass: onePass,
        sources: (ai?.sources || []).length,
        search_queries: (ai?.searchQueries || []).length,
        usage: ai?.usage || null,
        error: ai?._err || null,
      },
      elapsed_ms: Date.now() - t0,
      cache: statsSnapshot(),
    },
    scored_at: new Date().toISOString().split('T')[0],
  };
}
