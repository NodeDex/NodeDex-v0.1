// root-relatedness.ts — derive a MEANING-CLASSIFIED root-relatedness map from the
// CROSS-ROOT edges already in the graph. The "Venn overlap" of two project roots,
// grounded in real edges (no LLM, no hallucination).
//
// "Related" is NOT one thing — each relation type carries a DIFFERENT meaning, so
// edges are classified into categories rather than lumped:
//   dependency  — based_on/prompted_by/derived_from/supports/extends/depends_on/affects
//                 ("A reasons from / is triggered by B") — the real cross-root overlap
//   containment — part_of/contains ("A is INSIDE B") — the nesting signal, strongest
//   evolution   — supersedes/superseded_by ("A replaced B") — shared topic revisited
//   conflict    — contradicts — a conflict to resolve, surfaced distinctly
//   loose       — related_to — generic association
// EXCLUDED: member_of (chain grouping — would double-count) + provenance types
// (extracted_from/produced/describes/implements…) — not topic relatedness.
// Directional for the SUBORDINATING types, so "gear belongs under wind-river" falls out.

import type Database from "better-sqlite3";
import type { WorkspaceDB, Block } from "../../store/database.js";

export type RelatednessCategory = "dependency" | "containment" | "evolution" | "conflict" | "loose";

const CATEGORY: Record<string, RelatednessCategory> = {
  based_on: "dependency", prompted_by: "dependency", derived_from: "dependency",
  supports: "dependency", extends: "dependency", depends_on: "dependency",
  affects: "dependency", affected_by: "dependency", triggered: "dependency", enables: "dependency",
  part_of: "containment", contains: "containment",
  supersedes: "evolution", superseded_by: "evolution",
  contradicts: "conflict",
  related_to: "loose",
};
// Types where SOURCE is subordinate to TARGET (source depends on / sits under target).
const SUBORDINATING = new Set(["based_on", "prompted_by", "derived_from", "depends_on", "part_of", "triggered", "affected_by"]);
// Grouping + provenance — NOT topic relatedness.
const EXCLUDE = new Set(["member_of", "extracted_from", "produced", "describes", "described_by", "implements", "implemented_by"]);

export interface MinBlock { id: string; label: string; type: string; project_id: string | null; }
export interface RootEdge { source_id: string; target_id: string; type: string; }

export interface RelatedPair {
  root_a: string;
  root_b: string;
  categories: Partial<Record<RelatednessCategory, number>>;
  total: number;
  /** Label of the root the other sits under (most subordinating edges point here), or null. */
  parent: string | null;
  parent_subordinating_edges: number;
}
export interface RootRelatedness {
  pairs: RelatedPair[];
  standalone: string[];
}

/** Pure: classify cross-root edges into a meaning-categorized relatedness map. Testable. */
export function classifyRootRelatedness(blocks: MinBlock[], edges: RootEdge[]): RootRelatedness {
  const byId = new Map(blocks.map((b) => [b.id, b]));
  const rootOf = (id: string): string | null => {
    const b = byId.get(id);
    if (!b) return null;
    return b.type === "project" ? b.id : b.project_id;
  };
  const labelOf = (rid: string) => byId.get(rid)?.label ?? rid;

  interface Acc { a: string; b: string; cats: Map<RelatednessCategory, number>; subUp: Map<string, number>; }
  const pairs = new Map<string, Acc>();
  for (const e of edges) {
    if (EXCLUDE.has(e.type)) continue;
    const cat = CATEGORY[e.type];
    if (!cat) continue;
    const rs = rootOf(e.source_id), rt = rootOf(e.target_id);
    if (!rs || !rt || rs === rt) continue;
    const [a, b] = rs < rt ? [rs, rt] : [rt, rs];
    const k = `${a}|${b}`;
    let acc = pairs.get(k);
    if (!acc) { acc = { a, b, cats: new Map(), subUp: new Map() }; pairs.set(k, acc); }
    acc.cats.set(cat, (acc.cats.get(cat) ?? 0) + 1);
    if (SUBORDINATING.has(e.type)) acc.subUp.set(rt, (acc.subUp.get(rt) ?? 0) + 1); // target is the parent
  }

  const out: RelatedPair[] = [];
  const related = new Set<string>();
  for (const acc of pairs.values()) {
    related.add(acc.a); related.add(acc.b);
    const categories: Partial<Record<RelatednessCategory, number>> = {};
    let total = 0;
    for (const [c, n] of acc.cats) { categories[c] = n; total += n; }
    let parent: string | null = null, parentEdges = 0;
    for (const [rid, n] of acc.subUp) if (n > parentEdges) { parent = labelOf(rid); parentEdges = n; }
    out.push({ root_a: labelOf(acc.a), root_b: labelOf(acc.b), categories, total, parent, parent_subordinating_edges: parentEdges });
  }
  out.sort((x, y) => y.total - x.total);

  const standalone = blocks.filter((b) => b.type === "project" && !related.has(b.id)).map((b) => b.label);
  return { pairs: out, standalone };
}

/** DB wrapper: read blocks + active relations, classify. */
export function deriveRootRelatedness(db: WorkspaceDB): RootRelatedness {
  const blocks: MinBlock[] = db.getAllBlocks().map((b: Block) => ({
    id: b.id, label: b.label, type: b.type, project_id: (b as any).project_id ?? null,
  }));
  const raw = (db as any).db as Database.Database;
  const edges = raw.prepare("SELECT source_id, target_id, type FROM relations WHERE valid_to IS NULL").all() as RootEdge[];
  return classifyRootRelatedness(blocks, edges);
}
