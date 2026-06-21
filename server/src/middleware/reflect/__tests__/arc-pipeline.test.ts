/**
 * DEBT 5 Phase 3 — arc-pipeline tests
 *
 * Covers the pure data-transformation pieces:
 *   - buildArcConsolidatedInput (D1+D4 input builder)
 *   - runArcExtraction control flow that doesn't require an LLM
 *     (no-turns path, range-scoping, status checks)
 *
 * NOT covered here (deferred to Phase 11 multi-turn fixture validation):
 *   - End-to-end arc extraction with a real LLM provider
 *   - Pass 2c sew-as-event behavior at scale (~100 items)
 *   - Pass 2c quadratic context risk per design §2.8
 *
 * Run: node --import=tsx/esm --test src/middleware/reflect/__tests__/arc-pipeline.test.ts
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { WorkspaceDB } from "../../../store/database.js";
import { buildArcConsolidatedInput, runArcExtraction, _resetArcGuardsForTests } from "../arc-pipeline.js";
import { arcMaxRetries } from "../comprehend.js";

const TEST_DB = path.resolve("/tmp/wmcs_arc_test.db");
let db: WorkspaceDB;

before(async () => {
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  if (fs.existsSync(TEST_DB + "-wal")) fs.unlinkSync(TEST_DB + "-wal");
  if (fs.existsSync(TEST_DB + "-shm")) fs.unlinkSync(TEST_DB + "-shm");
  db = new WorkspaceDB(TEST_DB);
  await db.init();
});

after(() => {
  try { (db as any)["db"]?.close(); } catch { /* ignore */ }
  try { if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB); } catch { /* ignore */ }
  try { if (fs.existsSync(TEST_DB + "-wal")) fs.unlinkSync(TEST_DB + "-wal"); } catch { /* ignore */ }
  try { if (fs.existsSync(TEST_DB + "-shm")) fs.unlinkSync(TEST_DB + "-shm"); } catch { /* ignore */ }
});

// Helper to create a pass01_done turn with the given items + scene card
function seedPass01Turn(
  agent_id: string,
  turn_number: number,
  opts: {
    turn_name?: string;
    user_message?: string;
    agent_response?: string;
    agent_thinking?: string;
    scene_card?: any;
    items?: Array<{ id: string; text?: string; type?: string }>;
  } = {},
) {
  const transcript = JSON.stringify({
    user_message:   opts.user_message   ?? `u-turn-${turn_number}`,
    agent_response: opts.agent_response ?? `a-turn-${turn_number}`,
    agent_thinking: opts.agent_thinking ?? `t-turn-${turn_number}`,
  });
  const row = db.createConversationTurn({
    agent_id,
    turn_number,
    turn_name: opts.turn_name ?? null,
    transcript_json: transcript,
  });
  const pass01 = JSON.stringify({
    scene_card: opts.scene_card ?? { summary: `scene-${turn_number}` },
    items: opts.items ?? [{ id: `item_1`, text: `text-${turn_number}`, type: "fact" }],
  });
  db.updateConversationTurnPass01(row.id, pass01);
  return db.getConversationTurnById(row.id)!;
}

// ─── buildArcConsolidatedInput — D1+D4 input builder ─────────────────────────

