// ═══════════════════════════════════════════════════════════════════════════════
// INLINE DEDUP — recognize-before-write (run dedup BEFORE Pass 4 links)
// ═══════════════════════════════════════════════════════════════════════════════
//
// DO:    For each block this turn just wrote (Pass 3, still status='pending'),
//        find a same-scope existing block that is the SAME claim (exact /
//        token-overlap / drift-embedding), flag it, and run the universal
//        flag-reviewer so a confirmed duplicate is MERGED — all BEFORE Pass 4
//        gets a chance to wire a relation between the pair.
//
// SERVE: compounding. One piece of residue should be ONE block. A dead_end the
//        agent reached once, restated (reworded) in a later turn, must collapse
//        to a single block — not accrete near-copies that bury each other and
//        erode the agent's trust in the graph.
//
// CARRY: this exists at THIS seam (pre-Pass-4) for one reason. The async AUDIT
//        already detects + the reviewer already merges — but the AUDIT runs
//        AFTER Pass 4, and Pass 4 wires `extends` between a block and its own
//        restatement. The reviewer then correctly reads `extends` as
//        "elaboration, keep both" and LEAVES the pair. Running the SAME detection
//        + the SAME reviewer one step EARLIER (before the linker) means the
//        reviewer judges the pair on content, with no spurious edge in the way.
//        The async AUDIT stays as the cross-SESSION backstop + healer.
//
// REUSE (no new logic, no new prompt):
//   - judgeBlockDupPair / toAuditBlock / blockDupJudgeOpts / the idempotency
//     helpers  ← stage-audit-graph.ts (the ONE detection implementation)
//   - writePipelineFlag                                  ← pipeline-flags.ts
//   - runFlagReviewerTick + executeMerge (edge-union)    ← flag-reviewer.ts
//
// Containment: gated behind NODEDEX_INLINE_DEDUP (default OFF). The reviewer's
// executeMerge ARCHIVES the loser (recoverable, charter Rule 2 — never deletes)
// and UNIONS its edges onto the survivor (a block can belong to many chains:
// "write once, belong to many" — merging must not cost connections).

import type Database from "better-sqlite3";
import type { WorkspaceDB } from "../../store/database.js";
import type { LLMProvider } from "../../engine/ai-provider.js";
import { writePipelineFlag } from "./pipeline-flags.js";
import { runFlagReviewerTick } from "./flag-reviewer.js";
import {
  toAuditBlock,
  judgeBlockDupPair,
  blockDupJudgeOpts,
  hasSupersedesBetween,
  flagAlreadyExists,
  sharedConceptCount,
} from "./stage-audit-graph.js";

/** Gate. Default OFF — the inline merge only runs when explicitly opted in. */
export function inlineDedupEnabled(): boolean {
  return (process.env.NODEDEX_INLINE_DEDUP ?? "").toLowerCase() === "on";
}

export interface InlineDedupResult {
  /** block_dup_candidate flags written this call. */
  flagsWritten: number;
  /** Merges the reviewer actually executed (either side may be the loser). */
  merges: number;
  /** Flags routed to the agent (merge-lean but not confidently auto-mergeable). */
  routed: number;
  /** Ids of the NEW (this-turn) blocks the reviewer archived (merged away). */
  mergedAway: Set<string>;
  /** Labels of those same merged-away blocks (so the caller can prune its
   *  saved_labels precisely, without an id→label re-lookup post-archive). */
  mergedAwayLabels: Set<string>;
}

/**
 * Dedup this turn's new blocks against the existing graph, BEFORE Pass 4 links.
 *
 * @param newBlockIds  the ids Pass 3 just created (still status='pending').
 * @returns which of those ids the reviewer merged away (archived) — the caller
 *          drops them from the pending set so they never reach Pass 4 / Pass 5.
 */
