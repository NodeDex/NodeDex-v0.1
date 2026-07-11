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
// Storage bounds per channel (chars), env-overridable. Head-keep slice. Raise
// NODEDEX_CAPTURE_REASONING_MAX when the consumer reads thinking
// (NODEDEX_COMPREHEND_USE_REASONING=1) — the default 8000 was sized for
// storage-only days and truncates long builder sessions' thinking traces.
// Process env wins; ~/.nodedex/.env is the fallback (same fill-if-unset contract
// as the server's boot-env) — watcher processes are spawned by the entry/TUI,
// which forwards only its parity keys, so without this fallback a saved cap
// would never reach the adapter. Minimal mirror of home-env.ts parseEnvFile
// semantics (full-line # ignored, first `=` splits, inline ` # comment` stripped).
function homeEnvGet(name) {
  const live = process.env[name];
  if (live != null && live !== "") return live;
  try {
    for (const line of readFileSync(join(homedir(), ".nodedex", ".env"), "utf8").split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const eq = t.indexOf("=");
      if (eq < 0 || t.slice(0, eq).trim() !== name) continue;
      const raw = t.slice(eq + 1);
      const m = raw.match(/\s#/);
      return (m ? raw.slice(0, m.index) : raw).trim();
    }
  } catch { /* no home .env — defaults apply */ }
  return undefined;
}
const capNum = (name, dflt) => {
  const n = Number(homeEnvGet(name));
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : dflt;
};
const CAPS = {
  response: capNum("NODEDEX_CAPTURE_RESPONSE_MAX", 16000),
  reasoning: capNum("NODEDEX_CAPTURE_REASONING_MAX", 8000),
  user: capNum("NODEDEX_CAPTURE_USER_MAX", 2000),
};

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
 * Convenience: build → resolve → post. Returns a short status string:
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

/**
 * TRANSIENT capture statuses: the server wasn't reachable or rejected the POST — a later
 * retry can succeed, so a watcher's durable cursor must NOT pass a turn that returned one
 * of these (that's how source turns get permanently lost). Everything else is FINAL:
 * "captured" is done, "skipped:short" is content-determined (retrying can't change it).
 * Re-emits after a retry are safe — the server reuses the existing (agent_id, turn_number)
 * conversation_turns row instead of duplicating.
 */
export function isTransientCaptureStatus(status) {
  return status === "skipped:no-server" || status === "failed:post";
}
