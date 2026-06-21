/**
 * Security slice 1 — auth seam + network bind.
 * Run: node --import=tsx/esm --test src/__tests__/auth.test.ts
 */
import { test, describe, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { WorkspaceDB } from "../store/database.js";
import { startApiServer } from "../api-server.js";
import {
  resolveBindHost, safeEqual, extractCredential, validateCredential,
  defaultAuthExempt, apiTokenEnabled,
} from "../middleware/auth.js";
import type { Server } from "http";

// ─── Pure helpers (no socket) ────────────────────────────────────────────────

describe("resolveBindHost", () => {
  afterEach(() => { delete process.env.NODEDEX_BIND_HOST; });
  test("defaults to loopback when unset", () => {
    delete process.env.NODEDEX_BIND_HOST;
    assert.equal(resolveBindHost(), "127.0.0.1");
  });
  test("respects an explicit override (intentional exposure)", () => {
    process.env.NODEDEX_BIND_HOST = "0.0.0.0";
    assert.equal(resolveBindHost(), "0.0.0.0");
  });
});

describe("safeEqual", () => {
  test("equal strings", () => assert.equal(safeEqual("abc123", "abc123"), true));
  test("different strings", () => assert.equal(safeEqual("abc123", "abc124"), false));
  test("different length is false (no throw)", () => assert.equal(safeEqual("abc", "abcd"), false));
  test("empty vs empty", () => assert.equal(safeEqual("", ""), true));
});

describe("extractCredential", () => {
  test("dedicated header wins over Authorization", () => {
    const req: any = { headers: { "x-nodedex-token": "tok-x", authorization: "Bearer tok-bearer" } };
    assert.equal(extractCredential(req), "tok-x");
  });
  test("falls back to Authorization: Bearer", () => {
    const req: any = { headers: { authorization: "Bearer tok-bearer" } };
    assert.equal(extractCredential(req), "tok-bearer");
  });
  test("empty when neither present", () => {
    assert.equal(extractCredential({ headers: {} } as any), "");
  });
});

describe("validateCredential (the swap point)", () => {
  afterEach(() => { delete process.env.NODEDEX_API_TOKEN; });
  test("null when no token configured (caller checks apiTokenEnabled first)", () => {
    delete process.env.NODEDEX_API_TOKEN;
    assert.equal(validateCredential("anything"), null);
  });
  test("owner identity on exact match", () => {
    process.env.NODEDEX_API_TOKEN = "s3cret";
    assert.deepEqual(validateCredential("s3cret"), { kind: "owner" });
  });
  test("null on mismatch", () => {
    process.env.NODEDEX_API_TOKEN = "s3cret";
    assert.equal(validateCredential("wrong"), null);
  });
});

describe("defaultAuthExempt", () => {
  test("health is exempt (supervisors poll it)", () => assert.equal(defaultAuthExempt("/api/health"), true));
  test("chat-proxy is exempt (BYO-key passthrough)", () => assert.equal(defaultAuthExempt("/api/chat/completions"), true));
  test("non-/api page is exempt (e.g. /upgrade)", () => assert.equal(defaultAuthExempt("/upgrade"), true));
  test("data path is NOT exempt", () => assert.equal(defaultAuthExempt("/api/blocks"), false));
});

describe("apiTokenEnabled", () => {
  afterEach(() => { delete process.env.NODEDEX_API_TOKEN; });
  test("off when unset", () => { delete process.env.NODEDEX_API_TOKEN; assert.equal(apiTokenEnabled(), false); });
  test("on when set", () => { process.env.NODEDEX_API_TOKEN = "x"; assert.equal(apiTokenEnabled(), true); });
});

// ─── Gate over real HTTP ─────────────────────────────────────────────────────

const TEST_DB = "/tmp/wmcs_auth_test.db";
let db: WorkspaceDB;
let server: Server;
let baseUrl: string;
const TOKEN = "test-token-abc123";

before(async () => {
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  db = new WorkspaceDB(TEST_DB);
  await db.init();
  db.createBlock({ label: "auth_test_fact", type: "fact", essence: "fact", content: {}, ttl: "permanent" });
  // Boot with the token UNSET so the bind/listen default path is exercised;
  // each test toggles NODEDEX_API_TOKEN, which requireAuth reads per-request.
  delete process.env.NODEDEX_API_TOKEN;
  server = startApiServer(db, undefined, 0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const addr = server.address() as { port: number };
  baseUrl = `http://localhost:${addr.port}`;
});

after(() => {
  delete process.env.NODEDEX_API_TOKEN;
  server.close();
  try { (db as any)["db"]?.close(); } catch { /* ignore */ }
  for (const f of [TEST_DB, TEST_DB + "-wal", TEST_DB + "-shm"]) {
    try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch { /* ignore */ }
  }
});

afterEach(() => { delete process.env.NODEDEX_API_TOKEN; }); // never leak the lock into other suites

describe("API auth gate", () => {
  test("token OFF → reads are open (non-breaking)", async () => {
    delete process.env.NODEDEX_API_TOKEN;
    const res = await fetch(`${baseUrl}/api/blocks?limit=1`);
    assert.equal(res.status, 200);
  });

  test("token ON, no credential → 401 on a data path", async () => {
    process.env.NODEDEX_API_TOKEN = TOKEN;
    const res = await fetch(`${baseUrl}/api/blocks?limit=1`);
    assert.equal(res.status, 401);
  });

  test("token ON, correct x-nodedex-token → 200", async () => {
    process.env.NODEDEX_API_TOKEN = TOKEN;
    const res = await fetch(`${baseUrl}/api/blocks?limit=1`, { headers: { "x-nodedex-token": TOKEN } });
    assert.equal(res.status, 200);
  });

  test("token ON, correct Authorization: Bearer → 200", async () => {
    process.env.NODEDEX_API_TOKEN = TOKEN;
    const res = await fetch(`${baseUrl}/api/blocks?limit=1`, { headers: { authorization: `Bearer ${TOKEN}` } });
    assert.equal(res.status, 200);
  });

  test("token ON, wrong token → 401", async () => {
    process.env.NODEDEX_API_TOKEN = TOKEN;
    const res = await fetch(`${baseUrl}/api/blocks?limit=1`, { headers: { "x-nodedex-token": "nope" } });
    assert.equal(res.status, 401);
  });

  test("token ON → writes are gated too (POST without credential → 401)", async () => {
    process.env.NODEDEX_API_TOKEN = TOKEN;
    const res = await fetch(`${baseUrl}/api/blocks`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ label: "should_not_save", type: "fact", essence: "x" }),
    });
    assert.equal(res.status, 401);
  });

  test("token ON → /api/health stays open (supervisor exemption)", async () => {
    process.env.NODEDEX_API_TOKEN = TOKEN;
    const res = await fetch(`${baseUrl}/api/health`);
    assert.equal(res.status, 200);
  });
});
