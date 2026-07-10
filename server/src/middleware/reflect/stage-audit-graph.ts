// ═══════════════════════════════════════════════════════════════════════════════
// DEBT 5 Slice 2 Sub-step 2.3 — STAGE AUDIT (graph-health background scan)
// ═══════════════════════════════════════════════════════════════════════════════
//
// The SECOND writer to pipeline_flags (complements Slice 1's Stage FLAG, which
// fires per-pipeline-run). Stage AUDIT runs periodically over the WHOLE graph
// and detects cross-block patterns no single pipeline run can see:
//
//   project_dup_candidate  — two type='project' roots with high concept overlap
//                            and no cross-link (cross-customer / cross-arc
//                            anaphora Stage C missed)
//   scope_disagreement     — two blocks sharing the SAME source_excerpt but
//                            living under DIFFERENT project scopes (scope
//                            contamination — same source text filed twice)
//   island_candidate       — two blocks with strong concept overlap but NO
//                            relation between them (a missed supports/relates_to)
//
// Stage AUDIT does NOT call the LLM. It only WRITES flags. The async reviewer
// (Sub-step 2.2) is the LLM consumer that decides merge/leave/split.
//
// Design contract: docs/PIPELINE-SLICE-2-DESIGN.md §3.
// Worker pattern: stage-audit-startup wraps this in setInterval (folded into
// flag-reviewer-startup.ts-style wiring at Sub-step 2.4 / server bootstrap).
//
// Charter Rule 5 (producers disjoint): each flag_type has exactly ONE writer.
// AUDIT owns project_dup_candidate / scope_disagreement / island_candidate.
// Stage FLAG owns atomic_dup_candidate. Stage C owns entity_unresolved.
//
// What this module does NOT do:
//   - LLM calls (reviewer's job)
//   - mutate blocks/relations (reviewer's job; AUDIT is read + write-flag only)
//   - cosine/embedding similarity (cheaper concept + source_excerpt signals
//     for now; cosine is a future enhancement — see SCALE NOTE)
//   - cross-graph resolve (that's Slice 3 Stage D)
//   - scan archived blocks (getAllBlocks already excludes status='archived')

import type Database from "better-sqlite3";
import { cosineSim } from "../../engine/vector-math.js";
import { intFromEnv } from "./config.js";
import type { WorkspaceDB, Block } from "../../store/database.js";
import type { StageAuditTickResult, PipelineFlagType } from "./types.js";
import { writePipelineFlag } from "./pipeline-flags.js";
import { extractPrimaryValueFromUnique } from "./dedup-by-source-and-value.js";
import { budgetTripped } from "./cost-guard.js";

// ─── Config (env-controlled) ──────────────────────────────────────────────────

/** Jaccard threshold for project_dup_candidate (concept-set overlap). */
function projectDupThreshold(): number {
  const v = parseFloat(process.env.NODEDEX_AUDIT_PROJECT_DUP_THRESHOLD ?? "");
  return Number.isFinite(v) && v > 0 && v <= 1 ? v : 0.6;
}

/** Min shared concepts for island_candidate. */
function islandSharedMin(): number {
  return intFromEnv("NODEDEX_AUDIT_ISLAND_SHARED_MIN", 3);
}

/** Max pairwise comparisons per tick — bounds O(n²) wall time. Pairs beyond
 *  this are deferred to the next tick (round-robin via the block-id offset).
 *  SCALE NOTE: at 10000+ blocks, replace the pairwise scan with the retrieval
 *  mechanism Slice 3/4 builds (design §3.3). */
function maxPairsPerTick(): number {
  return intFromEnv("NODEDEX_AUDIT_MAX_PAIRS", 5000);
}

/** Min shared ESSENCE tokens for a project-dup candidate (the recall net for
 *  DRIFTED-concept fork pairs the concept-jaccard misses — see the project_dup
 *  branch). Recognition-layer step 4 (heal existing forks). */
function essenceOverlapMin(): number {
  return intFromEnv("NODEDEX_AUDIT_ESSENCE_MIN", 2);
}

/** Block-dup detector gate. Default ON — set NODEDEX_BLOCK_DUP_DETECT=off to
 *  silence block-level dup flags while keeping the rest of the AUDIT live. */
function blockDupDetectEnabled(): boolean {
  // Default ON (locked-on dup detection — validated 2026-06-20); set =off for dev/test.
  return (process.env.NODEDEX_BLOCK_DUP_DETECT ?? "").toLowerCase() !== "off";
}

