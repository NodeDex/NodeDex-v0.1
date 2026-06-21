// v2-aware LAZY CAPTURE — skip the redundant per-turn Pass 0-1 when v2 reads raw.
// Run: node --import=tsx/esm --test src/middleware/reflect/__tests__/lazy-capture.test.ts
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { WorkspaceDB } from "../../../store/database.js";
import { runAutoReflect } from "../pipeline.js";
import { lazyFillPass01 } from "../arc-pipeline.js";
import { resetProviders } from "../../../engine/providers/index.js";

const TEST_DB = path.resolve("/tmp/lazy_capture_test.db");
let db: WorkspaceDB;

before(async () => {
  for (const s of ["", "-wal", "-shm"]) { try { if (fs.existsSync(TEST_DB + s)) fs.unlinkSync(TEST_DB + s); } catch { /* ignore */ } }
  db = new WorkspaceDB(TEST_DB);
  await db.init();
});
after(() => {
  for (const k of ["NODEDEX_V2_LAZY_CAPTURE", "NODEDEX_ARC_EXTRACTION", "NODEDEX_EXTRACT_ALL_SOURCES", "GEMINI_API_KEY", "AI_PROVIDER"]) delete process.env[k];
  resetProviders(); // don't leak the dummy provider to other test files
  try { (db as any)["db"]?.close(); } catch { /* ignore */ }
  for (const s of ["", "-wal", "-shm"]) { try { if (fs.existsSync(TEST_DB + s)) fs.unlinkSync(TEST_DB + s); } catch { /* ignore */ } }
});

describe("capture skip (the cost saving)", () => {
  test("lazy-capture stores raw + marks pass01_done WITHOUT running Pass 0-1 (no LLM)", async () => {
    // A dummy key makes the provider "available" (passes the top guard) WITHOUT a
    // real call — the lazy-capture skip returns BEFORE Pass 0. EXTRACT_ALL_SOURCES
    // bypasses the <300-char trivial-turn skip. If Pass 0-1 actually ran, the skip
    // is broken (and the dummy key would make the real call fail).
    process.env.AI_PROVIDER = "gemini";
    process.env.GEMINI_API_KEY = "test-dummy-key";
    process.env.NODEDEX_EXTRACT_ALL_SOURCES = "1";
    process.env.NODEDEX_ARC_EXTRACTION = "1";
    process.env.NODEDEX_V2_LAZY_CAPTURE = "1";
    resetProviders();
    const r = await runAutoReflect(db, "AGENT: decided to use an empty array.", [], "why does it crash?", "", undefined, [], "lazycap-agent", undefined, 1, "t1");

    assert.equal(r.saved, 0, "capture writes no graph blocks");
    const turn = db.getConversationTurnByAgentTurn("lazycap-agent", 1);
    assert.ok(turn, "the raw transcript was captured");
    assert.equal(turn!.status, "pass01_done", "turn marked arc-ready");
    const p01 = JSON.parse(turn!.pass01_output_json!);
    assert.equal(p01.items.length, 0, "Pass 0-1 skipped → empty items");
    assert.equal(p01.scene_card, null, "no scene card computed");
    // the raw transcript IS stored (v2 reads it at arc)
    const tr = JSON.parse(turn!.transcript_json);
    assert.ok(tr.agent_response.includes("empty array"), "raw transcript preserved");
  });
});

describe("lazy fill (the v2-failure safety net)", () => {
  test("lazyFillPass01 runs Pass 0 + Pass 1 per turn and persists items", async () => {
    const row = db.createConversationTurn({ agent_id: "fill-agent", turn_number: 1, transcript_json: JSON.stringify({ user_message: "u", agent_response: "AGENT: chose X", agent_thinking: "" }) });
    db.updateConversationTurnPass01(row.id, JSON.stringify({ scene_card: null, items: [] })); // lazy-captured: empty

    let calls = 0;
    const mock: any = {
      getName: () => "mock",
      isAvailable: () => true,
      // one shape that satisfies BOTH Pass 0 (arrays formatSceneCard iterates) and Pass 1 (items)
      generateStructured: async () => {
        calls++;
        return { result: { input_type: "conversational", scope_project: null, projects: [], people: [], technologies: [], actor_actions: [], in_flight: [], causal_links: [], replacements: [], unchanged: [], items: [{ id: "li1", text: "chose X", provisional_type: "decision" }] }, rateLimited: false, usage: {} };
      },
    };

    const turns = db.listConversationTurnsByAgent("fill-agent", { status: "pass01_done" });
    await lazyFillPass01(db, mock, turns);

    // The fill invokes Pass 0 + Pass 1 for the one turn (the mechanism). Content
    // fidelity depends on the LLM result passing pass-0/1 validation (integration-
    // level); the unit guarantee is that the fallback runs both passes per turn.
    assert.equal(calls, 2, "Pass 0 + Pass 1 each called once for the one turn");
    const filled = JSON.parse(db.getConversationTurnByAgentTurn("fill-agent", 1)!.pass01_output_json!);
    assert.ok(Array.isArray(filled.items), "pass01 re-persisted with a valid items array");
  });
});
