/**
 * PIPELINE v2 (TRANSFORM) — COMPREHEND fragment tests (build step 2)
 *
 * Covers the three deterministic, $0 pieces that prove the v2 producer maps onto
 * the existing v1 consumer:
 *   - pipelineV2Enabled() — default OFF, "1" convention
 *   - validateComprehendResult() — SEAM 1 error/warning tiers
 *   - comprehendResultToPass2Items() — the bridge: link → Pass2Item field routing
 *
 * Run: node --import=tsx/esm --test src/middleware/reflect/__tests__/comprehend.test.ts
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  pipelineV2Enabled,
  validateComprehendResult,
  comprehendResultToPass2Items,
  comprehendResultToCheckpoint,
  normalizeProjectName,
  dominantProvisionalProject,
  summarizeWarnings,
  COMPREHEND_LINK_RELS,
  type ComprehendResult,
  type ComprehendBlock,
} from "../comprehend.js";

// ─── builders ────────────────────────────────────────────────────────────────

function mkBlock(o: Partial<ComprehendBlock> & { local_id: string; type: string }): ComprehendBlock {
  return {
    unique: {},
    essence: "an essence",
    provenance: "verbatim excerpt from the transcript",
    ...o,
  };
}

/** A minimal VALID fragment: one group, one fact, no links. */
function mkValidResult(): ComprehendResult {
  return {
    groups: [
      {
        group_id: "g1",
        topic: "the roaster-choice thread",
        provisional_project: "home-coffee-roasting",
        blocks: [mkBlock({ local_id: "g1.b1", type: "fact", unique: { value: "fluid-bed roasts evenly" } })],
        within_group_links: [],
      },
    ],
  };
}

// ─── pipelineV2Enabled ─────────────────────────────────────────────────────────

describe("pipelineV2Enabled — ALWAYS ON (v1 retired & un-turnable; env var is inert)", () => {
  test("unset → true", () => {
    const prev = process.env.NODEDEX_PIPELINE_V2;
    delete process.env.NODEDEX_PIPELINE_V2;
    assert.equal(pipelineV2Enabled(), true);
    if (prev !== undefined) process.env.NODEDEX_PIPELINE_V2 = prev;
  });
  test('"1" → true', () => {
    const prev = process.env.NODEDEX_PIPELINE_V2;
    process.env.NODEDEX_PIPELINE_V2 = "1";
    assert.equal(pipelineV2Enabled(), true);
    if (prev !== undefined) process.env.NODEDEX_PIPELINE_V2 = prev;
    else delete process.env.NODEDEX_PIPELINE_V2;
  });
  test('"0" → STILL true (v1 retired — the off-switch is inert, v1 cannot be turned on)', () => {
    const prev = process.env.NODEDEX_PIPELINE_V2;
    process.env.NODEDEX_PIPELINE_V2 = "0";
    assert.equal(pipelineV2Enabled(), true);
    if (prev !== undefined) process.env.NODEDEX_PIPELINE_V2 = prev;
    else delete process.env.NODEDEX_PIPELINE_V2;
  });
});

// ─── validateComprehendResult — happy path ─────────────────────────────────────

describe("validateComprehendResult — valid fragment", () => {
  test("minimal valid fragment → valid, no errors", () => {
    const v = validateComprehendResult(mkValidResult());
    assert.equal(v.valid, true);
    assert.equal(v.errors.length, 0);
  });

  test("decision WITH a based_on link → valid, no based_on warning", () => {
    const r: ComprehendResult = {
      groups: [
        {
          group_id: "g1",
          topic: "t",
          blocks: [
            mkBlock({ local_id: "f1", type: "fact", unique: { value: "v" } }),
            mkBlock({ local_id: "d1", type: "decision", unique: { choice: "go with X" } }),
          ],
          within_group_links: [{ from: "d1", to: "f1", type: "based_on" }],
        },
      ],
    };
    const v = validateComprehendResult(r);
    assert.equal(v.valid, true);
    assert.equal(v.warnings.some((w) => /based_on/.test(w.message)), false);
  });
});

