#!/usr/bin/env node
/**
 * NodeDex CLI entry point.
 *
 *   nodedex         First run → the setup wizard; configured → the server
 *   nodedex run     Start the MCP + API server (never the wizard)
 *   nodedex tui     Launch the console / onboarding wizard
 *   nodedex setup   Wizard, or headless with flags (see help)
 *   nodedex help    Show usage
 *
 * Back-compat: `nodedex-server` (no args) ALWAYS starts the server (never interactive).
 * In the repo, build first with `npm run build` in server/ (this loads ../dist/server.js);
 * the published npm package ships dist/ + the compiled TUI (tui-dist/) ready to run.
 */
import { spawn, execSync } from "node:child_process";
import { existsSync, readFileSync, mkdirSync, writeFileSync, unlinkSync, readdirSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve, join } from "node:path";
import { homedir } from "node:os";

// Fail CLEARLY on old Node — the entry + server use global fetch / AbortSignal.timeout
// (Node ≥ 18); without this guard an old runtime dies with a cryptic ReferenceError.
const nodeMajor = Number(process.versions.node.split(".")[0]);
if (nodeMajor < 18) {
  console.error(`[nodedex] Node ${process.versions.node} is too old — NodeDex needs Node >= 18. Upgrade at https://nodejs.org`);
  process.exit(1);
}

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const cmd = (args[0] || "").toLowerCase();

const HELP = `nodedex — persistent knowledge-graph memory for AI agents

Usage:
  nodedex run       Start the MCP + API server (+ any enabled capture watchers)
  nodedex connect   Print the connection card: the RIGHT url per client location
                    (host / Docker / LAN), token rule, and copy-paste test commands.
                    --json for machine-readable (agents).
  nodedex tui       Launch the operator console
  nodedex onboard   Run the setup wizard (provider / model / port / db)
  nodedex setup     Same as onboard; with flags = HEADLESS setup (for agents/scripts):
    --provider openrouter --key sk-or-...   [--model google/gemini-2.5-flash-lite]
    --provider local --base-url http://localhost:11434/v1 --model <id>
    [--port 3001] [--db <name>] [--capture hermes,claude-code | none] [--dry-run]
  nodedex demo      Serve a bundled sample graph (a finished project's decisions,
                    dead-ends, and chains) on :3009 — see what your agent's memory
                    looks like BEFORE accumulating your own. No LLM key needed.
  nodedex stop      Stop running NodeDex servers: \`stop\` = the ones it knows
                    (pidfiles + config port), \`stop 3002\` = that port,
                    \`stop --all\` = sweep the whole discovery range. Only kills
                    a process after confirming a NodeDex answers on the port.
  nodedex uninstall Remove ALL local data + config (~/.nodedex) — asks first;
                    --yes skips the prompt (scripts). Does not remove the package.
  nodedex help      Show this message

Reconfigure = re-run \`nodedex onboard\` (wizard) or \`nodedex setup\` with flags
(headless — merges into the existing config, e.g. just --key or --model).

With no command: first run launches the setup wizard; once configured it starts
the server (same as \`nodedex run\`). \`nodedex-server\` always starts the server.
Headless example (what an agent runs after asking its user):
  nodedex setup --provider openrouter --key sk-or-... --db memory --capture claude-code
  nodedex run`;

// The server is env-only; the TUI normally injects provider/port/db env at launch
// (tui/src/config.ts: providerEnv + launchServer). `nodedex run` does the SAME
// translation here, from ~/.nodedex/config.json, so it works standalone — otherwise
// the bare server defaults to keyless gemini. Keep this mapping in sync with
// config.ts. Explicit env always wins (fill-if-unset).
const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const OPENROUTER_DEFAULT_MODEL = "google/gemini-2.5-flash";

