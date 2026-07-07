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
import { SPINE_RELS, GROUNDING_RELS } from "../relation-sets.js";

// Scale guard: cap how many linked chains we surface. The connected component is
// naturally small at chain granularity (an incident ≈ 6 chains), but a long-lived
// project could grow one big component — so we rank by distance and cap.
const LINKED_CHAINS_CAP = 12;

export interface ChainSummary {
  label: string | null;          // Pass-5 chain block's label; `null` for a mechanical SIGN (no chain block exists)
  essence: string;
  arc: string | null;
  conclusion: string | null;
  // `mechanical: true` = this was composed LIVE from the spine edges at read time
  // (no materialized chain block), so it is always current. Absent/false = a Pass-5
  // (LLM-summarized) chain block. See composeSign / walkThread.
  mechanical?: boolean;
  // Members = the WAYPOINTS of the thread (origin(s), any mid-path result block —
  // dead_end/constraint/decision/blueprint/insight/question — and every leaf), in
  // causal order. Plain fact/event steps collapse. Each carries its label (the HOP
  // HANDLE the agent jumps to) + essence, so ONE get = the whole skeleton + how to move.
  members: Array<{ label: string; type: string; essence: string }>;
  // ── SIGN fields (present only on mechanical signs) ──
  // `leads_to` = the ranked, capped destinations this thread reaches downstream
  // (conclusion-type + access ranked). More than one ⇒ the path forked.
  leads_to?: Array<{ label: string; type: string; essence: string }>;
  more_leaves?: number;   // destinations beyond the cap — reachable, not shown
  backed_by?: number;     // count of GROUNDING (evidential) edges on the thread — a tag, not a step
  forked?: boolean;       // the downstream path splits into >1 destination
  truncated?: boolean;    // the thread exceeded the walk safety-cap; more is reachable
  terminal?: boolean;     // the focal block IS the conclusion — nothing further downstream (empty leads_to is expected, not missing)
}

export interface LinkedChain {
  chain: string;             // hop handle — a block label in the linked thread; get it to enter (at its conclusion)
  essence: string;           // the linked thread's one-line story (origin → conclusion)
  conclusion: string | null; // its conclusion
  distance: number;          // 1 = directly bridged (v1 surfaces direct bridges; deeper is reachable by navigating)
  via: string;               // the NON-spine bridge relation (grounding / related_to / contradicts)
}

export interface BlockChains {
  chains: ChainSummary[];       // the block's OWN arc — the computed SIGN (origin → destinations)
  linked_chains: LinkedChain[]; // OTHER threads bridged to this one by a non-spine edge (Mode 3)
}

/**
 * assembleBlockChains — "surface the thread AND its linked threads, not the bare block."
 *
 * Fully COMPUTED (no materialized chain read). A single `workspace_get(detail=relations)`
 * returns:
 *   - `chains`        — the block's own arc as the SIGN (composeSign): origin → ranked
 *                       destinations, bounded, fork/terminal/grounding-tagged. Always
 *                       current (walked live from the spine).
 *   - `linked_chains` — the OTHER threads causally linked to this one (assembleLinkedThreads,
 *                       Mode 3). Spine edges stay WITHIN a thread, so a linked thread is one
 *                       bridged by a NON-spine edge (grounding / related_to / contradicts),
 *                       deduped and summarized once. Hop thread→thread, not block→block.
 *
 * Exception: a legacy `type=chain` block gotten directly still shows its members.
 *
 * Portable, server-side equivalent of the Claude-Code chain-injection hook — it
 * rides the tool RESULT, so it works on ANY MCP host.
 */
