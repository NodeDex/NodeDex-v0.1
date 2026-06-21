// Unit tests for PER-GROUP COMPREHEND (comprehend-pergroup.ts, design §17).
// No real LLM — stubs provider.generateStructured. Covers the gate, SEAM 1.5
// (validateSegmentResult), the pure stitch (incl. keep-partial = missing group →
// empty), and the orchestrator's control flow (degrade on SEGMENT fail/invalid,
// empty-no-residue, and a happy SEGMENT→PRODUCE→stitch path).

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  pergroupEnabled,
  validateSegmentResult,
  stitchToComprehendResult,
  runComprehendPerGroup,
  splitTranscriptForRetry,
  mergeProduceResults,
  produceGroupBounded,
  groupIdsWithErrors,
  quarantineGroups,
  type SegmentResult,
  type ProduceResult,
  type SegmentGroup,
} from "../comprehend-pergroup.js";
import { type ComprehendValidationIssue, type ComprehendResult } from "../comprehend.js";

// ─── gate ────────────────────────────────────────────────────────────────────
describe("pergroupEnabled — default ON (v2 promoted 2026-06-12)", () => {
  test("unset → true; =0 → false (opt-out)", () => {
    const prev = process.env.NODEDEX_COMPREHEND_PERGROUP;
    delete process.env.NODEDEX_COMPREHEND_PERGROUP;
    assert.equal(pergroupEnabled(), true);
    process.env.NODEDEX_COMPREHEND_PERGROUP = "0";
    assert.equal(pergroupEnabled(), false);
    if (prev === undefined) delete process.env.NODEDEX_COMPREHEND_PERGROUP;
    else process.env.NODEDEX_COMPREHEND_PERGROUP = prev;
  });
  test("=1 → true", () => {
    const prev = process.env.NODEDEX_COMPREHEND_PERGROUP;
    process.env.NODEDEX_COMPREHEND_PERGROUP = "1";
    assert.equal(pergroupEnabled(), true);
    if (prev === undefined) delete process.env.NODEDEX_COMPREHEND_PERGROUP;
    else process.env.NODEDEX_COMPREHEND_PERGROUP = prev;
  });
});

// ─── SEAM 1.5 ──────────────────────────────────────────────────────────────────
describe("validateSegmentResult", () => {
  test("well-formed groups → valid", () => {
    const r: SegmentResult = { groups: [
      { group_id: "g1", topic: "roaster", provisional_project: "coffee-roasting", turn_numbers: [1, 2] },
    ] };
    const v = validateSegmentResult(r);
    assert.equal(v.valid, true);
    assert.equal(v.errors.length, 0);
  });
  test("empty groups → valid (no residue)", () => {
    assert.equal(validateSegmentResult({ groups: [] }).valid, true);
  });
  test("not an array → error", () => {
    assert.equal(validateSegmentResult({ groups: "x" }).valid, false);
    assert.equal(validateSegmentResult(null).valid, false);
  });
  test("duplicate group_id → error", () => {
    const v = validateSegmentResult({ groups: [
      { group_id: "g1", topic: "a", provisional_project: "p" },
      { group_id: "g1", topic: "b", provisional_project: "p" },
    ] });
    assert.equal(v.valid, false);
    assert.ok(v.errors.some((e) => /duplicate group_id/.test(e.message)));
  });
  test("missing topic/project → warning, still valid", () => {
    const v = validateSegmentResult({ groups: [{ group_id: "g1" } as any] });
    assert.equal(v.valid, true);
    assert.ok(v.warnings.some((w) => /topic/.test(w.message)));
    assert.ok(v.warnings.some((w) => /provisional_project/.test(w.message)));
  });
});

