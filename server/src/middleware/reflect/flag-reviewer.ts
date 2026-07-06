// ═══════════════════════════════════════════════════════════════════════════════
// DEBT 5 Slice 2 Sub-step 2.2 — ASYNC FLAG REVIEWER
// ═══════════════════════════════════════════════════════════════════════════════
//
// The "reasoning MERGES" half of the user's "system FLAGS, reasoning MERGES"
// directive. Consumes pipeline_flags rows written by Slice 1's Stage FLAG
// (atomic_dup_candidate) and Slice 2.3's Stage AUDIT (project_dup_candidate,
// scope_disagreement, island_candidate). For each pending flag:
//
//   1. Build context: load both blocks + scope chains (db reads, no LLM)
//   2. Call LLM with merge/leave/split prompt — single call per flag
//   3. Write verdict back via markFlagReviewed (idempotent UPDATE)
//   4. If verdict='merge' AND auto-merge enabled AND confidence='high':
//        execute merge — createRelation('supersedes') auto-archives loser
//        per database.ts:1192-1198 (existing supersedes-archive trigger)
//
// Design contract: docs/PIPELINE-SLICE-2-DESIGN.md §2.
// Worker pattern: flag-reviewer-startup.ts wraps this in setInterval.
//
// What this module does NOT do:
//   - Setinterval / startup (that's flag-reviewer-startup.ts)
//   - Stage AUDIT graph scanning (that's stage-audit-graph.ts)
//   - REST endpoints (that's routes/flags.ts)
//   - island_candidate / entity_unresolved review (different shape — both
//     deferred to optional Sub-step 2.6 per design doc §8; this reviewer
//     SKIPS them with verdict='leave' + reason explaining the deferral)
//
// Safety levels per design §2.5 (env-controlled). Since the 2026-06-20
// "self-maintenance locked-on" release decision the DEFAULT is Level 2:
//   Level 0: NODEDEX_FLAG_REVIEWER_ENABLED=off — worker never starts.
//            runFlagReviewerTick can still be called manually (REST sync path).
//   Level 1: NODEDEX_FLAG_AUTO_MERGE=off — verdicts written, NO auto-merge.
//   Level 2 (default): both unset — verdict='merge' AND confidence='high'
//            triggers executeMerge (charter Rule 2: archive not delete,
//            recoverable via /api/blocks).

import type Database from "better-sqlite3";
import type { WorkspaceDB } from "../../store/database.js";
import type { LLMProvider } from "../../engine/ai-provider.js";
import type {
  PipelineFlag,
  ReviewerContext,
  ReviewerVerdictOutput,
  BlockReviewSnapshot,
  FlagReviewerTickResult,
  ReviewerConfidence,
} from "./types.js";
import { getPendingFlags, markFlagReviewed, markFlagPendingClarification } from "./pipeline-flags.js";
import { extractPrimaryValueFromUnique } from "./dedup-by-source-and-value.js";
import { reflectTokenStats } from "./context.js";
import { getThinkingBudget, modelOverride, intFromEnv } from "./config.js";
import { computeCost } from "./cost-pricing.js";

// ─── Config (env-controlled) ──────────────────────────────────────────────────

/** Max flags reviewed per tick. Caps worst-case $$ per tick:
 *  default 5 × ~$0.02-0.05 per call ≈ $0.10-0.25 / tick.
 *  Override via NODEDEX_FLAG_REVIEWER_BATCH_SIZE.  */
function batchSize(): number {
  return intFromEnv("NODEDEX_FLAG_REVIEWER_BATCH_SIZE", 5);
}

/** Model override for the reviewer. Defaults to whatever the default provider
 *  uses; opt-in different model via NODEDEX_FLAG_REVIEWER_MODEL.  */
function reviewerModel(): string | undefined {
  return modelOverride("NODEDEX_FLAG_REVIEWER_MODEL");
}

/** Auto-merge gate. Default ON — Level 2 (self-maintenance locked-on per the
 *  2026-06-20 release decision: clear-case auto-merge is correct + recoverable,
 *  weak evidence is ROUTED to the agent, not merged). Set =off for Level 1
 *  verdict-only. Exported so the startup wrapper logs the SAME gate the tick
 *  honors — the two previously read OPPOSITE defaults, so the boot log claimed
 *  "Level 2" while ticks silently ran verdict-only (found 2026-07-04). */
