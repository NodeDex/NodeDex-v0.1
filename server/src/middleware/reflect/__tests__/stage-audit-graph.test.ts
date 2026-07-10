/**
 * DEBT 5 Slice 2 Sub-step 2.3 — Stage AUDIT graph-health scan tests.
 *
 * Uses a REAL WorkspaceDB so the scan reads actual blocks/relations and writes
 * real pipeline_flags rows. No LLM (AUDIT never calls one).
 *
 * Covers:
 *   - jaccard / sharedConceptCount pure functions
 *   - project_dup_candidate: two project roots, high overlap, no link → flag
 *   - project_dup NOT flagged when a relation already links them
 *   - scope_disagreement: same source_excerpt, different project_id → flag
 *   - island_candidate: ≥N shared concepts, no relation → flag
 *   - island NOT flagged when a relation exists
 *   - idempotency: re-running tick does NOT duplicate flags
 *   - precedence: both-projects pair only gets project_dup (not island)
 *   - pair cap: scanned_pairs respects maxPairsPerTick
 *
 * Run: node --import=tsx/esm --test src/middleware/reflect/__tests__/stage-audit-graph.test.ts
 */
import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import { WorkspaceDB } from "../../../store/database.js";
import { runStageAuditTick, jaccard, sharedConceptCount, sharedEssenceTokens, cosineSim, judgeBlockDupPair, loadAuditOffset, saveAuditOffset, type AuditBlock, type BlockDupJudgeOpts } from "../stage-audit-graph.js";
import { summarizePipelineFlags, getPendingFlags } from "../pipeline-flags.js";

const TEST_DB = path.resolve("/tmp/stage_audit_test.db");
let db: WorkspaceDB;
let raw: Database.Database;

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
});

after(() => {
  try { (db as any)["db"]?.close(); } catch { /* ignore */ }
  cleanFiles();
});

beforeEach(() => {
  raw.pragma("foreign_keys = OFF");
  raw.exec(`DELETE FROM pipeline_flags`);
  raw.exec(`DELETE FROM relations`);
  raw.exec(`DELETE FROM blocks`);
  raw.pragma("foreign_keys = ON");
  for (const k of Object.keys(process.env)) {
    if (k.startsWith("NODEDEX_AUDIT_") || k.startsWith("NODEDEX_BLOCK_DUP_")) delete process.env[k];
  }
});

function mkBlock(label: string, opts: {
  type?: string; concepts?: string[]; project_id?: string; source_excerpt?: string;
  // `value` becomes content.unique.value — the per-type identity field a `fact`
  // uses (PRIMARY_KEYS). scope_disagreement compares THIS across project_id.
  value?: string;
  // `essence` overrides the default — needed by block_dup essence-overlap tests.
  essence?: string;
} = {}) {
  const b = db.createBlock({
    label,
    type: opts.type ?? "fact",
    essence: opts.essence ?? `essence ${label}`,
    content: { unique: { value: opts.value ?? label } },
    concepts: opts.concepts ?? [],
    project_id: opts.project_id,
    source_excerpt: opts.source_excerpt,
    ttl: "permanent",
  });
  return b;
}

// ─── Pure functions ─────────────────────────────────────────────────────────────

describe("jaccard + sharedConceptCount", () => {
  test("jaccard: identical sets = 1, disjoint = 0", () => {
    assert.equal(jaccard(["a", "b"], ["a", "b"]), 1);
    assert.equal(jaccard(["a"], ["b"]), 0);
    assert.equal(jaccard([], []), 0);
  });

  test("jaccard: case-insensitive + partial overlap", () => {
    // {a,b,c} vs {B,c,d}: inter={b,c}=2, union={a,b,c,d}=4 → 0.5
    assert.equal(jaccard(["a", "b", "c"], ["B", "c", "d"]), 0.5);
  });

  test("sharedConceptCount: case-insensitive, dedups", () => {
    assert.equal(sharedConceptCount(["a", "A", "b"], ["a", "b", "x"]), 2);
    assert.equal(sharedConceptCount(["x"], ["y"]), 0);
  });
});

