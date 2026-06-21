/**
 * Ops gap 3 — scheduled/consistent DB backups.
 * Run: node --import=tsx/esm --test src/store/__tests__/backup.test.ts
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import Database from "better-sqlite3";
import { WorkspaceDB } from "../database.js";
import { performBackup } from "../backup.js";

const dir = path.join(os.tmpdir(), `nodedex-backup-test-${process.pid}`);
const dbPath = path.join(dir, "workspace.db");
const backupDir = path.join(dir, "backups");
let db: WorkspaceDB;

before(async () => {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  db = new WorkspaceDB(dbPath);
  await db.init();
  db.createBlock({ label: "backup_test_fact", type: "fact", essence: "backup me", content: {}, ttl: "permanent" });
});

after(() => {
  try { (db as any)["db"]?.close(); } catch { /* ignore */ }
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("performBackup", () => {
  test("creates a consistent, readable backup", () => {
    const r = performBackup(db, { keep: 5 });
    assert.ok(r.backed_up, "returns a backup path");
    assert.ok(fs.existsSync(r.backed_up!), "backup file exists");
    const bk = new Database(r.backed_up!, { readonly: true });
    const row = bk.prepare("SELECT essence FROM blocks WHERE label = 'backup_test_fact'").get() as any;
    bk.close();
    assert.equal(row?.essence, "backup me", "backup contains the written block (checkpoint folded the WAL in)");
  });

  test("rotates to the most recent `keep`", () => {
    for (let i = 0; i < 6; i++) fs.writeFileSync(path.join(backupDir, `workspace-2026-01-0${i}.db`), "x");
    performBackup(db, { keep: 5 });
    const remaining = fs.readdirSync(backupDir).filter((f) => /^workspace-.*\.db$/.test(f));
    assert.equal(remaining.length, 5, "keeps exactly 5");
  });

  test("throttle skips a too-soon backup", () => {
    const r = performBackup(db, { throttleMs: 60 * 60 * 1000, keep: 5 });
    assert.equal(r.skipped, true);
  });
});
