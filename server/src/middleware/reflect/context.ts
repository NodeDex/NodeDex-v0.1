import { EmbeddingEngine } from "../../engine/embeddings.js";
import { cosineSim } from "../../engine/vector-math.js";
import { CONFIG } from "./config.js";
import type { Pass1Item, Pass2Item } from "./types.js";

// ─── Token usage accumulator ──────────────────────────────────────────────────
// Slots cover: original monolith passes (pass0-pass4) + the Pass 2 split
// sub-passes (pass2a/b/c, populated only when NODEDEX_PASS2_SPLIT=1).
// When the flag is OFF, the split slots stay at 0; when ON, the monolith
// `pass2` slot stays at 0 and the sub-pass slots accumulate. This lets the
// turn log surface BOTH paths' usage independently without ambiguity.
//
// Per PASS2-SPLIT-DESIGN.md §7, this is the substrate for per-pass cost
// telemetry. Token counts are tracked here; $$ cost is derived elsewhere
// (provider-specific pricing). All 10 slots (0/1/judge/2/2a/2b/2c/3/4/5) are
// now present (debt-4 §3 uniform observability — pass5 slot added 2026-05-29).
// Pre-fix, pass5 token counts were mis-attributed into reflectTokenStats.pass4
// (see pass5.ts comment "lightweight, no separate counter needed" — empirically
// FALSE: pass5 wall_ms is ~5-12s and it bills thinking_budget=512). Inflated
// pass4 cost, hid pass5 from cost_breakdown → confabulated total_usd.
export const reflectTokenStats = {
  pass0:      { input: 0, thinking: 0, output: 0, calls: 0 },
  pass1:      { input: 0, thinking: 0, output: 0, calls: 0 },
  pass_judge: { input: 0, thinking: 0, output: 0, calls: 0 },
  pass2:      { input: 0, thinking: 0, output: 0, calls: 0 },
  pass2a: { input: 0, thinking: 0, output: 0, calls: 0 },
  pass2b: { input: 0, thinking: 0, output: 0, calls: 0 },
  pass2c: { input: 0, thinking: 0, output: 0, calls: 0 },
  pass3:  { input: 0, thinking: 0, output: 0, calls: 0 },
  pass4:  { input: 0, thinking: 0, output: 0, calls: 0 },
  pass5:  { input: 0, thinking: 0, output: 0, calls: 0 },
  // DEBT 5 Slice 1 Sub-step 1.2 — Stage C (arc entity resolve) runs once per
  // arc trigger BEFORE Pass 2-5. Its own telemetry slot avoids the cost-mis-
  // attribution pattern the pass5 fix addressed (commit 742f50d). Empty in
  // non-arc runs + when arc-entity-resolve fails before LLM call.
  pass_c_resolve: { input: 0, thinking: 0, output: 0, calls: 0 },
  // DEBT 5 Slice 3 (Stage D) — cross-graph resolve runs once per arc trigger
  // AFTER Stage C, BEFORE Pass 3. Own slot (same rationale as pass_c_resolve:
  // avoid cost mis-attribution). Empty in non-arc runs + when Stage D resolves
  // everything via the code-exact path (no LLM call).
  pass_d_resolve: { input: 0, thinking: 0, output: 0, calls: 0 },
  // DEBT 5 Slice 2 Sub-step 2.2 — async flag-reviewer runs OUTSIDE the
  // per-pipeline trigger (its own setInterval worker, env-gated). Cost is
  // billed to its own slot so per-pipeline cost_breakdown stays honest about
  // just-that-pipeline-run's spend. Reviewer cost is an ENRICHMENT-CYCLE
  // cost — different temporal grain than pipeline cost. Surfaced separately
  // via per-tick log + (future) /api/flags/cost endpoint.
  pass_reviewer: { input: 0, thinking: 0, output: 0, calls: 0 },
  reset() {
    this.pass0  = { input: 0, thinking: 0, output: 0, calls: 0 };
    this.pass1  = { input: 0, thinking: 0, output: 0, calls: 0 };
    this.pass_judge = { input: 0, thinking: 0, output: 0, calls: 0 };
    this.pass2  = { input: 0, thinking: 0, output: 0, calls: 0 };
    this.pass2a = { input: 0, thinking: 0, output: 0, calls: 0 };
    this.pass2b = { input: 0, thinking: 0, output: 0, calls: 0 };
    this.pass2c = { input: 0, thinking: 0, output: 0, calls: 0 };
    this.pass3  = { input: 0, thinking: 0, output: 0, calls: 0 };
    this.pass4  = { input: 0, thinking: 0, output: 0, calls: 0 };
    this.pass5  = { input: 0, thinking: 0, output: 0, calls: 0 };
    this.pass_c_resolve = { input: 0, thinking: 0, output: 0, calls: 0 };
    this.pass_d_resolve = { input: 0, thinking: 0, output: 0, calls: 0 };
    // Note: pass_reviewer NOT reset here — pipeline reset() runs per-turn
    // but the reviewer is async/global-grain. Reviewer module manages its
    // own per-tick read-and-clear if needed.
  },
};

