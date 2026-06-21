/**
 * Tests for foldConstituentFacts — the granularity fix (fold a sole-constituent
 * reason-fact INTO the state-change unit it justifies, instead of building it as
 * a redundant standalone block). See [[project-fragmentation-not-worth-fold-2026-06-04]].
 *
 * Run: node --import=tsx/esm --test src/middleware/reflect/__tests__/fold-constituents.test.ts
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { foldConstituentFacts } from "../pipeline.js";
import type { Pass2Item } from "../types.js";

const mk = (id: string, type: string, text: string, extras: Partial<Pass2Item> = {}): Pass2Item => ({
  id, type, text,
  triggered_by_items: extras.triggered_by_items ?? [],
  based_on_items: extras.based_on_items ?? [],
  ...extras,
});

describe("foldConstituentFacts", () => {
  test("folds a sole-constituent reason-fact into the decision and enriches its reason", () => {
    const items = [
      mk("d1", "decision", "Use raised beds", { based_on_items: ["f1"], unique: { choice: "raised beds", reason: "more control" } }),
      mk("f1", "fact", "raised beds drain better"),
    ];
    const { kept, folded } = foldConstituentFacts(items);
    assert.equal(kept.length, 1);
    assert.equal(kept[0].id, "d1");
    assert.equal(folded.length, 1);
    assert.equal(folded[0].id, "f1");
    assert.equal(folded[0].foldedInto, "d1");
    assert.equal(folded[0].enriched, true);
    assert.match(kept[0].unique!.reason, /raised beds drain better/);
    // the now-absorbed based_on edge to f1 must be stripped (f1 is never built)
    assert.deepEqual(kept[0].based_on_items, []);
  });

  test("does NOT fold a fact referenced by two units (shared anchor stays a block)", () => {
    const items = [
      mk("d1", "decision", "buy small batches", { based_on_items: ["f1"], unique: { choice: "buy small", reason: "" } }),
      mk("d2", "decision", "avoid old stock", { based_on_items: ["f1"], unique: { choice: "avoid old", reason: "" } }),
      mk("f1", "fact", "green coffee holds 6-12 months"),
    ];
    const { kept, folded } = foldConstituentFacts(items);
    assert.equal(folded.length, 0);
    assert.equal(kept.length, 3);
  });

  test("folds a fact already present in the rationale without duplicating the text (enriched=false)", () => {
    const items = [
      mk("d1", "decision", "fluid-bed roaster", { based_on_items: ["f1"], unique: { choice: "fluid-bed", reason: "faster heat-up, easier chaff cleanup" } }),
      mk("f1", "fact", "easier chaff cleanup"),
    ];
    const { kept, folded } = foldConstituentFacts(items);
    assert.equal(folded.length, 1);
    assert.equal(folded[0].enriched, false);
    assert.equal(kept[0].unique!.reason, "faster heat-up, easier chaff cleanup");
  });

  test("does NOT fold a fact that merely TRIGGERED a decision (often independently valuable)", () => {
    const items = [
      mk("d1", "decision", "defer feature X", { triggered_by_items: ["f1"], unique: { choice: "defer X", reason: "" } }),
      mk("f1", "fact", "budget was cut 40%"),
    ];
    const { kept, folded } = foldConstituentFacts(items);
    assert.equal(folded.length, 0);
    assert.equal(kept.length, 2);
  });

  test("does NOT fold a fact whose sole referrer is not a state-change unit (e.g. insight)", () => {
    const items = [
      mk("i1", "insight", "users churn on slow loads", { based_on_items: ["f1"] }),
      mk("f1", "fact", "p95 latency is 4s"),
    ];
    const { kept, folded } = foldConstituentFacts(items);
    assert.equal(folded.length, 0);
    assert.equal(kept.length, 2);
  });

  test("does NOT fold a fact that has its own outgoing reason edge (not a pure leaf)", () => {
    const items = [
      mk("d1", "decision", "X", { based_on_items: ["f1"], unique: { choice: "X", reason: "" } }),
      mk("f1", "fact", "derived claim", { based_on_items: ["f2"] }),
      mk("f2", "fact", "ground truth"),
    ];
    const { kept, folded } = foldConstituentFacts(items);
    assert.equal(folded.length, 0);
    assert.equal(kept.length, 3);
  });

  test("dead_end and constraint also absorb a sole reason-fact", () => {
    const items = [
      mk("de1", "dead_end", "tried drum roaster", { based_on_items: ["f1"], unique: { approach: "drum", reason: "" } }),
      mk("f1", "fact", "drum heats too slowly"),
      mk("c1", "constraint", "must roast under 12 min", { based_on_items: ["f2"], unique: { limit: "12 min", reason: "" } }),
      mk("f2", "fact", "beans scorch past 12 min"),
    ];
    const { kept, folded } = foldConstituentFacts(items);
    assert.equal(folded.length, 2);
    assert.equal(kept.length, 2);
    assert.match(kept.find(i => i.id === "de1")!.unique!.reason, /drum heats too slowly/);
    assert.match(kept.find(i => i.id === "c1")!.unique!.reason, /beans scorch/);
  });

  test("multiple sole-constituent facts all fold into the same decision", () => {
    const items = [
      mk("d1", "decision", "use raised beds", { based_on_items: ["f1", "f2", "f3"], unique: { choice: "raised beds", reason: "" } }),
      mk("f1", "fact", "better drainage"),
      mk("f2", "fact", "soil control"),
      mk("f3", "fact", "easier weeding"),
    ];
    const { kept, folded } = foldConstituentFacts(items);
    assert.equal(folded.length, 3);
    assert.equal(kept.length, 1);
    assert.deepEqual(kept[0].based_on_items, []);
    const r = kept[0].unique!.reason;
    assert.match(r, /better drainage/);
    assert.match(r, /soil control/);
    assert.match(r, /easier weeding/);
  });

  test("no-op when a fact is unreferenced (no fold candidate)", () => {
    const items = [
      mk("d1", "decision", "X", { unique: { choice: "X", reason: "because" } }),
      mk("f1", "fact", "standalone fact"),
    ];
    const { kept, folded } = foldConstituentFacts(items);
    assert.equal(folded.length, 0);
    assert.equal(kept.length, 2);
  });

  test("does NOT fold a fact referenced via based_on by one unit AND extends by another (shared)", () => {
    const items = [
      mk("d1", "decision", "X", { based_on_items: ["f1"], unique: { choice: "X", reason: "" } }),
      mk("f2", "fact", "broader fact", { extends_item: "f1" }),
      mk("f1", "fact", "narrow fact"),
    ];
    const { kept, folded } = foldConstituentFacts(items);
    assert.equal(folded.length, 0);
    assert.equal(kept.length, 3);
  });
});
