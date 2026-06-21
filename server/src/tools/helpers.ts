// ─── Shared response helpers ─────────────────────────────────────

export function ok(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ success: true, data }) }],
  };
}

export function err(code: string, message: string, extra?: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ success: false, error: { code, message, ...extra } }) }],
  };
}

// cosineSim now lives in engine/vector-math.ts (single source). Re-exported here
// so existing `import { cosineSim } from "./helpers.js"` call sites keep working.
export { cosineSim } from "../engine/vector-math.js";

import type { WorkspaceDB, Block } from "../store/database.js";
import { CAUSAL_TRAVERSAL_RELS } from "../relation-sets.js";

// Scale guard: cap how many linked chains we surface. The connected component is
// naturally small at chain granularity (an incident ≈ 6 chains), but a long-lived
// project could grow one big component — so we rank by distance and cap.
const LINKED_CHAINS_CAP = 12;

export interface ChainSummary {
  label: string;
  essence: string;
  arc: string | null;
  conclusion: string | null;
  // Members carry their essence so ONE get returns the whole READABLE arc (cause→
  // outcome), not just labels — the agent reads the story without N follow-up gets.
  members: Array<{ label: string; type: string; essence: string }>;
}

export interface LinkedChain {
  chain: string;             // the linked chain's label — open it to drill in
  essence: string;           // its one-line story
  conclusion: string | null; // its committed outcome
  distance: number;          // chain-hops from the block's OWN chain(s) (1 = directly bridged)
  via: string;               // the causal relation on the path that first reached it
}

export interface BlockChains {
  chains: ChainSummary[];       // the block's OWN arc(s) — full detail (the story it sits on)
  linked_chains: LinkedChain[]; // every chain with a causal PATH to it — the connected component, distance-ranked
}

/**
 * assembleBlockChains — "surface the chain AND its linked path, not the bare block."
 *
 * A block's meaning in a cause-and-effect store lives in the causal ARC it sits
 * on. So a single `workspace_get` returns:
 *   - `chains`        — the named Pass-5 chain(s) the block belongs to (its own arc).
 *   - `linked_chains` — every OTHER chain reachable by a causal PATH from those
 *                       chains (the connected component), with hop-`distance` and
 *                       the bridging relation. This is "everything linked back to
 *                       this block" — the whole relevant story, NOT the whole root
 *                       (unrelated islands in the same project are excluded).
 *
 * Why CHAIN-level, not block-level: a ±N block BFS floods (one anchor reached 40%
 * of a root in testing). Walking the CHAIN graph instead (chains = nodes, causal
 * bridges = edges) keeps the same incident at ~6 nodes — the whole linked story,
 * digestible. Distance-ranked + capped (LINKED_CHAINS_CAP) for the scale edge;
 * anything past the cap is reached by NAVIGATING (each linked chain is itself a
 * get-able anchor). Bound is on what's PUSHED, never on what's REACHABLE.
 *
 * Reads `member_of` (many-to-many) NOT the lossy `chain_id` column, so a HINGE
 * block (member of >1 chain) keeps all its memberships. Only CAUSAL_TRAVERSAL_RELS
 * bridge chains — NOT part_of / member_of / related_to / contradicts.
 *
 * Portable, server-side equivalent of the Claude-Code chain-injection hook — it
 * rides the tool RESULT, so it works on ANY MCP host.
 */
