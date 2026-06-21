import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import { WorkspaceDB } from "../../../store/database.js";
import { writePipelineFlag, markFlagPendingClarification, getAgentPendingFlags } from "../pipeline-flags.js";
import { resolveRoutedFlagsFromText, buildNlAcceptInput, type NlResolution } from "../nl-accept.js";

// nl-accept = flag-resolution (b): apply the agent's NL decision about a routed flag.
// These lock the SAFETY contract with a mock LLM (no real call): gate off / work-gate
// short-circuit before any LLM call; never-fabricate (quote must be grounded);
// conservative merge (only high-confidence + valid winner archives; weak merge stays
// pending); leave/split are non-destructive.

const TEST_DB = path.resolve("/tmp/nl_accept_test.db");
let db: WorkspaceDB;
let raw: Database.Database;

function cleanFiles() {
  for (const s of ["", "-wal", "-shm"]) {
    try { if (fs.existsSync(TEST_DB + s)) fs.unlinkSync(TEST_DB + s); } catch { /* ignore */ }
  }
}
function mkDecision(label: string, choice: string) {
  return db.createBlock({ label, type: "decision", essence: `essence ${label}`,
    content: { unique: { choice } }, concepts: [], ttl: "permanent" });
}
/** Write + route a dup flag to the agent (the reviewer's owner-unknown path). */
function routeFlag(aId: string, bId: string | null): string {
  const id = writePipelineFlag(raw, {
    flag_type: "cross_arc_dup_candidate", block_id_a: aId, block_id_b: bId,
    criteria: {}, scope_check: "unknown", origin_writer: "stage_d_resolve", origin_range_id: null,
  });
  markFlagPendingClarification(raw, { flag_id: id, reason: "owner unknown" });
  return id;
}

/** Minimal LLMProvider mock — returns a fixed resolutions[] and counts calls. */
function mkProvider(resolutions: NlResolution[] | null) {
  const p: any = {
    calls: 0,
    async generateStructured() { p.calls += 1; return { result: resolutions === null ? null : { resolutions }, rateLimited: false }; },
    async generate() { return null; },
    async ping() { return true; },
    isAvailable() { return true; },
    getName() { return "mock"; },
  };
  return p;
}

before(async () => { cleanFiles(); db = new WorkspaceDB(TEST_DB); await db.init(); raw = (db as any)["db"]; });
after(() => { try { (db as any)["db"]?.close(); } catch { /* ignore */ } cleanFiles(); });
beforeEach(() => {
  delete process.env.NODEDEX_FLAG_NL_ACCEPT;
  raw.pragma("foreign_keys = OFF");
  raw.exec(`DELETE FROM pipeline_flags`); raw.exec(`DELETE FROM relations`); raw.exec(`DELETE FROM blocks`);
  raw.pragma("foreign_keys = ON");
});

const AGENT_SAYS = "Looking at those two, they're the same decision — keep customer-c's entry and drop the other.";

describe("resolveRoutedFlagsFromText — gates", () => {
  test("gate OFF (default) → no LLM call, no change, even with a routed flag", async () => {
    const a = mkDecision("customer-c_decision_redis", "use redis"); const b = mkDecision("unspecified_decision_redis", "use redis");
    routeFlag(a.id, b.id);
    const prov = mkProvider([]);
    const res = await resolveRoutedFlagsFromText(db, prov, AGENT_SAYS);  // no force, env unset
    assert.equal(prov.calls, 0, "gated before any LLM call");
    assert.equal(res.addressed, 0);
    assert.equal(getAgentPendingFlags(raw).length, 1, "flag still pending");
  });

  test("work-gate: no routed flags → no LLM call (forced on)", async () => {
    const prov = mkProvider([]);
    const res = await resolveRoutedFlagsFromText(db, prov, AGENT_SAYS, { force: true });
    assert.equal(prov.calls, 0, "no flags → no call ($0)");
    assert.equal(res.addressed, 0);
  });
});

