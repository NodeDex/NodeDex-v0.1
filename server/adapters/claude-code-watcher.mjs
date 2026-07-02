#!/usr/bin/env node
// claude-code-watcher.mjs — capture Claude Code turns into NodeDex by reading Claude Code's
// own session transcripts (~/.claude/projects/<project>/<session>.jsonl). Zero cooperation
// needed from the host: no hooks to wire, no config in Claude Code itself — every session is
// already persisted line-by-line as it happens; we tail it.
//
// WHAT IT IS
//   A thin, host-specific shim over the shared capture core (nodedex-capture-core.mjs), the
//   same architecture as hermes-statedb-watcher.mjs. All it adds is "how Claude Code hands me
//   a turn": tail the JSONL files, assemble whole turns, call captureTurn().
//
// THE HARD PART — turn ASSEMBLY (what one logical turn looks like in the JSONL)
//   One turn spans many lines:
//     user(text) → assistant(thinking|text|tool_use)* → user(tool_result)* → … → assistant(text)
//   There is NO explicit end-of-turn marker. A turn CLOSES when:
//     • the NEXT real user prompt arrives in that session (the reliable boundary), or
//     • the file has been idle past idleFlushMs with a complete buffered turn (the last turn
//       of a session would otherwise never emit).
//   Mapping (mirrors the Hermes watcher: narration → response, raw traces → thinking):
//     agent_response = the assistant's TEXT blocks across the turn (preambles + final answer)
//     user_message   = the user prompt(s) that opened the turn (system tags stripped)
//     agent_thinking = thinking blocks + tool_use/tool_result previews (recorded, not extracted)
//   Skipped lines: isSidechain (subagent chatter), isMeta, and non-user/assistant types
//   (queue-operation, attachment, file-history-snapshot, ai-title, system, mode, …).
//
// WATERMARK (why turnNumber = a byte offset)
//   Same anchoring trick as Hermes (turn_number = state.db stop-id): the turn's identity lives
//   in the HOST's own log, not in a drift-prone private counter. Here that identity is the byte
//   offset where the turn's opening user line starts — stable across restarts, monotonic per
//   file, so (agent_id, turn_number) is idempotent and the extraction range IS a watermark.
//
// SAFETY
//   • READ-ONLY — opens transcripts with plain reads; never writes to ~/.claude.
//   • Privacy filter: only project dirs in the allow-list are read (default "*" = all — the
//     TUI consent step is where the user scopes this). Sub-agent sidechains are never captured.
//   • Fresh start captures FORWARD only (cursor = current EOF) — no history replay.
//
// CONFIG (read live each poll from ~/.nodedex/config.json → claudeCapture):
//   { enabled, projects: string[], pollMs, idleFlushMs, projectsDir }   (all optional)
//
// RUN
//   node server/adapters/claude-code-watcher.mjs             # poll forever
//   node server/adapters/claude-code-watcher.mjs --dry-run   # print assembled turns, POST nothing
//   node server/adapters/claude-code-watcher.mjs --once      # one pass then exit (testing)
//   node server/adapters/claude-code-watcher.mjs --backfill  # also capture pre-existing turns

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { homedir } from "node:os";
import { join, basename } from "node:path";
import { captureTurn } from "./nodedex-capture-core.mjs";

const HOME = join(homedir(), ".nodedex");
const CONFIG_FILE = join(HOME, "config.json");
const CURSOR_FILE = join(HOME, "claude-code-capture-cursor.json");

const args = new Set(process.argv.slice(2));
const DRY_RUN = args.has("--dry-run");
const ONCE = args.has("--once");
const BACKFILL = args.has("--backfill");

const TOOL_PREVIEW = 240; // truncate each tool result/args inside the thinking trace

