// thinking-spill.test.ts — per-model observed-reasoning memory that protects the
// output space when a model ignores its thinking budget (hy3 2026-07-06).

import { describe, test, beforeEach } from "node:test";
import assert from "node:assert";
import { recordObservedThinking, effectiveThinkBudget, isReasoningDisabled, reasoningDisabledForCall, _resetThinkingSpillForTests } from "../thinking-spill.js";

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

describe("isReasoningDisabled (no-think mode)", () => {
  const saved = { list: process.env.NODEDEX_NO_THINK_MODELS, global: process.env.NODEDEX_DISABLE_REASONING };
  beforeEach(() => {
    delete process.env.NODEDEX_NO_THINK_MODELS;
    delete process.env.NODEDEX_DISABLE_REASONING;
  });
  // restore after the suite so we don't leak env into other tests
  const restore = () => {
    if (saved.list === undefined) delete process.env.NODEDEX_NO_THINK_MODELS; else process.env.NODEDEX_NO_THINK_MODELS = saved.list;
    if (saved.global === undefined) delete process.env.NODEDEX_DISABLE_REASONING; else process.env.NODEDEX_DISABLE_REASONING = saved.global;
  };

  test("default (no env) → reasoning ON for everyone", () => {
    assert.equal(isReasoningDisabled("tencent/hy3:free"), false);
    assert.equal(isReasoningDisabled(undefined), false);
  });

  test("per-model list disables only listed models", () => {
    process.env.NODEDEX_NO_THINK_MODELS = "tencent/hy3:free, other/model";
    assert.equal(isReasoningDisabled("tencent/hy3:free"), true);
    assert.equal(isReasoningDisabled("other/model"), true);
    assert.equal(isReasoningDisabled("google/gemini-2.5-flash"), false);
  });

  test("global switch disables all models", () => {
    process.env.NODEDEX_DISABLE_REASONING = "on";
    assert.equal(isReasoningDisabled("anything/at-all"), true);
    restore();
  });

  test("the per-model list wins over the global switch", () => {
    process.env.NODEDEX_DISABLE_REASONING = "on";
    process.env.NODEDEX_NO_THINK_MODELS = "only/this";
    assert.equal(isReasoningDisabled("only/this"), true);
    assert.equal(isReasoningDisabled("something/else"), false);
    restore();
  });
});

describe("reasoningDisabledForCall (no-think scoped to mechanical passes)", () => {
  const saved = process.env.NODEDEX_NO_THINK_MODELS;
  beforeEach(() => { process.env.NODEDEX_NO_THINK_MODELS = "tencent/hy3:free"; });
  const restore = () => {
    if (saved === undefined) delete process.env.NODEDEX_NO_THINK_MODELS; else process.env.NODEDEX_NO_THINK_MODELS = saved;
  };

  test("no-think model, mechanical pass (no keepReasoning) → reasoning OFF", () => {
    assert.equal(reasoningDisabledForCall("tencent/hy3:free"), true);
    assert.equal(reasoningDisabledForCall("tencent/hy3:free", false), true);
  });

  test("no-think model, JUDGMENT pass (keepReasoning=true) → reasoning STAYS ON", () => {
    // the recognizer + dedup reviewer opt-out: no-think must not disable their thinking
    assert.equal(reasoningDisabledForCall("tencent/hy3:free", true), false);
    restore();
  });

  test("reasoning model → always ON regardless of keepReasoning", () => {
    assert.equal(reasoningDisabledForCall("google/gemini-2.5-flash"), false);
    assert.equal(reasoningDisabledForCall("google/gemini-2.5-flash", false), false);
    restore();
  });
});
