/**
 * DEBT 5 Slice 1 Sub-step 1.2 — Stage C (arc-entity-resolve) unit tests.
 *
 * Covers the contract that Sub-step 1.3 (Pass 3 consumer) will rely on:
 *   - skip paths (disabled, empty turns, provider unavailable) return safely
 *   - happy path: LLM clusters parsed into typed ArcEntityResolveResult
 *   - turn_id mapping: code fills from turns array (LLM only knows turn_number)
 *   - graceful degrade: LLM failure → undefined (Pass 3 falls back to per-turn)
 *   - telemetry: reflectTokenStats.pass_c_resolve increments per call
 *   - buildArcEntityResolveInput: scene cards format includes identity fields
 *
 * Run: node --import=tsx/esm --test src/middleware/reflect/__tests__/arc-entity-resolve.test.ts
 */
import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { LLMProvider } from "../../../engine/ai-provider.js";
import type { ConversationTurnRow } from "../../../store/database.js";
import type { Pass2Item, ArcEntityResolveResult } from "../types.js";
import { runArcEntityResolve, buildArcEntityResolveInput, applyArcEntityCanonicalNames } from "../arc-entity-resolve.js";
import { reflectTokenStats } from "../context.js";

// ─── Mock provider ────────────────────────────────────────────────────────────

interface MockResponse {
  result: any;
  rateLimited?: boolean;
  usage?: { input?: number; thinking?: number; output?: number };
}

function makeMockProvider(scripted: MockResponse[], opts: { available?: boolean } = {}): LLMProvider {
  let idx = 0;
  return {
    getName: () => "mock",
    isAvailable: () => opts.available ?? true,
    generateStructured: async () => {
      if (idx >= scripted.length) {
        throw new Error(`mock provider exhausted: asked for response ${idx + 1}, only ${scripted.length} scripted`);
      }
      const r = scripted[idx++];
      return {
        result:      r.result,
        thinking:    "",
        rateLimited: r.rateLimited ?? false,
        model:       "mock-model",
        attempts:    [{ model: "mock-model", outcome: r.result ? "ok" : "error" }],
        usage:       r.usage ?? { input: 500, thinking: 200, output: 300 },
      };
    },
  } as unknown as LLMProvider;
}

// ─── Test helpers ─────────────────────────────────────────────────────────────

function mkTurnRow(
  turn_number: number,
  scope_project_name: string,
  technologies: string[],
  itemIds: string[] = [`${turn_number}_1`, `${turn_number}_2`],
): ConversationTurnRow {
  const pass01 = {
    scene_card: {
      input_type: "CONVERSATIONAL",
      projects: [{ name: scope_project_name, scope: `scope of ${scope_project_name}` }],
      scope_project: { name: scope_project_name, scope: `scope of ${scope_project_name}` },
      technologies: technologies.map(t => ({ name: t, context: "in use" })),
      people: [{ name: "agent", role: "decision_maker", signal_type: "inferred" }],
    },
    items: itemIds.map(id => ({ id, text: `item ${id}`, provisional_type: "fact" })),
  };
  return {
    id:                   `ct_t${turn_number}_${Math.random().toString(36).slice(2, 8)}`,
    agent_id:             "test_agent",
    turn_number,
    turn_name:            `turn-${turn_number}`,
    transcript_json:      "{}",
    pass01_output_json:   JSON.stringify(pass01),
    pass01_completed_at:  new Date().toISOString(),
    status:               "pass01_done",
    created_at:           new Date().toISOString(),
    extracted_at:         null,
    pairing_range_id:     null,
  };
}

beforeEach(() => {
  reflectTokenStats.reset();
});

// ─── Skip paths ───────────────────────────────────────────────────────────────