describe("sharedEssenceTokens (step 4 — drifted-fork recall net)", () => {
  test("catches the measured drifted fork that concept-jaccard misses", () => {
    // The exact pair: 0 concept overlap, but essences share coffee+roasting(+home).
    const a = "Home coffee roasting — equipment choices, methods, and constraints.";
    const b = "Activities and considerations related to home coffee roasting.";
    assert.ok(sharedEssenceTokens(a, b) >= 2, "should share >=2 significant tokens");
  });

  test("ignores stopwords + short words (no false pair on 'this/that/with')", () => {
    assert.equal(sharedEssenceTokens("this and that with the", "those and these with the"), 0);
  });

  test("unrelated domains share nothing", () => {
    assert.equal(
      sharedEssenceTokens("Billing decisions for client Acme.", "Home vegetable garden bed layout."),
      0,
    );
  });

  test("same domain, different owner still shares domain tokens (recall; reviewer judges scope)", () => {
    // recall fires; the flag-reviewer is the precision judge that LEAVES on different owner.
    const n = sharedEssenceTokens("Authentication service for Customer A.", "Authentication service for Customer B.");
    assert.ok(n >= 2, "shares 'authentication'+'service'+'customer'");
  });
});

describe("cosineSim (drift recall — embedding similarity)", () => {
  test("identical = 1, orthogonal = 0", () => {
    assert.equal(cosineSim([1, 0, 0], [1, 0, 0]), 1);
    assert.equal(cosineSim([1, 0], [0, 1]), 0);
  });
  test("near-parallel is high; mismatch / empty / zero-vector = 0 (never spurious)", () => {
    assert.ok(cosineSim([1, 1, 0], [1, 1, 0.05]) > 0.99);
    assert.equal(cosineSim([1, 2, 3], [1, 2]), 0);  // length mismatch
    assert.equal(cosineSim([], []), 0);
    assert.equal(cosineSim([0, 0], [0, 0]), 0);      // zero vector
  });
});

// ─── judgeBlockDupPair (the shared pure judge — AUDIT + inline use this ONE impl) ──

