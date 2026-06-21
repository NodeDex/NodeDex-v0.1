// ═══════════════════════════════════════════════════════════════════════════════
// PASS 2 AUDIT QUARANTINE — Week 1, debt #1 (2026-05-25)
//
// Role:  When Pass 2's split-mode seam validation (§3 of PASS2-SPLIT-DESIGN.md)
//        cannot resolve a candidate into a valid block — after one retry — the
//        candidate is preserved here with its full audit trail. NEVER lost,
//        NEVER ships to the live graph as a flagged-block.
//
// Design choices (locked 2026-05-25):
//   - SEPARATE TABLE `pass2_audit_quarantine`, not `blocks.status='quarantined'`.
//     Reason: prevents silent leakage into existing `getAllBlocks()` and other
//     unfiltered queries. Default agent navigation can ONLY reach quarantine via
//     explicit `/api/quarantine` endpoints — the visibility contract from §3 is
//     enforced structurally, not by remembering to add WHERE-clauses.
//   - NO absolute size limit. Tier-based signal monitoring only (§3).
//   - `agent_clarification` field is a RESERVED slot for debt 2b (future); writers
//     leave it null. Future enrichment passes will populate it.
//
// What this module does NOT do:
//   - It does NOT decide what to quarantine — that's `pass2-seams.ts`.
//   - It does NOT call any LLM.
//   - It does NOT mutate live blocks (`blocks` table).
//   - It does NOT do composition analysis or tier-signal alerts — those live in
//     a future telemetry layer; this module just stores and retrieves.
//
// Charter alignment:
//   - Rule 2 (never delete vetted blocks): quarantine entries aren't blocks; they
//     are candidates that failed the gate. The seam decides whether a candidate
//     becomes a block. Quarantine preserves the rest.
//   - Rule 6 (guards catch failure, never override success): writes are additive;
//     existing blocks are never touched by quarantine code paths.
//   - Rule 14 (store the path): the full audit trail (Pass 1 text, Pass 2a
//     classification reasoning, Pass 2b attempt, failure reason, retry status)
//     is preserved so a future session can reason about what happened.
// ═══════════════════════════════════════════════════════════════════════════════

import type Database from "better-sqlite3";

// ─── Types ─────────────────────────────────────────────────────────────────────

/**
 * Full quarantine entry shape per PASS2-SPLIT-DESIGN.md §3.
 *
 * Origin fields (from Pass 1): immutable after first write.
 * 2a fields: populated by Pass 2a's classify attempt.
 * 2b fields: populated by Pass 2b's fill attempt.
 * Retry fields: filled if the seam tried route-back to 2a.
 * Enrichment fields: managed by future debt 2 work.
 * agent_clarification: reserved for debt 2b (agent-in-the-loop).
 */
export interface QuarantineEntry {
  // Origin (from Pass 1) — never mutated after first write
  id: string;
  pass1_text: string;
  pass1_provisional_type: string;
  pass1_reasoning: string | null;
  pass1_excerpt: string | null;

  // What 2a did
  pass2a_classified: string;          // the type 2a assigned
  pass2a_reasoning: string;           // classification_reasoning from 2a
  pass2a_alternatives: string[];      // other types 2a considered

  // What 2b tried + why failed
  pass2b_attempted: Record<string, unknown>;  // the unique{} 2b tried to fill
  pass2b_failure_reason: string;              // validateUniqueSchema detail

  // Route-back outcome
  retry_attempted: boolean;
  retry_2a_classified: string | null;
  retry_outcome: "success" | "different_type_quarantined" | "same_type_quarantined" | null;

  // Temporal + sibling locator
  batch_id: string;
  source_session_id: string;
  quarantined_at: string;             // ISO timestamp
  siblings_promoted: string[];        // live block IDs from same batch

  // Enrichment state
  queued_for_enrichment: boolean;
  enrichment_attempts: Array<{ when: string; pass_used: string; outcome: string }>;
  promotion_blocked_until: string | null;  // ISO timestamp; null = no backoff

  // Agent clarification (reserved for future debt 2b — see project-future-enhancements)
  agent_clarification: {
    resolved_at: string;
    agent_verdict: string;
    agent_notes: string;
  } | null;
}

/**
 * Filter parameters for `getQuarantineEntries`. All optional; AND-combined.
 */
