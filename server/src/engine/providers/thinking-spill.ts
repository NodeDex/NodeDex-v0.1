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

// ── No-think NON-COMPLIANCE (self-healing) ──────────────────────────────────────
// A model can be on the no-think list yet IGNORE `reasoning:{enabled:false}` and keep
// reasoning anyway (hy3, 2026-07-15). Because reasoning bills INSIDE max_tokens, the
// no-think path's effThink=0 then starves the output → every structured pass truncates.
// A hand-maintained list can't catch this — the model's behavior changed after it was
// added. So DETECT it at runtime: if we sent no-think but got reasoning tokens back, the
// model ignores the flag; from then on, budget headroom for its thinking even on the
// no-think path. Self-heals a stale/wrong no-think entry (the hy3 failure in one rule).
const NOTHINK_TOLERANCE = 256; // a compliant model may emit a few tokens; this is clear non-compliance
const ignoresNoThink = new Set<string>();

/** Record whether a model honored a no-think request. Called after every call's usage is
 *  read. `sentNoThink` = we asked for reasoning-off this call; `reasoningTokens` = what it
 *  actually spent. Spending past the tolerance despite the flag = ignores no-think. */
export function recordNoThinkCompliance(model: string, sentNoThink: boolean, reasoningTokens: number): void {
  if (model && sentNoThink && Number.isFinite(reasoningTokens) && reasoningTokens > NOTHINK_TOLERANCE) {
    ignoresNoThink.add(model);
  }
}

/** True once `model` has been OBSERVED to reason despite a no-think request — so callers
 *  reserve thinking headroom for it even when it's on the no-think list. */
export function modelIgnoresNoThink(model: string | undefined): boolean {
  return !!model && ignoresNoThink.has(model);
}

/** Test hook. */
export function _resetThinkingSpillForTests(): void {
  observedMax.clear();
  ignoresNoThink.clear();
}

// ── No-think mode ──────────────────────────────────────────────────────────────
// Some reasoning models do structured extraction BETTER and 3× FASTER with reasoning
// OFF. hy3 (2026-07-06 diagnostic): forced thinking mislabelled types AND one chunk
// spent 6758 think / 64 output (thinking starving output) → the arc failed; its native
// no-think mode produced cleaner classification in 2.7s vs 7.6s. Reasoning is a MODEL
// TRAIT for this workload, not a universal good — so it's a per-model switch.
//
// NODEDEX_NO_THINK_MODELS = comma-separated model ids to run reasoning-off.
// NODEDEX_DISABLE_REASONING = 1/on = global no-think (all models). The list wins when set.

/** Whether `model` should run with reasoning DISABLED (no-think). Checks the per-model
 *  list first, then the global switch. */
export function isReasoningDisabled(model: string | undefined): boolean {
  if (!model) return false;
  const list = (process.env.NODEDEX_NO_THINK_MODELS ?? "")
    .split(",").map(s => s.trim()).filter(Boolean);
  if (list.length > 0) return list.includes(model);
  const g = (process.env.NODEDEX_DISABLE_REASONING ?? "").toLowerCase();
  return g === "1" || g === "on" || g === "true";
}

/** Whether THIS specific call should run reasoning-off: the model is a no-think model
 *  AND the call site did not opt to keep reasoning. Judgment passes (recognizer, dedup
 *  reviewer) pass keepReasoning=true so no-think stays scoped to the mechanical passes
 *  (comprehend/classify/fill) even when the whole model is on the no-think list. */
export function reasoningDisabledForCall(model: string | undefined, keepReasoning?: boolean): boolean {
  return isReasoningDisabled(model) && !keepReasoning;
}