describe("judgeBlockDupPair (shared recall judge)", () => {
  const blk = (over: Partial<AuditBlock>): AuditBlock => ({
    id: "x", label: "p_dead_end_x", type: "dead_end",
    concepts: [], project_id: "p1", source_excerpt: null,
    primary_value: "", essence: "", embedding: null, ...over,
  });
  const OPTS: BlockDupJudgeOpts = { claimMin: 3, embedOn: true, embedMin: 0.78, crossMin: 0.80 };

  test("exact primary_value, same scope → candidate (primary_value_exact)", () => {
    const a = blk({ id: "a", primary_value: "fixed window" });
    const b = blk({ id: "b", primary_value: "fixed window" });
    const v = judgeBlockDupPair(a, b, OPTS);
    assert.equal(v.isCandidate, true);
    assert.equal(v.signal, "primary_value_exact");
  });

  test("token-overlap on primary_value → candidate (primary_value_overlap)", () => {
    const a = blk({ id: "a", primary_value: "sliding window log algorithm" });
    const b = blk({ id: "b", primary_value: "sliding window logging algorithm" });
    const v = judgeBlockDupPair(a, b, OPTS);
    assert.equal(v.isCandidate, true);
    assert.equal(v.signal, "primary_value_overlap");
  });

  test("token-overlap across DIFFERENT types → NOT a candidate (same-type gate, 2026-06-15)", () => {
    // Same token overlap as above, but a fact vs a blueprint — different epistemic
    // roles are almost never duplicates. The gate stops the cross-type false-candidate
    // flood on dense single-domain graphs (measured 66→15 on the collapse-e2e graph).
    const a = blk({ id: "a", type: "fact", primary_value: "sliding window log algorithm" });
    const b = blk({ id: "b", type: "blueprint", primary_value: "sliding window logging algorithm" });
    const v = judgeBlockDupPair(a, b, OPTS);
    assert.equal(v.isCandidate, false);
  });

  test("fact↔insight twin at ≥crossMin → candidate (Fix 3b fence — the invisible-twin fix)", () => {
    // The live example: the same finding stored as BOTH a fact and an insight
    // (hard-zero-freezes-tilted, cosine 0.970) — never compared under the same-type gate.
    const a = blk({ id: "a", type: "fact", primary_value: "hard zero freezes tilted blocks", embedding: [1, 1, 0] });
    const b = blk({ id: "b", type: "insight", primary_value: "hardzero freezes tilt", embedding: [1, 1, 0.05] });
    const v = judgeBlockDupPair(a, b, OPTS);
    assert.equal(v.isCandidate, true);
    assert.equal(v.signal, "essence_embedding");
  });

  test("fact↔insight below crossMin → NOT a candidate (the higher bar holds)", () => {
    // cosine([1,0,0],[1,0.9,0]) ≈ 0.743 — above the same-type 0.78? no; and below cross 0.80 either way.
    const a = blk({ id: "a", type: "fact", primary_value: "x", embedding: [1, 0, 0] });
    const b = blk({ id: "b", type: "insight", primary_value: "y", embedding: [1, 0.9, 0] });
    const v = judgeBlockDupPair(a, b, OPTS);
    assert.equal(v.isCandidate, false);
  });

  test("other cross-type pairs stay fenced even at cosine ~1.0 (fence is fact↔insight ONLY)", () => {
    const a = blk({ id: "a", type: "fact", primary_value: "same claim", embedding: [1, 1, 0] });
    const b = blk({ id: "b", type: "decision", primary_value: "same claim reworded", embedding: [1, 1, 0] });
    const v = judgeBlockDupPair(a, b, OPTS);
    assert.equal(v.isCandidate, false, "fact↔decision must not enter via the embedding fence");
  });

  test("same-type in the recalibrated band [0.78, 0.80) → candidate now (catches the labeled clusters)", () => {
    // Exact construction: cos([1,0], [0.79, 0.6131]) = 0.79 — the band the 07-10 audit's
    // paraphrase clusters actually live in (0.79-0.799), invisible under the old 0.80 bar.
    const a = blk({ id: "a", type: "fact", primary_value: "nav cost claim", embedding: [1, 0] });
    const b = blk({ id: "b", type: "fact", primary_value: "navigation cost restated", embedding: [0.79, 0.6131] });
    const v = judgeBlockDupPair(a, b, OPTS);
    assert.equal(v.isCandidate, true, "pairs under the OLD 0.80 bar but over 0.78 must now flag");
    assert.ok(v.embedSim < 0.80 && v.embedSim >= 0.78, `sim ${v.embedSim.toFixed(4)} must sit INSIDE the recalibrated band`);
  });

  test("drift: different wording, same-type, high cosine → candidate (essence_embedding)", () => {
    const a = blk({ id: "a", primary_value: "fixed window", embedding: [1, 1, 0] });
    const b = blk({ id: "b", primary_value: "fixed-window approach", embedding: [1, 1, 0.05] });
    const v = judgeBlockDupPair(a, b, OPTS);
    assert.equal(v.isCandidate, true);
    assert.equal(v.signal, "essence_embedding");
    assert.ok(v.embedSim > 0.99);
  });

  test("different scope → NEVER a candidate (scope is the merge guard)", () => {
    const a = blk({ id: "a", project_id: "p1", primary_value: "fixed window", embedding: [1, 1, 0] });
    const b = blk({ id: "b", project_id: "p2", primary_value: "fixed window", embedding: [1, 1, 0] });
    const v = judgeBlockDupPair(a, b, OPTS);
    assert.equal(v.isCandidate, false);
    assert.equal(v.sameScope, false);
  });

  test("embedding match only counts for SAME type", () => {
    const a = blk({ id: "a", type: "dead_end", primary_value: "fixed window", embedding: [1, 1, 0] });
    const b = blk({ id: "b", type: "fact", primary_value: "windowing", embedding: [1, 1, 0] });
    const v = judgeBlockDupPair(a, b, OPTS);
    assert.equal(v.isCandidate, false);
  });

  test("embed-off → no embedding signal (exact/token only)", () => {
    const a = blk({ id: "a", primary_value: "fixed window", embedding: [1, 1, 0] });
    const b = blk({ id: "b", primary_value: "fixed-window approach", embedding: [1, 1, 0.05] });
    const v = judgeBlockDupPair(a, b, { claimMin: 3, embedOn: false, embedMin: 0.80 });
    assert.equal(v.isCandidate, false);
    assert.equal(v.embedSim, 0);
  });

  test("empty primary_value never exact-matches another empty", () => {
    const a = blk({ id: "a", primary_value: "" });
    const b = blk({ id: "b", primary_value: "" });
    const v = judgeBlockDupPair(a, b, OPTS);
    assert.equal(v.isCandidate, false);
  });
});

// ─── project_dup_candidate ────────────────────────────────────────────────────

