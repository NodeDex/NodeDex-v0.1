/**
 * Pass 2c — prompt + schema + sanitizer + LLM-call-shape tests.
 *
 * Covers PASS2-SPLIT-DESIGN.md §2 Pass ownership for 2c:
 *   - OWNS: Q3 triggered_by, Q4 based_on, Q5 semantic relations
 *           (monolith-parity: contradicts / supports / resolves only)
 *   - DOES NOT: change type, unique, text, project, or any other read-only
 *               field (§1 Seam β contract)
 *
 * What this file tests (without a real LLM):
 *   - Prompt structure: required Q3/Q4/Q5 + Seam β framing present;
 *     removed Q0/Q1/Q2/UNIQUE FIELDS/etc. absent
 *   - Sanitizer: strips forbidden output keys + drops non-parity relation types
 *   - Empty-batch degenerate input short-circuits without hitting the LLM
 *
 * What this file does NOT test (needs integration runs, not unit):
 *   - Actual LLM call quality (Week 3 fixture validation per design §9)
 *   - End-to-end seam interaction (covered by pass2-seams.test.ts + future
 *     integration tests once the orchestrator wires 2a → α → 2b → β → 2c)
 *
 * Run: node --import=tsx/esm --test src/middleware/reflect/__tests__/pass2c.test.ts
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  PASS2C_PROMPT,
  ALLOWED_PASS2C_RELATION_TYPES,
  sanitizePass2cItem,
  sanitizePass2cResult,
  callPass2cLLM,
  type Pass2cInput,
} from "../pass2c.js";
import type { LLMProvider } from "../../../engine/ai-provider.js";

// ─────────────────────────────────────────────────────────────────────────────
// Prompt structure — sections that MUST be in the 2c prompt
// ─────────────────────────────────────────────────────────────────────────────

describe("PASS2C_PROMPT — required sections per §2 Pass 2c ownership", () => {
  test("includes SEAM β CONTRACT read-only callout (the load-bearing safety rail)", () => {
    assert.ok(PASS2C_PROMPT.includes("SEAM β CONTRACT"), "Seam β contract header missing");
    assert.ok(PASS2C_PROMPT.includes("DO NOT change") || PASS2C_PROMPT.includes("READ-ONLY"), "read-only framing missing");
    assert.ok(PASS2C_PROMPT.includes("DO NOT touch unique") || PASS2C_PROMPT.includes("DO NOT touch unique{}"), "do-not-touch-unique line missing");
    assert.ok(PASS2C_PROMPT.includes("DO NOT add or remove items") || PASS2C_PROMPT.includes("DO NOT add"), "do-not-add-items line missing");
    assert.ok(PASS2C_PROMPT.includes("DO NOT emit skipped"), "do-not-emit-skipped line missing");
  });

  test("includes STATE CONVENTION block (Q5 cross-batch refs depend on it)", () => {
    assert.ok(PASS2C_PROMPT.includes("STATE CONVENTION"), "STATE CONVENTION header missing");
    assert.ok(PASS2C_PROMPT.includes("PROJECT GRAPH"), "PROJECT GRAPH state reference missing");
    assert.ok(
      PASS2C_PROMPT.includes("training knowledge") || PASS2C_PROMPT.includes("commonly known"),
      "training-knowledge-not-state framing missing",
    );
  });

  test("includes Q3 TRIGGERED_BY with circularity guard + REPLACEMENTS + HIERARCHY rules", () => {
    assert.ok(PASS2C_PROMPT.includes("Q3: TRIGGERED_BY"), "Q3 TRIGGERED_BY header missing");
    assert.ok(PASS2C_PROMPT.includes("counterfactual") || PASS2C_PROMPT.includes("In a world where"), "counterfactual framing missing");
    assert.ok(PASS2C_PROMPT.includes("CIRCULARITY GUARD"), "circularity guard missing");
    assert.ok(PASS2C_PROMPT.includes("REPLACEMENTS"), "REPLACEMENTS rule missing");
    assert.ok(PASS2C_PROMPT.includes("HIERARCHY"), "HIERARCHY-level wiring rule missing");
    assert.ok(PASS2C_PROMPT.includes("Genesis") || PASS2C_PROMPT.includes("triggered_by: []"), "genesis empty-array rule missing");
  });

  test("includes Q4 BASED_ON", () => {
    assert.ok(PASS2C_PROMPT.includes("Q4: BASED_ON"), "Q4 BASED_ON header missing");
    assert.ok(PASS2C_PROMPT.includes("UNSUPPORTED"), "UNSUPPORTED counterfactual framing missing");
  });

  test("includes Q5 SEMANTIC RELATIONS with monolith-parity types only (3, not 5)", () => {
    assert.ok(PASS2C_PROMPT.includes("Q5: SEMANTIC RELATIONS"), "Q5 header missing");
    // Parity: only contradicts / supports / resolves
    for (const t of ["contradicts", "supports", "resolves"]) {
      assert.ok(PASS2C_PROMPT.includes(t), `relation type "${t}" missing from Q5`);
    }
    // Anti-parity: derived_from / affects belong elsewhere (Pass 4 / post-process)
    assert.ok(
      PASS2C_PROMPT.includes("ONLY these three") || PASS2C_PROMPT.includes("only these three"),
      "only-three-relation-types restriction missing — would let pass2c smuggle in design §2 expansion",
    );
  });

  test("includes SCENE CARD CAUSAL LINKS note (Q3 input)", () => {
    assert.ok(PASS2C_PROMPT.includes("SCENE CARD"), "SCENE CARD section missing");
    assert.ok(PASS2C_PROMPT.includes("CAUSAL LINKS"), "CAUSAL LINKS callout missing");
  });

  test("includes OUTPUT shape instruction (id + 3 arrays, empty-arrays-not-omit)", () => {
    assert.ok(PASS2C_PROMPT.includes("OUTPUT"), "OUTPUT section missing");
    assert.ok(PASS2C_PROMPT.includes("triggered_by") && PASS2C_PROMPT.includes("based_on") && PASS2C_PROMPT.includes("relations"), "output field names missing");
    assert.ok(
      PASS2C_PROMPT.includes("[]") || PASS2C_PROMPT.includes("empty array"),
      "empty-array convention missing — without it, model may omit fields the schema requires",
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Prompt structure — sections that MUST NOT be in the 2c prompt (§2 anti-examples)
// ─────────────────────────────────────────────────────────────────────────────

describe("PASS2C_PROMPT — sections REMOVED per §2 (anti-example contract)", () => {
  test("does NOT include Q0 DEDUP (that's Pass 2a)", () => {
    assert.ok(!PASS2C_PROMPT.includes("Q0: DEDUP"), "Q0 DEDUP section leaked from monolith");
    assert.ok(!PASS2C_PROMPT.includes("Intra-batch duplicate"), "intra-batch dedup step leaked");
    assert.ok(!PASS2C_PROMPT.includes("STEP I —"), "dedup STEP I leaked");
  });

  test("does NOT include Q1 TYPE TESTs (that's Pass 2a)", () => {
    assert.ok(!PASS2C_PROMPT.includes("Q1: TYPE"), "Q1 TYPE header leaked");
    assert.ok(!PASS2C_PROMPT.includes("TEST 1:"), "TEST 1 (metric) leaked");
    assert.ok(!PASS2C_PROMPT.includes("TEST 5:"), "TEST 5 (graph_align) leaked");
  });

  test("does NOT include Q2 HIERARCHY (meaning-dependency) — that's Pass 2a", () => {
    // Q2 HIERARCHY is 2a's extends_item assignment. 2c's "HIERARCHY" appears
    // INSIDE Q3 and means decision-vs-mechanism wiring level — different concept.
    assert.ok(!PASS2C_PROMPT.includes("Q2: HIERARCHY"), "Q2 HIERARCHY section leaked");
    assert.ok(
      !PASS2C_PROMPT.includes("Can this item stand alone as knowledge"),
      "extends_item meaning-dependency framing leaked",
    );
  });

  test("does NOT include UNIQUE FIELDS section (that's Pass 2b)", () => {
    assert.ok(!PASS2C_PROMPT.includes("UNIQUE FIELDS"), "UNIQUE FIELDS section leaked");
    assert.ok(!PASS2C_PROMPT.includes("Use ONLY the assigned type's fields"), "unique-fields instruction leaked");
    assert.ok(!PASS2C_PROMPT.includes("populate AFTER type is final"), "populate-after-type instruction leaked");
  });

  test("does NOT include PROJECT ATTRIBUTION (that's Pass 2a)", () => {
    assert.ok(!PASS2C_PROMPT.includes("PROJECT ATTRIBUTION"), "PROJECT ATTRIBUTION leaked");
    assert.ok(!PASS2C_PROMPT.includes("SCOPE PROJECT"), "scope-project fallback rule leaked");
  });

  test("does NOT include REVIEW FLAGS enum (that's Pass 2a)", () => {
    assert.ok(!PASS2C_PROMPT.includes("REVIEW FLAGS"), "REVIEW FLAGS header leaked");
    assert.ok(!PASS2C_PROMPT.includes("type_override"), "type_override flag leaked");
    assert.ok(!PASS2C_PROMPT.includes("weak_match"), "weak_match flag leaked");
  });

  test("does NOT include CLASSIFICATION REASONING required-output rule (that's Pass 2a)", () => {
    assert.ok(!PASS2C_PROMPT.includes("CLASSIFICATION REASONING"), "CLASSIFICATION REASONING header leaked");
  });

  test("does NOT include NOVEL TYPE schema declaration rule (that's Pass 2a)", () => {
    assert.ok(!PASS2C_PROMPT.includes("NOVEL TYPE"), "NOVEL TYPE rule leaked");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Charter-aligned framing preserved (rule 14 spirit — asymmetric cost framing)
// ─────────────────────────────────────────────────────────────────────────────

describe("PASS2C_PROMPT — charter-aligned framing preserved", () => {
  test("Q3 asymmetric-cost framing preserved (wrong wiring > missing wiring)", () => {
    assert.ok(
      PASS2C_PROMPT.includes("false narrative costs more") || PASS2C_PROMPT.includes("Wrong wiring"),
      "Q3 false-narrative cost framing missing",
    );
  });

  test("Q4 asymmetric-cost framing preserved (false evidence > missing evidence)", () => {
    assert.ok(
      PASS2C_PROMPT.includes("False evidence link costs more") || PASS2C_PROMPT.includes("false evidence"),
      "Q4 false-evidence cost framing missing",
    );
  });

  test("circularity guard kept verbatim from monolith (rule 7 / determinism on probabilistic input)", () => {
    assert.ok(PASS2C_PROMPT.includes("Did I already put B→A"), "circularity check phrasing changed from monolith — drift risk");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Sanitizer — single-item
// ─────────────────────────────────────────────────────────────────────────────

describe("sanitizePass2cItem — strips forbidden keys, normalizes shape", () => {
  test("passes through a clean wiring entry unchanged", () => {
    const raw = {
      id: "item_3",
      triggered_by: ["item_1"],
      based_on: ["item_2"],
      relations: [{ type: "contradicts", target: "item_7", reasoning: "item_3 claims X is true; item_7 claims X is false" }],
    };
    const { item, stripped, strippedRelationTypes } = sanitizePass2cItem(raw);
    assert.deepStrictEqual(item, raw);
    assert.deepStrictEqual(stripped, []);
    assert.deepStrictEqual(strippedRelationTypes, []);
  });

  test("strips leaked type / unique / text fields (Seam β read-only contract)", () => {
    const raw = {
      id: "item_3",
      type: "decision",                       // FORBIDDEN — Seam β
      unique: { choice: "X" },                // FORBIDDEN — Seam β
      text: "model decided to rewrite this",  // FORBIDDEN — Seam β
      triggered_by: [],
      based_on: [],
      relations: [],
    };
    const { item, stripped } = sanitizePass2cItem(raw);
    assert.ok(!("type" in item));
    assert.ok(!("unique" in item));
    assert.ok(!("text" in item));
    assert.deepStrictEqual(stripped.sort(), ["text", "type", "unique"]);
  });

  test("strips a wide forbidden surface (project, classification_reasoning, supersedes_ref, etc.)", () => {
    const raw = {
      id: "item_3",
      project: "p",
      extends_item: "item_1",
      supersedes_ref: "label_x",
      resolved_ref: "label_y",
      review_reason: "type_override",
      classification_reasoning: "TEST 5 fired",
      schema: { observation: "x", implication: "y" },
      note: "extra commentary",
      triggered_by: ["item_1"],
      based_on: [],
      relations: [],
    };
    const { item, stripped } = sanitizePass2cItem(raw);
    // Only the wiring-bundle fields survive
    assert.deepStrictEqual(Object.keys(item).sort(), ["based_on", "id", "relations", "triggered_by"]);
    assert.deepStrictEqual(
      stripped.sort(),
      ["classification_reasoning", "extends_item", "note", "project", "resolved_ref", "review_reason", "schema", "supersedes_ref"],
    );
  });

  test("defaults missing triggered_by / based_on / relations to empty arrays", () => {
    const raw = { id: "item_3" };
    const { item } = sanitizePass2cItem(raw);
    assert.deepStrictEqual(item.triggered_by, []);
    assert.deepStrictEqual(item.based_on, []);
    assert.deepStrictEqual(item.relations, []);
  });

  test("filters relation entries with non-parity types (derived_from, affects, supersedes, ...)", () => {
    const raw = {
      id: "item_3",
      triggered_by: [],
      based_on: [],
      relations: [
        { type: "contradicts",   target: "item_7" }, // ALLOWED
        { type: "derived_from",  target: "item_8" }, // FORBIDDEN per parity rule (Pass 4 emits this)
        { type: "affects",       target: "item_9" }, // FORBIDDEN per parity rule
        { type: "supports",      target: "item_10" },// ALLOWED
        { type: "supersedes",    target: "item_11" },// FORBIDDEN (2a's supersedes_ref handles this)
        { type: "resolves",      target: "item_12" },// ALLOWED
      ],
    };
    const { item, strippedRelationTypes } = sanitizePass2cItem(raw);
    assert.equal(item.relations.length, 3);
    assert.deepStrictEqual(item.relations.map((r) => r.type).sort(), ["contradicts", "resolves", "supports"]);
    assert.deepStrictEqual(strippedRelationTypes.sort(), ["affects", "derived_from", "supersedes"]);
  });

  test("filters relation entries with empty/missing type or target (defensive)", () => {
    const raw = {
      id: "item_3",
      triggered_by: [],
      based_on: [],
      relations: [
        { type: "contradicts", target: "item_7" },         // OK
        { type: "", target: "item_8" },                    // empty type — drop silently (not a parity violation)
        { type: "supports", target: "" },                  // empty target — drop
        { type: "supports", target: "   " },               // whitespace target — drop
        null,                                              // bogus — drop
        { type: "resolves" } as any,                       // no target — drop
      ],
    };
    const { item } = sanitizePass2cItem(raw);
    assert.equal(item.relations.length, 1);
    assert.equal(item.relations[0].target, "item_7");
  });

  test("string-array fields drop empty / whitespace / non-string entries", () => {
    const raw = {
      id: "item_3",
      triggered_by: ["item_1", "", "  ", 42 as any, null as any, "item_2"],
      based_on:     ["item_3"],
      relations:    [],
    };
    const { item } = sanitizePass2cItem(raw);
    assert.deepStrictEqual(item.triggered_by, ["item_1", "item_2"]);
    assert.deepStrictEqual(item.based_on, ["item_3"]);
  });

  test("does not modify the input object (pure function)", () => {
    const raw = {
      id: "item_3",
      type: "decision",
      triggered_by: ["item_1"],
      based_on: [],
      relations: [{ type: "derived_from", target: "x" }],
    };
    sanitizePass2cItem(raw);
    // Input retains the forbidden type field + the non-parity relation
    assert.ok("type" in raw, "sanitizer mutated input (should be pure)");
    assert.equal(raw.relations[0].type, "derived_from");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Sanitizer — full envelope
// ─────────────────────────────────────────────────────────────────────────────

describe("sanitizePass2cResult — full envelope, aggregated audit data", () => {
  test("clean batch passes through unchanged with zero strip events", () => {
    const raw = {
      wiring: [
        { id: "i1", triggered_by: [],         based_on: [],         relations: [] },
        { id: "i2", triggered_by: ["i1"],     based_on: [],         relations: [{ type: "supports", target: "i1" }] },
      ],
    };
    const { result, totalStrippedFields, perItemStripped, perItemStrippedRelationTypes } = sanitizePass2cResult(raw);
    assert.equal(result.wiring.length, 2);
    assert.equal(totalStrippedFields, 0);
    assert.equal(perItemStripped.length, 0);
    assert.equal(perItemStrippedRelationTypes.length, 0);
  });

  test("mixed batch — only leaky items appear in audit arrays", () => {
    const raw = {
      wiring: [
        { id: "i1", triggered_by: [],     based_on: [], relations: [] },                                    // clean
        { id: "i2", type: "decision", unique: { choice: "X" }, triggered_by: [], based_on: [], relations: [] }, // forbidden keys
        { id: "i3", triggered_by: [], based_on: [], relations: [{ type: "derived_from", target: "i1" }] }, // non-parity rel
        { id: "i4", text: "x", triggered_by: [], based_on: [], relations: [{ type: "affects", target: "i2" }] }, // both
      ],
    };
    const { result, totalStrippedFields, perItemStripped, perItemStrippedRelationTypes } = sanitizePass2cResult(raw);
    assert.equal(result.wiring.length, 4);
    // i2: 2 stripped keys (type, unique). i4: 1 stripped key (text).
    assert.equal(totalStrippedFields, 3);
    const ids = perItemStripped.map((p) => p.id).sort();
    assert.deepStrictEqual(ids, ["i2", "i4"]);
    // Relation strips: i3 (derived_from) + i4 (affects)
    const relIds = perItemStrippedRelationTypes.map((p) => p.id).sort();
    assert.deepStrictEqual(relIds, ["i3", "i4"]);
  });

  test("empty input → empty output, no crashes", () => {
    const { result, totalStrippedFields, perItemStripped, perItemStrippedRelationTypes } = sanitizePass2cResult({});
    assert.deepStrictEqual(result.wiring, []);
    assert.equal(totalStrippedFields, 0);
    assert.equal(perItemStripped.length, 0);
    assert.equal(perItemStrippedRelationTypes.length, 0);
  });

  test("non-parity relations stripped item-by-item without affecting other items", () => {
    const raw = {
      wiring: [
        { id: "i1", triggered_by: [], based_on: [], relations: [{ type: "derived_from", target: "x" }, { type: "contradicts", target: "y" }] },
        { id: "i2", triggered_by: [], based_on: [], relations: [{ type: "supports", target: "z" }] },
      ],
    };
    const { result, perItemStrippedRelationTypes } = sanitizePass2cResult(raw);
    assert.equal(result.wiring[0].relations.length, 1);
    assert.equal(result.wiring[0].relations[0].type, "contradicts");
    assert.equal(result.wiring[1].relations.length, 1);
    assert.equal(result.wiring[1].relations[0].type, "supports");
    assert.equal(perItemStrippedRelationTypes.length, 1);
    assert.equal(perItemStrippedRelationTypes[0].id, "i1");
    assert.deepStrictEqual(perItemStrippedRelationTypes[0].types, ["derived_from"]);
  });

  test("relations with all valid parity types pass through unchanged", () => {
    const raw = {
      wiring: [
        { id: "i1", triggered_by: [], based_on: [], relations: [
          { type: "contradicts", target: "a" },
          { type: "supports",    target: "b" },
          { type: "resolves",    target: "c" },
        ] },
      ],
    };
    const { result, perItemStrippedRelationTypes } = sanitizePass2cResult(raw);
    assert.equal(result.wiring[0].relations.length, 3);
    assert.equal(perItemStrippedRelationTypes.length, 0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Allowed-types constant (locking the parity contract via test)
// ─────────────────────────────────────────────────────────────────────────────

describe("ALLOWED_PASS2C_RELATION_TYPES — locked to monolith Q5 parity", () => {
  test("contains exactly the 3 monolith Q5 types — no more, no less", () => {
    // If this test fails because the set was expanded, that means someone
    // shipped the design §2 expansion (derived_from / affects) — make sure
    // the prompt was updated to MENTION them too (otherwise the sanitizer
    // accepts what the prompt forbids — bug).
    assert.equal(ALLOWED_PASS2C_RELATION_TYPES.size, 3, "ALLOWED set drifted from monolith Q5 parity");
    assert.ok(ALLOWED_PASS2C_RELATION_TYPES.has("contradicts"));
    assert.ok(ALLOWED_PASS2C_RELATION_TYPES.has("supports"));
    assert.ok(ALLOWED_PASS2C_RELATION_TYPES.has("resolves"));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// LLM call — short-circuit + provider shape contract
// ─────────────────────────────────────────────────────────────────────────────

describe("callPass2cLLM — degenerate inputs short-circuit (no LLM cost)", () => {
  test("empty items[] returns empty wiring without invoking the provider", async () => {
    const stub = {
      getName: () => "should-not-be-called",
      generateStructured: () => { throw new Error("provider invoked on empty batch — should have short-circuited"); },
    } as unknown as LLMProvider;

    const r = await callPass2cLLM(stub, [], "");
    assert.deepStrictEqual(r.result, { wiring: [] });
    assert.equal(r.rateLimited, false);
    assert.equal(r.thinking, "");
  });

  test("non-empty batch: sanitizes provider output through the same sanitizePass2cResult contract", async () => {
    // Mock provider returns a leaky wiring; assert sanitizer fired before we got back.
    const mockProvider = {
      getName: () => "mock",
      generateStructured: async () => ({
        result: {
          wiring: [
            // Leaky: includes type + a non-parity relation
            { id: "i1", type: "decision", triggered_by: ["i0"], based_on: [], relations: [{ type: "derived_from", target: "i0" }, { type: "contradicts", target: "i2" }] },
            // Clean
            { id: "i2", triggered_by: [], based_on: ["i1"], relations: [] },
          ],
        },
        thinking: "mock reasoning",
        rateLimited: false,
        model: "mock-model",
        attempts: [{ model: "mock-model", outcome: "ok" }],
        usage: { input: 100, thinking: 50, output: 80 },
      }),
    } as unknown as LLMProvider;

    const items: Pass2cInput[] = [
      { id: "i1", text: "a", type: "decision", unique: { choice: "X" } },
      { id: "i2", text: "b", type: "fact",     unique: { value: "Y" } },
    ];
    const r = await callPass2cLLM(mockProvider, items, "PROJECT GRAPH CONTEXT");

    assert.ok(r.result);
    assert.equal(r.result!.wiring.length, 2);
    // i1 had type stripped + derived_from filtered → clean wiring
    const i1 = r.result!.wiring.find((w) => w.id === "i1")!;
    assert.ok(!("type" in i1), "type leakage survived sanitize");
    assert.equal(i1.relations.length, 1);
    assert.equal(i1.relations[0].type, "contradicts");
    // Audit trail surfaces the stripping
    assert.ok(r.strippedFields && r.strippedFields.length === 1);
    assert.equal(r.strippedFields![0].id, "i1");
    assert.deepStrictEqual(r.strippedFields![0].stripped, ["type"]);
    assert.ok(r.strippedRelationTypes && r.strippedRelationTypes.length === 1);
    assert.equal(r.strippedRelationTypes![0].id, "i1");
    assert.deepStrictEqual(r.strippedRelationTypes![0].types, ["derived_from"]);
    // Usage + model passed through
    assert.deepStrictEqual(r.usage, { input: 100, thinking: 50, output: 80 });
    assert.equal(r.model, "mock-model");
  });

  test("provider returns null result (rate-limited or failed) → callPass2cLLM returns null result + propagates flags", async () => {
    const failProvider = {
      getName: () => "fail",
      generateStructured: async () => ({
        result: null,
        thinking: "",
        rateLimited: true,
        model: undefined,
        attempts: [{ model: "fail", outcome: "rate_limited" }],
      }),
    } as unknown as LLMProvider;

    const items: Pass2cInput[] = [{ id: "i1", text: "a", type: "decision", unique: { choice: "X" } }];
    const r = await callPass2cLLM(failProvider, items, "");

    assert.equal(r.result, null);
    assert.equal(r.rateLimited, true);
    assert.ok(r.attempts && r.attempts[0].outcome === "rate_limited");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// callPass2cLLM — modelOverride threading (C, 2026-05-25)
// ─────────────────────────────────────────────────────────────────────────────

describe("callPass2cLLM — passes modelOverride through to provider when set", () => {
  test("modelOverride present → forwarded to generateStructured options", async () => {
    const seen: { options?: any } = {};
    const mockProvider = {
      getName: () => "mock",
      generateStructured: async (_p: string, _u: string, _s: object, options?: any) => {
        seen.options = options;
        return { result: { wiring: [] }, thinking: "", rateLimited: false, model: "google/gemini-2.5-flash", attempts: [] };
      },
    } as unknown as LLMProvider;
    const items: Pass2cInput[] = [{ id: "i1", text: "a", type: "fact", unique: { value: "x" } }];

    await callPass2cLLM(mockProvider, items, "", 1024, undefined, "google/gemini-2.5-flash");
    assert.equal(seen.options?.modelOverride, "google/gemini-2.5-flash");
  });

  test("modelOverride undefined → option omitted", async () => {
    const seen: { options?: any } = {};
    const mockProvider = {
      getName: () => "mock",
      generateStructured: async (_p: string, _u: string, _s: object, options?: any) => {
        seen.options = options;
        return { result: { wiring: [] }, thinking: "", rateLimited: false, model: "m", attempts: [] };
      },
    } as unknown as LLMProvider;
    const items: Pass2cInput[] = [{ id: "i1", text: "a", type: "fact", unique: {} }];

    await callPass2cLLM(mockProvider, items, "", 1024, undefined /* no modelOverride */);
    assert.ok(!("modelOverride" in (seen.options ?? {})));
  });
});
