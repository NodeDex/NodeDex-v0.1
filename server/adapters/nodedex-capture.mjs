// nodedex-capture.mjs — non-intrusive TEE capture adapter.
//
// JOB
//   Send a COPY of each finished agent turn to the Nodedex pipeline so it can extract
//   decisions / dead-ends / chains. The MCP server is PASSIVE — it only sees tool-call
//   args + its own responses, never the agent's natural-language output. So capture
//   can't be done BY the server; it must be PUSHED by the host. This is that push.
//
// THE RULE THAT MAKES IT SAFE
//   OUT-of-path and fire-and-forget — the agent's OWN llm call is NEVER touched, never
//   slowed, never broken. You call this AFTER a turn completes and ignore the result.
//   The server already does debounce / dedup / pause-gating / async extraction
//   (POST /api/reflect/trigger), so this client stays dumb: build payload, POST, swallow.
//
// UNIVERSAL
//   Dependency-free; runs on Node / Bun / Deno. Probes every known reasoning shape
//   (OpenAI / OpenRouter / Anthropic) so it captures chain-of-thought when present.
//
// CONFIGURABLE — choose which fields to capture (env, or a per-call `capture` override):
//   NODEDEX_CAPTURE_RESPONSE  (default on)  the agent's emitted answer — the SUBSTRATE.
//                                           off ⇒ nothing is sent (the pipeline needs it).
//   NODEDEX_CAPTURE_USER      (default on)  the user's message.
//   NODEDEX_CAPTURE_REASONING (default on)  the agent's reasoning / thinking, if available.
//   NODEDEX_URL               (default http://localhost:3001)  where the server lives.
//   NODEDEX_CAPTURE_BUFFER    (default off) on ⇒ buffer to ~/.nodedex/capture-buffer.jsonl
//                                           when the server is down, flush on next success.

const env = (typeof process !== "undefined" && process.env) ? process.env : {};

const CAPS = { response: 16000, reasoning: 8000, user: 2000 };
export const DEFAULT_CAPTURE = { response: true, user: true, reasoning: true };

function flag(name, dflt) {
  const v = env[name];
  if (v == null || v === "") return dflt;
  return !/^(0|off|false|no)$/i.test(String(v).trim());
}

/** Resolve the capture config: per-call override wins over env, env over default. */
export function resolveCaptureConfig(override) {
  return {
    response:  override?.response  ?? flag("NODEDEX_CAPTURE_RESPONSE",  DEFAULT_CAPTURE.response),
    user:      override?.user      ?? flag("NODEDEX_CAPTURE_USER",      DEFAULT_CAPTURE.user),
    reasoning: override?.reasoning ?? flag("NODEDEX_CAPTURE_REASONING", DEFAULT_CAPTURE.reasoning),
  };
}

/** Probe every known provider shape for chain-of-thought. "" if none present. */
export function extractReasoning(message) {
  if (!message || typeof message !== "object") return "";
  let r = "";
  for (const f of ["reasoning", "reasoning_content"])                 // OpenAI / OpenRouter / DeepSeek
    if (typeof message[f] === "string") r += message[f];
  if (Array.isArray(message.reasoning_details))                       // OpenRouter detailed
    for (const d of message.reasoning_details) if (d && typeof d.text === "string") r += d.text;
  if (Array.isArray(message.content))                                 // Anthropic-style thinking parts
    for (const p of message.content) if (p && p.type === "thinking" && p.thinking) r += p.thinking + "\n";
  return r.trim();
}

function slug(s) {
  return String(s || "").split(/\s+/).slice(0, 5).join("-").toLowerCase()
    .replace(/[^a-z0-9-]/g, "").slice(0, 60) || "turn";
}

/**
 * Build the /api/reflect/trigger payload for one turn under a capture config.
 * PURE + testable. Returns null when nothing is capturable: response disabled, or the
 * answer is under 50 chars (the server rejects those anyway).
 *
 *   turn = { userMessage, agentResponse, reasoning?, agentId?, turnNumber?, turnName?,
 *            loadedBlockIds?, hint? }
 */
