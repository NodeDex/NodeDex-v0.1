import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { WorkspaceDB } from "../../store/database.js";
import { assembleBlockChains } from "../helpers.js";

// assembleBlockChains is the "surface the chain AND its linked path" fold behind
// workspace_get(detail=relations|full): { chains (the block's own arcs), linked_chains
// (the connected component reachable by a causal path, distance-ranked) }. It reads
// member_of (overlap-aware), not the lossy chain_id column. These tests lock the contract.

const TEST_DB = path.resolve("/tmp/assemble_block_chains_test.db");
let db: WorkspaceDB;

function cleanFiles() {
  for (const s of ["", "-wal", "-shm"]) {
    try { if (fs.existsSync(TEST_DB + s)) fs.unlinkSync(TEST_DB + s); } catch { /* ignore */ }
  }
}

// Make a chain block + wire `members` into it (chain_id column + member_of).
function makeChain(label: string, arc: string, conclusion: string, members: Array<{ id: string }>) {
  const chain = db.createBlock({
    label, type: "chain", essence: `${conclusion} arc`,
    content: { is_a: "chain", unique: { arc, conclusion } },
  });
  for (const m of members) {
    db.updateBlock(m.id, { chain_id: chain.id });
    db.createRelation({ source_id: m.id, target_id: chain.id, type: "member_of" });
  }
  return chain;
}

before(async () => {
  cleanFiles();
  db = new WorkspaceDB(TEST_DB);
  await db.init();
});
after(() => { try { (db as any)["db"]?.close(); } catch { /* ignore */ } cleanFiles(); });

describe("assembleBlockChains — own chains", () => {
  test("a member block returns its named chain with arc, conclusion, and ordered members", () => {
    const de = db.createBlock({ label: "p_dead_end_caching", type: "dead_end", essence: "caching rejected" });
    const dec = db.createBlock({ label: "p_decision_dataloader", type: "decision", essence: "dataloader chosen" });
    makeChain("p_chain_memory-scaling", "dead_end -> decision", "batched dataloader", [de, dec]);

    const out = assembleBlockChains(db, de);
    assert.equal(out.chains.length, 1, "member belongs to exactly one chain");
    const c = out.chains[0]!;
    assert.equal(c.label, "p_chain_memory-scaling");
    assert.equal(c.arc, "dead_end -> decision");
    assert.equal(c.conclusion, "batched dataloader");
    assert.deepEqual(c.members.map((m) => m.type), ["dead_end", "decision"], "members ordered cause-first");
    assert.ok(c.members.every((m) => m.essence && m.essence.length > 0), "each member carries its essence (whole arc readable in one get)");
    assert.deepEqual(out.linked_chains, [], "isolated chain has no linked path");
  });

  test("a HINGE block (member_of two chains) returns BOTH — the column alone would lose one", () => {
    const hinge = db.createBlock({ label: "p_fact_p99-after-fix", type: "fact", essence: "p99 800ms" });
    const tail  = db.createBlock({ label: "p_decision_next", type: "decision", essence: "next step" });
    makeChain("p_chain_n+1-fix", "fact -> fact", "n+1 fixed", [hinge]);          // sets column → this one
    makeChain("p_chain_type-mismatch", "fact -> decision", "type fixed", [hinge, tail]); // column overwritten

    const out = assembleBlockChains(db, hinge);
    assert.equal(out.chains.length, 2, "hinge surfaces both chains, not just the column's one");
    assert.deepEqual(out.chains.map((c) => c.label).sort(), ["p_chain_n+1-fix", "p_chain_type-mismatch"]);
  });

  test("a chain block itself surfaces its own arc (its members)", () => {
    const a = db.createBlock({ label: "p_fact_a", type: "fact", essence: "a" });
    const b = db.createBlock({ label: "p_insight_b", type: "insight", essence: "b" });
    const chain = makeChain("p_chain_self", "fact -> insight", "realized b", [a, b]);

    const out = assembleBlockChains(db, chain);
    assert.equal(out.chains.length, 1);
    assert.equal(out.chains[0]!.label, "p_chain_self");
    assert.deepEqual(out.chains[0]!.members.map((m) => m.label).sort(), ["p_fact_a", "p_insight_b"]);
  });

  test("a block on no chain returns empty for both", () => {
    const loner = db.createBlock({ label: "p_fact_orphan", type: "fact", essence: "alone" });
    assert.deepEqual(assembleBlockChains(db, loner), { chains: [], linked_chains: [] });
  });
});

describe("assembleBlockChains — linked_chains (connected component)", () => {
  test("a directly-bridged chain surfaces in linked_chains at distance 1, with the via relation", () => {
    const fix = db.createBlock({ label: "lk_decision_fix", type: "decision", essence: "the fix" });
    const problem = db.createBlock({ label: "lk_fact_problem", type: "fact", essence: "the problem the fix caused" });
    makeChain("lk_chain_fix", "decision", "fix shipped", [fix]);
    makeChain("lk_chain_problem", "fact", "problem found", [problem]);
    // the problem was triggered BY the fix: problem --prompted_by--> fix (a causal bridge)
    db.createRelation({ source_id: problem.id, target_id: fix.id, type: "prompted_by" });

    const fromFix = assembleBlockChains(db, fix).linked_chains;
    const lp = fromFix.find((l) => l.chain === "lk_chain_problem")!;
    assert.ok(lp, "the problem chain is on the fix's linked path");
    assert.equal(lp.distance, 1);
    assert.equal(lp.via, "prompted_by");
    assert.ok(!fromFix.some((l) => l.chain === "lk_chain_fix"), "the block's OWN chain is not in linked_chains");
  });

  test("a chain TWO hops away surfaces (the whole linked path, not just 1 hop)", () => {
    // X — Y — Z, with NO direct X↔Z edge. Anchored in X, both Y (1) and Z (2) must appear.
    const x = db.createBlock({ label: "h_fact_x", type: "fact", essence: "x" });
    const y = db.createBlock({ label: "h_fact_y", type: "fact", essence: "y" });
    const z = db.createBlock({ label: "h_fact_z", type: "fact", essence: "z" });
    makeChain("h_chain_x", "fact", "x done", [x]);
    makeChain("h_chain_y", "fact", "y done", [y]);
    makeChain("h_chain_z", "fact", "z done", [z]);
    db.createRelation({ source_id: y.id, target_id: x.id, type: "prompted_by" }); // X — Y
    db.createRelation({ source_id: z.id, target_id: y.id, type: "prompted_by" }); // Y — Z

    const linked = assembleBlockChains(db, x).linked_chains;
    const byChain = new Map(linked.map((l) => [l.chain, l.distance]));
    assert.equal(byChain.get("h_chain_y"), 1, "Y is one hop from X");
    assert.equal(byChain.get("h_chain_z"), 2, "Z is two hops — 1-hop would have MISSED it");
  });

  test("linked_chains are distance-ranked (nearest first)", () => {
    const linked = assembleBlockChains(db, db.getBlock("h_fact_x")!).linked_chains;
    for (let i = 1; i < linked.length; i++) {
      assert.ok(linked[i]!.distance >= linked[i - 1]!.distance, "non-decreasing distance");
    }
  });
});
