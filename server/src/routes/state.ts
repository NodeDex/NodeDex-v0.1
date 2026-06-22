// routes/state.ts — shared in-memory state + queue processor.
// All route modules import from here rather than from api-server.ts.
// Reference: api-server.v1.ts (lines 13-325)

import { v4 as uuidv4 } from "uuid";
import { WorkspaceDB } from "../store/database.js";
import { EmbeddingEngine } from "../engine/embeddings.js";
import { runAutoReflect, reflectTokenStats } from "../middleware/auto-reflect.js";
import type { ReflectCreatedBlock, ReflectUpdatedBlock } from "../middleware/auto-reflect.js";
import { runComprehendFrontHalf } from "../middleware/reflect/v2-integrate.js";
import { getLLMProvider } from "../engine/providers/index.js";
import type { PipelineCheckpoint } from "../middleware/reflect/types.js";
import { evaluateBudgetLive, writeSpendPauseFile, clearSpendPauseFile, creditExhausted, creditRecovered } from "../middleware/reflect/cost-guard.js";
import { isInsufficientCreditError } from "../engine/providers/failure-policy.js";
import { resolveRoutedFlagsFromText } from "../middleware/reflect/nl-accept.js";

// ─── Gemini Reflect Queue ─────────────────────────────────────────────────────
// Sequential queue — every agent turn is compiled, no rate-limit gate.
// Each job sees what the previous one saved via gemini_recent_saves in session state.
export interface ReflectJob {
  agentResponse: string;
  agentThinking: string;
  userMessage: string;
  loadedBlockIds: string[];
  agentId?: string;
  turnNumber?: number;    // which user turn triggered this reflect
  turnName?: string;      // slugified first 5 words of user message
  // Checkpoint slots — every completed pass survives retries so its reasoning
  // appears in the turn log. Pass0 carries the scene-card raw + formatted text;
  // Pass1/Pass2 carry their full item arrays.
  precomputedPass0?: { sceneCard: string | undefined; raw: any };
  precomputedPass1?: { items: any[] };
  precomputedPass2?: { classified: any[] };
  precomputedPass3PendingBlockIds?: string[];
  retryAfter?: number;    // epoch ms — job will wait until this time before processing
  retryAttempts?: number; // how many times this job has been re-queued due to rate limits
  dbId?: string;          // DB row ID — set on enqueue, used to sync status back to DB
}

export function resolveStateLabel(agentId?: string): string {
  return agentId ? `agent_session_state_${agentId}` : "agent_session_state";
}

export const reflectQueue: ReflectJob[] = [];
export let reflectProcessing = false;
export let reflectFlushGeneration = 0;   // incremented on every flush; each sleeping job checks its own snapshot
export let reflectPaused = false;
// SPEND pause — distinct from reflectPaused. reflectPaused stops CAPTURE (drops turns at
// /trigger) for benchmark/manual isolation; spendPaused stops only SPENDING (halts the
// drain) while CAPTURE KEEPS QUEUING, so a credit outage loses no turns. Set by the
// cost-breaker + the credit-out handler; cleared automatically when credit tops back up.
export let spendPaused = false;

export function setReflectProcessing(v: boolean) { reflectProcessing = v; }
export function setReflectFlushGeneration(v: number) { reflectFlushGeneration = v; }
export function setReflectPaused(v: boolean) { reflectPaused = v; }
export function setSpendPaused(v: boolean) { spendPaused = v; }

// Enqueue ONE captured turn for reflection — the SINGLE in-process path, shared by the
// HTTP trigger route (where hooks / the tee adapter POST in) and the chat proxy (which
// enqueues directly, no self-HTTP-call). Mechanics only — the CALLER owns pause policy
// (the proxy honors reflectPaused; the trigger route additionally bypasses it for
// benchmark runs) and the <50-char gate. Never throws: capture must never break its caller.
export function enqueueReflectTurn(
  db: WorkspaceDB,
  embeddings: EmbeddingEngine | undefined,
  turn: {
    agentResponse: string;
    agentThinking?: string;
    userMessage?: string;
    loadedBlockIds?: string[];
    agentId?: string;
    turnNumber?: number;
    turnName?: string;
  },
): { jobId: string; queueDepth: number } {
  const jobId = `rj_${uuidv4().slice(0, 12)}`;
  try {
    if (turn.agentId) db.registerAgent(turn.agentId);
    try {
      db.insertReflectJob(
        jobId,
        turn.agentId || null,
        JSON.stringify({
          agentResponse: turn.agentResponse,
          userMessage: turn.userMessage || "",
          loadedBlockIds: turn.loadedBlockIds || [],
        }),
      );
    } catch { /* non-critical — the DB row is for status sync only */ }
    reflectQueue.push({
      agentResponse: turn.agentResponse,
      agentThinking: turn.agentThinking || "",
      userMessage: turn.userMessage || "",
      loadedBlockIds: turn.loadedBlockIds || [],
      agentId: turn.agentId,
      turnNumber: turn.turnNumber,
      turnName: turn.turnName,
      dbId: jobId,
    });
    processReflectQueue(db, embeddings || undefined).catch((e) =>
      console.error("[reflect] worker error:", e),
    );
  } catch (e) {
    console.error("[reflect] enqueue error:", e);
  }
  return { jobId, queueDepth: reflectQueue.length };
}

