// ── Shared LLM-call failure policy (2026-06-06) ──────────────────────────────────
// The three providers (openai/gemini/anthropic) differ only in SDK CALL MECHANICS.
// "What to do when a call empties / hangs / truncates / rate-limits" is the SAME
// policy and must hold on EVERY real-world provider path — a developer may run
// Nodedex on any provider with their own key, not just our OpenRouter setup. This
// module owns the provider-agnostic pieces (failure classification, empty-detection,
// the call timeout); each provider maps its SDK errors into classifyGenError() and
// applies the one canonical retry policy:
//
//   empty        → retry SAME model once (transient glitch; the only recovery a
//                  single-key user has) → escalate to fallback model if configured
//                  → else degrade. Never bump max_tokens (no output to grow).
//   timeout      → escalate to fallback model → else degrade. No same-model retry
//                  (the call already paid the full timeout; don't pay it twice).
//   rate_limited → escalate to fallback model → else degrade (capacity problem).
//   truncated    → retry SAME model once with a bigger budget → else degrade. NEVER
//                  swap models (a different model yields a different classification =
//                  the determinism trap).
//   mechanism_or_other → provider-specific (openai: one prompt-JSON retry; others degrade).

/** Empty/hung response: the model returned NO content (text="" / 0 tokens, often
 *  after a long hang). DISTINCT from truncation — there is no partial classification,
 *  so a max_tokens bump is a no-op and escalating to a fallback model is SAFE (the
 *  determinism trap does not apply when there was no classification at all). */
export class EmptyResponseError extends Error {
  constructor(public readonly model: string) {
    super(`empty/hung response from ${model}`);
    this.name = "EmptyResponseError";
  }
}

/** finish_reason='length' with a PARSEABLE body: the model hit max_tokens but still
 *  emitted VALID JSON — cut at a group/array boundary → valid-but-PARTIAL, silently
 *  dropping content. DISTINCT from the SyntaxError truncation (a body cut MID-structure
 *  that fails JSON.parse); this one parses cleanly, so classifyGenError can't infer it
 *  from the error alone — the provider raises it explicitly when finish_reason='length'.
 *  Same recovery as any truncation: bump max_tokens on the SAME model (never swap — the
 *  determinism trap), then fail clean (→ turns left re-extractable). */
export class TruncatedResponseError extends Error {
  constructor(public readonly model: string) {
    super(`truncated response (finish_reason=length) from ${model}`);
    this.name = "TruncatedResponseError";
  }
}

/** True when an extracted completion body has no usable content. */
export function isEmptyResult(text: string | null | undefined): boolean {
  return (text ?? "").trim() === "";
}

/** Bound an LLM call so a hung provider can't stall the pipeline indefinitely.
 *  Promise.race — the underlying request continues in the background on timeout but
 *  the pipeline unblocks. Providers whose SDK has a native per-request timeout
 *  (openai, anthropic) use that instead; gemini's SDK does not, so it wraps with this.
 *  (debt-4 Stage A, promoted from gemini.ts so the bound is shared.) */
