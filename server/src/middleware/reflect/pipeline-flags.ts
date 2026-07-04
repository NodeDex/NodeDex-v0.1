// ═══════════════════════════════════════════════════════════════════════════════
// DEBT 5 Slice 1 — PIPELINE FLAGS (Stage FLAG infrastructure)
// ═══════════════════════════════════════════════════════════════════════════════
//
// Replaces auto-drop semantics in dedupBySourceAndValue + provides the durable
// flag persistence layer for Stage AUDIT (Slice 2) + entity resolution
// uncertainty (Stage C, Sub-step 1.2).
//
// Per user direction: system FLAGS, reasoning MERGES. This module is the
// system FLAGS half — code-only, no LLM, just durable persistence of
// "these two blocks look like duplicates — needs reasoning to decide."
//
// The async LLM reviewer (Slice 2) is the reasoning MERGES half — it
// consumes rows written here, calls LLM with full context, writes verdict +
// optional merge action back.
//
// Pattern reference: pass2-quarantine.ts (table + writer + reader module).
// Per docs/PIPELINE-SLICE-1-DESIGN.md §3.
//
// Sub-step 1.1 (this file): table schema + function signatures + stub impls.
//   - ensurePipelineFlagsTable: real impl (idempotent CREATE)
//   - writePipelineFlag: real impl (INSERT)
//   - getPendingFlags: real impl (SELECT)
//   No callers yet — Sub-step 1.4 wires Stage FLAG to call writePipelineFlag.
//
// What this module does NOT do:
//   - The async LLM reviewer (that's Slice 2 — its own module)
//   - Stage AUDIT background process (that's Slice 2)
//   - Auto-merge actions (reviewer's job, not flag-writer's)

import type Database from "better-sqlite3";
import { v4 as uuidv4 } from "uuid";
import type {
  PipelineFlag,
  PipelineFlagType,
  PipelineFlagWriter,
  ScopeCheck,
  ReviewVerdict,
  FlagActionTaken,
} from "./types.js";

// ─── Schema migration ──────────────────────────────────────────────────────────

/**
 * Create the pipeline_flags table + indexes if they don't exist. Safe to call
 * repeatedly (CREATE IF NOT EXISTS + indexes are idempotent).
 *
 * Caller responsibility: invoke once at server boot. Writers do NOT auto-
 * create the table — they assume it exists. Keeps the call graph predictable
 * (no silent side effects in hot paths). Matches pass2-quarantine.ts pattern.
 *
 * criteria_json + review/action fields are stored as nullable TEXT so the
 * shape can evolve without per-field column adds (SQLite JSON1 can query
 * into them if composition analysis ever needed).
 */
export function ensurePipelineFlagsTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS pipeline_flags (
      id              TEXT PRIMARY KEY,
      flag_type       TEXT NOT NULL,
      block_id_a      TEXT NOT NULL,
      block_id_b      TEXT,
      criteria_json   TEXT NOT NULL,
      scope_check     TEXT NOT NULL,
      origin_writer   TEXT NOT NULL,
      origin_range_id TEXT,
      created_at      TEXT NOT NULL,

      reviewed_at     TEXT,
      review_verdict  TEXT,
      review_reason   TEXT,

      action_taken    TEXT,
      action_at       TEXT,
      winning_block_id TEXT,

      FOREIGN KEY (block_id_a) REFERENCES blocks(id),
      FOREIGN KEY (block_id_b) REFERENCES blocks(id),
      FOREIGN KEY (origin_range_id) REFERENCES conversation_turn_ranges(id),
      FOREIGN KEY (winning_block_id) REFERENCES blocks(id)
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_pipeline_flags_unreviewed
    ON pipeline_flags(reviewed_at) WHERE reviewed_at IS NULL`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_pipeline_flags_type
    ON pipeline_flags(flag_type)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_pipeline_flags_block_a
    ON pipeline_flags(block_id_a)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_pipeline_flags_origin_writer
    ON pipeline_flags(origin_writer)`);
}

// ─── Writers ───────────────────────────────────────────────────────────────────

export interface WritePipelineFlagInput {
  flag_type: PipelineFlagType;
  block_id_a: string;
  block_id_b: string | null;
  criteria: Record<string, unknown>;
  scope_check: ScopeCheck;
  origin_writer: PipelineFlagWriter;
  origin_range_id: string | null;
}

