// memory.tsx — THE view. The graph as an explorer: roots on the left, the
// selected block's STORY on the right (essence, unique facts, its chain, its
// edges) — and the edges are walkable: focus the right pane, pick a relation or
// chain member, enter jumps to it. Browse + Chains from v2 merged into one.
//
// Navigation model (same keys everywhere):
//   ←/→ = pane focus · ↑/↓ = move in the focused pane · enter = open/jump
//   esc = up one level (blocks→roots · jump-trail back · close search)
//   /   = search overlay (the same three-signal /api/search agents use; hits carry
//         root context + superseded/weak-match flags)
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import { Section, Row, Keys, Panel, windowSlice } from "./components.js";
import { theme, typeColorOf, typeGlyphOf, trunc, relTime } from "./theme.js";
import { useTermSize } from "./hooks.js";
import {
  fetchTree, fetchProjectBlocks, fetchBlockDetail, fetchThread, searchMemory,
  type TreeRoot, type BlockRow, type SearchRow, type BlockDetail, type ThreadMember, type EdgeRef,
} from "./api.js";

type LeftLevel = "roots" | "blocks";

// A row the right pane can jump to (thread step or relation endpoint).
interface Jumpable { id: string; label: string; kind: "chain" | "out" | "in"; via: string; type?: string; mark?: string }

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
  const [thread, setThread] = useState<ThreadMember[]>([]);
  const [rightSel, setRightSel] = useState(0);
  const [focus, setFocus] = useState<"left" | "right">("left");
  const [trail, setTrail] = useState<string[]>([]); // jump history (block ids) for esc-back

  // ── search overlay ─────────────────────────────────────────────────────────
  const [searching, setSearching] = useState(false);
  const [q, setQ] = useState("");
  const [results, setResults] = useState<SearchRow[]>([]);
  const [resSel, setResSel] = useState(0);

  useEffect(() => {
    let alive = true;
    fetchTree().then((t) => { if (alive) setRoots(t); });
    return () => { alive = false; };
  }, []);

  useEffect(() => { onCapture(searching); }, [searching, onCapture]);

  // Load the story for a block id (shared by list-select, search, edge-jump).
  // The thread is COMPUTED on read (causal walk over live edges) — it exists for
  // every linked block, not just ones a Pass-5 chain block happened to claim.
  const inspect = useCallback((id: string | null) => {
    if (!id) { setDetail(null); setThread([]); return; }
    fetchBlockDetail(id).then(async (d) => {
      setDetail(d);
      setRightSel(0);
      if (d) {
        const t = await fetchThread(d.id);
        setThread(Array.isArray(t?.members) ? t!.members : []);
      } else setThread([]);
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
    const t = setTimeout(() => { void searchMemory(q, 8).then((r) => { setResults(r); setResSel(0); }); }, 150);
    return () => clearTimeout(t);
  }, [q, searching]);

  const openRootBlocks = useCallback((root: TreeRoot) => {
    setOpenRoot(root);
    setLevel("blocks");
    setBlockSel(0);
    void fetchProjectBlocks(root.label).then((b) => setBlocks(b));
  }, []);

  // Everything the right pane can jump to, in display order: the story first
  // (cause→effect, ESSENCES not labels — the narrative a human can read), then
  // the raw edges. ONE ROW PER NEIGHBOR: a block linked by several relations
  // (based_on + prompted_by is common) showed once per edge, so the same essence
  // repeated 2-3× and drowned the story. The story row wins outright (its spine
  // edges ARE how the story was built — repeating them says nothing new); an
  // edge-only neighbor with extra links shows "verb +N". Thread rows jump by
  // label (getBlock accepts idOrLabel).
  const jumpables = useMemo<Jumpable[]>(() => {
    if (!detail) return [];
    const out: Jumpable[] = [];
    const byNeighbor = new Map<string, Jumpable>();
    const push = (key: string, j: Jumpable) => {
      const existing = byNeighbor.get(key);
      if (existing) {
        if (existing.kind !== "chain") {
          const m = existing.via.match(/^(.*) \+(\d+)$/);
          existing.via = m ? `${m[1]} +${Number(m[2]) + 1}` : `${existing.via} +1`;
        }
        return;
      }
      byNeighbor.set(key, j);
      out.push(j);
    };
    for (const m of thread) {
      if (m.role === "focal") continue;
      const via = m.role === "origin" ? "start" : m.role === "leaf" ? "led to" : "step";
      push(m.label, { id: m.label, label: m.essence || m.label, kind: "chain", via, type: m.type, mark: m.role === "leaf" ? "★" : "⛓" });
    }
    // Edges render the NEIGHBOR'S ESSENCE (the server sends it per-edge exactly so
    // a reader never has to jump just to learn what's on the other end); the label
    // is the fallback, trimmed of the project prefix. ⚠ = the neighbor is stale
    // (superseded) — the rot shines through the edge.
    const prefix = detail.project_id && openRoot ? `${openRoot.label}_` : "";
    const gist = (e: EdgeRef, lbl?: string) =>
      `${e.superseded_by ? "⚠ " : ""}${e.essence || (lbl || "").replace(prefix, "")}`;
    for (const e of detail.outgoing ?? []) if (e.target_id) push(e.target_label || e.target_id, { id: e.target_id, label: gist(e, e.target_label || e.target_id), kind: "out", via: e.type });
    for (const e of detail.incoming ?? []) if (e.source_id) push(e.source_label || e.source_id, { id: e.source_id, label: gist(e, e.source_label || e.source_id), kind: "in", via: e.type });
    return out;
  }, [detail, thread, openRoot]);

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
        else if (k.escape) { setLevel("roots"); setOpenRoot(null); setBlocks([]); setDetail(null); setThread([]); setTrail([]); }
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

  // Sliding viewports — the cursor stays visible past the fold in every list.
  const rootsWin = windowSlice(roots, rootSel, listCap);
  const blocksWin = windowSlice(blocks, blockSel, listCap);
  const jumpWin = windowSlice(jumpables, rightSel, Math.max(4, listCap - 10));

  return (
    <Box flexDirection="column" flexGrow={1}>
      <Box flexGrow={1}>
        {/* left — the tree */}
        <Box flexDirection="column" width={leftW} marginRight={2}>
          {level === "roots" ? (
            <Section title="roots" hot={focus === "left"} right={<Text color={theme.dim}>{`${roots.length}`}</Text>}>
              {roots.length === 0 ? <Text color={theme.dim}>empty graph — memory appears as your agents work</Text> : null}
              {rootsWin.above > 0 ? <Text color={theme.dim}>{`  ↑ ${rootsWin.above} more`}</Text> : null}
              {rootsWin.visible.map((r, i) => {
                const idx = rootsWin.start + i;
                return (
                  <Row key={r.id} selected={idx === rootSel} focused={focus === "left"}>
                    <Text color={typeColorOf("project")}>{"⌂ "}</Text>
                    <Text color={idx === rootSel ? theme.value : theme.label}>{trunc(r.label, leftW - 10)}</Text>
                    <Text color={theme.dim}>{`  ${r.children_count ?? ""}`}</Text>
                  </Row>
                );
              })}
              {rootsWin.below > 0 ? <Text color={theme.dim}>{`  ↓ ${rootsWin.below} more`}</Text> : null}
            </Section>
          ) : (
            <Section title={trunc(openRoot?.label ?? "blocks", leftW - 8)} hot={focus === "left"} right={<Text color={theme.dim}>{`${blocks.length}`}</Text>}>
              {blocksWin.above > 0 ? <Text color={theme.dim}>{`  ↑ ${blocksWin.above} more`}</Text> : null}
              {blocksWin.visible.map((b, i) => {
                const idx = blocksWin.start + i;
                return (
                  <Row key={b.id} selected={idx === blockSel} focused={focus === "left"}>
                    <Text color={typeColorOf(b.type)}>{`${typeGlyphOf(b.type)} `}</Text>
                    <Text color={idx === blockSel ? theme.value : theme.label}>{trunc(b.label.replace(`${openRoot?.label ?? ""}_`, ""), leftW - 8)}</Text>
                  </Row>
                );
              })}
              {blocksWin.below > 0 ? <Text color={theme.dim}>{`  ↓ ${blocksWin.below} more`}</Text> : null}
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
                <Section title={thread.length > 0 ? `⛓ story · cause → effect` : "edges"} hot={focus === "right"}>
                  {jumpWin.above > 0 ? <Text color={theme.dim}>{`  ↑ ${jumpWin.above} more`}</Text> : null}
                  {jumpWin.visible.map((j, i) => {
                    const idx = jumpWin.start + i;
                    return (
                      <Row key={`${j.kind}-${j.id}-${idx}`} selected={idx === rightSel} focused={focus === "right"}>
                        <Box width={14}>
                          <Text color={j.mark === "★" ? theme.accent : theme.dim}>{j.kind === "in" ? `← ${trunc(j.via, 11)}` : j.kind === "out" ? `→ ${trunc(j.via, 11)}` : `${j.mark ?? "⛓"} ${trunc(j.via, 11)}`}</Text>
                        </Box>
                        {j.type ? <Text color={typeColorOf(j.type)}>{`${typeGlyphOf(j.type)} `}</Text> : null}
                        <Text color={idx === rightSel && focus === "right" ? theme.value : theme.label} wrap="truncate">{trunc(j.label, essW - 20)}</Text>
                      </Row>
                    );
                  })}
                  {jumpWin.below > 0 ? <Text color={theme.dim}>{`  ↓ ${jumpWin.below} more`}</Text> : null}
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
          {results.length > 0 && results[0]!.weak_match ? (
            <Text color={theme.warn}>⚠ weak matches only — memory likely has nothing on this; showing the nearest blocks</Text>
          ) : null}
          {results.map((r, i) => (
            <Row key={r.id} selected={i === resSel}>
              <Text color={typeColorOf(r.type)}>{`${typeGlyphOf(r.type)} `}</Text>
              <Text color={i === resSel ? theme.value : theme.label}>{trunc(r.label, 44)}</Text>
              {r.superseded_by ? <Text color={theme.warn}>{"  ⚠ superseded"}</Text> : null}
              {r.root_label ? <Text color={theme.dim}>{`  ⌂ ${trunc(r.root_label, 22)}`}</Text> : null}
              <Text color={theme.dim}>{`  ${trunc(r.essence, Math.max(10, cols - 96))}`}</Text>
            </Row>
          ))}
          {results.length > 0 && results[resSel]?.root_essence ? (
            <Text color={theme.dim}>{`  ⌂ ${trunc(results[resSel]!.root_label ?? "", 24)} — ${trunc(results[resSel]!.root_essence!, Math.max(20, cols - 40))}`}</Text>
          ) : null}
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
