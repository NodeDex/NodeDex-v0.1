// routes/session.ts — session state, events, alerts, monitoring, canvas, gaps.
// Reference: api-server.v1.ts (lines 1343-1470, 2262-2410, 3117-3227)

import { Router } from "express";
import { existsSync, readFileSync, appendFileSync } from "fs";
import path from "path";
import { WorkspaceDB } from "../store/database.js";
import { getLLMProvider } from "../engine/providers/index.js";
import {
  resolveStateLabel,
  sessionEvents, alertStore, resetMonitoring,
  SessionReflectEvent, SessionRecallEvent,
} from "./state.js";

export function createSessionRouter(db: WorkspaceDB, dataDir: string): Router {
  const router = Router();

  const serverStartFile = path.join(dataDir, "server_start.txt");
  const queryLogFile    = path.join(dataDir, "session_queries.jsonl");

  // ─── Session context (used by hooks for auto-recall) ─────────────
  router.get("/api/session", (req, res) => {
    try {
      const agentId = (req.query.agent_id as string) || undefined;

      if (agentId) db.registerAgent(agentId);

      const stats = db.getStats() as any;
      const allBlocks = db.getAllBlocks();

      const stateLabel = resolveStateLabel(agentId);
      const stateBlock = db.getBlock(stateLabel)
        ?? (agentId ? db.getBlock("agent_session_state") : null);

      const projects = allBlocks
        .filter((b) => b.type === "project" && b.status !== "archived")
        .map((b) => ({ id: b.id, label: b.label, essence: b.essence }));

      const openTasks = allBlocks
        .filter((b) => {
          if (b.type !== "task" || b.status === "archived" || b.status === "done") return false;
          try {
            const c = JSON.parse(b.content as string);
            return c?.unique?.status !== "done";
          } catch { return true; }
        })
        .map((b) => ({ id: b.id, label: b.label, essence: b.essence }));

      const recent = allBlocks
        .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
        .slice(0, 5)
        .map((b) => ({ id: b.id, label: b.label, type: b.type, essence: b.essence, created_at: b.created_at }));

      let stateLastReflected: string | null = null;
      if (stateBlock) {
        try { stateLastReflected = (JSON.parse(stateBlock.content as string) as any).last_reflected || null; } catch { /* */ }
      }

      const activeAgents = db.getActiveAgents(120);

      let uncertainRefs: any[] = [];
      if (stateBlock) {
        try {
          const stateContent = JSON.parse(stateBlock.content as string);
          uncertainRefs = stateContent.uncertain_references || [];
        } catch { /* */ }
      }

      // Last completed reflect — for context-hook pipeline feedback
      const lastReflectEvt = [...sessionEvents]
        .reverse()
        .find((e): e is SessionReflectEvent => e.type === "reflect");
      const lastReflect = lastReflectEvt ? {
        blocks_created: lastReflectEvt.blocks_created.length,
        blocks_updated: lastReflectEvt.blocks_updated.length,
        turn_number: lastReflectEvt.turn_number ?? null,
        turn_name: lastReflectEvt.turn_name ?? null,
        timestamp: lastReflectEvt.timestamp,
      } : null;

      res.json({
        // db identity — lets a multi-server client (e.g. the TUI switcher)
        // tell which graph a port is serving without exposing the full path.
        db: path.basename(db.dbPath),
        total_blocks: stats.total_blocks,
        by_type: stats.by_type,
        state_essence: stateBlock?.essence || null,
        state_last_reflected: stateLastReflected,
        projects,
        open_tasks: openTasks,
        recent_blocks: recent,
        active_agents: activeAgents,
        uncertain_references: uncertainRefs,
        graph_health: (() => {
          const h = db.getGraphHealth();
          return h.unlinked.length === 0 ? null : { unlinked: h.unlinked.length };
        })(),
        last_reflect: lastReflect,
        agent_id: agentId || null,
      });
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  // ─── Session state patch ─────────────────────────────────────────
  router.patch("/api/session/state", (req, res) => {
    try {
      const body = req.body as Record<string, unknown>;
      const agentId = (req.query.agent_id as string) || (body.agent_id as string) || undefined;
      const stateLabel = resolveStateLabel(agentId);
      let stateBlock = db.getBlock(stateLabel);
      if (!stateBlock) {
        stateBlock = db.createBlock({
          label: stateLabel,
          type: "process",
          status: "active",
          essence: `Session state${agentId ? ` for agent ${agentId.slice(0, 8)}` : ""}`,
          content: {},
          ttl: "permanent",
          source: "Auto-Reflect",
          created_by: agentId || undefined,
        });
      }
      let content: Record<string, unknown> = {};
      try { content = JSON.parse(stateBlock.content as string); } catch { /* */ }
      const { agent_id: _a, ...updates } = body;
      Object.assign(content, updates);
      db.updateBlock(stateLabel, { content: JSON.stringify(content) }, "PATCH /api/session/state", agentId || "hook");
      res.json({ updated: true });
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  // ─── Write audit log ─────────────────────────────────────────────
  router.get("/api/write-log", (req, res) => {
    try {
      const limit = Math.min(Number(req.query.limit) || 50, 200);
      const table = req.query.table as string | undefined;
      const entries = db.getWriteLog(limit);
      const filtered = table && table !== "all" ? entries.filter(e => e.table_name === table) : entries;
      res.json({ count: filtered.length, entries: filtered });
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  // ─── Live schema (relation types + block types from DB) ──────────
  router.get("/api/schema", (_req, res) => {
    try {
      const db_ = (db as any)["db"];
      const relationTypes = db_.prepare(
        `SELECT name, inverse, description FROM relation_types ORDER BY name`
      ).all() as Array<{ name: string; inverse: string | null; description: string }>;
      const blockTypes = db_.prepare(
        `SELECT name, description FROM block_types ORDER BY name`
      ).all() as Array<{ name: string; description: string }>;
      res.json({ relation_types: relationTypes, block_types: blockTypes });
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  // ─── Session canvas — reasoning timeline with block anchors ─────────────
  router.get("/api/session/canvas", (_req, res) => {
    try {
      const serverStart = existsSync(serverStartFile)
        ? new Date(readFileSync(serverStartFile, "utf8").trim()).getTime()
        : Date.now();

      const canvasLogFile = path.join(dataDir, "session_canvas.jsonl");
      const canvasEntries: Array<{ reasoning_step: string; summary: string; block_labels: string[]; timestamp: string }> = [];
      if (existsSync(canvasLogFile)) {
        const lines = readFileSync(canvasLogFile, "utf8").trim().split("\n").filter(Boolean);
        for (const line of lines) {
          try {
            const entry = JSON.parse(line);
            if (new Date(entry.timestamp).getTime() >= serverStart) canvasEntries.push(entry);
          } catch { /* skip */ }
        }
      }

      const allBlocks = db.getAllBlocks();
      const sessionBlocks = allBlocks.filter(b => new Date(b.created_at).getTime() >= serverStart);
      const stepMap = new Map<string, Array<{ id: string; label: string; type: string; essence: string }>>();
      for (const b of sessionBlocks) {
        try {
          const content = typeof b.content === "string" ? JSON.parse(b.content) : (b.content || {});
          const step: string = content?.save_context?.reasoning_step || "(no step)";
          if (!stepMap.has(step)) stepMap.set(step, []);
          stepMap.get(step)!.push({ id: b.id, label: b.label, type: b.type, essence: b.essence });
        } catch { /* skip */ }
      }

      const steps = canvasEntries.map(e => ({
        reasoning_step: e.reasoning_step,
        summary: e.summary,
        timestamp: e.timestamp,
        blocks: stepMap.get(e.reasoning_step) || e.block_labels.map(l => ({ label: l })),
      }));

      for (const [step, blocks] of stepMap) {
        if (step !== "(no step)" && !steps.find(s => s.reasoning_step === step)) {
          steps.push({ reasoning_step: step, summary: "", timestamp: blocks[0] ? "" : "", blocks });
        }
      }

      res.json({
        session_start: new Date(serverStart).toISOString(),
        total_session_blocks: sessionBlocks.length,
        steps,
        unanchored: stepMap.get("(no step)") || [],
      });
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  // ─── Session query log — hook appends each recall query ─────────────────
  router.post("/api/session-query-log", (req, res) => {
    try {
      const { query, terms, timestamp } = req.body as { query: string; terms: string[]; timestamp: string };
      if (!query?.trim()) return res.status(400).json({ error: "query required" });
      const entry = JSON.stringify({ query, terms: terms || [], timestamp: timestamp || new Date().toISOString() }) + "\n";
      appendFileSync(queryLogFile, entry, "utf8");
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  // ─── Session gaps ─────────────────────────────────────────────────────────
  router.get("/api/session-gaps", (_req, res) => {
    try {
      const serverStart = existsSync(serverStartFile)
        ? new Date(readFileSync(serverStartFile, "utf8").trim()).getTime()
        : Date.now();

      if (!existsSync(queryLogFile)) return res.json({ gaps: [], previous_session: null });

      const lines = readFileSync(queryLogFile, "utf8").trim().split("\n").filter(Boolean);
      const allEntries = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) as { query: string; terms: string[]; timestamp: string }[];

      const prevEntries = allEntries.filter(e => new Date(e.timestamp).getTime() < serverStart);
      if (prevEntries.length === 0) return res.json({ gaps: [], previous_session: null });

      const prevStart = prevEntries[0].timestamp;
      const prevEnd   = prevEntries[prevEntries.length - 1].timestamp;
      const prevStartMs = new Date(prevStart).getTime();
      const prevEndMs   = new Date(prevEnd).getTime();

      const GAP_STOP = new Set(["about","above","after","also","alright","although","always","another",
        "before","could","done","each","face","feel","from","good","have","here","hmm","into","just",
        "know","like","make","more","most","much","need","next","none","nothing","okay","only","other",
        "our","over","problem","real","really","said","same","since","some","such","than","that","them",
        "then","there","these","they","this","those","through","true","under","very","want","well",
        "were","what","when","where","which","while","with","would","your","system","should","going"]);
      const allTerms = new Set<string>();
      for (const e of prevEntries) {
        for (const t of (e.terms || [])) {
          const clean = t.replace(/[^a-z0-9_]/gi, "").toLowerCase();
          if (clean.length > 4 && !GAP_STOP.has(clean)) allTerms.add(clean);
        }
      }

      const savedDuring = db.getAllBlocks().filter(b => {
        const created = new Date(b.created_at).getTime();
        return created >= prevStartMs && created <= prevEndMs + 60_000;
      });

      const gaps: string[] = [];
      const covered: string[] = [];
      for (const term of allTerms) {
        const found = savedDuring.some(b =>
          b.label.toLowerCase().includes(term) ||
          b.essence.toLowerCase().includes(term) ||
          (b.concepts || "").toLowerCase().includes(term)
        );
        if (found) covered.push(term); else gaps.push(term);
      }

      res.json({
        previous_session: { start: prevStart, end: prevEnd, queries: prevEntries.length },
        gaps: gaps.slice(0, 8),
        covered: covered.slice(0, 5),
        blocks_saved_that_session: savedDuring.length,
      });
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  // ─── Session monitoring ────────────────────────────────────────────────────
  router.get("/api/session/events", (_req, res) => {
    res.json({ events: sessionEvents, total: sessionEvents.length });
  });

  router.post("/api/session/reset", (_req, res) => {
    resetMonitoring();
    res.json({ reset: true });
  });

  router.get("/api/alerts", (_req, res) => {
    res.json({ alerts: alertStore, total: alertStore.length });
  });

  router.get("/api/session/report", (_req, res) => {
const reflectEvts = sessionEvents.filter(e => e.type === "reflect") as SessionReflectEvent[];
    const recallEvts  = sessionEvents.filter(e => e.type === "recall")  as SessionRecallEvent[];

    const totalBilled = reflectEvts.reduce((s, e) => s + e.tokens.billed_equiv, 0);

    const allCreated = reflectEvts.flatMap(e => e.blocks_created);
    const allUpdated = reflectEvts.flatMap(e => e.blocks_updated);

    const typeBreakdown: Record<string, number> = {};
    const qualityBuckets: Record<string, number> = { "1": 0, "2": 0, "3": 0, "4": 0, "5": 0, "6": 0 };
    for (const b of allCreated) {
      typeBreakdown[b.type] = (typeBreakdown[b.type] ?? 0) + 1;
      const q = String(Math.min(Math.max(Math.round(b.quality), 1), 6));
      qualityBuckets[q]++;
    }

    const withRelations = allCreated.filter(b => b.quality >= 4).length;
    const relationDensity = allCreated.length > 0
      ? Math.round((withRelations / allCreated.length) * 100)
      : 0;

    const totalWrites = allCreated.length + allUpdated.length;
    const updateRate = totalWrites > 0 ? Math.round((allUpdated.length / totalWrites) * 100) : 0;

    const processingMs = reflectEvts.map(e => e.processing_ms);
    const avgLagMs = processingMs.length > 0
      ? Math.round(processingMs.reduce((s, v) => s + v, 0) / processingMs.length)
      : 0;
    const maxLagMs = processingMs.length > 0 ? Math.max(...processingMs) : 0;

    const costPerBlock = allCreated.length > 0 ? Math.round(totalBilled / allCreated.length) : 0;

    const rateLimitHits = reflectEvts.filter(e => e.rate_limited).length;
    const rateLimitByPass: Record<string, number> = {};
    for (const e of reflectEvts.filter(e => e.rate_limited && e.rate_limit_pass)) {
      const p = String(e.rate_limit_pass);
      rateLimitByPass[p] = (rateLimitByPass[p] ?? 0) + 1;
    }

    const totalRecalled = recallEvts.reduce((s, e) => s + e.total_injected, 0);
    const totalCrossProject = recallEvts.reduce((s, e) => s + e.cross_project_count, 0);
    const pollutionRate = totalRecalled > 0 ? Math.round((totalCrossProject / totalRecalled) * 100) : 0;

    res.json({
      summary: {
        reflect_cycles: reflectEvts.length,
        recall_calls: recallEvts.length,
        blocks_created: allCreated.length,
        blocks_updated: allUpdated.length,
        total_billed_tokens: totalBilled,
        cost_per_block_tokens: costPerBlock,
        rate_limit_hits: rateLimitHits,
      },
      blocks: {
        type_breakdown: typeBreakdown,
        quality_histogram: qualityBuckets,
        relation_density_pct: relationDensity,
        update_rate_pct: updateRate,
      },
      performance: {
        avg_processing_ms: avgLagMs,
        max_processing_ms: maxLagMs,
        rate_limit_by_pass: rateLimitByPass,
      },
      recall: {
        total_injected: totalRecalled,
        cross_project_injected: totalCrossProject,
        pollution_rate_pct: pollutionRate,
      },
      tokens: {
        pass1_input: reflectEvts.reduce((s, e) => s + e.tokens.pass1_input, 0),
        pass2_input: reflectEvts.reduce((s, e) => s + e.tokens.pass2_input, 0),
        pass2_thinking: reflectEvts.reduce((s, e) => s + e.tokens.pass2_thinking, 0),
        pass3_input: reflectEvts.reduce((s, e) => s + e.tokens.pass3_input, 0),
        pass3_thinking: reflectEvts.reduce((s, e) => s + e.tokens.pass3_thinking, 0),
        total_billed_equiv: totalBilled,
      },
      alerts_fired: alertStore,
    });
  });

  // ─── Draft-derive: Gemini synthesis detection ─────────────────────────────
  router.post("/api/draft-derive", async (req, res) => {
    try {
      const { block_ids, response_text } = req.body as { block_ids: string[]; response_text?: string };
      if (!block_ids?.length || block_ids.length < 2) return res.status(400).json({ error: "need 2+ block_ids" });

      const blocks = block_ids.map(id => db.getBlock(id)).filter((b): b is NonNullable<typeof b> => b !== null && b !== undefined);
      if (blocks.length < 2) return res.status(400).json({ draft: null, reason: "blocks not found" });

      const aiProvider = getLLMProvider();
      if (!aiProvider.isAvailable()) return res.status(503).json({ error: "AI provider not available — check your API key" });

      const blockSummaries = blocks.map(b => `- ${b.label}: ${b.essence}`).join("\n");
      const agentText = (response_text || "").slice(0, 600);

      const prompt = `An AI agent read these knowledge blocks and then produced output.

Blocks read:
${blockSummaries}

Agent's output excerpt:
"${agentText}"

Question: did the agent synthesise something from these blocks that NEITHER block states alone?
Only return synthesized:true if there is clear cross-block reasoning — not just parallel use.

Return valid JSON only:
{
  "synthesized": true | false,
  "conclusion": "one sentence — what the combination reveals (only if synthesized)",
  "logic": "brief reasoning chain (1-2 sentences, only if synthesized)"
}`;

      const text = await aiProvider.generate(prompt);
      if (!text) return res.status(500).json({ error: "AI provider returned no result" });
      const raw = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "");
      const parsed = JSON.parse(raw) as { synthesized: boolean; conclusion?: string; logic?: string };

      if (!parsed.synthesized) return res.json({ draft: null });

      res.json({
        draft: {
          input_ids:    blocks.map(b => b.id),
          input_labels: blocks.map(b => b.label),
          conclusion:   parsed.conclusion,
          logic:        parsed.logic,
        }
      });
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  return router;
}
