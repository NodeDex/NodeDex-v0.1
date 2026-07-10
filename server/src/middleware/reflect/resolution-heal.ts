// resolution-heal.ts — Fix 2: `resolves` + work-status self-heal (2026-07-10).
//
// THE DEFECT (whole-graph audit 07-10, replicated live in the dogfood graph): tasks and
// blueprints go ZOMBIE — completed by later work but never closed. Three stacked causes:
//   1. completions get linked based_on/related_to instead of `resolves` (a teaching gap —
//      the comprehend prompt scoped `resolves` to "answers the open question"; fixed in
//      comprehend-pergroup.ts alongside this module);
//   2. nothing APPLIED a resolves edge even when it existed (8 resolves edges in the
//      dogfood graph, zero status changes) — this module is that application;
//   3. extraction writes free-text status ("REQUIRED", whole sentences) that nothing
//      normalizes — normalizeWorkStatus below is the vocabulary gate.
//
// CONFIDENCE MODEL (mirrors the supersede stance: correct-never-delete, wrong auto-close
// is worse than a zombie):
//   • PIPELINE-ASSERTED resolves edge (the LLM explicitly claimed "this completes that")
//     → HIGH confidence → flip unique.status to 'done', with full block_history audit
//       trail + has.resolved_by back-pointer. Idempotent; a human re-open is respected.
//   • SWEEP-INFERRED (an open item merely has a newer completion-shaped neighbor)
//     → LOW confidence → a `resolution_pending` flag routed STRAIGHT to the agent/user
//       (pending_clarification), never auto-closed, never auto-judged by the reviewer.
//
// The BLOCK COLUMN status (active/archived lifecycle) is never touched here — the work
// status lives in content.unique.status, which is what the audit found rotting.

import type { WorkspaceDB } from "../../store/database.js";
import type Database from "better-sqlite3";
import {
  writePipelineFlag,
  markFlagPendingClarification,
  getFlagsForBlock,
} from "./pipeline-flags.js";

/** Types whose unique{} carries a work status a resolves edge can close. */
const RESOLVABLE_TYPES = new Set(["task", "blueprint"]);

/** Types that plausibly REPORT completed work (the sweep's low-confidence signal). */
const COMPLETION_SHAPED_TYPES = new Set(["event", "decision", "fact"]);

export type WorkStatus = "open" | "in_progress" | "done";

const DONE_WORDS = new Set([
  "done", "complete", "completed", "finished", "shipped", "fixed", "resolved",
  "closed", "merged", "deployed", "landed", "implemented",
]);
const IN_PROGRESS_WORDS = new Set([
  "in_progress", "in-progress", "in progress", "wip", "started", "ongoing",
  "underway", "building", "active",
]);
// Open-synonyms that carry no extra information — normalized silently (no note kept).
const OPEN_WORDS = new Set([
  "open", "todo", "to-do", "pending", "proposed", "planned", "required",
  "needed", "owed", "blocked", "not started", "unstarted", "",
]);

/**
 * Normalize a free-text work status to the enforced vocabulary open|in_progress|done.
 * Anything unrecognized maps to 'open' (the safe default for a work item) and the
 * original text is returned as `note` so no meaning is silently destroyed — the saver
 * stashes it in has.status_note. Pure / testable.
 */
export function normalizeWorkStatus(raw: unknown): { status: WorkStatus; note?: string } {
  const t = String(raw ?? "").trim().toLowerCase();
  if (DONE_WORDS.has(t)) return { status: "done" };
  if (IN_PROGRESS_WORDS.has(t)) return { status: "in_progress" };
  if (OPEN_WORDS.has(t)) return { status: "open" };
  // Unrecognized ("REQUIRED by the demo", a whole sentence…) → open + preserve the text.
  return { status: "open", note: String(raw ?? "").trim() };
}

/** Parse a block's content JSON, tolerating malformed rows (returns {}). */
function parseContent(raw: unknown): Record<string, any> {
  if (raw && typeof raw === "object") return raw as Record<string, any>;
  try { return JSON.parse(String(raw ?? "{}")) ?? {}; } catch { return {}; }
}

export interface ResolvesHealResult {
  scanned_edges: number;
  flipped: Array<{ target_label: string; resolved_by: string }>;
  skipped_already_done: number;
  skipped_reopened: number;
}

/**
 * HIGH-CONFIDENCE half: apply every `resolves` edge whose target is an open
 * task/blueprint — flip its unique.status to 'done'.
 *
 * Full-scan on purpose (not "this batch's edges"): idempotent, order-independent,
 * and it catches resolves edges from EVERY writer (comprehend link-intent, Pass 4
 * existing-graph wiring, cross-group linker) without threading block-id lists through
 * three call sites. Cost is trivial (resolves edges are rare — 8 in an 810-block graph).
 *
 * Re-open guard: a flip stamps has.resolved_by; if a human later re-opens the task
 * (status back to open) the stamp remains and we never re-flip — the human's call wins.
 */
