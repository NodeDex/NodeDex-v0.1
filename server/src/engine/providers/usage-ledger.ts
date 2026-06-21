// ═══════════════════════════════════════════════════════════════════════════════
// USAGE LEDGER — call-level API-key metering  (2026-06-01)
//
// Why this exists:
//   The existing cost telemetry (reflectTokenStats / cost-breakdown) is PER-PASS
//   and, by design, incomplete. That left a blind spot: "was the API key called
//   at all, and how much did THIS call cost?" When credit drops there was no local
//   ground-truth ledger to diff against the provider dashboard.
//
//   This wraps the LLM provider at the ONE seam every structured key call goes
//   through — getLLMProvider() — so EVERY generateStructured() (every provider,
//   every caller, present and future) is metered into an append-only JSONL ledger
//   (default ~/.nodedex/api-usage.jsonl), one line per call:
//     { ts, model, input, output, thinking, cost_usd, cost_source, wall_ms }
//
// Design invariants:
//   - Metering NEVER breaks a generation. The inner result is sacred; all ledger
//     work is wrapped in try/catch and swallowed on failure.
//   - Only real key calls are recorded — gated on `result.model` being set (the
//     no-API-key early return carries no model, so it's correctly skipped).
//   - cost_usd prefers the provider's ACTUAL billed cost (usage.costUsd, populated
//     on the OpenRouter path) and falls back to the static-table estimate; every
//     line is tagged with cost_source so the total is never a silent mix.
//   - Default ON (observability before optimization). NODEDEX_USAGE_LEDGER=off to
//     disable; NODEDEX_USAGE_LEDGER_PATH to relocate (tests point it at a temp file).
//
// Layering note: imports computeCost from middleware/reflect/cost-pricing, a pure
// LEAF module (zero internal imports). No cycle.
// ═══════════════════════════════════════════════════════════════════════════════

import { appendFileSync, readFileSync, existsSync, mkdirSync } from "fs";
import { homedir } from "os";
import path from "path";
import type { LLMProvider, GenerateResult } from "../ai-provider.js";
import { computeCost } from "../../middleware/reflect/cost-pricing.js";

function ledgerPath(): string {
  return (
    process.env.NODEDEX_USAGE_LEDGER_PATH ??
    path.join(homedir(), ".nodedex", "api-usage.jsonl")
  );
}

function ledgerEnabled(): boolean {
  return (process.env.NODEDEX_USAGE_LEDGER ?? "on").toLowerCase() !== "off";
}

/**
 * Provenance of an entry's cost_usd, so a total is never a silent mix of real and
 * guessed numbers:
 *   - "openrouter_actual": the provider's real billed cost (most accurate)
 *   - "estimated":         computed from the static PRICING table (approximate)
 *   - "unknown":           model not priced and no actual cost reported
 */
export type CostSource = "openrouter_actual" | "estimated" | "unknown";

/** One recorded API-key call. cost_usd is null when no cost is known. */
export interface UsageLedgerEntry {
  ts: string;
  model: string;
  input: number | null;
  output: number | null;
  thinking: number | null;
  cost_usd: number | null;
  cost_source: CostSource;
  wall_ms: number;
}

/** Append one call to the ledger file. Best-effort — callers must not depend on it. */
function recordCall(res: GenerateResult<unknown>, wallMs: number): void {
  const u = res.usage; // { input, thinking, output, costUsd? }
  const tokens = u ? { input: u.input, output: u.output, thinking: u.thinking } : undefined;

  // Prefer the provider's ACTUAL billed cost; else the static-table estimate.
  const actual = u?.costUsd;
  const estimated = computeCost(tokens, res.model);
  const cost_usd = actual ?? estimated;
  const cost_source: CostSource =
    actual !== undefined && actual !== null
      ? "openrouter_actual"
      : estimated !== null
        ? "estimated"
        : "unknown";

  const entry: UsageLedgerEntry = {
    ts: new Date().toISOString(),
    model: res.model ?? "(unknown)",
    input: tokens?.input ?? null,
    output: tokens?.output ?? null,
    thinking: tokens?.thinking ?? null,
    cost_usd,
    cost_source,
    wall_ms: wallMs,
  };

  const p = ledgerPath();
  const dir = path.dirname(p);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  appendFileSync(p, JSON.stringify(entry) + "\n", "utf8");
}

/**
 * Wrap a provider so every generateStructured() call is metered into the ledger.
 * The single seam — applied once in getLLMProvider(). All other methods delegate
 * untouched. Only calls that actually hit the API (result.model set) are recorded.
 */
export function wrapWithUsageLedger(inner: LLMProvider): LLMProvider {
  return {
    getName: () => inner.getName(),
    isAvailable: () => inner.isAvailable(),
    ping: () => inner.ping(),
    generate: (prompt: string) => inner.generate(prompt), // free-form: no usage to meter
    async generateStructured<T>(
      systemPrompt: string,
      userInput: string,
      schema: object,
      options?: { thinkingBudget?: number; maxOutputTokens?: number; modelOverride?: string }
    ): Promise<GenerateResult<T>> {
      const t0 = Date.now();
      const res = await inner.generateStructured<T>(systemPrompt, userInput, schema, options);
      try {
        // Only record genuine key calls — the no-client early return has no model.
        if (ledgerEnabled() && res.model !== undefined) recordCall(res, Date.now() - t0);
      } catch {
        /* metering must never break a generation */
      }
      return res;
    },
  };
}