/** Min shared CLAIM tokens (on unique{} primary_value) for a block_dup candidate.
 *  Anchored on the CLAIM, not the essence: essence carries TOPIC ("pydantic",
 *  "validation", "fastapi") which over-flags in a dense single-project graph
 *  (real-data validation: 33 pairs, ~30 false). primary_value is the per-type
 *  identity (PRIMARY_KEYS) — the same-claim signal a dup actually IS. The reviewer
 *  is the precision judge, so this is recall-tuned. */
function blockDupClaimMin(): number {
  return intFromEnv("NODEDEX_BLOCK_DUP_CLAIM_MIN", 3);
}

/** DRIFT recall (default ON). Also flag a block_dup candidate when two SAME-TYPE
 *  blocks under the same scope are SEMANTICALLY near-identical (cosine on the stored
 *  label+essence+concepts embedding). This catches reworded IDENTITY the exact/token
 *  match misses — e.g. approach "Sliding Window Log" vs "Sliding Window Logging".
 *  The SAME-TYPE gate + a high threshold limit the topic-similarity false flags that
 *  essence-meaning over-flags on (e.g. a Redis fact vs a Redis constraint); the
 *  reviewer remains the precision judge, so this stays recall-tuned. Default ON
 *  (2026-07-04): the signal is $0 (local embedder, no LLM), it only writes FLAGS
 *  (never mutates), and rewording is the dominant real-dup shape the token signal
 *  misses. Set NODEDEX_BLOCK_DUP_EMBED=off to narrow detection back to exact+token. */
function blockDupEmbedEnabled(): boolean {
  return (process.env.NODEDEX_BLOCK_DUP_EMBED ?? "").toLowerCase() !== "off";
}
function blockDupEmbedMin(): number {
  const v = parseFloat(process.env.NODEDEX_BLOCK_DUP_EMBED_MIN ?? "");
  // Default 0.78 (was 0.80; recalibrated 2026-07-11 on BOTH graphs — never tune on one).
  // The 07-10 whole-graph audit's labeled paraphrase clusters (value-proposition,
  // competitor-comparison, the reworded wake-decision pair) all scored 0.79-0.799 —
  // just UNDER the old bar, which is exactly why they persisted. Measured cost of
  // 0.78: +63 candidate pairs across DogfoodDemo+HermesTestextraction (tolerable
  // one-time reviewer drain). 0.76 and below floods with genuinely-different claims
  // ("session-1-complete" vs "session-2-complete" sits at 0.796 — the reviewer is the
  // precision arm for that band; below 0.78 the false share dominates). Cluster pairs
  // under ~0.70 are beyond bge-small's resolution — not chased (per the fix plan).
  return Number.isFinite(v) && v > 0 && v <= 1 ? v : 0.78;
}

/** Cross-type twin fence (Fix 3b, 2026-07-11): fact↔insight ONLY, at a HIGHER bar.
 *  The same-type gate made cross-type twins INVISIBLE — live example: the hard-zero
 *  finding stored as BOTH a fact and an insight (cosine 0.970, never compared).
 *  Weak models routinely emit the same claim in two epistemic wrappers; 0.80 keeps
 *  the fence tight (both graphs' cross-type pairs at ≥0.80 read as genuine twins;
 *  the labeled pair sits at 0.93-0.97). Other type pairs stay fenced — "different
 *  types are almost never duplicates" still holds outside this one wrapper split. */
const CROSS_TYPE_DUP_PAIRS = new Set(["fact|insight", "insight|fact"]);
function blockDupCrossMin(): number {
  const v = parseFloat(process.env.NODEDEX_BLOCK_DUP_CROSS_MIN ?? "");
  return Number.isFinite(v) && v > 0 && v <= 1 ? v : 0.80;
}

// ─── Pure helpers (no DB, no LLM — unit-testable) ──────────────────────────────

/** Jaccard similarity of two concept sets: |A∩B| / |A∪B|. 0 when both empty. */
export function jaccard(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 0;
  const setA = new Set(a.map(s => s.toLowerCase().trim()));
  const setB = new Set(b.map(s => s.toLowerCase().trim()));
  let inter = 0;
  for (const x of setA) if (setB.has(x)) inter += 1;
  const union = setA.size + setB.size - inter;
  return union === 0 ? 0 : inter / union;
}

