// model-caps-probe.test.ts — the auto-probe that learns a model's output ceiling
// from the OpenRouter catalog and remembers it in NODEDEX_MODEL_CAPS.
//
// The 2026-07-06 hy3 case this guards: unknown reasoning model + conservative default
// ceiling → thinking tokens ate max_tokens → every structured pass truncation-failed.

import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { probeCatalogCap, ensureModelCap } from "../model-caps-probe.js";
import { modelOutputCeiling, DEFAULT_CEILING } from "../model-caps.js";

/** Minimal fetch stub returning an OpenRouter-shaped /models payload. */
function catalogFetch(entries: any[]): typeof fetch {
  return (async () => ({
    ok: true,
    json: async () => ({ data: entries }),
  })) as unknown as typeof fetch;
}

const OR_BASE = "https://openrouter.ai/api/v1";

describe("probeCatalogCap", () => {
  test("returns the declared top_provider.max_completion_tokens", async () => {
    const f = catalogFetch([
      { id: "vendor/other", top_provider: { max_completion_tokens: 4096 } },
      { id: "tencent/hy3:free", top_provider: { max_completion_tokens: 262144 } },
    ]);
    assert.equal(await probeCatalogCap("tencent/hy3:free", { baseUrl: OR_BASE, fetchImpl: f }), 262144);
  });

  test("non-OpenRouter base URL → null without fetching (local ollama etc.)", async () => {
    let called = false;
    const f = (async () => { called = true; return { ok: true, json: async () => ({}) }; }) as unknown as typeof fetch;
    assert.equal(await probeCatalogCap("some/model", { baseUrl: "http://localhost:11434/v1", fetchImpl: f }), null);
    assert.equal(called, false);
  });

  test("model missing from catalog / null ceiling → null (never context_length)", async () => {
    const f = catalogFetch([
      { id: "a/no-ceiling", context_length: 262144, top_provider: { max_completion_tokens: null } },
    ]);
    assert.equal(await probeCatalogCap("a/no-ceiling", { baseUrl: OR_BASE, fetchImpl: f }), null);
    assert.equal(await probeCatalogCap("a/not-listed", { baseUrl: OR_BASE, fetchImpl: f }), null);
  });

  test("HTTP error → null", async () => {
    const f = (async () => ({ ok: false, json: async () => ({}) })) as unknown as typeof fetch;
    assert.equal(await probeCatalogCap("a/b", { baseUrl: OR_BASE, fetchImpl: f }), null);
  });
});

describe("ensureModelCap", () => {
  let dir: string;
  let envPath: string;

  beforeEach(() => {
    delete process.env.NODEDEX_MODEL_CAPS;
    dir = mkdtempSync(join(tmpdir(), "caps-probe-"));
    envPath = join(dir, ".env");
  });
  afterEach(() => {
    delete process.env.NODEDEX_MODEL_CAPS;
    rmSync(dir, { recursive: true, force: true });
  });

  test("unknown model: probes, applies to process.env, persists to .env", async () => {
    writeFileSync(envPath, "NODEDEX_ARC_AUTO_TURNS=3\n");
    const f = catalogFetch([{ id: "new/model", top_provider: { max_completion_tokens: 32768 } }]);

    const r = await ensureModelCap("new/model", { baseUrl: OR_BASE, fetchImpl: f, envPath });
    assert.equal(r.applied, true);
    assert.equal(r.cap, 32768);
    // live: the ceiling resolver sees it immediately (in-flight retries benefit)
    assert.equal(modelOutputCeiling("new/model"), 32768);
    // durable: persisted for next boot, existing keys untouched
    const file = readFileSync(envPath, "utf8");
    assert.match(file, /NODEDEX_ARC_AUTO_TURNS=3/);
    assert.match(file, /NODEDEX_MODEL_CAPS=\{"new\/model":32768\}/);
  });

  test("merges with existing overrides instead of replacing them", async () => {
    process.env.NODEDEX_MODEL_CAPS = JSON.stringify({ "kept/model": 8192 });
    const f = catalogFetch([{ id: "new/model", top_provider: { max_completion_tokens: 32768 } }]);

    const r = await ensureModelCap("new/model", { baseUrl: OR_BASE, fetchImpl: f, envPath });
    assert.equal(r.applied, true);
    assert.equal(modelOutputCeiling("kept/model"), 8192);
    assert.equal(modelOutputCeiling("new/model"), 32768);
  });

  test("existing override wins — no probe, no overwrite", async () => {
    process.env.NODEDEX_MODEL_CAPS = JSON.stringify({ "user/model": 12345 });
    let called = false;
    const f = (async () => { called = true; return { ok: true, json: async () => ({ data: [] }) }; }) as unknown as typeof fetch;

    const r = await ensureModelCap("user/model", { baseUrl: OR_BASE, fetchImpl: f, envPath });
    assert.equal(r.applied, false);
    assert.equal(called, false);
    assert.equal(modelOutputCeiling("user/model"), 12345);
  });

  test("KNOWN_CAPS model skips the probe", async () => {
    let called = false;
    const f = (async () => { called = true; return { ok: true, json: async () => ({ data: [] }) }; }) as unknown as typeof fetch;
    const r = await ensureModelCap("google/gemini-2.5-flash", { baseUrl: OR_BASE, fetchImpl: f, envPath });
    assert.equal(r.applied, false);
    assert.equal(called, false);
  });

  test("fetch failure → applied:false, conservative default stands, no throw", async () => {
    const f = (async () => { throw new Error("network down"); }) as unknown as typeof fetch;
    const r = await ensureModelCap("new/model", { baseUrl: OR_BASE, fetchImpl: f, envPath });
    assert.equal(r.applied, false);
    assert.equal(modelOutputCeiling("new/model"), DEFAULT_CEILING);
  });

  test("no model → applied:false", async () => {
    const r = await ensureModelCap(undefined, { envPath });
    assert.equal(r.applied, false);
  });
});
