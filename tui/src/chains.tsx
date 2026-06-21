// chains.tsx — the Chains story reader (TUI-V2 §2.2): a chain's members in
// causal order with the linking relation rendered between rows — the arc as a
// readable story, ending on the chain's committed conclusion.
// Read-only; chain list loads on mount, the story follows the highlight.
import React, { useEffect, useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import { Panel } from "./components.js";
import { theme, typeColorOf, typeGlyphOf, trunc } from "./theme.js";
import { useTermSize } from "./hooks.js";
import {
  fetchChains,
  fetchChainMembers,
  fetchBlockDetail,
  type BlockRow,
  type ChainMember,
} from "./api.js";

// chain rows carry arc/conclusion inside the content JSON (string in list API)
function chainMeta(b: BlockRow & { content?: unknown }): { arc: string; conclusion: string } {
  try {
    const c = typeof (b as any).content === "string" ? JSON.parse((b as any).content) : (b as any).content;
    return { arc: c?.unique?.arc ?? "", conclusion: c?.unique?.conclusion ?? "" };
  } catch {
    return { arc: "", conclusion: "" };
  }
}

// the relation joining two consecutive members, read from the earlier member's
// edges (↓ a→b, ↑ b→a); "·" when the order is associative rather than wired
interface Joint {
  glyph: "↓" | "↑" | "·";
  type: string;
}

async function resolveJoints(members: ChainMember[]): Promise<Joint[]> {
  const details = await Promise.all(members.map((m) => fetchBlockDetail(m.id)));
  const joints: Joint[] = [];
  for (let i = 0; i < members.length - 1; i++) {
    const a = details[i];
    const next = members[i + 1];
    const down = a?.outgoing?.find((e) => e.target_id === next.id || e.target_label === next.label);
    const up = a?.incoming?.find((e) => e.source_id === next.id || e.source_label === next.label);
    joints.push(down ? { glyph: "↓", type: down.type } : up ? { glyph: "↑", type: up.type } : { glyph: "·", type: "" });
  }
  return joints;
}

export function ChainsTab({ isActive }: { isActive: boolean }) {
  const { columns, rows } = useTermSize();
  const [chains, setChains] = useState<BlockRow[] | null>(null);
  const [idx, setIdx] = useState(0);
  const [members, setMembers] = useState<ChainMember[] | null>(null);
  const [joints, setJoints] = useState<Joint[]>([]);
  const [storyOff, setStoryOff] = useState(0);
  const [focus, setFocus] = useState<"list" | "story">("list");
  const seq = useRef(0);

  useEffect(() => {
    let alive = true;
    fetchChains().then((c) => { if (alive) setChains(c); });
    return () => { alive = false; };
  }, []);

  const sel = chains?.[Math.min(idx, Math.max(0, (chains?.length ?? 1) - 1))];

  // story follows the highlighted chain
  useEffect(() => {
    if (!sel) { setMembers(null); setJoints([]); return; }
    const s = ++seq.current;
    setMembers(null);
    setStoryOff(0);
    fetchChainMembers(sel.id).then(async (m) => {
      if (s !== seq.current) return;
      setMembers(m);
      const j = await resolveJoints(m);
      if (s === seq.current) setJoints(j);
    });
  }, [sel?.id]);

  // ~2 lines per wrapped member; how many fit the story panel before it overflows.
  const visibleMembers = Math.max(2, Math.floor(Math.max(6, rows - (rows < 30 ? 10 : 18)) / 2));
  const maxStoryOff = Math.max(0, (members?.length ?? 0) - visibleMembers);

  useInput(
    (input, key) => {
      const last = Math.max(0, (chains?.length ?? 1) - 1);
      // ←/→ (h/l) move FOCUS between the chain list and the story pane; ↑/↓ (j/k)
      // navigate whichever pane is focused (the highlighted one).
      if (input === "h" || key.leftArrow) { setFocus("list"); return; }
      if (input === "l" || key.rightArrow) { setFocus("story"); return; }
      const down = input === "j" || key.downArrow;
      const up = input === "k" || key.upArrow;
      if (focus === "story") {
        if (down) setStoryOff((o) => Math.min(o + 1, maxStoryOff));
        else if (up) setStoryOff((o) => Math.max(0, o - 1));
        else if (input === "g") setStoryOff(0);
        else if (input === "G") setStoryOff(maxStoryOff);
      } else {
        if (down) setIdx((i) => Math.min(i + 1, last));
        else if (up) setIdx((i) => Math.max(0, i - 1));
        else if (input === "g") setIdx(0);
        else if (input === "G") setIdx(last);
      }
    },
    { isActive }
  );

  const listW = Math.max(30, Math.floor(columns * 0.34));
  const storyW = Math.max(34, columns - listW - 4);
  const listH = Math.max(6, rows - (rows < 30 ? 10 : 18));

  const meta = sel ? chainMeta(sel) : { arc: "", conclusion: "" };

  return (
    <Box flexDirection="column">
      <Box flexDirection="row">
        <Panel title={`chains${(chains?.length ?? 0) > listH ? ` ${idx + 1}/${chains!.length}` : ""}`} width={listW} minHeight={listH + 2} hot={focus === "list"}>
          {chains === null ? (
            <Text color={theme.dim}>loading…</Text>
          ) : chains.length === 0 ? (
            <Text color={theme.dim}>no chains yet — when causally linked blocks reach a conclusion, the story lands here</Text>
          ) : (
            chains.slice(Math.max(0, Math.min(idx - Math.floor(listH / 2), chains.length - listH)), Math.max(0, Math.min(idx - Math.floor(listH / 2), chains.length - listH)) + listH).map((c, i) => {
              const off = Math.max(0, Math.min(idx - Math.floor(listH / 2), chains.length - listH));
              const isSel = off + i === idx;
              // chain labels are "{project}_{concept}" — the concept is the
              // distinct part, so it leads; the project recedes behind it
              const us = c.label.indexOf("_");
              const concept = us > 0 ? c.label.slice(us + 1) : c.label;
              const proj = us > 0 ? c.label.slice(0, us) : "";
              // project suffix only when the column is wide enough to fit it
              const showProj = proj !== "" && listW >= 44;
              return (
                <Box key={c.id}>
                  <Text color={typeColorOf("chain")}>{`${typeGlyphOf("chain")} `}</Text>
                  <Text bold={isSel} color={isSel ? theme.accent : undefined} wrap="truncate-end">
                    {`${isSel ? "▸" : " "}${trunc(concept, listW - (showProj ? 25 : 10))}`}
                  </Text>
                  {showProj ? <Text color={theme.dim}>{` · ${trunc(proj, 12)}`}</Text> : null}
                </Box>
              );
            })
          )}
        </Panel>
        <Panel title={sel ? `story: ${trunc(sel.label, storyW - 14)}` : "story"} width={storyW} minHeight={listH + 2} hot={focus === "story"}>
          {!sel ? (
            <Text color={theme.dim}>select a chain</Text>
          ) : members === null ? (
            <Text color={theme.dim}>loading…</Text>
          ) : members.length === 0 ? (
            <Text color={theme.dim}>chain has no member blocks</Text>
          ) : (
            <Box flexDirection="column">
              {meta.arc ? <Text color={theme.dim} wrap="wrap">{`arc: ${meta.arc}`}</Text> : null}
              {storyOff > 0 ? <Text color={theme.dim}>{`  ▲ ${storyOff} more above`}</Text> : null}
              {members.slice(storyOff, storyOff + visibleMembers).map((m, i) => {
                const gi = storyOff + i; // global index into members/joints
                return (
                  <Box key={m.id} flexDirection="column">
                    <Box>
                      <Text color={typeColorOf(m.type)}>{`${typeGlyphOf(m.type)} ${m.type.padEnd(10)} `}</Text>
                      <Text wrap="wrap">{m.essence}</Text>
                    </Box>
                    {gi < members.length - 1 ? (
                      <Text color={theme.dim}>
                        {`   ${joints[gi]?.glyph ?? "·"}${joints[gi]?.type ? ` ${joints[gi].type}` : ""}`}
                      </Text>
                    ) : null}
                  </Box>
                );
              })}
              {storyOff + visibleMembers < members.length ? (
                <Text color={theme.dim}>{`  ▼ ${members.length - (storyOff + visibleMembers)} more below`}</Text>
              ) : null}
              {meta.conclusion && storyOff + visibleMembers >= members.length ? (
                <Box marginTop={1}>
                  <Text color={theme.ok} wrap="wrap">{`── conclusion: ${meta.conclusion} ──`}</Text>
                </Box>
              ) : null}
            </Box>
          )}
        </Panel>
      </Box>
      <Text color={theme.dim}>{` [←/→] focus → ${focus === "list" ? "‹list›" : "‹story›"}   [↑/↓ j/k] navigate the focused pane   [Tab] tabs`}</Text>
    </Box>
  );
}
