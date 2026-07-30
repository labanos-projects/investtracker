// ─── screener_score.js — orchestrator ────────────────────────────────────────
// Computed criteria come from filings; only the six genuinely qualitative ones
// go to Gemini, and those are search-grounded rather than recalled from
// training data (which is what put Adobe's P/E at a 2023-era 46.5 and produced
// a PEG above 2 when the real figure is comfortably under 1).
// ─────────────────────────────────────────────────────────────────────────────

import { RUBRIC, computeQuantCriteria, aggregate, redFlags, sustainableGrowth, yearsToMultiple } from './screener_engine.js';
import { resolveMetrics } from './screener_data.js';
import { cachedValue, TTL, resetStats, statsSnapshot } from './screener_cache.js';

const MODEL = 'gemini-2.5-flash';
// google_search grounding and responseSchema are mutually exclusive on 2.5
// ("controlled generation is not supported with google_search tool"), so we
// research grounded, then structure ungrounded. gemini-3-flash-preview allows
// both in one call — flip this when you move models.
const GROUNDED_TWO_PASS = true;

const AI_IDS = ['moat', 'runway', 'cap_alloc', 'industry', 'disclosure', 'insider_buy'];

const RUBRIC_TEXT = `
- moat: Durability of competitive advantage. 2=wide, defensible 20+ years. 1=narrow, ~10 years. 0=none or eroding.
- runway: Reinvestment runway / TAM headroom. Judge how much of its addressable market the company has ALREADY captured and whether the market itself is growing. 2=large underpenetrated and expanding TAM. 1=some room left. 0=saturated, or the company already holds a dominant share of a flat market.
- cap_alloc: Capital allocation. 2=excellent, reinvests at high returns. 1=mixed. 0=value-destroying.
- industry: Industry stability over a 15-25 year hold. 2=slow-changing. 1=some flux. 0=disruption risk within 5 years.
- disclosure: Management transparency. 2=clear and candid. 1=adequate. 0=opaque, or restatements.
- insider_buy: Recent insider behaviour. 2=net open-market buyers. 1=neutral. 0=net sellers.`;

async function gemini(env, body) {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${env.GEMINI_API_KEY}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
  );
  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    throw new Error(`Gemini ${res.status}: ${e?.error?.message || 'unknown'}`);
  }
  const d = await res.json();
  const parts = d.candidates?.[0]?.content?.parts || [];
  return {
    text: parts.filter(p => !p.thought).map(p => p.text || '').join(''),
    sources: (d.candidates?.[0]?.groundingMetadata?.groundingChunks || [])
      .map(c => c.web?.uri).filter(Boolean).slice(0, 8),
  };
}

/**
 * Grounded research pass → prose + citations.
 *
 * Cached for 24h keyed on ticker + date. This is the expensive half (a live
 * web search plus a long generation) and qualitative judgements about moats
 * and TAM do not move day to day. The structuring pass below is deliberately
 * NOT cached, so edits to the rubric take effect on the next score.
 */
async function research(symbol, env, refresh) {
  const day = new Date().toISOString().slice(0, 10);
  return cachedValue(`ai-research:${symbol}:${day}`, TTL.AI_RESEARCH, refresh, async () => {
    const { text, sources } = await gemini(env, {
      contents: [{ parts: [{ text:
        `Research the company with ticker ${symbol} using current sources. Today is ${day}.\n\n` +
        `Report concisely on each of these, citing recent facts:\n${RUBRIC_TEXT}\n\n` +
        `Also state the company's full name, GICS sector and industry. ` +
        `Be specific about how much of its addressable market the company has already captured — ` +
        `a dominant share of a mature market is a LOW score on runway even for an excellent business.`
      }] }],
      tools: [{ google_search: {} }],
      generationConfig: { temperature: 0.2, maxOutputTokens: 4096 },
    });
    return { notes: text, sources };
  });
}

/** Ungrounded structuring pass → strict JSON. Not cached. */
async function structure(symbol, notes, env) {
  const props = { company: { type: 'STRING' }, sector: { type: 'STRING' }, industry: { type: 'STRING' } };
  for (const id of AI_IDS) {
    // 0/1/2 or -1 for "not enough information". We map -1 → null rather than
    // silently defaulting to 1, which is the bug that inflated every score.
    props[`${id}_score`] = { type: 'INTEGER' };
    props[`${id}_why`] = { type: 'STRING' };
  }
  const { text } = await gemini(env, {
    contents: [{ parts: [{ text:
      `Given these research notes on ${symbol}, score each criterion.\n\n` +
      `Use 2, 1 or 0 per the rubric. Use -1 ONLY when the notes genuinely do not ` +
      `support any judgement — never guess a middle score to fill a gap.\n\n` +
      `RUBRIC:${RUBRIC_TEXT}\n\nNOTES:\n${notes}`
    }] }],
    generationConfig: {
      temperature: 0,
      responseMimeType: 'application/json',
      responseSchema: { type: 'OBJECT', properties: props },
      maxOutputTokens: 4096,
    },
  });
  return JSON.parse(text);
}

export async function scoreTicker(symbol, env, refresh = false) {
  resetStats();
  const t0 = Date.now();

  // Data and AI are independent — run them concurrently.
  const [metrics, ai] = await Promise.all([
    resolveMetrics(symbol, env, refresh).catch(e => ({ _diag: { fatal: String(e.message) } })),
    (async () => {
      const { notes, sources } = await research(symbol, env, refresh);
      const parsed = await structure(symbol, notes, env);
      return { parsed, sources };
    })().catch(e => ({ _err: String(e.message) })),
  ]);

  const criteria = computeQuantCriteria(metrics);

  // Merge the AI half.
  const parsed = ai?.parsed || {};
  for (const id of AI_IDS) {
    const rawScore = parseInt(parsed[`${id}_score`]);
    const score = (Number.isInteger(rawScore) && rawScore >= 0 && rawScore <= 2) ? rawScore : null;
    criteria[id] = {
      score,
      note: parsed[`${id}_why`] || (ai?._err ? `AI unavailable: ${ai._err}` : 'No assessment'),
      source: score === null ? 'none' : 'ai-grounded',
      confidence: score === null ? 'none' : 'medium',
      ...RUBRIC[id],
    };
  }

  const agg = aggregate(criteria);
  const sgr = sustainableGrowth(metrics.roic?.value, metrics.payout_ratio?.value);

  // yearsToMultiple returns null for a non-positive rate. Guard on the RESULT:
  // a negative SGR is truthy, so `sgr ? Math.round(...) : null` rounded null
  // to 0 and rendered "0 yrs to 10×" for a company that is shrinking.
  const y10 = yearsToMultiple(sgr, 10);
  const y100 = yearsToMultiple(sgr, 100);

  return {
    ticker: symbol,
    company: parsed.company || symbol,
    sector: metrics._meta?.sector || parsed.sector || '',
    industry: metrics._meta?.industry || parsed.industry || '',
    criteria,
    ...agg,
    red_flags: redFlags(criteria, { sgr }),
    // Headline multibagger metrics — the numbers you actually want on the card.
    sgr: sgr === null ? null : Math.round(sgr * 1000) / 10,
    years_to_10x: y10 === null ? null : Math.round(y10),
    years_to_100x: y100 === null ? null : Math.round(y100),
    mktcap_usd: metrics.mktcap_usd?.value ?? null,
    sources: ai?.sources || [],
    diagnostics: {
      ...(metrics._diag || {}),
      elapsed_ms: Date.now() - t0,
      cache: statsSnapshot(),
    },
    scored_at: new Date().toISOString().split('T')[0],
  };
}
