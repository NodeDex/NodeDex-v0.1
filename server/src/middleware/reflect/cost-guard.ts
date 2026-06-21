// middleware/reflect/cost-guard.ts — cost circuit breaker (production gap 2).
//
// TRACK already exists (the usage ledger + the live OpenRouter balance). This is
// the CONTROL half: read spend, compare to a budget, and TRIP by reusing the
// reflect-pause lever so a runaway never silently drains credit. Two guards,
// each DEFAULT OFF (unset = no limit = today's behavior):
//   PRIMARY   — live OpenRouter remaining-credit floor (ground truth; catches
//               every call type, incl. the ledger's blind spots). Fail-CLOSED:
//               if the floor is set but the balance can't be read, we trip
//               ("don't spend when we can't confirm budget"). NODEDEX_MIN_CREDIT_USD
//   SECONDARY — ledger rolling-24h spend cap (fast, local, 97.8% real billed).
//               NODEDEX_DAILY_BUDGET_USD
//
// Shape: a PURE evaluateBudget(config, observed) so the verdict logic is unit-
// testable with crafted numbers (no network, no clock), plus a thin async
// evaluateBudgetLive() that gathers the observed values. No import from
// routes/state.ts — the wiring point there owns the trip ACTION (setReflectPaused
// + writePauseFile) so there's no import cycle.

import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "fs";
import { homedir } from "os";
import path from "path";
import { getSpendSince } from "../../engine/providers/usage-ledger.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const CREDIT_CACHE_TTL_MS = 60_000;

// When NO floor is configured, a HARD exhaustion (remaining at/below this epsilon) is
// still caught by the reactive credit-out probe — so a genuine $0 outage always pauses
// + requeues even with the soft proactive floor left off (its default). A user-set
// NODEDEX_MIN_CREDIT_USD overrides this for the reactive check too.
const CREDIT_OUT_EPSILON_USD = 0.01;

// ─── Config ───────────────────────────────────────────────────────────────────

export interface BudgetConfig {
  minCreditUsd: number | null;   // PRIMARY floor on live remaining credits
  dailyBudgetUsd: number | null; // SECONDARY rolling-24h ledger-spend cap
}

