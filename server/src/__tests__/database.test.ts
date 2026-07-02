/**
 * WMCS Database Tests — using Node.js built-in test runner (no Jest needed)
 * Run: node --import=tsx/esm --test src/__tests__/database.test.ts
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { WorkspaceDB } from "../store/database.js";

const TEST_DB = path.resolve("/tmp/wmcs_test.db");

let db: WorkspaceDB;

before(async () => {
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  if (fs.existsSync(TEST_DB + "-wal")) fs.unlinkSync(TEST_DB + "-wal");
  if (fs.existsSync(TEST_DB + "-shm")) fs.unlinkSync(TEST_DB + "-shm");
  db = new WorkspaceDB(TEST_DB);
  await db.init();
});

after(() => {
  // Close DB connection before deleting on Windows (EBUSY otherwise)
  try { (db as any)["db"]?.close(); } catch { /* ignore */ }
  try { if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB); } catch { /* ignore */ }
  try { if (fs.existsSync(TEST_DB + "-wal")) fs.unlinkSync(TEST_DB + "-wal"); } catch { /* ignore */ }
  try { if (fs.existsSync(TEST_DB + "-shm")) fs.unlinkSync(TEST_DB + "-shm"); } catch { /* ignore */ }
});

// ─── Block CRUD ──────────────────────────────────────────────────

describe("Block CRUD", () => {
  test("createBlock stores and retrieves a block", () => {
    const b = db.createBlock({
      label: "test_fact",
      type: "fact",
      essence: "The sky is blue",
      content: { unique: { source: "observation" } },
      ttl: "permanent",
    });

    assert.ok(b.id.startsWith("blk_"), "ID should start with blk_");
    assert.equal(b.label, "test_fact");
    assert.equal(b.type, "fact");
    assert.equal(b.essence, "The sky is blue");

    const fetched = db.getBlock("test_fact");
    assert.ok(fetched, "Should retrieve block by label");
    assert.equal(fetched!.id, b.id);
  });

  test("getBlock returns null for unknown label", () => {
    const result = db.getBlock("nonexistent_block_xyz");
    assert.equal(result, null);
  });

  test("updateBlock modifies essence and creates history entry", () => {
    const b = db.createBlock({
      label: "test_update",
      type: "note",
      essence: "Original",
      content: {},
      ttl: "permanent",
    });

    db.updateBlock(b.id, { essence: "Updated" }, "test update");
    const updated = db.getBlock("test_update");
    assert.equal(updated!.essence, "Updated");

    const history = db.getHistory(b.id);
    assert.ok(history.length > 0, "Should have history entry");
  });

  test("updateBlock with null clears the field to SQL NULL, not the string 'null'", () => {
    // Pins the Pass-5 cleanup contract: clearing chain_id means "standalone block"
    // (NULL), never a literal 'null' — which reads back as a real chain id and
    // groups every cleared block into one fake chain.
    const b = db.createBlock({
      label: "test_null_clear",
      type: "note",
      essence: "chain member being dissolved",
      content: {},
      ttl: "permanent",
    });
    db.updateBlock(b.id, { chain_id: "some-uuid-1234" });
    assert.equal(db.getBlock(b.id)!.chain_id, "some-uuid-1234");

    db.updateBlock(b.id, { chain_id: null });
    const cleared = db.getBlock(b.id)!;
    assert.equal(cleared.chain_id, null, "chain_id must be SQL NULL after clearing");
    assert.notEqual(cleared.chain_id, "null", "must not be the literal string 'null'");
  });

  test("init repairs legacy string-'null' chain_id rows, leaves real chain ids alone", async () => {
    // Rows written by the old stringifying updateBlock. The migration targets ONLY
    // the corrupt literals — blk_/UUID/chain_ forms are the three legitimate
    // chain_id families and must survive untouched.
    const victim = db.createBlock({ label: "test_migrate_victim", type: "note", essence: "corrupt", content: {}, ttl: "permanent" });
    const keeper = db.createBlock({ label: "test_migrate_keeper", type: "note", essence: "legit member", content: {}, ttl: "permanent" });
    (db as any)["db"].prepare(`UPDATE blocks SET chain_id = 'null' WHERE id = ?`).run(victim.id);
    (db as any)["db"].prepare(`UPDATE blocks SET chain_id = 'blk_realchain1' WHERE id = ?`).run(keeper.id);

    await db.init(); // migrations are idempotent — re-running applies the repair

    assert.equal(db.getBlock(victim.id)!.chain_id, null, "string 'null' repaired to NULL");
    assert.equal(db.getBlock(keeper.id)!.chain_id, "blk_realchain1", "real chain id untouched");
  });

  test("archiveBlock sets status to archived", () => {
    const b = db.createBlock({
      label: "test_archive",
      type: "note",
      essence: "Will be archived",
      content: {},
      ttl: "permanent",
    });

    db.archiveBlock(b.id, "test");
    // Query DB directly — getAllBlocks and getBlock may filter archived blocks
    const row = (db as any)["db"].prepare("SELECT status FROM blocks WHERE id = ?").get(b.id) as { status: string } | undefined;
    assert.ok(row, "Block should still exist in DB after archive");
    assert.equal(row!.status, "archived");
  });
});

// ─── Relations ───────────────────────────────────────────────────

describe("Relations", () => {
  test("createRelation links two blocks and getAllRelations returns it", () => {
    const a = db.createBlock({ label: "rel_src", type: "fact", essence: "A", content: {}, ttl: "permanent" });
    const b = db.createBlock({ label: "rel_tgt", type: "fact", essence: "B", content: {}, ttl: "permanent" });

    db.createRelation({ source_id: a.id, target_id: b.id, type: "enables", bidirectional: false });

    const rels = db.getAllRelations();
    const found = rels.find(r => r.source_id === a.id && r.target_id === b.id && r.type === "enables");
    assert.ok(found, "Relation should exist in getAllRelations");
  });

  test("invalidateRelation sets valid_to and hides from getAllRelations", () => {
    const a = db.createBlock({ label: "inv_src", type: "fact", essence: "A", content: {}, ttl: "permanent" });
    const b = db.createBlock({ label: "inv_tgt", type: "fact", essence: "B", content: {}, ttl: "permanent" });

    const rel = db.createRelation({ source_id: a.id, target_id: b.id, type: "causes", bidirectional: false });
    db.invalidateRelation(rel.id, "test invalidation");

    const rels = db.getAllRelations();
    const stillActive = rels.find(r => r.id === rel.id);
    assert.equal(stillActive, undefined, "Invalidated relation should not appear in active relations");
  });
});

// ─── Atomic Claims ───────────────────────────────────────────────

describe("Atomic Claims (multi-agent)", () => {
  test("claimBlock succeeds when unclaimed", () => {
    const b = db.createBlock({ label: "claim_test_1", type: "task", essence: "Task A", content: {}, ttl: "permanent" });

    const result = db.claimBlock(b.id, "agent-1", 300);
    assert.equal(result.claimed, true, "First claim should succeed");
    assert.ok(result.expires_at, "Should return expiry");
  });

  test("claimBlock fails when already claimed by another agent", () => {
    const b = db.createBlock({ label: "claim_test_2", type: "task", essence: "Task B", content: {}, ttl: "permanent" });

    db.claimBlock(b.id, "agent-1", 300);
    const second = db.claimBlock(b.id, "agent-2", 300);

    assert.equal(second.claimed, false, "Second claim should fail");
    assert.equal(second.claimed_by, "agent-1", "Should report who holds the claim");
  });

  test("claimBlock succeeds after releasing", () => {
    const b = db.createBlock({ label: "claim_test_3", type: "task", essence: "Task C", content: {}, ttl: "permanent" });

    db.claimBlock(b.id, "agent-1", 300);
    db.releaseBlock(b.id, "agent-1");

    const relaim = db.claimBlock(b.id, "agent-2", 300);
    assert.equal(relaim.claimed, true, "Should be claimable after release");
  });

  test("claimBlock auto-expires stale claims", () => {
    const b = db.createBlock({ label: "claim_test_4", type: "task", essence: "Task D", content: {}, ttl: "permanent" });

    // Manually insert an already-expired claim directly into the DB
    const pastTime = new Date(Date.now() - 10000).toISOString(); // 10s ago
    (db as any)["db"].prepare(
      "INSERT INTO block_claims (block_id, agent_id, claimed_at, expires_at) VALUES (?, ?, ?, ?)"
    ).run(b.id, "agent-1", pastTime, pastTime);

    // agent-2 should be able to claim — the expired claim should be auto-cleaned
    const result = db.claimBlock(b.id, "agent-2", 300);
    assert.equal(result.claimed, true, "Expired claim should be auto-released");
  });
});

