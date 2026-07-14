import OpenAI from "openai";
import type { LLMProvider, EmbeddingProvider, GenerateResult } from "../ai-provider.js";
import { EmptyResponseError, TruncatedResponseError, classifyGenError, isEmptyResult, llmTimeoutMs, decideEmptyOrTimeoutAction, isInsufficientCreditError, isAuthError } from "./failure-policy.js";
import { modelOutputCeiling } from "./model-caps.js";
import { effectiveThinkBudget, recordObservedThinking, reasoningDisabledForCall, recordNoThinkCompliance, modelIgnoresNoThink } from "./thinking-spill.js";
// Re-exported for back-compat (callers/tests that imported these from openai.js):
export { EmptyResponseError, classifyGenError } from "./failure-policy.js";

// ── Structured-output portability (2026-06-02) ──────────────────────────────────
// There is NO universal structured-output format across providers: OpenAI uses
// `response_format: json_schema`, Anthropic uses TOOL-USE (no response_format),
// others (Grok/Kimi/DeepSeek/local) vary. Routing a non-OpenAI model through the
// OpenAI `response_format` path 400s (proven: Anthropic Haiku on the complex 2b
// schema). So we pick the mechanism by model, and fall back to prompt-JSON — the
// only mechanism EVERY model supports ("just output JSON") — on a hard provider
// error. The default (Gemini/OpenAI) path is unchanged.
export type SoMechanism = "response_format" | "tool_use" | "prompt_json";

export function primaryMechanism(model: string): SoMechanism {
  const m = (model ?? "").toLowerCase();
  // Anthropic models reject response_format → use their native tool-use.
  return (m.startsWith("anthropic/") || m.includes("claude")) ? "tool_use" : "response_format";
}

/** Strip ```json ... ``` fences + surrounding whitespace (prompt-JSON models often
 *  wrap output in markdown despite instructions). */
export function stripJsonFences(s: string): string {
  return (s ?? "").trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/i, "").trim();
}

export class OpenAIProvider implements LLMProvider {
  private client: OpenAI | null;

  constructor(apiKey: string, baseURL?: string) {
    this.client = apiKey
      ? new OpenAI({ apiKey, ...(baseURL ? { baseURL } : {}) })
      : null;
  }

  // Default + fallback model resolved LIVE from env (NOT cached at construction) so a
  // web-UI / config-endpoint model change takes effect on the NEXT call without a
  // restart. The CLIENT (apiKey/baseURL) stays construction-cached, so key/base-url
  // changes still require resetProviders() (they're in the config endpoint's reset
  // list); only the model is live. A per-call modelOverride still wins (modelsToTry).
  private get model(): string { return process.env.AI_MODEL ?? "gpt-4o"; }
  private get fallbackModel(): string | null {
    const fb = process.env.NODEDEX_FALLBACK_MODEL ?? "";
    return fb && fb !== this.model ? fb : null;
  }

  // ── Key-failover (option B) ────────────────────────────────────────────────
  // The FALLBACK-KEY client, constructed LIVE from env (like fallbackModel above, not cached at
  // construction) so a keyring swap takes effect on the next call with no provider reset. Cached
  // by (key, base) so we don't rebuild an OpenAI client every call. Null when no fallback key is
  // configured — then the orchestrator simply never fails over.
  private _fbClient: { key: string; base: string; client: OpenAI } | null = null;
  private fallbackClient(): OpenAI | null {
    const key = process.env.NODEDEX_FALLBACK_API_KEY ?? "";
    if (!key) return null;
    const base = process.env.NODEDEX_FALLBACK_BASE_URL ?? process.env.OPENAI_BASE_URL ?? "";
    if (this._fbClient && this._fbClient.key === key && this._fbClient.base === base) return this._fbClient.client;
    const client = new OpenAI({ apiKey: key, ...(base ? { baseURL: base } : {}) });
    this._fbClient = { key, base, client };
    return client;
  }
  // User's choice (keyring page → NODEDEX_FAILOVER_ON_BILLING): auto-fail-over to the fallback key
  // when the ACTIVE key BILLS OUT (default on = keep extracting on the fallback). Off = respect the
  // spend-pause instead of auto-spending the fallback. AUTH failures (a broken key) fail over
  // regardless — that isn't a spend decision.
  private failoverOnBilling(): boolean {
    return (process.env.NODEDEX_FAILOVER_ON_BILLING ?? "on").toLowerCase() !== "off";
  }

