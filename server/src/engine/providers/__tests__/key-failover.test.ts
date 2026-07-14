// Unit tests for KEY-FAILOVER (option B) in OpenAIProvider.generateStructured.
// The orchestrator runs the model list on the ACTIVE key, and — when that key can't
// authenticate (401) or can't pay (402/credit, user-gated) — re-runs the SAME model on
// the FALLBACK key. Same model, different key ⇒ no determinism trap.
//
// We can't hit the network, so we inject fake clients: overwrite the provider's private
// `client` and prime its `_fbClient` cache (keyed to the fallback env we set) so
// fallbackClient() returns our stub. Each stub records the models it was asked for, so we
// can assert WHICH key ran WHICH model.

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { OpenAIProvider } from "../openai.js";

const MODEL = "failover-test-model";
const FB_BASE = "https://openrouter.ai/api/v1";

// A completion body the provider accepts as a clean success.
const okCompletion = (content = '{"ok":true}') => ({
  choices: [{ message: { content }, finish_reason: "stop" }],
  usage: { prompt_tokens: 10, completion_tokens: 5 },
});

type CreateFn = (args: any) => Promise<any>;
function fakeClient(models: string[], impl: CreateFn) {
  return { chat: { completions: { create: (args: any) => { models.push(args.model); return impl(args); } } } };
}

// Build a provider with an injected active client and (optionally) a primed fallback client.
function makeProvider(active: CreateFn, fallback?: CreateFn): {
  provider: OpenAIProvider; activeModels: string[]; fbModels: string[];
} {
  const activeModels: string[] = [];
  const fbModels: string[] = [];
  const p = new OpenAIProvider("sk-active", FB_BASE);
  (p as any).client = fakeClient(activeModels, active);
  if (fallback) {
    // fallbackClient() reads these env vars and returns the cache when (key, base) match.
    process.env.NODEDEX_FALLBACK_API_KEY = "sk-fallback";
    process.env.NODEDEX_FALLBACK_BASE_URL = FB_BASE;
    (p as any)._fbClient = { key: "sk-fallback", base: FB_BASE, client: fakeClient(fbModels, fallback) };
  }
  return { provider: p, activeModels, fbModels };
}

const billingOut: CreateFn = async () => { throw { status: 402, message: "insufficient credit" }; };
const authFail: CreateFn = async () => { throw { status: 401, message: "invalid api key" }; };
const succeed: CreateFn = async () => okCompletion();

let saved: Record<string, string | undefined>;
beforeEach(() => {
  saved = {
    AI_MODEL: process.env.AI_MODEL,
    NODEDEX_FALLBACK_MODEL: process.env.NODEDEX_FALLBACK_MODEL,
    NODEDEX_FALLBACK_API_KEY: process.env.NODEDEX_FALLBACK_API_KEY,
    NODEDEX_FALLBACK_BASE_URL: process.env.NODEDEX_FALLBACK_BASE_URL,
    NODEDEX_FAILOVER_ON_BILLING: process.env.NODEDEX_FAILOVER_ON_BILLING,
  };
  process.env.AI_MODEL = MODEL;
  delete process.env.NODEDEX_FALLBACK_MODEL;   // keep modelsToTry = [MODEL] (single model)
  delete process.env.NODEDEX_FALLBACK_API_KEY;
  delete process.env.NODEDEX_FALLBACK_BASE_URL;
  delete process.env.NODEDEX_FAILOVER_ON_BILLING; // default = on
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

describe("key-failover (generateStructured orchestrator)", () => {
  test("billing-out on active + failover ON → succeeds on the fallback key, SAME model", async () => {
    const { provider, activeModels, fbModels } = makeProvider(billingOut, succeed);
    const r = await provider.generateStructured("sys", "in", {});
    assert.deepEqual(r.result, { ok: true }, "recovered on the fallback key");
    assert.ok(!r.creditExhausted, "not surfaced as credit-exhausted — the fallback paid");
    assert.deepEqual(activeModels, [MODEL], "active key tried the model once");
    assert.deepEqual(fbModels, [MODEL], "fallback key tried the SAME model (no determinism trap)");
  });

  test("billing-out on active + failover OFF → does NOT fail over; returns creditExhausted", async () => {
    process.env.NODEDEX_FAILOVER_ON_BILLING = "off";
    const { provider, fbModels } = makeProvider(billingOut, succeed);
    const r = await provider.generateStructured("sys", "in", {});
    assert.equal(r.result, null, "no result — respected the pause");
    assert.ok(r.creditExhausted, "surfaced creditExhausted so the queue pauses the spend");
    assert.deepEqual(fbModels, [], "fallback key was NOT spent on a billing-out with failover off");
  });

  test("AUTH failure on active → fails over regardless of the billing toggle", async () => {
    process.env.NODEDEX_FAILOVER_ON_BILLING = "off"; // even off, a broken key is not a spend decision
    const { provider, activeModels, fbModels } = makeProvider(authFail, succeed);
    const r = await provider.generateStructured("sys", "in", {});
    assert.deepEqual(r.result, { ok: true }, "recovered on the fallback key after a 401");
    assert.deepEqual(activeModels, [MODEL], "active key tried once and was rejected");
    assert.deepEqual(fbModels, [MODEL], "fallback key ran the same model");
  });

  test("no fallback key configured → billing-out just returns creditExhausted (no failover)", async () => {
    const { provider } = makeProvider(billingOut); // no fallback client
    const r = await provider.generateStructured("sys", "in", {});
    assert.equal(r.result, null);
    assert.ok(r.creditExhausted, "single-key setup pauses on billing-out, unchanged behaviour");
  });

  test("both keys bill out → creditExhausted after trying both", async () => {
    const { provider, activeModels, fbModels } = makeProvider(billingOut, billingOut);
    const r = await provider.generateStructured("sys", "in", {});
    assert.equal(r.result, null);
    assert.ok(r.creditExhausted, "pause only when BOTH keys are exhausted");
    assert.deepEqual(activeModels, [MODEL], "active tried");
    assert.deepEqual(fbModels, [MODEL], "fallback tried too");
  });

  test("active key succeeds → fallback key is never touched", async () => {
    const { provider, activeModels, fbModels } = makeProvider(succeed, succeed);
    const r = await provider.generateStructured("sys", "in", {});
    assert.deepEqual(r.result, { ok: true });
    assert.deepEqual(activeModels, [MODEL], "active answered");
    assert.deepEqual(fbModels, [], "fallback key untouched on the happy path");
  });
});
