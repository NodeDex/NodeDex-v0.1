// ═══════════════════════════════════════════════════════════════════════════════
// PASS 4 — SLICE BUILDER (production gap ⑤: scale — replace the full-graph dump)
// ═══════════════════════════════════════════════════════════════════════════════
//
// WHAT IT DOES
//   Builds the PROJECT GRAPH context Pass 4 reasons over — but as a RETRIEVED
//   SLICE instead of buildProjectContext's whole-graph dump. Pass 4's job is
//   unchanged (link this-turn's new blocks to existing blocks BY MEANING); this
//   only changes WHAT it sees, never HOW it decides. The slice is RECALL only —
//   it narrows the field to plausible candidates; the link is still Pass 4's
//   meaning judgment, per pair. "In the slice" never implies "link it."
//
// HOW IT NARROWS (two paths — mirrors how the AGENT navigates cross-root, and
// reuses the exact same substrate: deriveRootRelatedness + the chain abstraction):
//
//   FOLLOW TRUTH (certain, no threshold) — for each new block, pull candidates
//     from its OWN root PLUS every root in its Venn overlap. A cross-root edge is
//     RECORDED truth that two roots are related (deriveRootRelatedness); there is
//     no "related enough" — edge present ⟹ descend. Root-level relatedness does
//     NOT pre-decide any block-level link; it only widens the candidate field.
//
//   GUESS (fuzzy, first-ever links only) — retrieveGraphSlice's identity/semantic
//     net surfaces candidates in roots with NO overlap yet, where there is no
//     recorded edge to follow. This is the only place similarity enters.
//
// HOW IT PRESENTS (coarse → fine — "the chain is the unit of meaning; the block
// is the entry point", agent.md Rule 2):
//   • CHAINS as units (chain block essence = the arc summary) to let Pass 4 find
//     the right neighbourhood, THEN
//   • the individual MEMBER blocks at full detail so Pass 4 can name the exact
//     link target (relations are block→block; you cannot link to a summary).
//   • loose blocks (chain_id = null) presented individually.
//
// Default OFF (NODEDEX_PASS4_SLICE=1). Small graphs fall back to the dump (the
// caller's buildProjectContext) — slicing only earns its keep at scale.

import type { WorkspaceDB, Block } from "../../store/database.js";
import { cosineSim } from "../../engine/vector-math.js";
import { intFromEnv } from "./config.js";
import { deriveRootRelatedness } from "./root-relatedness.js";
import { retrieveGraphSlice, type EntityQuery } from "./retrieve-graph-slice.js";
import { extractPrimaryValueFromUnique } from "./dedup-by-source-and-value.js";

// ─── Config (env-gated; safe defaults) ──────────────────────────────────────────

/** Default ON (promoted 2026-06-14 — validated; falls back to the full dump under the
 *  small-graph threshold). Set NODEDEX_PASS4_SLICE=0 to opt out. */
export function pass4SliceEnabled(): boolean {
  return process.env.NODEDEX_PASS4_SLICE !== "0";
}

/** Below this many blocks the dump is fine + cheaper than k retrievals → fall back. */
export function pass4SliceMinGraph(): number {
  return intFromEnv("NODEDEX_PASS4_SLICE_MIN_GRAPH", 150);
}

// ─── Semantic-delta net (drift recall) — default OFF, sub-feature of the slice ──
// Surfaces a SMALL, CAPPED, TAGGED set of existing blocks that are MEANING-near a
// new block but were missed by structure + identity (wording drift). It is a pure
// RECALL net: NOT weighted into the trusted ranking — appended separately, marked
// "unconfirmed", and judged by Pass 4. Reads STORED embeddings (no embed call).
export function semanticDeltaEnabled(): boolean {
  return process.env.NODEDEX_PASS4_SEMANTIC_DELTA === "1";
}
export function semanticDeltaK(): number {
  return intFromEnv("NODEDEX_PASS4_SEMANTIC_DELTA_K", 5);
}
// Below this cosine, "near" is noise — don't even introduce it to the judge.
const SEMANTIC_DELTA_FLOOR = 0.5;

export interface Pass4SliceOpts {
  /** First-ever net: top-k similarity candidates per new block (the GUESS path). */
  netK?: number;
  /** Hard cap on total surfaced blocks (token guard). */
  maxBlocks?: number;
}

// ─── Pure-ish helpers ────────────────────────────────────────────────────────────

function parseObject(s: unknown): Record<string, unknown> {
  if (s && typeof s === "object") return s as Record<string, unknown>;
  if (typeof s !== "string" || !s) return {};
  try { const p = JSON.parse(s); return p && typeof p === "object" ? p : {}; }
  catch { return {}; }
}

function parseConcepts(s: unknown): string[] {
  if (Array.isArray(s)) return s.filter((x) => typeof x === "string");
  if (typeof s !== "string" || !s) return [];
  try { const p = JSON.parse(s); return Array.isArray(p) ? p.filter((x) => typeof x === "string") : []; }
  catch { return []; }
}

