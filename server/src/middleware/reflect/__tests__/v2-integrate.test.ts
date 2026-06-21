// Unit tests for the v2 INTEGRATE root-recognition wiring (v2-integrate.ts).
// No real DB, no real LLM — stubs the WorkspaceDB.getAllBlocks scan + the
// provider.generateStructured recognizer call. The recognizer's own guards/remap
// are covered in recognize-root.test.ts; here we lock the v2-side GLUE:
//   flag OFF → passthrough · no roots → passthrough · confident attach → remap ·
//   "new"/"uncertain" verdict → keep (no remap).

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { Pass2Item } from "../types.js";
import type { RecognizerVerdict } from "../recognize-root.js";
import { integrateV2Roots, loadKnownRoots, runComprehendFrontHalf, mergeCrossGroupDups, mergeCrossGroupDupsEnabled, chooseHolistic, holisticMaxChars, v2CrossLinkFirstEnabled } from "../v2-integrate.js";

// ─── env helper (the flag the wiring + the live path share) ────────────────────
async function withRecognizer(on: boolean, fn: () => Promise<void>): Promise<void> {
  const prev = process.env.NODEDEX_RECOGNIZER_ENABLED;
  // off = explicit "0" (default is ON since 2026-06-12 — deleting the var means ON)
  process.env.NODEDEX_RECOGNIZER_ENABLED = on ? "1" : "0";
  try {
    await fn();
  } finally {
    if (prev === undefined) delete process.env.NODEDEX_RECOGNIZER_ENABLED;
    else process.env.NODEDEX_RECOGNIZER_ENABLED = prev;
  }
}

// ─── stubs ─────────────────────────────────────────────────────────────────────
function fakeDb(blocks: any[]): { db: any; calls: () => number } {
  let n = 0;
  return {
    db: { getAllBlocks: () => { n++; return blocks; } },
    calls: () => n,
  };
}

function fakeProvider(verdict: RecognizerVerdict | null): { provider: any; calls: () => number } {
  let n = 0;
  return {
    provider: {
      isAvailable: () => true,
      generateStructured: async () => {
        n++;
        return { result: verdict, rateLimited: false, usage: { input: 0, thinking: 0, output: 0 } };
      },
    },
    calls: () => n,
  };
}

const ROOT = { type: "project", label: "coffee-roasting", essence: "Home coffee roasting — equipment + methods, personal." };
const NON_ROOT = { type: "decision", label: "x_decision_y", essence: "leaf" };

function clusterItems(): Pass2Item[] {
  return [
    { id: "g1::b1", project: "coffee-roasting-setup", type: "decision", text: "chose the fluid-bed roaster" },
    { id: "g1::b2", project: "coffee-roasting-setup", type: "fact", text: "fluid-bed tops out around 250g" },
  ] as unknown as Pass2Item[];
}

function attachVerdict(): RecognizerVerdict {
  return { decision: "attach", matched_root: "coffee-roasting", same_owner: true, shared_subject: "the user's home coffee-roasting setup", reasoning: "same domain + same (personal) owner" };
}

// ─── loadKnownRoots ──────────────────────────────────────────────────────────────
describe("loadKnownRoots", () => {
  test("maps only type:'project' blocks → {label, essence}", () => {
    const { db } = fakeDb([ROOT, NON_ROOT]);
    assert.deepEqual(loadKnownRoots(db), [
      { label: "coffee-roasting", essence: ROOT.essence },
    ]);
  });

  test("missing essence → empty string (never undefined)", () => {
    const { db } = fakeDb([{ type: "project", label: "bare-root" }]);
    assert.deepEqual(loadKnownRoots(db), [{ label: "bare-root", essence: "" }]);
  });
});

// ─── integrateV2Roots ────────────────────────────────────────────────────────────
describe("integrateV2Roots — flag gate (default ON; =0 opts out)", () => {
  test("flag OFF → passthrough, no DB scan, no LLM call", async () => {
    await withRecognizer(false, async () => {
      const items = clusterItems();
      const { db, calls: dbCalls } = fakeDb([ROOT]);
      const { provider, calls: llmCalls } = fakeProvider(attachVerdict());
      const out = await integrateV2Roots(db, provider, items);
      assert.equal(out.ran, false);
      assert.equal(out.rewritten, 0);
      assert.equal(out.recognition, null);
      assert.equal(out.items, items);          // same reference
      assert.equal(dbCalls(), 0);              // never scanned the graph
      assert.equal(llmCalls(), 0);             // never called the model
    });
  });
});

