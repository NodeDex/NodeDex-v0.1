/**
 * Pass-3 from_item_id recovery — the guard against single-drift total loss.
 *
 * Background: Pass 3 must echo each block's source item id as `from_item_id`. Gemini
 * occasionally omits or drifts it on ONE block in a large batched write. The mandatory-
 * item accounting guard keys on from_item_id, so before the fix a single drift discarded
 * the WHOLE arc (every correctly-built block included). recoverDriftedFromItemIds runs
 * ahead of that guard and re-establishes the item↔block join by type-match.
 *
 * These deterministically exercise the recovery path the live extraction can't be relied
 * on to trigger (the drift is intermittent across fresh model calls).
 *
 * Run: node --import=tsx/esm --test src/middleware/reflect/__tests__/recover-from-item-id.test.ts
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { recoverDriftedFromItemIds } from "../pipeline.js";

// The mandatory-item guard (pipeline.ts) keys on the SET of from_item_ids. This mirrors
// its "is every mandatory item accounted?" check so the tests assert the real outcome.
function allAccounted(
  newBlocks: Array<{ from_item_id?: unknown }>,
  mandatoryIds: string[],
): boolean {
  const ids = new Set(newBlocks.map((b) => b.from_item_id).filter(Boolean) as string[]);
  return mandatoryIds.every((id) => ids.has(id));
}

test("the live failure: one blueprint with a MISSING from_item_id is recovered → arc accounts", () => {
  // Reproduces the CRISPR case: 3 blocks built, the melt-curve blueprint dropped its id.
  const classified = [
    { id: "group_1::decision_use_espcas9", type: "decision" },
    { id: "group_2::dead_end_gc_rich_guides", type: "dead_end" },
    { id: "group_3::blueprint_high_res_melt_curve_screening", type: "blueprint" },
  ];
  const newBlocks = [
    { from_item_id: "group_1::decision_use_espcas9", is_a: "decision", label: "use-espcas9" },
    { from_item_id: "group_2::dead_end_gc_rich_guides", is_a: "dead_end", label: "gc-rich-guides" },
    { from_item_id: undefined, is_a: "blueprint", label: "high-res-melt-curve-screening" }, // dropped
  ];
  const mandatory = classified.map((c) => c.id);

  assert.equal(allAccounted(newBlocks, mandatory), false, "precondition: blueprint unaccounted before recovery");
  const recovered = recoverDriftedFromItemIds(newBlocks, classified);
  assert.equal(recovered, 1);
  assert.equal(newBlocks[2].from_item_id, "group_3::blueprint_high_res_melt_curve_screening");
  assert.equal(allAccounted(newBlocks, mandatory), true, "all mandatory items accounted after recovery → no discard");
});

test("a DRIFTED id (present but pointing at no real item) is re-matched", () => {
  const classified = [{ id: "group_1::blueprint_real", type: "blueprint" }];
  const newBlocks = [{ from_item_id: "group_1::blueprint_DRIFTED_TYPO", is_a: "blueprint", label: "x" }];
  const recovered = recoverDriftedFromItemIds(newBlocks, classified);
  assert.equal(recovered, 1);
  assert.equal(newBlocks[0].from_item_id, "group_1::blueprint_real");
});

test("a VALID id is never reassigned", () => {
  const classified = [
    { id: "a", type: "decision" },
    { id: "b", type: "decision" },
  ];
  const newBlocks = [{ from_item_id: "b", is_a: "decision", label: "keep-b" }];
  const recovered = recoverDriftedFromItemIds(newBlocks, classified);
  assert.equal(recovered, 0);
  assert.equal(newBlocks[0].from_item_id, "b");
});

test("two blocks of the same type each claim a DISTINCT unmatched item (no double-claim)", () => {
  const classified = [
    { id: "bp1", type: "blueprint" },
    { id: "bp2", type: "blueprint" },
  ];
  const newBlocks = [
    { from_item_id: undefined, is_a: "blueprint", label: "x" },
    { from_item_id: undefined, is_a: "blueprint", label: "y" },
  ];
  const recovered = recoverDriftedFromItemIds(newBlocks, classified);
  assert.equal(recovered, 2);
  const ids = new Set(newBlocks.map((b) => b.from_item_id));
  assert.equal(ids.size, 2, "the two blocks got two different ids, not the same one twice");
  assert.ok(ids.has("bp1") && ids.has("bp2"));
});

test("no unmatched item of that type → left unrecovered (count reflects it, no crash)", () => {
  const classified = [{ id: "d1", type: "decision" }];
  const newBlocks = [{ from_item_id: undefined, is_a: "blueprint", label: "orphan" }];
  const recovered = recoverDriftedFromItemIds(newBlocks, classified);
  assert.equal(recovered, 0);
  assert.equal(newBlocks[0].from_item_id, undefined);
});

test("empty / missing new_blocks is a no-op", () => {
  assert.equal(recoverDriftedFromItemIds([], [{ id: "a", type: "decision" }]), 0);
  // @ts-expect-error — defensive: non-array input must not throw
  assert.equal(recoverDriftedFromItemIds(undefined, []), 0);
});