describe("project_dup_candidate", () => {
  test("two project roots, high concept overlap, no link → flagged", () => {
    mkBlock("projA", { type: "project", concepts: ["auth", "billing", "api", "rest"] });
    mkBlock("projB", { type: "project", concepts: ["auth", "billing", "api", "graphql"] });
    const res = runStageAuditTick({ db });
    // jaccard({auth,billing,api,rest},{auth,billing,api,graphql}) = 3/5 = 0.6 ≥ 0.6
    assert.equal(res.flags_written.project_dup_candidate, 1);
    const flags = getPendingFlags(raw, { flag_type: "project_dup_candidate" });
    assert.equal(flags.length, 1);
    assert.equal(flags[0]!.origin_writer, "stage_audit_project_dup");
  });

  test("two projects below threshold → NOT flagged", () => {
    mkBlock("lowA", { type: "project", concepts: ["auth", "billing"] });
    mkBlock("lowB", { type: "project", concepts: ["frontend", "ui"] });
    const res = runStageAuditTick({ db });
    assert.equal(res.flags_written.project_dup_candidate, 0);
  });

  test("two projects already linked → NOT flagged", () => {
    const a = mkBlock("linkA", { type: "project", concepts: ["auth", "billing", "api", "rest"] });
    const b = mkBlock("linkB", { type: "project", concepts: ["auth", "billing", "api", "graphql"] });
    db.createRelation({ source_id: a.id, target_id: b.id, type: "relates_to" });
    const res = runStageAuditTick({ db });
    assert.equal(res.flags_written.project_dup_candidate, 0, "existing link suppresses the flag");
  });
});

// ─── scope_disagreement ───────────────────────────────────────────────────────

describe("scope_disagreement (same unique{} identity, different owner)", () => {
  test("same primary_value, different project_id → flagged", () => {
    // Same identity value ("p99 < 50ms") filed under two different owners.
    mkBlock("scopeA", { value: "p99 latency under 50ms", project_id: "proj_x" });
    mkBlock("scopeB", { value: "p99 latency under 50ms", project_id: "proj_y" });
    const res = runStageAuditTick({ db });
    assert.equal(res.flags_written.scope_disagreement, 1);
    const flags = getPendingFlags(raw, { flag_type: "scope_disagreement" });
    assert.equal(flags[0]!.origin_writer, "stage_audit_scope");
    assert.equal(flags[0]!.scope_check, "different");
    assert.equal((flags[0]!.criteria as any).similarity_type, "unique_primary_value");
  });

  test("case-insensitive identity match (normalized) still flags", () => {
    mkBlock("ciA", { value: "P99 Latency Under 50ms", project_id: "proj_x" });
    mkBlock("ciB", { value: "p99 latency under 50ms", project_id: "proj_y" });
    const res = runStageAuditTick({ db });
    assert.equal(res.flags_written.scope_disagreement, 1);
  });

  test("same primary_value, SAME project_id → NOT flagged (no scope conflict)", () => {
    mkBlock("sameA", { value: "shared claim", project_id: "proj_x" });
    mkBlock("sameB", { value: "shared claim", project_id: "proj_x" });
    const res = runStageAuditTick({ db });
    assert.equal(res.flags_written.scope_disagreement, 0);
  });

  test("DIFFERENT primary_value across scopes → NOT flagged (paraphrase is LLM/Stage-D territory, not code)", () => {
    // The JWT/60-min case: same MEANING, different words → different primary_value.
    // Code detector deliberately does NOT catch this (would need semantic compare).
    mkBlock("paraA", { value: "JWT tokens expire after 1 hour", project_id: "proj_x" });
    mkBlock("paraB", { value: "auth tokens expire after 60 minutes", project_id: "proj_y" });
    const res = runStageAuditTick({ db });
    assert.equal(res.flags_written.scope_disagreement, 0,
      "paraphrase-across-owner is not code-catchable — deferred to Stage D / reviewer");
  });

  test("empty primary_value → NOT flagged even across scopes", () => {
    // A block with no extractable unique{} primary value can't be identity-matched.
    mkBlock("emptyA", { value: "", project_id: "proj_x" });
    mkBlock("emptyB", { value: "", project_id: "proj_y" });
    const res = runStageAuditTick({ db });
    assert.equal(res.flags_written.scope_disagreement, 0);
  });
});

// ─── island_candidate ──────────────────────────────────────────────────────────