export function autoMergeEnabled(): boolean {
  return (process.env.NODEDEX_FLAG_AUTO_MERGE ?? "").toLowerCase() !== "off";
}

// ─── Prompt + schema ──────────────────────────────────────────────────────────

const REVIEWER_PROMPT = `You are a graph curator reviewing a candidate-duplicate detection in a knowledge graph.

INPUT: A flag describing two blocks the pipeline (or graph-health audit) suspects might be duplicates, plus the full content + scope of each block.

YOUR DECISION: For this candidate pair, output ONE of three verdicts:
  - "merge":  The two blocks state the SAME CLAIM at the SAME epistemic role — one is a
              restatement/rewording of the other (the same constraint phrased two ways; the same
              fact captured twice). Judge on the \`claim:\` line (the unique{} identity), NOT the
              topic or the essence wording.
  - "leave":  NOT the same claim. Three common cases:
              (a) same topic / surface-similar but a DIFFERENT claim;
              (b) same claim but DIFFERENT SCOPE (different owner/project) — scope dominates;
              (c) DIFFERENT EPISTEMIC ROLE about the same topic — a metric (a measurement) vs a
                  constraint (its implication) vs a fact vs a dead_end vs a hypothesis are NOT
                  duplicates even when about the same thing. They are LINKED (based_on, etc.), not
                  merged. Collapsing them DESTROYS information (e.g. a metric's measurement value).
              When in doubt, LEAVE — a kept pair is recoverable; a wrong merge corrupts the graph.
  - "split":  Real ambiguity — both blocks should remain, BUT something structural needs to change
              (e.g., one should be re-parented to a different project). Or it needs human attention.

KEY RULE — compare the CLAIM, preserve the ROLE:
  Judge sameness on the \`claim:\` line (the unique{} identity = what the block IS), using
  \`essence:\` only as readable context. A duplicate is the SAME claim restated. Blocks of DIFFERENT
  \`type\` carry different epistemic roles and are almost never duplicates on the same topic — merge
  across type ONLY if they are unmistakably the identical claim captured under two type labels.
  Labels are strict {project}_{type}_{concept} (scope_role_topic), so the label echoes scope, role,
  and topic — use it consistently with type and project_id.

KEY RULE — scope dominates content similarity:
  Two blocks with identical content under DIFFERENT scopes (e.g., "auth-service" under Customer-A vs "auth-service" under Customer-B) are NOT duplicates. They serve different graphs. Output "leave".

KEY RULE — winning_block_id required when verdict='merge':
  If verdict='merge', you MUST set winning_block_id to one of block_a.id or block_b.id. Prefer:
    (a) the block with more concepts (richer indexed presence)
    (b) on tie: the block with more content
    (c) on tie: block_a (deterministic tiebreaker)

KEY RULE — confidence is structural:
  - "high":    obvious dup (same source_excerpt + same primary_value) OR obvious non-dup (different scope, different domain)
  - "medium":  content suggests same entity but evidence is partial
  - "low":     genuine ambiguity — the verdict is your best read but a human might disagree

OUTPUT: JSON per schema. Reason must explain WHY in 1-2 sentences — it's read by future audit + the next reviewer cycle.`;

const REVIEWER_SCHEMA = {
  type: "object",
  properties: {
    verdict:          { type: "string", enum: ["merge", "leave", "split"] },
    reason:           { type: "string" },
    winning_block_id: { type: "string" },
    confidence:       { type: "string", enum: ["high", "medium", "low"] },
  },
  required: ["verdict", "reason", "confidence"],
} as const;

// ─── Context loaders (no LLM) ──────────────────────────────────────────────────

/** Load a BlockReviewSnapshot from the blocks table. Returns null if the block
 *  was archived/deleted between flag-write and reviewer-tick (we don't
 *  re-resurrect — the flag becomes stale, reviewer skips it).  */
