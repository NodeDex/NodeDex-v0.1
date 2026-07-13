// setup-state.ts — is NodeDex actually WIRED into this agent, and how do we KNOW?
//
// THE PROBLEM THIS SERVES (measured 2026-07-12): the agent does not use the system. An
// agent read the dead_end list at 12:17, authored the room data at 16:44, and shipped the
// exact bug that list warned about. It understood the list perfectly — in isolation it uses
// it every time. It failed because the instruction to LOOK arrived once, at connect, and
// had scrolled out of context by the moment it chose an approach.
//
// So NodeDex has to be wired into the agent in THREE places, each with a different lifetime:
//
//   REFLEX  — the habit, in whatever the host re-reads EVERY turn (AGENTS.md / CLAUDE.md /
//             rules file / system prompt). Survives compaction. Present at hour four.
//   CAPTURE — turns reach the pipeline. Without it the graph is EMPTY and the reflex points
//             at nothing — worse than no reflex at all.
//   GATE    — a check that fires at the MOMENT OF DECISION (pre-edit / per-turn), not at
//             session start. The only wire that does not depend on the model remembering.
//
// WE DO NOT KNOW THE HOST, AND WE DO NOT NEED TO. The agent is the host expert: it knows
// where its own standing instructions live and what its own seams are. We ask a CAPABILITY
// question, hand it the content, and it installs. That is why this is universal across
// agentic hosts instead of six per-platform integrations.
//
// ── THE RULE THAT MAKES IT TRUSTWORTHY ──────────────────────────────────────────────
// NO WIRE IS EVER MARKED DONE BECAUSE AN AGENT SAID SO. Each is verified by OBSERVED
// EFFECT, and each verification is something the code can check without trusting a claim:
//
//   reflex  → the server READS BACK the file the agent names and finds the markers.
//   capture → a turn actually LANDED in conversation_turns.
//   gate    → a gate check actually HIT the endpoint.
//
// This matters because "the model says it did a thing and didn't" is the disease we are
// treating. The first version of this file marked setup complete the instant the tool was
// CALLED — an agent could call it, write nothing, and silence the nag forever. That is the
// same bug, inside the cure.
import type { WorkspaceDB } from "../store/database.js";
import { NODEDEX_BEGIN } from "../agent-protocol.js";
import fs from "fs";

export type Wire = "reflex" | "capture" | "gate";

const K = {
  reflexPath: "setup_reflex_verified_path",
  reflexDeclined: "setup_reflex_declined",
  captureDeclined: "setup_capture_declined",
  gateSeen: "setup_gate_seen",
  gateDeclined: "setup_gate_declined",
  lastRead: "last_graph_read_at",
} as const;

function raw(db: WorkspaceDB): any {
  return (db as any).db;
}

function ensure(r: any): void {
  r.exec(`CREATE TABLE IF NOT EXISTS maintenance_state (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
}

function get(db: WorkspaceDB, key: string): string | null {
  try {
    const r = raw(db);
    ensure(r);
    const row = r.prepare(`SELECT value FROM maintenance_state WHERE key = ?`).get(key) as
      | { value?: string }
      | undefined;
    return row?.value ?? null;
  } catch {
    return null;
  }
}

function set(db: WorkspaceDB, key: string, value: string): void {
  try {
    const r = raw(db);
    ensure(r);
    r.prepare(
      `INSERT INTO maintenance_state (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ).run(key, value);
  } catch {
    /* best-effort: worst case a notice keeps showing, which is the safe direction */
  }
}

// ── verification (by observed effect, never by claim) ───────────────────────────────

/**
 * REFLEX — read the file the agent says it wrote and confirm the marked block is there.
 * Read-only: we never write the user's config, because choosing WHERE and not clobbering
 * what is already in that file needs reasoning the server does not have. The agent writes;
 * the code checks. Returns why it failed so the agent can fix it rather than guess.
 */
export function verifyReflexWrite(db: WorkspaceDB, filePath: string): { ok: boolean; reason?: string } {
  let text: string;
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch {
    // A remote/containerised agent's disk is not ours. Say so plainly instead of failing
    // it — its write may well be fine, we just cannot see it from here.
    return {
      ok: false,
      reason:
        `Cannot read ${filePath} from the server. Either the path is wrong, or you are not on the same ` +
        `machine as this NodeDex server (a container/remote agent) — in which case I cannot verify the write ` +
        `and you should simply proceed; the block you wrote still works.`,
    };
  }
  if (!text.includes(NODEDEX_BEGIN)) {
    return { ok: false, reason: `Read ${filePath}, but the nodedex marker block is not in it. Was it written verbatim?` };
  }
  set(db, K.reflexPath, filePath);
  return { ok: true };
}

