// ═══════════════════════════════════════════════════════════════════════════════
// DEBT 5 Phase 4 (D2) — DEDUP BY (source_excerpt, unique{}.value)
// Updated by Slice 1 Sub-step 1.4 — FLAG, do not auto-drop
// ═══════════════════════════════════════════════════════════════════════════════
//
// Per design §2.5.1: two blocks are duplicates IFF their (source_excerpt,
// unique{}.<primary>) tuple matches. Block label and type are EXCLUDED as
// identity criteria — they can vary across runs / providers (per
// [[project-pass1-pass2a-provider-drift-2026-05-30]]: same source produced
// blueprint type one day, decision type the next; D2 makes that cosmetic).
//
// Sub-step 1.4 behavior change (per user direction in
// docs/DEBT5-PHASE11-FINDINGS-AND-DEPENDENCY-MAP.md §2):
//   - The system FLAGS duplicate candidates; it does NOT auto-merge.
//   - Reasoning (Slice 2 async LLM reviewer) decides merge/leave/split with
//     full graph context.
//   - This function now ONLY DETECTS duplicates. It returns ALL input items
//     unchanged (no drop). Caller (pipeline.ts) writes pipeline_flags rows
//     for each detected pair AFTER Pass 3 createBlock loop (when block_ids
//     are available for the FK).
//
// Until Slice 2 lands the reviewer, the graph may temporarily accumulate
// duplicate atomic blocks. That's the user-accepted trade-off versus auto-
// drop (which lost the reasoning step and violated charter Rule 2 spirit).
//
// Design anchors:
//   docs/DEBT5-ATOMIC-AND-ARC-EXTRACTION.md §2.5.1 (D2 dedup principle)
//                                          §2.3.2 (source_excerpt field; provides the dedup key)
//   docs/PIPELINE-FIX-ROADMAP.md §2 (Sub-step 1.4)
//   docs/PIPELINE-SLICE-1-DESIGN.md §3.1 (flag_type=atomic_dup_candidate)
//
// What "primary value" means per type — the IDENTITY-bearing unique{} field, per
// TYPE_UNIQUE_SCHEMA (schema-validator.ts) + docs/reference/block-types.md (the source
// of truth). The CANONICAL field is listed FIRST; legacy field names follow it as
// fallbacks so pre-rename blocks still resolve.
//
//   2026-06-07 sync: PRIMARY_KEYS had drifted from the schema — it named fields the
//   producers never emit (constraint.requirement vs the actual .limit; dead_end.dropped
//   vs .approach; insight.principle vs .observation; preference had no .lean entry). For
//   most types the alphabetical fallback below happened to land on the right field, but
//   for some it silently picked the WRONG one (insight -> implication, hypothesis ->
//   evidence_against, artifact -> description). Now aligned to the schema — keep in sync.

import type { Pass2Item } from "./types.js";

// ─── Primary-value extraction per type ────────────────────────────────────────

/**
 * Per type, which unique{} field carries the canonical "what is this block"
 * value used as the dedup discriminator alongside source_excerpt.
 * Synced with docs/reference/block-types.md (verified 2026-05-30).
 */
const PRIMARY_KEYS: Record<string, string[]> = {
  decision:        ["choice"],
  dead_end:        ["approach", "dropped", "reason", "value"],   // approach=canonical; dropped=legacy
  constraint:      ["limit", "requirement", "value"],            // limit=canonical; requirement=legacy
  blueprint:       ["purpose"],
  preference:      ["lean", "value"],                            // lean=canonical
  chain:           ["arc"],
  fact:            ["value"],
  insight:         ["observation", "principle", "value"],        // observation=canonical; principle=legacy
  reasoning_chain: ["observation"],
  task:            ["description"],                              // identity = what the task IS, not its status
  question:        ["question", "value"],
  hypothesis:      ["proposal", "claim", "value"],               // proposal=canonical; claim=legacy
  entity:          ["name"],
  claim:           ["assertion"],
  artifact:        ["path"],
  metric:          ["definition", "value"],
  event:           ["value", "what", "summary"],                 // value=canonical (event = fact + date/outcome)
  // Defensive fallback for novel/unknown types: first non-empty value in
  // unique{} alphabetically (stable across runs).
};

