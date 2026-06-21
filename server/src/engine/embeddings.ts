import { getEmbeddingProvider } from "./providers/index.js";
import { withTimeout } from "./providers/failure-policy.js";
import type { EmbeddingProvider } from "./ai-provider.js";
import { embeddingStats } from "../middleware/reflect/context.js";

// debt-4 Stage A — bound embedding calls so a hung provider can't stall the
// pipeline indefinitely. 30s is generous (typical embed call 100-500ms);
// caps the worst case without rejecting healthy calls. Promise.race based —
// the underlying request continues in background on timeout but the pipeline
// unblocks. A future SDK-level AbortController would also CANCEL the request,
// but Promise.race is enough for the bounded-time goal here.
const EMBEDDING_TIMEOUT_MS = 30_000;

/**
 * Canonical text for a STORED block's embedding vector (Tier 2 cleanup, 2026-06-15).
 *
 * ONE recipe so every stored vector is built the same way. Vectors compared
 * stored-vs-stored (semantic dedup, Stage-D resolve, Pass-4 semantic-delta) MUST
 * share a recipe or the cosine is noise — before this, ~5 call sites embedded the
 * same population of blocks with different recipes (essence+concepts vs
 * label+essence+concepts vs label+essence+type+unique vs a neighbor-context header).
 *
 * Recipe = essence + concepts — pure semantic CONTENT. The essence carries the
 * meaning, concepts the named entities. Deliberately EXCLUDES:
 *   - label  — a slug whose project prefix repeats across the project → would cluster
 *              by project, not meaning.
 *   - type   — a category word → would cluster by category, not content.
 *   - unique{} — identity is confirmed DOWNSTREAM by the structured unique{} compare;
 *              the embedding is the recall net, not the identity key.
 * `concepts` is read from the first-class blocks.concepts column (authoritative since
 * the 2026 migration out of content JSON), tolerating both the array form (pre-save
 * pass output) and the JSON-string form (a stored block).
 *
 * Query embeds (user message, search query, in-pass dedup) stay free-form — vs a
 * query, heterogeneity is inherent to semantic search. This canonicalizes the STORED
 * side only.
 */
export function blockEmbeddingText(input: {
  essence?: string | null;
  concepts?: string[] | string | null;
}): string {
  let concepts: string[] = [];
  if (Array.isArray(input.concepts)) {
    concepts = input.concepts;
  } else if (typeof input.concepts === "string") {
    try { concepts = JSON.parse(input.concepts || "[]"); } catch { concepts = []; }
  }
  return [input.essence, ...concepts].filter(Boolean).join(" ");
}

// ─── Embedding Engine ─────────────────────────────────────────────────────────
export class EmbeddingEngine {
  private provider: EmbeddingProvider;

  constructor() {
    this.provider = getEmbeddingProvider();
  }

  isAvailable(): boolean {
    return this.provider.isAvailable();
  }

  /**
   * Embed a single text. Instrumented per debt-4 Stage A:
   *   - records wall-time + call count + input chars to embeddingStats
   *     so the turn-log can surface the previously-hidden embedding tax
   *   - bounds wall-time with EMBEDDING_TIMEOUT_MS so provider hangs
   *     don't stall the pipeline
   *
   * On timeout: returns null (matches existing error semantics — most call
   * sites already do .catch(() => null) since embeddings are non-critical).
   */
  async embed(text: string): Promise<number[] | null> {
    const t0 = Date.now();
    embeddingStats.calls++;
    embeddingStats.input_chars += (text ?? "").length;
    try {
      return await withTimeout(this.provider.embed(text), EMBEDDING_TIMEOUT_MS, "embed");
    } catch {
      return null;
    } finally {
      embeddingStats.ms_total += Date.now() - t0;
    }
  }

  /** Embed a STORED block through the canonical recipe (essence + concepts).
   *  `concepts` accepts the first-class column's JSON-string form or an array. */
  async embedForBlock(block: {
    essence: string;
    concepts?: string[] | string | null;
  }): Promise<number[] | null> {
    return this.embed(blockEmbeddingText({ essence: block.essence, concepts: block.concepts }));
  }
}