export function assembleBlockChains(
  db: WorkspaceDB,
  block: { id: string; type: string },
): BlockChains {
  // ── OWN ARC ── every block's own arc is the COMPUTED SIGN (walkThread → composeSign):
  // always current, bounded, fork-aware. It no longer reads the Pass-5 materialized chain
  // / `chain_id` column — that layer is stamped-once and goes stale (35% of blocks used to
  // show it, uncapped). The materialized data still LIVES in the graph (Pass 5, the 20
  // chain blocks, member_of) — it's just no longer the read source. Retiring the write
  // side is a separate, deliberate change (it feeds context-injection + dedup).
  //
  // Exception: a `type=chain` block gotten DIRECTLY still surfaces its own members, so the
  // legacy chain blocks stay openable until they're retired.
  // A legacy chain block gotten DIRECTLY still shows its own members (openable until retired).
  if (block.type === "chain") {
    const cb = db.getBlock(block.id);
    if (!cb) return { chains: [], linked_chains: [] };
    let content: Record<string, unknown> = {};
    try { content = JSON.parse(cb.content); } catch { /* malformed → empty */ }
    const unique = (content.unique as Record<string, unknown>) || {};
    return {
      chains: [{
        label:      cb.label,
        essence:    cb.essence,
        arc:        (unique.arc as string) ?? null,
        conclusion: (unique.conclusion as string) ?? null,
        members:    orderMembersCausally(db, db.getBlocksByChain(cb.id)).map((m) => ({ label: m.label, type: m.type, essence: m.essence })),
      }],
      linked_chains: [],
    };
  }

  // Everything else: FULLY COMPUTED. Own arc = the sign (Mode 1); linked = other threads
  // bridged to this one (Mode 3). Walk once, reuse for both.
  const walk = walkThread(db, block.id);
  const sign = composeSign(db, walk);
  return {
    chains: sign ? [sign] : [],
    linked_chains: assembleLinkedThreads(db, walk),
  };
}

// Cross-thread bridges (Mode 3): edges that link one spine thread to ANOTHER. Spine edges
// stay WITHIN a thread, so a cross-thread link is by definition a NON-spine edge — shared
// evidence (grounding) or a semantic tie (related_to / contradicts / affects).
const LINKED_THREAD_BRIDGES = new Set<string>([...GROUNDING_RELS, "related_to", "contradicts", "affects"]);
// Bridge strength — surface MEANINGFUL cross-thread links first within the cap, so the
// loosest tie (`related_to`, by far the most common) can't crowd out a conflict or shared
// evidence. contradicts (a clash the agent must see) > supports (shared evidence) > affects
// (influence) > related_to (loose topical).
const BRIDGE_STRENGTH: Record<string, number> = { contradicts: 4, supports: 3, affects: 2, related_to: 1 };

function topRankedBlock(db: WorkspaceDB, ids: string[]): Block | null {
  const blocks = ids.map((id) => db.getBlock(id)).filter((b): b is Block => !!b && b.status !== "archived");
  if (blocks.length === 0) return null;
  blocks.sort((a, b) => (CONCLUSION_WEIGHT[b.type] ?? 1) - (CONCLUSION_WEIGHT[a.type] ?? 1) || (b.access_count ?? 0) - (a.access_count ?? 0));
  return blocks[0]!;
}

/**
 * assembleLinkedThreads — Mode 3: the OTHER threads causally linked to this one, so the
 * agent hops thread→thread, not block→block. A "link" is a NON-spine bridge (grounding /
 * related_to / contradicts) from a member of this thread to a block in another thread.
 * Each linked thread is summarized once (deduped) by its origin → top-ranked conclusion,
 * with the bridging relation and a hop handle (its conclusion block). Directly-bridged
 * (distance 1) for now; deeper threads are reachable by navigating into a linked one.
 */