// ─── Session Event Log ────────────────────────────────────────────────────────
// In-memory per-server-lifetime log. Cleared via POST /api/session/reset.
// Captures reflect cycles and recall injections for E2E analysis.

export interface SessionRecallEvent {
  id: number;
  timestamp: string;
  type: "recall";
  query: string;
  recalled: Array<{ label: string; type: string; project: string; quality: number }>;
  cross_project_count: number;
  total_injected: number;
  project_count: number;  // number of known project roots at recall time
}

export interface SessionReflectEvent {
  id: number;
  timestamp: string;
  type: "reflect";
  agent_id?: string;
  turn_number?: number;
  turn_name?: string;
  blocks_created: ReflectCreatedBlock[];
  blocks_updated: ReflectUpdatedBlock[];
  tokens: {
    pass1_input: number;
    pass2_input: number; pass2_thinking: number;
    pass3_input: number; pass3_thinking: number;
    billed_equiv: number;
  };
  processing_ms: number;
  rate_limited: boolean;
  rate_limit_pass?: 1 | 2 | 3;
}

export type SessionEvent = SessionRecallEvent | SessionReflectEvent;

export const sessionEvents: SessionEvent[] = [];
export let sessionEventCounter = 0;
export const SESSION_EVENT_MAX = 500; // cap at 500 events to avoid unbounded growth
export function incrementSessionEventCounter() { return ++sessionEventCounter; }

// ─── Alert store ─────────────────────────────────────────────────────────────
// Read-only monitoring layer. Evaluates conditions after each reflect cycle and
// recall call. Never modifies pipeline behaviour.

export type AlertSeverity = "warn" | "critical";

export interface AlertRecord {
  id: number;
  timestamp: string;
  condition: string;
  severity: AlertSeverity;
  message: string;
  context: Record<string, unknown>;
}

export const alertStore: AlertRecord[] = [];
let alertCounter = 0;
const ALERT_STORE_MAX = 200;
const ALERT_COOLDOWN_MS = 5 * 60 * 1000; // 5-minute cooldown per condition
export const alertCooldowns = new Map<string, number>(); // condition → last fired ms

/** Reset all session monitoring state (session events, alerts, counters) */
export function resetMonitoring() {
  sessionEvents.length = 0;
  sessionEventCounter = 0;
  alertStore.length = 0;
  alertCounter = 0;
  alertCooldowns.clear();
}

export function fireAlert(condition: string, severity: AlertSeverity, message: string, context: Record<string, unknown>) {
  const now = Date.now();
  if ((alertCooldowns.get(condition) ?? 0) + ALERT_COOLDOWN_MS > now) return;
  alertCooldowns.set(condition, now);
  const record: AlertRecord = { id: ++alertCounter, timestamp: new Date().toISOString(), condition, severity, message, context };
  if (alertStore.length < ALERT_STORE_MAX) alertStore.push(record);
  console.warn(`[ALERT:${severity.toUpperCase()}] ${condition}: ${message}`);
}

