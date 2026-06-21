/**
 * model-caps — per-model output ceiling resolution.
 *
 * Gates the token budget on every LLM call: the request (maxOut + thinking) must stay
 * under the model's hard output cap or the provider returns a broken response that
 * masquerades as a truncation (2026-06-16 Pass 3 glitch). This pins the resolution
 * order: NODEDEX_MODEL_CAPS override → KNOWN_CAPS → conservative default.
 */
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { modelOutputCeiling, DEFAULT_CEILING } from "../model-caps.js";

describe("modelOutputCeiling", () => {
  afterEach(() => { delete process.env.NODEDEX_MODEL_CAPS; });

  test("known prefixed model → its real cap", () => {
    assert.equal(modelOutputCeiling("google/gemini-2.5-flash"), 65535);
    assert.equal(modelOutputCeiling("openai/gpt-4o"), 16384);
  });

  test("known bare model id (AI_MODEL without vendor prefix) → its cap", () => {
    assert.equal(modelOutputCeiling("gemini-2.5-flash"), 65535);
    assert.equal(modelOutputCeiling("gpt-4o"), 16384);
  });

  test("unknown or missing model → conservative default", () => {
    assert.equal(modelOutputCeiling("some/never-seen-model"), DEFAULT_CEILING);
    assert.equal(modelOutputCeiling(undefined), DEFAULT_CEILING);
  });

  test("NODEDEX_MODEL_CAPS override wins over the known map (web-UI live cap)", () => {
    process.env.NODEDEX_MODEL_CAPS = JSON.stringify({ "google/gemini-2.5-flash": 12345, "vendor/new": 200000 });
    assert.equal(modelOutputCeiling("google/gemini-2.5-flash"), 12345); // override beats KNOWN_CAPS
    assert.equal(modelOutputCeiling("vendor/new"), 200000);             // override supplies an unknown
    assert.equal(modelOutputCeiling("openai/gpt-4o"), 16384);           // untouched models keep known cap
  });

  test("malformed NODEDEX_MODEL_CAPS is ignored (falls back to known/default)", () => {
    process.env.NODEDEX_MODEL_CAPS = "{not json";
    assert.equal(modelOutputCeiling("google/gemini-2.5-flash"), 65535);
    assert.equal(modelOutputCeiling("x/y"), DEFAULT_CEILING);
  });
});
