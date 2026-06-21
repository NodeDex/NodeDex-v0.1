// apply-flag-verdict.ts — the ONE mechanical applier for a flag verdict.
//
// Validate a {verdict, reason, execute?, winning_block_id?} against a flag, run the
// merge if asked, write the verdict back. Pure mechanics — no LLM, no NL. Both
// resolution surfaces call THIS so they can't diverge on validation or merge
// semantics:
//   • REST   — POST /api/flags/:id/review (operator override)
//   • NL      — nl-accept.ts (agent stated its decision in its reply)
//
// Charter Rule 2 honored downstream: executeMerge archives the loser (recoverable),
// never deletes.

import type Database from "better-sqlite3";
import type { WorkspaceDB } from "../../store/database.js";
import type { PipelineFlag, ReviewVerdict, FlagActionTaken } from "./types.js";
import { markFlagReviewed } from "./pipeline-flags.js";
import { executeMerge } from "./flag-reviewer.js";

export const APPLY_VALID_VERDICTS: ReviewVerdict[] = ["merge", "leave", "split", "pending_clarification"];

export interface ApplyVerdictInput {
  verdict: ReviewVerdict;
  reason: string;
  /** Run executeMerge (archive loser + wire supersedes). Only meaningful for 'merge'. */
  execute?: boolean;
  winning_block_id?: string | null;
}

export type ApplyVerdictResult =
  | { ok: true; action_taken: FlagActionTaken; winning_block_id: string | null }
  | { ok: false; code: string; message: string };

/**
 * Apply a verdict to a (fresh, not-yet-reviewed) flag. Caller is responsible for the
 * not-found / already-reviewed pre-checks (the REST route returns 404/409; the NL
 * path re-reads the pending set). Returns a discriminated result the caller maps to
 * its surface (HTTP status / log).
 */
export function applyFlagVerdict(
  db: WorkspaceDB,
  flag: PipelineFlag,
  input: ApplyVerdictInput,
): ApplyVerdictResult {
  const raw = (db as unknown as { db: Database.Database }).db;
  const verdict = input.verdict;
  const reason = (input.reason ?? "").trim();

  if (!APPLY_VALID_VERDICTS.includes(verdict)) {
    return { ok: false, code: "BAD_VERDICT", message: `verdict must be one of ${APPLY_VALID_VERDICTS.filter(Boolean).join(", ")}` };
  }
  if (!reason) {
    return { ok: false, code: "REASON_REQUIRED", message: "reason is required (the durable audit trail for this resolution)" };
  }

  let action_taken: FlagActionTaken = "none";
  let winningId: string | null = input.winning_block_id ?? null;

  if (input.execute && verdict === "merge") {
    if (!input.winning_block_id) {
      return { ok: false, code: "WINNER_REQUIRED", message: "winning_block_id required when execute=true and verdict='merge'" };
    }
    const validWinner = input.winning_block_id === flag.block_id_a || input.winning_block_id === flag.block_id_b;
    if (!validWinner) {
      return { ok: false, code: "BAD_WINNER", message: `winning_block_id must be one of the flag's blocks (${flag.block_id_a}, ${flag.block_id_b})` };
    }
    const loser = input.winning_block_id === flag.block_id_a ? flag.block_id_b : flag.block_id_a;
    if (!loser) {
      return { ok: false, code: "NO_LOSER", message: "cannot merge a single-block flag (no loser)" };
    }
    action_taken = executeMerge(db, input.winning_block_id, loser);
    if (action_taken === "none") {
      return { ok: false, code: "MERGE_FAILED", message: "merge execution failed (block not found or self-merge) — flag NOT marked reviewed" };
    }
    winningId = input.winning_block_id;
  }

  const wrote = markFlagReviewed(raw, { flag_id: flag.id, verdict, reason, action_taken, winning_block_id: winningId });
  if (!wrote) {
    return { ok: false, code: "ALREADY_REVIEWED", message: "flag was reviewed concurrently — re-fetch to see the verdict" };
  }
  return { ok: true, action_taken, winning_block_id: winningId };
}