function applyConfigEnv() {
  let c;
  try {
    c = JSON.parse(readFileSync(join(homedir(), ".nodedex", "config.json"), "utf8"));
  } catch {
    return; // no config yet — the server falls back to its own .env / defaults
  }
  const set = (k, v) => {
    if (v != null && v !== "" && !process.env[k]) process.env[k] = String(v);
  };
  if (c.provider === "openrouter" && c.openrouter_key) {
    set("AI_PROVIDER", "openai-compatible");
    set("OPENAI_BASE_URL", OPENROUTER_BASE_URL);
    set("OPENAI_API_KEY", c.openrouter_key);
    set("AI_MODEL", c.model || OPENROUTER_DEFAULT_MODEL);
  } else if (c.provider === "local" && c.base_url && c.model) {
    set("AI_PROVIDER", "openai-compatible");
    set("OPENAI_BASE_URL", c.base_url);
    set("OPENAI_API_KEY", "local");
    set("AI_MODEL", c.model);
  }
  set("PORT", c.port);
  set("WORKSPACE_DB_PATH", c.dbPath);
  // Arc mode ON, matching the TUI's launch env (servers.ts). Without this, watcher-fed
  // turns (turn_number present) route to the retired per-turn v1 path and NO-OP — the
  // whole capture story silently dead on a headless install. Found the hard way in the
  // 2026-07-02 dogfood run: a bare `node dist/server.js` captured nothing.
  set("NODEDEX_ARC_EXTRACTION", "1");
}

// `nodedex demo` — serve a bundled synthetic graph so minute ONE shows what weeks
// of accumulated memory look like (a fresh install's real graph is empty — the
// value compounds, which is honest but demos terribly). Read-only in spirit: no
// watchers are started, so nothing captures into the demo db.
async function demoRun() {
  const dbPath = join(homedir(), ".nodedex", "NodeDexDemo.db");
  const distServer = resolve(here, "../dist/server.js");
  if (!existsSync(distServer)) {
    console.error("[nodedex] dist/server.js not found — build the server first: `npm run build` (in server/).");
    process.exit(1);
  }
  if (!existsSync(dbPath)) {
    console.log("[nodedex demo] building the demo graph (one-time, ~1s, no LLM)…");
    const { buildDemoGraph } = await import(pathToFileURL(resolve(here, "demo-graph.mjs")).href);
    const n = await buildDemoGraph(dbPath);
    console.log(`[nodedex demo] demo graph ready — ${n.blocks} blocks, ${n.relations} causal links.`);
  }
  const port = Number(flagValue("--port")) || 3009;
  process.env.WORKSPACE_DB_PATH = dbPath; // explicit env wins over config
  process.env.PORT = String(port);
  applyConfigEnv();
  writePidFile();
  console.log(`
[nodedex demo] a synthetic project history (payments-API rate limiter) is live:

  MCP:  http://127.0.0.1:${port}/mcp        (point any MCP agent here)
  TUI:  \`nodedex tui\` → enter on "connected" → switch to :${port}

Ask your agent, with only this server connected:
  1. "What did we try and abandon in the ratelimiter project, and why?"
  2. "Why was token bucket chosen — what else was considered?"
  3. "Is 'keep the counters in Redis' still the current decision?"   ← superseded; the agent should follow the edge
  4. "What's still open or unverified?"

Stop with \`nodedex stop ${port}\`. Your real graph is untouched — this serves ${"NodeDexDemo.db"} only.
`);
  import(pathToFileURL(distServer).href);
}

function startServer() {
  applyConfigEnv();
  const distServer = resolve(here, "../dist/server.js");
  if (!existsSync(distServer)) {
    console.error(
      "[nodedex] dist/server.js not found — build the server first: `npm run build` (in server/)."
    );
    process.exit(1);
  }
  writePidFile();
  // On Windows a bare absolute path ("C:\\...") is rejected by the ESM loader;
  // it must be a file:// URL.
  import(pathToFileURL(distServer).href);
  startEnabledWatchers();
}

// ─── pidfiles + `nodedex stop` ─────────────────────────────────────────────────
// The server runs IN-PROCESS of this entry (import above), so this pid IS the
// server pid. `nodedex stop [port…|--all]` reads these first; for servers it
// didn't start (TUI-launched, bare node) it falls back to a port→PID lookup.
function runDir() { return join(homedir(), ".nodedex", "run"); }
function pidFileFor(port) { return join(runDir(), `server-${port}.pid`); }

function writePidFile() {
  try {
    const port = Number(process.env.PORT) || 3001;
    mkdirSync(runDir(), { recursive: true });
    writeFileSync(pidFileFor(port), String(process.pid));
    process.on("exit", () => { try { unlinkSync(pidFileFor(port)); } catch { /* */ } });
  } catch { /* best-effort — stop falls back to port lookup */ }
}

/** PID listening on a local port — Windows netstat / unix lsof. Null if none. */
function pidOnPort(port) {
  try {
    if (process.platform === "win32") {
      const out = execSync("netstat -ano -p tcp", { encoding: "utf8" });
      for (const line of out.split(/\r?\n/)) {
        const m = line.trim().match(/^TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)$/i);
        if (m && Number(m[1]) === port) return Number(m[2]);
      }
      return null;
    }
    const out = execSync(`lsof -ti tcp:${port} -sTCP:LISTEN`, { encoding: "utf8" });
    const pid = Number(out.trim().split(/\s+/)[0]);
    return Number.isInteger(pid) ? pid : null;
  } catch { return null; }
}

