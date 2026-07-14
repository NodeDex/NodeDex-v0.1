#!/usr/bin/env node
// cli.tsx — entry point. `npm run dev` (tsx) renders the app.
import React, { useState } from "react";
import { render } from "ink";
import { App } from "./App.js";
import { ConfigScreen } from "./config-screen.js";
import { Onboarding } from "./onboarding.js";
import { needsOnboarding } from "./config.js";

// Own the terminal via the ALTERNATE SCREEN BUFFER (like vim / htop / less): the TUI
// renders into a dedicated buffer with NO scrollback, so a frame taller than the
// window — or a tab switch — can't push a copy of the UI up into shell history (the
// "duplicate TUI on tab switch" bug). Pair with the height-pinned root in App.tsx so
// every frame is the same height and ink repaints in place.
//
// CRITICAL: restore the user's normal screen on EVERY exit path. A process that exits
// while still in the alt buffer leaves the shell looking broken. `process.on("exit")`
// is the catch-all — it fires on normal unmount, on process.exit() (App's signal
// handlers), and after ink's own Ctrl-C exit. It must be synchronous (a raw write is).
const enterAltScreen = () => process.stdout.write("\x1b[?1049h\x1b[2J\x1b[H");
const leaveAltScreen = () => process.stdout.write("\x1b[?1049l");
enterAltScreen();
process.on("exit", leaveAltScreen);

// A crash (a render throw or an unhandled promise rejection) while the terminal is in
// RAW MODE + the alt-screen buffer would otherwise leave it FROZEN — no input handler, so
// q / Ctrl-C / esc all do nothing and you can't close it. Restore raw mode + the screen and
// exit hard, so the user always gets their shell (and the error) back instead of a dead TUI.
const crashOut = (label: string) => (err: unknown) => {
  try { if (process.stdin.isTTY) process.stdin.setRawMode?.(false); } catch { /* */ }
  try { leaveAltScreen(); } catch { /* */ }
  try { process.stderr.write(`\nNodedex TUI ${label}: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`); } catch { /* */ }
  process.exit(1);
};
process.on("uncaughtException", crashOut("crashed"));
process.on("unhandledRejection", crashOut("unhandled rejection"));

// First run (no model configured yet) → the setup wizard, which starts a server and
// hands off to the TUI. Otherwise, straight into the app. `--onboard` (npm run onboard)
// FORCES the wizard even when already set up — to switch provider/model/db or re-run setup.
const forceOnboard = process.argv.includes("--onboard");
// `nodedex config` → the STANDALONE keyring page (its own screen, NOT the tui shell).
// The dashboard is `nodedex tui`; config is a focused key/model manager.
const startConfig = process.argv.includes("--config");
function Root() {
  const [done, setDone] = useState(() => !forceOnboard && !needsOnboarding());
  if (!done) return <Onboarding onDone={() => setDone(true)} />;
  if (startConfig) return <ConfigScreen />;
  return <App initialView={0} />;
}

render(<Root />);