describe("runArcEntityResolve — skip paths", () => {
  test("disabled=true → returns undefined, no LLM call", async () => {
    const provider = makeMockProvider([]);   // empty script — would throw if called
    const result = await runArcEntityResolve({
      provider,
      agent_id: "test_agent",
      turns: [mkTurnRow(1, "service", ["FastAPI"])],
      disabled: true,
    });
    assert.equal(result, undefined);
    assert.equal(reflectTokenStats.pass_c_resolve.calls, 0);
  });

  test("turns=[] → returns empty result (clusters + unresolved both empty), no LLM call", async () => {
    const provider = makeMockProvider([]);
    const result = await runArcEntityResolve({
      provider,
      agent_id: "test_agent",
      turns: [],
    });
    assert.ok(result);
    assert.equal(result!.clusters.length, 0);
    assert.deepEqual(result!.unresolved_mentions, []);
    assert.equal(reflectTokenStats.pass_c_resolve.calls, 0);
  });

  test("provider.isAvailable()=false → returns undefined, no LLM call", async () => {
    const provider = makeMockProvider([], { available: false });
    const result = await runArcEntityResolve({
      provider,
      agent_id: "test_agent",
      turns: [mkTurnRow(1, "service", ["FastAPI"])],
    });
    assert.equal(result, undefined);
    assert.equal(reflectTokenStats.pass_c_resolve.calls, 0);
  });
});

// ─── Happy path ───────────────────────────────────────────────────────────────

describe("runArcEntityResolve — happy path", () => {
  test("LLM returns one cluster with two anaphoric mentions → parsed correctly", async () => {
    const t1 = mkTurnRow(1, "json-api-service", ["FastAPI", "Pydantic"]);
    const t2 = mkTurnRow(2, "the-service", ["FastAPI", "Pydantic", "Litestar"]);

    const provider = makeMockProvider([
      {
        result: {
          clusters: [
            {
              canonical_name: "json-api-service",
              mentions: [
                { turn_number: 1, scope_project_name: "json-api-service", item_ids: ["item_T1_1_1", "item_T1_1_2"] },
                { turn_number: 2, scope_project_name: "the-service",      item_ids: ["item_T2_2_1"] },
              ],
              evidence: {
                shared_technologies: ["FastAPI", "Pydantic"],
                shared_entities:     [],
                shared_concepts:     ["python-web-framework"],
              },
              reasoning: "T1 names it 'json-api-service'; T2 uses anaphoric 'the-service' but shares FastAPI+Pydantic stack — same entity.",
            },
          ],
          unresolved_mentions: [],
          arc_resolve_reasoning: "Single-entity arc — both turns about same Python service.",
        },
      },
    ]);

    const result = await runArcEntityResolve({
      provider, agent_id: "test_agent", turns: [t1, t2],
    });

    assert.ok(result);
    assert.equal(result!.clusters.length, 1);
    const c = result!.clusters[0]!;
    assert.equal(c.canonical_name, "json-api-service");
    assert.equal(c.mentions.length, 2);
    assert.deepEqual(c.evidence.shared_technologies, ["FastAPI", "Pydantic"]);
    assert.match(c.reasoning, /anaphoric/);
    assert.equal(result!.arc_resolve_reasoning, "Single-entity arc — both turns about same Python service.");
  });

  test("turn_id is mapped from turns[] (NOT from LLM output)", async () => {
    // The LLM only knows turn_number; code fills turn_id from the turns array.
    const t1 = mkTurnRow(1, "auth", ["JWT"]);
    const t3 = mkTurnRow(3, "auth", ["JWT", "OAuth"]);   // gap at turn 2

    const provider = makeMockProvider([
      {
        result: {
          clusters: [
            {
              canonical_name: "auth-service",
              mentions: [
                { turn_number: 1, scope_project_name: "auth", item_ids: ["item_T1_1_1"] },
                { turn_number: 3, scope_project_name: "auth", item_ids: ["item_T3_3_1"] },
              ],
              evidence: { shared_technologies: ["JWT"], shared_entities: [], shared_concepts: [] },
              reasoning: "Same entity.",
            },
          ],
        },
      },
    ]);

    const result = await runArcEntityResolve({
      provider, agent_id: "test_agent", turns: [t1, t3],
    });

    assert.ok(result);
    const mentions = result!.clusters[0]!.mentions;
    // The turn_ids in the result should match the actual ConversationTurnRow ids
    assert.equal(mentions[0]!.turn_id, t1.id);
    assert.equal(mentions[1]!.turn_id, t3.id);
    // Original turn_number preserved
    assert.equal(mentions[0]!.turn_number, 1);
    assert.equal(mentions[1]!.turn_number, 3);
  });

  test("missing turn_number in result → falls back to unknown_turn_<n>", async () => {
    // Defensive: LLM emits a mention for a turn not in our input (hallucination).
    const t1 = mkTurnRow(1, "service", ["FastAPI"]);

    const provider = makeMockProvider([
      {
        result: {
          clusters: [
            {
              canonical_name: "service",
              mentions: [
                { turn_number: 1, scope_project_name: "service", item_ids: [] },
                { turn_number: 99, scope_project_name: "phantom-turn", item_ids: [] },   // hallucinated
              ],
              evidence: { shared_technologies: [], shared_entities: [], shared_concepts: [] },
              reasoning: "TEST",
            },
          ],
        },
      },
    ]);

    const result = await runArcEntityResolve({
      provider, agent_id: "test_agent", turns: [t1],
    });

    assert.ok(result);
    const mentions = result!.clusters[0]!.mentions;
    assert.equal(mentions[0]!.turn_id, t1.id);
    assert.equal(mentions[1]!.turn_id, "unknown_turn_99");   // defensive fallback
  });
});