export function loadBlockSnapshot(
  db: Database.Database,
  blockId: string,
): BlockReviewSnapshot | null {
  const row = db.prepare(`
    SELECT id, label, type, essence, content, concepts, project_id, source, status
      FROM blocks
     WHERE id = ?
  `).get(blockId) as
    | { id: string; label: string; type: string; essence: string; content: string;
        concepts: string; project_id: string | null; source: string | null; status: string | null }
    | undefined;

  if (!row) return null;
  // Honor this function's contract: an ARCHIVED block reads as STALE → null, so a
  // block merged earlier in the SAME tick is NOT re-judged/re-merged. The prior SQL
  // had no status filter → double-archive + archived-winner cascades (2026-06-03
  // reviewer-precision finding: 8 merges produced an incoherent merge graph).
  if (row.status === 'archived') return null;
  let concepts: string[] = [];
  try { concepts = Array.isArray(JSON.parse(row.concepts)) ? JSON.parse(row.concepts) : []; }
  catch { concepts = []; }
  // The CLAIM (unique{} identity) — the dedup anchor. SAME extractor as the detector
  // (Rule 5: one identity definition). Parsed from content.unique{}.
  let unique: Record<string, unknown> = {};
  try { const c = JSON.parse(row.content ?? "{}"); if (c && typeof c.unique === "object" && c.unique) unique = c.unique; }
  catch { /* tolerate malformed content */ }
  return {
    id:         row.id,
    label:      row.label,
    type:       row.type,
    essence:    row.essence,
    content:    row.content,
    concepts,
    project_id: row.project_id,
    source:     row.source,
    primary_value: extractPrimaryValueFromUnique(row.type, unique),
  };
}

/** Walk part_of relations up to the project root. Returns the chain of LABELS
 *  from root → block. Bounded depth (default 8) — graph cycles or pathological
 *  depths return whatever we walked.  */
export function loadScopeChain(
  db: Database.Database,
  blockId: string,
  maxDepth = 8,
): string[] {
  const chain: string[] = [];
  let current: string | null = blockId;
  let depth = 0;
  while (current && depth < maxDepth) {
    const row = db.prepare(`SELECT label FROM blocks WHERE id = ?`).get(current) as { label: string } | undefined;
    if (!row) break;
    chain.unshift(row.label);
    const parent = db.prepare(`
      SELECT target_id FROM relations
       WHERE source_id = ? AND type = 'part_of' AND valid_to IS NULL
       LIMIT 1
    `).get(current) as { target_id: string } | undefined;
    current = parent?.target_id ?? null;
    depth += 1;
  }
  return chain;
}

export function buildReviewerContext(
  db: Database.Database,
  flag: PipelineFlag,
): ReviewerContext | null {
  const block_a = loadBlockSnapshot(db, flag.block_id_a);
  if (!block_a) return null; // flag stale — block_a archived/deleted

  let block_b: BlockReviewSnapshot | null = null;
  if (flag.block_id_b) {
    block_b = loadBlockSnapshot(db, flag.block_id_b);
    // A 2-block dup flag whose partner is archived/gone is STALE (most often: already
    // merged by an earlier flag THIS tick) → skip it, don't degrade to a single-block
    // judgment. This + loadBlockSnapshot's archived-filter is the Problem-2 fix.
    if (!block_b) return null;
  }
  const scope_a_chain = loadScopeChain(db, flag.block_id_a);
  const scope_b_chain = flag.block_id_b ? loadScopeChain(db, flag.block_id_b) : null;

  return { flag, block_a, block_b, scope_a_chain, scope_b_chain };
}

// ─── LLM call ─────────────────────────────────────────────────────────────────

function formatBlockForPrompt(b: BlockReviewSnapshot, scope: string[] | null): string {
  return [
    `  id: ${b.id}`,
    `  label: ${b.label}`,                         // strict: {project}_{type}_{concept} = scope_role_topic
    `  type (epistemic ROLE): ${b.type}`,
    `  claim (unique{} identity — COMPARE THIS): ${b.primary_value || "(none)"}`,
    `  essence (readable context only, NOT the identity): ${b.essence}`,
    `  content: ${b.content.slice(0, 1500)}${b.content.length > 1500 ? " …[truncated]" : ""}`,
    `  concepts: [${b.concepts.join(", ")}]`,
    `  project_id (SCOPE): ${b.project_id ?? "(none)"}`,
    `  source: ${b.source ?? "(none)"}`,
    `  scope_chain: ${scope ? scope.join(" → ") : "(unknown)"}`,
  ].join("\n");
}

