// App.tsx — shell: tab state, polling, key handling, layout.
// Two cadences: a fast 2s poll over LOCAL endpoints, and a slow 30s poll for the
// balance (which calls OpenRouter). Input is guarded by isRawModeSupported so the
// app still renders in a non-TTY (piped) context without crashing.
import React, { useCallback, useEffect, useRef, useState } from "react";
import { Box, Text, useApp, useInput, useStdin } from "ink";
import { TabBar, Header, Footer, StatusBar, CreditAlert } from "./components.js";
import { LiveTab, StatsTab } from "./tabs.js";
import { BrowseTab } from "./browse.js";
import { ChainsTab } from "./chains.js";
import { ReviewTab } from "./review.js";
import { ServersTab } from "./serverstab.js";
import { SettingsTab } from "./settings.js";
import { ChatTab } from "./chat.js";
import { fetchDashboard, fetchBalance, getBase, setBase, type Dashboard, type Balance } from "./api.js";
import { killAllManaged, restoreSession, launchWatcher } from "./servers.js";
import { loadHermesCapture } from "./config.js";
import { theme } from "./theme.js";
import { useTermSize } from "./hooks.js";

const TABS = ["Live", "Browse", "Chains", "Review", "Servers", "Stats", "Settings", "Chat"];
const BROWSE = 1; // Browse owns arrows/j/k/enter while focused
const CHAINS = 2;
const REVIEW = 3;
const SERVERS = 4;
const STATS = 5;
const SETTINGS = 6;
const CHAT = 7;
const VERSION = "0.2.0";
const FAST_MS = 2000;
const SLOW_MS = 30000;

