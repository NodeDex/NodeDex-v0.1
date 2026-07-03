import OpenAI from "openai";
import type { LLMProvider, EmbeddingProvider, GenerateResult } from "../ai-provider.js";
import { EmptyResponseError, classifyGenError, isEmptyResult, llmTimeoutMs, decideEmptyOrTimeoutAction, isInsufficientCreditError } from "./failure-policy.js";
import { modelOutputCeiling } from "./model-caps.js";
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

  isAvailable(): boolean { return this.client !== null; }
  getName(): string { return process.env.OPENAI_BASE_URL ? "openai-compatible" : "openai"; }

  async generateStructured<T>(
    systemPrompt: string,
    userInput: string,
    schema: object,
    options?: { thinkingBudget?: number; maxOutputTokens?: number; modelOverride?: string }
  ): Promise<GenerateResult<T>> {
    if (!this.client) return { result: null, rateLimited: false };
    const modelsToTry = options?.modelOverride
      ? [options.modelOverride]
      : this.fallbackModel ? [this.model, this.fallbackModel] : [this.model];

    const client = this.client; // narrowed non-null (guarded above) — safe inside closures
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
      // Per-model output ceiling — an escalation may switch models with very different
      // caps (Gemini 2.5 Flash 65535 vs GPT-4o 16384), so recompute for THIS model.
      const outBudgetCeiling = modelOutputCeiling(modelName) - (thinkBudget ?? 0);
      const baseMaxOut = Math.min(requestedMaxOut, outBudgetCeiling);
      const bumpedMaxOut = Math.min(Math.round(baseMaxOut * 1.5), outBudgetCeiling);
      let truncBumped = false;
      let emptyRetried = false;
      // Structured-output mechanism for this model: native by provider, switched
      // to the universal prompt-JSON floor on a hard provider error (below).
      let mechanism: SoMechanism = primaryMechanism(modelName);

      // Inner loop: original + one truncation bump + (on hard error) a one-time
      // prompt-JSON fallback retry.
      while (true) {
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
          max_tokens: maxOut + (thinkBudget ?? 0),
          ...(thinkBudget ? { reasoning: { max_tokens: thinkBudget } } as any : {}),
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
