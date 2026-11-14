// ─── gemini.js — the one place that talks to the Gemini API ──────────────────
//
// Both engines (screener_score.js, valuation_model.js) used to carry their own
// copy of this call with the model name hard-coded. Model generations differ
// in which request fields they accept, so that knowledge lives here, once:
//
//   2.5   google_search and responseSchema are mutually exclusive ("controlled
//         generation is not supported with google_search tool"), so grounded
//         work is two passes: research in prose, then structure ungrounded.
//         Takes `temperature`.
//
//   3.x   May combine google_search with responseSchema in one call. Sampling
//         parameters (temperature/top_p/top_k) are deprecated, so they are not
//         sent. Reasoning depth is `thinkingConfig.thinkingLevel` — low,
//         medium or high; `minimal` is rejected on 3.8 Flash.
//
// One-pass (search + schema in ONE call) was measured on 2026-11-14 against
// NOVO-B.CO, ZEAL.CO, MSFT and ROCK-B.CO and REJECTED: in 3 of 4 runs 3.8
// Flash issued no search at all (0 queries, 0 sources) and scored from memory
// — exactly the recalled-not-observed failure the grounded pass exists to
// prevent. Two passes searched every time. `onePass` stays available behind
// ?onepass=1 so a future model can be re-measured, but nothing defaults to it.
// ─────────────────────────────────────────────────────────────────────────────

// What runs when nobody asks for anything else.
//
// 3.8 Flash since 2026-11-14, after a side-by-side on the four tickers above
// (screener) and MSFT (valuation), both models two-pass. Totals moved by at
// most ±5 points and every run stayed grounded; the difference was in the
// judgement. On Novo, 2.5 scored industry stability 2 on "pharma is stable";
// 3.8 scored it 1 citing patent-cliff cycles and pricing pressure. 3.8's notes
// and DCF rationales carried figures (penetration rates, growth and margin
// assumptions) where 2.5 wrote generic sentences. Valuation upside on MSFT:
// +40.7% (2.5) vs +39.7% (3.8), no flags on either.
export const DEFAULT_MODEL = 'gemini-3.8-flash';

// Models a request may select with ?model= for side-by-side comparison. An
// allowlist, so a query string can never send an arbitrary model name (or a
// path) into the API URL.
export const ALLOWED_MODELS = ['gemini-2.5-flash', 'gemini-3.8-flash'];

export const resolveModel = requested =>
  ALLOWED_MODELS.includes(requested) ? requested : DEFAULT_MODEL;

export const isGen3 = model => /^gemini-3/.test(model);

/** Can this model do grounded search and strict JSON in a single call? */
export const supportsOnePass = model => isGen3(model);

/**
 * One generateContent call.
 *
 * @param {object} o
 * @param {string}  o.model
 * @param {string}  o.prompt
 * @param {boolean} [o.grounded]         enable google_search
 * @param {object}  [o.schema]           responseSchema → JSON output
 * @param {number}  [o.maxOutputTokens]
 * @param {number}  [o.temperature]      2.5 only; ignored for 3.x
 * @param {string}  [o.thinkingLevel]    3.x only: 'low' | 'medium' | 'high'
 */
export async function gemini(env, o) {
  const model = o.model || DEFAULT_MODEL;
  if (o.grounded && o.schema && !supportsOnePass(model)) {
    throw new Error(`${model} cannot combine google_search with a response schema — use two passes`);
  }

  const generationConfig = { maxOutputTokens: o.maxOutputTokens || 8192 };
  if (isGen3(model)) {
    if (o.thinkingLevel) generationConfig.thinkingConfig = { thinkingLevel: o.thinkingLevel };
  } else if (typeof o.temperature === 'number') {
    generationConfig.temperature = o.temperature;
  }
  if (o.schema) {
    generationConfig.responseMimeType = 'application/json';
    generationConfig.responseSchema = o.schema;
  }

  const body = { contents: [{ parts: [{ text: o.prompt }] }], generationConfig };
  if (o.grounded) body.tools = [{ google_search: {} }];

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
  );
  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    const code = e?.error?.code || res.status;
    if (code === 429) throw new Error(`Gemini quota exceeded (${model}) — enable billing at aistudio.google.com or wait for quota reset`);
    throw new Error(`Gemini ${code} (${model}): ${(e?.error?.message || 'unknown').slice(0, 200)}`);
  }

  const d = await res.json();
  const cand = d.candidates?.[0];
  const parts = cand?.content?.parts || [];
  const gm = cand?.groundingMetadata || {};
  return {
    model,
    text: parts.filter(p => !p.thought).map(p => p.text || '').join(''),
    // MAX_TOKENS means the output is truncated mid-value; callers surface it
    // so truncation reports itself as truncation rather than as bad JSON.
    finishReason: cand?.finishReason || null,
    sources: (gm.groundingChunks || []).map(c => c.web?.uri).filter(Boolean).slice(0, 8),
    searchQueries: gm.webSearchQueries || [],
    usage: d.usageMetadata ? {
      input: d.usageMetadata.promptTokenCount ?? null,
      output: d.usageMetadata.candidatesTokenCount ?? null,
      thinking: d.usageMetadata.thoughtsTokenCount ?? null,
    } : null,
  };
}

/** Parse model JSON, tolerating a stray code fence, and say WHY it failed. */
export function parseJson(r) {
  const cleaned = String(r.text || '').replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch (e) {
    if (r.finishReason === 'MAX_TOKENS') {
      throw new Error(`Gemini (${r.model}) hit the output limit before finishing the JSON (${cleaned.length} chars) — truncated, not malformed.`);
    }
    throw new Error(`Gemini (${r.model}) returned unparseable JSON (finishReason=${r.finishReason}, ${cleaned.length} chars): ${e.message}. Tail: ${cleaned.slice(-160)}`);
  }
}