/** unique{} primary value (identity), via the same extractor RETRIEVE + AUDIT use. */
function uniquePrimary(block: Block): string {
  const content = parseObject(block.content);
  const unique = parseObject(content.unique);
  try { return extractPrimaryValueFromUnique(block.type, unique) || ""; }
  catch { return ""; }
}

/** unique{} fields rendered compactly for a context line (≤4 pairs, mirrors pipeline). */
function uniqueFieldsStr(block: Block): string {
  const content = parseObject(block.content);
  const unique = parseObject(content.unique);
  const pairs = Object.entries(unique)
    .filter(([, v]) => v && String(v).trim())
    .slice(0, 4)
    .map(([k, v]) => `${k}: "${String(v).slice(0, 80)}"`);
  return pairs.length ? ` | unique: { ${pairs.join(", ")} }` : "";
}

/** The {project} (owner) segment of a strict label {project}_{type}_{concept}. */
function labelPrefix(label: string): string {
  const i = (label ?? "").indexOf("_");
  return i === -1 ? (label ?? "") : label.slice(0, i);
}

function blockLine(block: Block, indent: string): string {
  return `${indent}${block.label} | ${block.id} [${block.type}] — "${(block.essence || "").slice(0, 140)}"${uniqueFieldsStr(block)}`;
}

/** Parse a stored embedding (JSON array string, or already an array) → vector or null. */
function parseEmbedding(v: unknown): number[] | null {
  if (Array.isArray(v)) return v.length ? (v as number[]) : null;
  if (typeof v !== "string" || !v) return null;
  try { const p = JSON.parse(v); return Array.isArray(p) && p.length ? p : null; } catch { return null; }
}

/** Cosine similarity of two equal-length vectors. 0 if shapes mismatch. */
// ─── Main entry ──────────────────────────────────────────────────────────────────

/**
 * Build the retrieved-slice PROJECT GRAPH body for Pass 4. Returns the same shape
 * as buildProjectContext ({ context, reflectedIds }) so it is a drop-in swap at
 * the call site. `context` is the body Pass 4 wraps in "PROJECT GRAPH (...):".
 */
