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

// ── PER-AGENT, not per-graph ─────────────────────────────────────────────────────────
//
// The REFLEX lives in one agent's standing-instructions file; the GATE lives in one agent's
// pre-edit seam. Neither is a property of the GRAPH — they are properties of an AGENT. Store
// them per-graph and the second agent to connect (the whole "one graph, many hosts" premise)
// inherits a silent "✓ wired" it never earned, gets no nag, and is exactly as blind as the
// agent we spent this week diagnosing.
//
// MCP hands us the connecting client's identity on initialize, so we key on it.
//
// CAPTURE stays GLOBAL, deliberately. It is proven by turns LANDING, and the agent_id on a
// turn comes from the watcher/adapter — it is not the MCP client name, and quietly assuming
// the two match would invent a false alarm out of a naming mismatch. So: zero turns anywhere
// ⇒ nag everyone; turns arriving ⇒ the pipeline is fed, and the per-agent notice tells a new
// agent to check capture too if its own turns aren't reaching the graph.
const KEYS = (client: string) => ({
  reflexPath: `setup_reflex_verified_path::${client}`,
  reflexDeclined: `setup_reflex_declined::${client}`,
  gateSeen: `setup_gate_seen::${client}`,
  gateDeclined: `setup_gate_declined::${client}`,
});

const K = {
  captureDeclined: "setup_capture_declined",
  gateLast: "setup_gate_last_check_at",
  gateCount: "setup_gate_check_count",
  lastRead: "last_graph_read_at",
  agents: "setup_known_agents",
} as const;

/** The connecting agent, normalised. Unknown clients share one bucket — safe, and it still
 *  nags (an agent we cannot identify is an agent we cannot assume is wired). */
export function normalizeClient(name?: string | null): string {
  const s = (name ?? "").trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return s || "unknown-agent";
}

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
export function verifyReflexWrite(db: WorkspaceDB, filePath: string, client: string): { ok: boolean; reason?: string } {
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
  set(db, KEYS(client).reflexPath, filePath);
  rememberAgent(db, client);
  return { ok: true };
}