function killPid(pid) {
  try {
    if (process.platform === "win32") execSync(`taskkill /PID ${pid} /T /F`, { stdio: "ignore" });
    else process.kill(pid, "SIGTERM");
    return true;
  } catch { return false; }
}

/** `nodedex stop [port…] | --all` — stop NodeDex servers by port. Only kills a
 *  process after confirming a NodeDex answers on that port (never blind-kills). */
async function stopServers() {
  const wantAll = args.includes("--all");
  const explicit = args.slice(1).map(Number).filter((n) => Number.isInteger(n) && n > 0);

  // Candidate ports: explicit args, or (for --all / bare stop) pidfiles + config
  // port + the discovery range.
  let ports = explicit;
  if (ports.length === 0) {
    const set = new Set();
    try {
      for (const f of readdirSync(runDir())) {
        const m = f.match(/^server-(\d+)\.pid$/);
        if (m) set.add(Number(m[1]));
      }
    } catch { /* no run dir */ }
    try {
      const c = JSON.parse(readFileSync(join(homedir(), ".nodedex", "config.json"), "utf8"));
      if (Number.isInteger(c.port)) set.add(c.port);
    } catch { /* */ }
    if (wantAll) for (const p of [3001, 3002, 3003, 3004, 3005, 3006, 3007, 3008, 3009, 3099]) set.add(p);
    ports = [...set];
  }
  if (ports.length === 0) { console.log("[nodedex stop] no known servers (no pidfiles, no config port). Pass a port: nodedex stop 3001"); return; }

  let stopped = 0;
  for (const port of ports.sort((a, b) => a - b)) {
    // Confirm it's a NodeDex before killing anything on the port.
    let isNodedex = false;
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1200) });
      isNodedex = r.ok;
    } catch { /* not up */ }
    if (!isNodedex) {
      if (explicit.length) console.log(`  :${port} — no NodeDex answering, skipped`);
      continue;
    }
    let pid = null;
    try { pid = Number(readFileSync(pidFileFor(port), "utf8").trim()) || null; } catch { /* no pidfile */ }
    if (!pid) pid = pidOnPort(port);
    if (!pid) { console.log(`  :${port} — NodeDex is up but its PID couldn't be resolved (kill it by hand)`); continue; }
    const ok = killPid(pid);
    console.log(`  :${port} — ${ok ? `stopped (pid ${pid})` : `failed to kill pid ${pid}`}`);
    if (ok) { stopped++; try { unlinkSync(pidFileFor(port)); } catch { /* */ } }
  }
  console.log(`[nodedex stop] ${stopped} server(s) stopped.`);
}

// Headless path parity with the TUI: `nodedex run` also brings up whichever capture
// watchers the config enables (the TUI spawns its own when it runs; this covers
// server-only / agent-driven installs where no TUI is ever opened).
function startEnabledWatchers() {
  let c = {};
  try { c = JSON.parse(readFileSync(join(homedir(), ".nodedex", "config.json"), "utf8")); } catch { return; }
  const defs = [
    { key: "hermesCapture", script: "hermes-statedb-watcher.mjs", name: "hermes" },
    { key: "claudeCapture", script: "claude-code-watcher.mjs", name: "claude-code" },
  ];
  for (const d of defs) {
    if (!c[d.key] || c[d.key].enabled === false) continue; // only spawn what setup/TUI explicitly enabled
    const script = resolve(here, "../adapters", d.script);
    if (!existsSync(script)) continue;
    const child = spawn(process.execPath, [script], { cwd: resolve(here, ".."), stdio: ["ignore", "inherit", "inherit"] });
    child.on("error", (e) => console.error(`[nodedex] ${d.name} watcher failed to start: ${e.message}`));
    console.error(`[nodedex] ${d.name} capture watcher started (pid ${child.pid}).`);
  }
}