export function evaluateAlertsAfterReflect(evt: SessionReflectEvent) {
  // Rate limit hit
  if (evt.rate_limited) {
    fireAlert("rate_limit", "warn", `Pass ${evt.rate_limit_pass ?? "?"} rate limited`, { pass: evt.rate_limit_pass });
  }

  // Processing lag
  if (evt.processing_ms > 120_000) {
    fireAlert("processing_lag_critical", "critical", `Reflect cycle took ${Math.round(evt.processing_ms / 1000)}s (threshold: 120s)`, { processing_ms: evt.processing_ms });
  } else if (evt.processing_ms > 60_000) {
    fireAlert("processing_lag_warn", "warn", `Reflect cycle took ${Math.round(evt.processing_ms / 1000)}s (threshold: 60s)`, { processing_ms: evt.processing_ms });
  }

  // Queue backup
  if (reflectQueue.length > 10) {
    fireAlert("queue_backup_critical", "critical", `Queue depth ${reflectQueue.length} (threshold: 10)`, { queue_depth: reflectQueue.length });
  } else if (reflectQueue.length > 3) {
    fireAlert("queue_backup_warn", "warn", `Queue depth ${reflectQueue.length} (threshold: 3)`, { queue_depth: reflectQueue.length });
  }

  // Quality drop — last 5 blocks avg < 3
  const allCreatedSoFar = sessionEvents
    .filter((e): e is SessionReflectEvent => e.type === "reflect")
    .flatMap(e => e.blocks_created);
  const last5 = allCreatedSoFar.slice(-5);
  if (last5.length >= 5) {
    const avgQuality = last5.reduce((s, b) => s + b.quality, 0) / last5.length;
    if (avgQuality < 3) {
      fireAlert("quality_drop", "warn", `Avg quality of last 5 blocks: ${avgQuality.toFixed(1)} (threshold: 3.0)`, { avg_quality: avgQuality, blocks: last5.map(b => b.label) });
    }
  }

  // Block creation spike — this cycle > 2× session avg, min 10 blocks
  const reflectEvtsSoFar = sessionEvents.filter((e): e is SessionReflectEvent => e.type === "reflect");
  if (reflectEvtsSoFar.length >= 3) {
    const prevAvg = reflectEvtsSoFar.slice(0, -1).reduce((s, e) => s + e.blocks_created.length, 0) / (reflectEvtsSoFar.length - 1);
    const thisCount = evt.blocks_created.length;
    if (prevAvg > 0 && thisCount > prevAvg * 2 && thisCount >= 10) {
      fireAlert("block_creation_spike", "warn", `${thisCount} blocks this cycle (2× avg of ${prevAvg.toFixed(1)})`, { this_cycle: thisCount, session_avg: prevAvg });
    }
  }

  // Block drought — 0 blocks for 3 consecutive cycles despite input tokens
  const recentEvts = reflectEvtsSoFar.slice(-3);
  if (recentEvts.length === 3 && recentEvts.every(e => e.blocks_created.length === 0 && e.tokens.pass1_input > 0)) {
    fireAlert("block_drought", "warn", "0 blocks saved in last 3 reflect cycles despite input being processed", { cycles_checked: 3 });
  }
}

export function evaluateAlertsAfterRecall(evt: SessionRecallEvent) {
  // Recall pollution threshold scales with project count:
  // Single-project workspace: 25% (cross-project recall is unexpected)
  // Multi-project workspace:  60% (cross-project recall is expected and useful)
  if (evt.total_injected >= 8) {
    const pct = (evt.cross_project_count / evt.total_injected) * 100;
    const threshold = evt.project_count <= 1 ? 25 : 60;
    if (pct > threshold) {
      fireAlert("recall_pollution", "warn", `${pct.toFixed(0)}% of recalled blocks are cross-project (threshold: ${threshold}%)`, { pollution_pct: pct, cross_project: evt.cross_project_count, total: evt.total_injected, query: evt.query, project_count: evt.project_count });
    }
  }
}

// ─── Mining candidates (removed — never wired, zero API calls, zero value at 42/42)
// To restore: add MiningCandidate interface + miningStore here, POST/GET/PATCH
// /api/mining-candidates in workspace.ts, inject in session.ts GET /api/session,
// inject in context hook section "3. Mining candidates".

// ─── Credit-out: pause spending, REQUEUE the turn (never drop) ───────────────────
// The REACTIVE backstop. When an extraction fails, decide whether it failed because the
// account is out of credit; if so, pause SPENDING and requeue the turn UNCHANGED so it
// drains after a top-up. Detection: the DEFINITIVE 402 signal first (isInsufficientCredit
// on the failure / reason — no network), then a FORCE-REFRESHED balance probe as the net.
//
// The requeue is the SAME mechanism as the rate-limit path (unshift + retry_wait row) with
// ONE deliberate difference: it does NOT increment retryAttempts. A credit outage is a
// global condition, not this turn's fault — counting it toward the per-turn drop cap would
// wrongly discard turns during an outage. Pairing it with the spend-pause (instead of a
// backoff-retry that would just re-hit the 402) is what makes capture-keeps-queuing work.
async function pauseAndRequeueIfCreditOut(db: WorkspaceDB, job: ReflectJob, errOrReason?: unknown): Promise<boolean> {
  let remaining: number | null = null;
  let out = isInsufficientCreditError(errOrReason);
  if (!out) { const c = await creditExhausted(); out = c.out; remaining = c.remaining; }
  if (!out) return false;

  setSpendPaused(true);
  const reason = `credit exhausted${remaining != null ? ` — remaining $${remaining.toFixed(2)}` : ""} (auto-resume on top-up)`;
  writeSpendPauseFile(reason);
  // Surface it in the monitoring feed (the TUI error terminal reads alertStore) — a
  // timestamped record alongside the standing spend_paused flag. 5-min cooldown built in.
  fireAlert("credit_exhausted", "critical", `Credit exhausted — extraction paused, ${reflectQueue.length + 1} turn(s) queued, auto-resume on top-up`, { remaining });
  // Requeue UNCHANGED — same unshift + retry_wait mechanism as the rate-limit path, but
  // NO attempt increment (a global outage, not this turn's fault → never drop it).
  if (job.dbId) db.updateReflectJob(job.dbId, { status: 'retry_wait', error: 'paused: credit exhausted' });
  reflectQueue.unshift(job);
  console.warn(`[reflect-queue] CREDIT EXHAUSTED — ${reason}. Spending paused, ${reflectQueue.length} job(s) preserved + still queuing. Auto-resumes when credit tops up.`);
  return true;
}