export function buildCapturePayload(turn, override) {
  const cfg = resolveCaptureConfig(override);
  if (!cfg.response) return null;                                     // substrate disabled ⇒ skip
  const response = String(turn?.agentResponse ?? "").slice(0, CAPS.response);
  if (response.trim().length < 50) return null;                      // server 400s on <50
  return {
    agent_response:   response,
    user_message:     cfg.user      ? String(turn?.userMessage ?? "").slice(0, CAPS.user)      : "",
    agent_thinking:   cfg.reasoning ? String(turn?.reasoning   ?? "").slice(0, CAPS.reasoning) : "",
    agent_id:         turn?.agentId,
    turn_number:      typeof turn?.turnNumber === "number" ? turn.turnNumber : undefined,
    // Don't leak the user message into the name when user-capture is off.
    turn_name:        turn?.turnName || (cfg.user ? slug(turn?.userMessage) : "turn"),
    loaded_block_ids: Array.isArray(turn?.loadedBlockIds) ? turn.loadedBlockIds : [],
    hint:             turn?.hint || "discovery",
  };
}

function baseUrl(url) {
  return String(url || env.NODEDEX_URL || "http://localhost:3001").replace(/\/+$/, "");
}

/** Resolve the local buffer handle — only when buffering is enabled AND fs is reachable. */
async function bufferHandle() {
  if (!flag("NODEDEX_CAPTURE_BUFFER", false)) return null;
  try {
    const [{ default: fs }, { default: os }, { default: path }] = await Promise.all([
      import("node:fs"), import("node:os"), import("node:path"),
    ]);
    const dir = path.join(os.homedir(), ".nodedex");
    return { fs, dir, file: path.join(dir, "capture-buffer.jsonl") };
  } catch { return null; }                                            // non-node runtime → no buffering
}

async function post(url, payload) {
  const res = await fetch(`${url}/api/reflect/trigger`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(4000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

/** Opportunistically drain any payloads buffered by prior failures. No-op if buffering off. */
export async function flushCaptureBuffer(url) {
  const b = await bufferHandle();
  if (!b || !b.fs.existsSync(b.file)) return;
  let lines;
  try { lines = b.fs.readFileSync(b.file, "utf8").trim().split("\n").filter(Boolean); } catch { return; }
  const u = baseUrl(url);
  let sent = 0;
  for (; sent < lines.length; sent++) {
    try { await post(u, JSON.parse(lines[sent])); } catch { break; } // server still down → stop
  }
  try {
    if (sent >= lines.length) b.fs.unlinkSync(b.file);
    else b.fs.writeFileSync(b.file, lines.slice(sent).join("\n") + "\n");
  } catch { /* best-effort */ }
}

async function bufferOnFail(payload) {
  const b = await bufferHandle();
  if (!b) return;
  try {
    b.fs.mkdirSync(b.dir, { recursive: true });
    b.fs.appendFileSync(b.file, JSON.stringify({ ...payload, _buffered_at: Date.now() }) + "\n");
  } catch { /* best-effort */ }
}

/**
 * Tee one finished turn into the pipeline. Returns immediately (fire-and-forget),
 * never throws, never blocks the agent. Call AFTER your turn completes.
 *
 *   options = { url?, capture?: { response?, user?, reasoning? } }
 */
export function nodedexCapture(turn, options = {}) {
  const payload = buildCapturePayload(turn, options.capture);
  if (!payload) return;                                              // nothing capturable this turn
  const url = baseUrl(options.url);
  // Out-of-path: drain prior failures, send, buffer-on-fail — all detached from the turn.
  (async () => {
    await flushCaptureBuffer(url);
    try { await post(url, payload); } catch { await bufferOnFail(payload); }
  })().catch(() => { /* capture must NEVER affect the agent's call */ });
}

export default nodedexCapture;
