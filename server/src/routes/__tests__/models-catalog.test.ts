// GET /api/models — the slimming mapper for the web-UI model picker.
// Fixtures are the REAL OpenRouter /api/v1/models shape (verified live 2026-06-16).
// Run: node --import=tsx/esm --test src/routes/__tests__/models-catalog.test.ts
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { slimOpenRouterModel, buildPassRouting, safeParseModelCaps } from "../admin.js";

describe("slimOpenRouterModel", () => {
  test("output ceiling comes from top_provider.max_completion_tokens, NOT context_length", () => {
    // Real gpt-4o entry shape.
    const m = slimOpenRouterModel({
      id: "openai/gpt-4o",
      name: "OpenAI: GPT-4o",
      context_length: 128000,
      top_provider: { context_length: 128000, max_completion_tokens: 16384, is_moderated: false },
      pricing: { prompt: "0.0000025", completion: "0.00001" },
      supported_parameters: ["tools", "response_format", "structured_outputs"],
      architecture: { modality: "text+image+file->text" },
    });
    assert.equal(m.max_completion_tokens, 16384, "output cap = top_provider.max_completion_tokens");
    assert.equal(m.context_length, 128000, "context window kept as its own (larger) number");
    assert.notEqual(m.max_completion_tokens, m.context_length, "cap must NOT be the context window");
    assert.equal(m.supports_structured, true);
    assert.equal(m.supports_tools, true);
    assert.deepEqual(m.pricing, { prompt: "0.0000025", completion: "0.00001" });
    assert.equal(m.modality, "text+image+file->text");
  });

  test("big-cap model (gemini-2.5-flash 65535) maps through", () => {
    const m = slimOpenRouterModel({
      id: "google/gemini-2.5-flash", name: "Google: Gemini 2.5 Flash",
      context_length: 1048576,
      top_provider: { context_length: 1048576, max_completion_tokens: 65535 },
      pricing: { prompt: "0.0000003", completion: "0.0000025" },
      supported_parameters: ["structured_outputs", "tools"],
    });
    assert.equal(m.max_completion_tokens, 65535);
    assert.equal(m.context_length, 1048576);
  });

  test("null max_completion_tokens when top_provider omits it (caller falls back to default cap)", () => {
    const m = slimOpenRouterModel({ id: "x/y", name: "Y", context_length: 8000, top_provider: {} });
    assert.equal(m.max_completion_tokens, null, "null → modelOutputCeiling() default applies downstream");
    assert.equal(m.context_length, 8000);
  });

  test("supports_structured is false when supported_parameters lacks the keys", () => {
    const m = slimOpenRouterModel({ id: "a/b", supported_parameters: ["temperature", "top_p"] });
    assert.equal(m.supports_structured, false);
    assert.equal(m.supports_tools, false);
  });

  test("missing/garbage fields degrade to safe defaults (no throw)", () => {
    const m = slimOpenRouterModel({});
    assert.equal(m.id, "");
    assert.equal(m.max_completion_tokens, null);
    assert.equal(m.context_length, null);
    assert.equal(m.pricing, null);
    assert.equal(m.supports_structured, false);
    assert.equal(m.modality, null);
  });
});

describe("safeParseModelCaps", () => {
  test("valid JSON object → parsed", () => {
    assert.deepEqual(safeParseModelCaps('{"openai/gpt-4o":16384}'), { "openai/gpt-4o": 16384 });
  });
  test("undefined / malformed / array → {}", () => {
    assert.deepEqual(safeParseModelCaps(undefined), {});
    assert.deepEqual(safeParseModelCaps("not json"), {});
    assert.deepEqual(safeParseModelCaps("[1,2,3]"), {}, "an array is not a model→cap map");
  });
});

describe("buildPassRouting — per-pass model routing + smartness hint", () => {
  const KEYS = [
    "AI_MODEL", "NODEDEX_PRIMARY_MODEL", "NODEDEX_REASONING_MODEL", "NODEDEX_STRUCTURAL_MODEL",
    "NODEDEX_COMPREHEND_MODEL", "NODEDEX_JUDGE_MODEL", "NODEDEX_PASS2B_MODEL",
    "NODEDEX_PASS3_MODEL", "NODEDEX_PASS4_MODEL", "NODEDEX_PASS5_MODEL",
  ];
  let saved: Record<string, string | undefined>;
  beforeEach(() => { saved = {}; for (const k of KEYS) { saved[k] = process.env[k]; delete process.env[k]; } });
  afterEach(() => { for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]!; } });

  const stage = (r: ReturnType<typeof buildPassRouting>, name: string) => r.stages.find((s) => s.stage === name)!;

  test("no overrides → every stage resolves to the default model", () => {
    process.env.AI_MODEL = "google/gemini-2.5-flash";
    const r = buildPassRouting();
    assert.equal(r.default_model, "google/gemini-2.5-flash");
    for (const s of r.stages) assert.equal(s.effective, "google/gemini-2.5-flash", `${s.stage} → default`);
  });

  test("per-stage override wins over tier and default", () => {
    process.env.AI_MODEL = "default-model";
    process.env.NODEDEX_REASONING_MODEL = "smart-model";
    process.env.NODEDEX_PASS3_MODEL = "build-special";
    const r = buildPassRouting();
    assert.equal(stage(r, "build").effective, "build-special", "override wins");
    assert.equal(stage(r, "build").override, "build-special");
  });

  test("REASONING tier applies to smart stages (selector/build/connect), not to comprehend", () => {
    process.env.AI_MODEL = "default-model";
    process.env.NODEDEX_REASONING_MODEL = "smart-model";
    const r = buildPassRouting();
    assert.equal(stage(r, "selector").effective, "smart-model", "judge → reasoning tier");
    assert.equal(stage(r, "build").effective, "smart-model", "pass3 → reasoning tier");
    assert.equal(stage(r, "connect").effective, "smart-model", "pass4 → reasoning tier");
    assert.equal(stage(r, "comprehend").effective, "default-model", "comprehend has no tier — falls to default");
  });

  test("STRUCTURAL tier applies to the mechanical fill stage", () => {
    process.env.AI_MODEL = "default-model";
    process.env.NODEDEX_STRUCTURAL_MODEL = "cheap-model";
    assert.equal(stage(buildPassRouting(), "fill").effective, "cheap-model");
  });

  test("comprehend reads its OWN env knob (the workhorse)", () => {
    process.env.AI_MODEL = "default-model";
    process.env.NODEDEX_COMPREHEND_MODEL = "comprehend-special";
    const s = stage(buildPassRouting(), "comprehend");
    assert.equal(s.effective, "comprehend-special");
    assert.equal(s.tier, "smart");
  });

  test("tier hint matches the stage tier", () => {
    process.env.AI_MODEL = "m";
    const r = buildPassRouting();
    assert.equal(stage(r, "comprehend").hint, "wants a strong model");
    assert.equal(stage(r, "fill").hint, "a cheap model is fine");
    assert.equal(stage(r, "chain").hint, "moderate");
  });
});
