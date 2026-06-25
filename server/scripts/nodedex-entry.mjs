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
  nodedex run       Start the MCP + API server
  nodedex tui       Launch the operator console
  nodedex onboard   Run the setup wizard (provider / model / port / db)
  nodedex help      Show this message

With no command, nodedex starts the server (same as \`nodedex run\`).`;

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

switch (cmd) {
  case "":
  case "run":
  case "start":
    startServer();
    break;
  case "tui":
  case "dashboard":
    launchTui();
    break;
  case "onboard":
  case "setup":
    launchTui(["--onboard"]);
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
