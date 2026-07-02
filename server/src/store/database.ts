import Database from "better-sqlite3";
import { cosineSim } from "../engine/vector-math.js";
import fs from "fs";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import CryptoJS from "crypto-js";

// ─── Types ───────────────────────────────────────────────────────
export interface Block {
  [key: string]: string | number | boolean | null;
  id: string;
  label: string;
  type: string;
  status: string;
  ttl: string;
  essence: string;
  content: string; // JSON string of full content
  source: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  last_accessed: string;
  access_count: number;
  concepts: string; // JSON array of concept tags — first-class for recall scoring
  aliases: string; // JSON array
  embedding: string | null; // JSON array of numbers
  is_sensitive: boolean; // Indicates if essence and content are encrypted
  locked: boolean; // If true, block cannot be updated without force:true
  enriched_at: string | null; // ISO timestamp of last Gemini concept enrichment
  quality_score: number; // 0–5 computed at save time — used to weight recall ranking
  last_challenged_at: string | null; // ISO timestamp of last adversarial challenge run (null = never, set by adversarial challenger)
  priority: string | null; // null | 'high' | 'medium' | 'low' — agent-set importance signal
  flow_role: string | null; // null | 'problem' | 'cause' | 'mechanism' | 'outcome' | 'solution' | 'trigger'
  chain_id: string | null;  // groups blocks that form one reasoning chain — stamped by workspace_derive
  review_status: string | null; // null | 'needs_review' | 'reviewed_ok' | 'corrected'
  review_reason: string | null; // 'weak_match' | 'type_override' | 'no_evidence' | 'project_uncertain'
  last_reflected_at: string | null; // ISO timestamp — last time this block was loaded as context in a reflect session
  project_id: string | null; // direct FK to the owning project block — replaces part_of relation for non-project blocks
}

export interface NearDuplicateConflict {
  id: string;
  block_a_id: string;
  block_b_id: string;
  similarity: number;
  detected_at: string;
  resolved: boolean;
  resolution: string | null;
}

export interface Relation {
  id: string;
  source_id: string;
  target_id: string;
  type: string;
  bidirectional: boolean;
  created_by: string | null;
  created_at: string;
  status: string; // 'active' | 'pending'
  valid_from: string | null; // ISO timestamp — when this relation became true
  valid_to: string | null;   // ISO timestamp — when it stopped being true (null = still valid)
}

export interface HistoryEntry {
  id: string;
  block_id: string;
  field_changed: string;
  old_value: string | null;
  new_value: string | null;
  changed_by: string | null;
  changed_at: string;
  reason: string | null;
}

export interface BlockTypeDef {
  name: string;
  extends: string;
  description: string;
  typical_fields: string; // JSON array
}

export interface RelationTypeDef {
  name: string;
  inverse: string | null;
  description: string;
}

export interface ProjectLog {
  id: string;
  project: string;
  entry: string;
  created_at: string;
}

// ─── Reflect Job Persistence ─────────────────────────────────────
// Jobs are written to SQLite so they survive server restarts and sustained Gemini outages.
// Lifecycle: pending → processing → done | dead
//            pending → processing → retry_wait → pending (on 503)
export type ReflectJobStatus = 'pending' | 'processing' | 'retry_wait' | 'done' | 'dead';

export interface ReflectJobRow {
  id: string;
  status: ReflectJobStatus;
  agent_id: string | null;
  payload: string;       // JSON: agentResponse, userMessage, loadedBlockIds, agentThinking
  precomputed: string | null;  // JSON: { pass1?, pass2? } — partial progress
  retry_attempts: number;
  retry_after: number | null;  // epoch ms
  created_at: number;          // epoch ms
  updated_at: number;          // epoch ms
  error: string | null;
}

// ─── DEBT 5: Conversation Turns + Ranges (Variant A persistence) ─────────────
// Per design §2.1, §2.2. agent_id is the conversation identifier (matches
// existing convention: agent_registry, ReflectJob, chat-proxy header).
//
// Lifecycle:
//   captured     — INSERT on Stop event; transcript saved, Pass 0-1 not yet run
//   pass01_done  — UPDATE after Pass 0-1 completes per-turn; pass01_output_json set
//   extracted    — UPDATE on arc-extract completion; extracted_at + pairing_range_id set
// Charter Rule 2: rows are forward-only-archived; re-extraction creates NEW
// conversation_turn_ranges instead of mutating pairing_range_id.

export type ConversationTurnStatus = 'captured' | 'pass01_done' | 'extracted';

export interface ConversationTurnRow {
  id: string;
  agent_id: string;
  turn_number: number;
  turn_name: string | null;
  transcript_json: string;            // {user_message, agent_response, agent_thinking}
  pass01_output_json: string | null;  // {scene_card, items[]} from Pass 0-1; NULL until completes
  pass01_completed_at: string | null;
  status: ConversationTurnStatus;
  created_at: string;
  extracted_at: string | null;
  pairing_range_id: string | null;    // FK → conversation_turn_ranges.id, NULL until extracted
  last_extract_error: string | null;       // followup 1: last FAILED arc attempt's error (turn STAYS pass01_done = re-extractable)
  last_extract_attempt_at: string | null;  // when that failed attempt ran
}

export type ConversationExtractionType = 'arc' | 're-extract';

export interface ConversationTurnRangeRow {
  id: string;
  agent_id: string;
  start_turn_number: number;
  end_turn_number: number;
  extraction_type: ConversationExtractionType;
  extracted_at: string;
  trigger_source: string | null;       // 'phase_tag' | 'mcp_tool' | 'api' | 'precompact' | 'inactivity'
  pipeline_run_id: string | null;      // cross-ref to turn-log / cost audit
  superseded_range_id: string | null;  // FK → prior range this re-extraction supersedes
}

// ─── Database ────────────────────────────────────────────────────
export class WorkspaceDB {
  private db: Database.Database | null = null;
  public dbPath: string;

  constructor(dbPath?: string) {
    this.dbPath = dbPath
      || process.env.WORKSPACE_DB_PATH
      || path.resolve(__dirname, "../../../data/workspace.db");
  }

  // Kept async for API compatibility with server.ts callers
  async init(): Promise<void> {
    const dir = path.dirname(this.dbPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    this.db = new Database(this.dbPath);

    // Encryption at rest (security slice 2). OPT-IN: when NODEDEX_DB_ENCRYPTION_KEY
    // is set, key the connection (SQLCipher via better-sqlite3-multiple-ciphers)
    // BEFORE any other statement — the PRAGMA key must come first. Unset = plaintext
    // (the default, unchanged). File-level (whole DB encrypted on disk, decrypted in
    // memory) so keyword search + embeddings still work — unlike the per-block
    // WORKSPACE_ENCRYPTION_KEY layer, which encrypts individual fields. An EXISTING
    // plaintext DB must be migrated first (scripts/db-encryption.mjs); opening a
    // plaintext DB WITH a key is caught below and fails loudly rather than corrupting.
    const encKey = process.env.NODEDEX_DB_ENCRYPTION_KEY;
    if (encKey && encKey.length > 0) {
      this.db.pragma(`key = '${encKey.replace(/'/g, "''")}'`);
      try {
        this.db.prepare("SELECT count(*) FROM sqlite_master").get();
      } catch {
        throw new Error(
          "NODEDEX_DB_ENCRYPTION_KEY is set but the database could not be opened with it. " +
          "The DB is likely plaintext (migrate it: `node scripts/db-encryption.mjs encrypt <db-path>`) " +
          "or the key is wrong."
        );
      }
    }

    // WAL mode: faster writes, allows concurrent readers
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");

    this.createTables();
    this.runMigrations();
  }

  // No-op: better-sqlite3 writes directly to disk on every statement
  save(): void {}

  /**
   * Close the underlying connection, releasing the DB file lock. Used on graceful
   * shutdown so a restart doesn't fight a lingering handle (the stale-process trap:
   * a zombie server holding workspace.db made it un-deletable / un-swappable).
   * Idempotent.
   */
  close(): void {
    try { this.db?.close(); } catch { /* already closed */ }
    this.db = null;
  }

  /**
   * Raw better-sqlite3 Database accessor. Added 2026-05-25 to allow new
   * middleware tables (e.g. `pass2_audit_quarantine` from the Pass 2 split
   * orchestrator) to manage their own schema without going through every
   * WorkspaceDB method. Use sparingly — direct access bypasses the wrapper's
   * encryption + status conventions, so it's appropriate only for tables
   * the wrapper does not own.
   */
  public get rawDb(): Database.Database {
    if (!this.db) throw new Error("Database not initialized — call init() first");
    return this.db;
  }

  // ─── Cryptography ────────────────────────────────────────────────

  private getEncryptionKey(): string {
    const key = process.env.WORKSPACE_ENCRYPTION_KEY;
    if (!key) {
      throw new Error("WORKSPACE_ENCRYPTION_KEY environment variable is required to save or read sensitive blocks.");
    }
    return key;
  }

  private encryptText(text: string): string {
    return CryptoJS.AES.encrypt(text, this.getEncryptionKey()).toString();
  }

  private decryptText(ciphertext: string): string {
    const bytes = CryptoJS.AES.decrypt(ciphertext, this.getEncryptionKey());
    return bytes.toString(CryptoJS.enc.Utf8);
  }

  private createTables(): void {
    if (!this.db) throw new Error("Database not initialized");

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS blocks (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        type TEXT NOT NULL DEFAULT 'note',
        status TEXT NOT NULL DEFAULT 'created',
        ttl TEXT NOT NULL DEFAULT 'permanent',
        project_id TEXT,
        essence TEXT NOT NULL DEFAULT '',
        content TEXT NOT NULL DEFAULT '{}',
        source TEXT,
        created_by TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_accessed TEXT NOT NULL,
        access_count INTEGER NOT NULL DEFAULT 0,
        concepts TEXT NOT NULL DEFAULT '[]',
        aliases TEXT NOT NULL DEFAULT '[]',
        embedding TEXT,
        is_sensitive INTEGER NOT NULL DEFAULT 0
      )
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS relations (
        id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL,
        target_id TEXT NOT NULL,
        type TEXT NOT NULL,
        bidirectional INTEGER NOT NULL DEFAULT 0,
        created_by TEXT,
        created_at TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        FOREIGN KEY (source_id) REFERENCES blocks(id),
        FOREIGN KEY (target_id) REFERENCES blocks(id)
      )
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS block_history (
        id TEXT PRIMARY KEY,
        block_id TEXT NOT NULL,
        field_changed TEXT NOT NULL,
        old_value TEXT,
        new_value TEXT,
        changed_by TEXT,
        changed_at TEXT NOT NULL,
        reason TEXT,
        FOREIGN KEY (block_id) REFERENCES blocks(id)
      )
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS block_types (
        name TEXT PRIMARY KEY,
        extends TEXT NOT NULL,
        description TEXT NOT NULL,
        typical_fields TEXT NOT NULL DEFAULT '[]'
      )
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS relation_types (
        name TEXT PRIMARY KEY,
        inverse TEXT,
        description TEXT NOT NULL
      )
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS project_logs (
        id TEXT PRIMARY KEY,
        project TEXT NOT NULL,
        entry TEXT NOT NULL,
        created_at TEXT NOT NULL
      )
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS recall_log (
        id TEXT PRIMARY KEY,
        block_id TEXT NOT NULL,
        recalled_at TEXT NOT NULL,
        project_id TEXT,
        reason TEXT,
        used INTEGER NOT NULL DEFAULT 0,
        FOREIGN KEY (block_id) REFERENCES blocks(id)
      )
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS near_duplicate_conflicts (
        id TEXT PRIMARY KEY,
        block_a_id TEXT NOT NULL,
        block_b_id TEXT NOT NULL,
        similarity REAL NOT NULL,
        detected_at TEXT NOT NULL,
        resolved INTEGER NOT NULL DEFAULT 0,
        resolution TEXT,
        FOREIGN KEY (block_a_id) REFERENCES blocks(id),
        FOREIGN KEY (block_b_id) REFERENCES blocks(id)
      )
    `);

    // Agent registry — tracks live agents with heartbeat
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_registry (
        agent_id TEXT PRIMARY KEY,
        role TEXT NOT NULL DEFAULT 'general',
        last_heartbeat TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        current_task TEXT,
        metadata TEXT NOT NULL DEFAULT '{}'
      )
    `);

    // Block claims — separate table for atomic, auditable ownership
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS block_claims (
        block_id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        claimed_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        FOREIGN KEY (block_id) REFERENCES blocks(id)
      )
    `);

    // ── Write audit log — captures ALL writes regardless of path (tool, API, or direct SQL) ──
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS write_log (
        id          TEXT PRIMARY KEY,
        table_name  TEXT NOT NULL,
        operation   TEXT NOT NULL,
        row_id      TEXT NOT NULL,
        snapshot    TEXT,
        changed_at  TEXT NOT NULL
      )
    `);

