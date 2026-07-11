// ═══════════════════════════════════════════════════════════════════════════════
// DEBT 5 Phase 3 — ARC EXTRACTION PIPELINE
// ═══════════════════════════════════════════════════════════════════════════════
//
// Reads `conversation_turns` rows in a given range (status='pass01_done' from
// Phase 2's per-turn capture), consolidates them into D1+D4-shaped input
// (raw transcripts + Pass 0-1 outputs in chronological order, sew-as-event
// framing), and runs Pass 2-5 over the merged input via the EXISTING runAuto-
// Reflect checkpoint mechanism (resumeFrom: 'pass2'). After successful
// extraction, creates a `conversation_turn_ranges` row and flips each turn's
// status to 'extracted' with pairing_range_id set.
//
// Design anchors:
//   docs/DEBT5-ATOMIC-AND-ARC-EXTRACTION.md §1.5 (D4 sew-as-event)
//                                          §2.5  (re-extraction semantics)
//                                          §2.5.1 (D2 dedup principle — relies on source_excerpt + value)
//                                          §2.6  (Pass routing — arc runs Pass 2-5)
//                                          §2.6.2 (D1 raw-transcripts-at-arc input layout)
//   docs/DEBT5-INVENTORY-MAP.md §6 (ReflectJob.precomputedPassN pattern reused here)
//
// What this file does NOT do (deferred to later phases):
//   - Phase 4: dedup-by-source-and-value at pre-Pass-3 / write-time
//   - Phase 5: source_excerpt propagation Pass 1 → 2 → 3
//   - Phase 6: D4 Pass 2 prompt addition (sew-as-event instruction in pass2a.ts)
//   - Phase 7: triggers (phase tag detector / MCP tool / API endpoint)
//   - Phase 8: backend handler (idempotency + rate-limit + range validation)
//   - Phase 9: extracted_from + source_excerpt wiring at createBlock sites
//   - Phase 10: safety nets (PreCompact hook + inactivity timeout)

import type { WorkspaceDB, ConversationTurnRow } from "../../store/database.js";
import { runAutoReflect } from "./pipeline.js";
import type { Pass1Item, PipelineCheckpoint, ReflectResult, ArcEntityResolveResult } from "./types.js";
import { getLLMProvider } from "../../engine/providers/index.js";
import { runArcEntityResolve } from "./arc-entity-resolve.js";
import { pipelineV2Enabled, v2LazyCaptureEnabled, arcMaxRetries, formatComprehendTurn } from "./comprehend.js";
import { runComprehendFrontHalf } from "./v2-integrate.js";
import { applyResolvesStatusEffects } from "./resolution-heal.js";
import { isInsufficientCreditError } from "../../engine/providers/failure-policy.js";
import { writeSpendPauseFile, creditExhausted } from "./cost-guard.js";
import { setSpendPaused } from "../../routes/state.js";
import { callPass0LLM, formatSceneCard } from "./pass0.js";
import { callPass1LLM } from "./pass1.js";
import type { LLMProvider } from "../../engine/ai-provider.js";

// Lazy-capture safety net: turns captured WITHOUT Pass 0-1 (NODEDEX_V2_LAZY_CAPTURE)
// rely on the v2 arc engine, which re-reads raw. If v2 FAILS at arc, the v1 path
// needs items — so fill Pass 0-1 now from each turn's raw transcript. Runs ONLY on
// (lazy-capture + v2 failed + empty items): the rare path. Reuses the SAME Pass 0-1
// the capture would have run, persisting back to the turn so v1 + provenance work.
export async function lazyFillPass01(db: WorkspaceDB, provider: LLMProvider, turns: ConversationTurnRow[]): Promise<void> {
  for (const t of turns) {
    let tr: any = {};
    try { tr = JSON.parse(t.transcript_json); } catch { /* malformed — degrade to empty */ }
    try {
      const p0 = await callPass0LLM(provider, tr.agent_thinking ?? "", tr.agent_response ?? "", [], [], tr.user_message ?? "");
      const sceneCard = p0.result ? formatSceneCard(p0.result) : "";
      const p1 = await callPass1LLM(provider, tr.agent_thinking ?? "", tr.agent_response ?? "", "", sceneCard, [], tr.user_message ?? "");
      // REFILL (not updateConversationTurnPass01): the turn is ALREADY pass01_done
      // (lazy capture marked it so as the arc-ready signal) — write items in place.
      db.refillConversationTurnPass01(t.id, JSON.stringify({ scene_card: p0.result ?? null, items: p1.result?.items ?? [] }));
    } catch (e: any) {
      console.warn(`[arc-extract] lazy-fill Pass 0-1 failed for turn ${t.turn_number}: ${e?.message ?? e}`);
    }
  }
}

