// ─────────────────────────────────────────────────────────────────────────────
// Vector math — the single cosine-similarity implementation.
//
// Consolidated 2026-06-14 from SEVEN divergent copies (context, pass4-slice,
// retrieve-graph-slice, stage-audit-graph, recall, database, tools/helpers) that
// computed the same value but carried different degenerate-input guards. This is
// the UNION of those guards. Pure / side-effect-free.
// ─────────────────────────────────────────────────────────────────────────────

/** Cosine similarity of two equal-length numeric vectors. Returns 0 on any
 *  degenerate input: null/undefined, empty, length mismatch, or a zero-magnitude
 *  vector. */
export function cosineSim(a: number[], b: number[]): number {
  if (!a || !b || a.length === 0 || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
