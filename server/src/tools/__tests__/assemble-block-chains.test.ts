import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { WorkspaceDB } from "../../store/database.js";
import { assembleBlockChains, assembleFullThread } from "../helpers.js";

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

describe("assembleBlockChains — own arc is the COMPUTED sign (materialized chain no longer read)", () => {
  test("a block's own arc is the live computed sign, NOT the stale Pass-5 chain", () => {
    // Wire BOTH a spine edge (the live truth) and a materialized Pass-5 chain (stale).
    // The read must return the computed sign, ignoring the materialized layer.
    const a = db.createBlock({ label: "sw_event_a", type: "event", essence: "a happened" });
    const b = db.createBlock({ label: "sw_dead_end_b", type: "dead_end", essence: "b was rejected" });
    db.createRelation({ source_id: b.id, target_id: a.id, type: "based_on" }); // spine: b rests on a
    makeChain("sw_chain_stale", "a -> b", "a STALE conclusion", [a, b]);        // also materialized

    const c = assembleBlockChains(db, b).chains[0]!;
    assert.ok(c, "the own arc surfaces");
    assert.equal(c.mechanical, true, "it's the live computed sign");
    assert.equal(c.label, null, "not the materialized chain block's label");
    assert.notEqual(c.conclusion, "a STALE conclusion", "does NOT read the stale Pass-5 conclusion");
  });

  test("a block on ONLY a materialized chain (no spine edge) no longer surfaces an arc", () => {
    // member_of without any spine edge = the old stamped-once layer. With the read switched
    // to computed, there's no live thread, so no arc (it's reachable via the chain block).
    const x = db.createBlock({ label: "sw_fact_x", type: "fact", essence: "x" });
    makeChain("sw_chain_orphan", "x", "x concluded", [x]);
    assert.deepEqual(assembleBlockChains(db, x).chains, [], "no spine thread → computed arc is empty");
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

  test("a truly standalone block (no causal edges) returns empty for both", () => {
    const loner = db.createBlock({ label: "p_fact_orphan", type: "fact", essence: "alone" });
    assert.deepEqual(assembleBlockChains(db, loner), { chains: [], linked_chains: [] });
  });
});

describe("assembleBlockChains — the mechanical SIGN (spine walk, no materialized chain)", () => {
  test("a linear thread collapses plain steps and shows origin → conclusion", () => {
    // event → fact → dead_end via based_on. No chain block. The plain `fact` step collapses.
    const ev = db.createBlock({ label: "m_event_test-ran", type: "event", essence: "the test ran" });
    const ft = db.createBlock({ label: "m_fact_null-result", type: "fact", essence: "result was null at scale" });
    const de = db.createBlock({ label: "m_dead_end_claim-rejected", type: "dead_end", essence: "the claim is rejected" });
    db.createRelation({ source_id: ft.id, target_id: ev.id, type: "based_on" }); // fact rests on event
    db.createRelation({ source_id: de.id, target_id: ft.id, type: "based_on" }); // dead_end rests on fact

    const c = assembleBlockChains(db, de).chains[0]!;
    assert.ok(c, "the thread surfaces even with no chain block");
    assert.equal(c.label, null);
    assert.equal(c.mechanical, true);
    // origin (event) + leaf (dead_end); the mid `fact` step is COLLAPSED (not a waypoint type).
    assert.deepEqual(c.members.map((m) => m.type), ["event", "dead_end"], "plain fact step collapsed; waypoints ordered cause-first");
    assert.equal(c.conclusion, "the claim is rejected", "conclusion = the leaf");
    assert.ok(!c.forked, "single destination → not forked");
  });

  test("a forked thread surfaces every destination, ranked, with fork + grounding tags", () => {
    // ev → (fact) → decision → { dead_end , blueprint }  — decision is the fork.
    const ev  = db.createBlock({ label: "f_event_ran", type: "event", essence: "experiment ran" });
    const ft  = db.createBlock({ label: "f_fact_data", type: "fact", essence: "the data came back" });
    const dec = db.createBlock({ label: "f_decision_pick", type: "decision", essence: "chose approach X" });
    const de  = db.createBlock({ label: "f_dead_end_wall", type: "dead_end", essence: "approach X hit a wall" });
    const bp  = db.createBlock({ label: "f_blueprint_plan", type: "blueprint", essence: "revised plan from X" });
    const sf  = db.createBlock({ label: "f_fact_evidence", type: "fact", essence: "a supporting measurement" });
    db.createRelation({ source_id: ft.id,  target_id: ev.id,  type: "based_on" });
    db.createRelation({ source_id: dec.id, target_id: ft.id,  type: "based_on" });
    db.createRelation({ source_id: de.id,  target_id: dec.id, type: "based_on" }); // branch 1
    db.createRelation({ source_id: bp.id,  target_id: dec.id, type: "based_on" }); // branch 2 → FORK
    db.createRelation({ source_id: sf.id,  target_id: dec.id, type: "supports" }); // GROUNDING, not a step

    const c = assembleBlockChains(db, dec).chains[0]!;
    assert.ok(c, "the forked thread surfaces");
    assert.equal(c.forked, true, "two destinations → forked");
    const leadTypes = (c.leads_to ?? []).map((l) => l.type);
    assert.deepEqual(leadTypes, ["dead_end", "blueprint"], "destinations ranked: dead_end (weight 5) before blueprint (4)");
    assert.equal(c.backed_by, 1, "the supports edge is counted as a grounding tag, not walked as a step");
    // members = the upstream lineage (origin + focal); the plain `fact` step collapses;
    // the two DOWNSTREAM leaves live in leads_to, not dumped into members (bounded sign).
    assert.deepEqual(c.members.map((m) => m.type), ["event", "decision"], "members = came-from lineage, not every branch waypoint");
  });
});

describe("assembleBlockChains — linked_chains (Mode 3, computed: non-spine bridges)", () => {
  test("a thread bridged to ANOTHER by a grounding edge surfaces as a linked thread", () => {
    // Thread A: a1 based_on a2 (spine). Thread B: b1 based_on b2 (spine).
    // Bridge: a1 --supports--> b1 (grounding, cross-thread) — NOT spine, so B stays a separate thread.
    const a2 = db.createBlock({ label: "lk_fact_a2", type: "fact", essence: "a2 evidence" });
    const a1 = db.createBlock({ label: "lk_decision_a1", type: "decision", essence: "a1 decided" });
    const b2 = db.createBlock({ label: "lk_fact_b2", type: "fact", essence: "b2 evidence" });
    const b1 = db.createBlock({ label: "lk_blueprint_b1", type: "blueprint", essence: "b1 planned" });
    db.createRelation({ source_id: a1.id, target_id: a2.id, type: "based_on" }); // thread A
    db.createRelation({ source_id: b1.id, target_id: b2.id, type: "based_on" }); // thread B
    db.createRelation({ source_id: a1.id, target_id: b1.id, type: "supports" }); // CROSS-THREAD bridge

    const linked = assembleBlockChains(db, a1).linked_chains;
    const lp = linked.find((l) => l.via === "supports")!;
    assert.ok(lp, "thread B surfaces as a linked thread via the grounding bridge");
    assert.equal(lp.distance, 1);
    assert.equal(lp.chain, "lk_blueprint_b1", "hop handle = the linked thread's conclusion (blueprint > fact)");
    assert.ok(!linked.some((l) => ["lk_decision_a1", "lk_fact_a2"].includes(l.chain)), "the block's OWN thread is not linked");
  });

  test("spine-connected blocks are the SAME thread, not a linked one", () => {
    // x based_on y is a SPINE edge → x and y are one thread; nothing linked.
    const y = db.createBlock({ label: "lk_fact_y", type: "fact", essence: "y" });
    const x = db.createBlock({ label: "lk_decision_x", type: "decision", essence: "x" });
    db.createRelation({ source_id: x.id, target_id: y.id, type: "based_on" });

    const out = assembleBlockChains(db, x);
    assert.ok(out.chains[0]!.members.some((m) => m.label === "lk_fact_y"), "y is in x's OWN thread (spine-connected)");
    assert.deepEqual(out.linked_chains, [], "no non-spine bridge → nothing linked");
  });
});

describe("assembleFullThread — Mode 2 (the whole thread in one call)", () => {
  test("returns EVERY member spine-ordered with role + grounding, uncollapsed", () => {
    // ev → ft → dec → { de , bp } ; sf supports dec (grounding).
    const ev  = db.createBlock({ label: "t_event_ran", type: "event", essence: "ran" });
    const ft  = db.createBlock({ label: "t_fact_data", type: "fact", essence: "data" });
    const dec = db.createBlock({ label: "t_decision_pick", type: "decision", essence: "picked X" });
    const de  = db.createBlock({ label: "t_dead_end_wall", type: "dead_end", essence: "wall" });
    const bp  = db.createBlock({ label: "t_blueprint_plan", type: "blueprint", essence: "plan" });
    const sf  = db.createBlock({ label: "t_fact_evidence", type: "fact", essence: "evidence" });
    db.createRelation({ source_id: ft.id,  target_id: ev.id,  type: "based_on" });
    db.createRelation({ source_id: dec.id, target_id: ft.id,  type: "based_on" });
    db.createRelation({ source_id: de.id,  target_id: dec.id, type: "based_on" });
    db.createRelation({ source_id: bp.id,  target_id: dec.id, type: "based_on" });
    db.createRelation({ source_id: sf.id,  target_id: dec.id, type: "supports" });

    const t = assembleFullThread(db, dec.id)!;
    assert.ok(t, "the thread assembles");
    assert.equal(t.count, 5, "ALL members (incl. the plain fact step) — not collapsed like the sign");
    assert.equal(t.focal, "t_decision_pick");
    // spine-ordered cause→effect: ev, ft, dec, then the two leaves.
    assert.deepEqual(t.members.slice(0, 3).map((m) => m.type), ["event", "fact", "decision"], "cause-first order");
    const roleOf = new Map(t.members.map((m) => [m.label, m.role]));
    assert.equal(roleOf.get("t_event_ran"), "origin");
    assert.equal(roleOf.get("t_decision_pick"), "focal");
    assert.equal(roleOf.get("t_dead_end_wall"), "leaf");
    assert.deepEqual(t.origins, ["t_event_ran"]);
    assert.deepEqual(t.leaves.sort(), ["t_blueprint_plan", "t_dead_end_wall"]);
    const decMember = t.members.find((m) => m.label === "t_decision_pick")!;
    assert.equal(decMember.backed_by, 1, "the supports edge tags the decision (grounding), sf itself is off-spine");
    assert.ok(!t.members.some((m) => m.label === "t_fact_evidence"), "grounding block is NOT a thread member");
  });

  test("a standalone block has no thread", () => {
    const lone = db.createBlock({ label: "t_fact_lone", type: "fact", essence: "alone" });
    assert.equal(assembleFullThread(db, lone.id), null);
  });
});