export function App() {
  const { exit } = useApp();
  const { isRawModeSupported } = useStdin();
  const { rows } = useTermSize();
  const [dash, setDash] = useState<Dashboard | null>(null);
  const [balance, setBalance] = useState<Balance>({ remaining: null, available: false });
  const [active, setActive] = useState(0);
  const [auto, setAuto] = useState(true);
  // Restore the last server+db BEFORE the first poll so we land on the right one (a
  // restart reconnects if it's up, else relaunches the managed server on the same
  // port+db). Polling waits on this so the first frame isn't aimed at the default base.
  const [booting, setBooting] = useState(true);

  // Just flip the tab. The old hack wrote `\x1b[2J\x1b[H` here to scrub a stale
  // panel-title line, but that homed the cursor while ink still believed it was at
  // the frame's end — desyncing ink's line accounting and contributing to the
  // duplicate-frame bug. With the height-pinned root (constant frame size) + the
  // alternate screen buffer (cli.tsx), ink repaints the fixed frame in place, so no
  // manual clear is needed or wanted.
  const switchTab = useCallback((next: (a: number) => number) => {
    setActive(next);
  }, []);

  // Browse's filter mode types free text — while it captures, the shell must
  // not act on q/esc/digits. A ref (not state) so the input handler sees the
  // current value without re-subscribing.
  const captureRef = useRef(false);
  const onCapture = useCallback((v: boolean) => {
    captureRef.current = v;
  }, []);

  const refresh = useCallback(async () => {
    setDash(await fetchDashboard());
  }, []);

  // Kill any servers the TUI launched before leaving — never leave a managed
  // child (or a held port) behind. Belt-and-suspenders: also on process exit.
  const doExit = useCallback(() => {
    try { killAllManaged(); } catch { /* */ }
    try { exit(); } catch { /* */ }
    // Force the process down shortly after the soft unmount. ink's exit() only unmounts;
    // pending handles (a managed server's stdout/stderr pipes, scan timers) can keep the
    // loop alive and leave the TUI "stuck" after quit. cli.tsx's process.on("exit") restores
    // the screen. unref so this timer itself never holds the loop open.
    const t = setTimeout(() => process.exit(0), 120);
    if (typeof t.unref === "function") t.unref();
  }, [exit]);
  useEffect(() => {
    const onProcExit = () => killAllManaged();
    // SIGTERM/SIGHUP terminate WITHOUT running 'exit' handlers, so handle them
    // explicitly (a plain `kill` left an orphan server otherwise), then exit.
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
      try { const url = await restoreSession(); if (alive && url) setBase(url); } catch { /* fall back to default base */ }
      // Reconcile Hermes capture: if the user left it enabled, bring the watcher back up with the
      // servers (the watcher self-locates the live server, so order doesn't matter).
      try { if (loadHermesCapture().enabled) launchWatcher(); } catch { /* best-effort */ }
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
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [auto, booting]);

  // Slow poll — balance hits OpenRouter, so keep it gentle. Also waits on boot restore.
  useEffect(() => {
    if (booting) return;
    let alive = true;
    const run = async () => {
      const b = await fetchBalance();
      if (alive) setBalance(b);
    };
    run();
    const id = setInterval(run, SLOW_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [booting]);

  useInput(
    (input, key) => {
      if (key.ctrl && input === "c") {
        doExit();
        return;
      }
      if (captureRef.current) return; // a pane's input mode owns the keyboard
      if (input === "q" || key.escape) {
        doExit();
        return;
      }
      if (key.tab) {
        // Tab = next tab, Shift+Tab = previous (1-7 jump directly). Arrows are
        // NO LONGER tab-switches — each tab owns ←/→ (pane focus) and ↑/↓
        // (navigate the focused pane), the same way in every tab.
        switchTab((a) => (key.shift ? a - 1 + TABS.length : a + 1) % TABS.length);
        return;
      }
      if (input >= "1" && input <= String(TABS.length)) {
        switchTab(() => Number(input) - 1);
        return;
      }
      // r/a collide with panes that own them (Servers rescan/add, Settings refresh) —
      // don't double-fire there.
      if (active !== SERVERS && active !== SETTINGS && input === "r") void refresh();
      if (active !== SERVERS && input === "a") setAuto((v) => !v);
    },
    // Strict boolean: ink's useInput only skips raw mode when isActive === false.
    // isRawModeSupported is `undefined` (not false) for a non-TTY stdin, so coerce.
    { isActive: isRawModeSupported === true }
  );

  // The Servers pane stays usable even when the active connection is down
  // (that's how you'd switch/launch your way back to a live server).
  let body: React.ReactNode;
  if (active === SERVERS) {
    body = (
      <ServersTab
        isActive={isRawModeSupported === true}
        onConnect={() => void refresh()}
        onCapture={onCapture}
      />
    );
  } else if (!dash) {
    body = (
      <Box paddingX={1} paddingY={1}>
        <Text color={theme.dim}>{`connecting to ${getBase()} …`}</Text>
      </Box>
    );
  } else if (!dash.ok) {
    body = (
      <Box flexDirection="column" paddingX={1} paddingY={1}>
        <Text color={theme.danger}>{`${"●"} server unreachable at ${getBase()}`}</Text>
        <Text color={theme.dim}>switch or launch one in the Servers tab [5], or set NODEDEX_TUI_API</Text>
      </Box>
    );
  } else if (active === 0) {
    body = <LiveTab dash={dash} />;
  } else if (active === BROWSE) {
    body = <BrowseTab isActive={isRawModeSupported === true} onCapture={onCapture} />;
  } else if (active === CHAINS) {
    body = <ChainsTab isActive={isRawModeSupported === true} />;
  } else if (active === REVIEW) {
    body = <ReviewTab dash={dash} isActive={isRawModeSupported === true} onCapture={onCapture} />;
  } else if (active === STATS) {
    body = <StatsTab dash={dash} />;
  } else if (active === CHAT) {
    body = <ChatTab dash={dash} isActive={isRawModeSupported === true} onCapture={onCapture} />;
  } else {
    body = <SettingsTab dash={dash} balance={balance} isActive={isRawModeSupported === true} onCapture={onCapture} />;
  }

  return (
    // height-pinned to the terminal so the frame is a CONSTANT size across tabs —
    // ink then repaints in place instead of emitting a taller/shorter frame that
    // scrolls. overflow:hidden clips rather than overflows on a small window.
    // Works with the alternate screen buffer entered in cli.tsx.
    <Box flexDirection="column" paddingX={1} height={rows} overflow="hidden">
      {/* Chrome — flexShrink=0 so a tall tab body can NEVER compress the header
          into itself (the tagline-overlaps-wordmark bug: yoga shrank every flex
          sibling on the content-heavy Live tab, collapsing the logo's rows). */}
      <Box flexDirection="column" flexShrink={0}>
        <Header compact={rows < 30} />
        <TabBar tabs={TABS} active={active} version={VERSION} />
        {dash && dash.ok ? (
          <StatusBar
            up={dash.ok}
            reflect={dash.reflect}
            blocks={dash.session?.total_blocks}
            balance={balance}
            budget={dash.budget}
          />
        ) : null}
        {dash && dash.ok ? <CreditAlert reflect={dash.reflect} /> : null}
      </Box>
      {/* Body absorbs the remaining height and CLIPS its own overflow. */}
      <Box flexDirection="column" flexGrow={1} flexShrink={1} overflow="hidden">
        {body}
      </Box>
      <Box flexShrink={0}>
        <Footer auto={auto} intervalSec={FAST_MS / 1000} base={dash?.base ?? getBase()} />
      </Box>
    </Box>
  );
}