// ─── stitch (incl. keep-partial) ───────────────────────────────────────────────
describe("stitchToComprehendResult", () => {
  const seg: SegmentResult = { groups: [
    { group_id: "g1", topic: "roaster", provisional_project: "coffee-roasting" },
    { group_id: "g2", topic: "sourcing", provisional_project: "coffee-roasting" },
  ] };

  test("merges produce outputs onto the skeleton, preserving topic + root", () => {
    const produced = new Map<string, ProduceResult>([
      ["g1", { blocks: [{ local_id: "b1", type: "decision", unique: { choice: "fluid-bed" }, essence: "e", provenance: "p" } as any], within_group_links: [] }],
      ["g2", { blocks: [{ local_id: "b1", type: "fact", unique: { value: "v" }, essence: "e", provenance: "p" } as any], within_group_links: [] }],
    ]);
    const out = stitchToComprehendResult(seg, produced);
    assert.equal(out.groups.length, 2);
    assert.equal(out.groups[0].provisional_project, "coffee-roasting");
    assert.equal(out.groups[0].topic, "roaster");
    assert.equal(out.groups[0].blocks.length, 1);
    assert.equal(out.groups[1].blocks[0].type, "fact");
  });

  test("KEEP-PARTIAL: a group with no produce output → empty blocks/links (not dropped)", () => {
    const produced = new Map<string, ProduceResult>([
      ["g1", { blocks: [{ local_id: "b1", type: "fact", unique: { value: "v" }, essence: "e", provenance: "p" } as any], within_group_links: [] }],
      // g2 missing (its PRODUCE failed)
    ]);
    const out = stitchToComprehendResult(seg, produced);
    assert.equal(out.groups.length, 2);          // g2 still present
    assert.deepEqual(out.groups[1].blocks, []);   // just empty
    assert.deepEqual(out.groups[1].within_group_links, []);
  });
});

// ─── Fix 2 Layer 1: output-bound (split-and-retry on truncation) ───────────────
describe("splitTranscriptForRetry", () => {
  test("splits a multi-line transcript roughly in half", () => {
    assert.deepEqual(splitTranscriptForRetry("a\nb\nc\nd"), ["a\nb", "c\nd"]);
  });
  test("returns [t] when it can't be split (single line)", () => {
    assert.deepEqual(splitTranscriptForRetry("single"), ["single"]);
  });
});

describe("mergeProduceResults — namespaces ids so they stay unique", () => {
  test("prefixes each part's local_ids + remaps link endpoints", () => {
    const merged = mergeProduceResults([
      { blocks: [{ local_id: "b1", type: "fact", unique: { value: "v" }, essence: "e", provenance: "p" } as any],
        within_group_links: [{ from: "b1", to: "b1", type: "based_on" }] },
      { blocks: [{ local_id: "b1", type: "decision", unique: { choice: "c" }, essence: "e", provenance: "p" } as any],
        within_group_links: [] },
    ]);
    assert.deepEqual(merged.blocks.map((b) => b.local_id), ["s0_b1", "s1_b1"]);
    assert.equal(merged.within_group_links[0].from, "s0_b1");
    assert.equal(merged.within_group_links[0].to, "s0_b1");
  });
});

describe("produceGroupBounded — split-and-retry on genuine truncation", () => {
  // Mock: truncates while the transcript has more than `maxOkLines` lines; succeeds
  // (1 block) once a split makes it small enough. Mirrors openai's attempts trail.
  function truncProvider(maxOkLines: number): any {
    return {
      isAvailable: () => true,
      generateStructured: async (_sys: string, userInput: string) => {
        const segs = userInput.split("\n\n");
        const transcript = segs[segs.length - 1];
        const n = transcript.split("\n").length;
        if (n > maxOkLines) {
          return { result: null, rateLimited: false, attempts: [{ model: "m", outcome: "truncated" }], usage: {} };
        }
        return {
          result: { blocks: [{ local_id: "b1", type: "fact", unique: { value: "v", why_matters: "w" }, essence: "e", provenance: "p" }],
                    within_group_links: [{ from: "b1", to: "b1", type: "based_on" }] },
          rateLimited: false, attempts: [{ model: "m", outcome: "ok" }], usage: {},
        };
      },
    };
  }
  const group: SegmentGroup = { group_id: "g1", topic: "t", provisional_project: "p" };

  test("truncates once, splits, and recovers BOTH halves (no group lost)", async () => {
    let calls = 0;
    const out = await produceGroupBounded(truncProvider(2), "l1\nl2\nl3\nl4", group, 0, () => { calls++; });
    assert.equal(out.ok, true);
    assert.equal(out.result.blocks.length, 2);          // both halves recovered
    assert.deepEqual(out.result.blocks.map((b) => b.local_id), ["s0_b1", "s1_b1"]); // namespaced
    assert.equal(calls, 3);                              // 1 truncated full + 2 ok halves
  });

  test("still truncating at the split floor → ok=false, empty (degrade, never crash)", async () => {
    const out = await produceGroupBounded(truncProvider(0), "l1\nl2\nl3\nl4", group, 0, () => {});
    assert.equal(out.ok, false);
    assert.deepEqual(out.result.blocks, []);
  });

  test("a clean (non-truncating) call returns its blocks directly", async () => {
    let calls = 0;
    const out = await produceGroupBounded(truncProvider(99), "l1\nl2", group, 0, () => { calls++; });
    assert.equal(out.ok, true);
    assert.equal(out.result.blocks.length, 1);
    assert.equal(calls, 1);                              // no split needed
  });
});

