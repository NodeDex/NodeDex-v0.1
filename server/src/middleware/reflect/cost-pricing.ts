// ═══════════════════════════════════════════════════════════════════════════════
// COST PRICING — per-pass $$ telemetry support  (D, 2026-05-25)
//
// Why this exists (system-level WHY before HOW per
// feedback-systems-thinking-framework 2026-05-25 lesson):
//
//   PASS2-SPLIT-DESIGN.md §7: "The bet is unfalsifiable without measurement."
//   Without per-pass $$ in the turn log, we can't:
//     (a) verify the split lands in the Comfortable cost tier ($0.05-0.15/turn)
//     (b) detect cost regressions before they reach the Warning tier
//     (c) compare baseline-vs-split honestly when assessing flip readiness
//     (d) attribute cost shifts (Pass 4 cheaper because Pass 2 is cleaner?
//         or Pass 2c expensive because semantic wiring?)
//
//   This module converts the already-tracked token counts (reflectTokenStats
//   in context.ts) into $$ per pass, written into the turn log per writeTurnLog
//   in pipeline.ts. Together with splitAudit persistence, this closes the
//   §7 measurement loop that the design declared non-negotiable.
//
// Universal framing (charter §5):
//   - Keyed by `model_name: string` — works for ANY provider (Anthropic,
//     Google, OpenAI, Mistral, DeepSeek, anything routed via OpenRouter)
//   - Adding a new model = one entry to the table; no schema change
//   - Returns null on unknown model — NEVER fabricates a cost (charter
//     rule 6: guards catch failure, never override success). The turn log
//     surfacing "we don't know what this costs" is the honest signal.
//   - USD only — explicit in field names (`cost_usd`, `input_per_million`).
//     Not aspirational about EUR/etc.
//
// Pricing source (point-in-time, verify against current provider docs):
//   - Anthropic: https://www.anthropic.com/pricing (Haiku 4.5, Sonnet 4.6, Opus 4.7)
//   - Google: https://ai.google.dev/pricing (Gemini 2.5 Flash, Pro)
//   - OpenRouter dashboard: https://openrouter.ai/models (cross-provider rates)
//   COST_PRICING_VERSION below is the safety valve — future agent should
//   bump it when re-verifying rates.
//
// What this module does NOT do:
//   - Per-attempt cost (escalations on truncation are billed at the model
//     that ran). Today we use the FINAL successful model. Per-attempt
//     fidelity is a follow-up if/when retry-cost-attribution becomes a
//     validation question.
//   - Reconcile with OpenRouter dashboard automatically — §7 wants ±10%
//     reconciliation, that's a manual check until a separate tool exists.
//   - Live-fetch rates — that would be a runtime dependency on an external
//     API. Static table + version is the right tradeoff for now.
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Bumped whenever the PRICING table below is re-verified against provider
 * docs / OpenRouter dashboard. Surfaced in the turn log so a future agent
 * (or future me) reading old turn logs can tell if the cost figures used
 * stale rates.
 */
export const COST_PRICING_VERSION = "2026-05-25";

/**
 * Per-million-token rates in USD. `thinking_per_million` is optional and
 * defaults to `output_per_million` when absent (most providers bill thinking
 * as output tokens; OpenAI o-series is the notable exception but is not
 * currently routed by this pipeline).
 */
export interface ModelRate {
  input_per_million:     number;
  output_per_million:    number;
  thinking_per_million?: number;
}

/**
 * Pricing table — model name string → per-million-token rates in USD.
 *
 * Add a new model = one entry. The key is the model name as it appears in
 * provider.getName() / GenerateResult.model — these are the strings the
 * pipeline already stamps into the turn log providers[] field. Stay
 * verbatim to what providers emit so lookups are direct.
 *
 * Rates as of 2026-05-25. If you bump these, bump COST_PRICING_VERSION too
 * so old turn-log readers can detect rate drift.
 */
