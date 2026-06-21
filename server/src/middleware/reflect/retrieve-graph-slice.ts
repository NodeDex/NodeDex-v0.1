// ═══════════════════════════════════════════════════════════════════════════════
// DEBT 5 Slice 3 (Stage D) — Part 1: RETRIEVE — identity-ranked candidate finder
// ═══════════════════════════════════════════════════════════════════════════════
//
// Job (docs/PIPELINE-STAGE-D-PART1-RETRIEVAL-DESIGN.md):
//   Narrow the graph to ~k candidate blocks the Stage D resolver (Part 2) should
//   judge for "same entity? same scope?". ONLY duty = high RECALL (never miss a
//   real same-entity match). Precision is the resolver's job.
//
// Why this is NOT just "reuse recall-smart" (the meaning-first audit, 2026-06-01):
//   recall-smart's SEMANTIC half fingerprints [label, essence, concepts] — TOPIC,
//   not identity. It omits unique{} (the system's identity basis) and FLATTENS the
//   label's {project} segment (the OWNER) into word-soup. For an IDENTITY check
//   that's the wrong signal. So we keep the candidate-FINDING plumbing
//   (keywordSearch/conceptSearch) but rebuild the RANKING on three SEPARATE
//   signals, identity-first:
//
//   Signal 1 IDENTITY  — unique{} primary value (via extractPrimaryValueFromUnique,
//                        the SAME extractor D2 + AUDIT use — Rule 5). DOMINANT.
//   Signal 2 SCOPE     — label {project} segment read as a DISCRETE dimension (not
//                        blended); catch-all scopes tagged "unknown" (spike pair-5
//                        lesson). Does NOT filter — cross-scope candidates are
//                        WANTED (resolver's Q2 needs them).
//   Signal 3 SEMANTIC  — existing cosine, DE-WEIGHTED (≤0.2). A weak recall-net for
//                        paraphrases Signal 1 missed; never the identity basis.
//
// source_excerpt: carried as EVIDENCE to the resolver, NOT a match key (cross-arc
// the same entity comes from different conversations → excerpts differ).

import type { WorkspaceDB, Block } from "../../store/database.js";
import { cosineSim } from "../../engine/vector-math.js";
import type { ArcEntityCluster } from "./types.js";
import { extractPrimaryValueFromUnique } from "./dedup-by-source-and-value.js";

// ─── Weights (identity dominates; semantic is a weak booster) ──────────────────
const W_IDENTITY_EXACT   = 1.0;   // exact normalized unique{} primary-value match
const W_IDENTITY_PARTIAL = 0.5;   // token overlap of primary values (paraphrase net)
const W_SEMANTIC_MAX     = 0.2;   // cosine contribution ceiling (recall booster only)

// Scopes that are catch-all dumping grounds, not real owners. Detected
// STRUCTURALLY below (a project root with few/no real members) — this constant
// is only the well-known explicit marker, NOT an exhaustive sentinel list (that
// would be the signal-word anti-pattern). See isCatchAllScope().
const EXPLICIT_CATCH_ALL = "unspecified-project";

// ─── Types ─────────────────────────────────────────────────────────────────────

export interface CandidateScope {
  /** The owner/scope value (label {project} segment or project_id resolved to it). */
  value: string;
  /** True when the scope is a catch-all dump ("owner unknown"), not a real owner. */
  is_catch_all: boolean;
}

export interface RetrievalCandidate {
  block: Block;
  identity_score: number;   // Signal 1 — exact (1.0) or partial (≤0.5) unique{} match
  scope: CandidateScope;    // Signal 2 — discrete, carried to resolver (not a filter)
  semantic_score: number;   // Signal 3 — raw cosine [0,1], pre-weight (0 if unavailable)
  rank_score: number;       // weighted blend; identity dominates
  why: string;              // which signals fired (falsifiability / debug)
}

/** What Part 1 needs about the arc entity it's finding matches for. Derived from
 *  a Stage C cluster, but kept as a plain shape so callers/tests can build it
 *  without a full ArcEntityResolveResult. */
export interface EntityQuery {
  canonical_name: string;
  /** Identity-bearing primary values of the entity's member items (the thing to
   *  match on — Signal 1). Often one, but a cluster can carry several. */
  primary_values: string[];
  /** Concept tags for candidate FINDING (recall) + partial signal. */
  concepts: string[];
  /** Optional query embedding for Signal 3. Omit to skip semantic. */
  embedding?: number[] | null;
}

// ─── Pure helpers (no DB — unit-testable) ──────────────────────────────────────

/** Normalize a primary value for comparison: lowercase, collapse whitespace,
 *  strip surrounding backticks/quotes/trailing punctuation. Identity compares on
 *  MEANING-bearing text, so cosmetic punctuation must not split a true match. */
