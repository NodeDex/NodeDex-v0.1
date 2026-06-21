// review.tsx — the Review pane (TUI-V2 §2.3): the queue with ACTIONS.
// The TUI's ONLY write surface, and every write is confirm-gated: the action
// shows exactly what will change and asks y/N (flag-don't-auto-act as UI).
//
// Three queues, one list:
//   ⚑ dup flags (unreviewed pipeline_flags)  → actions: merge A / merge B / keep
//   ⚑ routed-to-you questions                → read-only here (the agent answers
//     from conversation context; the TUI can't know the owner)
//   ⚑ thin / needs-review blocks             → read-only until the server grows
//     a demote endpoint (demote logic lives server-side; not duplicated here)
import React, { useCallback, useEffect, useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import { Panel } from "./components.js";
import { theme, glyph, typeColorOf, typeGlyphOf, trunc } from "./theme.js";
import { useTermSize } from "./hooks.js";
import {
  fetchUnreviewedFlags,
  fetchFlagDetail,
  postFlagReview,
  type Dashboard,
  type PipelineFlagRow,
  type FlagBlockSnapshot,
} from "./api.js";

type Item =
  | { kind: "dup"; flag: PipelineFlagRow }
  | { kind: "routed"; id: string; question: string; reason?: string }
  | { kind: "thin"; id: string; label: string; type: string; essence: string; reason?: string };

interface Confirm {
  lines: string[];
  run: () => Promise<void>;
}

function valueOf(snap: FlagBlockSnapshot | null): string {
  if (!snap) return "";
  try {
    const u = JSON.parse(snap.content)?.unique ?? {};
    const first = Object.values(u).find((v) => typeof v === "string" && v.trim());
    return (first as string) ?? "";
  } catch {
    return "";
  }
}

export function ReviewTab({
  dash,
  isActive,
  onCapture,
}: {
  dash: Dashboard;
  isActive: boolean;
  onCapture: (v: boolean) => void;
}) {
  const { columns, rows } = useTermSize();
  const [flags, setFlags] = useState<PipelineFlagRow[] | null>(null);
  const [idx, setIdx] = useState(0);
  const [detail, setDetail] = useState<{ a: FlagBlockSnapshot | null; b: FlagBlockSnapshot | null } | null>(null);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [notice, setNotice] = useState<string>("");
  const seq = useRef(0);

  const reload = useCallback(() => {
    void fetchUnreviewedFlags().then(setFlags);
  }, []);
  useEffect(reload, [reload]);

  const items: Item[] = [
    ...(flags ?? []).map((f): Item => ({ kind: "dup", flag: f })),
    ...dash.agentFlags.map((f): Item => ({ kind: "routed", id: f.id, question: f.question, reason: f.routed_reason })),
    ...dash.reviewQueue.map(
      (b): Item => ({ kind: "thin", id: b.id, label: b.label, type: b.type, essence: b.essence, reason: b.review_reason })
    ),
  ];
  const sel = items[Math.min(idx, Math.max(0, items.length - 1))];

  // dup detail (both blocks embedded) follows the highlight
  useEffect(() => {
    if (!sel || sel.kind !== "dup") { setDetail(null); return; }
    const s = ++seq.current;
    fetchFlagDetail(sel.flag.id).then((d) => {
      if (s === seq.current) setDetail(d ? { a: d.block_a, b: d.block_b } : null);
    });
  }, [sel?.kind === "dup" ? sel.flag.id : null]);

  // a pending confirm owns the keyboard (y/N must not leak to the shell)
  useEffect(() => { onCapture(confirm !== null); }, [confirm, onCapture]);

  const askMerge = (winner: "a" | "b") => {
    if (!sel || sel.kind !== "dup" || !detail) return;
    const win = winner === "a" ? detail.a : detail.b;
    const lose = winner === "a" ? detail.b : detail.a;
    if (!win || !lose) { setNotice("single-block flag — nothing to merge"); return; }
    setConfirm({
      lines: [
        `MERGE — keep:    ${trunc(win.label, columns - 30)}`,
        `        archive: ${trunc(lose.label, columns - 30)} (+ wire superseded_by)`,
        `        flag ${sel.flag.id} marked merge`,
      ],
      run: async () => {
        const r = await postFlagReview(sel.flag.id, {
          verdict: "merge",
          reason: "operator confirmed duplicate in TUI review pane",
          execute: true,
          winning_block_id: win.id,
        });
        setNotice(r?.ok ? `merged — ${lose.label} archived` : `failed: ${r?.error ?? "no response"}`);
        reload();
      },
    });
  };

  const askKeep = () => {
    if (!sel || sel.kind !== "dup") return;
    setConfirm({
      lines: [
        `KEEP BOTH — flag ${sel.flag.id} marked leave; no blocks change`,
      ],
      run: async () => {
        const r = await postFlagReview(sel.flag.id, {
          verdict: "leave",
          reason: "operator judged not-a-duplicate in TUI review pane",
        });
        setNotice(r?.ok ? "kept both — flag closed" : `failed: ${r?.error ?? "no response"}`);
        reload();
      },
    });
  };

  useInput(
    (input, key) => {
      if (confirm) {
        if (input === "y" || input === "Y") {
          const c = confirm;
          setConfirm(null);
          setNotice("applying…");
          void c.run();
        } else if (input === "n" || input === "N" || key.escape || key.return) {
          setConfirm(null);
          setNotice("cancelled");
        }
        return;
      }
      const last = Math.max(0, items.length - 1);
      if (input === "j" || key.downArrow) { setIdx((i) => Math.min(i + 1, last)); setNotice(""); return; }
      if (input === "k" || key.upArrow) { setIdx((i) => Math.max(0, i - 1)); setNotice(""); return; }
      if (input === "g") { setIdx(0); return; }
      if (input === "G") { setIdx(last); return; }
      if (input === "m") { askMerge("a"); return; }
      if (input === "b") { askMerge("b"); return; }
      if (input === "K") { askKeep(); return; }
    },
    { isActive }
  );

  const listH = Math.max(5, Math.floor((rows - (rows < 30 ? 12 : 20)) / 2));
  const off = Math.max(0, Math.min(idx - Math.floor(listH / 2), Math.max(0, items.length - listH)));

  const rowOf = (it: Item, i: number) => {
    const isSel = off + i === idx;
    const mark = isSel ? "▸" : " ";
    let tag = "";
    let text = "";
    if (it.kind === "dup") {
      tag = it.flag.flag_type;
      // show WHAT the blocks are (type_concept), not raw IDs. The detector already
      // carries the labels in criteria; strip the shared project prefix for room.
      const c = it.flag.criteria;
      const shortLbl = (lbl?: string | null, id?: string | null) =>
        (lbl ? lbl.replace(/^[^_]+_/, "") : "") || id || "—";
      text = `${shortLbl(c?.label_a, it.flag.block_id_a)} ≈ ${shortLbl(c?.label_b, it.flag.block_id_b)}`;
    } else if (it.kind === "routed") {
      tag = "routed-to-you";
      text = it.question;
    } else {
      tag = it.reason || "needs_review";
      text = it.essence || it.label;
    }
    return (
      <Box key={`${it.kind}-${i}`}>
        <Text color={isSel ? theme.accent : theme.accent}>{`${glyph.flag} `}</Text>
        <Text color={theme.label}>{`${trunc(tag, 16).padEnd(17)}`}</Text>
        <Text bold={isSel} color={isSel ? theme.accent : undefined} wrap="truncate-end">
          {`${mark}${trunc(text, columns - 32)}`}
        </Text>
      </Box>
    );
  };

  // detail panel for the selection
  let detailBody: React.ReactNode = <Text color={theme.dim}>nothing selected</Text>;
  if (sel?.kind === "dup") {
    detailBody = !detail ? (
      <Text color={theme.dim}>loading…</Text>
    ) : (
      <Box flexDirection="column">
        <Text>
          <Text color={theme.label}>A: </Text>
          <Text>{trunc(detail.a?.label ?? "(gone)", columns - 20)}</Text>
        </Text>
        <Text color={theme.dim}>{`   "${trunc(valueOf(detail.a) || detail.a?.essence || "", columns - 20)}"`}</Text>
        <Text>
          <Text color={theme.label}>B: </Text>
          <Text>{trunc(detail.b?.label ?? "(none)", columns - 20)}</Text>
        </Text>
        <Text color={theme.dim}>{`   "${trunc(valueOf(detail.b) || detail.b?.essence || "", columns - 20)}"`}</Text>
        {sel.flag.review_reason ? (
          <Text color={theme.dim}>{`   detector says: ${trunc(sel.flag.review_reason, columns - 24)}`}</Text>
        ) : null}
        <Box marginTop={1}>
          <Text>
            <Text color={theme.accent}>[m]</Text>
            <Text color={theme.dim}>erge keep A   </Text>
            <Text color={theme.accent}>[b]</Text>
            <Text color={theme.dim}> merge keep B   </Text>
            <Text color={theme.accent}>[K]</Text>
            <Text color={theme.dim}>eep both</Text>
          </Text>
        </Box>
      </Box>
    );
  } else if (sel?.kind === "routed") {
    detailBody = (
      <Box flexDirection="column">
        <Text wrap="wrap">{sel.question}</Text>
        {sel.reason ? <Text color={theme.dim}>{`reason: ${trunc(sel.reason, columns - 16)}`}</Text> : null}
        <Text color={theme.dim}>answered by the agent from conversation context — not actionable here</Text>
      </Box>
    );
  } else if (sel?.kind === "thin") {
    detailBody = (
      <Box flexDirection="column">
        <Text>
          <Text color={typeColorOf(sel.type)}>{`${typeGlyphOf(sel.type)} ${sel.type}  `}</Text>
          <Text wrap="truncate-end">{trunc(sel.label, columns - 24)}</Text>
        </Text>
        <Text wrap="wrap">{sel.essence}</Text>
        {sel.reason ? <Text color={theme.dim}>{`flagged: ${trunc(sel.reason, columns - 16)}`}</Text> : null}
        <Text color={theme.dim}>read-only — block actions (accept-demote) need a server endpoint first</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Panel title={`review queue (${items.length})${items.length > listH ? ` ${idx + 1}/${items.length}` : ""}`} hot={items.length > 0} minHeight={listH + 2}>
        {flags === null ? (
          <Text color={theme.dim}>loading…</Text>
        ) : items.length === 0 ? (
          <Text color={theme.ok}>{`${glyph.okMark} queue empty — nothing needs review`}</Text>
        ) : (
          items.slice(off, off + listH).map(rowOf)
        )}
      </Panel>
      <Panel title="selected" minHeight={7}>
        {detailBody}
      </Panel>
      {confirm ? (
        <Box flexDirection="column" borderStyle="round" borderColor={theme.warn} paddingX={1}>
          {confirm.lines.map((l, i) => (
            <Text key={i} color={theme.warn}>{l}</Text>
          ))}
          <Text>
            <Text color={theme.warn}>confirm: </Text>
            <Text color={theme.accent}>y</Text>
            <Text color={theme.dim}>/N</Text>
          </Text>
        </Box>
      ) : (
        <Text color={theme.dim}>
          {notice
            ? ` ${notice}`
            : sel?.kind === "dup"
              ? " [j/k] queue  [m/b] merge keep A/B  [K] keep both  — every write asks y/N first"
              : " [j/k] queue  — read-only: the pipeline manages these, no operator merge/keep"}
        </Text>
      )}
    </Box>
  );
}