/**
 * Write a new flag for async-reviewer pickup. Returns the generated id.
 *
 * Writes are additive — multiple flags for the same block_id_a are allowed
 * (different flag_types, or different block_id_b candidates). Reviewer
 * deduplicates by inspecting the unreviewed set + the actual graph state.
 *
 * No FK or shape validation here beyond what SQLite enforces — caller is
 * expected to assemble a valid criteria object per the flag_type's schema
 * (see PIPELINE-SLICE-1-DESIGN.md §3.1).
 */
export function writePipelineFlag(
  db: Database.Database,
  input: WritePipelineFlagInput,
): string {
  const id = `pfl_${uuidv4().slice(0, 12)}`;
  const stmt = db.prepare(`
    INSERT INTO pipeline_flags (
      id, flag_type, block_id_a, block_id_b, criteria_json,
      scope_check, origin_writer, origin_range_id, created_at,
      reviewed_at, review_verdict, review_reason,
      action_taken, action_at, winning_block_id
    ) VALUES (
      @id, @flag_type, @block_id_a, @block_id_b, @criteria_json,
      @scope_check, @origin_writer, @origin_range_id, @created_at,
      NULL, NULL, NULL,
      NULL, NULL, NULL
    )
  `);

  stmt.run({
    id,
    flag_type:       input.flag_type,
    block_id_a:      input.block_id_a,
    block_id_b:      input.block_id_b,
    criteria_json:   JSON.stringify(input.criteria ?? {}),
    scope_check:     input.scope_check,
    origin_writer:   input.origin_writer,
    origin_range_id: input.origin_range_id,
    created_at:      new Date().toISOString(),
  });

  return id;
}

// ─── Reviewer write-back (Slice 2.2) ──────────────────────────────────────────

export interface MarkFlagReviewedInput {
  flag_id: string;
  verdict: ReviewVerdict;
  reason: string;
  /** What the reviewer actually completed (dup merge / provenance correct/demote).
   *  null when the reviewer only wrote a verdict (verdict-only mode).  */
  action_taken?: FlagActionTaken;
  winning_block_id?: string | null;
}

/**
 * Mark a flag as reviewed — idempotent via `WHERE reviewed_at IS NULL` guard.
 * Returns true if the row was updated, false if it was already reviewed
 * (concurrent reviewer tick won the race, or manual REST review beat the
 * async worker). False is NOT an error — caller logs and moves on.
 *
 * Slice 2.2 reviewer worker (flag-reviewer.ts) writes via this helper after
 * each LLM call. Slice 2.4 REST endpoint (POST /api/flags/:id/review) also
 * uses it for manual operator override.
 */
export function markFlagReviewed(
  db: Database.Database,
  input: MarkFlagReviewedInput,
): boolean {
  const stmt = db.prepare(`
    UPDATE pipeline_flags
       SET reviewed_at      = @reviewed_at,
           review_verdict   = @verdict,
           review_reason    = @reason,
           action_taken     = @action_taken,
           action_at        = @action_at,
           winning_block_id = @winning_block_id
     WHERE id = @flag_id
       AND reviewed_at IS NULL
  `);
  const action_taken = input.action_taken ?? null;
  const r = stmt.run({
    flag_id:          input.flag_id,
    reviewed_at:      new Date().toISOString(),
    verdict:          input.verdict,
    reason:           input.reason,
    action_taken,
    // action_at populated only when an action actually fired
    action_at:        action_taken && action_taken !== 'none' ? new Date().toISOString() : null,
    winning_block_id: input.winning_block_id ?? null,
  });
  return r.changes === 1;
}

/**
 * Route a flag to the AGENT for clarification WITHOUT consuming the single review
 * slot. Sets review_verdict='pending_clarification' + review_reason but leaves
 * reviewed_at NULL, so:
 *   - getPendingFlags excludes it (the autonomous reviewer won't re-process it), AND
 *   - the agent can still resolve it via POST /api/flags/:id/review — that endpoint
 *     guards on reviewed_at (not verdict), so the agent's later verdict IS the real
 *     review and overwrites this routing marker.
 *
 * Used by the reviewer for owner-unknown flags it must NOT auto-decide: ownership
 * needs context the autonomous reviewer lacks (the conversation + the ability to ask
 * the user). FLAG, don't guess. Returns true if a row was updated (false if the flag
 * was already reviewed, or already routed).
 */