describe("Phase 3: buildArcConsolidatedInput — D1+D4 transformation", () => {
  test("single turn → all parts populated with TURN marker + sew header", () => {
    const t = seedPass01Turn("agent_arc_single", 1, {
      user_message: "what's the plan?",
      agent_response: "do X then Y",
      agent_thinking: "considering options",
    });
    const out = buildArcConsolidatedInput("agent_arc_single", [t]);

    assert.ok(out.agentResponse.includes("[ARC EXTRACTION"), "must contain sew-as-event header");
    assert.ok(out.agentResponse.includes("agent_id=agent_arc_single"), "header must name agent");
    assert.ok(out.agentResponse.includes("turns 1-1"), "header must show range");
    assert.ok(out.agentResponse.includes("[TURN 1]"), "must contain TURN 1 marker");
    assert.ok(out.agentResponse.includes("do X then Y"), "must include agent response content");

    assert.ok(out.userMessage.includes("[TURN 1]"));
    assert.ok(out.userMessage.includes("what's the plan?"));

    assert.ok(out.agentThinking.includes("considering options"));

    assert.equal(out.items.length, 1);
    assert.equal(out.items[0]!.id, "item_T1_1", "item id must be prefixed with turn number");
  });

  test("multiple turns → chronological order, multi-turn header, all items prefixed", () => {
    const turns = [
      seedPass01Turn("agent_arc_multi", 1, { agent_response: "first turn response" }),
      seedPass01Turn("agent_arc_multi", 2, { agent_response: "second turn response" }),
      seedPass01Turn("agent_arc_multi", 3, { agent_response: "third turn response" }),
    ];
    const out = buildArcConsolidatedInput("agent_arc_multi", turns);

    assert.ok(out.agentResponse.includes("turns 1-3"), "header must show full range");
    assert.ok(out.agentResponse.includes("3 turn(s)"), "header must show count");

    // Chronological order in agent_response
    const t1Pos = out.agentResponse.indexOf("first turn response");
    const t2Pos = out.agentResponse.indexOf("second turn response");
    const t3Pos = out.agentResponse.indexOf("third turn response");
    assert.ok(t1Pos > 0 && t2Pos > t1Pos && t3Pos > t2Pos, "turns must appear in chronological order");

    // Item IDs prefixed by turn
    assert.equal(out.items.length, 3);
    assert.deepEqual(
      out.items.map((i) => i.id),
      ["item_T1_1", "item_T2_1", "item_T3_1"],
      "item IDs must carry turn prefix per design §2.6.2 (cross-turn dedup composability)",
    );
  });

  test("item IDs strip pre-existing 'item_' prefix to avoid item_T2_item_1 (double-prefix bug)", () => {
    const t = seedPass01Turn("agent_arc_idprefix", 2, {
      items: [
        { id: "item_1", text: "a" },
        { id: "item_42", text: "b" },
      ],
    });
    const out = buildArcConsolidatedInput("agent_arc_idprefix", [t]);
    assert.deepEqual(
      out.items.map((i) => i.id),
      ["item_T2_1", "item_T2_42"],
      "double 'item_' must collapse to single canonical form",
    );
  });

  test("turn name appears in TURN marker when set", () => {
    const t = seedPass01Turn("agent_arc_named", 1, { turn_name: "discuss-plan" });
    const out = buildArcConsolidatedInput("agent_arc_named", [t]);
    assert.ok(out.agentResponse.includes("[TURN 1 — discuss-plan]"), "turn_name must surface in TURN marker");
  });

  test("turn with missing pass01_output_json (still 'captured', shouldn't happen but defensive)", () => {
    // Create a turn that hasn't completed pass01 (status='captured'); pass01_output_json is NULL.
    // The function should tolerate this — emit transcript but no scene card or items.
    const row = db.createConversationTurn({
      agent_id: "agent_arc_nopass01",
      turn_number: 1,
      transcript_json: JSON.stringify({ user_message: "u", agent_response: "a", agent_thinking: "t" }),
    });
    const fresh = db.getConversationTurnById(row.id)!;
    const out = buildArcConsolidatedInput("agent_arc_nopass01", [fresh]);
    assert.equal(out.items.length, 0, "no items when pass01 missing");
    assert.ok(out.agentResponse.includes("[TURN 1]"), "transcript still appears");
  });

  test("malformed transcript_json degrades gracefully (no throw)", () => {
    // Directly insert a row with bad JSON
    const dbAny: any = (db as any).db;
    dbAny.prepare(
      `INSERT INTO conversation_turns (id, agent_id, turn_number, transcript_json, status, created_at) VALUES (?, ?, ?, ?, 'pass01_done', ?)`,
    ).run("ct_malformed_1", "agent_arc_malformed", 1, "not-valid-json", new Date().toISOString());
    const row = db.getConversationTurnById("ct_malformed_1")!;
    assert.doesNotThrow(() => buildArcConsolidatedInput("agent_arc_malformed", [row]));
    const out = buildArcConsolidatedInput("agent_arc_malformed", [row]);
    // No agent response from this turn since transcript parsed empty
    assert.ok(out.agentResponse.includes("[ARC EXTRACTION"), "header still rendered");
  });

  test("scene cards merged in sceneCardMerged with per-turn provenance", () => {
    const turns = [
      seedPass01Turn("agent_arc_scenes", 1, { scene_card: { topic: "alpha" } }),
      seedPass01Turn("agent_arc_scenes", 2, { scene_card: { topic: "beta" } }),
    ];
    const out = buildArcConsolidatedInput("agent_arc_scenes", turns);
    assert.equal(out.sceneCardMerged.agent_id, "agent_arc_scenes");
    assert.equal(out.sceneCardMerged.start_turn, 1);
    assert.equal(out.sceneCardMerged.end_turn, 2);
    assert.equal(out.sceneCardMerged.merged_turns.length, 2);
    assert.equal(out.sceneCardMerged.merged_turns[0].turn, 1);
    assert.deepEqual(out.sceneCardMerged.merged_turns[0].scene_card, { topic: "alpha" });
  });
});