// ─── Headless setup (agent/script-driven — no TUI) ─────────────────────────────
// Writes the SAME ~/.nodedex/config.json the wizard writes, so `nodedex run`, the
// TUI, and the watchers all pick it up identically. Deterministic on purpose: an
// agent installing NodeDex for its user runs ONE command instead of improvising.
function flagValue(name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function headlessSetup() {
  const provider = (flagValue("--provider") || "").toLowerCase();
  const dryRun = args.includes("--dry-run");
  if (provider !== "openrouter" && provider !== "local") {
    console.error("[nodedex setup] --provider must be 'openrouter' or 'local'. See `nodedex help`.");
    process.exit(1);
  }
  const patch = { provider, onboarded: true };

  if (provider === "openrouter") {
    const key = flagValue("--key");
    if (!key) { console.error("[nodedex setup] --key sk-or-... is required for --provider openrouter."); process.exit(1); }
    // Same validation as the wizard: a typo fails HERE, not at first extraction.
    try {
      const r = await fetch(`${OPENROUTER_BASE_URL}/key`, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(8000) });
      if (!r.ok) { console.error(`[nodedex setup] OpenRouter rejected the key (${r.status}).`); process.exit(1); }
    } catch (e) {
      console.error(`[nodedex setup] couldn't reach OpenRouter to validate the key (${e?.message ?? e}).`);
      process.exit(1);
    }
    patch.openrouter_key = key;
    patch.model = flagValue("--model") || "google/gemini-2.5-flash-lite";
  } else {
    const baseUrl = flagValue("--base-url");
    const model = flagValue("--model");
    if (!baseUrl || !model) { console.error("[nodedex setup] --base-url and --model are required for --provider local."); process.exit(1); }
    patch.base_url = baseUrl;
    patch.model = model;
  }

  const port = Number(flagValue("--port"));
  patch.port = Number.isInteger(port) && port > 0 ? port : 3001;

  const db = flagValue("--db") || "workspace";
  patch.dbPath = /[\\/]/.test(db)
    ? db // explicit path given
    : join(homedir(), ".nodedex", `${db.trim().replace(/[^a-z0-9_-]/gi, "-").replace(/^-+|-+$/g, "") || "workspace"}.db`);

  // Capture consent is EXPLICIT here (no checkbox screen): the caller — typically an
  // agent that just asked its user — names the hosts. Default: none (read-only setup).
  const capture = (flagValue("--capture") || "none").toLowerCase();
  const hosts = new Set(capture === "none" ? [] : capture.split(",").map((s) => s.trim()).filter(Boolean));
  patch.hermesCapture = { enabled: hosts.has("hermes") };
  patch.claudeCapture = { enabled: hosts.has("claude-code") || hosts.has("claude") };

  const configPath = join(homedir(), ".nodedex", "config.json");
  let existing = {};
  try { existing = JSON.parse(readFileSync(configPath, "utf8")); } catch { /* fresh install */ }
  const merged = { ...existing, ...patch };

  if (dryRun) {
    const masked = { ...merged, openrouter_key: merged.openrouter_key ? merged.openrouter_key.slice(0, 8) + "…" : undefined };
    console.log("[nodedex setup] DRY-RUN — would write to " + configPath + ":");
    console.log(JSON.stringify(masked, null, 2));
    return;
  }
  const { mkdirSync, writeFileSync } = await import("node:fs");
  mkdirSync(join(homedir(), ".nodedex"), { recursive: true });
  writeFileSync(configPath, JSON.stringify(merged, null, 2));
  console.log(`[nodedex setup] config written → ${configPath}`);
  console.log(`  provider=${provider}  model=${merged.model}  port=${merged.port}`);
  console.log(`  db=${merged.dbPath}`);
  console.log(`  capture: hermes=${patch.hermesCapture.enabled} claude-code=${patch.claudeCapture.enabled}`);
  console.log(`Next: \`nodedex run\` starts the server (+ enabled watchers).`);
  console.log(`Connect your agent to http://127.0.0.1:${merged.port}/mcp — snippets: ~/.nodedex/connect-snippets.md (written by the TUI) or the README.`);
}

// Launch the TUI (operator console + first-run onboarding wizard). Two layouts:
//   packaged (npx / npm install): the compiled TUI ships INSIDE this package at
//     tui-dist/ and runs on plain node (its deps — ink/react — are package deps);
//   repo/dev: the sibling tui/ package, run from source via tsx.
function launchTui(extraArgs = []) {
  const packagedCli = resolve(here, "../tui-dist/cli.js");
  const repoTuiDir = resolve(here, "../../tui");
  let spawnArgs, cwd;
  if (existsSync(packagedCli)) {
    spawnArgs = [packagedCli, ...extraArgs];
    cwd = resolve(here, "..");
  } else if (existsSync(resolve(repoTuiDir, "src/cli.tsx"))) {
    spawnArgs = ["--import", "tsx/esm", "src/cli.tsx", ...extraArgs];
    cwd = repoTuiDir;
  } else {
    console.error("[nodedex] no TUI found (neither packaged tui-dist/ nor a repo tui/). Reinstall the package.");
    process.exit(1);
  }
  const child = spawn(process.execPath, spawnArgs, { cwd, stdio: "inherit" });
  child.on("error", (err) => {
    console.error(`[nodedex] failed to launch the TUI: ${err.message}`);
    process.exit(1);
  });
  child.on("exit", (code) => process.exit(code ?? 0));
}