export async function dedupNewBlocksInline(
  db: WorkspaceDB,
  provider: LLMProvider,
  newBlockIds: string[],
): Promise<InlineDedupResult> {
  const mergedAway = new Set<string>();
  const mergedAwayLabels = new Set<string>();
  if (newBlockIds.length === 0) return { flagsWritten: 0, merges: 0, routed: 0, mergedAway, mergedAwayLabels };

  const raw = (db as any).db as Database.Database;
  const opts = blockDupJudgeOpts();
  // Snapshot the graph ONCE (pre-merge). getAllBlocks excludes archived. byId
  // also lets us recover a merged-away loser's label after it is archived.
  const all = db.getAllBlocks().map(toAuditBlock);
  const byId = new Map(all.map((b) => [b.id, b]));
  const newSet = new Set(newBlockIds);

  let flagsWritten = 0;
  for (const nid of newBlockIds) {
    const a = byId.get(nid);
    // Unscoped blocks can't be safely deduped — same-scope is the merge guard.
    if (!a || a.project_id == null) continue;
    for (const b of all) {
      if (b.id === a.id) continue;
      // A new-vs-new pair would otherwise be judged twice (a→b and b→a); let the
      // lower id initiate it once. (flagAlreadyExists is the real backstop; this
      // just avoids redundant work.) Existing(b) blocks are always judged.
      if (newSet.has(b.id) && b.id < a.id) continue;
      if (b.project_id !== a.project_id) continue; // cheap same-scope pre-filter
      const v = judgeBlockDupPair(a, b, opts);
      if (!v.isCandidate) continue;
      if (hasSupersedesBetween(raw, a.id, b.id)) continue;
      if (flagAlreadyExists(raw, "block_dup_candidate", a.id, b.id)) continue;
      writePipelineFlag(raw, {
        flag_type: "block_dup_candidate",
        block_id_a: a.id,
        block_id_b: b.id,
        criteria: {
          signal: v.signal,
          claim_tokens: v.claimTokens,
          embed_sim: v.signal === "essence_embedding" ? Number(v.embedSim.toFixed(3)) : undefined,
          shared_concepts: sharedConceptCount(a.concepts, b.concepts),
          primary_value: a.primary_value.slice(0, 200),
          scope: a.project_id,
          type_a: a.type, type_b: b.type,
          label_a: a.label, label_b: b.label,
        },
        scope_check: "same",
        origin_writer: "inline_dedup",
        origin_range_id: null,
      });
      flagsWritten += 1;
    }
  }

  if (flagsWritten === 0) return { flagsWritten: 0, merges: 0, routed: 0, mergedAway, mergedAwayLabels };

  // REUSE the universal reviewer + executeMerge. forceAutoMerge: TRUE — inline
  // dedup's whole purpose is to MERGE before Pass 4; a verdict-only pass would
  // leave the block to enter Pass 4 and acquire the very `extends` edge this
  // seam exists to prevent. Contained: gated (default off), archives (never
  // deletes), and only fires on a high-confidence merge verdict. Single tick
  // (reviewer batch default 5): a turn producing >5 dups leans on the async
  // AUDIT backstop for the remainder.
  const tick = await runFlagReviewerTick({ db, provider, forceAutoMerge: true });

  // Which NEW blocks did the reviewer archive? getAllBlocks excludes archived,
  // so a new id absent from the post-merge snapshot was merged away. NOTE: a merge
  // may instead archive the EXISTING block (keeping the new one as winner) — that
  // is still a real merge but won't appear in mergedAway, so the honest merge count
  // comes from the reviewer tick (tick.actions_executed), not mergedAway.size.
  const liveIds = new Set(db.getAllBlocks().map((b) => b.id));
  for (const nid of newBlockIds) {
    if (!liveIds.has(nid)) {
      mergedAway.add(nid);
      const lbl = byId.get(nid)?.label;
      if (lbl) mergedAwayLabels.add(lbl);
    }
  }
  return { flagsWritten, merges: tick.actions_executed, routed: tick.routed_to_agent, mergedAway, mergedAwayLabels };
}
