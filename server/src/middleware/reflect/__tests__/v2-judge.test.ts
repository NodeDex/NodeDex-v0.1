// Unit tests for the v2 SELECTOR (worth-gate) — comprehend → JUDGE → drop low-worth,
// but NEVER orphan a kept item's causal evidence (anchor-override), and clean dangling
// refs. No real LLM — applyV2JudgeVerdicts is pure; runV2Judge uses a stubbed provider.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { v2JudgeEnabled, v2JudgeContextEnabled, applyV2JudgeVerdicts, runV2Judge, buildRoleContext } from "../v2-judge.js";
import type { Pass2Item } from "../types.js";
import type { PassJudgeResult } from "../pass_judge.js";

function mkItem(id: string, extra: Partial<Pass2Item> = {}): Pass2Item {
  return { id, text: id, type: "fact", triggered_by_items: [], based_on_items: [], relations: [], ...extra };
}
const KEEP = (id: string) => ({ item_id: id, verdict: "KEEP" as const, reason_category: "path_specific_residue" as const });
const DROP = (id: string) => ({ item_id: id, verdict: "DROP" as const, reason_category: "general_knowledge" as const });

describe("v2JudgeEnabled — default ON (v2 promoted 2026-06-12)", () => {
  test("unset → true; =0 → false; =1 → true", () => {
    const prev = process.env.NODEDEX_V2_JUDGE;
    delete process.env.NODEDEX_V2_JUDGE; assert.equal(v2JudgeEnabled(), true);
    process.env.NODEDEX_V2_JUDGE = "0"; assert.equal(v2JudgeEnabled(), false);
    process.env.NODEDEX_V2_JUDGE = "1"; assert.equal(v2JudgeEnabled(), true);
    if (prev === undefined) delete process.env.NODEDEX_V2_JUDGE; else process.env.NODEDEX_V2_JUDGE = prev;
  });
});

describe("v2JudgeContextEnabled — default OFF (context-aware judge, opt-in)", () => {
  test("unset → false; =1 → true; =0 → false", () => {
    const prev = process.env.NODEDEX_V2_JUDGE_CONTEXT;
    delete process.env.NODEDEX_V2_JUDGE_CONTEXT; assert.equal(v2JudgeContextEnabled(), false);
    process.env.NODEDEX_V2_JUDGE_CONTEXT = "1"; assert.equal(v2JudgeContextEnabled(), true);
    process.env.NODEDEX_V2_JUDGE_CONTEXT = "0"; assert.equal(v2JudgeContextEnabled(), false);
    if (prev === undefined) delete process.env.NODEDEX_V2_JUDGE_CONTEXT; else process.env.NODEDEX_V2_JUDGE_CONTEXT = prev;
  });
});

describe("buildRoleContext — each block's structural role (needed-by / builds-on)", () => {
  test("a based_on edge → target is needed-by, source builds-on (by neighbour type)", () => {
    const A = mkItem("A", { type: "fact" });
    const B = mkItem("B", { type: "decision", based_on_items: ["A"] });
    const roles = buildRoleContext([A, B]);
    assert.equal(roles["A"], "needed-by decision"); // a decision rests on A → load-bearing
    assert.equal(roles["B"], "builds-on fact");
  });
  test("multiple dependents collapse with ×N counts", () => {
    const A = mkItem("A", { type: "fact" });
    const B = mkItem("B", { type: "decision", based_on_items: ["A"] });
    const C = mkItem("C", { type: "decision", based_on_items: ["A"] });
    assert.equal(buildRoleContext([A, B, C])["A"], "needed-by decision×2");
  });
  test("isolated block → no entry (judged on text alone)", () => {
    assert.deepEqual(buildRoleContext([mkItem("x"), mkItem("y")]), {});
  });
  test("refs to out-of-set ids are ignored (external labels never match)", () => {
    const A = mkItem("A", { type: "decision", based_on_items: ["not-in-set"] });
    assert.deepEqual(buildRoleContext([A]), {});
  });
});

