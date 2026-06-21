// Unit tests for the structured-output portability helpers (openai.ts).
// The mechanism-selection + prompt-JSON fallback make the pipeline model-portable
// (Anthropic→tool-use, default→response_format, unknown/400→prompt-JSON floor).

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { primaryMechanism, stripJsonFences, classifyGenError, EmptyResponseError } from "../openai.js";

describe("primaryMechanism (mechanism-by-model)", () => {
  test("Anthropic models → tool_use (they reject response_format)", () => {
    assert.equal(primaryMechanism("anthropic/claude-haiku-4.5"), "tool_use");
    assert.equal(primaryMechanism("anthropic/claude-opus-4.1"), "tool_use");
    assert.equal(primaryMechanism("claude-3-5-sonnet"), "tool_use");
  });

  test("OpenAI / Gemini / others → response_format (the default, unchanged path)", () => {
    assert.equal(primaryMechanism("google/gemini-2.5-flash"), "response_format");
    assert.equal(primaryMechanism("openai/gpt-4o"), "response_format");
    assert.equal(primaryMechanism("gpt-4o"), "response_format");
    assert.equal(primaryMechanism("x-ai/grok-2"), "response_format");
    assert.equal(primaryMechanism("deepseek/deepseek-chat"), "response_format");
  });

  test("empty/garbage → response_format (safe default)", () => {
    assert.equal(primaryMechanism(""), "response_format");
    assert.equal(primaryMechanism(undefined as any), "response_format");
  });
});

describe("stripJsonFences (prompt-JSON robustness)", () => {
  test("strips ```json fences", () => {
    assert.equal(stripJsonFences('```json\n{"a":1}\n```'), '{"a":1}');
  });
  test("strips bare ``` fences", () => {
    assert.equal(stripJsonFences('```\n{"a":1}\n```'), '{"a":1}');
  });
  test("leaves un-fenced JSON untouched", () => {
    assert.equal(stripJsonFences('{"a":1}'), '{"a":1}');
  });
  test("trims surrounding whitespace", () => {
    assert.equal(stripJsonFences('   {"a":1}   '), '{"a":1}');
  });
});

describe("classifyGenError (failure-mode routing)", () => {
  test("EmptyResponseError → empty (escalates to fallback model, not a bump)", () => {
    assert.equal(classifyGenError(new EmptyResponseError("google/gemini-2.5-flash")), "empty");
  });

  test("empty is NOT misclassified as truncated (the Run-12 bug)", () => {
    // The old code let JSON.parse('') throw a SyntaxError → 'truncated'. The
    // explicit EmptyResponseError must win so empties escalate instead of bumping.
    assert.notEqual(classifyGenError(new EmptyResponseError("x")), "truncated");
  });

  test("429 → rate_limited (by status or message)", () => {
    assert.equal(classifyGenError({ status: 429 }), "rate_limited");
    assert.equal(classifyGenError(new Error("Request failed: 429 Too Many Requests")), "rate_limited");
  });

  test("APIConnectionTimeoutError / 'timed out' → timeout", () => {
    const e = new Error("Request timed out."); e.name = "APIConnectionTimeoutError";
    assert.equal(classifyGenError(e), "timeout");
    assert.equal(classifyGenError(new Error("the request timed out")), "timeout");
  });

  test("SyntaxError on a non-empty body → truncated (the determinism-trap case)", () => {
    let parseErr: unknown;
    try { JSON.parse('{"a":1'); } catch (pe) { parseErr = pe; }
    assert.equal(classifyGenError(parseErr), "truncated");
    assert.equal(classifyGenError(new Error("Unterminated string in JSON")), "truncated");
  });

  test("a 400/other provider error → mechanism_or_other (prompt-JSON floor)", () => {
    assert.equal(classifyGenError({ status: 400, message: "Bad Request" }), "mechanism_or_other");
  });
});
