/**
 * Pass 2 seam validators — pure-function tests.
 *
 * Covers PASS2-SPLIT-DESIGN.md §3 contract:
 *   - Seam α: schema-valid items proceed; mismatches route_back on first try,
 *     quarantine on retry exhaustion; novel_type bypasses validation
 *   - Seam β: read-only fields (type/unique/text/id) detected if mutated
 *
 * Run: node --import=tsx/esm --test src/middleware/reflect/__tests__/pass2-seams.test.ts
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  validateSeamAlpha,
  validateSeamAlphaBatch,
  snapshotForSeamBeta,
  checkSeamBetaInvariant,
  composeForDownstream,
  SEAM_ALPHA_MAX_RETRIES,
  DEMOTE_TARGETS,
  type SeamAlphaItem,
  type ComposeInput,
} from "../pass2-seams.js";

// ─────────────────────────────────────────────────────────────────────────────
// Seam α happy path — schema valid
// ─────────────────────────────────────────────────────────────────────────────

describe("validateSeamAlpha — happy path (schema valid → proceed)", () => {
  test("decision with required {choice} → proceed", () => {
    const item: SeamAlphaItem = { id: "i1", type: "decision", unique: { choice: "Use FastAPI" } };
    const v = validateSeamAlpha(item);
    assert.equal(v.kind, "proceed");
    if (v.kind === "proceed") assert.equal(v.item.id, "i1");
  });

  test("insight with required {observation, implication} → proceed", () => {
    const item: SeamAlphaItem = { id: "i2", type: "insight", unique: { observation: "X correlates Y", implication: "use X to predict Y" } };
    assert.equal(validateSeamAlpha(item).kind, "proceed");
  });

  test("fact with required {value} → proceed (why_matters optional)", () => {
    const item: SeamAlphaItem = { id: "i3", type: "fact", unique: { value: "Cold start is 8s" } };
    assert.equal(validateSeamAlpha(item).kind, "proceed");
  });

  test("freeform type (note) → always proceed", () => {
    const item: SeamAlphaItem = { id: "i4", type: "note", unique: { anything: "goes here" } };
    assert.equal(validateSeamAlpha(item).kind, "proceed");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Novel type bypass
// ─────────────────────────────────────────────────────────────────────────────

describe("validateSeamAlpha — novel_type bypass", () => {
  test("type with schema{} from 2a passes through without Tier 1B check", () => {
    const item: SeamAlphaItem = {
      id: "i_novel",
      type: "preference_evolution",  // not in TYPE_UNIQUE_SCHEMA
      unique: { from: "vanilla", to: "chocolate" },
      schema: { from: "previous preference", to: "new preference" },  // 2a declared it
    };
    const v = validateSeamAlpha(item);
    assert.equal(v.kind, "proceed");
  });

  test("type with EMPTY schema{} from 2a does NOT bypass (acts as no novel-type declared)", () => {
    // Empty schema{} means 2a flagged the type but provided no definition — treat as missing
    // and fall through to normal validation. Currently the type isn't in the schema map
    // so validateUniqueSchema returns ok (unknown type → trusted), so this still proceeds.
    const item: SeamAlphaItem = { id: "i_empty", type: "weird_unseen_type", unique: { foo: "bar" }, schema: {} };
    const v = validateSeamAlpha(item);
    // unknown type → validator returns ok (per schema-validator.ts line 89) → proceeds
    assert.equal(v.kind, "proceed");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Seam α failure path — route_back vs quarantine
// ─────────────────────────────────────────────────────────────────────────────

describe("validateSeamAlpha — failure paths (route_back, then quarantine)", () => {
  test("insight missing implication, no prior retries → route_back with failure detail", () => {
    const item: SeamAlphaItem = { id: "i_bad", type: "insight", unique: { observation: "X correlates Y" } };
    const v = validateSeamAlpha(item);
    assert.equal(v.kind, "route_back");
    if (v.kind === "route_back") {
      assert.ok(v.failure_detail.includes("missing=[implication]"), `expected missing=[implication] in detail, got ${v.failure_detail}`);
      assert.equal(v.failure.ok, false);
    }
  });

  test("insight missing implication, retry already exhausted → quarantine (default-off contract: existing callers unchanged)", () => {
    // 2026-05-27: the demote-edge is OPT-IN via { enable_demote: true }. With
    // default-off, the existing quarantine contract is preserved (callers that
    // don't handle demote must not silently lose items — rule 2). The
    // demote-on-this-same-input case is tested in the demote describe block
    // below with enable_demote: true.
    const item: SeamAlphaItem = {
      id: "i_bad_retry",
      type: "insight",
      unique: { observation: "X correlates Y" },
      _seam_alpha_retries: SEAM_ALPHA_MAX_RETRIES,  // = 1
    };
    const v = validateSeamAlpha(item);
    assert.equal(v.kind, "quarantine");
    if (v.kind === "quarantine") {
      assert.ok(v.failure_detail.includes("missing=[implication]"));
    }
  });

  test("decision missing required {choice} → route_back on first attempt", () => {
    const item: SeamAlphaItem = { id: "i_dec_bad", type: "decision", unique: { reason: "because" } };
    const v = validateSeamAlpha(item);
    assert.equal(v.kind, "route_back");
    if (v.kind === "route_back") {
      assert.ok(v.failure_detail.includes("missing=[choice]"));
    }
  });

  test("insight with extras={reason} but missing implication → route_back with both flags", () => {
    const item: SeamAlphaItem = { id: "i_drift", type: "insight", unique: { observation: "X correlates Y", reason: "because Z" } };
    const v = validateSeamAlpha(item);
    assert.equal(v.kind, "route_back");
    if (v.kind === "route_back") {
      assert.ok(v.failure_detail.includes("missing=[implication]"));
      assert.ok(v.failure_detail.includes("extras=[reason]"));
    }
  });

  test("MAX_RETRIES contract is exactly 1 (locked per §3 — increasing requires design revision)", () => {
    assert.equal(SEAM_ALPHA_MAX_RETRIES, 1);
  });

  test("retries above max also quarantine (defensive against caller miscount)", () => {
    const item: SeamAlphaItem = { id: "i_overrun", type: "insight", unique: {}, _seam_alpha_retries: 5 };
    assert.equal(validateSeamAlpha(item).kind, "quarantine");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Seam α DEMOTE path — debt-3 structural-small (2026-05-27)
// See memory: project-insight-fact-typing-gap. Each test targets the MEANING-
// equivalence the demote encodes, plus the boundary conditions.
// ─────────────────────────────────────────────────────────────────────────────

describe("validateSeamAlpha — demote (insight→fact when implication unfillable but observation present)", () => {
  // All tests in this block pass { enable_demote: true } — opt-in is required.
  // Default-off behavior (no demote, falls through to quarantine) is covered by
  // the existing "insight missing implication, retry already exhausted → quarantine"
  // test in the failure-paths block above + the dedicated default-off test below.

  test("default-off: enable_demote omitted → no demote even when target+source match (rule-2 safety)", () => {
    // The bug the opt-in prevents: a caller that doesn't handle `demote` would
    // otherwise silently lose items. Default-off = items stay in quarantine.
    const item: SeamAlphaItem = {
      id: "i_default_off",
      type: "insight",
      unique: { observation: "would-be-demotable" },
      _seam_alpha_retries: SEAM_ALPHA_MAX_RETRIES,
    };
    assert.equal(validateSeamAlpha(item).kind, "quarantine");
    assert.equal(validateSeamAlpha(item, {}).kind, "quarantine");
    assert.equal(validateSeamAlpha(item, { enable_demote: false }).kind, "quarantine");
  });

  test("DEMOTE_TARGETS contract — insight→fact with {observation: value} mapping locked", () => {
    // First principles: the row encodes block-types.md's definition equivalence,
    // not a domain heuristic. Lock the row so changes are deliberate.
    assert.equal(DEMOTE_TARGETS.insight.to, "fact");
    assert.deepStrictEqual(DEMOTE_TARGETS.insight.field_map, { observation: "value" });
  });

  test("insight + observation present + retry exhausted → demote (the canonical case)", () => {
    const item: SeamAlphaItem = {
      id: "i_canonical",
      type: "insight",
      unique: { observation: "validation cost dominates write path" },
      _seam_alpha_retries: SEAM_ALPHA_MAX_RETRIES,
    };
    const v = validateSeamAlpha(item, { enable_demote: true });
    assert.equal(v.kind, "demote");
    if (v.kind === "demote") {
      assert.equal(v.new_type, "fact");
      assert.deepStrictEqual(v.remapped_unique, { value: "validation cost dominates write path" });
    }
  });

  test("insight + observation EMPTY-STRING + retry exhausted → quarantine (no source for value)", () => {
    // Mirrors schema-validator's "present" definition: empty-string is absent.
    const item: SeamAlphaItem = {
      id: "i_empty_obs",
      type: "insight",
      unique: { observation: "" },
      _seam_alpha_retries: SEAM_ALPHA_MAX_RETRIES,
    };
    assert.equal(validateSeamAlpha(item, { enable_demote: true }).kind, "quarantine");
  });

  test("insight + observation WHITESPACE-only + retry exhausted → quarantine (whitespace = empty)", () => {
    const item: SeamAlphaItem = {
      id: "i_ws_obs",
      type: "insight",
      unique: { observation: "   \t  " },
      _seam_alpha_retries: SEAM_ALPHA_MAX_RETRIES,
    };
    assert.equal(validateSeamAlpha(item, { enable_demote: true }).kind, "quarantine");
  });

  test("insight + observation present, retries=0 → route_back (demote does NOT pre-empt 2b's retry)", () => {
    // Conservative: let 2b try again with failure detail; demote only after exhaustion.
    const item: SeamAlphaItem = {
      id: "i_no_retry",
      type: "insight",
      unique: { observation: "X" },
      // _seam_alpha_retries: undefined (defaults to 0)
    };
    assert.equal(validateSeamAlpha(item, { enable_demote: true }).kind, "route_back");
  });

  test("non-demotable type (decision missing choice) + retry exhausted → quarantine (no DEMOTE_TARGETS row)", () => {
    // Demote map is intentionally narrow — only types with a universal meaning-
    // equivalence appear. Decision/dead_end/constraint quarantine on miss.
    const item: SeamAlphaItem = {
      id: "i_dec_bad",
      type: "decision",
      unique: { reason: "because" },
      _seam_alpha_retries: SEAM_ALPHA_MAX_RETRIES,
    };
    assert.equal(validateSeamAlpha(item, { enable_demote: true }).kind, "quarantine");
  });

  test("demote reason names type→type AND the applied field-map (auditability)", () => {
    const item: SeamAlphaItem = {
      id: "i_reason",
      type: "insight",
      unique: { observation: "audited" },
      _seam_alpha_retries: SEAM_ALPHA_MAX_RETRIES,
    };
    const v = validateSeamAlpha(item, { enable_demote: true });
    if (v.kind === "demote") {
      assert.ok(v.reason.includes("insight→fact"), `expected 'insight→fact' in reason, got: ${v.reason}`);
      assert.ok(v.reason.includes("observation→value"), `expected 'observation→value' in reason, got: ${v.reason}`);
      assert.ok(v.reason.includes("missing=[implication]"), `expected failure detail in reason, got: ${v.reason}`);
    } else {
      assert.fail(`expected demote verdict, got ${v.kind}`);
    }
  });

  test("demote does NOT mutate the input item (verdict carries remapped_unique separately)", () => {
    // Pure-function discipline: the validator returns a NEW unique{} via
    // remapped_unique; the original item.unique is unchanged. Orchestrator
    // is the only place that applies the re-type.
    const original_unique = { observation: "do not mutate" };
    const item: SeamAlphaItem = {
      id: "i_no_mutate",
      type: "insight",
      unique: original_unique,
      _seam_alpha_retries: SEAM_ALPHA_MAX_RETRIES,
    };
    const v = validateSeamAlpha(item, { enable_demote: true });
    // Original input untouched
    assert.deepStrictEqual(item.unique, { observation: "do not mutate" });
    assert.equal(item.type, "insight");
    // Verdict carries the new shape
    if (v.kind === "demote") {
      assert.deepStrictEqual(v.remapped_unique, { value: "do not mutate" });
      assert.notStrictEqual(v.remapped_unique, original_unique);  // different object
    }
  });

  test("insight + observation + extras={reason} + retry exhausted → still demote (extras don't block)", () => {
    // The schema-check reports extras=[reason] AND missing=[implication]. The
    // demote applies because observation IS present; extras don't block it.
    // (Extras are dropped from the demoted unique{} since field_map only maps
    // observation→value — anything else falls away with the insight identity.)
    const item: SeamAlphaItem = {
      id: "i_extras",
      type: "insight",
      unique: { observation: "X", reason: "because Y" },
      _seam_alpha_retries: SEAM_ALPHA_MAX_RETRIES,
    };
    const v = validateSeamAlpha(item, { enable_demote: true });
    assert.equal(v.kind, "demote");
    if (v.kind === "demote") {
      assert.deepStrictEqual(v.remapped_unique, { value: "X" });  // `reason` dropped — not in field_map
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// validateSeamAlphaBatch — partitions correctly
// ─────────────────────────────────────────────────────────────────────────────

describe("validateSeamAlphaBatch — partitions items by verdict", () => {
  test("mixed batch with enable_demote: proceed + route_back + demote + quarantine all populated", () => {
    // 2026-05-27: with { enable_demote: true }, `bad2` (insight, observation
    // present, retry exhausted) demotes to fact. A genuinely-unfillable case
    // (`bad3`: insight with NO observation, retry exhausted) still quarantines.
    const items: SeamAlphaItem[] = [
      { id: "good", type: "decision", unique: { choice: "X" } },                              // proceed
      { id: "bad1", type: "insight", unique: { observation: "Y" } },                          // route_back (no retry yet)
      { id: "bad2", type: "insight", unique: { observation: "Z" }, _seam_alpha_retries: 1 },  // demote (retry exhausted, observation present)
      { id: "bad3", type: "insight", unique: {},                  _seam_alpha_retries: 1 },   // quarantine (no observation to demote with)
      { id: "good2", type: "fact",   unique: { value: "10" } },                               // proceed
    ];
    const r = validateSeamAlphaBatch(items, { enable_demote: true });
    assert.equal(r.proceed.length, 2);
    assert.equal(r.route_back.length, 1);
    assert.equal(r.demote.length, 1);
    assert.equal(r.quarantine.length, 1);
    assert.deepStrictEqual(r.proceed.map((p) => p.item.id).sort(), ["good", "good2"]);
    assert.equal(r.route_back[0].item.id, "bad1");
    assert.equal(r.demote[0].item.id, "bad2");
    assert.equal(r.demote[0].new_type, "fact");
    assert.equal(r.quarantine[0].item.id, "bad3");
  });

  test("same mixed batch WITHOUT enable_demote: bad2 falls into quarantine (default-off preserved)", () => {
    // Backward-compat: callers that don't opt in see the old contract.
    const items: SeamAlphaItem[] = [
      { id: "good", type: "decision", unique: { choice: "X" } },
      { id: "bad1", type: "insight", unique: { observation: "Y" } },
      { id: "bad2", type: "insight", unique: { observation: "Z" }, _seam_alpha_retries: 1 },
      { id: "bad3", type: "insight", unique: {},                  _seam_alpha_retries: 1 },
      { id: "good2", type: "fact",   unique: { value: "10" } },
    ];
    const r = validateSeamAlphaBatch(items);  // no options
    assert.equal(r.proceed.length, 2);
    assert.equal(r.route_back.length, 1);
    assert.equal(r.demote.length, 0);
    assert.equal(r.quarantine.length, 2);  // both bad2 and bad3 quarantined
  });

  test("empty batch → all-empty partitions, doesn't throw", () => {
    const r = validateSeamAlphaBatch([]);
    assert.deepStrictEqual(r.proceed, []);
    assert.deepStrictEqual(r.route_back, []);
    assert.deepStrictEqual(r.quarantine, []);
  });

  test("all-valid batch → proceed only", () => {
    const items: SeamAlphaItem[] = [
      { id: "a", type: "decision", unique: { choice: "X" } },
      { id: "b", type: "fact",     unique: { value: "10" } },
    ];
    const r = validateSeamAlphaBatch(items);
    assert.equal(r.proceed.length, 2);
    assert.equal(r.route_back.length, 0);
    assert.equal(r.quarantine.length, 0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Seam β invariant — type/unique/text/id are read-only across 2c
// ─────────────────────────────────────────────────────────────────────────────

describe("snapshotForSeamBeta + checkSeamBetaInvariant — read-only contract", () => {
  test("no mutation → ok", () => {
    const before = { id: "i1", type: "decision", unique: { choice: "X" }, text: "We use X." };
    const snap = snapshotForSeamBeta(before);
    const r = checkSeamBetaInvariant(snap, before);
    assert.equal(r.ok, true);
  });

  test("2c changes type → violation reported", () => {
    const before = { id: "i1", type: "decision", unique: { choice: "X" }, text: "We use X." };
    const snap = snapshotForSeamBeta(before);
    const after  = { id: "i1", type: "blueprint", unique: { choice: "X" }, text: "We use X." };
    const r = checkSeamBetaInvariant(snap, after);
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.violations.length, 1);
      assert.equal(r.violations[0].field, "type");
      assert.equal(r.violations[0].before, "decision");
      assert.equal(r.violations[0].after, "blueprint");
    }
  });

  test("2c changes unique field value → violation reported", () => {
    const before = { id: "i1", type: "decision", unique: { choice: "X" }, text: "We use X." };
    const snap = snapshotForSeamBeta(before);
    const after  = { id: "i1", type: "decision", unique: { choice: "Y" }, text: "We use X." };
    const r = checkSeamBetaInvariant(snap, after);
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.violations.length, 1);
      assert.equal(r.violations[0].field, "unique");
    }
  });

  test("2c adds a unique field that wasn't there → violation reported (Pass 2c is wire-only)", () => {
    const before = { id: "i1", type: "decision", unique: { choice: "X" }, text: "We use X." };
    const snap = snapshotForSeamBeta(before);
    const after  = { id: "i1", type: "decision", unique: { choice: "X", reason: "smuggled in" }, text: "We use X." };
    const r = checkSeamBetaInvariant(snap, after);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.violations[0].field, "unique");
  });

  test("2c changes text → violation reported", () => {
    const before = { id: "i1", type: "decision", unique: { choice: "X" }, text: "We use X." };
    const snap = snapshotForSeamBeta(before);
    const after  = { id: "i1", type: "decision", unique: { choice: "X" }, text: "Actually different text." };
    const r = checkSeamBetaInvariant(snap, after);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.violations[0].field, "text");
  });

  test("2c changes id → violation reported", () => {
    const before = { id: "i1", type: "decision", unique: { choice: "X" }, text: "We use X." };
    const snap = snapshotForSeamBeta(before);
    const after  = { id: "i_other", type: "decision", unique: { choice: "X" }, text: "We use X." };
    const r = checkSeamBetaInvariant(snap, after);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.violations[0].field, "id");
  });

  test("multiple mutations → all violations reported", () => {
    const before = { id: "i1", type: "decision", unique: { choice: "X" }, text: "We use X." };
    const snap = snapshotForSeamBeta(before);
    const after  = { id: "i_other", type: "blueprint", unique: { choice: "Y" }, text: "Different." };
    const r = checkSeamBetaInvariant(snap, after);
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.violations.length, 4);
      assert.deepStrictEqual(r.violations.map((v) => v.field).sort(), ["id", "text", "type", "unique"]);
    }
  });

  test("empty unique{} both sides → ok (JSON.stringify({}) is stable)", () => {
    const before = { id: "i1", type: "note", unique: {}, text: "freeform" };
    const snap = snapshotForSeamBeta(before);
    const r = checkSeamBetaInvariant(snap, before);
    assert.equal(r.ok, true);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// composeForDownstream — assemble 2a + 2b + 2c into the existing Pass2Result
// shape Pass 3 consumes. Pure function; surfaces structural inconsistencies as
// a separate array, never throws, never silently drops.
// ═════════════════════════════════════════════════════════════════════════════

describe("composeForDownstream — happy path (3-pass output → Pass2Result)", () => {
  const happyInput: ComposeInput = {
    pass2a: {
      skipped: [{ id: "drop1", reason: "intra-batch dup of i1" }],
      classified: [
        { id: "i1", text: "We chose FastAPI", type: "decision", project: "rate-limit", classification_reasoning: "TEST 4 fired", review_reason: undefined },
        { id: "i2", text: "FastAPI cold start is 8s", type: "fact", project: "rate-limit", classification_reasoning: "TEST 1 not fired; fact" },
      ],
    },
    pass2b_results: [
      { id: "i1", unique: { choice: "FastAPI", reason: "best fit", alternatives_rejected: "Flask, Django" } },
      { id: "i2", unique: { value: "8s", why_matters: "user-perceived latency" } },
    ],
    pass2c: {
      wiring: [
        { id: "i1", triggered_by: [], based_on: ["i2"], relations: [] },
        { id: "i2", triggered_by: [], based_on: [],     relations: [{ type: "supports", target: "i1" }] },
      ],
    },
  };

  test("composes Pass2Result with grafted unique{} + wiring + relations per item", () => {
    const { result, inconsistencies } = composeForDownstream(happyInput);
    assert.equal(inconsistencies.length, 0);
    assert.equal(result.classified.length, 2);
    const i1 = result.classified.find((c) => c.id === "i1")!;
    const i2 = result.classified.find((c) => c.id === "i2")!;
    // 2a fields preserved
    assert.equal(i1.type, "decision");
    assert.equal(i1.project, "rate-limit");
    assert.equal(i1.classification_reasoning, "TEST 4 fired");
    // 2b unique grafted
    assert.deepStrictEqual(i1.unique, { choice: "FastAPI", reason: "best fit", alternatives_rejected: "Flask, Django" });
    assert.deepStrictEqual(i2.unique, { value: "8s", why_matters: "user-perceived latency" });
    // 2c wiring grafted onto items
    assert.deepStrictEqual(i1.triggered_by_items, []);
    assert.deepStrictEqual(i1.based_on_items, ["i2"]);
    assert.deepStrictEqual(i1.relations, []);
    assert.deepStrictEqual(i2.based_on_items, []);
    assert.deepStrictEqual(i2.relations, [{ type: "supports", target: "i1" }]);
  });

  test("emits legacy top-level causal_wiring[] for items with at least one link", () => {
    const { result } = composeForDownstream(happyInput);
    // Only i1 had a non-empty wiring (based_on: ["i2"]); i2 had no triggered_by/based_on.
    assert.equal(result.causal_wiring!.length, 1);
    assert.equal(result.causal_wiring![0].item_id, "i1");
    assert.deepStrictEqual(result.causal_wiring![0].based_on, ["i2"]);
    assert.deepStrictEqual(result.causal_wiring![0].triggered_by, []);
  });

  test("passes 2a's skipped[] through unchanged", () => {
    const { result } = composeForDownstream(happyInput);
    assert.deepStrictEqual(result.skipped, [{ id: "drop1", reason: "intra-batch dup of i1" }]);
  });
});

describe("composeForDownstream — inconsistencies surfaced (audit, no throw)", () => {
  test("missing_pass2b_fill: classified item has no 2b result → empty unique{} + inconsistency record", () => {
    const input: ComposeInput = {
      pass2a: { skipped: [], classified: [{ id: "i1", text: "X", type: "decision", project: "p", classification_reasoning: "r" }] },
      pass2b_results: [],  // ← empty: orchestrator bug, but composer doesn't crash
      pass2c:         { wiring: [{ id: "i1", triggered_by: [], based_on: [], relations: [] }] },
    };
    const { result, inconsistencies } = composeForDownstream(input);
    assert.equal(result.classified.length, 1);
    assert.deepStrictEqual(result.classified[0].unique, {});
    assert.equal(inconsistencies.length, 1);
    assert.equal(inconsistencies[0].kind, "missing_pass2b_fill");
    assert.equal(inconsistencies[0].id, "i1");
  });

  test("missing_pass2c_wiring: defaults to empty arrays per pipeline.ts:773 monolith behavior + inconsistency record", () => {
    const input: ComposeInput = {
      pass2a: { skipped: [], classified: [{ id: "i1", text: "X", type: "decision", project: "p", classification_reasoning: "r" }] },
      pass2b_results: [{ id: "i1", unique: { choice: "X" } }],
      pass2c:         { wiring: [] },  // ← 2c didn't wire this item
    };
    const { result, inconsistencies } = composeForDownstream(input);
    assert.deepStrictEqual(result.classified[0].triggered_by_items, []);
    assert.deepStrictEqual(result.classified[0].based_on_items, []);
    assert.equal(result.classified[0].relations, undefined);
    assert.equal(inconsistencies.length, 1);
    assert.equal(inconsistencies[0].kind, "missing_pass2c_wiring");
  });

  test("orphan_pass2b: 2b emitted a fill for unknown id → record but not in composed output", () => {
    const input: ComposeInput = {
      pass2a:         { skipped: [], classified: [{ id: "i1", text: "X", type: "decision", project: "p", classification_reasoning: "r" }] },
      pass2b_results: [
        { id: "i1",      unique: { choice: "X" } },
        { id: "phantom", unique: { value: "?" } },  // ← no matching classified item
      ],
      pass2c:         { wiring: [{ id: "i1", triggered_by: [], based_on: [], relations: [] }] },
    };
    const { result, inconsistencies } = composeForDownstream(input);
    assert.equal(result.classified.length, 1);
    assert.ok(!result.classified.find((c) => c.id === "phantom"), "phantom 2b id leaked into classified output");
    const orphan = inconsistencies.find((i) => i.kind === "orphan_pass2b");
    assert.ok(orphan, "orphan_pass2b inconsistency not recorded");
    assert.equal(orphan!.id, "phantom");
  });

  test("orphan_pass2c: 2c emitted wiring for unknown id → record but not in composed output", () => {
    const input: ComposeInput = {
      pass2a:         { skipped: [], classified: [{ id: "i1", text: "X", type: "decision", project: "p", classification_reasoning: "r" }] },
      pass2b_results: [{ id: "i1", unique: { choice: "X" } }],
      pass2c:         { wiring: [
        { id: "i1",      triggered_by: [],     based_on: [], relations: [] },
        { id: "phantom", triggered_by: ["i1"], based_on: [], relations: [] },  // ← phantom id
      ]},
    };
    const { result, inconsistencies } = composeForDownstream(input);
    assert.equal(result.classified.length, 1);
    const orphan = inconsistencies.find((i) => i.kind === "orphan_pass2c");
    assert.ok(orphan, "orphan_pass2c inconsistency not recorded");
    assert.equal(orphan!.id, "phantom");
  });

  test("multiple inconsistencies accumulate; none cause a throw", () => {
    const input: ComposeInput = {
      pass2a: { skipped: [], classified: [
        { id: "i1", text: "a", type: "fact",     project: "p", classification_reasoning: "r1" },
        { id: "i2", text: "b", type: "decision", project: "p", classification_reasoning: "r2" },
      ]},
      pass2b_results: [
        { id: "i1", unique: { value: "y" } },
        // missing fill for i2
        { id: "phantom_b", unique: { value: "?" } },
      ],
      pass2c: { wiring: [
        { id: "i1", triggered_by: [], based_on: [], relations: [] },
        // missing wiring for i2
        { id: "phantom_c", triggered_by: [], based_on: [], relations: [] },
      ]},
    };
    const { result, inconsistencies } = composeForDownstream(input);
    assert.equal(result.classified.length, 2);
    // i2 has missing fill + missing wiring → 2 inconsistencies; phantom_b + phantom_c → 2 more.
    assert.equal(inconsistencies.length, 4);
    const kinds = inconsistencies.map((i) => i.kind).sort();
    assert.deepStrictEqual(kinds, ["missing_pass2b_fill", "missing_pass2c_wiring", "orphan_pass2b", "orphan_pass2c"]);
  });
});

describe("composeForDownstream — pass-through + edge cases", () => {
  test("empty inputs → empty result, no inconsistencies, no crash", () => {
    const { result, inconsistencies } = composeForDownstream({
      pass2a:         { skipped: [], classified: [] },
      pass2b_results: [],
      pass2c:         { wiring: [] },
    });
    assert.deepStrictEqual(result.skipped, []);
    assert.deepStrictEqual(result.classified, []);
    assert.deepStrictEqual(result.causal_wiring, []);
    assert.deepStrictEqual(inconsistencies, []);
  });

  test("does not mutate input objects (pure function)", () => {
    const pass2a = {
      skipped: [{ id: "x", reason: "y" }],
      classified: [{ id: "i1", text: "t", type: "decision", project: "p", classification_reasoning: "r" }],
    };
    const pass2b_results = [{ id: "i1", unique: { choice: "X" } }];
    const pass2c = { wiring: [{ id: "i1", triggered_by: ["item_0"], based_on: [], relations: [] }] };

    const before2aClassified = JSON.stringify(pass2a.classified);
    const before2bResults    = JSON.stringify(pass2b_results);
    const before2cWiring     = JSON.stringify(pass2c.wiring);

    composeForDownstream({ pass2a, pass2b_results, pass2c });

    assert.equal(JSON.stringify(pass2a.classified), before2aClassified, "pass2a.classified was mutated");
    assert.equal(JSON.stringify(pass2b_results),     before2bResults,    "pass2b_results was mutated");
    assert.equal(JSON.stringify(pass2c.wiring),      before2cWiring,     "pass2c.wiring was mutated");
  });

  test("preserves 2a fields that survive Seam α: schema, review_reason, extends_item, supersedes_ref, resolved_ref", () => {
    const input: ComposeInput = {
      pass2a: { skipped: [], classified: [{
        id: "i1", text: "novel thing", type: "novel_x", project: "p", classification_reasoning: "novel_type fired",
        schema: { metric_a: "what it captures", metric_b: "etc" },
        review_reason: "novel_type",
        extends_item: "item_0",
        supersedes_ref: "old_label",
        resolved_ref: "alt_label",
      }]},
      pass2b_results: [{ id: "i1", unique: { metric_a: "1", metric_b: "2" } }],
      pass2c:         { wiring: [{ id: "i1", triggered_by: [], based_on: [], relations: [] }] },
    };
    const { result } = composeForDownstream(input);
    const i1 = result.classified[0];
    assert.deepStrictEqual(i1.schema, { metric_a: "what it captures", metric_b: "etc" });
    assert.equal(i1.review_reason, "novel_type");
    assert.equal(i1.extends_item, "item_0");
    assert.equal(i1.supersedes_ref, "old_label");
    assert.equal(i1.resolved_ref, "alt_label");
  });

  test("causal_wiring[] omits items with no triggered_by AND no based_on (avoid empty noise)", () => {
    const input: ComposeInput = {
      pass2a: { skipped: [], classified: [
        { id: "i1", text: "a", type: "fact",     project: "p", classification_reasoning: "r" },
        { id: "i2", text: "b", type: "decision", project: "p", classification_reasoning: "r" },
      ]},
      pass2b_results: [
        { id: "i1", unique: { value: "x" } },
        { id: "i2", unique: { choice: "y" } },
      ],
      pass2c: { wiring: [
        { id: "i1", triggered_by: [],     based_on: [],     relations: [{ type: "contradicts", target: "i2" }] }, // no triggered_by/based_on
        { id: "i2", triggered_by: ["i1"], based_on: [],     relations: [] },
      ]},
    };
    const { result } = composeForDownstream(input);
    assert.equal(result.causal_wiring!.length, 1, "causal_wiring includes items without triggered_by/based_on (just relations)");
    assert.equal(result.causal_wiring![0].item_id, "i2");
    // But i1's relations[] is grafted onto the classified item even though it's not in causal_wiring[].
    assert.deepStrictEqual(result.classified.find((c) => c.id === "i1")!.relations, [{ type: "contradicts", target: "i2" }]);
  });
});
