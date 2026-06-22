#!/usr/bin/env node
// hermes-statedb-watcher.mjs — capture Hermes/Owl turns into NodeDex by reading Hermes's own
// state.db. This is the ONLY working capture path for Hermes: the model proxy is ignored
// (Hermes hardcodes its OpenRouter endpoint) and shell hooks are registered but never invoked.
// Hermes persists every turn to state.db itself, so we read it — zero Hermes cooperation needed.
//
// WHAT IT IS
//   A thin, host-specific shim over the shared capture core (nodedex-capture-core.mjs). All it
//   adds is "how Hermes hands me a turn": it polls the messages table read-only, assembles whole
//   turns, and calls captureTurn(). Finding the live server + POSTing is the core's job.
//
// THE HARD PART — turn ASSEMBLY (why a naive row-pair is wrong)
//   One logical agent turn spans many rows:
//     user → assistant(tool_calls) → tool → assistant(tool_calls) → tool → … → assistant(stop)
//   Hermes marks the END of a turn with finish_reason='stop'; every intermediate assistant row is
//   finish_reason='tool_calls' (a "let me check…" preamble). So:
//     • agent_response  = the agent's whole NARRATION across the turn — the tool-call preambles
//                         AND the final answer, joined — so extraction (v2 COMPREHEND reads
//                         user+response) sees the tool-driven investigation (dead-ends,
//                         decisions), not just the closing summary.
//     • user_message    = the user row(s) that opened the turn
//     • agent_thinking  = the raw tool RESULTS + any reasoning_content — recorded to the turn
//                         but NOT fed to extraction (raw tool JSON there adds noise / over-seg).
//   Pairing "each assistant with the preceding user" would instead emit garbage fragments.
//
// SAFETY
//   • READ-ONLY (mode=ro&immutable=1) — never opens the live DB for write; cannot corrupt it.
//   • Privacy filter: only captures sessions whose `source` is in the allow-list (default ["tui"]),
//     so telegram/discord/other sources are never read into the graph. Configurable in the TUI.
//   • In-flight turns (no closing stop yet) are deferred until their stop row appears.
//   • Fresh start captures FORWARD only (cursor = current max id) — it does not replay all history.
//
// CONFIG (read live each poll from ~/.nodedex/config.json → hermesCapture):
//   { enabled, sources: string[], pollMs, stateDbPath }   (all optional; sane defaults below)
//
// RUN
//   node server/adapters/hermes-statedb-watcher.mjs            # poll forever
//   node server/adapters/hermes-statedb-watcher.mjs --dry-run  # print assembled turns, POST nothing
//   node server/adapters/hermes-statedb-watcher.mjs --once     # one pass then exit (testing)
//   node server/adapters/hermes-statedb-watcher.mjs --backfill # also capture pre-existing turns

import { createRequire } from "node:module";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { captureTurn } from "./nodedex-capture-core.mjs";

// better-sqlite3 lives in server/node_modules; resolve it relative to THIS file so the watcher
// runs from any cwd (TUI spawns it with cwd=server, but a manual run shouldn't have to).
const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");

// Open Hermes's live DB strictly READ-ONLY. better-sqlite3 (unlike Python/node-sqlite3) does NOT
// support `file:…?mode=ro` URIs — pass the OS path + { readonly:true }. We deliberately do NOT use
// immutable mode: the file IS changing (Hermes writes every turn), and immutable would risk stale
// reads. readonly gives a consistent SQLite snapshot without ever writing the main db.
const openRO = (path) => new Database(path, { readonly: true });

const HOME = join(homedir(), ".nodedex");
const CONFIG_FILE = join(HOME, "config.json");
const CURSOR_FILE = join(HOME, "hermes-capture-cursor.json");

const args = new Set(process.argv.slice(2));
const DRY_RUN = args.has("--dry-run");
const ONCE = args.has("--once");
const BACKFILL = args.has("--backfill");

const TOOL_PREVIEW = 240; // truncate each tool result inside the reasoning trace