  isAvailable(): boolean { return this.client !== null; }
  getName(): string { return process.env.OPENAI_BASE_URL ? "openai-compatible" : "openai"; }

  async generateStructured<T>(
    systemPrompt: string,
    userInput: string,
    schema: object,
    options?: { thinkingBudget?: number; maxOutputTokens?: number; modelOverride?: string; keepReasoning?: boolean }
  ): Promise<GenerateResult<T>> {
    if (!this.client) return { result: null, rateLimited: false };
    const modelsToTry = options?.modelOverride
      ? [options.modelOverride]
      : this.fallbackModel ? [this.model, this.fallbackModel] : [this.model];

    // Primary attempt on the ACTIVE key.
    const primary = await this.runModels<T>(this.client, modelsToTry, systemPrompt, userInput, schema, options);

    // KEY-FAILOVER (option B): the active key can't authenticate (bad/revoked key) or can't pay
    // (billing-out — only when the user left auto-failover-on-billing ON). Retry the SAME models on
    // the FALLBACK key, if one is configured. Same model set ⇒ NO determinism trap (only the key
    // changes, never the model). Auth failure ALWAYS fails over; billing-out is user-gated.
    const fbClient = this.fallbackClient();
    if (fbClient && (primary.authFailed || (primary.creditExhausted && this.failoverOnBilling()))) {
      console.warn(`[openai] active key ${primary.authFailed ? "rejected (auth)" : "out of credit"} — failing over to fallback key (same model)`);
      const fb = await this.runModels<T>(fbClient, modelsToTry, systemPrompt, userInput, schema, options);
      fb.attempts = [...(primary.attempts ?? []), ...(fb.attempts ?? [])];
      return fb;
    }
    return primary;
  }