/** Track which agents we have seen, so the status surface can show each one's wires. */
function rememberAgent(db: WorkspaceDB, client: string): void {
  const seen = (get(db, K.agents) ?? "").split(",").filter(Boolean);
  if (!seen.includes(client)) set(db, K.agents, [...seen, client].join(","));
}
export function knownAgents(db: WorkspaceDB): string[] {
  return (get(db, K.agents) ?? "").split(",").filter(Boolean);
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

/** GATE — did a check ever actually reach us? Set by the /api/gate/check route.
 *  The gate script runs in the AGENT's host, so it names the agent it fired for (?agent=…);
 *  without that we can only record that *something* is gated, which is better than nothing. */
export function markGateSeen(db: WorkspaceDB, client?: string): void {
  if (client) { set(db, KEYS(client).gateSeen, "1"); rememberAgent(db, client); }
  set(db, K.gateLast, String(Date.now()));
  set(db, K.gateCount, String(Number(get(db, K.gateCount) ?? 0) + 1));
}

/** The user said no. A decline is a decision — record it and never nag past it.
 *  Reflex/gate declines are per-agent (this agent's files); capture is global. */
export function markDeclined(db: WorkspaceDB, wire: Wire, client: string): void {
  if (wire === "capture") { set(db, K.captureDeclined, "1"); return; }
  const k = KEYS(client);
  set(db, wire === "reflex" ? k.reflexDeclined : k.gateDeclined, "1");
  rememberAgent(db, client);
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

/** Which wires are settled FOR THIS AGENT (verified or declined) — i.e. what we stay quiet
 *  about. A different agent connecting to the same graph has its own answer. */
export function wireState(db: WorkspaceDB, client: string): WireState {
  const k = KEYS(client);
  return {
    reflex: !!get(db, k.reflexPath) || get(db, k.reflexDeclined) === "1",
    capture: captureWired(db) || get(db, K.captureDeclined) === "1",
    gate: get(db, k.gateSeen) === "1" || get(db, k.gateDeclined) === "1",
  };
}

/**
 * The notice. Rides EVERY tool result until every wire is settled, so every token here is
 * paid many times over — it names only what is MISSING, and it states the CONSEQUENCE, not
 * just the instruction ("call this tool" with no reason is exactly what an agent
 * deprioritises under momentum).
 */
export function buildSetupNotice(db: WorkspaceDB, client: string): string | null {
  const s = wireState(db, client);
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
  // Another agent may already have wired ITSELF in — that does nothing for YOU. The reflex
  // lives in a file YOUR host reads; the gate lives in YOUR seam. If it was written to a
  // shared file (AGENTS.md) that you also read, verifying is a single call, not a rewrite.
  if (knownAgents(db).some((a) => a !== client)) {
    const other = knownAgents(db).filter((a) => a !== client).join(", ");
    lines.push(
      `· NOTE: another agent (${other}) is already set up here, but that does NOT wire YOU — the reflex sits in a file ` +
        "and the gate in a seam that belong to it, not to you. If the block is already in a file you ALSO read (AGENTS.md " +
        "is chosen for exactly this), just confirm: workspace_onboard(written_to=<that file>).",
    );
  }
  lines.push("Each asks the user's permission first, and each goes quiet once it is VERIFIED (not merely claimed).");
  return lines.join("\n");
}

// ── the status surface (what the TUI and any UI should show) ─────────────────────────
//
// SOURCE-AGNOSTIC ON PURPOSE. A settings screen with a toggle per watcher describes OUR
// helpers, not the user's reality: someone running their own loop (the adapter, or a raw
// POST) has every watcher OFF and is capturing perfectly — and would see a screen implying
// nothing works. So we report what ACTUALLY ARRIVED, grouped by the agent that sent it.
// Watchers are then just one way to feed this; they are not the definition of "capture".
//
// Same rule as everywhere else in this file: report observed effect, not configured intent.

export interface CaptureSource {
  agent_id: string;
  turns: number;
  last_turn_at: string | null;
}

/** One agent's wires. EVERY agent that connects needs its own — the reflex is in a file IT
 *  reads, the gate is in a seam IT runs. This is the thing the TUI must show per-agent, so a
 *  user switching hosts can SEE that the new one is unwired instead of assuming it inherited. */
export interface AgentWires {
  agent: string;
  reflex: { done: boolean; declined: boolean; file: string | null };
  gate: { done: boolean; declined: boolean };
}

export interface SetupStatus {
  /** True only if at least one agent is fully wired AND capture is proven. */
  wired: boolean;
  agents: AgentWires[];
  capture: { done: boolean; declined: boolean; turns: number; sources: CaptureSource[] };
  gate: { checks: number; last_check_at: string | null };
  /** When the graph was last actually consulted — what the gate measures staleness against. */
  last_graph_read_at: string | null;
}

function agentWires(db: WorkspaceDB, agent: string): AgentWires {
  const k = KEYS(agent);
  return {
    agent,
    reflex: { done: !!get(db, k.reflexPath), declined: get(db, k.reflexDeclined) === "1", file: get(db, k.reflexPath) },
    gate: { done: get(db, k.gateSeen) === "1", declined: get(db, k.gateDeclined) === "1" },
  };
}

export function setupStatus(db: WorkspaceDB): SetupStatus {
  let sources: CaptureSource[] = [];
  let turns = 0;
  try {
    sources = raw(db)
      .prepare(
        `SELECT agent_id, COUNT(*) AS turns, MAX(created_at) AS last_turn_at
           FROM conversation_turns GROUP BY agent_id ORDER BY last_turn_at DESC`,
      )
      .all() as CaptureSource[];
    turns = sources.reduce((n, s) => n + s.turns, 0);
  } catch { /* no turns table yet */ }

  const iso = (key: string): string | null => {
    const v = Number(get(db, key) ?? 0);
    return v ? new Date(v).toISOString() : null;
  };
  const agents = knownAgents(db).map((a) => agentWires(db, a));
  const captureOk = turns > 0 || get(db, K.captureDeclined) === "1";
  return {
    wired: captureOk && agents.some((a) => (a.reflex.done || a.reflex.declined) && (a.gate.done || a.gate.declined)),
    agents,
    capture: { done: turns > 0, declined: get(db, K.captureDeclined) === "1", turns, sources },
    gate: { checks: Number(get(db, K.gateCount) ?? 0), last_check_at: iso(K.gateLast) },
    last_graph_read_at: iso(K.lastRead),
  };
}

type ToolResult = { content?: Array<{ type: string; text?: string }> };

/** The setup tools carry the full contract already — do not also nag them. */
const SETUP_TOOLS = new Set(["workspace_onboard", "workspace_install_capture", "workspace_install_gate"]);

/**
 * Ride the tool RESULT — the one channel that cannot decay (re-sent on every call), that
 * every MCP host shows the model, and that needs no hook or host-specific code.
 * Best-effort: a failure here must never break a tool.
 */
export function appendSetupNotice(result: ToolResult, db: WorkspaceDB, toolName: string | undefined, client: string): ToolResult {
  try {
    if (toolName && SETUP_TOOLS.has(toolName)) return result;
    if (!result || !Array.isArray(result.content)) return result;
    const notice = buildSetupNotice(db, client);
    if (!notice) return result;
    result.content.push({ type: "text", text: notice });
  } catch {
    /* best-effort — never break a tool */
  }
  return result;
}
