// feed.tsx — memory FORMING, live. The pulse view: what the pipeline is doing
// right now, the newest blocks as they're born (typed, colored, chained), and
// what the agent recently pulled back out. Replaces v2's Live + Stats overlap.
import React, { useEffect, useState } from "react";
import { Box, Text, useInput } from "ink";
import { Section, Row, Keys, Panel, windowSlice } from "./components.js";
import { theme, glyph, typeColorOf, typeGlyphOf, trunc, relTime } from "./theme.js";
import { useTermSize } from "./hooks.js";
import { fetchBlockDetail, type Dashboard, type BlockDetail } from "./api.js";

export function FeedTab({ dash, isActive }: { dash: Dashboard; isActive: boolean }) {
  const { rows: termRows, columns: cols } = useTermSize();
  const recent = dash.session?.recent_blocks ?? [];
  const reads = dash.reads ?? [];
  const r = dash.reflect;
  const last = dash.session?.last_reflect;
  const cap = Math.max(5, termRows - 16);

  const [sel, setSel] = useState(0);
  const [peek, setPeek] = useState<BlockDetail | null>(null);

  useEffect(() => { if (sel >= recent.length) setSel(Math.max(0, recent.length - 1)); }, [recent.length, sel]);

  useInput((_input, k) => {
    if (peek) { if (k.escape || k.return) setPeek(null); return; }
    if (k.upArrow) setSel((s) => Math.max(0, s - 1));
    else if (k.downArrow) setSel((s) => Math.min(recent.length - 1, s + 1));
    else if (k.return && recent[sel]) void fetchBlockDetail(recent[sel]!.id).then(setPeek);
  }, { isActive });

  const pulse = r?.processing || (r?.queue_depth ?? 0) > 0
    ? { color: theme.accent, text: `${glyph.tick} extracting…  ${r!.queue_depth} turn${r!.queue_depth === 1 ? "" : "s"} queued` }
    : r?.paused
      ? { color: theme.warn, text: `${glyph.paused} capture paused` }
      : r?.spend_paused
        ? { color: theme.warn, text: `${glyph.paused} spending paused (credit) — turns still queuing` }
        : last
          ? { color: theme.dim, text: `${glyph.okMark} last extraction ${last.timestamp ? relTime(last.timestamp) + " ago" : ""} · +${last.blocks_created} block${last.blocks_created === 1 ? "" : "s"}${last.blocks_updated ? ` · ${last.blocks_updated} updated` : ""}` }
          : { color: theme.dim, text: "idle — waiting for captured turns" };

  return (
    <Box flexDirection="column" flexGrow={1}>
      <Box marginBottom={1}>
        <Text color={pulse.color}>{pulse.text}</Text>
      </Box>

      <Section title="memory forming" right={<Text color={theme.dim}>newest first</Text>}>
        {recent.length === 0 ? (
          <Text color={theme.dim}>nothing yet — once capture is on, new memory streams here</Text>
        ) : (() => {
          const win = windowSlice(recent, sel, cap);
          return (
            <>
              {win.above > 0 ? <Text color={theme.dim}>{`  ↑ ${win.above} more`}</Text> : null}
              {win.visible.map((b, i) => {
                const idx = win.start + i;
                return (
                  <Row key={b.id} selected={idx === sel}>
                    <Box width={5}><Text color={theme.dim}>{relTime(b.created_at)}</Text></Box>
                    <Text color={typeColorOf(b.type)}>{`${typeGlyphOf(b.type)} `}</Text>
                    <Box width={Math.min(44, Math.floor(cols * 0.4))}>
                      <Text color={idx === sel ? theme.value : theme.label}>{trunc(b.label, Math.min(43, Math.floor(cols * 0.4) - 1))}</Text>
                    </Box>
                    <Text color={theme.dim}>{trunc(b.essence, Math.max(10, cols - 62))}</Text>
                  </Row>
                );
              })}
              {win.below > 0 ? <Text color={theme.dim}>{`  ↓ ${win.below} more`}</Text> : null}
            </>
          );
        })()}
      </Section>

      {reads.length > 0 ? (
        <Section title="agent reads" right={<Text color={theme.dim}>what memory got used</Text>}>
          {reads.slice(0, 3).map((ev) => (
            <Box key={ev.id}>
              <Box width={5}><Text color={theme.dim}>{relTime(ev.timestamp)}</Text></Box>
              <Text color={theme.dim}>{`${glyph.read} "${trunc(ev.query, 36)}" → `}</Text>
              <Text color={theme.label}>{ev.recalled.slice(0, 3).map((x) => x.label).join(" · ") || `${ev.total_injected} injected`}</Text>
            </Box>
          ))}
        </Section>
      ) : null}

      <Box flexGrow={1} />
      {peek ? (
        <Panel title={peek.label} hot>
          <Box>
            <Text color={typeColorOf(peek.type)}>{`${typeGlyphOf(peek.type)} ${peek.type}`}</Text>
            {(peek.incoming ?? []).some((e) => e.type === "superseded_by") ? <Text color={theme.warn}>{"  ⚠ superseded"}</Text> : null}
          </Box>
          <Text color={theme.value} wrap="wrap">{peek.essence}</Text>
          <Text color={theme.dim}>full story: view 1 (memory) → its root, or search it with /</Text>
        </Panel>
      ) : (
        <Keys items={[["↑↓", "move"], ["enter", "peek"], ["1", "open in memory"]]} />
      )}
    </Box>
  );
}
