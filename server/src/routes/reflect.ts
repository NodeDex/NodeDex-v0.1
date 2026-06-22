// routes/reflect.ts — reflect pipeline routes.
// Reference: api-server.v1.ts (lines 2894-3115)

import { Router } from "express";
import { v4 as uuidv4 } from "uuid";
import { WorkspaceDB } from "../store/database.js";
import { EmbeddingEngine } from "../engine/embeddings.js";
import { reflectTokenStats } from "../middleware/auto-reflect.js";
import {
  reflectQueue, reflectProcessing, reflectFlushGeneration, reflectPaused, spendPaused,
  setReflectPaused, setSpendPaused, setReflectFlushGeneration,
  processReflectQueue, resolveStateLabel, enqueueReflectTurn,
} from "./state.js";
import { clearSpendPauseFile, readSpendPauseReason } from "../middleware/reflect/cost-guard.js";
import { clearTurnLogs } from "../middleware/reflect/pipeline.js";

export function createReflectRouter(db: WorkspaceDB, embeddings?: EmbeddingEngine): Router {
  const router = Router();

  // ─── Auto-reflect: update agent_session_state with live summary ───
  router.post("/api/reflect", (req, res) => {
    try {
      const body = req.body as any;
      const agentId = (body?.agent_id as string) || undefined;
      const stateLabel = resolveStateLabel(agentId);

      // Drop hook-fired calls when paused (benchmark isolation mode).
      if (reflectPaused) {
        console.log("[reflect] dropped (paused)");
        return res.json({ reflected: false, reason: "paused" });
      }

      // Auto-register agent heartbeat if agent_id provided
      if (agentId) db.registerAgent(agentId);

      // ── Atomic rate-gate: stamp last_reflected immediately, reject duplicates ──
      const REFLECT_DEBOUNCE_MS = 5000;
      const stateBlockEarly = db.getBlock(stateLabel);
      if (stateBlockEarly) {
        let earlyContent: Record<string, unknown> = {};
        try { earlyContent = JSON.parse(stateBlockEarly.content as string); } catch { /* */ }
        const lastRefl = earlyContent.last_reflected as string | undefined;
        if (lastRefl && Date.now() - new Date(lastRefl).getTime() < REFLECT_DEBOUNCE_MS) {
          return res.status(429).json({ skipped: true, reason: "debounce" });
        }
        // Stamp immediately — any concurrent hook that arrives now will see this and 429
        earlyContent.last_reflected = new Date().toISOString();
        db.updateBlock(stateLabel, { content: JSON.stringify(earlyContent) }, "auto-reflect", agentId);
      }

      const windowHours = Number(body?.window_hours) || 24;
      const cutoff = new Date(Date.now() - windowHours * 60 * 60 * 1000).toISOString();
      const allBlocks = db.getAllBlocks();
      const stats = db.getStats() as any;

      const newBlocks = allBlocks
        .filter((b) => b.created_at >= cutoff)
        .sort((a, b) => b.created_at.localeCompare(a.created_at));

      const projects = allBlocks.filter((b) => b.type === "project" && b.status !== "archived");

      const openTasks = allBlocks.filter((b) => {
        if (b.type !== "task" || b.status === "archived") return false;
        try {
          const taskStatus = JSON.parse(b.content as string)?.unique?.status;
          return taskStatus !== "done";
        } catch { return true; }
      });

      const summary = [
        `total=${stats.total_blocks}`,
        `projects=${projects.map((p) => p.label).join(",") || "none"}`,
        `open_tasks=${openTasks.map((t) => t.label).join(",") || "none"}`,
        newBlocks.length > 0
          ? `recent=${newBlocks.slice(0, 8).map((b) => b.label).join(",")}`
          : "no_new_blocks",
      ].join(" | ");

      const stateBlock = db.getBlock(stateLabel);
      if (stateBlock) {
        let content: Record<string, unknown> = {};
        try { content = JSON.parse(stateBlock.content as string); } catch { /* */ }
        content.summary = summary;
        content.open_tasks = openTasks.map((t) => t.label);
        content.active_projects = projects.map((p) => p.label);
        content.recent_blocks = newBlocks.slice(0, 10).map((b) => b.label);
        db.updateBlock(stateLabel, { content: JSON.stringify(content) }, "auto-reflect", agentId);
      }

      // ── Gemini Reasoning Compiler: enqueue for sequential processing ────
      const agentResponseText = (body?.agent_response as string) || "";
      const userMessageText = (body?.user_message as string) || "";
      const agentThinkingText = (body?.agent_thinking as string) || "";
      const loadedBlockIds: string[] = Array.isArray(body?.loaded_block_ids) ? body.loaded_block_ids : [];

      let geminiStarted = false;
      if (agentResponseText.length > 100) {
        const jobId = `rj_${uuidv4().slice(0, 12)}`;
        try { db.insertReflectJob(jobId, agentId || null, JSON.stringify({ agentResponse: agentResponseText, userMessage: userMessageText, loadedBlockIds })); } catch { /* non-critical */ }
        reflectQueue.push({
          agentResponse: agentResponseText,
          agentThinking: agentThinkingText,
          userMessage: userMessageText,
          loadedBlockIds,
          agentId,
          dbId: jobId,
        });
        processReflectQueue(db, embeddings || undefined).catch(e =>
          console.error("[reflect-queue] worker error:", e)
        );
        geminiStarted = true;
      }

      res.json({ reflected: true, summary, new_blocks: newBlocks.length, window_hours: windowHours, gemini_started: geminiStarted });
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  // ─── Claude-triggered reflect: agent explicitly fires Gemini ─────────────
  router.post("/api/reflect/trigger", (req, res) => {
    try {
      const body = req.body as any;
      const agentId = (body?.agent_id as string) || undefined;
      const hint = (body?.hint as string) || "discovery";
      const agentResponseText = (body?.agent_response as string) || "";
      const userMessageText = (body?.user_message as string) || "";
      const agentThinkingText = (body?.agent_thinking as string) || "";
      const loadedBlockIds: string[] = Array.isArray(body?.loaded_block_ids) ? body.loaded_block_ids : [];
      const turnNumber = typeof body?.turn_number === "number" ? body.turn_number : undefined;
      const turnName = typeof body?.turn_name === "string" ? body.turn_name : undefined;

      // Floor on COMBINED content (answer + investigation + user), not the answer alone:
      // a short final answer can still sit on a rich tool-call trace worth extracting. Need
      // SOME agent_response, but the bar is just "not empty" (10 chars). Extraction is the
      // real filter downstream.
      const combinedLen = (agentResponseText.length + agentThinkingText.length + userMessageText.length);
      if (!agentResponseText || combinedLen < 10) {
        return res.status(400).json({ error: "turn too short (empty)" });
      }

      if (reflectPaused && !body?.benchmark) {
        console.log("[reflect-trigger] dropped (paused)");
        return res.json({ triggered: false, reason: "paused" });
      }

      const { queueDepth } = enqueueReflectTurn(db, embeddings, {
        agentResponse: agentResponseText,
        agentThinking: agentThinkingText,
        userMessage: userMessageText,
        loadedBlockIds,
        agentId,
        turnNumber,
        turnName,
      });

      console.log(`[reflect-trigger] queued (hint=${hint}, agent=${agentId?.slice(0,8) || "anon"})`);
      res.json({ triggered: true, hint, queue_depth: queueDepth });
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  // ─── reflect/stats: cumulative Gemini token usage since server start ─────────
  router.get("/api/reflect/stats", (_req, res) => {
    const p1 = reflectTokenStats.pass1;
    const p2 = reflectTokenStats.pass2;
    const p3 = reflectTokenStats.pass3;
    const p4 = reflectTokenStats.pass4;
    const totalInput    = p1.input    + p2.input    + p3.input    + p4.input;
    const totalThinking = p1.thinking + p2.thinking + p3.thinking + p4.thinking;
    const totalOutput   = p1.output   + p2.output   + p3.output   + p4.output;
    const billedEquiv   = totalInput + (totalThinking * 23) + totalOutput;
    res.json({
      pass1: { ...p1 },
      pass2: { ...p2 },
      pass3: { ...p3 },
      pass4: { ...p4 },
      totals: { input: totalInput, thinking: totalThinking, output: totalOutput, billed_equiv: billedEquiv },
    });
  });

  // ─── reflect/stats/reset: zero out counters (call before benchmark) ──────────
  router.post("/api/reflect/stats/reset", (_req, res) => {
    reflectTokenStats.reset();
    res.json({ reset: true });
  });

  // ─── reflect/pause + reflect/resume ─────────────────────────────────────────
  router.post("/api/reflect/pause", (_req, res) => {
    setReflectPaused(true);
    console.log("[reflect] paused — hook calls will be dropped until resume");
    res.json({ paused: true });
  });

  router.post("/api/reflect/resume", (_req, res) => {
    setReflectPaused(false);
    // Also clear a spend-pause (cost-breaker / credit-out) — a manual resume is an
    // explicit override; the next budget check re-trips it if still genuinely over.
    setSpendPaused(false);
    clearSpendPauseFile();
    console.log("[reflect] resumed (capture + spending)");
    res.json({ paused: false });
  });

  // ─── reflect/clear-turn-logs ──────────────────────────────────────────────
  router.post("/api/reflect/clear-turn-logs", (_req, res) => {
    clearTurnLogs();
    console.log("[reflect] per-turn debug logs cleared");
    res.json({ cleared: true });
  });

  // ─── reflect/queue/flush ──────────────────────────────────────────────────
  router.post("/api/reflect/queue/flush", (_req, res) => {
    const flushed = reflectQueue.length;
    try {
      const active = db.getActiveReflectJobs();
      for (const j of active) db.updateReflectJob(j.id, { status: 'dead', error: 'flushed by benchmark' });
      if (active.length > 0) console.log(`[reflect] flushed ${active.length} DB job(s) → dead`);
    } catch { /* non-critical */ }
    reflectQueue.length = 0;
    setReflectFlushGeneration(reflectFlushGeneration + 1);
    console.log(`[reflect] queue flushed — ${flushed} queued + any sleeping job signalled`);
    res.json({ flushed });
  });

  router.get("/api/reflect/status", (_req, res) => {
    res.json({
      paused: reflectPaused,
      spend_paused: spendPaused,
      spend_pause_reason: spendPaused ? (readSpendPauseReason() ?? "credit/budget") : null,
      queue_depth: reflectQueue.length,
      processing: reflectProcessing,
    });
  });

  router.get("/api/reflect/jobs", (_req, res) => {
    try {
      const active = db.getActiveReflectJobs();
      res.json({ count: active.length, jobs: active.map(j => ({ id: j.id, status: j.status, agent_id: j.agent_id, retry_attempts: j.retry_attempts, retry_after: j.retry_after, created_at: j.created_at, error: j.error })) });
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  return router;
}