export function applyResolvesStatusEffects(db: WorkspaceDB): ResolvesHealResult {
  const result: ResolvesHealResult = {
    scanned_edges: 0, flipped: [], skipped_already_done: 0, skipped_reopened: 0,
  };
  const resolves = db.getAllRelations().filter((r: any) => r.type === "resolves");
  result.scanned_edges = resolves.length;

  for (const rel of resolves as Array<{ source_id: string; target_id: string }>) {
    const target = db.getBlock(rel.target_id);
    if (!target || target.status === "archived" || !RESOLVABLE_TYPES.has(target.type)) continue;

    const content = parseContent(target.content);
    const unique = (content.unique ?? {}) as Record<string, unknown>;
    if (normalizeWorkStatus(unique.status).status === "done") { result.skipped_already_done++; continue; }
    if (content.has?.resolved_by) { result.skipped_reopened++; continue; } // healed before, human re-opened

    const source = db.getBlock(rel.source_id);
    if (!source || source.status === "archived") continue;

    content.unique = { ...unique, status: "done" };
    content.has = {
      ...(content.has ?? {}),
      resolved_by: source.label,
      resolved_at: new Date().toISOString(),
    };
    db.updateBlock(
      target.id,
      { content },
      `status → done: resolved by "${source.label}" (resolves edge)`,
      "pipeline_resolution_heal",
    );
    result.flipped.push({ target_label: target.label, resolved_by: source.label });
    console.log(`[resolution-heal] ${target.type} "${target.label}" → done (resolves ← "${source.label}")`);
  }
  return result;
}

export interface SweepOpts {
  /** Default TRUE — a dry run reports candidates and writes nothing. */
  dry_run?: boolean;
  /** Labels never flagged (e.g. a fixture task an experiment depends on). */
  exclude_labels?: string[];
}

export interface SweepResult {
  dry_run: boolean;
  scanned_open_items: number;
  flagged: Array<{ task_label: string; candidate_label: string; flag_id: string | null }>;
  skipped_existing_flag: number;
  excluded: number;
}

/**
 * LOW-CONFIDENCE half (the one-time retro sweep): for every open task/blueprint, look
 * for a NEWER completion-shaped neighbor (event/decision/fact one causal hop away) and
 * emit a `resolution_pending` flag routed straight to the agent/user — NEVER auto-close.
 * This is exactly the shape the 07-10 audit found: completions linked based_on/
 * related_to sitting next to zombie-open tasks.
 */
export function sweepUnresolvedTasks(db: WorkspaceDB, opts: SweepOpts = {}): SweepResult {
  const dryRun = opts.dry_run !== false; // default true — writing is the explicit choice
  const exclude = new Set(opts.exclude_labels ?? []);
  const rawDb = (db as any).db as Database.Database;
  const result: SweepResult = {
    dry_run: dryRun, scanned_open_items: 0, flagged: [], skipped_existing_flag: 0, excluded: 0,
  };

  const all = db.getAllBlocks(); // active working set (archived excluded by design)
  const byId = new Map(all.map((b) => [b.id, b]));
  const rels = db.getAllRelations() as Array<{ source_id: string; target_id: string; type: string }>;

  for (const item of all) {
    if (!RESOLVABLE_TYPES.has(item.type)) continue;
    const content = parseContent(item.content);
    if (normalizeWorkStatus((content.unique ?? {}).status).status === "done") continue;
    if (exclude.has(item.label)) { result.excluded++; continue; }
    result.scanned_open_items++;

    // Newest completion-shaped neighbor one causal hop away, created after the item.
    let candidate: (typeof all)[number] | null = null;
    for (const r of rels) {
      const otherId = r.source_id === item.id ? r.target_id : r.target_id === item.id ? r.source_id : null;
      if (!otherId) continue;
      const other = byId.get(otherId);
      if (!other || !COMPLETION_SHAPED_TYPES.has(other.type)) continue;
      if (String(other.created_at) <= String(item.created_at)) continue;
      if (!candidate || String(other.created_at) > String(candidate.created_at)) candidate = other;
    }
    if (!candidate) continue;

    // One unresolved flag per item — don't stack duplicates across sweep runs.
    const existing = getFlagsForBlock(rawDb, item.id)
      .some((f) => f.flag_type === "resolution_pending" && !f.reviewed_at);
    if (existing) { result.skipped_existing_flag++; continue; }

    let flagId: string | null = null;
    if (!dryRun) {
      flagId = writePipelineFlag(rawDb, {
        flag_type: "resolution_pending",
        block_id_a: item.id,
        block_id_b: candidate.id,
        criteria: {
          question: `Open ${item.type} "${item.label}" (${(content.unique ?? {}).status ?? "?"}) has a newer ${candidate.type} neighbor "${candidate.label}" — did that work resolve it?`,
          item_essence: item.essence,
          candidate_essence: candidate.essence,
          candidate_created_at: candidate.created_at,
        },
        scope_check: item.project_id && item.project_id === candidate.project_id ? "same" : "unknown",
        origin_writer: "resolution_sweep",
        origin_range_id: null,
      });
      // Route straight to the agent/user: resolution is a judgment about REALITY
      // (did the work actually complete the item?) — the autonomous dup-reviewer
      // has no basis to decide it. pending_clarification keeps it out of that
      // reviewer's queue and inside workspace_stats' "needs your input" surface.
      markFlagPendingClarification(rawDb, {
        flag_id: flagId,
        reason: "resolution is a reality judgment — agent/user confirms, never auto-closed",
      });
    }
    result.flagged.push({ task_label: item.label, candidate_label: candidate.label, flag_id: flagId });
  }
  return result;
}
