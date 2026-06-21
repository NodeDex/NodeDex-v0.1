/**
 * store/quality — block-quality scoring tests.
 *
 * Bug 1 fix (2026-05-28) extracted computeQualityScore from routes/blocks.ts
 * so the reflect pipeline can stamp scores at block creation. These tests
 * lock the existing scoring contract — same numbers blocks.ts has been
 * producing all along, just from a shared module now.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { computeQualityScore } from "../quality.js";

describe("computeQualityScore", () => {
  test("baseline block returns 1", () => {
    const block = { id: "blk_1", type: "note", content: {} };
    assert.equal(computeQualityScore(block, []), 1);
  });

  test("is_a adds 1 (→ 2)", () => {
    const block = { id: "blk_2", type: "fact", content: { is_a: "fact" } };
    assert.equal(computeQualityScore(block, []), 2);
  });

  test("unique with >=2 keys adds 1 (→ 3 with is_a)", () => {
    const block = { id: "blk_3", type: "fact", content: { is_a: "fact", unique: { value: "x", source: "y" } } };
    assert.equal(computeQualityScore(block, []), 3);
  });

  test("unique with 1 key does NOT add (still 2 with is_a)", () => {
    const block = { id: "blk_4", type: "fact", content: { is_a: "fact", unique: { value: "x" } } };
    assert.equal(computeQualityScore(block, []), 2);
  });

  test("concepts >=3 adds 1 (→ 4 with is_a + unique)", () => {
    const block = { id: "blk_5", type: "fact", content: { is_a: "fact", unique: { a: "1", b: "2" } } };
    assert.equal(computeQualityScore(block, ["one", "two", "three"]), 4);
  });

  test("concepts <3 does NOT add", () => {
    const block = { id: "blk_6", type: "fact", content: { is_a: "fact" } };
    assert.equal(computeQualityScore(block, ["one", "two"]), 2);
  });

  test("project type gets +1 bonus (→ 3 with is_a, no unique)", () => {
    // ★ THE BUG 1 CASE: pipeline-created projects had quality_score=0 and got
    // rejected by recall.ts:149. With computeQualityScore now stamped, they
    // arrive at q=3 (1 base + 1 is_a + 1 project bonus).
    const block = { id: "blk_7", type: "project", content: { is_a: "project", unique: {} } };
    assert.equal(computeQualityScore(block, []), 3);
  });

  test("project with unique{} and concepts hits 5 cap", () => {
    const block = { id: "blk_8", type: "project", content: { is_a: "project", unique: { a: "1", b: "2" } } };
    assert.equal(computeQualityScore(block, ["x", "y", "z"]), 5);
  });

  test("score caps at 5", () => {
    // Maxes all 4 conditions: base=1 + is_a + unique + concepts + project = 5.
    // Without project: 1 + is_a + unique + concepts = 4. Adding project would be 5.
    // Anything beyond is capped.
    const block = { id: "blk_9", type: "project", content: { is_a: "project", unique: { a: "1", b: "2", c: "3", d: "4", e: "5" } } };
    assert.equal(computeQualityScore(block, ["x", "y", "z", "w"]), 5);
  });

  test("string content (JSON-stringified) is parsed", () => {
    const block = { id: "blk_10", type: "fact", content: JSON.stringify({ is_a: "fact", unique: { a: "1", b: "2" } }) };
    assert.equal(computeQualityScore(block, []), 3);
  });

  test("malformed string content falls back to {} (only base score)", () => {
    const block = { id: "blk_11", type: "fact", content: "{not valid json" };
    assert.equal(computeQualityScore(block, []), 1);
  });

  test("null/undefined content is handled (only base score)", () => {
    const block1 = { id: "blk_12", type: "fact", content: null as any };
    const block2 = { id: "blk_13", type: "fact" };  // no content key
    assert.equal(computeQualityScore(block1, []), 1);
    assert.equal(computeQualityScore(block2, []), 1);
  });

  test("process-type block (session state) gets 2 with is_a, no project bonus", () => {
    // The other STRUCTURAL_TYPE in the recall.ts guard — session state blocks.
    const block = { id: "blk_14", type: "process", content: { is_a: "process" } };
    assert.equal(computeQualityScore(block, []), 2);
  });
});