// ─── orchestrator control flow (stubbed provider) ──────────────────────────────
function segProvider(segmentResult: any): any {
  return { isAvailable: () => true, generateStructured: async () => ({ result: segmentResult, rateLimited: false, usage: {} }) };
}
function twoStageProvider(seg: any, produce: any): any {
  let n = 0;
  return { isAvailable: () => true, generateStructured: async () => { n++; return { result: n === 1 ? seg : produce, rateLimited: false, usage: {} }; } };
}

describe("runComprehendPerGroup — control flow", () => {
  test("SEGMENT fails → result null (degrade to v1)", async () => {
    const out = await runComprehendPerGroup(segProvider(null), "t");
    assert.equal(out.result, null);
  });

  test("SEGMENT invalid (not array) → result null (SEAM 1.5)", async () => {
    const out = await runComprehendPerGroup(segProvider({ groups: "x" }), "t");
    assert.equal(out.result, null);
  });

  test("SEGMENT empty (no residue) → valid empty result, no PRODUCE", async () => {
    const out = await runComprehendPerGroup(segProvider({ groups: [] }), "t");
    assert.deepEqual(out.result, { groups: [] });
    assert.equal(out.validation?.valid, true);
    assert.equal(out.segmentGroups, 0);
    assert.equal(out.produceCalls, 0);
  });

  test("happy path: SEGMENT → PRODUCE per group → stitched valid result", async () => {
    const seg = { groups: [
      { group_id: "g1", topic: "roaster", provisional_project: "coffee-roasting", turn_numbers: [1] },
      { group_id: "g2", topic: "sourcing", provisional_project: "coffee-roasting", turn_numbers: [2] },
    ] };
    const produce = { blocks: [{ local_id: "b1", type: "fact", unique: { value: "v" }, essence: "e", provenance: "p" }], within_group_links: [] };
    const out = await runComprehendPerGroup(twoStageProvider(seg, produce), "t");
    assert.equal(out.segmentGroups, 2);
    assert.equal(out.produceCalls, 2);
    assert.equal(out.produceFailures, 0);
    assert.equal(out.result?.groups.length, 2);
    assert.equal(out.result?.groups[0].blocks.length, 1);
    assert.equal(out.validation?.valid, true);
  });
});

// ─── REDO + QUARANTINE helpers (pure) ──────────────────────────────────────────
describe("groupIdsWithErrors — attributes failures to groups", () => {
  test("collects distinct group_ids, ignores group-less errors", () => {
    const errs: ComprehendValidationIssue[] = [
      { severity: "error", message: "a", group_id: "g2" },
      { severity: "error", message: "b" },                 // no group → ignored
      { severity: "error", message: "c", group_id: "g2" }, // dup → once
      { severity: "error", message: "d", group_id: "g5" },
    ];
    assert.deepEqual([...groupIdsWithErrors(errs)].sort(), ["g2", "g5"]);
  });
  test("empty errors → empty set", () => {
    assert.equal(groupIdsWithErrors([]).size, 0);
  });
});

describe("quarantineGroups — empties only the named groups", () => {
  const mk = (): ComprehendResult => ({ groups: [
    { group_id: "g1", topic: "t1", provisional_project: "p", blocks: [{ local_id: "b1", type: "fact", unique: { value: "v" }, essence: "e", provenance: "p" }], within_group_links: [{ from: "b1", to: "b1", type: "based_on" }] },
    { group_id: "g2", topic: "t2", provisional_project: "p", blocks: [{ local_id: "b1", type: "fact", unique: { value: "v" }, essence: "e", provenance: "p" }], within_group_links: [{ from: "b1", to: "b1", type: "based_on" }] },
  ] });
  test("named group emptied, others untouched", () => {
    const out = quarantineGroups(mk(), new Set(["g2"]));
    assert.equal(out.groups[0].blocks.length, 1);          // g1 kept
    assert.equal(out.groups[1].blocks.length, 0);          // g2 emptied
    assert.equal(out.groups[1].within_group_links.length, 0);
  });
  test("empty set → returned unchanged", () => {
    const src = mk();
    assert.equal(quarantineGroups(src, new Set()), src);
  });
});

