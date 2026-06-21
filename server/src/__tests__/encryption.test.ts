/**
 * Security slice 2 — encryption at rest (NODEDEX_DB_ENCRYPTION_KEY).
 * Run: node --import=tsx/esm --test src/__tests__/encryption.test.ts
 */
import { test, describe, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { WorkspaceDB } from "../store/database.js";

const KEY = "test-enc-key-123";
const dbPath = path.join(os.tmpdir(), `nodedex-enc-test-${process.pid}.db`);

function cleanup() {
  for (const f of [dbPath, dbPath + "-wal", dbPath + "-shm"]) {
    try { fs.unlinkSync(f); } catch { /* ignore */ }
  }
}

describe("encryption at rest", () => {
  afterEach(() => { delete process.env.NODEDEX_DB_ENCRYPTION_KEY; });
  after(cleanup);

  test("round-trip: encrypted on disk, readable with the key", async () => {
    cleanup();
    process.env.NODEDEX_DB_ENCRYPTION_KEY = KEY;
    const db = new WorkspaceDB(dbPath);
    await db.init();
    db.createBlock({ label: "enc_test_fact", type: "fact", essence: "secret essence", content: {}, ttl: "permanent" });
    (db as any)["db"]?.close();

    // the file on disk must NOT be a plaintext SQLite DB
    const head = fs.readFileSync(dbPath).subarray(0, 16).toString("latin1");
    assert.ok(!head.startsWith("SQLite format 3"), "encrypted DB must not carry the plaintext header");

    // reopen with the correct key → the block is readable
    process.env.NODEDEX_DB_ENCRYPTION_KEY = KEY;
    const db2 = new WorkspaceDB(dbPath);
    await db2.init();
    const b = db2.getBlock("enc_test_fact");
    assert.ok(b, "block readable with the correct key");
    assert.equal(b!.essence, "secret essence");
    (db2 as any)["db"]?.close();
  });

  test("wrong key fails loudly at init", async () => {
    process.env.NODEDEX_DB_ENCRYPTION_KEY = "the-WRONG-key";
    const db = new WorkspaceDB(dbPath);
    await assert.rejects(() => db.init(), /could not be opened with it|key is wrong/i);
    try { (db as any)["db"]?.close(); } catch { /* ignore */ }
  });
});
