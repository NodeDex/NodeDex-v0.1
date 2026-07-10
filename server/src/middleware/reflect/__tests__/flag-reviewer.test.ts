/**
 * DEBT 5 Slice 2 Sub-step 2.2 — async flag-reviewer tests.
 *
 * Uses a REAL WorkspaceDB (not a mock) so the merge action exercises the
 * actual createRelation('supersedes')→auto-archive path (database.ts:1192-
 * 1198). The LLM provider IS mocked (scripted verdicts) — we test the
 * orchestration + action logic, not the model.
 *
 * Covers:
 *   - loadBlockSnapshot / loadScopeChain pure functions
 *   - buildReviewerInput formatting (both-block + single-block)
 *   - happy path: merge/leave/split verdicts written to flag row
 *   - Level 1 (verdict-only): merge verdict written but NO archive fires
 *   - Level 2 (auto-merge): merge + high confidence → loser archived + relation
 *   - winning_block_id validation: LLM hallucinated id → verdict written, NO merge
 *   - confidence gate: merge + medium confidence → NO auto-merge even at Level 2
 *   - deferral: island_candidate / entity_unresolved → leave + deferral reason
 *   - stale flag: block_a archived between write + review → leave no-op
 *   - idempotency: already-reviewed flag not re-processed
 *   - telemetry: reflectTokenStats.pass_reviewer increments
 *
 * Run: node --import=tsx/esm --test src/middleware/reflect/__tests__/flag-reviewer.test.ts
 */
import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import { WorkspaceDB } from "../../../store/database.js";
import type { LLMProvider } from "../../../engine/ai-provider.js";
import { writePipelineFlag, getFlagsForBlock, getPendingFlags, getAgentPendingFlags } from "../pipeline-flags.js";
import {
  runFlagReviewerTick,
  loadBlockSnapshot,
  loadScopeChain,
  buildReviewerInput,
  buildReviewerContext,
  executeMerge,
} from "../flag-reviewer.js";
import { reflectTokenStats } from "../context.js";

const TEST_DB = path.resolve("/tmp/flag_reviewer_test.db");

let db: WorkspaceDB;
let raw: Database.Database;

function cleanFiles() {
  for (const suffix of ["", "-wal", "-shm"]) {
    try { if (fs.existsSync(TEST_DB + suffix)) fs.unlinkSync(TEST_DB + suffix); } catch { /* ignore */ }
  }
}

before(async () => {
  cleanFiles();
  db = new WorkspaceDB(TEST_DB);
  await db.init();
  raw = (db as any)["db"] as Database.Database;
});

after(() => {
  try { (db as any)["db"]?.close(); } catch { /* ignore */ }
  cleanFiles();
});

beforeEach(() => {
  // Wipe with FK enforcement OFF so child→parent ordering doesn't matter for
  // teardown. Production keeps FK ON (database.ts:173) — re-enable after wipe
  // so the actual test operations exercise the real FK-enforced paths.
  raw.pragma("foreign_keys = OFF");
  raw.exec(`DELETE FROM pipeline_flags`);
  raw.exec(`DELETE FROM relations`);
  raw.exec(`DELETE FROM blocks`);
  raw.pragma("foreign_keys = ON");
  reflectTokenStats.reset();
  reflectTokenStats.pass_reviewer = { input: 0, thinking: 0, output: 0, calls: 0 };
  delete process.env.NODEDEX_FLAG_AUTO_MERGE;
});

// ─── Mock provider ──────────────────────────────────────────────────────────────

interface MockResponse {
  result: any;
  rateLimited?: boolean;
}