// ─── validateComprehendResult — ERRORS (hard) ──────────────────────────────────

describe("validateComprehendResult — errors", () => {
  test("malformed (groups missing / not an array) → invalid", () => {
    assert.equal(validateComprehendResult(null).valid, false);
    assert.equal(validateComprehendResult({}).valid, false);
    assert.equal(validateComprehendResult({ groups: "x" }).valid, false);
  });

  test("EMPTY groups → VALID (no residue = nothing to save, not an error)", () => {
    const v = validateComprehendResult({ groups: [] });
    assert.equal(v.valid, true);
    assert.equal(v.errors.length, 0);
  });

  test("missing provenance → error", () => {
    const r = mkValidResult();
    r.groups[0].blocks[0].provenance = "   ";
    const v = validateComprehendResult(r);
    assert.equal(v.valid, false);
    assert.ok(v.errors.some((e) => /provenance/.test(e.message)));
  });

  test("duplicate local_id → error", () => {
    const r = mkValidResult();
    r.groups[0].blocks.push(mkBlock({ local_id: "g1.b1", type: "fact", unique: { value: "dup" } }));
    const v = validateComprehendResult(r);
    assert.equal(v.valid, false);
    assert.ok(v.errors.some((e) => /duplicate local_id/.test(e.message)));
  });

  // 2026-06-12: dangling link endpoints DEMOTED error→warning. The live arc case:
  // ONE hallucinated link.to id (the LLM renamed a block it DID emit) declared the
  // whole 14-block fragment invalid → full degrade to v1 (double cost, better
  // output discarded). The converter drops unresolvable links; links are the most
  // repairable artifact (JUSTIFY / cross-linker / Pass 4); one droppable link must
  // never abort the fragment. Block-level breaks (provenance, dup id) stay fatal.
  test("dangling link endpoint → WARNING, fragment stays valid, link dropped at convert", () => {
    const r = mkValidResult();
    r.groups[0].within_group_links = [{ from: "g1.b1", to: "nope", type: "based_on" }];
    const v = validateComprehendResult(r);
    assert.equal(v.valid, true, "one bad link must not invalidate the fragment");
    assert.ok(v.warnings.some((e) => /references no block/.test(e.message)));
    const { items } = comprehendResultToPass2Items(r);
    assert.equal(items.length, 1, "blocks survive");
    assert.deepEqual(items[0].based_on_items, [], "the dangling link is dropped, not wired");
  });

  test("unknown link relation with a DANGLING endpoint → warnings for both, still valid", () => {
    const r = mkValidResult();
    r.groups[0].within_group_links = [{ from: "g1.b1", to: "ghost", type: "part_of" }];
    const v = validateComprehendResult(r);
    assert.equal(v.valid, true);
    assert.ok(v.warnings.some((e) => /unknown\/unsupported relation/.test(e.message)));
    assert.ok(v.warnings.some((e) => /references no block/.test(e.message)));
  });

  test("a decision whose ONLY based_on link dangles is warned as unjustified (JUSTIFY's detect contract)", () => {
    const r = mkValidResult();
    r.groups[0].blocks.push(mkBlock({ local_id: "g1.d1", type: "decision", unique: { choice: "x" } }));
    r.groups[0].within_group_links = [{ from: "g1.d1", to: "ghost", type: "based_on" }];
    const v = validateComprehendResult(r);
    assert.equal(v.valid, true);
    assert.ok(v.warnings.some((e) => /decision has no based_on link/.test(e.message)),
      "a based_on that will be dropped at convert must not satisfy the justification requirement");
  });

  test("part_of and superseded_by are NOT comprehend link rels", () => {
    assert.equal(COMPREHEND_LINK_RELS.has("part_of"), false);
    assert.equal(COMPREHEND_LINK_RELS.has("superseded_by"), false);
    assert.equal(COMPREHEND_LINK_RELS.has("based_on"), true);
    assert.equal(COMPREHEND_LINK_RELS.has("supports"), true);
  });

  test("missing type → error", () => {
    const r = mkValidResult();
    (r.groups[0].blocks[0] as any).type = "";
    const v = validateComprehendResult(r);
    assert.equal(v.valid, false);
    assert.ok(v.errors.some((e) => /missing type/.test(e.message)));
  });
});

