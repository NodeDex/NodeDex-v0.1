import "./boot-env.js"; // FIRST: load ~/.nodedex/.env before any module reads process.env
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WorkspaceDB } from "./store/database.js";
import { EmbeddingEngine, blockEmbeddingText } from "./engine/embeddings.js";
import { fileURLToPath } from "url";
import path from "path";
import fs from "fs";
import os from "os";
import { buildWorkspaceServer, agentToolAllowlist, writesExposed } from "./mcp-server.js";
import { startApiServer } from "./api-server.js";
import { getLLMProvider } from "./engine/providers/index.js";

// ─── Scheduler health state ───────────────────────────────────────
// Exported so the API server can expose it via /api/health
export interface SchedulerJobStatus {
  name: string;
  interval_label: string;
  interval_ms: number;
  running: boolean;
  run_count: number;
  last_run: string | null;
  last_result: string | null;
  last_error: string | null;
}
export const schedulerHealth: Record<string, SchedulerJobStatus> = {
  gc:      { name: "Garbage Collection",interval_label: "6h",   interval_ms: 6*60*60*1000,  running: false, run_count: 0, last_run: null, last_result: null, last_error: null },
  reembed: { name: "Re-embed",          interval_label: "10min",interval_ms: 10*60*1000,     running: false, run_count: 0, last_run: null, last_result: null, last_error: null },
  enrich:  { name: "Concept Enrich",    interval_label: "5min", interval_ms: 5*60*1000,      running: false, run_count: 0, last_run: null, last_result: null, last_error: null },
  gaps:    { name: "Gap Audit",         interval_label: "1h",   interval_ms: 60*60*1000,     running: false, run_count: 0, last_run: null, last_result: null, last_error: null },
};

// ─── Initialize ──────────────────────────────────────────────────
// Always resolve DB path relative to this file (../../data/workspace.db from src/ or dist/)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dbPath = process.env.WORKSPACE_DB_PATH || process.env.DB_PATH || path.resolve(__dirname, "../../data/workspace.db");
const db = new WorkspaceDB(dbPath);
const embeddings = new EmbeddingEngine();

// The Workspace MCP server (instructions + read-only gating + all tools) — built by the
// shared factory so the stdio transport here and the HTTP transport (routes/mcp-http.ts,
// for networked/Dockerized clients) expose the IDENTICAL tool surface. See mcp-server.ts.
const server = buildWorkspaceServer(db, embeddings);