describe("island_candidate", () => {
  test("≥3 shared concepts, no relation → flagged", () => {
    mkBlock("islA", { concepts: ["litestar", "msgspec", "fastapi", "perf"] });
    mkBlock("islB", { concepts: ["litestar", "msgspec", "fastapi", "migration"] });
    const res = runStageAuditTick({ db });
    assert.equal(res.flags_written.island_candidate, 1);
    const flags = getPendingFlags(raw, { flag_type: "island_candidate" });
    assert.equal(flags[0]!.origin_writer, "stage_audit_islands");
  });

  test("≥3 shared but ALREADY linked → NOT flagged", () => {
    const a = mkBlock("lkIslA", { concepts: ["litestar", "msgspec", "fastapi"] });
    const b = mkBlock("lkIslB", { concepts: ["litestar", "msgspec", "fastapi"] });
    db.createRelation({ source_id: a.id, target_id: b.id, type: "supports" });
    const res = runStageAuditTick({ db });
    assert.equal(res.flags_written.island_candidate, 0);
  });

  test("below shared-min → NOT flagged", () => {
    mkBlock("fewA", { concepts: ["litestar", "x"] });
    mkBlock("fewB", { concepts: ["litestar", "y"] });
    const res = runStageAuditTick({ db });
    assert.equal(res.flags_written.island_candidate, 0);
  });
});

// ─── Precedence + idempotency + cap ─────────────────────────────────────────────

describe("precedence, idempotency, cap", () => {
  test("both-projects pair gets project_dup ONLY, not island", () => {
    // High concept overlap + both projects → should be project_dup, NOT island
    mkBlock("precA", { type: "project", concepts: ["auth", "billing", "api", "rest"] });
    mkBlock("precB", { type: "project", concepts: ["auth", "billing", "api", "graphql"] });
    const res = runStageAuditTick({ db });
    assert.equal(res.flags_written.project_dup_candidate, 1);
    assert.equal(res.flags_written.island_candidate, 0, "both-projects pair must not double-flag as island");
  });

  test("idempotent: second tick writes 0 new flags, counts skips", () => {
    mkBlock("idemA", { concepts: ["litestar", "msgspec", "fastapi", "perf"] });
    mkBlock("idemB", { concepts: ["litestar", "msgspec", "fastapi", "migration"] });
    const first = runStageAuditTick({ db });
    assert.equal(first.flags_written.island_candidate, 1);
    const second = runStageAuditTick({ db });
    assert.equal(second.flags_written.island_candidate, 0, "no new flag on re-scan");
    assert.equal(second.flags_skipped_already_pending, 1, "skip is counted");
    // Total flag count stays 1
    assert.equal(summarizePipelineFlags(raw).total, 1);
  });

  test("idempotent even after the flag was reviewed (no re-spend on known 'leave')", () => {
    mkBlock("revA", { concepts: ["litestar", "msgspec", "fastapi"] });
    mkBlock("revB", { concepts: ["litestar", "msgspec", "fastapi"] });
    runStageAuditTick({ db });
    // Mark the flag reviewed (simulate reviewer verdict='leave')
    raw.exec(`UPDATE pipeline_flags SET reviewed_at = '2026-01-01', review_verdict = 'leave'`);
    const second = runStageAuditTick({ db });
    assert.equal(second.flags_written.island_candidate, 0, "reviewed-leave pair must not be re-flagged");
    assert.equal(second.flags_skipped_already_pending, 1);
  });

  test("pair cap bounds scanned_pairs", () => {
    // 6 blocks = 15 pairs; cap at 5 → scanned_pairs ≤ 5
    for (let i = 0; i < 6; i++) mkBlock(`capB${i}`, { concepts: [`c${i}`] });
    process.env.NODEDEX_AUDIT_MAX_PAIRS = "5";
    const res = runStageAuditTick({ db });
    assert.ok(res.scanned_pairs <= 5, `scanned_pairs=${res.scanned_pairs} must respect cap 5`);
  });

  test("empty graph → no flags, no errors", () => {
    const res = runStageAuditTick({ db });
    assert.equal(res.scanned_pairs, 0);
    assert.equal(res.errors, 0);
    assert.equal(res.flags_written.island_candidate, 0);
  });
});