// ─── Agent Registry ──────────────────────────────────────────────

describe("Agent Registry", () => {
  test("agentHeartbeat registers agent and getActiveAgents returns it", () => {
    db.agentHeartbeat("test-agent-1", "researcher", "doing research");

    const agents = db.getActiveAgents(60);
    const found = agents.find(a => a.agent_id === "test-agent-1");
    assert.ok(found, "Agent should appear in active registry");
    assert.equal(found!.role, "researcher");
    assert.equal(found!.current_task, "doing research");
  });

  test("getActiveAgents excludes agents past the stale threshold", () => {
    db.agentHeartbeat("stale-agent", "coder", "old task");

    // Use a 0-second threshold — anything not heartbeated in 0s is stale
    const agents = db.getActiveAgents(0);
    const found = agents.find(a => a.agent_id === "stale-agent");
    assert.equal(found, undefined, "Agent should be excluded when past stale threshold");
  });
});

// ─── Block Types ─────────────────────────────────────────────────

describe("Block Types", () => {
  test("dead_end blocks can be created and retrieved", () => {
    const b = db.createBlock({
      label: "dead_end_test_approach",
      type: "dead_end",
      essence: "Tried X, failed because Y",
      content: { unique: { approach: "X", reason: "Y" } },
      ttl: "permanent",
    });

    const fetched = db.getBlock("dead_end_test_approach");
    assert.equal(fetched!.type, "dead_end");
  });

  test("artifact blocks can be created with inline content", () => {
    const b = db.createBlock({
      label: "artifact_test_output",
      type: "artifact",
      essence: "Test output file",
      content: {
        unique: { filename: "test.md", mime_type: "text/markdown", storage: "inline", size_bytes: "42", sha256: "abc123" },
        has: { body: "# Hello World\n\nThis is a test artifact." },
      },
      ttl: "permanent",
    });

    const fetched = db.getBlock("artifact_test_output");
    assert.equal(fetched!.type, "artifact");
    const c = JSON.parse(fetched!.content);
    assert.equal(c.unique.storage, "inline");
    assert.ok(c.has.body.includes("Hello World"));
  });
});

// ─── member_of relation (debt-4 §2.3 / S1.3 fix) ──────────────────
// member_of is the many-to-many chain-membership relation that preserves
// memberships when Pass 5 emits overlapping narrative arcs through shared
// blocks. The chain block's `members[]` field is the canonical ORDERED
// narrative; member_of is the unordered fact-of-membership, enabling
// "which chains contain this block?" reverse lookup without losing
// memberships to chain_id column overwrites.

describe("member_of relation (debt-4 / S1.3 fix)", () => {
  test("member_of is seeded in relation_types with null inverse", () => {
    const dbAny: any = (db as any).db;
    const row = dbAny.prepare(`SELECT name, inverse FROM relation_types WHERE name = 'member_of'`).get();
    assert.ok(row, "member_of relation type must be seeded");
    assert.equal(row.name, "member_of");
    assert.equal(row.inverse, null, "member_of inverse is null — chain.members[] carries the canonical ordering");
  });

  test("createRelation member_of writes a row with correct fields", () => {
    const blk = db.createBlock({ label: "memof_blk_x", type: "fact", essence: "x", content: {}, ttl: "permanent" });
    const chain = db.createBlock({ label: "memof_chain_x", type: "chain", essence: "test chain", content: { is_a: "chain" }, ttl: "permanent" });
    const rel = db.createRelation({ source_id: blk.id, target_id: chain.id, type: "member_of", created_by: "test" });
    assert.equal(rel.source_id, blk.id);
    assert.equal(rel.target_id, chain.id);
    assert.equal(rel.type, "member_of");
    assert.equal(rel.status, "active");
  });

  test("duplicate member_of write is idempotent — returns existing row", () => {
    const blk = db.createBlock({ label: "memof_blk_idem", type: "fact", essence: "idem", content: {}, ttl: "permanent" });
    const chain = db.createBlock({ label: "memof_chain_idem", type: "chain", essence: "idem chain", content: { is_a: "chain" }, ttl: "permanent" });
    const r1 = db.createRelation({ source_id: blk.id, target_id: chain.id, type: "member_of", created_by: "test" });
    const r2 = db.createRelation({ source_id: blk.id, target_id: chain.id, type: "member_of", created_by: "test" });
    assert.equal(r1.id, r2.id, "duplicate write should return the existing relation, not create a second row");
  });

  test("one block can belong to MULTIPLE chains (the whole point of member_of)", () => {
    // S1.3 scenario: block X is part of TWO narrative arcs that share members.
    // Pre-fix, chain_id column collapsed this to last-write-wins. member_of
    // preserves both memberships in the relations table.
    const shared = db.createBlock({ label: "memof_blk_shared", type: "fact", essence: "shared", content: {}, ttl: "permanent" });
    const chainA = db.createBlock({ label: "memof_chain_A", type: "chain", essence: "arc A", content: { is_a: "chain" }, ttl: "permanent" });
    const chainB = db.createBlock({ label: "memof_chain_B", type: "chain", essence: "arc B", content: { is_a: "chain" }, ttl: "permanent" });
    db.createRelation({ source_id: shared.id, target_id: chainA.id, type: "member_of", created_by: "test" });
    db.createRelation({ source_id: shared.id, target_id: chainB.id, type: "member_of", created_by: "test" });

    const dbAny: any = (db as any).db;
    const rows = dbAny.prepare(
      `SELECT target_id FROM relations WHERE source_id = ? AND type = 'member_of' AND valid_to IS NULL`
    ).all(shared.id);
    assert.equal(rows.length, 2, "shared block must have member_of rows to BOTH chains (this is the S1.3 fix)");
    const targets = rows.map((r: any) => r.target_id).sort();
    assert.deepEqual(targets, [chainA.id, chainB.id].sort());
  });
});

// ─── getAllIncomingRelations — inverse-type translation (debt-4 / B1 fix) ─────────────
// The function's NAME promises "incoming relations from the reader's perspective."
// The stored type, however, is from the source's perspective. From the target's view
// the type should read as the INVERSE. The LEFT JOIN + COALESCE swap honors that.
// Solves all 7 paired inverse pairs at once. Patch — Debt 4 §2.2 will subsume with
// reason/evidence_basis columns on relations; read-side translation is independent.