describe("resolveRoutedFlagsFromText — apply", () => {
  test("leave: applied (non-destructive), flag resolved, both blocks kept", async () => {
    const a = mkDecision("customer-c_decision_redis", "use redis"); const b = mkDecision("unspecified_decision_redis", "use redis");
    const id = routeFlag(a.id, b.id);
    const prov = mkProvider([{ flag_id: id, verdict: "leave", confidence: "high", quote: "they're the same decision" }]);
    // (quote is grounded in AGENT_SAYS) — but verdict leave keeps both; reason captures it.
    const res = await resolveRoutedFlagsFromText(db, prov, AGENT_SAYS, { force: true });
    assert.equal(res.addressed, 1); assert.equal(res.left, 1);
    assert.notEqual(db.getBlock(a.id)!.status, "archived");
    assert.notEqual(db.getBlock(b.id)!.status, "archived");
    assert.equal(getAgentPendingFlags(raw).length, 0, "flag resolved");
  });

  test("merge HIGH-confidence + valid winner: loser archived", async () => {
    const a = mkDecision("customer-c_decision_redis", "use redis"); const b = mkDecision("unspecified_decision_redis", "use redis");
    const id = routeFlag(a.id, b.id);
    const prov = mkProvider([{ flag_id: id, verdict: "merge", winning_block_id: a.id, confidence: "high", quote: "keep customer-c's entry and drop the other" }]);
    const res = await resolveRoutedFlagsFromText(db, prov, AGENT_SAYS, { force: true });
    assert.equal(res.merged, 1);
    assert.equal(db.getBlock(b.id)!.status, "archived", "loser archived");
    assert.notEqual(db.getBlock(a.id)!.status, "archived");
  });

  test("merge LOW-confidence: NOT applied, flag left pending", async () => {
    const a = mkDecision("customer-c_decision_redis", "use redis"); const b = mkDecision("unspecified_decision_redis", "use redis");
    const id = routeFlag(a.id, b.id);
    const prov = mkProvider([{ flag_id: id, verdict: "merge", winning_block_id: a.id, confidence: "low", quote: "they're the same decision" }]);
    const res = await resolveRoutedFlagsFromText(db, prov, AGENT_SAYS, { force: true });
    assert.equal(res.merged, 0); assert.equal(res.skipped_low_conf, 1);
    assert.notEqual(db.getBlock(b.id)!.status, "archived", "weak merge never archives");
    assert.equal(getAgentPendingFlags(raw).length, 1, "flag stays pending for explicit confirmation");
  });

  test("never-fabricate: a quote NOT in the agent's text is ignored", async () => {
    const a = mkDecision("customer-c_decision_redis", "use redis"); const b = mkDecision("unspecified_decision_redis", "use redis");
    const id = routeFlag(a.id, b.id);
    const prov = mkProvider([{ flag_id: id, verdict: "merge", winning_block_id: a.id, confidence: "high", quote: "I never actually wrote this sentence" }]);
    const res = await resolveRoutedFlagsFromText(db, prov, AGENT_SAYS, { force: true });
    assert.equal(res.addressed, 0, "ungrounded quote rejected");
    assert.notEqual(db.getBlock(b.id)!.status, "archived");
    assert.equal(getAgentPendingFlags(raw).length, 1);
  });

  test("hallucinated flag_id is ignored", async () => {
    const a = mkDecision("customer-c_decision_redis", "use redis"); const b = mkDecision("unspecified_decision_redis", "use redis");
    routeFlag(a.id, b.id);
    const prov = mkProvider([{ flag_id: "pfl_does_not_exist", verdict: "leave", confidence: "high", quote: "they're the same decision" }]);
    const res = await resolveRoutedFlagsFromText(db, prov, AGENT_SAYS, { force: true });
    assert.equal(res.addressed, 0);
    assert.equal(getAgentPendingFlags(raw).length, 1);
  });

  test("verdict 'none' is skipped (the common case — turn didn't address the flag)", async () => {
    const a = mkDecision("customer-c_decision_redis", "use redis"); const b = mkDecision("unspecified_decision_redis", "use redis");
    const id = routeFlag(a.id, b.id);
    const prov = mkProvider([{ flag_id: id, verdict: "none", confidence: "low", quote: "" }]);
    const res = await resolveRoutedFlagsFromText(db, prov, AGENT_SAYS, { force: true });
    assert.equal(res.addressed, 0);
    assert.equal(getAgentPendingFlags(raw).length, 1);
  });
});

describe("buildNlAcceptInput", () => {
  test("presents each question with its two candidate ids (so the parser can name a winner)", () => {
    const a = mkDecision("customer-c_decision_redis", "use redis for sessions");
    const b = mkDecision("unspecified_decision_redis", "use redis for sessions");
    const id = routeFlag(a.id, b.id);
    const flags = getAgentPendingFlags(raw);
    const input = buildNlAcceptInput(raw, AGENT_SAYS, flags);
    assert.match(input, new RegExp(`flag_id=${id}`));
    assert.match(input, new RegExp(`id=${a.id}`));
    assert.match(input, new RegExp(`id=${b.id}`));
    assert.match(input, /AGENT'S MESSAGE/);
  });
});