// ─── Failure + degrade paths ─────────────────────────────────────────────────

describe("runArcEntityResolve — failure paths degrade gracefully", () => {
  test("LLM returns null result (failure) → undefined, telemetry still increments", async () => {
    const provider = makeMockProvider([
      { result: null },
    ]);
    const result = await runArcEntityResolve({
      provider, agent_id: "test_agent", turns: [mkTurnRow(1, "service", ["FastAPI"])],
    });
    assert.equal(result, undefined);
    // Telemetry — call counted even on failure (cost still incurred)
    assert.equal(reflectTokenStats.pass_c_resolve.calls, 1);
  });

  test("LLM rate-limited → undefined", async () => {
    const provider = makeMockProvider([
      { result: null, rateLimited: true },
    ]);
    const result = await runArcEntityResolve({
      provider, agent_id: "test_agent", turns: [mkTurnRow(1, "service", ["FastAPI"])],
    });
    assert.equal(result, undefined);
  });

  test("clusters with missing evidence sub-fields → defaulted to empty arrays", async () => {
    // Defensive parsing: LLM may emit partial evidence; we backfill with empty.
    const provider = makeMockProvider([
      {
        result: {
          clusters: [
            {
              canonical_name: "service",
              mentions: [{ turn_number: 1, scope_project_name: "service", item_ids: [] }],
              evidence: { shared_technologies: ["FastAPI"] },   // missing shared_entities/shared_concepts
              reasoning: "TEST",
            },
          ],
        },
      },
    ]);
    const result = await runArcEntityResolve({
      provider, agent_id: "test_agent", turns: [mkTurnRow(1, "service", ["FastAPI"])],
    });
    assert.ok(result);
    const ev = result!.clusters[0]!.evidence;
    assert.deepEqual(ev.shared_technologies, ["FastAPI"]);
    assert.deepEqual(ev.shared_entities, []);
    assert.deepEqual(ev.shared_concepts, []);
  });
});

// ─── Telemetry ────────────────────────────────────────────────────────────────

describe("runArcEntityResolve — telemetry", () => {
  test("pass_c_resolve slot increments by usage on success", async () => {
    const provider = makeMockProvider([
      {
        result: { clusters: [], unresolved_mentions: [] },
        usage:  { input: 1234, thinking: 567, output: 89 },
      },
    ]);
    await runArcEntityResolve({
      provider, agent_id: "test_agent", turns: [mkTurnRow(1, "service", ["FastAPI"])],
    });
    assert.equal(reflectTokenStats.pass_c_resolve.input,    1234);
    assert.equal(reflectTokenStats.pass_c_resolve.thinking, 567);
    assert.equal(reflectTokenStats.pass_c_resolve.output,   89);
    assert.equal(reflectTokenStats.pass_c_resolve.calls,    1);
  });
});

// ─── Input building (buildArcEntityResolveInput) ──────────────────────────────

