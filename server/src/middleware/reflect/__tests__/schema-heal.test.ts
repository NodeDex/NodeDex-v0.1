// schema-heal.test.ts — the retroactive demote backfill (correct, never delete).
import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import os from "os";
import { WorkspaceDB } from "../../../store/database.js";
import { healSchemaDemotes, schemaHealEnabled, startSchemaHealTimer, stopSchemaHealTimer, _isSchemaHealTimerRunningForTests } from "../schema-heal.js";

const TEST_DB = path.join(os.tmpdir(), "schema-heal-test.db");
let db: WorkspaceDB;

function cleanFiles() {
  for (const s of ["", "-wal", "-shm"]) {
    try { if (fs.existsSync(TEST_DB + s)) fs.unlinkSync(TEST_DB + s); } catch { /* ignore */ }
  }
}

before(async () => { cleanFiles(); db = new WorkspaceDB(TEST_DB); await db.init(); });
after(() => { try { (db as unknown as { db?: { close(): void } }).db?.close(); } catch { /* ignore */ } cleanFiles(); });
beforeEach(() => {
  const raw = (db as unknown as { db: { pragma(s: string): void; exec(s: string): void } }).db;
  raw.pragma("foreign_keys = OFF");
  raw.exec(`DELETE FROM relations`);
  raw.exec(`DELETE FROM blocks`);
  raw.pragma("foreign_keys = ON");
});

// createBlock doesn't take review_status; set the flag via updateBlock (the real path).
function seed(label: string, type: string, unique: Record<string, unknown>, flagged = false) {
  const b = db.createBlock({ label, type, essence: `essence of ${label}`, content: { unique }, concepts: [], ttl: "permanent" });
  if (flagged) db.updateBlock(b.id, { review_status: "needs_review", review_reason: `schema_mismatch: type=${type}` }, "seed", "test");
  return b;
}
const status = (id: string) => (db.getBlock(id) as unknown as { review_status?: string } | null)?.review_status;
const uniqueOf = (id: string) => JSON.parse((db.getBlock(id)!.content as string) || "{}").unique;

describe("healSchemaDemotes", () => {
  test("heals a demotable insight (no implication) → fact, flag cleared", () => {
    const b = seed("proj_insight_low-coffee", "insight", { observation: "User is low on coffee" }, true);
    const res = healSchemaDemotes(db);
    assert.equal(res.healed, 1);
    assert.equal(res.collided, 0);
    assert.equal(res.skipped, 0);
    const after = db.getBlock(b.id);
    assert.equal(after?.type, "fact");
    assert.equal(after?.label, "proj_fact_low-coffee");
    assert.equal(status(b.id), "corrected");
    assert.equal(uniqueOf(b.id).value, "User is low on coffee"); // observation mapped to value
  });

  test("leaves a collision flagged (demoted label already exists = a dup for the dup-reviewer)", () => {
    seed("proj_fact_low-coffee", "fact", { value: "existing" });          // target label taken
    const ins = seed("proj_insight_low-coffee", "insight", { observation: "User is low on coffee" }, true);
    const res = healSchemaDemotes(db);
    assert.equal(res.healed, 0);
    assert.equal(res.collided, 1);
    assert.equal(db.getBlock(ins.id)?.type, "insight");                   // unchanged
    assert.equal(status(ins.id), "needs_review");                         // still flagged
  });

  test("skips a non-demotable flag (task missing description → no DEMOTE_TARGETS row)", () => {
    const t = seed("proj_task_buy-coffee", "task", { status: "open" }, true);
    const res = healSchemaDemotes(db);
    assert.equal(res.healed, 0);
    assert.equal(res.skipped, 1);
    assert.equal(status(t.id), "needs_review");                          // left flagged
  });

  test("ignores blocks that aren't needs_review", () => {
    seed("proj_insight_ok", "insight", { observation: "x", implication: "y" }); // valid, unflagged
    const res = healSchemaDemotes(db);
    assert.equal(res.flagged, 0);
    assert.equal(res.healed, 0);
  });
});

describe("schema-heal background sweep (Tier-1 default-ON)", () => {
  const saved = process.env.NODEDEX_SCHEMA_HEAL_ENABLED;
  after(() => { stopSchemaHealTimer(); if (saved === undefined) delete process.env.NODEDEX_SCHEMA_HEAL_ENABLED; else process.env.NODEDEX_SCHEMA_HEAL_ENABLED = saved; });

  test("enabled by default (opt-out only)", () => {
    delete process.env.NODEDEX_SCHEMA_HEAL_ENABLED;
    assert.equal(schemaHealEnabled(), true);
    process.env.NODEDEX_SCHEMA_HEAL_ENABLED = "off";
    assert.equal(schemaHealEnabled(), false);
  });

  test("starts the timer when enabled, no-op when off", () => {
    stopSchemaHealTimer();
    process.env.NODEDEX_SCHEMA_HEAL_ENABLED = "off";
    assert.equal(startSchemaHealTimer(db), false);
    assert.equal(_isSchemaHealTimerRunningForTests(), false);
    process.env.NODEDEX_SCHEMA_HEAL_ENABLED = "on";
    assert.equal(startSchemaHealTimer(db), true);
    assert.equal(_isSchemaHealTimerRunningForTests(), true);
    assert.equal(startSchemaHealTimer(db), false); // idempotent — already running
    stopSchemaHealTimer();
    assert.equal(_isSchemaHealTimerRunningForTests(), false);
  });
});