// ─── validateComprehendResult — WARNINGS (soft, still valid) ────────────────────

describe("validateComprehendResult — warnings", () => {
  test("decision without based_on → warning, still valid", () => {
    const r: ComprehendResult = {
      groups: [
        {
          group_id: "g1",
          topic: "t",
          blocks: [mkBlock({ local_id: "d1", type: "decision", unique: { choice: "X" } })],
          within_group_links: [],
        },
      ],
    };
    const v = validateComprehendResult(r);
    assert.equal(v.valid, true);
    assert.ok(v.warnings.some((w) => /based_on/.test(w.message)));
  });

  test("unknown link relation with VALID endpoints → warning, still valid (recoverable; dropped at convert)", () => {
    const r = mkValidResult();
    r.groups[0].blocks.push(mkBlock({ local_id: "g1.b2", type: "fact", unique: { value: "x" } }));
    // "alternatives_rejected" is a decision unique{} field name the model sometimes
    // mis-emits as a link type (the big-arc gate found this). Recoverable, not fatal.
    r.groups[0].within_group_links = [{ from: "g1.b1", to: "g1.b2", type: "alternatives_rejected" }];
    const v = validateComprehendResult(r);
    assert.equal(v.valid, true);
    assert.ok(!v.errors.some((e) => /unknown\/unsupported relation/.test(e.message)));
    assert.ok(v.warnings.some((w) => /unknown\/unsupported relation/.test(w.message)));
  });

  test("unknown type without schema{} → warning; WITH schema{} → no warning", () => {
    const r1 = mkValidResult();
    r1.groups[0].blocks[0].type = "stance";
    const v1 = validateComprehendResult(r1);
    assert.equal(v1.valid, true);
    assert.ok(v1.warnings.some((w) => /unknown type/.test(w.message)));

    const r2 = mkValidResult();
    r2.groups[0].blocks[0].type = "stance";
    r2.groups[0].blocks[0].schema = { position: "the stance taken" };
    const v2 = validateComprehendResult(r2);
    assert.equal(v2.warnings.some((w) => /unknown type/.test(w.message)), false);
  });

  test("unique{} key mismatch → warning (soft, reuses validateUniqueSchema)", () => {
    const r = mkValidResult();
    // fact requires `value`; provide a wrong key
    r.groups[0].blocks[0].unique = { wrongkey: "oops" };
    const v = validateComprehendResult(r);
    assert.equal(v.valid, true);
    assert.ok(v.warnings.some((w) => /unique\{\}/.test(w.message)));
  });

  test("within-group link referencing ANOTHER group's block → warning, dropped (cross-group wiring is the LINKER's job)", () => {
    const r: ComprehendResult = {
      groups: [
        { group_id: "g1", topic: "t1", blocks: [mkBlock({ local_id: "a", type: "fact", unique: { value: "v" } })], within_group_links: [{ from: "a", to: "b", type: "related_to" }] },
        { group_id: "g2", topic: "t2", blocks: [mkBlock({ local_id: "b", type: "fact", unique: { value: "w" } })], within_group_links: [] },
      ],
    };
    const v = validateComprehendResult(r);
    assert.equal(v.valid, true); // "b" is not in g1 → not a within-group link; dropped, the cross-group LINKER owns those
    assert.ok(v.warnings.some((e) => /references no block in this group/.test(e.message)));
    const { items } = comprehendResultToPass2Items(r);
    assert.equal(items.length, 2, "both groups' blocks survive");
    assert.deepEqual(items[0].relations, [], "the cross-group reference is dropped at convert, not mis-wired");
  });

  test("same local_id REUSED across DIFFERENT groups → valid (group-scoped, the LLM's natural numbering)", () => {
    const r: ComprehendResult = {
      groups: [
        { group_id: "g1", topic: "t1", blocks: [mkBlock({ local_id: "block_1", type: "fact", unique: { value: "v" } })], within_group_links: [] },
        { group_id: "g2", topic: "t2", blocks: [mkBlock({ local_id: "block_1", type: "fact", unique: { value: "w" } })], within_group_links: [] },
      ],
    };
    assert.equal(validateComprehendResult(r).valid, true);
  });
});

