// tabs.tsx — the dashboard views (Browse lives in browse.tsx).
//   Live  — operational dashboard (reads · saves · attention)
//   Flags — routed-to-you questions + review queue (act in v2's Review pane)
//   Stats — block counts by type + last reflect
//   Graph — project roots + root relatedness
import React from "react";
import { Box, Text } from "ink";
import { Panel, Field } from "./components.js";
import { theme, glyph, typeColorOf, relTime, fmtNum, fmtMoney, trunc } from "./theme.js";
import { useTermSize } from "./hooks.js";
import type { Dashboard, Balance } from "./api.js";

function Empty({ msg }: { msg: string }) {
  return <Text color={theme.dim}>{msg}</Text>;
}

// Truncation budgets come from the live terminal width (v1 hardcoded 18-44ch
// and wasted half of any wide terminal). `reserved` = chars already spent on
// the row's fixed prefix/suffix (glyphs, timestamps, padded type names) plus
// panel border+padding; `min` keeps narrow terminals readable.
const budget = (columns: number, reserved: number, min = 12): number =>
  Math.max(min, columns - reserved);

// ─── Live ─────────────────────────────────────────────────────────────────────
// (connection / blocks / balance moved to the persistent StatusBar — single
// source per value; v1 repeated them here AND in Stats.)

function ReadsPanel({ dash }: { dash: Dashboard }) {
  const { columns } = useTermSize();
  // half-width panel: 5 time + 2 glyph + ~5 count suffix + ~8 border/padding
  const w = budget(Math.floor(columns / 2), 20);
  return (
    <Panel title="agent reads" width="50%" minHeight={7}>
      {dash.reads.length === 0 ? (
        <Empty msg="no recent reads — reflect is paused" />
      ) : (
        dash.reads.slice(0, 5).map((e) => (
          <Box key={e.id}>
            <Box width={5}>
              <Text color={theme.dim}>{relTime(e.timestamp)}</Text>
            </Box>
            <Text color={theme.accent}>{`${glyph.read} `}</Text>
            <Text>{trunc(e.query, w)}</Text>
            <Text color={theme.dim}>{` (${e.recalled?.length ?? 0})`}</Text>
          </Box>
        ))
      )}
    </Panel>
  );
}

function SavesPanel({ dash }: { dash: Dashboard }) {
  const { columns } = useTermSize();
  // half-width panel: 5 time + 2 save glyph + 13 type column + ~8 border/padding
  const w = budget(Math.floor(columns / 2), 28);
  const saves = dash.session?.recent_blocks ?? [];
  return (
    <Panel title="pipeline saves" width="50%" minHeight={7}>
      {saves.length === 0 ? (
        <Empty msg="no recent saves" />
      ) : (
        saves.slice(0, 5).map((b) => (
          <Box key={b.id}>
            <Box width={5}>
              <Text color={theme.dim}>{relTime(b.created_at)}</Text>
            </Box>
            <Text color={theme.ok}>{`${glyph.save} `}</Text>
            <Text color={typeColorOf(b.type)}>{`${glyph.block} ${b.type.padEnd(10)} `}</Text>
            <Text>{trunc(b.essence || b.label, w)}</Text>
          </Box>
        ))
      )}
    </Panel>
  );
}

// Error terminal — the half-width feed next to the cost panel. Shows the ongoing
// credit-exhaustion state (pinned, since it's a standing condition, not a moment) +
// the recent monitoring alerts (rate-limits, processing lag, queue backup, quality
// drops). This is the "where do I see errors" home on the Live tab.
function ErrorTerminalPanel({ dash }: { dash: Dashboard }) {
  const { columns } = useTermSize();
  const w = budget(Math.floor(columns / 2), 22);
  const spendPaused = !!dash.reflect?.spend_paused;
  const alerts = dash.alerts ?? [];
  const sevColor = (s: string) => (s === "critical" ? theme.danger : theme.warn);
  const empty = !spendPaused && alerts.length === 0;
  return (
    <Panel title="errors / alerts" width="50%" hot={spendPaused} minHeight={7}>
      {empty ? (
        <Text color={theme.ok}>{`${glyph.okMark} no errors`}</Text>
      ) : (
        <>
          {spendPaused && (
            <Text color={theme.danger}>
              {`${glyph.warn} credit exhausted — paused, ${dash.reflect?.queue_depth ?? 0} queuing, resumes on top-up`}
            </Text>
          )}
          {alerts.slice(0, spendPaused ? 4 : 5).map((a) => (
            <Box key={a.id}>
              <Box width={5}><Text color={theme.dim}>{relTime(a.timestamp)}</Text></Box>
              <Text color={sevColor(a.severity)}>{`${glyph.warn} `}</Text>
              <Text>{trunc(a.message, w)}</Text>
            </Box>
          ))}
        </>
      )}
    </Panel>
  );
}

