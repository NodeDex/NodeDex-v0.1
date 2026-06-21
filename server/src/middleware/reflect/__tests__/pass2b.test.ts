/**
 * Pass 2b — prompt builder + sanitizer + batch helper tests.
 *
 * Covers PASS2-SPLIT-DESIGN.md §2 Pass 2b ownership:
 *   - OWNS: unique{} fill per assigned type's schema, insight discriminator
 *   - DOES NOT: change type, wire relations, batch-reason about other items
 *
 * What this file tests (without an LLM):
 *   - buildPass2bPrompt: type-specific schema injection, insight discriminator
 *     fires only for insight, novel/freeform handling
 *   - sanitizePass2bUnique: strips fields outside the type's allowed set,
 *     preserves canonical fields, freeform/novel passthrough
 *   - callPass2bBatch parallelism: chunked execution with a mock provider
 *
 * What this file does NOT test (needs integration runs):
 *   - Actual LLM call quality (Week 2-3 fixture validation)
 *
 * Run: node --import=tsx/esm --test src/middleware/reflect/__tests__/pass2b.test.ts
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  buildPass2bPrompt,
  sanitizePass2bUnique,
  sanitizePass2bResult,
  callPass2bBatch,
  callPass2bLLM,
  type Pass2bInput,
} from "../pass2b.js";
import type { LLMProvider } from "../../../engine/ai-provider.js";

// ─────────────────────────────────────────────────────────────────────────────
// buildPass2bPrompt — schema injection per type
// ─────────────────────────────────────────────────────────────────────────────

describe("buildPass2bPrompt — type-specific schema injection", () => {
  test("decision: lists choice as REQUIRED, reason and alternatives_rejected as OPTIONAL", () => {
    const p = buildPass2bPrompt({ id: "i1", text: "We use FastAPI.", type: "decision" });
    assert.match(p, /REQUIRED.*choice/);
    assert.match(p, /OPTIONAL.*reason.*alternatives_rejected|reason, alternatives_rejected/);
  });

  test("insight: lists observation + implication as REQUIRED, no optional", () => {
    const p = buildPass2bPrompt({ id: "i1", text: "X correlates with Y.", type: "insight" });
    assert.match(p, /REQUIRED.*observation.*implication|observation, implication/);
  });

  test("insight prompt INCLUDES the insight discriminator (Bug-3 defense)", () => {
    const p = buildPass2bPrompt({ id: "i1", text: "X correlates with Y.", type: "insight" });
    assert.ok(p.includes("INSIGHT FIELD DISCIPLINE"), "insight discriminator missing");
    assert.ok(p.includes("implication"), "implication field name missing");
    assert.ok(p.includes("hypothesis"), "discriminator vs hypothesis missing");
  });

  test("decision prompt does NOT include the insight discriminator", () => {
    const p = buildPass2bPrompt({ id: "i1", text: "We use X.", type: "decision" });
    assert.ok(!p.includes("INSIGHT FIELD DISCIPLINE"), "insight discriminator leaked to non-insight prompt");
  });

  test("dead_end: required {approach, reason}, optional {alternative}", () => {
    const p = buildPass2bPrompt({ id: "i1", text: "Tried X, didn't work.", type: "dead_end" });
    assert.match(p, /REQUIRED.*approach.*reason|approach, reason/);
    assert.match(p, /OPTIONAL.*alternative/);
  });

  test("note (freeform): no required schema, capture-if-present language", () => {
    const p = buildPass2bPrompt({ id: "i1", text: "random note", type: "note" });
    assert.ok(p.includes("freeform"), "freeform language missing");
    assert.ok(p.includes("If structured data is present"), "capture-if-present guidance missing");
  });

  test("novel type (not in TYPE_UNIQUE_SCHEMA): novel-type guidance, lowercase snake_case fields", () => {
    const p = buildPass2bPrompt({ id: "i1", text: "X", type: "weird_new_type" });
    assert.ok(p.includes("novel type defined by Pass 2a"), "novel-type framing missing");
    assert.ok(p.includes("snake_case"), "field-naming guidance missing");
  });

  test("classification_reasoning is forwarded for context but doesn't change the prompt", () => {
    const p1 = buildPass2bPrompt({ id: "i1", text: "X", type: "fact", classification_reasoning: "TEST 1 fired" });
    const p2 = buildPass2bPrompt({ id: "i1", text: "X", type: "fact" });
    // The prompt builder doesn't include classification_reasoning in the PROMPT
    // (it's added to userInput in callPass2bLLM). So both prompts are identical.
    assert.equal(p1, p2);
  });

  test("DOES NOT include dedup or causal-wiring instructions", () => {
    const p = buildPass2bPrompt({ id: "i1", text: "X", type: "fact" });
    assert.ok(!p.includes("DEDUP"), "dedup instruction leaked from 2a");
    assert.ok(!p.includes("CAUSAL"), "causal wiring instruction leaked from 2c");
    assert.ok(!p.includes("triggered_by"), "wiring reference leaked");
    assert.ok(!p.includes("PROJECT GRAPH"), "graph context leaked from 2a");
  });

  test("explicit DO-NOT-change-type instruction (Seam α contract)", () => {
    const p = buildPass2bPrompt({ id: "i1", text: "X", type: "fact" });
    assert.ok(p.includes("DO NOT change the type"), "type-immutability instruction missing");
  });

  test("retryFailureDetail injects a RETRY section that names the missing field without licensing fabrication", () => {
    const p = buildPass2bPrompt({
      id: "i1",
      text: "every year by midsummer suggests a recurring problem",
      type: "insight",
      retryFailureDetail: "type=insight missing=[implication]",
    });
    assert.ok(p.includes("RETRY"), "RETRY section header missing");
    assert.ok(p.includes("type=insight missing=[implication]"), "failure detail not surfaced to the model");
    // Charter-clean: tells it to look harder if present, leave empty if genuinely absent, never invent.
    assert.ok(p.includes("leave it empty") || p.includes("set aside"), "no escape-hatch for genuinely-absent field");
    assert.ok(p.includes("Never invent") || p.includes("not in the text"), "no anti-fabrication guard in retry section");
  });

  test("no RETRY section on the first (non-retry) fill", () => {
    const p = buildPass2bPrompt({ id: "i1", text: "X", type: "insight" });
    assert.ok(!p.includes("RETRY —"), "RETRY section leaked into a first-pass (non-retry) prompt");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// sanitizePass2bUnique — strip extras per type's allowed set
// ─────────────────────────────────────────────────────────────────────────────

describe("sanitizePass2bUnique — strips fields outside the type's schema", () => {
  test("insight with {observation, implication}: passthrough, no strips", () => {
    const { unique, strippedKeys } = sanitizePass2bUnique("insight", {
      observation: "X correlates with Y",
      implication: "use X to predict Y",
    });
    assert.deepStrictEqual(unique, { observation: "X correlates with Y", implication: "use X to predict Y" });
    assert.deepStrictEqual(strippedKeys, []);
  });

  test("insight with {observation, reason} (Bug-3 pattern): reason stripped (not in allowed set)", () => {
    const { unique, strippedKeys } = sanitizePass2bUnique("insight", {
      observation: "X correlates with Y",
      reason: "because of Z",
    });
    assert.deepStrictEqual(unique, { observation: "X correlates with Y" });
    assert.deepStrictEqual(strippedKeys, ["reason"]);
  });

  test("insight with {observation, target} (rl-fixed pattern): target stripped", () => {
    const { unique, strippedKeys } = sanitizePass2bUnique("insight", {
      observation: "prevention starting before midsummer",
      target: "betting everything on it",
    });
    assert.deepStrictEqual(unique, { observation: "prevention starting before midsummer" });
    assert.deepStrictEqual(strippedKeys, ["target"]);
  });

  test("decision with {choice, reason}: passthrough", () => {
    const { unique, strippedKeys } = sanitizePass2bUnique("decision", {
      choice: "Use FastAPI",
      reason: "OpenAPI support",
    });
    assert.deepStrictEqual(unique, { choice: "Use FastAPI", reason: "OpenAPI support" });
    assert.deepStrictEqual(strippedKeys, []);
  });

  test("decision with bogus {approach}: stripped (approach is dead_end's field)", () => {
    const { unique, strippedKeys } = sanitizePass2bUnique("decision", {
      choice: "Use FastAPI",
      approach: "should not be here",
    });
    assert.deepStrictEqual(unique, { choice: "Use FastAPI" });
    assert.deepStrictEqual(strippedKeys, ["approach"]);
  });

  test("freeform type (note): passthrough — any fields allowed", () => {
    const { unique, strippedKeys } = sanitizePass2bUnique("note", {
      anything: "value",
      else: "another",
    });
    assert.deepStrictEqual(unique, { anything: "value", else: "another" });
    assert.deepStrictEqual(strippedKeys, []);
  });

  test("novel/unknown type: passthrough (no canonical schema to strip against)", () => {
    const { unique, strippedKeys } = sanitizePass2bUnique("totally_made_up_type", {
      foo: "bar",
      baz: "qux",
    });
    assert.deepStrictEqual(unique, { foo: "bar", baz: "qux" });
    assert.deepStrictEqual(strippedKeys, []);
  });

  test("empty / null / whitespace values are dropped before sanitization", () => {
    const { unique, strippedKeys } = sanitizePass2bUnique("decision", {
      choice: "Use FastAPI",
      reason: "",
      alternatives_rejected: null as any,
      source: "   ",  // not even in decision schema, but should be stripped before extras-check
    });
    assert.deepStrictEqual(unique, { choice: "Use FastAPI" });
    assert.deepStrictEqual(strippedKeys, []);  // source is empty so dropped pre-check, never reaches extras
  });

  test("non-string values coerced to string", () => {
    const { unique, strippedKeys } = sanitizePass2bUnique("fact", {
      value: 42 as any,  // numeric → "42"
    });
    assert.deepStrictEqual(unique, { value: "42" });
    assert.equal(typeof unique.value, "string");
    assert.deepStrictEqual(strippedKeys, []);
  });

  test("sanitizePass2bResult wraps unique sanitization in the per-item envelope", () => {
    const { result, strippedKeys } = sanitizePass2bResult("insight", {
      id: "item_1",
      unique: { observation: "X", implication: "Y", reason: "Z" },
    });
    assert.equal(result.id, "item_1");
    assert.deepStrictEqual(result.unique, { observation: "X", implication: "Y" });
    assert.deepStrictEqual(strippedKeys, ["reason"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// callPass2bBatch — parallelism + failure capture (mock provider)
// ─────────────────────────────────────────────────────────────────────────────

describe("callPass2bBatch — chunked parallelism + failure capture", () => {
  // Build a mock provider that returns scripted results per item id.
  function mkMockProvider(script: Record<string, "ok" | "rate_limited" | "throws">) {
    return {
      getName: () => "mock",
      generateStructured: async (_p: string, userInput: string, _s: any) => {
        // Pull id from userInput (the prompt structure puts "id: <id>" in there)
        const idMatch = userInput.match(/id:\s*(\S+)/);
        const id = idMatch?.[1] ?? "unknown";
        const verdict = script[id] ?? "ok";

        if (verdict === "throws") throw new Error("mock provider error for " + id);
        if (verdict === "rate_limited") {
          return { result: null, thinking: "", rateLimited: true, model: "mock", attempts: [{ model: "mock", outcome: "rate_limited" }] } as any;
        }
        // Type 'fact' has required: [value]; pick a value that satisfies it.
        return {
          result: { id, unique: { value: `extracted-for-${id}` } },
          thinking: "",
          rateLimited: false,
          model: "mock",
          attempts: [{ model: "mock", outcome: "ok" }],
          usage: { input: 100, output: 20, thinking: 0 },
        } as any;
      },
    } as any;
  }

  test("all items succeed → results populated, no failures", async () => {
    const items: Pass2bInput[] = [
      { id: "i1", text: "X", type: "fact" },
      { id: "i2", text: "Y", type: "fact" },
      { id: "i3", text: "Z", type: "fact" },
    ];
    const provider = mkMockProvider({ i1: "ok", i2: "ok", i3: "ok" });
    const r = await callPass2bBatch(provider, items, { parallelism: 2 });
    assert.equal(r.results.length, 3);
    assert.equal(r.failures.length, 0);
    assert.deepStrictEqual(r.results.map((x) => x.id).sort(), ["i1", "i2", "i3"]);
  });

  test("mixed: 2 ok, 1 rate-limited → results=2 failures=[rate_limited]", async () => {
    const items: Pass2bInput[] = [
      { id: "i1", text: "X", type: "fact" },
      { id: "i2", text: "Y", type: "fact" },
      { id: "i3", text: "Z", type: "fact" },
    ];
    const provider = mkMockProvider({ i1: "ok", i2: "rate_limited", i3: "ok" });
    const r = await callPass2bBatch(provider, items);
    assert.equal(r.results.length, 2);
    assert.equal(r.failures.length, 1);
    assert.equal(r.failures[0].id, "i2");
    assert.equal(r.failures[0].reason, "rate_limited");
  });

  test("provider throws on one item → captured as llm_error in failures", async () => {
    const items: Pass2bInput[] = [
      { id: "i1", text: "X", type: "fact" },
      { id: "i2", text: "Y", type: "fact" },
    ];
    const provider = mkMockProvider({ i1: "ok", i2: "throws" });
    const r = await callPass2bBatch(provider, items);
    assert.equal(r.results.length, 1);
    assert.equal(r.failures.length, 1);
    assert.equal(r.failures[0].reason, "llm_error");
  });

  test("empty batch → empty results + failures", async () => {
    const r = await callPass2bBatch(mkMockProvider({}), []);
    assert.deepStrictEqual(r.results, []);
    assert.deepStrictEqual(r.failures, []);
  });

  test("parallelism=1 → sequential fallback path (still completes correctly)", async () => {
    const items: Pass2bInput[] = [
      { id: "i1", text: "X", type: "fact" },
      { id: "i2", text: "Y", type: "fact" },
      { id: "i3", text: "Z", type: "fact" },
      { id: "i4", text: "W", type: "fact" },
    ];
    const provider = mkMockProvider({ i1: "ok", i2: "ok", i3: "ok", i4: "ok" });
    const r = await callPass2bBatch(provider, items, { parallelism: 1 });
    assert.equal(r.results.length, 4);
    assert.equal(r.failures.length, 0);
  });

  test("parallelism is coerced to a minimum of 1 (defensive against 0 / negative)", async () => {
    const items: Pass2bInput[] = [{ id: "i1", text: "X", type: "fact" }];
    const provider = mkMockProvider({ i1: "ok" });
    const r = await callPass2bBatch(provider, items, { parallelism: 0 });
    assert.equal(r.results.length, 1);
  });

  // D-fix 2026-05-25: batch rolls up per-item usage so the orchestrator can
  // stamp reflectTokenStats.pass2b (previously usage was discarded → $0 cost).
  test("usage rolls up across all per-item calls", async () => {
    const items: Pass2bInput[] = [
      { id: "i1", text: "X", type: "fact" },
      { id: "i2", text: "Y", type: "fact" },
      { id: "i3", text: "Z", type: "fact" },
    ];
    const provider = mkMockProvider({ i1: "ok", i2: "ok", i3: "ok" }); // each mock call: {input:100, output:20, thinking:0}
    const r = await callPass2bBatch(provider, items, { parallelism: 2 });
    assert.deepStrictEqual(r.usage, { input: 300, output: 60, thinking: 0 });
  });

  test("usage roll-up only counts calls that report usage (rate-limited contributes nothing)", async () => {
    const items: Pass2bInput[] = [
      { id: "i1", text: "X", type: "fact" },
      { id: "i2", text: "Y", type: "fact" }, // rate-limited → no usage on the mock return
    ];
    const provider = mkMockProvider({ i1: "ok", i2: "rate_limited" });
    const r = await callPass2bBatch(provider, items);
    assert.deepStrictEqual(r.usage, { input: 100, output: 20, thinking: 0 });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// callPass2bBatch — parallelism precedence (Stage C-1, 2026-05-30)
//
// Precedence (high → low):
//   1. options.parallelism (explicit caller)
//   2. NODEDEX_PASS2B_PARALLELISM env var (operator dial)
//   3. DEFAULT_PASS2B_PARALLELISM = 10 (compile-time fallback)
//
// We can't read DEFAULT_PASS2B_PARALLELISM directly (it's module-private), so
// the "default" test observes concurrent in-flight calls via an instrumented
// mock — that's how the constant manifests externally.
// ─────────────────────────────────────────────────────────────────────────────

describe("callPass2bBatch — parallelism precedence (env var + default)", () => {
  // Provider that tracks the MAX in-flight call count.
  function mkConcurrencyProbe() {
    let inFlight = 0;
    let maxInFlight = 0;
    const provider = {
      getName: () => "mock",
      generateStructured: async (_p: string, userInput: string, _s: any) => {
        inFlight++;
        if (inFlight > maxInFlight) maxInFlight = inFlight;
        // Yield to the event loop so chunked calls can overlap.
        await new Promise((res) => setImmediate(res));
        inFlight--;
        const idMatch = userInput.match(/id:\s*(\S+)/);
        const id = idMatch?.[1] ?? "unknown";
        return {
          result: { id, unique: { value: "v" } },
          thinking: "",
          rateLimited: false,
          model: "mock",
          attempts: [{ model: "mock", outcome: "ok" }],
          usage: { input: 1, output: 1, thinking: 0 },
        } as any;
      },
    } as any;
    return { provider, getMax: () => maxInFlight };
  }

  function makeItems(n: number): Pass2bInput[] {
    return Array.from({ length: n }, (_, i) => ({
      id: `i${i + 1}`,
      text: `t${i + 1}`,
      type: "fact",
    }));
  }

  test("DEFAULT is 10 — no options, no env var → max concurrent calls = 10", async () => {
    const prev = process.env.NODEDEX_PASS2B_PARALLELISM;
    delete process.env.NODEDEX_PASS2B_PARALLELISM;
    try {
      const { provider, getMax } = mkConcurrencyProbe();
      const r = await callPass2bBatch(provider, makeItems(25));
      assert.equal(r.results.length, 25);
      assert.equal(getMax(), 10, `expected max in-flight = 10 (DEFAULT), saw ${getMax()}`);
    } finally {
      if (prev !== undefined) process.env.NODEDEX_PASS2B_PARALLELISM = prev;
    }
  });

  test("env var honored when no options.parallelism — NODEDEX_PASS2B_PARALLELISM=3 → max concurrent = 3", async () => {
    const prev = process.env.NODEDEX_PASS2B_PARALLELISM;
    process.env.NODEDEX_PASS2B_PARALLELISM = "3";
    try {
      const { provider, getMax } = mkConcurrencyProbe();
      const r = await callPass2bBatch(provider, makeItems(12));
      assert.equal(r.results.length, 12);
      assert.equal(getMax(), 3, `expected max in-flight = 3 (env), saw ${getMax()}`);
    } finally {
      if (prev === undefined) delete process.env.NODEDEX_PASS2B_PARALLELISM;
      else process.env.NODEDEX_PASS2B_PARALLELISM = prev;
    }
  });

  test("options.parallelism WINS over env var (explicit caller > operator dial)", async () => {
    const prev = process.env.NODEDEX_PASS2B_PARALLELISM;
    process.env.NODEDEX_PASS2B_PARALLELISM = "20";
    try {
      const { provider, getMax } = mkConcurrencyProbe();
      const r = await callPass2bBatch(provider, makeItems(10), { parallelism: 2 });
      assert.equal(r.results.length, 10);
      assert.equal(getMax(), 2, `expected options.parallelism=2 to override env=20, saw max=${getMax()}`);
    } finally {
      if (prev === undefined) delete process.env.NODEDEX_PASS2B_PARALLELISM;
      else process.env.NODEDEX_PASS2B_PARALLELISM = prev;
    }
  });

  test("bad env var (non-numeric) → falls back to DEFAULT (10)", async () => {
    const prev = process.env.NODEDEX_PASS2B_PARALLELISM;
    process.env.NODEDEX_PASS2B_PARALLELISM = "abc";
    try {
      const { provider, getMax } = mkConcurrencyProbe();
      const r = await callPass2bBatch(provider, makeItems(15));
      assert.equal(r.results.length, 15);
      assert.equal(getMax(), 10, `bad env should fall back to DEFAULT=10, saw ${getMax()}`);
    } finally {
      if (prev === undefined) delete process.env.NODEDEX_PASS2B_PARALLELISM;
      else process.env.NODEDEX_PASS2B_PARALLELISM = prev;
    }
  });

  test("zero / negative env var → falls back to DEFAULT (10)", async () => {
    const prev = process.env.NODEDEX_PASS2B_PARALLELISM;
    process.env.NODEDEX_PASS2B_PARALLELISM = "0";
    try {
      const { provider, getMax } = mkConcurrencyProbe();
      const r = await callPass2bBatch(provider, makeItems(15));
      assert.equal(r.results.length, 15);
      assert.equal(getMax(), 10, `env=0 should fall back to DEFAULT=10, saw ${getMax()}`);
    } finally {
      if (prev === undefined) delete process.env.NODEDEX_PASS2B_PARALLELISM;
      else process.env.NODEDEX_PASS2B_PARALLELISM = prev;
    }
  });

  test("empty env var → falls back to DEFAULT (10)", async () => {
    const prev = process.env.NODEDEX_PASS2B_PARALLELISM;
    process.env.NODEDEX_PASS2B_PARALLELISM = "";
    try {
      const { provider, getMax } = mkConcurrencyProbe();
      const r = await callPass2bBatch(provider, makeItems(15));
      assert.equal(r.results.length, 15);
      assert.equal(getMax(), 10, `empty env should fall back to DEFAULT=10, saw ${getMax()}`);
    } finally {
      if (prev === undefined) delete process.env.NODEDEX_PASS2B_PARALLELISM;
      else process.env.NODEDEX_PASS2B_PARALLELISM = prev;
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// callPass2bLLM / Batch — modelOverride threading (C, 2026-05-25)
// ─────────────────────────────────────────────────────────────────────────────

describe("callPass2bLLM / callPass2bBatch — passes modelOverride through to provider", () => {
  test("callPass2bLLM: modelOverride forwarded to generateStructured options", async () => {
    const seen: { options?: any } = {};
    const mockProvider = {
      getName: () => "mock",
      generateStructured: async (_p: string, _u: string, _s: object, options?: any) => {
        seen.options = options;
        return {
          result: { id: "i1", unique: { value: "x" } },
          thinking: "", rateLimited: false, model: "anthropic/claude-haiku-4-5", attempts: [],
        };
      },
    } as unknown as LLMProvider;
    const item: Pass2bInput = { id: "i1", text: "t", type: "fact", classification_reasoning: "r" };

    await callPass2bLLM(mockProvider, item, 512, "anthropic/claude-haiku-4-5");
    assert.equal(seen.options?.modelOverride, "anthropic/claude-haiku-4-5");
  });

  test("callPass2bBatch: option.modelOverride forwarded to each per-item call", async () => {
    const seenModels: string[] = [];
    const mockProvider = {
      getName: () => "mock",
      generateStructured: async (_p: string, _u: string, _s: object, options?: any) => {
        seenModels.push(options?.modelOverride ?? "<default>");
        return { result: { id: "i", unique: {} }, thinking: "", rateLimited: false, model: "m", attempts: [] };
      },
    } as unknown as LLMProvider;
    const items: Pass2bInput[] = [
      { id: "i1", text: "a", type: "fact", classification_reasoning: "r" },
      { id: "i2", text: "b", type: "fact", classification_reasoning: "r" },
    ];

    await callPass2bBatch(mockProvider, items, { parallelism: 1, modelOverride: "anthropic/claude-haiku-4-5" });
    assert.equal(seenModels.length, 2);
    assert.ok(seenModels.every((m) => m === "anthropic/claude-haiku-4-5"),
      `all per-item calls should receive the modelOverride; saw ${JSON.stringify(seenModels)}`);
  });

  test("callPass2bBatch: option absent → no modelOverride forwarded (provider default)", async () => {
    const seen: { options?: any } = {};
    const mockProvider = {
      getName: () => "mock",
      generateStructured: async (_p: string, _u: string, _s: object, options?: any) => {
        seen.options = options;
        return { result: { id: "i", unique: {} }, thinking: "", rateLimited: false, model: "m", attempts: [] };
      },
    } as unknown as LLMProvider;
    const items: Pass2bInput[] = [{ id: "i1", text: "a", type: "fact", classification_reasoning: "r" }];

    await callPass2bBatch(mockProvider, items, { parallelism: 1 } /* no modelOverride */);
    assert.ok(!("modelOverride" in (seen.options ?? {})),
      "modelOverride must NOT be present when not configured");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// STAGE B — callPass2bBatchedFill (single-call batched fill, 2026-06-13)
