// Pass 3 batched write — the back-half scale fix (2026-06-14).
// Run: node --import=tsx/esm --test src/middleware/reflect/__tests__/pass3-batch.test.ts
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  chunkItems,
  mergePass3Analyses,
  callPass3Batched,
  pass3BatchEnabled,
  pass3BatchSize,
} from "../pass3-batch.js";

afterEach(() => {
  delete process.env.NODEDEX_PASS3_BATCH;
  delete process.env.NODEDEX_PASS3_BATCH_SIZE;
  delete process.env.NODEDEX_MODEL_CAPS;
});

// A provider whose generateStructured returns ONE new_block + the SAME project_creates
// per call, so we can count calls and verify the merge. `calls` is exposed for asserts.
function mkProvider() {
  const state = { calls: 0 };
  const provider: any = {
    getName: () => "mock",
    isAvailable: () => true,
    generateStructured: async () => {
      state.calls += 1;
      return {
        result: {
          project_creates: [{ label: "proj-x", essence: "shared root" }],
          new_blocks: [{ label: `b${state.calls}`, essence: "e", from_item_id: `i${state.calls}` }],
          updates: [],
          skip_reasons: [],
        },
        rateLimited: false,
        thinking: "",
        model: "mock",
        attempts: [],
      };
    },
  };
  return { provider, state };
}
const mkItems = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `i${i}`, type: "fact", text: "x" })) as any[];

describe("chunkItems", () => {
  test("splits into ceil(n/size) chunks, last is the remainder", () => {
    const c = chunkItems([1, 2, 3, 4, 5], 2);
    assert.equal(c.length, 3);
    assert.deepEqual(c[2], [5]);
  });
  test("size >= n → single chunk", () => {
    assert.equal(chunkItems([1, 2, 3], 10).length, 1);
  });
});

describe("mergePass3Analyses", () => {
  test("concats new_blocks/updates/skip_reasons; dedups project_creates by label", () => {
    const merged = mergePass3Analyses([
      { project_creates: [{ label: "p" }], new_blocks: [{ label: "a" }], updates: [{ block_id: "u1" }], skip_reasons: [] },
      { project_creates: [{ label: "p" }], new_blocks: [{ label: "b" }], updates: [], skip_reasons: [{ item_id: "s1" }] },
      null, // a failed chunk is skipped, not fatal
    ]);
    assert.equal(merged.new_blocks!.length, 2);
    assert.equal(merged.updates!.length, 1);
    assert.equal(merged.skip_reasons!.length, 1);
    assert.equal(merged.project_creates!.length, 1, "same root coined by two chunks → one");
  });
});

describe("config", () => {
  test("default ON; =0 opts out; size default 20; env overrides", () => {
    assert.equal(pass3BatchEnabled(), true);
    assert.equal(pass3BatchSize(), 20);
    process.env.NODEDEX_PASS3_BATCH = "0";
    assert.equal(pass3BatchEnabled(), false);
    process.env.NODEDEX_PASS3_BATCH = "1";
    process.env.NODEDEX_PASS3_BATCH_SIZE = "8";
    assert.equal(pass3BatchEnabled(), true);
    assert.equal(pass3BatchSize(), 8);
  });
});

describe("pass3BatchSize — model-cap scaling (H1 part B)", () => {
  test("no model → flat default 20 (provider default assumed big-cap)", () => {
    assert.equal(pass3BatchSize(), 20);
  });
  test("big-cap model (Gemini 65535) stays at the flat reliability bound", () => {
    // (65535 - 4096) / 400 ≈ 153 >> 20 → reliability-bound at 20
    assert.equal(pass3BatchSize("google/gemini-2.5-flash"), 20);
  });
  test("gpt-4o (16384) still fits 20 — it is NOT token-bound", () => {
    // (16384 - 4096) / 400 ≈ 30 > 20 → stays at 20
    assert.equal(pass3BatchSize("openai/gpt-4o"), 20);
  });
  test("small-cap model (claude-3.5-sonnet 8192) scales DOWN (token-bound)", () => {
    // (8192 - 4096) / 400 ≈ 10 < 20 → token-bound at 10
    assert.equal(pass3BatchSize("anthropic/claude-3.5-sonnet"), 10);
  });
  test("env NODEDEX_PASS3_BATCH_SIZE sets the reliability bound; model only lowers it", () => {
    process.env.NODEDEX_PASS3_BATCH_SIZE = "12";
    assert.equal(pass3BatchSize("google/gemini-2.5-flash"), 12, "big-cap → the flat bound (now 12)");
    assert.equal(pass3BatchSize("anthropic/claude-3.5-sonnet"), 10, "small-cap token-bound (10) wins when lower");
  });
  test("tiny ceiling via NODEDEX_MODEL_CAPS → floor of 1 block/call", () => {
    process.env.NODEDEX_MODEL_CAPS = JSON.stringify({ "tiny": 3000 });
    // (3000 - 4096) <= per-block → 1
    assert.equal(pass3BatchSize("tiny"), 1);
  });
  test("zero thinking frees output budget (no scaling when nothing reserved)", () => {
    // (8192 - 0) / 400 ≈ 20 → min(20, 20) = 20
    assert.equal(pass3BatchSize("anthropic/claude-3.5-sonnet", 0), 20);
  });
});

describe("callPass3Batched", () => {
  test("flag OFF (=0) → single call regardless of item count (byte-identical to today)", async () => {
    process.env.NODEDEX_PASS3_BATCH = "0";
    const { provider, state } = mkProvider();
    await callPass3Batched(provider, mkItems(50), [], "", [], 4096, "", {}, 2);
    assert.equal(state.calls, 1);
  });

  test("flag ON but count <= batchSize → single call", async () => {
    process.env.NODEDEX_PASS3_BATCH = "1";
    const { provider, state } = mkProvider();
    await callPass3Batched(provider, mkItems(2), [], "", [], 4096, "", {}, 2);
    assert.equal(state.calls, 1);
  });

  test("flag ON + count > batchSize → chunks, calls per chunk, merges results", async () => {
    process.env.NODEDEX_PASS3_BATCH = "1";
    const { provider, state } = mkProvider();
    const r = await callPass3Batched(provider, mkItems(5), [], "", [], 4096, "", {}, 2);
    assert.equal(state.calls, 3, "5 items / batch 2 → 3 chunks");
    assert.equal(r.analysis.new_blocks.length, 3, "every chunk's new_blocks merged");
    assert.equal(r.analysis.project_creates.length, 1, "project_creates deduped across chunks");
  });

  test("all chunks fail → null analysis (existing re-queue path fires)", async () => {
    process.env.NODEDEX_PASS3_BATCH = "1";
    const provider: any = { getName: () => "mock", isAvailable: () => true, generateStructured: async () => ({ result: null, rateLimited: true, thinking: "", model: "mock", attempts: [] }) };
    const r = await callPass3Batched(provider, mkItems(5), [], "", [], 4096, "", {}, 2);
    assert.equal(r.analysis, null);
    assert.equal(r.rateLimited, true);
  });
});