// ─── `nodedex uninstall` — remove ~/.nodedex (data + config). DESTRUCTIVE. ─────
// Mirrors tui/scripts/uninstall.mjs so packaged (npx) installs have a way out too.
// Does NOT remove the package itself or the NodeDex entry in the agent host's MCP
// config. `--yes` skips the prompt (agent/script-driven).
async function uninstall() {
  const { rmSync, readdirSync } = await import("node:fs");
  const home = join(homedir(), ".nodedex");
  if (!existsSync(home)) {
    console.log(`Nothing to remove — ${home} doesn't exist.`);
    return;
  }
  let dbs = [];
  try { dbs = readdirSync(home).filter((f) => f.endsWith(".db")); } catch { /* unreadable */ }
  console.log(`\nThis will permanently DELETE:\n  ${home}\n`);
  console.log("Including:");
  console.log("  • your config + OpenRouter API key");
  console.log(`  • ${dbs.length} knowledge-graph database(s): ${dbs.join(", ") || "(none)"}`);
  console.log("  • server logs + reflect-pause state");
  console.log("\nThis cannot be undone. It does NOT remove the nodedex package, or the NodeDex");
  console.log("entry in your agent host's MCP config — remove those yourself.\n");

  if (!args.includes("--yes")) {
    const readline = await import("node:readline/promises");
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const ans = (await rl.question('Type "delete" to confirm: ')).trim().toLowerCase();
    rl.close();
    if (ans !== "delete") {
      console.log("Aborted — nothing removed.");
      return;
    }
  }
  try {
    rmSync(home, { recursive: true, force: true });
  } catch (e) {
    console.log(`\nFailed to remove ${home}: ${e?.message ?? e}`);
    console.log("A server may still be holding a database file. Stop all NodeDex servers, then re-run.");
    process.exit(1);
  }
  console.log(`\nRemoved ${home}.`);
  console.log("Also remove the NodeDex MCP entry from your agent host's config.");
}

// First run? (mirrors tui/src/config.ts needsOnboarding, without importing it)
function isOnboarded() {
  try {
    const c = JSON.parse(readFileSync(join(homedir(), ".nodedex", "config.json"), "utf8"));
    if (!c.onboarded) return false;
    if (c.provider === "openrouter") return !!c.openrouter_key;
    if (c.provider === "local") return !!(c.base_url && c.model);
    return false;
  } catch {
    return false;
  }
}

