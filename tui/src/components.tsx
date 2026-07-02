// components.tsx — the chrome, v3: quiet slate shell, one frost accent.
// Minimal primitives: a one-line Brand, a text ViewBar (no boxes), caps Section
// headers instead of bordered panels, a single bottom StatusLine, and a Keys
// hint. Panel (bordered) survives for the few overlays that want a frame.
import React from "react";
import { Box, Text } from "ink";
import Gradient from "ink-gradient";
import { theme, glyph, fmtNum, fmtMoney } from "./theme.js";
import type { Dashboard, Balance } from "./api.js";

const WORDMARK = [
  " ███╗   ██╗ ██████╗ ██████╗ ███████╗██████╗ ███████╗██╗  ██╗",
  " ████╗  ██║██╔═══██╗██╔══██╗██╔════╝██╔══██╗██╔════╝╚██╗██╔╝",
  " ██╔██╗ ██║██║   ██║██║  ██║█████╗  ██║  ██║█████╗   ╚███╔╝ ",
  " ██║╚██╗██║██║   ██║██║  ██║██╔══╝  ██║  ██║██╔══╝   ██╔██╗ ",
  " ██║ ╚████║╚██████╔╝██████╔╝███████╗██████╔╝███████╗██╔╝ ██╗",
  " ╚═╝  ╚═══╝ ╚═════╝ ╚═════╝ ╚══════╝╚═════╝ ╚══════╝╚═╝  ╚═╝",
].join("\n");

const TAGLINE = "the memory your agent lives in";

// Wordmark gradient — already the cool family (teal→sky→indigo).
const MARK_COLORS = ["#5eead4", "#38bdf8", "#818cf8"];

// Full logo — onboarding's welcome only. The running app uses <Brand/>.
export function Logo() {
  return (
    <Box flexDirection="column" alignItems="center">
      <Gradient colors={MARK_COLORS}>
        <Text>{WORDMARK}</Text>
      </Gradient>
      <Text color={theme.dim} italic>{`◇  ${TAGLINE}  ◇`}</Text>
    </Box>
  );
}

// One-line brand for the app shell: wordmark-as-word, nothing shouting.
export function Brand() {
  return (
    <Box>
      <Gradient colors={MARK_COLORS}>
        <Text bold>{" nodedex"}</Text>
      </Gradient>
    </Box>
  );
}

// The view switcher — plain text, the active view carries the accent.
export function ViewBar({ views, active }: { views: string[]; active: number }) {
  return (
    <Box>
      {views.map((v, i) => (
        <Box key={v} marginRight={1}>
          <Text color={i === active ? theme.accent : theme.dim} bold={i === active}>
            {`${i + 1} ${v}`}
          </Text>
          {i < views.length - 1 ? <Text color={theme.dim}>{"  ·"}</Text> : null}
        </Box>
      ))}
    </Box>
  );
}

// Caps section header — replaces bordered panels for in-flow content.
export function Section({ title, hot, right, children }: {
  title: string; hot?: boolean; right?: React.ReactNode; children?: React.ReactNode;
}) {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box justifyContent="space-between">
        <Text color={hot ? theme.accent : theme.title} bold>{title.toUpperCase()}</Text>
        {right ?? null}
      </Box>
      {children}
    </Box>
  );
}

// A selectable row: focused = accent cursor + bright text; blurred list keeps a
// quiet cursor so pane focus is always legible.
export function Row({ selected, focused = true, children }: {
  selected: boolean; focused?: boolean; children: React.ReactNode;
}) {
  return (
    <Box>
      <Text color={selected ? (focused ? theme.accent : theme.dim) : undefined}>
        {selected ? "▸ " : "  "}
      </Text>
      {children}
    </Box>
  );
}

// Bordered panel — kept for overlays (search, review) that float over a view.
export function Panel({ title, children, hot, width, flexGrow, minHeight }: {
  title: string;
  children: React.ReactNode;
  hot?: boolean;
  width?: number | string;
  flexGrow?: number;
  minHeight?: number;
}) {
  return (
    <Box
      borderStyle="round"
      borderColor={hot ? theme.borderHot : theme.border}
      flexDirection="column"
      paddingX={1}
      width={width}
      flexGrow={flexGrow}
      minHeight={minHeight}
    >
      <Box marginTop={-1}>
        <Text color={theme.title}>{` ${title} `}</Text>
      </Box>
      {children}
    </Box>
  );
}

// The ONE home for connection / graph / pipeline / spend state — bottom line,
// every view. Views must not repeat these numbers (one value, one home).
export function StatusLine({ dash, balance, captureDots }: {
  dash: Dashboard | null;
  balance: Balance;
  captureDots: Array<{ name: string; on: boolean }>;
}) {
  const ok = !!dash?.ok;
  const s = dash?.session;
  const r = dash?.reflect;
  const spend24 = dash?.budget?.observed?.spend24h;
  return (
    <Box justifyContent="space-between">
      <Box>
        <Text color={ok ? theme.ok : theme.danger}>{`${glyph.up} `}</Text>
        <Text color={theme.value}>{s?.db ?? "no server"}</Text>
        <Text color={theme.dim}>{`  ${fmtNum(s?.total_blocks)} blocks`}</Text>
        {r ? (
          <Text color={r.paused || r.spend_paused ? theme.warn : theme.dim}>
            {r.paused ? "  ‖ capture paused" : r.spend_paused ? "  ‖ spend paused" : r.queue_depth > 0 ? `  ⟳ extracting (${r.queue_depth})` : ""}
          </Text>
        ) : null}
      </Box>
      <Box marginLeft={2}>
        {captureDots.map((c) => (
          <Box key={c.name} marginRight={1}>
            <Text color={c.on ? theme.ok : theme.dim}>{glyph.up}</Text>
            <Text color={theme.dim}>{` ${c.name}`}</Text>
          </Box>
        ))}
        {typeof spend24 === "number" ? <Text color={theme.dim}>{` ${fmtMoney(spend24)}/24h`}</Text> : null}
        {balance.available ? <Text color={theme.dim}>{`  bal ${fmtMoney(balance.remaining)}`}</Text> : null}
      </Box>
    </Box>
  );
}

// Bottom-of-view key hints. Quiet; the keycap carries the accent.
export function Keys({ items }: { items: Array<[string, string]> }) {
  return (
    <Box>
      {items.map(([k, label], i) => (
        <Box key={`${k}-${i}`} marginRight={2}>
          <Text color={theme.accent}>{`[${k}]`}</Text>
          <Text color={theme.dim}>{` ${label}`}</Text>
        </Box>
      ))}
    </Box>
  );
}