export interface QuarantineFilters {
  project?: string;             // matched via batch_id naming OR a project column if we add one later
  failure_reason?: string;      // substring match on pass2b_failure_reason
  batch_id?: string;
  source_session_id?: string;
  queued_for_enrichment?: boolean;
}

// ─── Schema migration ──────────────────────────────────────────────────────────

/**
 * Create the quarantine table if it doesn't exist. Safe to call repeatedly
 * (CREATE IF NOT EXISTS + indexes are idempotent).
 *
 * Caller responsibility: invoke once at server boot or test setup. Writers do
 * NOT auto-create the table — they assume it exists. This keeps the call graph
 * predictable (no silent side effects in hot paths).
 *
 * The audit-trail fields are stored as TEXT (JSON-serialized) so the shape can
 * evolve without per-field column adds. SQLite JSON1 functions can query into
 * them if we ever need composition analysis (debt-3 work).
 */
export function ensureQuarantineTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS pass2_audit_quarantine (
      id                          TEXT PRIMARY KEY,
      pass1_text                  TEXT NOT NULL,
      pass1_provisional_type      TEXT NOT NULL,
      pass1_reasoning             TEXT,
      pass1_excerpt               TEXT,

      pass2a_classified           TEXT NOT NULL,
      pass2a_reasoning            TEXT NOT NULL,
      pass2a_alternatives         TEXT NOT NULL DEFAULT '[]',  -- JSON array

      pass2b_attempted            TEXT NOT NULL DEFAULT '{}',  -- JSON object
      pass2b_failure_reason       TEXT NOT NULL,

      retry_attempted             INTEGER NOT NULL DEFAULT 0,  -- boolean
      retry_2a_classified         TEXT,
      retry_outcome               TEXT,                        -- nullable enum

      batch_id                    TEXT NOT NULL,
      source_session_id           TEXT NOT NULL,
      quarantined_at              TEXT NOT NULL,
      siblings_promoted           TEXT NOT NULL DEFAULT '[]',  -- JSON array of block ids

      queued_for_enrichment       INTEGER NOT NULL DEFAULT 1,  -- boolean
      enrichment_attempts         TEXT NOT NULL DEFAULT '[]',  -- JSON array
      promotion_blocked_until     TEXT,                        -- nullable ISO ts

      agent_clarification         TEXT                         -- nullable JSON object
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_quarantine_batch       ON pass2_audit_quarantine(batch_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_quarantine_session     ON pass2_audit_quarantine(source_session_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_quarantine_queued      ON pass2_audit_quarantine(queued_for_enrichment)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_quarantine_quarantined ON pass2_audit_quarantine(quarantined_at)`);
}

// ─── Writers ───────────────────────────────────────────────────────────────────

/**
 * Insert a new quarantine entry. Throws if `id` already exists (writes are
 * additive — re-quarantining the same id is a logic error in the caller, not
 * something this module silently handles).
 *
 * The caller (typically `pass2-seams.ts`) is responsible for assembling the
 * full audit trail before calling this — see `QuarantineEntry` shape.
 */
export function writeQuarantineEntry(
  db: Database.Database,
  entry: QuarantineEntry,
): void {
  const stmt = db.prepare(`
    INSERT INTO pass2_audit_quarantine (
      id, pass1_text, pass1_provisional_type, pass1_reasoning, pass1_excerpt,
      pass2a_classified, pass2a_reasoning, pass2a_alternatives,
      pass2b_attempted, pass2b_failure_reason,
      retry_attempted, retry_2a_classified, retry_outcome,
      batch_id, source_session_id, quarantined_at, siblings_promoted,
      queued_for_enrichment, enrichment_attempts, promotion_blocked_until,
      agent_clarification
    ) VALUES (
      @id, @pass1_text, @pass1_provisional_type, @pass1_reasoning, @pass1_excerpt,
      @pass2a_classified, @pass2a_reasoning, @pass2a_alternatives,
      @pass2b_attempted, @pass2b_failure_reason,
      @retry_attempted, @retry_2a_classified, @retry_outcome,
      @batch_id, @source_session_id, @quarantined_at, @siblings_promoted,
      @queued_for_enrichment, @enrichment_attempts, @promotion_blocked_until,
      @agent_clarification
    )
  `);

  stmt.run({
    id:                       entry.id,
    pass1_text:               entry.pass1_text,
    pass1_provisional_type:   entry.pass1_provisional_type,
    pass1_reasoning:          entry.pass1_reasoning,
    pass1_excerpt:            entry.pass1_excerpt,

    pass2a_classified:        entry.pass2a_classified,
    pass2a_reasoning:         entry.pass2a_reasoning,
    pass2a_alternatives:      JSON.stringify(entry.pass2a_alternatives ?? []),

    pass2b_attempted:         JSON.stringify(entry.pass2b_attempted ?? {}),
    pass2b_failure_reason:    entry.pass2b_failure_reason,

    retry_attempted:          entry.retry_attempted ? 1 : 0,
    retry_2a_classified:      entry.retry_2a_classified,
    retry_outcome:            entry.retry_outcome,

    batch_id:                 entry.batch_id,
    source_session_id:        entry.source_session_id,
    quarantined_at:           entry.quarantined_at,
    siblings_promoted:        JSON.stringify(entry.siblings_promoted ?? []),

    queued_for_enrichment:    entry.queued_for_enrichment ? 1 : 0,
    enrichment_attempts:      JSON.stringify(entry.enrichment_attempts ?? []),
    promotion_blocked_until:  entry.promotion_blocked_until,

    agent_clarification:      entry.agent_clarification
      ? JSON.stringify(entry.agent_clarification)
      : null,
  });
}

/**
 * Record an enrichment attempt — appends to enrichment_attempts[] without
 * touching other fields. Used by future debt 2a (pipeline self-enrichment).
 */
export function recordEnrichmentAttempt(
  db: Database.Database,
  id: string,
  attempt: { when: string; pass_used: string; outcome: string },
  options?: { newQueuedFlag?: boolean; newBlockedUntil?: string | null },
): void {
  const row = getQuarantineEntry(db, id);
  if (!row) throw new Error(`recordEnrichmentAttempt: no quarantine entry ${id}`);

  const updated = [...row.enrichment_attempts, attempt];
  db.prepare(`
    UPDATE pass2_audit_quarantine
    SET enrichment_attempts      = @attempts,
        queued_for_enrichment    = @queued,
        promotion_blocked_until  = @blocked
    WHERE id = @id
  `).run({
    id,
    attempts: JSON.stringify(updated),
    queued: (options?.newQueuedFlag ?? row.queued_for_enrichment) ? 1 : 0,
    blocked: options?.newBlockedUntil ?? row.promotion_blocked_until,
  });
}

/**
 * Mark a quarantine entry as PROMOTED — caller has already created a live
 * block from this candidate. Future enrichment will not pick it up again.
 *
 * Does NOT delete the row — the audit trail stays for inspection.
 * Records the promotion as the final enrichment_attempts entry with
 * `outcome: "promoted_to:<block_id>"`.
 */
export function markQuarantinePromoted(
  db: Database.Database,
  id: string,
  promotedBlockId: string,
): void {
  recordEnrichmentAttempt(
    db,
    id,
    { when: new Date().toISOString(), pass_used: "manual_or_enrichment", outcome: `promoted_to:${promotedBlockId}` },
    { newQueuedFlag: false, newBlockedUntil: null },
  );
}

// ─── Readers ───────────────────────────────────────────────────────────────────

interface QuarantineRow {
  id: string;
  pass1_text: string;
  pass1_provisional_type: string;
  pass1_reasoning: string | null;
  pass1_excerpt: string | null;
  pass2a_classified: string;
  pass2a_reasoning: string;
  pass2a_alternatives: string;       // JSON
  pass2b_attempted: string;          // JSON
  pass2b_failure_reason: string;
  retry_attempted: number;           // 0/1
  retry_2a_classified: string | null;
  retry_outcome: string | null;
  batch_id: string;
  source_session_id: string;
  quarantined_at: string;
  siblings_promoted: string;         // JSON
  queued_for_enrichment: number;     // 0/1
  enrichment_attempts: string;       // JSON
  promotion_blocked_until: string | null;
  agent_clarification: string | null; // JSON
}

function rowToEntry(row: QuarantineRow): QuarantineEntry {
  return {
    id:                       row.id,
    pass1_text:               row.pass1_text,
    pass1_provisional_type:   row.pass1_provisional_type,
    pass1_reasoning:          row.pass1_reasoning,
    pass1_excerpt:            row.pass1_excerpt,
    pass2a_classified:        row.pass2a_classified,
    pass2a_reasoning:         row.pass2a_reasoning,
    pass2a_alternatives:      JSON.parse(row.pass2a_alternatives || "[]"),
    pass2b_attempted:         JSON.parse(row.pass2b_attempted || "{}"),
    pass2b_failure_reason:    row.pass2b_failure_reason,
    retry_attempted:          row.retry_attempted === 1,
    retry_2a_classified:      row.retry_2a_classified,
    retry_outcome:            row.retry_outcome as QuarantineEntry["retry_outcome"],
    batch_id:                 row.batch_id,
    source_session_id:        row.source_session_id,
    quarantined_at:           row.quarantined_at,
    siblings_promoted:        JSON.parse(row.siblings_promoted || "[]"),
    queued_for_enrichment:    row.queued_for_enrichment === 1,
    enrichment_attempts:      JSON.parse(row.enrichment_attempts || "[]"),
    promotion_blocked_until:  row.promotion_blocked_until,
    agent_clarification:      row.agent_clarification ? JSON.parse(row.agent_clarification) : null,
  };
}

/**
 * Fetch a single quarantine entry by its Pass 1 item id. Returns `null` if
 * not found.
 */
export function getQuarantineEntry(
  db: Database.Database,
  id: string,
): QuarantineEntry | null {
  const row = db.prepare(`SELECT * FROM pass2_audit_quarantine WHERE id = ?`).get(id) as QuarantineRow | undefined;
  if (!row) return null;
  return rowToEntry(row);
}

/**
 * List quarantine entries matching the given filters. All filters are optional
 * and AND-combined. Sorted by `quarantined_at` DESC (most recent first).
 *
 * `failure_reason` is a SUBSTRING match (LIKE %term%) — useful for finding all
 * entries with a specific failure pattern (e.g. "missing=[implication]") which
 * is the debt-3 composition-shift signal from §3.
 */
export function getQuarantineEntries(
  db: Database.Database,
  filters: QuarantineFilters = {},
): QuarantineEntry[] {
  const where: string[] = [];
  const params: Record<string, unknown> = {};

  if (filters.batch_id !== undefined) {
    where.push("batch_id = @batch_id");
    params.batch_id = filters.batch_id;
  }
  if (filters.source_session_id !== undefined) {
    where.push("source_session_id = @session");
    params.session = filters.source_session_id;
  }
  if (filters.queued_for_enrichment !== undefined) {
    where.push("queued_for_enrichment = @queued");
    params.queued = filters.queued_for_enrichment ? 1 : 0;
  }
  if (filters.failure_reason !== undefined) {
    where.push("pass2b_failure_reason LIKE @reason");
    params.reason = `%${filters.failure_reason}%`;
  }
  // `project` filter is intentionally NOT implemented yet — quarantine entries
  // don't carry a project column. If we need this, add a project column to the
  // entry shape (Pass 2a does emit a project — pipe it through). Defer until
  // there's a real use case.

  const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
  const rows = db.prepare(
    `SELECT * FROM pass2_audit_quarantine ${whereSql} ORDER BY quarantined_at DESC`
  ).all(params) as QuarantineRow[];

  return rows.map(rowToEntry);
}

/**
 * Count quarantine entries — cheap aggregate for the tier-based signal monitor
 * referenced in §3. Returns total + grouped-by-failure_reason for composition
 * analysis.
 *
 * NOTE: this is the lowest-level primitive. Tier interpretation (Watch / Notice
 * / Investigate / Rollback per §3) lives in the telemetry layer, not here.
 */
export function summarizeQuarantine(db: Database.Database): {
  total: number;
  by_failure_reason: Array<{ reason: string; count: number }>;
  by_session: Array<{ session_id: string; count: number }>;
} {
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM pass2_audit_quarantine`).get() as { n: number }).n;

  const byReason = db.prepare(`
    SELECT pass2b_failure_reason AS reason, COUNT(*) AS n
    FROM pass2_audit_quarantine
    GROUP BY pass2b_failure_reason
    ORDER BY n DESC
  `).all() as Array<{ reason: string; n: number }>;

  const bySession = db.prepare(`
    SELECT source_session_id AS session_id, COUNT(*) AS n
    FROM pass2_audit_quarantine
    GROUP BY source_session_id
    ORDER BY n DESC
  `).all() as Array<{ session_id: string; n: number }>;

  return {
    total,
    by_failure_reason: byReason.map((r) => ({ reason: r.reason, count: r.n })),
    by_session:        bySession.map((r) => ({ session_id: r.session_id, count: r.n })),
  };
}
