/**
 * cost-pricing — per-pass $$ telemetry support.
 *
 * Covers the universal-framing + charter-rule-6 contract:
 *   - Known model + tokens → arithmetic correct
 *   - Unknown model → returns null (never fabricates)
 *   - Empty usage on known model → 0 (distinguishes "didn't run" from
 *     "ran but model unknown")
 *   - All models the pipeline currently routes to are in the table
 *   - Schema is provider-agnostic (no Anthropic-vs-Gemini assumption in
 *     the function signature)
 *
 * Run: node --import=tsx/esm --test src/middleware/reflect/__tests__/cost-pricing.test.ts
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  computeCost,
  PRICING,
  COST_PRICING_VERSION,
  _resetWarnings,
  type TokenUsage,
} from "../cost-pricing.js";

describe("computeCost — arithmetic correctness for known models", () => {
  test("Gemini 2.5 Flash with 1M input + 1M output → $0.30 + $2.50 = $2.80", () => {
    _resetWarnings();
    const usage: TokenUsage = { input: 1_000_000, output: 1_000_000, thinking: 0 };
    const cost = computeCost(usage, "google/gemini-2.5-flash");
    assert.ok(cost !== null, "should not be null for known model");
    // Floating-point compare with tolerance
    assert.ok(Math.abs(cost! - 2.80) < 1e-9, `expected 2.80, got ${cost}`);
  });

  test("Gemini Pro with 100K input + 50K output → $0.125 + $0.50 = $0.625", () => {
    const usage: TokenUsage = { input: 100_000, output: 50_000 };
    const cost = computeCost(usage, "google/gemini-2.5-pro");
    assert.ok(Math.abs(cost! - 0.625) < 1e-9, `expected 0.625, got ${cost}`);
  });

  test("Haiku 4.5 with thinking tokens → thinking billed at output rate (default)", () => {
    // Haiku rates: $1 input / $5 output. Thinking defaults to output rate.
    // 10K input + 5K output + 5K thinking = 0.01 + 0.025 + 0.025 = 0.06
    const usage: TokenUsage = { input: 10_000, output: 5_000, thinking: 5_000 };
    const cost = computeCost(usage, "claude-haiku-4-5");
    assert.ok(Math.abs(cost! - 0.06) < 1e-9, `expected 0.06, got ${cost}`);
  });

  test("Opus 4.7 with realistic split-turn shape → reasonable cost", () => {
    // Just sanity-check magnitude, not exact arithmetic
    const usage: TokenUsage = { input: 20_000, output: 8_000, thinking: 4_000 };
    const cost = computeCost(usage, "claude-opus-4-7");
    // 0.0003M × $15 + 0.0008M × $75 + 0.0004M × $75 = 0.0045 + 0.06 + 0.03 = 0.0945
    // (using thinking at output rate since no thinking_per_million set)
    assert.ok(Math.abs(cost! - (20_000 / 1e6 * 15 + 8_000 / 1e6 * 75 + 4_000 / 1e6 * 75)) < 1e-9);
    // Sanity-magnitude bound: Opus is expensive ($15/$75 per M) — this turn shape
    // (20K in + 12K out+thinking) lands ~$1.20. Wide bound just guards against
    // typos in the table (e.g. an accidental /1000 → would land ~$0.001).
    assert.ok(cost! > 0.5 && cost! < 5, `Opus turn cost should be expensive but not pathological, got ${cost}`);
  });
});

describe("computeCost — defensive contracts (charter rule 6)", () => {
  test("unknown model returns null (never fabricates)", () => {
    _resetWarnings();
    const usage: TokenUsage = { input: 100, output: 100 };
    const cost = computeCost(usage, "some-unknown-model-xyz");
    assert.strictEqual(cost, null, "unknown model must return null");
  });

  test("undefined model returns null", () => {
    _resetWarnings();
    const cost = computeCost({ input: 100 }, undefined);
    assert.strictEqual(cost, null);
  });

  test("empty usage on known model returns 0 (not null) — distinguishes 'didn't run' from 'don't know cost'", () => {
    _resetWarnings();
    const cost = computeCost({}, "gemini-2.5-flash");
    assert.strictEqual(cost, 0, "empty usage on known model is 0, not null");
  });

  test("undefined usage on known model returns 0 (same: distinguishes from unknown-model null)", () => {
    _resetWarnings();
    const cost = computeCost(undefined, "gemini-2.5-flash");
    assert.strictEqual(cost, 0);
  });

  test("partial usage (missing some fields) treats missing as 0", () => {
    _resetWarnings();
    const cost = computeCost({ input: 1_000_000 }, "gemini-2.5-flash"); // only input
    assert.ok(Math.abs(cost! - 0.30) < 1e-9, `1M input only → $0.30, got ${cost}`);
  });
});

describe("PRICING table — coverage for currently-routable models", () => {
  test("all primary pipeline models present (Gemini Flash + Pro, in both with/without provider-prefix)", () => {
    // Gemini Flash is the current pipeline default (CONFIG.PRIMARY_MODEL = "gemini-2.5-flash")
    // Pro is the truncation/escalation fallback (CONFIG.FALLBACK_MODEL = "gemini-2.5-pro")
    // Both with and without "google/" prefix because OpenRouter and direct-Gemini
    // emit different forms.
    for (const m of ["gemini-2.5-flash", "gemini-2.5-pro", "google/gemini-2.5-flash", "google/gemini-2.5-pro"]) {
      assert.ok(PRICING[m], `pricing missing for ${m} — turn log will record null cost`);
    }
  });

  test("Anthropic models in multi-model-routing target are present (Haiku/Sonnet/Opus)", () => {
    for (const m of ["claude-haiku-4-5", "claude-haiku-4-5-20251001", "claude-sonnet-4-6", "claude-opus-4-7"]) {
      assert.ok(PRICING[m], `pricing missing for ${m} — required for multi-model routing target`);
    }
  });

  test("every entry has positive non-zero rates (no accidental $0 lines)", () => {
    for (const [model, rate] of Object.entries(PRICING)) {
      assert.ok(rate.input_per_million > 0, `${model} input rate must be > 0`);
      assert.ok(rate.output_per_million > 0, `${model} output rate must be > 0`);
      if (rate.thinking_per_million !== undefined) {
        assert.ok(rate.thinking_per_million > 0, `${model} thinking rate must be > 0 if set`);
      }
    }
  });
});

describe("Universal framing — schema is provider-agnostic", () => {
  test("ModelRate fields are domain-free names (no 'gemini' or 'anthropic' in the type)", () => {
    // The interface only has input/output/thinking — no provider names.
    // This test is essentially a compile-time check, but we also assert
    // structurally that PRICING entries match the interface shape.
    const sample = PRICING["gemini-2.5-flash"];
    assert.ok(typeof sample.input_per_million === "number");
    assert.ok(typeof sample.output_per_million === "number");
    // thinking_per_million is optional — both forms (present + absent) are valid
  });

  test("adding a hypothetical new provider works without code changes — table-only", () => {
    // Verify the contract: PRICING can be extended via the same shape.
    const hypothetical = { input_per_million: 0.50, output_per_million: 1.50 };
    PRICING["test-only-fake-model"] = hypothetical;
    try {
      const cost = computeCost({ input: 1_000_000, output: 1_000_000 }, "test-only-fake-model");
      assert.ok(Math.abs(cost! - 2.00) < 1e-9);
    } finally {
      delete PRICING["test-only-fake-model"];
    }
  });
});

describe("COST_PRICING_VERSION — safety valve for stale rates", () => {
  test("version string exists and is non-empty", () => {
    assert.ok(typeof COST_PRICING_VERSION === "string");
    assert.ok(COST_PRICING_VERSION.length > 0, "version must be non-empty so stale-rate detection works");
  });

  test("version follows YYYY-MM-DD shape (so older < newer is sortable)", () => {
    assert.match(COST_PRICING_VERSION, /^\d{4}-\d{2}-\d{2}$/);
  });
});