function parseUsd(v: string | undefined): number | null {
  if (v == null || v.trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

export function readBudgetConfig(): BudgetConfig {
  return {
    minCreditUsd:   parseUsd(process.env.NODEDEX_MIN_CREDIT_USD),
    dailyBudgetUsd: parseUsd(process.env.NODEDEX_DAILY_BUDGET_USD),
  };
}

// ─── Live credit (ground truth) ────────────────────────────────────────────────

// Discriminated so the breaker can tell "floor inapplicable" (not an OpenRouter
// setup → no-op) apart from "fetch failed" (transient → fail-closed).
export type CreditStatus =
  | { kind: "ok"; remaining: number; total_credits: number | null; total_usage: number | null }
  | { kind: "unconfigured" }  // not an OpenRouter setup → the floor can't apply
  | { kind: "error" };        // OpenRouter, but the balance fetch failed

let creditCache: { status: CreditStatus; at: number } | null = null;

/**
 * Live OpenRouter remaining credits, cached ~60s (the gate runs before every
 * reflect job; we must not hammer the endpoint). Shared by /api/usage/balance
 * and the breaker so both read one source.
 */
export async function fetchOpenRouterCredits(force = false): Promise<CreditStatus> {
  const baseIsOpenRouter = (process.env.OPENAI_BASE_URL ?? "").includes("openrouter");
  const key = process.env.OPENROUTER_API_KEY ?? process.env.OPENAI_API_KEY;
  if (!baseIsOpenRouter || !key) return { kind: "unconfigured" };

  // force bypasses the cache — the reactive credit-out probe must read the LIVE balance
  // right after a failed call, not a stale "ok" read from up to 60s ago that would mask a
  // just-now exhaustion (→ the turn would be dropped instead of paused + requeued).
  if (!force && creditCache && Date.now() - creditCache.at < CREDIT_CACHE_TTL_MS) {
    return creditCache.status;
  }
  let status: CreditStatus;
  try {
    const r = await fetch("https://openrouter.ai/api/v1/credits", {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) {
      status = { kind: "error" };
    } else {
      const j: any = await r.json();
      const total_credits = j?.data?.total_credits ?? null;
      const total_usage = j?.data?.total_usage ?? null;
      status = total_credits !== null && total_usage !== null
        ? { kind: "ok", remaining: total_credits - total_usage, total_credits, total_usage }
        : { kind: "error" };
    }
  } catch {
    status = { kind: "error" };
  }
  creditCache = { status, at: Date.now() };
  return status;
}

// ─── Verdict ───────────────────────────────────────────────────────────────────

export interface BudgetVerdict {
  tripped: boolean;
  reason: string | null;
  config: BudgetConfig;
  observed: { credit: CreditStatus; spend24h: number };
}

/**
 * PURE budget evaluation. No guard configured → never trips (default OFF).
 * PRIMARY credit floor is checked first (ground truth + fail-closed), then the
 * SECONDARY rolling-24h cap. Exported for direct unit testing.
 */
export function evaluateBudget(config: BudgetConfig, observed: { credit: CreditStatus; spend24h: number }): BudgetVerdict {
  const base = { config, observed };
  if (config.minCreditUsd == null && config.dailyBudgetUsd == null) {
    return { tripped: false, reason: null, ...base };
  }
  // PRIMARY — live remaining-credit floor.
  if (config.minCreditUsd != null) {
    if (observed.credit.kind === "error") {
      return { tripped: true, reason: `live balance unavailable and NODEDEX_MIN_CREDIT_USD=$${config.minCreditUsd} is set — fail-closed (won't spend without confirming budget)`, ...base };
    }
    if (observed.credit.kind === "ok" && observed.credit.remaining < config.minCreditUsd) {
      return { tripped: true, reason: `remaining $${observed.credit.remaining.toFixed(2)} below floor $${config.minCreditUsd.toFixed(2)} (NODEDEX_MIN_CREDIT_USD)`, ...base };
    }
    // "unconfigured" → the floor can't apply here; fall through to the daily cap.
  }
  // SECONDARY — rolling-24h ledger spend.
  if (config.dailyBudgetUsd != null && observed.spend24h >= config.dailyBudgetUsd) {
    return { tripped: true, reason: `24h spend $${observed.spend24h.toFixed(2)} reached budget $${config.dailyBudgetUsd.toFixed(2)} (NODEDEX_DAILY_BUDGET_USD)`, ...base };
  }
  return { tripped: false, reason: null, ...base };
}

/**
 * Gather the live observed values and evaluate. Short-circuits to a no-op with
 * NO I/O when no guard is configured, so the per-job gate costs nothing by
 * default. Only fetches the balance if the credit floor is set; only reads the
 * ledger window if the daily cap is set.
 */
export async function evaluateBudgetLive(nowMs: number = Date.now()): Promise<BudgetVerdict> {
  const config = readBudgetConfig();
  if (config.minCreditUsd == null && config.dailyBudgetUsd == null) {
    return { tripped: false, reason: null, config, observed: { credit: { kind: "unconfigured" }, spend24h: 0 } };
  }
  const credit: CreditStatus = config.minCreditUsd != null ? await fetchOpenRouterCredits() : { kind: "unconfigured" };
  const spend24h = config.dailyBudgetUsd != null ? getSpendSince(nowMs - DAY_MS) : 0;
  return evaluateBudget(config, { credit, spend24h });
}

/**
 * Safe budget check for the autonomous background workers (flag-reviewer,
 * stage-audit, describer). Returns the verdict, or null if the breaker itself
 * throws — fail OPEN, because a guard must never break the worker it guards.
 *
 * Unlike the reflect gate, a worker that sees `tripped` just SKIPS its tick
 * (no pause file, no global pause): every spend path self-gates, and a worker
 * re-checks each tick, so it halts while over budget and auto-resumes when the
 * credit/window recovers. Reflect keeps its persistent manual-resume semantics
 * because it's the user-facing pipeline; the workers are background enrichment.
 */
export async function budgetTripped(): Promise<BudgetVerdict | null> {
  try {
    return await evaluateBudgetLive();
  } catch (e) {
    console.error("[cost-breaker] worker budget check threw — proceeding WITHOUT skipping:", e);
    return null;
  }
}

// ─── Trip persistence ───────────────────────────────────────────────────────────

export function pauseFilePath(): string {
  return path.join(homedir(), ".nodedex", "reflect-pause");
}

/**
 * Persist the trip by writing the reflect-pause file the boot path already
 * honors — so a restart can't bypass the budget. Self-documenting content (the
 * reason + timestamp); the boot check only tests existence. Best-effort.
 */
export function writePauseFile(reason: string): void {
  try {
    const p = pauseFilePath();
    const dir = path.dirname(p);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(p, JSON.stringify({ reason, tripped_at: new Date().toISOString(), by: "cost-breaker" }) + "\n", "utf8");
  } catch {
    /* persistence is best-effort; the in-memory pause still holds this session */
  }
}

// ─── Reactive credit-out probe ──────────────────────────────────────────────────

export interface CreditOutVerdict {
  out: boolean;             // the account is out of credit (balance at/below the effective floor)
  remaining: number | null; // live remaining USD, or null when unreadable / not OpenRouter
  floor: number;            // the floor the balance was compared against
  reason: string;           // human-readable
}

/**
 * "Did an extraction just fail because the account is out of credit?" — the REACTIVE
 * backstop the reflect queue calls on a failure, with a FORCE-REFRESHED live balance
 * (no stale cache masking a just-now exhaustion). Out ⟺ the balance is readable AND at
 * or below the effective floor (the user's NODEDEX_MIN_CREDIT_USD when set, else a tiny
 * epsilon so a genuine ~$0 outage is always caught even with the soft floor off).
 *
 * Deliberately conservative on the unknowns: a non-OpenRouter setup ("unconfigured") or
 * an unreadable balance ("error") returns out=false — we do NOT guess credit-out from a
 * network blip; the normal failure path handles those. The DEFINITIVE 402 signal
 * (isInsufficientCreditError on the raw error) is the queue's primary detector; this
 * balance probe is the secondary net for paths where the 402 didn't surface.
 */
export async function creditExhausted(): Promise<CreditOutVerdict> {
  const floor = readBudgetConfig().minCreditUsd ?? CREDIT_OUT_EPSILON_USD;
  const credit = await fetchOpenRouterCredits(true);
  if (credit.kind === "ok") {
    const out = credit.remaining <= floor;
    return { out, remaining: credit.remaining, floor, reason: out ? `remaining $${credit.remaining.toFixed(2)} at/below floor $${floor.toFixed(2)}` : `remaining $${credit.remaining.toFixed(2)} above floor $${floor.toFixed(2)}` };
  }
  return { out: false, remaining: null, floor, reason: credit.kind === "unconfigured" ? "not an OpenRouter setup — balance not checked" : "balance unreadable — not assuming credit-out" };
}

/**
 * "Has credit POSITIVELY recovered?" — the auto-resume gate. Unlike `creditExhausted`,
 * this is conservative the OTHER way: it returns recovered=true ONLY on a readable
 * balance strictly above the floor. An indeterminate balance (non-OpenRouter setup, or
 * an unreadable fetch) is NOT "recovered" — so a spend-pause never auto-lifts on a guess;
 * those setups resume manually (POST /api/reflect/resume). Force-refreshes the balance.
 */
export async function creditRecovered(): Promise<{ recovered: boolean; remaining: number | null }> {
  const floor = readBudgetConfig().minCreditUsd ?? CREDIT_OUT_EPSILON_USD;
  const c = await fetchOpenRouterCredits(true);
  if (c.kind === "ok") return { recovered: c.remaining > floor, remaining: c.remaining };
  return { recovered: false, remaining: null };
}

// ─── Spend-pause persistence (distinct from the capture reflect-pause) ────────────
// The cost-breaker + credit-out handler pause SPENDING (the drain), but capture keeps
// queuing — a different lever from the reflect-pause file (which drops capture). It gets
// its OWN file so (a) boot restores it as a spend-pause, not a capture-pause, and (b) the
// auto-resume timer only ever deletes THIS file — never the user's/dogfood reflect-pause.

export function spendPauseFilePath(): string {
  return path.join(homedir(), ".nodedex", "spend-pause");
}

export function writeSpendPauseFile(reason: string): void {
  try {
    const p = spendPauseFilePath();
    const dir = path.dirname(p);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(p, JSON.stringify({ reason, paused_at: new Date().toISOString(), by: "cost-breaker" }) + "\n", "utf8");
  } catch {
    /* best-effort; the in-memory spendPaused flag still holds this session */
  }
}

export function spendPauseFileExists(): boolean {
  try { return existsSync(spendPauseFilePath()); } catch { return false; }
}

export function readSpendPauseReason(): string | null {
  try { return JSON.parse(readFileSync(spendPauseFilePath(), "utf8")).reason ?? null; } catch { return null; }
}

export function clearSpendPauseFile(): void {
  try { rmSync(spendPauseFilePath(), { force: true }); } catch { /* best-effort */ }
}
