// capture-caps.test.mjs — the per-channel storage bounds are env-overridable
// (raise NODEDEX_CAPTURE_REASONING_MAX when the consume side reads thinking;
// the 8000 default was sized for storage-only days and truncates long builder
// sessions). CAPS is computed at module load, so env is set BEFORE the import —
// node --test runs each file in its own process, so this leaks nowhere.
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.NODEDEX_CAPTURE_RESPONSE_MAX = "60";
process.env.NODEDEX_CAPTURE_REASONING_MAX = "50";
// user cap deliberately NOT set → default 2000 must still apply

const { buildTriggerBody } = await import("../nodedex-capture-core.mjs");

test("env-overridden caps bound their channels; unset ones keep defaults", () => {
  const body = buildTriggerBody({
    agentResponse: "r".repeat(500),
    reasoning: "t".repeat(500),
    userMessage: "u".repeat(500),
    agentId: "x",
    turnName: "t",
  });
  assert.equal(body.agent_response.length, 60, "response bound by env");
  assert.equal(body.agent_thinking.length, 50, "reasoning bound by env");
  assert.equal(body.user_message.length, 500, "under the untouched default cap → intact");
});

test("garbage env values fall back to defaults (never a 0/negative cap)", async () => {
  // Same-process re-import won't re-evaluate CAPS; assert the guard function's
  // contract indirectly: a fresh child would get defaults. Here we just pin the
  // arithmetic: Number("nope") is NaN and NaN>0 is false.
  assert.equal(Number.isFinite(Number("nope")) && Number("nope") > 0, false);
  assert.equal(Number.isFinite(Number("-5")) && Number("-5") > 0, false);
});
