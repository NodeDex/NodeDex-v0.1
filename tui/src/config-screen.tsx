// config-screen.tsx — the STANDALONE `nodedex config` page.
//
// Deliberately NOT the App shell: no memory/feed tabs, no mission-control status line —
// just the keyring, so `nodedex config` is its own focused page and does not look like
// (or turn into) `nodedex tui`. The in-tui settings view keeps a "keyring" row that opens
// the SAME KeyringPanel as an overlay, so the manager is reachable from both without the
// config command being a second copy of the dashboard.
import React, { useCallback, useEffect, useState } from "react";
import { Box, Text, useApp, useStdin } from "ink";
import { Brand } from "./components.js";
import { KeyringPanel } from "./keyring.js";
import { theme } from "./theme.js";
import { useTermSize } from "./hooks.js";
import { setBase } from "./api.js";
import { discover } from "./servers.js";
import { loadConfig } from "./config.js";

export function ConfigScreen() {
  const { exit } = useApp();
  const { isRawModeSupported } = useStdin();
  const { rows } = useTermSize();
  const [server, setServer] = useState<string | null>(null);
  const [probed, setProbed] = useState(false);

  // Point live key-swaps at a RUNNING server if one is up — but NEVER launch one just to edit
  // keys (that's the tui's job, and launching from `config` would be surprising). If nothing is
  // up, edits still persist to config.json and take effect on the next launch.
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const up = (await discover()).find((s) => s.up);
        if (alive && up) { setBase(up.url); setServer(up.url); }
      } catch { /* offline is fine — file-only save */ }
      if (alive) setProbed(true);
    })();
    return () => { alive = false; };
  }, []);

  const doExit = useCallback(() => {
    try { exit(); } catch { /* */ }
    // Pending handles (a fetch, a timer) can keep the loop alive after the soft unmount.
    const t = setTimeout(() => process.exit(0), 80);
    if (typeof t.unref === "function") t.unref();
  }, [exit]);

  return (
    <Box flexDirection="column" paddingX={1} height={rows} overflow="hidden">
      <Box flexShrink={0} marginBottom={1}>
        <Brand />
        <Box marginLeft={3}><Text color={theme.accent} bold>config</Text></Box>
        <Box marginLeft={2}>
          <Text color={theme.dim}>
            {!probed ? "· connecting…" : server ? `· live on ${server}` : "· no server up — changes save to config, apply on next launch"}
          </Text>
        </Box>
      </Box>
      <KeyringPanel isActive={isRawModeSupported === true} provider={loadConfig().provider} onClose={doExit} />
    </Box>
  );
}