export function buildReviewerInput(ctx: ReviewerContext): string {
  const sections: string[] = [
    `FLAG TYPE: ${ctx.flag.flag_type}`,
    `FLAG ORIGIN: ${ctx.flag.origin_writer}`,
    `SCOPE CHECK (pipeline's pre-LLM read): ${ctx.flag.scope_check}`,
    `FLAG CRITERIA (what was detected): ${JSON.stringify(ctx.flag.criteria, null, 2)}`,
    "",
    "BLOCK A:",
    formatBlockForPrompt(ctx.block_a, ctx.scope_a_chain),
  ];
  if (ctx.block_b) {
    sections.push("", "BLOCK B:", formatBlockForPrompt(ctx.block_b, ctx.scope_b_chain));
  } else {
    sections.push("", "BLOCK B: (none — single-block flag; verdict='split' if uncertain)");
  }
  return sections.join("\n");
}

export async function callReviewerLLM(
  provider: LLMProvider,
  ctx: ReviewerContext,
): Promise<{ result: ReviewerVerdictOutput | null; model?: string; rateLimited: boolean }> {
  const userInput = buildReviewerInput(ctx);
  const r = await provider.generateStructured<ReviewerVerdictOutput>(
    REVIEWER_PROMPT,
    userInput,
    REVIEWER_SCHEMA,
    {
      thinkingBudget: getThinkingBudget(1024),  // judgment, not reasoning-heavy
      maxOutputTokens: 4096,                    // small JSON output expected
      modelOverride: reviewerModel(),
      keepReasoning: true,                      // dedup merge/leave/split JUDGE — keep reasoning even on a no-think model
    },
  );

  if (r.usage) {
    reflectTokenStats.pass_reviewer.input    += r.usage.input    ?? 0;
    reflectTokenStats.pass_reviewer.thinking += r.usage.thinking ?? 0;
    reflectTokenStats.pass_reviewer.output   += r.usage.output   ?? 0;
  }
  reflectTokenStats.pass_reviewer.calls += 1;

  return { result: r.result, model: r.model, rateLimited: r.rateLimited };
}

// ─── Merge action ──────────────────────────────────────────────────────────────

/**
 * Execute a merge verdict — wire supersedes (winner → loser) AND archive the
 * loser so the duplicate actually collapses.
 *
 * ⚠ DESIGN NOTE — relaxes the "facts permanent on supersede" rule for the
 * confirmed-duplicate-merge case (surfaced to user 2026-05-31):
 *
 * database.ts:1192-1199 auto-archives a supersede TARGET only when it's a
 * 'blueprint' or 'decision' — facts/constraints/dead_ends/questions are
 * treated as permanent historical records (a contradicted fact stays visible).
 * That rule is correct for GENERIC supersede ("B replaces A's claim; both are
 * history"). It is WRONG for a reviewer-confirmed DUPLICATE, which is a
 * different operation: "A and B are the SAME thing captured twice — collapse
 * to one." A duplicate fact is not two historical records; keeping both is
 * noise, not history. Slice 1's atomic_dup_candidate is PRECISELY duplicate
 * facts (same source_excerpt + same primary_value), so relying on the
 * type-conditional supersede-archive would leave every confirmed fact-dup
 * un-merged.
 *
 * Therefore executeMerge archives the loser DIRECTLY (db.archiveBlock) instead
 * of relying on the supersede side-effect. Charter Rule 2 honored: archive
 * (recoverable via /api/blocks), never delete. Containment: this only runs at
 * Level 2 (NODEDEX_FLAG_AUTO_MERGE=on, default OFF) on a high-confidence
 * reviewer 'merge' verdict — both opt-in gates.
 *
 * Returns the action_taken value to write to the flag row.
 */