// Contract under test: batching may reduce calls; it must NEVER lose a fill.
// ─────────────────────────────────────────────────────────────────────────────

import { callPass2bBatchedFill, v2FillBatchEnabled, buildPass2bBatchPrompt, batchFieldLine } from "../pass2b.js";

describe("v2FillBatchEnabled — default ON (Stage B)", () => {
  test("unset → true; =0 → false; =1 → true", () => {
    const prev = process.env.NODEDEX_V2_FILL_BATCH;
    delete process.env.NODEDEX_V2_FILL_BATCH; assert.equal(v2FillBatchEnabled(), true);
    process.env.NODEDEX_V2_FILL_BATCH = "0"; assert.equal(v2FillBatchEnabled(), false);
    process.env.NODEDEX_V2_FILL_BATCH = "1"; assert.equal(v2FillBatchEnabled(), true);
    if (prev === undefined) delete process.env.NODEDEX_V2_FILL_BATCH; else process.env.NODEDEX_V2_FILL_BATCH = prev;
  });
});

describe("buildPass2bBatchPrompt + batchFieldLine", () => {
  test("prompt carries the never-fabricate rules and the insight discipline", () => {
    const p = buildPass2bBatchPrompt();
    assert.ok(p.includes("do not fabricate"));
    assert.ok(p.includes("INSIGHT FIELD DISCIPLINE"));
    assert.ok(p.includes("ONE entry per input item"));
  });
  test("field line mirrors the per-item schema guidance", () => {
    assert.match(batchFieldLine("decision"), /REQUIRED: choice/);
    assert.match(batchFieldLine("zz-novel"), /novel type/);
  });
});