  // Run the model list (primary → fallback-MODEL) on ONE client (one key). Extracted from
  // generateStructured so the key-failover orchestrator above can re-run the SAME models on a
  // second CLIENT (the fallback key) without duplicating the intricate truncation / mechanism /
  // empty-retry policy. `client` is the key to use; every other line is unchanged from before.
  private async runModels<T>(
    client: OpenAI,
    modelsToTry: string[],
    systemPrompt: string,
    userInput: string,
    schema: object,
    options?: { thinkingBudget?: number; maxOutputTokens?: number; modelOverride?: string; keepReasoning?: boolean }
  ): Promise<GenerateResult<T>> {
    // Extraction is deterministic by nature → default temperature 0. This is the main lever
    // on run-to-run variance: 6 stochastic passes compound and the swing lands on borderline
    // items. Configurable via NODEDEX_REFLECT_TEMPERATURE; the call auto-drops temperature if
    // a model rejects it (some reasoning models require 1). 0 is the most-deterministic value
    // on every provider — ranges/defaults otherwise differ across providers.
    const tEnv = process.env.NODEDEX_REFLECT_TEMPERATURE;
    const temperature = tEnv !== undefined && tEnv !== "" && Number.isFinite(Number(tEnv)) ? Number(tEnv) : 0;

    // Failure-mode policy (2026-05-23):
    //  - JSON truncation  → SAME-MODEL retry with max_tokens × 1.5 (capped). If it
    //    still truncates, fail loudly. Truncation is a budget problem, not a model-
    //    capacity problem — silently swapping to a different model with different
    //    classification semantics is a non-determinism trap (we proved this: same
    //    input, two graphs depending on whether the primary truncated). The pipeline-
    //    level retry / re-queue handles persistent failure.
    //  - 429 rate-limit   → escalate to fallback model. Different problem (capacity);
    //    a different model is the right answer.
    //  - Other errors     → fail without escalation.
    const attempts: NonNullable<GenerateResult<T>["attempts"]> = [];
    const thinkBudget = options?.thinkingBudget;
    const requestedMaxOut = options?.maxOutputTokens ?? 16384;
    // The provider request is maxOut + thinkBudget — OUTPUT and REASONING share the
    // model's output budget, so that SUM must never exceed the model's hard output
    // ceiling. Over-requesting returns a broken, empty response (completion_tokens=0,
    // finish=null) that masquerades as a truncation but can't be recovered. The ceiling
    // is PER-MODEL (modelOutputCeiling) — a single constant broke portability: Pass 3's
    // 32768 over-requests on GPT-4o's 16384 cap. So baseMaxOut + the 1.5× truncation-bump
    // are clamped to (ceiling − thinking) INSIDE the model loop, recomputed when an
    // escalation switches models, and the bump stays EFFECTIVE whenever a pass leaves
    // headroom below the ceiling.
    // 2026-06-16: Pass 3 was set to Gemini's 65536 ceiling and +thinking pushed every
    // call over it → a glitch silently dropped a whole arc's write. Caught by the
    // deep-stress long-arc run; the old bump min(base*1.5, 65536) was a no-op at ceiling.
    // Shared call-timeout bound (NODEDEX_LLM_TIMEOUT_MS, 180s default) — bounds the
    // ~200s hangs that precede empty responses (Run 12). Native SDK timeout aborts the
    // request; a timed-out call escalates to the fallback model. <=0 disables it.
    const callTimeoutMs = llmTimeoutMs();

    for (let i = 0; i < modelsToTry.length; i++) {
      const modelName = modelsToTry[i];
      const isFallback = i > 0;
      let truncBumped = false;
      let emptyRetried = false;
      // Structured-output mechanism for this model: native by provider, switched
      // to the universal prompt-JSON floor on a hard provider error (below).
      let mechanism: SoMechanism = primaryMechanism(modelName);
      // For the post-loop log lines — set per iteration below.
      let baseMaxOut = 0;
      let bumpedMaxOut = 0;

      // Inner loop: original + one truncation bump + (on hard error) a one-time
      // prompt-JSON fallback retry.
      while (true) {
        // No-think models (hy3): reasoning OFF is faster AND better for structured
        // extraction — force effThink to 0 so the whole budget is OUTPUT, and send
        // reasoning:{enabled:false} below instead of a token budget. EXCEPT when the
        // call site is a judgment pass (recognizer / dedup reviewer) and opts to keep
        // reasoning — those are graph-aware comparison passes where thinking earns its
        // keep, so no-think is scoped to the mechanical passes only.
        const noThink = reasoningDisabledForCall(modelName, options?.keepReasoning);
        // Thinking spill: some models IGNORE the reasoning budget (hy3 asked for 1024,
        // spent 4-7K) and reasoning bills inside max_tokens — so budget the SUM with
        // what the model was OBSERVED to spend (recorded below the moment usage is
        // read, so a truncated attempt teaches this very retry). Recomputed per
        // iteration, per model — an escalation may switch to a model with a very
        // different ceiling (Gemini 2.5 Flash 65535 vs GPT-4o 16384).
        // A model on the no-think list that IGNORES reasoning-off (observed at runtime) still
        // needs headroom — its reasoning bills inside max_tokens, so effThink=0 would starve
        // the output and truncate (the hy3 failure). Once detected, budget for it anyway; this
        // self-heals a stale no-think entry without a human editing the list.
        const effThink = (noThink && !modelIgnoresNoThink(modelName)) ? 0 : effectiveThinkBudget(modelName, thinkBudget);
        const outBudgetCeiling = Math.max(1024, modelOutputCeiling(modelName) - effThink);
        baseMaxOut = Math.min(requestedMaxOut, outBudgetCeiling);
        bumpedMaxOut = Math.min(Math.round(baseMaxOut * 1.5), outBudgetCeiling);
        const maxOut = truncBumped ? bumpedMaxOut : baseMaxOut;
        const sysContent = mechanism === "prompt_json"
          ? `${systemPrompt}\n\nReturn ONLY a valid JSON object matching this schema (no markdown fences, no prose):\n${JSON.stringify(schema)}`
          : systemPrompt;
        const callWith = (useTemp: boolean) => client.chat.completions.create({
          model: modelName,
          messages: [
            { role: "system", content: sysContent },
            { role: "user",   content: userInput },
          ],
          // Mechanism-specific structured-output enforcement (prompt_json sends neither):
          ...(mechanism === "response_format"
            ? { response_format: { type: "json_schema", json_schema: { name: "response", strict: false, schema } } }
            : {}),
          ...(mechanism === "tool_use"
            ? { tools: [{ type: "function", function: { name: "structured_result", description: "Return the result as arguments matching the schema.", parameters: schema } }],
                tool_choice: { type: "function", function: { name: "structured_result" } } }
            : {}),
          // effThink (not thinkBudget): protect the output space from observed spill.
          // reasoning.max_tokens keeps the REQUESTED budget — the intent is unchanged;
          // only the room the response gets to overflow into grows.
          max_tokens: maxOut + effThink,
          // No-think model → explicitly disable reasoning (faster + better structured
          // output). Otherwise pass the requested reasoning budget when one is set.
          ...(noThink
            ? { reasoning: { enabled: false } } as any
            : thinkBudget ? { reasoning: { max_tokens: thinkBudget } } as any : {}),
          ...(useTemp && Number.isFinite(temperature) ? { temperature } : {}),
        } as any, callTimeoutMs > 0 ? { timeout: callTimeoutMs } : undefined);
        try {
          let completion;
          try {
            completion = await callWith(true);
          } catch (te: any) {
            // Some reasoning models forbid a non-default temperature — drop it and retry once.
            if (Number.isFinite(temperature) && /temperat/i.test(String(te?.message ?? ""))) {
              console.warn(`[openai] ${modelName} rejected temperature=${temperature} — retrying without it`);
              completion = await callWith(false);
            } else { throw te; }
          }
          // Extract the JSON text per mechanism: tool-use returns it as the tool
          // call's arguments; response_format/prompt_json return it as content
          // (prompt_json may wrap it in markdown fences → strip them).
          const _msg = completion.choices[0].message as any;
          let text = mechanism === "tool_use"
            ? (_msg.tool_calls?.[0]?.function?.arguments ?? "")
            : (_msg.content ?? "");
          // Reasoning-field recovery (Ollama gemma-4, ollama#15288): the /v1 compat
          // endpoint returns EMPTY content with ALL generated text in message.reasoning
          // (no think:false passthrough). The answer exists — wrong field. Recover it
          // instead of failing the pass. Only fires when content is blank, so models
          // that legitimately fill both fields are untouched. The recovered payload may
          // prepend thinking prose before the JSON → carve from the first "{" when the
          // call expects a structured object.
          if (!String(text).trim()) {
            const r = String(_msg.reasoning ?? _msg.reasoning_content ?? "");
            if (r.trim()) {
              console.warn(`[openai] ${modelName} empty content but reasoning payload present — recovering answer from reasoning field (ollama gemma-4 /v1 quirk)`);
              let recovered = stripJsonFences(r).trim();
              const brace = recovered.indexOf("{");
              if (brace > 0) recovered = recovered.slice(brace, recovered.lastIndexOf("}") + 1);
              text = recovered;
            }
          }
          if (mechanism === "prompt_json") text = stripJsonFences(text);
          text = text.trim();
          const usage = completion.usage as any;
          const thinkingTokens = usage?.completion_tokens_details?.reasoning_tokens ?? 0;
          // Record spill NOW — before any parse/empty throw below — so even a truncated
          // response teaches the retry how much this model really thinks.
          recordObservedThinking(modelName, thinkingTokens);
          // Did this model honor the no-think request? If we sent reasoning-off but it reasoned
          // anyway, mark it non-compliant so the NEXT call reserves headroom for it (self-heals a
          // stale no-think entry). Recorded from truncated attempts too — they report reasoning.
          recordNoThinkCompliance(modelName, noThink, thinkingTokens);
          // OpenAI/OpenRouter `completion_tokens` is INCLUSIVE of reasoning_tokens.
          // Split it so output + thinking sums back to completion_tokens exactly —
          // otherwise the reasoning portion is billed twice in computeCost (once
          // inside output, once as thinking). (Telemetry over-count fix 2026-05-25,
          // caught by the §7 dashboard reconciliation: telemetry ~1.5x the bill.)
          const completionTokens = usage?.completion_tokens ?? 0;
          const outputTokens = Math.max(0, completionTokens - thinkingTokens);

          // EMPTY/HUNG-response guard (BEFORE JSON.parse): the model returned no
          // content at all. JSON.parse("") would throw a SyntaxError the catch
          // can't tell apart from a genuine mid-structure truncation, so detect
          // it here and raise a DISTINCT error — the catch treats empty as a
          // transient hang (retry/escalate), not as truncation (same-model bump).
          // See EmptyResponseError + classifyGenError in ./failure-policy.
          if (isEmptyResult(text)) {
            if (process.env.NODEDEX_DEBUG_TRUNCATION === "1") {
              const fin = (completion.choices?.[0] as any)?.finish_reason;
              console.warn(`[trunc-debug] ${modelName} EMPTY: completion_tokens=${completionTokens}, reasoning=${thinkingTokens}, finish=${fin}`);
            }
            throw new EmptyResponseError(modelName);
          }

          // finish_reason='length' with a NON-empty, parseable body: the model hit
          // max_tokens but still emitted VALID JSON — cut at a group/array boundary →
          // valid-but-PARTIAL, silently dropping content. classifyGenError can't see this
          // (JSON.parse below would succeed), so raise it explicitly → the truncated policy
          // bumps max_tokens on the SAME model for the full result. (Empty + length is
          // handled above: no output to grow → escalate to a different model, not bump.)
          const finishReason = (completion.choices?.[0] as any)?.finish_reason;
          if (finishReason === "length") {
            throw new TruncatedResponseError(modelName);
          }

          // Parse BEFORE pushing the ok attempt — a truncation-induced SyntaxError must
          // not be preceded by a phantom "ok" in the attempts trail.
          // DIAGNOSTIC (NODEDEX_DEBUG_TRUNCATION=1): on a parse failure, dump the
          // token split + the tail of the unparseable text so a runaway's repetition
          // pattern is visible (which array/field looped). Off by default.
          let result: T;
          try {
            result = JSON.parse(text) as T;
          } catch (pe) {
            if (process.env.NODEDEX_DEBUG_TRUNCATION === "1") {
              const fin = (completion.choices?.[0] as any)?.finish_reason;
              console.warn(
                `[trunc-debug] ${modelName} PARSE-FAIL: text=${text.length} chars, finish=${fin}, ` +
                `completion_tokens=${completionTokens}, reasoning=${thinkingTokens}, output=${outputTokens}\n` +
                `[trunc-debug] TAIL:\n${text.slice(-900)}`,
              );
            }
            throw pe;
          }

          if (isFallback) console.log(`[openai] escalated to fallback model ${modelName}`);
          if (truncBumped) console.log(`[openai] ${modelName} succeeded after truncation bump (max_tokens ${baseMaxOut} → ${bumpedMaxOut})`);
          if (thinkBudget) console.log(`[openai] thinking: requested=${thinkBudget} actual=${thinkingTokens}`);
          attempts.push({ model: modelName, outcome: "ok" });
          // Actual billed cost from OpenRouter (usage.cost), when present — the
          // real number, preferred over the static-table estimate downstream.
          const actualCost = typeof usage?.cost === "number" ? usage.cost : undefined;
          return {
            result,
            rateLimited: false,
            usage: { input: usage?.prompt_tokens ?? 0, thinking: thinkingTokens, output: outputTokens, costUsd: actualCost },
            model: modelName,
            attempts,
          };
        } catch (e: any) {
          // Out-of-credit (402) — surface it DEFINITIVELY rather than wasting the
          // prompt-JSON mechanism retry + escalation (every model on an unfunded account
          // 402s identically) and then swallowing it into a generic null the reflect queue
          // can't tell from a real comprehend failure (→ retried 3x then DROPPED the turn).
          // creditExhausted lets the queue pause-the-spend + requeue instead of dropping.
          if (isInsufficientCreditError(e)) {
            attempts.push({ model: modelName, outcome: "error" });
            console.error(`[openai] ${modelName} insufficient credit (status=${e?.status ?? "?"}) — credit exhausted; not retrying/escalating (account unfunded)`);
            return { result: null, rateLimited: false, creditExhausted: true, model: modelName, attempts };
          }
          // Bad/revoked KEY (401) — surface DEFINITIVELY so the orchestrator fails over to the
          // fallback KEY (a different model on the same broken key would 401 identically). Checked
          // here alongside credit, and only AFTER it, so a spend-cap 402/403 stays billing (isAuthError
          // short-circuits on a credit error anyway).
          if (isAuthError(e)) {
            attempts.push({ model: modelName, outcome: "error" });
            console.error(`[openai] ${modelName} auth rejected (status=${e?.status ?? "?"}) — key invalid; signalling key-failover`);
            return { result: null, rateLimited: false, authFailed: true, model: modelName, attempts };
          }
          const kind = classifyGenError(e);
          const rateLimited = kind === "rate_limited";

          // EMPTY or TIMEOUT — neither is truncation (no partial output → never a
          // max_tokens bump, and switching models is SAFE: no determinism trap). Shared
          // policy (./failure-policy decideEmptyOrTimeoutAction): escalate to a fallback
          // model FIRST when one exists (a different model is the likeliest recovery for
          // an input-specific empty, and skips the slow same-model draw); only a single-
          // key setup with no fallback retries the SAME model once (its one recovery).
          if (kind === "empty" || kind === "timeout") {
            const action = decideEmptyOrTimeoutAction({ kind, hasNextModel: i + 1 < modelsToTry.length, emptyRetried });
            attempts.push({ model: modelName, outcome: kind === "timeout" ? "timeout" : "empty" });
            if (action === "escalate") {
              console.warn(`[openai] ${modelName} ${kind === "timeout" ? "timed out" : "returned EMPTY/hung response"} — escalating to fallback ${modelsToTry[i + 1]}`);
              break; // exit inner while; outer for tries the next model
            }
            if (action === "retry_same") {
              console.warn(`[openai] ${modelName} returned EMPTY/hung response — no fallback; retrying same model once`);
              emptyRetried = true;
              continue; // retry same model (same mechanism, same budget)
            }
            console.error(`[openai] ${modelName} ${kind === "timeout" ? "timed out" : "EMPTY/hung"} — no recovery left, failing pass`);
            return { result: null, rateLimited: false, model: modelName, attempts };
          }

          if (kind === "truncated" && !truncBumped) {
            // Same-model retry with bumped max_tokens — preserves determinism.
            attempts.push({ model: modelName, outcome: "truncated" });
            console.warn(`[openai] ${modelName} truncated at max_tokens=${baseMaxOut} — retrying SAME model with bumped max_tokens=${bumpedMaxOut}`);
            truncBumped = true;
            continue; // retry same model
          }

          // Hard provider error (e.g. 400 — the model rejects this structured-output
          // mechanism/schema, like Anthropic on a complex response_format schema) →
          // one-time fallback to the UNIVERSAL prompt-JSON mechanism on the SAME model
          // before giving up. This is what makes the pipeline model-portable: no model
          // ever empties the graph just because it doesn't speak response_format/tool-use.
          if (kind === "mechanism_or_other" && mechanism !== "prompt_json") {
            attempts.push({ model: modelName, outcome: "error" });
            console.warn(`[openai] ${modelName} ${mechanism} failed (status=${e?.status}) — falling back to prompt-JSON mechanism on same model`);
            mechanism = "prompt_json";
            truncBumped = false;
            continue; // retry same model with the universal prompt-JSON mechanism
          }

          attempts.push({ model: modelName, outcome: kind === "truncated" ? "truncated" : rateLimited ? "rate_limited" : "error" });
          if (kind === "truncated") console.error(`[openai] ${modelName} truncated AGAIN after bump — failing pass (truncation does NOT escalate to fallback model; that would silently change classification semantics)`);
          else if (!rateLimited) console.error(`[openai] generateStructured error (${modelName}): status=${e?.status} msg=${String(e?.message ?? e).slice(0, 200)}`);

          // Only rate-limit escalates to fallback model (empty/timeout handled above).
          if (rateLimited && !isFallback && this.fallbackModel) {
            console.log(`[openai] 429 on ${modelName} — escalating to fallback ${this.fallbackModel}`);
            break; // exit inner while; outer for tries the next model
          }
          if (rateLimited && isFallback) return { result: null, rateLimited: true, model: modelName, attempts };
          return { result: null, rateLimited, model: modelName, attempts };
        }
      }
    }
    return { result: null, rateLimited: true, attempts };
  }

