/**
 * resolution-heal.test.ts — Fix 2: `resolves` + work-status self-heal.
 *
 * The zombie-task defect (whole-graph audit 2026-07-10): completed-by-later-work
 * tasks/blueprints never close. Guards the three repairs:
 *   1. normalizeWorkStatus — the open|in_progress|done vocabulary gate,
 *   2. applyResolvesStatusEffects — a pipeline-asserted resolves edge closes its
 *      open target (high confidence), idempotently, respecting human re-opens,
 *   3. sweepUnresolvedTasks — the low-confidence retro sweep FLAGS (routed to the
 *      agent), never auto-closes, and never touches excluded fixture labels.
 * Plus: both comprehend prompt copies teach resolves-for-task-completion.
 *
 * Run: node --import=tsx/esm --test src/middleware/reflect/__tests__/resolution-heal.test.ts
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import type Database from "better-sqlite3";
import { WorkspaceDB } from "../../../store/database.js";
import {
  normalizeWorkStatus,
  applyResolvesStatusEffects,
  sweepUnresolvedTasks,
} from "../resolution-heal.js";
import { getFlagsForBlock, ensurePipelineFlagsTable } from "../pipeline-flags.js";
import { COMPREHEND_PROMPT } from "../comprehend.js";
import { PRODUCE_PROMPT } from "../comprehend-pergroup.js";

const TEST_DB = "/tmp/wmcs_resolution_heal_test.db";
let db: WorkspaceDB;
let rawDb: Database.Database;

const uniqueOf = (id: string): Record<string, any> => {
  const b = db.getBlock(id)!;
  return (JSON.parse(String(b.content)).unique ?? {});
};
const hasOf = (id: string): Record<string, any> => {
  const b = db.getBlock(id)!;
  return (JSON.parse(String(b.content)).has ?? {});
};

before(async () => {
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  db = new WorkspaceDB(TEST_DB);
  await db.init();
  rawDb = (db as any).db as Database.Database;
});

after(() => {
  db.close();
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
});

describe("normalizeWorkStatus — the vocabulary gate", () => {
  test("done-family words normalize to done, silently", () => {
    for (const w of ["done", "Completed", "SHIPPED", "fixed", "merged "]) {
      assert.deepEqual(normalizeWorkStatus(w), { status: "done" }, `"${w}"`);
    }
  });
  test("in-progress-family words normalize to in_progress", () => {
    for (const w of ["wip", "In Progress", "in_progress", "started"]) {
      assert.deepEqual(normalizeWorkStatus(w), { status: "in_progress" }, `"${w}"`);
    }
  });
  test("open synonyms normalize silently (no note — they carry nothing extra)", () => {
    for (const w of ["open", "TODO", "pending", "proposed", "REQUIRED", "", undefined]) {
      assert.deepEqual(normalizeWorkStatus(w), { status: "open" }, `"${w}"`);
    }
  });
  test("free text maps to open and PRESERVES the original as note", () => {
    const r = normalizeWorkStatus("owed to the demo video before Friday");
    assert.equal(r.status, "open");
    assert.equal(r.note, "owed to the demo video before Friday", "meaning must never be silently destroyed");
  });
});

describe("applyResolvesStatusEffects — the high-confidence half", () => {
  test("a resolves edge onto an open task flips unique.status to done, with the audit trail", () => {
    const task = db.createBlock({
      label: "heal_task_ship-widget", type: "task", essence: "ship the widget",
      content: { unique: { status: "open", description: "ship it" } }, ttl: "permanent", status: "active",
    });
    const ev = db.createBlock({
      label: "heal_event_widget-shipped", type: "event", essence: "widget shipped to npm",
      content: { unique: { what_happened: "shipped" } }, ttl: "permanent", status: "active",
    });
    db.createRelation({ source_id: ev.id, target_id: task.id, type: "resolves", bidirectional: false });

    const r = applyResolvesStatusEffects(db);
    assert.equal(r.flipped.length, 1);
    assert.equal(r.flipped[0]!.target_label, "heal_task_ship-widget");
    assert.equal(uniqueOf(task.id).status, "done");
    assert.equal(hasOf(task.id).resolved_by, "heal_event_widget-shipped", "back-pointer to the resolver");
    const hist = rawDb.prepare(
      `SELECT changed_by FROM block_history WHERE block_id = ? AND field_changed = 'content' ORDER BY changed_at DESC LIMIT 1`,
    ).get(task.id) as { changed_by: string };
    assert.equal(hist.changed_by, "pipeline_resolution_heal", "history carries who healed it");
  });

  test("idempotent: a second run flips nothing", () => {
    const r = applyResolvesStatusEffects(db);
    assert.equal(r.flipped.length, 0);
    assert.ok(r.skipped_already_done >= 1);
  });

  test("a human re-open is respected — never re-flipped", () => {
    const task = db.getBlock("heal_task_ship-widget")!;
    const content = JSON.parse(String(task.content));
    content.unique.status = "open"; // human re-opens; has.resolved_by stamp remains
    db.updateBlock(task.id, { content }, "human re-opened", "user");
    const r = applyResolvesStatusEffects(db);
    assert.equal(r.flipped.length, 0);
    assert.ok(r.skipped_reopened >= 1, "the stamp blocks a re-flip — the human's call wins");
    assert.equal(uniqueOf(task.id).status, "open", "stays open");
  });

  test("blueprints flip too; non-resolvable targets and archived blocks are untouched", () => {
    const bp = db.createBlock({
      label: "heal_blueprint_signs", type: "blueprint", essence: "build the sign engine",
      content: { unique: { purpose: "signs", status: "proposed" } }, ttl: "permanent", status: "active",
    });
    const fact = db.createBlock({
      label: "heal_fact_untouchable", type: "fact", essence: "a fact",
      content: { unique: { value: "x" } }, ttl: "permanent", status: "active",
    });
    const done = db.createBlock({
      label: "heal_decision_signs-built", type: "decision", essence: "sign engine built + verified",
      content: { unique: { choice: "built" } }, ttl: "permanent", status: "active",
    });
    db.createRelation({ source_id: done.id, target_id: bp.id, type: "resolves", bidirectional: false });
    db.createRelation({ source_id: done.id, target_id: fact.id, type: "resolves", bidirectional: false });

    const archTask = db.createBlock({
      label: "heal_task_archived", type: "task", essence: "old task",
      content: { unique: { status: "open", description: "old" } }, ttl: "permanent", status: "active",
    });
    db.createRelation({ source_id: done.id, target_id: archTask.id, type: "resolves", bidirectional: false });
    db.archiveBlock(archTask.id, "test");

    const r = applyResolvesStatusEffects(db);
    assert.deepEqual(r.flipped.map((f) => f.target_label), ["heal_blueprint_signs"]);
    assert.equal(uniqueOf(bp.id).status, "done");
    assert.equal(uniqueOf(fact.id).status, undefined, "facts carry no work status — untouched");
  });
});

describe("sweepUnresolvedTasks — the low-confidence half (flags, never closes)", () => {
  let zombie: { id: string };
  let completion: { id: string };

  before(() => {
    ensurePipelineFlagsTable(rawDb);
    zombie = db.createBlock({
      label: "sweep_task_zombie", type: "task", essence: "wire the export index",
      content: { unique: { status: "open", description: "wire it" } }, ttl: "permanent", status: "active",
    });
    completion = db.createBlock({
      label: "sweep_event_index-wired", type: "event", essence: "export index wired and verified",
      content: { unique: { what_happened: "wired" } }, ttl: "permanent", status: "active",
    });
    // the sweep's signal is "completion came AFTER the task" — same-millisecond fixture
    // rows would defeat the > guard, so date the completion explicitly later
    rawDb.prepare(`UPDATE blocks SET created_at = ? WHERE id = ?`)
      .run(new Date(Date.now() + 60_000).toISOString(), completion.id);
    // the audit's exact shape: completion linked based_on, NOT resolves
    db.createRelation({ source_id: completion.id, target_id: zombie.id, type: "based_on", bidirectional: false });
  });

  test("dry run (the default) reports the candidate and writes NOTHING", () => {
    const r = sweepUnresolvedTasks(db);
    assert.equal(r.dry_run, true);
    const hit = r.flagged.find((f) => f.task_label === "sweep_task_zombie");
    assert.ok(hit, "zombie found via its newer completion-shaped neighbor");
    assert.equal(hit!.candidate_label, "sweep_event_index-wired");
    assert.equal(hit!.flag_id, null, "dry run mints no flag");
    assert.equal(getFlagsForBlock(rawDb, zombie.id).length, 0, "no rows written");
  });

  test("write mode emits ONE resolution_pending flag, routed to the agent — status untouched", () => {
    const r = sweepUnresolvedTasks(db, { dry_run: false });
    const hit = r.flagged.find((f) => f.task_label === "sweep_task_zombie");
    assert.ok(hit?.flag_id, "flag written");
    const flags = getFlagsForBlock(rawDb, zombie.id);
    assert.equal(flags.length, 1);
    assert.equal(flags[0]!.flag_type, "resolution_pending");
    assert.equal(flags[0]!.review_verdict, "pending_clarification", "routed straight to the agent/user");
    assert.equal(flags[0]!.reviewed_at, null, "still open for the agent's real verdict");
    assert.equal(uniqueOf(zombie.id).status, "open", "NEVER auto-closed");
    // idempotent across runs: the unreviewed flag suppresses a duplicate
    const r2 = sweepUnresolvedTasks(db, { dry_run: false });
    assert.ok(r2.skipped_existing_flag >= 1);
    assert.equal(getFlagsForBlock(rawDb, zombie.id).length, 1, "no flag stacking");
  });

  test("supersede-twin (observed live 07-10): an open task with an incoming supersedes edge is flagged", () => {
    const oldTask = db.createBlock({
      label: "sweep_task_superseded-open", type: "task", essence: "add the export alert",
      content: { unique: { status: "open", description: "add it" } }, ttl: "permanent", status: "active",
    });
    const twin = db.createBlock({
      label: "sweep_task_alert-complete-twin", type: "task", essence: "export alert task marked complete",
      content: { unique: { status: "done", what_happened: "alert complete" } }, ttl: "permanent", status: "active",
    });
    // same-timestamp is fine here — the supersedes edge is the EXPLICIT signal
    db.createRelation({ source_id: twin.id, target_id: oldTask.id, type: "supersedes", bidirectional: false });
    const r = sweepUnresolvedTasks(db);
    const hit = r.flagged.find((f) => f.task_label === "sweep_task_superseded-open");
    assert.ok(hit, "superseded-but-still-open must be caught without any created_at requirement");
    assert.equal(hit!.candidate_label, "sweep_task_alert-complete-twin", "the superseder IS the candidate");
  });

  test("exclude_labels protects fixtures; items with no newer completion neighbor stay silent", () => {
    const r = sweepUnresolvedTasks(db, { dry_run: true, exclude_labels: ["sweep_task_zombie"] });
    assert.ok(r.excluded >= 1);
    assert.equal(r.flagged.find((f) => f.task_label === "sweep_task_zombie"), undefined);

    const lonely = db.createBlock({
      label: "sweep_task_lonely", type: "task", essence: "no neighbors",
      content: { unique: { status: "open", description: "alone" } }, ttl: "permanent", status: "active",
    });
    const r2 = sweepUnresolvedTasks(db);
    assert.equal(r2.flagged.find((f) => f.task_label === "sweep_task_lonely"), undefined, "no candidate → no flag");
    void lonely;
  });
});

describe("the prompts teach resolves-for-completion (both copies, no drift)", () => {
  for (const [name, prompt] of Object.entries({ COMPREHEND_PROMPT, PRODUCE_PROMPT })) {
    test(`${name} scopes resolves to questions AND tasks/blueprints`, () => {
      assert.match(prompt, /resolves\s+—\s+from answers the open question to, OR completes the open task/,
        `${name} must teach completion, not only question-answering`);
      assert.match(prompt, /completion wired only as based_on leaves the item looking forever open/,
        `${name} must name the zombie trap at the moment of linking`);
    });
  }
});
