#!/usr/bin/env node
/**
 * NodeDex CLI entry point.
 *
 *   nodedex run     Start the MCP + API server (also the no-arg default)
 *   nodedex setup   How to run first-time setup (the TUI onboarding wizard)
 *   nodedex help    Show usage
 *
 * Back-compat: `nodedex-server` (no args) still starts the server.
 * Build first with `npm run build` in server/ (this loads ../dist/server.js).
 */
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const cmd = (args[0] || "").toLowerCase();

const HELP = `nodedex — persistent knowledge-graph memory for AI agents

Usage:
  nodedex run     Start the MCP + API server
  nodedex setup   First-run setup (the onboarding wizard)
  nodedex help    Show this message

With no command, nodedex starts the server (same as \`nodedex run\`).`;

const SETUP = `First-run setup is the onboarding wizard in the tui/ package:

  cd tui && npm install && npm run dev

It walks you through provider/key, picks a port + database, and launches
the server. See the README for details.`;

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

switch (cmd) {
  case "":
  case "run":
  case "start":
    startServer();
    break;
  case "setup":
    console.log(SETUP);
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