describe("applyV2JudgeVerdicts", () => {
  test("judge=null → keep all (a failed selector must never drop residue)", () => {
    const items = [mkItem("a"), mkItem("b")];
    const out = applyV2JudgeVerdicts(items, null);
    assert.equal(out.kept.length, 2);
    assert.equal(out.droppedCount, 0);
  });

  test("drops DROP-verdicted items with no dependents", () => {
    const items = [mkItem("a"), mkItem("b")];
    const judge: PassJudgeResult = { verdicts: [KEEP("a"), DROP("b")] };
    const out = applyV2JudgeVerdicts(items, judge);
    assert.deepEqual(out.kept.map((i) => i.id), ["a"]);
    assert.equal(out.droppedCount, 1);
  });

  test("ANCHOR-OVERRIDE: a kept decision's based_on evidence is rescued (no islanding)", () => {
    const dec = mkItem("dec", { type: "decision", based_on_items: ["ev"] });
    const ev = mkItem("ev");
    const judge: PassJudgeResult = { verdicts: [KEEP("dec"), DROP("ev")] };
    const out = applyV2JudgeVerdicts([dec, ev], judge);
    assert.deepEqual(out.kept.map((i) => i.id).sort(), ["dec", "ev"]); // ev rescued
    assert.equal(out.rescued, 1);
    assert.deepEqual(dec.based_on_items, ["ev"]);                       // edge preserved
  });

  test("rescue is transitive (fixpoint): kept → ev1 → ev2 all kept", () => {
    const dec = mkItem("dec", { type: "decision", based_on_items: ["ev1"] });
    const ev1 = mkItem("ev1", { based_on_items: ["ev2"] });
    const ev2 = mkItem("ev2");
    const judge: PassJudgeResult = { verdicts: [KEEP("dec"), DROP("ev1"), DROP("ev2")] };
    const out = applyV2JudgeVerdicts([dec, ev1, ev2], judge);
    assert.deepEqual(out.kept.map((i) => i.id).sort(), ["dec", "ev1", "ev2"]);
    assert.equal(out.rescued, 2);
  });

  test("WEAK relation to a dropped item is NOT rescued — it's cleaned (no dangling edge)", () => {
    const a = mkItem("a", { relations: [{ type: "related_to", target: "b" }] });
    const b = mkItem("b");
    const judge: PassJudgeResult = { verdicts: [KEEP("a"), DROP("b")] };
    const out = applyV2JudgeVerdicts([a, b], judge);
    assert.deepEqual(out.kept.map((i) => i.id), ["a"]);   // b dropped (weak link doesn't rescue)
    assert.deepEqual(a.relations, []);                     // dangling related_to cleaned
  });
});

describe("runV2Judge — per-group, parallel (stubbed judge)", () => {
  // Echo mock: emits a verdict per item id it actually sees (DROP if the id contains
  // "drop", else KEEP), and counts calls so we can assert ONE call PER GROUP.
  function judgeMock() {
    let calls = 0;
    const provider: any = {
      isAvailable: () => true,
      generateStructured: async (_sys: string, userInput: string) => {
        calls++;
        const ids = [...userInput.matchAll(/"id":\s*"([^"]+)"/g)].map((m) => m[1]);
        const verdicts = ids.map((id) => id.includes("drop")
          ? { item_id: id, verdict: "DROP", reason_category: "general_knowledge" }
          : { item_id: id, verdict: "KEEP", reason_category: "path_specific_residue" });
        return { result: { verdicts }, rateLimited: false, usage: {}, attempts: [{ model: "m", outcome: "ok" }] };
      },
    };
    return { provider, calls: () => calls };
  }

  test("one call PER GROUP (parallel), verdicts merged across groups", async () => {
    const { provider, calls } = judgeMock();
    const items = [mkItem("g1::keep-a"), mkItem("g1::keep-b"), mkItem("g2::drop-c")];
    const out = await runV2Judge(provider, items, "transcript");
    assert.equal(out.ran, true);
    assert.equal(calls(), 2);                                              // g1 + g2 → 2 calls
    assert.deepEqual(out.kept.map((i) => i.id).sort(), ["g1::keep-a", "g1::keep-b"]);
    assert.equal(out.droppedCount, 1);                                    // g2::drop-c
  });

  test("a group whose judge FAILS keeps its items (recall guard); other groups still filter", async () => {
    const provider: any = {
      isAvailable: () => true,
      generateStructured: async (_sys: string, userInput: string) => {
        if (userInput.includes("fail")) return { result: null, rateLimited: false, attempts: [{ model: "m", outcome: "truncated" }] };
        const ids = [...userInput.matchAll(/"id":\s*"([^"]+)"/g)].map((m) => m[1]);
        return { result: { verdicts: ids.map((id) => ({ item_id: id, verdict: id.includes("drop") ? "DROP" : "KEEP", reason_category: id.includes("drop") ? "general_knowledge" : "path_specific_residue" })) }, rateLimited: false, attempts: [{ model: "m", outcome: "ok" }] };
      },
    };
    const items = [mkItem("g1::drop-x"), mkItem("g2::fail-y"), mkItem("g2::fail-z")];
    const out = await runV2Judge(provider, items, "transcript");
    assert.deepEqual(out.kept.map((i) => i.id).sort(), ["g2::fail-y", "g2::fail-z"]); // g1 filtered, g2 kept on failure
    assert.equal(out.ran, true);
  });

  test("no-op (keep all) for <2 items", async () => {
    const { provider } = judgeMock();
    const out = await runV2Judge(provider, [mkItem("g1::a")], "transcript");
    assert.equal(out.ran, false);
    assert.equal(out.kept.length, 1);
  });

  test("MALFORMED judge result (truthy but no verdicts[]) → keep all, no throw (seam contract)", async () => {
    // Provider variance can return a truthy object missing verdicts[]; consuming it
    // crashed the whole v2 front-half (.filter on undefined, 2026-06-11). The seam
    // check in callPassJudgeLLM must treat it as a failed judge → KEEP-ALL degrade.
    const provider: any = {
      isAvailable: () => true,
      generateStructured: async () => ({ result: {}, rateLimited: false, usage: {}, attempts: [{ model: "m", outcome: "ok" }] }),
    };
    const items = [mkItem("g1::a"), mkItem("g1::b"), mkItem("g2::c")];
    const out = await runV2Judge(provider, items, "transcript");
    assert.equal(out.kept.length, 3);          // nothing dropped
    assert.equal(out.droppedCount, 0);
  });
});