// ─── Embedding stats ───────────────────────────────────────────────────────────
// debt-4 Stage A (foundations) — embedding API calls were a HIDDEN time tax,
// invisible to cost_breakdown. ~100+ sequential embedding calls per
// moderate-sized turn at ~300ms each. Tracking here so the turn-log can
// surface the unaccounted time AND so Stage B (batching) has a measurement
// baseline to prove against.
//
// Slots: same shape pattern as reflectTokenStats.
// calls       — count of embed() invocations this turn
// ms_total    — sum of wall-time spent in embed() (sequential)
// input_chars — sum of input string lengths (cheap proxy for input tokens
//               since embeddings tokenize roughly 1 token per 4 chars)
// estimated_usd — rough cost using gemini-embedding-001 at $0.00015/1k chars
//                 (placeholder; real pricing is per-token at $0.15/M output
//                 tokens, but embeddings are output-tokens-only so the
//                 estimate is roughly chars/4 → tokens → /1M × $0.15)
export const embeddingStats = {
  calls: 0,
  ms_total: 0,
  input_chars: 0,
  reset() {
    this.calls = 0;
    this.ms_total = 0;
    this.input_chars = 0;
  },
};

// ─── Context builder constants ────────────────────────────────────────────────
const HIGH_SIGNAL_TYPES = new Set(["decision", "dead_end", "constraint", "blueprint"]);
const ANCHOR_TYPES      = new Set(["dead_end", "constraint"]); // always sent to Pass 2 regardless of relevance

// ─── buildProjectContext ──────────────────────────────────────────────────────
/**
 * Build a tiered project context for Gemini.
 *
 * Tier 1 — active project (inferred from loadedBlockIds label prefixes):
 *   High-signal types (decision, dead_end, constraint, blueprint):
 *     full detail — label + ID + essence + relations (dedup + causal linking)
 *   All other types:
 *     label + essence only — enough for dedup, no relations noise
 *
 * Tier 2 — other projects:
 *   High-signal types: label + essence (catches fuzzy dedup across projects)
 *   Everything else:   label only (routing signal for affects relations)
 */