export function executeMerge(
  db: WorkspaceDB,
  winnerBlockId: string,
  loserBlockId: string,
): 'archived_loser_and_wired_superseded_by' | 'none' {
  if (winnerBlockId === loserBlockId) return 'none'; // safety: refuse self-merge

  // ── Rewire the loser's relations onto the winner BEFORE archiving ──
  // (1) CONTENT edges (based_on/supports/contradicts/...): archived blocks are filtered
  //     at read, so an un-rewired loser edge would silently vanish — the cluster would
  //     LOSE the loser's connections (e.g. loser supports→hypothesis; gone on merge).
  // (2) the loser's OUTGOING `supersedes` edges (its OWN prior losers, when the loser was
  //     itself a winner in an earlier merge this tick): re-point them to the winner so a
  //     TRANSITIVE merge stays FLAT — every collapsed block ends up superseded DIRECTLY by
  //     the live winner, not via an archived intermediate (A→B, B→C becomes A→C, B→C).
  //     Without this, resolving "the live version of A" needs multi-hop through archived
  //     nodes, and single-hop supersedes resolution would land on a dead block.
  // SKIP only `superseded_by` (createRelation auto-wires that inverse) + `part_of` (the
  // winner already shares the scope). createRelation is idempotent + existence-guarded.
  const raw = (db as any).db as Database.Database;
  const SKIP_REWIRE = new Set(['superseded_by', 'part_of']);
  let rewired = 0;
  try {
    const out = raw.prepare(`SELECT target_id, type FROM relations WHERE source_id = ? AND valid_to IS NULL`).all(loserBlockId) as Array<{ target_id: string; type: string }>;
    for (const r of out) {
      if (SKIP_REWIRE.has(r.type) || r.target_id === winnerBlockId || r.target_id === loserBlockId) continue;
      const rr = db.createRelation({ source_id: winnerBlockId, target_id: r.target_id, type: r.type, created_by: 'flag-reviewer-merge' });
      if ((rr as any).status !== 'skipped' && rr.id) rewired++;
    }
    const inc = raw.prepare(`SELECT source_id, type FROM relations WHERE target_id = ? AND valid_to IS NULL`).all(loserBlockId) as Array<{ source_id: string; type: string }>;
    for (const r of inc) {
      if (SKIP_REWIRE.has(r.type) || r.source_id === winnerBlockId || r.source_id === loserBlockId) continue;
      const rr = db.createRelation({ source_id: r.source_id, target_id: winnerBlockId, type: r.type, created_by: 'flag-reviewer-merge' });
      if ((rr as any).status !== 'skipped' && rr.id) rewired++;
    }
  } catch (e: any) {
    console.warn(`[flag-reviewer] rewire failed for loser=${loserBlockId}: ${e?.message ?? e} — proceeding with supersede+archive`);
  }
  if (rewired > 0) console.log(`[flag-reviewer] merge rewired ${rewired} relation(s) loser=${loserBlockId} → winner=${winnerBlockId}`);

  // createRelation verifies both blocks exist (returns a stub status='skipped'
  // if not) and wires the inverse superseded_by. We do NOT depend on its
  // type-conditional archive (see DESIGN NOTE above).
  const rel = db.createRelation({
    source_id: winnerBlockId,
    target_id: loserBlockId,
    type:      'supersedes',
    created_by: 'flag-reviewer',
  });
  if ((rel as any).status === 'skipped' || !rel.id) {
    console.warn(`[flag-reviewer] merge skipped — one of winner=${winnerBlockId} loser=${loserBlockId} not found`);
    return 'none';
  }
  // Collapse the duplicate: archive the loser regardless of block type. The
  // supersedes edge above is the durable audit pointer (winner supersedes
  // loser); this archive is what actually de-duplicates the graph.
  const archived = db.archiveBlock(loserBlockId, `Merged into ${winnerBlockId} by flag-reviewer (confirmed duplicate)`);
  if (!archived) {
    console.warn(`[flag-reviewer] supersedes wired but archive failed for loser=${loserBlockId} — relation persists, block still active`);
    // Relation IS written; report partial so the flag row reflects reality.
    return 'none';
  }
  return 'archived_loser_and_wired_superseded_by';
}

// ─── Per-tick orchestrator ─────────────────────────────────────────────────────

export interface RunReviewerTickOpts {
  db: WorkspaceDB;
  provider: LLMProvider;
  /** Override the env-controlled auto-merge gate (used by REST manual-review
   *  endpoint, which passes execute=true explicitly).  */
  forceAutoMerge?: boolean;
}

/**
 * One reviewer tick: read up to N pending flags, review each, write verdicts.
 * Returns per-tick result for telemetry + log.
 *
 * This is the SINGLE PUBLIC entry point — flag-reviewer-startup.ts wraps it
 * in setInterval, REST /api/flags/:id/review (Sub-step 2.4) can also invoke
 * it synchronously for a specific flag (via filtered getPendingFlags +
 * forceAutoMerge from request body).
 *
 * Per-flag failure is contained: errors increment the counter and the flag
 * stays unreviewed (next tick picks it up). One bad flag does NOT crash the
 * whole tick.
 */
