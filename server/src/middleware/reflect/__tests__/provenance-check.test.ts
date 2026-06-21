// Gap ④(a) provenance integrity check.
// Run: node --import=tsx/esm --test src/middleware/reflect/__tests__/provenance-check.test.ts
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { WorkspaceDB } from "../../../store/database.js";
import { excerptMatchStatus, getBlockTranscript, runProvenanceCheck, flagBlockExcerptInline } from "../provenance-check.js";

const TEST_DB = path.resolve("/tmp/provenance_test.db");
let db: WorkspaceDB;

before(async () => {
  for (const s of ["", "-wal", "-shm"]) { try { if (fs.existsSync(TEST_DB + s)) fs.unlinkSync(TEST_DB + s); } catch { /* ignore */ } }
  db = new WorkspaceDB(TEST_DB);
  await db.init();
});
after(() => {
  try { (db as any)["db"]?.close(); } catch { /* ignore */ }
  for (const s of ["", "-wal", "-shm"]) { try { if (fs.existsSync(TEST_DB + s)) fs.unlinkSync(TEST_DB + s); } catch { /* ignore */ } }
});

describe("provenance-check — pure matcher", () => {
  test("verbatim excerpt (modulo case/punct) → exact", () => {
    const r = excerptMatchStatus("use AbortController to cancel", "The agent said: use abortcontroller, to cancel the fetch.");
    assert.equal(r.status, "exact");
    assert.equal(r.coverage, 1);
  });
  test("high token-overlap paraphrase → fuzzy", () => {
    const r = excerptMatchStatus("cancel the inflight fetch request", "we should cancel the inflight request while fetching", 0.6);
    assert.equal(r.status, "fuzzy");
    assert.ok(r.coverage > 0.6 && r.coverage < 1);
  });
  test("absent words → missing", () => {
    const r = excerptMatchStatus("deploy postgres kubernetes cluster eastregion", "the cat sat quietly on the warm mat");
    assert.equal(r.status, "missing");
  });
});

describe("runProvenanceCheck (DB-backed)", () => {
  let goodId = "";
  let badId = "";
  let fuzzyId = "";

  before(() => {
    const agent = "prov-test";
    db.createConversationTurn({
      agent_id: agent, turn_number: 1,
      transcript_json: JSON.stringify({ user_message: "what fixes the crash?", agent_response: "AGENT: use AbortController to cancel the in-flight fetch on unmount." }),
    });
    const range = db.createConversationTurnRange({ agent_id: agent, start_turn_number: 1, end_turn_number: 1, extraction_type: "arc" });

    const good = db.createBlock({ label: "prov_decision_good", type: "decision", essence: "cancel fetch", content: { unique: { choice: "abort" } }, ttl: "permanent", status: "active", source_excerpt: "use AbortController to cancel the in-flight fetch" });
    db.recordBlockExtraction(good.id, range.id);
    goodId = good.id;

    const bad = db.createBlock({ label: "prov_decision_bad", type: "decision", essence: "deploy", content: { unique: { choice: "k8s" } }, ttl: "permanent", status: "active", source_excerpt: "deploy the postgres database to a kubernetes cluster in useast region" });
    db.recordBlockExtraction(bad.id, range.id);
    badId = bad.id;

    // paraphrase: high token overlap, not a verbatim substring → fuzzy (soft)
    const fuzzy = db.createBlock({ label: "prov_decision_fuzzy", type: "decision", essence: "cancel via abort", content: { unique: { choice: "abort2" } }, ttl: "permanent", status: "active", source_excerpt: "cancel the in-flight fetch using AbortController on unmount" });
    db.recordBlockExtraction(fuzzy.id, range.id);
    fuzzyId = fuzzy.id;

    // has an excerpt but NO block_extractions row → not verifiable
    db.createBlock({ label: "prov_fact_nolink", type: "fact", essence: "orphan", content: {}, ttl: "permanent", status: "active", source_excerpt: "an excerpt with no provenance link whatsoever here today" });
  });

  test("classifies exact / missing / no_link and flags only the fabricated one", () => {
    const r = runProvenanceCheck(db, { write: true });
    assert.ok(r.checked >= 3, `checked ${r.checked}`);
    assert.ok(r.exact >= 1, "verbatim block counted exact");
    assert.ok(r.missing >= 1, "fabricated block counted missing");
    assert.ok(r.no_link >= 1, "unlinked block counted no_link");
    assert.ok(r.flagged >= 1, "fabricated block flagged");

    const raw = (db as any).db;
    const badFlags = raw.prepare("SELECT * FROM pipeline_flags WHERE flag_type='provenance_mismatch' AND block_id_a=?").all(badId);
    assert.equal(badFlags.length, 1, "fabricated block has exactly one provenance_mismatch flag");
    assert.equal(badFlags[0].origin_writer, "provenance_check");
    const crit = JSON.parse(badFlags[0].criteria_json);
    assert.equal(crit.severity, "hard");

    const goodFlags = raw.prepare("SELECT * FROM pipeline_flags WHERE block_id_a=?").all(goodId);
    assert.equal(goodFlags.length, 0, "verbatim-excerpt block is NOT flagged");
  });

  test("getBlockTranscript stitches the source turn text", () => {
    const t = getBlockTranscript(db, goodId);
    assert.ok(t && t.text.includes("AbortController"), "transcript text recovered for the block's range");
  });

  test("flagFuzzy:false drops the soft (fuzzy) flag but keeps hard (missing) — the LLM-cost lever", () => {
    const raw = (db as any).db;
    raw.prepare("DELETE FROM pipeline_flags").run(); // clean slate for an exact count
    const r = runProvenanceCheck(db, { write: true, flagFuzzy: false });
    assert.ok(r.fuzzy >= 1, "fuzzy still detected + counted");
    const fuzzyFlags = raw.prepare("SELECT * FROM pipeline_flags WHERE block_id_a=?").all(fuzzyId);
    assert.equal(fuzzyFlags.length, 0, "fuzzy NOT flagged when flagFuzzy:false (never reaches the LLM)");
    const badFlags = raw.prepare("SELECT * FROM pipeline_flags WHERE block_id_a=?").all(badId);
    assert.equal(badFlags.length, 1, "missing STILL flagged (the reviewer's real work)");
  });

  test("write:false is a dry-run (no new flags)", () => {
    const raw = (db as any).db;
    const before = raw.prepare("SELECT count(*) c FROM pipeline_flags").get().c;
    runProvenanceCheck(db, { write: false });
    const after = raw.prepare("SELECT count(*) c FROM pipeline_flags").get().c;
    assert.equal(after, before, "dry-run wrote no flags");
  });
});

