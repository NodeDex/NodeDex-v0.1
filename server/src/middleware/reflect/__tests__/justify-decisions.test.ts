// Unit tests for v2 JUSTIFY (grounded-conclusion → based_on repair). No real LLM —
// detect/apply/build are pure; the orchestrator uses a stubbed provider.
// Locks the seam contracts: detect ONLY empty-based_on grounded types (decision /
// hypothesis / insight; preference excluded) · candidates scoped to the conclusion's
// OWN group · cited ids sanitized against the offered set · existing links never
// overwritten · legitimate-empty stays unwired · malformed result → no-op · flag default ON.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { Pass2Item } from "../types.js";
import {
  v2JustifyEnabled,
  findUngroundedConclusions,
  applyJustifications,
  buildJustifyInput,
  runJustifyConclusions,
  type JustifyVerdict,
} from "../justify-decisions.js";

function mkItem(id: string, type: string, extra: Partial<Pass2Item> = {}): Pass2Item {
  return { id, text: `text of ${id}`, type, triggered_by_items: [], based_on_items: [], relations: [], ...extra } as Pass2Item;
}

async function withFlag(on: boolean, fn: () => Promise<void> | void): Promise<void> {
  const prev = process.env.NODEDEX_V2_JUSTIFY;
  // off = explicit "0" (default is ON since 2026-06-12 — deleting the var means ON)
  process.env.NODEDEX_V2_JUSTIFY = on ? "1" : "0";
  try { await fn(); } finally {
    if (prev === undefined) delete process.env.NODEDEX_V2_JUSTIFY; else process.env.NODEDEX_V2_JUSTIFY = prev;
  }
}

describe("v2JustifyEnabled — default ON (v2 promoted 2026-06-12)", () => {
  test("unset → true; =0 → false; =1 → true", async () => {
    const prev = process.env.NODEDEX_V2_JUSTIFY;
    delete process.env.NODEDEX_V2_JUSTIFY;
    assert.equal(v2JustifyEnabled(), true);
    if (prev !== undefined) process.env.NODEDEX_V2_JUSTIFY = prev;
    await withFlag(false, () => assert.equal(v2JustifyEnabled(), false));
    await withFlag(true, () => assert.equal(v2JustifyEnabled(), true));
  });
});

describe("findUngroundedConclusions — gets the RIGHT candidates", () => {
  test("grounded types (decision/hypothesis/insight) with EMPTY based_on; others excluded", () => {
    const items = [
      mkItem("g1::d1", "decision"),                                    // unjustified → found
      mkItem("g1::d2", "decision", { based_on_items: ["g1::f1"] }),    // already wired → skip
      mkItem("g1::h1", "hypothesis"),                                  // ungrounded hypothesis → found
      mkItem("g1::i1", "insight"),                                     // ungrounded insight → found
      mkItem("g1::f1", "fact"),                                        // fact (evidence, not a conclusion) → skip
      mkItem("g1::p1", "preference"),                                  // preference excluded by design
      mkItem("g1::d3", "decision", { based_on_items: undefined as any }), // missing array → found
    ];
    assert.deepEqual(findUngroundedConclusions(items).map((i) => i.id), ["g1::d1", "g1::h1", "g1::i1", "g1::d3"]);
  });
});

describe("buildJustifyInput — candidates scoped to the conclusion's OWN group", () => {
  test("offers same-group siblings only, never the conclusion itself", () => {
    const items = [
      mkItem("g1::d1", "decision"),
      mkItem("g1::f1", "fact"),
      mkItem("g2::f2", "fact"),   // OTHER group → not offered to g1::d1
    ];
    const { offered, input } = buildJustifyInput([items[0]!], items);
    const set = offered.get("g1::d1")!;
    assert.deepEqual([...set], ["g1::f1"]);
    assert.ok(input.includes("CONCLUSION g1::d1"));
    assert.ok(input.includes("g1::f1"));
    assert.ok(!input.includes("g2::f2"));
  });

  test("explicit groupByItemId map wins over the id-prefix fallback", () => {
    const items = [mkItem("a", "decision"), mkItem("b", "fact"), mkItem("c", "fact")];
    const { offered } = buildJustifyInput([items[0]!], items, { a: "t1", b: "t1", c: "t2" });
    assert.deepEqual([...offered.get("a")!], ["b"]); // c is in t2 → excluded
  });
});

