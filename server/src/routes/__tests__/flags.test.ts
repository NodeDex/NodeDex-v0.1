/**
 * DEBT 5 Slice 2 Sub-step 2.4 — /api/flags REST endpoint tests.
 *
 * Boots a real api-server on a random port (matches src/__tests__/api.test.ts
 * harness) so route wiring + JSON body parsing + the executeMerge path are all
 * exercised end-to-end. No LLM (manual review is operator-driven, no model).
 *
 * Covers:
 *   GET /api/flags/summary       — counts
 *   GET /api/flags               — list + filters (flag_type, reviewed, block_id)
 *   GET /api/flags/:id           — single flag + both blocks embedded; 404
 *   POST /api/flags/:id/review   — verdict-only; merge+execute (archive+relation);
 *                                  validation (bad verdict / missing reason /
 *                                  bad winning_block_id); 409 on already-reviewed
 *
 * Run: node --import=tsx/esm --test src/routes/__tests__/flags.test.ts
 */
import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import type Database from "better-sqlite3";
import type { Server } from "http";
import { WorkspaceDB } from "../../store/database.js";
import { startApiServer } from "../../api-server.js";
import { writePipelineFlag, markFlagPendingClarification } from "../../middleware/reflect/pipeline-flags.js";

const TEST_DB = "/tmp/wmcs_flags_route_test.db";
let db: WorkspaceDB;
let raw: Database.Database;
let server: Server;
let baseUrl: string;

function cleanFiles() {
  for (const s of ["", "-wal", "-shm"]) {
    try { if (fs.existsSync(TEST_DB + s)) fs.unlinkSync(TEST_DB + s); } catch { /* ignore */ }
  }
}

before(async () => {
  cleanFiles();
  db = new WorkspaceDB(TEST_DB);
  await db.init();
  raw = (db as any)["db"] as Database.Database;
  server = startApiServer(db, undefined, 0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const addr = server.address() as { port: number };
  baseUrl = `http://localhost:${addr.port}`;
});

after(() => {
  server.close();
  try { (db as any)["db"]?.close(); } catch { /* ignore */ }
  cleanFiles();
});

beforeEach(() => {
  raw.pragma("foreign_keys = OFF");
  raw.exec(`DELETE FROM pipeline_flags`);
  raw.exec(`DELETE FROM relations`);
  raw.exec(`DELETE FROM blocks`);
  raw.pragma("foreign_keys = ON");
});

function mkBlock(label: string, opts: { concepts?: string[]; type?: string } = {}) {
  return db.createBlock({
    label, type: opts.type ?? "fact", essence: `essence ${label}`,
    content: { value: label }, concepts: opts.concepts ?? [], ttl: "permanent",
  });
}

function writeFlag(a: string, b: string | null, flag_type: any = "atomic_dup_candidate") {
  return writePipelineFlag(raw, {
    flag_type, block_id_a: a, block_id_b: b,
    criteria: { value_match: "x" }, scope_check: "unknown",
    origin_writer: "stage_flag_dedup", origin_range_id: null,
  });
}

// ─── GET summary + list ─────────────────────────────────────────────────────────

describe("GET /api/flags/summary + /api/flags", () => {
  test("summary counts total + unreviewed + by_type", async () => {
    const a = mkBlock("sum_a"); const b = mkBlock("sum_b");
    writeFlag(a.id, b.id, "atomic_dup_candidate");
    writeFlag(a.id, b.id, "island_candidate");
    const res = await fetch(`${baseUrl}/api/flags/summary`);
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.total, 2);
    assert.equal(json.unreviewed, 2);
    assert.ok(Array.isArray(json.by_type));
  });

  test("list returns all flags, count matches", async () => {
    const a = mkBlock("list_a"); const b = mkBlock("list_b");
    writeFlag(a.id, b.id);
    const res = await fetch(`${baseUrl}/api/flags`);
    const json = await res.json();
    assert.equal(json.count, 1);
    assert.equal(json.flags.length, 1);
  });

  test("agent-pending renders owner-unknown flags as plain questions (no ids/schema)", async () => {
    const owned  = mkBlock("customer-c_decision_redis",        { type: "decision" });
    const orphan = mkBlock("unspecified-project_decision_redis", { type: "decision" });
    const id = writePipelineFlag(raw, {
      flag_type: "cross_arc_dup_candidate",
      block_id_a: owned.id, block_id_b: orphan.id,
      criteria: { decision: "flag_for_review" },
      scope_check: "unknown", origin_writer: "stage_d_resolve", origin_range_id: null,
    });
    markFlagPendingClarification(raw, { flag_id: id, reason: "owner unknown — routed to agent" });

    const res = await fetch(`${baseUrl}/api/flags/agent-pending`);
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.count, 1);
    const f = json.flags[0];
    assert.equal(f.id, id);
    assert.match(f.question, /same thing/i);             // a plain question, not a verdict form
    assert.match(f.question, /ask the user/i);            // the escalation affordance
    assert.equal(f.you_are_recording.owner, "customer-c");      // owner from label, in plain terms
    assert.equal(f.existing_uncertain.owner, "unspecified-project");
    // No raw flag schema leaked to the agent surface
    assert.equal(f.block_id_a, undefined);
    assert.equal(f.scope_check, undefined);
  });

  test("agent-pending excludes flags still in the reviewer queue (not yet routed)", async () => {
    const a = mkBlock("notrouted_a"); const b = mkBlock("notrouted_b");
    writeFlag(a.id, b.id); // unreviewed, verdict NULL → reviewer's queue, not the agent's
    const res = await fetch(`${baseUrl}/api/flags/agent-pending`);
    const json = await res.json();
    assert.equal(json.count, 0);
  });

  test("list filters by flag_type", async () => {
    const a = mkBlock("ft_a"); const b = mkBlock("ft_b");
    writeFlag(a.id, b.id, "atomic_dup_candidate");
    writeFlag(a.id, b.id, "island_candidate");
    const res = await fetch(`${baseUrl}/api/flags?flag_type=island_candidate`);
    const json = await res.json();
    assert.equal(json.count, 1);
    assert.equal(json.flags[0].flag_type, "island_candidate");
  });

  test("list filters by reviewed=false (unreviewed only)", async () => {
    const a = mkBlock("rv_a"); const b = mkBlock("rv_b");
    const f1 = writeFlag(a.id, b.id, "atomic_dup_candidate");
    writeFlag(a.id, b.id, "island_candidate");
    // Review one
    raw.prepare(`UPDATE pipeline_flags SET reviewed_at='2026-01-01', review_verdict='leave' WHERE id=?`).run(f1);
    const res = await fetch(`${baseUrl}/api/flags?reviewed=false`);
    const json = await res.json();
    assert.equal(json.count, 1, "only the unreviewed flag");
  });
});

