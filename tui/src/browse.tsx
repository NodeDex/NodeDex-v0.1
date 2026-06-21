// browse.tsx — the Browse pane: the graph as a file explorer (TUI-V2 §2.1+§2.1.1).
// Miller columns: roots │ blocks (role-sectioned) │ inspector. The agent
// protocol "tree → label → traverse" as UI. Read-only; all data on-demand from
// local endpoints (never part of the 2s poll).
//
// Keys (vim grammar, active only when this tab is focused):
//   h/l ←/→ column focus · j/k ↑/↓ rows · g/G top/bottom · enter open/inspect ·
//   / filter-as-you-type in the focused column (esc clears).
import React, { useEffect, useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import { Panel } from "./components.js";
import { theme, typeColorOf, typeGlyphOf, trunc } from "./theme.js";
import { useTermSize } from "./hooks.js";
import {
  fetchTree,
  fetchProjectBlocks,
  fetchBlockDetail,
  type TreeRoot,
  type BlockRow,
  type BlockDetail,
  type EdgeRef,
} from "./api.js";

// ─── role sections (§2.1.1 rule 1: sort by MEANING, boundaries first) ────────
const SECTION_ORDER = ["boundaries", "committed", "open", "knowledge"] as const;
type Section = (typeof SECTION_ORDER)[number];

function sectionOf(type: string): Section {
  if (type === "constraint") return "boundaries";
  if (["decision", "dead_end", "preference", "blueprint"].includes(type)) return "committed";
  if (["question", "hypothesis", "task"].includes(type)) return "open";
  return "knowledge";
}

// blocks ordered section-by-section; headers are render-only (selection skips them)
function sectionize(blocks: BlockRow[]): { ordered: BlockRow[]; headerBefore: Map<string, Section> } {
  const ordered: BlockRow[] = [];
  const headerBefore = new Map<string, Section>();
  for (const sec of SECTION_ORDER) {
    const members = blocks.filter((b) => sectionOf(b.type) === sec);
    if (members.length === 0) continue;
    headerBefore.set(members[0].id, sec);
    ordered.push(...members);
  }
  return { ordered, headerBefore };
}

// short display name: strip the "{project}_{type}_" prefix the label carries
function shortName(label: string, projectLabel: string): string {
  const rest = label.startsWith(projectLabel + "_") ? label.slice(projectLabel.length + 1) : label;
  return rest.replace(/^[a-z-]+_/, "") || rest;
}

// ─── edge grouping (§2.1.1 rule 4: edges by MEANING in the inspector) ────────
const EDGE_GROUPS: Array<{ name: string; types: string[]; color: string }> = [
  { name: "why", types: ["based_on", "prompted_by", "supports", "resolves", "triggered"], color: "cyan" },
  { name: "story", types: ["member_of"], color: "yellow" },
  { name: "history", types: ["supersedes", "superseded_by", "extends", "evolved_from"], color: "magenta" },
  { name: "conflicts", types: ["contradicts", "conflicts_with"], color: "red" },
];

interface GroupedEdge {
  dir: "→" | "←";
  type: string;
  label: string;
  id: string;
}

function groupEdges(detail: BlockDetail): Array<{ name: string; color: string; edges: GroupedEdge[] }> {
  const all: GroupedEdge[] = [
    ...(detail.outgoing ?? []).map((e: EdgeRef) => ({
      dir: "→" as const, type: e.type, label: e.target_label ?? e.target_id ?? "?", id: e.target_id ?? "",
    })),
    ...(detail.incoming ?? []).map((e: EdgeRef) => ({
      dir: "←" as const, type: e.type, label: e.source_label ?? e.source_id ?? "?", id: e.source_id ?? "",
    })),
  ];
  const out: Array<{ name: string; color: string; edges: GroupedEdge[] }> = [];
  const used = new Set<GroupedEdge>();
  for (const g of EDGE_GROUPS) {
    const edges = all.filter((e) => g.types.includes(e.type));
    edges.forEach((e) => used.add(e));
    if (edges.length > 0) out.push({ name: g.name, color: g.color, edges });
  }
  const rest = all.filter((e) => !used.has(e) && e.type !== "part_of");
  if (rest.length > 0) out.push({ name: "other", color: theme.dim, edges: rest });
  return out;
}

// ─── scroll window: keep selection visible, show position when scrolled ──────
function windowAround<T>(items: T[], selected: number, height: number): { slice: T[]; offset: number } {
  if (items.length <= height) return { slice: items, offset: 0 };
  const offset = Math.min(Math.max(0, selected - Math.floor(height / 2)), items.length - height);
  return { slice: items.slice(offset, offset + height), offset };
}

// ─── the pane ────────────────────────────────────────────────────────────────
export function BrowseTab({ isActive, onCapture }: { isActive: boolean; onCapture: (v: boolean) => void }) {
  const { columns, rows } = useTermSize();
  const [roots, setRoots] = useState<TreeRoot[] | null>(null);
  const [blocks, setBlocks] = useState<BlockRow[] | null>(null);
  const [detail, setDetail] = useState<BlockDetail | null>(null);
  const [col, setCol] = useState(0); // 0 roots · 1 blocks · 2 inspector
  const [rootIdx, setRootIdx] = useState(0);
  const [blockIdx, setBlockIdx] = useState(0);
  const [openRoot, setOpenRoot] = useState<TreeRoot | null>(null);
  const [filter, setFilter] = useState("");
  const [filterMode, setFilterMode] = useState(false);
  // edge traversal (§2.1.1 rule 4): focus ≠ null → inspector shows a walked-to
  // block instead of the list selection; trail = the way back (breadcrumbs)
  const [focus, setFocus] = useState<{ id: string; label: string } | null>(null);
  const [trail, setTrail] = useState<Array<{ id: string; label: string }>>([]);
  const [edgeIdx, setEdgeIdx] = useState(0);
  const visited = useRef(new Set<string>());
  const detailSeq = useRef(0);

  // roots once per mount ('r' on the shell refreshes the dashboard, not this)
  useEffect(() => {
    let alive = true;
    fetchTree().then((t) => { if (alive) setRoots(t); });
    return () => { alive = false; };
  }, []);

  const q = filter.trim().toLowerCase();
  const visRoots = (roots ?? []).filter(
    (r) => !q || col !== 0 || r.label.toLowerCase().includes(q) || r.essence.toLowerCase().includes(q)
  );
  const { ordered, headerBefore } = sectionize(
    (blocks ?? []).filter(
      (b) =>
        b.type !== "project" &&
        (!q || col !== 1 || b.label.toLowerCase().includes(q) || b.essence.toLowerCase().includes(q))
    )
  );

  const selRoot = visRoots[Math.min(rootIdx, Math.max(0, visRoots.length - 1))];
  const selBlock = ordered[Math.min(blockIdx, Math.max(0, ordered.length - 1))];

  // inspector follows the walked-to block if traversing, else the highlighted one
  const inspectId = focus?.id ?? selBlock?.id;
  useEffect(() => {
    if (!inspectId) { setDetail(null); return; }
    const seq = ++detailSeq.current;
    fetchBlockDetail(inspectId).then((d) => {
      if (seq === detailSeq.current) setDetail(d);
    });
  }, [inspectId]);

  // moving the list selection abandons any traversal in progress
  useEffect(() => {
    setFocus(null);
    setTrail([]);
    setEdgeIdx(0);
  }, [selBlock?.id]);

  // filter mode captures ALL keys (incl. q/esc/digits) — tell the shell
  useEffect(() => { onCapture(filterMode); }, [filterMode, onCapture]);

  const openSelectedRoot = () => {
    if (!selRoot) return;
    setOpenRoot(selRoot);
    setBlocks(null);
    setBlockIdx(0);
    setCol(1);
    void fetchProjectBlocks(selRoot.label).then(setBlocks);
  };

  // grouped edges of the inspected block — selectable when the inspector is
  // focused; the flat list mirrors exactly what's rendered (6 per group)
  const groups = detail ? groupEdges(detail) : [];
  const visGroups = groups.map((g) => ({ ...g, shown: g.edges.slice(0, 6), more: Math.max(0, g.edges.length - 6) }));
  const flatEdges = visGroups.flatMap((g) => g.shown);
  const selEdge = flatEdges[Math.min(edgeIdx, Math.max(0, flatEdges.length - 1))];

  const traverse = (e: GroupedEdge | undefined) => {
    if (!e || (!e.id && !e.label) || !detail) return;
    visited.current.add(detail.id);
    setTrail((t) => [...t, { id: detail.id, label: detail.label }]);
    setFocus({ id: e.id || e.label, label: e.label });
    setEdgeIdx(0);
  };

  const goBack = () => {
    if (trail.length === 0) { setCol(1); return; }
    const prev = trail[trail.length - 1];
    setTrail((t) => t.slice(0, -1));
    setFocus(prev.id === selBlock?.id && trail.length === 1 ? null : prev);
    setEdgeIdx(0);
  };

  useInput(
    (input, key) => {
      if (filterMode) {
        if (key.escape) { setFilterMode(false); setFilter(""); }
        else if (key.return) setFilterMode(false);
        else if (key.backspace || key.delete) setFilter((f) => f.slice(0, -1));
        else if (input && !key.ctrl && !key.meta) setFilter((f) => f + input);
        return;
      }
      if (input === "/") { setFilterMode(true); setFilter(""); return; }
      const move = (d: number) => {
        if (col === 0) setRootIdx((i) => Math.min(Math.max(0, i + d), Math.max(0, visRoots.length - 1)));
        else if (col === 1) setBlockIdx((i) => Math.min(Math.max(0, i + d), Math.max(0, ordered.length - 1)));
        else setEdgeIdx((i) => Math.min(Math.max(0, i + d), Math.max(0, flatEdges.length - 1)));
      };
      if (input === "j" || key.downArrow) { move(1); return; }
      if (input === "k" || key.upArrow) { move(-1); return; }
      if (input === "g") { col === 0 ? setRootIdx(0) : col === 1 ? setBlockIdx(0) : setEdgeIdx(0); return; }
      if (input === "G") {
        if (col === 0) setRootIdx(Math.max(0, visRoots.length - 1));
        else if (col === 1) setBlockIdx(Math.max(0, ordered.length - 1));
        else setEdgeIdx(Math.max(0, flatEdges.length - 1));
        return;
      }
      if (input === "h" || key.leftArrow || key.backspace) {
        if (col === 2) goBack();
        else { setCol((c) => Math.max(0, c - 1)); setFilter(""); }
        return;
      }
      if (input === "l" || key.rightArrow) {
        if (col === 0 && openRoot) setCol(1);
        else if (col === 1 && detail) setCol(2);
        return;
      }
      if (key.return) {
        if (col === 0) openSelectedRoot();
        else if (col === 1 && detail) setCol(2);
        else if (col === 2) traverse(selEdge);
        return;
      }
    },
    { isActive }
  );

  // ─── layout ────────────────────────────────────────────────────────────────
  const rootsW = Math.max(22, Math.floor(columns * 0.2));
  const blocksW = Math.max(30, Math.floor(columns * 0.32));
  const inspW = Math.max(30, columns - rootsW - blocksW - 4);
  const listH = Math.max(6, rows - (rows < 30 ? 10 : 18));

  // roots column
  const rw = windowAround(visRoots, rootIdx, listH);
  const rootsCol = (
    <Panel title={`roots${visRoots.length > listH ? ` ${rootIdx + 1}/${visRoots.length}` : ""}`} width={rootsW} minHeight={listH + 2} hot={col === 0}>
      {roots === null ? (
        <Text color={theme.dim}>loading…</Text>
      ) : visRoots.length === 0 ? (
        <Text color={theme.dim}>{q ? "no match" : "no projects yet — the pipeline creates roots as topics appear"}</Text>
      ) : (
        rw.slice.map((r, i) => {
          const sel = rw.offset + i === rootIdx;
          return (
            <Box key={r.id}>
              <Text bold={sel} color={sel ? theme.accent : undefined}>
                {`${sel ? "▸ " : "  "}${trunc(r.label, rootsW - 10)}`}
              </Text>
              <Text color={theme.dim}>{typeof r.children_count === "number" ? ` ${r.children_count}` : ""}</Text>
            </Box>
          );
        })
      )}
    </Panel>
  );

  // blocks column (role sections as inline headers)
  const blockRows: React.ReactNode[] = [];
  if (openRoot) {
    const bw = windowAround(ordered, blockIdx, listH);
    bw.slice.forEach((b, i) => {
      const idx = bw.offset + i;
      const sec = headerBefore.get(b.id);
      if (sec) {
        blockRows.push(
          <Text key={`h-${sec}`} color={theme.dim}>{`── ${sec} ──`}</Text>
        );
      }
      const sel = idx === blockIdx;
      blockRows.push(
        <Box key={b.id}>
          <Text color={typeColorOf(b.type)}>{`${typeGlyphOf(b.type)} `}</Text>
          <Text bold={sel} color={sel ? theme.accent : undefined}>
            {`${sel ? "▸" : " "}${trunc(shortName(b.label, openRoot.label), blocksW - 12)}`}
          </Text>
          <Text color={theme.dim}>
            {`${b.review_status ? " ⚑" : ""}${b.chain_id ? " ⛓" : ""}${visited.current.has(b.id) ? " ·" : ""}`}
          </Text>
        </Box>
      );
    });
  }
  const blocksCol = (
    <Panel
      title={openRoot ? `blocks (${trunc(openRoot.label, blocksW - 18)})${ordered.length > listH ? ` ${blockIdx + 1}/${ordered.length}` : ""}` : "blocks"}
      width={blocksW}
      minHeight={listH + 2}
      hot={col === 1}
    >
      {!openRoot ? (
        <Text color={theme.dim}>[enter] on a root to open it</Text>
      ) : blocks === null ? (
        <Text color={theme.dim}>loading…</Text>
      ) : ordered.length === 0 ? (
        <Text color={theme.dim}>{q ? "no match" : "no blocks yet — extraction fills this as the agent works"}</Text>
      ) : (
        blockRows
      )}
    </Panel>
  );

  // inspector column
  const fieldW = inspW - 6;
  let inspector: React.ReactNode;
  if (!selBlock || !openRoot) {
    inspector = <Text color={theme.dim}>select a block to inspect it</Text>;
  } else if (!detail) {
    inspector = <Text color={theme.dim}>loading…</Text>;
  } else {
    const unique: Record<string, unknown> =
      detail.content && typeof detail.content === "object" && detail.content.unique && typeof detail.content.unique === "object"
        ? detail.content.unique
        : {};
    let edgeOffset = 0;
    inspector = (
      <Box flexDirection="column">
        <Text>
          <Text color={typeColorOf(detail.type)}>{`${typeGlyphOf(detail.type)} ${detail.type}`}</Text>
          <Text color={theme.dim}>{`  q${detail.quality_score ?? "—"}${detail.review_status ? "  ⚑ " + detail.review_status : ""}`}</Text>
        </Text>
        <Text bold wrap="truncate-end">{detail.label}</Text>
        <Box marginTop={1}>
          <Text wrap="wrap">{detail.essence}</Text>
        </Box>
        {Object.keys(unique).length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            {Object.entries(unique).map(([k, v]) => (
              <Text key={k}>
                <Text color={theme.label}>{`${k}: `}</Text>
                <Text>{trunc(typeof v === "string" ? v : JSON.stringify(v), fieldW - k.length)}</Text>
              </Text>
            ))}
          </Box>
        )}
        {visGroups.map((g) => {
          const start = edgeOffset;
          edgeOffset += g.shown.length;
          return (
            <Box key={g.name} flexDirection="column" marginTop={1}>
              <Text color={g.color}>{`── ${g.name} ──`}</Text>
              {g.shown.map((e, i) => {
                const sel = col === 2 && start + i === Math.min(edgeIdx, Math.max(0, flatEdges.length - 1));
                return (
                  <Text key={`${e.id}-${e.type}-${i}`}>
                    <Text color={sel ? theme.accent : theme.dim} bold={sel}>
                      {`${sel ? "▸" : " "}${e.dir} ${e.type.padEnd(12)} `}
                    </Text>
                    <Text bold={sel} color={sel ? theme.accent : undefined}>{trunc(e.label, fieldW - 18)}</Text>
                  </Text>
                );
              })}
              {g.more > 0 ? <Text color={theme.dim}>{`  …${g.more} more`}</Text> : null}
            </Box>
          );
        })}
        {detail.source_excerpt ? (
          <Box flexDirection="column" marginTop={1}>
            <Text color={theme.dim}>── provenance ──</Text>
            <Text color={theme.dim} wrap="wrap">{trunc(detail.source_excerpt, fieldW * 3)}</Text>
          </Box>
        ) : null}
      </Box>
    );
  }
  const inspectorCol = (
    <Panel title="inspector" width={inspW} minHeight={listH + 2} hot={col === 2}>
      {inspector}
    </Panel>
  );

  return (
    <Box flexDirection="column">
      <Box flexDirection="row">
        {rootsCol}
        {blocksCol}
        {inspectorCol}
      </Box>
      {trail.length > 0 || focus ? (
        <Text color={theme.dim} wrap="truncate-end">
          {` ⌂ ${[...trail.map((t) => trunc(t.label, 28)), trunc(focus?.label ?? "", 28)].join(" ▸ ")}  (h back)`}
        </Text>
      ) : null}
      <Text color={theme.dim}>
        {filterMode || filter
          ? ` / ${filter}▌  (enter keep · esc clear)`
          : col === 2
            ? " [j/k] edges  [enter] walk edge  [h] back  — the graph is traversable, follow the why"
            : " [h/l] columns  [j/k] rows  [enter] open/inspect  [/] filter  [g/G] top/bottom"}
      </Text>
    </Box>
  );
}
