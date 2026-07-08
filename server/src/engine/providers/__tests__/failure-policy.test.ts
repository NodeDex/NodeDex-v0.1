// Unit tests for the shared provider failure-policy (classification, empty-detection,
// timeout). This is the provider-agnostic policy all three providers consume so the
// retry behavior is identical on every real-world provider path.

import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  EmptyResponseError,
  TruncatedResponseError,
  classifyGenError,
  isEmptyResult,
  withTimeout,
  llmTimeoutMs,
  decideEmptyOrTimeoutAction,
  isInsufficientCreditError,
} from "../failure-policy.js";

describe("classifyGenError (provider-agnostic failure routing)", () => {
  test("EmptyResponseError → empty (wins over the SyntaxError an empty body would throw)", () => {
    assert.equal(classifyGenError(new EmptyResponseError("any/model")), "empty");
  });

  test("429 / 503 / 529 / quota / RESOURCE_EXHAUSTED → rate_limited", () => {
    assert.equal(classifyGenError({ status: 429 }), "rate_limited");
    assert.equal(classifyGenError({ status: 503 }), "rate_limited");
    assert.equal(classifyGenError({ status: 529 }), "rate_limited"); // Anthropic overloaded
    assert.equal(classifyGenError(new Error("RESOURCE_EXHAUSTED: quota")), "rate_limited");
    assert.equal(classifyGenError(new Error("model is experiencing high demand")), "rate_limited");
  });

  test("APIConnectionTimeoutError / withTimeout message → timeout", () => {
    const e = new Error("Request timed out."); e.name = "APIConnectionTimeoutError";
    assert.equal(classifyGenError(e), "timeout");
    assert.equal(classifyGenError(new Error("generateStructured(x) timeout after 180000ms")), "timeout");
  });

  test("SyntaxError on a non-empty body → truncated (the determinism-trap case)", () => {
    let parseErr: unknown;
    try { JSON.parse('{"a":1'); } catch (pe) { parseErr = pe; }
    assert.equal(classifyGenError(parseErr), "truncated");
    assert.equal(classifyGenError(new Error("Unterminated string in JSON")), "truncated");
  });

  test("TruncatedResponseError (finish_reason=length, valid-but-partial body) → truncated", () => {
    // The valid-but-partial case: the body PARSES, so JSON.parse throws nothing — only the
    // explicit error carries the truncation signal. Must classify as 'truncated' → same-model
    // bump retry (grow the budget for the full result), NEVER a model swap (determinism trap).
    assert.equal(classifyGenError(new TruncatedResponseError("any/model")), "truncated");
  });

  test("a 400/other provider error → mechanism_or_other (prompt-JSON floor / degrade)", () => {
    assert.equal(classifyGenError({ status: 400, message: "Bad Request" }), "mechanism_or_other");
    assert.equal(classifyGenError(new Error("something unexpected")), "mechanism_or_other");
  });
});

describe("isInsufficientCreditError (out-of-credit, distinct from rate-limit)", () => {
  test("HTTP 402 (status or code, number or string) → true", () => {
    assert.equal(isInsufficientCreditError({ status: 402 }), true);
    assert.equal(isInsufficientCreditError({ code: 402 }), true);
    assert.equal(isInsufficientCreditError({ status: "402" }), true);
  });
  test("OpenRouter / OpenAI billing message bodies → true", () => {
    assert.equal(isInsufficientCreditError(new Error("402 Insufficient credits. Add more to continue.")), true);
    assert.equal(isInsufficientCreditError(new Error("Payment Required")), true);
    assert.equal(isInsufficientCreditError(new Error("You exceeded your current quota — insufficient_quota")), true);
    assert.equal(isInsufficientCreditError("insufficient_credit"), true); // the swallowed-null reason string
    assert.equal(isInsufficientCreditError(new Error("negative credit balance")), true);
  });
  test("provider SPEND-CAP (OpenRouter 403 'Key limit exceeded') → true (same class as 402 → pause+alert)", () => {
    assert.equal(isInsufficientCreditError(new Error("403 Key limit exceeded (total limit).")), true);
    assert.equal(isInsufficientCreditError({ status: 403, message: "Key limit exceeded (total limit)" }), true);
    assert.equal(isInsufficientCreditError(new Error("Your credit limit has been reached")), true);
  });
  test("a transient rate-limit is NOT credit-out (must not pause-the-spend on a 429)", () => {
    assert.equal(isInsufficientCreditError({ status: 429 }), false);
    assert.equal(isInsufficientCreditError(new Error("RESOURCE_EXHAUSTED: rate limit")), false);
    assert.equal(isInsufficientCreditError(new Error("429 Rate limit exceeded")), false); // 'limit exceeded' but a RATE limit, not a spend-cap
    assert.equal(isInsufficientCreditError(new Error("503 Service Unavailable")), false);
  });
  test("null / generic errors → false", () => {
    assert.equal(isInsufficientCreditError(null), false);
    assert.equal(isInsufficientCreditError(undefined), false);
    assert.equal(isInsufficientCreditError(new Error("comprehend_failed")), false);
    assert.equal(isInsufficientCreditError({ status: 400, message: "Bad Request" }), false);
    assert.equal(isInsufficientCreditError({ status: 403, message: "Forbidden" }), false); // bare 403 (auth) ≠ spend-cap
  });
});

