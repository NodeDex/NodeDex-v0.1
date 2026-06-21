// ═══════════════════════════════════════════════════════════════════════════════
// PASS 3 — BATCHED WRITE (the back-half scale fix; 2026-06-14)
// ═══════════════════════════════════════════════════════════════════════════════
//
// WHY: Pass 3 writes EVERY block in ONE LLM call. The model reliably covers ~25
// items; past that it returns a syntactically-valid but INCOMPLETE response
// (live: 59 items → only 28 covered, using 5751/65536 output tokens = 9% of budget).
// So it is NOT a token ceiling — it is the model giving up on a too-long item list.
// Per-group fixed the same failure at the FRONT (COMPREHEND); this fixes it at the
// BACK (the write).
//
// HOW: split `classified` into chunks of ~N (default 20, safely under the proven-good
// 25), run callPass3LLM per chunk against the SAME existing-graph snapshot, then MERGE
// the per-chunk analyses into the ONE analysis shape the save loop already consumes.
// The merge is safe because:
//   - item ids are globally unique across the arc → from_item_id stays unique → the
//     save loop's itemIdToLabel map is consistent → cross-CHUNK triggered_by/based_on
//     resolve SERVER-SIDE (pipeline.ts:1772+), with pendingTriggeredBy for forward refs;
//   - Pass 2 already owns cross-item dedup (Pass 3 only checks label collision) → no
//     dedup is lost by not showing chunks each other;
//   - novel cross-chunk links the per-chunk LLM couldn't see are swept by Pass 4.
//
// DROP-IN: callPass3Batched has the SAME signature + return shape as callPass3LLM and,
// when the flag is OFF or the item count is ≤ batch size, simply DELEGATES to it — so
// the default path is byte-identical to today. Default OFF: NODEDEX_PASS3_BATCH=1.

import type { LLMProvider } from "../../engine/ai-provider.js";
import { intFromEnv, modelForPass } from "./config.js";
import { modelOutputCeiling } from "../../engine/providers/model-caps.js";
import type { Pass2Item } from "./types.js";
import { callPass3LLM } from "./pass3.js";

// Default ON (promoted 2026-06-14 — validated: bounds the last unbounded write pass);
// set NODEDEX_PASS3_BATCH=0 to opt out (single-call write, byte-identical for small sets).
export function pass3BatchEnabled(): boolean {
  return process.env.NODEDEX_PASS3_BATCH !== "0";
}

// Heuristic visible-output tokens per Pass-3 block (~300 observed: "20 blocks ≈ 6k"
// + headroom for dense unique{}/relations). Used ONLY to keep a batch from
// over-requesting a SMALL-CAP model's output ceiling; a big-cap model fits the flat
// default many times over so this never lowers it there.
const PASS3_OUTPUT_TOKENS_PER_BLOCK = 400;

/**
 * Pass 3 batch size = min(reliability bound, token bound).
 *
 * RELIABILITY bound (NODEDEX_PASS3_BATCH_SIZE, default 20): under the empirically-
 * reliable ~25 (25 & 15 covered fully; 59 dropped ~half). This is THE cap on a
 * big-cap model — its output budget is never the limit (20 blocks ≈ 6k vs Gemini's
 * 65536), so a big-cap model always lands here.
 *
 * TOKEN bound (small-cap models only): a model with a small output ceiling (e.g.
 * claude-3.5-sonnet 8192) can hit that ceiling BEFORE the reliability bound, so scale
 * the batch down to keep (batchSize × ~tokens/block + thinking) under the ceiling.
 * `model` undefined → the provider default (assumed big-cap) → the flat bound. Pairs
 * with the openai.ts per-model ceiling CLAMP (which already prevents the over-request
 * glitch); this just reduces the truncation-retries that clamp would otherwise cause
 * on a small-cap model. Pure (reads env + KNOWN_CAPS).
 */
export function pass3BatchSize(model?: string, thinkingBudget = 4096): number {
  const flat = intFromEnv("NODEDEX_PASS3_BATCH_SIZE", 20);
  if (!model) return flat;
  const outBudget = modelOutputCeiling(model) - thinkingBudget;
  if (outBudget <= PASS3_OUTPUT_TOKENS_PER_BLOCK) return 1; // tiny ceiling — one block per call
  const tokenBound = Math.floor(outBudget / PASS3_OUTPUT_TOKENS_PER_BLOCK);
  return Math.max(1, Math.min(flat, tokenBound));
}