describe("integrateV2Roots — ON path", () => {
  test("no existing roots → passthrough (nothing to attach to), no LLM call", async () => {
    await withRecognizer(true, async () => {
      const items = clusterItems();
      const { db } = fakeDb([NON_ROOT]); // no type:'project' blocks
      const { provider, calls: llmCalls } = fakeProvider(attachVerdict());
      const out = await integrateV2Roots(db, provider, items);
      assert.equal(out.ran, false);
      assert.equal(out.rewritten, 0);
      assert.equal(llmCalls(), 0);
      assert.equal((out.items[0] as any).project, "coffee-roasting-setup"); // unchanged
    });
  });

  test("confident attach → remaps the cluster's .project to the existing root", async () => {
    await withRecognizer(true, async () => {
      const items = clusterItems();
      const { db } = fakeDb([ROOT]);
      const { provider } = fakeProvider(attachVerdict());
      const out = await integrateV2Roots(db, provider, items);
      assert.equal(out.ran, true);
      assert.equal(out.rewritten, 2);
      assert.equal((out.items[0] as any).project, "coffee-roasting");
      assert.equal((out.items[1] as any).project, "coffee-roasting");
      assert.equal(out.recognition?.attached, 1);
      assert.equal(out.recognition?.candidates, 1);
    });
  });

  test("verdict 'new' → keep (no remap; the safe fork)", async () => {
    await withRecognizer(true, async () => {
      const items = clusterItems();
      const { db } = fakeDb([ROOT]);
      const { provider } = fakeProvider({ decision: "new", matched_root: "", same_owner: false, reasoning: "genuinely separate" });
      const out = await integrateV2Roots(db, provider, items);
      assert.equal(out.ran, true);
      assert.equal(out.rewritten, 0);
      assert.equal((out.items[0] as any).project, "coffee-roasting-setup"); // unchanged
      assert.equal(out.recognition?.attached, 0);
    });
  });

  test("verdict 'uncertain' → keep (bias-to-fork)", async () => {
    await withRecognizer(true, async () => {
      const items = clusterItems();
      const { db } = fakeDb([ROOT]);
      const { provider } = fakeProvider({ decision: "uncertain", matched_root: "coffee-roasting", same_owner: true, reasoning: "weak fit" });
      const out = await integrateV2Roots(db, provider, items);
      assert.equal(out.ran, true);
      assert.equal(out.rewritten, 0);
      assert.equal((out.items[0] as any).project, "coffee-roasting-setup"); // unchanged
    });
  });
});

// ─── runComprehendFrontHalf — degrade paths (success path = harness e2e) ────────
// Each returns checkpoint=null so the live arc caller falls back to v1.
function frontHalfProvider(comprehendResult: any): any {
  return {
    isAvailable: () => true,
    generateStructured: async () => ({ result: comprehendResult, rateLimited: false, usage: { input: 0, thinking: 0, output: 0 } }),
  };
}
const noDb: any = { getAllBlocks: () => [] };