// ─── Auto-resume: drain again once credit recovers ───────────────────────────────
// processReflectQueue BREAKS on spendPaused BEFORE the budget re-check, so a paused queue
// never re-evaluates itself — resume needs a SEPARATE timer. It only ever acts on an active
// spendPaused (never the capture reflect-pause), force-refreshes the balance, and on recovery
// clears the spend-pause (flag + its OWN file — never the user's/dogfood reflect-pause) and
// kicks the drain. Idempotent; unref'd so it never holds the process open (tests/CI safe).
/**
 * One auto-resume check: if spend-paused AND credit has POSITIVELY recovered, lift the
 * pause + drain. Returns true iff it resumed. Exported so the behavior is unit/live-testable
 * without waiting on the 60s timer. Conservative — `creditRecovered` only confirms recovery
 * on a readable balance above the floor, so an indeterminate balance keeps the pause.
 */
export async function creditAutoResumeTick(db: WorkspaceDB, embeddings?: EmbeddingEngine): Promise<boolean> {
  if (!spendPaused) return false;
  let rec: { recovered: boolean; remaining: number | null };
  try { rec = await creditRecovered(); } catch { return false; }
  if (!rec.recovered) return false;            // still out / unconfirmed — stay paused
  setSpendPaused(false);
  clearSpendPauseFile();
  console.log(`[cost-breaker] credit recovered${rec.remaining != null ? ` (remaining $${rec.remaining.toFixed(2)})` : ""} — SPENDING RESUMED, draining ${reflectQueue.length} queued job(s)`);
  processReflectQueue(db, embeddings).catch(e => console.error("[cost-breaker] resume drain error:", e));
  return true;
}

let autoResumeTimer: ReturnType<typeof setInterval> | null = null;
export function startCreditAutoResume(db: WorkspaceDB, embeddings?: EmbeddingEngine, intervalMs = 60_000): void {
  if (autoResumeTimer) return;
  autoResumeTimer = setInterval(() => { creditAutoResumeTick(db, embeddings).catch(() => {}); }, intervalMs);
  autoResumeTimer.unref?.();
}

export function stopCreditAutoResume(): void {
  if (autoResumeTimer) { clearInterval(autoResumeTimer); autoResumeTimer = null; }
}

