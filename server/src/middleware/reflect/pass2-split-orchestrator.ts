// ═══════════════════════════════════════════════════════════════════════════════
// PASS 2 SPLIT ORCHESTRATOR  (Week 3 piece, debt #1, 2026-05-25)
//
// Role:  Drop-in replacement for `callPass2LLM` (monolith) when
//        NODEDEX_PASS2_SPLIT=1. Runs the full split-mode flow:
//
//          1. pass2a (classify, full batch)             — 1 LLM call
//          2. pass2b (per-item fill, parallelized)      — N LLM calls
//          3. validateSeamAlphaBatch (pure code)
//          4. pass2c (batch wiring)                     — 1 LLM call
//          5. checkSeamBetaInvariant per 2c output item (pure code)
//          6. composeForDownstream → existing Pass2Result shape
//
//        Returns the SAME signature the pipeline.ts call site expects from
//        callPass2LLM, so the if/else branch around it stays minimal.
//
// What goes to quarantine (the audit-safe drain per §3 + §1):
//   - 2b per-item failures (rate-limit, llm-error) — that item never got filled
//   - Seam α failures that survive the RE-FILL RETRY (see step 3.5): 2b's first
//     fill missed a required field → one re-fill attempt at the same type with
//     the failure detail → if it STILL fails, quarantine (retry_attempted=true)
//   - Seam β invariant violations (2c mutated a read-only field)
//   - composer inconsistencies of kind missing_pass2b_fill (defensive — should
//     not happen if upstream routing is correct; if it does, audit the entry)
//
// What goes back as a re-queue checkpoint (transient failure, retry whole pass):
//   - 2a returns null/rate-limited
//   - 2c returns null/rate-limited
//
// Route-back retry — IMPLEMENTED as RE-FILL (step 3.5), an evidence-driven
//   deviation from design §3. Design §3 specified reclassify-via-2a (pick a
//   different type matching what 2b filled). The 2026-05-25 smoke run showed
//   the real cause of seam α failure is 2b UNDER-filling (missing a field that
//   IS in the text), not a wrong type — so reclassify would have downgraded
//   genuine insights to facts. Re-fill instead gives 2b one more shot at the
//   SAME type with the failure detail, targeting the actual root cause and
//   never creating a mis-typed block. Reclassify-via-2a remains available as a
//   future addition IF a genuine wrong-type seam failure is ever observed.
//
// What's DEFERRED for this first wiring (gaps from design's "ready to flip"):
//   1. Multi-model routing — design §7 NON-OPTIONAL (Haiku for 2a/2b, Gemini
//      for 2c). This wiring uses the same provider for all 3 sub-passes
//      (Gemini), which lands in §7 Warning tier ($0.25-0.40/turn expected).
//      Must be implemented BEFORE any default-on flag flip per §7's "MUST
//      hold" list.
//   2. $$ cost telemetry — token counts are tracked in reflectTokenStats but
//      $$ conversion requires per-provider pricing. §7's "Per-pass cost
//      telemetry shipped and reconciles with OpenRouter dashboard within
//      ±10%" is satisfied for tokens, not $$. Conversion is orthogonal,
//      can land as a wrapper over reflectTokenStats post-wiring.
//
// Charter alignment:
//   - Rule 2 (never delete vetted blocks): quarantine entries aren't deletes;
//     candidates that failed the gate are preserved with full audit trail
//   - Rule 6 (guards catch failure, never override success): seam validators
//     REJECT bad input, never silently pass it; orchestrator routes to
//     quarantine, never to /dev/null
//   - Rule 9 (bugs live at seams): this file IS the seam orchestration; every
//     seam transition is explicit + audit-logged
//   - Rule 14 (store the path): quarantine entries carry pass1_text / 2a
//     reasoning / 2b attempt / failure_reason — the full path to the
//     failure, not just the failure
// ═══════════════════════════════════════════════════════════════════════════════

import { v4 as uuidv4 } from "uuid";
import type { WorkspaceDB } from "../../store/database.js";
import type { LLMProvider } from "../../engine/ai-provider.js";
import type { Pass1Item, Pass2Result } from "./types.js";
import { reflectTokenStats } from "./context.js";

