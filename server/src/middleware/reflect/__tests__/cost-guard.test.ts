/**
 * Cost circuit breaker (production gap 2) — verdict logic + windowed spend.
 * Run: node --import=tsx/esm --test src/middleware/reflect/__tests__/cost-guard.test.ts
 */
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { evaluateBudget, readBudgetConfig, budgetTripped, type CreditStatus } from "../cost-guard.js";
import { getSpendSince, getSpendBetween } from "../../../engine/providers/usage-ledger.js";

const OK = (remaining: number): CreditStatus => ({ kind: "ok", remaining, total_credits: null, total_usage: null });
const ERR: CreditStatus = { kind: "error" };
const UNCONF: CreditStatus = { kind: "unconfigured" };

// ─── PURE verdict ────────────────────────────────────────────────────────────

describe("evaluateBudget — default off", () => {
  test("no guard configured → never trips", () => {
    const v = evaluateBudget({ minCreditUsd: null, dailyBudgetUsd: null }, { credit: UNCONF, spend24h: 9999 });
    assert.equal(v.tripped, false);
  });
});

describe("evaluateBudget — credit floor (PRIMARY)", () => {
  const cfg = { minCreditUsd: 1, dailyBudgetUsd: null };
  test("remaining above floor → ok", () => assert.equal(evaluateBudget(cfg, { credit: OK(5), spend24h: 0 }).tripped, false));
  test("remaining below floor → tripped", () => {
    const v = evaluateBudget(cfg, { credit: OK(0.5), spend24h: 0 });
    assert.equal(v.tripped, true);
    assert.match(v.reason ?? "", /remaining .* below floor/);
  });
  test("remaining exactly at floor → ok (strict below)", () => assert.equal(evaluateBudget(cfg, { credit: OK(1), spend24h: 0 }).tripped, false));
  test("balance fetch error → FAIL-CLOSED (tripped)", () => {
    const v = evaluateBudget(cfg, { credit: ERR, spend24h: 0 });
    assert.equal(v.tripped, true);
    assert.match(v.reason ?? "", /fail-closed/);
  });
  test("not an OpenRouter setup (unconfigured) → floor inapplicable, not tripped", () => {
    assert.equal(evaluateBudget(cfg, { credit: UNCONF, spend24h: 0 }).tripped, false);
  });
});

describe("evaluateBudget — rolling-24h cap (SECONDARY)", () => {
  const cfg = { minCreditUsd: null, dailyBudgetUsd: 2 };
  test("under budget → ok", () => assert.equal(evaluateBudget(cfg, { credit: UNCONF, spend24h: 1.5 }).tripped, false));
  test("at budget → tripped (>=)", () => assert.equal(evaluateBudget(cfg, { credit: UNCONF, spend24h: 2 }).tripped, true));
  test("over budget → tripped", () => {
    const v = evaluateBudget(cfg, { credit: UNCONF, spend24h: 2.5 });
    assert.equal(v.tripped, true);
    assert.match(v.reason ?? "", /24h spend/);
  });
});

describe("evaluateBudget — both guards", () => {
  const cfg = { minCreditUsd: 1, dailyBudgetUsd: 2 };
  test("credit ok + spend under → ok", () => assert.equal(evaluateBudget(cfg, { credit: OK(5), spend24h: 1 }).tripped, false));
  test("credit fine but daily exceeded → tripped by daily", () => {
    const v = evaluateBudget(cfg, { credit: OK(5), spend24h: 3 });
    assert.equal(v.tripped, true);
    assert.match(v.reason ?? "", /24h spend/);
  });
  test("credit floor breached takes precedence", () => {
    const v = evaluateBudget(cfg, { credit: OK(0.2), spend24h: 0 });
    assert.equal(v.tripped, true);
    assert.match(v.reason ?? "", /below floor/);
  });
});

// ─── Config parsing ──────────────────────────────────────────────────────────

describe("readBudgetConfig", () => {
  afterEach(() => { delete process.env.NODEDEX_MIN_CREDIT_USD; delete process.env.NODEDEX_DAILY_BUDGET_USD; });
  test("unset → both null (default off)", () => {
    delete process.env.NODEDEX_MIN_CREDIT_USD; delete process.env.NODEDEX_DAILY_BUDGET_USD;
    assert.deepEqual(readBudgetConfig(), { minCreditUsd: null, dailyBudgetUsd: null });
  });
  test("valid numbers parsed", () => {
    process.env.NODEDEX_MIN_CREDIT_USD = "1.5"; process.env.NODEDEX_DAILY_BUDGET_USD = "10";
    assert.deepEqual(readBudgetConfig(), { minCreditUsd: 1.5, dailyBudgetUsd: 10 });
  });
  test("empty / invalid / negative → null", () => {
    process.env.NODEDEX_MIN_CREDIT_USD = "  "; process.env.NODEDEX_DAILY_BUDGET_USD = "-5";
    assert.deepEqual(readBudgetConfig(), { minCreditUsd: null, dailyBudgetUsd: null });
  });
});