describe("runComprehendFrontHalf — degrade to v1 (checkpoint=null)", () => {
  test("COMPREHEND failed → null, reason comprehend_failed", async () => {
    const out = await runComprehendFrontHalf(noDb, frontHalfProvider(null), "t");
    assert.equal(out.checkpoint, null);
    assert.equal(out.reason, "comprehend_failed");
  });

  // 2026-06-12: a dangling link is a WARNING now (dropped at convert) — it no
  // longer degrades the arc. The seam1_invalid path still exists for BLOCK-level
  // breaks; missing provenance (the anti-confab key, unrepairable) is the fixture.
  test("SEAM 1 invalid (block missing provenance) → null, reason seam1_invalid", async () => {
    const bad = { groups: [{ group_id: "g1", topic: "t",
      blocks: [{ local_id: "b1", type: "fact", unique: { value: "x" }, essence: "e", provenance: "" }],
      within_group_links: [] }] };
    const out = await runComprehendFrontHalf(noDb, frontHalfProvider(bad), "t");
    assert.equal(out.checkpoint, null);
    assert.equal(out.reason, "seam1_invalid");
  });

  test("a dangling link endpoint does NOT degrade — blocks proceed, link dropped", async () => {
    const oneBadLink = { groups: [{ group_id: "g1", topic: "t",
      blocks: [{ local_id: "b1", type: "fact", unique: { value: "x" }, essence: "e", provenance: "p" }],
      within_group_links: [{ from: "b1", to: "ghost", type: "based_on" }] }] };
    const out = await runComprehendFrontHalf(noDb, frontHalfProvider(oneBadLink), "t");
    assert.notEqual(out.checkpoint, null, "one droppable link must not cost the arc");
    assert.equal(out.blocks, 1);
    assert.deepEqual(out.checkpoint!.pass2Classified![0].based_on_items, [], "the bad link was dropped, not wired");
  });

  test("checkpoint carries v2 stage wall-time telemetry (observability before optimization)", async () => {
    const ok = { groups: [{ group_id: "g1", topic: "t",
      blocks: [{ local_id: "b1", type: "fact", unique: { value: "x" }, essence: "e", provenance: "p" }],
      within_group_links: [] }] };
    const out = await runComprehendFrontHalf(noDb, frontHalfProvider(ok), "t");
    assert.notEqual(out.checkpoint, null);
    const wall = out.checkpoint!.v2WallMs!;
    assert.ok(wall, "front-half must report stage timings");
    for (const k of ["v2_comprehend", "v2_fill_2b", "v2_justify", "v2_crosslink", "v2_integrate"]) {
      assert.ok(typeof wall[k] === "number" && wall[k] >= 0, `missing stage timing: ${k}`);
    }
  });

  test("empty groups (no residue) → null, reason empty", async () => {
    const out = await runComprehendFrontHalf(noDb, frontHalfProvider({ groups: [] }), "t");
    assert.equal(out.checkpoint, null);
    assert.equal(out.reason, "empty");
  });
});

// ─── mergeCrossGroupDups (Shape B — collapse cross-group duplicates) ────────────
function mkI(over: Partial<Pass2Item> & { id: string; type: string }): Pass2Item {
  return { text: "", triggered_by_items: [], based_on_items: [], relations: [], ...over } as Pass2Item;
}

describe("mergeCrossGroupDupsEnabled — default ON (v2 promoted 2026-06-12)", () => {
  test("unset → true; =0 → false; =1 → true", () => {
    const prev = process.env.NODEDEX_V2_MERGE_DUPS;
    delete process.env.NODEDEX_V2_MERGE_DUPS;
    assert.equal(mergeCrossGroupDupsEnabled(), true);
    process.env.NODEDEX_V2_MERGE_DUPS = "0";
    assert.equal(mergeCrossGroupDupsEnabled(), false);
    process.env.NODEDEX_V2_MERGE_DUPS = "1";
    assert.equal(mergeCrossGroupDupsEnabled(), true);
    if (prev === undefined) delete process.env.NODEDEX_V2_MERGE_DUPS; else process.env.NODEDEX_V2_MERGE_DUPS = prev;
  });
});

describe("v2CrossLinkFirstEnabled — default ON (promoted 2026-06-14); =0 opts out", () => {
  test("unset → true; =1 → true; =0 → false", () => {
    const prev = process.env.NODEDEX_V2_CROSSLINK_FIRST;
    delete process.env.NODEDEX_V2_CROSSLINK_FIRST;
    assert.equal(v2CrossLinkFirstEnabled(), true);
    process.env.NODEDEX_V2_CROSSLINK_FIRST = "1";
    assert.equal(v2CrossLinkFirstEnabled(), true);
    process.env.NODEDEX_V2_CROSSLINK_FIRST = "0";
    assert.equal(v2CrossLinkFirstEnabled(), false);
    if (prev === undefined) delete process.env.NODEDEX_V2_CROSSLINK_FIRST; else process.env.NODEDEX_V2_CROSSLINK_FIRST = prev;
  });
});