// ─── config (re-read each poll so TUI changes apply without a restart) ────────────────────────
function defaultProjectsDir() {
  return join(homedir(), ".claude", "projects");
}
function loadCaptureConfig() {
  let raw = {};
  try { raw = JSON.parse(readFileSync(CONFIG_FILE, "utf8"))?.claudeCapture ?? {}; } catch { /* none */ }
  const projects = Array.isArray(raw.projects) && raw.projects.length ? raw.projects.map(String) : ["*"];
  return {
    enabled: raw.enabled !== false,
    projects,
    allowAll: projects.includes("*"),
    pollMs: Number.isFinite(raw.pollMs) && raw.pollMs >= 1000 ? raw.pollMs : 5000,
    idleFlushMs: Number.isFinite(raw.idleFlushMs) && raw.idleFlushMs >= 15000 ? raw.idleFlushMs : 120000,
    projectsDir: raw.projectsDir || defaultProjectsDir(),
  };
}
const projectAllowed = (cfg, dirName) => cfg.allowAll || cfg.projects.includes(dirName);

// ─── cursor: file → byte offset of the CURRENT (still-buffering) turn's opening line ──────────
// We persist the offset where the pending turn STARTS, not EOF — so a restart re-reads and
// re-buffers the in-flight turn instead of losing it. Emitted turns are idempotent via
// turnNumber (= that same offset), so a re-emit after restart dedups server-side.
function loadCursors() {
  try { return JSON.parse(readFileSync(CURSOR_FILE, "utf8"))?.files ?? {}; } catch { return {}; }
}
function saveCursors(files) {
  try { mkdirSync(HOME, { recursive: true }); writeFileSync(CURSOR_FILE, JSON.stringify({ files }, null, 2)); }
  catch { /* read-only home → memory-only cursors */ }
}

// ─── line classification ───────────────────────────────────────────────────────────────────────
const clean = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
const truncate = (s, n) => { const t = String(s ?? ""); return t.length > n ? t.slice(0, n) + "…" : t; };

// System-injected user texts that are NOT a human prompt. Stripped from prompts; a user line
// that is ONLY these never opens a turn.
const SYSTEM_TEXT = /^\s*(<command-name>|<local-command-stdout>|<local-command-caveat>|<ide_|<system-reminder>|Caveat: The messages below)/;

/** Real prompt text from a user line ("" when it's tool results / meta / system tags only). */
function userPromptText(msg) {
  const c = msg?.content;
  const parts = [];
  if (typeof c === "string") { if (!SYSTEM_TEXT.test(c)) parts.push(c); }
  else if (Array.isArray(c)) {
    for (const item of c) {
      if (item?.type === "text" && typeof item.text === "string" && !SYSTEM_TEXT.test(item.text)) parts.push(item.text);
    }
  }
  return clean(parts.join("\n"));
}

/** Tool-result previews from a user line (the feedback half of tool use). */
function toolResultPreviews(msg) {
  const out = [];
  const c = msg?.content;
  if (!Array.isArray(c)) return out;
  for (const item of c) {
    if (item?.type !== "tool_result") continue;
    const inner = typeof item.content === "string"
      ? item.content
      : Array.isArray(item.content) ? item.content.map((x) => (x?.type === "text" ? x.text : "")).join(" ") : "";
    const t = clean(inner);
    if (t) out.push(`[result] ${truncate(t, TOOL_PREVIEW)}`);
  }
  return out;
}

// ─── per-file turn assembly state ──────────────────────────────────────────────────────────────
/** files: path → { offset, pendingStart, buf, partial, lastGrowth, sessionId, project } */
const state = new Map();

function newBuffer() {
  return { user: [], response: [], thinking: [], openedAt: 0 };
}

function emitReady(fileState) {
  const b = fileState.buf;
  return b && b.user.length > 0 && b.response.length > 0;
}