export function assembleBlockChains(
  db: WorkspaceDB,
  block: { id: string; type: string },
): BlockChains {
  // A chain block itself → its own arc. Any other block → the chain(s) it is a
  // member_of (member_of is non-bidirectional → only ever an OUTGOING relation).
  const ownChainIds = block.type === "chain"
    ? [block.id]
    : db.getRelations(block.id)
        .filter((r) => r.direction === "outgoing" && r.type === "member_of")
        .map((r) => r.target_id);
  const own = [...new Set(ownChainIds)];
  if (own.length === 0) return { chains: [], linked_chains: [] };

  // Graph data — fetched ONCE, only when the block is on a chain.
  const allRels = db.getAllRelations(false);
  const memberOf = new Map<string, Set<string>>(); // blockId → chains it belongs to
  for (const r of allRels) {
    if (r.type !== "member_of") continue;
    if (!memberOf.has(r.source_id)) memberOf.set(r.source_id, new Set());
    memberOf.get(r.source_id)!.add(r.target_id);
  }

  // Build the CHAIN graph (undirected — a "linked path" can run either causal
  // direction): chainId → neighbourChainId → the relation that first bridges them.
  const chainGraph = new Map<string, Map<string, string>>();
  const link = (a: string, b: string, via: string) => {
    if (a === b) return;
    if (!chainGraph.has(a)) chainGraph.set(a, new Map());
    if (!chainGraph.get(a)!.has(b)) chainGraph.get(a)!.set(b, via);
  };
  for (const r of allRels) {
    if (!CAUSAL_TRAVERSAL_RELS.has(r.type)) continue;
    const sc = memberOf.get(r.source_id);
    const tc = memberOf.get(r.target_id);
    if (!sc || !tc) continue;
    for (const a of sc) for (const b of tc) { link(a, b, r.type); link(b, a, r.type); }
  }

  // The block's OWN chains, full detail.
  const chains: ChainSummary[] = [];
  for (const chainId of own) {
    const cb = db.getBlock(chainId);
    if (!cb || cb.type !== "chain") continue;
    let content: Record<string, unknown> = {};
    try { content = JSON.parse(cb.content); } catch { /* malformed → empty */ }
    const unique = (content.unique as Record<string, unknown>) || {};
    chains.push({
      label:      cb.label,
      essence:    cb.essence,
      arc:        (unique.arc as string) ?? null,
      conclusion: (unique.conclusion as string) ?? null,
      // cause-first order via getBlocksByChain (chain_id column, created_at ASC),
      // WITH each member's essence — the whole arc readable in this one call.
      members:    db.getBlocksByChain(cb.id).map((m) => ({ label: m.label, type: m.type, essence: m.essence })),
    });
  }

  // Multi-source BFS over the chain graph from ALL the block's own chains →
  // every chain on a linked path, with its min hop-distance + bridging relation.
  const ownSet = new Set(own);
  const dist = new Map<string, number>();
  const via = new Map<string, string>();
  const queue: string[] = [];
  for (const c of own) { dist.set(c, 0); queue.push(c); }
  while (queue.length) {
    const cur = queue.shift()!;
    const d = dist.get(cur)!;
    for (const [nb, rel] of chainGraph.get(cur) ?? []) {
      if (!dist.has(nb)) { dist.set(nb, d + 1); via.set(nb, rel); queue.push(nb); }
    }
  }

  const linked_chains: LinkedChain[] = [...dist.entries()]
    .filter(([id]) => !ownSet.has(id))
    .sort((a, b) => a[1] - b[1])                  // nearest first
    .slice(0, LINKED_CHAINS_CAP)
    .map(([id, d]) => {
      const cb = db.getBlock(id);
      let conclusion: string | null = null;
      try { conclusion = (JSON.parse(cb?.content ?? "{}")?.unique?.conclusion as string) ?? null; } catch { /* ignore */ }
      return { chain: cb?.label ?? id, essence: cb?.essence ?? "", conclusion, distance: d, via: via.get(id)! };
    });

  return { chains, linked_chains };
}

export interface RootSuggestion {
  root: string;                                   // root label — the address to open
  description: string;                            // root essence (DESCRIBER-made signpost)
  terms_matched: string[];                        // which of the query concepts this root covers
  match_count: number;                            // # matching blocks under this root
  entries: Array<{ label: string; type: string }>; // top matching blocks = navigation entry points
}