// ─── comprehendResultToPass2Items — the bridge ─────────────────────────────────

describe("comprehendResultToPass2Items — fragment → Pass2Item[]", () => {
  test("flattens blocks; maps id/type/unique/excerpt/project", () => {
    const { items, groupByItemId } = comprehendResultToPass2Items(mkValidResult());
    assert.equal(items.length, 1);
    const it = items[0];
    assert.equal(it.id, "g1::g1.b1"); // qualified by group
    assert.equal(it.type, "fact");
    assert.deepEqual(it.unique, { value: "fluid-bed roasts evenly" });
    assert.equal(it.excerpt, "verbatim excerpt from the transcript");
    assert.equal(it.project, "home-coffee-roasting");
    assert.deepEqual(it.triggered_by_items, []);
    assert.deepEqual(it.based_on_items, []);
    assert.equal(groupByItemId["g1::g1.b1"], "g1");
  });

  test("keep_reason + type_reasoning survive the bridge (turn-log observability)", () => {
    // Before 2026-06-12 the bridge dropped both fields → per-turn v2 turn-logs had
    // no auditable reasoning (charter rule 8 unfollowable on that path).
    const r: ComprehendResult = {
      groups: [
        {
          group_id: "g1",
          topic: "t",
          provisional_project: "p",
          blocks: [mkBlock({
            local_id: "g1.b1", type: "blueprint", unique: { purpose: "x" },
            keep_reason: "offered to the user — path-specific residue",
            type_reasoning: "proposal awaiting acceptance — fork still open, so blueprint not decision",
          })],
          within_group_links: [],
        },
      ],
    };
    const { items } = comprehendResultToPass2Items(r);
    assert.equal(items[0].keep_reason, "offered to the user — path-specific residue");
    assert.equal(items[0].type_reasoning, "proposal awaiting acceptance — fork still open, so blueprint not decision");
  });

  test("based_on link → based_on_items; prompted_by → triggered_by_items", () => {
    const r: ComprehendResult = {
      groups: [
        {
          group_id: "g1",
          topic: "t",
          blocks: [
            mkBlock({ local_id: "f1", type: "fact", unique: { value: "v" } }),
            mkBlock({ local_id: "e1", type: "event", unique: { value: "happened" } }),
            mkBlock({ local_id: "d1", type: "decision", unique: { choice: "X" } }),
          ],
          within_group_links: [
            { from: "d1", to: "f1", type: "based_on" },
            { from: "d1", to: "e1", type: "prompted_by" },
          ],
        },
      ],
    };
    const { items } = comprehendResultToPass2Items(r);
    const d1 = items.find((i) => i.id === "g1::d1")!;
    assert.deepEqual(d1.based_on_items, ["g1::f1"]);
    assert.deepEqual(d1.triggered_by_items, ["g1::e1"]);
  });

  test("extends → extends_item (single); supersedes → supersedes_ref; resolves → resolved_ref", () => {
    const r: ComprehendResult = {
      groups: [
        {
          group_id: "g1",
          topic: "t",
          blocks: [
            mkBlock({ local_id: "a", type: "fact", unique: { value: "broad" } }),
            mkBlock({ local_id: "b", type: "fact", unique: { value: "specific" } }),
            mkBlock({ local_id: "old", type: "decision", unique: { choice: "old" } }),
            mkBlock({ local_id: "new", type: "decision", unique: { choice: "new" } }),
            mkBlock({ local_id: "q", type: "question", unique: { question: "?" } }),
            mkBlock({ local_id: "ans", type: "fact", unique: { value: "answer" } }),
          ],
          within_group_links: [
            { from: "b", to: "a", type: "extends" },
            { from: "new", to: "old", type: "supersedes" },
            { from: "ans", to: "q", type: "resolves" },
          ],
        },
      ],
    };
    const { items } = comprehendResultToPass2Items(r);
    assert.equal(items.find((i) => i.id === "g1::b")!.extends_item, "g1::a");
    assert.equal(items.find((i) => i.id === "g1::new")!.supersedes_ref, "g1::old");
    assert.equal(items.find((i) => i.id === "g1::ans")!.resolved_ref, "g1::q");
  });

  test("supports/contradicts/etc → relations[] with target + reasoning", () => {
    const r: ComprehendResult = {
      groups: [
        {
          group_id: "g1",
          topic: "t",
          blocks: [
            mkBlock({ local_id: "fact1", type: "fact", unique: { value: "evidence" } }),
            mkBlock({ local_id: "hyp1", type: "hypothesis", unique: { proposal: "theory" } }),
          ],
          within_group_links: [{ from: "fact1", to: "hyp1", type: "supports", reasoning: "the data backs it" }],
        },
      ],
    };
    const { items } = comprehendResultToPass2Items(r);
    const fact1 = items.find((i) => i.id === "g1::fact1")!;
    assert.equal(fact1.relations!.length, 1);
    assert.deepEqual(fact1.relations![0], { type: "supports", target: "g1::hyp1", reasoning: "the data backs it" });
  });

  test("uncertain block → review_reason set", () => {
    const r = mkValidResult();
    r.groups[0].blocks[0].uncertain = true;
    const { items } = comprehendResultToPass2Items(r);
    assert.equal(items[0].review_reason, "comprehend_uncertain");
  });

  test("defensive: dangling link does not throw, just skips", () => {
    const r = mkValidResult();
    r.groups[0].within_group_links = [{ from: "g1.b1", to: "ghost", type: "based_on" }];
    const { items } = comprehendResultToPass2Items(r);
    assert.deepEqual(items[0].based_on_items, []); // skipped, no crash
  });

  test("unknown link relation is DROPPED (not relegated to relations[])", () => {
    const r: ComprehendResult = {
      groups: [
        {
          group_id: "g1",
          topic: "t",
          blocks: [
            mkBlock({ local_id: "d1", type: "decision", unique: { choice: "X" } }),
            mkBlock({ local_id: "o1", type: "fact", unique: { value: "the rejected option" } }),
          ],
          // a unique{} field name mis-used as a link type → must NOT become a relation
          within_group_links: [{ from: "d1", to: "o1", type: "alternatives_rejected" }],
        },
      ],
    };
    const { items } = comprehendResultToPass2Items(r);
    const d1 = items.find((i) => i.id === "g1::d1")!;
    assert.deepEqual(d1.relations, []); // dropped, not pushed as a junk relation
  });

  test("underscore provisional_project → item.project normalized to hyphens (no fork)", () => {
    const r: ComprehendResult = {
      groups: [
        {
          group_id: "web_framework_selection",
          topic: "t",
          provisional_project: "backend_api_service", // underscore = the Run 9 fork bug
          blocks: [mkBlock({ local_id: "d1", type: "decision", unique: { choice: "X" } })],
          within_group_links: [],
        },
      ],
    };
    const { items } = comprehendResultToPass2Items(r);
    assert.equal(items[0].project, "backend-api-service"); // hyphens, single dimension
  });

  test("empty groups → items: [] (no crash)", () => {
    const { items, groupByItemId } = comprehendResultToPass2Items({ groups: [] });
    assert.equal(items.length, 0);
    assert.deepEqual(groupByItemId, {});
  });

  // ── project-name fallback (the group_1 regression fix, 2026-06-14) ─────────────
  // An empty provisional_project must NEVER yield item.project=undefined: that starves
  // the recognizer and lets Pass 3 coin a "group_1" placeholder root.
  test("empty provisional_project → inherits the arc's DOMINANT root (no fragmentation)", () => {
    const r: ComprehendResult = {
      groups: [
        { group_id: "g1", topic: "crash fix", provisional_project: "react-app-debugging",
          blocks: [mkBlock({ local_id: "b1", type: "fact", unique: { value: "v" } })], within_group_links: [] },
        { group_id: "g2", topic: "retry strategy", provisional_project: "react-app-debugging",
          blocks: [mkBlock({ local_id: "b2", type: "fact", unique: { value: "v" } })], within_group_links: [] },
        // guess missing → must inherit the dominant root, NOT become its own root
        { group_id: "g3", topic: "caching", provisional_project: "",
          blocks: [mkBlock({ local_id: "b3", type: "fact", unique: { value: "v" } })], within_group_links: [] },
      ],
    };
    const { items, groupByItemId } = comprehendResultToPass2Items(r);
    const g3item = items.find((it) => groupByItemId[it.id] === "g3")!;
    assert.equal(g3item.project, "react-app-debugging");
  });

  test("ALL provisional_project empty → falls back to the group topic (never undefined/placeholder)", () => {
    const r: ComprehendResult = {
      groups: [
        { group_id: "group_1", topic: "improving the useFetch hook", provisional_project: "",
          blocks: [mkBlock({ local_id: "b1", type: "fact", unique: { value: "v" } })], within_group_links: [] },
      ],
    };
    const { items } = comprehendResultToPass2Items(r);
    assert.equal(items[0].project, "improving-the-usefetch-hook"); // topic-derived, NOT "group_1"
    assert.notEqual(items[0].project, undefined);
  });

  // 2026-06-12 mechanism change: keep_reason/type_reasoning now RIDE the Pass2Item
  // so they reach the turn-log on EVERY path (the per-turn holistic path has no
  // per-group debug dump — dropping them here made charter rule 8 unfollowable).
  // The original design INTENT is unchanged and still enforced: they never reach
  // the graph block — Pass 3 strips them from its prompt copy (pass3.ts), and the
  // block is built solely from the LLM's response to that stripped copy.
  test("keep_reason is accepted and rides Pass2Item to the turn-log", () => {
    const r = mkValidResult();
    r.groups[0].blocks[0].keep_reason = "the user chose this approach";
    assert.equal(validateComprehendResult(r).valid, true);
    const { items } = comprehendResultToPass2Items(r);
    assert.equal(items[0].keep_reason, "the user chose this approach");
  });

  test("type_reasoning is accepted and rides Pass2Item to the turn-log", () => {
    const r = mkValidResult();
    (r.groups[0].blocks[0] as any).type_reasoning = "an approach evaluated and closed off → dead_end, not a chosen path";
    assert.equal(validateComprehendResult(r).valid, true);
    const { items } = comprehendResultToPass2Items(r);
    // Meta-reasoning about the TYPE choice — travels to the turn-log via the item;
    // never onto the graph block, never into unique{} `reason` (which is content).
    assert.equal(items[0].type_reasoning, "an approach evaluated and closed off → dead_end, not a chosen path");
  });
});