export function buildProjectContext(
  allBlocks: any[],
  allRels: any[],
  allProjectPrefixes: Set<string>,
  loadedBlockIds: string[] = [],
): { context: string; reflectedIds: string[] } {
  const blockById = new Map(allBlocks.map((b) => [b.id, b]));

  // Infer active project prefixes from loaded block labels
  const activeProjectPrefixes = new Set<string>();
  for (const id of loadedBlockIds) {
    const b = blockById.get(id);
    if (!b) continue;
    const prefix = (b.label || "").split("_")[0];
    if (allProjectPrefixes.has(prefix)) activeProjectPrefixes.add(prefix);
  }
  // Fallback: if no loaded blocks touched a known project, use all prefixes
  if (activeProjectPrefixes.size === 0) {
    for (const p of allProjectPrefixes) activeProjectPrefixes.add(p);
  }

  // Build relation map (skip part_of — not useful for Gemini context)
  const relMap = new Map<string, Array<{ type: string; targetLabel: string }>>();
  for (const rel of allRels) {
    if (rel.status !== "active" || rel.type === "part_of") continue;
    const target = blockById.get(rel.target_id);
    if (!target) continue;
    if (!relMap.has(rel.source_id)) relMap.set(rel.source_id, []);
    relMap.get(rel.source_id)!.push({ type: rel.type, targetLabel: target.label });
  }

  const lines: string[] = [];
  const reflectedIds: string[] = [];

  // ── Tier 1: Active project ────────────────────────────────────────────────
  const activeBlocks = allBlocks.filter(
    (b) => b.type !== "project" && activeProjectPrefixes.has((b.label || "").split("_")[0]),
  );

  if (activeBlocks.length > 0) {
    const TYPE_ORDER = ["decision", "dead_end", "constraint", "blueprint", "fact", "insight", "entity", "process"];
    const groups = new Map<string, any[]>();
    for (const b of activeBlocks) {
      if (!groups.has(b.type)) groups.set(b.type, []);
      groups.get(b.type)!.push(b);
    }
    const orderedTypes = [...new Set([...TYPE_ORDER, ...groups.keys()])];
    for (const type of orderedTypes) {
      const blocks = groups.get(type);
      if (!blocks || blocks.length === 0) continue;
      lines.push(`[${type}s]`);
      for (const b of blocks) {
        reflectedIds.push(b.id); // stamp all Tier 1 blocks as reflected
        if (HIGH_SIGNAL_TYPES.has(type)) {
          // Full detail: label + ID + essence + unique{} values + relations
          const rels = relMap.get(b.id) ?? [];
          const relStr = rels.length > 0
            ? `\n    relations: ${rels.map((r) => `${r.type}→${r.targetLabel}`).join(", ")}`
            : "";
          let uniqueStr = "";
          try {
            const c = typeof b.content === "string" ? JSON.parse(b.content) : b.content;
            const u = c?.unique ?? {};
            const pairs = Object.entries(u)
              .filter(([, v]) => v && String(v).trim())
              .map(([k, v]) => `${k}: "${String(v).slice(0, 80)}"`)
              .slice(0, 4);
            if (pairs.length > 0) uniqueStr = `\n    unique: { ${pairs.join(", ")} }`;
          } catch { /* skip malformed content */ }
          lines.push(`  ${b.label} | ${b.id} — "${b.essence || ""}"${uniqueStr}${relStr}`);
        } else {
          lines.push(`  ${b.label} — "${(b.essence || "").slice(0, 100)}"`);
        }
      }
      lines.push("");
    }
  }

  // ── Tier 2: Other projects ────────────────────────────────────────────────
  const otherBlocks = allBlocks.filter(
    (b) => b.type !== "project"
      && !activeProjectPrefixes.has((b.label || "").split("_")[0]),
  );

  if (otherBlocks.length > 0) {
    const otherHighSignal = otherBlocks.filter((b) => HIGH_SIGNAL_TYPES.has(b.type));
    const otherRest       = otherBlocks.filter((b) => !HIGH_SIGNAL_TYPES.has(b.type));

    if (otherHighSignal.length > 0) {
      lines.push("[other projects — decisions/constraints/dead_ends (essence for dedup)]");
      for (const b of otherHighSignal) {
        reflectedIds.push(b.id); // stamp Tier 2 high-signal blocks as reflected
        lines.push(`  ${b.label} — "${(b.essence || "").slice(0, 100)}"`);
      }
      lines.push("");
    }
    if (otherRest.length > 0) {
      lines.push("[other projects — label only, use for affects relations]");
      for (const b of otherRest) lines.push(`  ${b.label}`);
      lines.push("");
    }
  }

  return { context: lines.join("\n"), reflectedIds };
}

