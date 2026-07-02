#!/usr/bin/env node
/**
 * NodeDex CLI entry point.
 *
 *   nodedex run     Start the MCP + API server (also the no-arg default)
 *   nodedex tui     Launch the console / onboarding wizard
 *   nodedex setup   First-run setup (alias for `nodedex tui`)
 *   nodedex help    Show usage
 *
 * Back-compat: `nodedex-server` (no args) still starts the server.
 * Build first with `npm run build` in server/ (this loads ../dist/server.js).
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve, join } from "node:path";
import { homedir } from "node:os";

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
  nodedex help      Show this message

With no command, nodedex starts the server (same as \`nodedex run\`).
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

function startServer() {
  applyConfigEnv();
  const distServer = resolve(here, "../dist/server.js");
  if (!existsSync(distServer)) {
    console.error(
      "[nodedex] dist/server.js not found — build the server first: `npm run build` (in server/)."
    );
    process.exit(1);
  }
  // On Windows a bare absolute path ("C:\\...") is rejected by the ESM loader;
  // it must be a file:// URL.
  import(pathToFileURL(distServer).href);
  startEnabledWatchers();
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

// Launch the TUI (operator console + first-run onboarding wizard). The TUI is a
// sibling package run with tsx; it lives next to server/ in the repo, not in the
// published server bundle — so this is a clone-only convenience.
function launchTui(extraArgs = []) {
  const tuiDir = resolve(here, "../../tui");
  if (!existsSync(resolve(tuiDir, "src/cli.tsx"))) {
    console.error(
      "[nodedex] tui/ not found next to the server — `nodedex tui` needs the full repo (clone), not a standalone server install."
    );
    process.exit(1);
  }
  const child = spawn(process.execPath, ["--import", "tsx/esm", "src/cli.tsx", ...extraArgs], {
    cwd: tuiDir,
    stdio: "inherit",
  });
  child.on("error", (err) => {
    console.error(`[nodedex] failed to launch the TUI: ${err.message}`);
    process.exit(1);
  });
  child.on("exit", (code) => process.exit(code ?? 0));
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

switch (cmd) {
  case "":
  case "run":
  case "start":
    startServer();
    break;
  case "connect":
  case "doctor":
    void connectCard();
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
