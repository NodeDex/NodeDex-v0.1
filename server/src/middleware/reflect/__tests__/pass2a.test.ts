/**
 * Pass 2a — prompt + schema + sanitizer tests.
 *
 * Covers PASS2-SPLIT-DESIGN.md §2 Pass ownership for 2a:
 *   - OWNS: type, project, hierarchy, dedup, supersedes_ref, review flags,
 *           classification_reasoning, novel_type schema
 *   - DOES NOT: emit unique{}, triggered_by_items, based_on_items, relations
 *
 * What this file tests (without an LLM):
 *   - Prompt structure: required sections present, removed sections absent
 *   - Schema structure: required fields, forbidden fields absent
 *   - Sanitizer: strips forbidden fields from LLM output (defense in depth)
 *
 * What this file does NOT test (needs integration runs, not unit):
 *   - Actual LLM call quality (Week 2-3 fixture validation)
 *   - End-to-end flow through Seam α (pass2-seams.test.ts covers seam behavior;
 *     wiring is a Week 2 integration step)
 *
 * Run: node --import=tsx/esm --test src/middleware/reflect/__tests__/pass2a.test.ts
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  PASS2A_PROMPT,
  PASS2A_SCHEMA,
  sanitizePass2aItem,
  sanitizePass2aResult,
  callPass2aLLM,
} from "../pass2a.js";
import type { LLMProvider } from "../../../engine/ai-provider.js";
import type { Pass1Item } from "../types.js";

// ─────────────────────────────────────────────────────────────────────────────
// Prompt structure — sections that MUST be in the 2a prompt
// ─────────────────────────────────────────────────────────────────────────────

describe("PASS2A_PROMPT — required sections per §2 Pass 2a ownership", () => {
  test("includes Q0 DEDUP section", () => {
    assert.ok(PASS2A_PROMPT.includes("── Q0: DEDUP"), "Q0 DEDUP header missing");
    assert.ok(PASS2A_PROMPT.includes("Intra-batch duplicate"), "STEP I intra-batch missing");
    assert.ok(PASS2A_PROMPT.includes("PROJECT GRAPH"), "graph-dedup STEP A/B context missing");
  });

  test("includes Q1 TYPE section with all 5 structural tests", () => {
    assert.ok(PASS2A_PROMPT.includes("── Q1: TYPE"), "Q1 TYPE header missing");
    assert.ok(PASS2A_PROMPT.includes("TEST 1:"), "TEST 1 (metric) missing");
    assert.ok(PASS2A_PROMPT.includes("TEST 2:"), "TEST 2 (hypothesis) missing");
    assert.ok(PASS2A_PROMPT.includes("TEST 3:"), "TEST 3 (closing/adopting) missing");
    assert.ok(PASS2A_PROMPT.includes("TEST 4:"), "TEST 4 (decision/blueprint/question) missing");
    assert.ok(PASS2A_PROMPT.includes("TEST 5:"), "TEST 5 (graph_align) missing");
  });

  test("includes Q2 HIERARCHY section", () => {
    assert.ok(PASS2A_PROMPT.includes("── Q2: HIERARCHY"), "Q2 HIERARCHY header missing");
    assert.ok(PASS2A_PROMPT.includes("extends_item"), "extends_item discussion missing");
  });

  test("includes PROJECT ATTRIBUTION section", () => {
    assert.ok(PASS2A_PROMPT.includes("PROJECT ATTRIBUTION"), "PROJECT ATTRIBUTION header missing");
    assert.ok(PASS2A_PROMPT.includes("SCOPE PROJECT"), "scope-project fallback rule missing");
  });

  test("includes SUPERSEDES_REF section", () => {
    assert.ok(PASS2A_PROMPT.includes("SUPERSEDES_REF"), "SUPERSEDES_REF header missing");
    assert.ok(PASS2A_PROMPT.includes("resolved_ref"), "resolved_ref rule missing");
  });

  test("includes REVIEW FLAGS enum with all 7 reasons", () => {
    assert.ok(PASS2A_PROMPT.includes("REVIEW FLAGS"), "REVIEW FLAGS header missing");
    for (const flag of ["type_override", "weak_match", "no_evidence", "project_uncertain", "incomplete_context", "graph_align", "novel_type"]) {
      assert.ok(PASS2A_PROMPT.includes(flag), `${flag} flag missing from REVIEW FLAGS enum`);
    }
  });

  test("includes CLASSIFICATION REASONING required-output rule", () => {
    assert.ok(PASS2A_PROMPT.includes("CLASSIFICATION REASONING"), "CLASSIFICATION REASONING header missing");
    assert.ok(PASS2A_PROMPT.includes("required"), "required-output marker missing");
    assert.ok(PASS2A_PROMPT.includes("1-2 sentences"), "length guidance missing");
  });

  test("includes NOVEL TYPE rule", () => {
    assert.ok(PASS2A_PROMPT.includes("NOVEL TYPE"), "NOVEL TYPE rule missing");
    assert.ok(PASS2A_PROMPT.includes("schema{}"), "schema{} declaration requirement missing");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Prompt structure — sections that MUST NOT be in the 2a prompt (§2 anti-examples)
// ─────────────────────────────────────────────────────────────────────────────

describe("PASS2A_PROMPT — sections REMOVED per §2 (anti-example contract)", () => {
  test("does NOT include UNIQUE FIELDS section (that's Pass 2b)", () => {
    // The section header in monolith was "── UNIQUE FIELDS — populate AFTER type is final"
    assert.ok(!PASS2A_PROMPT.includes("UNIQUE FIELDS"), "UNIQUE FIELDS section leaked from monolith");
    // Specific monolith content that should NOT be here
    assert.ok(!PASS2A_PROMPT.includes("Use ONLY the assigned type's fields"), "unique-fields fill instruction leaked");
  });

  test("does NOT include CAUSAL WIRING section (that's Pass 2c)", () => {
    assert.ok(!PASS2A_PROMPT.includes("── CAUSAL WIRING"), "CAUSAL WIRING section leaked from monolith");
    assert.ok(!PASS2A_PROMPT.includes("Q3: TRIGGERED_BY"), "Q3 TRIGGERED_BY leaked");
    assert.ok(!PASS2A_PROMPT.includes("Q4: BASED_ON"), "Q4 BASED_ON leaked");
    assert.ok(!PASS2A_PROMPT.includes("Q5: SEMANTIC RELATIONS"), "Q5 SEMANTIC RELATIONS leaked");
  });

  test("does NOT include causal_wiring[] output reference", () => {
    assert.ok(!PASS2A_PROMPT.includes("causal_wiring[]"), "causal_wiring output reference leaked");
  });

  test("does NOT instruct the model to fill unique{}", () => {
    // Specific monolith phrases that imply unique-fill is part of this pass
    assert.ok(!PASS2A_PROMPT.includes("fill unique fields"), "fill-unique-fields instruction leaked");
    assert.ok(!PASS2A_PROMPT.includes("populate AFTER type is final"), "populate-after-type leaked");
  });

  test("instructs the model NOT to echo item text back (project-future-enhancements #6)", () => {
    // The prompt must tell the model to reference items by id only.
    // Without this, the model echoes verbatim text → output bloat → truncation
    // (refund 2026-05-25 truncated at 16384 tokens → 321s same-model retry).
    assert.ok(
      PASS2A_PROMPT.includes("do NOT echo") || PASS2A_PROMPT.includes("do not echo"),
      "no-echo-text instruction missing — model will keep echoing input text and bloating output",
    );
    assert.ok(
      PASS2A_PROMPT.includes("Reference each item by its id") ||
        PASS2A_PROMPT.includes("reference each item by its id"),
      "reference-by-id instruction missing",
    );
  });

  test("processing-order line explicitly excludes unique{} and causal_wiring", () => {
    assert.ok(
      PASS2A_PROMPT.includes("DO NOT output unique{}") || PASS2A_PROMPT.includes("DO NOT output unique"),
      "explicit DO-NOT-output-unique line missing — would let leakage be ambiguous",
    );
    assert.ok(
      PASS2A_PROMPT.includes("DO NOT output causal") || PASS2A_PROMPT.includes("handled by later passes"),
      "explicit later-passes-handle-causal note missing",
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// State convention + asymmetric cost preserved (charter-aligned)
// ─────────────────────────────────────────────────────────────────────────────

describe("PASS2A_PROMPT — charter-aligned framing preserved", () => {
  test("STATE CONVENTION block preserved (no domain knowledge as state)", () => {
    assert.ok(PASS2A_PROMPT.includes("STATE CONVENTION"), "STATE CONVENTION header missing");
    assert.ok(PASS2A_PROMPT.includes("Familiarity ≠ recorded"), "familiarity-not-recorded rule missing");
  });

  test("ASYMMETRIC COST preserved (false skip > false save)", () => {
    assert.ok(PASS2A_PROMPT.includes("ASYMMETRIC COST"), "ASYMMETRIC COST callout missing");
    assert.ok(PASS2A_PROMPT.includes("false skip"), "false-skip framing missing");
  });

  test("SKIP EVIDENCE falsifiability rule preserved", () => {
    assert.ok(PASS2A_PROMPT.includes("SKIP EVIDENCE"), "SKIP EVIDENCE header missing");
    assert.ok(PASS2A_PROMPT.includes("falsifiability"), "falsifiability framing missing");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Sanitizer — single-item
// ─────────────────────────────────────────────────────────────────────────────

describe("sanitizePass2aItem — strips forbidden fields, preserves required ones", () => {
  test("passes through a clean item with no changes", () => {
    const raw = {
      id: "item_1",
      text: "We use FastAPI.",
      type: "decision",
      project: "rate-limiting",
      classification_reasoning: "TEST 4 fired — outcome selected.",
    };
    const { item, stripped } = sanitizePass2aItem(raw);
    assert.deepStrictEqual(item, raw);
    assert.deepStrictEqual(stripped, []);
  });

  test("strips leaked `unique` field and reports it", () => {
    const raw = {
      id: "item_1", text: "X", type: "decision", project: "p", classification_reasoning: "r",
      unique: { choice: "X" },  // SHOULD NOT BE EMITTED BY 2a
    };
    const { item, stripped } = sanitizePass2aItem(raw);
    assert.ok(!("unique" in item), "unique field still present after sanitize");
    assert.deepStrictEqual(stripped, ["unique"]);
  });

  test("strips leaked causal wiring fields and reports them", () => {
    const raw = {
      id: "item_1", text: "X", type: "decision", project: "p", classification_reasoning: "r",
      triggered_by_items: ["item_2"],
      based_on_items: ["item_3"],
      relations: [{ type: "contradicts", target: "item_4" }],
    };
    const { item, stripped } = sanitizePass2aItem(raw);
    assert.ok(!("triggered_by_items" in item));
    assert.ok(!("based_on_items" in item));
    assert.ok(!("relations" in item));
    assert.deepStrictEqual(stripped.sort(), ["based_on_items", "relations", "triggered_by_items"]);
  });

  test("strips multiple forbidden fields at once + preserves all allowed fields", () => {
    const raw = {
      id: "item_1",
      text: "X",
      type: "insight",
      project: "p",
      extends_item: "item_0",
      supersedes_ref: "label_x",
      resolved_ref: "label_y",
      review_reason: "type_override",
      schema: { observation: "what was seen", implication: "what it means" },
      classification_reasoning: "TEST 5 graph_align fired.",
      unique: { observation: "X", implication: "Y" },          // forbidden
      triggered_by_items: ["item_2"],                          // forbidden
      based_on_items: [],                                      // forbidden (empty still strips — contract is about emission, not content)
      note: "extra notes",                                     // forbidden (deferred to 2c per §2)
    };
    const { item, stripped } = sanitizePass2aItem(raw);
    // Allowed survives
    assert.equal(item.id, "item_1");
    assert.equal(item.type, "insight");
    assert.equal(item.project, "p");
    assert.equal(item.extends_item, "item_0");
    assert.equal(item.supersedes_ref, "label_x");
    assert.equal(item.resolved_ref, "label_y");
    assert.equal(item.review_reason, "type_override");
    assert.deepStrictEqual(item.schema, { observation: "what was seen", implication: "what it means" });
    assert.equal(item.classification_reasoning, "TEST 5 graph_align fired.");
    // Forbidden gone
    assert.ok(!("unique" in item));
    assert.ok(!("triggered_by_items" in item));
    assert.ok(!("based_on_items" in item));
    assert.ok(!("note" in item));
    // Tracking is exact
    assert.deepStrictEqual(stripped.sort(), ["based_on_items", "note", "triggered_by_items", "unique"]);
  });

  test("does not modify the input object (pure function)", () => {
    const raw = { id: "x", text: "y", type: "z", project: "p", classification_reasoning: "r", unique: { a: "b" } };
    sanitizePass2aItem(raw);
    // Input still has `unique` — sanitizer returns a new object
    assert.ok("unique" in raw, "sanitizer mutated input (should be pure)");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Sanitizer — full result envelope
// ─────────────────────────────────────────────────────────────────────────────

describe("sanitizePass2aResult — full envelope, mixed clean+leaky items", () => {
  test("clean batch passes through unchanged with no strip events", () => {
    const raw = {
      skipped: [{ id: "s1", reason: "dup" }],
      classified: [
        { id: "i1", text: "a", type: "fact", project: "p", classification_reasoning: "r1" },
        { id: "i2", text: "b", type: "decision", project: "p", classification_reasoning: "r2" },
      ],
    };
    const { result, totalStrippedFields, perItemStripped } = sanitizePass2aResult(raw);
    assert.equal(result.skipped.length, 1);
    assert.equal(result.classified.length, 2);
    assert.equal(totalStrippedFields, 0);
    assert.equal(perItemStripped.length, 0);
  });

  test("mixed batch — only leaky items appear in perItemStripped", () => {
    const raw = {
      skipped: [],
      classified: [
        { id: "i1", text: "a", type: "fact",     project: "p", classification_reasoning: "r1" }, // clean
        { id: "i2", text: "b", type: "decision", project: "p", classification_reasoning: "r2", unique: { choice: "X" } },
        { id: "i3", text: "c", type: "insight",  project: "p", classification_reasoning: "r3", triggered_by_items: ["i2"], based_on_items: ["i1"] },
      ],
    };
    const { result, totalStrippedFields, perItemStripped } = sanitizePass2aResult(raw);
    assert.equal(result.classified.length, 3);
    assert.equal(totalStrippedFields, 3); // 1 (i2.unique) + 2 (i3.triggered+based)
    assert.equal(perItemStripped.length, 2);
    const i2 = perItemStripped.find((p) => p.id === "i2")!;
    const i3 = perItemStripped.find((p) => p.id === "i3")!;
    assert.deepStrictEqual(i2.stripped, ["unique"]);
    assert.deepStrictEqual(i3.stripped.sort(), ["based_on_items", "triggered_by_items"]);
  });

  test("empty input → empty output, no crashes", () => {
    const { result, totalStrippedFields, perItemStripped } = sanitizePass2aResult({});
    assert.deepStrictEqual(result.skipped, []);
    assert.deepStrictEqual(result.classified, []);
    assert.equal(totalStrippedFields, 0);
    assert.equal(perItemStripped.length, 0);
  });

  test("skipped[] entries are coerced to {id, reason} shape (defensive)", () => {
    const raw = {
      skipped: [
        { id: 5, reason: "dup" } as any,           // numeric id → coerced to string
        { id: "x", reason: null } as any,          // null reason → empty string
      ],
      classified: [],
    };
    const { result } = sanitizePass2aResult(raw);
    assert.equal(result.skipped[0].id, "5");
    assert.equal(typeof result.skipped[0].id, "string");
    assert.equal(result.skipped[1].reason, "");
    assert.equal(typeof result.skipped[1].reason, "string");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PASS2A_SCHEMA — contract lock for the #6 optimization (text not LLM-emitted)
// ─────────────────────────────────────────────────────────────────────────────

describe("PASS2A_SCHEMA — text is not a required output field (#6)", () => {
  test("classified item schema does NOT require `text`", () => {
    const classifiedItemSchema = (PASS2A_SCHEMA.properties.classified.items as any);
    assert.ok(Array.isArray(classifiedItemSchema.required), "required[] missing");
    assert.ok(
      !classifiedItemSchema.required.includes("text"),
      "text should not be a required output field — it's re-joined from Pass 1 input in callPass2aLLM",
    );
  });

  test("classified item schema does NOT declare a `text` property", () => {
    const itemProps = (PASS2A_SCHEMA.properties.classified.items as any).properties;
    assert.ok(
      !("text" in itemProps),
      "text should not be in the classified item properties — declaring it invites the model to echo it",
    );
  });

  test("required output fields remain (id, type, project, classification_reasoning)", () => {
    const required = (PASS2A_SCHEMA.properties.classified.items as any).required as string[];
    for (const k of ["id", "type", "project", "classification_reasoning"]) {
      assert.ok(required.includes(k), `${k} should remain a required output field`);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// callPass2aLLM — text re-join from Pass 1 (#6 watch-out: Pass2Item.text survives)
// ─────────────────────────────────────────────────────────────────────────────

describe("callPass2aLLM — re-joins text by id from pass1Items", () => {
  test("classified items get text from pass1Items even when provider omits it", async () => {
    const pass1Items: Pass1Item[] = [
      { id: "item_1", text: "We will use FastAPI for the API layer.", source: "agent", excerpt: "FastAPI", provisional_type: "decision" },
      { id: "item_2", text: "Postgres is the datastore.",             source: "agent", excerpt: "Postgres", provisional_type: "fact" },
    ];
    const mockProvider = {
      getName: () => "mock",
      generateStructured: async () => ({
        result: {
          skipped: [],
          // NOTE: classified items deliberately OMIT `text` — this is what 2a
          // produces now that PASS2A_SCHEMA doesn't require it.
          classified: [
            { id: "item_1", type: "decision", project: "p", classification_reasoning: "TEST 4 fired" },
            { id: "item_2", type: "fact",     project: "p", classification_reasoning: "no test fired; pass1 holds" },
          ],
        },
        thinking: "",
        rateLimited: false,
        model: "mock-model",
        attempts: [{ model: "mock-model", outcome: "ok" }],
        usage: { input: 10, thinking: 0, output: 5 },
      }),
    } as unknown as LLMProvider;

    const r = await callPass2aLLM(mockProvider, pass1Items, "", [], 1024, undefined);
    assert.ok(r.result, "result should not be null");
    const i1 = r.result!.classified.find((c) => c.id === "item_1")!;
    const i2 = r.result!.classified.find((c) => c.id === "item_2")!;
    assert.equal(i1.text, "We will use FastAPI for the API layer.");
    assert.equal(i2.text, "Postgres is the datastore.");
  });

  test("classified id with no matching pass1 id → text falls back to empty string (no crash, no undefined)", async () => {
    const pass1Items: Pass1Item[] = [
      { id: "item_1", text: "real", source: "agent", excerpt: "e", provisional_type: "fact" },
    ];
    const mockProvider = {
      getName: () => "mock",
      generateStructured: async () => ({
        result: {
          skipped: [],
          classified: [
            // Hostile case: classified id ghost_99 has no pass1 match
            { id: "ghost_99", type: "fact", project: "p", classification_reasoning: "anomaly" },
          ],
        },
        thinking: "",
        rateLimited: false,
        model: "mock-model",
        attempts: [],
      }),
    } as unknown as LLMProvider;

    const r = await callPass2aLLM(mockProvider, pass1Items, "", [], 1024, undefined);
    assert.ok(r.result);
    const ghost = r.result!.classified.find((c) => c.id === "ghost_99")!;
    assert.equal(ghost.text, "", "ghost id should default to empty string, not undefined");
    assert.equal(typeof ghost.text, "string", "text must be a string for downstream Pass2Item type safety");
  });

  test("text re-join overrides any leaked LLM-emitted text (source of truth = Pass 1)", async () => {
    const pass1Items: Pass1Item[] = [
      { id: "item_1", text: "GROUND TRUTH from pass 1", source: "agent", excerpt: "e", provisional_type: "fact" },
    ];
    const mockProvider = {
      getName: () => "mock",
      generateStructured: async () => ({
        result: {
          skipped: [],
          classified: [
            // Defiant model: emits text anyway (paraphrased!). Re-join must win.
            { id: "item_1", text: "PARAPHRASED text the model invented", type: "fact", project: "p", classification_reasoning: "r" },
          ],
        },
        thinking: "",
        rateLimited: false,
        model: "mock-model",
        attempts: [],
      }),
    } as unknown as LLMProvider;

    const r = await callPass2aLLM(mockProvider, pass1Items, "", [], 1024, undefined);
    assert.ok(r.result);
    const i1 = r.result!.classified.find((c) => c.id === "item_1")!;
    assert.equal(
      i1.text,
      "GROUND TRUTH from pass 1",
      "re-join must override LLM-emitted text — Pass 1 is the source of truth",
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// callPass2aLLM — modelOverride threading (C, multi-model routing 2026-05-25)
// ─────────────────────────────────────────────────────────────────────────────

describe("callPass2aLLM — passes modelOverride through to provider when set", () => {
  test("modelOverride present → forwarded to generateStructured options", async () => {
    const seen: { options?: any } = {};
    const mockProvider = {
      getName: () => "mock",
      generateStructured: async (_p: string, _u: string, _s: object, options?: any) => {
        seen.options = options;
        return {
          result: { skipped: [], classified: [{ id: "item_1", type: "fact", project: "p", classification_reasoning: "r" }] },
          thinking: "",
          rateLimited: false,
          model: "anthropic/claude-haiku-4-5",
          attempts: [{ model: "anthropic/claude-haiku-4-5", outcome: "ok" }],
        };
      },
    } as unknown as LLMProvider;
    const pass1: Pass1Item[] = [{ id: "item_1", text: "t", source: "agent", excerpt: "e", provisional_type: "fact" }];

    await callPass2aLLM(mockProvider, pass1, "", [], 1024, undefined, "anthropic/claude-haiku-4-5");
    assert.equal(seen.options?.modelOverride, "anthropic/claude-haiku-4-5",
      "modelOverride must be threaded to the provider call");
  });

  test("modelOverride undefined → option omitted (provider uses default)", async () => {
    const seen: { options?: any } = {};
    const mockProvider = {
      getName: () => "mock",
      generateStructured: async (_p: string, _u: string, _s: object, options?: any) => {
        seen.options = options;
        return {
          result: { skipped: [], classified: [] },
          thinking: "", rateLimited: false, model: "default-model", attempts: [],
        };
      },
    } as unknown as LLMProvider;

    await callPass2aLLM(mockProvider, [], "", [], 1024, undefined /* no modelOverride */);
    assert.ok(!("modelOverride" in (seen.options ?? {})),
      "modelOverride must NOT be present when caller didn't pass it — provider falls back to default");
  });
});
