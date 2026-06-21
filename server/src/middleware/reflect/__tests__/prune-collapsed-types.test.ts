import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import { WorkspaceDB } from "../../../store/database.js";
import { pruneCollapsedTypes, COLLAPSED_TYPE_NAMES } from "../prune-collapsed-types.js";

const TEST_DB = path.resolve("/tmp/prune_collapsed_test.db");
let db: WorkspaceDB;
let raw: Database.Database;

function cleanFiles() {
  for (const s of ["", "-wal", "-shm"]) { try { if (fs.existsSync(TEST_DB + s)) fs.unlinkSync(TEST_DB + s); } catch { /* ignore */ } }
}
before(async () => { cleanFiles(); db = new WorkspaceDB(TEST_DB); await db.init(); raw = (db as any)["db"] as Database.Database; });
after(() => { try { (db as any)["db"]?.close(); } catch { /* ignore */ } cleanFiles(); });

describe("pruneCollapsedTypes", () => {
  test("current-code DB has no collapsed-type rows to prune", () => {
    // the seed already excludes them, so a freshly-init'd DB is already clean
    const r = pruneCollapsedTypes(db);
    assert.deepEqual(r.deleted, []);
  });

  test("removes exactly the 3 pre-collapse rows, keeps everything else", () => {
    // simulate a DB seeded BEFORE the collapse: the 3 rows linger
    const ins = raw.prepare(`INSERT OR IGNORE INTO block_types (name, extends, description, typical_fields) VALUES (?,?,?,?)`);
    ins.run("reasoning_chain", "insight", "old", "[]");
    ins.run("metric", "fact", "old", "[]");
    ins.run("claim", "fact", "old", "[]");
    const before = (raw.prepare(`SELECT COUNT(*) AS n FROM block_types`).get() as any).n;

    const r = pruneCollapsedTypes(db);
    assert.deepEqual([...r.deleted].sort(), [...COLLAPSED_TYPE_NAMES].sort());
    assert.equal(r.remaining_types, before - 3);

    for (const keep of ["fact", "insight", "decision", "entity", "artifact", "hypothesis", "event"]) {
      assert.ok(raw.prepare(`SELECT 1 FROM block_types WHERE name = ?`).get(keep), `${keep} must remain`);
    }
    for (const gone of COLLAPSED_TYPE_NAMES) {
      assert.ok(!raw.prepare(`SELECT 1 FROM block_types WHERE name = ?`).get(gone), `${gone} must be gone`);
    }
  });

  test("idempotent — a second prune deletes nothing", () => {
    const r = pruneCollapsedTypes(db);
    assert.deepEqual(r.deleted, []);
  });
});
