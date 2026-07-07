// pass5-mechanical.ts — deterministic replacement for the Pass-5 LLM chain assembly.
//
// WHY: Pass 5 spends an LLM call every reflect turn to summarize causal clusters into
// chain blocks. But its consumers (pass4-slice header, context.ts supersede, provenance-
// reviewer) use only MEMBERSHIP + a one-line summary + the type-arc — all mechanically
// computable. This produces the SAME Pass5Result shape (fed through the identical
// downstream chain-block creation in pipeline.ts) with NO model call.
//
// It matches Pass 5's SELECTIVITY: a chain is emitted only for a cluster whose terminus
// is a committed conclusion (a decision/constraint/insight/dead_end/reasoning_chain that
// is a sink of the arc) — not for open arcs or pure accumulation.
import type { Pass5Result, Pass5Chain } from "./types.js";
import { SPINE_RELS } from "../../relation-sets.js";

// The terminus must be one of these for the cluster to be a chain (Pass 5's "committed
// conclusion" test). fact/event/task/blueprint are NOT committed conclusions.
const CONCLUSION_TYPES = new Set(["decision", "constraint", "insight", "dead_end", "reasoning_chain"]);
const WEIGHT: Record<string, number> = { dead_end: 5, constraint: 5, decision: 4, insight: 3, reasoning_chain: 3 };

type MechBlock = { id: string; label: string; type: string; essence: string };
type MechRel = { source_id: string; target_id: string; type: string };

function trunc(s: string, n: number): string {
  const t = (s || "").trim();
  return t.length > n ? t.slice(0, n).trimEnd() + "…" : t;
}

export function assembleMechanicalChains(newBlocks: MechBlock[], causalRels: MechRel[]): Pass5Result {
  if (newBlocks.length < 2) return { chains: [] };
  const byId = new Map(newBlocks.map((b) => [b.id, b]));
  const rels = causalRels.filter((r) => byId.has(r.source_id) && byId.has(r.target_id));
  if (rels.length === 0) return { chains: [] };

  // 1. Connected components — undirected over ALL causal rels (matches stampFlowRolesAndChains).
  const adj = new Map<string, Set<string>>();
  for (const b of newBlocks) adj.set(b.id, new Set());
  for (const r of rels) { adj.get(r.source_id)!.add(r.target_id); adj.get(r.target_id)!.add(r.source_id); }
  const seenGlobal = new Set<string>();
  const components: string[][] = [];
  for (const b of newBlocks) {
    if (seenGlobal.has(b.id)) continue;
    const comp: string[] = []; const q = [b.id];
    while (q.length) {
      const id = q.shift()!; if (seenGlobal.has(id)) continue; seenGlobal.add(id); comp.push(id);
      for (const n of adj.get(id) ?? []) if (!seenGlobal.has(n)) q.push(n);
    }
    if (comp.length >= 2) components.push(comp);
  }

  const chains: Pass5Chain[] = [];
  for (const comp of components) {
    const compSet = new Set(comp);
    const spineInComp = rels.filter((r) => SPINE_RELS.has(r.type) && compSet.has(r.source_id) && compSet.has(r.target_id));

    // 2. Committed conclusion? terminus = a conclusion-type SINK. In a SPINE edge
    //    source=effect, target=cause; a block that is never a `target` is never a cause
    //    of anything in the component → it's a terminal (effect-end).
    const isCause = new Set(spineInComp.map((r) => r.target_id));
    const sinks = comp.filter((id) => !isCause.has(id)).map((id) => byId.get(id)!);
    const conclusionSinks = sinks
      .filter((b) => CONCLUSION_TYPES.has(b.type))
      .sort((a, b) => (WEIGHT[b.type] ?? 0) - (WEIGHT[a.type] ?? 0));
    if (conclusionSinks.length === 0) continue; // open arc / accumulation → not a chain (matches Pass 5)
    const terminal = conclusionSinks[0]!;

    // 3. Topological order (cause → effect) over the spine: directed cause(target) → effect(source).
    const indeg = new Map<string, number>(comp.map((id) => [id, 0]));
    const nextOf = new Map<string, string[]>(comp.map((id) => [id, []]));
    for (const r of spineInComp) {
      nextOf.get(r.target_id)!.push(r.source_id);
      indeg.set(r.source_id, (indeg.get(r.source_id) ?? 0) + 1);
    }
    const ordered: string[] = []; const visited = new Set<string>();
    const dq = comp.filter((id) => (indeg.get(id) ?? 0) === 0);
    while (dq.length) {
      const id = dq.shift()!; if (visited.has(id)) continue; visited.add(id); ordered.push(id);
      for (const nx of nextOf.get(id) ?? []) { indeg.set(nx, (indeg.get(nx) ?? 1) - 1); if ((indeg.get(nx) ?? 0) <= 0) dq.push(nx); }
    }
    for (const id of comp) if (!visited.has(id)) ordered.push(id); // cycle leftover

    const orderedBlocks = ordered.map((id) => byId.get(id)!).filter(Boolean);
    const first = orderedBlocks[0] ?? terminal;
    const project = terminal.label.split("_")[0];
    const concept = terminal.label.split("_").slice(2).join("-") || "arc";
    const relTypes = [...new Set(spineInComp.map((r) => r.type))].join(", ") || "causal edges";

    chains.push({
      chain_label:   `${project}_chain_${concept}`.slice(0, 120),
      chain_essence: trunc(`${trunc(first.essence, 60)} → ${trunc(terminal.essence, 70)}`, 140),
      arc:           orderedBlocks.map((b) => b.type).join(" → "),
      conclusion:    trunc(terminal.essence, 80),
      members:       orderedBlocks.map((b) => b.label),
      reasoning:     `Mechanically clustered: ${comp.length} blocks joined by ${relTypes}; terminus = ${terminal.type} "${terminal.label}" (a committed conclusion sink).`,
    });
  }
  return { chains };
}