// ─── Public interface ─────────────────────────────────────────────────────────

export type ArcTriggerSource = 'phase_tag' | 'mcp_tool' | 'api' | 'precompact' | 'inactivity' | 'auto';

export interface ArcExtractionOpts {
  agent_id: string;
  start_turn?: number;            // default: first pass01_done turn
  end_turn?: number;              // default: latest pass01_done turn
  trigger_source: ArcTriggerSource;
  re_extract?: boolean;           // default false — when true, creates a 're-extract' range
}

export interface ArcExtractionResult {
  range_id: string | null;
  turns_consumed: number;
  status: 'extracted'
        | 'no_turns'
        | 'pipeline_failed'      // runAutoReflect THREW — turns left re-extractable
        | 'pipeline_incomplete'  // v2-only fail-clean: front-half OR back-half failed after the retry budget — turns left re-extractable, NOT marked extracted (no silent loss)
        | 'in_progress'          // Phase 8: another arc-extract already running for this agent
        | 'rate_limited'         // Phase 8: too soon after last extraction
        | 'min_range_too_small'; // Phase 8: range < 2 turns; atomic extraction was enough
  start_turn?: number;
  end_turn?: number;
  reflect_result: ReflectResult | null;
  error?: string;
  rate_limited_retry_after_ms?: number;  // when status='rate_limited', how long to wait
}

// ─── Phase 8: backend handler — idempotency + rate-limit + min-range guard ───
//
// These guards are CENTRAL — every trigger path (phase tag detector, MCP tool,
// API endpoint) goes through runArcExtraction, so wiring the checks here covers
// all three at once. Per design §3.5.
//
// Idempotency (in-memory): a Set of agent_ids currently being extracted.
//   Second trigger while one's in flight → returns 'in_progress' without
//   running. Survives single-process lifetime only; restart resets. For
//   multi-process deployments, a DB-backed lock would replace this — Phase 9+
//   work if needed.
//
// Rate-limit: last-extraction-end timestamp per agent. Default 60s gap;
//   configurable via NODEDEX_ARC_RATE_LIMIT_SECONDS env.
//
// Min-range: < 2 turns means atomic extraction was enough — arc adds no value.
//   Returns 'min_range_too_small' (caller can log + ignore).

const _arcInProgress = new Set<string>();   // agent_ids currently extracting
const _arcLastEndTs = new Map<string, number>();  // agent_id → epoch ms of last successful end

function getRateLimitMs(): number {
  const envSec = process.env.NODEDEX_ARC_RATE_LIMIT_SECONDS;
  if (envSec) {
    const n = Number.parseInt(envSec, 10);
    if (Number.isFinite(n) && n >= 0) return n * 1000;
  }
  return 60_000;  // default 60s per design §3.5
}

// Exported for tests — reset the in-memory guards. NOT for production callers.
export function _resetArcGuardsForTests(): void {
  _arcInProgress.clear();
  _arcLastEndTs.clear();
}

// ─── runArcExtraction — the orchestrator ──────────────────────────────────────