/** CAPTURE — did a turn ever actually land? The only honest proof that capture is wired. */
export function captureWired(db: WorkspaceDB): boolean {
  try {
    const r = raw(db);
    const row = r.prepare(`SELECT 1 AS hit FROM conversation_turns LIMIT 1`).get() as { hit?: number } | undefined;
    return !!row?.hit;
  } catch {
    return true; // table missing/unreadable → stay silent rather than nag on a false alarm
  }
}

/** GATE — did a check ever actually reach us? Set by the /api/gate/check route. */
export function markGateSeen(db: WorkspaceDB): void {
  set(db, K.gateSeen, "1");
}

/** The user said no. A decline is a decision — record it and never nag past it. */
export function markDeclined(db: WorkspaceDB, wire: Wire): void {
  set(db, wire === "reflex" ? K.reflexDeclined : wire === "capture" ? K.captureDeclined : K.gateDeclined, "1");
}

/** Every graph read stamps the clock the GATE reads. See gateShouldRemind. */
export function recordGraphRead(db: WorkspaceDB): void {
  set(db, K.lastRead, String(Date.now()));
}

/**
 * Should the pre-edit gate speak up?
 *
 * TIME, NOT SESSION — and this is the load-bearing design call. A session-scoped check
 * ("have you read the graph this session?") would have said YES to arm B: it read at 12:17
 * and shipped the bug at 16:45, same session. What decayed was not the session, it was the
 * CONTEXT — four hours and several compactions later, the knowledge was gone. So the gate
 * asks how STALE the last read is, which is the thing we actually measured going wrong.
 */
export function gateShouldRemind(db: WorkspaceDB): boolean {
  const mins = Number(process.env.NODEDEX_GATE_STALE_MIN ?? 30);
  const last = Number(get(db, K.lastRead) ?? 0);
  if (!last) return true; // never read this graph → definitely remind
  return Date.now() - last > mins * 60_000;
}

// ── the notice (rides every tool RESULT — the one channel that cannot decay) ─────────

export interface WireState {
  reflex: boolean;
  capture: boolean;
  gate: boolean;
}

/** Which wires are done (verified) or deliberately declined — i.e. which we stay quiet about. */
export function wireState(db: WorkspaceDB): WireState {
  return {
    reflex: !!get(db, K.reflexPath) || get(db, K.reflexDeclined) === "1",
    capture: captureWired(db) || get(db, K.captureDeclined) === "1",
    gate: get(db, K.gateSeen) === "1" || get(db, K.gateDeclined) === "1",
  };
}

/**
 * The notice. Rides EVERY tool result until every wire is settled, so every token here is
 * paid many times over — it names only what is MISSING, and it states the CONSEQUENCE, not
 * just the instruction ("call this tool" with no reason is exactly what an agent
 * deprioritises under momentum).
 */
export function buildSetupNotice(db: WorkspaceDB): string | null {
  const s = wireState(db);
  if (s.reflex && s.capture && s.gate) return null;

  const lines: string[] = ["⚠ NODEDEX IS NOT FULLY WIRED INTO YOU YET — and unwired, it cannot help you."];
  if (!s.capture) {
    lines.push(
      "· CAPTURE is not proven: no conversation turn has ever reached this graph, so it is EMPTY and will stay empty. " +
        "Call workspace_install_capture.",
    );
  }
  if (!s.reflex) {
    lines.push(
      "· REFLEX is not persisted: these instructions reached you ONCE, at connect, and will be gone from your context " +
        "by the time you are deep in a task and actually choosing an approach — which is exactly when this graph " +
        "matters. Call workspace_onboard.",
    );
  }
  if (!s.gate) {
    lines.push(
      "· GATE is not installed: nothing checks the graph at the moment you edit. Call workspace_install_gate.",
    );
  }
  lines.push("Each asks the user's permission first, and each goes quiet once it is VERIFIED (not merely claimed).");
  return lines.join("\n");
}

type ToolResult = { content?: Array<{ type: string; text?: string }> };

/** The setup tools carry the full contract already — do not also nag them. */
const SETUP_TOOLS = new Set(["workspace_onboard", "workspace_install_capture", "workspace_install_gate"]);

/**
 * Ride the tool RESULT — the one channel that cannot decay (re-sent on every call), that
 * every MCP host shows the model, and that needs no hook or host-specific code.
 * Best-effort: a failure here must never break a tool.
 */
export function appendSetupNotice(result: ToolResult, db: WorkspaceDB, toolName?: string): ToolResult {
  try {
    if (toolName && SETUP_TOOLS.has(toolName)) return result;
    if (!result || !Array.isArray(result.content)) return result;
    const notice = buildSetupNotice(db);
    if (!notice) return result;
    result.content.push({ type: "text", text: notice });
  } catch {
    /* best-effort — never break a tool */
  }
  return result;
}
