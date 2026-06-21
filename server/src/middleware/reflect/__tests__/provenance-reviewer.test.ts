// Gap ④(b) provenance meaning-reviewer — action logic + tick, mocked LLM ($0).
// Run: node --import=tsx/esm --test src/middleware/reflect/__tests__/provenance-reviewer.test.ts
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { WorkspaceDB } from "../../../store/database.js";
import { writePipelineFlag, getPendingFlags } from "../pipeline-flags.js";
import {
  applyProvenanceVerdict, buildReviewInput, runProvenanceReviewerTick,
  type ProvenanceVerdict,
} from "../provenance-reviewer.js";

const TEST_DB = path.resolve("/tmp/provenance_reviewer_test.db");
let db: WorkspaceDB;
let rangeId = "";
const TRANSCRIPT_TEXT = "use AbortController to cancel the in-flight fetch on unmount.";

before(async () => {
  for (const s of ["", "-wal", "-shm"]) { try { if (fs.existsSync(TEST_DB + s)) fs.unlinkSync(TEST_DB + s); } catch { /* ignore */ } }
  db = new WorkspaceDB(TEST_DB);
  await db.init();
  db.createConversationTurn({ agent_id: "rev", turn_number: 1, transcript_json: JSON.stringify({ user_message: "what fixes the race?", agent_response: `AGENT: ${TRANSCRIPT_TEXT}` }) });
  const range = db.createConversationTurnRange({ agent_id: "rev", start_turn_number: 1, end_turn_number: 1, extraction_type: "arc" });
  rangeId = range.id;
});
after(() => {
  try { (db as any)["db"]?.close(); } catch { /* ignore */ }
  for (const s of ["", "-wal", "-shm"]) { try { if (fs.existsSync(TEST_DB + s)) fs.unlinkSync(TEST_DB + s); } catch { /* ignore */ } }
});

let _n = 0;
function makeFlaggedBlock(excerpt: string, severity: "hard" | "soft" = "hard") {
  const label = `rev_decision_${_n++}`;
  const block = db.createBlock({ label, type: "decision", essence: "cancel fetch", content: { unique: { choice: "abort" } }, ttl: "permanent", status: "active", source_excerpt: excerpt });
  db.recordBlockExtraction(block.id, rangeId);
  const raw = (db as any).db;
  writePipelineFlag(raw, {
    flag_type: "provenance_mismatch", block_id_a: block.id, block_id_b: null,
    criteria: { status: severity === "hard" ? "missing" : "fuzzy", severity, excerpt_preview: excerpt.slice(0, 80) },
    scope_check: "unknown", origin_writer: "provenance_check", origin_range_id: rangeId,
  });
  const flag = getPendingFlags(raw, { flag_type: "provenance_mismatch", limit: 1000 }).find((f) => f.block_id_a === block.id)!;
  return { block: db.getBlock(block.id)!, flag };
}
function flagRow(flagId: string) {
  return (db as any).db.prepare("SELECT * FROM pipeline_flags WHERE id=?").get(flagId) as any;
}
function statusOf(blockId: string) {
  return (db as any).db.prepare("SELECT status FROM blocks WHERE id=?").get(blockId).status as string;
}

