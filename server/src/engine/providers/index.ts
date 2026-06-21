import type { LLMProvider, EmbeddingProvider } from "../ai-provider.js";
import { GeminiProvider, GeminiEmbeddingProvider } from "./gemini.js";
import { OpenAIProvider, OpenAIEmbeddingProvider } from "./openai.js";
import { AnthropicProvider } from "./anthropic.js";
import { LocalEmbeddingProvider } from "./local.js";
import { wrapWithUsageLedger } from "./usage-ledger.js";

let _llm: LLMProvider | null = null;
let _embeddings: EmbeddingProvider | null = null;

/** Returns the singleton LLM provider (lazy-initialized from env vars). */
export function getLLMProvider(): LLMProvider {
  if (_llm) return _llm;

  const name = (process.env.AI_PROVIDER ?? "gemini").toLowerCase();

  if (name === "openai" || name === "openai-compatible") {
    _llm = new OpenAIProvider(
      process.env.OPENAI_API_KEY ?? "",
      process.env.OPENAI_BASE_URL
    );
  } else if (name === "anthropic") {
    _llm = new AnthropicProvider(process.env.ANTHROPIC_API_KEY ?? "");
  } else {
    _llm = new GeminiProvider(process.env.GEMINI_API_KEY ?? "");
  }

  // Meter every structured key call at the single seam — wrap once so the cached
  // provider (and all callers) route generateStructured() through the usage ledger.
  _llm = wrapWithUsageLedger(_llm);
  return _llm;
}

/** Returns the singleton embedding provider (lazy-initialized from env vars). */
export function getEmbeddingProvider(): EmbeddingProvider {
  if (_embeddings) return _embeddings;

  // Embeddings default to LOCAL (bundled bge-small, offline, $0, no key) when
  // EMBEDDING_PROVIDER is unset — the shipped release default. A fresh install gets
  // working semantic search with zero setup; set EMBEDDING_PROVIDER=gemini|openai|
  // anthropic for hosted embeddings. (Decoupled from AI_PROVIDER on purpose: a chat
  // model like owl/openai-compatible is a poor embedder.)
  const embName = (process.env.EMBEDDING_PROVIDER ?? "local").toLowerCase();

  if (embName === "local") {
    // Local, free, offline embeddings (transformers.js) — no API/quota.
    _embeddings = new LocalEmbeddingProvider();
  } else if (embName === "openai" || embName === "openai-compatible") {
    _embeddings = new OpenAIEmbeddingProvider(
      process.env.OPENAI_API_KEY ?? "",
      process.env.OPENAI_BASE_URL
    );
  } else if (embName === "anthropic") {
    // Anthropic has no embeddings API — cascade to Gemini, then OpenAI
    if (process.env.GEMINI_API_KEY) {
      _embeddings = new GeminiEmbeddingProvider(process.env.GEMINI_API_KEY);
    } else if (process.env.OPENAI_API_KEY) {
      _embeddings = new OpenAIEmbeddingProvider(process.env.OPENAI_API_KEY);
    } else {
      _embeddings = { embed: async () => null, isAvailable: () => false };
    }
  } else {
    // gemini (default)
    _embeddings = new GeminiEmbeddingProvider(process.env.GEMINI_API_KEY ?? "");
  }

  return _embeddings;
}

/** Reset singletons — used in tests after env var changes. */
export function resetProviders(): void {
  _llm = null;
  _embeddings = null;
}