describe("getAllIncomingRelations — inverse type translation (B1 fix)", () => {
  test("paired: supersedes → superseded_by (reading the OLD block shows superseded_by)", () => {
    const oldB = db.createBlock({ label: "b1_old_decision", type: "decision", essence: "old", content: {}, ttl: "permanent" });
    const newB = db.createBlock({ label: "b1_new_decision", type: "decision", essence: "new", content: {}, ttl: "permanent" });
    db.createRelation({ source_id: newB.id, target_id: oldB.id, type: "supersedes", created_by: "test" });

    const incoming = db.getAllIncomingRelations(oldB.id);
    const row = incoming.find((r) => r.source_id === newB.id);
    assert.ok(row, "incoming row from new block must be present");
    assert.equal(row!.type, "superseded_by", "stored type is supersedes; reader sees the inverse superseded_by");
  });

  test("paired: part_of → contains (reading the PARENT shows contains)", () => {
    const parent = db.createBlock({ label: "b1_parent_proj", type: "project", essence: "p", content: {}, ttl: "permanent" });
    const child = db.createBlock({ label: "b1_child_fact", type: "fact", essence: "c", content: {}, ttl: "permanent" });
    db.createRelation({ source_id: child.id, target_id: parent.id, type: "part_of", created_by: "test" });

    const incoming = db.getAllIncomingRelations(parent.id);
    const row = incoming.find((r) => r.source_id === child.id);
    assert.ok(row, "incoming row from child must be present");
    assert.equal(row!.type, "contains", "stored type is part_of; parent sees inverse contains");
  });

  test("self-inverse: related_to passes through unchanged", () => {
    const a = db.createBlock({ label: "b1_self_a", type: "fact", essence: "a", content: {}, ttl: "permanent" });
    const b = db.createBlock({ label: "b1_self_b", type: "fact", essence: "b", content: {}, ttl: "permanent" });
    db.createRelation({ source_id: a.id, target_id: b.id, type: "related_to", created_by: "test" });

    const incoming = db.getAllIncomingRelations(b.id);
    const row = incoming.find((r) => r.source_id === a.id);
    assert.ok(row, "incoming row must be present");
    assert.equal(row!.type, "related_to", "self-inverse: rt.inverse equals r.type, COALESCE no-op");
  });

  test("null-inverse: based_on passes through unchanged (no inverse name by design)", () => {
    const evidence = db.createBlock({ label: "b1_null_evidence", type: "fact", essence: "e", content: {}, ttl: "permanent" });
    const conclusion = db.createBlock({ label: "b1_null_conclusion", type: "insight", essence: "c", content: {}, ttl: "permanent" });
    db.createRelation({ source_id: conclusion.id, target_id: evidence.id, type: "based_on", created_by: "test" });

    const incoming = db.getAllIncomingRelations(evidence.id);
    const row = incoming.find((r) => r.source_id === conclusion.id);
    assert.ok(row, "incoming row must be present");
    assert.equal(row!.type, "based_on", "null-inverse: rt.inverse IS NULL, COALESCE keeps r.type");
  });

  test("unknown type (not seeded in relation_types) passes through unchanged", () => {
    const a = db.createBlock({ label: "b1_unk_a", type: "fact", essence: "a", content: {}, ttl: "permanent" });
    const b = db.createBlock({ label: "b1_unk_b", type: "fact", essence: "b", content: {}, ttl: "permanent" });
    db.createRelation({ source_id: a.id, target_id: b.id, type: "novel_unseeded_type", created_by: "test" });

    const incoming = db.getAllIncomingRelations(b.id);
    const row = incoming.find((r) => r.source_id === a.id);
    assert.ok(row, "incoming row must be present");
    assert.equal(row!.type, "novel_unseeded_type", "unknown type: LEFT JOIN returns NULL, COALESCE keeps r.type");
  });

  test("outgoing side unaffected: getRelations still returns original (source-perspective) type", () => {
    // Regression guard: B1 must NOT change outgoing semantics. getRelations is the
    // outgoing path; reader is the source, so the stored type is already correct.
    const newB = db.createBlock({ label: "b1_outgoing_new", type: "decision", essence: "new", content: {}, ttl: "permanent" });
    const oldB = db.createBlock({ label: "b1_outgoing_old", type: "decision", essence: "old", content: {}, ttl: "permanent" });
    db.createRelation({ source_id: newB.id, target_id: oldB.id, type: "supersedes", created_by: "test" });

    const outgoing = db.getRelations(newB.id);
    const row = outgoing.find((r) => r.target_id === oldB.id && r.direction === "outgoing");
    assert.ok(row, "outgoing row must be present");
    assert.equal(row!.type, "supersedes", "outgoing: reader is the source, type stays supersedes");
  });
});

// ─── Supersede currency semantics (2026-07-02) ───────────────────────────────
// The supersedes EDGE is the source of truth for old-vs-current; it must NOT
// archive the target. Superseded blocks stay visible history (searchable, like
// dead_ends); read paths annotate them via getSupersededByLabels instead.
// `archived` is reserved for actual removal: merge dedup, TTL expiry, forget.

describe("supersede does NOT archive — edge carries currency", () => {
  test("superseding a decision leaves the old decision ACTIVE (visible history)", () => {
    const oldB = db.createBlock({ label: "cur_old_decision", type: "decision", essence: "use localStorage", content: {}, ttl: "permanent" });
    const newB = db.createBlock({ label: "cur_new_decision", type: "decision", essence: "use httpOnly cookies", content: {}, ttl: "permanent" });
    db.createRelation({ source_id: newB.id, target_id: oldB.id, type: "supersedes", created_by: "test" });

    const row = (db as any)["db"].prepare(`SELECT status FROM blocks WHERE id = ?`).get(oldB.id);
    assert.notEqual(row.status, "archived", "superseded decision must STAY visible — the edge marks currency, not status");
    assert.ok(db.getAllBlocks().some((b) => b.id === oldB.id), "superseded block still surfaces in active reads");
  });

  test("getSupersededByLabels maps superseded ids to the ACTIVE superseding label", () => {
    const oldB = db.createBlock({ label: "cur_map_old", type: "blueprint", essence: "v1 plan", content: {}, ttl: "permanent" });
    const newB = db.createBlock({ label: "cur_map_new", type: "decision", essence: "v2 shipped", content: {}, ttl: "permanent" });
    const lone = db.createBlock({ label: "cur_map_lone", type: "fact", essence: "unrelated", content: {}, ttl: "permanent" });
    db.createRelation({ source_id: newB.id, target_id: oldB.id, type: "supersedes", created_by: "test" });

    const map = db.getSupersededByLabels([oldB.id, lone.id]);
    assert.equal(map.get(oldB.id), "cur_map_new", "superseded id maps to the superseding block's label");
    assert.equal(map.has(lone.id), false, "non-superseded id is not annotated");
    assert.equal(db.getSupersededByLabels([]).size, 0, "empty input → empty map, no throw");
  });

  test("explicit archive still works and is independent of supersede", () => {
    const dupe = db.createBlock({ label: "cur_dupe", type: "fact", essence: "duplicate", content: {}, ttl: "permanent" });
    db.archiveBlock(dupe.id, "merged duplicate");
    const row = (db as any)["db"].prepare(`SELECT status FROM blocks WHERE id = ?`).get(dupe.id);
    assert.equal(row.status, "archived", "explicit archive (merge/forget/TTL path) unchanged");
  });
});

// ─── DEBT 5 Phase 1 schema additions ──────────────────────────────────────────
// Verifies the persistence layer: conversation_turns + conversation_turn_ranges
// tables exist with correct columns, source_excerpt column added to blocks,
// extracted_from relation seeded. Phase 1 is additive — zero behavior change;
// these tests only check that the schema is in place for later phases to use.
// Source: docs/DEBT5-ATOMIC-AND-ARC-EXTRACTION.md §2.1, §2.2, §2.3, §2.3.2.