async function emitTurn(fileState, filePath) {
  const b = fileState.buf;
  const sid = fileState.sessionId || basename(filePath, ".jsonl");
  const turn = {
    agentResponse: b.response.join("\n"),
    userMessage: b.user.join("\n"),
    reasoning: b.thinking.join("\n"),
    // #agent-id convention: host-prefixed + per-session → one arc per Claude Code session,
    // and provenance in the graph reads as "this came from Claude Code".
    agentId: `claude-code-${String(sid).slice(0, 8)}`,
    turnNumber: b.openedAt, // byte offset of the turn's opening line — the file-anchored watermark
    turnName: `cc-${fileState.project.slice(0, 20)}-${b.openedAt}`,
    hint: "discovery",
  };
  if (DRY_RUN) {
    console.log("─".repeat(72));
    console.log(`TURN  project=${fileState.project}  session=${String(sid).slice(0, 8)}  at=${b.openedAt}`);
    console.log(`  user:      ${truncate(turn.userMessage.replace(/\n/g, " ⏎ "), 160)}`);
    console.log(`  response:  ${truncate(clean(turn.agentResponse), 200)}  (${turn.agentResponse.length} ch)`);
    console.log(`  thinking:  ${truncate(turn.reasoning.replace(/\n/g, " · "), 200)}  (${turn.reasoning.length} ch)`);
  } else {
    const status = await captureTurn(turn);
    console.log(`[claude-code-watcher] captured ${fileState.project}/${String(sid).slice(0, 8)}@${b.openedAt} → ${status}`);
  }
}

/** Feed one parsed JSONL line into the file's buffer. Returns "opened" when a new turn began. */
async function feedLine(fileState, filePath, lineStartOffset, j) {
  if (!j || j.isSidechain === true || j.isMeta === true) return;
  if (j.sessionId && !fileState.sessionId) fileState.sessionId = j.sessionId;

  if (j.type === "user") {
    const prompt = userPromptText(j.message);
    if (prompt) {
      // A real user prompt = the boundary. Emit the buffered turn, then open a new one here.
      if (emitReady(fileState)) await emitTurn(fileState, filePath);
      if (!fileState.buf || fileState.buf.response.length > 0 || fileState.buf.user.length === 0) {
        fileState.buf = newBuffer();
        fileState.buf.openedAt = lineStartOffset;
        fileState.pendingStart = lineStartOffset;
      }
      fileState.buf.user.push(prompt);
      return;
    }
    // tool results ride the CURRENT turn's thinking trace
    if (fileState.buf) fileState.buf.thinking.push(...toolResultPreviews(j.message));
    return;
  }

  if (j.type === "assistant" && fileState.buf) {
    const c = j.message?.content;
    if (!Array.isArray(c)) return;
    for (const item of c) {
      if (item?.type === "text" && item.text) fileState.buf.response.push(clean(item.text));
      else if (item?.type === "thinking" && item.thinking) fileState.buf.thinking.push(truncate(clean(item.thinking), 2000));
      else if (item?.type === "tool_use") fileState.buf.thinking.push(`[tool] ${item.name || "?"}(${truncate(JSON.stringify(item.input ?? {}), TOOL_PREVIEW)})`);
    }
  }
}