export function markFlagPendingClarification(
  db: Database.Database,
  input: { flag_id: string; reason: string },
): boolean {
  const stmt = db.prepare(`
    UPDATE pipeline_flags
       SET review_verdict = 'pending_clarification',
           review_reason  = @reason
     WHERE id = @flag_id
       AND reviewed_at IS NULL
       AND (review_verdict IS NULL OR review_verdict != 'pending_clarification')
  `);
  const r = stmt.run({ flag_id: input.flag_id, reason: input.reason });
  return r.changes === 1;
}

// ─── Readers ───────────────────────────────────────────────────────────────────

interface PipelineFlagRow {
  id: string;
  flag_type: string;
  block_id_a: string;
  block_id_b: string | null;
  criteria_json: string;
  scope_check: string;
  origin_writer: string;
  origin_range_id: string | null;
  created_at: string;
  reviewed_at: string | null;
  review_verdict: string | null;
  review_reason: string | null;
  action_taken: string | null;
  action_at: string | null;
  winning_block_id: string | null;
}

function rowToFlag(row: PipelineFlagRow): PipelineFlag {
  let criteria: Record<string, unknown> = {};
  try { criteria = JSON.parse(row.criteria_json); } catch { /* tolerate bad JSON — empty criteria */ }
  return {
    id:              row.id,
    flag_type:       row.flag_type as PipelineFlagType,
    block_id_a:      row.block_id_a,
    block_id_b:      row.block_id_b,
    criteria,
    scope_check:     row.scope_check as ScopeCheck,
    origin_writer:   row.origin_writer as PipelineFlagWriter,
    origin_range_id: row.origin_range_id,
    created_at:      row.created_at,
    reviewed_at:     row.reviewed_at,
    review_verdict:  (row.review_verdict as ReviewVerdict) ?? null,
    review_reason:   row.review_reason,
    action_taken:    (row.action_taken as PipelineFlag["action_taken"]) ?? null,
    action_at:       row.action_at,
    winning_block_id: row.winning_block_id,
  };
}

export interface GetPendingFlagsOpts {
  flag_type?: PipelineFlagType;
  origin_writer?: PipelineFlagWriter;
  limit?: number;
}

/**
 * Get flags awaiting review (reviewed_at IS NULL). Default limit 100.
 * Used by Slice 2 async reviewer worker. Also useful for debug REST endpoint
 * (Slice 2 will add GET /api/flags).
 */
export function getPendingFlags(
  db: Database.Database,
  opts: GetPendingFlagsOpts = {},
): PipelineFlag[] {
  // Exclude flags routed to the agent (verdict='pending_clarification', reviewed_at
  // still NULL) — those await the agent/user, not the autonomous reviewer. Without
  // this the reviewer would re-route them every tick.
  const where: string[] = [
    "reviewed_at IS NULL",
    "(review_verdict IS NULL OR review_verdict != 'pending_clarification')",
  ];
  const params: Record<string, unknown> = {};
  if (opts.flag_type) {
    where.push("flag_type = @flag_type");
    params.flag_type = opts.flag_type;
  }
  if (opts.origin_writer) {
    where.push("origin_writer = @origin_writer");
    params.origin_writer = opts.origin_writer;
  }
  const limit = opts.limit ?? 100;
  const sql = `SELECT * FROM pipeline_flags WHERE ${where.join(" AND ")} ORDER BY created_at ASC LIMIT ${limit}`;
  const rows = db.prepare(sql).all(params) as PipelineFlagRow[];
  return rows.map(rowToFlag);
}

/**
 * Flags routed to the AGENT for clarification (reviewed_at NULL + verdict=
 * 'pending_clarification'). The context hook surfaces these as plain-English
 * questions; the agent resolves them (POST /api/flags/:id/review) or asks the user.
 * Oldest first (resolve the longest-waiting ambiguity first).
 */
export function getAgentPendingFlags(
  db: Database.Database,
  opts: { limit?: number } = {},
): PipelineFlag[] {
  const limit = opts.limit ?? 20;
  const rows = db.prepare(
    `SELECT * FROM pipeline_flags
      WHERE reviewed_at IS NULL AND review_verdict = 'pending_clarification'
      ORDER BY created_at ASC LIMIT ${limit}`,
  ).all() as PipelineFlagRow[];
  return rows.map(rowToFlag);
}

/**
 * Cheap COUNT of flags routed to the agent (same predicate as getAgentPendingFlags,
 * no row materialization). Drives the lightweight "N items need your input" nudge
 * that rides on every tool result — a passive MCP tool can't push, so the agent
 * discovers pending work by bumping into this on calls it was already making.
 */
