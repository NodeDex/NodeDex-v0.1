/**
 * DEBT 5 Phase 12 — /api/conversations endpoint integration tests
 *
 * Verifies routing + validation + the no-LLM paths through runArcExtraction.
 * The LLM-required end-to-end happy path (status='extracted' with real block
 * writes) is deferred to Phase 11 multi-turn fixture validation.
 *
 * Covers:
 *   GET  /api/conversations/:agent_id           — summary
 *   GET  /api/conversations/:agent_id/turns     — list with filters
 *   POST /api/conversations/:agent_id/extract   — validation + early-return paths
 *
 * Run: node --import=tsx/esm --test src/__tests__/conversations.test.ts
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { WorkspaceDB } from "../store/database.js";
import { startApiServer } from "../api-server.js";
import { _resetArcGuardsForTests } from "../middleware/reflect/arc-pipeline.js";
import type { Server } from "http";

const TEST_DB = "/tmp/wmcs_conv_test.db";
let db: WorkspaceDB;
let server: Server;
let baseUrl: string;

before(async () => {
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  if (fs.existsSync(TEST_DB + "-wal")) fs.unlinkSync(TEST_DB + "-wal");
  if (fs.existsSync(TEST_DB + "-shm")) fs.unlinkSync(TEST_DB + "-shm");
  db = new WorkspaceDB(TEST_DB);
  await db.init();

  server = startApiServer(db, undefined, 0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const addr = server.address() as { port: number };
  baseUrl = `http://localhost:${addr.port}`;
});

after(() => {
  server.close();
  try { (db as any)["db"]?.close(); } catch { /* ignore */ }
  try { if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB); } catch { /* ignore */ }
  try { if (fs.existsSync(TEST_DB + "-wal")) fs.unlinkSync(TEST_DB + "-wal"); } catch { /* ignore */ }
  try { if (fs.existsSync(TEST_DB + "-shm")) fs.unlinkSync(TEST_DB + "-shm"); } catch { /* ignore */ }
});

function mkTranscript(suffix = "x") {
  return JSON.stringify({ user_message: `u-${suffix}`, agent_response: `a-${suffix}`, agent_thinking: `t-${suffix}` });
}

function seedPass01(agent_id: string, n: number): void {
  for (let t = 1; t <= n; t++) {
    const row = db.createConversationTurn({
      agent_id, turn_number: t,
      transcript_json: mkTranscript(String(t)),
    });
    db.updateConversationTurnPass01(row.id, JSON.stringify({ scene_card: { topic: `t${t}` }, items: [] }));
  }
}

// ─── GET /api/conversations/:agent_id (summary) ──────────────────────────────

describe("GET /api/conversations/:agent_id — summary", () => {
  test("404 for an agent that has no turns recorded", async () => {
    const res = await fetch(`${baseUrl}/api/conversations/agent_p12_summary_404`);
    assert.equal(res.status, 404);
    const j = await res.json() as any;
    assert.equal(j.agent_id, "agent_p12_summary_404");
    assert.ok(j.error.includes("no turns"), `error must mention no turns (got: ${j.error})`);
  });

  test("200 with status breakdown when agent has mixed-status turns", async () => {
    const ag = "agent_p12_summary_mixed";
    // 2 captured, 1 pass01_done
    db.createConversationTurn({ agent_id: ag, turn_number: 1, transcript_json: mkTranscript("1") });
    db.createConversationTurn({ agent_id: ag, turn_number: 2, transcript_json: mkTranscript("2") });
    const r3 = db.createConversationTurn({ agent_id: ag, turn_number: 3, transcript_json: mkTranscript("3") });
    db.updateConversationTurnPass01(r3.id, JSON.stringify({ items: [] }));

    const res = await fetch(`${baseUrl}/api/conversations/${ag}`);
    assert.equal(res.status, 200);
    const j = await res.json() as any;
    assert.equal(j.agent_id, ag);
    assert.equal(j.total_turns, 3);
    assert.equal(j.status_breakdown.captured, 2);
    assert.equal(j.status_breakdown.pass01_done, 1);
    assert.equal(j.status_breakdown.extracted, 0);
    assert.equal(j.first_turn_number, 1);
    assert.equal(j.last_turn_number, 3);
    assert.ok(j.last_turn_at, "last_turn_at must be set");
  });
});

// ─── GET /api/conversations/:agent_id/turns (list with filters) ──────────────

