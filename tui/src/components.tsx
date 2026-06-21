// components.tsx — the chrome: gradient wordmark, tab bar, titled panels, footer.
import React from "react";
import { Box, Text } from "ink";
import Gradient from "ink-gradient";
import { theme, glyph } from "./theme.js";
import type { BudgetVerdict } from "./api.js";

const WORDMARK = [
  " ███╗   ██╗ ██████╗ ██████╗ ███████╗██████╗ ███████╗██╗  ██╗",
  " ████╗  ██║██╔═══██╗██╔══██╗██╔════╝██╔══██╗██╔════╝╚██╗██╔╝",
  " ██╔██╗ ██║██║   ██║██║  ██║█████╗  ██║  ██║█████╗   ╚███╔╝ ",
  " ██║╚██╗██║██║   ██║██║  ██║██╔══╝  ██║  ██║██╔══╝   ██╔██╗ ",
  " ██║ ╚████║╚██████╔╝██████╔╝███████╗██████╔╝███████╗██╔╝ ██╗",
  " ╚═╝  ╚═══╝ ╚═════╝ ╚═════╝ ╚══════╝╚═════╝ ╚══════╝╚═╝  ╚═╝",
].join("\n");

const TAGLINE = "the memory your agent lives in";

// Cool palette for the wordmark: teal→sky→indigo. One place to retune the brand
// color. (The node-graph mark is deferred — to be added back later.)
const MARK_COLORS = ["#5eead4", "#38bdf8", "#818cf8"];

// The logo: wordmark + tagline. Reused by the Header (static) and the onboarding
// intro (static — no animation).
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

// The full logo eats ~14 rows; below 30 terminal rows it would push panels
// off-screen (and trigger ink repaint artifacts), so it collapses to one line.
export function Header({ compact }: { compact?: boolean }) {
  if (compact) {
    return (
      <Box paddingX={1}>
        <Gradient colors={MARK_COLORS}>
          <Text bold>NODEDEX</Text>
        </Gradient>
        <Text color={theme.dim} italic>
          {`  · ${TAGLINE}`}
        </Text>
      </Box>
    );
  }
  return (
    <Box flexDirection="column" alignItems="center" marginTop={1} marginBottom={1}>
      <Logo />
    </Box>
  );
}

export function TabBar({ tabs, active, version }: { tabs: string[]; active: number; version: string }) {
  return (
    <Box justifyContent="space-between" paddingX={1}>
      <Box>
        {tabs.map((t, i) => (
          <Box key={t} marginRight={2}>
            <Text bold={i === active} underline={i === active} color={i === active ? theme.accent : theme.dim}>
              {`${i + 1} ${t}`}
            </Text>
          </Box>
        ))}
      </Box>
      <Text color={theme.dim}>{`nodedex tui · v${version}`}</Text>
    </Box>
  );
}