/** Count shared concepts (case-insensitive). */
export function sharedConceptCount(a: string[], b: string[]): number {
  const setB = new Set(b.map(s => s.toLowerCase().trim()));
  let n = 0;
  const seen = new Set<string>();
  for (const x of a) {
    const k = x.toLowerCase().trim();
    if (setB.has(k) && !seen.has(k)) { n += 1; seen.add(k); }
  }
  return n;
}

// Common words that carry no domain signal — excluded from the essence-overlap
// recall signal so two unrelated roots don't pair on "this/that/with". NOT an
// exhaustive list; just the high-frequency noise. Real domain words (coffee,
// roasting, billing, customer) are what we want to match on.
const ESSENCE_STOPWORDS = new Set([
  "the","and","for","with","this","that","from","into","your","you","are","not",
  "but","has","was","its","our","their","other","some","more","than","then","over",
  "onto","only","also","such","when","what","which","both","each","per","about",
  "these","those","they","them","have","will","would","should","could","been",
]);

/** Count distinct shared SIGNIFICANT tokens between two essences (descriptions).
 *  The recall net for drifted-concept fork pairs: two roots about the same domain
 *  share domain words in their descriptions even when their concept tags drift
 *  (measured: home-coffee-roasting vs ...-activities had 0 concept overlap but
 *  share "coffee"+"roasting" in essence). Keys on the DESCRIPTION (meaning), not
 *  the label (name-vs-meaning). Pure / testable. */
export function sharedEssenceTokens(a: string, b: string): number {
  const tok = (s: string) =>
    new Set(
      (s ?? "").toLowerCase().split(/[^a-z0-9]+/)
        .filter((w) => w.length >= 4 && !ESSENCE_STOPWORDS.has(w)),
    );
  const ta = tok(a), tb = tok(b);
  let n = 0;
  for (const w of ta) if (tb.has(w)) n += 1;
  return n;
}

// cosineSim now lives in engine/vector-math.ts (single source). Re-exported for
// callers that import it from this module.
export { cosineSim };

export interface AuditBlock {
  id: string;
  label: string;
  type: string;
  concepts: string[];
  project_id: string | null;
  source_excerpt: string | null;
  /** Per-type identity value from content.unique{} — the "is this the same
   *  thing" signal (per [[feedback-identity-is-unique-not-label]]). Normalized
   *  (trim + lowercase) for cross-conversation comparison. "" when none. */
  primary_value: string;
  /** Root description / block essence — a TEXT recall signal for drifted-concept
   *  project-dup pairs that concept-jaccard misses (the recognizer-validated gap). */
  essence: string;
  /** Stored embedding (label+essence+concepts), parsed. null when not yet embedded —
   *  the embedding-recall branch skips such pairs (falls back to exact/token). */
  embedding: number[] | null;
}

export function toAuditBlock(b: Block): AuditBlock {
  let concepts: string[] = [];
  try {
    const parsed = JSON.parse((b.concepts as string) ?? "[]");
    if (Array.isArray(parsed)) concepts = parsed;
  } catch { /* tolerate */ }
  // Identity value lives in content.unique{} (NOT label/essence). Parse it +
  // extract the per-type primary value the SAME way D2 dedup does.
  let unique: Record<string, unknown> = {};
  try {
    const c = JSON.parse((b.content as string) ?? "{}");
    if (c && typeof c.unique === "object" && c.unique !== null) unique = c.unique;
  } catch { /* tolerate */ }
  const primary_value = extractPrimaryValueFromUnique(b.type, unique).trim().toLowerCase();
  let embedding: number[] | null = null;
  try {
    const e = (b as any).embedding;
    if (typeof e === "string" && e.length > 0) { const v = JSON.parse(e); if (Array.isArray(v)) embedding = v as number[]; }
    else if (Array.isArray(e)) embedding = e as number[];
  } catch { /* tolerate malformed embedding */ }
  return {
    id:             b.id,
    label:          b.label,
    type:           b.type,
    concepts,
    project_id:     (b as any).project_id ?? null,
    source_excerpt: (b as any).source_excerpt ?? null,
    primary_value,
    essence:        b.essence ?? "",
    embedding,
  };
}

// ─── Shared block-dup pair judgment (the ONE implementation) ───────────────────

export interface BlockDupJudgeOpts {
  /** Min shared CLAIM tokens (primary_value) to flag as a candidate. */
  claimMin: number;
  /** Whether the embedding-recall (drift) branch is active. */
  embedOn: boolean;
  /** Min cosine for the embedding-recall branch on SAME-TYPE pairs. */
  embedMin: number;
  /** Min cosine for the fact↔insight cross-type twin fence (higher bar than embedMin). */
  crossMin: number;
}

