import Anthropic from "@anthropic-ai/sdk";
import type { LLMProvider, GenerateResult } from "../ai-provider.js";
import { EmptyResponseError, classifyGenError, llmTimeoutMs, decideEmptyOrTimeoutAction, isInsufficientCreditError } from "./failure-policy.js";

export class AnthropicProvider implements LLMProvider {
  private client: Anthropic | null;
  private model: string;
  private fallbackModel: string | null;

  constructor(apiKey: string) {
    this.client = apiKey ? new Anthropic({ apiKey }) : null;
    this.model = process.env.AI_MODEL ?? "claude-opus-4-6";
    const fb = process.env.NODEDEX_FALLBACK_MODEL ?? "";
    this.fallbackModel = fb && fb !== this.model ? fb : null;
  }

  isAvailable(): boolean { return this.client !== null; }
  getName(): string { return "anthropic"; }

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

    const attempts: NonNullable<GenerateResult<T>["attempts"]> = [];
    for (let i = 0; i < modelsToTry.length; i++) {
      const modelName = modelsToTry[i];
      const isFallback = i > 0;
      let emptyRetried = false;
      while (true) {
       try {
        const response = await this.client.messages.create({
          model: modelName,
          max_tokens: options?.maxOutputTokens ?? 8192,
          system: systemPrompt,
          messages: [{ role: "user", content: userInput }],
          tools: [{
            name: "save_result",
            description: "Save the structured extraction result",
            input_schema: schema as Anthropic.Tool["input_schema"],
          }],
          tool_choice: { type: "tool", name: "save_result" },
        }, { timeout: llmTimeoutMs() });
        const toolUse = response.content.find(
          (c): c is Anthropic.ToolUseBlock => c.type === "tool_use"
        );
        // No tool_use block = the model produced no structured content = EMPTY/hung
        // (see ./failure-policy). Raise it so the catch retries/escalates rather than
        // failing the pass outright (the old behavior — no retry, no fallback).
        if (!toolUse) throw new EmptyResponseError(modelName);

        if (isFallback) console.log(`[anthropic] escalated to fallback model ${modelName}`);
        attempts.push({ model: modelName, outcome: "ok" });
        return {
          result: toolUse.input as T,
          rateLimited: false,
          usage: { input: response.usage.input_tokens, thinking: 0, output: response.usage.output_tokens },
          model: modelName,
          attempts,
        };
       } catch (e: any) {
        // Out-of-credit (402) — surface DEFINITIVELY (see openai.ts): the reflect queue
        // pauses-the-spend + requeues instead of swallowing it into a generic null.
        if (isInsufficientCreditError(e)) {
          attempts.push({ model: modelName, outcome: "error" });
          console.error(`[anthropic] ${modelName} insufficient credit (status=${e?.status ?? "?"}) — credit exhausted; not retrying/escalating (account unfunded)`);
          return { result: null, rateLimited: false, creditExhausted: true, model: modelName, attempts };
        }
        const kind = classifyGenError(e);
        const rateLimited = kind === "rate_limited";
        const hasNextModel = i + 1 < modelsToTry.length;

        // EMPTY/TIMEOUT → shared escalate-first policy (./failure-policy): a fallback model
        // is the likeliest recovery for an input-specific empty (and skips the slow same-
        // model draw); only a single-key setup retries the SAME model once.
        if (kind === "empty" || kind === "timeout") {
          const action = decideEmptyOrTimeoutAction({ kind, hasNextModel, emptyRetried });
          attempts.push({ model: modelName, outcome: kind === "timeout" ? "timeout" : "empty" });
          if (action === "escalate") {
            console.log(`[anthropic] ${modelName} ${kind} — escalating to fallback ${modelsToTry[i + 1]}`);
            break; // exit while; outer for tries the next model
          }
          if (action === "retry_same") {
            console.warn(`[anthropic] ${modelName} returned no structured content — no fallback; retrying same model once`);
            emptyRetried = true;
            continue; // retry same model
          }
          if (kind === "timeout") {
            console.error(`[anthropic] generateStructured TIMEOUT (${modelName}): ${llmTimeoutMs()}ms — pipeline continues`);
          }
          return { result: null, rateLimited: false, model: modelName, attempts };
        }

        // RATE-LIMIT / other → escalate to the next model if one remains, else degrade.
        // (No same-model bump: anthropic returns structured tool input directly, not
        // parsed JSON, so there is no truncation-retry rung.)
        attempts.push({ model: modelName, outcome: rateLimited ? "rate_limited" : "error" });
        if (rateLimited && hasNextModel) {
          console.log(`[anthropic] ${modelName} rate-limited — escalating to fallback ${modelsToTry[i + 1]}`);
          break; // exit while; outer for tries the next model
        }
        if (!rateLimited) {
          console.error(`[anthropic] generateStructured error (${modelName}): status=${e?.status} msg=${String(e?.message ?? e).slice(0, 200)}`);
        }
        return { result: null, rateLimited, model: modelName, attempts };
       }
      }
    }
    return { result: null, rateLimited: true, attempts };
  }

  async generate(prompt: string): Promise<string | null> {
    if (!this.client) return null;
    try {
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: 2048,
        messages: [{ role: "user", content: prompt }],
      });
      const textBlock = response.content.find(
        (c): c is Anthropic.TextBlock => c.type === "text"
      );
      return textBlock?.text ?? null;
    } catch {
      return null;
    }
  }

  async ping(): Promise<boolean> {
    return (await this.generate("Say OK")) !== null;
  }
}
