// Unit tests for the CROSS-GROUP LINKER (cross-group-link.ts, design §15.4).
// No real LLM. Covers the gate, the input builder, and applyCrossGroupLinks — the
// guards (cross-thread only, valid id, no self, valid type) + that each relation
// lands in the RIGHT Pass2Item field (via the shared applyLinkToPass2Item).

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { Pass2Item } from "../types.js";
import {
  crossGroupLinkEnabled,
  buildCrossGroupLinkInput,
  unlinkedIds,
  applyCrossGroupLinks,
  runCrossGroupLink,
} from "../cross-group-link.js";

function mkItem(id: string, type: string): Pass2Item {
  return { id, text: `essence of ${id}`, type, triggered_by_items: [], based_on_items: [], relations: [] } as unknown as Pass2Item;
}
// two blocks in two different threads
function pair(): { items: Pass2Item[]; gbi: Record<string, string> } {
  return { items: [mkItem("gA::1", "decision"), mkItem("gB::2", "fact")], gbi: { "gA::1": "gA", "gB::2": "gB" } };
}

describe("crossGroupLinkEnabled — default ON (v2 promoted 2026-06-12)", () => {
  test("unset → true; =0 → false; =1 → true", () => {
    const prev = process.env.NODEDEX_V2_CROSSLINK;
    delete process.env.NODEDEX_V2_CROSSLINK;
    assert.equal(crossGroupLinkEnabled(), true);
    process.env.NODEDEX_V2_CROSSLINK = "0";
    assert.equal(crossGroupLinkEnabled(), false);
    process.env.NODEDEX_V2_CROSSLINK = "1";
    assert.equal(crossGroupLinkEnabled(), true);
    if (prev === undefined) delete process.env.NODEDEX_V2_CROSSLINK; else process.env.NODEDEX_V2_CROSSLINK = prev;
  });
});

describe("unlinkedIds — islands (no link at all) the linker should target", () => {
  test("isolated block is an island; a based_on edge un-islands BOTH ends", () => {
    const a = mkItem("gA::1", "decision"); (a as any).based_on_items = ["gB::2"];
    const b = mkItem("gB::2", "fact");
    const island = mkItem("gC::3", "blueprint"); // truly isolated
    const islands = unlinkedIds([a, b, island]);
    assert.equal(islands.has("gA::1"), false); // has an outgoing ref
    assert.equal(islands.has("gB::2"), false); // is a target
    assert.equal(islands.has("gC::3"), true);  // island
  });
  test("a ref to an out-of-set (existing-graph) label counts as connected", () => {
    const a = mkItem("gA::1", "decision"); (a as any).supersedes_ref = "existing-graph-label";
    assert.equal(unlinkedIds([a]).has("gA::1"), false);
  });
});

describe("buildCrossGroupLinkInput — orphan-aware marking (flag-gated, default OFF)", () => {
  const setFlag = (v?: string) => { if (v === undefined) delete process.env.NODEDEX_V2_CROSSLINK_ORPHAN_AWARE; else process.env.NODEDEX_V2_CROSSLINK_ORPHAN_AWARE = v; };
  test("flag ON → island gets ⚠ UNLINKED + count; connected block not marked", () => {
    const prev = process.env.NODEDEX_V2_CROSSLINK_ORPHAN_AWARE; setFlag("1");
    const a = mkItem("gA::1", "decision"); (a as any).based_on_items = ["gB::2"];
    const b = mkItem("gB::2", "fact");
    const island = mkItem("gC::3", "blueprint");
    const s = buildCrossGroupLinkInput([a, b, island], { "gA::1": "gA", "gB::2": "gB", "gC::3": "gC" });
    assert.ok(s.includes("gC::3 [blueprint] ⚠ UNLINKED"), "island marked");
    assert.ok(!s.includes("gA::1 [decision] ⚠ UNLINKED"), "connected block not marked");
    assert.ok(/1 block\(s\) are marked ⚠ UNLINKED/.test(s), "count noted");
    setFlag(prev);
  });
  test("flag OFF (default) → no marks (input byte-identical to before)", () => {
    const prev = process.env.NODEDEX_V2_CROSSLINK_ORPHAN_AWARE; setFlag(undefined);
    const s = buildCrossGroupLinkInput([mkItem("gC::3", "blueprint")], { "gC::3": "gC" });
    assert.ok(!s.includes("UNLINKED"), "no marking when flag off");
    setFlag(prev);
  });
});

