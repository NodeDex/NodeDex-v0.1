/**
 * reasoning-consumption.test.ts — the opt-in CONSUME side of the thinking channel
 * (NODEDEX_COMPREHEND_USE_REASONING). Guards:
 *   1. OFF (default) = byte-identical floor — formatComprehendTurn emits the
 *      historical `USER: …\nAGENT: …` shape and prompts pass through unchanged,
 *      even when thinking is present (stored ≠ consumed).
 *   2. ON = THINKING rides along IF the turn has it (graceful degradation when a
 *      model exposes no reasoning), capped head+tail with a visible marker.
 *   3. REASONING_GUIDANCE is appended at CALL time and is NOT baked into any of
 *      the three prompt constants (drift guard — one fragment, three users).
 *
 * Run: node --import=tsx/esm --test src/middleware/reflect/__tests__/reasoning-consumption.test.ts
 */
import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import {
  formatComprehendTurn,
  withReasoningGuidance,
  comprehendUseReasoningEnabled,
  REASONING_GUIDANCE,
  COMPREHEND_PROMPT,
} from "../comprehend.js";
import { SEGMENT_PROMPT, PRODUCE_PROMPT } from "../comprehend-pergroup.js";

const FLAG = "NODEDEX_COMPREHEND_USE_REASONING";
const off = () => { delete process.env[FLAG]; };
const on = () => { process.env[FLAG] = "1"; };
after(off);

describe("flag semantics", () => {
  test("off by default; only the literal '1' turns it on", () => {
    off();
    assert.equal(comprehendUseReasoningEnabled(), false);
    process.env[FLAG] = "true";
    assert.equal(comprehendUseReasoningEnabled(), false);
    on();
    assert.equal(comprehendUseReasoningEnabled(), true);
    off();
  });
});

describe("formatComprehendTurn", () => {
  test("OFF: byte-identical historical shape — thinking ignored even when present", () => {
    off();
    assert.equal(formatComprehendTurn("", "u", "a", "SECRET THINKING"), "USER: u\nAGENT: a");
    assert.equal(formatComprehendTurn("[TURN 3]", "u", "a", "t"), "[TURN 3]\nUSER: u\nAGENT: a");
  });

  test("OFF: undefined user/response degrade to empty like the old inline templates", () => {
    off();
    assert.equal(formatComprehendTurn("", undefined, undefined), "USER: \nAGENT: ");
  });

  test("ON + thinking present: THINKING section appended after AGENT", () => {
    on();
    const out = formatComprehendTurn("[TURN 1]", "u", "a", "tried X, failed with Y");
    assert.equal(out, "[TURN 1]\nUSER: u\nAGENT: a\nTHINKING: tried X, failed with Y");
    off();
  });

  test("ON + absent/blank thinking: floor shape (graceful degradation)", () => {
    on();
    assert.equal(formatComprehendTurn("", "u", "a"), "USER: u\nAGENT: a");
    assert.equal(formatComprehendTurn("", "u", "a", "   "), "USER: u\nAGENT: a");
    off();
  });

  test("ON + oversized thinking: head+tail keep, visible marker, bounded size", () => {
    on();
    const big = "H".repeat(14000) + "M".repeat(30000) + "T".repeat(6000);
    const out = formatComprehendTurn("", "u", "a", big);
    assert.ok(out.includes("[…thinking truncated…]"), "truncation must be visible");
    const thinking = out.split("THINKING: ")[1];
    assert.ok(thinking.startsWith("H".repeat(100)), "head (the plan) survives");
    assert.ok(thinking.endsWith("T".repeat(100)), "tail (the final debugging) survives");
    assert.ok(!thinking.includes("M"), "the middle is the cut");
    assert.ok(thinking.length <= 21000 + 40, `bounded, got ${thinking.length}`);
    off();
  });
});

describe("REASONING_GUIDANCE wiring", () => {
  test("OFF: withReasoningGuidance is the identity", () => {
    off();
    assert.equal(withReasoningGuidance(COMPREHEND_PROMPT), COMPREHEND_PROMPT);
  });

  test("ON: guidance appended after the base; base survives verbatim", () => {
    on();
    const out = withReasoningGuidance("BASE PROMPT");
    assert.ok(out.startsWith("BASE PROMPT"));
    assert.ok(out.includes("THINKING SECTIONS"));
    off();
  });

  test("guidance is NOT baked into any prompt constant (call-time only, no drift)", () => {
    off();
    for (const [name, p] of Object.entries({ COMPREHEND_PROMPT, SEGMENT_PROMPT, PRODUCE_PROMPT })) {
      assert.ok(!p.includes("THINKING SECTIONS"), `${name} must not embed the guidance`);
    }
  });

  test("guidance teaches the two load-bearing rules: response-wins + mine-for-dead-ends", () => {
    assert.ok(REASONING_GUIDANCE.includes("AGENT wins"));
    assert.ok(REASONING_GUIDANCE.includes("EXPLORATION, not commitment"));
    assert.ok(REASONING_GUIDANCE.includes("dead_end"));
    assert.ok(REASONING_GUIDANCE.includes("deliberation itself is not"));
  });
});
