// ─── Pass 0 types ──────────────────────────────────────────────────────────────

export interface Pass0Result {
  input_type:          string;     // "CONVERSATIONAL" or "KNOWLEDGE_SYNTHESIS"
  projects:            Array<{ name: string; scope: string }>;
  scope_project:       { name: string; scope: string };  // overarching subject — home for cross-cutting items
  people:              Array<{ name: string; role: string; signal_type: string }>;
  actor_actions:       Array<{ actor: string; action: string; object: string; outcome?: string }>;
  technologies:        Array<{ name: string; project?: string; context?: string }>;  // APPROACHES — observational descriptions
  in_flight:           string[];   // work actively underway (tasks, not yet done)
  causal_links:        Array<{ cause: string; effect: string }>;
  replacements:        Array<{ predecessor: string; replacement: string; function: string }>;  // active-use predecessors being replaced this session
  unchanged:           string[];
  scene_card_reasoning?: string;  // diagnostic: input type + rationale for APPROACHES descriptions
}

// ─── Pass 1 types ──────────────────────────────────────────────────────────────

export interface Pass1Item {
  id: string;
  text: string;
  source: string;
  excerpt: string;
  provisional_type: string;
  extends_id?: string;  // set when item is meaningless without parent (standalone test: "delete parent → does this still make sense?")
  uncertain?: boolean;  // true when extracted with incomplete context — save-first, clarify later
  extraction_reasoning?: string; // Level 2 derivation + post-type rules that fired
}

export interface Pass1Result {
  items: Pass1Item[];
}

// ─── Pass 2 types ──────────────────────────────────────────────────────────────

export interface Pass2Item {
  id: string;
  text: string;
  type: string;
  project?: string;            // project root this item belongs to — set by Pass 2, used by Pass 3 for label
  unique?: Record<string, string>; // structured fields by type — filled by Pass 2, copied through by Pass 3
  schema?: Record<string, string>; // novel types only — field definitions (field → what it captures)
  triggered_by_items: string[];
  based_on_items: string[];
  extends_item?: string;       // ID of another item in this batch that this extends (same topic, broader)
  supersedes_ref?: string;     // label of existing PROJECT GRAPH block this replaces, OR item ID for within-batch replacement
  resolved_ref?: string;
  relations?: Array<{ type: string; target: string; reasoning?: string }>; // semantic relations: contradicts/supports/resolves/derived_from/affects. `reasoning` set by Pass 2c split path (commit 450d631; Q5 case + claim-pair), absent on monolith path. Persisted to turn log (no graph column for it).
  note?: string;
  review_reason?: string;      // set when type was overridden or match confidence is weak
  classification_reasoning?: string; // debug: which path/section was followed and why
  keep_reason?: string;        // v2 COMPREHEND: why this is residue not noise (worth). Debug/turn-log only — stripped from the Pass-3 prompt copy (pass3.ts).
  type_reasoning?: string;     // v2 COMPREHEND: why THIS type's epistemic role fits. Debug/turn-log only — stripped from the Pass-3 prompt copy (pass3.ts).
  source_type?: string;        // block provenance override (e.g. "seam_demoted" — debt-3 demote-edge). Maps to the blocks.source_type column at save. Absent → default "agent_derived".
  excerpt?: string;            // DEBT 5 D3 (§2.3.2) — exact transcript text this item was extracted from. Inherited from Pass1Item.excerpt via re-join in callPass2aLLM (text is re-joined the same way per the 2026-05-25 truncation-fix pattern). Pass 3 persists this to blocks.source_excerpt column for line-level provenance + dedup-by-source-and-value (D2 §2.5.1). Optional because pre-Debt-5 callers + non-arc paths may not populate it; NULL excerpt on a block signals "pre-Debt-5 atomic" by convention.
}

export interface Pass2CausalWiring {
  item_id: string;
  triggered_by: string[];
  based_on: string[];
}

export interface Pass2Result {
  skipped: Array<{ id: string; reason: string }>;
  classified: Pass2Item[];
  causal_wiring?: Pass2CausalWiring[];
}

// ─── Pass 5 types ──────────────────────────────────────────────────────────────

