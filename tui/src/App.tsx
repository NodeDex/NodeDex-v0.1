// App.tsx — shell v3: three views (memory · feed · health), one quiet chrome.
// Top line = brand + view bar; bottom line = the StatusLine (single home for
// connection/graph/pipeline/spend numbers). Two poll cadences: fast 2s over
// LOCAL endpoints, slow 30s for the OpenRouter balance. Input is guarded by
// isRawModeSupported so a non-TTY (piped) context still renders.
import React, { useCallback, useEffect, useRef, useState } from "react";
import { Box, Text, useApp, useInput, useStdin } from "ink";
import { Brand, ViewBar, StatusLine } from "./components.js";
import { MemoryTab } from "./memory.js";
import { FeedTab } from "./feed.js";
import { HealthTab } from "./health.js";
import { fetchDashboard, fetchBalance, getBase, setBase, type Dashboard, type Balance } from "./api.js";
import { killAllManaged, restoreSession, launchWatcher, isWatcherRunning } from "./servers.js";
import { loadHermesCapture, loadClaudeCapture } from "./config.js";
import { theme } from "./theme.js";
import { useTermSize } from "./hooks.js";

const VIEWS = ["memory", "feed", "health"];
const MEMORY = 0;
const FEED = 1;
const HEALTH = 2;
const VERSION = "0.3.0";
const FAST_MS = 2000;
const SLOW_MS = 30000;

