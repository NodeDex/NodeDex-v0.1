// model-caps.ts — per-model hard OUTPUT-token ceiling.
//
// WHY: the provider request is `maxOutputTokens + thinkingBudget`, and that SUM must
// stay under the MODEL's hard output limit or the provider returns a broken/empty
// response that masquerades as a truncation but can't be recovered (2026-06-16 Pass 3
// glitch). A single hardcoded ceiling broke model-portability — e.g. Pass 3 (32768)
// over-requests on GPT-4o (16384). So the ceiling is PER MODEL.
//
// Source of truth, in order:
//   1. NODEDEX_MODEL_CAPS override — JSON map the web-UI model picker populates from the
//      provider's live /models data (OpenRouter exposes top_provider.max_completion_tokens).
//   2. KNOWN_CAPS — the configured/common models, so the pipeline is correct with no
//      network dependency in the hot path.
//   3. DEFAULT_CEILING — conservative fallback for a genuinely unknown model.

// Verified against OpenRouter /models (2026-06-16). Keyed by both prefixed id and bare
// AI_MODEL form (AI_MODEL may or may not carry the vendor prefix).
const KNOWN_CAPS: Record<string, number> = {
  "google/gemini-2.5-flash": 65535,
  "google/gemini-2.5-pro":   65535,
  "gemini-2.5-flash":        65535,
  "gemini-2.5-pro":          65535,
  "openai/gpt-4o":           16384,
  "openai/gpt-4o-mini":      16384,
  "gpt-4o":                  16384,
  "gpt-4o-mini":             16384,
  "anthropic/claude-3.5-sonnet": 8192,
  "anthropic/claude-3.7-sonnet": 64000,
};

// Most pipeline-capable models allow at least this; low enough to avoid an over-request
// glitch on a smaller unknown model (the truncation bump then earns its room up to here).
const DEFAULT_CEILING = 16384;

function overrides(): Record<string, number> {
  try {
    const o = JSON.parse(process.env.NODEDEX_MODEL_CAPS ?? "{}");
    return o && typeof o === "object" ? o : {};
  } catch { return {}; }
}

/** Hard output-token ceiling for `model`. Override → known map → conservative default. */
export function modelOutputCeiling(model: string | undefined): number {
  if (!model) return DEFAULT_CEILING;
  const cap = overrides()[model] ?? KNOWN_CAPS[model];
  return typeof cap === "number" && cap > 0 ? cap : DEFAULT_CEILING;
}

export { KNOWN_CAPS, DEFAULT_CEILING };