export interface Pass5Chain {
  chain_label: string;   // e.g. "compass_chain_primary-datastore"
  chain_essence: string; // compressed one-sentence story arc
  arc: string;           // type sequence e.g. "fact → dead_end → decision"
  conclusion: string;    // noun phrase: what now exists or is established
  members: string[];     // ordered block labels, cause-first outcome-last
  // Per-chain rationale: WHY these members form one cluster AND WHY the chosen
  // conclusion is the committed terminus (vs an open arc or accumulated context).
  // Each justification names SPECIFIC blocks — definitional, not signal-words.
  // Carries forward for: agent chain navigation ("why does this arc end here?"),
  // audit, debug. Mirrors Pass 2c/Pass 4 per-link reasoning pattern.
  reasoning: string;
}

export interface Pass5Result {
  chains: Pass5Chain[];
}

// ─── DEBT 5 Slice 1 — ARC ENTITY RESOLVE (Stage C) types ──────────────────────
//
// Produced by `runArcEntityResolve` (arc-entity-resolve.ts) BEFORE Pass 2-5
// run at arc time. Pass 3 consumes this for canonical project naming so that
// per-turn Pass 0's per-turn scope_project drift doesn't fragment one arc
// into N project roots (Phase 11 verified bug — see
// docs/DEBT5-PHASE11-FINDINGS-AND-DEPENDENCY-MAP.md).
//
// Identity model (from docs/PIPELINE-AUDIT-DEPENDENCY-MAP.md §1):
//   - Within-arc: entity = (technologies overlap + entities overlap + scene-card
//     scope description) clustered by LLM judgment, NOT label/name string match
//   - LLM picks canonical_name (rule 3 compliance — naming is LLM's job)
//   - Code only checks overlap (system flags equality; LLM merges)
//
// Sub-step 1.1 (this commit): types only — no implementation, no consumer.
// Sub-step 1.2 wires runArcEntityResolve in arc-pipeline.ts.
// Sub-step 1.3 modifies pass3.ts to consume PipelineCheckpoint.arcEntityResolution.

export interface ArcEntityMention {
  turn_id: string;            // conversation_turns.id — back-pointer to source row
  turn_number: number;        // for display + chronological reasoning
  scope_project_name: string; // what THAT turn's Pass 0 called it (the anaphoric form)
  item_ids: string[];         // Pass 1 item IDs from this turn that belong to this entity
}

export interface ArcEntityCluster {
  canonical_name: string;     // LLM-chosen canonical name following strict naming rule
  mentions: ArcEntityMention[];
  // Evidence the LLM used to cluster these mentions — read by debug/audit + later
  // by Stage D (Slice 3) for cross-graph match decisions.
  evidence: {
    shared_technologies: string[];  // names appearing in ≥2 mentions' scene cards
    shared_entities: string[];      // people/orgs appearing in ≥2 mentions
    shared_concepts: string[];      // free-form concept overlap (loose signal)
  };
  // WHY these mentions are one entity. Mirrors Pass 2c per-relation + Pass 5
  // per-chain reasoning pattern. Required for debug ("did the LLM make the
  // right anaphora call?") + future async reviewer context (Slice 2).
  reasoning: string;
}

export interface ArcEntityResolveResult {
  clusters: ArcEntityCluster[];
  // Diagnostic: items the LLM couldn't confidently cluster (uncertain). These
  // fall through to per-turn defaults (Pass 0's scope_project) — caller decides
  // whether to flag for review (Slice 2) or accept the per-turn name.
  unresolved_mentions?: ArcEntityMention[];
  // Telemetry — read by buildCostBreakdown for the arc cost row.
  arc_resolve_reasoning?: string;
  // Provider trail — populated by runArcEntityResolve on success so the
  // downstream cost_breakdown can attribute Stage C's $$ to its own slot
  // (followup #2 from project-slice1-verified-2026-05-31; mirrors the
  // 742f50d pass5 pattern that fixed pass5-into-pass4 mis-attribution).
  // On graceful-degrade failure (LLM returned null), these stay undefined
  // and providers.pass_c_resolve is omitted — ran:false in cost_breakdown.
  model?: string;
  attempts?: Array<{ model: string; outcome: string }>;
}

// ─── DEBT 5 Slice 1 — PIPELINE FLAGS (Stage FLAG) types ───────────────────────
//
// Replaces auto-drop in dedupBySourceAndValue. When code detects duplicate
// candidates, INSTEAD of dropping silently it writes a `pipeline_flags` row
// for async LLM reviewer (Slice 2) to decide merge/leave/split with full
// context. Per user direction: system FLAGS, reasoning MERGES.
//
// Multi-writer: this table is also written by Stage AUDIT (Slice 2 background
// process) and Stage C unresolved mentions (Sub-step 1.2). The `origin_writer`
// field discriminates source. The flag_type enum will grow as more writers
// are added.
//
// Persistence: pipeline_flags table — see database.ts initialize() + the
// new pipeline-flags.ts module (writer + reader functions).