/**
 * filterRootsByConcepts — the COLD-START orientation filter ("amnesia move").
 *
 * When the agent has NO anchor, it distills its current context into first-
 * principle concept terms and asks "which root(s) are relevant?" This returns
 * ranked ROOT suggestions (each with its pre-made description + the blocks that
 * matched = entry points), so the agent opens one → gets an anchor → the chain-
 * fold (assembleBlockChains) takes over.
 *
 * Matches over TWO cheap, structured fields — NOT the surface:
 *   1. concepts[]   — the abstract tag net (db.conceptSearch, cross-domain).
 *   2. strict label — the address; its segments carry concept/entity/PROJECT, so
 *                     a label hit also resolves the root for free.
 * It deliberately does NOT scan essence/content (those are LIKE full-scans and
 * re-introduce the surface search). essence is READ (for display), never filtered.
 *
 * Returns SUGGESTIONS, never "the" root — the system surfaces, the agent navigates.
 */
export function filterRootsByConcepts(
  db: WorkspaceDB,
  terms: string[],
  opts?: { limit?: number; entriesPerRoot?: number },
): RootSuggestion[] {
  const limit = opts?.limit ?? 8;
  const entriesPerRoot = opts?.entriesPerRoot ?? 3;
  const cleanTerms = [...new Set(terms.map((t) => t.trim().toLowerCase()).filter((t) => t.length > 1))];
  if (cleanTerms.length === 0) return [];

  // block id → which query terms it covers (concept hit OR label hit)
  const hits = new Map<string, { block: Block; terms: Set<string> }>();
  const addHit = (block: Block, term: string) => {
    const e = hits.get(block.id);
    if (e) e.terms.add(term);
    else hits.set(block.id, { block, terms: new Set([term]) });
  };

  // 1. concepts[] — the abstract-tag net (indexed, json_each)
  for (const term of cleanTerms) {
    for (const { block } of db.conceptSearch([term]).values()) addHit(block, term);
  }
  // 2. strict label — structured address. Match the term against the block's OWN
  //    segments (entity/type/concept), NOT the repeated {project} prefix — else a
  //    project-name term (e.g. "latency" in "…-latency-incident") matches every
  //    block in the project and drowns the signal. The root is still found via
  //    its OWN label (a top root has no project prefix to strip).
  const all = db.getAllBlocks();
  const byId = new Map(all.map((b) => [b.id, b]));
  for (const block of all) {
    const projLabel = block.project_id ? byId.get(block.project_id)?.label?.toLowerCase() : undefined;
    let local = (block.label || "").toLowerCase();
    if (projLabel && local.startsWith(projLabel + "_")) local = local.slice(projLabel.length + 1);
    for (const term of cleanTerms) if (local.includes(term)) addHit(block, term);
  }
  if (hits.size === 0) return [];

  // Resolve any block to its TOP project root (walk project_id up the chain).
  const topRoot = (block: Block): Block => {
    let cur: Block = block;
    const seen = new Set<string>();
    while (cur.project_id && byId.has(cur.project_id) && !seen.has(cur.project_id)) {
      seen.add(cur.project_id);
      cur = byId.get(cur.project_id)!;
    }
    return cur;
  };

  // Aggregate hits up to their root.
  const roots = new Map<string, { root: Block; terms: Set<string>; entries: Array<{ block: Block; terms: Set<string> }> }>();
  for (const { block, terms: bterms } of hits.values()) {
    const r = topRoot(block);
    if (r.type !== "project") continue; // only suggest project roots
    const e = roots.get(r.id) ?? { root: r, terms: new Set<string>(), entries: [] };
    for (const t of bterms) e.terms.add(t);
    if (block.id !== r.id) e.entries.push({ block, terms: bterms }); // the root itself isn't an "entry"
    roots.set(r.id, e);
  }

  // Rank roots: most query-terms covered first, then most matching blocks.
  return [...roots.values()]
    .sort((a, b) => b.terms.size - a.terms.size || b.entries.length - a.entries.length)
    .slice(0, limit)
    .map((r) => ({
      root:          r.root.label,
      description:   r.root.essence || "",
      terms_matched: [...r.terms].sort(),
      match_count:   r.entries.length,
      entries:       r.entries
        .sort((a, b) => b.terms.size - a.terms.size)
        .slice(0, entriesPerRoot)
        .map((e) => ({ label: e.block.label, type: e.block.type })),
    }));
}