// ─── config (re-read each poll so TUI changes apply without a restart) ────────────────────────
function defaultStateDbPath() {
  if (platform() === "win32" && process.env.LOCALAPPDATA) {
    return join(process.env.LOCALAPPDATA, "hermes", "state.db");
  }
  // mac/linux Hermes (best-effort default; override via config.stateDbPath)
  return join(homedir(), ".local", "share", "hermes", "state.db");
}
function loadCaptureConfig() {
  let raw = {};
  try { raw = JSON.parse(readFileSync(CONFIG_FILE, "utf8"))?.hermesCapture ?? {}; } catch { /* none */ }
  const sources = Array.isArray(raw.sources) && raw.sources.length ? raw.sources.map(String) : ["tui"];
  return {
    enabled: raw.enabled !== false,                 // present-but-not-false → on (the watcher only runs when started)
    sources,                                         // [] or ["*"] handled by sourceAllowed()
    allowAll: sources.includes("*"),
    pollMs: Number.isFinite(raw.pollMs) && raw.pollMs >= 500 ? raw.pollMs : 4000,
    stateDbPath: raw.stateDbPath || defaultStateDbPath(),
  };
}
const sourceAllowed = (cfg, source) => cfg.allowAll || cfg.sources.includes(String(source ?? ""));

// ─── cursor (last stop-row id we've emitted a turn for) ───────────────────────────────────────
function loadCursor() {
  try { return Number(JSON.parse(readFileSync(CURSOR_FILE, "utf8"))?.lastStopId) || 0; } catch { return 0; }
}
function saveCursor(lastStopId) {
  try { mkdirSync(HOME, { recursive: true }); writeFileSync(CURSOR_FILE, JSON.stringify({ lastStopId }, null, 2)); }
  catch { /* read-only home → no persistence; we just re-process from memory cursor */ }
}

// ─── turn assembly ────────────────────────────────────────────────────────────────────────────
const clean = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
const truncate = (s, n) => { const t = String(s ?? ""); return t.length > n ? t.slice(0, n) + "…" : t; };

/** Build one turn from the rows in [prevStopId+1 .. stop.id] of a session. null if no user prompt. */
function assembleTurn(db, sid, prevStopId, stop) {
  const rows = db.prepare(
    `SELECT id, role, content, tool_name, finish_reason, reasoning_content
       FROM messages WHERE session_id = ? AND id > ? AND id <= ? ORDER BY id`
  ).all(sid, prevStopId, stop.id);

  const userParts = [];
  const agentParts = [];                                  // agent narration across the turn (preambles + final answer) → response
  const toolTrace = [];                                   // raw tool outputs → thinking (recorded, not extracted)
  for (const r of rows) {
    if (r.role === "user") { const c = clean(r.content); if (c) userParts.push(c); }
    else if (r.role === "assistant") { const c = clean(r.content); if (c) agentParts.push(c); }          // incl. the final 'stop' row
    else if (r.role === "tool") { const c = clean(r.content); if (c) toolTrace.push(`[${r.tool_name || "tool"}] ${truncate(c, TOOL_PREVIEW)}`); }
  }
  if (!userParts.length || !agentParts.length) return null;   // no prompt or no agent text → skip (orphan)

  const stopThinking = clean(stop.reasoning_content);     // thinking-model reasoning on the final row
  if (stopThinking) toolTrace.unshift(stopThinking);

  // turn_number = the state.db message id of this turn's closing 'stop' row — the turn's identity
  // in HERMES'S OWN log, NOT a private ordinal. Anchoring to it means NodeDex never keeps a
  // drift-prone copy of "what's extracted": the extraction RANGE bounds ARE state.db ids
  // (conversation_turn_ranges.end_turn_number = the last extracted stop-id = a watermark), so
  // "extracted vs not" is just `state.db stop.id <= watermark`. Globally unique + monotonic.
  // agent_id is PER-SESSION ("owl-<sid>") so each conversation is its own arc (turns don't bleed
  // across sessions into one range).
  const turnNumber = stop.id;

  return {
    agentResponse: agentParts.join("\n"),
    userMessage: userParts.join("\n"),
    reasoning: toolTrace.join("\n"),
    agentId: `owl-${String(sid)}`,                  // per-session → one arc per Hermes conversation
    turnNumber,                                      // = state.db stop-row id (the state-anchored watermark unit)
    turnName: `hermes-${String(sid).slice(0, 15)}-${stop.id}`,
    hint: "discovery",
  };
}

