// thinking-spill.ts — per-model memory of how many reasoning tokens a model ACTUALLY
// spends, vs what we asked for.
//
// WHY (hy3 2026-07-06): reasoning budgets are ADVISORY on some models — hy3 was asked
// for 1024 thinking tokens and spent 4-7K, and OpenAI-compatible APIs bill reasoning
// INSIDE max_tokens. The spill cannibalized the output space, so structured passes
// truncated over and over (each retry a slow, wasted call). A static per-model output
// ceiling (model-caps.ts) can't fix this — the spill is only visible at runtime, in
// usage.completion_tokens_details.reasoning_tokens.
//
// So: RECORD the worst observed spill per model (openai.ts records it the moment usage
// is read — truncated responses report reasoning tokens too, so a failure teaches the
// very next attempt), and SIZE requests with max(requested, observed × headroom).
// In-process only: a restart starts fresh and re-learns within one call.

const observedMax = new Map<string, number>();

/** Record the reasoning tokens a response actually consumed. Keeps the per-model MAX —
 *  budgets must cover the worst case, not the average. */
export function recordObservedThinking(model: string, actualTokens: number): void {
  if (!model || !Number.isFinite(actualTokens) || actualTokens <= 0) return;
  const prev = observedMax.get(model) ?? 0;
  if (actualTokens > prev) observedMax.set(model, actualTokens);
}

/** The thinking allowance to budget INTO the max_tokens sum for `model`: the requested
 *  budget when the model has stayed within it, else the worst observed spill × 1.25
 *  headroom (spill varies call to call). The requested value still goes to the
 *  provider's `reasoning.max_tokens` unchanged — this only protects the OUTPUT space. */
export function effectiveThinkBudget(model: string, requested: number | undefined): number {
  const req = requested ?? 0;
  const seen = observedMax.get(model) ?? 0;
  return seen <= req ? req : Math.ceil(seen * 1.25);
}

/** Test hook. */
export function _resetThinkingSpillForTests(): void {
  observedMax.clear();
}
