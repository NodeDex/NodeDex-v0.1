// Code-synthesis of the one Pass-1 item the LLM provably cannot produce reliably:
// the dead_end half of a replacement.
//
// THE PROBLEM. "I went with PostgreSQL, replacing SQLite" is one sentence but two
// events — a choice made (decision) AND a path abandoned (dead_end). Pass 1's
// per-sentence chunking emits one item and drops the dead_end (observed
// 2026-05-21, SQLite case). A prompt rule cannot beat chunking.
//
// THE SCOPE — deliberately one job. The LLM reliably extracts the *decision* half
// of a replacement (an affirmative, single-chunk statement) and reliably *finds*
// in-progress work. Its single proven blind spot is the dead_end half. So this
// module synthesizes ONLY that:
//
//   each replacements[] entry  →  exactly one dead_end item
//
// It does NOT emit the decision (the LLM owns that) and does NOT emit tasks from
// in_flight[] (the LLM finds those; Pass 2 re-verifies their type). Keeping the
// synthesizer and the LLM on disjoint jobs is what makes duplication structurally
// impossible — see docs/PIPELINE-REBUILD-PLAN.md, the seam-contract section.
//
// HONEST LIMIT. This is deterministic, but its input is not: replacements[] is
// produced by Pass 0, an LLM. If Pass 0 mislabels an in-place update (e.g. a doc
// revision) as a replacement, this module faithfully emits a nonsense dead_end.
// Determinism bounds the transform, never the result. That residual is the
// Pass 0 → synthesizer seam and is fixed upstream, not here.

import type { Pass0Result, Pass1Item } from "./types.js";

const EXCERPT_WINDOW = 150;
const EXCERPT_PAD = Math.floor((EXCERPT_WINDOW - 60) / 2); // leave room for the matched term itself

/**
 * Find a ~150-char window of `agentOutput` that contains `needle` (case-insensitive).
 * Returns the verbatim slice from the original casing. Falls back to "" if no match
 * — acceptable per Pass1Item schema, and downstream still gets correct text/type.
 */
function liftExcerpt(agentOutput: string, needle: string): string {
  if (!agentOutput || !needle) return "";
  const hay = agentOutput.toLowerCase();
  const n = needle.toLowerCase().trim();
  if (n.length === 0) return "";
  const idx = hay.indexOf(n);
  if (idx === -1) return "";
  const start = Math.max(0, idx - EXCERPT_PAD);
  const end = Math.min(agentOutput.length, idx + n.length + EXCERPT_PAD);
  let slice = agentOutput.slice(start, end);
  if (slice.length > EXCERPT_WINDOW) slice = slice.slice(0, EXCERPT_WINDOW);
  return slice.trim();
}

/**
 * Pick the most-likely-to-match needle for a replacements[] entry.
 * Prefer the predecessor name (the abandoned thing this dead_end is about),
 * then fall back to the replacement, then the function string.
 */
function pickReplacementExcerpt(
  agentOutput: string,
  predecessor: string,
  replacement: string,
  func: string,
): string {
  return (
    liftExcerpt(agentOutput, predecessor) ||
    liftExcerpt(agentOutput, replacement) ||
    liftExcerpt(agentOutput, func) ||
    ""
  );
}

export interface SynthesizeOptions {
  /** ID prefix — defaults to "syn" so synthesized items are traceable in logs. */
  idPrefix?: string;
}

/**
 * Translate each Pass 0 `replacements[]` entry into one synthesized `dead_end`
 * Pass-1 item — the half the LLM drops.
 *
 * Deterministic. No LLM. Output is a flat array; caller merges it with the LLM's
 * Pass 1 items into a single Pass1Result before handing to Pass 2. The matching
 * `decision` is left entirely to the LLM, so the two producers never overlap.
 */
export function synthesizeFromSceneCard(
  sceneCard: Pass0Result,
  agentOutput: string,
  opts: SynthesizeOptions = {},
): Pass1Item[] {
  const items: Pass1Item[] = [];
  const prefix = opts.idPrefix ?? "syn";
  let seq = 1;

  // ── REPLACEMENTS → one dead_end each ────────────────────────────────────────
  // The decision half is the LLM's job (it never misses it). Emitting it here too
  // would duplicate. The dead_end is the LLM's blind spot — so it is ours, alone.
  for (const r of sceneCard.replacements ?? []) {
    if (!r?.predecessor || !r?.replacement || !r?.function) continue;
    const { predecessor, replacement, function: func } = r;

    items.push({
      id: `${prefix}_${seq++}`,
      text: `${predecessor} was abandoned as the ${func}, replaced by ${replacement}`,
      source: "output",
      excerpt: pickReplacementExcerpt(agentOutput, predecessor, replacement, func),
      provisional_type: "dead_end",
      extraction_reasoning:
        "Synthesized from scene card replacements[] entry (predecessor abandoned in real use).",
    });
  }

  return items;
}