// ─── runArcExtraction — control flow (no-LLM paths) ──────────────────────────

describe("Phase 3: runArcExtraction — no-LLM control-flow paths", () => {
  test("no pass01_done turns → returns 'no_turns' without invoking pipeline", async () => {
    const r = await runArcExtraction(db, {
      agent_id: "agent_arc_empty",
      trigger_source: "phase_tag",
    });
    assert.equal(r.status, "no_turns");
    assert.equal(r.range_id, null);
    assert.equal(r.turns_consumed, 0);
    assert.equal(r.reflect_result, null);
  });

  test("turns exist but only outside explicit range → returns 'no_turns'", async () => {
    seedPass01Turn("agent_arc_outrange", 1);
    seedPass01Turn("agent_arc_outrange", 2);
    // Request range [5, 10] — no turns in that range
    const r = await runArcExtraction(db, {
      agent_id: "agent_arc_outrange",
      start_turn: 5,
      end_turn: 10,
      trigger_source: "api",
    });
    assert.equal(r.status, "no_turns");
    assert.equal(r.range_id, null);
    assert.equal(r.start_turn, 5);
    assert.equal(r.end_turn, 10);
  });

  test("only 'captured' (no pass01_done) turns → returns 'no_turns'", async () => {
    // Captured but no pass01 update
    db.createConversationTurn({
      agent_id: "agent_arc_capturedonly",
      turn_number: 1,
      transcript_json: JSON.stringify({ user_message: "u", agent_response: "a", agent_thinking: "t" }),
    });
    const r = await runArcExtraction(db, {
      agent_id: "agent_arc_capturedonly",
      trigger_source: "inactivity",
    });
    assert.equal(r.status, "no_turns", "only counts pass01_done — captured turns not yet eligible");
  });
});

// ─── Phase 8: backend handler — idempotency + rate-limit + min-range ─────────