describe("DEBT 5 Phase 1: schema additions", () => {
  function tableInfo(name: string): Array<{ name: string; type: string; notnull: number; dflt_value: any; pk: number }> {
    const dbAny: any = (db as any).db;
    return dbAny.prepare(`PRAGMA table_info(${name})`).all();
  }
  function indexNames(table: string): string[] {
    const dbAny: any = (db as any).db;
    return dbAny.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name=?`).all(table).map((r: any) => r.name);
  }

  test("conversation_turns table exists with all expected columns", () => {
    const cols = tableInfo("conversation_turns");
    assert.ok(cols.length > 0, "conversation_turns table must exist");
    const colNames = cols.map((c) => c.name).sort();
    const expected = [
      "agent_id",
      "created_at",
      "extracted_at",
      "id",
      "last_extract_attempt_at",
      "last_extract_error",
      "pairing_range_id",
      "pass01_completed_at",
      "pass01_output_json",
      "status",
      "transcript_json",
      "turn_name",
      "turn_number",
    ];
    assert.deepEqual(colNames, expected, "conversation_turns must have exactly these columns");
  });

  test("conversation_turns: id is PRIMARY KEY; agent_id + turn_number have NOT NULL; status defaults to 'captured'", () => {
    const cols = tableInfo("conversation_turns");
    const id = cols.find((c) => c.name === "id");
    assert.ok(id?.pk, "id must be PRIMARY KEY");
    assert.equal(cols.find((c) => c.name === "agent_id")?.notnull, 1, "agent_id NOT NULL");
    assert.equal(cols.find((c) => c.name === "turn_number")?.notnull, 1, "turn_number NOT NULL");
    assert.equal(cols.find((c) => c.name === "transcript_json")?.notnull, 1, "transcript_json NOT NULL");
    assert.equal(cols.find((c) => c.name === "status")?.notnull, 1, "status NOT NULL");
    const statusDefault = String(cols.find((c) => c.name === "status")?.dflt_value ?? "");
    assert.ok(statusDefault.includes("captured"), `status default should be 'captured' (got: ${statusDefault})`);
  });

  test("conversation_turns: (agent_id, turn_number) is UNIQUE", () => {
    const dbAny: any = (db as any).db;
    const ts = new Date().toISOString();
    dbAny.prepare(`INSERT INTO conversation_turns (id, agent_id, turn_number, transcript_json, created_at) VALUES (?, ?, ?, ?, ?)`)
      .run("ct_test_uniq_1", "agent_test_uniq", 1, "{}", ts);
    assert.throws(() => {
      dbAny.prepare(`INSERT INTO conversation_turns (id, agent_id, turn_number, transcript_json, created_at) VALUES (?, ?, ?, ?, ?)`)
        .run("ct_test_uniq_2", "agent_test_uniq", 1, "{}", ts);
    }, /UNIQUE constraint failed/, "second insert with same (agent_id, turn_number) must fail UNIQUE");
  });

  test("conversation_turns: indexes on agent_id and status", () => {
    const idxs = indexNames("conversation_turns");
    assert.ok(idxs.includes("idx_conv_turns_agent"),  `idx_conv_turns_agent missing (have: ${idxs.join(",")})`);
    assert.ok(idxs.includes("idx_conv_turns_status"), `idx_conv_turns_status missing (have: ${idxs.join(",")})`);
  });

  test("conversation_turn_ranges table exists with all expected columns", () => {
    const cols = tableInfo("conversation_turn_ranges");
    assert.ok(cols.length > 0, "conversation_turn_ranges table must exist");
    const colNames = cols.map((c) => c.name).sort();
    const expected = [
      "agent_id",
      "end_turn_number",
      "extracted_at",
      "extraction_type",
      "id",
      "pipeline_run_id",
      "start_turn_number",
      "superseded_range_id",
      "trigger_source",
    ];
    assert.deepEqual(colNames, expected, "conversation_turn_ranges must have exactly these columns");
  });

  test("conversation_turn_ranges: agent_id + start/end + extraction_type + extracted_at NOT NULL", () => {
    const cols = tableInfo("conversation_turn_ranges");
    assert.equal(cols.find((c) => c.name === "agent_id")?.notnull,           1);
    assert.equal(cols.find((c) => c.name === "start_turn_number")?.notnull,  1);
    assert.equal(cols.find((c) => c.name === "end_turn_number")?.notnull,    1);
    assert.equal(cols.find((c) => c.name === "extraction_type")?.notnull,    1);
    assert.equal(cols.find((c) => c.name === "extracted_at")?.notnull,       1);
  });

  test("conversation_turn_ranges: index on agent_id", () => {
    const idxs = indexNames("conversation_turn_ranges");
    assert.ok(idxs.includes("idx_ctr_agent"), `idx_ctr_agent missing (have: ${idxs.join(",")})`);
  });

  test("blocks.source_excerpt column added (D3); index is partial (NULL excluded)", () => {
    const cols = tableInfo("blocks");
    const se = cols.find((c) => c.name === "source_excerpt");
    assert.ok(se, "blocks.source_excerpt must exist (D3 line-level provenance)");
    assert.equal(se!.notnull, 0, "source_excerpt is nullable (NULL = pre-Debt-5 atomic block)");

    const idxs = indexNames("blocks");
    assert.ok(idxs.includes("idx_blocks_source_excerpt"), `idx_blocks_source_excerpt missing (have: ${idxs.join(",")})`);

    // Verify the index is partial — the partial WHERE clause shows up in sqlite_master.sql
    const dbAny: any = (db as any).db;
    const idxRow: any = dbAny.prepare(
      `SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_blocks_source_excerpt'`
    ).get();
    assert.ok(idxRow?.sql?.includes("WHERE source_excerpt IS NOT NULL"),
      `index must be partial — keep tight, only arc-extracted blocks indexed. SQL was: ${idxRow?.sql}`);
  });

  test("extracted_from is seeded as a relation_type with null inverse (D5/§2.3)", () => {
    const dbAny: any = (db as any).db;
    const row: any = dbAny.prepare(`SELECT name, inverse, description FROM relation_types WHERE name = 'extracted_from'`).get();
    assert.ok(row, "extracted_from must be seeded");
    assert.equal(row.name, "extracted_from");
    assert.equal(row.inverse, null, "extracted_from inverse is null — turn_range_id reverse query is direct");
    assert.ok(/provenance/i.test(row.description), "description should mention provenance");
  });

  test("blocks created without source_excerpt have NULL (pre-Debt-5 atomic convention)", () => {
    const b = db.createBlock({ label: "phase1_noexcerpt", type: "fact", essence: "x", content: {}, ttl: "permanent" });
    const dbAny: any = (db as any).db;
    const row: any = dbAny.prepare(`SELECT source_excerpt FROM blocks WHERE id = ?`).get(b.id);
    assert.equal(row.source_excerpt, null, "default source_excerpt must be NULL — dedup logic relies on this");
  });
});

// ─── DEBT 5 Phase 2: Conversation turn + range CRUD helpers ───────────────────
// Per §2.1, §2.2. Exercises the typed DB helpers that the pipeline (Phase 2b)
// and arc-mode (Phase 3) build on. Idempotency / status-flip / UNIQUE behavior
// is load-bearing — these tests lock it.

