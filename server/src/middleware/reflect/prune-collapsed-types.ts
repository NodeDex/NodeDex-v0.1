// prune-collapsed-types.ts — registry cleanup for the 2026-06-15 type collapse.
//
// reasoning_chain→insight and metric/claim→fact were collapsed: removed from the
// code's builtin-types seed, the prompts, and the validator. But a DB seeded BEFORE
// the collapse still carries their `block_types` rows — `INSERT OR IGNORE` only adds,
// never deletes — so they persist and still surface to the agent (via /api/session)
// and re-union into the pipeline's seedTypeNames. This prunes EXACTLY those three
// rows by name.
//
// Deliberately NOT a "delete everything not in the seed" reconcile: that would also
// wipe user-created custom types (workspace_create_type). Explicit names = zero
// collateral. Idempotent. $0, no LLM. Existing BLOCKS of these types are left
// forward-only — the validator trusts unknown types, so they recall/traverse fine;
// re-typing old blocks is a separate, heavier migration we deliberately do not do.
//
// Runs through the server's single DB connection (safe live, unlike a side-script).

import type Database from "better-sqlite3";
import type { WorkspaceDB } from "../../store/database.js";

/** The block types collapsed on 2026-06-15. Their content folded into fact/insight. */
export const COLLAPSED_TYPE_NAMES = ["reasoning_chain", "metric", "claim"] as const;

export interface PruneCollapsedResult {
  /** Which of the collapsed-type rows actually existed and were removed. */
  deleted: string[];
  /** block_types row count AFTER the prune (sanity). */
  remaining_types: number;
}

export function pruneCollapsedTypes(db: WorkspaceDB): PruneCollapsedResult {
  const raw = (db as any).db as Database.Database;
  const placeholders = COLLAPSED_TYPE_NAMES.map(() => "?").join(",");
  const present = raw
    .prepare(`SELECT name FROM block_types WHERE name IN (${placeholders})`)
    .all(...COLLAPSED_TYPE_NAMES)
    .map((r: any) => r.name as string);
  if (present.length > 0) {
    raw.prepare(`DELETE FROM block_types WHERE name IN (${present.map(() => "?").join(",")})`).run(...present);
  }
  const remaining_types = (raw.prepare(`SELECT COUNT(*) AS n FROM block_types`).get() as any).n as number;
  return { deleted: present, remaining_types };
}