describe("callPass2bBatchedFill — never loses a fill", () => {
  // Mock provider: batch calls are recognized by the {items:[...]} schema;
  // per-item calls parse the id from the user input.
  function mkProvider(batchResponder: (input: string) => any) {
    const calls = { batch: 0, perItem: 0 };
    const provider = {
      isAvailable: () => true,
      generateStructured: async (_p: string, input: string, schema: any) => {
        if (schema?.properties?.items) {
          calls.batch += 1;
          return { result: batchResponder(input), rateLimited: false, usage: { input: 10, thinking: 0, output: 10 } };
        }
        calls.perItem += 1;
        const id = /id: (\S+)/.exec(input)?.[1] ?? "?";
        return { result: { id, unique: { choice: "fallback-fill" } }, rateLimited: false, usage: { input: 5, thinking: 0, output: 5 } };
      },
    } as unknown as LLMProvider;
    return { provider, calls };
  }
  const item = (id: string): Pass2bInput => ({ id, type: "decision", text: `text for ${id}` });

  test("happy path: N items, ONE call, sanitized results, zero fallbacks", async () => {
    const { provider, calls } = mkProvider(() => ({
      items: [
        { id: "a", unique: { choice: "x", bogus_field: "strip-me" } },
        { id: "b", unique: { choice: "y" } },
        { id: "c", unique: { choice: "z" } },
      ],
    }));
    const out = await callPass2bBatchedFill(provider, [item("a"), item("b"), item("c")]);
    assert.equal(out.llmCalls, 1);
    assert.equal(calls.batch, 1);
    assert.equal(calls.perItem, 0);
    assert.deepEqual(out.fellBackIds, []);
    assert.equal(out.results.length, 3);
    const a = out.results.find((r) => r.id === "a")!;
    assert.equal(a.unique.choice, "x");
    assert.ok(!("bogus_field" in a.unique), "sanitizer must strip fields outside the type's schema");
  });

  test("an id missing from the batch response falls back to the per-item call", async () => {
    const { provider, calls } = mkProvider(() => ({ items: [{ id: "a", unique: { choice: "x" } }] }));
    const out = await callPass2bBatchedFill(provider, [item("a"), item("b")]);
    assert.equal(calls.batch, 1);
    assert.equal(calls.perItem, 1);
    assert.deepEqual(out.fellBackIds, ["b"]);
    assert.equal(out.results.length, 2, "both items filled — none lost");
    assert.equal(out.results.find((r) => r.id === "b")!.unique.choice, "fallback-fill");
  });

  test("a failed chunk (null result) falls back per-item for EVERY chunk item", async () => {
    const { provider, calls } = mkProvider(() => null);
    const out = await callPass2bBatchedFill(provider, [item("a"), item("b"), item("c")]);
    assert.equal(calls.batch, 1);
    assert.equal(calls.perItem, 3);
    assert.deepEqual(out.fellBackIds.sort(), ["a", "b", "c"]);
    assert.equal(out.results.length, 3, "all fills recovered via fallback");
  });

  test("chunking: items beyond chunkSize get a second batch call", async () => {
    const { provider, calls } = mkProvider((input: string) => ({
      items: [...input.matchAll(/ITEM (\S+)/g)].map((m) => ({ id: m[1], unique: { choice: "v" } })),
    }));
    const items = Array.from({ length: 13 }, (_, i) => item(`i${i}`));
    const out = await callPass2bBatchedFill(provider, items, { chunkSize: 12 });
    assert.equal(calls.batch, 2);
    assert.equal(out.results.length, 13);
    assert.deepEqual(out.fellBackIds, []);
  });
});