export async function runArcExtraction(
  db: WorkspaceDB,
  opts: ArcExtractionOpts,
): Promise<ArcExtractionResult> {
  // ── Phase 8 guard 1: idempotency (in-memory) ───────────────────────────────
  // Reject if an arc extraction is already in flight for this agent_id. The
  // caller (hook / API / MCP) should retry later — the in-flight extraction
  // will catch the same range (or a superset).
  if (_arcInProgress.has(opts.agent_id)) {
    return {
      range_id: null,
      turns_consumed: 0,
      status: 'in_progress',
      reflect_result: null,
    };
  }

  // ── Phase 8 guard 2: rate-limit ────────────────────────────────────────────
  // Reject if the last successful extraction for this agent ended < N seconds
  // ago. Per design §3.5 + Rule 4: don't trust LLM restraint as the sole guard
  // — the agent might emit <!-- arc-extract --> twice in close succession,
  // or two trigger paths (phase tag + hook fallback) might fire in parallel.
  const rateLimitMs = getRateLimitMs();
  const lastEnd = _arcLastEndTs.get(opts.agent_id);
  if (lastEnd !== undefined) {
    const elapsed = Date.now() - lastEnd;
    if (elapsed < rateLimitMs) {
      return {
        range_id: null,
        turns_consumed: 0,
        status: 'rate_limited',
        reflect_result: null,
        rate_limited_retry_after_ms: rateLimitMs - elapsed,
      };
    }
  }

  // 1. Resolve the range. Default to "all pass01_done turns for this agent."
  //    Explicit start/end let callers (MCP tool, API, re-extract) scope tighter.
  const candidatesAll = db.listConversationTurnsByAgent(opts.agent_id, { status: 'pass01_done' });
  if (candidatesAll.length === 0) {
    return {
      range_id: null,
      turns_consumed: 0,
      status: 'no_turns',
      reflect_result: null,
    };
  }
  const startTurn = opts.start_turn ?? candidatesAll[0]!.turn_number;
  let endTurn     = opts.end_turn   ?? candidatesAll[candidatesAll.length - 1]!.turn_number;

  // Re-read with the explicit range bounds (in case caller scoped tighter than 'all').
  let turnsInRange = db.listConversationTurnsByAgent(opts.agent_id, {
    status: 'pass01_done',
    minTurn: startTurn,
    maxTurn: endTurn,
  });
  if (turnsInRange.length === 0) {
    return { range_id: null, turns_consumed: 0, status: 'no_turns', reflect_result: null, start_turn: startTurn, end_turn: endTurn };
  }

  // ── Model-floor guard: arc size cap (opt-in) ────────────────────────────────
  // NODEDEX_ARC_MAX_TURNS=N clamps EVERY arc to the OLDEST N turns of its range —
  // repeated triggers then walk the backlog forward chunk by chunk. Exists because
  // arc survival on a weak model ≈ per-call success ^ n_calls: a 15-turn dev arc on
  // a free model died 3/3 attempts while 2-turn slices of the SAME content landed
  // (observed live 2026-07-10). Whole-range comprehension links better — when the
  // model survives it; set this only for below-floor models (free/local), leave
  // unset for flash-lite-class. Deliberately clamps EXPLICIT ranges too: the cap is
  // a statement about the MODEL's capacity, not the caller's intent. endTurn shrinks
  // with the clamp so the recorded range/watermark only covers consumed turns.
  const maxArcTurns = Number(process.env.NODEDEX_ARC_MAX_TURNS ?? 0);
  if (Number.isFinite(maxArcTurns) && maxArcTurns >= 2 && turnsInRange.length > maxArcTurns) {
    turnsInRange = turnsInRange.slice(0, maxArcTurns);
    endTurn = turnsInRange[turnsInRange.length - 1]!.turn_number;
    console.log(`[arc-extract] range clamped to oldest ${maxArcTurns} turn(s) (NODEDEX_ARC_MAX_TURNS) — the rest extracts on later triggers`);
  }

  // ── Phase 8 guard 3: minimum range size ────────────────────────────────────
  // Arc extraction over < 2 turns adds no value over atomic — refuse and let
  // caller try later when more turns have accumulated. Per design §3.5.
  // Exception: re_extract bypasses the min check (caller explicitly wants
  // to reprocess even a single turn — they've made the cost-benefit call).
  if (turnsInRange.length < 2 && !opts.re_extract) {
    return {
      range_id: null,
      turns_consumed: turnsInRange.length,
      status: 'min_range_too_small',
      start_turn: startTurn,
      end_turn: endTurn,
      reflect_result: null,
    };
  }

  // followup 1: on EVERY failure path below, mark the range's still-pending turns
  // with the error (non-destructive — they stay pass01_done/re-extractable) so the
  // freshness surface can tell "queued/coming" from "last attempt failed". Defined
  // here so no failure return can forget it.
  const failClean = (status: ArcExtractionResult['status'], error: string): ArcExtractionResult => {
    try { db.markConversationTurnsExtractFailed(opts.agent_id, startTurn, endTurn, error); } catch { /* best-effort marker */ }
    return { range_id: null, turns_consumed: turnsInRange.length, status, start_turn: startTurn, end_turn: endTurn, reflect_result: null, error };
  };

  // ── Phase 8: acquire the in-flight marker BEFORE the heavy work ──
  // We hold this through the pipeline run + DB writes. The try/finally
  // below ensures we release on every exit path, including thrown errors.
  _arcInProgress.add(opts.agent_id);
  try {

  // 2. Build consolidated input — the D1+D4 transformation.
  //    Raw transcripts (D1) + scene cards + Pass-1 items merged with turn-prefixed
  //    IDs (so Pass 2c can wire cross-turn relations unambiguously). Sew-as-event
  //    header (D4) instructs Pass 2 to treat as ONE continuous arc.
  let consolidated = buildArcConsolidatedInput(opts.agent_id, turnsInRange);

  // ─── PIPELINE v2 (TRANSFORM) — default ON (NODEDEX_PIPELINE_V2) ──────────────
  // When ON, replace the extraction front-half (Stage C + the resumeFrom:'pass2'
  // checkpoint over per-turn Pass-0/1 items) with ONE holistic COMPREHEND read of
  // the RAW arc transcript → a resumeFrom:'pass3' checkpoint. The recognizer
  // (inside runComprehendFrontHalf) does Stage C's root-matching job, so Stage C
  // is skipped here.
  //
  // V2-ONLY failure policy (2026-06-16) — replaces the old "auto-fall-to-v1" degrade:
  //   • checkpoint set        → success, run the back-half.
  //   • reason 'empty'        → v2 read the arc and judged NO residue worth saving.
  //                             A clean, FINAL outcome — we trust the comprehender
  //                             (no v1 double-check); marks turns extracted, 0 blocks.
  //   • failed / threw        → BOUNDED-RETRY (arcMaxRetries); on exhaustion FAIL
  //                             CLEAN (return below) — turns stay re-extractable,
  //                             NEVER auto-fall to v1. v1 runs ONLY as the explicit
  //                             off-switch (NODEDEX_PIPELINE_V2=0 → the !checkpoint
  //                             block below).
  // NOTE: in v2 mode the per-turn pass01 scene-cards/items that
  // buildArcConsolidatedInput assembles go unused — v2 reads the raw transcript
  // instead (intended; v2 replaces that front-half).
  let checkpoint: PipelineCheckpoint | undefined;
  let v2FrontFailed = false;   // a real front-half failure that persisted after all retries
  let v2FrontEmpty  = false;   // v2 ran fine but found no residue worth saving (clean no-op)
  let v2CreditOut   = false;   // the account ran out of credit mid-extraction (pause, don't burn retries)
  if (pipelineV2Enabled()) {
    const v2Transcript = turnsInRange.map((t) => {
      let tr: any = {};
      try { tr = JSON.parse(t.transcript_json); } catch { /* malformed — degrade to empty */ }
      const h = `[TURN ${t.turn_number}${t.turn_name ? ` — ${t.turn_name}` : ""}]`;
      // THINKING rides along only when NODEDEX_COMPREHEND_USE_REASONING=1 (capped per turn)
      return formatComprehendTurn(h, tr.user_message, tr.agent_response, tr.agent_thinking);
    }).join("\n\n");
    const maxRetries = arcMaxRetries();
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const provider = getLLMProvider();
        const front = await runComprehendFrontHalf(db, provider, v2Transcript);
        if (front.checkpoint) {
          checkpoint = front.checkpoint;
          v2FrontFailed = false;
          console.log(`[arc-extract] PIPELINE v2: ${front.groups} group(s), ${front.blocks} block(s), ${front.filled} filled, recognizer attached=${front.recognizer.attached}`);
          break;
        }
        if (front.reason === 'empty') {
          v2FrontEmpty = true;
          console.log(`[arc-extract] PIPELINE v2: no residue worth saving (empty) — nothing to extract`);
          break;
        }
        // Out of credit → DON'T burn the remaining retries (every one 402s identically).
        // Pause spending + bail; arc fail-cleans below so turns stay re-extractable, and
        // the auto-resume timer re-extracts on top-up.
        if (front.reason === 'insufficient_credit') {
          v2CreditOut = true;
          console.warn(`[arc-extract] PIPELINE v2: insufficient credit — pausing spending, leaving turns re-extractable`);
          break;
        }
        // comprehend_failed / seam1_invalid → a real failure; retry if budget remains.
        v2FrontFailed = true;
        console.warn(`[arc-extract] PIPELINE v2 front-half failed (${front.reason}) — attempt ${attempt + 1}/${maxRetries + 1}`);
      } catch (e: any) {
        if (isInsufficientCreditError(e)) {
          v2CreditOut = true;
          console.warn(`[arc-extract] PIPELINE v2 front-half: insufficient credit — pausing spending, leaving turns re-extractable`);
          break;
        }
        v2FrontFailed = true;
        console.warn(`[arc-extract] PIPELINE v2 front-half threw (${e?.message ?? e}) — attempt ${attempt + 1}/${maxRetries + 1}`);
      }
    }
  }

  // CREDIT-OUT (arc) — pause spending + fail clean. Unlike the per-turn queue (which
  // requeues into a paused drain), arc capture stores turns RAW and /extract consumes
  // them only on SUCCESS, so failing clean already leaves the whole arc re-extractable.
  // Setting the spend-pause makes the TUI alert + auto-resume timer apply uniformly: on
  // top-up the pause clears and the next arc trigger re-extracts. Belt-and-suspenders:
  // re-check the live balance so a stale 'insufficient_credit' reason can't false-pause.
  if (v2CreditOut && !checkpoint) {
    const c = await creditExhausted();
    setSpendPaused(true);
    writeSpendPauseFile(`credit exhausted${c.remaining != null ? ` — remaining $${c.remaining.toFixed(2)}` : ""} (auto-resume on top-up)`);
    return failClean('pipeline_incomplete', 'insufficient credit — spending paused; turns left re-extractable (auto-resume on top-up)');
  }

  // V2-ONLY FAIL CLEAN: v2 was the engine, it truly failed (not just empty), and the
  // retry budget is spent. Do NOT fall through to v1 and do NOT mark turns extracted —
  // return so the arc stays re-extractable (a later trigger / a fixed model retries).
  if (v2FrontFailed && !checkpoint) {
    return failClean('pipeline_incomplete', `v2 COMPREHEND front-half failed after ${arcMaxRetries() + 1} attempt(s) — turns left re-extractable`);
  }

  // ⚠ OLD v1 PIPELINE — DO NOT TURN ON. v2 is unconditional now (pipelineV2Enabled()
  // always returns true), so on the v2 path a checkpoint = success, a real failure
  // already returned above, and 'empty' is a clean 0-block result. This v1 block is
  // intentionally unreachable — kept in-tree for reference only.
  if (!checkpoint && !v2FrontEmpty) {
    // ⚠ v1 ARC FALLBACK — RETIRED & DISABLED (2026-06-22). Unreachable: v2 is
    // unconditional (pipelineV2Enabled() always true), so success set `checkpoint`, a real
    // failure already returned failClean above, credit-out returned above, and 'empty' set
    // v2FrontEmpty. Reaching here = a routing regression. FAIL CLEAN (turns stay
    // re-extractable) instead of silently running the retired v1 arc path (lazyFillPass01 +
    // Stage C). The code below is kept verbatim for the follow-up deletion PR.
    return failClean(
      'pipeline_incomplete',
      'v1 arc fallback is retired and disabled — v2 produced neither a checkpoint nor an ' +
      'empty result (routing bug); turns left re-extractable',
    );
  }

  // 4. Invoke runAutoReflect with the checkpoint — OR, when v2 judged the arc empty,
  //    skip the back-half and synthesize a clean 0-block result. turnNumber/turnName
  //    are LEFT undefined deliberately — arc extraction is NOT a new "turn"; it
  //    consumes existing pass01_done turns. The Phase 2 INSERT path checks
  //    (agentId && turnNumber !== undefined), so it's correctly skipped here.
  const runBackHalf = (cp: PipelineCheckpoint | undefined) => runAutoReflect(
    db,
    consolidated.agentResponse,     // sew-as-event narrative + raw transcripts
    [],                              // loadedBlocks — empty; Phase 9 may wire if needed
    consolidated.userMessage,        // chronological aggregate of user messages
    consolidated.agentThinking,      // chronological aggregate of agent thinking
    undefined,                       // embeddings
    [],                              // recalledBlocks
    opts.agent_id,                   // agentId — used for session-state labels
    cp,
    // turnNumber + turnName: undefined intentionally (see comment above)
  );

  let reflectResult: ReflectResult;
  if (v2FrontEmpty) {
    // v2-only: no residue worth saving. No back-half; record a clean 0-block
    // extraction (turns consumed, range created, nothing saved).
    reflectResult = { saved: 0, updated: 0, skipped: 0, saved_labels: [], uncertain_count: 0, created_blocks: [], updated_blocks: [] };
  } else {
    try {
      reflectResult = await runBackHalf(checkpoint);
    } catch (e: any) {
      return failClean('pipeline_failed', String(e?.message ?? e).slice(0, 500));
    }

    // ─── BACK-HALF BOUNDED RE-QUEUE (v2-only fail-clean; fixes silent-loss) ─────
    // runAutoReflect RETURNS a checkpoint (it does not throw) when Pass 3 dropped
    // items (truncation / mandatory-item miss). The per-turn QUEUE consumes that to
    // re-run from pass3; the inline arc path has no queue, so we drive the SAME
    // resume here, bounded by arcMaxRetries. The re-run is idempotent — Pass 3 seeds
    // allBlocks from the DB, so already-saved blocks hit the label-dedup MERGE path
    // (no dups) and only the still-missing items are created. The OLD code IGNORED
    // this checkpoint and marked turns extracted with 0 saved blocks = silent,
    // unrecoverable loss; this loop + the fail-clean below close that hole.
    const maxBack = arcMaxRetries();
    for (let backRetries = 1; reflectResult.checkpoint && backRetries <= maxBack; backRetries++) {
      console.warn(`[arc-extract] back-half incomplete (resumeFrom=${reflectResult.checkpoint.resumeFrom}, saved=${reflectResult.saved}) — inline retry ${backRetries}/${maxBack}`);
      try {
        reflectResult = await runBackHalf(reflectResult.checkpoint);
      } catch (e: any) {
        return failClean('pipeline_failed', String(e?.message ?? e).slice(0, 500));
      }
    }

    // Still incomplete after the retry budget → FAIL CLEAN: do NOT mark turns
    // extracted. Turns stay pending = re-extractable (never silent loss).
    if (reflectResult.checkpoint) {
      console.error(`[arc-extract] back-half STILL incomplete after ${maxBack} retr(ies) (resumeFrom=${reflectResult.checkpoint.resumeFrom}) — failing clean, turns left re-extractable`);
      return failClean('pipeline_incomplete', `Pass 3 incomplete after ${maxBack + 1} attempt(s) — turns left re-extractable`);
    }
  }

  // 4b. Resolution self-heal (Fix 2, 2026-07-10): apply every `resolves` edge whose
  //     target is an open task/blueprint → unique.status 'done'. Runs on the WHOLE
  //     graph (idempotent, edges are rare) so it catches resolves written by any of
  //     this run's writers — comprehend link-intent, Pass 4, cross-group. Best-effort:
  //     a heal failure must never fail an otherwise-committed extraction.
  try {
    const heal = applyResolvesStatusEffects(db);
    if (heal.flipped.length > 0) {
      console.log(`[arc-extract] resolution-heal: ${heal.flipped.length} open item(s) closed by resolves edges`);
    }
  } catch (e: any) {
    console.warn(`[arc-extract] resolution-heal skipped: ${e?.message ?? e}`);
  }

  // 5. Pipeline succeeded — record the extraction event and flip turn statuses.
  //    Per design §2.5: re-extraction creates a NEW range (extraction_type=
  //    're-extract') rather than mutating prior. Old turns' pairing_range_id
  //    POINTS to the original; re-extract creates new blocks linked to new range.
  //    For first-extraction (default), extraction_type='arc'.
  const rangeRow = db.createConversationTurnRange({
    agent_id:          opts.agent_id,
    start_turn_number: startTurn,
    end_turn_number:   endTurn,
    extraction_type:   opts.re_extract ? 're-extract' : 'arc',
    trigger_source:    opts.trigger_source,
    pipeline_run_id:   null,   // Phase 8 wires this through from the backend handler
  });

  for (const turn of turnsInRange) {
    try {
      db.markConversationTurnExtracted(turn.id, rangeRow.id);
    } catch (e: any) {
      // Defensive — a turn that's already 'extracted' (re-extract path) would
      // have failed UPDATE. Phase 8's idempotency layer should catch this
      // before we reach here; tolerate for now and log.
      console.warn(`[arc-extract] mark-extracted failed for ct ${turn.id}: ${e?.message}`);
    }
  }

  // ── Phase 9: extracted_from provenance — record block → range join ────────
  // For every block runAutoReflect created during this arc run, write a row to
  // block_extractions linking it to rangeRow.id. The reflectResult only carries
  // labels (not ids), so look up each by label. Failures here are logged but
  // not fatal — the arc itself succeeded; the provenance is a secondary write.
  let provenanceRecorded = 0;
  let provenanceMisses   = 0;
  for (const cb of (reflectResult.created_blocks ?? [])) {
    try {
      const block = db.getBlock(cb.label);
      if (!block) { provenanceMisses++; continue; }
      const created = db.recordBlockExtraction(block.id, rangeRow.id);
      if (created) provenanceRecorded++;
    } catch (e: any) {
      console.warn(`[arc-extract] recordBlockExtraction failed for label="${cb.label}": ${e?.message}`);
      provenanceMisses++;
    }
  }
  if (provenanceRecorded > 0 || provenanceMisses > 0) {
    console.log(`[arc-extract] provenance: ${provenanceRecorded} block_extractions recorded, ${provenanceMisses} misses (range_id=${rangeRow.id})`);
  }

  // ─── STAGE FLAG (Sub-step 1.4 — now active, in pipeline.ts) ───────────────
  // The atomic_dup_candidate flag writes live in pipeline.ts after the Pass 3
  // createBlock loop (after stampFlowRolesAndChains) because that's where
  // item_id → block_id resolution becomes possible via itemIdToLabel. This
  // arc-pipeline.ts level sees the COMPLETED reflect_result and could add
  // ARC-level flag writes (e.g., project_dup_candidate post-AUDIT) in a
  // future slice — Stage AUDIT (Slice 2) is the natural owner.
  //
  // origin_range_id backfill: flags written from pipeline.ts know nothing
  // about arc range_id; could be backfilled here from rangeRow.id if the
  // async reviewer needs the arc-attribution. Deferred until Slice 2
  // reviewer surfaces the need.

  // Set rate-limit timestamp on success ONLY — failure shouldn't block retry.
  _arcLastEndTs.set(opts.agent_id, Date.now());

  return {
    range_id: rangeRow.id,
    turns_consumed: turnsInRange.length,
    status: 'extracted',
    start_turn: startTurn,
    end_turn: endTurn,
    reflect_result: reflectResult,
  };
  } finally {
    // Release the in-progress marker on EVERY exit path (success, failure,
    // thrown exception). Done in finally so even a runtime error in DB
    // writes above doesn't leave the agent permanently locked.
    _arcInProgress.delete(opts.agent_id);
  }
}