// ─── GET :id ──────────────────────────────────────────────────────────────────

describe("GET /api/flags/:id", () => {
  test("returns flag + both blocks embedded", async () => {
    const a = mkBlock("det_a"); const b = mkBlock("det_b");
    const id = writeFlag(a.id, b.id);
    const res = await fetch(`${baseUrl}/api/flags/${id}`);
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.flag.id, id);
    assert.equal(json.block_a.label, "det_a");
    assert.equal(json.block_b.label, "det_b");
  });

  test("404 for unknown id", async () => {
    const res = await fetch(`${baseUrl}/api/flags/pfl_does_not_exist`);
    assert.equal(res.status, 404);
  });
});

// ─── POST :id/review ────────────────────────────────────────────────────────────

describe("POST /api/flags/:id/review", () => {
  test("verdict-only (no execute) writes verdict, no graph change", async () => {
    const a = mkBlock("vo_a"); const b = mkBlock("vo_b");
    const id = writeFlag(a.id, b.id);
    const res = await fetch(`${baseUrl}/api/flags/${id}/review`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ verdict: "leave", reason: "different scope" }),
    });
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.verdict, "leave");
    assert.equal(json.action_taken, "none");
    // Block still active
    assert.notEqual(db.getBlock(b.id)!.status, "archived");
  });

  test("merge + execute archives loser + wires supersedes", async () => {
    const winner = mkBlock("mx_winner"); const loser = mkBlock("mx_loser");
    const id = writeFlag(winner.id, loser.id);
    const res = await fetch(`${baseUrl}/api/flags/${id}/review`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ verdict: "merge", reason: "same entity", execute: true, winning_block_id: winner.id }),
    });
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.action_taken, "archived_loser_and_wired_superseded_by");
    assert.equal(db.getBlock(loser.id)!.status, "archived");
    const rel = raw.prepare(`SELECT * FROM relations WHERE source_id=? AND target_id=? AND type='supersedes'`).get(winner.id, loser.id);
    assert.ok(rel, "supersedes relation winner→loser exists");
  });

  test("400 on invalid verdict", async () => {
    const a = mkBlock("iv_a"); const b = mkBlock("iv_b");
    const id = writeFlag(a.id, b.id);
    const res = await fetch(`${baseUrl}/api/flags/${id}/review`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ verdict: "frobnicate", reason: "x" }),
    });
    assert.equal(res.status, 400);
  });

  test("400 on missing reason", async () => {
    const a = mkBlock("mr_a"); const b = mkBlock("mr_b");
    const id = writeFlag(a.id, b.id);
    const res = await fetch(`${baseUrl}/api/flags/${id}/review`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ verdict: "leave" }),
    });
    assert.equal(res.status, 400);
  });

  test("400 when merge+execute but winning_block_id not a candidate", async () => {
    const a = mkBlock("bw_a"); const b = mkBlock("bw_b");
    const id = writeFlag(a.id, b.id);
    const res = await fetch(`${baseUrl}/api/flags/${id}/review`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ verdict: "merge", reason: "x", execute: true, winning_block_id: "blk_bogus" }),
    });
    assert.equal(res.status, 400);
    // Neither block archived
    assert.notEqual(db.getBlock(a.id)!.status, "archived");
    assert.notEqual(db.getBlock(b.id)!.status, "archived");
  });

  test("409 on already-reviewed flag", async () => {
    const a = mkBlock("ar_a"); const b = mkBlock("ar_b");
    const id = writeFlag(a.id, b.id);
    raw.prepare(`UPDATE pipeline_flags SET reviewed_at='2026-01-01', review_verdict='leave' WHERE id=?`).run(id);
    const res = await fetch(`${baseUrl}/api/flags/${id}/review`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ verdict: "merge", reason: "x" }),
    });
    assert.equal(res.status, 409);
  });

  test("404 review on unknown flag", async () => {
    const res = await fetch(`${baseUrl}/api/flags/pfl_nope/review`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ verdict: "leave", reason: "x" }),
    });
    assert.equal(res.status, 404);
  });
});
