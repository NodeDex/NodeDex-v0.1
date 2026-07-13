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

async function main() {
  // Drain stdin if the host pipes us a payload — we do not need it, but leaving the pipe
  // unread can make some hosts hang.
  if (!process.stdin.isTTY) {
    try {
      for await (const _ of process.stdin) { /* discard */ }
    } catch { /* ignore */ }
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const q = AGENT ? `?agent=${encodeURIComponent(AGENT)}` : "";
    const res = await fetch(`${URL_BASE}/api/gate/check${q}`, { signal: ctrl.signal });
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
