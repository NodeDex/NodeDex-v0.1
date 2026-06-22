// nodedex-capture-core.mjs — shared, host-agnostic capture core.
//
// WHY THIS EXISTS
//   Every host adapter (a Claude Code hook, the Hermes hook, the tee, the next host…) needs
//   the SAME two things, and only the same two things:
//     1. find the live Nodedex server — its url + token — WITHOUT the user hardcoding a port,
//     2. POST a finished turn to /api/reflect/trigger, fire-and-forget, never breaking the agent.
//   That's this file. A host adapter is then a thin SHIM that knows how ITS host hands over a
//   turn, parses that, and calls captureTurn() (or resolveNodedexTarget + buildTriggerBody +
//   postTrigger). Building one host gives every future host this core for free.
//
// SELF-LOCATING (the reason the adapter never contains a port)
//   The server's port can change — switch DB in the TUI and it relaunches on a new port. So we
//   read the LIVE port + token from ~/.nodedex/tui-session.json, which the TUI rewrites on every
//   launch / stop / DB-switch. The adapter follows the running server automatically; the user
//   never types or re-edits a port. An explicit NODEDEX_CAPTURE_URL / NODEDEX_CAPTURE_TOKEN
//   override wins when you want to pin a specific server (e.g. several running at once).
//
// Dependency-free: runs on Node 18+ (global fetch), Bun, or Deno.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const TRIGGER_MIN_CHARS = 10; // mirror the server's combined-content floor (/api/reflect/trigger)
const CAPS = { response: 16000, reasoning: 8000, user: 2000 };

/**
 * Resolve the live Nodedex server to capture into → { url, token } or null.
 * Order: explicit env override → the FOCUSED server in tui-session.json → first managed server.
 * Returns null (caller skips silently) when no server is known.
 */
export function resolveNodedexTarget() {
  // 1. Explicit override — pin a specific server.
  const envUrl = process.env.NODEDEX_CAPTURE_URL;
  if (envUrl && envUrl.trim()) {
    return {
      url: envUrl.trim().replace(/\/+$/, ""),
      token: process.env.NODEDEX_CAPTURE_TOKEN || process.env.NODEDEX_TOKEN || "",
    };
  }

  // 2. Read the TUI's own record of running servers.
  let session;
  try {
    session = JSON.parse(readFileSync(join(homedir(), ".nodedex", "tui-session.json"), "utf8"));
  } catch {
    return null; // no session file → no server known
  }
  const managed = Array.isArray(session?.managed) ? session.managed : [];
  if (managed.length === 0) return null;

  // Prefer the server the user is FOCUSED on (matched to its managed entry for the token).
  let entry = null;
  const focusedUrl = session?.connected?.url;
  if (focusedUrl) {
    let port = null;
    try { port = Number(new URL(focusedUrl).port) || null; } catch { /* not a url → ignore */ }
    if (port != null) entry = managed.find((m) => Number(m?.port) === port) || null;
  }
  if (!entry) entry = managed[0]; // fallback: first managed server

  if (!entry?.port) return null;
  // The adapter runs on the HOST (where the agent host / Hermes gateway lives), so the server
  // is on loopback — 127.0.0.1 (not `localhost`, which can resolve to IPv6 ::1 on Windows; and
  // not host.docker.internal, which is only for code running INSIDE a container).
  return { url: `http://127.0.0.1:${entry.port}`, token: entry.token || "" };
}

/**
 * Build the /api/reflect/trigger body for one turn. PURE + testable.
 * Returns null when there's nothing worth sending (no response, or under 50 chars).
 *   turn = { agentResponse, userMessage?, reasoning?, agentId?, turnName?, hint? }
 */
export function buildTriggerBody(turn) {
  const response = String(turn?.agentResponse ?? "").slice(0, CAPS.response);
  const reasoning = String(turn?.reasoning ?? "").slice(0, CAPS.reasoning);
  const user = String(turn?.userMessage ?? "").slice(0, CAPS.user);
  // Need SOME answer, but floor on COMBINED content — a short answer can ride a rich trace.
  if (!response.trim()) return null;
  if ((response + reasoning + user).trim().length < TRIGGER_MIN_CHARS) return null;
  const body = {
    agent_response: response,
    user_message: user,
    agent_thinking: reasoning,
    agent_id: turn?.agentId || "agent",
    turn_name: turn?.turnName || "turn",
    hint: turn?.hint || "discovery",
    loaded_block_ids: [],
  };
  // turn_number enables ARC mode: the server stores this turn in conversation_turns keyed by
  // (agent_id, turn_number) and later assembles the range. Only sent when the adapter supplies a
  // monotonic ordinal; adapters that don't (per-turn-only capture) simply omit it → atomic mode.
  if (Number.isInteger(turn?.turnNumber)) body.turn_number = turn.turnNumber;
  return body;
}

/** POST a body to a resolved target's /api/reflect/trigger. Never throws → true on success. */
export async function postTrigger(target, body, timeoutMs = 5000) {
  if (!target?.url || !body) return false;
  try {
    const res = await fetch(`${target.url}/api/reflect/trigger`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(target.token ? { "x-nodedex-token": target.token } : {}) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.ok;
  } catch {
    return false; // server down / unreachable → capture is best-effort
  }
}

/**
 * Convenience: build → resolve → post. Returns a short status string (for logging only):
 *   "captured" | "skipped:short" | "skipped:no-server" | "failed:post"
 * Never throws — capture must never affect the agent's turn.
 */
export async function captureTurn(turn) {
  try {
    const body = buildTriggerBody(turn);
    if (!body) return "skipped:short";
    const target = resolveNodedexTarget();
    if (!target) return "skipped:no-server";
    return (await postTrigger(target, body)) ? "captured" : "failed:post";
  } catch {
    return "failed:post";
  }
}