/**
 * Core extractor: given a block TYPE + its unique{} object, return the canonical
 * "what is this block" primary value. The identity-bearing field per type
 * (per [[feedback-identity-is-unique-not-label]] — identity is unique{} content,
 * NOT label/essence). Returns "" when no primary value found.
 *
 * Exported so OTHER producers that hold a (type, unique) pair rather than a
 * Pass2Item — e.g. Stage AUDIT's scope_disagreement detector, which works off
 * persisted Block rows — extract the SAME identity value (Rule 5: one notion of
 * "block identity value," one implementation).
 */
export function extractPrimaryValueFromUnique(
  type: string,
  unique: Record<string, unknown>,
): string {
  const keys = PRIMARY_KEYS[type];
  if (keys) {
    for (const k of keys) {
      const v = unique[k];
      if (typeof v === "string" && v.trim().length > 0) return v.trim();
    }
  }
  // Fallback: first non-empty value alphabetically (stable).
  const sortedKeys = Object.keys(unique).sort();
  for (const k of sortedKeys) {
    const v = unique[k];
    if (typeof v === "string" && v.trim().length > 0) return v.trim();
  }
  return "";
}

/**
 * Extract the canonical primary value for a Pass2Item, used as the second
 * tuple element in dedup. Returns "" when no primary value found (the item
 * then dedups only on source_excerpt, which is conservative).
 */
export function extractPrimaryValue(item: Pass2Item): string {
  return extractPrimaryValueFromUnique(item.type, item.unique ?? {});
}

// ─── The detect function (Sub-step 1.4 — FLAG, do not drop) ───────────────────

export interface DedupResult {
  /**
   * Items list returned to the caller. Sub-step 1.4 semantics: kept ALWAYS
   * equals input items (no drop). Pre-1.4 this auto-dropped duplicates;
   * post-1.4 the caller writes pipeline_flags rows for an async LLM
   * reviewer (Slice 2) to decide merge/leave/split with full graph context.
   *
   * Until Slice 2 lands, the graph may accumulate duplicate atomic blocks.
   * That's the trade-off versus auto-drop, which violated the flag-not-merge
   * principle the user established in PIPELINE-AUDIT-DEPENDENCY-MAP.md §2.
   */
  kept: Pass2Item[];
  /**
   * Duplicate-candidate pairs detected. The caller (pipeline.ts) resolves
   * these item_ids to block_ids after Pass 3 createBlock loop, then calls
   * writePipelineFlag with flag_type='atomic_dup_candidate'.
   */
  duplicates: Array<{ id: string; duplicate_of: string; key: string }>;
}

/**
 * Detect candidate duplicate items by (source_excerpt, primary_value).
 *
 * Sub-step 1.4 change: this function NO LONGER drops items. Returns input
 * unchanged + the duplicate-pair list. See DedupResult.kept comment for
 * full rationale.
 *
 * RULES (unchanged from prior behavior):
 *   - Two items are duplicate-CANDIDATES iff:
 *       a) Both have non-empty excerpt AND
 *       b) Both have non-empty primary value AND
 *       c) Both tuples match exactly (case-sensitive — Pass 1 deterministically
 *          extracts from transcript, so case should be stable)
 *   - First occurrence is the "winner" for FK target purposes in the flag.
 *   - NULL/empty excerpt items NEVER detected (treated as pre-Debt-5 atomic —
 *     can't determine sameness without source pin).
 *   - Empty primary value items NEVER detected (defensive — risk false-positive
 *     on unrelated items that happen to share a source line).
 *
 * Returns:
 *   - kept: ALL input items (never drops; same array reference)
 *   - duplicates: list of {id, duplicate_of, key} for downstream flag writing
 *
 * Function name preserved (dedupBySourceAndValue) for backward compat with
 * callers, but semantics flipped from "dedup" to "detect duplicates."
 */
export function dedupBySourceAndValue(items: Pass2Item[]): DedupResult {
  const seen = new Map<string, string>();
  const duplicates: Array<{ id: string; duplicate_of: string; key: string }> = [];

  for (const item of items) {
    const excerpt = (item.excerpt ?? "").trim();
    const primary = extractPrimaryValue(item);

    if (excerpt.length === 0 || primary.length === 0) continue;

    const dedupKey = excerpt + " " + primary;
    const firstId = seen.get(dedupKey);
    if (firstId) {
      duplicates.push({ id: item.id, duplicate_of: firstId, key: dedupKey });
      continue;
    }

    seen.set(dedupKey, item.id);
  }

  return { kept: items, duplicates };
}
