// ═══════════════════════════════════════════════════════════════════════════════
// GAP ④(b) — PROVENANCE MEANING-REVIEWER (the expensive-narrow half)
// ═══════════════════════════════════════════════════════════════════════════════
//
// Consumes the HARD (severity='missing') provenance_mismatch flags the $0 detector
// (provenance-check.ts) wrote. For each, it re-reads the STORED source transcript
// (never the user's new turn) + the block's chain, and judges BY MEANING:
//
//   grounded=true  → the block's claim IS in the transcript (the excerpt was just
//                    mis-quoted). If it can find the real passage → correct_excerpt.
//   grounded=false → the claim is NOT in the transcript at all → fabricated → demote.
//
// TRIAGE → INVESTIGATE: fuzzy (soft) flags NEVER reach here — they're benign
// paraphrase and would be the scale-cost trap. Only hard flags cost an LLM call.
//
// Mirrors flag-reviewer.ts (the dup reviewer) + describe-roots.ts (the timer):
//   input builder → LLM judge → act → markFlagReviewed → bounded async tick.
//
// Safety LEVELS (mirror flag-reviewer's auto-merge gate):
//   Level 0 (default): NODEDEX_PROVENANCE_REVIEWER_ENABLED unset → worker never
//                      starts. runProvenanceReviewerTick still callable (REST/tests).
//   Level 1: ENABLED=on, AUTO_ACT unset → verdicts WRITTEN, graph NOT mutated.
//   Level 2: + NODEDEX_PROVENANCE_AUTO_ACT=on → corrections + demotes execute
//            (updateBlock excerpt / archiveBlock — recoverable, charter Rule 2).

import type { WorkspaceDB, Block } from "../../store/database.js";
import type { LLMProvider } from "../../engine/ai-provider.js";
import type { PipelineFlag, FlagActionTaken, ReviewVerdict } from "./types.js";
import { getPendingFlags, markFlagReviewed } from "./pipeline-flags.js";
import { getBlockTranscript } from "./provenance-check.js";
import { orderMembersCausally } from "../../tools/helpers.js";
import { extractPrimaryValueFromUnique } from "./dedup-by-source-and-value.js";
import { getLLMProvider } from "../../engine/providers/index.js";
import { budgetTripped } from "./cost-guard.js";
import { modelOverride, intFromEnv } from "./config.js";

// ─── Config ──────────────────────────────────────────────────────────────────────

export function provenanceReviewerEnabled(): boolean {
  return (process.env.NODEDEX_PROVENANCE_REVIEWER_ENABLED ?? "").toLowerCase() === "on";
}
/** Level 2 gate: only when on does the reviewer MUTATE (correct/demote). */
export function provenanceAutoActEnabled(): boolean {
  return (process.env.NODEDEX_PROVENANCE_AUTO_ACT ?? "").toLowerCase() === "on";
}
function batchSize(): number {
  return intFromEnv("NODEDEX_PROVENANCE_REVIEWER_BATCH", 5); // caps $$ per tick
}
function intervalMs(): number {
  return intFromEnv("NODEDEX_PROVENANCE_REVIEWER_INTERVAL_MS", 1_800_000); // 30 min (slow background)
}
function reviewerModel(): string | undefined {
  return modelOverride("NODEDEX_PROVENANCE_REVIEWER_MODEL");
}
const MAX_TRANSCRIPT_CHARS = 8000; // bound input tokens

// ─── Prompt + schema ───────────────────────────────────────────────────────────

export const PROVENANCE_REVIEW_PROMPT = `You are auditing a knowledge-graph block's PROVENANCE. The block claims it was
extracted from a conversation, but an automatic check found its stored EXCERPT does
not appear in the transcript. Decide whether the block's CLAIM is actually grounded
in the SOURCE TRANSCRIPT at all — read the transcript as ground truth.

  grounded=true  — the claim IS supported somewhere in the transcript (the excerpt
                   was merely paraphrased / reordered / mis-quoted). If you can find
                   the exact passage the claim comes from, copy it VERBATIM into
                   correct_excerpt; otherwise leave correct_excerpt empty.
  grounded=false — the claim is NOT present in the transcript (the excerpt AND the
                   claim were fabricated or mis-attributed). The block will be demoted.

Judge by MEANING — surface word overlap is NOT enough. When genuinely uncertain
whether the claim is in the transcript, prefer grounded=true (demoting is heavier
than keeping a flagged block). correct_excerpt must be copied verbatim from the
transcript or left empty. reasoning ≤ 200 chars, citing what you found (or didn't).`;

const PROVENANCE_REVIEW_SCHEMA = {
  type: "object",
  properties: {
    grounded: { type: "boolean" },
    correct_excerpt: { type: "string" },
    reasoning: { type: "string" },
  },
  required: ["grounded", "reasoning"],
};

