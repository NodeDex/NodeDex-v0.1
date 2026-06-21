// ═══════════════════════════════════════════════════════════════════════════════
// COST BREAKDOWN — uniform per-pass turn-log record  (debt-4 §3, 2026-05-29)
//
// Pure-function extraction of the per-pass cost_breakdown construction that
// previously lived as an IIFE in pipeline.ts. Extracted so the three meaningful
// states (ran:false / ran:true+priced / ran:true+null) can be unit-tested
// directly without the integration-scale fixture cost.
//
// THE THREE STATES — each carries a different meaning a reader must distinguish:
//   ran:false + usd:null     → pass DID NOT RUN this turn (checkpoint resume
//                               skipped it; pipeline.ts:730-733 pre-populates
//                               pass1/2 from checkpoint, leaving _passNProvider
//                               unset). Non-contribution to total.
//   ran:true  + usd:number   → ran, priced cleanly. Contributes to total.
//   ran:true  + usd:null     → ran with UNKNOWN model — audit signal,
//                               pricing table doesn't know the model
//                               (don't fabricate). Poisons total_usd to null.
//
// Pre-debt-4 the per-pass record was just { model, usd } — readers couldn't
// distinguish "didn't run" (legitimate skip) from "ran but unpriced" (real
// audit gap). Today's S1.1 finding (turn-08 NULL = checkpoint resume) is the
// case that motivated this distinction.
// ═══════════════════════════════════════════════════════════════════════════════

import { computeCost, COST_PRICING_VERSION } from "./cost-pricing.js";

export type ProviderInfo = { model?: string; attempts?: Array<{ model: string; outcome: string }> };
export type PassTokenStats = { input: number; thinking: number; output: number; calls: number };
export type PassCost = { ran: boolean; model: string | undefined; usd: number | null };

export type CostBreakdownProviders = {
  pass0?: ProviderInfo;
  pass1?: ProviderInfo;
  pass_judge?: ProviderInfo;
  pass2?: ProviderInfo;
  pass3?: ProviderInfo;
  pass4?: ProviderInfo;
  pass5?: ProviderInfo;
  // Stage C (arc entity resolve) — slice-1 added the LLM call; this slot
  // closes the cost-attribution gap (followup #2 from project-slice1-
  // verified-2026-05-31). Without it, Stage C's $$ was invisible to
  // cost_breakdown and the run-cost in turn-NN.json under-counted by
  // exactly Stage C's spend on arc-extraction turns.
  pass_c_resolve?: ProviderInfo;
  // Slice 2.2 async flag-reviewer — billed per-tick in its own slot, but
  // included here so per-pipeline cost_breakdown can RECORD it on the rare
  // turn where reviewer fires during a pipeline run. Default: stays undefined
  // on pipeline turns (reviewer is async-grain, NOT pipeline-grain), making
  // pass_reviewer.ran=false and contributing 0 to the per-pipeline total.
  pass_reviewer?: ProviderInfo;
};

export type CostBreakdownTokenStats = {
  pass0: PassTokenStats;
  pass1: PassTokenStats;
  pass_judge: PassTokenStats;
  pass2: PassTokenStats;
  pass2a: PassTokenStats;
  pass2b: PassTokenStats;
  pass2c: PassTokenStats;
  pass3: PassTokenStats;
  pass4: PassTokenStats;
  pass5: PassTokenStats;
  pass_c_resolve: PassTokenStats;
  pass_reviewer: PassTokenStats;
};

export type CostBreakdown = {
  pricing_version: string;
  pass0: PassCost;
  pass1: PassCost;
  pass_judge: PassCost;
  pass2: PassCost;
  pass2a: PassCost;
  pass2b: PassCost;
  pass2c: PassCost;
  pass3: PassCost;
  pass4: PassCost;
  pass5: PassCost;
  pass_c_resolve: PassCost;
  pass_reviewer: PassCost;
  total_usd: number | null;
};

/**
 * Build the per-pass cost_breakdown record for the turn log.
 *
 * total_usd accumulates only RAN-passes:
 *   - ran:false → skip (non-contribution; was previously poisoning total to null)
 *   - ran:true  + usd:null   → real cost gap, total goes null
 *   - ran:true  + usd:number → contributes to running total
 */
export function buildCostBreakdown(
  providers: CostBreakdownProviders,
  tokenStats: CostBreakdownTokenStats,
): CostBreakdown {
  const pass0:      PassCost = { ran: !!providers.pass0,      model: providers.pass0?.model,      usd: computeCost(tokenStats.pass0,      providers.pass0?.model) };
  const pass1:      PassCost = { ran: !!providers.pass1,      model: providers.pass1?.model,      usd: computeCost(tokenStats.pass1,      providers.pass1?.model) };
  const pass_judge: PassCost = { ran: !!providers.pass_judge, model: providers.pass_judge?.model, usd: computeCost(tokenStats.pass_judge, providers.pass_judge?.model) };
  const pass2:      PassCost = { ran: !!providers.pass2,      model: providers.pass2?.model,      usd: computeCost(tokenStats.pass2,      providers.pass2?.model) };
  const pass2a:     PassCost = { ran: !!providers.pass2,      model: providers.pass2?.model,      usd: computeCost(tokenStats.pass2a,     providers.pass2?.model) };
  const pass2b:     PassCost = { ran: !!providers.pass2,      model: providers.pass2?.model,      usd: computeCost(tokenStats.pass2b,     providers.pass2?.model) };
  const pass2c:     PassCost = { ran: !!providers.pass2,      model: providers.pass2?.model,      usd: computeCost(tokenStats.pass2c,     providers.pass2?.model) };
  const pass3:      PassCost = { ran: !!providers.pass3,      model: providers.pass3?.model,      usd: computeCost(tokenStats.pass3,      providers.pass3?.model) };
  const pass4:      PassCost = { ran: !!providers.pass4,      model: providers.pass4?.model,      usd: computeCost(tokenStats.pass4,      providers.pass4?.model) };
  const pass5:      PassCost = { ran: !!providers.pass5,      model: providers.pass5?.model,      usd: computeCost(tokenStats.pass5,      providers.pass5?.model) };
  const pass_c_resolve: PassCost = { ran: !!providers.pass_c_resolve, model: providers.pass_c_resolve?.model, usd: computeCost(tokenStats.pass_c_resolve, providers.pass_c_resolve?.model) };
  const pass_reviewer:  PassCost = { ran: !!providers.pass_reviewer,  model: providers.pass_reviewer?.model,  usd: computeCost(tokenStats.pass_reviewer,  providers.pass_reviewer?.model) };

  const passes = [pass0, pass1, pass_judge, pass2, pass2a, pass2b, pass2c, pass3, pass4, pass5, pass_c_resolve, pass_reviewer];
  let total: number | null = 0;
  for (const v of passes) {
    if (!v.ran) continue;
    if (v.usd === null) { total = null; break; }
    total += v.usd;
  }

  return {
    pricing_version: COST_PRICING_VERSION,
    pass0, pass1, pass_judge, pass2, pass2a, pass2b, pass2c, pass3, pass4, pass5, pass_c_resolve, pass_reviewer,
    total_usd: total,
  };
}