// ─── `nodedex connect` — the connection card ───────────────────────────────────
// THE fix for "connecting is messy": one command that reports ground truth instead
// of the user/agent guessing at ip × port × token. Reads the live server list
// (tui-session.json), probes health, and prints the RIGHT url for each client
// location + the exact test command to run from there. --json for agents.
async function connectCard() {
  const asJson = args.includes("--json");
  let session = {};
  try { session = JSON.parse(readFileSync(join(homedir(), ".nodedex", "tui-session.json"), "utf8")); } catch { /* none */ }
  let managed = Array.isArray(session?.managed) ? session.managed : [];
  if (managed.length === 0) {
    // No TUI-managed record — probe the config/default port directly (headless installs).
    let port = 3001;
    try { port = JSON.parse(readFileSync(join(homedir(), ".nodedex", "config.json"), "utf8"))?.port || 3001; } catch { /* default */ }
    managed = [{ port, token: process.env.NODEDEX_API_TOKEN || "" }];
  }

  const servers = [];
  for (const m of managed) {
    if (!m?.port) continue;
    let up = false, db = null;
    try {
      const r = await fetch(`http://127.0.0.1:${m.port}/api/health`, { signal: AbortSignal.timeout(2500) });
      up = r.ok;
      try { db = (await r.json())?.db ?? null; } catch { /* health may be bodyless */ }
    } catch { /* down */ }
    servers.push({ port: m.port, token: m.token || "", up, db });
  }

  // Best-effort LAN address (for a remote machine / LAN agent).
  const { networkInterfaces } = await import("node:os");
  let lanIp = null;
  for (const ifaces of Object.values(networkInterfaces() || {})) {
    for (const i of ifaces || []) {
      if (i.family === "IPv4" && !i.internal && !String(i.address).startsWith("169.254.")) { lanIp = i.address; break; }
    }
    if (lanIp) break;
  }

  if (asJson) {
    console.log(JSON.stringify({
      token_rule: "same-machine connections NEVER need the token; Docker/remote ALWAYS do (unless NODEDEX_STRICT_TOKEN=1)",
      servers: servers.map((s) => ({
        up: s.up, port: s.port, db: s.db,
        from_this_machine: { mcp: `http://127.0.0.1:${s.port}/mcp`, token_needed: false },
        from_docker: { mcp: `http://host.docker.internal:${s.port}/mcp`, token_needed: !!s.token, token: s.token || null, linux_note: "add --add-host=host.docker.internal:host-gateway" },
        from_lan: lanIp ? { mcp: `http://${lanIp}:${s.port}/mcp`, token_needed: !!s.token, token: s.token || null, note: "server must be started with NODEDEX_BIND_HOST=0.0.0.0" } : null,
      })),
    }, null, 2));
    return;
  }

  if (servers.length === 0) { console.log("[nodedex connect] no server known — run `nodedex run` (or the TUI) first."); return; }
  console.log("NodeDex connection card — the ONE token rule: same machine = no token; Docker/remote = token.\n");
  for (const s of servers) {
    console.log(`● port ${s.port}  ${s.up ? "UP" : "DOWN — start it: nodedex run"}${s.db ? `  db=${s.db}` : ""}`);
    console.log(`  From THIS machine (Claude Code, local agents):`);
    console.log(`    http://127.0.0.1:${s.port}/mcp        (no token, ever)`);
    console.log(`    test: curl http://127.0.0.1:${s.port}/api/health`);
    console.log(`  From INSIDE Docker (agent in a container):`);
    console.log(`    http://host.docker.internal:${s.port}/mcp${s.token ? `   + header  Authorization: Bearer ${s.token}` : "   (no token configured — set one for network exposure)"}`);
    console.log(`    test (run INSIDE the container): curl ${s.token ? `-H "Authorization: Bearer ${s.token}" ` : ""}http://host.docker.internal:${s.port}/api/health`);
    console.log(`    Linux: add  --add-host=host.docker.internal:host-gateway  to the container.`);
    if (lanIp) console.log(`  From ANOTHER machine on your network: http://${lanIp}:${s.port}/mcp  (token required; server needs NODEDEX_BIND_HOST=0.0.0.0)`);
    console.log("");
  }
  console.log(`If a Docker connect fails: (1) run the in-container curl above — if it hangs, it's networking
(host-gateway flag / Windows firewall "allow" prompt for node), not NodeDex; (2) 401 = missing/wrong
token header; (3) NEVER use "localhost" from a container (that's the container itself).`);
}

// Bare `npx nodedex` on a fresh machine = the setup wizard, not a keyless server.
// `nodedex run`/`start` (and the `nodedex-server` bin name) always mean the server —
// scripts and process managers must never be surprised by an interactive wizard.
const invokedAsServer = String(process.argv[1] || "").toLowerCase().includes("nodedex-server");

switch (cmd) {
  case "":
    if (!invokedAsServer && !isOnboarded()) {
      console.error("[nodedex] first run — launching the setup wizard (use `nodedex run` to skip straight to the server).");
      launchTui(["--onboard"]);
      break;
    }
    startServer();
    break;
  case "run":
  case "start":
    startServer();
    break;
  case "connect":
  case "doctor":
    void connectCard();
    break;
  case "stop":
    void stopServers();
    break;
  case "demo":
    void demoRun();
    break;
  case "uninstall":
    void uninstall();
    break;
  case "tui":
  case "dashboard":
    launchTui();
    break;
  case "onboard":
  case "setup":
    // Flags present → headless (agent/script-driven); bare → the interactive wizard.
    if (args.some((a) => a.startsWith("--"))) void headlessSetup();
    else launchTui(["--onboard"]);
    break;
  case "help":
  case "-h":
  case "--help":
    console.log(HELP);
    break;
  default:
    console.error(`[nodedex] unknown command: ${args[0]}\n`);
    console.log(HELP);
    process.exit(1);
}