describe("buildCrossGroupLinkInput", () => {
  test("groups blocks by thread and lists ids + types", () => {
    const { items, gbi } = pair();
    const s = buildCrossGroupLinkInput(items, gbi);
    assert.ok(s.includes("[thread: gA]"));
    assert.ok(s.includes("[thread: gB]"));
    assert.ok(s.includes("gA::1 [decision]"));
    assert.ok(s.includes("gB::2 [fact]"));
  });
});

describe("applyCrossGroupLinks — guards + right-field landing", () => {
  test("cross-thread based_on → lands in based_on_items", () => {
    const { items, gbi } = pair();
    const r = applyCrossGroupLinks(items, [{ from: "gA::1", to: "gB::2", type: "based_on" }], gbi);
    assert.equal(r.added, 1);
    assert.deepEqual(items[0].based_on_items, ["gB::2"]);
  });

  test("cross-thread supports → lands in relations[] {type,target,reasoning}", () => {
    const { items, gbi } = pair();
    applyCrossGroupLinks(items, [{ from: "gA::1", to: "gB::2", type: "supports", reasoning: "evidence" }], gbi);
    assert.deepEqual(items[0].relations, [{ type: "supports", target: "gB::2", reasoning: "evidence" }]);
  });

  test("SAME thread → skipped (within-thread links already exist)", () => {
    const items = [mkItem("gA::1", "decision"), mkItem("gA::2", "fact")];
    const gbi = { "gA::1": "gA", "gA::2": "gA" };
    const r = applyCrossGroupLinks(items, [{ from: "gA::1", to: "gA::2", type: "based_on" }], gbi);
    assert.equal(r.added, 0);
    assert.equal(r.skipped, 1);
    assert.deepEqual(items[0].based_on_items, []);
  });

  test("self-link, unknown id, unknown type → all skipped", () => {
    const { items, gbi } = pair();
    const r = applyCrossGroupLinks(items, [
      { from: "gA::1", to: "gA::1", type: "based_on" },       // self
      { from: "gA::1", to: "ghost", type: "based_on" },        // unknown id
      { from: "gA::1", to: "gB::2", type: "part_of" },         // unknown relation type
    ], gbi);
    assert.equal(r.added, 0);
    assert.equal(r.skipped, 3);
  });
});

describe("runCrossGroupLink — gate + no-op", () => {
  test("flag OFF → passthrough, no LLM call", async () => {
    const prev = process.env.NODEDEX_V2_CROSSLINK;
    process.env.NODEDEX_V2_CROSSLINK = "0";
    let called = false;
    const provider: any = { isAvailable: () => true, generateStructured: async () => { called = true; return { result: { links: [] }, rateLimited: false }; } };
    const { items, gbi } = pair();
    const out = await runCrossGroupLink(provider, items, gbi);
    assert.equal(out.added, 0);
    assert.equal(out.llm_calls, 0);
    assert.equal(called, false);
    if (prev === undefined) delete process.env.NODEDEX_V2_CROSSLINK; else process.env.NODEDEX_V2_CROSSLINK = prev;
  });

  test("flag ON but <2 threads → no-op, no LLM call", async () => {
    const prev = process.env.NODEDEX_V2_CROSSLINK;
    process.env.NODEDEX_V2_CROSSLINK = "1";
    let called = false;
    const provider: any = { isAvailable: () => true, generateStructured: async () => { called = true; return { result: { links: [] }, rateLimited: false }; } };
    const items = [mkItem("gA::1", "decision"), mkItem("gA::2", "fact")];
    const gbi = { "gA::1": "gA", "gA::2": "gA" }; // one thread
    const out = await runCrossGroupLink(provider, items, gbi);
    assert.equal(out.llm_calls, 0);
    assert.equal(called, false);
    if (prev === undefined) delete process.env.NODEDEX_V2_CROSSLINK; else process.env.NODEDEX_V2_CROSSLINK = prev;
  });
});