function makeMockProvider(scripted: MockResponse[], opts: { available?: boolean } = {}): LLMProvider {
  let idx = 0;
  return {
    getName: () => "mock",
    isAvailable: () => opts.available ?? true,
    generateStructured: async () => {
      if (idx >= scripted.length) {
        throw new Error(`mock provider exhausted: asked for response ${idx + 1}, only ${scripted.length} scripted`);
      }
      const r = scripted[idx++];
      return {
        result:      r.result,
        thinking:    "",
        rateLimited: r.rateLimited ?? false,
        model:       "gemini-2.5-flash",  // priced model so cost_usd is a number
        attempts:    [{ model: "gemini-2.5-flash", outcome: r.result ? "ok" : "error" }],
        usage:       { input: 500, thinking: 100, output: 200 },
      };
    },
  } as unknown as LLMProvider;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function mkBlock(label: string, opts: { concepts?: string[]; content?: Record<string, unknown>; type?: string } = {}) {
  return db.createBlock({
    label,
    type: opts.type ?? "fact",
    essence: `essence of ${label}`,
    content: opts.content ?? { value: label },
    concepts: opts.concepts ?? [],
    ttl: "permanent",
  });
}

function writeDupFlag(blockA: string, blockB: string | null, flag_type: any = "atomic_dup_candidate") {
  return writePipelineFlag(raw, {
    flag_type,
    block_id_a: blockA,
    block_id_b: blockB,
    criteria: { value_match: "x", overlap_score: 0.9 },
    scope_check: "unknown",
    origin_writer: "stage_flag_dedup",
    origin_range_id: null,
  });
}

function getFlagRow(flagId: string): any {
  return raw.prepare(`SELECT * FROM pipeline_flags WHERE id = ?`).get(flagId);
}

// ─── Pure-function tests ────────────────────────────────────────────────────────

describe("loadBlockSnapshot + loadScopeChain", () => {
  test("loadBlockSnapshot returns parsed concepts + null for missing block", () => {
    const b = mkBlock("snap_test", { concepts: ["alpha", "beta"] });
    const snap = loadBlockSnapshot(raw, b.id);
    assert.ok(snap);
    assert.equal(snap!.label, "snap_test");
    assert.deepEqual(snap!.concepts, ["alpha", "beta"]);
    assert.equal(loadBlockSnapshot(raw, "blk_nonexistent"), null);
  });

  test("loadScopeChain walks part_of to root", () => {
    const root = mkBlock("scope_root", { type: "project" });
    const child = mkBlock("scope_child");
    db.createRelation({ source_id: child.id, target_id: root.id, type: "part_of" });
    const chain = loadScopeChain(raw, child.id);
    // root → child order (unshift puts root first)
    assert.deepEqual(chain, ["scope_root", "scope_child"]);
  });

  test("loadScopeChain on orphan block returns just itself", () => {
    const b = mkBlock("scope_orphan");
    assert.deepEqual(loadScopeChain(raw, b.id), ["scope_orphan"]);
  });

  test("loadBlockSnapshot returns null for an ARCHIVED block (stale — Problem-2 fix)", () => {
    const b = mkBlock("arch_snap");
    db.archiveBlock(b.id, "test archive");
    assert.equal(loadBlockSnapshot(raw, b.id), null, "archived block must read as stale (null)");
  });

  test("loadBlockSnapshot surfaces the unique{} claim as primary_value", () => {
    const b = mkBlock("claim_snap", { content: { unique: { value: "the canonical claim" } } });
    const snap = loadBlockSnapshot(raw, b.id);
    assert.equal(snap!.primary_value, "the canonical claim");
  });
});

describe("buildReviewerInput", () => {
  test("includes both blocks when block_b present", () => {
    const a = mkBlock("input_a", { concepts: ["x"] });
    const b = mkBlock("input_b", { concepts: ["y"] });
    const flagId = writeDupFlag(a.id, b.id);
    const flag = getFlagsForBlock(raw, a.id)[0];
    const ctx = buildReviewerContext(raw, flag)!;
    const text = buildReviewerInput(ctx);
    assert.match(text, /BLOCK A:/);
    assert.match(text, /BLOCK B:/);
    assert.match(text, /input_a/);
    assert.match(text, /input_b/);
    assert.match(text, /FLAG TYPE: atomic_dup_candidate/);
    void flagId;
  });

  test("single-block flag formats BLOCK B as none", () => {
    const a = mkBlock("input_solo");
    writeDupFlag(a.id, null, "entity_unresolved");
    const flag = getFlagsForBlock(raw, a.id)[0];
    const ctx = buildReviewerContext(raw, flag)!;
    const text = buildReviewerInput(ctx);
    assert.match(text, /BLOCK B: \(none/);
  });
});

// ─── Orchestration: verdicts ──────────────────────────────────────────────────

describe("runFlagReviewerTick — verdicts", () => {
  test("leave verdict written, no graph change", async () => {
    const a = mkBlock("leave_a");
    const b = mkBlock("leave_b");
    const flagId = writeDupFlag(a.id, b.id);
    const provider = makeMockProvider([
      { result: { verdict: "leave", reason: "different scope", confidence: "high" } },
    ]);
    const res = await runFlagReviewerTick({ db, provider });
    assert.equal(res.reviewed, 1);
    assert.equal(res.verdicts.leave, 1);
    assert.equal(res.actions_executed, 0);
    const row = getFlagRow(flagId);
    assert.equal(row.review_verdict, "leave");
    assert.ok(row.reviewed_at);
    assert.equal(row.action_taken, "none");
    // Both blocks still active
    assert.equal(db.getBlock(a.id)!.status !== "archived", true);
    assert.equal(db.getBlock(b.id)!.status !== "archived", true);
  });

  test("split verdict written, no graph change", async () => {
    const a = mkBlock("split_a");
    const b = mkBlock("split_b");
    const flagId = writeDupFlag(a.id, b.id);
    const provider = makeMockProvider([
      { result: { verdict: "split", reason: "needs re-parent", confidence: "low" } },
    ]);
    const res = await runFlagReviewerTick({ db, provider });
    assert.equal(res.verdicts.split, 1);
    assert.equal(getFlagRow(flagId).review_verdict, "split");
    assert.equal(getFlagRow(flagId).action_taken, "none");
  });

  test("telemetry: pass_reviewer increments + cost_usd is a number", async () => {
    const a = mkBlock("tel_a");
    const b = mkBlock("tel_b");
    writeDupFlag(a.id, b.id);
    const provider = makeMockProvider([
      { result: { verdict: "leave", reason: "x", confidence: "high" } },
    ]);
    const res = await runFlagReviewerTick({ db, provider });
    assert.equal(reflectTokenStats.pass_reviewer.calls, 1);
    assert.ok(reflectTokenStats.pass_reviewer.input > 0);
    assert.equal(typeof res.cost_usd, "number");
  });
});

// ─── Level 1 vs Level 2 (auto-merge gate) ──────────────────────────────────────

describe("runFlagReviewerTick — merge action gating", () => {
  test("Level 1 (auto-merge OFF): merge verdict written but NO archive", async () => {
    process.env.NODEDEX_FLAG_AUTO_MERGE = "off"; // Level 1 is now the opt-DOWN (default = Level 2)
    const winner = mkBlock("L1_winner", { concepts: ["a", "b", "c"] });
    const loser = mkBlock("L1_loser", { concepts: ["a"] });
    const flagId = writeDupFlag(winner.id, loser.id);
    const provider = makeMockProvider([
      { result: { verdict: "merge", reason: "same", confidence: "high", winning_block_id: winner.id } },
    ]);
    const res = await runFlagReviewerTick({ db, provider });
    assert.equal(res.verdicts.merge, 1);
    assert.equal(res.actions_executed, 0, "Level 1 must NOT execute merge");
    const row = getFlagRow(flagId);
    assert.equal(row.review_verdict, "merge");
    assert.equal(row.action_taken, "none", "no action at Level 1");
    assert.equal(row.winning_block_id, winner.id, "winner recorded even without action");
    // Loser still active
    assert.notEqual(db.getBlock(loser.id)!.status, "archived");
  });

  test("Level 2 (forceAutoMerge): merge + high conf → loser archived + supersedes relation", async () => {
    const winner = mkBlock("L2_winner", { concepts: ["a", "b", "c"] });
    const loser = mkBlock("L2_loser", { concepts: ["a"] });
    const flagId = writeDupFlag(winner.id, loser.id);
    const provider = makeMockProvider([
      { result: { verdict: "merge", reason: "same entity", confidence: "high", winning_block_id: winner.id } },
    ]);
    const res = await runFlagReviewerTick({ db, provider, forceAutoMerge: true });
    assert.equal(res.actions_executed, 1, "Level 2 high-conf merge fires");
    const row = getFlagRow(flagId);
    assert.equal(row.action_taken, "archived_loser_and_wired_superseded_by");
    assert.ok(row.action_at);
    // Loser archived
    assert.equal(db.getBlock(loser.id)!.status, "archived");
    // supersedes relation winner → loser exists
    const rel = raw.prepare(
      `SELECT * FROM relations WHERE source_id = ? AND target_id = ? AND type = 'supersedes'`
    ).get(winner.id, loser.id);
    assert.ok(rel, "supersedes relation should exist winner→loser");
  });

  test("DEFAULT (env unset) is Level 2: merge + high conf auto-merges without forceAutoMerge", async () => {
    // Pins the 2026-06-20 locked-on decision: NODEDEX_FLAG_AUTO_MERGE unset = ON.
    // Regression guard for the startup-log/tick default mismatch (found 2026-07-04:
    // boot log claimed Level 2 while the tick's gate read the opposite default).
    const winner = mkBlock("def_winner", { concepts: ["a", "b"] });
    const loser = mkBlock("def_loser", { concepts: ["a"] });
    writeDupFlag(winner.id, loser.id);
    const provider = makeMockProvider([
      { result: { verdict: "merge", reason: "same", confidence: "high", winning_block_id: winner.id } },
    ]);
    const res = await runFlagReviewerTick({ db, provider }); // no forceAutoMerge — env default decides
    assert.equal(res.actions_executed, 1, "default must be Level 2 (auto-merge ON)");
    assert.equal(db.getBlock(loser.id)!.status, "archived");
  });

  test("Level 2 but MEDIUM confidence → verdict written, NO merge (confidence gate)", async () => {
    const winner = mkBlock("med_winner", { concepts: ["a", "b"] });
    const loser = mkBlock("med_loser");
    writeDupFlag(winner.id, loser.id);
    const provider = makeMockProvider([
      { result: { verdict: "merge", reason: "maybe same", confidence: "medium", winning_block_id: winner.id } },
    ]);
    const res = await runFlagReviewerTick({ db, provider, forceAutoMerge: true });
    assert.equal(res.actions_executed, 0, "medium confidence must NOT auto-merge");
    assert.notEqual(db.getBlock(loser.id)!.status, "archived");
  });

  test("Level 2 but LLM picks invalid winning_block_id → verdict written, NO merge", async () => {
    const winner = mkBlock("bad_winner");
    const loser = mkBlock("bad_loser");
    writeDupFlag(winner.id, loser.id);
    const provider = makeMockProvider([
      { result: { verdict: "merge", reason: "x", confidence: "high", winning_block_id: "blk_hallucinated_999" } },
    ]);
    const res = await runFlagReviewerTick({ db, provider, forceAutoMerge: true });
    assert.equal(res.actions_executed, 0, "invalid winner id must NOT merge");
    assert.notEqual(db.getBlock(loser.id)!.status, "archived");
    assert.notEqual(db.getBlock(winner.id)!.status, "archived");
  });
});

// ─── Deferral + stale + idempotency ─────────────────────────────────────────────

describe("runFlagReviewerTick — deferral, stale, idempotency", () => {
  test("island_candidate is deferred (leave + deferral reason), NO LLM call", async () => {
    const a = mkBlock("island_a");
    const b = mkBlock("island_b");
    const flagId = writeDupFlag(a.id, b.id, "island_candidate");
    // Empty mock script — if the reviewer tried to call the LLM it would throw
    const provider = makeMockProvider([]);
    const res = await runFlagReviewerTick({ db, provider });
    assert.equal(res.reviewed, 1);
    assert.equal(res.verdicts.leave, 1);
    const row = getFlagRow(flagId);
    assert.equal(row.review_verdict, "leave");
    assert.match(row.review_reason, /Deferred/);
  });

  test("entity_unresolved is deferred (leave), NO LLM call", async () => {
    const a = mkBlock("unres_a");
    const flagId = writeDupFlag(a.id, null, "entity_unresolved");
    const provider = makeMockProvider([]);
    const res = await runFlagReviewerTick({ db, provider });
    assert.equal(res.verdicts.leave, 1);
    assert.match(getFlagRow(flagId).review_reason, /Deferred/);
  });

  test("stale flag (block_a fully removed) → leave no-op, NO LLM call", async () => {
    // loadBlockSnapshot has NO status filter — it finds ARCHIVED blocks (the
    // reviewer SHOULD see them). The only "null" trigger is a block that's
    // genuinely gone from the table. Under FK-ON that can't happen normally
    // (archive-not-delete), so we simulate an out-of-band removal with FK off —
    // exactly the orphan state the defensive null-branch guards against.
    const a = mkBlock("stale_a");
    const b = mkBlock("stale_b");
    const flagId = writeDupFlag(a.id, b.id);
    raw.pragma("foreign_keys = OFF");
    raw.prepare(`DELETE FROM blocks WHERE id = ?`).run(a.id);
    raw.pragma("foreign_keys = ON");
    const provider = makeMockProvider([]); // empty — would throw if LLM called
    const res = await runFlagReviewerTick({ db, provider });
    assert.equal(res.reviewed, 1);
    assert.equal(res.verdicts.leave, 1);
    assert.match(getFlagRow(flagId).review_reason, /Stale/);
    void b;
  });

  test("2-block flag whose partner B is ARCHIVED → stale, no LLM, no re-merge (Problem-2 fix)", async () => {
    // Simulates: an earlier merge THIS tick archived B; a later flag still references it.
    // Pre-fix, loadBlockSnapshot loaded the archived B → re-judged → double-merge cascade.
    const a = mkBlock("ap_a");
    const b = mkBlock("ap_b");
    db.archiveBlock(b.id, "merged earlier this tick (simulated)");
    writeDupFlag(a.id, b.id);
    const provider = makeMockProvider([]); // throws if the reviewer tries to call the LLM
    const res = await runFlagReviewerTick({ db, provider });
    assert.equal(res.reviewed, 1);
    assert.equal(res.verdicts.leave, 1, "archived partner → stale leave, never a re-merge");
    assert.equal(res.actions_executed, 0);
  });

  test("already-reviewed flag is NOT re-processed (getPendingFlags excludes it)", async () => {
    const a = mkBlock("idem_a");
    const b = mkBlock("idem_b");
    writeDupFlag(a.id, b.id);
    const provider = makeMockProvider([
      { result: { verdict: "leave", reason: "x", confidence: "high" } },
    ]);
    await runFlagReviewerTick({ db, provider });
    // Second tick: empty script — would throw if it tried to review again
    const provider2 = makeMockProvider([]);
    const res2 = await runFlagReviewerTick({ db, provider: provider2 });
    assert.equal(res2.reviewed, 0, "no pending flags remain");
  });

  test("LLM failure → flag stays unreviewed (error counted)", async () => {
    const a = mkBlock("fail_a");
    const b = mkBlock("fail_b");
    const flagId = writeDupFlag(a.id, b.id);
    const provider = makeMockProvider([{ result: null, rateLimited: true }]);
    const res = await runFlagReviewerTick({ db, provider });
    assert.equal(res.errors, 1);
    assert.equal(res.reviewed, 0);
    assert.equal(getFlagRow(flagId).reviewed_at, null, "flag stays unreviewed for retry");
  });
});

// ─── Owner-unknown routing: flag → agent, never auto-guess ──────────────────────

describe("runFlagReviewerTick — owner-unknown routing to the agent", () => {
  function writeStageDFlag(blockA: string, blockB: string | null, scope: "same" | "unknown", decision: string) {
    return writePipelineFlag(raw, {
      flag_type: "cross_arc_dup_candidate",
      block_id_a: blockA,
      block_id_b: blockB,
      criteria: { detected_by: "stage_d_resolve", decision },
      scope_check: scope,
      origin_writer: "stage_d_resolve",
      origin_range_id: null,
    });
  }

  test("Stage D owner-unknown flag is ROUTED to the agent — no LLM, no merge, agent can still resolve", async () => {
    const newBlk = mkBlock("route_new", { concepts: ["redis"] });
    const orphan = mkBlock("route_orphan", { concepts: ["redis"] });
    const flagId = writeStageDFlag(newBlk.id, orphan.id, "unknown", "flag_for_review");
    // Empty mock — if the reviewer tried to call the LLM (i.e. tried to GUESS) it throws.
    const provider = makeMockProvider([]);
    const res = await runFlagReviewerTick({ db, provider, forceAutoMerge: true });

    assert.equal(res.routed_to_agent, 1, "owner-unknown is handed to the agent");
    assert.equal(res.reviewed, 0, "routing is not a verdict");
    assert.equal(res.actions_executed, 0, "no auto-merge — must not guess the owner");
    assert.equal(res.verdicts.merge + res.verdicts.leave + res.verdicts.split, 0);

    const row = getFlagRow(flagId);
    assert.equal(row.review_verdict, "pending_clarification");
    assert.equal(row.reviewed_at, null, "stays resolvable by the agent via /api/flags/:id/review");
    assert.notEqual(db.getBlock(newBlk.id)!.status, "archived");
    assert.notEqual(db.getBlock(orphan.id)!.status, "archived");

    // The reviewer won't re-tick it; the agent-pending reader surfaces it.
    assert.equal(getPendingFlags(raw).length, 0, "excluded from the reviewer queue");
    const agentPending = getAgentPendingFlags(raw);
    assert.equal(agentPending.length, 1);
    assert.equal(agentPending[0].id, flagId);
  });

  test("Stage D attach_existing (scope=same) is NOT routed — reviewer handles it normally", async () => {
    const a = mkBlock("attach_a");
    const b = mkBlock("attach_b");
    writeStageDFlag(a.id, b.id, "same", "attach_existing");
    const provider = makeMockProvider([{ result: { verdict: "leave", reason: "x", confidence: "high" } }]);
    const res = await runFlagReviewerTick({ db, provider });
    assert.equal(res.routed_to_agent, 0);
    assert.equal(res.reviewed, 1);
  });

  test("D2 atomic-dup with scope=unknown (origin=stage_flag_dedup) is NOT routed — same-source, mechanical", async () => {
    const a = mkBlock("d2_a");
    const b = mkBlock("d2_b");
    writeDupFlag(a.id, b.id); // origin=stage_flag_dedup, scope=unknown
    const provider = makeMockProvider([{ result: { verdict: "leave", reason: "exact dup", confidence: "high" } }]);
    const res = await runFlagReviewerTick({ db, provider });
    assert.equal(res.routed_to_agent, 0, "D2 'unknown' is not genuine owner-ambiguity");
    assert.equal(res.reviewed, 1);
    assert.equal(res.verdicts.leave, 1);
  });
});

// ─── Merge-confidence routing: lean-merge-but-unsure → agent, not silent ────────

describe("runFlagReviewerTick — merge-confidence routing to the agent", () => {
  test("merge + MEDIUM confidence (auto-merge on) is ROUTED to the agent — not merged, not silently dropped", async () => {
    const a = mkBlock("mc_a");
    const b = mkBlock("mc_b");
    const flagId = writeDupFlag(a.id, b.id, "block_dup_candidate");
    const provider = makeMockProvider([
      { result: { verdict: "merge", confidence: "medium", winning_block_id: a.id, reason: "likely the same claim, reworded" } },
    ]);
    const res = await runFlagReviewerTick({ db, provider, forceAutoMerge: true });

    assert.equal(res.routed_to_agent, 1, "lean-merge-but-unsure goes to the agent");
    assert.equal(res.actions_executed, 0, "no auto-merge on sub-high confidence — a wrong merge corrupts");
    assert.equal(res.reviewed, 0, "routing is not a verdict");
    assert.notEqual(db.getBlock(a.id)!.status, "archived");
    assert.notEqual(db.getBlock(b.id)!.status, "archived");
    const row = getFlagRow(flagId);
    assert.equal(row.review_verdict, "pending_clarification");
    assert.equal(row.reviewed_at, null, "agent can still resolve via /api/flags/:id/review");
    assert.equal(getAgentPendingFlags(raw).some((f) => f.id === flagId), true, "surfaced to the agent");
    assert.equal(getPendingFlags(raw).length, 0, "excluded from the reviewer queue");
  });

  test("merge + HIGH confidence + valid winner still auto-merges — not routed", async () => {
    const a = mkBlock("mc_hi_a", { concepts: ["x", "y"] }); // richer → preferred winner
    const b = mkBlock("mc_hi_b");
    writeDupFlag(a.id, b.id, "block_dup_candidate");
    const provider = makeMockProvider([
      { result: { verdict: "merge", confidence: "high", winning_block_id: a.id, reason: "same claim, same source" } },
    ]);
    const res = await runFlagReviewerTick({ db, provider, forceAutoMerge: true });
    assert.equal(res.actions_executed, 1, "high-confidence merge still executes");
    assert.equal(res.routed_to_agent, 0);
    assert.equal(db.getBlock(b.id)!.status, "archived", "loser archived");
  });

  test("merge + HIGH but winner outside the candidate pair is ROUTED, not merged", async () => {
    const a = mkBlock("mc_w_a");
    const b = mkBlock("mc_w_b");
    const flagId = writeDupFlag(a.id, b.id, "block_dup_candidate");
    const provider = makeMockProvider([
      { result: { verdict: "merge", confidence: "high", winning_block_id: "blk_not_a_candidate", reason: "hallucinated winner" } },
    ]);
    const res = await runFlagReviewerTick({ db, provider, forceAutoMerge: true });
    assert.equal(res.actions_executed, 0, "cannot merge onto a block outside the pair");
    assert.equal(res.routed_to_agent, 1, "surfaced instead of silently dropped");
    assert.equal(getFlagRow(flagId).review_verdict, "pending_clarification");
  });

  test("merge + medium with auto-merge OFF (Level 1) is verdict-only — NOT routed (manual REST review)", async () => {
    process.env.NODEDEX_FLAG_AUTO_MERGE = "off"; // Level 1 is the opt-DOWN (default = Level 2)
    const a = mkBlock("mc_l1_a");
    const b = mkBlock("mc_l1_b");
    const flagId = writeDupFlag(a.id, b.id, "block_dup_candidate");
    const provider = makeMockProvider([
      { result: { verdict: "merge", confidence: "medium", winning_block_id: a.id, reason: "leans dup" } },
    ]);
    const res = await runFlagReviewerTick({ db, provider }); // Level 1: no forceAutoMerge, env auto-merge off
    assert.equal(res.routed_to_agent, 0, "Level 1 keeps verdict-only semantics");
    assert.equal(res.reviewed, 1);
    assert.equal(res.verdicts.merge, 1);
    const row = getFlagRow(flagId);
    assert.equal(row.review_verdict, "merge");
    assert.equal(row.action_taken, "none");
  });
});

// ─── executeMerge — rewire loser's relations onto winner before archive ─────────

describe("executeMerge — relation rewire", () => {
  function rawOut(id: string) {
    return raw.prepare(`SELECT target_id, type FROM relations WHERE source_id = ? AND valid_to IS NULL`).all(id) as Array<{ target_id: string; type: string }>;
  }
  function rawIn(id: string) {
    return raw.prepare(`SELECT source_id, type FROM relations WHERE target_id = ? AND valid_to IS NULL`).all(id) as Array<{ source_id: string; type: string }>;
  }

  test("loser's CONTENT edges (both directions) are re-pointed to the winner; part_of is NOT", () => {
    const winner = mkBlock("mg_winner");
    const loser  = mkBlock("mg_loser");
    const other  = mkBlock("mg_other");
    const parent = mkBlock("mg_parent", { type: "project" });
    db.createRelation({ source_id: loser.id, target_id: other.id,  type: "based_on" }); // loser → other
    db.createRelation({ source_id: other.id, target_id: loser.id,  type: "supports" }); // other → loser
    db.createRelation({ source_id: loser.id, target_id: parent.id, type: "part_of" });  // structural — skip

    const action = executeMerge(db, winner.id, loser.id);
    assert.equal(action, "archived_loser_and_wired_superseded_by");

    assert.ok(rawOut(winner.id).some(r => r.target_id === other.id && r.type === "based_on"), "winner → other (based_on) rewired");
    assert.ok(rawIn(winner.id).some(r => r.source_id === other.id && r.type === "supports"), "other → winner (supports) rewired");
    assert.ok(!rawOut(winner.id).some(r => r.type === "part_of"), "part_of is structural — NOT rewired onto winner");
    assert.equal(db.getBlock(loser.id)!.status, "archived", "loser archived");
  });

  test("refuses self-merge", () => {
    const b = mkBlock("self_b");
    assert.equal(executeMerge(db, b.id, b.id), "none");
  });

  test("STATUS CARRY-FORWARD (Fix 3): merging a done twin into an open task carries done onto the survivor", () => {
    // The live 07-10 shape: "task X (open)" + twin "task X marked complete (done)". If the
    // reviewer picks the older/richer OPEN block as winner, archiving the done twin must
    // not archive the completion — the survivor carries the most-advanced status.
    const winner = mkBlock("cf_task_open", { type: "task", content: { unique: { status: "open", description: "wire the alert" } } });
    const loser = mkBlock("cf_task_done-twin", { type: "task", content: { unique: { status: "done", description: "alert wired" } } });
    const action = executeMerge(db, winner.id, loser.id);
    assert.equal(action, "archived_loser_and_wired_superseded_by");
    const c = JSON.parse(String(db.getBlock(winner.id)!.content));
    assert.equal(c.unique.status, "done", "survivor carries the completed state");
    assert.equal(c.has.status_carried_from, "cf_task_done-twin", "audit back-pointer to the twin");
  });

  test("carry-forward is one-directional: an open loser never downgrades a done winner", () => {
    const winner = mkBlock("cf_task_already-done", { type: "task", content: { unique: { status: "done", description: "x" } } });
    const loser = mkBlock("cf_task_stale-open", { type: "task", content: { unique: { status: "open", description: "x" } } });
    executeMerge(db, winner.id, loser.id);
    const c = JSON.parse(String(db.getBlock(winner.id)!.content));
    assert.equal(c.unique.status, "done", "done never regresses");
    assert.equal(c.has?.status_carried_from, undefined, "no carry happened");
  });

  test("carry-forward ignores non-stateful and cross-type merges", () => {
    const factWinner = mkBlock("cf_fact_a", { type: "fact", content: { unique: { value: "v" } } });
    const factLoser = mkBlock("cf_fact_b", { type: "fact", content: { unique: { value: "v2", status: "done" } } });
    executeMerge(db, factWinner.id, factLoser.id);
    const c = JSON.parse(String(db.getBlock(factWinner.id)!.content));
    assert.equal(c.unique.status, undefined, "facts carry no work status — untouched");
  });

  test("loser already linked to winner → no winner→winner self-loop", () => {
    const winner = mkBlock("sl_winner");
    const loser  = mkBlock("sl_loser");
    db.createRelation({ source_id: loser.id, target_id: winner.id, type: "supports" }); // loser → winner
    const action = executeMerge(db, winner.id, loser.id);
    assert.equal(action, "archived_loser_and_wired_superseded_by");
    assert.ok(!rawOut(winner.id).some(r => r.target_id === winner.id), "no winner→winner self-loop created");
  });

  test("transitive merge FLATTENS: a prior loser is superseded DIRECTLY by the final winner", () => {
    const A = mkBlock("tm_a"); const B = mkBlock("tm_b"); const C = mkBlock("tm_c");
    executeMerge(db, B.id, A.id);   // A -> B (B wins)
    executeMerge(db, C.id, B.id);   // B -> C (C wins); B was a winner, now a loser
    // A must be superseded by the LIVE winner C directly, not only by the archived intermediate B.
    const supersedorsOfA = rawIn(A.id).filter(r => r.type === "supersedes").map(r => r.source_id);
    assert.ok(supersedorsOfA.includes(C.id), "A superseded directly by live winner C (chain flattened)");
    assert.notEqual(db.getBlock(C.id)!.status, "archived", "C is the live winner");
    assert.equal(db.getBlock(A.id)!.status, "archived");
    assert.equal(db.getBlock(B.id)!.status, "archived");
  });
});