export function assembleLinkedThreads(db: WorkspaceDB, walk: ThreadWalk): LinkedChain[] {
  if (walk.depth.size < 1) return [];
  const threadSet = new Set(walk.depth.keys());
  const rels = db.getAllRelations(false).filter((r) => r.status === "active" && LINKED_THREAD_BRIDGES.has(r.type));

  // First bridge edge to each block OUTSIDE this thread → (outside block id, via relation).
  const bridges = new Map<string, string>();
  for (const r of rels) {
    if (threadSet.has(r.source_id) && !threadSet.has(r.target_id)) { if (!bridges.has(r.target_id)) bridges.set(r.target_id, r.type); }
    else if (threadSet.has(r.target_id) && !threadSet.has(r.source_id)) { if (!bridges.has(r.source_id)) bridges.set(r.source_id, r.type); }
  }
  if (bridges.size === 0) return [];

  // Strongest bridge relations first, so the cap keeps conflicts/evidence over loose ties.
  const orderedBridges = [...bridges.entries()].sort(
    (a, b) => (BRIDGE_STRENGTH[b[1]] ?? 0) - (BRIDGE_STRENGTH[a[1]] ?? 0)
  );

  const seen = new Set<string>(threadSet);
  const out: LinkedChain[] = [];
  for (const [targetId, via] of orderedBridges) {
    if (seen.has(targetId)) continue;                 // already covered by an emitted linked thread
    const w = walkThread(db, targetId);
    for (const id of w.depth.keys()) seen.add(id);     // dedup: many bridges into one thread → one entry
    seen.add(targetId);

    const onThread = w.depth.size >= 2;
    const entry = (onThread ? topRankedBlock(db, w.leaves) : db.getBlock(targetId)) ?? db.getBlock(targetId);
    const origin = (w.origins[0] && db.getBlock(w.origins[0])) || db.getBlock(targetId);
    // A bridge target may itself be a STANDALONE block (linked only by this non-spine
    // edge, no arc of its own) → render its essence once, not "X → X". Only when it's on
    // a real thread do we show origin → conclusion.
    const arc = onThread && origin && entry && origin.id !== entry.id;
    out.push({
      chain:      entry?.label ?? targetId,            // hop handle: workspace_get it to enter (workspace_thread if on an arc)
      essence:    arc ? `${truncEssence(origin!.essence)} → ${truncEssence(entry!.essence)}` : truncEssence(entry?.essence ?? ""),
      conclusion: entry?.essence ?? null,
      distance:   1,
      via,
    });
    if (out.length >= LINKED_CHAINS_CAP) break;
  }
  return out;
}

// ─── The thread engine — walkThread + composeSign ───────────────────────────────
// Serves the "sign that says which path leads where". Two steps: walkThread finds the
// thread the focal block sits on (its spine ancestors → origins, descendants → leaves,
// forks, grounding); composeSign renders the short signpost. Read-only, always current
// (nothing materialized), so it can never go stale.

// Safety valve: reach is unbounded by design (walk the WHOLE thread so the true
// destination is never cut off), but a pathological giant component is capped and
// MARKED — a visible fold ("truncated → more reachable"), never a silent cut.
const THREAD_SAFETY_CAP = 300;

// Mid-path blocks worth showing as waypoints: the ones that change the agent's next
// move (Rule 1: dead-ends + constraints; plus committed decisions, plans, learnings,
// open questions). Plain fact/event steps collapse. Origins + leaves always show.
const WAYPOINT_TYPES = new Set(["dead_end", "constraint", "decision", "blueprint", "insight", "question"]);
// Rank of a destination when capping: how "conclusive" is it, then how used.
const CONCLUSION_WEIGHT: Record<string, number> = { dead_end: 5, constraint: 5, decision: 4, blueprint: 4, insight: 3, question: 3 };
const BRANCH_CAP = 5;

function truncEssence(s: string, n = 80): string {
  const t = (s || "").trim();
  return t.length > n ? t.slice(0, n).trimEnd() + "…" : t;
}

interface ThreadWalk {
  focalId: string;
  depth: Map<string, number>;         // block id → causal depth (neg = cause side, pos = effect side)
  origins: string[];                  // no spine CAUSE within the thread — where it starts
  leaves: string[];                   // no spine EFFECT within the thread — where it ends up
  groundedBy: Map<string, number>;    // block id → # of GROUNDING edges touching it (evidence tags)
  truncated: boolean;
}

