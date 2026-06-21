// flag-surface.ts — the PULL side of flag-resolution for the MCP agent.
//
// A passive MCP tool can't push the agent a "the graph needs your judgment" signal.
// So instead:
//   • buildAgentFlagSurface — the agent PULLS its routed flags inside workspace_stats
//     (mirrors the `extraction` freshness field), each rendered as a plain-English
//     question via the shared renderAgentFlag (single source of truth with the REST
//     /api/flags/agent-pending surface — they can't drift).
//   • appendFlagNudge — a one-line "N items need your input" note appended to EVERY
//     tool result when work is waiting, so the agent discovers it by bumping into it
//     on calls it was already making (it would never know to look otherwise).
//
// Only owner-unknown dup flags reach getAgentPendingFlags today (the reviewer routes
// them via markFlagPendingClarification when it refuses to guess ownership). The
// reviewer auto-cleans every clear case; this surface is ONLY that ambiguous residue.

import type { WorkspaceDB } from "../store/database.js";
import {
  getAgentPendingFlags,
  countAgentPendingFlags,
} from "../middleware/reflect/pipeline-flags.js";
import { renderAgentFlag, type RenderedAgentFlag } from "../middleware/reflect/render-agent-flag.js";

const SURFACE_LIMIT = 5; // cap items in the pull; the count is the full backlog

export interface AgentFlagSurface {
  needs_your_input: number;      // full count of routed flags awaiting the agent
  items: RenderedAgentFlag[];    // up to SURFACE_LIMIT, oldest first
}

/** The flags pull embedded in workspace_stats. Cheap: one COUNT + ≤5 renders. */
export function buildAgentFlagSurface(db: WorkspaceDB, limit = SURFACE_LIMIT): AgentFlagSurface {
  const raw = (db as unknown as { db: import("better-sqlite3").Database }).db;
  const needs = countAgentPendingFlags(raw);
  const flags = getAgentPendingFlags(raw, { limit });
  const items = flags
    .map((f) => renderAgentFlag(raw, f))
    .filter((x): x is RenderedAgentFlag => x !== null);
  return { needs_your_input: needs, items };
}

/** Cheap count, for the nudge. */
export function countAgentFlags(db: WorkspaceDB): number {
  const raw = (db as unknown as { db: import("better-sqlite3").Database }).db;
  return countAgentPendingFlags(raw);
}

type ToolResult = { content?: Array<{ type: "text"; text: string }> } | undefined;

/**
 * Append a passive "N items need your input" nudge to a tool result when flags are
 * waiting. Adds a SEPARATE text item (never mutates the data payload), so it can't
 * corrupt the JSON the agent parses. Best-effort: a failure here must never break
 * the tool. `toolName` lets us skip self-reference on workspace_stats (the agent is
 * already looking at the flags there).
 */
export function appendFlagNudge(result: ToolResult, db: WorkspaceDB, toolName?: string): ToolResult {
  try {
    if (toolName === "workspace_stats") return result; // it already carries the full surface
    if (!result || !Array.isArray(result.content)) return result;
    const n = countAgentFlags(db);
    if (n <= 0) return result;
    result.content.push({
      type: "text",
      text:
        `ℹ ${n} memory item${n > 1 ? "s" : ""} need${n > 1 ? "" : "s"} your input when you have a moment — ` +
        `call workspace_stats (free, read-only) to see the question${n > 1 ? "s" : ""}.`,
    });
  } catch { /* nudge is best-effort — never break a tool */ }
  return result;
}