// ─── one pass: find new completed turns, assemble, capture ────────────────────────────────────
async function pass(cfg, cursor) {
  const db = openRO(cfg.stateDbPath);
  try {
    // Completed turns since the cursor = assistant rows with finish_reason='stop' and id > cursor.
    const stops = db.prepare(
      `SELECT m.id, m.session_id, m.content, m.reasoning_content, s.source
         FROM messages m JOIN sessions s ON s.id = m.session_id
        WHERE m.role = 'assistant' AND m.finish_reason = 'stop' AND m.id > ?
        ORDER BY m.id`
    ).all(cursor);

    let lastStopId = cursor;
    for (const stop of stops) {
      const sid = stop.session_id;
      // walk back to the previous stop in THIS session (the window start), else session start (0)
      const prevStopId = db.prepare(
        `SELECT MAX(id) AS p FROM messages
          WHERE session_id = ? AND role = 'assistant' AND finish_reason = 'stop' AND id < ?`
      ).get(sid, stop.id)?.p ?? 0;

      if (!sourceAllowed(cfg, stop.source)) { lastStopId = stop.id; continue; }   // privacy skip, still advance

      const turn = assembleTurn(db, sid, prevStopId, stop);
      if (turn) {
        if (DRY_RUN) {
          console.log("─".repeat(72));
          console.log(`TURN  session=${sid}  stop_id=${stop.id}  source=${stop.source}`);
          console.log(`  user:      ${truncate(turn.userMessage.replace(/\n/g, " ⏎ "), 160)}`);
          console.log(`  response:  ${truncate(clean(turn.agentResponse), 200)}  (${turn.agentResponse.length} ch)`);
          console.log(`  thinking:  ${truncate(turn.reasoning.replace(/\n/g, " · "), 220)}  (${turn.reasoning.length} ch)`);
        } else {
          const status = await captureTurn(turn);
          console.log(`[hermes-watcher] captured stop_id=${stop.id} session=${String(sid).slice(0, 15)} → ${status}`);
        }
      }
      lastStopId = stop.id;
    }
    return lastStopId;
  } finally {
    db.close();
  }
}

// ─── main loop ────────────────────────────────────────────────────────────────────────────────
async function main() {
  const boot = loadCaptureConfig();
  console.log(`[hermes-watcher] ${DRY_RUN ? "DRY-RUN " : ""}watching ${boot.stateDbPath}`);
  console.log(`[hermes-watcher] sources=${boot.allowAll ? "* (all)" : boot.sources.join(",")}  poll=${boot.pollMs}ms${BACKFILL ? "  (backfill)" : ""}`);

  // --backfill starts at 0; else the persisted cursor wins. If neither, DEFER picking the start
  // point until state.db first appears, then start forward-only (current max stop-id). This lets a
  // default-on watcher start BEFORE Hermes exists without crashing or later replaying all history.
  let cursor = BACKFILL ? 0 : loadCursor();
  let cursorReady = BACKFILL || cursor > 0;
  let warnedMissing = false;

  do {
    const cfg = loadCaptureConfig();              // re-read each pass → TUI changes apply live
    if (cfg.enabled) {
      if (!existsSync(cfg.stateDbPath)) {
        // Default-on, but no Hermes turn-log yet (or Hermes not installed). Wait — never crash;
        // a harmless idle poll until it appears (or the user toggles capture off in the TUI).
        if (!warnedMissing) { console.log(`[hermes-watcher] waiting — no Hermes state.db at ${cfg.stateDbPath} yet`); warnedMissing = true; }
      } else {
        if (warnedMissing) { console.log(`[hermes-watcher] state.db appeared — starting capture`); warnedMissing = false; }
        if (!cursorReady) {
          const db = openRO(cfg.stateDbPath);
          try { cursor = db.prepare(`SELECT MAX(id) AS m FROM messages WHERE role='assistant' AND finish_reason='stop'`).get()?.m ?? 0; }
          finally { db.close(); }
          cursorReady = true;
          console.log(`[hermes-watcher] capturing forward from cursor=${cursor}`);
        }
        try {
          const next = await pass(cfg, cursor);
          if (next > cursor) { cursor = next; if (!DRY_RUN) saveCursor(cursor); }
        } catch (e) {
          console.error(`[hermes-watcher] pass error: ${e?.message ?? e}`);
        }
      }
    }
    if (ONCE) break;
    await new Promise((r) => setTimeout(r, loadCaptureConfig().pollMs));
  } while (!ONCE);
}

main().catch((e) => { console.error(`[hermes-watcher] fatal: ${e?.message ?? e}`); process.exit(1); });

export { assembleTurn, sourceAllowed, loadCaptureConfig }; // for testing
