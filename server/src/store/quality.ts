// store/quality.ts — shared block-quality scoring.
// Extracted from routes/blocks.ts (2026-05-28) so the reflect pipeline can
// stamp quality_score at block creation, not just the UI/manual POST paths.
// See [[project-read-side-audit-scale]] Bug 1: leaving quality_score=0 on
// pipeline-created blocks made `recall-fast?types=project` return zero hits,
// because recall.ts unconditionally rejected q=0 — a semantic overload of
// "junk" with "structurally-empty container."

import type { WorkspaceDB } from "./database.js";

/**
 * Structural thinness score for a block: 1..5.
 * Higher = better-formed (more fields filled, more concepts, project bonus).
 * NOT a worth/importance signal — worth is earned via access+recency
 * ([[feedback-quality-not-worth.md]]); this is just "how much of the schema
 * did the producer fill in".
 */
export function computeQualityScore(
  block: { type: string; id: string; content?: unknown },
  concepts: string[],
): number {
  let score = 1;
  const content = (() => {
    try {
      return typeof (block as any).content === "string"
        ? JSON.parse((block as any).content)
        : ((block as any).content || {});
    } catch {
      return {};
    }
  })();
  if (content.is_a)                                              score++;
  if (content.unique && Object.keys(content.unique).length >= 2) score++;
  if (concepts.length >= 3)                                      score++;
  if (block.type === "project")                                  score++;
  return Math.min(score, 5);
}

/**
 * Convenience wrapper: compute the score for a just-created block and
 * persist it. Returns the score (callers usually don't need it). Used
 * everywhere new blocks are created — the manual POST routes in
 * routes/blocks.ts AND the reflect pipeline (8 createBlock sites).
 */
export function stampQualityScore(
  db: WorkspaceDB,
  block: { id: string; type: string; content?: unknown },
  concepts: string[],
): number {
  const qScore = computeQualityScore(block, concepts);
  db.updateBlock(block.id, { quality_score: qScore });
  return qScore;
}