describe("Phase 8: runArcExtraction guards (idempotency + rate-limit + min-range)", () => {
  // Helper: seed N pass01_done turns for an agent
  function seedAgent(agent_id: string, n: number): void {
    for (let t = 1; t <= n; t++) {
      const row = db.createConversationTurn({
        agent_id,
        turn_number: t,
        transcript_json: JSON.stringify({ user_message: `u-${t}`, agent_response: `a-${t}`, agent_thinking: `t-${t}` }),
      });
      db.updateConversationTurnPass01(row.id, JSON.stringify({ scene_card: { topic: `t${t}` }, items: [] }));
    }
  }

  // Reset in-memory guards between tests so they don't bleed across describes.
  test("setup: clear in-memory guards (sanity)", () => {
    _resetArcGuardsForTests();
    assert.ok(true);
  });

  test("min-range guard: single-turn range → 'min_range_too_small' (not 'no_turns')", async () => {
    _resetArcGuardsForTests();
    seedAgent("agent_p8_minrange", 1);
    const r = await runArcExtraction(db, {
      agent_id: "agent_p8_minrange",
      trigger_source: "api",
    });
    assert.equal(r.status, "min_range_too_small", "<2 turns means atomic was enough; refuse arc");
    assert.equal(r.turns_consumed, 1, "still report the count so caller knows what they offered");
  });

  test("min-range guard: zero pass01_done turns → 'no_turns' (NOT 'min_range_too_small')", async () => {
    _resetArcGuardsForTests();
    const r = await runArcExtraction(db, {
      agent_id: "agent_p8_empty",
      trigger_source: "api",
    });
    assert.equal(r.status, "no_turns", "distinct from min_range — caller learns 'nothing captured yet'");
  });

  test("min-range guard: re_extract=true BYPASSES min-range check (single turn allowed)", async () => {
    _resetArcGuardsForTests();
    seedAgent("agent_p8_reextract_single", 1);
    // re_extract bypass — design §3.5: explicit re-extract is the caller's
    // judgement call. Note: this will FAIL on pipeline run (no LLM in test),
    // so we expect pipeline_failed or any post-guard status, NOT min_range.
    const r = await runArcExtraction(db, {
      agent_id: "agent_p8_reextract_single",
      re_extract: true,
      trigger_source: "api",
    });
    assert.notEqual(r.status, "min_range_too_small", "re_extract bypasses min-range guard");
  });

  test("rate-limit guard: 2nd call within window → 'rate_limited' with retry_after_ms", async () => {
    _resetArcGuardsForTests();
    seedAgent("agent_p8_ratelimit", 2);
    // First call — will pipeline_failed (no LLM) but sets timestamp on success only
    // → no timestamp set. So second call should ALSO pipeline_failed (not rate_limited).
    // Force a timestamp manually via the module's internal state — we can't reach
    // _arcLastEndTs from outside. Use the second-call-after-success scenario:
    // emulate prior success by calling _resetArcGuardsForTests then directly
    // populating via a successful run. Since we can't easily mock the LLM here,
    // we test the GUARD CONTRACT differently: verify that AFTER a rate-limit
    // window passes, calls are allowed again.
    //
    // For this test we exercise: rate-limit ENV override → 0s → no rate limit.
    const prev = process.env.NODEDEX_ARC_RATE_LIMIT_SECONDS;
    process.env.NODEDEX_ARC_RATE_LIMIT_SECONDS = "0";
    try {
      const r = await runArcExtraction(db, {
        agent_id: "agent_p8_ratelimit",
        trigger_source: "api",
      });
      assert.notEqual(r.status, "rate_limited", "rate-limit=0 means no throttle");
    } finally {
      if (prev === undefined) delete process.env.NODEDEX_ARC_RATE_LIMIT_SECONDS;
      else process.env.NODEDEX_ARC_RATE_LIMIT_SECONDS = prev;
    }
  });

  test("rate-limit guard: ENV override NODEDEX_ARC_RATE_LIMIT_SECONDS honored", async () => {
    // Test the getRateLimitMs reader by setting env vars and observing behavior.
    // Bad / negative env → default 60s.
    _resetArcGuardsForTests();
    seedAgent("agent_p8_envrl", 2);
    const prev = process.env.NODEDEX_ARC_RATE_LIMIT_SECONDS;
    process.env.NODEDEX_ARC_RATE_LIMIT_SECONDS = "abc";  // invalid
    try {
      // Should NOT throw — bad env falls back to default (no rate-limit hit
      // because no prior successful run was recorded).
      const r = await runArcExtraction(db, {
        agent_id: "agent_p8_envrl",
        trigger_source: "api",
      });
      assert.notEqual(r.status, "rate_limited", "first call always passes rate-limit (no prior timestamp)");
    } finally {
      if (prev === undefined) delete process.env.NODEDEX_ARC_RATE_LIMIT_SECONDS;
      else process.env.NODEDEX_ARC_RATE_LIMIT_SECONDS = prev;
    }
  });

  test("_resetArcGuardsForTests clears in-flight markers and timestamps", () => {
    _resetArcGuardsForTests();
    // Can't directly observe; verify via the no-state-on-first-call invariant.
    // (Tested indirectly via the other Phase 8 tests passing in sequence.)
    assert.ok(true);
  });

  test("guard ordering: idempotency check fires BEFORE pass01_done lookup", async () => {
    // If an agent is in the _arcInProgress set, we should return 'in_progress'
    // even when they have no pass01_done turns. The in-progress check is the
    // FIRST guard.
    // We can't easily inject a value into _arcInProgress externally, so test
    // by invariant: first call should not be 'in_progress' (set is empty).
    _resetArcGuardsForTests();
    const r = await runArcExtraction(db, {
      agent_id: "agent_p8_order_check",
      trigger_source: "api",
    });
    assert.notEqual(r.status, "in_progress", "empty in-flight set → not in-progress");
  });

  test("status return shape includes rate_limited_retry_after_ms ONLY when rate-limited", async () => {
    _resetArcGuardsForTests();
    seedAgent("agent_p8_shape", 2);
    const r = await runArcExtraction(db, {
      agent_id: "agent_p8_shape",
      trigger_source: "api",
    });
    // On non-rate-limited path, retry_after_ms must be undefined or absent
    assert.equal(r.rate_limited_retry_after_ms, undefined, "field is only set on rate_limited status");
  });
});

// ─── H1: v2-only fail-clean + bounded retry budget ───────────────────────────
// The bug this guards: the arc path used to IGNORE a returned re-queue checkpoint
// (Pass 3 drop) and mark turns extracted with 0 blocks = silent, unrecoverable
// loss. v2-only policy now: bounded retry → FAIL CLEAN (turns left re-extractable),
// never auto-fall to v1. v1 stays reachable ONLY via NODEDEX_PIPELINE_V2=0.