export interface ProvenanceVerdict {
  grounded: boolean;
  correct_excerpt: string;
  reasoning: string;
}

// ─── Context builder (DB reads, no LLM — testable) ──────────────────────────────

export function buildReviewInput(db: WorkspaceDB, block: Block, transcript: string): string {
  let claim = "";
  try {
    const c = typeof block.content === "string" ? JSON.parse(block.content) : (block.content || {});
    claim = extractPrimaryValueFromUnique(block.type, c.unique || {}) || "";
  } catch { /* tolerate */ }

  const chainLines: string[] = [];
  const cid = (block as any).chain_id as string | null;
  if (cid) {
    try {
      // Causal FLOW order (cause → effect), not created_at — see orderMembersCausally.
      for (const m of orderMembersCausally(db, db.getBlocksByChain(cid))) {
        if (m.id === block.id) continue;
        chainLines.push(`  - [${m.type}] ${m.label} — "${(m.essence || "").slice(0, 100)}"`);
      }
    } catch { /* tolerate */ }
  }

  const tx = transcript.length > MAX_TRANSCRIPT_CHARS ? transcript.slice(0, MAX_TRANSCRIPT_CHARS) + " …[truncated]" : transcript;
  return [
    `BLOCK: [${block.type}] "${(block.essence || "").slice(0, 200)}"`,
    claim ? `IDENTITY CLAIM: "${claim.slice(0, 200)}"` : "",
    `STORED EXCERPT (suspect): "${String(block.source_excerpt ?? "").slice(0, 300)}"`,
    chainLines.length ? `CHAIN (context):\n${chainLines.join("\n")}` : "CHAIN: (none)",
    `\nSOURCE TRANSCRIPT:\n${tx}`,
  ].filter(Boolean).join("\n");
}

// ─── LLM judge (the only cost) ──────────────────────────────────────────────────

export async function judgeProvenance(
  provider: LLMProvider,
  userInput: string,
): Promise<{ verdict: ProvenanceVerdict | null; rateLimited: boolean }> {
  const r = await provider.generateStructured<ProvenanceVerdict>(
    PROVENANCE_REVIEW_PROMPT, userInput, PROVENANCE_REVIEW_SCHEMA,
    { thinkingBudget: 512, modelOverride: reviewerModel() },
  );
  return { verdict: r.result ?? null, rateLimited: r.rateLimited };
}

// ─── Act (pure-ish — testable with a synthetic verdict, no LLM) ─────────────────

export interface AppliedVerdict { verdict: ReviewVerdict; action_taken: FlagActionTaken; reason: string; }

/**
 * Apply a verdict to one flagged block + record it. autoAct=false → verdict only,
 * NO mutation (Level 1). Mutations (Level 2): correct the excerpt (grounded + a real
 * fix) or archive the block (ungrounded) — both recoverable.
 */
export function applyProvenanceVerdict(
  db: WorkspaceDB,
  flag: PipelineFlag,
  block: Block,
  verdict: ProvenanceVerdict,
  autoAct: boolean,
): AppliedVerdict {
  const raw = (db as any).db;
  let out: AppliedVerdict;

  if (!verdict.grounded) {
    if (autoAct) db.archiveBlock(block.id, `provenance: claim not found in source transcript — ${verdict.reasoning.slice(0, 120)}`);
    out = { verdict: "demoted", action_taken: autoAct ? "demoted_unprovenanced" : "none", reason: verdict.reasoning };
  } else {
    const fix = (verdict.correct_excerpt ?? "").trim();
    const needsFix = fix.length > 0 && fix !== String(block.source_excerpt ?? "").trim();
    if (needsFix && autoAct) {
      db.updateBlock(block.id, { source_excerpt: fix }, "provenance: corrected excerpt to verbatim source", "provenance_reviewer");
      out = { verdict: "corrected", action_taken: "corrected_excerpt", reason: verdict.reasoning };
    } else if (needsFix) {
      out = { verdict: "corrected", action_taken: "none", reason: verdict.reasoning }; // Level 1: would-correct, not applied
    } else {
      out = { verdict: "leave", action_taken: "none", reason: verdict.reasoning };
    }
  }

  markFlagReviewed(raw, {
    flag_id: flag.id, verdict: out.verdict, reason: out.reason, action_taken: out.action_taken,
  });
  return out;
}

// ─── Tick orchestrator ──────────────────────────────────────────────────────────

export interface ProvenanceReviewerTickResult {
  pending: number; reviewed: number; corrected: number; demoted: number; left: number;
  skipped_soft: number; skipped_no_transcript: number; rate_limited: number; errors: number; wall_ms: number;
}