describe("isEmptyResult", () => {
  test("empty / whitespace / null / undefined → true", () => {
    assert.equal(isEmptyResult(""), true);
    assert.equal(isEmptyResult("   \n\t "), true);
    assert.equal(isEmptyResult(null), true);
    assert.equal(isEmptyResult(undefined), true);
  });
  test("any real content → false", () => {
    assert.equal(isEmptyResult("{}"), false);
    assert.equal(isEmptyResult('  {"a":1} '), false);
  });
});

describe("llmTimeoutMs", () => {
  const saved = process.env.NODEDEX_LLM_TIMEOUT_MS;
  afterEach(() => {
    if (saved === undefined) delete process.env.NODEDEX_LLM_TIMEOUT_MS;
    else process.env.NODEDEX_LLM_TIMEOUT_MS = saved;
  });

  test("defaults to 180000 when unset", () => {
    delete process.env.NODEDEX_LLM_TIMEOUT_MS;
    assert.equal(llmTimeoutMs(), 180000);
  });
  test("honors the env override (incl. 0 = disabled)", () => {
    process.env.NODEDEX_LLM_TIMEOUT_MS = "5000";
    assert.equal(llmTimeoutMs(), 5000);
    process.env.NODEDEX_LLM_TIMEOUT_MS = "0";
    assert.equal(llmTimeoutMs(), 0);
  });
  test("falls back to 180000 on a non-numeric value", () => {
    process.env.NODEDEX_LLM_TIMEOUT_MS = "not-a-number";
    assert.equal(llmTimeoutMs(), 180000);
  });
});

describe("decideEmptyOrTimeoutAction (escalate-first-when-fallback policy)", () => {
  test("empty WITH a fallback model → escalate (skip the slow same-model draw)", () => {
    assert.equal(decideEmptyOrTimeoutAction({ kind: "empty", hasNextModel: true, emptyRetried: false }), "escalate");
  });
  test("empty with NO fallback, not yet retried → retry_same (single-key user's only recovery)", () => {
    assert.equal(decideEmptyOrTimeoutAction({ kind: "empty", hasNextModel: false, emptyRetried: false }), "retry_same");
  });
  test("empty with NO fallback, already retried → degrade", () => {
    assert.equal(decideEmptyOrTimeoutAction({ kind: "empty", hasNextModel: false, emptyRetried: true }), "degrade");
  });
  test("timeout WITH a fallback → escalate", () => {
    assert.equal(decideEmptyOrTimeoutAction({ kind: "timeout", hasNextModel: true, emptyRetried: false }), "escalate");
  });
  test("timeout with NO fallback → degrade (never re-pay the timeout on the same model)", () => {
    assert.equal(decideEmptyOrTimeoutAction({ kind: "timeout", hasNextModel: false, emptyRetried: false }), "degrade");
  });
});

describe("withTimeout", () => {
  test("resolves a fast promise before the bound", async () => {
    const v = await withTimeout(Promise.resolve(42), 1000, "fast");
    assert.equal(v, 42);
  });
  test("rejects with a 'timeout after' message when the bound fires first", async () => {
    const slow = new Promise((res) => setTimeout(() => res("late"), 50));
    await assert.rejects(
      withTimeout(slow, 5, "slow"),
      /timeout after 5ms/,
    );
  });
});