export function normalizePrimaryValue(v: string): string {
  return (v ?? "")
    .toLowerCase()
    .replace(/[`"'.]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** The {project} (owner) segment of a strict label {project}_{type}_{concept}.
 *  Read STRUCTURALLY (split on the `_` dimension separator) — never word-soup. */
export function scopeSegmentOfLabel(label: string): string {
  const i = (label ?? "").indexOf("_");
  return i === -1 ? (label ?? "") : label.slice(0, i);
}

function tokenize(s: string): string[] {
  return normalizePrimaryValue(s).split(" ").filter(t => t.length > 2);
}

/** Token-overlap (Jaccard) of two primary values — the partial-identity signal
 *  for paraphrase, where exact normalized match fails. */
export function primaryValueTokenOverlap(a: string, b: string): number {
  const ta = new Set(tokenize(a)), tb = new Set(tokenize(b));
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter += 1;
  return inter / (ta.size + tb.size - inter);
}

// ─── Scope: catch-all detection (structural, not a sentinel list) ──────────────
//
// A scope is "catch-all" when it's a dumping ground rather than a real owner. We
// detect this STRUCTURALLY: the explicit well-known marker, OR a project root that
// owns blocks spanning many unrelated concept clusters with a generic essence.
// For now (small graph) the explicit marker + a low-cohesion heuristic; the
// heuristic is the extensible part (NOT a hard-coded list of names).

export function isCatchAllScope(
  scopeValue: string,
  projectRootEssenceByLabel?: Map<string, string>,
): boolean {
  if (scopeValue === EXPLICIT_CATCH_ALL) return true;
  // Structural signal: a project root whose essence advertises "items without a
  // specified project" / "miscellaneous" — read from the root block's own essence,
  // NOT a name list. Extensible: future cohesion metric plugs in here.
  const essence = projectRootEssenceByLabel?.get(scopeValue)?.toLowerCase() ?? "";
  return /without a specified project|miscellaneous|uncategorized|catch-?all|unspecified/.test(essence);
}

// ─── Main entry ────────────────────────────────────────────────────────────────

export interface RetrieveOpts {
  k?: number;                       // candidate cap (default 20)
  /** Pass an embedding-getter to enable Signal 3; omit to skip (pure identity+scope). */
  embeddingFor?: (block: Block) => number[] | null;
}

/**
 * Retrieve the top-k candidate blocks for an arc entity, ranked identity-first.
 *
 * Recall step: union of keywordSearch(canonical_name + primary values) +
 * conceptSearch(concepts). Cross-scope candidates are INCLUDED (the resolver's
 * Q2 needs them). Ranking: Signal 1 (identity) dominates; Signal 2 (scope) is
 * carried as evidence, not a filter; Signal 3 (semantic) is a capped booster.
 */
export function retrieveGraphSlice(
  db: WorkspaceDB,
  entity: EntityQuery,
  opts: RetrieveOpts = {},
): RetrievalCandidate[] {
  const k = opts.k ?? 20;

  // Project-root essences for structural catch-all detection (cheap; small set).
  const rootEssence = new Map<string, string>();
  for (const b of db.getAllBlocks()) {
    if (b.type === "project") rootEssence.set(b.label, b.essence ?? "");
  }

  // ── Recall (FINDING): union keyword + concept candidates ──
  const queryString = [entity.canonical_name.replace(/-/g, " "), ...entity.primary_values].join(" ");
  const kw = db.keywordSearch(queryString, 200);
  const conceptHits = entity.concepts.length
    ? [...db.conceptSearch(entity.concepts).values()].map(v => v.block)
    : [];

  const pool = new Map<string, Block>();
  for (const b of [...kw, ...conceptHits]) {
    if (b && b.id && b.status === "active") pool.set(b.id, b);
  }

  const normEntityValues = entity.primary_values.map(normalizePrimaryValue).filter(Boolean);

  // ── Rank ──
  const scored: RetrievalCandidate[] = [];
  for (const block of pool.values()) {
    if (block.type === "project") continue;  // entities resolve against atomic blocks, not roots

    // Signal 1 — IDENTITY (unique{} primary value)
    let content: any = {};
    try { content = typeof block.content === "string" ? JSON.parse(block.content) : (block.content || {}); }
    catch { content = {}; }
    const candVal = extractPrimaryValueFromUnique(block.type, content.unique || {});
    const candNorm = normalizePrimaryValue(candVal);
    let identity = 0;
    const whyParts: string[] = [];
    if (candNorm) {
      if (normEntityValues.includes(candNorm)) {
        identity = W_IDENTITY_EXACT;
        whyParts.push(`identity:exact(${candNorm.slice(0, 40)})`);
      } else {
        const best = Math.max(0, ...normEntityValues.map(v => primaryValueTokenOverlap(v, candNorm)));
        if (best > 0) { identity = W_IDENTITY_PARTIAL * best; whyParts.push(`identity:partial(${best.toFixed(2)})`); }
      }
    }

    // Signal 2 — SCOPE (discrete; carried, not filtered)
    const scopeVal = scopeSegmentOfLabel(block.label);
    const scope: CandidateScope = { value: scopeVal, is_catch_all: isCatchAllScope(scopeVal, rootEssence) };
    if (scope.is_catch_all) whyParts.push("scope:catch-all");

    // Signal 3 — SEMANTIC (capped booster)
    let semantic = 0;
    if (entity.embedding && opts.embeddingFor) {
      const vec = opts.embeddingFor(block);
      if (vec) { semantic = cosineSim(entity.embedding, vec); if (semantic > 0.01) whyParts.push(`semantic:${semantic.toFixed(2)}`); }
    }

    const rank = identity + Math.min(semantic, 1) * W_SEMANTIC_MAX;
    // Keep anything with ANY identity OR a strong semantic hit (recall net).
    if (rank <= 0 && semantic < 0.5) continue;

    scored.push({
      block, identity_score: identity, scope, semantic_score: semantic,
      rank_score: rank, why: whyParts.join(" "),
    });
  }

  scored.sort((a, b) => b.rank_score - a.rank_score);
  return scored.slice(0, k);
}