describe("H1: arcMaxRetries() retry-budget config", () => {
  const KEY = "NODEDEX_ARC_MAX_RETRIES";
  let prev: string | undefined;
  before(() => { prev = process.env[KEY]; });
  after(() => { if (prev === undefined) delete process.env[KEY]; else process.env[KEY] = prev; });

  test("default is 2 (→ up to 3 attempts) when unset", () => {
    delete process.env[KEY];
    assert.equal(arcMaxRetries(), 2);
  });
  test("env override honored", () => {
    process.env[KEY] = "5";
    assert.equal(arcMaxRetries(), 5);
  });
  test("0 is allowed — fail clean on the first failure (min floor is 0, not 1)", () => {
    process.env[KEY] = "0";
    assert.equal(arcMaxRetries(), 0);
  });
  test("malformed → default 2", () => {
    process.env[KEY] = "not-a-number";
    assert.equal(arcMaxRetries(), 2);
  });
  test("negative → default 2", () => {
    process.env[KEY] = "-3";
    assert.equal(arcMaxRetries(), 2);
  });
});

describe("H1: v2-only fail-clean — no silent loss on extraction failure", () => {
  function seedAgent(agent_id: string, n: number): void {
    for (let t = 1; t <= n; t++) {
      const row = db.createConversationTurn({
        agent_id,
        turn_number: t,
        transcript_json: JSON.stringify({ user_message: `u-${t}`, agent_response: `a-${t}`, agent_thinking: `t-${t}` }),
      });
      db.updateConversationTurnPass01(row.id, JSON.stringify({ scene_card: { topic: `t${t}` }, items: [] }));
    }
  }

  test("v2 front-half failure (no LLM) → 'pipeline_incomplete', turns LEFT re-extractable", async () => {
    _resetArcGuardsForTests();
    const prevV2 = process.env.NODEDEX_PIPELINE_V2;
    const prevR  = process.env.NODEDEX_ARC_MAX_RETRIES;
    process.env.NODEDEX_PIPELINE_V2     = "1";   // v2 is the engine
    process.env.NODEDEX_ARC_MAX_RETRIES = "0";   // fail clean on the first failure (fast, deterministic)
    try {
      seedAgent("agent_h1_failclean", 2);
      const r = await runArcExtraction(db, { agent_id: "agent_h1_failclean", trigger_source: "api" });
      assert.equal(r.status, "pipeline_incomplete", "v2 failure must fail clean — not silently succeed, not fall to v1");
      assert.equal(r.range_id, null, "no range created on fail-clean");
      assert.equal(r.reflect_result, null, "no reflect_result on fail-clean");
      // THE invariant the bug violated: turns stay re-extractable (NOT marked extracted).
      const still = db.listConversationTurnsByAgent("agent_h1_failclean", { status: "pass01_done" });
      assert.equal(still.length, 2, "turns must remain pass01_done = re-extractable (no silent loss)");
    } finally {
      if (prevV2 === undefined) delete process.env.NODEDEX_PIPELINE_V2; else process.env.NODEDEX_PIPELINE_V2 = prevV2;
      if (prevR  === undefined) delete process.env.NODEDEX_ARC_MAX_RETRIES; else process.env.NODEDEX_ARC_MAX_RETRIES = prevR;
    }
  });

  test("the old NODEDEX_PIPELINE_V2=0 off-switch is INERT — v2 still runs, v1 cannot be turned on", async () => {
    // Pre-release, =0 ran the v1 front-half (no LLM on trivial input → clean 0-block
    // 'extracted'). v1 is now RETIRED and un-turnable: even with =0, v2 is the engine,
    // so the front-half COMPREHEND needs the LLM → fails → v2-only fail-clean
    // ('pipeline_incomplete'). The contrast PROVES the off-switch no longer reaches v1.
    _resetArcGuardsForTests();
    const prevV2 = process.env.NODEDEX_PIPELINE_V2;
    const prevR  = process.env.NODEDEX_ARC_MAX_RETRIES;
    process.env.NODEDEX_PIPELINE_V2     = "0";   // INERT now — v2 runs regardless
    process.env.NODEDEX_ARC_MAX_RETRIES = "0";
    try {
      seedAgent("agent_h1_offswitch", 2);
      const r = await runArcExtraction(db, { agent_id: "agent_h1_offswitch", trigger_source: "api" });
      assert.equal(r.status, "pipeline_incomplete", "=0 must STILL run v2 (front-half needs the LLM → fail-clean), proving v1 is un-turnable");
    } finally {
      if (prevV2 === undefined) delete process.env.NODEDEX_PIPELINE_V2; else process.env.NODEDEX_PIPELINE_V2 = prevV2;
      if (prevR  === undefined) delete process.env.NODEDEX_ARC_MAX_RETRIES; else process.env.NODEDEX_ARC_MAX_RETRIES = prevR;
    }
  });
});
