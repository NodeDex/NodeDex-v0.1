import { GoogleGenerativeAI } from "@google/generative-ai";
import type { LLMProvider, EmbeddingProvider, GenerateResult } from "../ai-provider.js";
import { EmptyResponseError, classifyGenError, isEmptyResult, withTimeout, llmTimeoutMs, decideEmptyOrTimeoutAction, isInsufficientCreditError } from "./failure-policy.js";

// Default + fallback model resolved LIVE from env per call. A const frozen at
// MODULE LOAD would ignore a web-UI / config-endpoint model change until a full
// restart (resetProviders can't refresh a module-level const) — so these are
// functions read at call time.
function primaryModel(): string {
  return process.env.AI_MODEL ?? process.env.NODEDEX_PRIMARY_MODEL ?? "gemini-2.5-flash";
}
function fallbackModel(): string {
  return process.env.NODEDEX_FALLBACK_MODEL ?? "gemini-2.5-pro";
}

// Failure handling (timeout bound, empty-detection, failure classification) is now
// shared across all providers — see ./failure-policy.ts. The 180s call bound
// (debt-4 Stage A) lives there as llmTimeoutMs() / withTimeout().

export class GeminiProvider implements LLMProvider {
  private genAI: GoogleGenerativeAI | null;

  constructor(apiKey: string) {
    this.genAI = apiKey ? new GoogleGenerativeAI(apiKey) : null;
  }

  isAvailable(): boolean { return this.genAI !== null; }
  getName(): string { return "gemini"; }

