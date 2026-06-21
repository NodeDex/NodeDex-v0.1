// ═══════════════════════════════════════════════════════════════════════════════
// DEBT 5 Slice 2 Sub-step 2.2 — FLAG REVIEWER STARTUP / WORKER WRAPPER
// ═══════════════════════════════════════════════════════════════════════════════
//
// Env-gated setInterval wrapper around runFlagReviewerTick (flag-reviewer.ts).
// Pattern reference: arc-inactivity-timer.ts — same shape (singleton handle,
// in-flight guard, unref so tests/shutdown aren't blocked, idempotent start/
// stop, test inspector).
//
// Worker runs ONLY when NODEDEX_FLAG_REVIEWER_ENABLED=on. Default off so
// upgrading does not silently start LLM spend.
//
// Per-tick policy:
//   - One tick at a time (in-flight guard) — if a tick is still running
//     when next interval fires, skip and log.
//   - Tick errors do NOT crash the process (try/catch around runReviewerTick).
//   - Each tick logs reviewed-count / verdicts / cost.

import type { WorkspaceDB } from "../../store/database.js";
import { getLLMProvider } from "../../engine/providers/index.js";
import { runFlagReviewerTick } from "./flag-reviewer.js";
import { budgetTripped } from "./cost-guard.js";
import { intFromEnv } from "./config.js";

let _intervalHandle: ReturnType<typeof setInterval> | null = null;
let _inFlight = false;

function flagReviewerEnabled(): boolean {
  // Default ON (self-cleaning loop locked-on — validated 2026-06-20); set =off for dev/test.
  return (process.env.NODEDEX_FLAG_REVIEWER_ENABLED ?? "").toLowerCase() !== "off";
}

function getIntervalMs(): number {
  return intFromEnv("NODEDEX_FLAG_REVIEWER_INTERVAL_MS", 300_000); // default 5 min
}

async function tick(db: WorkspaceDB): Promise<void> {
  if (_inFlight) {
    console.log("[flag-reviewer] tick still running, skipping this interval");
    return;
  }
  _inFlight = true;
  try {
    // Cost breaker (production gap 2, Phase B): this autonomous worker self-gates
    // on the budget before spending. No-op when no budget is configured.
    const budget = await budgetTripped();
    if (budget?.tripped) {
      console.warn(`[flag-reviewer] tick skipped — cost breaker: ${budget.reason}`);
      return;
    }
    const provider = getLLMProvider();
    if (!provider.isAvailable()) {
      console.warn("[flag-reviewer] provider unavailable — skipping tick");
      return;
    }
    const result = await runFlagReviewerTick({ db, provider });
    if (result.reviewed === 0 && result.errors === 0) {
      // Quiet skip — common case (no pending flags). Don't spam the log.
      return;
    }
    const costStr = result.cost_usd === null ? "?" : `$${result.cost_usd.toFixed(4)}`;
    console.log(
      `[flag-reviewer] tick: reviewed=${result.reviewed} ` +
      `verdicts={merge:${result.verdicts.merge}, leave:${result.verdicts.leave}, split:${result.verdicts.split}} ` +
      `actions=${result.actions_executed} routed=${result.routed_to_agent} errors=${result.errors} cost=${costStr}`
    );
  } catch (e: any) {
    console.warn(`[flag-reviewer] tick threw: ${e?.message ?? e}`);
  } finally {
    _inFlight = false;
  }
}

/**
 * Start the flag-reviewer interval timer. Idempotent — calling twice after
 * the first call is a no-op. Returns true if the timer started, false if
 * disabled or already running.
 */
export function startFlagReviewer(db: WorkspaceDB): boolean {
  if (!flagReviewerEnabled()) {
    console.log("[flag-reviewer] disabled (set NODEDEX_FLAG_REVIEWER_ENABLED=on to enable)");
    return false;
  }
  if (_intervalHandle !== null) return false;

  const intervalMs = getIntervalMs();
  // Default ON (validated: clear-case auto-merge is correct + recoverable; weak evidence is routed, not merged); set =off for dev/test.
  const autoMerge = (process.env.NODEDEX_FLAG_AUTO_MERGE ?? "on").toLowerCase() !== "off";
  console.log(`[flag-reviewer] starting: interval=${intervalMs}ms auto_merge=${autoMerge ? "ON (Level 2)" : "OFF (Level 1 verdict-only)"}`);

  _intervalHandle = setInterval(() => {
    tick(db).catch((e) => {
      console.warn(`[flag-reviewer] interval-fired tick rejected: ${e?.message ?? e}`);
    });
  }, intervalMs);
  if (typeof _intervalHandle.unref === "function") _intervalHandle.unref();
  return true;
}

/**
 * Stop the flag-reviewer interval timer. Used on shutdown + by tests.
 */
export function stopFlagReviewer(): void {
  if (_intervalHandle !== null) {
    clearInterval(_intervalHandle);
    _intervalHandle = null;
  }
}

/**
 * For tests only — reports whether the timer is currently running.
 */
export function _isFlagReviewerRunningForTests(): boolean {
  return _intervalHandle !== null;
}
