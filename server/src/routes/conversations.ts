// routes/conversations.ts — DEBT 5 Phase 7 trigger path: API endpoint
//
// POST /api/conversations/:agent_id/extract  — fires arc extraction over a range
// GET  /api/conversations                     — list all known agent_ids (turn counts + extraction state)
// GET  /api/conversations/:agent_id           — turn count + last activity + extraction state
// GET  /api/conversations/:agent_id/turns     — list turns for an agent (with optional range/status filters)
//
// Design anchors:
//   docs/DEBT5-ATOMIC-AND-ARC-EXTRACTION.md §3.1 (three trigger paths)
//                                          §3.5 (idempotency + rate-limit + minimum range — handled here in Phase 7)
//   docs/DEBT5-INVENTORY-MAP.md §2 (no collision with existing endpoints)
//
// NOTE on rate-limit + idempotency: Phase 8 will add a shared backend handler
// that ALL three trigger paths route through (phase tag + MCP tool + API).
// For Phase 7's first slice, the handler logic is inlined here as a no-op
// placeholder — runArcExtraction itself is the only safety net. Phase 8
// hardens this.

import { Router } from "express";
import type { WorkspaceDB } from "../store/database.js";
import { runArcExtraction, type ArcTriggerSource } from "../middleware/reflect/arc-pipeline.js";

const ALLOWED_TRIGGER_SOURCES: ArcTriggerSource[] = [
  "phase_tag",
  "mcp_tool",
  "api",
  "precompact",
  "inactivity",
];

export function createConversationsRouter(db: WorkspaceDB): Router {
  const router = Router();

  // ─── POST /api/conversations/:agent_id/extract ────────────────────────────
  // Fire arc extraction over a range of pass01_done turns.
  //
  // Body: { start_turn?, end_turn?, re_extract?, trigger_source? }
  //   - start_turn / end_turn: optional range bounds. Default = all pass01_done.
  //   - re_extract: boolean, default false. When true, creates 're-extract'
  //     range (vs 'arc') so the extraction event is auditable as intentional.
  //   - trigger_source: 'api' (default), or one of phase_tag/mcp_tool/
  //     precompact/inactivity when the caller is a hook/safety-net wrapper.
  //
  // Returns: 200 { range_id, turns_consumed, status, start_turn, end_turn,
  //                reflect_result: { saved, updated, saved_labels, ... } }
  //         400 on invalid body
  //         404 when no pass01_done turns exist for agent_id (status='no_turns')
  //         500 on pipeline error (status='pipeline_failed')
  router.post("/api/conversations/:agent_id/extract", async (req, res) => {
    const agent_id = req.params.agent_id;
    if (!agent_id) {
      return res.status(400).json({ error: "agent_id is required in path" });
    }

    const body = (req.body ?? {}) as any;
    const start_turn = body.start_turn !== undefined ? Number(body.start_turn) : undefined;
    const end_turn   = body.end_turn   !== undefined ? Number(body.end_turn)   : undefined;
    const re_extract = body.re_extract === true;
    const trigger_source: ArcTriggerSource =
      ALLOWED_TRIGGER_SOURCES.includes(body.trigger_source) ? body.trigger_source : "api";

    if (start_turn !== undefined && !Number.isFinite(start_turn)) {
      return res.status(400).json({ error: "start_turn must be a number" });
    }
    if (end_turn !== undefined && !Number.isFinite(end_turn)) {
      return res.status(400).json({ error: "end_turn must be a number" });
    }
    if (start_turn !== undefined && end_turn !== undefined && end_turn < start_turn) {
      return res.status(400).json({ error: `end_turn (${end_turn}) cannot be less than start_turn (${start_turn})` });
    }

    try {
      const result = await runArcExtraction(db, {
        agent_id,
        start_turn,
        end_turn,
        re_extract,
        trigger_source,
      });

      if (result.status === "no_turns") {
        // 404 is honest — there's nothing to extract for this scope.
        return res.status(404).json({ ...result, message: "No pass01_done turns in range" });
      }
      if (result.status === "pipeline_failed") {
        return res.status(500).json(result);
      }
      if (result.status === "pipeline_incomplete") {
        // Extraction didn't complete after the retry budget, but the turns are LEFT
        // re-extractable (no silent loss). 503 = honest "retry later".
        return res.status(503).json({ ...result, message: "Extraction incomplete after retries — turns left re-extractable; retry later" });
      }
      return res.status(200).json(result);
    } catch (e: any) {
      return res.status(500).json({ error: `arc-extract failed: ${e?.message ?? e}` });
    }
  });

  // ─── GET /api/conversations/:agent_id/turns ───────────────────────────────
  // List turns for an agent. Useful for debugging + future arc-status UI.
  //   ?status=captured|pass01_done|extracted  (optional)
  //   ?min_turn=N  ?max_turn=N                 (optional)
  router.get("/api/conversations/:agent_id/turns", (req, res) => {
    const agent_id = req.params.agent_id;
    if (!agent_id) return res.status(400).json({ error: "agent_id is required in path" });

    const status = req.query.status as any;
    const minTurn = req.query.min_turn !== undefined ? Number(req.query.min_turn) : undefined;
    const maxTurn = req.query.max_turn !== undefined ? Number(req.query.max_turn) : undefined;

    const allowedStatus = ["captured", "pass01_done", "extracted"];
    if (status !== undefined && !allowedStatus.includes(status)) {
      return res.status(400).json({ error: `status must be one of: ${allowedStatus.join(", ")}` });
    }
    if (minTurn !== undefined && !Number.isFinite(minTurn)) return res.status(400).json({ error: "min_turn must be a number" });
    if (maxTurn !== undefined && !Number.isFinite(maxTurn)) return res.status(400).json({ error: "max_turn must be a number" });

    const turns = db.listConversationTurnsByAgent(agent_id, {
      status: status ?? undefined,
      minTurn,
      maxTurn,
    });
    return res.json({ agent_id, count: turns.length, turns });
  });

  // ─── GET /api/conversations/:agent_id ─────────────────────────────────────
  // Summary: turn count + status breakdown + last activity.
  router.get("/api/conversations/:agent_id", (req, res) => {
    const agent_id = req.params.agent_id;
    if (!agent_id) return res.status(400).json({ error: "agent_id is required in path" });

    const all = db.listConversationTurnsByAgent(agent_id);
    if (all.length === 0) return res.status(404).json({ agent_id, error: "no turns recorded for this agent" });

    const statusBreakdown = { captured: 0, pass01_done: 0, extracted: 0 };
    for (const t of all) statusBreakdown[t.status as keyof typeof statusBreakdown]++;
    const lastTurn = all[all.length - 1]!;
    return res.json({
      agent_id,
      total_turns: all.length,
      status_breakdown: statusBreakdown,
      first_turn_number: all[0]!.turn_number,
      last_turn_number: lastTurn.turn_number,
      last_turn_at: lastTurn.created_at,
    });
  });

  return router;
}