export function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timeout after ${ms}ms`)), ms),
    ),
  ]);
}

/** The shared call-timeout bound (ms). 180s is generous: a healthy Pass 3 (~60-80s)
 *  and Pass 2c (~100-150s) fit; it caps the worst case (~3min) AND the ~200s empty-
 *  hang we observed (Run 12, 2026-06-06). Configurable via NODEDEX_LLM_TIMEOUT_MS;
 *  <=0 disables the bound. */
export function llmTimeoutMs(): number {
  const n = Number(process.env.NODEDEX_LLM_TIMEOUT_MS ?? "180000");
  return Number.isFinite(n) ? n : 180000;
}

export type GenFailureKind = "empty" | "timeout" | "rate_limited" | "truncated" | "mechanism_or_other";

/** Classify a generateStructured() failure so every provider's retry policy branches
 *  identically. Order matters: the explicit EmptyResponseError must win over the
 *  SyntaxError that an empty body would otherwise produce. */
export function classifyGenError(e: unknown): GenFailureKind {
  if (e instanceof EmptyResponseError) return "empty";
  // finish_reason='length' surfaced by the provider (valid-but-partial body). Must win
  // over the SyntaxError branch below (this one PARSED, so it isn't a SyntaxError anyway).
  if (e instanceof TruncatedResponseError) return "truncated";
  const msg = String((e as any)?.message ?? "");
  const status = (e as any)?.status;
  // Capacity / rate-limit: 429, 503 (overloaded), 529 (Anthropic overloaded), quota.
  if (status === 429 || status === 503 || status === 529 ||
      /\b429\b|\b503\b|\b529\b|quota|RESOURCE_EXHAUSTED|high demand/i.test(msg)) return "rate_limited";
  const name = String((e as any)?.name ?? "");
  // Timeout: openai/anthropic SDK throw APIConnectionTimeoutError; withTimeout() throws "... timeout after Nms".
  if (name === "APIConnectionTimeoutError" || /timeout after|timed?\s?out|timeout/i.test(msg)) return "timeout";
  // Truncation: JSON.parse threw on a NON-empty body (cut mid-structure at max_tokens).
  if (e instanceof SyntaxError || msg.includes("Unterminated") || msg.includes("position")) return "truncated";
  return "mechanism_or_other";
}

/** Out-of-credit / billing failure — DISTINCT from a transient rate-limit. The account
 *  can't pay for the call (HTTP 402, or an "insufficient credit/funds/balance/quota" body),
 *  so retrying the same model OR escalating to a fallback is pointless — every model on the
 *  account is equally unfunded. The pipeline treats this as a PAUSE-the-spend trigger
 *  (preserve + requeue the turn, auto-resume on top-up), NOT a per-turn failure that counts
 *  toward the drop cap. Accepts an Error, an OpenRouter/OpenAI SDK error ({status,code,message}),
 *  or a plain reason string (so the reflect queue can classify a swallowed-null reason too).
 *  Checked separately from classifyGenError so a billing-out never masquerades as a
 *  rate-limit (which would wastefully escalate to an equally-unfunded fallback model). */
export function isInsufficientCreditError(e: unknown): boolean {
  if (e == null) return false;
  const status = (e as any)?.status ?? (e as any)?.code;
  if (status === 402 || status === "402") return true;
  const msg = typeof e === "string" ? e : String((e as any)?.message ?? "");
  // 402 / "insufficient credit" = account out of funds. ALSO treat a provider SPEND-CAP as the
  // same class so it routes through the pause-spend + TUI alert + auto-resume path instead of a
  // silent generic-failure fail-clean: OpenRouter returns 403 "Key limit exceeded (total limit)"
  // when a key's spend ceiling is hit. Deliberately NOT a transient 429 rate-limit (that backs
  // off + retries — pausing-till-topup would be wrong) and NOT a bare 403 (auth/permission) —
  // only the limit-exceeded TEXT, which "rate limit exceeded" does not match.
  return /\b402\b|payment required|insufficient[\s_-]*(credit|fund|balance|quota)|negative\s+(credit|balance)|requires?\s+(more|additional)\s+credit|out of credit|add (more )?credit|key\s+limit\s+exceeded|\btotal\s+limit\b|credit\s+limit\b/i.test(msg);
}

/** A genuine AUTHENTICATION failure — the KEY is rejected (HTTP 401, or an invalid/expired/
 *  revoked-key body). DISTINCT from isInsufficientCreditError (402 / "key limit exceeded" = the
 *  account can't PAY, a spend decision) and from a transient 429. This is the trigger to fail
 *  over to a DIFFERENT KEY (the active one is broken), never to a different model. A billing 402/
 *  403 spend-cap must NOT read as auth, so a credit-error short-circuits to false first. A bare
 *  403 (permission/geo) is deliberately NOT auth unless the text names the key. */
export function isAuthError(e: unknown): boolean {
  if (e == null) return false;
  if (isInsufficientCreditError(e)) return false; // a spend-cap 402/403 is billing, not auth
  const status = (e as any)?.status ?? (e as any)?.code;
  if (status === 401 || status === "401") return true;
  const msg = typeof e === "string" ? e : String((e as any)?.message ?? "");
  return /\b401\b|unauthor|invalid[\s_-]*(api[\s_-]*)?key|no auth credentials|authentication[\s_-]*fail(ed|ure)?|api key.*(invalid|expired|revoked)|user not found/i.test(msg);
}

export type RetryAction = "escalate" | "retry_same" | "degrade";

/** Decide what to do with an EMPTY or TIMEOUT failure, given the retry state. This is
 *  the "escalate-first-when-a-fallback-exists" policy (2026-06-06, Run 14 finding):
 *  - escalate    : a fallback model remains → try it. For an empty, a DIFFERENT model is
 *                  the likeliest recovery (the empty tends to be input-specific to one
 *                  model) and it skips the slow same-model draw; for a timeout, don't pay
 *                  the bound twice on the same model.
 *  - retry_same  : NO fallback remains AND this is an un-retried empty → give the SAME
 *                  model one more independent draw. This is a single-key user's ONLY
 *                  recovery path (empties are probabilistic — a 2nd draw sometimes wins).
 *  - degrade     : nothing left to try (no fallback + already retried, or a timeout with
 *                  no fallback — we never re-pay a timeout on the same model).
 *  Neither empty nor timeout ever bumps max_tokens (no partial output to grow) and both
 *  are SAFE to escalate (no determinism trap — there was no classification to contradict). */
export function decideEmptyOrTimeoutAction(opts: {
  kind: "empty" | "timeout";
  hasNextModel: boolean;
  emptyRetried: boolean;
}): RetryAction {
  if (opts.hasNextModel) return "escalate";
  if (opts.kind === "empty" && !opts.emptyRetried) return "retry_same";
  return "degrade";
}
