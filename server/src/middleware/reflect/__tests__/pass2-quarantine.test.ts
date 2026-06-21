/**
 * Pass 2 audit quarantine — table + write + read + summarize tests.
 *
 * Covers the §3 contract:
 *   - entry shape round-trips through SQLite (JSON fields preserved)
 *   - filters AND-combine correctly
 *   - failure_reason filter is substring match (debt-3 composition signal)
 *   - summarize gives total + by_failure_reason + by_session
 *   - enrichment_attempts append-only
 *   - promotion marker doesn't delete the audit row
 *
 * Run: node --import=tsx/esm --test src/middleware/reflect/__tests__/pass2-quarantine.test.ts
 */
import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import {
  ensureQuarantineTable,
  writeQuarantineEntry,
  getQuarantineEntry,
  getQuarantineEntries,
  summarizeQuarantine,
  recordEnrichmentAttempt,
  markQuarantinePromoted,
  type QuarantineEntry,
} from "../pass2-quarantine.js";

const TEST_DB = path.resolve("/tmp/quarantine_test.db");

let db: Database.Database;

// Fresh DB for the file (one schema), wiped table per-test for isolation.
before(() => {
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  if (fs.existsSync(TEST_DB + "-wal")) fs.unlinkSync(TEST_DB + "-wal");
  if (fs.existsSync(TEST_DB + "-shm")) fs.unlinkSync(TEST_DB + "-shm");
  db = new Database(TEST_DB);
  ensureQuarantineTable(db);
});

after(() => {
  try { db.close(); } catch { /* ignore */ }
  try { if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB); } catch { /* ignore */ }
  try { if (fs.existsSync(TEST_DB + "-wal")) fs.unlinkSync(TEST_DB + "-wal"); } catch { /* ignore */ }
  try { if (fs.existsSync(TEST_DB + "-shm")) fs.unlinkSync(TEST_DB + "-shm"); } catch { /* ignore */ }
});

beforeEach(() => {
  db.exec(`DELETE FROM pass2_audit_quarantine`);
});

// ─────────────────────────────────────────────────────────────────────────────
// Helper: build a minimal valid entry — overrides are spread last.
// ─────────────────────────────────────────────────────────────────────────────

