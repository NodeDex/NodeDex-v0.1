// nodedex-gate.mjs — the check that fires AT THE MOMENT OF DECISION.
//
// WHY (measured 2026-07-12): an agent read the project's recorded dead-ends at 12:17,
// wrote the code at 16:44, and shipped the exact bug those dead-ends warned about. It
// understood them perfectly. It just no longer had them — four hours and several
// compactions later, the knowledge was gone from its context.
//
// A prompt is a request. This is the guarantee: it runs on the HOST's schedule (before an
// edit, or every turn), not on the model's memory. It asks the server one question —
// "is this agent's view of the graph STALE?" — and if so, prints a short reminder that the
// host feeds back into the agent's context.
//
// TWO RULES, both non-negotiable:
//   · FAIL OPEN. If NodeDex is down, slow, or missing, this exits 0 and says nothing. A
//     memory tool must NEVER block someone's editor.
//   · WARN, NEVER BLOCK. It reminds. It does not deny the edit.
//
// WIRING: run it from whatever your host fires before a file edit (a pre-tool hook, a
// middleware, the line before your write call). Anything it prints to stdout should reach
// the agent's context. If your host wants a specific JSON envelope, wrap this — the part
// that matters is the endpoint call, not the plumbing.
//
//   node nodedex-gate.mjs            # prints a reminder, or nothing
//
// Env: NODEDEX_URL (default http://localhost:3001)

const URL_BASE = (process.env.NODEDEX_URL || "http://localhost:3001").replace(/\/$/, "");
const TIMEOUT_MS = Number(process.env.NODEDEX_GATE_TIMEOUT_MS || 800);
// WHICH agent this gate is wired into. The gate lives in ONE agent's seam, so one host having
// it proves nothing about the next — set NODEDEX_AGENT (or pass --agent=<name>) and the status
// surface can show you, per agent, what is actually wired.
const AGENT =
  process.argv.find((a) => a.startsWith("--agent="))?.slice(8) ||
  process.env.NODEDEX_AGENT ||
  "";

/** WHICH FILE is about to be edited. Two ways to tell us, because hosts differ:
 *   · --file=<path>
 *   · a JSON payload on stdin containing a file path anywhere (most pre-tool hooks pipe one)
 *
 *  It matters because a fresh graph read is not the same as a RELEVANT one: an agent that read
 *  about the font system four minutes ago knows nothing about enemy placement. A NEW TASK SHOWS
 *  UP AS NEW FILES, so the first touch of a file is a moment worth checking. */
function fileFrom(stdinText) {
  const flag = process.argv.find((a) => a.startsWith("--file="));
  if (flag) return flag.slice(7);
  try {
    const j = JSON.parse(stdinText);
    const hit = j?.tool_input?.file_path ?? j?.file_path ?? j?.path ?? j?.tool_input?.path;
    if (typeof hit === "string") return hit;
  } catch { /* not JSON, or no path in it — fine */ }
  return "";
}

async function main() {
  // Read stdin if the host pipes us a payload (most pre-tool hooks do). Leaving the pipe
  // unread can also make some hosts hang, so we always drain it.
  let stdinText = "";
  if (!process.stdin.isTTY) {
    try {
      for await (const chunk of process.stdin) stdinText += chunk;
    } catch { /* ignore */ }
  }
  const file = fileFrom(stdinText);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const q = new URLSearchParams();
    if (AGENT) q.set("agent", AGENT);
    if (file) q.set("file", file);
    const res = await fetch(`${URL_BASE}/api/gate/check${q.size ? `?${q}` : ""}`, { signal: ctrl.signal });
    if (!res.ok) return;
    const body = await res.json();
    if (body?.remind && body?.message) process.stdout.write(String(body.message) + "\n");
  } catch {
    // fail open — server down, slow, or unreachable. Say nothing, block nothing.
  } finally {
    clearTimeout(timer);
  }
}

main().finally(() => process.exit(0));
