/**
 * Pass 2 split orchestrator — full-flow tests with mock provider.
 *
 * Covers PASS2-SPLIT-DESIGN.md §3 + §4 orchestration:
 *   - happy path: 2a → 2b → seam α proceed → 2c → composer → Pass2Result
 *   - 2a returns null (rate-limited) → re-queue (null result)
 *   - 2b per-item failure → that item goes to quarantine, others proceed
 *   - seam α failure (schema mismatch) → that item goes to quarantine
 *   - 2c returns null → re-queue
 *   - quarantine entries persist + have correct audit fields
 *
 * No real LLM. Mock provider returns scripted responses per call sequence.
 *
 * Run: node --import=tsx/esm --test src/middleware/reflect/__tests__/pass2-split-orchestrator.test.ts
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import type { LLMProvider } from "../../../engine/ai-provider.js";
import type { Pass1Item } from "../types.js";
import { runPass2Split } from "../pass2-split-orchestrator.js";
import { ensureQuarantineTable, getQuarantineEntries, summarizeQuarantine } from "../pass2-quarantine.js";

// ─────────────────────────────────────────────────────────────────────────────
// Minimal WorkspaceDB stub — only exposes `rawDb`, which is all the
// orchestrator needs from it. Using an in-memory better-sqlite3 keeps tests
// hermetic + fast.
// ─────────────────────────────────────────────────────────────────────────────

function makeDb(): { db: any; raw: Database.Database; close: () => void } {
  const raw = new Database(":memory:");
  ensureQuarantineTable(raw);
  return {
    db: { rawDb: raw },     // duck-typed WorkspaceDB
    raw,
    close: () => raw.close(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Mock provider — returns scripted responses per call sequence. Each call to
// generateStructured pops the next scripted response. Use this to simulate
// 2a / 2b / 2c happy + failure paths deterministically.
// ─────────────────────────────────────────────────────────────────────────────

interface MockResponse {
  result: any;
  rateLimited?: boolean;
  usage?: { input?: number; thinking?: number; output?: number };
}

function makeMockProvider(scripted: MockResponse[]): LLMProvider {
  let idx = 0;
  return {
    getName: () => "mock",
    isAvailable: () => true,
    generateStructured: async () => {
      if (idx >= scripted.length) {
        throw new Error(`mock provider exhausted: ${scripted.length} responses scripted, asking for ${idx + 1}`);
      }
      const r = scripted[idx++];
      return {
        result:      r.result,
        thinking:    "",
        rateLimited: r.rateLimited ?? false,
        model:       "mock-model",
        attempts:    [{ model: "mock-model", outcome: r.result ? "ok" : "failed" }],
        usage:       r.usage ?? { input: 100, thinking: 50, output: 80 },
      };
    },
  } as unknown as LLMProvider;
}

const pass1Items: Pass1Item[] = [
  { id: "i1", text: "We chose FastAPI",       source: "agent", excerpt: "We chose FastAPI",       provisional_type: "decision" },
  { id: "i2", text: "Cold start is 8 seconds", source: "agent", excerpt: "Cold start is 8 seconds", provisional_type: "fact" },
];

// ═════════════════════════════════════════════════════════════════════════════
// Happy path — full flow succeeds end-to-end
// ═════════════════════════════════════════════════════════════════════════════

describe("runPass2Split — happy path: 2a + 2b + 2c all succeed", () => {
  test("composes Pass2Result with grafted unique{} + wiring; no quarantine writes", async () => {
    const { db, raw, close } = makeDb();
    try {
      const provider = makeMockProvider([
        // 2a: classify both items
        {
          result: {
            skipped: [],
            classified: [
              { id: "i1", text: "We chose FastAPI",        type: "decision", project: "rate-limit", classification_reasoning: "TEST 4 fired" },
              { id: "i2", text: "Cold start is 8 seconds", type: "fact",     project: "rate-limit", classification_reasoning: "single value" },
            ],
          },
        },
        // 2b: fill i1
        { result: { id: "i1", unique: { choice: "FastAPI" } } },
        // 2b: fill i2
        { result: { id: "i2", unique: { value: "8s" } } },
        // 2c: wire both
        { result: { wiring: [
          { id: "i1", triggered_by: [], based_on: ["i2"], relations: [] },
          { id: "i2", triggered_by: [], based_on: [],     relations: [{ type: "supports", target: "i1", reasoning: "i2's evidence reinforces i1's decision" }] },
        ]}},
      ]);

      const r = await runPass2Split(provider, db, pass1Items, "PROJECT CTX", [], 1024, undefined, "test-session");

      assert.ok(r.result, "no result returned");
      assert.equal(r.rateLimited, false);
      assert.equal(r.result!.classified.length, 2);

      const i1 = r.result!.classified.find((c) => c.id === "i1")!;
      assert.equal(i1.type, "decision");
      assert.deepStrictEqual(i1.unique, { choice: "FastAPI" });
      assert.deepStrictEqual(i1.based_on_items, ["i2"]);

      const i2 = r.result!.classified.find((c) => c.id === "i2")!;
      assert.deepStrictEqual(i2.relations, [{ type: "supports", target: "i1", reasoning: "i2's evidence reinforces i1's decision" }]);

      // No quarantine writes on happy path
      const quarantine = summarizeQuarantine(raw);
      assert.equal(quarantine.total, 0);

      assert.ok(r.splitAudit, "splitAudit missing");
      assert.equal(r.splitAudit!.quarantine_writes, 0);
      assert.equal(r.splitAudit!.pass2c_wired, 2);
    } finally {
      close();
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Transient failure — 2a returns null (rate-limited)
// ═════════════════════════════════════════════════════════════════════════════

describe("runPass2Split — 2a transient failure: null result → re-queue", () => {
  test("2a rate-limited → returns null result + rateLimited=true; no quarantine writes", async () => {
    const { db, raw, close } = makeDb();
    try {
      const provider = makeMockProvider([
        { result: null, rateLimited: true },  // 2a fails
      ]);

      const r = await runPass2Split(provider, db, pass1Items, "", [], 1024, undefined, "test-session");

      assert.equal(r.result, null);
      assert.equal(r.rateLimited, true);
      // No quarantine should be touched if 2a never produced classified items
      assert.equal(summarizeQuarantine(raw).total, 0);
    } finally {
      close();
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Per-item 2b failure — that item goes to quarantine, others proceed
// ═════════════════════════════════════════════════════════════════════════════

describe("runPass2Split — 2b per-item failure: item quarantines, others proceed", () => {
  test("i1 fills cleanly; i2 rate-limited → i1 in classified, i2 in quarantine", async () => {
    const { db, raw, close } = makeDb();
    try {
      const provider = makeMockProvider([
        // 2a: both classified
        {
          result: {
            skipped: [],
            classified: [
              { id: "i1", text: "We chose FastAPI",        type: "decision", project: "p", classification_reasoning: "r1" },
              { id: "i2", text: "Cold start is 8 seconds", type: "fact",     project: "p", classification_reasoning: "r2" },
            ],
          },
        },
        // 2b for i1: success
        { result: { id: "i1", unique: { choice: "FastAPI" } } },
        // 2b for i2: rate-limited (null result)
        { result: null, rateLimited: true },
        // 2c: only i1 reaches it (proceed list = [i1])
        { result: { wiring: [
          { id: "i1", triggered_by: [], based_on: [], relations: [] },
        ]}},
      ]);

      const r = await runPass2Split(provider, db, pass1Items, "", [], 1024, undefined, "test-session");

      assert.ok(r.result);
      // Only i1 in composed classified
      assert.equal(r.result!.classified.length, 1);
      assert.equal(r.result!.classified[0].id, "i1");

      // i2 in quarantine
      const q = getQuarantineEntries(raw);
      assert.equal(q.length, 1);
      assert.ok(q[0].id.endsWith("_i2"));  // turn-scoped composite PK: `${batch_id}_${item.id}`
      assert.ok(q[0].pass2b_failure_reason.startsWith("pass2b_rate_limited"));
      assert.equal(q[0].pass2a_classified, "fact");
      assert.equal(q[0].pass1_text, "Cold start is 8 seconds");
      assert.equal(q[0].source_session_id, "test-session");
      assert.ok(q[0].batch_id.startsWith("batch_"));
      assert.equal(q[0].queued_for_enrichment, true);

      assert.equal(r.splitAudit!.pass2b_failed, 1);
      assert.equal(r.splitAudit!.quarantine_writes, 1);
    } finally {
      close();
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Seam α failure → RE-FILL RETRY (step 3.5). Two cases:
//   (a) re-fill still fails → quarantine with retry_attempted=true
//   (b) re-fill salvages → item proceeds
// ═════════════════════════════════════════════════════════════════════════════

describe("runPass2Split — seam α route_back → re-fill retry STILL fails → quarantine", () => {
  test("insight missing implication on both attempts → quarantine, retry_attempted=true, retry_exhausted reason", async () => {
    // Opt out of demote (env=0): this test verifies the route_back→retry→quarantine
    // path. With demote default-on, an observation-present insight would demote to
    // fact instead — that behavior is covered by the demote-edge describe block.
    const prevDemote = process.env.NODEDEX_SEAM_ALPHA_DEMOTE;
    process.env.NODEDEX_SEAM_ALPHA_DEMOTE = "0";
    const { db, raw, close } = makeDb();
    try {
      const provider = makeMockProvider([
        // 2a classifies as insight
        {
          result: {
            skipped: [],
            classified: [
              { id: "i1", text: "X correlates Y", type: "insight", project: "p", classification_reasoning: "TEST 2 not fired; insight" },
            ],
          },
        },
        // 2b first fill: observation + reason → sanitizer strips reason → {observation} → seam α route_back
        { result: { id: "i1", unique: { observation: "X correlates Y", reason: "data shows it" } } },
        // 2b RE-FILL retry: still only observation (genuinely no forward-looking implication) → fails again
        { result: { id: "i1", unique: { observation: "X correlates Y" } } },
        // 2c: never reached (nothing proceeds → short-circuits)
        { result: { wiring: [] } },
      ]);

      const r = await runPass2Split(provider, db, [{ id: "i1", text: "X correlates Y", source: "a", excerpt: "X correlates Y", provisional_type: "insight" }], "", [], 1024, undefined, "test-session");

      assert.ok(r.result, "result missing");
      assert.equal(r.result!.classified.length, 0, "failed item should not ship to live graph");

      const q = getQuarantineEntries(raw);
      assert.equal(q.length, 1);
      assert.ok(q[0].id.endsWith("_i1"));  // turn-scoped composite PK: `${batch_id}_${item.id}`
      assert.ok(q[0].pass2b_failure_reason.startsWith("seam_alpha_retry_exhausted"), `expected retry_exhausted, got: ${q[0].pass2b_failure_reason}`);
      assert.ok(q[0].pass2b_failure_reason.includes("implication"), "failure detail should mention implication");
      assert.equal(q[0].retry_attempted, true, "retry_attempted should be true after re-fill");
      assert.equal(q[0].retry_outcome, "same_type_quarantined");

      assert.equal(r.splitAudit!.seam_alpha_route_back, 1);
      assert.equal(r.splitAudit!.refill_attempted, 1);
      assert.equal(r.splitAudit!.refill_salvaged, 0);
      assert.equal(r.splitAudit!.quarantine_writes, 1);
    } finally {
      close();
      if (prevDemote === undefined) delete process.env.NODEDEX_SEAM_ALPHA_DEMOTE; else process.env.NODEDEX_SEAM_ALPHA_DEMOTE = prevDemote;
    }
  });
});

describe("runPass2Split — seam α route_back → re-fill retry SALVAGES → item proceeds", () => {
  test("insight under-filled first, then re-fill finds implication → proceeds to live graph", async () => {
    const { db, raw, close } = makeDb();
    try {
      const provider = makeMockProvider([
        // 2a classifies as insight
        {
          result: {
            skipped: [],
            classified: [
              { id: "i1", text: "every year by midsummer suggests a recurring problem needing proactive management", type: "insight", project: "p", classification_reasoning: "insight" },
            ],
          },
        },
        // 2b first fill: observation only (too conservative) → seam α route_back
        { result: { id: "i1", unique: { observation: "they said every year by midsummer" } } },
        // 2b RE-FILL retry: now finds the implication that was in the text → passes seam α
        { result: { id: "i1", unique: { observation: "they said every year by midsummer", implication: "recurring problem needing proactive management" } } },
        // 2c: wires the now-proceeding item
        { result: { wiring: [{ id: "i1", triggered_by: [], based_on: [], relations: [] }] } },
      ]);

      const r = await runPass2Split(provider, db, [{ id: "i1", text: "every year by midsummer suggests a recurring problem needing proactive management", source: "a", excerpt: "...", provisional_type: "insight" }], "", [], 1024, undefined, "test-session");

      assert.ok(r.result, "result missing");
      // SALVAGED — appears in the live graph with both fields
      assert.equal(r.result!.classified.length, 1);
      assert.equal(r.result!.classified[0].id, "i1");
      assert.equal(r.result!.classified[0].type, "insight");
      assert.deepStrictEqual(r.result!.classified[0].unique, {
        observation: "they said every year by midsummer",
        implication: "recurring problem needing proactive management",
      });

      // Nothing quarantined
      assert.equal(getQuarantineEntries(raw).length, 0);

      assert.equal(r.splitAudit!.seam_alpha_route_back, 1);
      assert.equal(r.splitAudit!.refill_attempted, 1);
      assert.equal(r.splitAudit!.refill_salvaged, 1);
      assert.equal(r.splitAudit!.seam_alpha_proceed, 1);  // final proceed incl. salvaged
      assert.equal(r.splitAudit!.quarantine_writes, 0);
    } finally {
      close();
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Transient failure — 2c returns null (rate-limited)
// ═════════════════════════════════════════════════════════════════════════════

describe("runPass2Split — 2c transient failure: null result → re-queue", () => {
  test("2c rate-limited after successful 2a+2b → null result; quarantine remains from any 2b/seam failures", async () => {
    const { db, raw, close } = makeDb();
    try {
      const provider = makeMockProvider([
        // 2a
        { result: { skipped: [], classified: [{ id: "i1", text: "X", type: "decision", project: "p", classification_reasoning: "r" }] } },
        // 2b
        { result: { id: "i1", unique: { choice: "X" } } },
        // 2c rate-limited
        { result: null, rateLimited: true },
      ]);

      const r = await runPass2Split(provider, db, [{ id: "i1", text: "X", source: "a", excerpt: "X", provisional_type: "decision" }], "", [], 1024, undefined, "test-session");

      assert.equal(r.result, null);
      assert.equal(r.rateLimited, true);
      // Successful items don't get quarantined just because 2c failed; the whole
      // pass re-runs from scratch via the checkpoint mechanism in pipeline.ts.
      assert.equal(summarizeQuarantine(raw).total, 0);
    } finally {
      close();
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Empty inputs — 2a returns no classified → degenerate-empty result, no LLM
// calls past 2a
// ═════════════════════════════════════════════════════════════════════════════

describe("runPass2Split — 2a returns no classified items: degenerate empty result", () => {
  test("empty classified[] → empty result, no 2b/2c calls, no quarantine writes", async () => {
    const { db, raw, close } = makeDb();
    try {
      const provider = makeMockProvider([
        { result: { skipped: [{ id: "i1", reason: "dup of label_x" }], classified: [] } },
        // No further scripted responses — if anything is called past 2a, mock throws.
      ]);

      const r = await runPass2Split(provider, db, pass1Items, "", [], 1024, undefined, "test-session");

      assert.ok(r.result);
      assert.equal(r.result!.classified.length, 0);
      assert.deepStrictEqual(r.result!.skipped, [{ id: "i1", reason: "dup of label_x" }]);
      assert.equal(summarizeQuarantine(raw).total, 0);
    } finally {
      close();
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Quarantine table is idempotent — orchestrator can be called multiple times
// per process without table conflicts
// ═════════════════════════════════════════════════════════════════════════════

describe("runPass2Split — quarantine table is idempotent across calls", () => {
  test("two calls with the SAME item id don't collide (cross-turn quarantine PK regression)", async () => {
    const { db, raw, close } = makeDb();
    try {
      const make2bFailScript = () => [
        { result: { skipped: [], classified: [
          { id: "i_x", text: "Y", type: "decision", project: "p", classification_reasoning: "r" }
        ]}},
        { result: null, rateLimited: true },  // 2b fails
        { result: { wiring: [] } },             // 2c (won't be reached — empty inputs short-circuit)
      ];

      // First call
      let provider = makeMockProvider(make2bFailScript() as MockResponse[]);
      const r1 = await runPass2Split(provider, db, [{ id: "i_x", text: "Y", source: "a", excerpt: "Y", provisional_type: "decision" }], "", [], 1024, undefined, "session-1");
      assert.ok(r1.result);
      let q = getQuarantineEntries(raw);
      assert.equal(q.length, 1);
      const batch1 = q[0].batch_id;

      // Second call — SAME item id "i_x" as the first. Pre-2026-05-26 this threw
      // UNIQUE-constraint: the quarantine PK was the bare per-turn item id, which
      // repeats across turns in one workspace (Pass 1 resets item_1..N each turn).
      // The composite `${batch_id}_${item.id}` PK makes cross-turn quarantine of
      // the same item-number safe. This is the regression guard for the deep-test
      // turn-3 crash (SqliteError: UNIQUE constraint failed: pass2_audit_quarantine.id).
      provider = makeMockProvider([
        { result: { skipped: [], classified: [
          { id: "i_x", text: "Z", type: "decision", project: "p", classification_reasoning: "r" }
        ]}},
        { result: null, rateLimited: true },
        { result: { wiring: [] } },
      ]);
      const r2 = await runPass2Split(provider, db, [{ id: "i_x", text: "Z", source: "a", excerpt: "Z", provisional_type: "decision" }], "", [], 1024, undefined, "session-2");
      assert.ok(r2.result);
      q = getQuarantineEntries(raw);
      assert.equal(q.length, 2, "both turns' quarantine entries coexist despite same item id");
      // Both entries originate from item i_x but carry distinct turn-scoped ids.
      assert.ok(q.every((e) => e.id.endsWith("_i_x")), "both ids carry the i_x suffix");
      assert.equal(new Set(q.map((e) => e.id)).size, 2, "the two ids are distinct (different batch prefixes)");
      const batch2 = q.map((e) => e.batch_id).find((b) => b !== batch1)!;

      // Distinct batches
      assert.notEqual(batch1, batch2, "expected different batch_ids for separate calls");
      // Session IDs preserved
      const sessions = q.map((e) => e.source_session_id).sort();
      assert.deepStrictEqual(sessions, ["session-1", "session-2"]);
    } finally {
      close();
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Audit data shape — splitAudit reports correct counts even on mixed runs
// ═════════════════════════════════════════════════════════════════════════════

describe("runPass2Split — splitAudit shape reflects all steps", () => {
  test("mixed run (2b success + 2b fail + seam α fail) populates audit correctly", async () => {
    // Opt out of demote (env=0) so i3's under-filled insight quarantines as this
    // test intends — it verifies the multi-path quarantine audit shape. (Default-
    // on demote behavior is covered by the demote-edge describe block.)
    const prevDemote = process.env.NODEDEX_SEAM_ALPHA_DEMOTE;
    process.env.NODEDEX_SEAM_ALPHA_DEMOTE = "0";
    const { db, raw, close } = makeDb();
    try {
      // 3 items: i1 succeeds, i2 has 2b rate-limited, i3 has insight schema mismatch
      const items: Pass1Item[] = [
        { id: "i1", text: "We use FastAPI",  source: "a", excerpt: "We use FastAPI",  provisional_type: "decision" },
        { id: "i2", text: "Cold start is 8s", source: "a", excerpt: "Cold start is 8s", provisional_type: "fact" },
        { id: "i3", text: "X means Y",        source: "a", excerpt: "X means Y",        provisional_type: "insight" },
      ];

      const provider = makeMockProvider([
        // 2a: all three classified
        { result: { skipped: [], classified: [
          { id: "i1", text: "We use FastAPI",  type: "decision", project: "p", classification_reasoning: "r" },
          { id: "i2", text: "Cold start is 8s", type: "fact",     project: "p", classification_reasoning: "r" },
          { id: "i3", text: "X means Y",        type: "insight",  project: "p", classification_reasoning: "r" },
        ]}},
        // 2b: i1 OK
        { result: { id: "i1", unique: { choice: "FastAPI" } } },
        // 2b: i2 rate-limited (hard failure → quarantine, NOT re-filled)
        { result: null, rateLimited: true },
        // 2b: i3 first fill missing implication → seam α route_back
        { result: { id: "i3", unique: { observation: "X means Y" } } },
        // 2b: i3 RE-FILL retry, still missing implication → quarantine (retry exhausted)
        { result: { id: "i3", unique: { observation: "X means Y" } } },
        // 2c: only i1 proceeds (i2 quarantined for 2b fail, i3 quarantined after re-fill)
        { result: { wiring: [{ id: "i1", triggered_by: [], based_on: [], relations: [] }] } },
      ]);

      const r = await runPass2Split(provider, db, items, "", [], 1024, undefined, "audit-test");

      assert.ok(r.result);
      assert.equal(r.result!.classified.length, 1);
      assert.equal(r.result!.classified[0].id, "i1");
      assert.equal(r.splitAudit!.pass2a_classified, 3);
      assert.equal(r.splitAudit!.pass2b_filled, 2);   // i1 + i3 first-fill (i3's fill failed seam α, not 2b itself)
      assert.equal(r.splitAudit!.pass2b_failed, 1);   // i2 (rate-limited)
      assert.equal(r.splitAudit!.seam_alpha_proceed, 1);  // only i1
      assert.equal(r.splitAudit!.seam_alpha_route_back, 1); // i3 entered re-fill
      assert.equal(r.splitAudit!.refill_attempted, 1);     // i3
      assert.equal(r.splitAudit!.refill_salvaged, 0);      // i3 still failed
      assert.equal(r.splitAudit!.quarantine_writes, 2);  // i2 (2b fail) + i3 (retry exhausted)
      assert.equal(r.splitAudit!.pass2c_wired, 1);

      // Confirm quarantine reflects correct failure reasons
      const q = getQuarantineEntries(raw);
      assert.equal(q.length, 2);
      const reasons = q.map((e) => e.pass2b_failure_reason);
      assert.ok(reasons.some((r) => r.startsWith("pass2b_")), "no pass2b_ failure reason (i2)");
      assert.ok(reasons.some((r) => r.startsWith("seam_alpha_retry_exhausted")), "no retry_exhausted reason (i3)");
      // i3 should show retry was attempted. NB: quarantine id is now turn-scoped
      // (`${batch_id}_${item.id}`) so we match the item-id suffix, not the bare id.
      const i3 = q.find((e) => e.id.endsWith("_i3"))!;
      assert.equal(i3.retry_attempted, true);
    } finally {
      close();
      if (prevDemote === undefined) delete process.env.NODEDEX_SEAM_ALPHA_DEMOTE; else process.env.NODEDEX_SEAM_ALPHA_DEMOTE = prevDemote;
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Multi-model routing (C, 2026-05-25) — env-var driven per-sub-pass model override
// ─────────────────────────────────────────────────────────────────────────────

describe("runPass2Split — multi-model routing via NODEDEX_PASS2{A,B,C}_MODEL env vars", () => {
  // Custom mock that captures the modelOverride seen on each call (in order:
  // 2a, then per-item 2b calls, then 2c). Lets us assert routing happened.
  function makeRoutingMockProvider(scripted: MockResponse[]): { provider: LLMProvider; seenOverrides: (string | undefined)[] } {
    let idx = 0;
    const seenOverrides: (string | undefined)[] = [];
    const provider = {
      getName: () => "mock",
      isAvailable: () => true,
      generateStructured: async (_p: string, _u: string, _s: object, options?: any) => {
        seenOverrides.push(options?.modelOverride);
        if (idx >= scripted.length) throw new Error("mock exhausted");
        const r = scripted[idx++];
        return {
          result: r.result,
          thinking: "",
          rateLimited: r.rateLimited ?? false,
          model: "mock-model",
          attempts: [{ model: "mock-model", outcome: r.result ? "ok" : "failed" }],
          usage: r.usage ?? { input: 100, thinking: 50, output: 80 },
        };
      },
      generate: async () => null,
      ping: async () => true,
    } as unknown as LLMProvider;
    return { provider, seenOverrides };
  }

  test("env vars route 2a→haiku, 2b→haiku, 2c→flash; provider sees correct modelOverride per call", async () => {
    const prevA = process.env.NODEDEX_PASS2A_MODEL;
    const prevB = process.env.NODEDEX_PASS2B_MODEL;
    const prevC = process.env.NODEDEX_PASS2C_MODEL;
    process.env.NODEDEX_PASS2A_MODEL = "anthropic/claude-haiku-4-5";
    process.env.NODEDEX_PASS2B_MODEL = "anthropic/claude-haiku-4-5";
    process.env.NODEDEX_PASS2C_MODEL = "google/gemini-2.5-flash";

    const { db, close } = makeDb();
    try {
      const items: Pass1Item[] = [{ id: "item_1", text: "We use FastAPI", source: "agent", excerpt: "FastAPI", provisional_type: "decision" }];
      const scripted: MockResponse[] = [
        { result: { skipped: [], classified: [{ id: "item_1", type: "decision", project: "p", classification_reasoning: "TEST 4" }] } },
        { result: { id: "item_1", unique: { choice: "FastAPI", reason: "decided" } } },
        { result: { wiring: [{ id: "item_1", triggered_by: [], based_on: [], relations: [] }] } },
      ];
      const { provider, seenOverrides } = makeRoutingMockProvider(scripted);

      const r = await runPass2Split(provider, db, items, "", [], 1024, undefined, "test-session");

      assert.ok(r.result, "routing run should succeed");
      assert.equal(seenOverrides.length, 3, `expected 3 LLM calls, saw ${seenOverrides.length}`);
      assert.equal(seenOverrides[0], "anthropic/claude-haiku-4-5", "2a should get NODEDEX_PASS2A_MODEL");
      assert.equal(seenOverrides[1], "anthropic/claude-haiku-4-5", "2b should get NODEDEX_PASS2B_MODEL");
      assert.equal(seenOverrides[2], "google/gemini-2.5-flash",    "2c should get NODEDEX_PASS2C_MODEL");
    } finally {
      close();
      if (prevA === undefined) delete process.env.NODEDEX_PASS2A_MODEL; else process.env.NODEDEX_PASS2A_MODEL = prevA;
      if (prevB === undefined) delete process.env.NODEDEX_PASS2B_MODEL; else process.env.NODEDEX_PASS2B_MODEL = prevB;
      if (prevC === undefined) delete process.env.NODEDEX_PASS2C_MODEL; else process.env.NODEDEX_PASS2C_MODEL = prevC;
    }
  });

  test("env vars absent → all sub-passes receive undefined modelOverride (backward compat — identical to today)", async () => {
    const prevA = process.env.NODEDEX_PASS2A_MODEL;
    const prevB = process.env.NODEDEX_PASS2B_MODEL;
    const prevC = process.env.NODEDEX_PASS2C_MODEL;
    delete process.env.NODEDEX_PASS2A_MODEL;
    delete process.env.NODEDEX_PASS2B_MODEL;
    delete process.env.NODEDEX_PASS2C_MODEL;

    const { db, close } = makeDb();
    try {
      const items: Pass1Item[] = [{ id: "item_1", text: "X", source: "agent", excerpt: "X", provisional_type: "fact" }];
      const scripted: MockResponse[] = [
        { result: { skipped: [], classified: [{ id: "item_1", type: "fact", project: "p", classification_reasoning: "r" }] } },
        { result: { id: "item_1", unique: { value: "X" } } },
        { result: { wiring: [{ id: "item_1", triggered_by: [], based_on: [], relations: [] }] } },
      ];
      const { provider, seenOverrides } = makeRoutingMockProvider(scripted);

      await runPass2Split(provider, db, items, "", [], 1024, undefined, "test-session");
      assert.equal(seenOverrides.length, 3);
      assert.ok(seenOverrides.every((o) => o === undefined),
        `backward-compat: no modelOverride should be threaded when env vars unset; saw ${JSON.stringify(seenOverrides)}`);
    } finally {
      close();
      if (prevA !== undefined) process.env.NODEDEX_PASS2A_MODEL = prevA;
      if (prevB !== undefined) process.env.NODEDEX_PASS2B_MODEL = prevB;
      if (prevC !== undefined) process.env.NODEDEX_PASS2C_MODEL = prevC;
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Demote-edge integration — debt-3 structural-small (2026-05-27)
// See memory: project-insight-fact-typing-gap. End-to-end opt-in behavior
// via NODEDEX_SEAM_ALPHA_DEMOTE=1: an insight whose implication is unfillable
// but whose observation IS present re-types to fact + routes to proceed,
// instead of quarantining. Default-off preserves the existing contract.
// ═════════════════════════════════════════════════════════════════════════════

describe("runPass2Split — demote-edge (NODEDEX_SEAM_ALPHA_DEMOTE)", () => {
  // Same fixture used by both tests — only the env var differs. Demonstrates
  // that the SAME pipeline run produces different outcomes under the flag.
  // 2a classifies as insight; 2b under-fills both attempts (only observation);
  // seam α retry exhausted. With env OFF → quarantine; with env ON → demote.
  const sharedItems: Pass1Item[] = [
    { id: "i1", text: "the original validation-is-cheap premise didn't hold for write-heavy workloads", source: "a", excerpt: "premise didn't hold", provisional_type: "insight" },
  ];
  const sharedScript: MockResponse[] = [
    // 2a: insight
    { result: { skipped: [], classified: [
      { id: "i1", type: "insight", project: "framework", classification_reasoning: "Q7b — describes a realization" },
    ]}},
    // 2b first: observation only (no implication in text)
    { result: { id: "i1", unique: { observation: "the original validation-is-cheap premise didn't hold" } } },
    // 2b retry: still no implication (genuinely absent — single observation)
    { result: { id: "i1", unique: { observation: "the original validation-is-cheap premise didn't hold" } } },
    // 2c: only consumed in the demote-on path (when i1 has proceeded as a fact)
    { result: { wiring: [{ id: "i1", triggered_by: [], based_on: [], relations: [] }] } },
  ];

  test("explicit opt-out (env=0) → quarantine (reversibility: NODEDEX_SEAM_ALPHA_DEMOTE=0 disables)", async () => {
    const prev = process.env.NODEDEX_SEAM_ALPHA_DEMOTE;
    process.env.NODEDEX_SEAM_ALPHA_DEMOTE = "0";
    const { db, raw, close } = makeDb();
    try {
      const provider = makeMockProvider(sharedScript);
      const r = await runPass2Split(provider, db, sharedItems, "", [], 1024, undefined, "test-session");

      assert.ok(r.result, "result missing");
      assert.equal(r.result!.classified.length, 0, "default-off: item should be quarantined, not in live graph");

      const q = getQuarantineEntries(raw);
      assert.equal(q.length, 1);
      assert.ok(q[0].pass2b_failure_reason.includes("seam_alpha_retry_exhausted"));

      assert.equal(r.splitAudit!.demote_enabled, false);
      assert.equal(r.splitAudit!.seam_alpha_demoted, 0);
      assert.deepStrictEqual(r.splitAudit!.demoted_breakdown, {});
      assert.equal(r.splitAudit!.quarantine_writes, 1);
    } finally {
      close();
      if (prev === undefined) delete process.env.NODEDEX_SEAM_ALPHA_DEMOTE; else process.env.NODEDEX_SEAM_ALPHA_DEMOTE = prev;
    }
  });

  test("default (env unset) → demote to fact + lands in live graph (default-on as of 2026-05-27)", async () => {
    const prev = process.env.NODEDEX_SEAM_ALPHA_DEMOTE;
    delete process.env.NODEDEX_SEAM_ALPHA_DEMOTE;  // new default = ON (!== "0")
    const { db, raw, close } = makeDb();
    try {
      const provider = makeMockProvider(sharedScript);
      const r = await runPass2Split(provider, db, sharedItems, "", [], 1024, undefined, "test-session");

      assert.ok(r.result, "result missing");
      // Item now in live graph — but as fact, not insight.
      assert.equal(r.result!.classified.length, 1, "env-on: demoted item should reach the live graph");
      const out = r.result!.classified[0];
      assert.equal(out.id, "i1");
      assert.equal(out.type, "fact", "demote should re-type insight → fact");
      assert.deepStrictEqual(out.unique, { value: "the original validation-is-cheap premise didn't hold" },
        "remapped unique: observation → value");
      assert.ok(out.classification_reasoning?.includes("DEMOTED insight→fact"),
        `classification_reasoning should record the demote provenance; got: ${out.classification_reasoning}`);
      assert.equal(out.source_type, "seam_demoted",
        "demoted block should carry source_type=seam_demoted (block-level provenance → blocks.source_type at save)");

      // No quarantine entries — the demote drained the case that would have been quarantined.
      const q = getQuarantineEntries(raw);
      assert.equal(q.length, 0, "env-on: nothing quarantined (the case was demoted instead)");

      assert.equal(r.splitAudit!.demote_enabled, true);
      assert.equal(r.splitAudit!.seam_alpha_demoted, 1);
      assert.deepStrictEqual(r.splitAudit!.demoted_breakdown, { "insight->fact": 1 });
      assert.equal(r.splitAudit!.seam_alpha_proceed, 1, "demoted item counts toward final proceed");
      assert.equal(r.splitAudit!.quarantine_writes, 0);
    } finally {
      close();
      if (prev === undefined) delete process.env.NODEDEX_SEAM_ALPHA_DEMOTE; else process.env.NODEDEX_SEAM_ALPHA_DEMOTE = prev;
    }
  });
});