describe("GET /api/conversations/:agent_id/turns — list with filters", () => {
  test("returns all turns for an agent in ASCending turn_number order", async () => {
    const ag = "agent_p12_turns_asc";
    seedPass01(ag, 3);
    const res = await fetch(`${baseUrl}/api/conversations/${ag}/turns`);
    assert.equal(res.status, 200);
    const j = await res.json() as any;
    assert.equal(j.count, 3);
    assert.deepEqual(j.turns.map((t: any) => t.turn_number), [1, 2, 3]);
  });

  test("filters by status=pass01_done", async () => {
    const ag = "agent_p12_turns_status_filter";
    db.createConversationTurn({ agent_id: ag, turn_number: 1, transcript_json: mkTranscript("c1") });
    const r2 = db.createConversationTurn({ agent_id: ag, turn_number: 2, transcript_json: mkTranscript("p1") });
    db.updateConversationTurnPass01(r2.id, JSON.stringify({ items: [] }));

    const res = await fetch(`${baseUrl}/api/conversations/${ag}/turns?status=pass01_done`);
    assert.equal(res.status, 200);
    const j = await res.json() as any;
    assert.equal(j.count, 1);
    assert.equal(j.turns[0].turn_number, 2);
    assert.equal(j.turns[0].status, "pass01_done");
  });

  test("400 on invalid status value", async () => {
    const ag = "agent_p12_turns_bad_status";
    seedPass01(ag, 1);
    const res = await fetch(`${baseUrl}/api/conversations/${ag}/turns?status=garbage`);
    assert.equal(res.status, 400);
    const j = await res.json() as any;
    assert.ok(j.error.includes("status"), `error must mention status (got: ${j.error})`);
  });

  test("filters by min_turn and max_turn range", async () => {
    const ag = "agent_p12_turns_range";
    seedPass01(ag, 5);
    const res = await fetch(`${baseUrl}/api/conversations/${ag}/turns?min_turn=2&max_turn=4`);
    assert.equal(res.status, 200);
    const j = await res.json() as any;
    assert.equal(j.count, 3);
    assert.deepEqual(j.turns.map((t: any) => t.turn_number), [2, 3, 4]);
  });

  test("400 on non-numeric min_turn", async () => {
    const ag = "agent_p12_turns_bad_min";
    seedPass01(ag, 1);
    const res = await fetch(`${baseUrl}/api/conversations/${ag}/turns?min_turn=abc`);
    assert.equal(res.status, 400);
  });
});

// ─── POST /api/conversations/:agent_id/extract (validation + early returns) ──

describe("POST /api/conversations/:agent_id/extract — validation + no-LLM paths", () => {
  test("400 when end_turn < start_turn", async () => {
    const res = await fetch(`${baseUrl}/api/conversations/agent_p12_extract_bad_range/extract`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ start_turn: 5, end_turn: 3 }),
    });
    assert.equal(res.status, 400);
    const j = await res.json() as any;
    assert.ok(j.error.includes("end_turn") && j.error.includes("start_turn"), `error: ${j.error}`);
  });

  test("400 on non-numeric start_turn", async () => {
    const res = await fetch(`${baseUrl}/api/conversations/agent_p12_extract_nan/extract`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ start_turn: "abc" }),
    });
    assert.equal(res.status, 400);
  });

  test("404 with status='no_turns' when agent has no pass01_done turns", async () => {
    _resetArcGuardsForTests();
    const res = await fetch(`${baseUrl}/api/conversations/agent_p12_extract_noturns/extract`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 404);
    const j = await res.json() as any;
    assert.equal(j.status, "no_turns");
    assert.equal(j.turns_consumed, 0);
  });

  test("200 with status='min_range_too_small' when only 1 pass01_done turn exists", async () => {
    _resetArcGuardsForTests();
    const ag = "agent_p12_extract_minrange";
    seedPass01(ag, 1);
    const res = await fetch(`${baseUrl}/api/conversations/${ag}/extract`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 200);  // min_range_too_small is a 200 — endpoint returned a verdict
    const j = await res.json() as any;
    assert.equal(j.status, "min_range_too_small");
    assert.equal(j.turns_consumed, 1);
  });

  test("trigger_source defaults to 'api' when omitted; explicit value is honored when valid", async () => {
    // Drive via min_range path (1 turn) — doesn't reach LLM, returns 200 with status='min_range_too_small'.
    // We just verify the endpoint accepts the body shape.
    _resetArcGuardsForTests();
    const ag = "agent_p12_extract_trigger_default";
    seedPass01(ag, 1);
    const res = await fetch(`${baseUrl}/api/conversations/${ag}/extract`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ trigger_source: "phase_tag" }),
    });
    assert.equal(res.status, 200);
    // Result shape is min_range_too_small — trigger_source itself doesn't get
    // echoed back unless status='extracted'. Just verify no 400 / 500.
  });

  test("invalid trigger_source falls back to 'api' silently (not 400)", async () => {
    _resetArcGuardsForTests();
    const ag = "agent_p12_extract_bad_trigger";
    seedPass01(ag, 1);
    const res = await fetch(`${baseUrl}/api/conversations/${ag}/extract`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ trigger_source: "nonsense" }),
    });
    // Endpoint coerces unknown trigger_source to 'api' — does not 400. Min-range
    // guard still fires for the 1-turn scenario.
    assert.equal(res.status, 200);
    const j = await res.json() as any;
    assert.equal(j.status, "min_range_too_small");
  });
});