export type BlockDupSignal = 'primary_value_exact' | 'primary_value_overlap' | 'essence_embedding';

export interface BlockDupVerdict {
  /** True when the pair is a same-scope dup CANDIDATE. RECALL only — the
   *  flag-reviewer is the precision judge (merge/leave). */
  isCandidate: boolean;
  /** Same project_id (the hard structural merge-guard). false → never a candidate. */
  sameScope: boolean;
  /** Which recall signal fired (null when not a candidate). */
  signal: BlockDupSignal | null;
  /** Shared primary_value tokens (recorded for the flag criteria). */
  claimTokens: number;
  /** Cosine on the stored embeddings; 0 when not computed/applicable. */
  embedSim: number;
}

/** Read the block-dup judge config once, from the SAME env readers the periodic
 *  AUDIT uses, so the inline recognize-before-write path can never drift apart
 *  from the AUDIT scan. */
export function blockDupJudgeOpts(): BlockDupJudgeOpts {
  return { claimMin: blockDupClaimMin(), embedOn: blockDupEmbedEnabled(), embedMin: blockDupEmbedMin(), crossMin: blockDupCrossMin() };
}

/**
 * DO: decide whether two blocks are a same-scope duplicate CANDIDATE — exact
 *   primary_value, primary_value token-overlap, or (opt-in) near-identical
 *   same-type essence embedding (the drift net).
 * SERVE: compounding — one piece of residue should be ONE block. This is the
 *   RECALL stage; the flag-reviewer is the precision judge.
 * CARRY: identity is unique{} primary_value, NOT label/essence; same-scope
 *   (project_id) is the merge guard — a cross-scope same-claim pair is a
 *   scope_disagreement (never merged), so it can never be a candidate here.
 *
 * Pure: no DB, no LLM. The supersedes-skip + flag idempotency are caller-side
 * (they need the DB). This is the ONE implementation shared by the periodic
 * AUDIT (runStageAuditTick) and the inline path (dedupNewBlocksInline) — so the
 * two seams detect identically (Rule 5 spirit: one detection, two timings).
 */
export function judgeBlockDupPair(a: AuditBlock, b: AuditBlock, opts: BlockDupJudgeOpts): BlockDupVerdict {
  const sameScope = a.project_id != null && a.project_id === b.project_id;
  if (!sameScope) return { isCandidate: false, sameScope: false, signal: null, claimTokens: 0, embedSim: 0 };
  const sameIdentity = a.primary_value.length > 0 && a.primary_value === b.primary_value;
  const claimTokens = sharedEssenceTokens(a.primary_value, b.primary_value);
  // SAME-TYPE gate on the token-overlap signal (2026-06-15): a primary_value token
  // overlap is a dup CANDIDATE only when the two blocks share the same epistemic role.
  // Different types are different kinds of knowledge — "almost never duplicates" (the
  // reviewer's own rule) — and in a dense single-domain graph the shared domain tokens
  // (useFetch/hook/state) otherwise flood the queue with cross-type false candidates.
  // This aligns the token signal with the embedding signal below, which ALREADY requires
  // same-type. Measured on the collapse-e2e graph: 66→15 candidates, real dup preserved.
  // (A concept-overlap gate was rejected — it cut 66→3 but LOST the real dup pair.)
  // Exact-identity (sameIdentity) stays type-agnostic: an identical primary_value is a
  // strong enough signal to flag regardless of type.
  const byClaim = claimTokens >= opts.claimMin && a.type === b.type;
  // Embedding branch: same-type pairs at embedMin, plus the ONE sanctioned cross-type
  // fence — fact↔insight at the higher crossMin bar (the same claim in two epistemic
  // wrappers; every other cross-type pair stays invisible to this signal by design).
  const sameType = a.type === b.type;
  const crossPair = CROSS_TYPE_DUP_PAIRS.has(`${a.type}|${b.type}`);
  const embedSim = (opts.embedOn && (sameType || crossPair) && a.embedding && b.embedding)
    ? cosineSim(a.embedding, b.embedding) : 0;
  const byEmbedding = embedSim > 0 && embedSim >= (sameType ? opts.embedMin : opts.crossMin);
  const isCandidate = sameIdentity || byClaim || byEmbedding;
  const signal: BlockDupSignal | null = !isCandidate ? null
    : sameIdentity ? 'primary_value_exact'
    : byClaim ? 'primary_value_overlap'
    : 'essence_embedding';
  return { isCandidate, sameScope, signal, claimTokens, embedSim };
}

