#!/usr/bin/env node
/**
 * NodeDex entry point — starts the MCP + API server (compiled dist).
 *
 * Run `npm run build` in server/ first (this loads ../dist/server.js).
 * First-run setup is the TUI onboarding wizard — see the `tui/` package
 * (`npm run dev`), which configures provider/key/port/db and launches the server.
 */

// Start MCP (stdio) + HTTP API server.
import("../dist/server.js");
