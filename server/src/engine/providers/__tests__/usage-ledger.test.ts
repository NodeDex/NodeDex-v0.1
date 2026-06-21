import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, rmSync, mkdtempSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import type { LLMProvider, GenerateResult } from "../../ai-provider.js";
import { wrapWithUsageLedger, getUsageSummary } from "../usage-ledger.js";

type Usage = NonNullable<GenerateResult<unknown>["usage"]>;

/** Minimal fake provider. `model: null` simulates the no-API-key early return. */
function fakeProvider(usage: Usage | undefined, model: string | null = "gemini-2.5-flash"): LLMProvider {
  return {
    getName: () => "test",
    isAvailable: () => true,
    ping: async () => true,
    generate: async () => "ok",
    async generateStructured<T>() {
      const res: GenerateResult<T> = { result: {} as T, rateLimited: false, usage };
      if (model !== null) res.model = model;
      return res;
    },
  };
}

describe("usage-ledger", () => {
  let dir: string;
  let ledger: string;
  const savedEnabled = process.env.NODEDEX_USAGE_LEDGER;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "nodedex-usage-"));
    ledger = path.join(dir, "api-usage.jsonl");
    process.env.NODEDEX_USAGE_LEDGER_PATH = ledger;
    delete process.env.NODEDEX_USAGE_LEDGER; // default on
  });

  afterEach(() => {
    delete process.env.NODEDEX_USAGE_LEDGER_PATH;
    if (savedEnabled === undefined) delete process.env.NODEDEX_USAGE_LEDGER;
    else process.env.NODEDEX_USAGE_LEDGER = savedEnabled;
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("records a priced call with computed (estimated) cost", async () => {
    const p = wrapWithUsageLedger(fakeProvider({ input: 1000, output: 2000, thinking: 500 }));
    const r = await p.generateStructured("sys", "user", {});
    assert.equal(r.rateLimited, false); // result passes through untouched

    const s = getUsageSummary();
    assert.equal(s.total.calls, 1);
    assert.equal(s.total.input, 1000);
    assert.equal(s.total.output, 2000);
    assert.equal(s.total.thinking, 500);
    // gemini-2.5-flash: (1000*0.30 + 2000*2.50 + 500*2.50) / 1e6  (thinking billed as output)
    const expected = (1000 * 0.3 + 2000 * 2.5 + 500 * 2.5) / 1_000_000;
    assert.ok(Math.abs(s.total.cost_usd - expected) < 1e-9, `cost ${s.total.cost_usd} ~ ${expected}`);
    assert.equal(s.cost_sources.estimated, 1);
    assert.equal(s.recent[0].cost_source, "estimated");
    assert.ok(s.since && s.latest);
    assert.equal(s.by_model["gemini-2.5-flash"].calls, 1);
  });

  it("uses the provider's ACTUAL cost when present (openrouter_actual, not the estimate)", async () => {
    // costUsd deliberately != the table estimate → must win.
    const p = wrapWithUsageLedger(fakeProvider({ input: 1000, output: 2000, thinking: 0, costUsd: 0.123 }));
    await p.generateStructured("s", "u", {});
    const s = getUsageSummary();
    assert.equal(s.total.cost_usd, 0.123);
    assert.equal(s.cost_sources.openrouter_actual, 1);
    assert.equal(s.cost_sources.estimated, 0);
    assert.equal(s.recent[0].cost_source, "openrouter_actual");
  });

  it("accumulates across calls and breaks down by model", async () => {
    const flash = wrapWithUsageLedger(fakeProvider({ input: 100, output: 100, thinking: 0 }, "gemini-2.5-flash"));
    const pro = wrapWithUsageLedger(fakeProvider({ input: 200, output: 200, thinking: 0 }, "gemini-2.5-pro"));
    await flash.generateStructured("s", "u", {});
    await flash.generateStructured("s", "u", {});
    await pro.generateStructured("s", "u", {});

    const s = getUsageSummary();
    assert.equal(s.total.calls, 3);
    assert.equal(s.by_model["gemini-2.5-flash"].calls, 2);
    assert.equal(s.by_model["gemini-2.5-pro"].calls, 1);
    assert.equal(s.total.input, 400);
  });

  it("marks an unpriced model as unknown (cost null, never fabricated)", async () => {
    const p = wrapWithUsageLedger(fakeProvider({ input: 10, output: 10, thinking: 0 }, "some/unknown-model"));
    await p.generateStructured("s", "u", {});
    const s = getUsageSummary();
    assert.equal(s.total.calls, 1);
    assert.equal(s.total.unpriced_calls, 1);
    assert.equal(s.total.cost_usd, 0); // unknown excluded from the $ total, not counted as 0-cost
    assert.equal(s.cost_sources.unknown, 1);
  });

  it("writes nothing when disabled", async () => {
    process.env.NODEDEX_USAGE_LEDGER = "off";
    const p = wrapWithUsageLedger(fakeProvider({ input: 10, output: 10, thinking: 0 }));
    const r = await p.generateStructured("s", "u", {});
    assert.equal(r.rateLimited, false); // generation still works
    assert.equal(existsSync(ledger), false);
    const s = getUsageSummary();
    assert.equal(s.enabled, false);
    assert.equal(s.total.calls, 0);
  });

  it("does NOT record a no-API-key call (no model set)", async () => {
    const p = wrapWithUsageLedger(fakeProvider(undefined, null)); // model null → not a real key call
    await p.generateStructured("s", "u", {});
    const s = getUsageSummary();
    assert.equal(s.total.calls, 0);
  });
});