import { callPass2aLLM, type Pass2aResult, type Pass2aItem } from "./pass2a.js";
import { callPass2bBatch, type Pass2bResult, type Pass2bInput } from "./pass2b.js";
import { callPass2cLLM, type Pass2cInput } from "./pass2c.js";
import { modelForPass } from "./config.js";
import {
  validateSeamAlphaBatch,
  snapshotForSeamBeta,
  checkSeamBetaInvariant,
  composeForDownstream,
  type SeamAlphaItem,
  type ComposeInput,
} from "./pass2-seams.js";
import {
  ensureQuarantineTable,
  writeQuarantineEntry,
  type QuarantineEntry,
} from "./pass2-quarantine.js";

// ─── Return type — matches callPass2LLM shape ──────────────────────────────────
//
// The pipeline.ts call site treats the result transparently — same fields
// whether produced by monolith or split. This makes the if/else branch a
// one-liner instead of forcing pipeline.ts to know about composer/quarantine.

export interface Pass2SplitResult {
  result: Pass2Result | null;
  thinking: string;
  rateLimited: boolean;
  model?: string;
  attempts?: Array<{ model: string; outcome: string }>;
  // Split-specific audit data (populated when result is non-null)
  splitAudit?: {
    pass2a_items_in:          number;
    pass2a_classified:        number;
    pass2a_skipped:           number;
    pass2b_filled:            number;
    pass2b_failed:            number;
    seam_alpha_proceed:       number;  // FINAL proceed (incl. re-fill salvaged + demoted)
    seam_alpha_route_back:    number;  // first-pass route_back → entered re-fill
    refill_attempted:         number;  // items given a 2b re-fill retry
    refill_salvaged:          number;  // re-fill retries that then passed seam α
    seam_alpha_quarantine:    number;  // first-pass quarantine verdicts (defensive; ~always 0)
    // Demote-edge (2026-05-27, debt-3): opt-in via NODEDEX_SEAM_ALPHA_DEMOTE=1.
    // Items previously quarantined for missing required fields that DO have the
    // source field for a structurally-equivalent type (see DEMOTE_TARGETS in
    // pass2-seams.ts) are re-typed and routed to proceed instead. Keep these
    // counters observable so quarantine drainage doesn't silently hide the
    // problem-class — it relocates here.
    demote_enabled:           boolean;
    seam_alpha_demoted:       number;
    demoted_breakdown:        Record<string, number>;  // e.g. {"insight->fact": 3}
    seam_beta_violations:     number;
    pass2c_wired:             number;
    quarantine_writes:        number;
    compose_inconsistencies:  number;
  };
}

// ─── runPass2Split — the orchestration ─────────────────────────────────────────
//
// Signature mirrors `callPass2LLM(provider, items, projectContext, prevMap,
// thinkingBudget, sceneCard)` so pipeline.ts can substitute one for the other
// without other call-site changes.