// ─── dominantProvisionalProject — the arc's root for empty-guess groups ────────

describe("dominantProvisionalProject — the most-common root an empty group inherits", () => {
  test("picks the most frequent normalized provisional_project", () => {
    const groups: any[] = [
      { group_id: "a", topic: "t", provisional_project: "react-app-debugging", blocks: [], within_group_links: [] },
      { group_id: "b", topic: "t", provisional_project: "react-app-debugging", blocks: [], within_group_links: [] },
      { group_id: "c", topic: "t", provisional_project: "other-thing", blocks: [], within_group_links: [] },
    ];
    assert.equal(dominantProvisionalProject(groups), "react-app-debugging");
  });
  test("normalizes before counting (underscores fold into the same root)", () => {
    const groups: any[] = [
      { group_id: "a", topic: "t", provisional_project: "backend_api_service", blocks: [], within_group_links: [] },
      { group_id: "b", topic: "t", provisional_project: "backend-api-service", blocks: [], within_group_links: [] },
    ];
    assert.equal(dominantProvisionalProject(groups), "backend-api-service");
  });
  test("no named project anywhere → undefined", () => {
    const groups: any[] = [
      { group_id: "a", topic: "t", provisional_project: "", blocks: [], within_group_links: [] },
    ];
    assert.equal(dominantProvisionalProject(groups), undefined);
  });
});

