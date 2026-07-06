// thinking-spill.test.ts — per-model observed-reasoning memory that protects the
// output space when a model ignores its thinking budget (hy3 2026-07-06).

import { describe, test, beforeEach } from "node:test";
import assert from "node:assert";
import { recordObservedThinking, effectiveThinkBudget, _resetThinkingSpillForTests } from "../thinking-spill.js";

describe("thinking-spill", () => {
  beforeEach(() => _resetThinkingSpillForTests());

  test("no observation → the requested budget passes through", () => {
    assert.equal(effectiveThinkBudget("a/model", 1024), 1024);
    assert.equal(effectiveThinkBudget("a/model", undefined), 0);
  });

  test("model stays within budget → requested budget stands", () => {
    recordObservedThinking("a/model", 800);
    assert.equal(effectiveThinkBudget("a/model", 1024), 1024);
  });

  test("spill over budget → worst observed × 1.25 headroom", () => {
    recordObservedThinking("a/model", 4000);
    assert.equal(effectiveThinkBudget("a/model", 1024), 5000);
  });

  test("keeps the MAX across calls (budgets cover the worst case)", () => {
    recordObservedThinking("a/model", 7031);
    recordObservedThinking("a/model", 1143); // a later quieter call must not shrink it
    assert.equal(effectiveThinkBudget("a/model", 1024), Math.ceil(7031 * 1.25));
  });

  test("per-model isolation — one model's spill never taxes another", () => {
    recordObservedThinking("spilly/model", 6000);
    assert.equal(effectiveThinkBudget("tidy/model", 1024), 1024);
  });

  test("spill also covers budget-less calls (no thinkingBudget requested)", () => {
    recordObservedThinking("a/model", 3000);
    assert.equal(effectiveThinkBudget("a/model", undefined), 3750);
  });

  test("garbage observations are ignored", () => {
    recordObservedThinking("a/model", 0);
    recordObservedThinking("a/model", -5);
    recordObservedThinking("a/model", NaN);
    recordObservedThinking("", 5000);
    assert.equal(effectiveThinkBudget("a/model", 1024), 1024);
  });
});