// The INLINE path (called at extraction, transcript in hand — the cheap/immediate
// version that does NOT need block_extractions). Only HARD ('missing') flags;
// reworded-but-same-meaning is fine ("same meaning ok, totally wrong flag").
describe("flagBlockExcerptInline — inline at-extraction provenance check", () => {
  const raw = () => (db as any).db;
  const mk = (label: string) => db.createBlock({ label, type: "decision", essence: "x", content: {}, ttl: "permanent", status: "active" });
  const flagCount = (id: string) => raw().prepare("SELECT count(*) c FROM pipeline_flags WHERE block_id_a=?").get(id).c as number;

  test("excerpt NOT in transcript (missing) → 'missing' + writes a HARD provenance_mismatch flag", () => {
    const blk = mk("inline_bad");
    const status = flagBlockExcerptInline(raw(), blk.id, "deploy postgres kubernetes cluster eastregion", "the agent discussed caching strategies and retry budgets today");
    assert.equal(status, "missing");
    const f = raw().prepare("SELECT * FROM pipeline_flags WHERE flag_type='provenance_mismatch' AND block_id_a=?").all(blk.id);
    assert.equal(f.length, 1, "fabricated inline excerpt is flagged");
    const crit = JSON.parse(f[0].criteria_json);
    assert.equal(crit.severity, "hard");
    assert.equal(crit.origin, "inline");
  });

  test("excerpt verbatim in transcript (exact) → no flag", () => {
    const blk = mk("inline_good");
    const status = flagBlockExcerptInline(raw(), blk.id, "use AbortController to cancel the in-flight fetch", "AGENT: use AbortController to cancel the in-flight fetch on unmount");
    assert.equal(status, "exact");
    assert.equal(flagCount(blk.id), 0);
  });

  test("reworded paraphrase (high overlap) → NOT flagged (same meaning is okay)", () => {
    const blk = mk("inline_fuzzy");
    // all excerpt tokens present, but not a contiguous substring → fuzzy, not missing
    flagBlockExcerptInline(raw(), blk.id, "cancel the inflight fetch on unmount", "on unmount we should cancel the inflight fetch request");
    assert.equal(flagCount(blk.id), 0, "a paraphrase that's not 'missing' is not flagged");
  });

  test("empty / null excerpt → 'no_link', no flag, never throws", () => {
    const blk = mk("inline_empty");
    assert.equal(flagBlockExcerptInline(raw(), blk.id, "", "any transcript"), "no_link");
    assert.equal(flagBlockExcerptInline(raw(), blk.id, null, "any transcript"), "no_link");
    assert.equal(flagCount(blk.id), 0);
  });
});