// ─── Relation + flag existence (idempotency) ───────────────────────────────────

/** True if any active relation exists between the pair in EITHER direction. */
function hasRelationBetween(raw: Database.Database, idA: string, idB: string): boolean {
  const row = raw.prepare(`
    SELECT 1 FROM relations
     WHERE valid_to IS NULL
       AND ((source_id = @a AND target_id = @b) OR (source_id = @b AND target_id = @a))
     LIMIT 1
  `).get({ a: idA, b: idB });
  return !!row;
}

/** True if a supersedes/superseded_by relation exists between the pair (either
 *  direction). Used by the block_dup detector to SKIP pairs already in a
 *  replacement chain (the recap "reconfirmed → abandoned" case): the supersede
 *  mechanism already collapsed them, re-flagging is redundant. Deliberately
 *  NARROWER than hasRelationBetween — a `supports`/`contradicts` edge between two
 *  same-claim blocks is NOT a dedup and must NOT suppress the flag (the 50ms-SLA
 *  pair carries a `supports` edge yet is still an un-merged duplicate). */
export function hasSupersedesBetween(raw: Database.Database, idA: string, idB: string): boolean {
  const row = raw.prepare(`
    SELECT 1 FROM relations
     WHERE valid_to IS NULL
       AND type IN ('supersedes', 'superseded_by')
       AND ((source_id = @a AND target_id = @b) OR (source_id = @b AND target_id = @a))
     LIMIT 1
  `).get({ a: idA, b: idB });
  return !!row;
}

/** True if a flag of this type already exists for the pair (either direction),
 *  reviewed OR not. Prevents re-flagging a known pair on every tick (incl.
 *  re-spending reviewer $$ on a pair already verdicted 'leave'). */
export function flagAlreadyExists(
  raw: Database.Database,
  flag_type: PipelineFlagType,
  idA: string,
  idB: string,
): boolean {
  const row = raw.prepare(`
    SELECT 1 FROM pipeline_flags
     WHERE flag_type = @t
       AND ((block_id_a = @a AND block_id_b = @b) OR (block_id_a = @b AND block_id_b = @a))
     LIMIT 1
  `).get({ t: flag_type, a: idA, b: idB });
  return !!row;
}

// ─── Tick orchestrator ──────────────────────────────────────────────────────────

export interface RunStageAuditOpts {
  db: WorkspaceDB;
  /** Round-robin start offset into the block list (for paging across ticks
   *  when the graph exceeds maxPairsPerTick). Default 0.  */
  startOffset?: number;
}

/**
 * One Stage AUDIT tick: scan blocks pairwise, write flags for the 3 audit
 * patterns. Bounded by maxPairsPerTick. Idempotent — never re-flags a pair
 * already in pipeline_flags for that type.
 *
 * Returns per-tick result for telemetry + log + the next-tick offset.
 *
 * Per-pair precedence to avoid double-flagging the same pair:
 *   both type='project'  → project_dup_candidate only (skip scope/island)
 *   else same source_excerpt + different project → scope_disagreement
 *   else strong concept overlap + no link → island_candidate
 */
