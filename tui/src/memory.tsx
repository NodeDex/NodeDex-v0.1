// memory.tsx — THE view. The graph as an explorer: roots on the left, the
// selected block's STORY on the right (essence, unique facts, its chain, its
// edges) — and the edges are walkable: focus the right pane, pick a relation or
// chain member, enter jumps to it. Browse + Chains from v2 merged into one.
//
// Navigation model (same keys everywhere):
//   ←/→ = pane focus · ↑/↓ = move in the focused pane · enter = open/jump
//   esc = up one level (blocks→roots · jump-trail back · close search)
//   /   = search overlay (keyword recall — the same /api/search agents use)
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import { Section, Row, Keys, Panel } from "./components.js";
import { theme, typeColorOf, typeGlyphOf, trunc, relTime } from "./theme.js";
import { useTermSize } from "./hooks.js";
import {
  fetchTree, fetchProjectBlocks, fetchBlockDetail, fetchChainMembers, searchMemory,
  type TreeRoot, type BlockRow, type BlockDetail, type ChainMember, type EdgeRef,
} from "./api.js";

type LeftLevel = "roots" | "blocks";

// A row the right pane can jump to (chain member or relation endpoint).
interface Jumpable { id: string; label: string; kind: "chain" | "out" | "in"; via: string; type?: string }