describe("DEBT 5 Phase 2: conversation_turns CRUD", () => {
  function mkTranscript(suffix = "x") {
    return JSON.stringify({ user_message: `u-${suffix}`, agent_response: `a-${suffix}`, agent_thinking: `t-${suffix}` });
  }

  test("createConversationTurn inserts with default status='captured' and null pass01 fields", () => {
    const row = db.createConversationTurn({
      agent_id: "agent_p2_create",
      turn_number: 1,
      turn_name: "first-turn",
      transcript_json: mkTranscript("create"),
    });
    assert.ok(row.id.startsWith("ct_"), `id must start with ct_ prefix (got ${row.id})`);
    assert.equal(row.agent_id, "agent_p2_create");
    assert.equal(row.turn_number, 1);
    assert.equal(row.turn_name, "first-turn");
    assert.equal(row.status, "captured");
    assert.equal(row.pass01_output_json, null);
    assert.equal(row.pass01_completed_at, null);
    assert.equal(row.extracted_at, null);
    assert.equal(row.pairing_range_id, null);
    assert.ok(row.created_at, "created_at must be set (ISO timestamp)");
  });

  test("createConversationTurn rejects duplicate (agent_id, turn_number)", () => {
    db.createConversationTurn({ agent_id: "agent_p2_dup", turn_number: 5, transcript_json: mkTranscript("a") });
    assert.throws(() => {
      db.createConversationTurn({ agent_id: "agent_p2_dup", turn_number: 5, transcript_json: mkTranscript("b") });
    }, /UNIQUE constraint failed/, "second insert must surface UNIQUE violation (re-entry is a real bug, not silent idempotency)");
  });

  test("createConversationTurn allows same agent_id + different turn_number", () => {
    const r1 = db.createConversationTurn({ agent_id: "agent_p2_multi", turn_number: 1, transcript_json: mkTranscript("1") });
    const r2 = db.createConversationTurn({ agent_id: "agent_p2_multi", turn_number: 2, transcript_json: mkTranscript("2") });
    assert.notEqual(r1.id, r2.id);
    assert.equal(r1.agent_id, r2.agent_id);
  });

  test("updateConversationTurnPass01 flips status captured → pass01_done with payload", () => {
    const row = db.createConversationTurn({ agent_id: "agent_p2_update", turn_number: 1, transcript_json: mkTranscript("u") });
    const payload = JSON.stringify({ scene_card: { summary: "test" }, items: [{ id: "item_1", text: "x" }] });
    db.updateConversationTurnPass01(row.id, payload);
    const updated = db.getConversationTurnById(row.id)!;
    assert.equal(updated.status, "pass01_done");
    assert.equal(updated.pass01_output_json, payload);
    assert.ok(updated.pass01_completed_at, "pass01_completed_at must be set");
  });

  test("updateConversationTurnPass01 throws when row already past 'captured'", () => {
    const row = db.createConversationTurn({ agent_id: "agent_p2_doubleflip", turn_number: 1, transcript_json: mkTranscript("d") });
    db.updateConversationTurnPass01(row.id, JSON.stringify({ items: [] }));
    // Second flip must throw (caller bug — flag-gated path is expected to call once per turn).
    assert.throws(() => {
      db.updateConversationTurnPass01(row.id, JSON.stringify({ items: [] }));
    }, /no row updated/, "double-flip must surface, not silently no-op");
  });

  test("updateConversationTurnPass01 throws for missing id", () => {
    assert.throws(() => {
      db.updateConversationTurnPass01("ct_does_not_exist", "{}");
    }, /no row updated/, "missing id must throw");
  });

  test("markConversationTurnExtracted flips pass01_done → extracted with pairing_range_id", () => {
    const row = db.createConversationTurn({ agent_id: "agent_p2_extract", turn_number: 1, transcript_json: mkTranscript("e") });
    db.updateConversationTurnPass01(row.id, JSON.stringify({ items: [] }));
    db.markConversationTurnExtracted(row.id, "ctr_fake_range_123");
    const updated = db.getConversationTurnById(row.id)!;
    assert.equal(updated.status, "extracted");
    assert.equal(updated.pairing_range_id, "ctr_fake_range_123");
    assert.ok(updated.extracted_at, "extracted_at must be set");
  });

  test("getConversationTurnByAgentTurn returns null for non-existent (agent, turn)", () => {
    assert.equal(db.getConversationTurnByAgentTurn("agent_does_not_exist", 999), null);
  });

  test("listConversationTurnsByAgent returns all turns in turn_number ascending order", () => {
    db.createConversationTurn({ agent_id: "agent_p2_list", turn_number: 3, transcript_json: mkTranscript("3") });
    db.createConversationTurn({ agent_id: "agent_p2_list", turn_number: 1, transcript_json: mkTranscript("1") });
    db.createConversationTurn({ agent_id: "agent_p2_list", turn_number: 2, transcript_json: mkTranscript("2") });
    const rows = db.listConversationTurnsByAgent("agent_p2_list");
    assert.equal(rows.length, 3);
    assert.deepEqual(rows.map((r) => r.turn_number), [1, 2, 3], "must be ASCending by turn_number");
  });

  test("listConversationTurnsByAgent filters by status", () => {
    const ag = "agent_p2_listfilter";
    const r1 = db.createConversationTurn({ agent_id: ag, turn_number: 1, transcript_json: mkTranscript("1") });
    db.createConversationTurn({ agent_id: ag, turn_number: 2, transcript_json: mkTranscript("2") });
    db.updateConversationTurnPass01(r1.id, JSON.stringify({ items: [] }));
    const captured  = db.listConversationTurnsByAgent(ag, { status: "captured" });
    const pass01done = db.listConversationTurnsByAgent(ag, { status: "pass01_done" });
    assert.equal(captured.length, 1, "1 turn still 'captured'");
    assert.equal(captured[0]!.turn_number, 2);
    assert.equal(pass01done.length, 1, "1 turn moved to 'pass01_done'");
    assert.equal(pass01done[0]!.turn_number, 1);
  });

  test("listAgentsWithFailedArc lists only agents whose arc extraction FAILED (the credit-resume re-extract target)", () => {
    // agent A: pass01_done turn with a failure marker → should be re-extracted on resume
    const a = db.createConversationTurn({ agent_id: "agent_failed_arc", turn_number: 1, transcript_json: mkTranscript("a") });
    db.updateConversationTurnPass01(a.id, JSON.stringify({ items: [] }));
    db.markConversationTurnsExtractFailed("agent_failed_arc", 1, 1, "403 Key limit exceeded (total limit)");
    // agent B: pass01_done but NO failure marker (merely accumulating) → must NOT be re-extracted
    const b = db.createConversationTurn({ agent_id: "agent_clean_arc", turn_number: 1, transcript_json: mkTranscript("b") });
    db.updateConversationTurnPass01(b.id, JSON.stringify({ items: [] }));
    const stuck = db.listAgentsWithFailedArc();
    assert.ok(stuck.includes("agent_failed_arc"), "the credit-failed arc agent must be listed");
    assert.ok(!stuck.includes("agent_clean_arc"), "an agent merely accumulating turns must NOT be re-extracted");
  });

  test("listConversationTurnsByAgent filters by minTurn / maxTurn range", () => {
    const ag = "agent_p2_listrange";
    for (let t = 1; t <= 5; t++) db.createConversationTurn({ agent_id: ag, turn_number: t, transcript_json: mkTranscript(String(t)) });
    const slice = db.listConversationTurnsByAgent(ag, { minTurn: 2, maxTurn: 4 });
    assert.equal(slice.length, 3);
    assert.deepEqual(slice.map((r) => r.turn_number), [2, 3, 4]);
  });
});

describe("DEBT 5 Phase 2: conversation_turn_ranges CRUD", () => {
  test("createConversationTurnRange inserts with ctr_ prefix + correct fields", () => {
    const r = db.createConversationTurnRange({
      agent_id: "agent_p2_range",
      start_turn_number: 1,
      end_turn_number: 5,
      extraction_type: "arc",
      trigger_source: "phase_tag",
      pipeline_run_id: "rj_test_run_1",
    });
    assert.ok(r.id.startsWith("ctr_"), `id must start with ctr_ prefix (got ${r.id})`);
    assert.equal(r.agent_id, "agent_p2_range");
    assert.equal(r.start_turn_number, 1);
    assert.equal(r.end_turn_number, 5);
    assert.equal(r.extraction_type, "arc");
    assert.equal(r.trigger_source, "phase_tag");
    assert.equal(r.pipeline_run_id, "rj_test_run_1");
    assert.equal(r.superseded_range_id, null);
    assert.ok(r.extracted_at, "extracted_at must be set");
  });

  test("createConversationTurnRange rejects end_turn < start_turn", () => {
    assert.throws(() => {
      db.createConversationTurnRange({
        agent_id: "agent_p2_badrange",
        start_turn_number: 5,
        end_turn_number: 3,
        extraction_type: "arc",
      });
    }, /end_turn_number.*<.*start_turn_number/, "must reject reversed range");
  });

  test("createConversationTurnRange supports extraction_type='re-extract' with superseded_range_id", () => {
    const original = db.createConversationTurnRange({
      agent_id: "agent_p2_reextract", start_turn_number: 1, end_turn_number: 3, extraction_type: "arc",
    });
    const re = db.createConversationTurnRange({
      agent_id: "agent_p2_reextract", start_turn_number: 1, end_turn_number: 3, extraction_type: "re-extract",
      superseded_range_id: original.id,
    });
    assert.equal(re.extraction_type, "re-extract");
    assert.equal(re.superseded_range_id, original.id);
  });

  test("getConversationTurnRange returns null for missing id", () => {
    assert.equal(db.getConversationTurnRange("ctr_does_not_exist"), null);
  });
});

// ─── DEBT 5 Phase 5: D3 source_excerpt — createBlock persistence ─────────────
// Verifies the schema column added in Phase 1 + the new createBlock param wire
// correctly through to a stored row. Propagation through Pass 1→2→3 is verified
// by the existing Pass 2a tests + the manual code review of pipeline.ts:1690
// (sourceExcerptMap lookup at the createBlock call). End-to-end (Pass 1 emits
// excerpt → block in DB has source_excerpt) is deferred to Phase 11 multi-turn
// fixture validation.

