import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  buildCapturePayload, extractReasoning, resolveCaptureConfig,
} from "../../../adapters/nodedex-capture.mjs";

// The tee adapter's PURE core. nodedexCapture() itself is fire-and-forget network I/O
// (untestable without a live server by design); these lock the payload-shaping contract:
// which fields get captured under which config, the <50 skip, caps, and the no-leak rule.

describe("nodedex-capture — buildCapturePayload (field config)", () => {
  const fullTurn = {
    userMessage: "why is the dataloader slow under load",
    agentResponse: "x".repeat(60),
    reasoning: "thought about batching",
    agentId: "agent-1",
    turnNumber: 3,
  };

  test("captures all three fields by default", () => {
    const p = buildCapturePayload(fullTurn);
    assert.equal(p.agent_response.length, 60);
    assert.equal(p.user_message, "why is the dataloader slow under load");
    assert.equal(p.agent_thinking, "thought about batching");
    assert.equal(p.agent_id, "agent-1");
    assert.equal(p.turn_number, 3);
    assert.equal(p.turn_name, "why-is-the-dataloader-slow");
    assert.deepEqual(p.loaded_block_ids, []);
    assert.equal(p.hint, "discovery");
  });

  test("response under 50 chars ⇒ null (server would reject)", () => {
    assert.equal(buildCapturePayload({ ...fullTurn, agentResponse: "too short" }), null);
  });

  test("response disabled ⇒ null (substrate off = nothing to capture)", () => {
    assert.equal(buildCapturePayload(fullTurn, { response: false }), null);
  });

  test("user disabled ⇒ user_message omitted AND turn_name not derived from it (no leak)", () => {
    const p = buildCapturePayload(fullTurn, { user: false });
    assert.equal(p.user_message, "");
    assert.equal(p.turn_name, "turn");
    assert.equal(p.agent_thinking, "thought about batching", "reasoning still captured");
  });

  test("reasoning disabled ⇒ agent_thinking omitted, response + user kept", () => {
    const p = buildCapturePayload(fullTurn, { reasoning: false });
    assert.equal(p.agent_thinking, "");
    assert.equal(p.user_message, "why is the dataloader slow under load");
  });

  test("response-only (user + reasoning off) still captures the substrate", () => {
    const p = buildCapturePayload(fullTurn, { user: false, reasoning: false });
    assert.equal(p.agent_response.length, 60);
    assert.equal(p.user_message, "");
    assert.equal(p.agent_thinking, "");
  });

  test("caps every long field to its budget", () => {
    const p = buildCapturePayload({
      agentResponse: "a".repeat(20000),
      userMessage: "b".repeat(5000),
      reasoning: "c".repeat(20000),
    });
    assert.equal(p.agent_response.length, 16000);
    assert.equal(p.user_message.length, 2000);
    assert.equal(p.agent_thinking.length, 8000);
  });

  test("explicit turnName overrides the derived slug", () => {
    const p = buildCapturePayload({ ...fullTurn, turnName: "custom-name" });
    assert.equal(p.turn_name, "custom-name");
  });
});

describe("nodedex-capture — extractReasoning (provider shapes)", () => {
  test("OpenAI `reasoning` field", () => {
    assert.equal(extractReasoning({ reasoning: "chain of thought" }), "chain of thought");
  });
  test("`reasoning_content` field", () => {
    assert.equal(extractReasoning({ reasoning_content: "cot2" }), "cot2");
  });
  test("OpenRouter `reasoning_details[]`", () => {
    assert.equal(extractReasoning({ reasoning_details: [{ text: "a" }, { text: "b" }] }), "ab");
  });
  test("Anthropic-style thinking parts in content[]", () => {
    assert.equal(
      extractReasoning({ content: [{ type: "thinking", thinking: "deep" }, { type: "text", text: "answer" }] }),
      "deep",
    );
  });
  test("no reasoning present ⇒ empty string (never crashes)", () => {
    assert.equal(extractReasoning({ content: "plain answer" }), "");
    assert.equal(extractReasoning(null), "");
    assert.equal(extractReasoning(undefined), "");
  });
});

describe("nodedex-capture — resolveCaptureConfig", () => {
  test("returns a boolean for each field", () => {
    const c = resolveCaptureConfig();
    for (const k of ["response", "user", "reasoning"]) assert.equal(typeof c[k], "boolean");
  });
  test("per-call override wins over the default", () => {
    assert.equal(resolveCaptureConfig({ reasoning: false }).reasoning, false);
    assert.equal(resolveCaptureConfig({ reasoning: false }).response, true);
  });
});
