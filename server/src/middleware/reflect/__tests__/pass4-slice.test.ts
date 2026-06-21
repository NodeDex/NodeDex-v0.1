// Pass 4 slice builder — DB-backed tests.
// Run: node --import=tsx/esm --test src/middleware/reflect/__tests__/pass4-slice.test.ts
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { WorkspaceDB, type Block } from "../../../store/database.js";
import { buildPass4Slice, pass4SliceMinGraph } from "../pass4-slice.js";

const TEST_DB = path.resolve("/tmp/pass4_slice_test.db");

let db: WorkspaceDB;

// Root ids + a couple of member handles we assert against.
let alpha!: Block, beta!: Block, gamma!: Block;
let chainBlk!: Block, member1!: Block, member2!: Block, loose!: Block, betaM!: Block, gammaM!: Block;

before(async () => {
  for (const suffix of ["", "-wal", "-shm"]) {
    try { if (fs.existsSync(TEST_DB + suffix)) fs.unlinkSync(TEST_DB + suffix); } catch { /* ignore */ }
  }
  db = new WorkspaceDB(TEST_DB);
  await db.init();

  // ── roots ──
  alpha = db.createBlock({ label: "alpha", type: "project", essence: "Alpha project", content: {}, ttl: "permanent" });
  beta  = db.createBlock({ label: "beta",  type: "project", essence: "Beta project",  content: {}, ttl: "permanent" });
  gamma = db.createBlock({ label: "gamma", type: "project", essence: "Gamma project", content: {}, ttl: "permanent" });

  // ── alpha: a chain (chain block + 2 members carrying its id) + one loose block ──
  chainBlk = db.createBlock({ label: "alpha_chain_db-arc", type: "chain", essence: "DB choice arc", content: { is_a: "chain" }, ttl: "permanent", status: "active" });
  member1 = db.createBlock({ label: "alpha_decision_use-x", type: "decision", essence: "Chose X", content: { unique: { choice: "Use X" } }, ttl: "permanent", status: "active", project_id: alpha.id });
  member2 = db.createBlock({ label: "alpha_fact_x-perf", type: "fact", essence: "X is fast", content: { unique: { value: "X is fast" } }, ttl: "permanent", status: "active", project_id: alpha.id });
  loose   = db.createBlock({ label: "alpha_constraint_no-vendor", type: "constraint", essence: "No vendor lock", content: { unique: { limit: "no vendor lock" } }, ttl: "permanent", status: "active", project_id: alpha.id });
  // members carry chain_id = the chain block's id (canonical convention)
  db.updateBlock(member1.id, { chain_id: chainBlk.id });
  db.updateBlock(member2.id, { chain_id: chainBlk.id });

  // ── beta: one member, RELATED to alpha via a recorded cross-root edge ──
  betaM = db.createBlock({ label: "beta_decision_use-redis", type: "decision", essence: "Chose Redis", content: { unique: { choice: "Use Redis" } }, ttl: "permanent", status: "active", project_id: beta.id });
  db.createRelation({ source_id: member1.id, target_id: betaM.id, type: "based_on" }); // alpha ↔ beta overlap

  // ── gamma: one member with NO edge to alpha — reachable ONLY via the similarity net ──
  gammaM = db.createBlock({ label: "gamma_decision_use-postgres", type: "decision", essence: "Use PostgreSQL for storage", content: { unique: { choice: "Use PostgreSQL" } }, concepts: ["postgres"], ttl: "permanent", status: "active", project_id: gamma.id });
});

after(() => {
  try { (db as any)["db"]?.close(); } catch { /* ignore */ }
  for (const suffix of ["", "-wal", "-shm"]) {
    try { if (fs.existsSync(TEST_DB + suffix)) fs.unlinkSync(TEST_DB + suffix); } catch { /* ignore */ }
  }
});