function mkEntry(overrides: Partial<QuarantineEntry> = {}): QuarantineEntry {
  return {
    id:                       "item_1",
    pass1_text:               "Insight: X correlates with Y",
    pass1_provisional_type:   "insight",
    pass1_reasoning:          "Q-tree decided insight via TEST 5",
    pass1_excerpt:            "X correlates with Y in our data",
    pass2a_classified:        "insight",
    pass2a_reasoning:         "Speaker's stance is realization",
    pass2a_alternatives:      ["fact", "hypothesis"],
    pass2b_attempted:         { observation: "X correlates with Y", reason: "Statistical signal in logs" },
    pass2b_failure_reason:    "type=insight missing=[implication] extras=[reason]",
    retry_attempted:          true,
    retry_2a_classified:      "insight",  // 2a confirmed same type on retry → quarantined
    retry_outcome:            "same_type_quarantined",
    batch_id:                 "batch_2026-05-25T12-00-00",
    source_session_id:        "session_abc",
    quarantined_at:           "2026-05-25T12:00:01.000Z",
    siblings_promoted:        ["block_1", "block_2"],
    queued_for_enrichment:    true,
    enrichment_attempts:      [],
    promotion_blocked_until:  null,
    agent_clarification:      null,
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// ensureQuarantineTable — idempotent, indexes created
// ─────────────────────────────────────────────────────────────────────────────

describe("ensureQuarantineTable — schema management", () => {
  test("called twice is a no-op (idempotent)", () => {
    ensureQuarantineTable(db);
    ensureQuarantineTable(db);
    // If the second call wasn't IF NOT EXISTS, we'd throw here.
    assert.ok(true);
  });

  test("indexes are created for batch_id, session, queued, quarantined_at", () => {
    const indexes = db.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='pass2_audit_quarantine'`).all() as Array<{ name: string }>;
    const names = indexes.map((i) => i.name);
    assert.ok(names.includes("idx_quarantine_batch"));
    assert.ok(names.includes("idx_quarantine_session"));
    assert.ok(names.includes("idx_quarantine_queued"));
    assert.ok(names.includes("idx_quarantine_quarantined"));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Round-trip — write then read, all fields preserved including JSON arrays/objects
// ─────────────────────────────────────────────────────────────────────────────

describe("writeQuarantineEntry + getQuarantineEntry — round-trip", () => {
  test("round-trips a fully populated entry", () => {
    const entry = mkEntry();
    writeQuarantineEntry(db, entry);
    const got = getQuarantineEntry(db, "item_1");
    assert.deepStrictEqual(got, entry);
  });

  test("preserves JSON array fields exactly (pass2a_alternatives, siblings_promoted, enrichment_attempts)", () => {
    const entry = mkEntry({
      pass2a_alternatives: ["fact", "hypothesis", "insight"],
      siblings_promoted:   ["block_a", "block_b"],
      enrichment_attempts: [
        { when: "2026-05-26T10:00:00.000Z", pass_used: "pipeline_self_enrich", outcome: "still_quarantined" },
      ],
    });
    writeQuarantineEntry(db, entry);
    const got = getQuarantineEntry(db, entry.id)!;
    assert.deepStrictEqual(got.pass2a_alternatives, ["fact", "hypothesis", "insight"]);
    assert.deepStrictEqual(got.siblings_promoted, ["block_a", "block_b"]);
    assert.equal(got.enrichment_attempts.length, 1);
    assert.equal(got.enrichment_attempts[0].outcome, "still_quarantined");
  });

  test("preserves JSON object field pass2b_attempted exactly", () => {
    const entry = mkEntry({
      pass2b_attempted: { observation: "Pattern P", reason: "Because of Q", nested: { extra: "stuff" } } as any,
    });
    writeQuarantineEntry(db, entry);
    const got = getQuarantineEntry(db, entry.id)!;
    assert.deepStrictEqual(got.pass2b_attempted, entry.pass2b_attempted);
  });

  test("agent_clarification null round-trips as null (not missing-key, not stringified-null)", () => {
    const entry = mkEntry({ agent_clarification: null });
    writeQuarantineEntry(db, entry);
    const got = getQuarantineEntry(db, entry.id)!;
    assert.strictEqual(got.agent_clarification, null);
  });

  test("agent_clarification populated round-trips with all sub-fields", () => {
    const entry = mkEntry({
      agent_clarification: {
        resolved_at:   "2026-06-01T09:00:00.000Z",
        agent_verdict: "This was actually a hypothesis, not insight",
        agent_notes:   "The phrasing 'might be' should have routed to hypothesis",
      },
    });
    writeQuarantineEntry(db, entry);
    const got = getQuarantineEntry(db, entry.id)!;
    assert.deepStrictEqual(got.agent_clarification, entry.agent_clarification);
  });

  test("boolean fields (retry_attempted, queued_for_enrichment) round-trip as booleans not numbers", () => {
    writeQuarantineEntry(db, mkEntry({ retry_attempted: true,  queued_for_enrichment: false }));
    const got = getQuarantineEntry(db, "item_1")!;
    assert.strictEqual(got.retry_attempted, true);
    assert.strictEqual(got.queued_for_enrichment, false);
    assert.strictEqual(typeof got.retry_attempted, "boolean");
    assert.strictEqual(typeof got.queued_for_enrichment, "boolean");
  });

  test("getQuarantineEntry returns null for unknown id (not undefined, not throw)", () => {
    const got = getQuarantineEntry(db, "nonexistent_id");
    assert.strictEqual(got, null);
  });

  test("writing same id twice throws (callers must not re-quarantine)", () => {
    writeQuarantineEntry(db, mkEntry());
    assert.throws(() => writeQuarantineEntry(db, mkEntry()), /UNIQUE constraint/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Filters — AND-combine, substring match for failure_reason
// ─────────────────────────────────────────────────────────────────────────────

describe("getQuarantineEntries — filters", () => {
  beforeEach(() => {
    // Populate 4 entries with varied attributes.
    writeQuarantineEntry(db, mkEntry({
      id: "item_a", batch_id: "batch_1", source_session_id: "sess_x",
      pass2b_failure_reason: "type=insight missing=[implication]",
      queued_for_enrichment: true, quarantined_at: "2026-05-25T12:00:00.000Z",
    }));
    writeQuarantineEntry(db, mkEntry({
      id: "item_b", batch_id: "batch_1", source_session_id: "sess_x",
      pass2b_failure_reason: "type=insight missing=[implication]",
      queued_for_enrichment: false, quarantined_at: "2026-05-25T13:00:00.000Z",
    }));
    writeQuarantineEntry(db, mkEntry({
      id: "item_c", batch_id: "batch_2", source_session_id: "sess_y",
      pass2b_failure_reason: "type=fact extras=[reason]",
      queued_for_enrichment: true, quarantined_at: "2026-05-25T14:00:00.000Z",
    }));
    writeQuarantineEntry(db, mkEntry({
      id: "item_d", batch_id: "batch_2", source_session_id: "sess_y",
      pass2b_failure_reason: "type=decision missing=[choice]",
      queued_for_enrichment: true, quarantined_at: "2026-05-25T15:00:00.000Z",
    }));
  });

  test("no filters → all entries, sorted by quarantined_at DESC", () => {
    const all = getQuarantineEntries(db);
    assert.equal(all.length, 4);
    assert.deepStrictEqual(all.map((e) => e.id), ["item_d", "item_c", "item_b", "item_a"]);
  });

  test("batch_id filter narrows to one batch", () => {
    const b1 = getQuarantineEntries(db, { batch_id: "batch_1" });
    assert.equal(b1.length, 2);
    assert.ok(b1.every((e) => e.batch_id === "batch_1"));
  });

  test("source_session_id filter narrows to one session", () => {
    const sx = getQuarantineEntries(db, { source_session_id: "sess_x" });
    assert.equal(sx.length, 2);
    assert.ok(sx.every((e) => e.source_session_id === "sess_x"));
  });

  test("queued_for_enrichment=true filters out manually-cleared entries", () => {
    const queued = getQuarantineEntries(db, { queued_for_enrichment: true });
    assert.equal(queued.length, 3);
    assert.ok(queued.every((e) => e.queued_for_enrichment === true));
  });

  test("failure_reason is SUBSTRING match (debt-3 composition signal)", () => {
    // Both item_a and item_b have "missing=[implication]" in their reason
    const missing = getQuarantineEntries(db, { failure_reason: "missing=[implication]" });
    assert.equal(missing.length, 2);
    assert.deepStrictEqual(missing.map((e) => e.id).sort(), ["item_a", "item_b"]);
  });

  test("filters AND-combine — batch_id + queued_for_enrichment", () => {
    const r = getQuarantineEntries(db, { batch_id: "batch_1", queued_for_enrichment: true });
    assert.equal(r.length, 1);
    assert.equal(r[0].id, "item_a");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Summarize — tier-monitoring primitive
// ─────────────────────────────────────────────────────────────────────────────

describe("summarizeQuarantine — primitive for tier monitoring (§3)", () => {
  test("empty quarantine → total 0, empty groupings", () => {
    const s = summarizeQuarantine(db);
    assert.equal(s.total, 0);
    assert.deepStrictEqual(s.by_failure_reason, []);
    assert.deepStrictEqual(s.by_session, []);
  });

  test("groups by failure_reason and by_session, sorted by count DESC", () => {
    writeQuarantineEntry(db, mkEntry({ id: "i1", pass2b_failure_reason: "type=insight missing=[implication]", source_session_id: "s1" }));
    writeQuarantineEntry(db, mkEntry({ id: "i2", pass2b_failure_reason: "type=insight missing=[implication]", source_session_id: "s1" }));
    writeQuarantineEntry(db, mkEntry({ id: "i3", pass2b_failure_reason: "type=insight missing=[implication]", source_session_id: "s2" }));
    writeQuarantineEntry(db, mkEntry({ id: "i4", pass2b_failure_reason: "type=fact extras=[reason]",          source_session_id: "s2" }));

    const s = summarizeQuarantine(db);
    assert.equal(s.total, 4);

    // Composition signal — the "missing=[implication]" pattern is concentrated (3 of 4 = 75%, debt-3 territory)
    assert.equal(s.by_failure_reason[0].reason, "type=insight missing=[implication]");
    assert.equal(s.by_failure_reason[0].count, 3);
    assert.equal(s.by_failure_reason[1].count, 1);

    // by_session also sorted DESC
    assert.equal(s.by_session[0].count, 2);
    assert.equal(s.by_session[1].count, 2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Enrichment attempts — append-only, doesn't disturb other fields
// ─────────────────────────────────────────────────────────────────────────────

describe("recordEnrichmentAttempt — append-only, preserves audit trail", () => {
  test("appends to enrichment_attempts, leaves other fields unchanged", () => {
    const initial = mkEntry({ id: "item_x" });
    writeQuarantineEntry(db, initial);

    const attempt1 = { when: "2026-06-01T09:00:00.000Z", pass_used: "self_enrich_v1", outcome: "still_quarantined" };
    recordEnrichmentAttempt(db, "item_x", attempt1);

    const after1 = getQuarantineEntry(db, "item_x")!;
    assert.equal(after1.enrichment_attempts.length, 1);
    assert.deepStrictEqual(after1.enrichment_attempts[0], attempt1);
    // All other fields preserved
    assert.equal(after1.pass1_text, initial.pass1_text);
    assert.deepStrictEqual(after1.pass2a_alternatives, initial.pass2a_alternatives);
    assert.deepStrictEqual(after1.pass2b_attempted, initial.pass2b_attempted);

    const attempt2 = { when: "2026-06-02T09:00:00.000Z", pass_used: "self_enrich_v2", outcome: "still_quarantined" };
    recordEnrichmentAttempt(db, "item_x", attempt2);
    const after2 = getQuarantineEntry(db, "item_x")!;
    assert.equal(after2.enrichment_attempts.length, 2);
    assert.deepStrictEqual(after2.enrichment_attempts[1], attempt2);
  });

  test("optional newQueuedFlag flips queued_for_enrichment", () => {
    writeQuarantineEntry(db, mkEntry({ id: "item_y", queued_for_enrichment: true }));
    recordEnrichmentAttempt(db, "item_y",
      { when: "2026-06-01T09:00:00.000Z", pass_used: "manual", outcome: "abandoned" },
      { newQueuedFlag: false },
    );
    const after = getQuarantineEntry(db, "item_y")!;
    assert.strictEqual(after.queued_for_enrichment, false);
  });

  test("optional newBlockedUntil sets the exponential-backoff timestamp", () => {
    writeQuarantineEntry(db, mkEntry({ id: "item_z" }));
    recordEnrichmentAttempt(db, "item_z",
      { when: "2026-06-01T09:00:00.000Z", pass_used: "self_enrich", outcome: "rate_limited" },
      { newBlockedUntil: "2026-06-08T00:00:00.000Z" },
    );
    const after = getQuarantineEntry(db, "item_z")!;
    assert.equal(after.promotion_blocked_until, "2026-06-08T00:00:00.000Z");
  });

  test("throws if entry id doesn't exist (catches caller bugs)", () => {
    assert.throws(
      () => recordEnrichmentAttempt(db, "nonexistent", { when: "x", pass_used: "y", outcome: "z" }),
      /no quarantine entry nonexistent/,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// markQuarantinePromoted — records the promotion, does NOT delete the row
// ─────────────────────────────────────────────────────────────────────────────

describe("markQuarantinePromoted — audit trail stays after promotion", () => {
  test("marks not-queued + records the promoted block id in enrichment_attempts", () => {
    writeQuarantineEntry(db, mkEntry({ id: "item_promote" }));
    markQuarantinePromoted(db, "item_promote", "block_xyz");

    const after = getQuarantineEntry(db, "item_promote");
    assert.notStrictEqual(after, null, "row must still exist — promotion does not delete");
    assert.strictEqual(after!.queued_for_enrichment, false);
    assert.equal(after!.enrichment_attempts.length, 1);
    assert.ok(after!.enrichment_attempts[0].outcome.includes("block_xyz"));
  });

  test("multiple promotions appear as multiple enrichment_attempts entries (rare but possible if logic re-promotes)", () => {
    writeQuarantineEntry(db, mkEntry({ id: "item_multi" }));
    markQuarantinePromoted(db, "item_multi", "block_first");
    markQuarantinePromoted(db, "item_multi", "block_second");
    const after = getQuarantineEntry(db, "item_multi")!;
    assert.equal(after.enrichment_attempts.length, 2);
  });
});