/**
 * walkThread — find the thread the focal block sits on, from the SPINE edges only.
 *
 * Direction is uniform across SPINE_RELS: an edge source=EFFECT, target=CAUSE. So
 * walking UP (edges where focal is the source) reaches causes; DOWN (focal is the
 * target) reaches effects. Cycle-safe (visit-once). GROUNDING edges (supports/…) are
 * counted as evidence tags, never followed as steps.
 */
function walkThread(db: WorkspaceDB, focalId: string): ThreadWalk {
  const rels = db.getAllRelations(false).filter((r) => r.status === "active");
  const spine = rels.filter((r) => SPINE_RELS.has(r.type));

  const depth = new Map<string, number>([[focalId, 0]]);
  let truncated = false;
  // UP → causes (target of an edge the focal/current is the source of)
  const up: string[] = [focalId];
  while (up.length) {
    if (depth.size >= THREAD_SAFETY_CAP) { truncated = true; break; }
    const id = up.shift()!;
    const d = depth.get(id)!;
    for (const r of spine) {
      if (r.source_id === id && !depth.has(r.target_id)) { depth.set(r.target_id, d - 1); up.push(r.target_id); }
    }
  }
  // DOWN → effects (source of an edge the focal/current is the target of)
  const down: string[] = [focalId];
  while (down.length) {
    if (depth.size >= THREAD_SAFETY_CAP) { truncated = true; break; }
    const id = down.shift()!;
    const d = depth.get(id)!;
    for (const r of spine) {
      if (r.target_id === id && !depth.has(r.source_id)) { depth.set(r.source_id, d + 1); down.push(r.source_id); }
    }
  }

  // origins = no spine cause in-thread; leaves = no spine effect in-thread.
  const hasCause = new Set<string>();   // this block rests on a cause that's in the thread
  const hasEffect = new Set<string>();  // something in the thread rests on this block
  for (const r of spine) {
    if (depth.has(r.source_id) && depth.has(r.target_id)) { hasCause.add(r.source_id); hasEffect.add(r.target_id); }
  }
  const origins = [...depth.keys()].filter((id) => !hasCause.has(id));
  const leaves = [...depth.keys()].filter((id) => !hasEffect.has(id));

  // grounding: count evidential edges touching each in-thread block (a "backed by" tag).
  const groundedBy = new Map<string, number>();
  for (const r of rels) {
    if (!GROUNDING_RELS.has(r.type)) continue;
    for (const side of [r.source_id, r.target_id]) {
      if (depth.has(side)) groundedBy.set(side, (groundedBy.get(side) ?? 0) + 1);
    }
  }

  return { focalId, depth, origins, leaves, groundedBy, truncated };
}

/**
 * composeSign — render the short signpost from a walked thread.
 *
 * members = the focal's UPSTREAM lineage (origin → focal), bounded — the "came from".
 * leads_to = the ranked, capped DOWNSTREAM destinations (>1 ⇒ forked). Splitting the
 * two keeps the sign short even at a wide fork: a 12-way fork puts 1–2 lines in members
 * and the fan in leads_to (capped), instead of dumping every branch's waypoints. Mid-
 * branch results are reachable by drilling into a destination (the whole-chain fetch).
 * conclusion = the top destination's essence. Each entry carries its LABEL = the hop
 * handle. Returns null for a standalone block (thread < 2) so "loner → empty" holds.
 */