describe("buildArcEntityResolveInput", () => {
  test("includes ARC header + per-turn sections with identity fields", () => {
    const turns = [
      mkTurnRow(1, "json-api-service", ["FastAPI", "Pydantic"], ["1"]),
      mkTurnRow(2, "the-service",      ["FastAPI", "Litestar"], ["1", "2"]),
    ];
    const input = buildArcEntityResolveInput({ agent_id: "test", turns });

    // Top-level header
    assert.match(input, /ARC ENTITY RESOLVE — agent_id=test, 2 turn\(s\)/);
    // Per-turn sections with key fields
    assert.match(input, /\[TURN 1/);
    assert.match(input, /Scope project:\s+json-api-service/);
    assert.match(input, /Technologies:\s+FastAPI, Pydantic/);
    assert.match(input, /\[TURN 2/);
    assert.match(input, /Scope project:\s+the-service/);
    assert.match(input, /Technologies:\s+FastAPI, Litestar/);
    // Item IDs use the arc-prefix convention
    assert.match(input, /item_T1_1/);
    assert.match(input, /item_T2_1, item_T2_2/);
  });

  test("tolerates malformed pass01_output_json (no scene_card) — emits '(none)' fallbacks", () => {
    const badTurn: ConversationTurnRow = {
      id:                   "ct_bad",
      agent_id:             "test",
      turn_number:          1,
      turn_name:            null,
      transcript_json:      "{}",
      pass01_output_json:   "not valid json",
      pass01_completed_at:  null,
      status:               "pass01_done",
      created_at:           new Date().toISOString(),
      extracted_at:         null,
      pairing_range_id:     null,
    };
    const input = buildArcEntityResolveInput({ agent_id: "test", turns: [badTurn] });
    assert.match(input, /Scope project:\s+\(no scope project\)/);
    assert.match(input, /Technologies:\s+\(none\)/);
  });
});

// ─── applyArcEntityCanonicalNames (Sub-step 1.3 consumer) ─────────────────────

function mkItem(id: string, project: string, type = "fact"): Pass2Item {
  return {
    id,
    text:                `item ${id}`,
    type,
    project,
    triggered_by_items:  [],
    based_on_items:      [],
  };
}

function mkResolution(clusters: Array<{ canonical: string; item_ids: string[] }>): ArcEntityResolveResult {
  return {
    clusters: clusters.map(c => ({
      canonical_name: c.canonical,
      mentions: [{
        turn_id:            "ct_test",
        turn_number:        1,
        scope_project_name: c.canonical,
        item_ids:           c.item_ids,
      }],
      evidence: { shared_technologies: [], shared_entities: [], shared_concepts: [] },
      reasoning: "test cluster",
    })),
  };
}

describe("applyArcEntityCanonicalNames — degrade paths", () => {
  test("resolution undefined → items returned unchanged, 0 renames", () => {
    const items = [mkItem("item_T1_1", "service"), mkItem("item_T2_1", "the-service")];
    const result = applyArcEntityCanonicalNames(items, undefined);
    assert.equal(result.renamed_count, 0);
    assert.equal(result.clusters_used, 0);
    assert.deepEqual(result.unmatched_item_ids, ["item_T1_1", "item_T2_1"]);
    assert.equal(result.items[0]!.project, "service");
    assert.equal(result.items[1]!.project, "the-service");
  });

  test("resolution with empty clusters → items unchanged", () => {
    const items = [mkItem("item_T1_1", "service")];
    const result = applyArcEntityCanonicalNames(items, { clusters: [] });
    assert.equal(result.renamed_count, 0);
    assert.deepEqual(result.unmatched_item_ids, ["item_T1_1"]);
  });
});

describe("applyArcEntityCanonicalNames — rename behavior", () => {
  test("single cluster covering all items → all items get canonical name", () => {
    const items = [
      mkItem("item_T1_1", "json-api-service"),
      mkItem("item_T2_1", "the-service"),
      mkItem("item_T3_1", "this-service"),
    ];
    const resolution = mkResolution([{
      canonical: "json-api-service",
      item_ids: ["item_T1_1", "item_T2_1", "item_T3_1"],
    }]);
    const result = applyArcEntityCanonicalNames(items, resolution);
    // T1 already had canonical name → NOT counted as rename (counted as cluster used)
    assert.equal(result.renamed_count, 2);
    assert.equal(result.clusters_used, 1);
    assert.equal(result.unmatched_item_ids.length, 0);
    for (const item of result.items) {
      assert.equal(item.project, "json-api-service");
    }
  });

  test("multiple distinct clusters → each item rerouted to its cluster's canonical", () => {
    const items = [
      mkItem("item_T1_1", "auth"),
      mkItem("item_T1_2", "billing"),
      mkItem("item_T2_1", "auth"),
    ];
    const resolution = mkResolution([
      { canonical: "auth-service",    item_ids: ["item_T1_1", "item_T2_1"] },
      { canonical: "billing-service", item_ids: ["item_T1_2"] },
    ]);
    const result = applyArcEntityCanonicalNames(items, resolution);
    assert.equal(result.clusters_used, 2);
    assert.equal(result.renamed_count, 3);  // all 3 items renamed
    assert.equal(result.items.find(i => i.id === "item_T1_1")!.project, "auth-service");
    assert.equal(result.items.find(i => i.id === "item_T1_2")!.project, "billing-service");
    assert.equal(result.items.find(i => i.id === "item_T2_1")!.project, "auth-service");
  });

  test("unmatched items keep their per-turn project (partial coverage)", () => {
    const items = [
      mkItem("item_T1_1", "json-api-service"),
      mkItem("item_T2_1", "the-service"),
      mkItem("item_T3_99", "leftover-name"),     // not in any cluster
    ];
    const resolution = mkResolution([{
      canonical: "json-api-service",
      item_ids: ["item_T1_1", "item_T2_1"],
    }]);
    const result = applyArcEntityCanonicalNames(items, resolution);
    assert.equal(result.renamed_count, 1);   // only T2 renamed
    assert.deepEqual(result.unmatched_item_ids, ["item_T3_99"]);
    assert.equal(result.items.find(i => i.id === "item_T3_99")!.project, "leftover-name");
  });

  test("returns NEW items array (input unchanged)", () => {
    const items = [mkItem("item_T1_1", "service")];
    const original = items[0]!.project;
    const resolution = mkResolution([{ canonical: "json-api-service", item_ids: ["item_T1_1"] }]);
    const result = applyArcEntityCanonicalNames(items, resolution);
    // Output array is a new array; input items array's items are unchanged
    assert.notEqual(result.items, items);
    assert.equal(items[0]!.project, original);
    assert.equal(result.items[0]!.project, "json-api-service");
  });

  test("preserves all non-project fields on each item", () => {
    const items: Pass2Item[] = [{
      id: "item_T1_1",
      text: "We chose FastAPI",
      type: "decision",
      project: "service",
      unique: { choice: "FastAPI" },
      triggered_by_items: ["item_T1_0"],
      based_on_items: [],
      excerpt: "from transcript",
      classification_reasoning: "TEST",
    }];
    const resolution = mkResolution([{ canonical: "json-api-service", item_ids: ["item_T1_1"] }]);
    const result = applyArcEntityCanonicalNames(items, resolution);
    const renamed = result.items[0]!;
    assert.equal(renamed.project, "json-api-service");
    assert.equal(renamed.text, "We chose FastAPI");
    assert.equal(renamed.type, "decision");
    assert.deepEqual(renamed.unique, { choice: "FastAPI" });
    assert.deepEqual(renamed.triggered_by_items, ["item_T1_0"]);
    assert.equal(renamed.excerpt, "from transcript");
    assert.equal(renamed.classification_reasoning, "TEST");
  });

  test("duplicate item_id across clusters → first cluster wins (defensive)", () => {
    const items = [mkItem("item_T1_1", "service")];
    const resolution: ArcEntityResolveResult = {
      clusters: [
        {
          canonical_name: "first-cluster",
          mentions: [{ turn_id: "ct_1", turn_number: 1, scope_project_name: "first", item_ids: ["item_T1_1"] }],
          evidence: { shared_technologies: [], shared_entities: [], shared_concepts: [] },
          reasoning: "first",
        },
        {
          canonical_name: "second-cluster",
          mentions: [{ turn_id: "ct_1", turn_number: 1, scope_project_name: "second", item_ids: ["item_T1_1"] }],
          evidence: { shared_technologies: [], shared_entities: [], shared_concepts: [] },
          reasoning: "second",
        },
      ],
    };
    const result = applyArcEntityCanonicalNames(items, resolution);
    assert.equal(result.items[0]!.project, "first-cluster");
  });
});