// Per-pass cost of the LAST reflect run — on the MAIN page so "where did the
// money go" needs no tab switch (the StatusBar carries balance + breaker state;
// this carries the breakdown — different values, one home each). Sub-cent costs
// → 4dp (fmtMoney's 2dp is for the dollar-scale totals/balance).
const money4 = (n: number | null | undefined): string => (typeof n === "number" ? `$${n.toFixed(4)}` : "  ?");

function CostPanel({ dash }: { dash: Dashboard }) {
  const pc = dash.passes;
  const passes = pc?.passes ?? [];
  const spend24h = dash.budget?.observed?.spend24h;
  const title = `cost · last run${pc?.turn != null ? ` (turn ${pc.turn})` : ""}`;
  return (
    <Panel title={title} width="50%" minHeight={7}>
      {passes.length === 0 ? (
        <Empty msg={pc?.note ?? "no reflect runs yet — per-pass cost shows after the next run"} />
      ) : (
        <>
          {passes.map((p) => (
            <Box key={p.name}>
              <Box width={12}><Text color={theme.label}>{p.name}</Text></Box>
              <Text color={theme.value}>{money4(p.usd)}</Text>
            </Box>
          ))}
          <Box marginTop={1}>
            <Box width={12}><Text bold color={theme.label}>total</Text></Box>
            <Box width={10}><Text bold color={theme.value}>{money4(pc?.total_usd)}</Text></Box>
            {typeof spend24h === "number" ? (
              <Text color={theme.dim}>{`  ·  24h spend ${fmtMoney(spend24h)}`}</Text>
            ) : null}
          </Box>
        </>
      )}
    </Panel>
  );
}

export function LiveTab({ dash }: { dash: Dashboard }) {
  return (
    <Box flexDirection="column">
      <Box flexDirection="row">
        <ReadsPanel dash={dash} />
        <SavesPanel dash={dash} />
      </Box>
      <Box flexDirection="row">
        <CostPanel dash={dash} />
        <ErrorTerminalPanel dash={dash} />
      </Box>
    </Box>
  );
}

// ─── Stats ──────────────────────────────────────────────────────────────────
export function StatsTab({ dash }: { dash: Dashboard }) {
  const { columns } = useTermSize();
  const byType = dash.session?.by_type ?? {};
  const entries = Object.entries(byType).sort((a, b) => b[1] - a[1]);
  const max = entries.reduce((m, [, n]) => Math.max(m, n), 1);
  const barMax = budget(columns, 28, 10); // 12 type + 6 count columns + ~10 border/padding
  const lr = dash.session?.last_reflect;
  return (
    <Box flexDirection="column">
      <Panel title="blocks by type" minHeight={6}>
        {entries.length === 0 ? (
          <Empty msg="no blocks yet" />
        ) : (
          entries.map(([type, n]) => (
            <Box key={type}>
              <Box width={12}>
                <Text color={typeColorOf(type)}>{type}</Text>
              </Box>
              <Box width={6}>
                <Text>{fmtNum(n)}</Text>
              </Box>
              <Text color={typeColorOf(type)}>{glyph.block.repeat(Math.max(1, Math.round((n / max) * barMax)))}</Text>
            </Box>
          ))
        )}
      </Panel>
      {/* blocks + balance live in the StatusBar (single source) — this panel
          keeps only what's unique to Stats. */}
      <Panel title="last reflect">
        {lr ? (
          <Text>
            {`${relTime(lr.timestamp)} ago · +${lr.blocks_created} created, ${lr.blocks_updated} updated`}
            {lr.turn_name ? ` · ${trunc(lr.turn_name, 24)}` : ""}
          </Text>
        ) : (
          <Text color={theme.dim}>none this session</Text>
        )}
      </Panel>
    </Box>
  );
}

// (FlagsTab retired — the Review pane in review.tsx is the single home for
// flags + review queue, now with confirm-gated actions.)

// (GraphTab retired — the project-roots + relatedness view was dropped from the TUI.)