export function runStageAuditTick(opts: RunStageAuditOpts): StageAuditTickResult {
  const t0 = Date.now();
  const raw = (opts.db as any).db as Database.Database;
  const result: StageAuditTickResult = {
    scanned_pairs: 0,
    flags_written: { project_dup_candidate: 0, scope_disagreement: 0, island_candidate: 0, block_dup_candidate: 0 },
    flags_skipped_already_pending: 0,
    errors: 0,
    wall_ms: 0,
    next_offset: 0,
  };

  let blocks: AuditBlock[];
  try {
    blocks = opts.db.getAllBlocks().map(toAuditBlock);
  } catch (e: any) {
    result.errors += 1;
    result.wall_ms = Date.now() - t0;
    console.warn(`[stage-audit] getAllBlocks threw: ${e?.message ?? e}`);
    return result;
  }

  const projDupThresh = projectDupThreshold();
  const essMin = essenceOverlapMin();
  const islandMin = islandSharedMin();
  const pairCap = maxPairsPerTick();
  const blockDupOn = blockDupDetectEnabled();
  const blockDupEmbedOn = blockDupEmbedEnabled();
  const embedMin = blockDupEmbedMin();
  const crossMin = blockDupCrossMin();
  const blockDupClaim = blockDupClaimMin();
  const n = blocks.length;
  const start = Math.min(opts.startOffset ?? 0, Math.max(0, n - 1));

  outer:
  for (let i = start; i < n; i++) {
    const a = blocks[i]!;
    for (let j = i + 1; j < n; j++) {
      // Pair cap hit: the next tick RESUMES at this outer index (i's remaining
      // pairs are re-checked — cheap, flagAlreadyExists makes them no-ops). A
      // completed sweep leaves next_offset at 0 (wrap and start over). This must
      // advance by actual coverage: the old `offset+1`-per-tick crawl left the
      // graph's tail unscanned for days (the un-flagged twin-dup pair, 2026-07-04).
      if (result.scanned_pairs >= pairCap) { result.next_offset = i; break outer; }
      const b = blocks[j]!;
      result.scanned_pairs += 1;

      try {
        // ── project_dup_candidate: both projects, high concept overlap, no link
        if (a.type === 'project' && b.type === 'project') {
          // Recall = concept-jaccard OR shared-essence-tokens. The essence signal
          // catches DRIFTED-concept fork pairs the jaccard misses (the
          // recognizer-validated gap: home-coffee-roasting vs ...-activities had
          // ~0 concept overlap but share "coffee"+"roasting" in essence). Detection
          // is RECALL only + LLM-free; the flag-reviewer is the precision judge
          // (same domain + same owner -> merge; different scope -> leave), so a
          // looser recall is safe (false pairs get 'leave').
          const conceptJac = jaccard(a.concepts, b.concepts);
          const essTokens = sharedEssenceTokens(a.essence, b.essence);
          const byConcept = conceptJac >= projDupThresh;
          const byEssence = essTokens >= essMin;
          if ((byConcept || byEssence) && !hasRelationBetween(raw, a.id, b.id)) {
            if (flagAlreadyExists(raw, 'project_dup_candidate', a.id, b.id)) {
              result.flags_skipped_already_pending += 1;
            } else {
              writePipelineFlag(raw, {
                flag_type: 'project_dup_candidate',
                block_id_a: a.id,
                block_id_b: b.id,
                criteria: {
                  jaccard: Number(conceptJac.toFixed(3)),
                  shared_essence_tokens: essTokens,
                  signal: byConcept ? (byEssence ? 'concept+essence' : 'concept') : 'essence',
                  shared_concepts: a.concepts.filter(c => b.concepts.map(x => x.toLowerCase()).includes(c.toLowerCase())),
                  label_a: a.label, label_b: b.label,
                },
                scope_check: 'different',
                origin_writer: 'stage_audit_project_dup',
                origin_range_id: null,
              });
              result.flags_written.project_dup_candidate += 1;
            }
          }
          continue; // both-projects pair handled — don't also scope/island it
        }

        // ── scope_disagreement: SAME identity (unique{} primary value) under
        //    DIFFERENT owner (project_id). Identity is content.unique{}, NOT
        //    label/essence/source_excerpt (per [[feedback-identity-is-unique-
        //    not-label]] + the provider-drift finding). This catches the EXACT
        //    cross-owner collision precisely: "the same specific claim is filed
        //    under two different projects." It does NOT catch paraphrased-same-
        //    meaning across owners (different words → different primary_value) —
        //    that's PARAPHRASE = LLM territory (Stage D / Slice 3 + reviewer),
        //    explicitly not solved in code per the identity memory. The code
        //    AUDIT is the precise smoke alarm; Stage D is the semantic sprinkler.
        const sameIdentity = a.primary_value.length > 0 && a.primary_value === b.primary_value;
        const differentScope = (a.project_id ?? null) !== (b.project_id ?? null);
        if (sameIdentity && differentScope) {
          if (flagAlreadyExists(raw, 'scope_disagreement', a.id, b.id)) {
            result.flags_skipped_already_pending += 1;
          } else {
            writePipelineFlag(raw, {
              flag_type: 'scope_disagreement',
              block_id_a: a.id,
              block_id_b: b.id,
              criteria: {
                similarity_type: 'unique_primary_value',
                primary_value: a.primary_value.slice(0, 200),
                scope_a: a.project_id, scope_b: b.project_id,
              },
              scope_check: 'different',
              origin_writer: 'stage_audit_scope',
              origin_range_id: null,
            });
            result.flags_written.scope_disagreement += 1;
          }
          continue; // scope handled — don't also island it
        }

        // ── block_dup_candidate: two NON-root blocks under the SAME scope that look
        //    like the same claim — the recap-restatement gap (reworded same claim
        //    OR same claim re-typed). Recall = same primary_value (exact identity)
        //    OR essence-token overlap (the reworded net). SAME-scope is the merge
        //    guard: cross-scope is scope_disagreement (handled above, must NOT merge);
        //    only same-scope pairs are merge candidates. The reviewer is the precision
        //    judge (merge/leave). Skips pairs already in a SUPERSEDES chain (the
        //    supersede mechanism already collapsed them) — but NOT pairs merely linked
        //    by supports/contradicts (those ARE the un-merged dups). Default ON
        //    (NODEDEX_BLOCK_DUP_DETECT=off to silence).
        if (blockDupOn) {
          // The pair-decision (same-scope gate + claim/embedding recall) is the ONE
          // shared judge — reused verbatim by the inline recognize-before-write path
          // so the two seams can never drift. Same-scope is the structural merge guard
          // (cross-scope = scope_disagreement, handled above); identity is unique{}
          // primary_value, NOT essence (essence carries topic and over-flags). The
          // reviewer is the precision judge, so this stays recall-tuned.
          const v = judgeBlockDupPair(a, b, { claimMin: blockDupClaim, embedOn: blockDupEmbedOn, embedMin, crossMin });
          if (v.isCandidate && !hasSupersedesBetween(raw, a.id, b.id)) {
            if (flagAlreadyExists(raw, 'block_dup_candidate', a.id, b.id)) {
              result.flags_skipped_already_pending += 1;
            } else {
              writePipelineFlag(raw, {
                flag_type: 'block_dup_candidate',
                block_id_a: a.id,
                block_id_b: b.id,
                criteria: {
                  signal: v.signal,
                  claim_tokens: v.claimTokens,
                  embed_sim: v.signal === 'essence_embedding' ? Number(v.embedSim.toFixed(3)) : undefined,
                  shared_concepts: sharedConceptCount(a.concepts, b.concepts),
                  primary_value: a.primary_value.slice(0, 200),
                  scope: a.project_id,
                  type_a: a.type, type_b: b.type,
                  label_a: a.label, label_b: b.label,
                },
                scope_check: 'same',
                origin_writer: 'stage_audit_block_dup',
                origin_range_id: null,
              });
              result.flags_written.block_dup_candidate += 1;
            }
            continue; // block-dup handled — don't also island it
          }
        }

        // ── island_candidate: strong concept overlap, no relation
        const shared = sharedConceptCount(a.concepts, b.concepts);
        if (shared >= islandMin && !hasRelationBetween(raw, a.id, b.id)) {
          if (flagAlreadyExists(raw, 'island_candidate', a.id, b.id)) {
            result.flags_skipped_already_pending += 1;
          } else {
            writePipelineFlag(raw, {
              flag_type: 'island_candidate',
              block_id_a: a.id,
              block_id_b: b.id,
              criteria: {
                shared_concept_count: shared,
                shared_concepts: a.concepts.filter(c => b.concepts.map(x => x.toLowerCase()).includes(c.toLowerCase())),
                potential_relation_type: 'relates_to',
              },
              scope_check: 'unknown',
              origin_writer: 'stage_audit_islands',
              origin_range_id: null,
            });
            result.flags_written.island_candidate += 1;
          }
        }
      } catch (e: any) {
        result.errors += 1;
        console.warn(`[stage-audit] pair (${a.id}, ${b.id}) threw: ${e?.message ?? e}`);
      }
    }
  }

  result.wall_ms = Date.now() - t0;
  return result;
}

