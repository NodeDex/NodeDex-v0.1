// ─── AI Provider Abstraction ──────────────────────────────────────────────────
// Swap AI backends without touching pipeline logic.
// Supported: gemini (default) | openai | anthropic | openai-compatible (Ollama, Groq, etc.)

export interface GenerateResult<T> {
  result: T | null;
  rateLimited: boolean;
  /** The call failed because the account is OUT OF CREDIT (HTTP 402 / insufficient-credit
   *  body) — distinct from rateLimited (a transient capacity cap). The reflect queue treats
   *  this as a spend-pause trigger (preserve + requeue the turn, never drop), so it must be
   *  surfaced rather than swallowed into a generic null. See isInsufficientCreditError. */
  creditExhausted?: boolean;
  /** The call failed because the KEY ITSELF was rejected (HTTP 401 / invalid-key body) —
   *  distinct from creditExhausted (the account can't pay). Signals the provider's key-failover
   *  orchestrator to retry the SAME model on the fallback KEY. A broken active key is not a spend
   *  decision, so this always triggers failover (billing-out is user-gated). See isAuthError. */
  authFailed?: boolean;
  thinking?: string;   // populated by Gemini; empty for other providers
  usage?: { input: number; thinking: number; output: number; costUsd?: number };
  /** Model that produced this result (or the last attempted, on failure). Instrumentation for run-to-run variance. */
  model?: string;
  /**
   * Full attempt trail across the primary-then-fallback escalation in this single generateStructured() call.
   * Lets the turn log show *why* a run diverged (e.g. primary truncated → fallback succeeded). One entry per
   * model invocation; the last entry's outcome matches `result === null` (failure) or `"ok"`.
   */
  attempts?: Array<{ model: string; outcome: "ok" | "rate_limited" | "truncated" | "empty" | "timeout" | "error" }>;
}

export interface LLMProvider {
  /** Schema-enforced JSON generation — used by pipeline passes 1–4. */
  generateStructured<T>(
    systemPrompt: string,
    userInput: string,
    schema: object,
    // keepReasoning: judgment passes (recognizer, dedup reviewer) set this so a
    // no-think model (NODEDEX_NO_THINK_MODELS) STILL reasons for them — no-think
    // is scoped to the mechanical passes (comprehend/classify/fill).
    options?: { thinkingBudget?: number; maxOutputTokens?: number; modelOverride?: string; keepReasoning?: boolean }
  ): Promise<GenerateResult<T>>;

  /** Free-form text/JSON generation — route handlers, tools, scheduler jobs. */
  generate(prompt: string): Promise<string | null>;

  ping(): Promise<boolean>;
  isAvailable(): boolean;
  getName(): string;
}

export interface EmbeddingProvider {
  embed(text: string): Promise<number[] | null>;
  isAvailable(): boolean;
}