export async function runProvenanceReviewerTick(opts: {
  db: WorkspaceDB; provider: LLMProvider; limit?: number; autoAct?: boolean;
}): Promise<ProvenanceReviewerTickResult> {
  const t0 = Date.now();
  const { db, provider } = opts;
  const autoAct = opts.autoAct ?? provenanceAutoActEnabled();
  const res: ProvenanceReviewerTickResult = {
    pending: 0, reviewed: 0, corrected: 0, demoted: 0, left: 0,
    skipped_soft: 0, skipped_no_transcript: 0, rate_limited: 0, errors: 0, wall_ms: 0,
  };
  const raw = (db as any).db;

  const flags = getPendingFlags(raw, {
    flag_type: "provenance_mismatch", origin_writer: "provenance_check", limit: opts.limit ?? batchSize(),
  });
  res.pending = flags.length;

  for (const flag of flags) {
    try {
      // soft (fuzzy) flags never cost an LLM call — close them with 'leave'.
      if ((flag.criteria as any)?.severity !== "hard") {
        markFlagReviewed(raw, { flag_id: flag.id, verdict: "leave", reason: "soft (paraphrase) — not LLM-reviewed", action_taken: "none" });
        res.skipped_soft++; continue;
      }
      const block = db.getBlock(flag.block_id_a);
      if (!block || block.status === "archived") {
        markFlagReviewed(raw, { flag_id: flag.id, verdict: "leave", reason: "block gone/archived", action_taken: "none" });
        continue;
      }
      const src = getBlockTranscript(db, block.id);
      if (!src) {
        markFlagReviewed(raw, { flag_id: flag.id, verdict: "leave", reason: "no source transcript to verify against", action_taken: "none" });
        res.skipped_no_transcript++; continue;
      }
      const { verdict, rateLimited } = await judgeProvenance(provider, buildReviewInput(db, block, src.text));
      if (rateLimited || !verdict) { res.rate_limited += rateLimited ? 1 : 0; res.errors += verdict ? 0 : 1; continue; }
      const applied = applyProvenanceVerdict(db, flag, block, verdict, autoAct);
      res.reviewed++;
      if (applied.verdict === "corrected") res.corrected++;
      else if (applied.verdict === "demoted") res.demoted++;
      else res.left++;
    } catch (e: any) {
      res.errors++;
      console.warn(`[provenance-reviewer] flag ${flag.id} threw: ${e?.message ?? e}`);
    }
  }
  res.wall_ms = Date.now() - t0;
  return res;
}

// ─── Timer wrapper (env-gated, default OFF — mirrors describe-roots) ─────────────

let _handle: ReturnType<typeof setInterval> | null = null;
let _inFlight = false;

async function tick(db: WorkspaceDB): Promise<void> {
  if (_inFlight) return;
  _inFlight = true;
  try {
    const budget = await budgetTripped();
    if (budget?.tripped) { console.warn(`[provenance-reviewer] tick skipped — cost breaker: ${budget.reason}`); return; }
    const provider = getLLMProvider();
    if (!provider.isAvailable()) { console.warn("[provenance-reviewer] provider unavailable — skipping tick"); return; }
    const r = await runProvenanceReviewerTick({ db, provider });
    if (r.reviewed > 0 || r.errors > 0) {
      console.log(`[provenance-reviewer] tick: pending=${r.pending} reviewed=${r.reviewed} ` +
        `corrected=${r.corrected} demoted=${r.demoted} left=${r.left} soft=${r.skipped_soft} ` +
        `errors=${r.errors} wall_ms=${r.wall_ms}`);
    }
  } catch (e: any) {
    console.warn(`[provenance-reviewer] tick threw: ${e?.message ?? e}`);
  } finally {
    _inFlight = false;
  }
}

/** Start the reviewer timer. Idempotent; default OFF. Returns true if started. */
export function startProvenanceReviewerTimer(db: WorkspaceDB): boolean {
  if (!provenanceReviewerEnabled()) {
    console.log("[provenance-reviewer] disabled (set NODEDEX_PROVENANCE_REVIEWER_ENABLED=on to enable)");
    return false;
  }
  if (_handle !== null) return false;
  const ms = intervalMs();
  console.log(`[provenance-reviewer] starting: interval=${ms}ms autoAct=${provenanceAutoActEnabled()}`);
  _handle = setInterval(() => { tick(db).catch((e) => console.warn(`[provenance-reviewer] interval rejected: ${e?.message ?? e}`)); }, ms);
  if (typeof _handle.unref === "function") _handle.unref();
  return true;
}

export function stopProvenanceReviewerTimer(): void {
  if (_handle !== null) { clearInterval(_handle); _handle = null; }
}

/** Tests only — is the timer running? */
export function _isProvenanceReviewerTimerRunningForTests(): boolean {
  return _handle !== null;
}