function composeSign(db: WorkspaceDB, walk: ThreadWalk): ChainSummary | null {
  if (walk.depth.size < 2) return null;
  const get = (id: string) => db.getBlock(id);

  // members = the "came from" lineage: origins + upstream (depth ≤ 0) result waypoints
  // + the focal. Downstream (depth > 0) is leads_to, NOT dumped here.
  const lineageIds = new Set<string>(walk.origins);
  for (const [id, d] of walk.depth) {
    if (d > 0) continue; // downstream → leads_to
    const b = get(id);
    if (id === walk.focalId || (b && WAYPOINT_TYPES.has(b.type))) lineageIds.add(id);
  }
  let ordered = [...lineageIds]
    .map((id) => ({ b: get(id), d: walk.depth.get(id)! }))
    .filter((x): x is { b: Block; d: number } => !!x.b && x.b.status !== "archived")
    .sort((a, b) => a.d - b.d); // cause-first
  if (ordered.length === 0) return null;
  // bound the lineage — keep the origin + the steps nearest the focal.
  const LINEAGE_CAP = 8;
  if (ordered.length > LINEAGE_CAP) ordered = [ordered[0]!, ...ordered.slice(ordered.length - (LINEAGE_CAP - 1))];

  // Destinations = leaves OTHER than the focal, ranked by how conclusive then how used, capped.
  const rankedLeaves = walk.leaves
    .filter((id) => id !== walk.focalId)
    .map((id) => get(id))
    .filter((b): b is Block => !!b && b.status !== "archived")
    .map((b) => ({ label: b.label, type: b.type, essence: b.essence || "", w: CONCLUSION_WEIGHT[b.type] ?? 1, a: b.access_count ?? 0 }))
    .sort((x, y) => y.w - x.w || y.a - x.a);
  const shown = rankedLeaves.slice(0, BRANCH_CAP);
  const moreLeaves = Math.max(0, rankedLeaves.length - BRANCH_CAP);

  let backed = 0;
  for (const c of walk.groundedBy.values()) backed += c;

  const members = ordered.map((x) => ({ label: x.b.label, type: x.b.type, essence: x.b.essence || "" }));
  const origin = ordered[0]!.b;
  // Terminal = there's nothing downstream to navigate to (and we didn't hit the safety
  // cap) — so an empty leads_to reads as "you're at the end of this thread", not
  // "missing". Reader-honest: covers the focal-is-a-leaf case AND the case where the
  // only downstream leaves are archived/gone.
  const isTerminal = shown.length === 0 && !walk.truncated;
  const topLeaf = shown[0] ?? { essence: ordered[ordered.length - 1]!.b.essence || "" };

  return {
    label: null,
    mechanical: true,
    essence: `${truncEssence(origin.essence)} → ${truncEssence(topLeaf.essence)}`,
    arc: ordered.map((x) => truncEssence(x.b.essence, 60)).join("  →  "),
    conclusion: topLeaf.essence || null,
    members,
    leads_to: shown.map(({ label, type, essence }) => ({ label, type, essence })),
    ...(moreLeaves > 0 ? { more_leaves: moreLeaves } : {}),
    ...(backed > 0 ? { backed_by: backed } : {}),
    ...(walk.leaves.length > 1 ? { forked: true } : {}),
    ...(walk.truncated ? { truncated: true } : {}),
    ...(isTerminal ? { terminal: true } : {}),
  };
}

export interface FullThread {
  focal: string;                 // focal block's label
  count: number;                 // # members in the whole thread
  origins: string[];             // labels where the thread starts
  leaves: string[];              // labels where it ends up (the destinations)
  truncated: boolean;            // hit the walk safety-cap → more members reachable
  // ALL members, spine-ordered (cause→effect), FULL essence — "read the whole thread
  // in ONE call" instead of N block-by-block hops. role situates each; backed_by tags
  // the evidence. This is Mode 2 (the whole-chain read); the SIGN (Mode 1) is the short
  // signpost you read to decide whether to fetch this.
  members: Array<{
    label: string;
    type: string;
    essence: string;
    role: "origin" | "focal" | "leaf" | "step";
    backed_by?: number;
  }>;
}

/**
 * assembleFullThread — Mode 2: the whole thread a block sits on, in one call.
 *
 * The SIGN (composeSign) is the short "origin → destinations" you read to CHOOSE a
 * thread. Once chosen, this returns the ENTIRE thread — every member, spine-ordered,
 * with full essences + grounding tags — so the agent reads the reasoning without N
 * block-by-block hops (chain-as-unit traversal). Computed live from the spine, so it is
 * always current. Returns null for a standalone block (thread < 2).
 *
 * Order = causal depth (cause-first), ties broken by created_at (a topo proxy — exact
 * for a line, good enough for a DAG). Bounded by walkThread's safety cap (`truncated`).
 */