export function countAgentPendingFlags(db: Database.Database): number {
  const row = db.prepare(
    `SELECT COUNT(*) AS n FROM pipeline_flags
      WHERE reviewed_at IS NULL AND review_verdict = 'pending_clarification'`,
  ).get() as { n: number };
  return row?.n ?? 0;
}

export interface ListFlagsOpts {
  flag_type?: PipelineFlagType;
  origin_writer?: PipelineFlagWriter;
  /** true → only reviewed; false → only unreviewed; undefined → all. */
  reviewed?: boolean;
  block_id?: string;
  limit?: number;
}

/**
 * General flag lister for the REST endpoint (Slice 2.4). Unlike getPendingFlags
 * (unreviewed-only), this handles the reviewed=true / =false / =all (undefined)
 * tri-state + a block_id filter (matches either block_id_a or block_id_b).
 * Newest-first ordering (REST consumers want the recent flags up top).
 */
export function listFlags(
  db: Database.Database,
  opts: ListFlagsOpts = {},
): PipelineFlag[] {
  const where: string[] = [];
  const params: Record<string, unknown> = {};
  if (opts.flag_type)     { where.push("flag_type = @flag_type");         params.flag_type = opts.flag_type; }
  if (opts.origin_writer) { where.push("origin_writer = @origin_writer"); params.origin_writer = opts.origin_writer; }
  if (opts.reviewed === true)  where.push("reviewed_at IS NOT NULL");
  if (opts.reviewed === false) where.push("reviewed_at IS NULL");
  if (opts.block_id) {
    where.push("(block_id_a = @block_id OR block_id_b = @block_id)");
    params.block_id = opts.block_id;
  }
  const limit = opts.limit ?? 100;
  const whereClause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const sql = `SELECT * FROM pipeline_flags ${whereClause} ORDER BY created_at DESC LIMIT ${limit}`;
  const rows = db.prepare(sql).all(params) as PipelineFlagRow[];
  return rows.map(rowToFlag);
}

/** Single flag by id, or null if not found. */
export function getFlagById(db: Database.Database, id: string): PipelineFlag | null {
  const row = db.prepare(`SELECT * FROM pipeline_flags WHERE id = ?`).get(id) as PipelineFlagRow | undefined;
  return row ? rowToFlag(row) : null;
}

/**
 * Get all flags for a given block (reviewed or not). Useful for surfacing
 * flag history per block (Slice 2 REST endpoint, debug, audit).
 */
export function getFlagsForBlock(
  db: Database.Database,
  blockId: string,
): PipelineFlag[] {
  const rows = db.prepare(`
    SELECT * FROM pipeline_flags
    WHERE block_id_a = @blockId OR block_id_b = @blockId
    ORDER BY created_at DESC
  `).all({ blockId }) as PipelineFlagRow[];
  return rows.map(rowToFlag);
}

/**
 * Summary counts — useful for telemetry + debug visibility (mirrors
 * summarizeQuarantine pattern from pass2-quarantine.ts).
 */
export function summarizePipelineFlags(db: Database.Database): {
  total: number;
  unreviewed: number;
  by_type: Array<{ flag_type: string; count: number }>;
  by_writer: Array<{ origin_writer: string; count: number }>;
  unreviewed_by_type: Array<{ flag_type: string; count: number }>;
} {
  const total = (db.prepare(`SELECT COUNT(*) as n FROM pipeline_flags`).get() as { n: number }).n;
  const unreviewed = (db.prepare(`SELECT COUNT(*) as n FROM pipeline_flags WHERE reviewed_at IS NULL`).get() as { n: number }).n;
  const by_type = db.prepare(`SELECT flag_type, COUNT(*) as count FROM pipeline_flags GROUP BY flag_type ORDER BY count DESC`).all() as Array<{ flag_type: string; count: number }>;
  const by_writer = db.prepare(`SELECT origin_writer, COUNT(*) as count FROM pipeline_flags GROUP BY origin_writer ORDER BY count DESC`).all() as Array<{ origin_writer: string; count: number }>;
  // Pending-work breakdown (what the TUI Health row shows): counts only what
  // still NEEDS a decision, unlike by_type which is the all-time ledger.
  const unreviewed_by_type = db.prepare(
    `SELECT flag_type, COUNT(*) as count FROM pipeline_flags WHERE reviewed_at IS NULL GROUP BY flag_type ORDER BY count DESC`,
  ).all() as Array<{ flag_type: string; count: number }>;
  return { total, unreviewed, by_type, by_writer, unreviewed_by_type };
}
