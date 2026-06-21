// ═══════════════════════════════════════════════════════════════════════════════
// DEBT 5 Phase 10 — INACTIVITY SAFETY NET (server-side timer)
// ═══════════════════════════════════════════════════════════════════════════════
//
// Per design §3.8 safety net 3: when an agent has pass01_done turns sitting
// idle past a threshold (default 30 min) and no new captures since, the
// conversation is likely abandoned (user walked away, agent crashed, session
// closed without explicit arc-extract). Fire arc extraction so residue isn't
// permanently lost.
//
// Why this is the UNIVERSAL fallback per inventory §4:
//   - PreCompact hook (safety net 1) requires Claude Code emit a PreCompact event
//   - SessionEnd hook (safety net 2) is NOT available in Claude Code today
//   - Inactivity timer needs NO framework cooperation — pure server-side
//
// Config (env):
//   NODEDEX_ARC_INACTIVITY_INTERVAL_MS  default 60_000 (1 min check cadence)
//   NODEDEX_ARC_INACTIVITY_THRESHOLD_MS default 1_800_000 (30 min idle threshold)
//   NODEDEX_ARC_INACTIVITY_ENABLED      'on' to enable, 'off' (default) to skip
//
// DEFAULT OFF — opt-in via env. Reason: until per-turn capture is on
// (NODEDEX_ARC_EXTRACTION=1), there will be no pass01_done turns and the
// timer is a no-op anyway. Once arc-mode is enabled, operators flip this
// on to get the auto-trigger safety net.

import type { WorkspaceDB } from "../../store/database.js";
import { runArcExtraction } from "./arc-pipeline.js";
import { intFromEnv } from "./config.js";

let _intervalHandle: ReturnType<typeof setInterval> | null = null;

function getIntervalMs(): number {
  return intFromEnv("NODEDEX_ARC_INACTIVITY_INTERVAL_MS", 60_000, 1000);
}

function getThresholdMs(): number {
  const raw = process.env.NODEDEX_ARC_INACTIVITY_THRESHOLD_MS;
  if (raw) {
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n) && n >= 60_000) return n;
  }
  return 1_800_000;  // 30 min default
}

function arcInactivityEnabled(): boolean {
  return (process.env.NODEDEX_ARC_INACTIVITY_ENABLED ?? "").toLowerCase() === "on";
}

/**
 * Run one inactivity check. For each stale agent, fire arc extraction with
 * trigger_source='inactivity'. Per-agent failures are logged but don't stop
 * the tick. Exported so tests can drive it directly without setInterval.
 */
export async function runInactivityTick(db: WorkspaceDB): Promise<{
  checked: number;
  extracted: number;
  skipped_in_progress: number;
  skipped_rate_limited: number;
  skipped_min_range: number;
  errors: number;
}> {
  const thresholdMs = getThresholdMs();
  const agents = db.getAgentsWithStalePass01Turns(thresholdMs);
  const stats = {
    checked: agents.length,
    extracted: 0,
    skipped_in_progress: 0,
    skipped_rate_limited: 0,
    skipped_min_range: 0,
    errors: 0,
  };

  for (const agentId of agents) {
    try {
      const r = await runArcExtraction(db, {
        agent_id: agentId,
        trigger_source: "inactivity",
      });
      switch (r.status) {
        case "extracted":           stats.extracted++; break;
        case "in_progress":         stats.skipped_in_progress++; break;
        case "rate_limited":        stats.skipped_rate_limited++; break;
        case "min_range_too_small": stats.skipped_min_range++; break;
        case "no_turns":            // race: turns were extracted between query and run
        case "pipeline_incomplete": // v2 failed after retries — turns stay re-extractable, next tick retries
        case "pipeline_failed":     stats.errors++; break;
      }
    } catch (e: any) {
      stats.errors++;
      console.warn(`[arc-inactivity] runArcExtraction threw for agent=${agentId.slice(0, 8)}: ${e?.message}`);
    }
  }

  if (stats.checked > 0) {
    console.log(`[arc-inactivity] tick: checked=${stats.checked} extracted=${stats.extracted} in_progress=${stats.skipped_in_progress} rate_limited=${stats.skipped_rate_limited} min_range=${stats.skipped_min_range} errors=${stats.errors}`);
  }
  return stats;
}

/**
 * Start the inactivity check timer. Idempotent — calling twice is a no-op
 * after the first call. Honor the enabled flag — if off, do nothing.
 * Returns true if the timer started, false if it was disabled or already running.
 */
export function startArcInactivityTimer(db: WorkspaceDB): boolean {
  if (!arcInactivityEnabled()) {
    console.log("[arc-inactivity] disabled (set NODEDEX_ARC_INACTIVITY_ENABLED=on to enable)");
    return false;
  }
  if (_intervalHandle !== null) {
    return false;
  }
  const intervalMs = getIntervalMs();
  const thresholdMs = getThresholdMs();
  console.log(`[arc-inactivity] starting: interval=${intervalMs}ms threshold=${thresholdMs}ms`);
  _intervalHandle = setInterval(() => {
    runInactivityTick(db).catch((e) => {
      console.warn(`[arc-inactivity] tick threw: ${e?.message}`);
    });
  }, intervalMs);
  // Allow the process to exit even with the timer scheduled (don't block
  // shutdown). Node's setInterval refs by default; unref releases.
  if (typeof _intervalHandle.unref === "function") _intervalHandle.unref();
  return true;
}

/**
 * Stop the inactivity check timer. Used on shutdown + by tests.
 */
export function stopArcInactivityTimer(): void {
  if (_intervalHandle !== null) {
    clearInterval(_intervalHandle);
    _intervalHandle = null;
  }
}

/**
 * For tests only — reports whether the timer is currently running.
 */
export function _isArcInactivityTimerRunningForTests(): boolean {
  return _intervalHandle !== null;
}