export function buildPass4Slice(
  db: WorkspaceDB,
  newBlocks: Block[],
  opts: Pass4SliceOpts = {},
): { context: string; reflectedIds: string[] } {
  const netK = opts.netK ?? 5;
  const maxBlocks = opts.maxBlocks ?? 120;

  if (!newBlocks || newBlocks.length === 0) return { context: "", reflectedIds: [] };

  const allBlocks = db.getAllBlocks();
  const newIds = new Set(newBlocks.map((b) => b.id));

  // Root maps (label ⇄ id). deriveRootRelatedness speaks in LABELS; member blocks
  // carry their root id in project_id — so we need both directions.
  const rootIdByLabel = new Map<string, string>();
  const rootLabelById = new Map<string, string>();
  for (const b of allBlocks) {
    if (b.type === "project") { rootIdByLabel.set(b.label, b.id); rootLabelById.set(b.id, b.label); }
  }

  // ── 1. ANCHOR ROOTS — the new blocks' own roots (project_id, else label prefix) ──
  const anchorRootLabels = new Set<string>();
  for (const b of newBlocks) {
    const pid = (b as any).project_id as string | null;
    if (pid && rootLabelById.has(pid)) anchorRootLabels.add(rootLabelById.get(pid)!);
    const pref = labelPrefix(b.label);
    if (rootIdByLabel.has(pref)) anchorRootLabels.add(pref);
  }

  // ── 2. RELATED ROOTS (FOLLOW TRUTH) — Venn overlap from recorded cross-root edges ──
  const relatedRootLabels = new Set<string>();
  try {
    for (const pair of deriveRootRelatedness(db).pairs) {
      if (anchorRootLabels.has(pair.root_a)) relatedRootLabels.add(pair.root_b);
      if (anchorRootLabels.has(pair.root_b)) relatedRootLabels.add(pair.root_a);
    }
  } catch { /* best-effort — a relatedness failure must not sink Pass 4 */ }

  const neighbourhoodLabels = new Set<string>([...anchorRootLabels, ...relatedRootLabels]);
  const neighbourhoodIds = new Set<string>();
  for (const lbl of neighbourhoodLabels) {
    const id = rootIdByLabel.get(lbl);
    if (id) neighbourhoodIds.add(id);
  }

  // ── 3. NEIGHBOURHOOD MEMBERS — atomic blocks owned by anchor ∪ related roots ──
  const surfaced = new Map<string, Block>();
  for (const b of allBlocks) {
    if (b.type === "project") continue;
    // No status filter: getAllBlocks() already excludes archived — match the
    // dump (buildProjectContext) this replaces, so it stays a faithful swap.
    if (newIds.has(b.id)) continue; // never link a new block against itself
    const pid = (b as any).project_id as string | null;
    const inByPid = pid != null && neighbourhoodIds.has(pid);
    const inByPrefix = neighbourhoodLabels.has(labelPrefix(b.label));
    if (inByPid || inByPrefix) surfaced.set(b.id, b);
  }

  // ── 4. FIRST-EVER NET (GUESS) — similarity candidates in not-yet-overlapping roots ──
  for (const nb of newBlocks) {
    const primary = uniquePrimary(nb);
    const entity: EntityQuery = {
      canonical_name: nb.label.replace(/-/g, " "),
      primary_values: primary ? [primary] : [],
      concepts: parseConcepts((nb as any).concepts),
    };
    let candidates;
    try { candidates = retrieveGraphSlice(db, entity, { k: netK }); }
    catch { continue; }
    for (const c of candidates) {
      const b = c.block;
      if (!b || b.type === "project" || newIds.has(b.id) || b.status !== "active") continue;
      if (!surfaced.has(b.id)) surfaced.set(b.id, b);
    }
  }

  // Token guard: cap total surfaced blocks (FOLLOW-TRUTH neighbourhood first,
  // already inserted before the net, so the cap drops the weakest net hits first).
  let surfacedBlocks = [...surfaced.values()];
  if (surfacedBlocks.length > maxBlocks) surfacedBlocks = surfacedBlocks.slice(0, maxBlocks);

  // ── 4b. SEMANTIC DELTA (drift recall net) — UNWEIGHTED, separate, capped, $0 ──
  // Pure recall: existing blocks MEANING-near a new block but missed by structure
  // + identity (wording drift). Reads STORED vectors (no embed call). NOT ranked
  // into the trusted set — appended as a small tagged delta the LLM judges by
  // meaning. Excludes anything already surfaced + the new blocks themselves.
  const deltaScored: Array<{ block: Block; sim: number }> = [];
  if (semanticDeltaEnabled()) {
    const queryVecs = newBlocks
      .map((b) => parseEmbedding((b as any).embedding))
      .filter((v): v is number[] => !!v);
    if (queryVecs.length > 0) {
      const surfacedIds = new Set(surfacedBlocks.map((b) => b.id));
      for (const b of allBlocks) {
        if (b.type === "project" || newIds.has(b.id) || surfacedIds.has(b.id)) continue;
        if (b.status !== "active") continue;
        const vec = parseEmbedding((b as any).embedding);
        if (!vec) continue;
        let best = 0;
        for (const q of queryVecs) { const s = cosineSim(q, vec); if (s > best) best = s; }
        if (best >= SEMANTIC_DELTA_FLOOR) deltaScored.push({ block: b, sim: best });
      }
      deltaScored.sort((a, b) => b.sim - a.sim);
      deltaScored.length = Math.min(deltaScored.length, semanticDeltaK());
    }
  }
  if (deltaScored.length > 0) {
    console.log(`[pass4-slice] semantic delta: ${deltaScored.length} candidate(s) — ` +
      deltaScored.map((d) => `${d.block.label}(${d.sim.toFixed(2)})`).join(", "));
  }

  if (surfacedBlocks.length === 0 && deltaScored.length === 0) return { context: "", reflectedIds: [] };

  // ── 5. PRESENT COARSE → FINE — group by chain_id; chain block essence = the arc ──
  const byChain = new Map<string, Block[]>();
  const loose: Block[] = [];
  for (const b of surfacedBlocks) {
    const cid = (b as any).chain_id as string | null;
    if (cid) {
      let arr = byChain.get(cid);
      if (!arr) { arr = []; byChain.set(cid, arr); }
      arr.push(b);
    } else loose.push(b);
  }

  const lines: string[] = [];
  for (const [chainId, members] of byChain) {
    // Canonical chain_id IS the blk_ id of the materialized type:"chain" block.
    let header = `CHAIN ${chainId}`;
    try {
      const cb = db.getBlock(chainId);
      if (cb && cb.type === "chain") header = `CHAIN ${cb.label} — "${(cb.essence || "").slice(0, 160)}"`;
    } catch { /* tolerate — fall back to the bare chain id header */ }
    lines.push(header);
    for (const m of members) lines.push(blockLine(m, "    "));
  }
  if (loose.length > 0) {
    lines.push("[loose blocks]");
    for (const b of loose) lines.push(blockLine(b, "    "));
  }
  // Semantic delta — kept SEPARATE + tagged so Pass 4 scrutinizes by meaning,
  // never links on resemblance. sim shown for the judge's calibration.
  if (deltaScored.length > 0) {
    lines.push("[semantically related — UNCONFIRMED; link ONLY if the meaning clearly matches, not on resemblance]");
    for (const { block, sim } of deltaScored) lines.push(`${blockLine(block, "    ")}  (sim ${sim.toFixed(2)})`);
  }

  return {
    context: lines.join("\n"),
    reflectedIds: [...surfacedBlocks.map((b) => b.id), ...deltaScored.map((d) => d.block.id)],
  };
}
