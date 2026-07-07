import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { assembleMechanicalChains } from "../pass5-mechanical.js";

const B = (id: string, type: string, essence: string) => ({ id, label: `proj_${type}_${id}`, type, essence });

describe("assembleMechanicalChains — deterministic Pass-5 replacement", () => {
  test("a cluster ending in a committed conclusion (decision) becomes a chain", () => {
    const blocks = [B("ev", "event", "the test ran"), B("ft", "fact", "result was null"), B("dec", "decision", "chose approach X")];
    const rels = [
      { source_id: "ft", target_id: "ev", type: "based_on" }, // fact rests on event
      { source_id: "dec", target_id: "ft", type: "based_on" }, // decision rests on fact
    ];
    const { chains } = assembleMechanicalChains(blocks, rels);
    assert.equal(chains.length, 1, "one cluster → one chain");
    const c = chains[0]!;
    assert.deepEqual(c.members, ["proj_event_ev", "proj_fact_ft", "proj_decision_dec"], "cause-first order");
    assert.equal(c.arc, "event → fact → decision");
    assert.equal(c.conclusion, "chose approach X", "conclusion = the terminal decision's essence");
    assert.ok(c.chain_label.startsWith("proj_chain_"), "labelled {project}_chain_{concept}");
    assert.ok(c.reasoning.includes("decision"), "reasoning names the terminus type");
  });

  test("a cluster with NO committed-conclusion sink (ends in a blueprint) is NOT a chain", () => {
    // Pass 5's rule: a blueprint is planned-not-concluded → not a committed conclusion.
    const blocks = [B("ev", "event", "ran"), B("bp", "blueprint", "a plan")];
    const rels = [{ source_id: "bp", target_id: "ev", type: "based_on" }];
    assert.deepEqual(assembleMechanicalChains(blocks, rels).chains, [], "open arc → no chain (matches Pass 5 selectivity)");
  });

  test("fewer than 2 blocks or no relations → no chains", () => {
    assert.deepEqual(assembleMechanicalChains([B("a", "fact", "x")], []).chains, []);
    assert.deepEqual(assembleMechanicalChains([B("a", "fact", "x"), B("b", "decision", "y")], []).chains, []);
  });

  test("grounding (supports) joins the cluster but the arc is ordered on the spine", () => {
    // evidence --supports--> dead_end ; dead_end based_on fact ; fact based_on event
    const blocks = [B("ev", "event", "ran"), B("ft", "fact", "data"), B("de", "dead_end", "rejected"), B("sf", "fact", "evidence")];
    const rels = [
      { source_id: "ft", target_id: "ev", type: "based_on" },
      { source_id: "de", target_id: "ft", type: "based_on" },
      { source_id: "sf", target_id: "de", type: "supports" }, // grounding pulls sf into the component
    ];
    const { chains } = assembleMechanicalChains(blocks, rels);
    assert.equal(chains.length, 1, "the supports edge keeps the cluster together");
    assert.equal(chains[0]!.conclusion, "rejected", "terminus is the dead_end (a committed conclusion), not the evidence");
  });
});