// ─── summarizeWarnings — quiet, honest warning log (lower the noise) ───────────

describe("summarizeWarnings — separates repaired-downstream draft from notable", () => {
  const w = (message: string) => ({ severity: "warning" as const, message });
  test("draft warnings (unique/link/based_on) bucket as 'draft (repaired downstream)'", () => {
    const out = summarizeWarnings([
      w("unique{} type=decision missing=[reason]"),
      w('link.from "x" references no block in this group (dropped at convert)'),
      w("decision has no based_on link (block-types.md requires one)"),
      w("block missing essence"), // the one notable
    ]);
    assert.equal(out, "1 notable, 3 draft (repaired downstream)");
  });
  test("a clean arc reads as '0 notable' (no alarming count)", () => {
    assert.equal(summarizeWarnings([]), "0 notable");
  });
});

// ─── comprehendResultToCheckpoint — the bridge to runnable ─────────────────────

describe("normalizeProjectName — enforce the hyphens-only dimension rule", () => {
  test("underscores → hyphens (the fork bug)", () => {
    assert.equal(normalizeProjectName("backend_api_service"), "backend-api-service");
  });
  test("already-valid hyphen name unchanged", () => {
    assert.equal(normalizeProjectName("home-coffee-roasting"), "home-coffee-roasting");
  });
  test("lowercases + collapses whitespace/junk + trims edge hyphens", () => {
    assert.equal(normalizeProjectName("  Backend API  Service! "), "backend-api-service");
  });
  test("undefined/empty → undefined", () => {
    assert.equal(normalizeProjectName(undefined), undefined);
    assert.equal(normalizeProjectName(""), undefined);
    assert.equal(normalizeProjectName("___"), undefined);
  });
});

describe("comprehendResultToCheckpoint — fragment → Pass-3-resume checkpoint", () => {
  test("resumeFrom pass3, classified items + derived pass1Items", () => {
    const cp = comprehendResultToCheckpoint(mkValidResult());
    assert.equal(cp.resumeFrom, "pass3");
    assert.equal(cp.pass2Classified?.length, 1);
    assert.equal(cp.pass2Classified?.[0].id, "g1::g1.b1");
    assert.equal(cp.pass1Items?.length, 1);
    assert.equal(cp.pass1Items?.[0].source, "comprehend");
    assert.equal(cp.pass1Items?.[0].provisional_type, "fact");
    assert.equal(cp.pass1Items?.[0].excerpt, "verbatim excerpt from the transcript");
  });

  test("empty fragment → checkpoint with zero items (Pass 3 no-ops)", () => {
    const cp = comprehendResultToCheckpoint({ groups: [] });
    assert.equal(cp.resumeFrom, "pass3");
    assert.equal(cp.pass2Classified?.length, 0);
    assert.equal(cp.pass1Items?.length, 0);
  });
});