export function App() {
  const { exit } = useApp();
  const { isRawModeSupported } = useStdin();
  const { rows } = useTermSize();
  const [dash, setDash] = useState<Dashboard | null>(null);
  const [balance, setBalance] = useState<Balance>({ remaining: null, available: false });
  const [active, setActive] = useState(MEMORY);
  const [auto, setAuto] = useState(true);
  // Restore the last server+db BEFORE the first poll so we land on the right one (a
  // restart reconnects if it's up, else relaunches the managed server on the same
  // port+db). Polling waits on this so the first frame isn't aimed at the default base.
  const [booting, setBooting] = useState(true);

  // A pane's free-text input mode (search, edit rows) owns the keyboard — while it
  // captures, the shell must not act on q/esc/digits. Ref, not state, so the input
  // handler sees the current value without re-subscribing.
  const captureRef = useRef(false);
  const onCapture = useCallback((v: boolean) => { captureRef.current = v; }, []);

  const refresh = useCallback(async () => { setDash(await fetchDashboard()); }, []);

  // Kill any servers the TUI launched before leaving — never leave a managed
  // child (or a held port) behind. Belt-and-suspenders: also on process exit.
  const doExit = useCallback(() => {
    try { killAllManaged(); } catch { /* */ }
    try { exit(); } catch { /* */ }
    // Force the process down shortly after the soft unmount; pending handles (a
    // managed server's pipes, scan timers) can keep the loop alive otherwise.
    const t = setTimeout(() => process.exit(0), 120);
    if (typeof t.unref === "function") t.unref();
  }, [exit]);
  useEffect(() => {
    const onProcExit = () => killAllManaged();
    // SIGTERM/SIGHUP terminate WITHOUT running 'exit' handlers — handle explicitly.
    const onSignal = () => { killAllManaged(); process.exit(0); };
    process.on("exit", onProcExit);
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
    process.on("SIGHUP", onSignal);
    return () => {
      process.off("exit", onProcExit);
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      process.off("SIGHUP", onSignal);
    };
  }, []);

  // One-time startup restore: reconnect to (or relaunch) the last server+db, then
  // release the boot gate so polling begins against the right base.
  useEffect(() => {
    let alive = true;
    (async () => {
      try { const url = await restoreSession(); if (alive && url) setBase(url); } catch { /* default base */ }
      // Reconcile capture watchers: whatever the user left enabled comes back up with
      // the servers (each watcher self-locates the live server, order doesn't matter).
      try { if (loadHermesCapture().enabled) launchWatcher(); } catch { /* best-effort */ }
      try { if (loadClaudeCapture().enabled) launchWatcher("claude-code"); } catch { /* best-effort */ }
      if (alive) setBooting(false);
    })();
    return () => { alive = false; };
  }, []);

  // Fast poll — local endpoints only. Held until boot restore picks the base.
  useEffect(() => {
    if (booting) return;
    let alive = true;
    const run = async () => {
      const d = await fetchDashboard();
      if (alive) setDash(d);
    };
    run();
    if (!auto) return () => { alive = false; };
    const id = setInterval(run, FAST_MS);
    return () => { alive = false; clearInterval(id); };
  }, [auto, booting]);

  // Slow poll — balance hits OpenRouter, keep it gentle. Also waits on boot.
  useEffect(() => {
    if (booting) return;
    let alive = true;
    const run = async () => {
      const b = await fetchBalance();
      if (alive) setBalance(b);
    };
    run();
    const id = setInterval(run, SLOW_MS);
    return () => { alive = false; clearInterval(id); };
  }, [booting]);

  useInput(
    (input, key) => {
      if (key.ctrl && input === "c") { doExit(); return; }
      if (captureRef.current) return; // a pane's input mode owns the keyboard
      if (input === "q") { doExit(); return; }
      if (key.tab) {
        setActive((a) => (key.shift ? a - 1 + VIEWS.length : a + 1) % VIEWS.length);
        return;
      }
      if (input >= "1" && input <= String(VIEWS.length)) { setActive(Number(input) - 1); return; }
      // r/j/k etc. belong to the views; only global leftovers here.
      if (active === FEED && input === "r") void refresh();
      if (input === "a") setAuto((v) => !v);
    },
    // Strict boolean: ink's useInput only skips raw mode when isActive === false.
    { isActive: isRawModeSupported === true }
  );

  const captureDots = [
    { name: "claude", on: isWatcherRunning("claude-code") },
    { name: "hermes", on: isWatcherRunning("hermes") },
  ];

  let body: React.ReactNode;
  if (active === HEALTH) {
    // Health stays usable when the connection is down — that's where you fix it.
    body = <HealthTab dash={dash} balance={balance} isActive={isRawModeSupported === true} onCapture={onCapture} onConnect={() => void refresh()} />;
  } else if (!dash) {
    body = (
      <Box paddingY={1}>
        <Text color={theme.dim}>{`connecting to ${getBase()} …`}</Text>
      </Box>
    );
  } else if (!dash.ok) {
    body = (
      <Box flexDirection="column" paddingY={1}>
        <Text color={theme.danger}>{`● server unreachable at ${getBase()}`}</Text>
        <Text color={theme.dim}>fix it in health [3] — switch server / db, or `nodedex run`</Text>
      </Box>
    );
  } else if (active === MEMORY) {
    body = <MemoryTab isActive={isRawModeSupported === true} onCapture={onCapture} />;
  } else {
    body = <FeedTab dash={dash} isActive={isRawModeSupported === true} />;
  }

  return (
    // height-pinned to the terminal so the frame is a CONSTANT size across views —
    // ink repaints in place instead of emitting a taller/shorter frame that scrolls.
    <Box flexDirection="column" paddingX={1} height={rows} overflow="hidden">
      <Box flexShrink={0} justifyContent="space-between" marginBottom={1}>
        <Box>
          <Brand />
          <Box marginLeft={3}><ViewBar views={VIEWS} active={active} /></Box>
        </Box>
        <Text color={theme.dim}>{`v${VERSION}`}</Text>
      </Box>
      <Box flexDirection="column" flexGrow={1} overflow="hidden">
        {body}
      </Box>
      <Box flexShrink={0} marginTop={1}>
        <StatusLine dash={dash} balance={balance} captureDots={captureDots} />
      </Box>
    </Box>
  );
}