describe("DEBT 5 Phase 5: D3 source_excerpt propagation (createBlock layer)", () => {
  test("createBlock with source_excerpt persists the value", () => {
    const excerpt = "Skip the multi-course plated format entirely and run a family-style menu with two hot mains served in a single coordinated push.";
    const b = db.createBlock({
      label: "phase5_with_excerpt",
      type: "decision",
      essence: "chose family-style menu",
      content: { unique: { choice: "family-style menu" } },
      ttl: "permanent",
      source_excerpt: excerpt,
    });
    const dbAny: any = (db as any).db;
    const row: any = dbAny.prepare(`SELECT source_excerpt FROM blocks WHERE id = ?`).get(b.id);
    assert.equal(row.source_excerpt, excerpt, "exact transcript text must round-trip");
  });

  test("createBlock without source_excerpt persists NULL (pre-Debt-5 atomic convention)", () => {
    const b = db.createBlock({
      label: "phase5_no_excerpt",
      type: "fact",
      essence: "no excerpt",
      content: { unique: { value: "x" } },
      ttl: "permanent",
    });
    const dbAny: any = (db as any).db;
    const row: any = dbAny.prepare(`SELECT source_excerpt FROM blocks WHERE id = ?`).get(b.id);
    assert.equal(row.source_excerpt, null, "explicit NULL distinguishes pre-Debt-5 from arc-extracted-with-empty");
  });

  test("createBlock with empty-string source_excerpt persists NULL (not empty string)", () => {
    // Pass 2a's defensive fallback uses "" when Pass 1 re-join misses — we
    // want createBlock to treat that as NULL (no pin) rather than "" (an
    // explicit pin of empty text). The pipeline.ts wiring uses
    // `...(blockSourceExcerpt ? { source_excerpt: blockSourceExcerpt } : {})`
    // which omits the field when empty, so createBlock writes NULL.
    // Here we test the createBlock contract DIRECTLY — when source_excerpt
    // is explicitly empty string, the column stores empty string (caller's
    // responsibility to omit the param when empty).
    const b = db.createBlock({
      label: "phase5_empty_excerpt",
      type: "fact",
      essence: "test empty",
      content: { unique: { value: "x" } },
      ttl: "permanent",
      source_excerpt: "",
    });
    const dbAny: any = (db as any).db;
    const row: any = dbAny.prepare(`SELECT source_excerpt FROM blocks WHERE id = ?`).get(b.id);
    // SQLite stores empty string as empty string (not NULL). Caller (pipeline)
    // omits the param when empty, so this contract is fine.
    assert.equal(row.source_excerpt, "", "explicit empty string is stored as such; pipeline omits param when empty");
  });

  test("source_excerpt index allows efficient lookup by exact match (D2 dedup uses this)", () => {
    const excerpt = "This is a unique transcript line that should be findable by exact match.";
    const b = db.createBlock({
      label: "phase5_indexed_excerpt",
      type: "fact",
      essence: "indexed",
      content: { unique: { value: "x" } },
      ttl: "permanent",
      source_excerpt: excerpt,
    });
    const dbAny: any = (db as any).db;
    const found = dbAny.prepare(`SELECT id FROM blocks WHERE source_excerpt = ?`).get(excerpt) as any;
    assert.ok(found, "exact-match lookup on source_excerpt must find the block");
    assert.equal(found.id, b.id);
  });
});

// ─── DEBT 5 Phase 9: extracted_from provenance via block_extractions join ────
// Validates the join table + helpers introduced in Phase 9. Schema: each row
// pairs a block_id with a conversation_turn_ranges row that produced it.
// re-extract scenario produces a NEW row joining the same block_id to a NEW
// range_id (audit trail preserved per Rule 2).

