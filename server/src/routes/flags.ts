// routes/flags.ts — pipeline_flags inspection + manual review override.
//
// DEBT 5 Slice 2 Sub-step 2.4. Surfaces the pipeline_flags table (written by
// Stage FLAG in Slice 1 + Stage AUDIT in Sub-step 2.3, consumed by the async
// reviewer in Sub-step 2.2) so a human/agent can inspect the enrichment-cycle
// queue without waiting for the async worker — AND manually override a verdict.
//
// Pattern reference: routes/quarantine.ts (read-only list/summary/:id). This
// adds ONE write path: POST /api/flags/:id/review for manual operator override.
//
// Visibility contract (matches quarantine): flags do NOT leak into /api/blocks,
// /api/tree, /api/search. These /api/flags/* routes ARE the explicit opt-in
// inspection surface.
//
// Endpoints:
//   GET  /api/flags                — list (filters: flag_type, origin_writer,
//                                    reviewed=true|false, block_id, limit)
//   GET  /api/flags/summary        — counts (total, unreviewed, by_type, by_writer)
//   GET  /api/flags/:id            — single flag + both blocks embedded
//   POST /api/flags/:id/review     — manual override { verdict, reason,
//                                    execute?, winning_block_id? }

import { Router } from "express";
import type Database from "better-sqlite3";
import { WorkspaceDB } from "../store/database.js";
import {
  ensurePipelineFlagsTable,
  listFlags,
  getFlagById,
  getAgentPendingFlags,
  summarizePipelineFlags,
  type ListFlagsOpts,
} from "../middleware/reflect/pipeline-flags.js";
import { loadBlockSnapshot } from "../middleware/reflect/flag-reviewer.js";
import { applyFlagVerdict } from "../middleware/reflect/apply-flag-verdict.js";
import { renderAgentFlag } from "../middleware/reflect/render-agent-flag.js";
import type { PipelineFlagType, PipelineFlagWriter, ReviewVerdict } from "../middleware/reflect/types.js";

export function createFlagsRouter(db: WorkspaceDB): Router {
  const router = Router();
  const raw = (db as any)["db"] as Database.Database;

  // Idempotent — guarantees reads succeed even on a DB that never wrote a flag
  // (table comes back empty). CREATE IF NOT EXISTS, safe to call once here.
  ensurePipelineFlagsTable(raw);

  // ─── Summary (declare BEFORE /:id so "summary" isn't captured as an id) ─────
  router.get("/api/flags/summary", (_req, res) => {
    try {
      res.json(summarizePipelineFlags(raw));
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  // ─── Agent-pending (owner-unknown flags routed to the agent) ─────────────────
  // Owner-unknown flags the reviewer refused to guess (Part 3) surface here as
  // PLAIN-ENGLISH questions. The agent resolves from context or asks the user, then
  // applies via POST /api/flags/:id/review. Declared BEFORE /:id. The context hook
  // injects these each turn (the uncertain_references pattern).
  router.get("/api/flags/agent-pending", (req, res) => {
    try {
      let limit = 20;
      if (typeof req.query.limit === "string") {
        const n = parseInt(req.query.limit, 10);
        if (Number.isFinite(n) && n > 0) limit = n;
      }
      const flags = getAgentPendingFlags(raw, { limit });
      const rendered = flags.map(f => renderAgentFlag(raw, f)).filter(Boolean);
      res.json({ count: rendered.length, flags: rendered });
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  // ─── List (filtered) ────────────────────────────────────────────────────────
  router.get("/api/flags", (req, res) => {
    try {
      const opts: ListFlagsOpts = {};
      if (typeof req.query.flag_type === "string")     opts.flag_type = req.query.flag_type as PipelineFlagType;
      if (typeof req.query.origin_writer === "string") opts.origin_writer = req.query.origin_writer as PipelineFlagWriter;
      if (typeof req.query.block_id === "string")      opts.block_id = req.query.block_id;
      if (typeof req.query.reviewed === "string")      opts.reviewed = req.query.reviewed === "true";
      if (typeof req.query.limit === "string") {
        const n = parseInt(req.query.limit, 10);
        if (Number.isFinite(n) && n > 0) opts.limit = n;
      }
      const flags = listFlags(raw, opts);
      res.json({ count: flags.length, flags });
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  // ─── Single entry (flag + both blocks embedded for context) ──────────────────
  router.get("/api/flags/:id", (req, res) => {
    try {
      const flag = getFlagById(raw, req.params.id);
      if (!flag) return res.status(404).json({ error: `no flag ${req.params.id}` });
      res.json({
        flag,
        block_a: loadBlockSnapshot(raw, flag.block_id_a),
        block_b: flag.block_id_b ? loadBlockSnapshot(raw, flag.block_id_b) : null,
      });
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  // ─── Manual review override ───────────────────────────────────────────────────
  // Body: { verdict, reason, execute?, winning_block_id? }
  //   execute=true + verdict='merge' → run executeMerge synchronously
  //     (archive loser + wire supersedes). winning_block_id REQUIRED + must be
  //     one of the flag's two blocks.
  //   execute=false / omitted → write verdict only, no graph mutation.
  // 404 if flag already reviewed (don't silently re-review; the operator must
  // see the existing verdict first).
  router.post("/api/flags/:id/review", (req, res) => {
    try {
      const flag = getFlagById(raw, req.params.id);
      if (!flag) return res.status(404).json({ error: `no flag ${req.params.id}` });
      if (flag.reviewed_at) {
        return res.status(409).json({
          error: `flag ${req.params.id} already reviewed`,
          existing_verdict: flag.review_verdict,
          reviewed_at: flag.reviewed_at,
        });
      }

      const body = req.body ?? {};
      const verdict = body.verdict as ReviewVerdict;
      const reason = typeof body.reason === "string" ? body.reason : "";
      const execute = body.execute === true;
      const winning_block_id = typeof body.winning_block_id === "string" ? body.winning_block_id : null;

      // Shared mechanics with the NL accept-path (apply-flag-verdict.ts) — one
      // validation + merge implementation, so the two surfaces can't diverge.
      const result = applyFlagVerdict(db, flag, { verdict, reason, execute, winning_block_id });
      if (!result.ok) {
        // MERGE_FAILED is a server-side failure; everything else is a bad request.
        const status =
          result.code === "MERGE_FAILED" ? 500 :
          result.code === "ALREADY_REVIEWED" ? 409 : 400;
        return res.status(status).json({ error: result.message });
      }

      res.json({
        ok: true,
        flag_id: flag.id,
        verdict,
        action_taken: result.action_taken,
        winning_block_id: result.winning_block_id,
      });
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  return router;
}