export async function runFlagReviewerTick(
  opts: RunReviewerTickOpts,
): Promise<FlagReviewerTickResult> {
  const rawDb = (opts.db as any).db as Database.Database;
  const limit = batchSize();
  const pending = getPendingFlags(rawDb, { limit });
  const result: FlagReviewerTickResult = {
    reviewed: 0,
    verdicts: { merge: 0, leave: 0, split: 0 },
    actions_executed: 0,
    routed_to_agent: 0,
    errors: 0,
    cost_usd: 0,
  };
  const allowAutoMerge = opts.forceAutoMerge ?? autoMergeEnabled();
  const inputTokensBefore = reflectTokenStats.pass_reviewer.input;
  const thinkingTokensBefore = reflectTokenStats.pass_reviewer.thinking;
  const outputTokensBefore = reflectTokenStats.pass_reviewer.output;
  let modelUsed: string | undefined;
  let unpricedHit = false;

  for (const flag of pending) {
    // Deferral: island_candidate + entity_unresolved don't fit merge/leave/split
    // cleanly — design §2.4 + §7 mark Sub-step 2.6 as the optional reviewer for
    // these. For now: write 'leave' + a deferral reason so they don't re-block
    // the queue. The flag stays in the DB for audit + future re-review.
    if (flag.flag_type === 'island_candidate' || flag.flag_type === 'entity_unresolved') {
      const ok = markFlagReviewed(rawDb, {
        flag_id: flag.id,
        verdict: 'leave',
        reason: `Deferred: ${flag.flag_type} review requires Sub-step 2.6 (design §8 optional). Flag preserved for audit + manual review via /api/flags.`,
        action_taken: 'none',
      });
      if (ok) { result.reviewed += 1; result.verdicts.leave += 1; }
      continue;
    }

    // Owner-unknown → the agent's call, not the autonomous reviewer's. Stage D's
    // flag_for_review means "identity matches an existing block, but that block's
    // owner is a catch-all/placeholder (genuinely unknown)". Deciding ownership needs
    // context the reviewer lacks — the conversation + the ability to ask the user —
    // so route it to the agent (no LLM, no auto-merge) instead of GUESSING which owner
    // an orphan belongs to. Leaves reviewed_at NULL so the agent can still resolve via
    // POST /api/flags/:id/review.
    //
    // Trigger is SPECIFIC: origin_writer='stage_d_resolve' AND scope_check='unknown'.
    // scope_check='unknown' alone is NOT enough — D2 atomic-dups (stage_flag_dedup)
    // and one AUDIT path also use 'unknown' as a default, but those are same-source /
    // mechanical, not genuine owner-ambiguity. (Latent cleanup: make those writers
    // set an honest scope_check so this could key on scope_check alone.)
    if (flag.origin_writer === 'stage_d_resolve' && flag.scope_check === 'unknown') {
      const ok = markFlagPendingClarification(rawDb, {
        flag_id: flag.id,
        reason: `Owner unknown — routed to the agent to confirm ownership (or ask the user). The reviewer must not guess which owner this matches.`,
      });
      if (ok) result.routed_to_agent += 1;
      continue;
    }

    try {
      const ctx = buildReviewerContext(rawDb, flag);
      if (!ctx) {
        // Stale: block_a was archived/deleted between flag-write and review
        const ok = markFlagReviewed(rawDb, {
          flag_id: flag.id,
          verdict: 'leave',
          reason: `Stale: block_id_a=${flag.block_id_a} not found (archived?). Flag auto-resolved as no-op.`,
          action_taken: 'none',
        });
        if (ok) { result.reviewed += 1; result.verdicts.leave += 1; }
        continue;
      }

      const llmResp = await callReviewerLLM(opts.provider, ctx);
      if (!llmResp.result) {
        result.errors += 1;
        console.warn(`[flag-reviewer] LLM call failed for flag=${flag.id} (rateLimited=${llmResp.rateLimited}) — flag stays unreviewed`);
        continue;
      }
      if (llmResp.model) modelUsed = llmResp.model;

      const v: ReviewerVerdictOutput = llmResp.result;
      // Safety: validate verdict + winning_block_id consistency. Narrow to the
      // 3-way reviewer verdict (the schema enum) — ReviewVerdict is broader
      // ('pending_clarification' | null are persistence states, not reviewer
      // outputs). Anything off-enum collapses to 'leave' (safe no-op).
      const validVerdict: 'merge' | 'leave' | 'split' =
        (v.verdict === 'merge' || v.verdict === 'split') ? v.verdict : 'leave';
      const validConfidence: ReviewerConfidence = (['high','medium','low'] as ReviewerConfidence[]).includes(v.confidence)
        ? v.confidence : 'low';

      // Decide action
      let actionTaken: 'archived_loser_and_wired_superseded_by' | 'none' = 'none';
      let winningId: string | null = null;
      let routedUnclear = false;
      if (validVerdict === 'merge' && allowAutoMerge) {
        // Validate winning_block_id is one of the candidates (defense vs LLM hallucination)
        const validWinner = !!v.winning_block_id &&
          (v.winning_block_id === flag.block_id_a || v.winning_block_id === flag.block_id_b);
        if (validConfidence === 'high' && validWinner) {
          const loser = v.winning_block_id === flag.block_id_a ? flag.block_id_b : flag.block_id_a;
          if (loser) {
            actionTaken = executeMerge(opts.db, v.winning_block_id!, loser);
            winningId = v.winning_block_id!;
            if (actionTaken !== 'none') result.actions_executed += 1;
          }
        } else {
          // Merge-LEAN but not confidently auto-executable: either confidence is
          // below 'high' (the reviewer reads SAME claim but isn't sure — a reworded
          // / drift dup is 'medium' by the confidence rubric, never 'high'), or the
          // LLM named a winner outside the candidate pair. Do NOT silently record-
          // and-drop (the dup would persist + re-flag forever) and do NOT auto-archive
          // on weak evidence (a wrong merge corrupts the graph). Route to the AGENT,
          // which has the conversation + can ask the user. ("system FLAGS, reasoning
          // MERGES, the agent resolves the genuinely-unclear ones.")
          const why = validConfidence !== 'high'
            ? `confidence=${validConfidence} (below the auto-merge bar)`
            : `winner="${v.winning_block_id ?? 'none'}" not in the candidate pair`;
          const ok = markFlagPendingClarification(rawDb, {
            flag_id: flag.id,
            reason: `Reviewer leans MERGE but ${why} — routed to the agent to confirm these are the same claim reworded (or to keep them separate). Reviewer reason: ${v.reason || '(none)'}`,
          });
          if (ok) { result.routed_to_agent += 1; routedUnclear = true; }
        }
      } else if (validVerdict === 'merge' && !allowAutoMerge) {
        // Level 1 verdict-only: record the LLM's choice but DON'T act (operator chose
        // manual REST review; agent-routing is reserved for the auto-merge path).
        winningId = v.winning_block_id ?? null;
      }

      if (!routedUnclear) {
        const ok = markFlagReviewed(rawDb, {
          flag_id: flag.id,
          verdict: validVerdict,
          reason: v.reason || `(LLM returned no reason; confidence=${validConfidence})`,
          action_taken: actionTaken,
          winning_block_id: winningId,
        });
        if (ok) {
          result.reviewed += 1;
          result.verdicts[validVerdict] += 1;
        }
      }
    } catch (e: any) {
      result.errors += 1;
      console.warn(`[flag-reviewer] threw on flag=${flag.id}: ${e?.message ?? e}`);
    }
  }

  // Bill the tick's $$ for telemetry — read the delta of pass_reviewer stats
  const inputDelta    = reflectTokenStats.pass_reviewer.input    - inputTokensBefore;
  const thinkingDelta = reflectTokenStats.pass_reviewer.thinking - thinkingTokensBefore;
  const outputDelta   = reflectTokenStats.pass_reviewer.output   - outputTokensBefore;
  if (modelUsed) {
    const tickStats = { input: inputDelta, thinking: thinkingDelta, output: outputDelta, calls: result.reviewed };
    const billed = computeCost(tickStats, modelUsed);
    if (billed === null) unpricedHit = true;
    else result.cost_usd = billed;
  }
  if (unpricedHit) result.cost_usd = null;

  return result;
}
