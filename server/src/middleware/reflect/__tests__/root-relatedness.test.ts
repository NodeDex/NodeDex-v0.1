import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { classifyRootRelatedness, type MinBlock, type RootEdge } from "../root-relatedness.js";

describe("classifyRootRelatedness", () => {
  const blocks: MinBlock[] = [
    { id: "rA", label: "alpha", type: "project", project_id: null },
    { id: "rB", label: "beta", type: "project", project_id: null },
    { id: "rC", label: "gamma", type: "project", project_id: null },
    { id: "a1", label: "alpha_x", type: "decision", project_id: "rA" },
    { id: "a2", label: "alpha_y", type: "fact", project_id: "rA" },
    { id: "b1", label: "beta_x", type: "constraint", project_id: "rB" },
    { id: "c1", label: "gamma_x", type: "decision", project_id: "rC" },
  ];

  test("classifies cross-root edges BY MEANING, excludes grouping, finds the parent", () => {
    const edges: RootEdge[] = [
      { source_id: "a1", target_id: "b1", type: "based_on" },    // dependency — a-side depends on b
      { source_id: "a2", target_id: "b1", type: "prompted_by" }, // dependency — a-side depends on b
      { source_id: "a1", target_id: "b1", type: "supersedes" },  // evolution
      { source_id: "a2", target_id: "b1", type: "member_of" },   // EXCLUDED (chain grouping)
      { source_id: "a1", target_id: "b1", type: "related_to" },  // loose
    ];
    const r = classifyRootRelatedness(blocks, edges);
    assert.equal(r.pairs.length, 1);
    const p = r.pairs[0]!;
    assert.equal(p.root_a, "alpha");
    assert.equal(p.root_b, "beta");
    assert.equal(p.categories.dependency, 2);
    assert.equal(p.categories.evolution, 1);
    assert.equal(p.categories.loose, 1);
    assert.equal(p.categories.containment, undefined);
    assert.equal(p.parent, "beta"); // both subordinating edges point INTO rB
    assert.deepEqual(r.standalone, ["gamma"]); // rC has no cross-root edge
  });

  test("grouping + provenance types are NOT topic relatedness (excluded)", () => {
    const r = classifyRootRelatedness(blocks, [
      { source_id: "a1", target_id: "b1", type: "member_of" },
      { source_id: "a1", target_id: "b1", type: "extracted_from" },
      { source_id: "a1", target_id: "b1", type: "describes" },
    ]);
    assert.equal(r.pairs.length, 0);
    assert.equal(r.standalone.length, 3);
  });

  test("same-root edges are ignored — only CROSS-root counts", () => {
    const r = classifyRootRelatedness(blocks, [
      { source_id: "a1", target_id: "a2", type: "based_on" }, // both under rA
    ]);
    assert.equal(r.pairs.length, 0);
  });

  test("part_of is containment and sets direction (child→parent)", () => {
    const r = classifyRootRelatedness(blocks, [
      { source_id: "a1", target_id: "b1", type: "part_of" }, // rA's member part_of rB's → rB parent
    ]);
    assert.equal(r.pairs[0]!.categories.containment, 1);
    assert.equal(r.pairs[0]!.parent, "beta");
  });
});