// ─── REDO + QUARANTINE orchestration (scripted provider) ───────────────────────
// SEGMENT first, then PRODUCE per group; PRODUCE results are scripted PER TOPIC and
// PER ATTEMPT so we can drive invalid-then-valid (redo recovers) and invalid-always
// (quarantine / degrade). A block WITHOUT provenance is a SEAM-1 hard error.
function scriptedProvider(seg: any, scriptByTopic: Record<string, any[]>): any {
  const counts: Record<string, number> = {};
  return {
    isAvailable: () => true,
    generateStructured: async (_sys: string, userInput: string) => {
      const m = userInput.match(/topic: "([^"]*)"/);       // PRODUCE call carries the topic
      if (m) {
        const topic = m[1];
        const i = counts[topic] ?? 0;
        counts[topic] = i + 1;
        const script = scriptByTopic[topic] ?? [];
        return { result: script[Math.min(i, script.length - 1)] ?? null, rateLimited: false, usage: {} };
      }
      return { result: seg, rateLimited: false, usage: {} }; // SEGMENT
    },
  };
}
const validBlk = { local_id: "b1", type: "fact", unique: { value: "v", why_matters: "w" }, essence: "e", provenance: "p", keep_reason: "k" };
const noProvBlk = { local_id: "b1", type: "fact", unique: { value: "v", why_matters: "w" }, essence: "e", keep_reason: "k" }; // missing provenance → HARD error
const pr = (blocks: any[]) => ({ blocks, within_group_links: [] });
const twoGroupSeg = { groups: [
  { group_id: "g1", topic: "t1", provisional_project: "p", turn_numbers: [1] },
  { group_id: "g2", topic: "t2", provisional_project: "p", turn_numbers: [2] },
] };

describe("runComprehendPerGroup — redo + quarantine", () => {
  test("a group invalid at SEAM 1 is RE-RUN (only it) and recovers", async () => {
    const out = await runComprehendPerGroup(
      scriptedProvider(twoGroupSeg, { t1: [pr([validBlk])], t2: [pr([noProvBlk]), pr([validBlk])] }), "t");
    assert.equal(out.validation?.valid, true);             // recovered → valid
    assert.equal(out.redoneGroups, 1);                     // only the bad one redone
    assert.equal(out.quarantinedGroups, 0);
    assert.equal(out.produceCalls, 3);                     // 2 initial + 1 redo
    assert.equal(out.result?.groups[0].blocks.length, 1);  // g1 untouched
    assert.equal(out.result?.groups[1].blocks.length, 1);  // g2 recovered
  });

  test("a group invalid even after redo is QUARANTINED so the valid group survives", async () => {
    const out = await runComprehendPerGroup(
      scriptedProvider(twoGroupSeg, { t1: [pr([validBlk])], t2: [pr([noProvBlk])] }), "t"); // t2 always invalid
    assert.equal(out.validation?.valid, true);             // valid because g2 was emptied
    assert.equal(out.redoneGroups, 1);
    assert.equal(out.quarantinedGroups, 1);
    assert.equal(out.result?.groups[0].blocks.length, 1);  // g1 kept (the whole arc is NOT lost)
    assert.equal(out.result?.groups[1].blocks.length, 0);  // g2 quarantined
  });

  test("ALL groups invalid after redo → left invalid (caller degrades to v1), no quarantine", async () => {
    const oneGroupSeg = { groups: [{ group_id: "g1", topic: "t1", provisional_project: "p", turn_numbers: [1] }] };
    const out = await runComprehendPerGroup(
      scriptedProvider(oneGroupSeg, { t1: [pr([noProvBlk])] }), "t"); // always invalid
    assert.equal(out.validation?.valid, false);            // nothing survives → still invalid
    assert.equal(out.redoneGroups, 1);
    assert.equal(out.quarantinedGroups, 0);                // didn't quarantine the only group
  });
});