// Titled rounded panel — the title sits on the top border (binsider legend look).
export function Panel({
  title,
  children,
  hot,
  width,
  flexGrow,
  minHeight,
}: {
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

// StatusBar — THE single source for connection / reflect / blocks / balance.
// One line, every tab (k9s-style context bar). Panels must NOT repeat these:
// the same number in two places was v1's layout bug (caught by the user
// 2026-06-12) — each value renders in exactly one home.
// The cost-breaker state, rendered next to the balance it guards (one home per
// value). Off when no budget is configured; armed/TRIPPED otherwise — so a
// breaker-paused reflect is never mysterious.
function BreakerState({ budget }: { budget: BudgetVerdict | null }) {
  if (!budget) return <Text color={theme.dim}>—</Text>;
  const { config, tripped } = budget;
  const configured = config.minCreditUsd !== null || config.dailyBudgetUsd !== null;
  if (!configured) return <Text color={theme.dim}>off</Text>;
  if (tripped) return <Text color={theme.danger}>{`${glyph.warn} TRIPPED`}</Text>;
  const limits = [
    config.minCreditUsd !== null ? `$${config.minCreditUsd} floor` : null,
    config.dailyBudgetUsd !== null ? `$${config.dailyBudgetUsd}/24h` : null,
  ].filter(Boolean).join(" · ");
  return (
    <>
      <Text color={theme.ok}>{`${glyph.okMark} armed`}</Text>
      <Text color={theme.dim}>{` ${limits}`}</Text>
    </>
  );
}

// StatusBar — THE single source for connection / reflect / blocks / balance /
// breaker. One line, every tab (k9s-style context bar). Panels must NOT repeat
// these: the same number in two places was v1's layout bug (caught by the user
// 2026-06-12) — each value renders in exactly one home.
export function StatusBar({
  up,
  reflect,
  blocks,
  balance,
  budget,
}: {
  up: boolean;
  reflect: { paused: boolean; spend_paused?: boolean; queue_depth: number; processing: boolean } | null;
  blocks: number | undefined;
  balance: { remaining: number | null; available: boolean };
  budget: BudgetVerdict | null;
}) {
  // When the breaker tripped reflect, say so on the reflect segment too.
  const breakerPausedReflect = reflect?.paused && budget?.tripped;
  // Spending paused (credit-out / cost-breaker) while capture keeps queuing — a
  // DISTINCT state from a full reflect pause (which also stops capture).
  const spendPaused = reflect?.spend_paused && !reflect?.paused;
  return (
    <Box paddingX={1} marginBottom={1}>
      <Text color={up ? theme.ok : theme.danger}>{`${glyph.up} ${up ? "up" : "down"}`}</Text>
      <Text color={theme.dim}>{"  │  "}</Text>
      {reflect ? (
        <>
          <Text color={reflect.paused || spendPaused ? theme.warn : theme.ok}>
            {reflect.paused
              ? `${glyph.paused} reflect paused${breakerPausedReflect ? " (breaker)" : ""}`
              : spendPaused
                ? `${glyph.paused} spending paused (credit)`
                : "reflect running"}
          </Text>
          <Text color={theme.dim}>{`  queue ${reflect.queue_depth}${reflect.processing ? " · processing" : ""}`}</Text>
        </>
      ) : (
        <Text color={theme.dim}>reflect unknown</Text>
      )}
      <Text color={theme.dim}>{"  │  "}</Text>
      <Text color={theme.label}>blocks </Text>
      <Text>{blocks === undefined ? "—" : String(blocks)}</Text>
      <Text color={theme.dim}>{"  │  "}</Text>
      <Text color={theme.label}>balance </Text>
      <Text color={balance.available ? theme.value : theme.dim}>
        {balance.available && balance.remaining !== null ? `$${balance.remaining.toFixed(2)}` : "n/a"}
      </Text>
      <Text color={theme.dim}>{"  │  "}</Text>
      <Text color={theme.label}>breaker </Text>
      <BreakerState budget={budget} />
    </Box>
  );
}

// CreditAlert — a prominent, can't-miss banner when SPENDING is paused because the
// account is out of credit (the StatusBar segment is intentionally subtle; this is the
// loud one the user asked for). Renders NOTHING in the normal case, so it costs no rows
// until it matters. Capture keeps queuing, so the message is reassuring, not alarming:
// nothing is lost, it just resumes on top-up.
export function CreditAlert({ reflect }: { reflect: { paused: boolean; spend_paused?: boolean; spend_pause_reason?: string | null; queue_depth: number } | null }) {
  if (!reflect?.spend_paused || reflect.paused) return null;
  const reason = reflect.spend_pause_reason || "credit exhausted";
  return (
    <Box paddingX={1} marginBottom={1} borderStyle="round" borderColor={theme.danger} flexDirection="column">
      <Text color={theme.danger}>{`${glyph.warn} CREDIT EXHAUSTED — extraction PAUSED (${reason}).`}</Text>
      <Text color={theme.warn}>{`Turns keep queuing (${reflect.queue_depth} waiting) — nothing is lost. Top up your OpenRouter credit; extraction resumes automatically.`}</Text>
    </Box>
  );
}

// One key-hint, e.g. [Tab→view]
function Key({ k, label }: { k: string; label: string }) {
  return (
    <Box marginRight={2}>
      <Text color={theme.accent}>{`[${k}`}</Text>
      <Text color={theme.dim}>{`→${label}]`}</Text>
    </Box>
  );
}

export function Footer({
  auto,
  intervalSec,
  base,
}: {
  auto: boolean;
  intervalSec: number;
  base: string;
}) {
  return (
    <Box justifyContent="space-between" paddingX={1}>
      <Box>
        <Key k="Tab" label="view" />
        <Key k="r" label="refresh" />
        <Key k="a" label="auto" />
        <Key k="q" label="quit" />
      </Box>
      <Text color={theme.dim}>
        {base}
        {"   "}
        {auto ? `${glyph.tick} ${intervalSec}s` : "auto off"}
      </Text>
    </Box>
  );
}

// Small two-column field row used inside panels.
export function Field({ label, children, width = 9 }: { label: string; children: React.ReactNode; width?: number }) {
  return (
    <Box>
      <Box width={width}>
        <Text color={theme.label}>{label}</Text>
      </Box>
      <Text>{children as any}</Text>
    </Box>
  );
}
