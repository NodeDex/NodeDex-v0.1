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
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const cmd = (args[0] || "").toLowerCase();

const HELP = `nodedex — persistent knowledge-graph memory for AI agents

Usage:
  nodedex run     Start the MCP + API server
  nodedex tui     Launch the console / onboarding wizard
  nodedex setup   First-run setup (alias for \`nodedex tui\`)
  nodedex help    Show this message

With no command, nodedex starts the server (same as \`nodedex run\`).`;

function startServer() {
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
function launchTui() {
  const tuiDir = resolve(here, "../../tui");
  if (!existsSync(resolve(tuiDir, "src/cli.tsx"))) {
    console.error(
      "[nodedex] tui/ not found next to the server — `nodedex tui` needs the full repo (clone), not a standalone server install."
    );
    process.exit(1);
  }
  const child = spawn(process.execPath, ["--import", "tsx/esm", "src/cli.tsx"], {
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
  case "setup":
    launchTui();
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