// ─── Reflect queue processor ──────────────────────────────────────────────────
export async function processReflectQueue(db: WorkspaceDB, embeddings?: EmbeddingEngine): Promise<void> {
  if (reflectProcessing) return;
  reflectProcessing = true;
  try {
    while (reflectQueue.length > 0) {
      // Pause halts the drain. "Pause" means "stop spending" — and a paused
      // server must never silently resume a recovered queue. Jobs stay queued
      // (and persisted in DB); they drain on the next trigger after resume, or
      // on a restart that boots unpaused. (Before this guard, pause only gated
      // NEW enqueues at /trigger while the existing queue kept draining — the
      // surprising behavior that burned credit on 2026-06-01.)
      if (reflectPaused) {
        console.log(`[reflect-queue] paused — halting drain (${reflectQueue.length} job(s) remain queued)`);
        break;
      }
      // SPEND pause — halts the drain (stop spending) but capture keeps queuing at
      // /trigger, so a credit outage never loses turns. Auto-resumes on top-up.
      if (spendPaused) {
        console.log(`[reflect-queue] spend paused (credit/budget) — halting drain; capture still queuing (${reflectQueue.length} job(s) preserved, auto-resume on top-up)`);
        break;
      }

      // Cost breaker (production gap 2): trip BEFORE pulling a job, reusing the
      // SPEND-pause lever. No-op + no I/O when no budget is configured (the default).
      // Tripping persists the spend-pause file so a restart can't bypass the budget;
      // the queue is preserved (fail-safe) and CAPTURE KEEPS QUEUING. The auto-resume
      // timer drains it when the balance recovers. The designed protections (floor
      // breach, balance-unknown) return a clean tripped verdict; an unexpected THROW
      // here is a breaker BUG, and a guard must never break what it guards — so we fail
      // OPEN on a throw (proceed), never silently halt reflection because the breaker
      // itself errored.
      let budget = null;
      try { budget = await evaluateBudgetLive(); }
      catch (e) { console.error("[cost-breaker] evaluation threw — proceeding WITHOUT tripping (breaker bug, not a budget breach):", e); }
      if (budget?.tripped) {
        setSpendPaused(true);
        writeSpendPauseFile(budget.reason ?? "cost breaker tripped");
        console.warn(`[cost-breaker] TRIPPED — ${budget.reason}. SPENDING PAUSED (${reflectQueue.length} job(s) preserved + queued; capture continues). Auto-resumes when the balance recovers.`);
        break;
      }

      const job = reflectQueue.shift()!;

      // Honour retry delay — put back and wait if not ready yet
      if (job.retryAfter && Date.now() < job.retryAfter) {
        const wait = job.retryAfter - Date.now();
        console.log(`[reflect-queue] rate-limit retry in ${Math.round(wait / 1000)}s — pausing queue`);
        reflectQueue.unshift(job);
        // Snapshot generation at sleep entry — flush increments it, so any change means abandon
        const myGeneration = reflectFlushGeneration;
        const sleepUntil = Date.now() + Math.min(wait, 10000);
        while (Date.now() < sleepUntil) {
          await new Promise(r => setTimeout(r, 1000));
          if (reflectFlushGeneration !== myGeneration) break;
        }
        if (reflectFlushGeneration !== myGeneration) {
          reflectQueue.length = 0;
          console.log("[reflect-queue] flush acknowledged — sleeping job abandoned");
          break;
        }
        continue;
      }

      // Mark job as actively processing in DB
      if (job.dbId) db.updateReflectJob(job.dbId, { status: 'processing' });

      const recalledBlocks = job.loadedBlockIds
        .map(id => db.getBlock(id))
        .filter(Boolean)
        .map((b: any) => ({ id: b.id, label: b.label, essence: b.essence || "", type: b.type }));

      // FLAG-RESOLUTION (b): if this turn answered a question the system routed to the
      // agent, apply it. Fire-and-forget + independent of extraction. Self-gated
      // (NODEDEX_FLAG_NL_ACCEPT off → instant no-op) and work-gated (no LLM call unless
      // a flag is actually pending), so this is $0 in the common case.
      resolveRoutedFlagsFromText(db, getLLMProvider(), job.agentResponse)
        .then(r => { if (r.addressed) console.log(`[nl-accept] addressed=${r.addressed} merged=${r.merged} left=${r.left} split=${r.split} skipped=${r.skipped_low_conf} errors=${r.errors}`); })
        .catch(e => console.warn(`[nl-accept] ${e?.message ?? e}`));

      const jobStart = Date.now();
      const statsBefore = {
        p1in: reflectTokenStats.pass1.input,
        p2in: reflectTokenStats.pass2.input, p2th: reflectTokenStats.pass2.thinking,
        p3in: reflectTokenStats.pass3.input, p3th: reflectTokenStats.pass3.thinking,
      };

      try {
        // Carry forward every completed pass when resuming, so Pass 0/1/2 reasoning
        // ends up in the final turn log regardless of which pass triggered the retry.
        let checkpoint: PipelineCheckpoint | undefined = job.precomputedPass3PendingBlockIds
          ? {
              resumeFrom: 'pass4' as const,
              pass0: job.precomputedPass0,
              pass1Items: job.precomputedPass1?.items,
              pass2Classified: job.precomputedPass2?.classified ?? [],
              p3PendingBlockIds: job.precomputedPass3PendingBlockIds,
            }
          : job.precomputedPass2
            ? {
                resumeFrom: 'pass3' as const,
                pass0: job.precomputedPass0,
                pass1Items: job.precomputedPass1?.items,
                pass2Classified: job.precomputedPass2.classified,
              }
            : job.precomputedPass1
              ? {
                  resumeFrom: 'pass2' as const,
                  pass0: job.precomputedPass0,
                  pass1Items: job.precomputedPass1.items,
                }
              : undefined;

        // ── PIPELINE v2 (per-turn) — gated on its OWN flag, NOT pipelineV2Enabled ─────
        // v2 was arc/batch-only; this brings it to the LIVE per-turn path so a live agent
        // gets v2's worth-gate SELECTOR + (with NODEDEX_V2_MERGE_DUPS) cross-group dedup.
        // SEPARATE flag NODEDEX_V2_PER_TURN so it does NOT auto-fire on the arc-mode
        // NODEDEX_PIPELINE_V2 flag a deployment may set for batch. Routes through
        // runComprehendFrontHalf with holistic:true — a single turn fits ONE COMPREHEND
        // call, so it does NOT use per-group SEGMENT (which exists only as the big-arc
        // truncate fix and, on a single turn's overlapping threads, blind-parallel
        // re-extracts shared claims → cross-group dups). Holistic prevents the dup at the
        // source; the MERGE_DUPS pass then stays a harmless no-op here (arc-mode net).
        // Transcript = USER/AGENT only (matches the arc path; thinking is captured to
        // conversation_turns but not fed to COMPREHEND — it amplified over-seg in testing).
        // Guards: !checkpoint (don't override a retry) · !job.turnNumber (arc mode keeps
        // its Pass 0-1 defer, so this NEVER runs in arc mode). V2-ONLY (2026-06-20): a v2
        // failure NO LONGER degrades to v1 — it REQUEUES (retry v2 with backoff) up to a
        // cap, then fail-cleans (turn skipped, never v1, no silent corruption). This matches
        // the arc path's v2-only fail-clean policy (arc-pipeline.ts §"V2-ONLY failure
        // policy"). ⚠ OLD v1 PIPELINE — DO NOT TURN ON: the NODEDEX_V2_PER_TURN=0
        // off-switch was REMOVED, so v2 per-turn is unconditional and the v1 path below
        // (runAutoReflect with no checkpoint + no turnNumber) is intentionally unreachable.
        let v2PerTurnAttempted = false;
        let v2PerTurnReason: string | null = null;
        if (!checkpoint && !job.turnNumber && job.agentResponse) {
          v2PerTurnAttempted = true;
          try {
            const v2Transcript = `USER: ${job.userMessage ?? ""}\nAGENT: ${job.agentResponse}`;
            // holistic by default (1 turn fits one call, no cross-group dup). Set
            // NODEDEX_V2_PER_TURN_PERGROUP=1 to instead run per-group + merge on the
            // per-turn path — under evaluation: per-group runs the cross-group LINKER
            // (no-op on holistic's single group), which may wire based_on/supports that
            // holistic leaves as islands. The wiring-vs-dup A/B decides the default.
            const useHolistic = process.env.NODEDEX_V2_PER_TURN_PERGROUP !== "1";
            const front = await runComprehendFrontHalf(db, getLLMProvider(), v2Transcript, { holistic: useHolistic });
            if (front.checkpoint) {
              checkpoint = front.checkpoint;
              console.log(`[reflect-per-turn] PIPELINE v2: ${front.groups} group(s), ${front.blocks} block(s), ${front.merged ?? 0} merged`);
            } else {
              v2PerTurnReason = front.reason ?? "unknown"; // "empty" (legit: nothing to save) | "comprehend_failed" | "seam1_invalid"
            }
          } catch (e: any) {
            v2PerTurnReason = `threw: ${e?.message ?? e}`;
          }
        }

        // V2-ONLY per-turn outcome — never fall through to v1.
        //   • checkpoint set → success → fall through to runAutoReflect (v2 back-half).
        //   • reason "empty"  → legitimately no residue → clean 0-block, done (NOT a failure).
        //   • any other failure → REQUEUE (retry v2) up to the cap, then fail-clean.
        if (v2PerTurnAttempted && !checkpoint) {
          if (v2PerTurnReason === "empty") {
            console.log(`[reflect-per-turn] v2: nothing worth saving (empty) — done, 0 blocks`);
            if (job.dbId) db.updateReflectJob(job.dbId, { status: 'done' });
          } else if (await pauseAndRequeueIfCreditOut(db, job, v2PerTurnReason)) {
            // Out of credit — paused + requeued UNCHANGED (no retry-cap burn). The loop
            // top sees spendPaused and halts the drain; capture keeps queuing.
            continue;
          } else {
            const attempts = (job.retryAttempts ?? 0) + 1;
            const maxRetries = Number(process.env.NODEDEX_V2_PER_TURN_MAX_RETRIES) || 3;
            if (attempts <= maxRetries) {
              const base = Math.min(15_000 * Math.pow(2, attempts - 1), 60_000);
              const retryDelay = Math.round(base + Math.random() * base * 0.5);
              console.warn(`[reflect-per-turn] v2 failed (${v2PerTurnReason}) — requeue ${attempts}/${maxRetries} in ${Math.round(retryDelay / 1000)}s (v2-only, NO v1)`);
              const retryJob: ReflectJob = { ...job, retryAfter: Date.now() + retryDelay, retryAttempts: attempts };
              if (job.dbId) db.updateReflectJob(job.dbId, { status: 'retry_wait', retry_after: retryJob.retryAfter, retry_attempts: attempts });
              reflectQueue.unshift(retryJob);
            } else {
              console.warn(`[reflect-per-turn] v2 failed after ${maxRetries} retries (${v2PerTurnReason}) — fail-clean, turn skipped (v2-only, NO v1)`);
              if (job.dbId) db.updateReflectJob(job.dbId, { status: 'dead', error: `v2 per-turn failed: ${v2PerTurnReason}`.slice(0, 200) });
            }
          }
          continue; // skip runAutoReflect — the per-turn v2 path never falls to v1
        }

        const r = await runAutoReflect(
          db,
          job.agentResponse,
          job.loadedBlockIds,
          job.userMessage,
          job.agentThinking || undefined,
          embeddings || undefined,
          recalledBlocks,
          job.agentId,
          checkpoint,
          // ── DEBT 5 Phase 2: thread turn identity into pipeline ──
          // When NODEDEX_ARC_EXTRACTION=1 + agentId present + turnNumber present,
          // pipeline persists Pass 0-1 to conversation_turns and defers Pass 2-5
          // to arc-extract trigger. ReflectJob has carried turnNumber/turnName
          // since the inventory pass; this completes the wire.
          job.turnNumber,
          job.turnName,
        );
        if (r.saved > 0 || r.updated > 0)
          console.log(`[reflect-queue] saved=${r.saved} updated=${r.updated} labels=${r.saved_labels.join(",")}`);
        if (r.uncertain_count > 0)
          console.log(`[reflect-queue] uncertain_refs=${r.uncertain_count} — stored for next turn`);

        // ── Record session event ──────────────────────────────────────────────
        const processing_ms = Date.now() - jobStart;
        const rateLimited = !!r.checkpoint;
        const rateLimitPass: 1 | 2 | 3 | undefined = r.checkpoint?.resumeFrom === 'pass1' ? 1 : r.checkpoint?.resumeFrom === 'pass2' ? 2 : r.checkpoint?.resumeFrom === 'pass3' ? 3 : undefined;
        const p1in = reflectTokenStats.pass1.input - statsBefore.p1in;
        const p2in = reflectTokenStats.pass2.input - statsBefore.p2in;
        const p2th = reflectTokenStats.pass2.thinking - statsBefore.p2th;
        const p3in = reflectTokenStats.pass3.input - statsBefore.p3in;
        const p3th = reflectTokenStats.pass3.thinking - statsBefore.p3th;
        const billedEquiv = p1in + p2in + (p2th * 23) + p3in + (p3th * 23);
        if (sessionEvents.length < SESSION_EVENT_MAX) {
          sessionEvents.push({
            id: incrementSessionEventCounter(),
            timestamp: new Date().toISOString(),
            type: "reflect",
            agent_id: job.agentId,
            turn_number: job.turnNumber,
            turn_name: job.turnName,
            blocks_created: r.created_blocks,
            blocks_updated: r.updated_blocks,
            tokens: { pass1_input: p1in, pass2_input: p2in, pass2_thinking: p2th, pass3_input: p3in, pass3_thinking: p3th, billed_equiv: billedEquiv },
            processing_ms,
            rate_limited: rateLimited,
            ...(rateLimitPass ? { rate_limit_pass: rateLimitPass } : {}),
          } as SessionReflectEvent);
          evaluateAlertsAfterReflect(sessionEvents[sessionEvents.length - 1] as SessionReflectEvent);
        }

        // Exponential backoff with full jitter — avoids thundering herd on Gemini 503s.
        // Base: 15s. Doubles each attempt, caps at 60s. Jitter: random 0-50% of base delay.
        // Jobs are never dropped — agent knowledge is permanent. Retries until Gemini is available.
        // Survives server restarts via DB (retry_wait rows recovered on startup).
        const attempts = (job.retryAttempts ?? 0) + 1;
        {
          const baseDelay = Math.min(15_000 * Math.pow(2, attempts - 1), 60_000);
          const jitter = Math.random() * baseDelay * 0.5;
          const retryDelay = Math.round(baseDelay + jitter);
          const retryInSec = Math.round(retryDelay / 1000);

          // Every retry preserves EVERY completed pass so the eventual turn log shows
          // Pass 0/1/2/3 reasoning regardless of where the retry started.
          const pass0Snapshot = r.checkpoint?.pass0 ?? job.precomputedPass0;
          const pass1Snapshot = r.checkpoint?.pass1Items
            ? { items: r.checkpoint.pass1Items }
            : job.precomputedPass1;
          const pass2Snapshot = r.checkpoint?.pass2Classified
            ? { classified: r.checkpoint.pass2Classified }
            : job.precomputedPass2;

          if (r.checkpoint?.resumeFrom === 'pass1') {
            console.log(`[reflect-queue] Pass 1 failed — re-queuing (attempt ${attempts}, retry in ${retryInSec}s)`);
            const retryJob: ReflectJob = {
              ...job,
              precomputedPass0: pass0Snapshot,
              precomputedPass1: undefined,
              precomputedPass2: undefined,
              precomputedPass3PendingBlockIds: undefined,
              retryAfter: Date.now() + retryDelay,
              retryAttempts: attempts,
            };
            if (job.dbId) db.updateReflectJob(job.dbId, { status: 'retry_wait', retry_after: retryJob.retryAfter, retry_attempts: attempts, precomputed: JSON.stringify({ pass0: pass0Snapshot }) });
            reflectQueue.unshift(retryJob);
          } else if (r.checkpoint?.resumeFrom === 'pass2') {
            console.log(`[reflect-queue] Pass 2 failed — re-queuing with Pass 0+1 (attempt ${attempts}, retry in ${retryInSec}s)`);
            const retryJob: ReflectJob = {
              ...job,
              precomputedPass0: pass0Snapshot,
              precomputedPass1: pass1Snapshot,
              precomputedPass2: undefined,
              precomputedPass3PendingBlockIds: undefined,
              retryAfter: Date.now() + retryDelay,
              retryAttempts: attempts,
            };
            if (job.dbId) db.updateReflectJob(job.dbId, { status: 'retry_wait', retry_after: retryJob.retryAfter, retry_attempts: attempts, precomputed: JSON.stringify({ pass0: pass0Snapshot, pass1: pass1Snapshot }) });
            reflectQueue.unshift(retryJob);
          } else if (r.checkpoint?.resumeFrom === 'pass3') {
            console.log(`[reflect-queue] Pass 3 failed — re-queuing with Pass 0+1+2 (attempt ${attempts}, retry in ${retryInSec}s)`);
            const retryJob: ReflectJob = {
              ...job,
              precomputedPass0: pass0Snapshot,
              precomputedPass1: pass1Snapshot,
              precomputedPass2: pass2Snapshot,
              precomputedPass3PendingBlockIds: undefined,
              retryAfter: Date.now() + retryDelay,
              retryAttempts: attempts,
            };
            if (job.dbId) db.updateReflectJob(job.dbId, { status: 'retry_wait', retry_after: retryJob.retryAfter, retry_attempts: attempts, precomputed: JSON.stringify({ pass0: pass0Snapshot, pass1: pass1Snapshot, pass2: pass2Snapshot }) });
            reflectQueue.unshift(retryJob);
          } else if (r.checkpoint?.resumeFrom === 'pass4') {
            console.log(`[reflect-queue] Pass 4 failed — re-queuing with Pass 0+1+2+3 pending blocks (attempt ${attempts}, retry in ${retryInSec}s)`);
            const retryJob: ReflectJob = {
              ...job,
              precomputedPass0: pass0Snapshot,
              precomputedPass1: pass1Snapshot,
              precomputedPass2: pass2Snapshot,
              precomputedPass3PendingBlockIds: r.checkpoint.p3PendingBlockIds,
              retryAfter: Date.now() + retryDelay,
              retryAttempts: attempts,
            };
            if (job.dbId) db.updateReflectJob(job.dbId, { status: 'retry_wait', retry_after: retryJob.retryAfter, retry_attempts: attempts, precomputed: JSON.stringify({ pass0: pass0Snapshot, pass1: pass1Snapshot, pass2: pass2Snapshot, p3PendingBlockIds: r.checkpoint.p3PendingBlockIds }) });
            reflectQueue.unshift(retryJob);
          } else {
            // Job completed successfully
            if (job.dbId) db.updateReflectJob(job.dbId, { status: 'done' });
          }
        }
      } catch (e) {
        // Out of credit → pause spending + requeue UNCHANGED (never drop, no cap burn).
        // Checked BEFORE the 503/rate-limit branch so a 402 is never mistaken for capacity.
        if (await pauseAndRequeueIfCreditOut(db, job, e)) { continue; }
        const errStr = String(e);
        const isBothModels503 = errStr.includes("503") || errStr.includes("Service Unavailable") ||
          errStr.includes("high demand") || errStr.includes("429") || errStr.includes("RESOURCE_EXHAUSTED");
        const attempts = (job.retryAttempts ?? 0) + 1;
        if (isBothModels503) {
          // Both primary and fallback returned 503 — park and retry later
          const baseDelay = Math.min(15_000 * Math.pow(2, attempts - 1), 60_000);
          const retryDelay = Math.round(baseDelay + Math.random() * baseDelay * 0.5);
          console.warn(`[reflect-queue] both models 503 — retry ${attempts} in ${Math.round(retryDelay / 1000)}s`);
          const retryJob: ReflectJob = { ...job, retryAfter: Date.now() + retryDelay, retryAttempts: attempts };
          if (job.dbId) db.updateReflectJob(job.dbId, { status: 'retry_wait', retry_after: retryJob.retryAfter, retry_attempts: attempts });
          reflectQueue.unshift(retryJob);
        } else {
          console.error("[reflect-queue] job error:", e);
          if (job.dbId) db.updateReflectJob(job.dbId, { status: 'dead', error: errStr.slice(0, 200) });
        }
      }
    }
  } finally {
    reflectProcessing = false;
  }
}