    // SQLite triggers — fire on every INSERT/UPDATE to blocks and relations
    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS wlog_block_insert
      AFTER INSERT ON blocks
      BEGIN
        INSERT INTO write_log (id, table_name, operation, row_id, snapshot, changed_at)
        VALUES (lower(hex(randomblob(8))), 'blocks', 'INSERT', NEW.id,
          json_object('label', NEW.label, 'type', NEW.type, 'essence', NEW.essence),
          datetime('now'));
      END
    `);

    // wlog_block_update is managed in runMigrations() so it can be rebuilt when the schema changes

    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS wlog_relation_insert
      AFTER INSERT ON relations
      BEGIN
        INSERT INTO write_log (id, table_name, operation, row_id, snapshot, changed_at)
        VALUES (lower(hex(randomblob(8))), 'relations', 'INSERT', NEW.id,
          json_object('source_id', NEW.source_id, 'target_id', NEW.target_id, 'type', NEW.type),
          datetime('now'));
      END
    `);

    // Reflect job queue — persists jobs across server restarts and Gemini outages
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS reflect_jobs (
        id             TEXT PRIMARY KEY,
        status         TEXT NOT NULL DEFAULT 'pending',
        agent_id       TEXT,
        payload        TEXT NOT NULL,
        precomputed    TEXT,
        retry_attempts INTEGER NOT NULL DEFAULT 0,
        retry_after    INTEGER,
        created_at     INTEGER NOT NULL,
        updated_at     INTEGER NOT NULL,
        error          TEXT
      )
    `);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_reflect_jobs_status ON reflect_jobs(status)`);

    // ─── DEBT 5 Phase 1: arc-extraction persistence layer ─────────────────────
    //
    // conversation_turns: per-turn transcript + pass 0-1 intermediate state.
    // INSERT on Stop event (status='captured'), UPDATE after per-turn Pass 0-1
    // completes (status='pass01_done'), UPDATE on arc-extract completion
    // (status='extracted', pairing_range_id set). Per Variant A: NO graph
    // blocks are written per-turn; only at arc time.
    //
    // Naming per inventory §5/§10 (GATE 5): agent_id matches existing
    // convention (agent_registry, agent_session_state_<id>, reflect-buffer,
    // ReflectJob, chat-proxy x-nodedex-agent-id header).
    //
    // Charter Rule 2 (never delete): rows are forward-only-archived; even
    // re-extraction creates NEW conversation_turn_ranges rather than mutating
    // pairing_range_id. See design §2.5.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS conversation_turns (
        id                  TEXT PRIMARY KEY,
        agent_id            TEXT NOT NULL,
        turn_number         INTEGER NOT NULL,
        turn_name           TEXT,
        transcript_json     TEXT NOT NULL,
        pass01_output_json  TEXT,
        pass01_completed_at TEXT,
        status              TEXT NOT NULL DEFAULT 'captured',
        created_at          TEXT NOT NULL,
        extracted_at        TEXT,
        pairing_range_id    TEXT,
        UNIQUE (agent_id, turn_number)
      )
    `);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_conv_turns_agent  ON conversation_turns(agent_id)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_conv_turns_status ON conversation_turns(status)`);

    // conversation_turn_ranges: extraction-batch entity. One row per arc-or-
    // re-extract event (atomic per-turn extractions don't create rows — they
    // are implicit). Per design §2.2.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS conversation_turn_ranges (
        id                  TEXT PRIMARY KEY,
        agent_id            TEXT NOT NULL,
        start_turn_number   INTEGER NOT NULL,
        end_turn_number     INTEGER NOT NULL,
        extraction_type     TEXT NOT NULL,
        extracted_at        TEXT NOT NULL,
        trigger_source      TEXT,
        pipeline_run_id     TEXT,
        superseded_range_id TEXT
      )
    `);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_ctr_agent ON conversation_turn_ranges(agent_id)`);

    // block_extractions: provenance join. Each arc-extracted block points back
    // to the conversation_turn_ranges row it was emitted from. Per design §2.3
    // the conceptual relation was `extracted_from`; we use a dedicated join
    // table because relations.target_id has a FK to blocks(id) and a turn-range
    // is not a block (it COULD become one per §2.4-deferred, but for Phase 9
    // the join table is cheaper and queryable). The 'extracted_from' relation
    // type seed (Phase 1) remains for the future when ranges become blocks —
    // dropping it would lose seed continuity.
    //
    // Cardinality: one row per (block, range) pair. A re-extract creates a NEW
    // range; the original block→range row stays (audit trail) and a new
    // block→new_range row joins via the same block_id (multi-row per block).
    // Query for "which range produced this block" returns the most recent row.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS block_extractions (
        id            TEXT PRIMARY KEY,
        block_id      TEXT NOT NULL,
        range_id      TEXT NOT NULL,
        extracted_at  TEXT NOT NULL,
        UNIQUE (block_id, range_id),
        FOREIGN KEY (block_id) REFERENCES blocks(id)
      )
    `);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_block_extractions_block ON block_extractions(block_id)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_block_extractions_range ON block_extractions(range_id)`);

    // DEBT 5 Slice 1 (Sub-step 1.1) — pipeline_flags: durable flag persistence
    // for the Stage FLAG mechanism. Replaces auto-drop semantics in
    // dedupBySourceAndValue (per user direction: system FLAGS, reasoning MERGES).
    //
    // Multi-writer table: Stage FLAG (Sub-step 1.4), Stage AUDIT (Slice 2),
    // Stage C entity-unresolved (Sub-step 1.2). Consumed by async LLM reviewer
    // (Slice 2). origin_writer column discriminates source.
    //
    // criteria_json + review/action fields stored as TEXT so flag_type families
    // can evolve without per-field column adds (pass2_audit_quarantine pattern).
    //
    // FK to conversation_turn_ranges optional (origin_range_id NULL for non-arc
    // sources like Stage AUDIT background scan).
    //
    // No writes yet in Sub-step 1.1 — table exists empty. Sub-step 1.4 wires
    // Stage FLAG to call writePipelineFlag (pipeline-flags.ts module).
    this.db.exec(`
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
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_pipeline_flags_unreviewed
      ON pipeline_flags(reviewed_at) WHERE reviewed_at IS NULL`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_pipeline_flags_type
      ON pipeline_flags(flag_type)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_pipeline_flags_block_a
      ON pipeline_flags(block_id_a)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_pipeline_flags_origin_writer
      ON pipeline_flags(origin_writer)`);

    // Indexes for performance
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_blocks_label ON blocks(label)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_blocks_type ON blocks(type)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_blocks_status ON blocks(status)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_relations_source ON relations(source_id)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_relations_target ON relations(target_id)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_history_block ON block_history(block_id)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_project_logs_project ON project_logs(project)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_write_log_table ON write_log(table_name, changed_at)`);
  }

  private runMigrations(): void {
    if (!this.db) throw new Error("Database not initialized");
    try { this.db.exec(`ALTER TABLE blocks ADD COLUMN is_sensitive INTEGER NOT NULL DEFAULT 0`); } catch { /* exists */ }
    try { this.db.exec(`ALTER TABLE relations ADD COLUMN status TEXT NOT NULL DEFAULT 'active'`); } catch { /* exists */ }
    try { this.db.exec(`ALTER TABLE blocks ADD COLUMN locked INTEGER NOT NULL DEFAULT 0`); } catch { /* exists */ }
    try { this.db.exec(`ALTER TABLE blocks ADD COLUMN enriched_at TEXT`); } catch { /* exists */ }
    // followup 1: failed-attempt marker on conversation_turns (non-destructive — the
    // turn stays pass01_done = re-extractable; lets the freshness surface tell
    // "queued/coming" from "last attempt failed").
    try { this.db.exec(`ALTER TABLE conversation_turns ADD COLUMN last_extract_error TEXT`); } catch { /* exists */ }
    try { this.db.exec(`ALTER TABLE conversation_turns ADD COLUMN last_extract_attempt_at TEXT`); } catch { /* exists */ }
    try { this.db.exec(`CREATE INDEX IF NOT EXISTS idx_recall_log_block ON recall_log(block_id)`); } catch { /* exists */ }
    try { this.db.exec(`CREATE INDEX IF NOT EXISTS idx_recall_log_used ON recall_log(used)`); } catch { /* exists */ }

    // Bitemporal edge modeling — valid_from/valid_to on relations
    try { this.db.exec(`ALTER TABLE relations ADD COLUMN valid_from TEXT`); } catch { /* exists */ }
    try { this.db.exec(`ALTER TABLE relations ADD COLUMN valid_to TEXT`); } catch { /* exists */ }
    // Back-fill valid_from for existing relations
    try { this.db.exec(`UPDATE relations SET valid_from = created_at WHERE valid_from IS NULL`); } catch { /* */ }

    // First-class concepts column on blocks
    try { this.db.exec(`ALTER TABLE blocks ADD COLUMN concepts TEXT NOT NULL DEFAULT '[]'`); } catch { /* exists */ }
    // Back-fill: migrate concepts stored in content JSON into the new column
    try {
      const rows = this.db.prepare(`SELECT id, content FROM blocks WHERE concepts = '[]'`).all() as Array<{ id: string; content: string }>;
      const upd = this.db.prepare(`UPDATE blocks SET concepts = ? WHERE id = ?`);
      const migrate = this.db.transaction(() => {
        for (const row of rows) {
          try {
            const c = JSON.parse(row.content);
            const extracted: string[] = c?.concepts || [];
            if (extracted.length > 0) upd.run(JSON.stringify(extracted), row.id);
          } catch { /* skip */ }
        }
      });
      migrate();
    } catch { /* */ }
    try { this.db.exec(`CREATE INDEX IF NOT EXISTS idx_blocks_concepts ON blocks(concepts)`); } catch { /* exists */ }

    // quality_score — persisted so recall can weight by block depth
    try { this.db.exec(`ALTER TABLE blocks ADD COLUMN quality_score INTEGER NOT NULL DEFAULT 0`); } catch { /* exists */ }

    // source_type — provenance enum: who/what created this block
    try { this.db.exec(`ALTER TABLE blocks ADD COLUMN source_type TEXT NOT NULL DEFAULT 'agent_derived'`); } catch { /* exists */ }

    // last_challenged_at — when the adversarial challenger last ran on this block
    try { this.db.exec(`ALTER TABLE blocks ADD COLUMN last_challenged_at TEXT`); } catch { /* exists */ }
    try { this.db.exec(`ALTER TABLE blocks ADD COLUMN priority TEXT`); } catch { /* exists */ }
    try { this.db.exec(`ALTER TABLE blocks ADD COLUMN flow_role TEXT`); } catch { /* exists */ }
    try { this.db.exec(`ALTER TABLE blocks ADD COLUMN chain_id TEXT`); } catch { /* exists */ }
    // Repair: updateBlock used to stringify null (typeof null === "object" →
    // JSON.stringify(null) = 'null'), so Pass 5's chain_id cleanup wrote the literal
    // string into standalone blocks — which then read as members of one fake "null"
    // chain. Only the corrupt literals are repaired; blk_/UUID/chain_ values are the
    // three legitimate chain_id families and must not be touched. Idempotent.
    try { this.db.exec(`UPDATE blocks SET chain_id = NULL WHERE chain_id IN ('null', 'undefined')`); } catch { /* */ }
    try { this.db.exec(`ALTER TABLE blocks ADD COLUMN review_status TEXT`); } catch { /* exists */ }
    try { this.db.exec(`ALTER TABLE blocks ADD COLUMN review_reason TEXT`); } catch { /* exists */ }
    try { this.db.exec(`ALTER TABLE blocks ADD COLUMN last_reflected_at TEXT`); } catch { /* exists */ }
    try { this.db.exec(`CREATE INDEX IF NOT EXISTS idx_blocks_last_reflected ON blocks(last_reflected_at)`); } catch { /* exists */ }

    // ─── DEBT 5 Phase 1 (D3): source_excerpt — line-level provenance ──────────
    // Per design §2.3.2: each arc-extracted block carries the exact transcript
    // text it was extracted from (80-600 chars, sentence-boundary truncated).
    // Composes with extracted_from relation (turn-range pointer) but is
    // strictly stronger (line-level vs turn-level provenance). Solves: dedup-
    // by-content (D2), audit navigability, quality verification, re-extraction
    // supersedes wiring, provider-variance robustness (per [[project-pass1-pass2a-
    // provider-drift-2026-05-30]] — LLM-typing varies; source-pin doesn't).
    //
    // NULL signals "pre-Debt-5 atomic block" — dedup logic must NEVER match
    // two NULL excerpts as duplicates. Index is partial (NULL excluded) to
    // keep it tight; only arc-extracted blocks live in the index.
    try { this.db.exec(`ALTER TABLE blocks ADD COLUMN source_excerpt TEXT`); } catch { /* exists */ }
    try { this.db.exec(`CREATE INDEX IF NOT EXISTS idx_blocks_source_excerpt ON blocks(source_excerpt) WHERE source_excerpt IS NOT NULL`); } catch { /* exists */ }

    // Unique label constraint — prevents silent duplicate rows on same label.
    // Dedup first (keep newest per label), then replace non-unique index with unique one.
    try {
      this.db.exec(`
        DELETE FROM blocks WHERE rowid NOT IN (
          SELECT MAX(rowid) FROM blocks GROUP BY label
        )
      `);
      this.db.exec(`DROP INDEX IF EXISTS idx_blocks_label`);
      this.db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_blocks_label ON blocks(label)`);
    } catch { /* already unique or other error — leave as-is */ }

    // Agent registry extensions: name + created_at for multi-agent support
    try { this.db.exec(`ALTER TABLE agent_registry ADD COLUMN name TEXT`); } catch { /* exists */ }
    try { this.db.exec(`ALTER TABLE agent_registry ADD COLUMN created_at TEXT`); } catch { /* exists */ }

    // project_id column — direct FK to owning project, replaces part_of relation for non-project blocks
    try { this.db.exec(`ALTER TABLE blocks ADD COLUMN project_id TEXT`); } catch { /* exists */ }
    // Back-fill project_id from existing part_of relations
    try {
      this.db.exec(`
        UPDATE blocks SET project_id = (
          SELECT r.target_id FROM relations r
          WHERE r.source_id = blocks.id AND r.type = 'part_of'
            AND r.status = 'active' AND r.valid_to IS NULL
          LIMIT 1
        )
        WHERE project_id IS NULL AND type != 'project'
      `);
    } catch { /* */ }

    // Remove confidence column — replaced by quality_score + recency
    // Trigger must be dropped first because it referenced NEW.confidence
    try {
      this.db.exec(`DROP TRIGGER IF EXISTS wlog_block_update`);
      this.db.exec(`
        CREATE TRIGGER wlog_block_update
        AFTER UPDATE ON blocks
        BEGIN
          INSERT INTO write_log (id, table_name, operation, row_id, snapshot, changed_at)
          VALUES (lower(hex(randomblob(8))), 'blocks', 'UPDATE', NEW.id,
            json_object('label', NEW.label, 'type', NEW.type, 'essence', NEW.essence),
            datetime('now'));
        END
      `);
    } catch { /* */ }
    try { this.db.exec(`ALTER TABLE blocks DROP COLUMN confidence`); } catch { /* already dropped or old SQLite */ }
    try { this.db.exec(`ALTER TABLE relations DROP COLUMN confidence`); } catch { /* already dropped or old SQLite */ }

    // Seed built-in relation types (idempotent)
    const seedRelations = this.db.prepare(`INSERT OR IGNORE INTO relation_types (name, inverse, description) VALUES (?, ?, ?)`);
    const builtinRelations: [string, string | null, string][] = [
      ["related_to",       "related_to",       "Generic bidirectional association"],
      ["part_of",          "contains",         "Block belongs to a parent entity"],
      ["contains",         "part_of",          "Parent entity contains this block"],
      ["derived_from",     "produced",         "Block was reasoned or inferred from source"],
      ["produced",         "derived_from",     "Source that produced a derived block"],
      ["based_on",         null,               "Decision or conclusion grounded in evidence"],
      ["contradicts",      "contradicts",      "Blocks hold conflicting information"],
      ["extends",          null,               "Block builds upon or refines another"],
      ["affects",          "affected_by",      "Block influences another"],
      ["affected_by",      "affects",          "Block is influenced by another"],
      ["implements",       "implemented_by",   "Block realizes a higher-level concept"],
      ["implemented_by",   "implements",       "Higher-level concept realized by this block"],
      ["describes",        "described_by",     "Block provides description of another"],
      ["described_by",     "describes",        "Block is described by another"],
      ["supersedes",       "superseded_by",    "Block replaces an older block"],
      ["superseded_by",    "supersedes",       "Block has been replaced by a newer one"],
      ["depends_on",       null,               "Block requires another to function"],
      ["enables",          null,               "Block makes another possible"],
      ["prompted_by",      "triggered",        "This block was cognitively triggered by reading the target block — distinct from derived_from (logical) and related_to (loose)"],
      ["triggered",        "prompted_by",      "Target block prompted the creation of this block"],
      // member_of — Pass 5 writes one row per (member block, chain block) pair.
      // Many-to-many: a block can participate in multiple narrative arcs (e.g.
      // when Pass 5 emits overlapping chains through shared blocks). The chain
      // block's `members[]` field is the canonical ORDERED narrative; this
      // relation is the unordered fact-of-membership, enabling reverse lookup
      // ("which chains contain this block?") without losing memberships to
      // chain_id column overwrites. Per debt-4 §2.3 + S1.3 root cause.
      // Inverse: null — the chain block's `members[]` carries the canonical
      // ordering; a `has_member` inverse would duplicate that information in
      // a worse shape (unordered rows vs ordered array).
      ["member_of",        null,               "Block participates in a chain's narrative arc (many-to-many; chain.members[] is the canonical ordering)"],
      // extracted_from — Debt 5 §2.3. Block was extracted from a specific
      // conversation_turn_ranges row. Direction: block → range. Inverse: null
      // (reverse query is `SELECT * FROM relations WHERE target_id=<range_id>
      // AND type='extracted_from'`). Cardinality: each block has 0 or 1
      // extracted_from (one extraction event creates one wiring; re-extraction
      // creates NEW blocks with NEW extracted_from to the new range).
      // Composes with the per-block source_excerpt column (line-level
      // provenance) — extracted_from gives turn-range scope, source_excerpt
      // pins the exact source line.
      ["extracted_from",   null,               "Block was extracted from a specific conversation_turn_ranges row — the turn-range provenance audit link (composes with source_excerpt column for line-level pinning)"],
    ];
    for (const [name, inverse, description] of builtinRelations) {
      try { seedRelations.run(name, inverse, description); } catch { /* skip */ }
    }

    // Seed built-in block types (idempotent)
    const seedTypes = this.db.prepare(`INSERT OR IGNORE INTO block_types (name, extends, description, typical_fields) VALUES (?, ?, ?, ?)`);
    const builtinTypes: [string, string, string][] = [
      // Core DB types
      ["fact",            "base", "Verified piece of information"],
      ["insight",         "base", "Synthesized understanding from multiple facts"],
      ["decision",        "base", "A choice made with reasoning"],
      ["constraint",      "base", "A limitation or hard requirement"],
      ["note",            "base", "General observation or annotation"],
      ["process",         "base", "A repeatable procedure or workflow"],
      ["project",         "base", "A container for related work"],
      ["question",        "base", "An open question to be resolved"],
      ["task",            "base", "An actionable item with status"],
      ["dead_end",        "base", "An approach that was tried and failed"],
      ["draft",           "base", "Work-in-progress not yet verified"],
      ["artifact",        "base", "A file, document, or generated output"],
      // Extended types used by Gemini auto-reflect
      ["hypothesis",      "fact", "A proposed explanation not yet confirmed — could be wrong"],
      ["preference",      "decision", "A strong user preference or non-negotiable rule"],
      ["blueprint",       "process", "A deferred design or feature plan — not built yet"],
      ["entity",          "note", "A named thing in the domain — person, user type, organization, component"],
      ["event",           "note", "Something that occurred — launch, incident, experiment result"],
      // reasoning_chain/metric/claim collapsed → insight/fact (2026-06-15); removed from the
      // seed so new DBs don't advertise them. Rows already seeded in existing DBs are pruned
      // separately via the admin migration (INSERT OR IGNORE never deletes). entity KEPT —
      // the pipeline auto-creates entity blocks as label sub-group containers (structural).
    ];
    for (const [name, extends_, description] of builtinTypes) {
      try { seedTypes.run(name, extends_, description, "[]"); } catch { /* skip */ }
    }
  }

  // Convert raw DB row (with 0/1 integers) to typed Block
  private rowToBlock(row: Record<string, unknown>): Block {
    return {
      ...row,
      is_sensitive: row.is_sensitive === 1 || row.is_sensitive === true,
      locked: row.locked === 1 || row.locked === true,
    } as Block;
  }

  private decryptBlockIfSensitive(block: Block): Block {
    if (!block.is_sensitive) return block;
    try {
      return {
        ...block,
        essence: this.decryptText(block.essence),
        content: this.decryptText(block.content),
      };
    } catch {
      return block;
    }
  }

  // ─── Block CRUD ──────────────────────────────────────────────

  createBlock(params: {
    label: string;
    type: string;
    essence: string;
    content?: Record<string, unknown>;
    ttl?: string;
    status?: string;
    source?: string;
    concepts?: string[];
    aliases?: string[];
    embedding?: number[];
    is_sensitive?: boolean;
    created_by?: string;
    project_id?: string;
    // DEBT 5 D3 (§2.3.2): line-level provenance. The exact transcript text
    // this block was extracted from (Pass 1 emits, Pass 2 carries, Pass 3
    // persists). NULL = pre-Debt-5 atomic convention; do NOT default to ""
    // because dedup logic (D2 §2.5.1) MUST distinguish NULL from "" (empty
    // is an explicit "no excerpt available," NULL is "this block predates
    // the pinning era").
    source_excerpt?: string;
  }): Block {
    if (!this.db) throw new Error("Database not initialized");

    const now = new Date().toISOString();
    const id = `blk_${uuidv4().slice(0, 8)}`;

    let finalEssence = params.essence;
    let finalContent = JSON.stringify(params.content || {});

    if (params.is_sensitive) {
      finalEssence = this.encryptText(finalEssence);
      finalContent = this.encryptText(finalContent);
    }

    const conceptsJson = JSON.stringify(params.concepts || []);

    const insertResult = this.db.prepare(
      `INSERT OR IGNORE INTO blocks (id, label, type, status, ttl, project_id, essence, content, source, source_type, created_by, created_at, updated_at, last_accessed, access_count, concepts, aliases, embedding, is_sensitive, source_excerpt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id, params.label, params.type || "note", params.status || "created",
      params.ttl || "permanent",
      params.project_id || null,
      finalEssence, finalContent, params.source || null,
      (params as any).source_type || "agent_derived",
      params.created_by || null,
      now, now, now, 0,
      conceptsJson,
      JSON.stringify(params.aliases || []),
      params.embedding ? JSON.stringify(params.embedding) : null,
      params.is_sensitive ? 1 : 0,
      params.source_excerpt ?? null,
    );

    // Duplicate label — merge unique fields into existing block instead of creating a second row
    if (insertResult.changes === 0) {
      const existing = this.db.prepare(
        `SELECT * FROM blocks WHERE LOWER(label) = ?`
      ).get(params.label.toLowerCase()) as any;
      if (existing) {
        // If archived, reactivate it with the new values
        if (existing.status === "archived") {
          this.db.prepare(
            `UPDATE blocks SET status = 'active', essence = ?, ttl = ?, updated_at = ? WHERE id = ?`
          ).run(params.essence || existing.essence, params.ttl || existing.ttl, now, existing.id);
          return { ...existing, status: "active", essence: params.essence || existing.essence } as unknown as Block;
        }
        // Active block with same label — merge unique fields
        try {
          const existingContent = JSON.parse(existing.content || "{}");
          const newContent = JSON.parse(finalContent || "{}");
          const merged = {
            ...existingContent,
            unique: { ...(existingContent.unique || {}), ...(newContent.unique || {}) },
          };
          this.db.prepare(`UPDATE blocks SET content = ?, updated_at = ? WHERE id = ?`)
            .run(JSON.stringify(merged), now, existing.id);
        } catch { /* merge failed — return existing as-is */ }
        return { ...existing, id: existing.id } as unknown as Block;
      }
    }

    const block: Block = {
      id, label: params.label, type: params.type || "note",
      status: params.status || "created",
      ttl: params.ttl || "permanent",
      essence: params.is_sensitive ? finalEssence : params.essence,
      content: params.is_sensitive ? finalContent : JSON.stringify(params.content || {}),
      source: params.source || null, created_by: params.created_by || null,
      created_at: now, updated_at: now, last_accessed: now, access_count: 0,
      concepts: conceptsJson,
      aliases: JSON.stringify(params.aliases || []),
      embedding: params.embedding ? JSON.stringify(params.embedding) : null,
      is_sensitive: params.is_sensitive || false, locked: false, enriched_at: null,
      quality_score: 0, // updated immediately after creation via workspace_remember
      last_challenged_at: null,
      priority: (params as any).priority || null,
      flow_role: (params as any).flow_role || null,
      chain_id: (params as any).chain_id || null,
      review_status: (params as any).review_status || null,
      review_reason: (params as any).review_reason || null,
      last_reflected_at: null,
      project_id: params.project_id || null,
    };

    if (block.is_sensitive) {
      return { ...block, essence: params.essence, content: JSON.stringify(params.content || {}) };
    }

    return block;
  }

  getBlock(idOrLabel: string): Block | null {
    if (!this.db) throw new Error("Database not initialized");

    const row = this.db.prepare(
      `SELECT * FROM blocks WHERE (id = ? OR LOWER(label) = ?)`
    ).get(idOrLabel, idOrLabel.toLowerCase()) as Record<string, unknown> | undefined;

    if (!row) return null;

    const block = this.decryptBlockIfSensitive(this.rowToBlock(row));

    this.db.prepare(
      `UPDATE blocks SET last_accessed = ?, access_count = access_count + 1,
       status = CASE WHEN status = 'stale' THEN 'active' WHEN status = 'created' THEN 'active' ELSE status END
       WHERE id = ?`
    ).run(new Date().toISOString(), block.id);

    return block;
  }

  getAllBlocks(): Block[] {
    if (!this.db) throw new Error("Database not initialized");

    const rows = this.db.prepare(
      `SELECT * FROM blocks WHERE status != 'archived'`
    ).all() as Record<string, unknown>[];

    return rows.map((row) => this.decryptBlockIfSensitive(this.rowToBlock(row)));
  }

  // Status-explicit fetch. getAllBlocks() excludes archived rows by design (the live working set);
  // listing archived/quarantined blocks requires asking for that status explicitly — without this,
  // a `?status=archived` query silently matches nothing.
  getBlocksByStatus(status: string): Block[] {
    if (!this.db) throw new Error("Database not initialized");
    const rows = this.db.prepare(
      `SELECT * FROM blocks WHERE status = ?`
    ).all(status) as Record<string, unknown>[];
    return rows.map((row) => this.decryptBlockIfSensitive(this.rowToBlock(row)));
  }

  getBlocksByChain(chainId: string): Block[] {
    if (!this.db) throw new Error("Database not initialized");
    const rows = this.db.prepare(
      `SELECT * FROM blocks WHERE chain_id = ? AND status != 'archived' ORDER BY created_at ASC`
    ).all(chainId) as Record<string, unknown>[];
    return rows.map((row) => this.decryptBlockIfSensitive(this.rowToBlock(row)));
  }

  updateBlock(
    idOrLabel: string,
    changes: Record<string, unknown>,
    reason?: string,
    changedBy?: string,
    force?: boolean
  ): Block | null {
    if (!this.db) throw new Error("Database not initialized");

    const block = this.getBlock(idOrLabel);
    if (!block) return null;

    if (block.locked && !force && !("locked" in changes)) {
      throw new Error(`Block '${block.label}' (${block.id}) is locked. Pass force:true to override.`);
    }

    const allowedFields = [
      "label", "type", "status", "ttl", "project_id",
      "essence", "content", "source", "concepts", "aliases", "embedding", "locked", "enriched_at",
      "quality_score", "last_challenged_at", "priority", "flow_role", "chain_id",
      "review_status", "review_reason",
      "source_excerpt", // gap ④(b): the provenance reviewer corrects a mis-quoted excerpt (with history)
    ];

    const now = new Date().toISOString();
    const isSensitive = block.is_sensitive;
    const fullSnapshot = JSON.stringify(block);

    for (const [field, newValue] of Object.entries(changes)) {
      if (!allowedFields.includes(field)) continue;

      const oldValue = block[field];
      // null/undefined must stay SQL NULL. `typeof null === "object"` made the old
      // code JSON.stringify(null) → the literal string 'null' landed in nullable
      // columns (hit: Pass 5's chain_id cleanup — 146 standalone blocks read as one
      // fake "null" chain). Clearing a field means NULL, never the string.
      const serializedNew = newValue == null
        ? null
        : typeof newValue === "object" ? JSON.stringify(newValue) : String(newValue);

      let dbValue = serializedNew;
      const isEncryptedField = isSensitive && (field === "essence" || field === "content");

      if (isEncryptedField && serializedNew !== null) dbValue = this.encryptText(serializedNew);

      const histOldValue = (field === "essence" || field === "content") && !isEncryptedField
        ? JSON.stringify({ snapshot: fullSnapshot, field_value: String(oldValue ?? "") })
        : isEncryptedField
          ? "[ENCRYPTED]"
          : (typeof oldValue === "object" ? JSON.stringify(oldValue) : String(oldValue ?? ""));

      this.db.prepare(
        `INSERT INTO block_history (id, block_id, field_changed, old_value, new_value, changed_by, changed_at, reason)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        `hist_${uuidv4().slice(0, 8)}`, block.id, field,
        histOldValue,
        isEncryptedField ? "[ENCRYPTED]" : serializedNew,
        changedBy || null, now, reason || null
      );

      this.db.prepare(
        `UPDATE blocks SET ${field} = ?, updated_at = ? WHERE id = ?`
      ).run(dbValue, now, block.id);
    }

    if ("essence" in changes || "content" in changes) {
      this._invalidateDerivedBlocks(block.id, now);
    }

    return this.getBlock(block.id);
  }

  private _invalidateDerivedBlocks(sourceId: string, now: string): void {
    if (!this.db) return;
    const rows = this.db.prepare(
      `SELECT id, content FROM blocks WHERE status NOT IN ('archived', 'stale') AND content LIKE ?`
    ).all(`%${sourceId}%`) as Array<{ id: string; content: string }>;

    for (const row of rows) {
      try {
        const c = JSON.parse(row.content);
        const inputIds: string[] = c?.derivation?.input_ids || [];
        if (inputIds.includes(sourceId)) {
          this.db.prepare(`UPDATE blocks SET status = 'stale', updated_at = ? WHERE id = ?`).run(now, row.id);
          this.db.prepare(
            `INSERT INTO block_history (id, block_id, field_changed, old_value, new_value, changed_by, changed_at, reason) VALUES (?, ?, 'status', 'active', 'stale', ?, ?, ?)`
          ).run(`hist_${uuidv4().slice(0, 8)}`, row.id, "system", now, `source block ${sourceId} was updated`);
        }
      } catch { /* skip */ }
    }
  }

  archiveBlock(idOrLabel: string, reason?: string): boolean {
    if (!this.db) throw new Error("Database not initialized");

    const block = this.getBlock(idOrLabel);
    if (!block) return false;

    const now = new Date().toISOString();

    this.db.prepare(`UPDATE blocks SET status = 'archived', updated_at = ? WHERE id = ?`).run(now, block.id);
    this.db.prepare(
      `INSERT INTO block_history (id, block_id, field_changed, old_value, new_value, changed_by, changed_at, reason) VALUES (?, ?, 'status', ?, 'archived', ?, ?, ?)`
    ).run(`hist_${uuidv4().slice(0, 8)}`, block.id, block.status, null, now, reason || "Archived by agent");

    // Archive outgoing relations so orphaned rows no longer affect GC protection,
    // children_count, incoming_count, or quality_score on other blocks.
    // Incoming relations are left intact — they are historical record of what cited this block.
    this.db.prepare(
      `UPDATE relations SET valid_to = ?, status = 'archived' WHERE source_id = ? AND valid_to IS NULL`
    ).run(now, block.id);

    return true;
  }

  // ─── Search ──────────────────────────────────────────────────

  /**
   * Find blocks whose concepts column contains any of the given concept strings.
   * Uses SQLite's json_each() to match inside the JSON array — no JS-level parsing loop.
   * Returns map of blockId → overlap count (number of matching concepts).
   */
  conceptSearch(queryConcepts: string[]): Map<string, { block: Block; matches: number }> {
    if (!this.db) throw new Error("Database not initialized");
    if (queryConcepts.length === 0) return new Map();

    const result = new Map<string, { block: Block; matches: number }>();

    // One query per concept — SQLite json_each expands the JSON array into rows
    const stmt = this.db.prepare(`
      SELECT b.*
      FROM blocks b, json_each(b.concepts) je
      WHERE b.status != 'archived'
        AND (LOWER(je.value) LIKE ? OR ? LIKE '%' || LOWER(je.value) || '%')
    `);

    for (const qc of queryConcepts) {
      const term = qc.toLowerCase();
      const rows = stmt.all(`%${term}%`, term) as Record<string, unknown>[];
      for (const row of rows) {
        const block = this.rowToBlock(row);
        const existing = result.get(block.id);
        if (existing) {
          existing.matches++;
        } else {
          result.set(block.id, { block, matches: 1 });
        }
      }
    }

    return result;
  }

  keywordSearch(query: string, limit: number = 10, type?: string, status?: string): Block[] {
    if (!this.db) throw new Error("Database not initialized");

    const terms = query.toLowerCase().split(/\s+/);
    const statusFilter = status === "all" ? "" : (status ? `AND status = '${status}'` : `AND status IN ('active', 'created')`);
    const typeFilter = type ? `AND type = '${type}'` : "";

    const termConditions = terms.map(
      () => `(LOWER(label) LIKE ? OR LOWER(essence) LIKE ? OR LOWER(content) LIKE ? OR LOWER(concepts) LIKE ? OR LOWER(aliases) LIKE ?)`
    );

    const params = terms.flatMap((t) => {
      const like = `%${t}%`;
      return [like, like, like, like, like];
    });

    const sql = `
      SELECT * FROM blocks
      WHERE (${termConditions.join(" OR ")})
      ${statusFilter} ${typeFilter}
      ORDER BY access_count DESC, updated_at DESC
      LIMIT ?
    `;

    const rows = this.db.prepare(sql).all(...params, limit) as Record<string, unknown>[];
    return rows.map((row) => this.rowToBlock(row));
  }

  semanticSearch(queryEmbedding: number[], limit: number = 10, type?: string, minSimilarity: number = 0.2): Block[] {
    if (!this.db) throw new Error("Database not initialized");

    const typeFilter = type ? `AND type = '${type}'` : "";
    const rows = this.db.prepare(
      `SELECT * FROM blocks WHERE embedding IS NOT NULL AND status != 'archived' ${typeFilter}`
    ).all() as Record<string, unknown>[];

    const blocks = rows.map((row) => this.rowToBlock(row));

    return blocks
      .map((block) => ({
        block,
        similarity: cosineSim(queryEmbedding, JSON.parse(block.embedding!) as number[]),
      }))
      .filter((s) => s.similarity > minSimilarity)
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, limit)
      .map((s) => s.block);
  }

  // ─── Relations ─────────────────────────────────────────────────

  createRelation(params: {
    source_id: string;
    target_id: string;
    type: string;
    bidirectional?: boolean;
    created_by?: string;
    status?: string;
    valid_from?: string;
  }): Relation {
    if (!this.db) throw new Error("Database not initialized");

    // Guard: both blocks must exist before creating a relation.
    // Prevents orphaned edges that silently break chain traversal.
    // Logs and returns a null-like stub instead of throwing — callers check for null if needed.
    const srcExists = this.db.prepare(`SELECT id FROM blocks WHERE id = ?`).get(params.source_id);
    const tgtExists = this.db.prepare(`SELECT id FROM blocks WHERE id = ?`).get(params.target_id);
    if (!srcExists || !tgtExists) {
      const missing = !srcExists ? `source "${params.source_id}"` : `target "${params.target_id}"`;
      console.warn(`createRelation: ${missing} does not exist — skipping "${params.type}" relation`);
      // Return a stub so callers don't need to null-check; the relation is simply not persisted.
      return { id: "", source_id: params.source_id, target_id: params.target_id, type: params.type,
        bidirectional: false, created_by: null, created_at: "", status: "skipped",
        valid_from: null, valid_to: null } as any;
    }

    // Idempotency guard: return existing active relation if same source/target/type already exists
    const existing = this.db.prepare(
      `SELECT * FROM relations WHERE source_id = ? AND target_id = ? AND type = ? AND valid_to IS NULL LIMIT 1`
    ).get(params.source_id, params.target_id, params.type) as Record<string, unknown> | undefined;

    if (existing) {
      return {
        id: existing.id as string,
        source_id: existing.source_id as string,
        target_id: existing.target_id as string,
        type: existing.type as string,
        bidirectional: existing.bidirectional === 1 || existing.bidirectional === true,
        created_by: existing.created_by as string | null,
        created_at: existing.created_at as string,
        status: (existing.status as string) ?? "active",
        valid_from: existing.valid_from as string | null,
        valid_to: existing.valid_to as string | null,
      };
    }

    const now = new Date().toISOString();
    const relation: Relation = {
      id: `rel_${uuidv4().slice(0, 8)}`,
      source_id: params.source_id,
      target_id: params.target_id,
      type: params.type,
      bidirectional: params.bidirectional ?? false,
      created_by: params.created_by || null,
      created_at: now,
      status: params.status ?? "active",
      valid_from: params.valid_from ?? now,
      valid_to: null,
    };

    this.db.prepare(
      `INSERT INTO relations (id, source_id, target_id, type, bidirectional, created_by, created_at, status, valid_from, valid_to)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      relation.id, relation.source_id, relation.target_id, relation.type,
      relation.bidirectional ? 1 : 0,
      relation.created_by, relation.created_at, relation.status,
      relation.valid_from, null
    );

    // Recompute quality_score for the source block — gaining a relation bumps the score.
    // Only recompute if current score is below the max (6) to avoid unnecessary writes.
    const srcRow = this.db.prepare(`SELECT * FROM blocks WHERE id = ?`).get(params.source_id) as Record<string, unknown> | undefined;
    if (srcRow && (srcRow.quality_score as number) < 5) {
      const qc: any = (() => { try { return typeof srcRow.content === "string" ? JSON.parse(srcRow.content as string) : (srcRow.content || {}); } catch { return {}; } })();
      const concepts: string[] = (() => { try { return JSON.parse(srcRow.concepts as string || "[]"); } catch { return []; } })();
      const relCount = (this.db.prepare(`SELECT COUNT(*) as n FROM relations WHERE source_id = ? AND valid_to IS NULL`).get(params.source_id) as any)?.n ?? 0;
      let qScore = 1; // essence always present
      if (qc.is_a) qScore++;
      if (qc.unique && Object.keys(qc.unique).length >= 2) qScore++;
      if (concepts.length >= 3) qScore++;
      if (relCount > 0) qScore++;
      const newScore = Math.min(qScore, 5);
      if (newScore !== (srcRow.quality_score as number)) {
        this.db.prepare(`UPDATE blocks SET quality_score = ? WHERE id = ?`).run(newScore, params.source_id);
      }
    }

    // SEMANTIC (2026-07-02): a supersedes relation does NOT archive the target.
    // The EDGE itself is the source of truth for currency — old block stays visible
    // history (like a dead_end), with its superseded_by edge telling any reader what
    // replaced it. Archiving here made superseded decisions INVISIBLE to search/list
    // (archived is filtered everywhere), so the "we already tried X" signal vanished —
    // and it was type-inconsistent (only decision/blueprint archived; preferences etc.
    // stayed active). `archived` is reserved for actual removal-from-view: confirmed
    // duplicates (executeMerge archives explicitly), TTL expiry, and workspace_forget.

    return relation;
  }

  /**
   * Batch currency lookup: which of these blocks have been superseded, and by what.
   * Returns target_id → label of the ACTIVE superseding block. Read paths that list
   * blocks WITHOUT relations (search, filters) use this so a superseded-but-visible
   * block can never leak as current — the annotation says what replaced it.
   */
  getSupersededByLabels(blockIds: string[]): Map<string, string> {
    if (!this.db) throw new Error("Database not initialized");
    const out = new Map<string, string>();
    if (!blockIds.length) return out;
    const rows = this.db.prepare(
      `SELECT r.target_id AS tid, b.label AS lbl
       FROM relations r JOIN blocks b ON b.id = r.source_id
       WHERE r.type = 'supersedes' AND r.valid_to IS NULL
         AND b.status != 'archived'
         AND r.target_id IN (${blockIds.map(() => "?").join(",")})`
    ).all(...blockIds) as Array<{ tid: string; lbl: string }>;
    for (const row of rows) out.set(row.tid, row.lbl);
    return out;
  }

  getRelations(blockId: string): Array<{ type: string; target_id: string; target_label: string; direction: string }> {
    if (!this.db) throw new Error("Database not initialized");

    const outgoing = this.db.prepare(
      `SELECT r.type, r.target_id, b.label as target_label
       FROM relations r JOIN blocks b ON r.target_id = b.id
       WHERE r.source_id = ? AND r.valid_to IS NULL`
    ).all(blockId) as Array<{ type: string; target_id: string; target_label: string }>;

    const incoming = this.db.prepare(
      `SELECT r.type, r.source_id as target_id, b.label as target_label
       FROM relations r JOIN blocks b ON r.source_id = b.id
       WHERE r.target_id = ? AND r.bidirectional = 1 AND r.valid_to IS NULL`
    ).all(blockId) as Array<{ type: string; target_id: string; target_label: string }>;

    return [
      ...outgoing.map((r) => ({ ...r, direction: "outgoing" })),
      ...incoming.map((r) => ({ ...r, direction: "incoming" })),
    ];
  }

  getAllRelations(includePending = false): Relation[] {
    if (!this.db) throw new Error("Database not initialized");

    // Always exclude expired (valid_to IS NOT NULL) unless explicitly querying history
    const sql = includePending
      ? `SELECT * FROM relations WHERE valid_to IS NULL`
      : `SELECT * FROM relations WHERE (status = 'active' OR status IS NULL) AND valid_to IS NULL`;

    const rows = this.db.prepare(sql).all() as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: row.id as string,
      source_id: row.source_id as string,
      target_id: row.target_id as string,
      type: row.type as string,
      bidirectional: row.bidirectional === 1 || row.bidirectional === true,
      created_by: row.created_by as string | null,
      created_at: row.created_at as string,
      status: (row.status as string) ?? "active",
      valid_from: row.valid_from as string | null,
      valid_to: row.valid_to as string | null,
    }));
  }

  // Batch: get incoming contradicts/challenges for a set of block IDs.
  // Also surfaces challenges on 1-hop neighbors so caveat blocks are never invisible:
  //   recalled block X → neighbor Y (any relation) → challenger Z contradicts Y
  //   → Z appears in X's challenges array
  getChallengesForBlocks(blockIds: string[]): Map<string, Array<{ label: string; essence: string }>> {
    if (!this.db || blockIds.length === 0) return new Map();
    const placeholders = blockIds.map(() => "?").join(",");

    // Direct challenges: Z contradicts recalled block X
    const directRows = this.db.prepare(
      `SELECT r.target_id as block_id, b.label, b.essence
       FROM relations r
       JOIN blocks b ON r.source_id = b.id
       WHERE r.target_id IN (${placeholders})
         AND r.type IN ('contradicts','challenges')
         AND r.valid_to IS NULL
         AND (r.status = 'active' OR r.status IS NULL)`
    ).all(...blockIds) as Array<{ block_id: string; label: string; essence: string }>;

    const result = new Map<string, Array<{ label: string; essence: string }>>();
    for (const row of directRows) {
      if (!result.has(row.block_id)) result.set(row.block_id, []);
      result.get(row.block_id)!.push({ label: row.label, essence: row.essence });
    }

    // 1-hop expansion: find neighbors of recalled blocks, then their challengers
    const neighborRows = this.db.prepare(
      `SELECT CASE WHEN r.source_id IN (${placeholders}) THEN r.source_id ELSE r.target_id END as recalled_id,
              CASE WHEN r.source_id IN (${placeholders}) THEN r.target_id ELSE r.source_id END as neighbor_id
       FROM relations r
       WHERE (r.source_id IN (${placeholders}) OR r.target_id IN (${placeholders}))
         AND r.type NOT IN ('contradicts','challenges')
         AND r.valid_to IS NULL`
    ).all(...blockIds, ...blockIds, ...blockIds, ...blockIds) as Array<{ recalled_id: string; neighbor_id: string }>;

    if (neighborRows.length > 0) {
      const neighborIds = [...new Set(neighborRows.map(r => r.neighbor_id))];
      // Include ALL neighbors — even if they're also in the recall result.
      // A block in the result set may still be a 1-hop neighbor of another result block;
      // its challengers should surface on the originating recalled block.
      if (neighborIds.length > 0) {
        const nPlaceholders = neighborIds.map(() => "?").join(",");
        const neighborChallengeRows = this.db.prepare(
          `SELECT r.target_id as neighbor_id, b.label, b.essence
           FROM relations r
           JOIN blocks b ON r.source_id = b.id
           WHERE r.target_id IN (${nPlaceholders})
             AND r.type IN ('contradicts','challenges')
             AND r.valid_to IS NULL
             AND (r.status = 'active' OR r.status IS NULL)`
        ).all(...neighborIds) as Array<{ neighbor_id: string; label: string; essence: string }>;

        // Map neighbor challenges back to their recalled block origin
        const neighborToRecalled = new Map<string, string>();
        for (const row of neighborRows) neighborToRecalled.set(row.neighbor_id, row.recalled_id);

        for (const row of neighborChallengeRows) {
          const recalledId = neighborToRecalled.get(row.neighbor_id);
          if (!recalledId) continue;
          if (!result.has(recalledId)) result.set(recalledId, []);
          // avoid duplicates
          const existing = result.get(recalledId)!;
          if (!existing.some(e => e.label === row.label))
            existing.push({ label: row.label, essence: row.essence });
        }
      }
    }

    return result;
  }

  // Batch: count incoming relations per block (signals graph importance)
  getIncomingCounts(blockIds: string[]): Map<string, number> {
    if (!this.db || blockIds.length === 0) return new Map();
    const placeholders = blockIds.map(() => "?").join(",");
    const rows = this.db.prepare(
      `SELECT target_id, COUNT(*) as cnt
       FROM relations
       WHERE target_id IN (${placeholders})
         AND valid_to IS NULL
         AND (status = 'active' OR status IS NULL)
       GROUP BY target_id`
    ).all(...blockIds) as Array<{ target_id: string; cnt: number }>;
    const result = new Map<string, number>();
    for (const row of rows) result.set(row.target_id, row.cnt);
    return result;
  }

  // Mark a relation as no longer valid (bitemporal invalidation)
  invalidateRelation(id: string, reason?: string): boolean {
    if (!this.db) throw new Error("Database not initialized");
    const now = new Date().toISOString();
    const result = this.db.prepare(
      `UPDATE relations SET valid_to = ?, status = 'archived' WHERE id = ? AND valid_to IS NULL`
    ).run(now, id);
    if (result.changes > 0 && reason) {
      // Log to history of the source block
      const rel = this.db.prepare(`SELECT source_id FROM relations WHERE id = ?`).get(id) as { source_id: string } | undefined;
      if (rel) {
        this.db.prepare(
          `INSERT INTO block_history (id, block_id, field_changed, old_value, new_value, changed_by, changed_at, reason) VALUES (?, ?, 'relation', ?, 'invalidated', 'system', ?, ?)`
        ).run(`hist_${uuidv4().slice(0, 8)}`, rel.source_id, id, now, reason);
      }
    }
    return result.changes > 0;
  }

  getPendingRelations(): Array<{
    id: string; source_id: string; source_label: string;
    target_id: string; target_label: string;
    type: string; created_by: string | null; created_at: string;
  }> {
    if (!this.db) throw new Error("Database not initialized");
    const rows = this.db.prepare(
      `SELECT r.id, r.source_id, s.label as source_label, r.target_id, t.label as target_label,
              r.type, r.created_by, r.created_at
       FROM relations r
       JOIN blocks s ON r.source_id = s.id
       JOIN blocks t ON r.target_id = t.id
       WHERE r.status = 'pending'
       ORDER BY r.created_at DESC`
    ).all() as Array<Record<string, unknown>>;

    return rows.map((row) => ({
      id: row.id as string,
      source_id: row.source_id as string,
      source_label: row.source_label as string,
      target_id: row.target_id as string,
      target_label: row.target_label as string,
      type: row.type as string,
      created_by: row.created_by as string | null,
      created_at: row.created_at as string,
    }));
  }

  approveRelation(id: string): boolean {
    if (!this.db) throw new Error("Database not initialized");
    this.db.prepare(`UPDATE relations SET status = 'active' WHERE id = ? AND status = 'pending'`).run(id);
    return true;
  }

  // Update relation type and/or status — used by Gemini async validation
  updateRelation(id: string, updates: { type?: string; status?: string }): boolean {
    if (!this.db) throw new Error("Database not initialized");
    const fields: string[] = [];
    const values: unknown[] = [];
    if (updates.type !== undefined) { fields.push("type = ?"); values.push(updates.type); }
    if (updates.status !== undefined) { fields.push("status = ?"); values.push(updates.status); }
    if (fields.length === 0) return false;
    values.push(id);
    const result = this.db.prepare(`UPDATE relations SET ${fields.join(", ")} WHERE id = ?`).run(...values);
    return result.changes > 0;
  }

  // Hard delete a pending relation — used when Gemini determines no real connection exists
  deleteRelation(id: string): boolean {
    if (!this.db) throw new Error("Database not initialized");
    const result = this.db.prepare(`DELETE FROM relations WHERE id = ? AND status = 'pending'`).run(id);
    return result.changes > 0;
  }

  rejectRelation(id: string): boolean {
    if (!this.db) throw new Error("Database not initialized");
    this.db.prepare(`DELETE FROM relations WHERE id = ? AND status = 'pending'`).run(id);
    return true;
  }

  // IDF helpers — count blocks with a concept tag to detect generic vs specific tags
  countBlocksWithConcept(tag: string): number {
    if (!this.db) throw new Error("Database not initialized");
    const result = this.db.prepare(
      `SELECT COUNT(*) as c FROM blocks WHERE concepts LIKE ? AND status != 'archived'`
    ).get(`%"${tag}"%`) as { c: number };
    return result?.c ?? 0;
  }

  getTotalBlockCount(): number {
    if (!this.db) throw new Error("Database not initialized");
    const result = this.db.prepare(
      `SELECT COUNT(*) as c FROM blocks WHERE status != 'archived'`
    ).get() as { c: number };
    return result?.c ?? 0;
  }

  deleteInferredRelations(): number {
    if (!this.db) throw new Error("Database not initialized");
    const result = this.db.prepare(`DELETE FROM relations WHERE created_by LIKE 'infer_%'`).run();
    return result.changes;
  }

  getAllIncomingRelations(blockId: string): Array<{ type: string; source_id: string; source_label: string }> {
    if (!this.db) throw new Error("Database not initialized");
    // Translate r.type to its inverse so the type field reads from the READER'S perspective
    // (the reader is the target block; the stored type is from the source's perspective).
    //   - Paired inverses (supersedes↔superseded_by, part_of↔contains, prompted_by↔triggered,
    //     derived_from↔produced, affects↔affected_by, implements↔implemented_by,
    //     describes↔described_by): translates — agent reading the OLD block of a supersede
    //     sees `superseded_by`, not `supersedes`.
    //   - Self-inverse (related_to, contradicts): rt.inverse equals r.type → COALESCE no-op.
    //   - Null-inverse (based_on, extends, depends_on, enables, member_of): rt.inverse IS NULL
    //     → COALESCE keeps r.type. These types have no semantic inverse name by design.
    //   - Unknown type (not seeded in relation_types): LEFT JOIN returns NULL → COALESCE keeps r.type.
    // Patch — Debt 4 §2.2 will subsume with reason/evidence_basis columns on relations;
    // read-side translation has zero conflict with that future schema work.
    const rows = this.db.prepare(
      `SELECT COALESCE(rt.inverse, r.type) AS type,
              r.source_id,
              b.label as source_label
       FROM relations r
       JOIN blocks b ON r.source_id = b.id
       LEFT JOIN relation_types rt ON rt.name = r.type
       WHERE r.target_id = ? AND r.valid_to IS NULL AND (r.status = 'active' OR r.status IS NULL)`
    ).all(blockId) as Array<{ type: string; source_id: string; source_label: string }>;
    return rows;
  }

  getBlockTypes(): BlockTypeDef[] {
    if (!this.db) throw new Error("Database not initialized");
    const rows = this.db.prepare(`SELECT * FROM block_types`).all() as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      name: row.name as string,
      extends: row.extends as string,
      description: row.description as string,
      typical_fields: row.typical_fields as string,
    }));
  }

  // ─── History ──────────────────────────────────────────────────

  // ─── Graph health + maintenance ───────────────────────────────────────────

  /** Returns blocks with no project_id — invisible to project-scoped queries. */
  getGraphHealth(): { unlinked: { id: string; label: string; type: string }[] } {
    if (!this.db) throw new Error("Database not initialized");

    const unlinked = this.db.prepare(`
      SELECT id, label, type FROM blocks
      WHERE status = 'active' AND type != 'project' AND project_id IS NULL
    `).all() as { id: string; label: string; type: string }[];

    return { unlinked };
  }

  pruneEmbeddingHistory(): { deleted: number } {
    if (!this.db) throw new Error("Database not initialized");
    const result = this.db.prepare(`DELETE FROM block_history WHERE field_changed = 'embedding'`).run();
    return { deleted: result.changes };
  }

  getHistory(blockId?: string, limit: number = 10): HistoryEntry[] {
    if (!this.db) throw new Error("Database not initialized");

    const rows = blockId
      ? this.db.prepare(`SELECT * FROM block_history WHERE block_id = ? ORDER BY changed_at DESC LIMIT ?`).all(blockId, limit)
      : this.db.prepare(`SELECT * FROM block_history ORDER BY changed_at DESC LIMIT ?`).all(limit);

    return (rows as Array<Record<string, unknown>>).map((row) => ({
      id: row.id as string,
      block_id: row.block_id as string,
      field_changed: row.field_changed as string,
      old_value: row.old_value as string | null,
      new_value: row.new_value as string | null,
      changed_by: row.changed_by as string | null,
      changed_at: row.changed_at as string,
      reason: row.reason as string | null,
    }));
  }

  // ─── Custom Types ───────────────────────────────────────────────

  createBlockType(params: { name: string; extends: string; description: string; typical_fields?: string[] }): boolean {
    if (!this.db) throw new Error("Database not initialized");
    try {
      this.db.prepare(
        `INSERT INTO block_types (name, extends, description, typical_fields) VALUES (?, ?, ?, ?)`
      ).run(params.name, params.extends, params.description, JSON.stringify(params.typical_fields || []));
      return true;
    } catch (e) {
      if (String(e).includes("UNIQUE constraint")) return false;
      throw e;
    }
  }

  createRelationType(params: { name: string; inverse?: string; description: string }): boolean {
    if (!this.db) throw new Error("Database not initialized");
    try {
      this.db.prepare(
        `INSERT INTO relation_types (name, inverse, description) VALUES (?, ?, ?)`
      ).run(params.name, params.inverse || null, params.description);
      return true;
    } catch (e) {
      if (String(e).includes("UNIQUE constraint")) return false;
      throw e;
    }
  }

  // ─── Projects ───────────────────────────────────────────────────

  createProjectLog(project: string, entry: string): ProjectLog {
    if (!this.db) throw new Error("Database not initialized");
    const log: ProjectLog = {
      id: `log_${uuidv4().slice(0, 8)}`,
      project,
      entry,
      created_at: new Date().toISOString(),
    };
    this.db.prepare(`INSERT INTO project_logs (id, project, entry, created_at) VALUES (?, ?, ?, ?)`)
      .run(log.id, log.project, log.entry, log.created_at);
    return log;
  }

  getProjectLogs(project: string, limit: number = 5): ProjectLog[] {
    if (!this.db) throw new Error("Database not initialized");
    const rows = this.db.prepare(
      `SELECT * FROM project_logs WHERE project = ? ORDER BY created_at DESC LIMIT ?`
    ).all(project, limit) as Array<Record<string, unknown>>;

    return rows.map((row) => ({
      id: row.id as string,
      project: row.project as string,
      entry: row.entry as string,
      created_at: row.created_at as string,
    }));
  }

  getProjectBlocks(project: string): Block[] {
    if (!this.db) throw new Error("Database not initialized");
    const projectKey = project.toLowerCase();

    const projectRow = this.db.prepare(
      `SELECT id FROM blocks WHERE type = 'project' AND LOWER(label) = ? AND status != 'archived'`
    ).get(projectKey) as { id: string } | undefined;
    const projectId = projectRow?.id || null;

    const rows = this.db.prepare(
      `SELECT * FROM blocks
       WHERE status != 'archived'
         AND (
           (type = 'project' AND LOWER(label) = ?)
           OR (project_id IS NOT NULL AND project_id = ?)
         )`
    ).all(
      projectKey,
      projectId
    ) as Record<string, unknown>[];

    return rows.map((row) => this.decryptBlockIfSensitive(this.rowToBlock(row)));
  }

  updateEmbedding(id: string, embedding: number[]): void {
    if (!this.db) throw new Error("Database not initialized");
    this.db.prepare(`UPDATE blocks SET embedding = ? WHERE id = ?`).run(JSON.stringify(embedding), id);
    // No history log — embeddings are derived data
  }

  getBlocksWithoutEmbeddings(): Block[] {
    if (!this.db) throw new Error("Database not initialized");
    const rows = this.db.prepare(
      `SELECT * FROM blocks WHERE (embedding IS NULL OR embedding = '') AND status != 'archived'`
    ).all() as Record<string, unknown>[];
    return rows.map((row) => this.decryptBlockIfSensitive(this.rowToBlock(row)));
  }

  getRecentBlocks(limit: number = 10): Block[] {
    if (!this.db) throw new Error("Database not initialized");
    const rows = this.db.prepare(
      `SELECT * FROM blocks WHERE status != 'archived' AND type != 'project' ORDER BY updated_at DESC LIMIT ?`
    ).all(limit) as Record<string, unknown>[];
    return rows.map((row) => this.decryptBlockIfSensitive(this.rowToBlock(row)));
  }

  // ─── Lifecycle / GC ───────────────────────────────────────────

  promoteHotBlocks(): { promoted: number } {
    if (!this.db) throw new Error("Database not initialized");
    const HOT_TTLS = ["session", "1hr"];
    const PROMOTION_THRESHOLD = 3;

    const rows = this.db.prepare(
      `SELECT id, ttl, access_count FROM blocks WHERE status != 'archived' AND ttl IN ('session', '1hr')`
    ).all() as Array<{ id: string; ttl: string; access_count: number }>;

    let promotedCount = 0;
    for (const row of rows) {
      if (HOT_TTLS.includes(row.ttl) && row.access_count >= PROMOTION_THRESHOLD) {
        this.db.prepare(
          `UPDATE blocks SET ttl = 'permanent', updated_at = ? WHERE id = ?`
        ).run(new Date().toISOString(), row.id);
        promotedCount++;
      }
    }

    return { promoted: promotedCount };
  }

  runGC(): { archived: number; protected: number; promoted: number } {
    if (!this.db) throw new Error("Database not initialized");
    const now = Date.now();
    let archivedCount = 0;
    let protectedCount = 0;

    // Promote hot blocks BEFORE GC loop so they become permanent and are skipped by GC.
    // If promotion runs after, hot session blocks are archived before they can be saved.
    const { promoted } = this.promoteHotBlocks();

    const PROTECTED_TYPES = new Set(["decision", "constraint", "project"]);

    const rows = this.db.prepare(
      `SELECT id, status, ttl, updated_at, access_count, type FROM blocks WHERE status != 'archived'`
    ).all() as Array<{ id: string; status: string; ttl: string; updated_at: string; access_count: number; type: string }>;

    for (const row of rows) {
      const ageMs = now - new Date(row.updated_at).getTime();

      if (PROTECTED_TYPES.has(row.type) || row.ttl === "permanent") {
        protectedCount++;
        continue;
      }

      const relCheck = this.db.prepare(
        `SELECT COUNT(*) as cnt FROM relations WHERE (source_id = ? OR target_id = ?) AND valid_to IS NULL AND status = 'active'`
      ).get(row.id, row.id) as { cnt: number };

      if (relCheck.cnt > 0) {
        protectedCount++;
        continue;
      }

      // Archive TTL blocks — agent explicitly set these as temporary
      if (row.ttl === "1hr"     && ageMs > 60 * 60 * 1000)          { this.db.prepare(`UPDATE blocks SET status = 'archived' WHERE id = ?`).run(row.id); archivedCount++; }
      else if (row.ttl === "24hr"    && ageMs > 24 * 60 * 60 * 1000)     { this.db.prepare(`UPDATE blocks SET status = 'archived' WHERE id = ?`).run(row.id); archivedCount++; }
      else if (row.ttl === "1week"   && ageMs > 7 * 24 * 60 * 60 * 1000) { this.db.prepare(`UPDATE blocks SET status = 'archived' WHERE id = ?`).run(row.id); archivedCount++; }
      else if (row.ttl === "session" && ageMs > 24 * 60 * 60 * 1000)     { this.db.prepare(`UPDATE blocks SET status = 'archived' WHERE id = ?`).run(row.id); archivedCount++; }
    }

    return { archived: archivedCount, protected: protectedCount, promoted };
  }

  // ─── Stats ────────────────────────────────────────────────────

  getStats(): Record<string, unknown> {
    if (!this.db) throw new Error("Database not initialized");

    const total = (this.db.prepare(`SELECT COUNT(*) as cnt FROM blocks WHERE status != 'archived'`).get() as { cnt: number }).cnt;

    const byStatus = this.db.prepare(`SELECT status, COUNT(*) as cnt FROM blocks GROUP BY status`).all() as Array<{ status: string; cnt: number }>;
    const byType = this.db.prepare(`SELECT type, COUNT(*) as cnt FROM blocks WHERE status != 'archived' GROUP BY type`).all() as Array<{ type: string; cnt: number }>;

    const statusMap: Record<string, number> = {};
    for (const row of byStatus) statusMap[row.status] = row.cnt;

    const typeMap: Record<string, number> = {};
    for (const row of byType) typeMap[row.type] = row.cnt;

    return { total_blocks: total, by_status: statusMap, by_type: typeMap };
  }

  // ─── Recall Log ───────────────────────────────────────────────

  logRecall(blockId: string, projectId?: string, reason?: string, used = false): void {
    if (!this.db) return;
    try {
      this.db.prepare(
        `INSERT INTO recall_log (id, block_id, recalled_at, project_id, reason, used) VALUES (?, ?, ?, ?, ?, ?)`
      ).run(`rl_${uuidv4().slice(0, 8)}`, blockId, new Date().toISOString(), projectId || null, reason || null, used ? 1 : 0);
      this.db.prepare(`DELETE FROM recall_log WHERE recalled_at < datetime('now', '-90 days')`).run();
    } catch { /* non-critical */ }
  }

  markRecallUsed(blockId: string): void {
    if (!this.db) return;
    try {
      this.db.prepare(
        `UPDATE recall_log SET used = 1 WHERE block_id = ? AND used = 0 AND recalled_at = (SELECT MAX(recalled_at) FROM recall_log WHERE block_id = ? AND used = 0)`
      ).run(blockId, blockId);
    } catch { /* non-critical */ }
  }

  // ─── Reflect stamp ────────────────────────────────────────────────────────────
  // Updates last_reflected_at for a batch of block IDs. Bypasses updateBlock
  // intentionally — last_reflected_at is an operational timestamp (like last_accessed),
  // not a content field. Should not appear in block_history.
  stampReflectedAt(blockIds: string[]): void {
    if (!this.db || blockIds.length === 0) return;
    const now = new Date().toISOString();
    const CHUNK = 900; // SQLite binding limit
    for (let i = 0; i < blockIds.length; i += CHUNK) {
      const chunk = blockIds.slice(i, i + CHUNK);
      const placeholders = chunk.map(() => "?").join(",");
      try {
        this.db.prepare(
          `UPDATE blocks SET last_reflected_at = ? WHERE id IN (${placeholders})`
        ).run(now, ...chunk);
      } catch { /* non-critical */ }
    }
  }

  getWriteLog(limit: number = 50): Array<{ id: string; table_name: string; operation: string; row_id: string; snapshot: string; changed_at: string }> {
    if (!this.db) return [];
    return this.db.prepare(
      `SELECT id, table_name, operation, row_id, snapshot, changed_at
       FROM write_log ORDER BY changed_at DESC LIMIT ?`
    ).all(limit) as Array<{ id: string; table_name: string; operation: string; row_id: string; snapshot: string; changed_at: string }>;
  }

  getRecallStats(limit: number = 20): Array<{ block_id: string; label: string; recall_count: number; use_count: number; precision: number }> {
    if (!this.db) return [];
    const rows = this.db.prepare(
      `SELECT rl.block_id, b.label, COUNT(*) as recall_count, SUM(rl.used) as use_count
       FROM recall_log rl
       INNER JOIN blocks b ON b.id = rl.block_id
       GROUP BY rl.block_id
       ORDER BY recall_count DESC
       LIMIT ?`
    ).all(limit) as Array<{ block_id: string; label: string; recall_count: number; use_count: number }>;

    return rows.map((row) => {
      const recallCount = row.recall_count || 1;
      const useCount = row.use_count || 0;
      return {
        block_id: row.block_id,
        label: row.label || "unknown",
        recall_count: recallCount,
        use_count: useCount,
        precision: Math.round((useCount / recallCount) * 100) / 100,
      };
    });
  }

  // ─── Near-Duplicate Conflicts ─────────────────────────────────

  createConflict(blockAId: string, blockBId: string, similarity: number): string {
    if (!this.db) throw new Error("Database not initialized");

    const existing = this.db.prepare(
      `SELECT id FROM near_duplicate_conflicts WHERE ((block_a_id = ? AND block_b_id = ?) OR (block_a_id = ? AND block_b_id = ?)) AND resolved = 0`
    ).get(blockAId, blockBId, blockBId, blockAId) as { id: string } | undefined;

    if (existing) return existing.id;

    const id = `cnf_${uuidv4().slice(0, 8)}`;
    this.db.prepare(
      `INSERT INTO near_duplicate_conflicts (id, block_a_id, block_b_id, similarity, detected_at, resolved, resolution) VALUES (?, ?, ?, ?, ?, 0, NULL)`
    ).run(id, blockAId, blockBId, similarity, new Date().toISOString());
    return id;
  }

  getOpenConflicts(): Array<{ id: string; block_a: any; block_b: any; similarity: number; detected_at: string }> {
    if (!this.db) return [];
    const rows = this.db.prepare(
      `SELECT id, block_a_id, block_b_id, similarity, detected_at FROM near_duplicate_conflicts WHERE resolved = 0 ORDER BY detected_at DESC`
    ).all() as Array<{ id: string; block_a_id: string; block_b_id: string; similarity: number; detected_at: string }>;

    return rows.map((row) => {
      const a = this.getBlock(row.block_a_id);
      const b = this.getBlock(row.block_b_id);
      return {
        id: row.id,
        block_a: a ? { id: a.id, label: a.label, essence: a.essence, type: a.type } : { id: row.block_a_id, label: "unknown" },
        block_b: b ? { id: b.id, label: b.label, essence: b.essence, type: b.type } : { id: row.block_b_id, label: "unknown" },
        similarity: row.similarity,
        detected_at: row.detected_at,
      };
    });
  }

  resolveConflict(conflictId: string, resolution: string): boolean {
    if (!this.db) throw new Error("Database not initialized");
    this.db.prepare(
      `UPDATE near_duplicate_conflicts SET resolved = 1, resolution = ? WHERE id = ?`
    ).run(resolution, conflictId);
    return true;
  }

  // ─── Multi-Agent: Atomic Claim ────────────────────────────────
  // Uses SQLite's synchronous writes + WAL to make claim check-and-set atomic.
  // No two agents can claim the same block simultaneously.

  claimBlock(blockId: string, agentId: string, ttlSeconds = 300): { claimed: boolean; claimed_by?: string; expires_at?: string } {
    if (!this.db) throw new Error("Database not initialized");
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();

    // Single transaction: expire stale claims, then attempt insert
    const result = this.db.transaction(() => {
      // Release any expired claims on this block first
      this.db!.prepare(`DELETE FROM block_claims WHERE block_id = ? AND expires_at < ?`).run(blockId, now);

      // Try to insert — UNIQUE constraint on block_id means only one can succeed
      try {
        this.db!.prepare(
          `INSERT INTO block_claims (block_id, agent_id, claimed_at, expires_at) VALUES (?, ?, ?, ?)`
        ).run(blockId, agentId, now, expiresAt);
        return { claimed: true, expires_at: expiresAt };
      } catch {
        // Already claimed by another agent
        const existing = this.db!.prepare(
          `SELECT agent_id, expires_at FROM block_claims WHERE block_id = ?`
        ).get(blockId) as { agent_id: string; expires_at: string } | undefined;
        return { claimed: false, claimed_by: existing?.agent_id };
      }
    })();

    return result as { claimed: boolean; claimed_by?: string; expires_at?: string };
  }

  releaseBlock(blockId: string, agentId: string): boolean {
    if (!this.db) throw new Error("Database not initialized");
    const result = this.db.prepare(
      `DELETE FROM block_claims WHERE block_id = ? AND agent_id = ?`
    ).run(blockId, agentId);
    return result.changes > 0;
  }

  getBlockClaim(blockId: string): { agent_id: string; claimed_at: string; expires_at: string } | null {
    if (!this.db) throw new Error("Database not initialized");
    const now = new Date().toISOString();
    // Clean expired first
    this.db.prepare(`DELETE FROM block_claims WHERE expires_at < ?`).run(now);
    return this.db.prepare(
      `SELECT agent_id, claimed_at, expires_at FROM block_claims WHERE block_id = ?`
    ).get(blockId) as { agent_id: string; claimed_at: string; expires_at: string } | null;
  }

  // ─── Multi-Agent: Agent Registry ──────────────────────────────

  agentHeartbeat(agentId: string, role = "general", currentTask?: string, metadata?: Record<string, unknown>): void {
    if (!this.db) throw new Error("Database not initialized");
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO agent_registry (agent_id, role, last_heartbeat, status, current_task, metadata)
      VALUES (?, ?, ?, 'active', ?, ?)
      ON CONFLICT(agent_id) DO UPDATE SET
        last_heartbeat = excluded.last_heartbeat,
        status = 'active',
        current_task = excluded.current_task,
        metadata = excluded.metadata
    `).run(agentId, role, now, currentTask || null, JSON.stringify(metadata || {}));
  }

  getActiveAgents(staleAfterSeconds = 120): Array<{ agent_id: string; role: string; last_heartbeat: string; current_task: string | null }> {
    if (!this.db) throw new Error("Database not initialized");
    const cutoff = new Date(Date.now() - staleAfterSeconds * 1000).toISOString();
    return this.db.prepare(
      `SELECT agent_id, role, last_heartbeat, current_task FROM agent_registry WHERE last_heartbeat > ? AND status = 'active' ORDER BY last_heartbeat DESC`
    ).all(cutoff) as Array<{ agent_id: string; role: string; last_heartbeat: string; current_task: string | null }>;
  }

  registerAgent(agentId: string, name?: string, role = "general", metadata?: Record<string, unknown>): void {
    if (!this.db) throw new Error("Database not initialized");
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO agent_registry (agent_id, name, role, last_heartbeat, status, current_task, metadata, created_at)
      VALUES (?, ?, ?, ?, 'active', NULL, ?, ?)
      ON CONFLICT(agent_id) DO UPDATE SET
        name = COALESCE(excluded.name, agent_registry.name),
        role = excluded.role,
        last_heartbeat = excluded.last_heartbeat,
        status = 'active',
        metadata = excluded.metadata
    `).run(agentId, name || null, role, now, JSON.stringify(metadata || {}), now);
  }

  getRegisteredAgents(): Array<{ agent_id: string; name: string | null; role: string; last_heartbeat: string; status: string; created_at: string | null }> {
    if (!this.db) throw new Error("Database not initialized");
    return this.db.prepare(
      `SELECT agent_id, name, role, last_heartbeat, status, created_at FROM agent_registry ORDER BY last_heartbeat DESC`
    ).all() as Array<{ agent_id: string; name: string | null; role: string; last_heartbeat: string; status: string; created_at: string | null }>;
  }

  // ─── Reflect Job Persistence ──────────────────────────────────

  insertReflectJob(id: string, agentId: string | null, payload: string): void {
    if (!this.db) return;
    const now = Date.now();
    this.db.prepare(
      `INSERT INTO reflect_jobs (id, status, agent_id, payload, precomputed, retry_attempts, retry_after, created_at, updated_at, error)
       VALUES (?, 'pending', ?, ?, NULL, 0, NULL, ?, ?, NULL)`
    ).run(id, agentId, payload, now, now);
  }

  updateReflectJob(id: string, fields: Partial<Pick<ReflectJobRow, 'status' | 'precomputed' | 'retry_attempts' | 'retry_after' | 'error'>>): void {
    if (!this.db) return;
    const sets: string[] = ['updated_at = ?'];
    const vals: (string | number | null)[] = [Date.now()];
    if (fields.status      !== undefined) { sets.push('status = ?');          vals.push(fields.status); }
    if (fields.precomputed !== undefined) { sets.push('precomputed = ?');      vals.push(fields.precomputed); }
    if (fields.retry_attempts !== undefined) { sets.push('retry_attempts = ?'); vals.push(fields.retry_attempts); }
    if (fields.retry_after !== undefined) { sets.push('retry_after = ?');     vals.push(fields.retry_after); }
    if (fields.error       !== undefined) { sets.push('error = ?');           vals.push(fields.error); }
    vals.push(id);
    this.db.prepare(`UPDATE reflect_jobs SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }

  // Returns all jobs that need to be in memory: pending, retry_wait, and any
  // processing rows (which indicate a crash mid-job — caller resets them to pending).
  getActiveReflectJobs(): ReflectJobRow[] {
    if (!this.db) return [];
    // Also recover jobs that were killed by the old attempt cap (error = 'max retries exceeded')
    // — those are retriable, not real failures.
    return this.db.prepare(
      `SELECT * FROM reflect_jobs WHERE status IN ('pending', 'processing', 'retry_wait')
       OR (status = 'dead' AND error = 'max retries exceeded')
       ORDER BY created_at ASC`
    ).all() as ReflectJobRow[];
  }

  // Deletes done jobs older than 24h and dead jobs older than 7 days.
  cleanupReflectJobs(): number {
    if (!this.db) return 0;
    const oneDayAgo  = Date.now() - 86_400_000;
    const sevenDaysAgo = Date.now() - 604_800_000;
    const r1 = this.db.prepare(`DELETE FROM reflect_jobs WHERE status = 'done' AND updated_at < ?`).run(oneDayAgo);
    const r2 = this.db.prepare(`DELETE FROM reflect_jobs WHERE status = 'dead' AND updated_at < ?`).run(sevenDaysAgo);
    return (r1.changes ?? 0) + (r2.changes ?? 0);
  }

  // ─── DEBT 5 Phase 2: Conversation turn + range CRUD ────────────────────────
  //
  // Helpers for the Variant A persistence layer. Per-turn flow uses the first
  // four; arc-extract flow uses the range helpers + status flip helpers.
  //
  // All helpers throw on missing db. Use INSERT (not INSERT OR IGNORE) so
  // caller sees UNIQUE-constraint violations on duplicate (agent_id, turn_number) —
  // re-entry is a real bug, not silent idempotency.

  createConversationTurn(input: {
    agent_id: string;
    turn_number: number;
    turn_name?: string | null;
    transcript_json: string;  // already-stringified JSON
  }): ConversationTurnRow {
    if (!this.db) throw new Error("Database not initialized");
    const id = `ct_${uuidv4().slice(0, 12)}`;
    const now = new Date().toISOString();
    this.db.prepare(
      `INSERT INTO conversation_turns
         (id, agent_id, turn_number, turn_name, transcript_json, status, created_at)
       VALUES (?, ?, ?, ?, ?, 'captured', ?)`,
    ).run(id, input.agent_id, input.turn_number, input.turn_name ?? null, input.transcript_json, now);
    return this.getConversationTurnById(id)!;
  }

  updateConversationTurnPass01(id: string, pass01_output_json: string): void {
    if (!this.db) throw new Error("Database not initialized");
    const now = new Date().toISOString();
    const r = this.db.prepare(
      `UPDATE conversation_turns
         SET pass01_output_json = ?, pass01_completed_at = ?, status = 'pass01_done'
       WHERE id = ? AND status = 'captured'`,
    ).run(pass01_output_json, now, id);
    if (r.changes === 0) {
      // Either row missing or status was already past 'captured' — both are bugs
      // upstream (caller should not double-flip). Surface loudly.
      throw new Error(`updateConversationTurnPass01: no row updated for id=${id} (already past 'captured' or missing)`);
    }
  }

  /** Lazy-capture REFILL: a turn was marked pass01_done WITHOUT Pass 0-1 (v2 lazy
   *  capture skipped it); v2 then failed at arc, so the v1 fallback computed Pass
   *  0-1 now and writes the items back IN PLACE. Unlike updateConversationTurnPass01
   *  (one-shot captured→pass01_done), this updates an already-pass01_done turn's
   *  items without re-flipping status. Best-effort (no throw): a missing/extracted
   *  row just means the fallback has nothing to fill. */
  refillConversationTurnPass01(id: string, pass01_output_json: string): void {
    if (!this.db) throw new Error("Database not initialized");
    const now = new Date().toISOString();
    this.db.prepare(
      `UPDATE conversation_turns
         SET pass01_output_json = ?, pass01_completed_at = ?
       WHERE id = ? AND status = 'pass01_done'`,
    ).run(pass01_output_json, now, id);
  }

  markConversationTurnExtracted(id: string, pairing_range_id: string): void {
    if (!this.db) throw new Error("Database not initialized");
    const now = new Date().toISOString();
    const r = this.db.prepare(
      `UPDATE conversation_turns
         SET extracted_at = ?, pairing_range_id = ?, status = 'extracted'
       WHERE id = ?`,
    ).run(now, pairing_range_id, id);
    if (r.changes === 0) {
      throw new Error(`markConversationTurnExtracted: no row updated for id=${id} (missing?)`);
    }
  }

  // followup 1: record a FAILED extraction attempt on a range's still-pending
  // turns. NON-destructive — turns stay pass01_done (re-extractable); this only
  // sets a marker so the freshness surface can tell "queued/coming" from "last
  // attempt failed, re-trigger". Best-effort; never throws (a failure path must
  // not be derailed by its own bookkeeping).
  markConversationTurnsExtractFailed(agent_id: string, startTurn: number, endTurn: number, error: string): void {
    if (!this.db) throw new Error("Database not initialized");
    const now = new Date().toISOString();
    this.db.prepare(
      `UPDATE conversation_turns
         SET last_extract_error = ?, last_extract_attempt_at = ?
       WHERE agent_id = ? AND status = 'pass01_done' AND turn_number >= ? AND turn_number <= ?`,
    ).run(String(error).slice(0, 500), now, agent_id, startTurn, endTurn);
  }

  /** Distinct agent_ids whose arc extraction FAILED — turns are still pass01_done (re-extractable)
   *  AND carry a last_extract_error marker. Used by the credit auto-resume to re-fire arc
   *  extraction for arcs that were paused mid-flight: the per-turn reflectQueue's resume-drain
   *  can't reach them (arc turns live here, not in the queue). Targets FAILED arcs only, so an
   *  agent merely accumulating sub-threshold turns isn't extracted prematurely. */
  listAgentsWithFailedArc(): string[] {
    if (!this.db) throw new Error("Database not initialized");
    return (this.db.prepare(
      `SELECT DISTINCT agent_id FROM conversation_turns
        WHERE status = 'pass01_done' AND last_extract_error IS NOT NULL`,
    ).all() as Array<{ agent_id: string }>).map((r) => r.agent_id);
  }

  getConversationTurnById(id: string): ConversationTurnRow | null {
    if (!this.db) throw new Error("Database not initialized");
    return (this.db.prepare(`SELECT * FROM conversation_turns WHERE id = ?`).get(id) as ConversationTurnRow | undefined) ?? null;
  }

  getConversationTurnByAgentTurn(agent_id: string, turn_number: number): ConversationTurnRow | null {
    if (!this.db) throw new Error("Database not initialized");
    return (this.db.prepare(
      `SELECT * FROM conversation_turns WHERE agent_id = ? AND turn_number = ?`,
    ).get(agent_id, turn_number) as ConversationTurnRow | undefined) ?? null;
  }

  listConversationTurnsByAgent(
    agent_id: string,
    opts?: { status?: ConversationTurnStatus; minTurn?: number; maxTurn?: number },
  ): ConversationTurnRow[] {
    if (!this.db) throw new Error("Database not initialized");
    const clauses: string[] = [`agent_id = ?`];
    const params: any[] = [agent_id];
    if (opts?.status !== undefined) { clauses.push(`status = ?`); params.push(opts.status); }
    if (opts?.minTurn !== undefined) { clauses.push(`turn_number >= ?`); params.push(opts.minTurn); }
    if (opts?.maxTurn !== undefined) { clauses.push(`turn_number <= ?`); params.push(opts.maxTurn); }
    return this.db.prepare(
      `SELECT * FROM conversation_turns WHERE ${clauses.join(' AND ')} ORDER BY turn_number ASC`,
    ).all(...params) as ConversationTurnRow[];
  }

  createConversationTurnRange(input: {
    agent_id: string;
    start_turn_number: number;
    end_turn_number: number;
    extraction_type: ConversationExtractionType;
    trigger_source?: string | null;
    pipeline_run_id?: string | null;
    superseded_range_id?: string | null;
  }): ConversationTurnRangeRow {
    if (!this.db) throw new Error("Database not initialized");
    if (input.end_turn_number < input.start_turn_number) {
      throw new Error(`createConversationTurnRange: end_turn_number (${input.end_turn_number}) < start_turn_number (${input.start_turn_number})`);
    }
    const id = `ctr_${uuidv4().slice(0, 12)}`;
    const now = new Date().toISOString();
    this.db.prepare(
      `INSERT INTO conversation_turn_ranges
         (id, agent_id, start_turn_number, end_turn_number, extraction_type, extracted_at, trigger_source, pipeline_run_id, superseded_range_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.agent_id,
      input.start_turn_number,
      input.end_turn_number,
      input.extraction_type,
      now,
      input.trigger_source ?? null,
      input.pipeline_run_id ?? null,
      input.superseded_range_id ?? null,
    );
    return this.getConversationTurnRange(id)!;
  }

  getConversationTurnRange(id: string): ConversationTurnRangeRow | null {
    if (!this.db) throw new Error("Database not initialized");
    return (this.db.prepare(`SELECT * FROM conversation_turn_ranges WHERE id = ?`).get(id) as ConversationTurnRangeRow | undefined) ?? null;
  }

  // ─── DEBT 5 Phase 9: extracted_from provenance join ────────────────────────
  // Records the (block, range) pair. Idempotent — INSERT OR IGNORE on the
  // UNIQUE(block_id, range_id) constraint means a re-call for the same pair
  // is a no-op. Returns true when a new row was created, false on duplicate.

  recordBlockExtraction(block_id: string, range_id: string): boolean {
    if (!this.db) throw new Error("Database not initialized");
    const id = `bx_${uuidv4().slice(0, 12)}`;
    const now = new Date().toISOString();
    const r = this.db.prepare(
      `INSERT OR IGNORE INTO block_extractions (id, block_id, range_id, extracted_at) VALUES (?, ?, ?, ?)`,
    ).run(id, block_id, range_id, now);
    return (r.changes ?? 0) > 0;
  }

  // List range IDs a block was extracted from (chronological — oldest first).
  // Multiple rows when the block has been re-extracted.
  getBlockExtractions(block_id: string): Array<{ id: string; block_id: string; range_id: string; extracted_at: string }> {
    if (!this.db) throw new Error("Database not initialized");
    return this.db.prepare(
      `SELECT * FROM block_extractions WHERE block_id = ? ORDER BY extracted_at ASC`,
    ).all(block_id) as any[];
  }

  // List block IDs produced by a given range (for audit + range diff).
  getBlocksByRange(range_id: string): Array<{ id: string; block_id: string; range_id: string; extracted_at: string }> {
    if (!this.db) throw new Error("Database not initialized");
    return this.db.prepare(
      `SELECT * FROM block_extractions WHERE range_id = ? ORDER BY extracted_at ASC`,
    ).all(range_id) as any[];
  }

  // ─── DEBT 5: agent-facing EXTRACTION FRESHNESS (pull via workspace_stats) ────
  // The agent is a PASSIVE MCP client — the system CANNOT push it a "your arc
  // extracted" signal. So the agent PULLS this inside a read result and learns
  // freshness exactly when it queries. It lets the agent tell three look-alike
  // "empty graph" states apart:
  //   • pending (turns captured, not yet promoted to blocks) → "view may be stale"
  //   • extracted WITH blocks                                → queryable now
  //   • extracted with 0 blocks                              → ran, nothing worth saving
  // Identity is by TOPIC (the {project} label-prefix the arc produced), NOT
  // turn_number — that's host-assigned and the agent never holds it.

  listConversationTurnRangesByAgent(agent_id: string, limit = 5): ConversationTurnRangeRow[] {
    if (!this.db) throw new Error("Database not initialized");
    return this.db.prepare(
      `SELECT * FROM conversation_turn_ranges WHERE agent_id = ? ORDER BY extracted_at DESC LIMIT ?`,
    ).all(agent_id, limit) as ConversationTurnRangeRow[];
  }

  // agent_id is OPTIONAL (followup 2): with it → scoped to that agent; without it
  // → GLOBAL most-recent activity (in single-agent use that IS the caller's own,
  // so the agent gets a freshness signal even without knowing its host-assigned id).
  getExtractionStatus(agent_id?: string, recentLimit = 5): {
    pending: { turns: number; span: string; topics: string[]; failed: boolean; last_error: string | null } | null;
    recent: Array<{ topic: string; turns: string; blocks: number; chain: string | null; extracted_at: string }>;
  } {
    if (!this.db) throw new Error("Database not initialized");

    // PENDING = captured (Pass 0-1 done) but not yet promoted to graph blocks.
    // followup 1: a FAILED arc fail-cleans to here too (turns stay re-extractable)
    // but now carries last_extract_error — so `failed` tells "queued/coming" from
    // "last attempt failed, re-trigger".
    const staged = agent_id
      ? this.listConversationTurnsByAgent(agent_id, { status: 'pass01_done' })
      : (this.db.prepare(`SELECT * FROM conversation_turns WHERE status = 'pass01_done' ORDER BY turn_number ASC`).all() as ConversationTurnRow[]);
    const failedTurns = staged.filter(t => t.last_extract_error);
    const pending = staged.length === 0 ? null : {
      turns: staged.length,
      span: `${staged[0]!.turn_number}-${staged[staged.length - 1]!.turn_number}`,
      topics: [...new Set(staged.map(t => t.turn_name).filter((n): n is string => !!n))].slice(0, 3),
      failed: failedTurns.length > 0,
      last_error: failedTurns.length > 0 ? failedTurns[failedTurns.length - 1]!.last_extract_error : null,
    };

    // RECENT = the last N extracted arcs, summarized by what the agent ACTS on:
    // its topic (to recognize the work), the chain (the readable story handle),
    // and the block count (0 ⇒ ran-but-nothing-worth-saving). One indexed JOIN
    // per range — no getAllBlocks scan.
    const rangeBlocks = this.db.prepare(
      `SELECT b.label AS label, b.type AS type, b.chain_id AS chain_id FROM block_extractions bx
         JOIN blocks b ON b.id = bx.block_id WHERE bx.range_id = ?`,
    );
    const ranges = agent_id
      ? this.listConversationTurnRangesByAgent(agent_id, recentLimit)
      : (this.db.prepare(`SELECT * FROM conversation_turn_ranges ORDER BY extracted_at DESC LIMIT ?`).all(recentLimit) as ConversationTurnRangeRow[]);
    const recent = ranges.map(r => {
      const rows = rangeBlocks.all(r.id) as Array<{ label: string; type: string; chain_id: string | null }>;
      // topic = the most common {project} label-prefix the arc produced.
      const prefixCounts = new Map<string, number>();
      for (const row of rows) {
        const proj = String(row.label).split('_')[0];
        if (proj) prefixCounts.set(proj, (prefixCounts.get(proj) ?? 0) + 1);
      }
      const topic = [...prefixCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]
        ?? `turns ${r.start_turn_number}-${r.end_turn_number}`;
      // chain = the readable-story handle. The Pass-5 chain block is NOT in
      // block_extractions, but the arc's atomic blocks carry chain_id = the chain
      // block's OWN id (verified on real data: atomic.chain_id === chain.id). So:
      // prefer an in-range chain block, else resolve the dominant chain_id to it.
      let chain = rows.find(row => row.type === 'chain')?.label ?? null;
      if (!chain) {
        const chainCounts = new Map<string, number>();
        for (const row of rows) if (row.chain_id) chainCounts.set(row.chain_id, (chainCounts.get(row.chain_id) ?? 0) + 1);
        const topChainId = [...chainCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
        if (topChainId) {
          const cb = this.getBlock(topChainId);
          if (cb && cb.type === 'chain') chain = cb.label;
        }
      }
      return {
        topic,
        turns: `${r.start_turn_number}-${r.end_turn_number}`,
        blocks: rows.length,
        chain,
        extracted_at: r.extracted_at,
      };
    });

    return { pending, recent };
  }

  // ─── DEBT 5 Phase 10: inactivity safety net query ──────────────────────────
  // Returns distinct agent_ids that have AT LEAST ONE pass01_done turn whose
  // OLDEST pass01_done turn is older than `thresholdMs` ago AND no newer
  // 'captured' or 'pass01_done' activity since. These are stale conversations
  // where the agent likely walked away — fire arc extraction to capture before
  // residue is lost forever (per design §3.8 safety net 3).
  //
  // Returns at most `limit` (default 16) to bound work per timer tick.
  getAgentsWithStalePass01Turns(thresholdMs: number, limit = 16): string[] {
    if (!this.db) throw new Error("Database not initialized");
    const cutoff = new Date(Date.now() - thresholdMs).toISOString();
    // Strategy: for each agent_id with pass01_done turns, find the MAX
    // (created_at) across all non-extracted statuses ('captured' OR
    // 'pass01_done') — that's the LAST activity. If MAX < cutoff, the
    // conversation is inactive enough to extract.
    const rows = this.db.prepare(
      `SELECT agent_id, MAX(created_at) AS last_activity
         FROM conversation_turns
        WHERE status IN ('captured', 'pass01_done')
        GROUP BY agent_id
       HAVING last_activity < ?
        ORDER BY last_activity ASC
        LIMIT ?`,
    ).all(cutoff, limit) as Array<{ agent_id: string; last_activity: string }>;
    return rows.map((r) => r.agent_id);
  }
}