export const PRICING: Record<string, ModelRate> = {
  // ── Google Gemini (currently the primary pipeline model) ────────────────────
  "google/gemini-2.5-flash":  { input_per_million: 0.30, output_per_million: 2.50 },
  "google/gemini-2.5-pro":    { input_per_million: 1.25, output_per_million: 10.00 },
  "gemini-2.5-flash":         { input_per_million: 0.30, output_per_million: 2.50 },
  "gemini-2.5-pro":           { input_per_million: 1.25, output_per_million: 10.00 },

  // ── Anthropic (target for multi-model routing per PASS2-SPLIT-DESIGN.md §7) ─
  // Haiku for 2a/2b (structural); Sonnet/Opus for harder semantic work if needed.
  // Both bare-name (direct Anthropic API) and "anthropic/" prefixed (OpenRouter
  // routing) forms — these are the same models, the provider emits different
  // model strings depending on the path. Multi-model routing in the orchestrator
  // (NODEDEX_PASS2A_MODEL etc.) generally uses OpenRouter-prefix form because
  // the production agent already routes via OpenRouter (see project-chat-proxy-built).
  "claude-haiku-4-5-20251001":  { input_per_million: 1.00,  output_per_million: 5.00 },
  "claude-haiku-4-5":           { input_per_million: 1.00,  output_per_million: 5.00 },
  "claude-sonnet-4-6":          { input_per_million: 3.00,  output_per_million: 15.00 },
  "claude-opus-4-7":            { input_per_million: 15.00, output_per_million: 75.00 },
  "anthropic/claude-haiku-4-5": { input_per_million: 1.00,  output_per_million: 5.00 },
  "anthropic/claude-haiku-4.5": { input_per_million: 1.00,  output_per_million: 5.00 },
  "anthropic/claude-sonnet-4-6":{ input_per_million: 3.00,  output_per_million: 15.00 },
  "anthropic/claude-sonnet-4.6":{ input_per_million: 3.00,  output_per_million: 15.00 },
  "anthropic/claude-opus-4-7":  { input_per_million: 15.00, output_per_million: 75.00 },
  "anthropic/claude-opus-4.7":  { input_per_million: 15.00, output_per_million: 75.00 },
};

/**
 * Token usage from one (or accumulated) LLM call(s). Matches the shape of
 * `reflectTokenStats.passN` in context.ts so callers can pass the slot
 * directly.
 */
export interface TokenUsage {
  input?:    number;
  output?:   number;
  thinking?: number;
  calls?:    number;
}

/**
 * Compute USD cost for a token-usage record under the given model's rates.
 *
 * Returns `null` if the model is unknown to the pricing table. This is
 * deliberate — fabricating a cost would mislead the validation work the
 * design relies on. Logs once per unknown model so the gap is auditable.
 *
 * Returns 0 (not null) on empty usage with a known model — distinguishes
 * "didn't run" (0) from "ran but we don't know what it cost" (null).
 */
const _warnedModels = new Set<string>();

export function computeCost(usage: TokenUsage | undefined, model: string | undefined): number | null {
  if (!model) {
    if (!_warnedModels.has("(undefined)")) {
      _warnedModels.add("(undefined)");
      console.warn("cost-pricing: computeCost called with undefined model — returning null");
    }
    return null;
  }
  const rate = PRICING[model];
  if (!rate) {
    if (!_warnedModels.has(model)) {
      _warnedModels.add(model);
      console.warn(`cost-pricing: no pricing entry for model "${model}" — returning null (add to PRICING table)`);
    }
    return null;
  }

  const input    = usage?.input    ?? 0;
  const output   = usage?.output   ?? 0;
  const thinking = usage?.thinking ?? 0;

  // Thinking billed as output unless the provider specifies otherwise.
  const thinkingRate = rate.thinking_per_million ?? rate.output_per_million;

  const cost =
    (input    / 1_000_000) * rate.input_per_million +
    (output   / 1_000_000) * rate.output_per_million +
    (thinking / 1_000_000) * thinkingRate;

  return cost;
}

/**
 * Reset the warn-once memo. Useful for tests; not used in production code.
 */
export function _resetWarnings(): void {
  _warnedModels.clear();
}