export async function runPass2Split(
  provider: LLMProvider,
  db: WorkspaceDB,
  pass1Items: Pass1Item[],
  projectContext: string,
  prevEntityMap: Array<{ reference: string; resolved_to: string }>,
  thinkingBudget: number,
  sceneCard: string | undefined,
  sourceSessionId: string,
): Promise<Pass2SplitResult> {
  // Ensure quarantine table exists. Idempotent — safe to call every turn.
  // First-call latency is one CREATE IF NOT EXISTS + 4 indexes; negligible.
  ensureQuarantineTable(db.rawDb);

  // Stable batch_id for all quarantine entries from this turn.
  const batch_id = `batch_${uuidv4()}`;

  const allAttempts: Array<{ model: string; outcome: string }> = [];

  // ── Multi-model routing (C, 2026-05-25) ──────────────────────────────────────
  // Per PASS2-SPLIT-DESIGN.md §7 cost recalibration, the split's cost-tier bet
  // depends on routing 2a/2b (structural) to a cheaper model (Haiku-class)
  // while keeping 2c (semantic wiring) on a stronger model (Gemini Flash/Pro).
  //
  // Opt-in via env vars (universal — provider-agnostic string passed straight
  // through to provider.generateStructured's modelOverride). Absent env var →
  // no routing for that sub-pass → uses provider default → identical to today.
  //
  //   NODEDEX_PASS2A_MODEL — e.g. "anthropic/claude-haiku-4-5" (via OpenRouter)
  //   NODEDEX_PASS2B_MODEL — e.g. "anthropic/claude-haiku-4-5"
  //   NODEDEX_PASS2C_MODEL — e.g. "google/gemini-2.5-flash" (typically left unset
  //                          so 2c uses provider default; useful for A/B)
  //
  // Safety guard: if the provider is "gemini" (the GeminiProvider singleton),
  // modelOverride to a non-Gemini model name will fail at the provider layer.
  // We DON'T block the override here — the user is responsible for ensuring
  // their AI_PROVIDER can serve the model they request. Logging the intent so
  // a failure is debuggable (the turn log providers[] will show the failed model).
  // Per-pass override → NODEDEX_REASONING_MODEL (2a/2c) / NODEDEX_STRUCTURAL_MODEL (2b)
  // tier → provider default. modelForPass keeps the existing NODEDEX_PASS2{A,B,C}_MODEL
  // as the highest-priority override (backward compatible).
  const pass2aModel = modelForPass("pass2a");
  const pass2bModel = modelForPass("pass2b");
  const pass2cModel = modelForPass("pass2c");

  // Demote-edge (2026-05-27, debt-3 structural-small). Seam α emits a `demote`
  // verdict for items whose required field is unfillable but whose source field
  // for a structurally-equivalent type IS present (see DEMOTE_TARGETS in
  // pass2-seams.ts); the orchestrator re-types those items and routes to proceed
  // instead of quarantining. DEFAULT-ON as of 2026-05-27 (flip after E2E
  // validation: 14 demotes insight→fact, 0 regression, quarantine drained 9→0)
  // — mirrors the NODEDEX_PASS2_SPLIT flip pattern. Reversible: set
  // NODEDEX_SEAM_ALPHA_DEMOTE=0 to disable. Full diagnosis + plan + validation:
  // memory project-insight-fact-typing-gap.
  const enableDemote = process.env.NODEDEX_SEAM_ALPHA_DEMOTE !== "0";
  if (!enableDemote) {
    console.log(`Auto-Reflect Pass 2 split: seam α demote DISABLED (NODEDEX_SEAM_ALPHA_DEMOTE=0)`);
  }
  if (pass2aModel || pass2bModel || pass2cModel) {
    const parts: string[] = [];
    if (pass2aModel) parts.push(`2a→${pass2aModel}`);
    if (pass2bModel) parts.push(`2b→${pass2bModel}`);
    if (pass2cModel) parts.push(`2c→${pass2cModel}`);
    console.log(`Auto-Reflect Pass 2 split: multi-model routing ${parts.join(", ")} (provider=${provider.getName()})`);
  }

  // ── Step 1: Pass 2a (classify) ───────────────────────────────────────────────
  const a = await callPass2aLLM(provider, pass1Items, projectContext, prevEntityMap, thinkingBudget, sceneCard, pass2aModel);

  // Stamp 2a usage into telemetry.
  if (a.usage) {
    reflectTokenStats.pass2a.input    += a.usage.input    ?? 0;
    reflectTokenStats.pass2a.thinking += a.usage.thinking ?? 0;
    reflectTokenStats.pass2a.output   += a.usage.output   ?? 0;
    reflectTokenStats.pass2a.calls    += 1;
  }
  if (a.attempts) allAttempts.push(...a.attempts.map((x) => ({ ...x, model: `2a:${x.model}` })));

  if (!a.result) {
    // 2a failed — bubble up as if monolith failed. pipeline.ts will re-queue.
    return {
      result: null,
      thinking: a.thinking,
      rateLimited: a.rateLimited,
      model: a.model,
      attempts: allAttempts,
    };
  }

  // ── Step 2: Pass 2b batch (fill unique{} per item) ───────────────────────────
  // Defensive empty-classified case: no items to fill or wire; emit empty result.
  if (a.result.classified.length === 0) {
    return {
      result: { skipped: a.result.skipped, classified: [], causal_wiring: [] },
      thinking: a.thinking,
      rateLimited: false,
      model: a.model,
      attempts: allAttempts,
      splitAudit: {
        pass2a_items_in: pass1Items.length,
        pass2a_classified: 0,
        pass2a_skipped: a.result.skipped.length,
        pass2b_filled: 0, pass2b_failed: 0,
        seam_alpha_proceed: 0, seam_alpha_route_back: 0,
        refill_attempted: 0, refill_salvaged: 0,
        seam_alpha_quarantine: 0,
        demote_enabled: process.env.NODEDEX_SEAM_ALPHA_DEMOTE === "1",
        seam_alpha_demoted: 0,
        demoted_breakdown: {},
        seam_beta_violations: 0, pass2c_wired: 0,
        quarantine_writes: 0, compose_inconsistencies: 0,
      },
    };
  }

  const pass2bInputs: Pass2bInput[] = a.result.classified.map((c) => ({
    id:                       c.id,
    text:                     c.text,
    type:                     c.type,
    classification_reasoning: c.classification_reasoning,
  }));

  const b = await callPass2bBatch(provider, pass2bInputs, pass2bModel ? { modelOverride: pass2bModel } : undefined);

  // Stamp 2b usage: callPass2bBatch rolls up per-item usage across the whole
  // batch (D-fix 2026-05-25 — previously only .calls was bumped → pass2b billed $0).
  reflectTokenStats.pass2b.input    += b.usage.input;
  reflectTokenStats.pass2b.thinking += b.usage.thinking;
  reflectTokenStats.pass2b.output   += b.usage.output;
  reflectTokenStats.pass2b.calls    += b.results.length + b.failures.length;

  // Map back: each 2a-classified item has either a 2b result, or it failed.
  const filledById = new Map<string, Pass2bResult>();
  for (const r of b.results) filledById.set(r.id, r);

  // Quarantine helpers — defined before Step 3 so both first-pass and the
  // re-fill retry stage can use them. Collect a count for the audit summary.
  let quarantineWrites = 0;
  let refillAttempted = 0;
  let refillSalvaged = 0;
  const now = () => new Date().toISOString();

  const quarantineForFailedB = (item: Pass2aItem, failure_reason: string): QuarantineEntry => ({
    // Turn-unique PK. item.id is the Pass 1 id (item_1..item_N), which RESETS
    // per turn — using it bare as the quarantine PK collides across turns in one
    // workspace (cross-session), throwing UNIQUE-constraint and crashing the turn.
    // batch_id is a fresh per-turn uuid, so this is unique across turns AND within
    // one (item.id unique within a turn). Fixed 2026-05-26 (deep-test turn 3).
    id:                       `${batch_id}_${item.id}`,
    pass1_text:               item.text,
    pass1_provisional_type:   pass1Items.find((p) => p.id === item.id)?.provisional_type ?? "",
    pass1_reasoning:          pass1Items.find((p) => p.id === item.id)?.extraction_reasoning ?? null,
    pass1_excerpt:            pass1Items.find((p) => p.id === item.id)?.excerpt ?? null,
    pass2a_classified:        item.type,
    pass2a_reasoning:         item.classification_reasoning ?? "",
    pass2a_alternatives:      [],
    pass2b_attempted:         {},
    pass2b_failure_reason:    failure_reason,
    retry_attempted:          false,
    retry_2a_classified:      null,
    retry_outcome:            null,
    batch_id,
    source_session_id:        sourceSessionId,
    quarantined_at:           now(),
    siblings_promoted:        [],
    queued_for_enrichment:    true,
    enrichment_attempts:      [],
    promotion_blocked_until:  null,
    agent_clarification:      null,
  });

  const quarantineForSeamFailure = (
    item: Pass2aItem,
    fill: Pass2bResult,
    failure_reason: string,
    retried: boolean,
  ): QuarantineEntry => ({
    // Turn-unique PK. item.id is the Pass 1 id (item_1..item_N), which RESETS
    // per turn — using it bare as the quarantine PK collides across turns in one
    // workspace (cross-session), throwing UNIQUE-constraint and crashing the turn.
    // batch_id is a fresh per-turn uuid, so this is unique across turns AND within
    // one (item.id unique within a turn). Fixed 2026-05-26 (deep-test turn 3).
    id:                       `${batch_id}_${item.id}`,
    pass1_text:               item.text,
    pass1_provisional_type:   pass1Items.find((p) => p.id === item.id)?.provisional_type ?? "",
    pass1_reasoning:          pass1Items.find((p) => p.id === item.id)?.extraction_reasoning ?? null,
    pass1_excerpt:            pass1Items.find((p) => p.id === item.id)?.excerpt ?? null,
    pass2a_classified:        item.type,
    pass2a_reasoning:         item.classification_reasoning ?? "",
    pass2a_alternatives:      [],
    pass2b_attempted:         fill.unique,
    pass2b_failure_reason:    failure_reason,
    retry_attempted:          retried,
    retry_2a_classified:      null,  // re-fill keeps the same type (no 2a reclassify)
    retry_outcome:            retried ? "same_type_quarantined" : null,
    batch_id,
    source_session_id:        sourceSessionId,
    quarantined_at:           now(),
    siblings_promoted:        [],
    queued_for_enrichment:    true,
    enrichment_attempts:      [],
    promotion_blocked_until:  null,
    agent_clarification:      null,
  });

  // Rule 6 (guards catch failure, never destroy): a single quarantine write
  // failure must not abort the whole turn — writeQuarantineEntry runs inside
  // pipeline.ts's try/catch, so an uncaught throw here zeroes EVERY block this
  // turn. Log + skip the one entry instead. (Surfaced 2026-05-26: a duplicate-PK
  // SqliteError crashed turn 3 of the deep test before the composite-id fix.)
  const safeQuarantine = (entry: QuarantineEntry): void => {
    try {
      writeQuarantineEntry(db.rawDb, entry);
      quarantineWrites++;
    } catch (e) {
      console.error(`Auto-Reflect Pass 2 split: quarantine write failed for "${entry.id}" — skipping (non-fatal): ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  // ── Step 3: Seam α validation (first pass) ───────────────────────────────────
  // For items 2b successfully filled, run validateSeamAlphaBatch. Items 2b
  // hard-failed on (rate-limit / error) never got a fill → quarantined in Step 4.
  const seamAlphaInputs: SeamAlphaItem[] = [];
  for (const c of a.result.classified) {
    const fill = filledById.get(c.id);
    if (!fill) continue;
    seamAlphaInputs.push({ id: c.id, type: c.type, unique: fill.unique, schema: c.schema });
  }
  // First pass: items have _seam_alpha_retries=0, so the `demote` verdict can
  // never fire here (demote requires retries >= MAX_RETRIES). Pass the option
  // anyway for consistency — `seam1.demote` will always be empty by design.
  const seam1 = validateSeamAlphaBatch(seamAlphaInputs, { enable_demote: enableDemote });
  const proceedIds = new Set<string>(seam1.proceed.map((p) => p.item.id));
  // Demote audit: counter + per-pair breakdown for telemetry.
  let demotedCount = 0;
  const demotedBreakdown: Record<string, number> = {};

  // ── Step 3.5: RE-FILL RETRY for seam α route_back items ──────────────────────
  // A route_back verdict means 2b's filled unique{} didn't satisfy the type's
  // schema (a required field missing). Instead of reclassifying the type (design
  // §3's original spec), we give 2b ONE more shot at the SAME type with the
  // failure detail injected — because the smoke run showed the real cause is 2b
  // UNDER-filling (e.g. missing an implication that IS in the text), not a wrong
  // type. Re-fill targets that root cause and can't create mis-typed blocks.
  // Genuinely-unfillable items fail again (retries=1 → quarantine verdict).
  //
  // Evidence-driven deviation from design §3 (reclassify-via-2a), documented
  // 2026-05-25. Reclassify remains available as a future addition if we ever
  // observe a genuine wrong-type seam failure.
  if (seam1.route_back.length > 0) {
    refillAttempted = seam1.route_back.length;
    // Stable alias — `a.result` narrowing is lost across the awaits below.
    const classified2a = a.result.classified;

    const retryInputs: Pass2bInput[] = seam1.route_back.map((rb) => {
      const c = classified2a.find((x) => x.id === rb.item.id)!;
      return {
        id:                       c.id,
        text:                     c.text,
        type:                     c.type,
        classification_reasoning: c.classification_reasoning,
        retryFailureDetail:       rb.failure_detail,
      };
    });

    const retryB = await callPass2bBatch(provider, retryInputs, pass2bModel ? { modelOverride: pass2bModel } : undefined);
    reflectTokenStats.pass2b.input    += retryB.usage.input;
    reflectTokenStats.pass2b.thinking += retryB.usage.thinking;
    reflectTokenStats.pass2b.output   += retryB.usage.output;
    reflectTokenStats.pass2b.calls    += retryB.results.length + retryB.failures.length;

    // Retry hard-failures (rate-limit / error) → quarantine.
    for (const f of retryB.failures) {
      const item = classified2a.find((c) => c.id === f.id);
      if (!item) continue;
      safeQuarantine(quarantineForFailedB(item, `pass2b_retry_${f.reason}${f.detail ? `:${f.detail.slice(0, 100)}` : ""}`));
    }

    // Re-validate seam α with _seam_alpha_retries=1 → a second failure now
    // yields a quarantine verdict (not another route_back).
    const retryFilledById = new Map<string, Pass2bResult>();
    for (const r of retryB.results) retryFilledById.set(r.id, r);
    const retrySeamInputs: SeamAlphaItem[] = retryB.results.map((r) => {
      const c = classified2a.find((x) => x.id === r.id)!;
      return { id: r.id, type: c.type, unique: r.unique, schema: c.schema, _seam_alpha_retries: 1 };
    });
    const seam2 = validateSeamAlphaBatch(retrySeamInputs, { enable_demote: enableDemote });

    // Salvaged → proceed (override the fill with the successful retry fill).
    for (const p of seam2.proceed) {
      proceedIds.add(p.item.id);
      filledById.set(p.item.id, retryFilledById.get(p.item.id)!);
      refillSalvaged++;
    }
    // ── Demote handling (debt-3 structural-small, 2026-05-27) ─────────────────
    // Items that 2b couldn't fill the required field for, but whose source field
    // for a structurally-equivalent type IS present, are re-typed via the seam α
    // demote verdict. We mutate a.result.classified[].type so Pass 2c + composer
    // + Pass 3 see the new type; we replace the fill's unique{} with the
    // remapped one (so the type's NEW schema is satisfied); and we augment
    // classification_reasoning so the re-type is auditable in the persisted
    // block (lightweight provenance — full source_type=seam_demoted column-level
    // stamp is a separate sub-chunk that needs Pass 3 / database.createBlock
    // plumbing). Rule 6: guard catches failure (unfillable required field),
    // routes to recoverable type, never overrides a 2c/Pass 3 success.
    for (const d of seam2.demote) {
      const item: Pass2aItem | undefined = a.result.classified.find((c) => c.id === d.item.id);
      const fill = retryFilledById.get(d.item.id);
      if (!item || !fill) continue;
      const original_type: string = item.type;
      // Apply the re-type. Mutating the classified item is safe — this is the
      // orchestrator's working data, not shared elsewhere after compose.
      item.type = d.new_type;
      // Block-level provenance: carried via composeForDownstream → Pass2Item →
      // pipeline.ts sourceTypeMap → blocks.source_type column. This is the ONLY
      // block-level marker (classification_reasoning does NOT persist to the
      // block — confirmed in the 2026-05-27 E2E run). debt-2 enrichment uses it
      // to find fact→insight re-promotion candidates.
      item.source_type = "seam_demoted";
      const note = `[DEMOTED ${original_type}→${d.new_type} at seam α: ${d.reason}]`;
      item.classification_reasoning = item.classification_reasoning
        ? `${item.classification_reasoning} ${note}`
        : note;
      // Replace the fill's unique{} with the remapped one (insight.observation
      // becomes fact.value). Pass 2c + composer + Pass 3 see only the new shape.
      filledById.set(d.item.id, { ...fill, unique: d.remapped_unique });
      proceedIds.add(d.item.id);
      demotedCount++;
      const key = `${original_type}->${d.new_type}`;
      demotedBreakdown[key] = (demotedBreakdown[key] ?? 0) + 1;
      console.log(`  [seam α demote] ${d.item.id} ${original_type}→${d.new_type}: ${d.reason}`);
    }
    // Still failing after retry → quarantine (retries exhausted, no demote path).
    for (const q of [...seam2.quarantine, ...seam2.route_back]) {
      const item = classified2a.find((c) => c.id === q.item.id);
      const fill = retryFilledById.get(q.item.id);
      if (!item || !fill) continue;
      safeQuarantine(quarantineForSeamFailure(item, fill, `seam_alpha_retry_exhausted:${q.failure_detail}`, true));
    }
  }

  // ── Step 4: First-pass 2b hard-failures → quarantine ─────────────────────────
  // Items 2b never filled at all (rate-limit / error on the first batch). These
  // never reached seam α. Transient-failure retry of the whole item is out of
  // scope for this wiring; preserve in quarantine (recoverable).
  for (const f of b.failures) {
    const item = a.result.classified.find((c) => c.id === f.id);
    if (!item) continue;
    safeQuarantine(quarantineForFailedB(item, `pass2b_${f.reason}${f.detail ? `:${f.detail.slice(0, 100)}` : ""}`));
  }

  // First-pass seam α quarantine verdicts (only fire if an item entered with
  // _seam_alpha_retries already ≥1, which doesn't happen on the first pass —
  // defensive).
  for (const q of seam1.quarantine) {
    const item = a.result.classified.find((c) => c.id === q.item.id);
    const fill = filledById.get(q.item.id);
    if (!item || !fill) continue;
    safeQuarantine(quarantineForSeamFailure(item, fill, `seam_alpha_quarantine:${q.failure_detail}`, false));
  }

  // ── Step 5: Pass 2c batch wiring (only proceed items) ────────────────────────
  // Build 2c inputs from proceed items — read-only context per Seam β contract.
  const pass2cInputs: Pass2cInput[] = a.result.classified
    .filter((c) => proceedIds.has(c.id))
    .map((c) => {
      const fill = filledById.get(c.id)!;
      return {
        id:                       c.id,
        text:                     c.text,
        type:                     c.type,
        project:                  c.project,
        unique:                   fill.unique,
        extends_item:             c.extends_item,
        supersedes_ref:           c.supersedes_ref,
        resolved_ref:             c.resolved_ref,
        classification_reasoning: c.classification_reasoning,
      };
    });

  // Seam β snapshots — taken BEFORE 2c sees the items, verified AFTER.
  const seamBetaSnapshots = new Map(
    pass2cInputs.map((i) => [i.id, snapshotForSeamBeta({ id: i.id, type: i.type, unique: i.unique, text: i.text })]),
  );

  const c = await callPass2cLLM(provider, pass2cInputs, projectContext, thinkingBudget, sceneCard, pass2cModel);

  // Stamp 2c usage.
  if (c.usage) {
    reflectTokenStats.pass2c.input    += c.usage.input    ?? 0;
    reflectTokenStats.pass2c.thinking += c.usage.thinking ?? 0;
    reflectTokenStats.pass2c.output   += c.usage.output   ?? 0;
    reflectTokenStats.pass2c.calls    += 1;
  }
  if (c.attempts) allAttempts.push(...c.attempts.map((x) => ({ ...x, model: `2c:${x.model}` })));

  if (!c.result) {
    // 2c failed — re-queue the whole pass. The work 2a + 2b did is lost
    // (they'll re-run from scratch). Acceptable; transient failure path.
    return {
      result: null,
      thinking: a.thinking + (c.thinking ? `\n\n[2c]\n${c.thinking}` : ""),
      rateLimited: c.rateLimited,
      model: c.model,
      attempts: allAttempts,
    };
  }

  // ── Step 6: Seam β invariant check ───────────────────────────────────────────
  // 2c output IDs should match the inputs (passed in unique-as-context). Per
  // Seam β, 2c is forbidden to mutate type/unique/text/id. Our schema doesn't
  // even let 2c emit those fields, so the LLM CAN'T return them — but check
  // anyway because the sanitizer also runs and we want the invariant verified
  // structurally, not assumed.
  //
  // In this wiring, 2c only emits wiring bundles (no type/unique/text). So
  // the only Seam β violation we could see is a wiring entry with an ID not
  // matching a proceed input — which composeForDownstream catches as
  // orphan_pass2c. So technically Seam β snapshot/check is redundant here.
  // Keep the code path active anyway so when 2c's schema grows (e.g., if Q5
  // is ever expanded to write back to relations on the item directly), the
  // invariant check is already in place. Defense in depth, rule 6.
  //
  // For now: no per-output mutation check possible because 2c output is the
  // wiring bundle, not a (type, unique, text)-shaped item. The snapshot map
  // remains in scope for future use (when 2c output shape expands).
  void seamBetaSnapshots;  // mark as intentionally retained for future invariant
  let seamBetaViolations = 0;

  // ── Step 7: Compose for downstream ───────────────────────────────────────────
  // Only proceed items get passed to compose. The skipped[] from 2a passes
  // through. Quarantined items are NOT in classified (they don't ship to the
  // live graph).
  const proceedClassified = a.result.classified.filter((c2a) => proceedIds.has(c2a.id));
  const proceedFills      = Array.from(filledById.entries())
    .filter(([id]) => proceedIds.has(id))
    .map(([, r]) => r);

  const composeInput: ComposeInput = {
    pass2a: { skipped: a.result.skipped, classified: proceedClassified },
    pass2b_results: proceedFills,
    pass2c: c.result,
  };

  const composed = composeForDownstream(composeInput);

  // Log composer inconsistencies — they're rare (orchestrator design avoids
  // missing_pass2b_fill / missing_pass2c_wiring by routing), but if they
  // occur they're orchestrator bugs to investigate.
  if (composed.inconsistencies.length > 0) {
    console.warn(`Pass 2 split: composer surfaced ${composed.inconsistencies.length} inconsistency(ies) — investigate`);
    for (const inc of composed.inconsistencies) {
      console.warn(`  ${inc.kind} on ${inc.id}: ${inc.detail}`);
    }
  }

  // Summary log line — concise turn-level signal.
  const demoteFragment = demotedCount > 0
    ? `, demoted=${demotedCount} (${Object.entries(demotedBreakdown).map(([k, n]) => `${k}:${n}`).join(",")})`
    : "";
  console.log(
    `Pass 2 split summary: 2a classified=${a.result.classified.length}/${pass1Items.length}, 2b filled=${b.results.length}/${b.failures.length + b.results.length}, ` +
    `seam α first-pass (proceed/route_back)=${seam1.proceed.length}/${seam1.route_back.length}, ` +
    `re-fill (attempted/salvaged)=${refillAttempted}/${refillSalvaged}, final proceed=${proceedIds.size}${demoteFragment}, ` +
    `seam β violations=${seamBetaViolations}, 2c wired=${c.result.wiring.length}, ` +
    `quarantine writes=${quarantineWrites}, compose inconsistencies=${composed.inconsistencies.length}`,
  );

  return {
    result: composed.result,
    thinking: a.thinking + (c.thinking ? `\n\n[2c]\n${c.thinking}` : ""),
    rateLimited: false,
    model: a.model ?? c.model,
    attempts: allAttempts,
    splitAudit: {
      pass2a_items_in:          pass1Items.length,
      pass2a_classified:        a.result.classified.length,
      pass2a_skipped:           a.result.skipped.length,
      pass2b_filled:            b.results.length,
      pass2b_failed:            b.failures.length,
      seam_alpha_proceed:       proceedIds.size,
      seam_alpha_route_back:    seam1.route_back.length,
      refill_attempted:         refillAttempted,
      refill_salvaged:          refillSalvaged,
      seam_alpha_quarantine:    seam1.quarantine.length,
      demote_enabled:           enableDemote,
      seam_alpha_demoted:       demotedCount,
      demoted_breakdown:        demotedBreakdown,
      seam_beta_violations:     seamBetaViolations,
      pass2c_wired:             c.result.wiring.length,
      quarantine_writes:        quarantineWrites,
      compose_inconsistencies:  composed.inconsistencies.length,
    },
  };
}
