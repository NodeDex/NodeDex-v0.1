// schema-heal.ts — retroactive backfill of the deterministic demote-at-save heal.
//
// WHY: demoteForSave() (schema-validator.ts) re-types a block whose content fits a
// DIFFERENT type better — an `insight` with no `implication` IS, by definition, a
// `fact` whose value is the observation. But it runs at SAVE time, forward-only, so
// blocks created before it shipped (2026-06-12) sit FLAGGED
// (review_status='needs_review', schema_mismatch) instead of demoted. This applies the
// SAME deterministic rule retroactively to already-flagged blocks.
//
// CORRECTS, never deletes (Rule 2):
//   - clean case  → re-type via the demote (insight→fact: label segment renamed,
//                   observation mapped to value), flag cleared.
//   - collision   → the demoted label already exists, so this block DUPLICATES it.
//                   That's a MERGE judgment, not a clean demote — LEFT flagged for the
//                   dup-reviewer; never auto-merged here on a label match alone.
//   - not eligible→ no DEMOTE_TARGETS row / extras / source field missing → LEFT flagged.
//
// $0 — no LLM, pure deterministic rule. Run via POST /api/admin/heal-schema-demotes
// (the server's single DB connection). NEVER run as a script against a server-held DB.

import type { WorkspaceDB } from "../../store/database.js";
import { demoteForSave } from "./schema-validator.js";
import { intFromEnv } from "./config.js";

export interface SchemaHealResult {
  flagged: number;          // blocks examined (review_status='needs_review')
  healed: number;           // re-typed via the deterministic demote (corrected, flag cleared)
  collided: number;         // demote would hit an existing label → dup, left flagged
  skipped: number;          // not demote-eligible → left flagged
  healed_labels: string[];  // the new (post-demote) labels, for audit
}

/**
 * Apply demoteForSave() retroactively to every needs_review block. Pure use of the
 * existing rule + db.updateBlock (which records block_history). Idempotent: a healed
 * block becomes review_status='corrected' and is no longer picked up on a re-run.
 */
export function healSchemaDemotes(db: WorkspaceDB): SchemaHealResult {
  const flagged = db.getAllBlocks().filter((b) => (b as { review_status?: string }).review_status === "needs_review");
  const res: SchemaHealResult = { flagged: flagged.length, healed: 0, collided: 0, skipped: 0, healed_labels: [] };

  for (const b of flagged) {
    let content: Record<string, unknown> = {};
    try { content = typeof b.content === "string" ? JSON.parse(b.content) : ((b.content as Record<string, unknown>) ?? {}); }
    catch { content = {}; }
    const unique = (content.unique as Record<string, unknown>) ?? {};

    const demotion = demoteForSave((b as { type: string }).type, unique, b.label);
    if (!demotion) { res.skipped++; continue; }

    // Collision: the demoted label is already taken → this block duplicates an
    // existing one. Merging is a judgment for the dup-reviewer; leave it flagged.
    if (db.getBlock(demotion.label)) { res.collided++; continue; }

    content.unique = demotion.unique;
    db.updateBlock(
      b.id,
      { type: demotion.type, label: demotion.label, content, review_status: "corrected", review_reason: "" },
      `schema-heal: demoted ${demotion.from_type}→${demotion.type} (required field unfillable)`,
      "schema_heal",
    );
    res.healed++;
    res.healed_labels.push(demotion.label);
  }
  return res;
}

// ─── Background sweep (Tier-1 LOCKED-ON per docs/RELEASE-DEFAULTS-AND-SELF-MAINTENANCE.md) ──
// The doc lists schema-heal as a default-on essential ($0 deterministic), but only the
// save-time demote (forward) + the manual /api/admin/heal-schema-demotes endpoint were ever
// wired — so OLD flagged blocks never got swept (the doc↔code drift the backpacking DB's 8
// schema_mismatch flags exposed, 2026-06-21). This timer makes the doc true: a periodic $0
// deterministic sweep over the server's OWN db connection (the safe path — NEVER a script
// against a server-held DB). Idempotent (healed → review_status='corrected', not re-picked),
// so re-running is free. Opt-out only: NODEDEX_SCHEMA_HEAL_ENABLED=off.

export function schemaHealEnabled(): boolean {
  return (process.env.NODEDEX_SCHEMA_HEAL_ENABLED ?? "on").toLowerCase() !== "off";
}
function intervalMs(): number {
  return intFromEnv("NODEDEX_SCHEMA_HEAL_INTERVAL_MS", 1_800_000); // 30 min (slow background)
}

let _handle: ReturnType<typeof setInterval> | null = null;
let _inFlight = false;

function tick(db: WorkspaceDB): void {
  if (_inFlight) return;
  _inFlight = true;
  try {
    const r = healSchemaDemotes(db);
    if (r.healed > 0 || r.collided > 0) {
      console.log(`[schema-heal] swept: flagged=${r.flagged} healed=${r.healed} collided=${r.collided} skipped=${r.skipped}`);
    }
  } catch (e: any) {
    console.warn(`[schema-heal] sweep threw: ${e?.message ?? e}`);
  } finally {
    _inFlight = false;
  }
}

/** Start the $0 deterministic schema-heal sweep. Default-ON (Tier-1). Idempotent.
 *  Runs an initial sweep ~15s after boot (let the server settle), then periodically. */
export function startSchemaHealTimer(db: WorkspaceDB): boolean {
  if (!schemaHealEnabled()) {
    console.log("[schema-heal] disabled (NODEDEX_SCHEMA_HEAL_ENABLED=off)");
    return false;
  }
  if (_handle !== null) return false;
  const ms = intervalMs();
  const initial = setTimeout(() => tick(db), 15_000);
  if (typeof initial.unref === "function") initial.unref();
  _handle = setInterval(() => tick(db), ms);
  if (typeof _handle.unref === "function") _handle.unref();
  console.log(`[schema-heal] started: $0 deterministic sweep, interval=${ms}ms (initial in 15s)`);
  return true;
}

export function stopSchemaHealTimer(): void {
  if (_handle !== null) { clearInterval(_handle); _handle = null; }
}

/** Tests only — is the timer running? */
export function _isSchemaHealTimerRunningForTests(): boolean {
  return _handle !== null;
}
