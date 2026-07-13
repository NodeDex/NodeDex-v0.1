// onboarding-state.ts — has the memory REFLEX been persisted into the agent's own
// standing config yet?
//
// WHY THIS EXISTS (measured 2026-07-12): the reflex reaches the agent on the MCP
// `instructions` field — ONCE, at connect. Hours into a task it has scrolled out of
// context, which is exactly when the agent is committing to an approach. An agent read
// the dead_end list at 12:17, authored the room data at 14:00, and shipped the bug that
// list warned about. `workspace_onboard` was built to fix this (persist the reflex where
// the host re-reads it EVERY turn) — and no agent has ever called it, because a tool the
// model must REMEMBER to invoke has the same decay problem it is meant to cure.
//
// So the reminder rides the ONE channel that cannot decay and that we fully control:
// the tool RESULT. Every response carries a setup notice until onboard is called, then
// it stops forever. Universal — no hooks, no host-specific code, works on any MCP host.
// Self-extinguishing — the call is the extinguishing event, whether the user says yes
// or no (a decline is a decision, and we do not nag past it).
import type { WorkspaceDB } from "../store/database.js";

const KEY = "agent_reflex_onboarded";

function rawDb(db: WorkspaceDB): any {
  return (db as any).db;
}

function ensureTable(raw: any): void {
  raw.exec(`CREATE TABLE IF NOT EXISTS maintenance_state (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
}

/** Has workspace_onboard been called for this workspace? */
export function isReflexOnboarded(db: WorkspaceDB): boolean {
  try {
    const raw = rawDb(db);
    ensureTable(raw);
    const row = raw.prepare(`SELECT value FROM maintenance_state WHERE key = ?`).get(KEY) as
      | { value?: string }
      | undefined;
    return row?.value === "1";
  } catch {
    return false; // unreadable state → nudge (fail toward setup, never toward silence)
  }
}

/** Record that onboard ran. Idempotent. */
export function markReflexOnboarded(db: WorkspaceDB): void {
  try {
    const raw = rawDb(db);
    ensureTable(raw);
    raw
      .prepare(`INSERT INTO maintenance_state (key, value) VALUES (?, '1')
                ON CONFLICT(key) DO UPDATE SET value = '1'`)
      .run(KEY);
  } catch {
    /* best-effort: worst case the notice keeps showing, which is the safe direction */
  }
}

// The notice. Short — it rides EVERY tool result until setup is done, so every token here
// is paid many times over. It states the CONSEQUENCE, not just the instruction: "call this
// tool" without a reason is exactly what an agent deprioritizes under momentum.
export const SETUP_NOTICE =
  "⚠ SETUP INCOMPLETE — the memory reflex is not yet persisted. These instructions reach you ONCE, at connect, " +
  "and are gone from your context by the time you are deep in a task and actually choosing an approach — which is " +
  "exactly when this graph matters. Call workspace_onboard ONCE (it asks the user's permission, then writes a short " +
  "marked block into this project's agent instructions). This notice stops after that call.";

type ToolResult = { content?: Array<{ type: string; text?: string }> };

/**
 * Ride the tool RESULT — the one channel that cannot decay (it is re-sent on every call),
 * that every MCP host shows the model, and that needs no hook or host-specific code.
 * Appended to every result until onboard has run; silent forever after. Best-effort:
 * a failure here must never break a tool.
 *
 * Skipped on workspace_onboard's own result (it already carries the full contract).
 */
export function appendSetupNotice(result: ToolResult, db: WorkspaceDB, toolName?: string): ToolResult {
  try {
    if (toolName === "workspace_onboard") return result;
    if (!result || !Array.isArray(result.content)) return result;
    if (isReflexOnboarded(db)) return result;
    result.content.push({ type: "text", text: SETUP_NOTICE });
  } catch {
    /* best-effort — never break a tool */
  }
  return result;
}
