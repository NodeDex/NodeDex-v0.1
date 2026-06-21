/**
 * DEBT 5 Slice 1 (Sub-step 1.1) — pipeline_flags table + writer/reader tests.
 *
 * Verifies the contract that Sub-step 1.4 (Stage FLAG) and Slice 2 (async
 * reviewer) will rely on:
 *   - ensurePipelineFlagsTable is idempotent
 *   - writePipelineFlag generates id, JSON-serializes criteria, returns id
 *   - getPendingFlags returns unreviewed only, respects filters + limit
 *   - getFlagsForBlock returns all flags touching a block id (a or b)
 *   - summarizePipelineFlags counts correctly + groups by type/writer
 *   - round-trip: writing then reading yields equivalent shape
 *
 * Run: node --import=tsx/esm --test src/middleware/reflect/__tests__/pipeline-flags.test.ts
 */
import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import {
  ensurePipelineFlagsTable,
  writePipelineFlag,
  getPendingFlags,
  getFlagsForBlock,
  summarizePipelineFlags,
  type WritePipelineFlagInput,
} from "../pipeline-flags.js";

const TEST_DB = path.resolve("/tmp/pipeline_flags_test.db");

let db: Database.Database;

before(() => {
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  if (fs.existsSync(TEST_DB + "-wal")) fs.unlinkSync(TEST_DB + "-wal");
  if (fs.existsSync(TEST_DB + "-shm")) fs.unlinkSync(TEST_DB + "-shm");
  db = new Database(TEST_DB);
  // pipeline_flags has FK to blocks + conversation_turn_ranges. Production DB
  // enables foreign_keys=ON (database.ts:173); here we leave it OFF so we can
  // use synthetic block_ids without creating the entire schema. FK enforcement
  // is covered by WorkspaceDB integration tests, not by this module test.
  db.pragma("foreign_keys = OFF");
  ensurePipelineFlagsTable(db);
});

after(() => {
  try { db.close(); } catch { /* ignore */ }
  try { if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB); } catch { /* ignore */ }
  try { if (fs.existsSync(TEST_DB + "-wal")) fs.unlinkSync(TEST_DB + "-wal"); } catch { /* ignore */ }
  try { if (fs.existsSync(TEST_DB + "-shm")) fs.unlinkSync(TEST_DB + "-shm"); } catch { /* ignore */ }
});

beforeEach(() => {
  db.exec(`DELETE FROM pipeline_flags`);
});

// ─── Helpers ───────────────────────────────────────────────────────────────────

function mkInput(overrides: Partial<WritePipelineFlagInput> = {}): WritePipelineFlagInput {
  return {
    flag_type:       'project_dup_candidate',
    block_id_a:      'blk_a',
    block_id_b:      'blk_b',
    criteria:        { value_match: 'json-api-service', overlap_score: 0.85, shared_keys: ['tech', 'entities'] },
    scope_check:     'unknown',
    origin_writer:   'stage_flag_dedup',
    origin_range_id: 'ctr_test_1',
    ...overrides,
  };
}

// ─── ensurePipelineFlagsTable ─────────────────────────────────────────────────

describe("ensurePipelineFlagsTable", () => {
  test("idempotent — second call doesn't error or destroy data", () => {
    writePipelineFlag(db, mkInput());
    ensurePipelineFlagsTable(db);    // call again
    ensurePipelineFlagsTable(db);    // and again
    const rows = db.prepare(`SELECT COUNT(*) as n FROM pipeline_flags`).get() as { n: number };
    assert.equal(rows.n, 1);
  });
});

// ─── writePipelineFlag ────────────────────────────────────────────────────────