// ─── one pass over one file: read appended bytes, feed complete lines ──────────────────────────
async function passFile(fileState, filePath, cfg) {
  const size = statSync(filePath).size;
  if (size < fileState.offset) fileState.offset = size; // truncated? resync forward-only
  if (size > fileState.offset) {
    const fd = openSync(filePath, "r");
    try {
      const len = size - fileState.offset;
      const buf = Buffer.alloc(Math.min(len, 8 * 1024 * 1024)); // cap one pass at 8MB
      const read = readSync(fd, buf, 0, buf.length, fileState.offset);
      const chunk = buf.toString("utf8", 0, read);
      // Only COMPLETE lines advance the offset (summed in exact bytes per line, so a
      // trailing partial line — or a mid-multibyte-char cut — is simply re-read next
      // pass once its newline lands; no in-memory carry, no byte drift).
      let text = chunk;
      let lineStart = fileState.offset;
      let consumed = 0;
      let idx;
      while ((idx = text.indexOf("\n")) >= 0) {
        const line = text.slice(0, idx);
        const lineBytes = Buffer.byteLength(line, "utf8") + 1;
        if (line.trim()) {
          let j = null; try { j = JSON.parse(line); } catch { /* garbled line → skip */ }
          if (j) await feedLine(fileState, filePath, lineStart, j);
        }
        lineStart += lineBytes;
        consumed += lineBytes;
        text = text.slice(idx + 1);
      }
      fileState.offset += consumed;
      fileState.lastGrowth = Date.now();
    } finally { closeSync(fd); }
  } else if (emitReady(fileState) && Date.now() - fileState.lastGrowth > cfg.idleFlushMs) {
    // idle flush: the session went quiet with a complete turn buffered (the session's last turn)
    await emitTurn(fileState, filePath);
    fileState.buf = newBuffer();
    fileState.pendingStart = fileState.offset;
  }
}

// ─── one pass: discover files, tail each, persist cursors ─────────────────────────────────────
async function pass(cfg) {
  let dirs = [];
  try { dirs = readdirSync(cfg.projectsDir, { withFileTypes: true }).filter((d) => d.isDirectory()); } catch { return; }
  for (const dir of dirs) {
    if (!projectAllowed(cfg, dir.name)) continue;
    let files = [];
    try { files = readdirSync(join(cfg.projectsDir, dir.name)).filter((f) => f.endsWith(".jsonl")); } catch { continue; }
    for (const f of files) {
      const filePath = join(cfg.projectsDir, dir.name, f);
      let fs_ = state.get(filePath);
      if (!fs_) {
        // New file: forward-only unless --backfill (or a persisted cursor exists).
        const persisted = loadCursors()[filePath];
        const startAt = BACKFILL ? 0 : persisted?.offset ?? statSync(filePath).size;
        fs_ = { offset: startAt, pendingStart: startAt, buf: newBuffer(), lastGrowth: Date.now(), sessionId: null, project: dir.name };
        state.set(filePath, fs_);
      }
      try { await passFile(fs_, filePath, cfg); } catch (e) { console.error(`[claude-code-watcher] ${basename(filePath)}: ${e?.message ?? e}`); }
    }
  }
  if (!DRY_RUN) {
    const files = {};
    for (const [p, s] of state) { if (existsSync(p)) files[p] = { offset: s.pendingStart }; }
    saveCursors(files);
  }
}

// ─── main loop ─────────────────────────────────────────────────────────────────────────────────
async function main() {
  const boot = loadCaptureConfig();
  console.log(`[claude-code-watcher] ${DRY_RUN ? "DRY-RUN " : ""}watching ${boot.projectsDir}`);
  console.log(`[claude-code-watcher] projects=${boot.allowAll ? "* (all)" : boot.projects.join(",")}  poll=${boot.pollMs}ms${BACKFILL ? "  (backfill)" : ""}`);
  let warnedMissing = false;
  do {
    const cfg = loadCaptureConfig();
    if (cfg.enabled) {
      if (!existsSync(cfg.projectsDir)) {
        if (!warnedMissing) { console.log(`[claude-code-watcher] waiting — no Claude Code projects dir at ${cfg.projectsDir} yet`); warnedMissing = true; }
      } else {
        if (warnedMissing) { console.log(`[claude-code-watcher] projects dir appeared — starting capture`); warnedMissing = false; }
        try { await pass(cfg); } catch (e) { console.error(`[claude-code-watcher] pass error: ${e?.message ?? e}`); }
      }
    }
    if (ONCE) break;
    await new Promise((r) => setTimeout(r, cfg.pollMs));
  } while (true);
}

main().catch((e) => { console.error(`[claude-code-watcher] fatal: ${e?.message ?? e}`); process.exit(1); });