// ─── buildPreSearchContext ────────────────────────────────────────────────────
// Targeted context for Pass 2. Replaces full block dump with:
// project roots + anchors (dead_ends/constraints) + per-item semantic candidates.
export async function buildPreSearchContext(
  items: Pass1Item[],
  allBlocks: any[],
  allRels: any[],
  knownRoots: { label: string; essence: string }[],
  embeddings: EmbeddingEngine | null,
  activeProjectPrefixes: Set<string>,
): Promise<string> {
  const activeProject = [...activeProjectPrefixes][0] || "";

  const lines: string[] = ["[PROJECTS IN THIS GRAPH]"];
  for (const root of knownRoots) {
    lines.push(`  ${root.label} — "${root.essence}"`);
  }
  lines.push(`\n[ACTIVE PROJECT: ${activeProject || "unknown"}]\n`);

  // Relation map
  const blockById = new Map(allBlocks.map((b: any) => [b.id, b]));
  const relMap = new Map<string, Array<{ type: string; targetLabel: string }>>();
  for (const rel of allRels) {
    if (rel.status !== "active" || rel.type === "part_of") continue;
    const target = blockById.get(rel.target_id);
    if (!target) continue;
    if (!relMap.has(rel.source_id)) relMap.set(rel.source_id, []);
    relMap.get(rel.source_id)!.push({ type: rel.type, targetLabel: target.label });
  }

  // Active project blocks only
  const projectBlocks = allBlocks.filter((b: any) => {
    if (b.type === "project" || b.status === "archived") return false;
    const prefix = (b.label || "").split("_")[0];
    return activeProjectPrefixes.has(prefix);
  });

  const formatBlock = (b: any, includeRelations = false): string => {
    let uniqueStr = "";
    try {
      const c = typeof b.content === "string" ? JSON.parse(b.content) : b.content;
      const u = c?.unique ?? {};
      const pairs = Object.entries(u)
        .filter(([, v]) => v && String(v).trim())
        .map(([k, v]) => `${k}: "${String(v).slice(0, 80)}"`)
        .slice(0, 3);
      if (pairs.length > 0) uniqueStr = `\n    unique: { ${pairs.join(", ")} }`;
    } catch { /* skip */ }
    const rels = includeRelations ? (relMap.get(b.id) ?? []) : [];
    const relStr = rels.length > 0 ? `\n    relations: ${rels.map((r) => `${r.type}→${r.targetLabel}`).join(", ")}` : "";
    return `  ${b.label} | ${b.id} — "${b.essence || ""}"${uniqueStr}${relStr}`;
  };

  // Anchor layer: all dead_ends + constraints (always present)
  const anchors = projectBlocks.filter((b: any) => ANCHOR_TYPES.has(b.type));
  if (anchors.length > 0) {
    lines.push("[anchor blocks — always included: dead_ends + constraints]");
    for (const b of anchors) lines.push(formatBlock(b, true));
    lines.push("");
  }

  const includedIds = new Set<string>(anchors.map((b: any) => b.id));
  const anchorIds = new Set<string>(anchors.map((b: any) => b.id));
  const nonAnchorBlocks = projectBlocks.filter((b: any) => !anchorIds.has(b.id));

  const candidateLines: string[] = [];

  // Semantic candidates: one best-match per item
  if (embeddings?.isAvailable() && nonAnchorBlocks.length > 0) {
    for (const item of items) {
      const vec = await embeddings.embed(item.text).catch(() => null);
      if (!vec) continue;
      let best: { sim: number; block: any } | null = null;
      for (const block of nonAnchorBlocks) {
        if (includedIds.has(block.id) || !block.embedding) continue;
        try {
          const blockVec = JSON.parse(block.embedding) as number[];
          const sim = cosineSim(vec, blockVec);
          if (sim >= CONFIG.preSearch.semanticMatchThreshold && (!best || sim > best.sim)) best = { sim, block };
        } catch { /* skip */ }
      }
      if (best) {
        includedIds.add(best.block.id);
        candidateLines.push(formatBlock(best.block, true));
      }
    }
  }

  // Also always include recent decisions (last 3 sessions worth — for supersedes detection)
  const recentDecisions = projectBlocks
    .filter((b: any) => b.type === "decision" && !includedIds.has(b.id) && !anchorIds.has(b.id))
    .sort((a: any, b: any) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
    .slice(0, CONFIG.preSearch.recentDecisionsLimit);
  for (const b of recentDecisions) {
    includedIds.add(b.id);
    candidateLines.push(formatBlock(b, false));
  }

  if (candidateLines.length > 0) {
    lines.push("[related blocks — matched to current items + recent decisions]");
    lines.push(...candidateLines);
    lines.push("");
  }

  // Conflict candidates: existing decisions/blueprints that dead_end items may supersede
  const conflictSection = await buildConflictCandidates(items, allBlocks, embeddings);
  if (conflictSection) lines.push(conflictSection);

  return lines.join("\n");
}

// ─── buildItemContext ─────────────────────────────────────────────────────────
/**
 * For each Pass 2 classified item, find the closest existing block in the graph
 * and render a mini-narrative: the block + its 1-hop causal neighborhood.
 *
 * This gives Pass 3 the story behind each candidate match — not just "block exists"
 * but what caused it, what it led to, and whether it is still active.
 *
 * Priority order for candidate lookup per item:
 *   1. supersedes_ref (exact label pointer from Pass 2)
 *   2. extends_item target (if set and resolves to a block label)
 *   3. Cosine similarity search (threshold 0.72, same as buildPreSearchContext)
 */
export async function buildItemContext(
  classified: Pass2Item[],
  allBlocks: any[],
  allRels: any[],
  embeddings: EmbeddingEngine | null,
): Promise<Record<string, string>> {
  const blockByLabel = new Map(allBlocks.map((b: any) => [b.label, b]));
  const blockById    = new Map(allBlocks.map((b: any) => [b.id, b]));

  // Build outgoing and incoming relation maps
  const outgoing = new Map<string, Array<{ type: string; targetLabel: string; targetEssence: string; targetType: string }>>();
  const incoming = new Map<string, Array<{ type: string; sourceLabel: string; sourceEssence: string; sourceType: string }>>();
  const CAUSAL_TYPES = new Set(["prompted_by", "based_on", "supersedes", "extends", "derived_from"]);
  for (const rel of allRels) {
    if (rel.status !== "active") continue;
    const src = blockById.get(rel.source_id);
    const tgt = blockById.get(rel.target_id);
    if (!src || !tgt) continue;
    if (CAUSAL_TYPES.has(rel.type)) {
      if (!outgoing.has(rel.source_id)) outgoing.set(rel.source_id, []);
      outgoing.get(rel.source_id)!.push({ type: rel.type, targetLabel: tgt.label, targetEssence: (tgt.essence || "").slice(0, 80), targetType: tgt.type });
      if (!incoming.has(rel.target_id)) incoming.set(rel.target_id, []);
      incoming.get(rel.target_id)!.push({ type: rel.type, sourceLabel: src.label, sourceEssence: (src.essence || "").slice(0, 80), sourceType: src.type });
    }
  }

  // Check if any newer block supersedes a given block
  const isSuperseded = new Set<string>();
  for (const rel of allRels) {
    if (rel.status === "active" && rel.type === "supersedes") isSuperseded.add(rel.target_id);
  }

  const renderNeighborhood = (block: any): string => {
    const lines: string[] = [
      `EXISTING BLOCK: ${block.label} [${block.type}]`,
      `  "${(block.essence || "").slice(0, 120)}"`,
    ];

    const inc = incoming.get(block.id) ?? [];
    if (inc.length === 0) {
      lines.push(`  Preceded by: (founding block — no causal predecessors)`);
    } else {
      lines.push(`  Preceded by:`);
      for (const r of inc.slice(0, 4)) {
        lines.push(`    ← ${r.sourceLabel} [${r.sourceType}] via ${r.type} — "${r.sourceEssence}"`);
      }
    }

    const out = (outgoing.get(block.id) ?? []).filter(r => r.type !== "part_of");
    if (out.length > 0) {
      for (const r of out.slice(0, 3)) {
        lines.push(`  ${r.type}→ ${r.targetLabel} [${r.targetType}]`);
      }
    }

    if (isSuperseded.has(block.id)) {
      lines.push(`  Superseded by: YES — this block has been replaced by a newer block`);
    } else {
      lines.push(`  Superseded by: (none — currently active)`);
    }

    // Summarise the story arc
    const arcParts = [...inc.map(r => r.sourceType), block.type];
    lines.push(`  Story arc: ${arcParts.join(" → ")}`);

    return lines.join("\n");
  };

  const result: Record<string, string> = {};
  const embeddingAvailable = embeddings?.isAvailable() && allBlocks.some((b: any) => b.embedding);
  const highSignal = allBlocks.filter((b: any) => HIGH_SIGNAL_TYPES.has(b.type) && b.type !== "project");

  for (const item of classified) {
    let candidate: any = null;

    // Priority 1: exact label from supersedes_ref
    if (item.supersedes_ref) {
      candidate = blockByLabel.get(item.supersedes_ref) ?? null;
    }

    // Priority 2: extends_item — resolve the item id to a block label via classified batch
    // (extends_item is an item ID not a block label; skip if not resolvable to a block)
    // This is intentionally lightweight — we just ensure the supersedes path is captured above.

    // Priority 3: cosine similarity
    if (!candidate && embeddingAvailable) {
      const vec = await embeddings!.embed(item.text).catch(() => null);
      if (vec) {
        let bestSim = CONFIG.preSearch.semanticMatchThreshold;
        for (const block of highSignal) {
          if (!block.embedding) continue;
          try {
            const blockVec = JSON.parse(block.embedding) as number[];
            const sim = cosineSim(vec, blockVec);
            if (sim > bestSim) { bestSim = sim; candidate = block; }
          } catch { /* skip */ }
        }
      }
    }

    result[item.id] = candidate
      ? renderNeighborhood(candidate)
      : "(no existing match — create new block)";
  }

  return result;
}

// ─── buildConflictCandidates ──────────────────────────────────────────────────
/**
 * For each dead_end item from Pass 1, find existing decision/blueprint blocks
 * that are likely being superseded. Uses two-step lookup:
 *   1. Label substring search on key nouns (deterministic, uses naming convention)
 *   2. Embedding similarity fallback (threshold 0.85, only if step 1 finds nothing)
 *
 * For each match found, also looks up the block's chain membership to give
 * Pass 2 the full causal arc context.
 *
 * Returns a formatted string ready for injection into Pass 2 context, or "" if none.
 */
export async function buildConflictCandidates(
  items: Pass1Item[],
  allBlocks: any[],
  embeddings: EmbeddingEngine | null,
): Promise<string> {
  const deadEndItems = items.filter(i => i.provisional_type === "dead_end");
  if (deadEndItems.length === 0) return "";

  const SUPERSEDABLE_TYPES = new Set(["decision", "blueprint"]);
  const candidates = allBlocks.filter(b => SUPERSEDABLE_TYPES.has(b.type) && b.status !== "archived");
  if (candidates.length === 0) return "";

  // Build chain membership map: blockId → chain block
  const chainBlocks = allBlocks.filter(b => b.type === "chain");
  const blockIdToChain = new Map<string, any>();
  for (const chain of chainBlocks) {
    try {
      const content = typeof chain.content === "string" ? JSON.parse(chain.content) : chain.content;
      const memberLabels: string[] = content?.unique?.members ?? content?.members ?? [];
      for (const memberLabel of memberLabels) {
        const member = allBlocks.find(b => b.label === memberLabel);
        if (member) blockIdToChain.set(member.id, chain);
      }
    } catch { /* skip malformed chain content */ }
  }
  // Also use chain_id stamp on blocks directly
  for (const block of allBlocks) {
    if (block.chain_id && !blockIdToChain.has(block.id)) {
      const chainBlock = allBlocks.find(b => b.id === block.chain_id);
      if (chainBlock) blockIdToChain.set(block.id, chainBlock);
    }
  }

  // Extract key nouns from text — words 4+ chars, not stop words
  const STOP = new Set(["this","that","with","from","have","been","will","were","they","their","would","could","should","when","then","also","into","over","under","about","after","before","there","here","just","more","some","such","than","very","what","which","while","these","those","where","both","only","well"]);
  const extractNouns = (text: string): string[] => {
    return text.toLowerCase()
      .replace(/[^a-z0-9\s-]/g, " ")
      .split(/\s+/)
      .filter(w => w.length >= 4 && !STOP.has(w));
  };

  const formatCandidate = (item: Pass1Item, block: any, matchType: "label" | "semantic", sim?: number): string => {
    let uniqueStr = "";
    try {
      const c = typeof block.content === "string" ? JSON.parse(block.content) : block.content;
      const u = c?.unique ?? {};
      const pairs = Object.entries(u)
        .filter(([, v]) => v && String(v).trim())
        .map(([k, v]) => `${k}: "${String(v).slice(0, 80)}"`)
        .slice(0, 3);
      if (pairs.length > 0) uniqueStr = `\n      unique: { ${pairs.join(", ")} }`;
    } catch { /* skip */ }

    const chainBlock = blockIdToChain.get(block.id);
    let chainStr = "";
    if (chainBlock) {
      try {
        const c = typeof chainBlock.content === "string" ? JSON.parse(chainBlock.content) : chainBlock.content;
        const members: string[] = c?.unique?.members ?? c?.members ?? [];
        const arc = c?.unique?.arc ?? "";
        if (members.length > 0) {
          chainStr = `\n      part of chain: ${chainBlock.label}` +
            (arc ? ` (arc: ${arc})` : "") +
            `\n        members: ${members.join(" → ")}`;
        }
      } catch { /* skip */ }
    }

    const confidence = matchType === "label" ? "label match" : `semantic match ${Math.round((sim ?? 0) * 100)}%`;
    return `  item ${item.id} [dead_end] "${item.text.slice(0, 70)}"\n` +
      `    → may supersede: ${block.label} [${block.type}] (${confidence})\n` +
      `      essence: "${(block.essence || "").slice(0, 120)}"${uniqueStr}${chainStr}`;
  };

  const SEMANTIC_THRESHOLD = 0.85;
  const sections: string[] = [];

  for (const item of deadEndItems) {
    const nouns = extractNouns(item.text);
    let matched: any = null;
    let matchType: "label" | "semantic" = "label";
    let matchSim: number | undefined;

    // Step 1: label substring search
    for (const noun of nouns) {
      const found = candidates.find(b => b.label.includes(noun));
      if (found) { matched = found; break; }
    }

    // Step 2: embedding fallback
    if (!matched && embeddings?.isAvailable()) {
      const vec = await embeddings.embed(item.text).catch(() => null);
      if (vec) {
        let bestSim = SEMANTIC_THRESHOLD;
        for (const block of candidates) {
          if (!block.embedding) continue;
          try {
            const blockVec = JSON.parse(block.embedding) as number[];
            const sim = cosineSim(vec, blockVec);
            if (sim > bestSim) { bestSim = sim; matched = block; matchSim = sim; }
          } catch { /* skip */ }
        }
        if (matched) matchType = "semantic";
      }
    }

    if (matched) {
      sections.push(formatCandidate(item, matched, matchType, matchSim));
    }
  }

  if (sections.length === 0) return "";
  return `[POTENTIAL SUPERSEDES CANDIDATES — dead_end items may replace these existing blocks]\n` +
    `  Verify by reading content. If the item is replacing this block → set supersedes_ref to the EXACT label shown.\n` +
    sections.join("\n\n") + "\n";
}

// ─── Dedup helpers ────────────────────────────────────────────────────────────


export const DEDUP_HIGH_SIGNAL = new Set(["decision", "constraint", "dead_end", "blueprint"]);

export async function buildDuplicateAlerts(
  items: Pass2Item[],
  existingBlocks: any[],
  embeddings: EmbeddingEngine,
): Promise<string> {
  const candidates = existingBlocks.filter(
    (b) => b.type !== "project" && DEDUP_HIGH_SIGNAL.has(b.type) && b.embedding,
  );
  if (candidates.length === 0) return "";

  const RELATED_SIM_LOW  = 0.72;
  const RELATED_SIM_HIGH = CONFIG.dedup.defaultThreshold; // 0.88

  const strongAlerts: string[] = [];
  const relatedAlerts: string[] = [];

  for (const item of items) {
    if (!DEDUP_HIGH_SIGNAL.has(item.type)) continue;
    const vec = await embeddings.embed(item.text);
    if (!vec) continue;

    let bestStrongSim = 0;
    let bestStrongBlock: any = null;
    let bestRelatedSim = 0;
    let bestRelatedBlock: any = null;

    for (const block of candidates) {
      if (block.type !== item.type) continue; // only same-type comparisons
      try {
        const blockVec = JSON.parse(block.embedding) as number[];
        const sim = cosineSim(vec, blockVec);
        if (sim >= RELATED_SIM_HIGH && sim > bestStrongSim) {
          bestStrongSim = sim;
          bestStrongBlock = block;
        } else if (sim >= RELATED_SIM_LOW && sim < RELATED_SIM_HIGH && sim > bestRelatedSim) {
          bestRelatedSim = sim;
          bestRelatedBlock = block;
        }
      } catch { /* skip malformed embedding */ }
    }

    const snippet = item.text.length > 80 ? item.text.slice(0, 80) + "..." : item.text;

    if (bestStrongBlock) {
      const pct = Math.round(bestStrongSim * 100);
      strongAlerts.push(
        `  Item [type:${item.type}]: "${snippet}"\n` +
        `  → ${pct}% similar to existing block: ${bestStrongBlock.label}\n` +
        `       essence: "${(bestStrongBlock.essence || "").slice(0, 120)}"\n` +
        `  → Same concept? Put in updates[], not new_blocks[]. Genuinely different? Explain in novelty_reason.`,
      );
    } else if (bestRelatedBlock) {
      const pct = Math.round(bestRelatedSim * 100);
      relatedAlerts.push(
        `  Item [type:${item.type}]: "${snippet}"\n` +
        `  → ${pct}% related to existing block: ${bestRelatedBlock.label}\n` +
        `       essence: "${(bestRelatedBlock.essence || "").slice(0, 120)}"\n` +
        `  → Specialization or extension? Add { "type": "extends", "target_id": "${bestRelatedBlock.label}" } to the new block's relations[].`,
      );
    }
  }

  const parts: string[] = [];
  if (strongAlerts.length > 0) {
    console.log(`Auto-Reflect: ${strongAlerts.length} strong duplicate(s) flagged for Pass 3`);
    parts.push(`⚠ POTENTIAL DUPLICATE ALERTS — check these before creating new blocks:\n${strongAlerts.join("\n\n")}`);
  }
  if (relatedAlerts.length > 0) {
    console.log(`Auto-Reflect: ${relatedAlerts.length} related block(s) flagged for Pass 3 (extends candidates)`);
    parts.push(`⚠ RELATED BLOCK ALERTS — these items overlap with existing blocks but are likely specializations:\n${relatedAlerts.join("\n\n")}`);
  }
  if (parts.length === 0) return "";
  return parts.join("\n\n") + "\n\n";
}