export type PipelineFlagType =
  | 'project_dup_candidate'      // Stage FLAG: project blocks with overlapping content
  | 'atomic_dup_candidate'       // Stage FLAG: atomic blocks with same (source_excerpt, primary_value)
  | 'scope_disagreement'         // Stage AUDIT (Slice 2): same content identity
                                 //   (unique{} primary value) under DIFFERENT
                                 //   project_id (owner). Exact-collision only;
                                 //   paraphrase-across-owner is Stage D / Slice 3.
  | 'island_candidate'           // Stage AUDIT (Slice 2): concept overlap with no cross-link
  | 'block_dup_candidate'        // Stage AUDIT: two NON-root blocks under the SAME scope
                                 //   (project_id) suspected the same claim — exact same
                                 //   primary_value OR essence-token overlap (the reworded /
                                 //   cross-type near-dup the exact checks miss; the
                                 //   recap-restatement case). System FLAGS; the generic
                                 //   reviewer judges merge/leave (scope already confirmed same).
  | 'cross_arc_dup_candidate'    // Stage D (Slice 3): an arc entity resolved (identity +
                                 //   scope) to an EXISTING graph block — 'attach' (same
                                 //   scope) or 'flag' (owner unknown). System FLAGS; the
                                 //   async reviewer ACTS (merge/leave). Judged WITH
                                 //   conversation context, unlike AUDIT's blind scan.
  | 'entity_unresolved'          // Stage C (Sub-step 1.2): anaphora couldn't decide
  | 'provenance_mismatch';       // Gap ④(a) provenance check: a block's source_excerpt
                                 //   does NOT appear in its source transcript. severity
                                 //   'missing' = likely fabricated quote; 'fuzzy' =
                                 //   paraphrased, not verbatim. Single-block flag ($0,
                                 //   deterministic, no LLM). The meaning-reviewer (b')
                                 //   judges the flagged block by re-reading the STORED
                                 //   transcript + chain — never the new turn's context.

export type ScopeCheck = 'same' | 'different' | 'unknown';

export type PipelineFlagWriter =
  | 'stage_flag_dedup'           // Sub-step 1.4 — atomic_dup_candidate
  | 'stage_audit_islands'        // Slice 2.3 — island_candidate
  | 'stage_audit_scope'          // Slice 2.3 — scope_disagreement
  | 'stage_audit_project_dup'    // Slice 2.3 — project_dup_candidate (one writer
                                 //   per flag_type keeps Rule 5 producers disjoint)
  | 'stage_audit_block_dup'      // Periodic AUDIT scan — block_dup_candidate
  | 'inline_dedup'               // Inline recognize-before-write — block_dup_candidate.
                                 //   Same DETECTION as stage_audit_block_dup at a
                                 //   different TIMING (at write, before Pass 4 links),
                                 //   sharing the ONE judge (judgeBlockDupPair) + the
                                 //   either-direction idempotency guard (flagAlreadyExists),
                                 //   feeding the ONE reviewer. Rule 5's spirit (no two
                                 //   writers disagreeing / double-flagging a pair) holds.
  | 'stage_d_resolve'            // Slice 3 — cross_arc_dup_candidate
  | 'stage_c_entity_resolve'     // Sub-step 1.2 — entity_unresolved
  | 'provenance_check';          // Gap ④(a) — provenance_mismatch (the $0 detector)

export type ReviewVerdict =
  | 'merge'                      // dup reviewer: same claim → merge
  | 'leave'                      // dup: not a dup · provenance: grounded, excerpt OK
  | 'split'
  | 'pending_clarification'
  | 'corrected'                  // gap ④(b): grounded, but the wrong excerpt was fixed
  | 'demoted'                    // gap ④(b): claim NOT in transcript (fabricated) → archived
  | null;                        // null = not yet reviewed

/** What the reviewer actually DID to the graph (audit trail). Per flag_type:
 *  dup → archived_loser… · provenance → corrected_excerpt | demoted_unprovenanced. */
export type FlagActionTaken =
  | 'archived_loser_and_wired_superseded_by'
  | 'corrected_excerpt'
  | 'demoted_unprovenanced'
  | 'none'
  | null;