// ─── Round-robin coverage: next_offset + persisted offset (2026-07-04 fix) ──────
// The old timer advanced the offset +1 per tick (not by pairs covered) AND kept it
// in process memory (reset on restart) — the tail of the block list was never
// scanned on restart-heavy servers, which is how a proven twin-dup pair went
// un-flagged in a 223-block graph. These pin the resume-where-you-stopped contract.

describe("round-robin coverage (next_offset + persisted offset)", () => {
  test("next_offset resumes at the index the cap stopped at; wraps to 0 on a completed sweep", () => {
    for (let i = 0; i < 6; i++) mkBlock(`roB${i}`, { concepts: [`c${i}`] });
    process.env.NODEDEX_AUDIT_MAX_PAIRS = "5";
    const offsets: number[] = [];
    let start = 0;
    for (let t = 0; t < 4; t++) {
      const res = runStageAuditTick({ db, startOffset: start });
      offsets.push(res.next_offset);
      start = res.next_offset;
    }
    // 6 blocks = 15 pairs at cap 5: ticks stop at outer index 1, 2, 4, then the
    // sweep completes and wraps to 0.
    assert.deepEqual(offsets, [1, 2, 4, 0]);
  });

  test("a same-claim pair at the TAIL of insertion order is reached within one full sweep", () => {
    // 8 unscoped fillers first, the twins LAST — the exact shape of the missed dup.
    for (let i = 0; i < 8; i++) mkBlock(`fill${i}`, { value: `unrelated filler claim number ${i} entirely` });
    mkBlock("twinA", { value: "nodedex trades round trips for retrieval precision", project_id: "proj_x" });
    mkBlock("twinB", { value: "nodedex trades round trips for retrieval precision while memory risks errors", project_id: "proj_x" });
    process.env.NODEDEX_AUDIT_MAX_PAIRS = "10"; // 10 blocks = 45 pairs → several ticks
    let start = 0;
    let flagged = 0;
    for (let t = 0; t < 8; t++) {
      const res = runStageAuditTick({ db, startOffset: start });
      flagged += res.flags_written.block_dup_candidate;
      start = res.next_offset;
      if (start === 0) break; // sweep complete
    }
    assert.equal(flagged, 1, "resumed coverage must reach the tail pair (the +1-per-tick crawl never did)");
  });

  test("loadAuditOffset / saveAuditOffset persist in the DB (restart-safe)", () => {
    assert.equal(loadAuditOffset(db), 0, "fresh db → offset 0");
    saveAuditOffset(db, 7);
    assert.equal(loadAuditOffset(db), 7, "saved offset survives (lives in maintenance_state, not module memory)");
    saveAuditOffset(db, 0);
    assert.equal(loadAuditOffset(db), 0);
  });
});

// ─── block_dup_candidate (same-scope near-dup: the recap-restatement gap) ───────