describe("writePipelineFlag", () => {
  test("returns a generated id with pfl_ prefix", () => {
    const id = writePipelineFlag(db, mkInput());
    assert.match(id, /^pfl_[0-9a-f-]+$/);
  });

  test("writes all fields including JSON-serialized criteria", () => {
    const id = writePipelineFlag(db, mkInput({ criteria: { foo: "bar", n: 42, arr: [1, 2] } }));
    const row = db.prepare(`SELECT * FROM pipeline_flags WHERE id = ?`).get(id) as any;
    assert.equal(row.flag_type, 'project_dup_candidate');
    assert.equal(row.block_id_a, 'blk_a');
    assert.equal(row.block_id_b, 'blk_b');
    assert.equal(row.scope_check, 'unknown');
    assert.equal(row.origin_writer, 'stage_flag_dedup');
    assert.equal(row.origin_range_id, 'ctr_test_1');
    const criteria = JSON.parse(row.criteria_json);
    assert.deepEqual(criteria, { foo: "bar", n: 42, arr: [1, 2] });
    // review/action fields all NULL on fresh write
    assert.equal(row.reviewed_at, null);
    assert.equal(row.review_verdict, null);
    assert.equal(row.action_taken, null);
  });

  test("created_at is an ISO timestamp", () => {
    const id = writePipelineFlag(db, mkInput());
    const row = db.prepare(`SELECT created_at FROM pipeline_flags WHERE id = ?`).get(id) as { created_at: string };
    // ISO format: YYYY-MM-DDTHH:MM:SS...Z
    assert.match(row.created_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  test("block_id_b nullable for single-block flags (e.g., scope warning)", () => {
    const id = writePipelineFlag(db, mkInput({ block_id_b: null, flag_type: 'scope_disagreement' }));
    const row = db.prepare(`SELECT * FROM pipeline_flags WHERE id = ?`).get(id) as any;
    assert.equal(row.block_id_b, null);
    assert.equal(row.flag_type, 'scope_disagreement');
  });

  test("origin_range_id nullable for non-arc sources (Stage AUDIT background)", () => {
    const id = writePipelineFlag(db, mkInput({
      origin_range_id: null,
      origin_writer: 'stage_audit_islands',
      flag_type: 'island_candidate',
    }));
    const row = db.prepare(`SELECT origin_range_id, origin_writer FROM pipeline_flags WHERE id = ?`).get(id) as any;
    assert.equal(row.origin_range_id, null);
    assert.equal(row.origin_writer, 'stage_audit_islands');
  });
});

// ─── getPendingFlags ──────────────────────────────────────────────────────────

describe("getPendingFlags", () => {
  test("returns only unreviewed (reviewed_at IS NULL)", () => {
    const id1 = writePipelineFlag(db, mkInput({ block_id_a: 'blk_1' }));
    const id2 = writePipelineFlag(db, mkInput({ block_id_a: 'blk_2' }));
    // Mark id1 as reviewed
    db.prepare(`UPDATE pipeline_flags SET reviewed_at = ?, review_verdict = ? WHERE id = ?`)
      .run(new Date().toISOString(), 'merge', id1);
    const pending = getPendingFlags(db);
    assert.equal(pending.length, 1);
    assert.equal(pending[0]!.id, id2);
  });

  test("filters by flag_type", () => {
    writePipelineFlag(db, mkInput({ flag_type: 'project_dup_candidate', block_id_a: 'blk_p' }));
    writePipelineFlag(db, mkInput({ flag_type: 'atomic_dup_candidate',  block_id_a: 'blk_a' }));
    writePipelineFlag(db, mkInput({ flag_type: 'island_candidate', block_id_a: 'blk_i', origin_writer: 'stage_audit_islands' }));
    const projects = getPendingFlags(db, { flag_type: 'project_dup_candidate' });
    assert.equal(projects.length, 1);
    assert.equal(projects[0]!.flag_type, 'project_dup_candidate');
  });

  test("filters by origin_writer", () => {
    writePipelineFlag(db, mkInput({ origin_writer: 'stage_flag_dedup', block_id_a: 'blk_f' }));
    writePipelineFlag(db, mkInput({ origin_writer: 'stage_audit_scope', flag_type: 'scope_disagreement', block_id_a: 'blk_s' }));
    const audits = getPendingFlags(db, { origin_writer: 'stage_audit_scope' });
    assert.equal(audits.length, 1);
    assert.equal(audits[0]!.origin_writer, 'stage_audit_scope');
  });

  test("respects limit", () => {
    for (let i = 0; i < 5; i++) {
      writePipelineFlag(db, mkInput({ block_id_a: `blk_${i}` }));
    }
    const limited = getPendingFlags(db, { limit: 2 });
    assert.equal(limited.length, 2);
  });

  test("orders by created_at ASC (oldest first — FIFO for reviewer)", async () => {
    const id1 = writePipelineFlag(db, mkInput({ block_id_a: 'blk_old' }));
    await new Promise(r => setTimeout(r, 20));   // small delay to differentiate timestamps
    const id2 = writePipelineFlag(db, mkInput({ block_id_a: 'blk_new' }));
    const pending = getPendingFlags(db);
    assert.equal(pending[0]!.id, id1);
    assert.equal(pending[1]!.id, id2);
  });

  test("parses criteria_json back into criteria object", () => {
    writePipelineFlag(db, mkInput({ criteria: { test: true, count: 7 } }));
    const [flag] = getPendingFlags(db);
    assert.deepEqual(flag!.criteria, { test: true, count: 7 });
  });
});

// ─── getFlagsForBlock ─────────────────────────────────────────────────────────

describe("getFlagsForBlock", () => {
  test("returns flags where block is block_id_a", () => {
    writePipelineFlag(db, mkInput({ block_id_a: 'blk_target', block_id_b: 'blk_other' }));
    const flags = getFlagsForBlock(db, 'blk_target');
    assert.equal(flags.length, 1);
  });

  test("returns flags where block is block_id_b", () => {
    writePipelineFlag(db, mkInput({ block_id_a: 'blk_other', block_id_b: 'blk_target' }));
    const flags = getFlagsForBlock(db, 'blk_target');
    assert.equal(flags.length, 1);
  });

  test("returns BOTH reviewed and unreviewed (full history)", () => {
    const id1 = writePipelineFlag(db, mkInput({ block_id_a: 'blk_x' }));
    const id2 = writePipelineFlag(db, mkInput({ block_id_a: 'blk_x' }));
    db.prepare(`UPDATE pipeline_flags SET reviewed_at = ?, review_verdict = ? WHERE id = ?`)
      .run(new Date().toISOString(), 'leave', id1);
    const flags = getFlagsForBlock(db, 'blk_x');
    assert.equal(flags.length, 2);
  });

  test("returns empty array for block with no flags", () => {
    writePipelineFlag(db, mkInput({ block_id_a: 'blk_x' }));
    const flags = getFlagsForBlock(db, 'blk_nonexistent');
    assert.deepEqual(flags, []);
  });
});

// ─── summarizePipelineFlags ───────────────────────────────────────────────────

describe("summarizePipelineFlags", () => {
  test("counts total + unreviewed + groups by type and writer", () => {
    const id1 = writePipelineFlag(db, mkInput({ flag_type: 'project_dup_candidate', block_id_a: 'blk_1' }));
    writePipelineFlag(db, mkInput({ flag_type: 'project_dup_candidate', block_id_a: 'blk_2' }));
    writePipelineFlag(db, mkInput({ flag_type: 'atomic_dup_candidate',  block_id_a: 'blk_3' }));
    writePipelineFlag(db, mkInput({ flag_type: 'island_candidate', block_id_a: 'blk_4', origin_writer: 'stage_audit_islands' }));
    // Mark one as reviewed
    db.prepare(`UPDATE pipeline_flags SET reviewed_at = ?, review_verdict = ? WHERE id = ?`)
      .run(new Date().toISOString(), 'merge', id1);

    const summary = summarizePipelineFlags(db);
    assert.equal(summary.total, 4);
    assert.equal(summary.unreviewed, 3);

    // by_type — find the project_dup_candidate row, should have count=2
    const projectRow = summary.by_type.find(r => r.flag_type === 'project_dup_candidate');
    assert.equal(projectRow?.count, 2);

    // by_writer — stage_flag_dedup should have 3, stage_audit_islands should have 1
    const dedupRow = summary.by_writer.find(r => r.origin_writer === 'stage_flag_dedup');
    const auditRow = summary.by_writer.find(r => r.origin_writer === 'stage_audit_islands');
    assert.equal(dedupRow?.count, 3);
    assert.equal(auditRow?.count, 1);
  });

  test("empty table — total + unreviewed both 0", () => {
    const summary = summarizePipelineFlags(db);
    assert.equal(summary.total, 0);
    assert.equal(summary.unreviewed, 0);
    assert.deepEqual(summary.by_type, []);
    assert.deepEqual(summary.by_writer, []);
  });
});