export interface PipelineFlag {
  id: string;                    // "pfl_" + uuid
  flag_type: PipelineFlagType;
  block_id_a: string;
  block_id_b: string | null;     // null for single-block flags (e.g., scope warning)
  // JSON criteria — shape varies by flag_type. Stored as TEXT in DB, parsed here.
  // See PIPELINE-SLICE-1-DESIGN.md §3.1 for per-type expected shape.
  criteria: Record<string, unknown>;
  scope_check: ScopeCheck;
  origin_writer: PipelineFlagWriter;
  origin_range_id: string | null;  // conversation_turn_ranges.id when arc-sourced
  created_at: string;             // ISO timestamp

  // ── Review fields — filled by async reviewer (Slice 2) ──
  reviewed_at: string | null;
  review_verdict: ReviewVerdict;
  review_reason: string | null;

  // ── Action fields — filled when an action executes (merge / correct / demote) ──
  action_taken: FlagActionTaken;
  action_at: string | null;
  winning_block_id: string | null;
}

// ─── Pipeline checkpoint ───────────────────────────────────────────────────────
//
// Carries the outputs of every pass that completed successfully before the one
// that failed.  The failed pass always runs fresh — it receives only the previous
// passes' outputs as context, never any partial work from its own aborted attempt.
//
//   resumeFrom: 'pass1'  →  pass0 output present; Pass 1 reruns with transcript + scene card
//   resumeFrom: 'pass2'  →  pass0 + pass1Items present; Pass 2 reruns with items + scene card
//   resumeFrom: 'pass3'  →  pass0 + pass1Items + pass2Classified present; Pass 3 reruns
//   resumeFrom: 'pass4'  →  pass0 + pass2Classified + p3PendingBlockIds present; Pass 4 reruns
//                           new blocks were written to DB as 'pending' — activated after Pass 4

export interface PipelineCheckpoint {
  resumeFrom: 'pass1' | 'pass2' | 'pass3' | 'pass4';
  pass0?: { sceneCard: string | undefined; raw: any }; // Pass 0 output — scene card context for Pass 1/2/3
  pass1Items?: Pass1Item[];       // Pass 1 output — items to classify (Pass 2) + budget hint (Pass 3)
  pass2Classified?: Pass2Item[];  // Pass 2 output — classified items to build (Pass 3)
  p3PendingBlockIds?: string[];   // Pass 3 output — IDs of blocks written as 'pending', activated after Pass 4
  // v2 front-half wall-time telemetry (2026-06-12): the front-half runs BEFORE
  // runAutoReflect, so its stage timings travel here and merge into the turn-log's
  // pass_wall_ms. Without this the pipeline's biggest time consumer (COMPREHEND +
  // the per-block 2b fill fan-out) was invisible — observability before optimization.
  v2WallMs?: Record<string, number>;
  // Per-stage v2 front-half COST (USD), attributed from the usage ledger over
  // each stage's timing window — the cost twin of v2WallMs. Surfaced in the turn
  // log as v2_front_cost_usd so "which v2 stage spent what" is answerable.
  v2FrontCostUsd?: Record<string, number>;

  // ── DEBT 5 Slice 1 — ARC ENTITY RESOLVE (Stage C) ──
  // When arc-pipeline runs Stage C before the Pass 2-5 sequence, its output
  // travels via this field. Pass 3 reads it to use canonical_name from the
  // matching cluster for each item's label.project, OVERRIDING the per-turn
  // Pass 0 scope_project that's currently trusted verbatim (pass3.ts:75-77).
  // Undefined when:
  //   - Not arc mode (per-turn runs)
  //   - Arc mode but Stage C disabled (Sub-step 1.2 flag-gate)
  //   - Stage C failed (degrade gracefully to per-turn names)
  // Wired by Sub-step 1.2; consumed by Sub-step 1.3 (pass3.ts changes).
  arcEntityResolution?: ArcEntityResolveResult;
}

// ─── Pipeline result types ─────────────────────────────────────────────────────

export interface ReflectCreatedBlock {
  label: string;
  type: string;
  quality: number;
  project: string;
}

export interface ReflectUpdatedBlock {
  label: string;
  type: string;
}

export interface ReflectResult {
  saved: number;
  updated: number;
  skipped: number;
  saved_labels: string[];
  uncertain_count: number;
  created_blocks: ReflectCreatedBlock[];
  updated_blocks: ReflectUpdatedBlock[];
  checkpoint?: PipelineCheckpoint; // set when a pass failed — queue re-runs from checkpoint.resumeFrom
}

