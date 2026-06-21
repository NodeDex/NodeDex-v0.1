import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { decideFromResolution, buildStageDInput, resolveArcEntitiesForItems } from "../stage-d-resolve-graph.js";
import type { RetrievalCandidate } from "../retrieve-graph-slice.js";
import type { Pass2Item } from "../types.js";

function cand(opts: Partial<RetrievalCandidate> & { label?: string; is_catch_all?: boolean } = {}): RetrievalCandidate {
  return {
    block: { id: "blk_x", label: opts.label ?? "proj_fact_thing", type: "fact", essence: "", content: "{}", concepts: [] } as any,
    identity_score: opts.identity_score ?? 1.0,
    scope: { value: "proj", is_catch_all: opts.is_catch_all ?? false },
    semantic_score: 0,
    rank_score: opts.rank_score ?? 1.0,
    why: "",
  };
}

describe("Stage D — DECIDE rule (the 3-way outcome)", () => {
  it("different identity → new_entity (regardless of scope)", () => {
    assert.equal(decideFromResolution(false, "same", cand()).decision, "new_entity");
    assert.equal(decideFromResolution(false, "different", cand()).decision, "new_entity");
    assert.equal(decideFromResolution(false, "owner_unknown", cand()).decision, "new_entity");
  });

  it("same identity + same scope → attach_existing (the no-duplicate win)", () => {
    assert.equal(decideFromResolution(true, "same", cand()).decision, "attach_existing");
  });

  it("same identity + different scope → new_entity (cross-customer safety)", () => {
    // Same kind under a genuinely different owner: do NOT fuse.
    assert.equal(decideFromResolution(true, "different", cand()).decision, "new_entity");
  });

  it("same identity + owner_unknown → flag_for_review (don't guess the owner)", () => {
    const r = decideFromResolution(true, "owner_unknown", cand());
    assert.equal(r.decision, "flag_for_review");
    assert.ok(r.flag_reason && r.flag_reason.length > 0);
  });

  it("catch-all candidate produces a catch-all-specific flag reason (spike pair-5)", () => {
    const r = decideFromResolution(true, "owner_unknown", cand({ is_catch_all: true, label: "unspecified-project_fact_x" }));
    assert.equal(r.decision, "flag_for_review");
    assert.match(r.flag_reason ?? "", /catch-all/i);
  });

  it("non-catch-all owner_unknown gives the generic undetermined-owner reason", () => {
    const r = decideFromResolution(true, "owner_unknown", cand({ is_catch_all: false }));
    assert.equal(r.decision, "flag_for_review");
    assert.match(r.flag_reason ?? "", /undetermined/i);
  });
});

describe("Stage D — input builder (falsifiability: shows identity value + scope)", () => {
  it("surfaces the entity's unique{} value, the candidate's value, and tags catch-all scope", () => {
    const entity = { canonical_name: "auth-service", primary_values: ["JWT chosen for auth"], concepts: ["auth", "jwt"] };
    const input = buildStageDInput(entity, cand({ is_catch_all: true, label: "unspecified-project_fact_x" }));
    assert.match(input, /auth-service/);
    assert.match(input, /JWT chosen for auth/);
    assert.match(input, /CATCH-ALL/);          // catch-all candidate is explicitly tagged for the LLM
    assert.match(input, /identity, then scope/); // the two-axis instruction reaches the model
  });
});

describe("Stage D — batch resolver (Part 4 entry, cost-gated)", () => {
  // A fake DB whose getAllBlocks/keywordSearch/conceptSearch return nothing →
  // every item retrieves zero candidates → new_entity for free, no LLM, no entries.
  const emptyDb: any = {
    getAllBlocks: () => [],
    keywordSearch: () => [],
    conceptSearch: () => new Map(),
    getBlock: () => null,
  };
  // A provider that MUST NOT be called (codeOnly / no-candidate paths never hit it).
  const forbiddenProvider: any = {
    isAvailable: () => true,
    getName: () => "forbidden",
    generateStructured: () => { throw new Error("LLM must not be called when there are no candidates"); },
  };

  function item(id: string, type: string, unique: Record<string, string>, project = "proj"): Pass2Item {
    return { id, text: "t", type, project, unique, triggered_by_items: [], based_on_items: [] } as Pass2Item;
  }

  it("omits new_entity outcomes (only attach/flag become entries) and never calls LLM with no candidates", async () => {
    const items = [
      item("i1", "fact", { value: "something with no graph match" }),
      item("i2", "decision", { choice: "another unmatched choice" }),
    ];
    const res = await resolveArcEntitiesForItems({ db: emptyDb, provider: forbiddenProvider, items });
    assert.equal(res.items_resolved, 2);
    assert.equal(res.entries.length, 0);  // all new_entity → no flags
    assert.equal(res.llm_calls, 0);       // cost gate: no candidates → no spend
    assert.equal(res.attached, 0);
    assert.equal(res.flagged, 0);
  });

  it("skips items with no identity value (no unique{} primary) without resolving", async () => {
    const items = [item("i3", "fact", {})]; // empty unique → extractPrimaryValue returns ""
    const res = await resolveArcEntitiesForItems({ db: emptyDb, provider: forbiddenProvider, items });
    assert.equal(res.items_resolved, 1);
    assert.equal(res.entries.length, 0);
    assert.equal(res.llm_calls, 0);
  });

  it("flag_for_review CARRIES the matched block id+label (so Touchpoint B can write block_id_b → actionable flag)", async () => {
    // A graph with one catch-all-scoped orphan whose unique{} value matches the item.
    // identity=1.0 but scope is catch-all → code-exact gate skipped → LLM path →
    // same_entity + owner_unknown → flag_for_review. The fix: the entry must carry the
    // matched candidate so the flag isn't a dangling single-block row.
    const dbWithOrphan: any = {
      getAllBlocks: () => [],
      keywordSearch: () => [{
        id: "blk_orphan",
        label: "unspecified-project_decision_redis",   // scope segment = explicit catch-all
        type: "decision",
        essence: "orphan redis decision, owner never recorded",
        content: JSON.stringify({ unique: { choice: "redis for sessions" } }),
        status: "active",
        concepts: [],
      }],
      conceptSearch: () => new Map(),
      getBlock: () => null,
    };
    const ownerUnknownProvider: any = {
      isAvailable: () => true,
      getName: () => "mock",
      generateStructured: async () => ({
        result: {
          same_entity: true, identity_evidence: "identical choice value",
          same_scope: "owner_unknown", scope_evidence: "candidate scope is a catch-all bucket",
          verdict: "match_existing", reasoning: "same redis decision; orphan owner unknown",
        },
        model: "mock", rateLimited: false, usage: { input: 1, thinking: 0, output: 1 },
      }),
    };
    const items = [item("i1", "decision", { choice: "redis for sessions" }, "customer-c")];
    const res = await resolveArcEntitiesForItems({ db: dbWithOrphan, provider: ownerUnknownProvider, items });

    assert.equal(res.flagged, 1);
    assert.equal(res.entries.length, 1);
    const e = res.entries[0];
    assert.equal(e.decision, "flag_for_review");
    assert.equal(e.matched_block_id, "blk_orphan");                              // the fix
    assert.equal(e.matched_block_label, "unspecified-project_decision_redis");   // the fix
  });
});