export function MemoryTab({ isActive, onCapture }: { isActive: boolean; onCapture: (v: boolean) => void }) {
  const { rows: termRows, columns: cols } = useTermSize();
  const listCap = Math.max(6, termRows - 12);

  // ── left pane: roots → blocks ──────────────────────────────────────────────
  const [roots, setRoots] = useState<TreeRoot[]>([]);
  const [blocks, setBlocks] = useState<BlockRow[]>([]);
  const [level, setLevel] = useState<LeftLevel>("roots");
  const [rootSel, setRootSel] = useState(0);
  const [blockSel, setBlockSel] = useState(0);
  const [openRoot, setOpenRoot] = useState<TreeRoot | null>(null);

  // ── right pane: the story ──────────────────────────────────────────────────
  const [detail, setDetail] = useState<BlockDetail | null>(null);
  const [chain, setChain] = useState<ChainMember[]>([]);
  const [rightSel, setRightSel] = useState(0);
  const [focus, setFocus] = useState<"left" | "right">("left");
  const [trail, setTrail] = useState<string[]>([]); // jump history (block ids) for esc-back

  // ── search overlay ─────────────────────────────────────────────────────────
  const [searching, setSearching] = useState(false);
  const [q, setQ] = useState("");
  const [results, setResults] = useState<Array<BlockRow & { superseded_by?: string }>>([]);
  const [resSel, setResSel] = useState(0);

  useEffect(() => {
    let alive = true;
    fetchTree().then((t) => { if (alive) setRoots(t); });
    return () => { alive = false; };
  }, []);

  useEffect(() => { onCapture(searching); }, [searching, onCapture]);

  // Load the story for a block id (shared by list-select, search, edge-jump).
  const inspect = useCallback((id: string | null) => {
    if (!id) { setDetail(null); setChain([]); return; }
    fetchBlockDetail(id).then(async (d) => {
      setDetail(d);
      setRightSel(0);
      if (d?.chain_id) setChain(await fetchChainMembers(d.chain_id));
      else setChain([]);
    });
  }, []);

  // Selection in the left pane drives the right pane (debounced light).
  const selectedBlock = level === "blocks" ? blocks[blockSel] : undefined;
  const inspectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (inspectTimer.current) clearTimeout(inspectTimer.current);
    inspectTimer.current = setTimeout(() => inspect(selectedBlock?.id ?? null), 120);
    return () => { if (inspectTimer.current) clearTimeout(inspectTimer.current); };
  }, [selectedBlock?.id, inspect]);

  // Debounced search.
  useEffect(() => {
    if (!searching) return;
    const t = setTimeout(() => { void searchMemory(q, 8).then((r) => { setResults(r as any); setResSel(0); }); }, 150);
    return () => clearTimeout(t);
  }, [q, searching]);

  const openRootBlocks = useCallback((root: TreeRoot) => {
    setOpenRoot(root);
    setLevel("blocks");
    setBlockSel(0);
    void fetchProjectBlocks(root.label).then((b) => setBlocks(b));
  }, []);

  // Everything the right pane can jump to, in display order.
  const jumpables = useMemo<Jumpable[]>(() => {
    if (!detail) return [];
    const out: Jumpable[] = [];
    for (const m of chain) if (m.id !== detail.id) out.push({ id: m.id, label: m.label, kind: "chain", via: m.flow_role || "member", type: m.type });
    for (const e of detail.outgoing ?? []) if (e.target_id) out.push({ id: e.target_id, label: e.target_label || e.target_id, kind: "out", via: e.type });
    for (const e of detail.incoming ?? []) if (e.source_id) out.push({ id: e.source_id, label: e.source_label || e.source_id, kind: "in", via: e.type });
    return out;
  }, [detail, chain]);

  useInput((input, k) => {
    if (searching) {
      if (k.escape) { setSearching(false); setQ(""); return; }
      if (k.return) {
        const hit = results[resSel];
        if (hit) { setTrail((t) => (detail ? [...t, detail.id] : t)); inspect(hit.id); setFocus("right"); }
        setSearching(false); setQ("");
        return;
      }
      if (k.upArrow) { setResSel((s) => Math.max(0, s - 1)); return; }
      if (k.downArrow) { setResSel((s) => Math.min(results.length - 1, s + 1)); return; }
      if (k.backspace || k.delete) { setQ((s) => s.slice(0, -1)); return; }
      if (input && !k.ctrl && !k.meta && !k.tab) setQ((s) => s + input);
      return;
    }
    if (input === "/") { setSearching(true); setResults([]); setResSel(0); return; }
    if (k.leftArrow) { setFocus("left"); return; }
    if (k.rightArrow) { if (detail) setFocus("right"); return; }

    if (focus === "left") {
      if (level === "roots") {
        if (k.upArrow) setRootSel((s) => Math.max(0, s - 1));
        else if (k.downArrow) setRootSel((s) => Math.min(roots.length - 1, s + 1));
        else if (k.return && roots[rootSel]) openRootBlocks(roots[rootSel]!);
      } else {
        if (k.upArrow) setBlockSel((s) => Math.max(0, s - 1));
        else if (k.downArrow) setBlockSel((s) => Math.min(blocks.length - 1, s + 1));
        else if (k.return && detail) setFocus("right");
        else if (k.escape) { setLevel("roots"); setOpenRoot(null); setBlocks([]); setDetail(null); setChain([]); setTrail([]); }
      }
      return;
    }

    // right pane focused — walk the story
    if (k.upArrow) setRightSel((s) => Math.max(0, s - 1));
    else if (k.downArrow) setRightSel((s) => Math.min(jumpables.length - 1, s + 1));
    else if (k.return) {
      const j = jumpables[rightSel];
      if (j && detail) { setTrail((t) => [...t, detail.id]); inspect(j.id); }
    } else if (k.escape) {
      const back = trail[trail.length - 1];
      if (back) { setTrail((t) => t.slice(0, -1)); inspect(back); }
      else setFocus("left");
    }
  }, { isActive: isActive && true });

  // ── render ─────────────────────────────────────────────────────────────────
  const leftW = Math.min(38, Math.max(28, Math.floor(cols * 0.32)));
  const essW = Math.max(30, cols - leftW - 8);

  const supersededBy = (detail?.incoming ?? []).find((e: EdgeRef) => e.type === "superseded_by");

  return (
    <Box flexDirection="column" flexGrow={1}>
      <Box flexGrow={1}>
        {/* left — the tree */}
        <Box flexDirection="column" width={leftW} marginRight={2}>
          {level === "roots" ? (
            <Section title="roots" hot={focus === "left"} right={<Text color={theme.dim}>{`${roots.length}`}</Text>}>
              {roots.length === 0 ? <Text color={theme.dim}>empty graph — memory appears as your agents work</Text> : null}
              {roots.slice(0, listCap).map((r, i) => (
                <Row key={r.id} selected={i === rootSel} focused={focus === "left"}>
                  <Text color={typeColorOf("project")}>{"⌂ "}</Text>
                  <Text color={i === rootSel ? theme.value : theme.label}>{trunc(r.label, leftW - 10)}</Text>
                  <Text color={theme.dim}>{`  ${r.children_count ?? ""}`}</Text>
                </Row>
              ))}
            </Section>
          ) : (
            <Section title={trunc(openRoot?.label ?? "blocks", leftW - 8)} hot={focus === "left"} right={<Text color={theme.dim}>{`${blocks.length}`}</Text>}>
              {blocks.slice(0, listCap).map((b, i) => (
                <Row key={b.id} selected={i === blockSel} focused={focus === "left"}>
                  <Text color={typeColorOf(b.type)}>{`${typeGlyphOf(b.type)} `}</Text>
                  <Text color={i === blockSel ? theme.value : theme.label}>{trunc(b.label.replace(`${openRoot?.label ?? ""}_`, ""), leftW - 8)}</Text>
                </Row>
              ))}
              {blocks.length > listCap ? <Text color={theme.dim}>{`  … ${blocks.length - listCap} more`}</Text> : null}
            </Section>
          )}
        </Box>

        {/* right — the story */}
        <Box flexDirection="column" flexGrow={1}>
          {!detail ? (
            <Box flexDirection="column">
              <Section title="memory">
                <Text color={theme.dim}>
                  {level === "roots" ? "open a root (enter) to browse its blocks" : "select a block — its story shows here"}
                </Text>
              </Section>
            </Box>
          ) : (
            <Box flexDirection="column">
              <Box>
                <Text color={typeColorOf(detail.type)} bold>{`${typeGlyphOf(detail.type)} ${detail.label}`}</Text>
              </Box>
              <Box marginBottom={1}>
                <Text color={typeColorOf(detail.type)}>{detail.type}</Text>
                <Text color={theme.dim}>{detail.created_at ? `  ·  ${relTime(detail.created_at)} ago` : ""}</Text>
                {supersededBy ? (
                  <Text color={theme.warn}>{`  ⚠ SUPERSEDED → ${trunc(supersededBy.source_label ?? "", 40)}`}</Text>
                ) : null}
              </Box>
              <Box marginBottom={1} width={essW}>
                <Text color={theme.value} wrap="wrap">{detail.essence || "(no essence)"}</Text>
              </Box>
              {detail.content?.unique && Object.keys(detail.content.unique).length > 0 ? (
                <Box flexDirection="column" marginBottom={1}>
                  {Object.entries(detail.content.unique).slice(0, 6).map(([k, v]) => (
                    <Box key={k}>
                      <Box width={16}><Text color={theme.label}>{trunc(k, 15)}</Text></Box>
                      <Text color={theme.value}>{trunc(String(v), essW - 18)}</Text>
                    </Box>
                  ))}
                </Box>
              ) : null}
              {jumpables.length > 0 ? (
                <Section title={chain.length > 0 ? `⛓ chain + edges` : "edges"} hot={focus === "right"}>
                  {jumpables.slice(0, Math.max(4, listCap - 10)).map((j, i) => (
                    <Row key={`${j.kind}-${j.id}-${i}`} selected={i === rightSel} focused={focus === "right"}>
                      <Box width={14}>
                        <Text color={theme.dim}>{j.kind === "in" ? `← ${trunc(j.via, 11)}` : j.kind === "out" ? `→ ${trunc(j.via, 11)}` : `⛓ ${trunc(j.via, 11)}`}</Text>
                      </Box>
                      {j.type ? <Text color={typeColorOf(j.type)}>{`${typeGlyphOf(j.type)} `}</Text> : null}
                      <Text color={i === rightSel && focus === "right" ? theme.value : theme.label}>{trunc(j.label, essW - 20)}</Text>
                    </Row>
                  ))}
                </Section>
              ) : null}
            </Box>
          )}
        </Box>
      </Box>

      {searching ? (
        <Panel title="search memory" hot>
          <Box>
            <Text color={theme.accent}>{"/ "}</Text>
            <Text color={theme.value}>{q}</Text>
            <Text color={theme.accent}>▏</Text>
          </Box>
          {results.map((r, i) => (
            <Row key={r.id} selected={i === resSel}>
              <Text color={typeColorOf(r.type)}>{`${typeGlyphOf(r.type)} `}</Text>
              <Text color={i === resSel ? theme.value : theme.label}>{trunc(r.label, 50)}</Text>
              {(r as any).superseded_by ? <Text color={theme.warn}>{"  ⚠ superseded"}</Text> : null}
              <Text color={theme.dim}>{`  ${trunc(r.essence, Math.max(10, cols - 70))}`}</Text>
            </Row>
          ))}
          {q && results.length === 0 ? <Text color={theme.dim}>no hits</Text> : null}
        </Panel>
      ) : (
        <Keys items={[
          ["↑↓", "move"], ["←→", "pane"], ["enter", focus === "left" ? (level === "roots" ? "open root" : "walk story") : "jump"],
          ["esc", "back"], ["/", "search"],
        ]} />
      )}
    </Box>
  );
}
