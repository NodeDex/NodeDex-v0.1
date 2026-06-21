import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import { WorkspaceDB } from "../../../store/database.js";
import { writePipelineFlag, getFlagById } from "../pipeline-flags.js";
import { applyFlagVerdict } from "../apply-flag-verdict.js";

// applyFlagVerdict is the ONE mechanical applier shared by the REST review endpoint
// and the NL accept-path. These lock its validation + merge semantics so neither
// surface can diverge.

const TEST_DB = path.resolve("/tmp/apply_verdict_test.db");
let db: WorkspaceDB;
let raw: Database.Database;

function cleanFiles() {
  for (const s of ["", "-wal", "-shm"]) {
    try { if (fs.existsSync(TEST_DB + s)) fs.unlinkSync(TEST_DB + s); } catch { /* ignore */ }
  }
}
function mkBlock(label: string, choice: string) {
  return db.createBlock({ label, type: "decision", essence: `essence ${label}`,
    content: { unique: { choice } }, concepts: [], ttl: "permanent" });
}
function writeFlag(aId: string, bId: string | null) {
  return writePipelineFlag(raw, {
    flag_type: "cross_arc_dup_candidate", block_id_a: aId, block_id_b: bId,
    criteria: {}, scope_check: "unknown", origin_writer: "stage_d_resolve", origin_range_id: null,
  });
}

before(async () => { cleanFiles(); db = new WorkspaceDB(TEST_DB); await db.init(); raw = (db as any)["db"]; });
after(() => { try { (db as any)["db"]?.close(); } catch { /* ignore */ } cleanFiles(); });
beforeEach(() => {
  raw.pragma("foreign_keys = OFF");
  raw.exec(`DELETE FROM pipeline_flags`); raw.exec(`DELETE FROM relations`); raw.exec(`DELETE FROM blocks`);
  raw.pragma("foreign_keys = ON");
});

describe("applyFlagVerdict", () => {
  test("leave: marks reviewed, archives nothing", () => {
    const a = mkBlock("p_decision_a", "x"); const b = mkBlock("p_decision_b", "y");
    const id = writeFlag(a.id, b.id);
    const res = applyFlagVerdict(db, getFlagById(raw, id)!, { verdict: "leave", reason: "different scopes" });
    assert.ok(res.ok); assert.equal((res as any).action_taken, "none");
    assert.notEqual(db.getBlock(a.id)!.status, "archived");
    assert.notEqual(db.getBlock(b.id)!.status, "archived");
    assert.equal(getFlagById(raw, id)!.review_verdict, "leave");
  });

  test("merge + execute: archives the loser and wires supersedes", () => {
    const a = mkBlock("p_decision_keep", "x"); const b = mkBlock("p_decision_drop", "x");
    const id = writeFlag(a.id, b.id);
    const res = applyFlagVerdict(db, getFlagById(raw, id)!, { verdict: "merge", execute: true, winning_block_id: a.id, reason: "same claim" });
    assert.ok(res.ok);
    assert.equal((res as any).action_taken, "archived_loser_and_wired_superseded_by");
    assert.equal(db.getBlock(b.id)!.status, "archived", "loser archived");
    assert.notEqual(db.getBlock(a.id)!.status, "archived", "winner stays");
  });

  test("missing reason → REASON_REQUIRED", () => {
    const a = mkBlock("p_decision_a", "x"); const b = mkBlock("p_decision_b", "y");
    const res = applyFlagVerdict(db, getFlagById(raw, writeFlag(a.id, b.id))!, { verdict: "leave", reason: "  " });
    assert.equal(res.ok, false); assert.equal((res as any).code, "REASON_REQUIRED");
  });

  test("merge winner not in the pair → BAD_WINNER (no archive)", () => {
    const a = mkBlock("p_decision_a", "x"); const b = mkBlock("p_decision_b", "x");
    const res = applyFlagVerdict(db, getFlagById(raw, writeFlag(a.id, b.id))!, { verdict: "merge", execute: true, winning_block_id: "not-a-block", reason: "same" });
    assert.equal(res.ok, false); assert.equal((res as any).code, "BAD_WINNER");
    assert.notEqual(db.getBlock(a.id)!.status, "archived");
    assert.notEqual(db.getBlock(b.id)!.status, "archived");
  });

  test("single-block merge → NO_LOSER", () => {
    const a = mkBlock("p_decision_a", "x");
    const res = applyFlagVerdict(db, getFlagById(raw, writeFlag(a.id, null))!, { verdict: "merge", execute: true, winning_block_id: a.id, reason: "same" });
    assert.equal(res.ok, false); assert.equal((res as any).code, "NO_LOSER");
  });

  test("already-reviewed flag → ALREADY_REVIEWED on second apply", () => {
    const a = mkBlock("p_decision_a", "x"); const b = mkBlock("p_decision_b", "y");
    const id = writeFlag(a.id, b.id);
    assert.ok(applyFlagVerdict(db, getFlagById(raw, id)!, { verdict: "leave", reason: "first" }).ok);
    const second = applyFlagVerdict(db, getFlagById(raw, id)!, { verdict: "leave", reason: "again" });
    assert.equal(second.ok, false); assert.equal((second as any).code, "ALREADY_REVIEWED");
  });
});