export function assembleFullThread(db: WorkspaceDB, blockId: string): FullThread | null {
  const walk = walkThread(db, blockId);
  if (walk.depth.size < 2) return null;

  const originSet = new Set(walk.origins);
  const leafSet = new Set(walk.leaves);
  const rows = [...walk.depth.entries()]
    .map(([id, d]) => ({ b: db.getBlock(id), d }))
    .filter((x): x is { b: Block; d: number } => !!x.b && x.b.status !== "archived")
    .sort((a, b) => a.d - b.d || String(a.b.created_at).localeCompare(String(b.b.created_at)));
  if (rows.length < 2) return null;

  const label = (id: string) => db.getBlock(id)?.label ?? id;
  const members = rows.map(({ b }) => {
    const role: "origin" | "focal" | "leaf" | "step" =
      b.id === blockId ? "focal"
      : originSet.has(b.id) ? "origin"
      : leafSet.has(b.id) ? "leaf"
      : "step";
    const g = walk.groundedBy.get(b.id);
    return { label: b.label, type: b.type, essence: b.essence || "", role, ...(g ? { backed_by: g } : {}) };
  });

  return {
    focal: label(blockId),
    count: members.length,
    origins: walk.origins.map(label),
    leaves: walk.leaves.map(label),
    truncated: walk.truncated,
    members,
  };
}

/**
 * orderMembersCausally — order a chain's member blocks by the CHAIN'S FLOW (cause → effect),
 * not by created_at. Verified against the real dogfood graph: created_at order disagreed with
 * causal order in 20/20 chains (a decision/conclusion routinely sorted FIRST by creation time),
 * and the chain blocks carry no stored member order — so the only faithful source of flow is a
 * topological sort over the SPINE edges. Ties (multiple roots / a DAG) break by created_at for
 * determinism. Cycle-safe (leftovers appended). Used by every chain-member read path.
 */
export function orderMembersCausally(db: WorkspaceDB, members: Block[]): Block[] {
  if (members.length < 2) return members;
  const ids = new Set(members.map((m) => m.id));
  const byId = new Map(members.map((m) => [m.id, m]));
  const spine = db.getAllRelations(false).filter(
    (r) => r.status === "active" && SPINE_RELS.has(r.type) && ids.has(r.source_id) && ids.has(r.target_id),
  );
  // Directed cause → effect: a spine edge is source=EFFECT, target=CAUSE, so target → source.
  const next = new Map<string, string[]>(members.map((m) => [m.id, []]));
  const indeg = new Map<string, number>(members.map((m) => [m.id, 0]));
  for (const r of spine) { next.get(r.target_id)!.push(r.source_id); indeg.set(r.source_id, (indeg.get(r.source_id) ?? 0) + 1); }

  const byCreated = (a: string, b: string) => String(byId.get(a)!.created_at).localeCompare(String(byId.get(b)!.created_at));
  const ready = members.filter((m) => (indeg.get(m.id) ?? 0) === 0).map((m) => m.id).sort(byCreated);
  const seen = new Set<string>();
  const order: Block[] = [];
  while (ready.length) {
    const id = ready.shift()!;
    if (seen.has(id)) continue;
    seen.add(id); order.push(byId.get(id)!);
    const unlocked: string[] = [];
    for (const y of next.get(id) ?? []) { indeg.set(y, (indeg.get(y) ?? 1) - 1); if ((indeg.get(y) ?? 0) <= 0 && !seen.has(y)) unlocked.push(y); }
    ready.push(...unlocked); ready.sort(byCreated); // keep deterministic cause-first tie-break
  }
  for (const m of members) if (!seen.has(m.id)) order.push(m); // cycle leftover
  return order;
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