// ── Read side: the "return how much was used" half ───────────────────────────

interface ModelTotal {
  calls: number;
  input: number;
  output: number;
  thinking: number;
  cost_usd: number;
}

export interface UsageSummary {
  ledger_path: string;
  enabled: boolean;
  total: ModelTotal & { unpriced_calls: number };
  /** How many calls' cost is real vs estimated — tells you how much to trust cost_usd. */
  cost_sources: Record<CostSource, number>;
  by_model: Record<string, ModelTotal>;
  since: string | null;
  latest: string | null;
  recent: UsageLedgerEntry[]; // last N entries (newest last)
}

function emptyModelTotal(): ModelTotal {
  return { calls: 0, input: 0, output: 0, thinking: 0, cost_usd: 0 };
}

/**
 * Summarize the ledger file (all-time — survives restarts, unlike any in-memory
 * counter). Returns zeros if the ledger doesn't exist. Reads the whole file per
 * call (fine for a local dev ledger); `recent` caps the tail (default 20).
 * Malformed lines are skipped, not fatal.
 */
export function getUsageSummary(opts: { recent?: number } = {}): UsageSummary {
  const recentN = opts.recent ?? 20;
  const p = ledgerPath();
  const summary: UsageSummary = {
    ledger_path: p,
    enabled: ledgerEnabled(),
    total: { ...emptyModelTotal(), unpriced_calls: 0 },
    cost_sources: { openrouter_actual: 0, estimated: 0, unknown: 0 },
    by_model: {},
    since: null,
    latest: null,
    recent: [],
  };

  if (!existsSync(p)) return summary;

  let lines: string[];
  try {
    lines = readFileSync(p, "utf8").split("\n").filter((l) => l.trim().length > 0);
  } catch {
    return summary;
  }

  const parsed: UsageLedgerEntry[] = [];
  for (const line of lines) {
    let e: UsageLedgerEntry;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    parsed.push(e);

    summary.total.calls += 1;
    summary.total.input += e.input ?? 0;
    summary.total.output += e.output ?? 0;
    summary.total.thinking += e.thinking ?? 0;
    if (e.cost_usd === null || e.cost_usd === undefined) {
      summary.total.unpriced_calls += 1;
    } else {
      summary.total.cost_usd += e.cost_usd;
    }
    const src: CostSource = e.cost_source ?? "estimated";
    summary.cost_sources[src] = (summary.cost_sources[src] ?? 0) + 1;

    const m = (summary.by_model[e.model] ??= emptyModelTotal());
    m.calls += 1;
    m.input += e.input ?? 0;
    m.output += e.output ?? 0;
    m.thinking += e.thinking ?? 0;
    m.cost_usd += e.cost_usd ?? 0;
  }

  if (parsed.length > 0) {
    summary.since = parsed[0].ts ?? null;
    summary.latest = parsed[parsed.length - 1].ts ?? null;
    summary.recent = parsed.slice(-recentN);
  }

  // Round money so the JSON isn't float-noise.
  summary.total.cost_usd = Math.round(summary.total.cost_usd * 1e6) / 1e6;
  for (const m of Object.values(summary.by_model)) {
    m.cost_usd = Math.round(m.cost_usd * 1e6) / 1e6;
  }

  return summary;
}

/**
 * Sum cost_usd for ledger entries with `startMs <= ts <= endMs` (epoch millis) —
 * the fast, LOCAL windowed-spend read. Two consumers: the cost breaker's
 * rolling-window guard (via getSpendSince), and per-stage v2 front-half cost
 * attribution (each stage's [start,end] timing window → its spend, since the
 * stages run sequentially so windows don't overlap). Accurate because 97.8% of
 * entries carry the real billed cost; the blind spots (free-form generate(),
 * embeddings) aren't ledgered. Missing/unreadable ledger → 0. Malformed lines
 * skipped; null-cost entries contribute 0.
 */
export function getSpendBetween(startMs: number, endMs: number): number {
  const p = ledgerPath();
  if (!existsSync(p)) return 0;
  let lines: string[];
  try {
    lines = readFileSync(p, "utf8").split("\n").filter((l) => l.trim().length > 0);
  } catch {
    return 0;
  }
  let sum = 0;
  for (const line of lines) {
    let e: UsageLedgerEntry;
    try { e = JSON.parse(line); } catch { continue; }
    const t = Date.parse(e.ts);
    if (!Number.isFinite(t) || t < startMs || t > endMs) continue;
    if (typeof e.cost_usd === "number") sum += e.cost_usd;
  }
  return Math.round(sum * 1e6) / 1e6;
}

export function getSpendSince(sinceMs: number): number {
  return getSpendBetween(sinceMs, Number.POSITIVE_INFINITY);
}