  async generate(prompt: string): Promise<string | null> {
    if (!this.client) return null;
    try {
      const completion = await this.client.chat.completions.create({
        model: this.model,
        messages: [{ role: "user", content: prompt }],
      });
      const msg = completion.choices[0].message as any;
      const content = msg.content ?? "";
      if (String(content).trim()) return content;
      // Same reasoning-field recovery as generateStructured (ollama gemma-4 /v1 quirk).
      const r = String(msg.reasoning ?? msg.reasoning_content ?? "");
      return r.trim() ? r : null;
    } catch {
      return null;
    }
  }

  async ping(): Promise<boolean> {
    return (await this.generate("Say OK")) !== null;
  }
}

export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  private client: OpenAI | null;
  private readonly embModel = process.env.NODEDEX_EMBEDDING_MODEL ?? "text-embedding-3-small";

  constructor(apiKey: string, baseURL?: string) {
    this.client = apiKey
      ? new OpenAI({ apiKey, ...(baseURL ? { baseURL } : {}) })
      : null;
  }

  isAvailable(): boolean { return this.client !== null; }

  async embed(text: string): Promise<number[] | null> {
    if (!this.client) return null;
    try {
      const response = await this.client.embeddings.create({ model: this.embModel, input: text });
      return response.data[0]?.embedding ?? null;
    } catch {
      return null;
    }
  }
}
