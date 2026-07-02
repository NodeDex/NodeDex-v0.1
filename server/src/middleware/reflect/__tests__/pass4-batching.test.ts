// pass4-batching.test.ts — the Pass 4 emission-side batching contract.
//
// WHY THIS EXISTS (2026-07-03 dogfood run): Pass 4's input-side slice was always
// capped (retrieve-graph-slice k=20), but its OUTPUT grows with the new-block
// count — 157 new blocks in ONE call blew flash-lite's output cap, truncated
// twice, failed the whole pass, and orphaned every cross-group conclusion
// (including the investigation's synthesis dead_end). The fix: the caller chunks
// new blocks to ≤ batch-size per call, accumulates relations, applies once.
// These tests pin the pure chunking contract; the pipeline wiring is exercised
// by the existing arc/pipeline suites.
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { chunkForPass4, pass4BatchSize, PASS4_DEFAULT_BATCH } from "../pass4.js";

afterEach(() => { delete process.env.NODEDEX_PASS4_BATCH; });

describe("pass4BatchSize — env-tunable, sane default", () => {
  test("default is 20 (the documented slice-k spirit)", () => {
    delete process.env.NODEDEX_PASS4_BATCH;
    assert.equal(pass4BatchSize(), PASS4_DEFAULT_BATCH);
    assert.equal(PASS4_DEFAULT_BATCH, 20);
  });
  test("env override wins; floors at 1; garbage falls back to default", () => {
    process.env.NODEDEX_PASS4_BATCH = "8";
    assert.equal(pass4BatchSize(), 8);
    process.env.NODEDEX_PASS4_BATCH = "0";
    assert.equal(pass4BatchSize(), PASS4_DEFAULT_BATCH, "0 is not a usable batch — default");
    process.env.NODEDEX_PASS4_BATCH = "nope";
    assert.equal(pass4BatchSize(), PASS4_DEFAULT_BATCH);
    process.env.NODEDEX_PASS4_BATCH = "5.9";
    assert.equal(pass4BatchSize(), 5, "fractional floors down");
  });
});

describe("chunkForPass4 — bounded batches, nothing lost, order kept", () => {
  const blocks = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `b${i}` }));

  test("the dogfood case: 157 blocks → 8 batches of ≤20, all blocks present in order", () => {
    const batches = chunkForPass4(blocks(157));
    assert.equal(batches.length, 8);
    assert.ok(batches.every((b) => b.length <= 20));
    assert.equal(batches[7]!.length, 17, "remainder batch carries the tail");
    const flat = batches.flat().map((b) => b.id);
    assert.deepEqual(flat, blocks(157).map((b) => b.id), "no block lost or reordered");
  });
  test("under one batch → single chunk (the common small-turn case stays one call)", () => {
    assert.equal(chunkForPass4(blocks(5)).length, 1);
    assert.equal(chunkForPass4(blocks(20)).length, 1);
    assert.equal(chunkForPass4(blocks(21)).length, 2);
  });
  test("empty input → no batches (Pass 4 loop simply doesn't run)", () => {
    assert.deepEqual(chunkForPass4([]), []);
  });
  test("explicit size argument overrides the env default", () => {
    process.env.NODEDEX_PASS4_BATCH = "50";
    assert.equal(chunkForPass4(blocks(10), 3).length, 4);
  });
});