// ═══════════════════════════════════════════════════════════════════════════════
// DEBT 5 Slice 2 — ASYNC REVIEWER + STAGE AUDIT types (Sub-step 2.1, contracts)
// ═══════════════════════════════════════════════════════════════════════════════
//
// These types are the durable contracts for the modules built in Sub-steps
// 2.2-2.4. Shipped in 2.1 with NO implementation so future-self has the seam
// artifact even if 2.2 onwards is paused mid-build.
//
// See docs/PIPELINE-SLICE-2-DESIGN.md for the full contract (DO/SERVE/CARRY +
// charter rule alignment + per-sub-step build order). This block is the
// TypeScript half of that doc.
//
// Layering note: kept self-contained (no import from store/database.ts) by
// defining BlockReviewSnapshot — the reviewer only needs a SUBSET of Block's
// columns, and the smaller shape doubles as the explicit "what the reviewer
// can see" contract.

// ─── Reviewer types (flag-reviewer.ts will implement these) ──────────────────

export type ReviewerConfidence = 'high' | 'medium' | 'low';

/** Subset of database.ts Block that the reviewer prompt + merge action need.
 *  Kept lean so the reviewer's input surface is auditable — adding a field
 *  here means deliberately expanding what the LLM sees.  */
export interface BlockReviewSnapshot {
  id: string;
  label: string;
  type: string;                 // block type (project, fact, decision, etc.) — the EPISTEMIC ROLE
  essence: string;
  content: string;              // JSON string per blocks.content column
  concepts: string[];           // PARSED (caller pre-parses from blocks.concepts JSON)
  project_id: string | null;    // for scope comparison
  source: string | null;
  primary_value: string;        // the unique{} CLAIM (per-type identity) — the dedup anchor
}

export interface ReviewerContext {
  flag: PipelineFlag;
  block_a: BlockReviewSnapshot;
  block_b: BlockReviewSnapshot | null;   // null for non-pair flags (entity_unresolved)
  scope_a_chain: string[];               // part_of chain labels: [root, ..., block_a.label]
  scope_b_chain: string[] | null;
}

export interface ReviewerVerdictOutput {
  verdict: ReviewVerdict;                // re-uses Slice 1's enum (merge|leave|split)
  reason: string;                        // WHY — durable audit trail
  winning_block_id?: string;             // REQUIRED when verdict='merge'; null otherwise
  confidence: ReviewerConfidence;        // gates Level 2 auto-merge action
}

export interface FlagReviewerTickResult {
  reviewed: number;
  verdicts: { merge: number; leave: number; split: number };
  actions_executed: number;              // count of auto-merges that actually fired
  routed_to_agent: number;               // owner-unknown flags handed to the agent (no LLM, no auto-merge)
  errors: number;
  cost_usd: number | null;               // null if any unpriced model in the batch
}

// ─── Stage AUDIT types (stage-audit-graph.ts will implement these) ──────────

export interface StageAuditTickResult {
  scanned_pairs: number;
  flags_written: {
    project_dup_candidate: number;
    scope_disagreement: number;
    island_candidate: number;
    block_dup_candidate: number;
  };
  flags_skipped_already_pending: number; // idempotency dedup hits
  errors: number;
  wall_ms: number;
}

// ─── Flag REST endpoint shapes (routes/flags.ts will implement these) ───────

export interface FlagListFilters {
  flag_type?: PipelineFlagType;
  origin_writer?: PipelineFlagWriter;
  reviewed?: boolean;
  block_id?: string;
  limit?: number;
}

/** Single-flag detail returned by GET /api/flags/:id — includes the two
 *  blocks' content so the operator can SEE what was flagged without a
 *  follow-up call. Mirrors quarantine.ts/single-entry shape. */
export interface FlagDetailWithBlocks {
  flag: PipelineFlag;
  block_a: BlockReviewSnapshot | null;
  block_b: BlockReviewSnapshot | null;
}

/** Body of POST /api/flags/:id/review — manual operator override.
 *  When `execute=true` AND `verdict='merge'`, the route runs executeMerge
 *  synchronously (charter Rule 2: archive loser, write supersedes relation). */
export interface ManualReviewInput {
  verdict: ReviewVerdict;
  reason: string;
  execute?: boolean;
  winning_block_id?: string;             // required if execute=true AND verdict='merge'
}