describe("chooseHolistic — size decides unless the caller forces a mode", () => {
  test("small input → holistic; big input → per-group eligible", () => {
    const prev = process.env.NODEDEX_V2_HOLISTIC_MAX_CHARS;
    delete process.env.NODEDEX_V2_HOLISTIC_MAX_CHARS;
    assert.equal(holisticMaxChars(), 20000);
    assert.equal(chooseHolistic(5000), true);          // a small arc fits one call
    assert.equal(chooseHolistic(20000), true);         // boundary inclusive
    assert.equal(chooseHolistic(20001), false);        // big arc → per-group (truncate risk)
    if (prev === undefined) delete process.env.NODEDEX_V2_HOLISTIC_MAX_CHARS; else process.env.NODEDEX_V2_HOLISTIC_MAX_CHARS = prev;
  });

  test("caller's explicit opts.holistic always wins over size", () => {
    assert.equal(chooseHolistic(999999, true), true);  // per-turn caller forces holistic
    assert.equal(chooseHolistic(10, false), false);    // a caller may force per-group
  });

  test("threshold is env-tunable", () => {
    const prev = process.env.NODEDEX_V2_HOLISTIC_MAX_CHARS;
    process.env.NODEDEX_V2_HOLISTIC_MAX_CHARS = "100";
    assert.equal(chooseHolistic(101), false);
    assert.equal(chooseHolistic(100), true);
    if (prev === undefined) delete process.env.NODEDEX_V2_HOLISTIC_MAX_CHARS; else process.env.NODEDEX_V2_HOLISTIC_MAX_CHARS = prev;
  });
});

describe("mergeCrossGroupDups — collapse on stable primary_value", () => {
  test("same type+primary_value across groups, DIFFERENT essence → 1 survivor (the real case)", () => {
    // The crux: per-group PRODUCE writes a different essence each time, but the
    // approach (primary_value) is identical → keyed on primary_value, they merge.
    const a1 = mkI({ id: "g1::a", type: "dead_end", unique: { approach: "Fixed Window Counter", reason: "boundary bursts" }, text: "fixed window rejected — boundary bursts", based_on_items: ["g1::x"] });
    const a2 = mkI({ id: "g2::a", type: "dead_end", unique: { approach: "Fixed Window Counter", reason: "susceptibility" }, text: "fixed window rejected — different wording", based_on_items: ["g2::y"] });
    const b  = mkI({ id: "g2::b", type: "decision", unique: { choice: "token bucket" }, text: "token bucket", based_on_items: ["g2::a"] }); // refs the dropped copy
    const out = mergeCrossGroupDups([a1, a2, b]);
    assert.equal(out.merged, 1);
    assert.deepEqual(out.items.map((i) => i.id), ["g1::a", "g2::b"]);   // a2 collapsed into a1
    assert.ok(a1.based_on_items.includes("g1::x") && a1.based_on_items.includes("g2::y"), "survivor unions both copies' links");
    assert.deepEqual(b.based_on_items, ["g1::a"], "ref to dropped copy re-pointed to survivor");
  });

  test("DIFFERENT primary_value → NOT merged (distinct claims)", () => {
    const d1 = mkI({ id: "g1::d", type: "dead_end", unique: { approach: "Fixed Window Counter" }, text: "x" });
    const d2 = mkI({ id: "g2::d", type: "dead_end", unique: { approach: "Leaky Bucket" }, text: "y" });
    const out = mergeCrossGroupDups([d1, d2]);
    assert.equal(out.merged, 0);
    assert.equal(out.items.length, 2);
  });

  test("empty unique{} (no primary_value yet) → never merged", () => {
    const e1 = mkI({ id: "g1::e", type: "dead_end", unique: {}, text: "same essence" });
    const e2 = mkI({ id: "g2::e", type: "dead_end", unique: {}, text: "same essence" });
    assert.equal(mergeCrossGroupDups([e1, e2]).merged, 0);
  });

  test("no dups → passthrough (same array, merged 0)", () => {
    const items = [mkI({ id: "g1::a", type: "fact", unique: { value: "v1" }, text: "a" }), mkI({ id: "g1::b", type: "fact", unique: { value: "v2" }, text: "b" })];
    const out = mergeCrossGroupDups(items);
    assert.equal(out.merged, 0);
    assert.equal(out.items, items);
  });
});