  async generateStructured<T>(
    systemPrompt: string,
    userInput: string,
    schema: object,
    options?: { thinkingBudget?: number; maxOutputTokens?: number; modelOverride?: string }
  ): Promise<GenerateResult<T>> {
    if (!this.genAI) return { result: null, rateLimited: false };

    const primary = primaryModel(), fallback = fallbackModel();
    const modelsToTry = options?.modelOverride
      ? [options.modelOverride]
      : primary === fallback ? [primary] : [primary, fallback];

    const attempts: NonNullable<GenerateResult<T>["attempts"]> = [];
    for (let i = 0; i < modelsToTry.length; i++) {
      const modelName = modelsToTry[i];
      const isFallback = i > 0;
      // gemini-2.5-pro requires non-zero thinking budget
      const budget = isFallback
        ? Math.max(512, options?.thinkingBudget ?? 0)
        : (options?.thinkingBudget ?? 0);

      const genConfig: any = {
        thinkingConfig: { thinkingBudget: budget },
        responseMimeType: "application/json",
        responseSchema: schema,
      };
      if (options?.maxOutputTokens) genConfig.maxOutputTokens = options.maxOutputTokens;
      // Deterministic extraction → default temperature 0 (cuts run-to-run variance).
      // Gemini thinking models accept temperature. Configurable via NODEDEX_REFLECT_TEMPERATURE.
      {
        const tEnv = process.env.NODEDEX_REFLECT_TEMPERATURE;
        genConfig.temperature = tEnv !== undefined && tEnv !== "" && Number.isFinite(Number(tEnv)) ? Number(tEnv) : 0;
      }

      const model = this.genAI.getGenerativeModel({
        model: modelName,
        systemInstruction: systemPrompt,
        generationConfig: genConfig,
      });

      let emptyRetried = false;
      while (true) {
       try {
        const response = await withTimeout(
          model.generateContent(userInput),
          llmTimeoutMs(),
          `generateStructured(${modelName})`,
        );
        const usageMeta: any = (response.response as any).usageMetadata ?? {};

        // Extract non-thinking output parts (pass3 reads thinking separately)
        const parts: any[] = response.response.candidates?.[0]?.content?.parts ?? [];
        const rawText = (parts.length > 0
          ? parts.filter((p: any) => !p.thought).map((p: any) => p.text ?? "").join("")
          : response.response.text()
        ).trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();

        const thinking = parts
          .filter((p: any) => p.thought === true)
          .map((p: any) => p.text ?? "")
          .join("\n")
          .trim();

        // EMPTY/HUNG guard BEFORE JSON.parse — a distinct failure (see ./failure-policy):
        // JSON.parse("") would look like truncation; raise it explicitly so the catch
        // retries/escalates instead of mislabeling it.
        if (isEmptyResult(rawText)) throw new EmptyResponseError(modelName);

        const result = JSON.parse(rawText) as T;
        attempts.push({ model: modelName, outcome: "ok" });
        return {
          result,
          rateLimited: false,
          thinking,
          usage: {
            input:   usageMeta.promptTokenCount     ?? 0,
            thinking: usageMeta.thoughtsTokenCount  ?? 0,
            output:  usageMeta.candidatesTokenCount ?? 0,
          },
          model: modelName,
          attempts,
        };
       } catch (e: any) {
        // Out-of-credit (402) — surface DEFINITIVELY (see openai.ts): the reflect queue
        // pauses-the-spend + requeues instead of swallowing it into a generic null.
        if (isInsufficientCreditError(e)) {
          attempts.push({ model: modelName, outcome: "error" });
          console.error(`[gemini] ${modelName} insufficient credit (status=${e?.status ?? "?"}) — credit exhausted; not retrying/escalating (account unfunded)`);
          return { result: null, rateLimited: false, creditExhausted: true, model: modelName, attempts };
        }
        const kind = classifyGenError(e);
        const rateLimited = kind === "rate_limited";
        const hasNextModel = i + 1 < modelsToTry.length;

        // EMPTY/TIMEOUT → shared escalate-first policy (./failure-policy): a fallback
        // model is the likeliest recovery for an input-specific empty (and skips the slow
        // same-model draw); only a single-key setup retries the SAME model once.
        if (kind === "empty" || kind === "timeout") {
          const action = decideEmptyOrTimeoutAction({ kind, hasNextModel, emptyRetried });
          attempts.push({ model: modelName, outcome: kind === "timeout" ? "timeout" : "empty" });
          if (action === "escalate") {
            console.warn(`[gemini] ${modelName} ${kind} — escalating to fallback`);
            break; // exit while; outer for tries the next model
          }
          if (action === "retry_same") {
            console.warn(`[gemini] ${modelName} returned EMPTY/hung response — no fallback; retrying same model once`);
            emptyRetried = true;
            continue; // retry same model
          }
          if (kind === "timeout") {
            console.error(`[gemini] generateStructured TIMEOUT (${modelName}): ${llmTimeoutMs()}ms — pipeline continues, request may still be running at provider`);
          }
          return { result: null, rateLimited: false, model: modelName, attempts };
        }

        // RATE-LIMIT / TRUNCATED → escalate to the next model if one remains, else degrade.
        // (Truncation→fallback preserves gemini's long-standing behavior; openai's stricter
        // same-model-only truncation policy is left provider-specific to keep this tight.)
        attempts.push({ model: modelName, outcome:
          kind === "truncated" ? "truncated" :
          rateLimited          ? "rate_limited" : "error" });
        if ((kind === "truncated" || rateLimited) && hasNextModel) {
          console.warn(`[gemini] ${modelName} ${kind} — escalating to fallback`);
          break; // exit while; outer for tries the next model
        }
        if (!rateLimited) {
          console.error(`[gemini] generateStructured error (${modelName}): ${String(e?.message ?? e).slice(0, 300)}`);
        }
        return { result: null, rateLimited, model: modelName, attempts };
       }
      }
    }
    return { result: null, rateLimited: true, attempts };
  }

  async generate(prompt: string): Promise<string | null> {
    if (!this.genAI) return null;
    try {
      const primary = primaryModel();
      const model = this.genAI.getGenerativeModel({ model: primary });
      const result = await withTimeout(
        model.generateContent(prompt),
        llmTimeoutMs(),
        `generate(${primary})`,
      );
      return result.response.text().trim();
    } catch {
      return null;
    }
  }

  async ping(): Promise<boolean> {
    return (await this.generate("Say OK")) !== null;
  }
}

export class GeminiEmbeddingProvider implements EmbeddingProvider {
  private genAI: GoogleGenerativeAI | null;
  private readonly embModel = process.env.NODEDEX_EMBEDDING_MODEL ?? "gemini-embedding-001";

  constructor(apiKey: string) {
    this.genAI = apiKey ? new GoogleGenerativeAI(apiKey) : null;
  }

  isAvailable(): boolean { return this.genAI !== null; }

  async embed(text: string): Promise<number[] | null> {
    if (!this.genAI) return null;
    try {
      const model = this.genAI.getGenerativeModel({ model: this.embModel });
      // Provider-level timeout: belt-and-suspenders with EmbeddingEngine.embed
      // wrapper (which also times out at 30s + records stats). This catches
      // direct provider calls if they ever happen without the engine.
      const result = await withTimeout(
        model.embedContent(text),
        30_000,
        `embed(${this.embModel})`,
      );
      return result.embedding.values;
    } catch {
      return null;
    }
  }
}
