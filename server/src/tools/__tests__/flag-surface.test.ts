import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import { WorkspaceDB } from "../../store/database.js";
import { writePipelineFlag, markFlagPendingClarification } from "../../middleware/reflect/pipeline-flags.js";
import { buildAgentFlagSurface, countAgentFlags, appendFlagNudge } from "../flag-surface.js";

// flag-surface is the PULL side of flag-resolution: routed (owner-unknown) flags
// reach the MCP agent via workspace_stats.flags, and a passive nudge rides on every
// tool result so the agent discovers them. These lock that contract: ONLY flags the
// reviewer ROUTED ('pending_clarification') surface — never raw pending ones — and
// the nudge appends without touching the data payload.

const TEST_DB = path.resolve("/tmp/flag_surface_test.db");
let db: WorkspaceDB;
let raw: Database.Database;

function cleanFiles() {
  for (const s of ["", "-wal", "-shm"]) {
    try { if (fs.existsSync(TEST_DB + s)) fs.unlinkSync(TEST_DB + s); } catch { /* ignore */ }
  }
}

function mkDecision(label: string, choice: string) {
  return db.createBlock({
    label, type: "decision", essence: `essence ${label}`,
    content: { unique: { choice } }, ttl: "permanent",
  });
}

/** Write a dup flag and route it to the agent (the reviewer's owner-unknown path). */
function routeFlag(aId: string, bId: string | null): string {
  const id = writePipelineFlag(raw, {
    flag_type: "cross_arc_dup_candidate", block_id_a: aId, block_id_b: bId,
    criteria: { decision: "flag_for_review" }, scope_check: "unknown",
    origin_writer: "stage_d_resolve", origin_range_id: null,
  });
  markFlagPendingClarification(raw, { flag_id: id, reason: "owner unknown — routed to agent" });
  return id;
}

before(async () => {
  cleanFiles();
  db = new WorkspaceDB(TEST_DB);
  await db.init();
  raw = (db as any)["db"] as Database.Database;
});
after(() => { try { (db as any)["db"]?.close(); } catch { /* ignore */ } cleanFiles(); });

beforeEach(() => {
  raw.pragma("foreign_keys = OFF");
  raw.exec(`DELETE FROM pipeline_flags`);
  raw.exec(`DELETE FROM relations`);
  raw.exec(`DELETE FROM blocks`);
  raw.pragma("foreign_keys = ON");
});

describe("buildAgentFlagSurface", () => {
  test("a ROUTED flag surfaces as a plain-English question with a count", () => {
    const owned  = mkDecision("customer-c_decision_redis", "use redis for sessions");
    const orphan = mkDecision("unspecified-project_decision_redis", "use redis for sessions");
    routeFlag(owned.id, orphan.id);

    const surface = buildAgentFlagSurface(db);
    assert.equal(surface.needs_your_input, 1);
    assert.equal(surface.items.length, 1);
    assert.match(surface.items[0]!.question, /same thing/i, "rendered as a plain question");
    // no ids/schema to fill — the agent only judges "same? whose?"
    assert.equal(typeof surface.items[0]!.id, "string");
    assert.ok(surface.items[0]!.you_are_recording);
  });

  test("a PENDING-but-not-routed flag does NOT surface (auto-reviewer's territory)", () => {
    const a = mkDecision("proj_decision_a", "choice a");
    const b = mkDecision("proj_decision_b", "choice b");
    // written, but NEVER markFlagPendingClarification → belongs to the autonomous reviewer
    writePipelineFlag(raw, {
      flag_type: "cross_arc_dup_candidate", block_id_a: a.id, block_id_b: b.id,
      criteria: {}, scope_check: "unknown", origin_writer: "stage_d_resolve", origin_range_id: null,
    });
    const surface = buildAgentFlagSurface(db);
    assert.equal(surface.needs_your_input, 0);
    assert.equal(surface.items.length, 0);
  });

  test("items are capped but the count reflects the full backlog", () => {
    for (let i = 0; i < 7; i++) {
      const a = mkDecision(`owner-${i}_decision_x`, `choice ${i}`);
      const o = mkDecision(`unspecified_decision_x_${i}`, `choice ${i}`);
      routeFlag(a.id, o.id);
    }
    const surface = buildAgentFlagSurface(db);
    assert.equal(surface.needs_your_input, 7, "count is the full backlog");
    assert.equal(surface.items.length, 5, "items are capped at the surface limit");
  });
});

describe("appendFlagNudge", () => {
  function fakeResult() {
    return { content: [{ type: "text" as const, text: JSON.stringify({ success: true, data: {} }) }] };
  }

  test("appends a one-line nudge when work is routed — as a SEPARATE content item", () => {
    const a = mkDecision("o_decision_x", "c"); const b = mkDecision("unspecified_decision_x", "c");
    routeFlag(a.id, b.id);
    const r = fakeResult();
    const before = r.content[0]!.text;
    appendFlagNudge(r, db, "workspace_get");
    assert.equal(r.content.length, 2, "added a separate text item");
    assert.equal(r.content[0]!.text, before, "the data payload is untouched");
    assert.match(r.content[1]!.text, /need.*your input/i);
    assert.match(r.content[1]!.text, /workspace_stats/);
  });

  test("no nudge when nothing is routed", () => {
    const r = fakeResult();
    appendFlagNudge(r, db, "workspace_get");
    assert.equal(r.content.length, 1);
  });

  test("no self-nudge on workspace_stats (it already carries the full surface)", () => {
    const a = mkDecision("o2_decision_x", "c"); const b = mkDecision("unspecified2_decision_x", "c");
    routeFlag(a.id, b.id);
    assert.equal(countAgentFlags(db), 1, "a flag IS routed");
    const r = fakeResult();
    appendFlagNudge(r, db, "workspace_stats");
    assert.equal(r.content.length, 1, "stats is skipped — no redundant nudge");
  });

  test("best-effort: never throws on a malformed/empty result", () => {
    assert.equal(appendFlagNudge(undefined, db, "x"), undefined);
    const weird = {} as any;
    assert.doesNotThrow(() => appendFlagNudge(weird, db, "x"));
  });
});
