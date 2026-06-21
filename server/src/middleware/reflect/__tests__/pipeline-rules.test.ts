/**
 * Reflect pipeline — deterministic rule tests.
 * These rules run after each Gemini pass. They are pure functions with no
 * API calls, no DB, no file I/O.
 *
 * Run: node --import=tsx/esm --test src/middleware/reflect/__tests__/pipeline-rules.test.ts
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  prePopulateExtendsItem,
  stampTypeOverrides,
  isDuplicateLabel,
  isKnownProject,
  isValidLabelSegmentCount,
  dedupIdenticalEssenceTwins,
  dedupIdenticalUniqueValues,
  activatePendingBlocks,
  resolveProjectParent,
  normalizeMultiWordTypeInLabel,
  computeNextTurnNumber,
} from "../pipeline.js";
import { applyJudgeVerdicts, type PassJudgeResult } from "../pass_judge.js";
import type { Pass1Item, Pass2Item } from "../types.js";

// ─────────────────────────────────────────────────────────────────────────────
// prePopulateExtendsItem
// Rule: if Pass 1 set extends_id on an item but Pass 2 left extends_item blank,
// copy extends_id → extends_item.
// ─────────────────────────────────────────────────────────────────────────────

describe("prePopulateExtendsItem", () => {
  test("copies extends_id from Pass 1 when Pass 2 left extends_item blank", () => {
    const pass1: Pass1Item[] = [
      { id: "p1_mechanism", text: "How the DB replication works", source: "agent", excerpt: "", provisional_type: "fact", extends_id: "p1_decision" },
      { id: "p1_decision",  text: "We chose async replication",  source: "agent", excerpt: "", provisional_type: "decision" },
    ];
    const pass2: Pass2Item[] = [
      { id: "p1_mechanism", text: "How the DB replication works", type: "fact",     triggered_by_items: [], based_on_items: [] },
      { id: "p1_decision",  text: "We chose async replication",  type: "decision", triggered_by_items: [], based_on_items: [] },
    ];

    prePopulateExtendsItem(pass1, pass2);

    assert.equal(pass2[0].extends_item, "p1_decision", "mechanism item should extend the decision");
    assert.equal(pass2[1].extends_item, undefined, "decision has no extends_id, should stay blank");
  });

  test("does NOT overwrite extends_item when Pass 2 already set it", () => {
    const pass1: Pass1Item[] = [
      { id: "item_a", text: "...", source: "agent", excerpt: "", provisional_type: "fact", extends_id: "item_b" },
    ];
    const pass2: Pass2Item[] = [
      { id: "item_a", text: "...", type: "fact", triggered_by_items: [], based_on_items: [], extends_item: "item_c" },
    ];

    prePopulateExtendsItem(pass1, pass2);

    // Pass 2's own judgment should be preserved
    assert.equal(pass2[0].extends_item, "item_c", "Pass 2 value must not be overwritten");
  });

  test("no-op when Pass 1 item has no extends_id", () => {
    const pass1: Pass1Item[] = [
      { id: "standalone", text: "We adopted Redis", source: "agent", excerpt: "", provisional_type: "decision" },
    ];
    const pass2: Pass2Item[] = [
      { id: "standalone", text: "We adopted Redis", type: "decision", triggered_by_items: [], based_on_items: [] },
    ];

    prePopulateExtendsItem(pass1, pass2);

    assert.equal(pass2[0].extends_item, undefined);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// stampTypeOverrides
// Rule (seam contract enforcement): if Pass 2 changed an item's type from
// Pass 1's provisional_type but didn't set review_reason, code-stamp
// "type_override". Never overwrites an existing review_reason. Pure structural
// check — enum compare, no language interpretation.
// ─────────────────────────────────────────────────────────────────────────────

describe("stampTypeOverrides", () => {
  test("stamps type_override when Pass 2 changed the type and review_reason is empty", () => {
    const pass1: Pass1Item[] = [
      { id: "i1", text: "t", source: "agent", excerpt: "", provisional_type: "fact" },
    ];
    const pass2: Pass2Item[] = [
      { id: "i1", text: "t", type: "insight", triggered_by_items: [], based_on_items: [] },
    ];

    const stamped = stampTypeOverrides(pass1, pass2);

    assert.equal(stamped, 1);
    assert.equal(pass2[0].review_reason, "type_override");
  });

  test("does NOT stamp when Pass 2 kept the same type", () => {
    const pass1: Pass1Item[] = [
      { id: "i1", text: "t", source: "agent", excerpt: "", provisional_type: "fact" },
    ];
    const pass2: Pass2Item[] = [
      { id: "i1", text: "t", type: "fact", triggered_by_items: [], based_on_items: [] },
    ];

    const stamped = stampTypeOverrides(pass1, pass2);

    assert.equal(stamped, 0);
    assert.equal(pass2[0].review_reason, undefined);
  });

  test("does NOT overwrite an existing review_reason", () => {
    const pass1: Pass1Item[] = [
      { id: "i1", text: "t", source: "agent", excerpt: "", provisional_type: "fact" },
    ];
    const pass2: Pass2Item[] = [
      { id: "i1", text: "t", type: "insight", triggered_by_items: [], based_on_items: [], review_reason: "graph_align" },
    ];

    const stamped = stampTypeOverrides(pass1, pass2);

    assert.equal(stamped, 0, "should not count an item with existing reason");
    assert.equal(pass2[0].review_reason, "graph_align", "existing reason must be preserved");
  });

  test("no-op when the Pass 1 item is missing for this id (Pass 2 synthesized item)", () => {
    const pass1: Pass1Item[] = [];
    const pass2: Pass2Item[] = [
      { id: "synthesized", text: "t", type: "fact", triggered_by_items: [], based_on_items: [] },
    ];

    const stamped = stampTypeOverrides(pass1, pass2);

    assert.equal(stamped, 0);
    assert.equal(pass2[0].review_reason, undefined);
  });

  test("counts and stamps multiple changed items in one batch", () => {
    const pass1: Pass1Item[] = [
      { id: "a", text: "ta", source: "agent", excerpt: "", provisional_type: "fact" },
      { id: "b", text: "tb", source: "agent", excerpt: "", provisional_type: "fact" },
      { id: "c", text: "tc", source: "agent", excerpt: "", provisional_type: "decision" },
    ];
    const pass2: Pass2Item[] = [
      { id: "a", text: "ta", type: "insight",    triggered_by_items: [], based_on_items: [] },  // changed
      { id: "b", text: "tb", type: "hypothesis", triggered_by_items: [], based_on_items: [] },  // changed
      { id: "c", text: "tc", type: "decision",   triggered_by_items: [], based_on_items: [] },  // kept
    ];

    const stamped = stampTypeOverrides(pass1, pass2);

    assert.equal(stamped, 2);
    assert.equal(pass2[0].review_reason, "type_override");
    assert.equal(pass2[1].review_reason, "type_override");
    assert.equal(pass2[2].review_reason, undefined);
  });

  test("empty Pass 1 + empty Pass 2 = no-op", () => {
    assert.equal(stampTypeOverrides([], []), 0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// isDuplicateLabel
// Rule: if a block with the exact same label already exists, skip it.
// ─────────────────────────────────────────────────────────────────────────────

describe("isDuplicateLabel", () => {
  const existing = [
    { label: "beacon_decision_use-timescale" },
    { label: "beacon_constraint_hipaa-phi-encryption" },
    { label: "orion_dead_end_redis-cluster" },
  ];

  test("returns true when label already exists", () => {
    assert.ok(isDuplicateLabel("beacon_decision_use-timescale", existing));
  });

  test("returns false when label is new", () => {
    assert.ok(!isDuplicateLabel("beacon_decision_new-thing", existing));
  });

  test("is case-sensitive — different case is not a duplicate", () => {
    assert.ok(!isDuplicateLabel("Beacon_Decision_Use-Timescale", existing));
  });

  test("returns false on empty block list", () => {
    assert.ok(!isDuplicateLabel("anything", []));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// isKnownProject
// Rule: a block is only saved if its project prefix is a known project root.
// New roots declared in project_creates[] this batch count as known too.
// ─────────────────────────────────────────────────────────────────────────────

describe("isKnownProject", () => {
  const known  = new Set(["beacon", "orion", "atlas"]);
  const newlyCreated = new Set(["nova"]);

  test("accepts a block whose project exists in knownProjects", () => {
    assert.ok(isKnownProject("beacon", known, new Set()));
  });

  test("accepts a project declared in this batch (newProjectLabels)", () => {
    assert.ok(isKnownProject("nova", known, newlyCreated));
  });

  test("rejects a block whose project is completely unknown", () => {
    assert.ok(!isKnownProject("phantom", known, newlyCreated));
  });

  test("rejects an empty string project", () => {
    assert.ok(!isKnownProject("", known, newlyCreated));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// isValidLabelSegmentCount
// Rule: labels with > 4 underscore-separated segments are rejected unless a
// compound block type (e.g. "dead_end") accounts for the
// extra segment.
// ─────────────────────────────────────────────────────────────────────────────

describe("isValidLabelSegmentCount", () => {
  const blockTypes = new Set([
    "fact", "decision", "constraint", "dead_end", "blueprint",
    "entity", "project", "task",
  ]);

  test("3-segment label is valid", () => {
    assert.ok(isValidLabelSegmentCount("beacon_decision_use-timescale", blockTypes));
  });

  test("4-segment label is valid", () => {
    assert.ok(isValidLabelSegmentCount("beacon_api_decision_rest-endpoints", blockTypes));
  });

  test("5-segment label with compound type (dead_end) is valid", () => {
    // beacon_api_dead_end_redis-spof → segs[1..2] = "api_dead" ✗, segs[2..3] = "dead_end" ✓
    assert.ok(isValidLabelSegmentCount("beacon_api_dead_end_redis-spof", blockTypes));
  });

  test("5-segment plain label (no compound type) is rejected", () => {
    assert.ok(!isValidLabelSegmentCount("beacon_api_decision_rest_endpoints", blockTypes));
  });

  test("6-segment label is always rejected (no compound type spans that far)", () => {
    assert.ok(!isValidLabelSegmentCount("a_b_c_d_e_f", blockTypes));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// resolveProjectParent (Bug 3 fix, 2026-05-28)
// Rule: default `parent` for project_creates[] items to scope_project when the
// LLM left it unset — code does the structurally-determined work, not the LLM.
// Charter rule 3.
// ─────────────────────────────────────────────────────────────────────────────

describe("resolveProjectParent", () => {
  test("defaults parent to scope_project for a non-scope sub-project", () => {
    const result = resolveProjectParent(
      { label: "bosch-powerpack" },
      "ebike-battery-replacement",
    );
    assert.equal(result, "ebike-battery-replacement",
      "sub-project should auto-nest under scope when pass3 omits parent");
  });

  test("does NOT self-parent the scope project itself", () => {
    const result = resolveProjectParent(
      { label: "ebike-battery-replacement" },
      "ebike-battery-replacement",
    );
    assert.equal(result, undefined,
      "scope project must not become its own parent");
  });

  test("respects explicit parent from Pass 3 over the scope default", () => {
    const result = resolveProjectParent(
      { label: "child", parent: "explicit-parent" },
      "scope-would-have-been-here",
    );
    assert.equal(result, "explicit-parent",
      "LLM-set parent must not be overridden");
  });

  test("returns undefined when no scope and no explicit parent", () => {
    const result = resolveProjectParent({ label: "lonely-project" }, undefined);
    assert.equal(result, undefined,
      "no scope + no explicit parent = top-level project");
  });

  test("explicit parent wins even when it matches the scope label", () => {
    // Edge case: pass3 could legitimately echo the scope as parent — still respect it.
    const result = resolveProjectParent(
      { label: "child", parent: "the-scope" },
      "the-scope",
    );
    assert.equal(result, "the-scope");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// normalizeMultiWordTypeInLabel (Bug 2 fix, 2026-05-28)
// Rule: replace the multi-word type's underscore form (`dead_end`) with its
// canonical hyphenated form (`dead-end`) when it appears as the type segment
// of a label. Pure, idempotent, only matches anchored type-segment positions.
// ─────────────────────────────────────────────────────────────────────────────

describe("normalizeMultiWordTypeInLabel", () => {
  const multi = new Set(["dead_end", "code_review"]);

  test("rewrites underscore-form type in a 3-segment label", () => {
    assert.equal(
      normalizeMultiWordTypeInLabel("garden_dead_end_aphid-treatment", multi),
      "garden_dead-end_aphid-treatment",
    );
  });

  test("rewrites underscore-form type in a 4-segment label (with entity)", () => {
    assert.equal(
      normalizeMultiWordTypeInLabel("backup_nas_dead_end_synology-failed", multi),
      "backup_nas_dead-end_synology-failed",
    );
  });

  test("is idempotent — canonical hyphenated form is unchanged", () => {
    const canonical = "garden_dead-end_aphid-treatment";
    assert.equal(normalizeMultiWordTypeInLabel(canonical, multi), canonical);
    assert.equal(normalizeMultiWordTypeInLabel(normalizeMultiWordTypeInLabel(canonical, multi), multi), canonical);
  });

  test("normalizes a custom multi-word type similarly", () => {
    assert.equal(
      normalizeMultiWordTypeInLabel("rl_code_review_intro-flow", multi),
      "rl_code-review_intro-flow",
    );
  });

  test("doesn't touch a label that has no multi-word type segment", () => {
    assert.equal(
      normalizeMultiWordTypeInLabel("garden_decision_use-neem-oil", multi),
      "garden_decision_use-neem-oil",
    );
  });

  test("doesn't touch a single-word type that coincidentally contains 'end'", () => {
    // No `_dead_end_` anchor → leave alone.
    assert.equal(
      normalizeMultiWordTypeInLabel("project_fact_back-end-pattern", multi),
      "project_fact_back-end-pattern",
    );
  });

  test("handles end-of-label position (no trailing concept)", () => {
    // Rare but defensive — a label that ends in the type segment.
    assert.equal(
      normalizeMultiWordTypeInLabel("garden_aphids_dead_end", multi),
      "garden_aphids_dead-end",
    );
  });

  test("safe on empty/null/non-string input", () => {
    assert.equal(normalizeMultiWordTypeInLabel("", multi), "");
    assert.equal(normalizeMultiWordTypeInLabel(null as any, multi), null);
    assert.equal(normalizeMultiWordTypeInLabel(undefined as any, multi), undefined);
  });

  test("empty multi-word type set is a no-op", () => {
    const empty = new Set<string>();
    assert.equal(
      normalizeMultiWordTypeInLabel("garden_dead_end_x", empty),
      "garden_dead_end_x",
    );
  });

  test("single-word types in the set are skipped (no underscore to find)", () => {
    const noisy = new Set(["dead_end", "fact", "decision"]);
    assert.equal(
      normalizeMultiWordTypeInLabel("garden_dead_end_x", noisy),
      "garden_dead-end_x",
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// dedupIdenticalEssenceTwins
// Rule: collapse classified items with byte-identical normalized text but
// different type (the structurally-determined slice of cross-type dedup).
// Conservative on role-splits (any causal edge between the twins → keep both).
// ─────────────────────────────────────────────────────────────────────────────

describe("dedupIdenticalEssenceTwins", () => {
  const mk = (id: string, type: string, text: string, extras: Partial<Pass2Item> = {}): Pass2Item => ({
    id, type, text,
    triggered_by_items: extras.triggered_by_items ?? [],
    based_on_items: extras.based_on_items ?? [],
    ...extras,
  });

  test("collapses identical-text fact+constraint twin → keeps constraint (more-specific role)", () => {
    const items = [
      mk("item_1", "fact",       "Stricter return policies could hurt legitimate returns and customer satisfaction."),
      mk("item_2", "constraint", "Stricter return policies could hurt legitimate returns and customer satisfaction."),
    ];
    const { kept, dropped } = dedupIdenticalEssenceTwins(items);
    assert.equal(kept.length, 1);
    assert.equal(kept[0].id, "item_2");
    assert.equal(kept[0].type, "constraint");
    assert.equal(dropped.length, 1);
    assert.equal(dropped[0].id, "item_1");
    assert.equal(dropped[0].mergedInto, "item_2");
  });

  test("normalization handles case and whitespace differences", () => {
    const items = [
      mk("a", "fact",       "  Same  CLAIM. "),
      mk("b", "constraint", "same claim."),
    ];
    const { kept, dropped } = dedupIdenticalEssenceTwins(items);
    assert.equal(kept.length, 1);
    assert.equal(dropped.length, 1);
  });

  test("same-type duplicates are NOT touched (that is Pass 2 STEP I's job)", () => {
    const items = [
      mk("a", "fact", "same text"),
      mk("b", "fact", "same text"),
    ];
    const { kept, dropped } = dedupIdenticalEssenceTwins(items);
    assert.equal(kept.length, 2);
    assert.equal(dropped.length, 0);
  });

  test("identical text + internal edge between twins → STILL collapse (identical text rules out a real role-split; edge is vestigial)", () => {
    // The empirical Pass 2 case: model emits `fact X` and `constraint X` with identical text and
    // wires `constraint based_on fact`. The edge is self-referential redundancy, not a role-split
    // (a real role-split has different content). Collapse + strip the now-self edge.
    const items = [
      mk("item_1", "fact",       "same text"),
      mk("item_2", "constraint", "same text", { based_on_items: ["item_1"] }),
    ];
    const { kept, dropped } = dedupIdenticalEssenceTwins(items);
    assert.equal(kept.length, 1);
    assert.equal(dropped.length, 1);
    // The constraint had causal wiring (based_on_items) so it wins on the wiring-beats-type rule
    assert.equal(kept[0].id, "item_2");
    // The vestigial self-reference (item_2 based_on item_2 after rewire) must be stripped
    assert.deepEqual(kept[0].based_on_items, []);
  });

  test("self-references that emerge from merge are stripped", () => {
    // item_3 already references item_2; item_1 (the dropped twin) was also referenced by item_3.
    // After merge, the rewired ref equals item_3's own id → must be stripped.
    const items = [
      mk("item_1", "fact",       "X"),
      mk("item_2", "constraint", "X"),
      mk("item_3", "insight",    "Y", { based_on_items: ["item_1", "item_3"] }),
    ];
    const { kept } = dedupIdenticalEssenceTwins(items);
    const item3 = kept.find(i => i.id === "item_3")!;
    assert.deepEqual(item3.based_on_items, ["item_2"]); // item_1 → item_2; the item_3 self-ref dropped
  });

  test("extends_item self-ref from merge is stripped (garden-blight fact+constraint twin)", () => {
    // Empirical garden case: Pass 1 emits `fact X` + `constraint X` (identical text), constraint
    // extends_item → the fact. Twin collapses, constraint wins, fact dropped. The constraint's
    // extends_item now points at the deleted fact (== its own id after merge) → must be stripped,
    // else it dangles → spurious extends_item_unresolved skip downstream.
    const items = [
      mk("item_12", "fact",       "once blight hits, it's nearly impossible to stop"),
      mk("item_13", "constraint", "once blight hits, it's nearly impossible to stop", { extends_item: "item_12" }),
    ];
    const { kept, dropped } = dedupIdenticalEssenceTwins(items);
    assert.equal(kept.length, 1);
    assert.equal(dropped.length, 1);
    assert.equal(kept[0].id, "item_13");
    assert.equal(kept[0].extends_item, undefined, "self-referential extends_item must be stripped, not left dangling");
  });

  test("extends_item pointing at a dropped twin is rewired to the winner", () => {
    const items = [
      mk("item_1", "fact",       "X"),
      mk("item_2", "constraint", "X"),
      mk("item_3", "insight",    "Y", { extends_item: "item_1" }), // extends the loser
    ];
    const { kept } = dedupIdenticalEssenceTwins(items);
    const item3 = kept.find(i => i.id === "item_3")!;
    assert.equal(item3.extends_item, "item_2", "extends_item rewired loser → winner");
  });

  test("non-twins are untouched (different text → different groups)", () => {
    const items = [
      mk("a", "fact",       "claim A"),
      mk("b", "constraint", "claim B"),
    ];
    const { kept } = dedupIdenticalEssenceTwins(items);
    assert.equal(kept.length, 2);
  });

  test("rewires cross-references: a third item pointing at the dropped twin is rewired to the winner", () => {
    const items = [
      mk("item_1", "fact",       "X"),
      mk("item_2", "constraint", "X"),
      mk("item_3", "insight",    "Y", { based_on_items: ["item_1"] }), // refs the loser
    ];
    const { kept } = dedupIdenticalEssenceTwins(items);
    assert.equal(kept.length, 2);
    const item3 = kept.find(i => i.id === "item_3")!;
    assert.deepEqual(item3.based_on_items, ["item_2"]); // rewired loser → winner
  });

  test("winner pick: causal wiring beats type preference", () => {
    // A fact WITH wiring should win over a constraint WITHOUT wiring
    const items = [
      mk("a", "fact",       "X", { triggered_by_items: ["other"] }),
      mk("b", "constraint", "X"),
    ];
    const { kept } = dedupIdenticalEssenceTwins(items);
    assert.equal(kept.length, 1);
    assert.equal(kept[0].id, "a");
  });

  test("empty / no-text items are ignored (no false grouping on empty string)", () => {
    const items = [
      mk("a", "fact",       ""),
      mk("b", "constraint", ""),
    ];
    const { kept, dropped } = dedupIdenticalEssenceTwins(items);
    assert.equal(kept.length, 2);
    assert.equal(dropped.length, 0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// dedupIdenticalUniqueValues (Tier 1C)
// Rule: a block's identity is its content.unique{} values, not its essence text.
// Collapse items whose normalized unique{} value-SET is identical (field names
// ignored), cross-type OR same-type. Never touch fragments (different values).
// Winner = schema-valid block (Tier 1B) → wired → non-fact → lowest id.
// ─────────────────────────────────────────────────────────────────────────────

describe("dedupIdenticalUniqueValues", () => {
  const mk = (
    id: string,
    type: string,
    unique: Record<string, string>,
    wiring: { triggered_by_items?: string[]; based_on_items?: string[] } = {},
  ): Pass2Item => ({
    id, text: `${type} ${id}`, type, unique,
    triggered_by_items: wiring.triggered_by_items || [],
    based_on_items: wiring.based_on_items || [],
  });

  test("CROSS-TYPE: Chalice as decision{value,reason} + dead_end{approach,reason} → collapse, dead_end wins (schema-valid)", () => {
    const items = [
      mk("c_dec", "decision", { value: "Chalice", reason: "OpenAPI story is weak" }),       // wrong shape for decision
      mk("c_de",  "dead_end", { approach: "Chalice", reason: "OpenAPI story is weak" }),     // valid shape for dead_end
    ];
    const { kept, dropped } = dedupIdenticalUniqueValues(items);
    assert.equal(kept.length, 1, "the two Chalice items collapse to one");
    assert.equal(dropped.length, 1);
    assert.equal(kept[0].id, "c_de", "schema-valid dead_end is the winner, not the mis-typed decision");
    assert.equal(dropped[0].id, "c_dec");
    assert.match(dropped[0].reason, /cross-type/);
  });

  test("SAME-TYPE PARAPHRASE: two decisions with identical choice value → collapse", () => {
    const items = [
      mk("d1", "decision", { choice: "FastAPI + Mangum" }),
      mk("d2", "decision", { choice: "fastapi + mangum" }), // differs only by case → normalized identical
    ];
    const { kept, dropped } = dedupIdenticalUniqueValues(items);
    assert.equal(kept.length, 1);
    assert.equal(dropped.length, 1);
    assert.match(dropped[0].reason, /same-type paraphrase/);
  });

  test("FRAGMENTATION: different unique{} values are NOT collapsed", () => {
    // Two preferences capturing different axes of one user's overall preference.
    const items = [
      mk("p1", "preference", { lean: "TypeScript over Python", condition: "for backend services" }),
      mk("p2", "preference", { lean: "single laptop setup", condition: "for development" }),
    ];
    const { kept, dropped } = dedupIdenticalUniqueValues(items);
    assert.equal(kept.length, 2, "different value-sets → distinct atomic claims, never merged");
    assert.equal(dropped.length, 0);
  });

  test("field-name independence: {value,reason} vs {approach,reason} with same VALUES collapse", () => {
    // The whole point: field names differ, values match → same claim.
    const items = [
      mk("a", "fact",     { value: "Backblaze $70/year" }),
      mk("b", "decision", { choice: "Backblaze $70/year" }),
    ];
    const { kept, dropped } = dedupIdenticalUniqueValues(items);
    assert.equal(kept.length, 1, "same value under different field names → collapse");
    assert.equal(dropped.length, 1);
  });

  test("extends_item pointing at a dropped twin is rewired to the surviving winner", () => {
    // Same root fix as the essence-twin path: a surviving item whose extends_item referenced the
    // dropped twin must follow the merge to the winner (not dangle → extends_item_unresolved).
    const items: Pass2Item[] = [
      mk("u1", "fact",     { value: "Backblaze $70/year" }),
      mk("u2", "decision", { choice: "Backblaze $70/year" }),
      { ...mk("u3", "insight", { observation: "unrelated", implication: "also unrelated" }), extends_item: "u1" },
    ];
    const { kept } = dedupIdenticalUniqueValues(items);
    const winner = kept.find(i => i.id === "u1" || i.id === "u2")!; // whichever twin survived
    const u3 = kept.find(i => i.id === "u3")!;
    assert.equal(u3.extends_item, winner.id, "extends_item rewired from dropped twin → surviving winner");
  });

  test("winner: wired beats unwired when both schema-valid (or both invalid)", () => {
    const items = [
      mk("unwired", "decision", { choice: "Kafka" }),
      mk("wired",   "decision", { choice: "Kafka" }, { based_on_items: ["some_fact"] }),
    ];
    const { kept } = dedupIdenticalUniqueValues(items);
    assert.equal(kept.length, 1);
    assert.equal(kept[0].id, "wired", "the item with causal wiring survives");
  });

  test("rewires references: a third item pointing at the dropped twin is repointed to the winner", () => {
    const items = [
      mk("c_dec", "decision", { value: "Chalice", reason: "weak" }),                  // will be dropped (invalid shape)
      mk("c_de",  "dead_end", { approach: "Chalice", reason: "weak" }),               // winner (valid shape)
      mk("downstream", "decision", { choice: "FastAPI" }, { based_on_items: ["c_dec"] }),
    ];
    const { kept } = dedupIdenticalUniqueValues(items);
    const downstream = kept.find(i => i.id === "downstream");
    assert.ok(downstream);
    assert.deepEqual(downstream!.based_on_items, ["c_de"], "reference rewired from dropped c_dec to winner c_de");
  });

  test("empty unique{} (project/process) is never grouped", () => {
    const items = [
      mk("proj1", "project", {}),
      mk("proc1", "process", {}),
      mk("proj2", "project", {}),
    ];
    const { kept, dropped } = dedupIdenticalUniqueValues(items);
    assert.equal(kept.length, 3, "empty value-sets do not collapse together");
    assert.equal(dropped.length, 0);
  });

  test("no twins → all kept, nothing dropped", () => {
    const items = [
      mk("a", "decision", { choice: "Postgres" }),
      mk("b", "dead_end", { approach: "MySQL", reason: "no JSONB" }),
    ];
    const { kept, dropped } = dedupIdenticalUniqueValues(items);
    assert.equal(kept.length, 2);
    assert.equal(dropped.length, 0);
  });

  test("three-way collapse: three items same value-set → 1 kept, 2 dropped, both repointed", () => {
    const items = [
      mk("x1", "fact",       { value: "8s cold start" }),
      mk("x2", "metric",     { value: "8s cold start" }),     // metric needs `definition` → invalid shape here
      mk("x3", "constraint", { value: "8s cold start" }),     // constraint needs `limit` → invalid shape here
    ];
    const { kept, dropped } = dedupIdenticalUniqueValues(items);
    assert.equal(kept.length, 1);
    assert.equal(dropped.length, 2);
    for (const d of dropped) assert.equal(d.mergedInto, kept[0].id);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// applyJudgeVerdicts (PASS JUDGE ref-cleanup)
// Rule: apply per-item verdicts from JUDGE; if a kept item references a dropped
// item via extends_id (the only intra-batch ref Pass 1 carries), override the
// drop and keep the parent — never lose an anchor of something we're keeping.
// ─────────────────────────────────────────────────────────────────────────────

describe("applyJudgeVerdicts", () => {
  const mkPass1 = (id: string, type: string, text: string, extends_id?: string): Pass1Item => ({
    id, text, source: "output", excerpt: text.slice(0, 80), provisional_type: type, extends_id,
  });
  const mkVerdict = (id: string, verdict: "KEEP" | "DROP", reason_category: string): any =>
    ({ item_id: id, verdict, reason_category });

  test("null judge result → pass-through (all items kept, no drops)", () => {
    const items = [mkPass1("item_1", "fact", "x"), mkPass1("item_2", "decision", "y")];
    const r = applyJudgeVerdicts(items, null);
    assert.equal(r.kept.length, 2);
    assert.equal(r.dropped.length, 0);
    assert.equal(r.anchorOverrides.length, 0);
  });

  test("all KEEP → nothing dropped", () => {
    const items = [mkPass1("a", "fact", "x"), mkPass1("b", "decision", "y")];
    const judge: PassJudgeResult = {
      verdicts: [mkVerdict("a", "KEEP", "path_specific_residue"), mkVerdict("b", "KEEP", "path_specific_residue")],
    };
    const r = applyJudgeVerdicts(items, judge);
    assert.equal(r.kept.length, 2);
    assert.equal(r.dropped.length, 0);
  });

  test("all DROP → kept set is empty", () => {
    const items = [mkPass1("a", "fact", "x"), mkPass1("b", "fact", "y")];
    const judge: PassJudgeResult = {
      verdicts: [mkVerdict("a", "DROP", "general_knowledge"), mkVerdict("b", "DROP", "general_knowledge")],
    };
    const r = applyJudgeVerdicts(items, judge);
    assert.equal(r.kept.length, 0);
    assert.equal(r.dropped.length, 2);
  });

  test("mixed verdicts → kept and dropped split correctly", () => {
    const items = [
      mkPass1("a", "fact", "general"),
      mkPass1("b", "decision", "specific"),
      mkPass1("c", "fact", "general too"),
    ];
    const judge: PassJudgeResult = {
      verdicts: [
        mkVerdict("a", "DROP", "general_knowledge"),
        mkVerdict("b", "KEEP", "path_specific_residue"),
        mkVerdict("c", "DROP", "general_knowledge"),
      ],
    };
    const r = applyJudgeVerdicts(items, judge);
    assert.equal(r.kept.length, 1);
    assert.equal(r.kept[0].id, "b");
    assert.equal(r.dropped.length, 2);
  });

  test("anchor override: kept item extends a dropped item → drop is reversed (parent kept too)", () => {
    // item_5 extends item_3 (i.e. item_5 is meaningless without item_3).
    // Judge drops item_3 but keeps item_5 → asymmetric cost says keep item_3 too.
    const items = [
      mkPass1("item_3", "fact", "anchor"),
      mkPass1("item_5", "fact", "detail", "item_3"),
    ];
    const judge: PassJudgeResult = {
      verdicts: [
        mkVerdict("item_3", "DROP", "general_knowledge"),
        mkVerdict("item_5", "KEEP", "path_specific_residue"),
      ],
    };
    const r = applyJudgeVerdicts(items, judge);
    assert.equal(r.kept.length, 2);
    assert.deepEqual(r.kept.map(i => i.id).sort(), ["item_3", "item_5"]);
    assert.equal(r.dropped.length, 0, "the drop is reversed, so dropped[] is empty");
    assert.deepEqual(r.anchorOverrides, ["item_3"]);
  });

  test("cascade drop allowed: when BOTH child and parent are DROP, no override needed", () => {
    const items = [
      mkPass1("p", "fact", "parent"),
      mkPass1("c", "fact", "child", "p"),
    ];
    const judge: PassJudgeResult = {
      verdicts: [mkVerdict("p", "DROP", "general_knowledge"), mkVerdict("c", "DROP", "general_knowledge")],
    };
    const r = applyJudgeVerdicts(items, judge);
    assert.equal(r.kept.length, 0);
    assert.equal(r.dropped.length, 2);
    assert.equal(r.anchorOverrides.length, 0);
  });

  test("multiple kept items extending the same dropped parent → ONE override", () => {
    const items = [
      mkPass1("anchor", "fact", "x"),
      mkPass1("c1", "fact", "child1", "anchor"),
      mkPass1("c2", "fact", "child2", "anchor"),
    ];
    const judge: PassJudgeResult = {
      verdicts: [
        mkVerdict("anchor", "DROP", "general_knowledge"),
        mkVerdict("c1", "KEEP", "path_specific_residue"),
        mkVerdict("c2", "KEEP", "path_specific_residue"),
      ],
    };
    const r = applyJudgeVerdicts(items, judge);
    assert.equal(r.kept.length, 3, "anchor saved by either child");
    assert.equal(r.anchorOverrides.length, 1);
    assert.equal(r.anchorOverrides[0], "anchor");
  });

  test("items missing from judge verdicts → defaulted to KEEP (defensive)", () => {
    const items = [mkPass1("a", "fact", "x"), mkPass1("b", "fact", "y")];
    const judge: PassJudgeResult = { verdicts: [mkVerdict("a", "DROP", "general_knowledge")] };
    const r = applyJudgeVerdicts(items, judge);
    assert.equal(r.kept.length, 1);
    assert.equal(r.kept[0].id, "b", "b had no verdict — defaulted to keep, never silently dropped");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// activatePendingBlocks — the activate-pending race guard
// Rule: commit this turn's pending blocks to 'active', but NEVER resurrect one
// that a same-turn supersede archived in the interim (database.ts:981).
// Regression for the 5-turn deep-test T5 race (2026-05-26): a decision created
// AND superseded in one turn must stay archived, not be re-activated.
// ─────────────────────────────────────────────────────────────────────────────

describe("activatePendingBlocks", () => {
  // Minimal in-memory db: a status map + getBlock/updateBlock over it.
  function mockDb(initial: Record<string, string>) {
    const status = { ...initial };
    return {
      status,
      getBlock: (id: string) => (id in status ? { status: status[id] } : null),
      updateBlock: (id: string, patch: { status: string }) => { status[id] = patch.status; },
    };
  }

  test("activates blocks that are still pending", () => {
    const db = mockDb({ a: "pending", b: "pending" });
    const r = activatePendingBlocks(db, ["a", "b"]);
    assert.equal(r.activated, 2);
    assert.equal(r.skippedArchived, 0);
    assert.equal(db.status.a, "active");
    assert.equal(db.status.b, "active");
  });

  test("does NOT resurrect a block archived in-turn by a same-turn supersede", () => {
    // c was created pending this turn, then archived by a supersede during Pass 4.
    const db = mockDb({ a: "pending", c: "archived" });
    const r = activatePendingBlocks(db, ["a", "c"]);
    assert.equal(r.activated, 1, "only the still-pending block activates");
    assert.equal(r.skippedArchived, 1, "the in-turn-archived block is counted + left");
    assert.equal(db.status.a, "active");
    assert.equal(db.status.c, "archived", "archived block must STAY archived — never resurrected");
  });

  test("tolerates ids missing from the db (no throw, no spurious activation)", () => {
    const db = mockDb({ a: "pending" });
    const r = activatePendingBlocks(db, ["a", "ghost"]);
    assert.equal(r.activated, 1);
    assert.equal(r.skippedArchived, 0);
    assert.equal(db.status.a, "active");
  });
});

// ─── computeNextTurnNumber — turn-log uniqueness across runs/restarts ──────────
// (2026-06-12: v2 per-turn runs all wrote turn-00.json — the counter never
// advanced on checkpoint runs AND reset to 0 every restart. The pure rule:
// next number = max existing + 1; non-matching names ignored.)

describe("computeNextTurnNumber — turn-log file numbering", () => {
  test("empty dir → 0", () => {
    assert.equal(computeNextTurnNumber([]), 0);
  });
  test("continues past the max existing number (restart survival)", () => {
    assert.equal(computeNextTurnNumber(["turn-00.json", "turn-01.json", "turn-02.json"]), 3);
  });
  test("gaps don't matter — only the max counts", () => {
    assert.equal(computeNextTurnNumber(["turn-00.json", "turn-07.json"]), 8);
  });
  test("ignores non-matching names", () => {
    assert.equal(computeNextTurnNumber(["reflect-last.json", "turn-abc.json", "turn-1.json.bak"]), 0);
  });
  test("handles 3+ digit numbers", () => {
    assert.equal(computeNextTurnNumber(["turn-99.json", "turn-100.json"]), 101);
  });
});

// ─── resolveWithinBatchRefLabel — the v2-id edge-loss fix (2026-06-13) ─────────
// The old resolvers gated on startsWith("item_"), silently dropping every v2
// within-batch based_on/supersedes/semantic edge (v2 ids are group::local).

import { resolveWithinBatchRefLabel } from "../pipeline.js";

describe("resolveWithinBatchRefLabel — item-map first, label fallback, never label an item ref", () => {
  const map = new Map<string, string>([
    ["item_3", "proj_fact_v1-style"],
    ["group_2::insight_cause", "proj_fact_demoted-insight"],
  ]);

  test("v1 item id in map → its (post-demote) label", () => {
    assert.deepEqual(resolveWithinBatchRefLabel("item_3", map), { label: "proj_fact_v1-style", viaItemMap: true });
  });

  test("v2 group::local id in map → its label (THE bug: was dropped before)", () => {
    assert.deepEqual(resolveWithinBatchRefLabel("group_2::insight_cause", map), { label: "proj_fact_demoted-insight", viaItemMap: true });
  });

  test("v2 id NOT in map → null, never treated as a label", () => {
    assert.equal(resolveWithinBatchRefLabel("group_9::ghost", map), null);
  });

  test("v1 item id NOT in map → null", () => {
    assert.equal(resolveWithinBatchRefLabel("item_99", map), null);
  });

  test("a real graph label passes through with viaItemMap=false", () => {
    assert.deepEqual(resolveWithinBatchRefLabel("other-proj_constraint_rate-limit", map), { label: "other-proj_constraint_rate-limit", viaItemMap: false });
  });
});