// ─── buildArcConsolidatedInput — the D1+D4 input transformation ──────────────
//
// Converts N conversation_turn rows into a single arc-shaped input for Pass 2-5.
// Per design §2.6.2:
//   - Inter-turn order: chronological (oldest first) — caller already passed in
//     ASC order (listConversationTurnsByAgent sorts), so we trust it.
//   - Intra-turn order: scene_card → items → raw transcript (dependency order;
//     Pass 1 consumed Pass 0; raw transcript is the source under both).
//   - Raw transcripts INCLUDED (D1, post-cap-bump): visible to Pass 2c for
//     sew-as-event accuracy.
//   - Item IDs prefixed `item_T<turn>_<original>` (D2 dedup composability).
//   - Sew-as-event header (D4) prepended to instruct Pass 2 to treat as ONE
//     continuous event.

export function buildArcConsolidatedInput(agentId: string, turns: ConversationTurnRow[]): {
  agentResponse: string;
  userMessage: string;
  agentThinking: string;
  sceneCardFormatted: string;
  sceneCardMerged: any;
  items: Pass1Item[];
} {
  const startTurn = turns[0]!.turn_number;
  const endTurn = turns[turns.length - 1]!.turn_number;

  const sewHeader = `[ARC EXTRACTION — agent_id=${agentId}, turns ${startTurn}-${endTurn}, ${turns.length} turn(s)]
This input represents ONE CONTINUOUS CONVERSATION ARC, not N independent turns.
- Items mentioned in multiple turns are the SAME item — sew them together, do NOT emit duplicates needing supersedes.
- Reason about cross-turn relations (causal chains, decisions built progressively, dead-ends abandoned then re-considered).
- Turn headers [TURN N] mark sequence only; the conversation flowed as one thought.
`;

  const userMessageParts: string[] = [];
  const agentResponseParts: string[] = [sewHeader];
  const agentThinkingParts: string[] = [];
  const sceneCardParts: string[] = [];
  const sceneCardRawList: any[] = [];
  const mergedItems: Pass1Item[] = [];

  for (const turn of turns) {
    let transcript: any = {};
    try { transcript = JSON.parse(turn.transcript_json); } catch { /* malformed — degrade to empty */ }

    const turnHeader = `[TURN ${turn.turn_number}${turn.turn_name ? ` — ${turn.turn_name}` : ''}]`;

    if (transcript.user_message) {
      userMessageParts.push(`${turnHeader}\nUSER: ${transcript.user_message}`);
    }
    if (transcript.agent_response) {
      agentResponseParts.push(`${turnHeader}\nAGENT: ${transcript.agent_response}`);
    }
    if (transcript.agent_thinking) {
      agentThinkingParts.push(`${turnHeader}\nTHINKING: ${transcript.agent_thinking}`);
    }

    // Pass 0-1 outputs from per-turn capture (Phase 2)
    let pass01: any = null;
    try { pass01 = turn.pass01_output_json ? JSON.parse(turn.pass01_output_json) : null; } catch { /* */ }

    if (pass01?.scene_card) {
      sceneCardRawList.push({ turn: turn.turn_number, scene_card: pass01.scene_card });
      sceneCardParts.push(`[TURN ${turn.turn_number} SCENE CARD]\n${typeof pass01.scene_card === 'string' ? pass01.scene_card : JSON.stringify(pass01.scene_card, null, 2)}`);
    }

    if (Array.isArray(pass01?.items)) {
      for (const item of pass01.items as Pass1Item[]) {
        // Prefix item IDs with turn number per §2.6.2. Strip any existing
        // 'item_' prefix to avoid `item_T2_item_1` (some Pass 1 implementations
        // emit ids like 'item_1', others bare integers as strings — both ok).
        const cleanId = String(item.id ?? '').replace(/^item_/, '') || `${mergedItems.length + 1}`;
        const arcId = `item_T${turn.turn_number}_${cleanId}`;
        mergedItems.push({ ...item, id: arcId });
      }
    }
  }

  return {
    agentResponse:       agentResponseParts.join('\n\n'),
    userMessage:         userMessageParts.join('\n\n'),
    agentThinking:       agentThinkingParts.join('\n\n'),
    sceneCardFormatted:  sceneCardParts.join('\n\n---\n\n'),
    sceneCardMerged:     { merged_turns: sceneCardRawList, agent_id: agentId, start_turn: startTurn, end_turn: endTurn },
    items:               mergedItems,
  };
}