// ─── Start Server ────────────────────────────────────────────────
async function main() {
  await db.init();
  console.error("Workspace MCP Server v1.0.0-MVP starting...");
  const encryptionEnabled = !!process.env.WORKSPACE_ENCRYPTION_KEY;
  console.error(`Encryption: ${encryptionEnabled ? "enabled (AES-256)" : "disabled (no WORKSPACE_ENCRYPTION_KEY)"}`);
  console.error(`Embeddings: ${embeddings.isAvailable() ? "enabled" : "disabled (no embedding API key)"}`);
  const provider = getLLMProvider();
  console.error(`AI provider: ${provider.getName()} — ${provider.isAvailable() ? "ready" : "NOT AVAILABLE (no API key set — check .env)"}`);

  // ── Agent identity env vars ───────────────────────────────────────
  // Set these when spawning sub-agents so they know who they are:
  //   WMCS_AGENT_ID   = unique name for this agent instance (e.g. "researcher-1", "coder-main")
  //   WMCS_AGENT_ROLE = agent's role (e.g. "researcher", "coder", "reviewer")
  // NOTE: WMCS_ prefix is a Wmcs-era leftover; pending rename to NODEDEX_AGENT_ID.
  const agentId   = process.env.WMCS_AGENT_ID;
  const agentRole = process.env.WMCS_AGENT_ROLE;
  if (agentId) {
    console.error(`Agent identity: ${agentId} (role: ${agentRole || "general"})`);
    db.agentHeartbeat(agentId, agentRole || "general");
  } else {
    console.error(`Agent identity: not set (set WMCS_AGENT_ID + WMCS_AGENT_ROLE when spawning sub-agents)`);
  }

  // ── One-time: prune any embedding vectors stored in block_history ────────
  const { deleted: histPruned } = db.pruneEmbeddingHistory();
  if (histPruned > 0) console.error(`Pruned ${histPruned} embedding history entry(ies) from block_history.`);

  // ── Backfill embeddings for blocks created before embedding support ──────
  if (embeddings.isAvailable()) {
    const allBlocks = db.getAllBlocks();
    const missing = allBlocks.filter((b) => !b.embedding);
    if (missing.length > 0) {
      console.error(`Backfilling embeddings for ${missing.length} block(s)...`);
      for (const block of missing) {
        try {
          const embeddingText = blockEmbeddingText({ essence: block.essence, concepts: block.concepts });
          const vec = await embeddings.embed(embeddingText);
          if (vec) db.updateEmbedding(block.id, vec);
        } catch { /* skip silently */ }
      }
      console.error("Embedding backfill complete.");
    }
  }

  // ── Warm up the LOCAL embedder so its model downloads NOW (at boot), not on the
  //    first extraction. The bundled bge-small lazy-downloads on first embed; a fresh
  //    install has no blocks to backfill, so without this the ~30MB download would stall
  //    the user's first real turn. Local-only (a hosted provider has nothing to pre-fetch).
  //    Fire-and-forget so boot stays fast; the model is ready long before the agent connects.
  const embProvider = (process.env.EMBEDDING_PROVIDER ?? "local").toLowerCase();
  if (embProvider === "local" && embeddings.isAvailable()) {
    console.error("[boot] warming up the local embedding model (first run downloads it — one-time)…");
    embeddings.embed("warmup")
      .then(() => console.error("[boot] local embedding model ready."))
      .catch(() => { /* best-effort — the lazy path still downloads on the first real embed */ });
  }

  // ── Start Web UI API server (HTTP) ───────────────────────────────
  // Port defaults to 3001 but is overridable via PORT env. This is the
  // hinge for TEST ISOLATION: the global reflect Stop hook is hardcoded
  // to localhost:3001, so a test server booted on a different PORT (e.g.
  // PORT=3099) physically cannot be reached by the hook firing on our
  // own live conversation — closing the harness-pollution leak that
  // pause/benchmark band-aids couldn't (the hook hits 3001, not us).
  const apiPort = Number(process.env.PORT) || 3001;
  const httpServer = startApiServer(db, schedulerHealth, apiPort, embeddings);

  // ── PID file + graceful shutdown (ops gap 3) ─────────────────────────────────
  // Write a pidfile so tooling can find this server; on a deliverable signal,
  // close the HTTP server (release the port) and the DB (release the file lock)
  // so a restart never fights a lingering handle. NB on Windows, Stop-Process
  // -Force (TerminateProcess) bypasses handlers — but the EADDRINUSE-exit guard
  // in api-server.ts already prevents the zombie accumulation that was the real
  // problem; this is the clean path for Ctrl+C / SIGTERM-respecting stops.
  const pidDir = path.join(os.homedir(), ".nodedex");
  const pidFile = path.join(pidDir, `nodedex-server-${apiPort}.pid`);
  try { if (!fs.existsSync(pidDir)) fs.mkdirSync(pidDir, { recursive: true }); fs.writeFileSync(pidFile, String(process.pid)); } catch { /* non-fatal */ }

  let shuttingDown = false;
  const gracefulShutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.error(`[shutdown] ${signal} — closing server + DB, releasing the port + DB lock`);
    try { httpServer.close(); } catch { /* ignore */ }
    try { db.close(); } catch { /* ignore */ }
    try { if (fs.existsSync(pidFile)) fs.unlinkSync(pidFile); } catch { /* ignore */ }
    process.exit(0);
  };
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"] as NodeJS.Signals[]) {
    try { process.on(sig, () => gracefulShutdown(sig)); } catch { /* signal not supported on this platform */ }
  }

  // ── Background scheduling ────────────────────────────────────────
  function runJob(key: string, fn: () => Promise<string>): void {
    const job = schedulerHealth[key]!;
    if (job.running) return;
    job.running = true;
    job.last_run = new Date().toISOString();
    fn()
      .then((result) => {
        job.last_result = result;
        job.last_error = null;
        job.run_count++;
      })
      .catch((e) => {
        job.last_error = String(e);
        job.run_count++;
        console.error(`[scheduler:${key}] error:`, e);
      })
      .finally(() => { job.running = false; });
  }

  // GC — every 6 hours
  setInterval(() => runJob("gc", async () => {
    const r = db.runGC();
    const { deleted } = db.pruneEmbeddingHistory();
    return `archived=${r.archived} promoted=${r.promoted} hist_pruned=${deleted}`;
  }), schedulerHealth.gc!.interval_ms);

  // Reembed + enrich — only when Gemini is available
  if (embeddings.isAvailable()) {
    // Reembed missing embeddings every 10 minutes
    setInterval(() => runJob("reembed", async () => {
      const missing = db.getAllBlocks().filter((b) => !b.embedding).slice(0, 20);
      if (missing.length === 0) return "nothing to reembed";
      let done = 0;
      for (const block of missing) {
        try {
          const text = blockEmbeddingText({ essence: block.essence, concepts: block.concepts });
          const vec = await embeddings.embed(text);
          if (vec) { db.updateEmbedding(block.id, vec); done++; }
        } catch { /* skip */ }
      }
      return `reembedded ${done}/${missing.length}`;
    }), schedulerHealth.reembed!.interval_ms);

    // Concept enrichment every 30 minutes
    setInterval(() => runJob("enrich", async () => {
      const enrichProvider = getLLMProvider();
      if (!enrichProvider.isAvailable()) return "skipped (AI provider not available)";
      const targets = db.getAllBlocks().filter((b) => {
        if (b.status === "archived") return false;
        try {
          const c = JSON.parse(b.content as string);
          // Never overwrite concepts the agent tagged manually
          if (c.concepts_source === "agent") return false;
          return (c.concepts_source === "keyword_auto" || c.concepts_source === "gemini_reflect") && !b.enriched_at;
        }
        catch { return false; }
      }).slice(0, 10);
      if (targets.length === 0) return "nothing to enrich";

      const enrichSysInstr = "Return 4-8 specific search tags as a JSON array. Tags must be specific named things a future user would search for: technologies, tools, mechanisms, measurements, named failure modes, named people or teams. NOT category labels, NOT type descriptions, NOT vague process words. Respond ONLY with a JSON array of lowercase strings.";
      let enriched = 0;
      for (const block of targets) {
        try {
          const c = JSON.parse(block.content as string);
          const enrichText = await enrichProvider.generate(`${enrichSysInstr}\n\nBlock: "${block.label}" (${block.type})\nEssence: "${block.essence}"\nReturn 4-8 specific named things (technologies, mechanisms, measurements) as a JSON array. Not categories.`);
          const newConcepts = JSON.parse((enrichText ?? "").trim().replace(/```json\n?|```/g, ""));
          if (Array.isArray(newConcepts) && newConcepts.length > 0) {
            c.concepts = newConcepts; c.concepts_source = "gemini_enriched";
            db.updateBlock(block.id, { content: JSON.stringify(c), enriched_at: new Date().toISOString() }, "auto-enriched by scheduler");
            // Recompute quality score — enrichment adds is_a/unique/concepts so the
            // creation-time score (before content existed) is now stale.
            const concepts = (() => { try { return JSON.parse((block as any).concepts || "[]"); } catch { return []; } })() as string[];
            let qScore = 0;
            if (block.essence && block.essence.trim().length > 0) qScore++;
            if (c.is_a)                                              qScore++;
            if (c.unique && Object.keys(c.unique).length >= 2)      qScore++;
            if (concepts.length >= 3)                                qScore++;
            const relCount = db.getRelations(block.id).length;
            if (block.type === "project" || relCount > 0)            qScore++;
            db.updateBlock(block.id, { quality_score: Math.min(qScore, 5) });
            enriched++;
          }
        } catch { /* skip */ }
      }
      return `enriched ${enriched}/${targets.length}`;
    }), schedulerHealth.enrich!.interval_ms);
  }

  // Gap audit — every hour, logs to console and saves a note block if critical gaps found
  setInterval(() => runJob("gaps", async () => {
    const allBlocks = db.getAllBlocks().filter(b => b.status !== "archived");
    const allRelations = db.getAllRelations(false);
    const connectedIds = new Set<string>();
    for (const r of allRelations) { connectedIds.add(r.source_id); connectedIds.add(r.target_id); }

    const orphans = allBlocks.filter(b => b.type !== "project" && !connectedIds.has(b.id)).length;
    const openQ   = allBlocks.filter(b => b.type === "question").filter(b => {
      const qRels = allRelations.filter(r => r.source_id === b.id || r.target_id === b.id);
      return !qRels.some(r => {
        const oid = r.source_id === b.id ? r.target_id : r.source_id;
        return ["fact","decision"].includes(allBlocks.find(x => x.id === oid)?.type || "");
      });
    }).length;
    const unlinkedDE = allBlocks.filter(b => b.type === "dead_end").filter(b => {
      return !allRelations.some(r => (r.source_id === b.id || r.target_id === b.id) && r.type === "contradicts");
    }).length;
    const sevenAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const staleDrafts = allBlocks.filter(b => {
      if (b.type !== "draft") return false;
      const c = (() => { try { return JSON.parse(b.content as string); } catch { return {}; } })();
      return c?.unique?.draft_status !== "promoted" && b.created_at < sevenAgo;
    }).length;

    const total = orphans + openQ + unlinkedDE + staleDrafts;
    const summary = `orphans=${orphans} open_questions=${openQ} unlinked_dead_ends=${unlinkedDE} stale_drafts=${staleDrafts}`;
    if (total > 0) console.error(`[scheduler:gaps] ${total} gap(s) detected — ${summary}`);
    return total === 0 ? "no gaps" : summary;
  }), schedulerHealth.gaps!.interval_ms);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Workspace MCP Server running on stdio.");
  if (writesExposed()) {
    console.error("Agent tools: ALL exposed (NODEDEX_EXPOSE_WRITE_TOOLS=on) — read + write + admin.");
  } else {
    console.error(`Agent tools (READ-ONLY surface): ${[...agentToolAllowlist()].join(", ")}`);
    console.error("  write/admin/maintenance tools HIDDEN (the pipeline writes; agent only reads). NODEDEX_EXPOSE_WRITE_TOOLS=on to expose; NODEDEX_EXPOSE_TASKS=on for task tools.");
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