// ─── Windowed spend (ledger) ─────────────────────────────────────────────────

describe("getSpendSince", () => {
  const tmp = path.join(os.tmpdir(), `nodedex-ledger-test-${process.pid}.jsonl`);
  afterEach(() => { try { fs.unlinkSync(tmp); } catch { /* ignore */ } delete process.env.NODEDEX_USAGE_LEDGER_PATH; });

  test("sums only entries within the window", () => {
    const now = Date.now();
    const line = (agoMs: number, cost: number | null) => JSON.stringify({ ts: new Date(now - agoMs).toISOString(), model: "m", input: 1, output: 1, thinking: 0, cost_usd: cost, cost_source: "estimated", wall_ms: 1 });
    fs.writeFileSync(tmp, [
      line(48 * 3600 * 1000, 5.0),   // 2 days ago — excluded
      line(1 * 3600 * 1000, 0.10),   // 1h ago — included
      line(60 * 1000, 0.05),         // 1m ago — included
      line(30 * 1000, null),         // null cost — contributes 0
      "{ broken json",                // malformed — skipped
    ].join("\n") + "\n", "utf8");
    process.env.NODEDEX_USAGE_LEDGER_PATH = tmp;
    const spend = getSpendSince(now - 24 * 3600 * 1000);
    assert.equal(spend, 0.15);
  });

  test("missing ledger → 0", () => {
    process.env.NODEDEX_USAGE_LEDGER_PATH = path.join(os.tmpdir(), `nodedex-ledger-absent-${process.pid}.jsonl`);
    assert.equal(getSpendSince(Date.now() - 1000), 0);
  });

  // getSpendBetween powers per-stage v2 front-half cost attribution.
  test("getSpendBetween sums only the [start,end] window", () => {
    const now = Date.now();
    const line = (agoMs: number, cost: number) => JSON.stringify({ ts: new Date(now - agoMs).toISOString(), model: "m", input: 1, output: 1, thinking: 0, cost_usd: cost, cost_source: "estimated", wall_ms: 1 });
    fs.writeFileSync(tmp, [
      line(10_000, 1.00), // before window — excluded
      line(5_000, 0.20),  // in window
      line(3_000, 0.05),  // in window
      line(500, 2.00),    // after window — excluded
    ].join("\n") + "\n", "utf8");
    process.env.NODEDEX_USAGE_LEDGER_PATH = tmp;
    assert.equal(getSpendBetween(now - 6_000, now - 2_000), 0.25);
  });
});

// ─── Worker self-gate path (budgetTripped) ───────────────────────────────────
// The 3 background workers (flag-reviewer, stage-audit, describer) call this.
// Tested via the daily-budget guard only, so it stays deterministic (no network).

describe("budgetTripped", () => {
  const tmp = path.join(os.tmpdir(), `nodedex-ledger-bt-${process.pid}.jsonl`);
  afterEach(() => {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    delete process.env.NODEDEX_USAGE_LEDGER_PATH;
    delete process.env.NODEDEX_DAILY_BUDGET_USD;
    delete process.env.NODEDEX_MIN_CREDIT_USD;
  });

  test("no budget configured → not tripped (worker proceeds)", async () => {
    delete process.env.NODEDEX_DAILY_BUDGET_USD; delete process.env.NODEDEX_MIN_CREDIT_USD;
    const v = await budgetTripped();
    assert.equal(v?.tripped, false);
  });

  test("daily budget exceeded → tripped (worker skips)", async () => {
    const now = Date.now();
    fs.writeFileSync(tmp, JSON.stringify({ ts: new Date(now - 60_000).toISOString(), model: "m", input: 1, output: 1, thinking: 0, cost_usd: 3.0, cost_source: "estimated", wall_ms: 1 }) + "\n", "utf8");
    process.env.NODEDEX_USAGE_LEDGER_PATH = tmp;
    process.env.NODEDEX_DAILY_BUDGET_USD = "1"; // $3 spent in 24h >= $1 budget; no credit floor => no network
    const v = await budgetTripped();
    assert.equal(v?.tripped, true);
    assert.match(v?.reason ?? "", /24h spend/);
  });
});