type Pass3Analysis = {
  project_creates?: any[];
  new_blocks?: any[];
  updates?: any[];
  skip_reasons?: any[];
};

/** Merge per-chunk Pass-3 analyses into ONE analysis the save loop consumes unchanged.
 *  new_blocks/updates/skip_reasons concatenate (item ids are globally unique → no
 *  collision); project_creates DEDUP by label (two chunks of a fresh project each coin
 *  the same root). Pure / testable. */
export function mergePass3Analyses(parts: Array<Pass3Analysis | null | undefined>): Pass3Analysis {
  const new_blocks: any[] = [];
  const updates: any[] = [];
  const skip_reasons: any[] = [];
  const projByLabel = new Map<string, any>();
  for (const p of parts) {
    if (!p) continue;
    for (const b of p.new_blocks ?? []) new_blocks.push(b);
    for (const u of p.updates ?? []) updates.push(u);
    for (const s of p.skip_reasons ?? []) skip_reasons.push(s);
    for (const pc of p.project_creates ?? []) {
      const k = String(pc?.label ?? "").trim();
      if (k && !projByLabel.has(k)) projByLabel.set(k, pc);
    }
  }
  return { project_creates: [...projByLabel.values()], new_blocks, updates, skip_reasons };
}

/** Split items into chunks of at most `size`. Pure / testable. */
export function chunkItems<T>(items: T[], size: number): T[][] {
  if (size <= 0) return [items];
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

type Pass3Result = {
  analysis: any;
  geminiThinking: string;
  rateLimited: boolean;
  model?: string;
  attempts?: Array<{ model: string; outcome: string }>;
};

/**
 * Batched Pass 3 — drop-in for callPass3LLM. Delegates to a single call when the flag
 * is off OR the item count fits one call; otherwise chunks → per-chunk callPass3LLM
 * (sequential, sharing the same graph snapshot) → mergePass3Analyses. Sequential (not
 * parallel) to stay gentle on rate limits — the chunks are independent reads of the
 * same snapshot, so order does not change correctness (cross-chunk links wire at save).
 */
export async function callPass3Batched(
  provider: LLMProvider,
  classified: Pass2Item[],
  knownRoots: Array<{ label: string; essence: string }>,
  projectContext: string,
  agentSavedBlocks: Array<{ id: string; label: string; type: string; essence: string; unique: Record<string, any> }>,
  thinkingBudget = 4096,
  duplicateAlerts = "",
  itemContext: Record<string, string> = {},
  batchSize = pass3BatchSize(modelForPass("pass3"), thinkingBudget),
): Promise<Pass3Result> {
  if (!pass3BatchEnabled() || classified.length <= batchSize) {
    return callPass3LLM(provider, classified, knownRoots, projectContext, agentSavedBlocks, thinkingBudget, duplicateAlerts, itemContext);
  }

  const chunks = chunkItems(classified, batchSize);
  console.log(`Auto-Reflect Pass 3: batched write — ${classified.length} items in ${chunks.length} chunk(s) of ≤${batchSize}`);

  const analyses: Pass3Analysis[] = [];
  let rateLimited = false;
  let model: string | undefined;
  let geminiThinking = "";
  const attempts: Array<{ model: string; outcome: string }> = [];

  for (let i = 0; i < chunks.length; i++) {
    const r = await callPass3LLM(provider, chunks[i], knownRoots, projectContext, agentSavedBlocks, thinkingBudget, duplicateAlerts, itemContext);
    if (r.analysis) analyses.push(r.analysis);
    rateLimited = rateLimited || r.rateLimited;
    if (!model) model = r.model;
    if (r.attempts) attempts.push(...r.attempts);
    if (r.geminiThinking) geminiThinking += (geminiThinking ? "\n" : "") + r.geminiThinking;
    const got = (r.analysis?.new_blocks?.length ?? 0) + (r.analysis?.skip_reasons?.length ?? 0) + (r.analysis?.updates?.length ?? 0);
    console.log(`  [pass3-batch] chunk ${i + 1}/${chunks.length}: ${chunks[i].length} item(s) → ${got} accounted${r.rateLimited ? " (rate limited)" : ""}`);
  }

  // Every chunk failed (all null) → bubble up a null analysis so the existing
  // re-queue path fires, exactly as a single failed call would.
  if (analyses.length === 0) {
    return { analysis: null, geminiThinking, rateLimited, model, attempts };
  }

  return { analysis: mergePass3Analyses(analyses), geminiThinking, rateLimited, model, attempts };
}