describe("applyProvenanceVerdict", () => {
  test("ungrounded + autoAct → block archived, verdict demoted", () => {
    const { block, flag } = makeFlaggedBlock("deploy postgres to kubernetes us-east region");
    const v: ProvenanceVerdict = { grounded: false, correct_excerpt: "", reasoning: "claim not in transcript" };
    const out = applyProvenanceVerdict(db, flag, block, v, true);
    assert.equal(out.verdict, "demoted");
    assert.equal(out.action_taken, "demoted_unprovenanced");
    assert.equal(statusOf(block.id), "archived", "fabricated block archived");
    assert.equal(flagRow(flag.id).review_verdict, "demoted");
  });

  test("grounded + correct_excerpt + autoAct → excerpt corrected, verdict corrected", () => {
    const { block, flag } = makeFlaggedBlock("cancel inflight request using an abort signal");
    const v: ProvenanceVerdict = { grounded: true, correct_excerpt: TRANSCRIPT_TEXT, reasoning: "found verbatim passage" };
    const out = applyProvenanceVerdict(db, flag, block, v, true);
    assert.equal(out.verdict, "corrected");
    assert.equal(out.action_taken, "corrected_excerpt");
    assert.equal(db.getBlock(block.id)!.source_excerpt, TRANSCRIPT_TEXT, "excerpt rewritten to verbatim");
  });

  test("grounded + fix but autoAct FALSE → verdict corrected, action none, block UNCHANGED (Level 1)", () => {
    const original = "cancel inflight request using an abort signal";
    const { block, flag } = makeFlaggedBlock(original);
    const v: ProvenanceVerdict = { grounded: true, correct_excerpt: TRANSCRIPT_TEXT, reasoning: "would correct" };
    const out = applyProvenanceVerdict(db, flag, block, v, false);
    assert.equal(out.verdict, "corrected");
    assert.equal(out.action_taken, "none");
    assert.equal(db.getBlock(block.id)!.source_excerpt, original, "Level 1 does NOT mutate the block");
  });

  test("grounded + no fix → verdict leave", () => {
    const { block, flag } = makeFlaggedBlock("use AbortController to cancel");
    const v: ProvenanceVerdict = { grounded: true, correct_excerpt: "", reasoning: "grounded, excerpt acceptable" };
    const out = applyProvenanceVerdict(db, flag, block, v, true);
    assert.equal(out.verdict, "leave");
    assert.equal(out.action_taken, "none");
  });
});

describe("buildReviewInput", () => {
  test("includes block, suspect excerpt, and source transcript", () => {
    const block = db.createBlock({ label: "rev_buildinput", type: "decision", essence: "cancel fetch", content: { unique: { choice: "abort" } }, ttl: "permanent", status: "active", source_excerpt: "some suspect excerpt here" });
    const s = buildReviewInput(db, db.getBlock(block.id)!, TRANSCRIPT_TEXT);
    assert.ok(s.includes("STORED EXCERPT"), "labels the suspect excerpt");
    assert.ok(s.includes("SOURCE TRANSCRIPT"), "includes the source transcript section");
    assert.ok(s.includes("AbortController"), "transcript text present");
  });
});

describe("runProvenanceReviewerTick", () => {
  before(() => { (db as any).db.prepare("DELETE FROM pipeline_flags").run(); }); // isolate from earlier describes

  test("soft (fuzzy) flag is closed WITHOUT an LLM call", async () => {
    const { flag } = makeFlaggedBlock("a paraphrased excerpt", "soft");
    let called = false;
    const provider: any = { getName: () => "mock", isAvailable: () => true, generateStructured: async () => { called = true; return { result: null, rateLimited: false }; } };
    const r = await runProvenanceReviewerTick({ db, provider, limit: 50, autoAct: false });
    assert.ok(r.skipped_soft >= 1, "soft flag counted as skipped");
    assert.equal(called, false, "LLM was NEVER called for a soft flag");
    assert.equal(flagRow(flag.id).review_verdict, "leave", "soft flag closed as leave");
  });

  test("hard flag drives one LLM call and applies the verdict", async () => {
    const { block, flag } = makeFlaggedBlock("a fabricated excerpt not in transcript at all");
    const verdict: ProvenanceVerdict = { grounded: false, correct_excerpt: "", reasoning: "mock: not grounded" };
    let calls = 0;
    const provider: any = { getName: () => "mock", isAvailable: () => true, generateStructured: async () => { calls++; return { result: verdict, rateLimited: false }; } };
    const r = await runProvenanceReviewerTick({ db, provider, limit: 50, autoAct: true });
    assert.ok(calls >= 1, "LLM called for the hard flag");
    assert.ok(r.demoted >= 1, "hard flag demoted");
    assert.equal(flagRow(flag.id).review_verdict, "demoted");
    assert.equal(statusOf(block.id), "archived");
  });
});
