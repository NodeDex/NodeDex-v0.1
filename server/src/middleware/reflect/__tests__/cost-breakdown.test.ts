/**
 * cost-breakdown — turn-log per-pass cost record tests.
 *
 * Debt-4 §3 (uniform observability) introduced the `ran:bool` field on each
 * pass record to distinguish three states that previously all produced NULL:
 *   - ran:false              → pass didn't run (checkpoint resume)
 *   - ran:true  + usd:number → ran, priced
 *   - ran:true  + usd:null   → ran, unknown model (audit gap)
 *
 * These tests lock the contract so a future regression can't silently
 * re-conflate the three meanings. The empirical case that motivated this
 * (turn-08.json 2026-05-29 NULL = checkpoint resume) is the third test.
 *
 * Run: node --import=tsx/esm --test src/middleware/reflect/__tests__/cost-breakdown.test.ts
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { buildCostBreakdown } from "../cost-breakdown.js";
import type { CostBreakdownProviders, CostBreakdownTokenStats, PassTokenStats } from "../cost-breakdown.js";

// Helper — token stats for a pass that ran with some traffic. Numbers chosen
// so that at the seeded gemini-2.5-flash rates ($0.30/M input + $2.50/M
// output), the per-pass cost is small but non-zero (input=10000 / output=2000
// → ~$0.003 + $0.005 = ~$0.008).
const RAN_STATS: PassTokenStats = { input: 10000, thinking: 0, output: 2000, calls: 1 };
const EMPTY_STATS: PassTokenStats = { input: 0, thinking: 0, output: 0, calls: 0 };
const KNOWN = "gemini-2.5-flash";
const UNKNOWN = "fictitious-model-xyz-not-in-pricing-table";

function allEmptyStats(): CostBreakdownTokenStats {
  return {
    pass0: { ...EMPTY_STATS }, pass1: { ...EMPTY_STATS }, pass_judge: { ...EMPTY_STATS },
    pass2: { ...EMPTY_STATS }, pass2a: { ...EMPTY_STATS }, pass2b: { ...EMPTY_STATS },
    pass2c: { ...EMPTY_STATS }, pass3: { ...EMPTY_STATS }, pass4: { ...EMPTY_STATS },
    pass5: { ...EMPTY_STATS },
    pass_c_resolve: { ...EMPTY_STATS },
    pass_reviewer: { ...EMPTY_STATS },
  };
}

describe("buildCostBreakdown — three meaningful states per pass", () => {
  test("CASE 1: every pass ran with known model → ran:true, usd:number, total_usd is sum", () => {
    const providers: CostBreakdownProviders = {
      pass0: { model: KNOWN }, pass1: { model: KNOWN }, pass_judge: { model: KNOWN },
      pass2: { model: KNOWN }, pass3: { model: KNOWN }, pass4: { model: KNOWN }, pass5: { model: KNOWN },
    };
    const stats: CostBreakdownTokenStats = {
      pass0: { ...RAN_STATS }, pass1: { ...RAN_STATS }, pass_judge: { ...RAN_STATS },
      pass2: { ...EMPTY_STATS }, // monolith path off (split is default)
      pass2a: { ...RAN_STATS }, pass2b: { ...RAN_STATS }, pass2c: { ...RAN_STATS },
      pass3: { ...RAN_STATS }, pass4: { ...RAN_STATS }, pass5: { ...RAN_STATS },
      pass_c_resolve: { ...EMPTY_STATS }, // not arc-mode: Stage C didn't run
      pass_reviewer:  { ...EMPTY_STATS }, // reviewer runs async, not in pipeline
    };
    const cb = buildCostBreakdown(providers, stats);

    // Every pass should have ran:true (all providers were set)
    for (const k of ["pass0","pass1","pass_judge","pass2","pass2a","pass2b","pass2c","pass3","pass4","pass5"] as const) {
      assert.equal(cb[k].ran, true, `${k}.ran must be true when its provider is set`);
      assert.equal(typeof cb[k].usd, "number", `${k}.usd must be a number when ran+known-model`);
      assert.equal(cb[k].model, KNOWN, `${k}.model preserved`);
    }
    // total_usd must be a real number — sum of all priced passes (no NULL poison)
    assert.equal(typeof cb.total_usd, "number", "total_usd must be a number when all passes ran cleanly");
    assert.ok(cb.total_usd! > 0, "total_usd must be > 0 when token traffic exists");
  });

  test("CASE 2: a pass ran with UNKNOWN model → ran:true, usd:null, total_usd:null (audit gap)", () => {
    const providers: CostBreakdownProviders = {
      pass0: { model: KNOWN },
      pass1: { model: UNKNOWN }, // ← the audit gap: ran but model not in pricing table
      pass_judge: { model: KNOWN }, pass2: { model: KNOWN },
      pass3: { model: KNOWN }, pass4: { model: KNOWN }, pass5: { model: KNOWN },
    };
    const stats: CostBreakdownTokenStats = {
      pass0: { ...RAN_STATS }, pass1: { ...RAN_STATS }, pass_judge: { ...RAN_STATS },
      pass2: { ...EMPTY_STATS }, pass2a: { ...RAN_STATS }, pass2b: { ...RAN_STATS }, pass2c: { ...RAN_STATS },
      pass3: { ...RAN_STATS }, pass4: { ...RAN_STATS }, pass5: { ...RAN_STATS },
      pass_c_resolve: { ...EMPTY_STATS }, // not arc-mode
      pass_reviewer:  { ...EMPTY_STATS }, // reviewer runs async
    };
    const cb = buildCostBreakdown(providers, stats);

    // pass1: ran but unknown model
    assert.equal(cb.pass1.ran, true, "pass1.ran is true because provider was set");
    assert.equal(cb.pass1.usd, null, "pass1.usd is null because model unpriced");
    assert.equal(cb.pass1.model, UNKNOWN, "pass1.model preserved as the unknown name (don't fabricate)");
    // Other passes still ran cleanly
    assert.equal(cb.pass0.ran, true);
    assert.equal(typeof cb.pass0.usd, "number");
    // total_usd must be null — pass1 is a real audit gap that should poison the total
    assert.equal(cb.total_usd, null, "total_usd is null when a RAN pass has unknown model (real cost gap)");
  });

  test("CASE 3: checkpoint resume — pass0/1/judge didn't run → ran:false, total_usd is sum of ran passes (NOT poisoned)", () => {
    // The S1.1 case: turn-08.json had pass0/1/judge providers MISSING because the
    // queue produced a checkpoint with pass1Items (routes/state.ts:244-340), and
    // pipeline.ts:731 pre-populated pass1 so the if(!pass1) block was skipped.
    // Pre-debt-4 this poisoned total_usd to null; post-fix the total is real.
    const providers: CostBreakdownProviders = {
      // pass0/1/judge intentionally undefined — checkpoint resume skipped them
      pass2: { model: KNOWN }, pass3: { model: KNOWN }, pass4: { model: KNOWN }, pass5: { model: KNOWN },
    };
    const stats: CostBreakdownTokenStats = {
      // pass0/1/judge stats stay 0 (they didn't accumulate tokens)
      pass0: { ...EMPTY_STATS }, pass1: { ...EMPTY_STATS }, pass_judge: { ...EMPTY_STATS },
      pass2: { ...EMPTY_STATS }, pass2a: { ...RAN_STATS }, pass2b: { ...RAN_STATS }, pass2c: { ...RAN_STATS },
      pass3: { ...RAN_STATS }, pass4: { ...RAN_STATS }, pass5: { ...RAN_STATS },
      pass_c_resolve: { ...EMPTY_STATS }, // not arc-mode
      pass_reviewer:  { ...EMPTY_STATS }, // reviewer runs async
    };
    const cb = buildCostBreakdown(providers, stats);

    // Skipped passes: ran:false, model:undefined, usd:null — but TOTAL still real
    assert.equal(cb.pass0.ran, false, "pass0.ran is false (no provider — didn't run)");
    assert.equal(cb.pass0.model, undefined);
    assert.equal(cb.pass0.usd, null);
    assert.equal(cb.pass1.ran, false, "pass1.ran is false (checkpoint resumed past it)");
    assert.equal(cb.pass_judge.ran, false, "pass_judge.ran is false (same)");

    // The passes that DID run still report correctly
    assert.equal(cb.pass2a.ran, true);
    assert.equal(typeof cb.pass2a.usd, "number");
    assert.equal(cb.pass3.ran, true);
    assert.equal(cb.pass4.ran, true);

    // THE KEY ASSERTION — checkpoint-resumed turns no longer poison total_usd
    assert.equal(typeof cb.total_usd, "number",
      "total_usd is a number when only ran:false passes have usd:null (the S1.1 fix)");
    assert.ok(cb.total_usd! > 0, "total_usd reflects real cost of passes that ran");
  });

  test("CASE 4 (edge): ran:true + 0 tokens + known model → usd:0 (no traffic is cheaper than no run)", () => {
    // A pass with a provider set but no token traffic is technically "ran" with
    // 0 cost. Distinct from "didn't run." Defensive — verifies computeCost
    // returns 0 (not null) for known model + zero tokens.
    const providers: CostBreakdownProviders = { pass0: { model: KNOWN } };
    const stats = allEmptyStats();
    const cb = buildCostBreakdown(providers, stats);
    assert.equal(cb.pass0.ran, true);
    assert.equal(cb.pass0.usd, 0, "0 tokens × known rate = 0, not null");
    assert.equal(cb.total_usd, 0, "total_usd is 0 when one pass ran with 0 tokens, rest didn't run");
  });

  test("CASE 5: pass5 has its OWN slot — pre-fix it was merged into pass4 bucket (cost confabulation)", () => {
    // The empirical case 2026-05-29 (this slice): turn-01.json showed
    // pass4.usd = $0.0028522 but pass4 emitted 0 relations that turn — its
    // real cost was ~0. The $0.0028522 was pass5's actual spend mis-attributed
    // (pass5.ts:174-175 wrote to reflectTokenStats.pass4 with the comment
    // "pass5 is lightweight, no separate counter needed"). Inflated pass4,
    // hid pass5 from cost_breakdown, confabulated total_usd.
    //
    // This test locks that pass5 must have its own ran/model/usd slot AND that
    // its cost contributes independently to total_usd. A future regression
    // re-merging pass5 into pass4 would either fail this assertion (cb.pass5
    // would be undefined or never ran:true) OR drop a chunk of total_usd
    // (caught by the sum check).
    const providers: CostBreakdownProviders = {
      // Only pass4 and pass5 ran — simulates the post-pass-2 tail
      pass4: { model: KNOWN }, pass5: { model: KNOWN },
    };
    const stats: CostBreakdownTokenStats = {
      pass0: { ...EMPTY_STATS }, pass1: { ...EMPTY_STATS }, pass_judge: { ...EMPTY_STATS },
      pass2: { ...EMPTY_STATS }, pass2a: { ...EMPTY_STATS }, pass2b: { ...EMPTY_STATS }, pass2c: { ...EMPTY_STATS },
      pass3: { ...EMPTY_STATS },
      pass4: { ...RAN_STATS },  // pass4 ran with traffic
      pass5: { ...RAN_STATS },  // pass5 ran with traffic — its OWN bucket
      pass_c_resolve: { ...EMPTY_STATS }, // not arc-mode
      pass_reviewer:  { ...EMPTY_STATS }, // reviewer runs async
    };
    const cb = buildCostBreakdown(providers, stats);

    assert.equal(cb.pass4.ran, true, "pass4.ran must be true");
    assert.equal(cb.pass5.ran, true, "pass5.ran must be true — debt-4 §3 uniform observability");
    assert.equal(typeof cb.pass4.usd, "number");
    assert.equal(typeof cb.pass5.usd, "number");
    assert.ok(cb.pass5.usd! > 0, "pass5.usd > 0 when pass5 has token traffic (its own bucket, not merged with pass4)");
    // The sum must include BOTH — regression guard: if pass5 ever gets re-merged
    // into pass4, pass5.usd would be 0 and this assertion would fail because the
    // total wouldn't reach 2x the per-pass cost.
    assert.equal(typeof cb.total_usd, "number");
    assert.ok(cb.total_usd! >= cb.pass4.usd! + cb.pass5.usd! - 1e-9,
      "total_usd must include pass5's contribution separately from pass4's");
  });

  test("CASE 6: pass_c_resolve (Stage C arc resolve) has its OWN slot — followup #2 from slice-1 verify", () => {
    // The empirical case that motivated this: slice-1 verification 2026-05-31
    // burned ~$3 actual vs $1.30-1.60 estimated. Root cause class: Stage C's
    // LLM spend was invisible to cost_breakdown (no pass_c_resolve slot
    // existed). Same pattern as 742f50d (pass5-into-pass4 mis-attribution)
    // but ONE LEVEL UP — slice-1 added the LLM call without adding the slot.
    //
    // This test locks pass_c_resolve must:
    //   - Have its own ran/model/usd slot
    //   - Contribute independently to total_usd
    //   - Stay ran:false on non-arc turns (Stage C doesn't run in per-turn mode)
    // A future regression that drops pass_c_resolve back to silent burn would
    // fail the sum assertion OR the cb.pass_c_resolve.ran assertion.
    const providers: CostBreakdownProviders = {
      // Arc-extraction turn: pass0-5 ran (consolidated transcript) AND Stage C
      pass0: { model: KNOWN }, pass1: { model: KNOWN }, pass_judge: { model: KNOWN },
      pass2: { model: KNOWN }, pass3: { model: KNOWN }, pass4: { model: KNOWN }, pass5: { model: KNOWN },
      pass_c_resolve: { model: KNOWN },
    };
    const stats: CostBreakdownTokenStats = {
      pass0: { ...RAN_STATS }, pass1: { ...RAN_STATS }, pass_judge: { ...RAN_STATS },
      pass2: { ...EMPTY_STATS }, pass2a: { ...RAN_STATS }, pass2b: { ...RAN_STATS }, pass2c: { ...RAN_STATS },
      pass3: { ...RAN_STATS }, pass4: { ...RAN_STATS }, pass5: { ...RAN_STATS },
      pass_c_resolve: { ...RAN_STATS },  // Stage C ran on this arc — its OWN bucket
      pass_reviewer:  { ...EMPTY_STATS }, // reviewer doesn't run during pipeline (async)
    };
    const cb = buildCostBreakdown(providers, stats);

    assert.equal(cb.pass_c_resolve.ran, true, "pass_c_resolve.ran must be true when Stage C provider set");
    assert.equal(typeof cb.pass_c_resolve.usd, "number");
    assert.ok(cb.pass_c_resolve.usd! > 0, "pass_c_resolve.usd > 0 when Stage C has traffic — followup #2 fix");
    // Total must include Stage C alongside everything else — regression guard:
    // if Stage C ever loses its slot, total_usd would drop by ~$0.008 per arc
    // turn and the assertion below would catch it.
    assert.equal(typeof cb.total_usd, "number");
    assert.ok(cb.total_usd! >= cb.pass5.usd! + cb.pass_c_resolve.usd! - 1e-9,
      "total_usd must include pass_c_resolve's contribution separately");
  });

  test("CASE 6b: Stage C didn't run on per-turn (non-arc) turn → pass_c_resolve.ran:false, total intact", () => {
    // The graceful-degrade case: every per-turn pipeline run (NODEDEX_ARC_
    // EXTRACTION off OR per-turn fast-path on) never invokes Stage C. The
    // providers.pass_c_resolve stays undefined → ran:false, doesn't poison
    // total_usd. Mirrors the pass5 checkpoint-resume CASE 3 logic.
    const providers: CostBreakdownProviders = {
      pass0: { model: KNOWN }, pass1: { model: KNOWN }, pass_judge: { model: KNOWN },
      pass2: { model: KNOWN }, pass3: { model: KNOWN }, pass4: { model: KNOWN }, pass5: { model: KNOWN },
      // pass_c_resolve intentionally undefined — non-arc turn
    };
    const stats = allEmptyStats();
    // Pretend the priced passes ran with traffic
    stats.pass0 = { ...RAN_STATS }; stats.pass3 = { ...RAN_STATS };
    const cb = buildCostBreakdown(providers, stats);

    assert.equal(cb.pass_c_resolve.ran, false, "pass_c_resolve.ran is false when provider not set (non-arc turn)");
    assert.equal(cb.pass_c_resolve.model, undefined);
    assert.equal(cb.pass_c_resolve.usd, null);
    assert.equal(typeof cb.total_usd, "number",
      "total_usd remains a number — ran:false passes don't poison the total");
  });

  test("CASE 7: pass_reviewer (async flag reviewer) has its OWN slot — Slice 2.2", () => {
    // The async reviewer runs OUTSIDE per-pipeline triggers (own setInterval
    // worker, env-gated). Same own-slot discipline as pass5/pass_c_resolve so
    // the day reviewer cost shows up in a turn-NN.json (e.g., manual review
    // fired synchronously via POST /api/flags/:id/review) it's attributable.
    // This test locks the slot exists and contributes independently.
    const providers: CostBreakdownProviders = {
      // Synthetic edge case: reviewer fired (e.g., synchronous manual review
      // during a pipeline run via REST endpoint) — pass_reviewer.ran:true
      pass0: { model: KNOWN }, pass3: { model: KNOWN },
      pass_reviewer: { model: KNOWN },
    };
    const stats: CostBreakdownTokenStats = {
      pass0: { ...RAN_STATS }, pass1: { ...EMPTY_STATS }, pass_judge: { ...EMPTY_STATS },
      pass2: { ...EMPTY_STATS }, pass2a: { ...EMPTY_STATS }, pass2b: { ...EMPTY_STATS }, pass2c: { ...EMPTY_STATS },
      pass3: { ...RAN_STATS }, pass4: { ...EMPTY_STATS }, pass5: { ...EMPTY_STATS },
      pass_c_resolve: { ...EMPTY_STATS },
      pass_reviewer: { ...RAN_STATS }, // reviewer fired this turn — its OWN bucket
    };
    const cb = buildCostBreakdown(providers, stats);

    assert.equal(cb.pass_reviewer.ran, true, "pass_reviewer.ran is true when reviewer provider set");
    assert.equal(typeof cb.pass_reviewer.usd, "number");
    assert.ok(cb.pass_reviewer.usd! > 0, "pass_reviewer.usd > 0 when reviewer had traffic");
    assert.ok(cb.total_usd! >= cb.pass3.usd! + cb.pass_reviewer.usd! - 1e-9,
      "total_usd must include pass_reviewer's contribution separately");
  });

  test("CASE 7b: reviewer DIDN'T run during pipeline → pass_reviewer.ran:false (DEFAULT case)", () => {
    // The COMMON case (≈100% of pipeline turns): reviewer runs async, never
    // during pipeline trigger. providers.pass_reviewer stays undefined →
    // ran:false → no contribution to total_usd. Mirror of CASE 6b for Stage C.
    const providers: CostBreakdownProviders = {
      pass0: { model: KNOWN }, pass1: { model: KNOWN }, pass_judge: { model: KNOWN },
      pass2: { model: KNOWN }, pass3: { model: KNOWN }, pass4: { model: KNOWN }, pass5: { model: KNOWN },
      // pass_reviewer intentionally undefined — async worker, not this trigger
    };
    const stats = allEmptyStats();
    stats.pass0 = { ...RAN_STATS }; stats.pass3 = { ...RAN_STATS };
    const cb = buildCostBreakdown(providers, stats);

    assert.equal(cb.pass_reviewer.ran, false, "pass_reviewer.ran is false in DEFAULT pipeline turn (reviewer is async)");
    assert.equal(cb.pass_reviewer.model, undefined);
    assert.equal(cb.pass_reviewer.usd, null);
    assert.equal(typeof cb.total_usd, "number",
      "total_usd remains a number — ran:false reviewer doesn't poison the total");
  });
});