// ─── Timer wrapper (env-gated, mirror arc-inactivity-timer) ────────────────────
//
// Default ON (self-maintenance locked-on per release decision 2026-06-20); set
// NODEDEX_AUDIT_ENABLED=off for dev/test. Longer interval than the reviewer
// (graph-wide scan; no need to be fast) — default 30 min. The round-robin
// startOffset is PERSISTED in the DB so coverage accumulates across ticks AND
// restarts — an in-memory offset reset to 0 on every restart, which on
// restart-heavy servers meant the tail of the block list was never scanned.

let _auditHandle: ReturnType<typeof setInterval> | null = null;
let _auditInFlight = false;

/** Tiny per-DB kv for maintenance workers' cross-restart state. Lazy + idempotent. */
function ensureMaintenanceStateTable(raw: Database.Database): void {
  raw.prepare(
    `CREATE TABLE IF NOT EXISTS maintenance_state (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  ).run();
}

/** Exported for tests. Falls back to 0 on any read problem — worst case is re-coverage. */
export function loadAuditOffset(db: WorkspaceDB): number {
  try {
    const raw = (db as any).db as Database.Database;
    ensureMaintenanceStateTable(raw);
    const row = raw.prepare(`SELECT value FROM maintenance_state WHERE key = 'stage_audit_offset'`)
      .get() as { value?: string } | undefined;
    const v = Number(row?.value);
    return Number.isInteger(v) && v >= 0 ? v : 0;
  } catch {
    return 0;
  }
}

/** Exported for tests. Best-effort — a failed save only costs re-coverage next tick. */
export function saveAuditOffset(db: WorkspaceDB, offset: number): void {
  try {
    const raw = (db as any).db as Database.Database;
    ensureMaintenanceStateTable(raw);
    raw.prepare(
      `INSERT INTO maintenance_state (key, value) VALUES ('stage_audit_offset', @v)
       ON CONFLICT(key) DO UPDATE SET value = @v`,
    ).run({ v: String(offset) });
  } catch {
    /* best-effort */
  }
}

function auditEnabled(): boolean {
  // Default ON (self-maintenance locked-on per release decision 2026-06-20); set =off for dev/test.
  return (process.env.NODEDEX_AUDIT_ENABLED ?? "").toLowerCase() !== "off";
}

function auditIntervalMs(): number {
  return intFromEnv("NODEDEX_AUDIT_INTERVAL_MS", 1_800_000); // 30 min default
}

async function auditTick(db: WorkspaceDB): Promise<void> {
  if (_auditInFlight) {
    console.log("[stage-audit] tick still running, skipping this interval");
    return;
  }
  _auditInFlight = true;
  try {
    // Cost breaker (production gap 2, Phase B): self-gate before spending
    // (audit's spend is embeddings; the flags it writes feed the gated reviewer).
    const budget = await budgetTripped();
    if (budget?.tripped) {
      console.warn(`[stage-audit] tick skipped — cost breaker: ${budget.reason}`);
      return;
    }
    const res = runStageAuditTick({ db, startOffset: loadAuditOffset(db) });
    // Persist where the scan stopped so the next tick — or the next PROCESS —
    // resumes coverage instead of re-walking the head of the block list.
    saveAuditOffset(db, res.next_offset);
    const w = res.flags_written;
    if (w.project_dup_candidate + w.scope_disagreement + w.island_candidate + w.block_dup_candidate > 0 || res.errors > 0) {
      console.log(
        `[stage-audit] tick: pairs=${res.scanned_pairs} ` +
        `flags={project_dup:${w.project_dup_candidate}, scope:${w.scope_disagreement}, island:${w.island_candidate}, block_dup:${w.block_dup_candidate}} ` +
        `skipped=${res.flags_skipped_already_pending} errors=${res.errors} next_offset=${res.next_offset} wall_ms=${res.wall_ms}`
      );
    }
  } catch (e: any) {
    console.warn(`[stage-audit] tick threw: ${e?.message ?? e}`);
  } finally {
    _auditInFlight = false;
  }
}

/** Start the Stage AUDIT timer. Idempotent; returns true if started. */
export function startStageAuditTimer(db: WorkspaceDB): boolean {
  if (!auditEnabled()) {
    console.log("[stage-audit] disabled (set NODEDEX_AUDIT_ENABLED=on to enable)");
    return false;
  }
  if (_auditHandle !== null) return false;
  const intervalMs = auditIntervalMs();
  console.log(`[stage-audit] starting: interval=${intervalMs}ms`);
  _auditHandle = setInterval(() => {
    auditTick(db).catch((e: any) => console.warn(`[stage-audit] interval tick rejected: ${e?.message ?? e}`));
  }, intervalMs);
  if (typeof _auditHandle.unref === "function") _auditHandle.unref();
  return true;
}

/** Stop the Stage AUDIT timer. Used on shutdown + by tests. */
export function stopStageAuditTimer(): void {
  if (_auditHandle !== null) {
    clearInterval(_auditHandle);
    _auditHandle = null;
  }
}

/** For tests only — reports whether the timer is currently running. */
export function _isStageAuditTimerRunningForTests(): boolean {
  return _auditHandle !== null;
}