describe("applyJustifications — outputs only the RIGHT links", () => {
  const offered = new Map([["g1::d1", new Set(["g1::f1", "g1::f2"]) as ReadonlySet<string>]]);

  test("fills sanitized ids: drops unknown, self, duplicate; keeps offered", () => {
    const items = [mkItem("g1::d1", "decision"), mkItem("g1::f1", "fact"), mkItem("g1::f2", "fact")];
    const verdicts: JustifyVerdict[] = [{
      conclusion_id: "g1::d1",
      evidence_ids: ["g1::f1", "g1::f1", "g1::d1", "hallucinated", "g1::f2"],
      reasoning: "r",
    }];
    const repaired = applyJustifications(items, verdicts, offered);
    assert.equal(repaired, 1);
    assert.deepEqual(items[0]!.based_on_items, ["g1::f1", "g1::f2"]);
  });

  test("legitimate-empty: no evidence in the list → stays unwired, not repaired", () => {
    const items = [mkItem("g1::d1", "decision")];
    const repaired = applyJustifications(items, [{ conclusion_id: "g1::d1", evidence_ids: [], reasoning: "out of scope" }], offered);
    assert.equal(repaired, 0);
    assert.deepEqual(items[0]!.based_on_items, []);
  });

  test("NEVER overwrites existing links (repair fills absence only)", () => {
    const items = [mkItem("g1::d1", "decision", { based_on_items: ["already"] })];
    const repaired = applyJustifications(items, [{ conclusion_id: "g1::d1", evidence_ids: ["g1::f1"], reasoning: "r" }], offered);
    assert.equal(repaired, 0);
    assert.deepEqual(items[0]!.based_on_items, ["already"]);
  });

  test("verdicts for conclusions never asked about are ignored", () => {
    const items = [mkItem("g1::other", "decision")];
    const repaired = applyJustifications(items, [{ conclusion_id: "g1::other", evidence_ids: ["g1::f1"], reasoning: "r" }], offered);
    assert.equal(repaired, 0); // not in the offered map → not asked → ignored
  });
});

describe("runJustifyConclusions — orchestrator (stubbed provider)", () => {
  test("flag OFF → passthrough, zero provider calls", async () => {
    let calls = 0;
    const provider: any = { generateStructured: async () => { calls++; return { result: null }; } };
    await withFlag(false, async () => {
      const out = await runJustifyConclusions(provider, [mkItem("g1::d1", "decision"), mkItem("g1::f1", "fact")]);
      assert.deepEqual(out, { ran: false, ungrounded: 0, repaired: 0 });
      assert.equal(calls, 0);
    });
  });

  test("repairs decision AND hypothesis via ONE batched call; wired conclusions untouched", async () => {
    let calls = 0;
    const provider: any = {
      generateStructured: async (_sys: string, userInput: string) => {
        calls++;
        // echo mock: justify every CONCLUSION it sees with its first candidate id
        const verdicts = [...userInput.matchAll(/CONCLUSION (\S+) \[/g)].map((m) => {
          const sect = userInput.slice(m.index);
          const cand = sect.match(/- (\S+) \[/)?.[1] ?? "";
          return { conclusion_id: m[1], evidence_ids: cand ? [cand] : [], reasoning: "grounded" };
        });
        return { result: { justifications: verdicts }, rateLimited: false };
      },
    };
    const items = [
      mkItem("g1::d1", "decision"),
      mkItem("g1::f1", "fact"),
      mkItem("g2::h2", "hypothesis"),                              // ungrounded hypothesis (new coverage)
      mkItem("g2::f2", "fact"),
      mkItem("g2::d3", "decision", { based_on_items: ["g2::f2"] }), // already wired
    ];
    await withFlag(true, async () => {
      const out = await runJustifyConclusions(provider, items);
      assert.equal(calls, 1);                                  // ONE batched call
      assert.deepEqual(out, { ran: true, ungrounded: 2, repaired: 2 });
      assert.deepEqual(items[0]!.based_on_items, ["g1::f1"]);  // g1 candidate
      assert.deepEqual(items[2]!.based_on_items, ["g2::f2"]);  // hypothesis grounded in own-group fact
      assert.deepEqual(items[4]!.based_on_items, ["g2::f2"]);  // untouched
    });
  });

  test("MALFORMED result (truthy, no justifications[]) → no-op, no throw", async () => {
    const provider: any = { generateStructured: async () => ({ result: {}, rateLimited: false }) };
    const items = [mkItem("g1::d1", "decision"), mkItem("g1::f1", "fact")];
    await withFlag(true, async () => {
      const out = await runJustifyConclusions(provider, items);
      assert.deepEqual(out, { ran: true, ungrounded: 1, repaired: 0 });
      assert.deepEqual(items[0]!.based_on_items, []);
    });
  });

  test("provider throw → degrade (conclusions left as-is), no crash", async () => {
    const provider: any = { generateStructured: async () => { throw new Error("boom"); } };
    const items = [mkItem("g1::d1", "decision"), mkItem("g1::f1", "fact")];
    await withFlag(true, async () => {
      const out = await runJustifyConclusions(provider, items);
      assert.deepEqual(out, { ran: true, ungrounded: 1, repaired: 0 });
    });
  });

  test("nothing ungrounded → no LLM call at all", async () => {
    let calls = 0;
    const provider: any = { generateStructured: async () => { calls++; return { result: null }; } };
    const items = [mkItem("g1::d1", "decision", { based_on_items: ["g1::f1"] }), mkItem("g1::f1", "fact")];
    await withFlag(true, async () => {
      const out = await runJustifyConclusions(provider, items);
      assert.equal(calls, 0);
      assert.deepEqual(out, { ran: false, ungrounded: 0, repaired: 0 });
    });
  });
});