describe("block_dup_candidate (same scope, reworded/cross-type near-dup)", () => {
  test("same primary_value + same scope → flagged (signal includes primary_value)", () => {
    process.env.NODEDEX_BLOCK_DUP_DETECT = "on";
    mkBlock("bdA", { value: "50ms p99 sla all endpoints", project_id: "proj_x" });
    mkBlock("bdB", { value: "50ms p99 sla all endpoints", project_id: "proj_x" });
    const res = runStageAuditTick({ db });
    assert.equal(res.flags_written.block_dup_candidate, 1);
    const flags = getPendingFlags(raw, { flag_type: "block_dup_candidate" });
    assert.equal(flags[0]!.origin_writer, "stage_audit_block_dup");
    assert.equal(flags[0]!.scope_check, "same");
    assert.ok(String((flags[0]!.criteria as any).signal).includes("primary_value"));
  });

  test("claim (primary_value) token-overlap + same scope (DIFFERENT value) → flagged (the reworded case)", () => {
    process.env.NODEDEX_BLOCK_DUP_DETECT = "on";
    // Different value TEXT, same underlying claim → shares >=3 significant CLAIM tokens
    // (fifty/latency/target). The anchor is primary_value, NOT essence.
    mkBlock("essA", { value: "fifty ms latency target pinned by product team", project_id: "proj_x" });
    mkBlock("essB", { value: "fifty ms latency target cannot be relaxed", project_id: "proj_x" });
    const res = runStageAuditTick({ db });
    assert.equal(res.flags_written.block_dup_candidate, 1, "reworded same-scope claim flagged via primary_value overlap");
    const flags = getPendingFlags(raw, { flag_type: "block_dup_candidate" });
    assert.equal((flags[0]!.criteria as any).signal, "primary_value_overlap");
  });

  test("DIFFERENT scope → NOT block_dup (cross-scope is scope_disagreement; never a merge candidate)", () => {
    process.env.NODEDEX_BLOCK_DUP_DETECT = "on";
    mkBlock("dsA", { value: "same claim", project_id: "proj_x" });
    mkBlock("dsB", { value: "same claim", project_id: "proj_y" });
    const res = runStageAuditTick({ db });
    assert.equal(res.flags_written.block_dup_candidate, 0, "cross-scope must NOT be a merge candidate");
    assert.equal(res.flags_written.scope_disagreement, 1, "cross-scope same-identity is scope_disagreement");
  });

  test("supersedes-linked pair → skipped (already a replacement chain)", () => {
    process.env.NODEDEX_BLOCK_DUP_DETECT = "on";
    const a = mkBlock("supA", { value: "fastapi abandoned", project_id: "proj_x" });
    const b = mkBlock("supB", { value: "fastapi abandoned", project_id: "proj_x" });
    db.createRelation({ source_id: a.id, target_id: b.id, type: "supersedes" });
    const res = runStageAuditTick({ db });
    assert.equal(res.flags_written.block_dup_candidate, 0, "supersedes chain already collapsed — don't re-flag");
  });

  test("supports-linked pair → STILL flagged (a supports edge is NOT a dedup)", () => {
    process.env.NODEDEX_BLOCK_DUP_DETECT = "on";
    const a = mkBlock("spA", { value: "50ms sla", project_id: "proj_x" });
    const b = mkBlock("spB", { value: "50ms sla", project_id: "proj_x" });
    db.createRelation({ source_id: a.id, target_id: b.id, type: "supports" });
    const res = runStageAuditTick({ db });
    assert.equal(res.flags_written.block_dup_candidate, 1, "same-claim blocks linked by supports are still an un-merged dup");
  });

  test("low CLAIM overlap + same scope → NOT flagged (distinct same-topic facts)", () => {
    process.env.NODEDEX_BLOCK_DUP_DETECT = "on";
    // Same project/topic but DIFFERENT claims → 0 shared claim tokens. Even though
    // their essences would share topic words, the claim anchor keeps them apart.
    mkBlock("loA", { value: "pydantic validation dominates write cost", project_id: "proj_x" });
    mkBlock("loB", { value: "litestar provides msgspec serialization", project_id: "proj_x" });
    const res = runStageAuditTick({ db });
    assert.equal(res.flags_written.block_dup_candidate, 0, "distinct same-topic facts must not be flagged");
  });

  test("default (unset) → ON: an obvious dup IS flagged (self-maintenance locked-on 2026-06-20)", () => {
    // NODEDEX_BLOCK_DUP_DETECT unset (cleared by beforeEach) → now default ON.
    mkBlock("defA", { value: "identical claim", project_id: "proj_x" });
    mkBlock("defB", { value: "identical claim", project_id: "proj_x" });
    const res = runStageAuditTick({ db });
    assert.equal(res.flags_written.block_dup_candidate, 1, "detector is locked-on by default");
  });

  test("gate =off (explicit) → no block_dup flags even for an obvious dup (the dev/test off-switch)", () => {
    process.env.NODEDEX_BLOCK_DUP_DETECT = "off";
    mkBlock("offA", { value: "identical claim", project_id: "proj_x" });
    mkBlock("offB", { value: "identical claim", project_id: "proj_x" });
    const res = runStageAuditTick({ db });
    assert.equal(res.flags_written.block_dup_candidate, 0, "the =off switch still silences the detector");
  });

  test("idempotent: second tick writes 0 new block_dup flags, counts the skip", () => {
    process.env.NODEDEX_BLOCK_DUP_DETECT = "on";
    mkBlock("idA", { value: "dup claim", project_id: "proj_x" });
    mkBlock("idB", { value: "dup claim", project_id: "proj_x" });
    const first = runStageAuditTick({ db });
    assert.equal(first.flags_written.block_dup_candidate, 1);
    const second = runStageAuditTick({ db });
    assert.equal(second.flags_written.block_dup_candidate, 0);
    assert.equal(second.flags_skipped_already_pending, 1);
  });
});