describe("buildPass4Slice", () => {
  test("empty newBlocks → empty slice", () => {
    const { context, reflectedIds } = buildPass4Slice(db, []);
    assert.equal(context, "");
    assert.equal(reflectedIds.length, 0);
  });

  test("FOLLOW TRUTH: surfaces own-root + edge-related-root members, excludes unrelated roots", () => {
    const newBlk = db.createBlock({ label: "alpha_decision_add-cache", type: "decision", essence: "Add a cache layer", content: { unique: { choice: "Add cache layer" } }, ttl: "permanent", project_id: alpha.id });
    const { context, reflectedIds } = buildPass4Slice(db, [newBlk]);

    // own root (alpha) members present
    assert.ok(context.includes("alpha_decision_use-x"), "alpha member1 should be surfaced");
    assert.ok(context.includes("alpha_constraint_no-vendor"), "alpha loose block should be surfaced");
    // edge-related root (beta) member present — FOLLOW TRUTH across the Venn overlap
    assert.ok(context.includes("beta_decision_use-redis"), "beta member should be surfaced via the cross-root edge");
    // unrelated root (gamma) absent — identity doesn't match, no edge → not dumped
    assert.ok(!context.includes("gamma_decision_use-postgres"), "gamma must NOT be surfaced (no edge, no identity match)");

    // coarse → fine: chain header (arc essence) with its members under it
    assert.ok(context.includes("DB choice arc"), "chain essence (the arc) should head the chain group");
    assert.ok(/CHAIN .*alpha_chain_db-arc/.test(context), "chain block label should appear as the unit header");
    // loose section present
    assert.ok(context.includes("[loose blocks]"), "loose blocks section should be present");

    // reflectedIds = surfaced existing blocks; excludes the new block and the roots
    assert.ok(reflectedIds.includes(member1.id));
    assert.ok(reflectedIds.includes(betaM.id));
    assert.ok(!reflectedIds.includes(newBlk.id), "new block must not be reflected against itself");
    assert.ok(!reflectedIds.includes(alpha.id), "project roots are not candidates");
    assert.ok(!reflectedIds.includes(gammaM.id), "unrelated-root block not surfaced");
  });

  test("GUESS net: a first-ever match in a non-overlapping root is surfaced by identity", () => {
    // New block whose identity (unique.choice) matches gammaM, but gamma shares NO
    // edge with alpha → only the similarity net can reach it.
    const newBlk = db.createBlock({ label: "alpha_decision_db-pick", type: "decision", essence: "Pick the database", content: { unique: { choice: "Use PostgreSQL" } }, concepts: ["postgres"], ttl: "permanent", project_id: alpha.id });
    const { context } = buildPass4Slice(db, [newBlk]);
    assert.ok(context.includes("gamma_decision_use-postgres"), "the net should surface the identity-matching block in the non-overlapping root");
  });

  test("min-graph threshold default is sane", () => {
    assert.ok(pass4SliceMinGraph() >= 1);
  });

  test("SEMANTIC DELTA: surfaces a drift block (diff unique, near embedding) that identity+structure missed", () => {
    // Unrelated root, DIFFERENT unique wording (identity net misses), but an
    // embedding ~parallel to the new block's → only the semantic delta can reach it.
    const driftRoot = db.createBlock({ label: "driftproj", type: "project", essence: "unrelated project", content: {}, ttl: "permanent", status: "active" });
    const drift = db.createBlock({ label: "driftproj_decision_teardown", type: "decision", essence: "tear down the stale request on unmount", content: { unique: { choice: "tear down request on unmount" } }, ttl: "permanent", status: "active", project_id: driftRoot.id, embedding: [1, 0, 0, 0] });
    const newBlk = db.createBlock({ label: "alpha_decision_cancel-fetch", type: "decision", essence: "cancel in-flight fetch", content: { unique: { choice: "use abortcontroller to cancel fetch" } }, ttl: "permanent", status: "active", project_id: alpha.id, embedding: [0.99, 0.01, 0, 0] });

    process.env.NODEDEX_PASS4_SEMANTIC_DELTA = "1";
    const on = buildPass4Slice(db, [newBlk]);
    delete process.env.NODEDEX_PASS4_SEMANTIC_DELTA;
    const off = buildPass4Slice(db, [newBlk]);

    assert.ok(on.context.includes("driftproj_decision_teardown"), "delta ON should surface the meaning-near drift block");
    assert.ok(on.context.includes("UNCONFIRMED"), "drift block sits under the UNCONFIRMED section");
    assert.ok(on.reflectedIds.includes(drift.id), "delta block included in reflectedIds");
    assert.ok(!off.context.includes("driftproj_decision_teardown"), "delta OFF: identity+structure miss it → absent");
  });

  test("SEMANTIC DELTA: respects the K cap", () => {
    // Two more unrelated-root blocks with near embeddings → ≥2 delta candidates.
    const r2 = db.createBlock({ label: "driftproj2", type: "project", essence: "unrelated 2", content: {}, ttl: "permanent", status: "active" });
    db.createBlock({ label: "driftproj2_decision_x", type: "decision", essence: "discard the pending call", content: { unique: { choice: "discard pending call" } }, ttl: "permanent", status: "active", project_id: r2.id, embedding: [0.97, 0.03, 0, 0] });
    const newBlk = db.createBlock({ label: "alpha_decision_cancel2", type: "decision", essence: "cancel fetch v2", content: { unique: { choice: "cancel fetch v2 differently" } }, ttl: "permanent", status: "active", project_id: alpha.id, embedding: [0.98, 0.02, 0, 0] });

    process.env.NODEDEX_PASS4_SEMANTIC_DELTA = "1";
    process.env.NODEDEX_PASS4_SEMANTIC_DELTA_K = "1";
    const res = buildPass4Slice(db, [newBlk]);
    delete process.env.NODEDEX_PASS4_SEMANTIC_DELTA;
    delete process.env.NODEDEX_PASS4_SEMANTIC_DELTA_K;

    const deltaLines = res.context.split("\n").filter((l) => /\(sim [0-9.]+\)/.test(l));
    assert.equal(deltaLines.length, 1, `K=1 must cap delta to exactly 1, got ${deltaLines.length}`);
  });
});