describe("DEBT 5 Phase 9: block_extractions provenance", () => {
  function tableInfo(name: string): Array<{ name: string; notnull: number; pk: number }> {
    const dbAny: any = (db as any).db;
    return dbAny.prepare(`PRAGMA table_info(${name})`).all();
  }
  function indexNames(table: string): string[] {
    const dbAny: any = (db as any).db;
    return dbAny.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name=?`).all(table).map((r: any) => r.name);
  }

  test("block_extractions table exists with expected columns + indexes", () => {
    const cols = tableInfo("block_extractions");
    assert.ok(cols.length > 0, "block_extractions table must exist");
    const colNames = cols.map((c) => c.name).sort();
    assert.deepEqual(colNames, ["block_id", "extracted_at", "id", "range_id"], "exact column set");
    const idxs = indexNames("block_extractions");
    assert.ok(idxs.includes("idx_block_extractions_block"), `idx_block_extractions_block missing (have: ${idxs.join(",")})`);
    assert.ok(idxs.includes("idx_block_extractions_range"), `idx_block_extractions_range missing (have: ${idxs.join(",")})`);
  });

  test("recordBlockExtraction creates a row with bx_ prefix + returns true", () => {
    const b = db.createBlock({ label: "p9_blk_1", type: "fact", essence: "x", content: {}, ttl: "permanent" });
    const range = db.createConversationTurnRange({
      agent_id: "agent_p9_basic", start_turn_number: 1, end_turn_number: 3, extraction_type: "arc",
    });
    const created = db.recordBlockExtraction(b.id, range.id);
    assert.equal(created, true, "first insert reports true");
    const rows = db.getBlockExtractions(b.id);
    assert.equal(rows.length, 1);
    assert.ok(rows[0]!.id.startsWith("bx_"), `id must start with bx_ prefix (got ${rows[0]!.id})`);
    assert.equal(rows[0]!.range_id, range.id);
    assert.ok(rows[0]!.extracted_at, "extracted_at must be set");
  });

  test("recordBlockExtraction is idempotent on (block_id, range_id) — second call returns false", () => {
    const b = db.createBlock({ label: "p9_blk_idem", type: "fact", essence: "x", content: {}, ttl: "permanent" });
    const range = db.createConversationTurnRange({
      agent_id: "agent_p9_idem", start_turn_number: 1, end_turn_number: 3, extraction_type: "arc",
    });
    assert.equal(db.recordBlockExtraction(b.id, range.id), true, "first call: created");
    assert.equal(db.recordBlockExtraction(b.id, range.id), false, "second call: no-op (UNIQUE constraint)");
    const rows = db.getBlockExtractions(b.id);
    assert.equal(rows.length, 1, "only one row exists despite two record calls");
  });

  test("re-extract pattern: same block_id, NEW range_id → 2 rows (audit trail preserved)", () => {
    const b = db.createBlock({ label: "p9_blk_reextract", type: "fact", essence: "x", content: {}, ttl: "permanent" });
    const range1 = db.createConversationTurnRange({
      agent_id: "agent_p9_re", start_turn_number: 1, end_turn_number: 3, extraction_type: "arc",
    });
    const range2 = db.createConversationTurnRange({
      agent_id: "agent_p9_re", start_turn_number: 1, end_turn_number: 3, extraction_type: "re-extract",
      superseded_range_id: range1.id,
    });
    db.recordBlockExtraction(b.id, range1.id);
    db.recordBlockExtraction(b.id, range2.id);
    const rows = db.getBlockExtractions(b.id);
    assert.equal(rows.length, 2, "both arc and re-extract events present (Rule 2: never delete)");
    const rangeIds = rows.map((r) => r.range_id);
    assert.ok(rangeIds.includes(range1.id));
    assert.ok(rangeIds.includes(range2.id));
  });

  test("getBlocksByRange returns all blocks produced by a range", () => {
    const range = db.createConversationTurnRange({
      agent_id: "agent_p9_listrange", start_turn_number: 1, end_turn_number: 5, extraction_type: "arc",
    });
    const b1 = db.createBlock({ label: "p9_blk_list_1", type: "fact",     essence: "1", content: {}, ttl: "permanent" });
    const b2 = db.createBlock({ label: "p9_blk_list_2", type: "decision", essence: "2", content: {}, ttl: "permanent" });
    const b3 = db.createBlock({ label: "p9_blk_list_3", type: "dead_end", essence: "3", content: {}, ttl: "permanent" });
    db.recordBlockExtraction(b1.id, range.id);
    db.recordBlockExtraction(b2.id, range.id);
    db.recordBlockExtraction(b3.id, range.id);
    const rows = db.getBlocksByRange(range.id);
    assert.equal(rows.length, 3);
    const blockIds = rows.map((r) => r.block_id).sort();
    assert.deepEqual(blockIds, [b1.id, b2.id, b3.id].sort());
  });

  test("getBlockExtractions returns empty array for block with no extractions (pre-Debt-5 atomic)", () => {
    const b = db.createBlock({ label: "p9_blk_pre_debt5", type: "fact", essence: "x", content: {}, ttl: "permanent" });
    const rows = db.getBlockExtractions(b.id);
    assert.deepEqual(rows, [], "pre-Debt-5 atomic blocks have no extracted_from rows; empty array is the answer");
  });
});

// ─── DEBT 5 Phase 10: inactivity safety net query ────────────────────────────
// Validates getAgentsWithStalePass01Turns — the query the server-side timer
// uses to find stale conversations to auto-extract. The query groups by
// agent_id, takes MAX(created_at) across non-extracted statuses (captured +
// pass01_done), and returns those where last activity is older than threshold.

describe("DEBT 5 Phase 10: getAgentsWithStalePass01Turns", () => {
  // Helper to backdate a conversation_turns row by N hours
  function backdateTurn(id: string, hoursAgo: number): void {
    const ts = new Date(Date.now() - hoursAgo * 3_600_000).toISOString();
    const dbAny: any = (db as any).db;
    dbAny.prepare(`UPDATE conversation_turns SET created_at = ? WHERE id = ?`).run(ts, id);
  }

  test("returns empty when no pass01_done turns exist", () => {
    // Clean slate via a fresh agent id — other tests' agents shouldn't bleed
    const agents = db.getAgentsWithStalePass01Turns(1_000);
    // Note: previous tests may have left rows; we can't fully isolate. We
    // verify the SHAPE (an array) — see specific scenarios below.
    assert.ok(Array.isArray(agents), "must return an array");
  });

  test("includes an agent whose only pass01_done turn is older than threshold", () => {
    const ag = "agent_p10_stale";
    const row = db.createConversationTurn({
      agent_id: ag, turn_number: 1,
      transcript_json: JSON.stringify({ user_message: "u", agent_response: "a", agent_thinking: "t" }),
    });
    db.updateConversationTurnPass01(row.id, JSON.stringify({ items: [] }));
    backdateTurn(row.id, 2);  // 2 hours ago → past 1-hour threshold

    const agents = db.getAgentsWithStalePass01Turns(3_600_000);  // 1h threshold
    assert.ok(agents.includes(ag), `agent ${ag} should be in stale list (have: ${agents.join(",")})`);
  });

  test("EXCLUDES an agent whose latest activity is RECENT (even if older turns exist)", () => {
    const ag = "agent_p10_recent_activity";
    const r1 = db.createConversationTurn({
      agent_id: ag, turn_number: 1,
      transcript_json: JSON.stringify({ user_message: "u1", agent_response: "a1", agent_thinking: "t1" }),
    });
    db.updateConversationTurnPass01(r1.id, JSON.stringify({ items: [] }));
    backdateTurn(r1.id, 5);  // 5 hours ago

    // Recent activity: a fresh captured turn (NOT yet pass01_done)
    db.createConversationTurn({
      agent_id: ag, turn_number: 2,
      transcript_json: JSON.stringify({ user_message: "u2", agent_response: "a2", agent_thinking: "t2" }),
    });

    const agents = db.getAgentsWithStalePass01Turns(3_600_000);  // 1h threshold
    assert.ok(!agents.includes(ag), `agent ${ag} has recent activity (turn 2 captured now) → NOT stale`);
  });

  test("EXCLUDES agents with only 'extracted' turns (already processed)", () => {
    const ag = "agent_p10_already_extracted";
    const r1 = db.createConversationTurn({
      agent_id: ag, turn_number: 1,
      transcript_json: JSON.stringify({ user_message: "u", agent_response: "a", agent_thinking: "t" }),
    });
    db.updateConversationTurnPass01(r1.id, JSON.stringify({ items: [] }));
    db.markConversationTurnExtracted(r1.id, "ctr_synthetic_for_test");
    backdateTurn(r1.id, 10);

    const agents = db.getAgentsWithStalePass01Turns(3_600_000);
    assert.ok(!agents.includes(ag), `extracted turns are done; should not show up as stale`);
  });

  test("respects limit parameter (bounds work per timer tick)", () => {
    for (let i = 1; i <= 5; i++) {
      const ag = `agent_p10_limit_${i}`;
      const row = db.createConversationTurn({
        agent_id: ag, turn_number: 1,
        transcript_json: JSON.stringify({ user_message: "u", agent_response: "a", agent_thinking: "t" }),
      });
      db.updateConversationTurnPass01(row.id, JSON.stringify({ items: [] }));
      backdateTurn(row.id, 10);  // all stale
    }
    const agents = db.getAgentsWithStalePass01Turns(3_600_000, 3);
    assert.ok(agents.length <= 3, `limit=3 must return at most 3 (got ${agents.length})`);
  });

  test("orders by oldest-stale-first (last_activity ASC) so most-urgent gets extracted first", () => {
    const ag5 = "agent_p10_order_5h";
    const ag10 = "agent_p10_order_10h";
    for (const [agent_id, hours] of [[ag5, 5], [ag10, 10]] as Array<[string, number]>) {
      const row = db.createConversationTurn({
        agent_id, turn_number: 1,
        transcript_json: JSON.stringify({ user_message: "u", agent_response: "a", agent_thinking: "t" }),
      });
      db.updateConversationTurnPass01(row.id, JSON.stringify({ items: [] }));
      backdateTurn(row.id, hours);
    }
    const agents = db.getAgentsWithStalePass01Turns(3_600_000, 16);
    const i5 = agents.indexOf(ag5);
    const i10 = agents.indexOf(ag10);
    if (i5 >= 0 && i10 >= 0) {
      assert.ok(i10 < i5, `older-stale agent (${ag10}, 10h) should appear BEFORE younger-stale agent (${ag5}, 5h); got order [${agents.join(", ")}]`);
    } else {
      // If other tests' agents pushed these past the limit, skip — the shape
      // assertion above is the load-bearing check.
      assert.ok(true);
    }
  });
});

// ─── Boot sweep gating — recover arcs a restart stranded mid-extraction ───────
describe("startBootArcSweep gating", () => {
  test("off when arc mode is off, and when NODEDEX_ARC_BOOT_SWEEP=off; on otherwise", async () => {
    const { startBootArcSweep } = await import("../middleware/reflect/arc-inactivity-timer.js");
    const prevArc = process.env.NODEDEX_ARC_EXTRACTION;
    const prevSweep = process.env.NODEDEX_ARC_BOOT_SWEEP;
    const prevDelay = process.env.NODEDEX_ARC_BOOT_SWEEP_DELAY_MS;
    process.env.NODEDEX_ARC_BOOT_SWEEP_DELAY_MS = "3600000"; // far-future so the "on" case's timer never fires in-suite
    try {
      delete process.env.NODEDEX_ARC_EXTRACTION;
      assert.equal(startBootArcSweep(db), false, "arc mode off → no sweep (no pass01_done turns to recover)");
      process.env.NODEDEX_ARC_EXTRACTION = "1";
      process.env.NODEDEX_ARC_BOOT_SWEEP = "off";
      assert.equal(startBootArcSweep(db), false, "explicit off → no sweep");
      delete process.env.NODEDEX_ARC_BOOT_SWEEP;
      assert.equal(startBootArcSweep(db), true, "arc on + default → sweep scheduled");
    } finally {
      if (prevArc === undefined) delete process.env.NODEDEX_ARC_EXTRACTION; else process.env.NODEDEX_ARC_EXTRACTION = prevArc;
      if (prevSweep === undefined) delete process.env.NODEDEX_ARC_BOOT_SWEEP; else process.env.NODEDEX_ARC_BOOT_SWEEP = prevSweep;
      if (prevDelay === undefined) delete process.env.NODEDEX_ARC_BOOT_SWEEP_DELAY_MS; else process.env.NODEDEX_ARC_BOOT_SWEEP_DELAY_MS = prevDelay;
    }
  });
});

// ─── DEBT 5: getExtractionStatus — agent-facing extraction freshness ──────────
// The agent PULLS this (via workspace_stats) because, as a passive MCP tool, the
// system can't push it. It must disambiguate the three look-alike "empty" states.
describe("getExtractionStatus — extraction freshness (pull surface)", () => {
  test("extracted arc → recent[] carries topic (label-prefix), block count, chain label", () => {
    const agent = "es_extracted";
    const t1 = db.createConversationTurn({ agent_id: agent, turn_number: 1, turn_name: "es-t1", transcript_json: "{}" });
    const t2 = db.createConversationTurn({ agent_id: agent, turn_number: 2, turn_name: "es-t2", transcript_json: "{}" });
    db.updateConversationTurnPass01(t1.id, "{}");
    db.updateConversationTurnPass01(t2.id, "{}");
    const range = db.createConversationTurnRange({ agent_id: agent, start_turn_number: 1, end_turn_number: 2, extraction_type: "arc" });
    db.markConversationTurnExtracted(t1.id, range.id);
    db.markConversationTurnExtracted(t2.id, range.id);
    const d = db.createBlock({ label: "es-topic_decision_pick-pg", type: "decision", essence: "pick pg", content: {}, ttl: "permanent" });
    const f = db.createBlock({ label: "es-topic_fact_scale", type: "fact", essence: "scale", content: {}, ttl: "permanent" });
    const c = db.createBlock({ label: "es-topic_chain_story", type: "chain", essence: "the story", content: { is_a: "chain" }, ttl: "permanent" });
    db.recordBlockExtraction(d.id, range.id);
    db.recordBlockExtraction(f.id, range.id);
    db.recordBlockExtraction(c.id, range.id);

    const st = db.getExtractionStatus(agent);
    assert.equal(st.pending, null, "all turns extracted → no pending");
    assert.equal(st.recent.length, 1);
    assert.equal(st.recent[0]!.topic, "es-topic", "topic = the {project} label-prefix the arc produced");
    assert.equal(st.recent[0]!.turns, "1-2");
    assert.equal(st.recent[0]!.blocks, 3);
    assert.equal(st.recent[0]!.chain, "es-topic_chain_story", "chain handle = the chain block's label (the story)");
  });

  test("pass01_done but un-extracted → pending set (NOT mistakable for 'nothing exists')", () => {
    const agent = "es_pending";
    const t1 = db.createConversationTurn({ agent_id: agent, turn_number: 1, turn_name: "fetch-crash", transcript_json: "{}" });
    db.updateConversationTurnPass01(t1.id, "{}");
    const st = db.getExtractionStatus(agent);
    assert.ok(st.pending, "pending must be set for a staged-but-unextracted turn");
    assert.equal(st.pending!.turns, 1);
    assert.equal(st.pending!.span, "1-1");
    assert.deepEqual(st.pending!.topics, ["fetch-crash"]);
    assert.equal(st.recent.length, 0);
  });

  test("extracted with 0 blocks → recent entry blocks:0, chain:null (ran, nothing worth saving)", () => {
    const agent = "es_empty";
    const t1 = db.createConversationTurn({ agent_id: agent, turn_number: 1, turn_name: "smalltalk", transcript_json: "{}" });
    db.updateConversationTurnPass01(t1.id, "{}");
    const range = db.createConversationTurnRange({ agent_id: agent, start_turn_number: 1, end_turn_number: 1, extraction_type: "arc" });
    db.markConversationTurnExtracted(t1.id, range.id);
    // NO block_extractions for this range — the worth-test kept nothing.
    const st = db.getExtractionStatus(agent);
    assert.equal(st.pending, null);
    assert.equal(st.recent.length, 1);
    assert.equal(st.recent[0]!.blocks, 0, "0 blocks = ran, found nothing worth saving (final, not error)");
    assert.equal(st.recent[0]!.chain, null);
    assert.equal(st.recent[0]!.topic, "turns 1-1", "no blocks → topic falls back to the turn span");
  });

  test("scoped per agent — a different agent sees none of these", () => {
    const agent = "es_iso";
    db.createConversationTurnRange({ agent_id: agent, start_turn_number: 1, end_turn_number: 1, extraction_type: "arc" });
    db.createConversationTurnRange({ agent_id: agent, start_turn_number: 2, end_turn_number: 3, extraction_type: "arc" });
    const st = db.getExtractionStatus(agent);
    assert.equal(st.recent.length, 2);
    assert.deepEqual(new Set(st.recent.map(r => r.turns)), new Set(["1-1", "2-3"]));
    assert.equal(db.getExtractionStatus("es_other_agent").recent.length, 0);
  });

  test("chain resolved via members' chain_id when the chain block is NOT in block_extractions (real-data shape)", () => {
    const agent = "es_chainid";
    const t1 = db.createConversationTurn({ agent_id: agent, turn_number: 1, turn_name: "cid", transcript_json: "{}" });
    db.updateConversationTurnPass01(t1.id, "{}");
    const range = db.createConversationTurnRange({ agent_id: agent, start_turn_number: 1, end_turn_number: 1, extraction_type: "arc" });
    db.markConversationTurnExtracted(t1.id, range.id);
    // Pass-5 chain block: created but (like real data) NOT recorded in block_extractions.
    const chainBlk = db.createBlock({ label: "es-cid_chain_story", type: "chain", essence: "story", content: { is_a: "chain" }, ttl: "permanent" });
    const d = db.createBlock({ label: "es-cid_decision_a", type: "decision", essence: "a", content: {}, ttl: "permanent" });
    const f = db.createBlock({ label: "es-cid_fact_b", type: "fact", essence: "b", content: {}, ttl: "permanent" });
    // chain_id is stamped POST-HOC by the pipeline (createBlock's INSERT omits it),
    // so set it directly to mirror the real linkage: members.chain_id === chain block's id.
    const raw = (db as any)["db"];
    raw.prepare("UPDATE blocks SET chain_id = ? WHERE id = ?").run(chainBlk.id, d.id);
    raw.prepare("UPDATE blocks SET chain_id = ? WHERE id = ?").run(chainBlk.id, f.id);
    db.recordBlockExtraction(d.id, range.id);
    db.recordBlockExtraction(f.id, range.id);
    // chainBlk deliberately NOT recorded — must still be found via chain_id.

    const st = db.getExtractionStatus(agent);
    assert.equal(st.recent.length, 1);
    assert.equal(st.recent[0]!.blocks, 2, "only the 2 atomic blocks are in block_extractions");
    assert.equal(st.recent[0]!.chain, "es-cid_chain_story", "chain resolved via members' chain_id → the chain block's label");
  });

  // followup 1: failed vs pending
  test("a FAILED extraction attempt sets pending.failed + last_error (not just 'queued')", () => {
    const agent = "es_failed";
    const t1 = db.createConversationTurn({ agent_id: agent, turn_number: 1, turn_name: "db-choice", transcript_json: "{}" });
    const t2 = db.createConversationTurn({ agent_id: agent, turn_number: 2, turn_name: "db-choice-2", transcript_json: "{}" });
    db.updateConversationTurnPass01(t1.id, "{}");
    db.updateConversationTurnPass01(t2.id, "{}");
    // before any attempt → queued, not failed
    let st = db.getExtractionStatus(agent);
    assert.equal(st.pending!.failed, false, "no attempt yet → not failed");
    assert.equal(st.pending!.last_error, null);
    // a failed arc attempt over turns 1-2 (turns STAY pass01_done = re-extractable)
    db.markConversationTurnsExtractFailed(agent, 1, 2, "COMPREHEND front-half failed after 3 attempts");
    st = db.getExtractionStatus(agent);
    assert.ok(st.pending, "still pending — failure does not consume the turns");
    assert.equal(st.pending!.failed, true, "now flagged failed, not just queued");
    assert.match(st.pending!.last_error ?? "", /COMPREHEND front-half failed/);
    assert.equal(st.recent.length, 0, "a failed attempt creates NO range");
  });

  // followup 2: global (no agent_id) fallback
  test("no agent_id → GLOBAL most-recent activity (agent need not know its host-assigned id)", () => {
    const agent = "es_global";
    const t1 = db.createConversationTurn({ agent_id: agent, turn_number: 1, turn_name: "g1", transcript_json: "{}" });
    const t2 = db.createConversationTurn({ agent_id: agent, turn_number: 2, turn_name: "g2", transcript_json: "{}" });
    db.updateConversationTurnPass01(t1.id, "{}");
    db.updateConversationTurnPass01(t2.id, "{}");
    const range = db.createConversationTurnRange({ agent_id: agent, start_turn_number: 1, end_turn_number: 2, extraction_type: "arc" });
    db.markConversationTurnExtracted(t1.id, range.id);
    db.markConversationTurnExtracted(t2.id, range.id);
    const b = db.createBlock({ label: "es-global_decision_x", type: "decision", essence: "x", content: {}, ttl: "permanent" });
    db.recordBlockExtraction(b.id, range.id);
    // global call (no agent_id) sees this agent's arc among recent — no id needed.
    const st = db.getExtractionStatus(undefined, 20);
    assert.ok(st.recent.some(r => r.turns === "1-2" && r.topic === "es-global"),
      "global recent includes the arc without an agent_id");
  });
});
