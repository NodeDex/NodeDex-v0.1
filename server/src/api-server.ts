// api-server.ts — thin orchestrator. Creates the Express app, mounts all route
// modules, and handles startup recovery for the reflect queue.
// Reference: api-server.v1.ts (the original monolithic version, 3390 lines)

import express from "express";
import cors from "cors";
import { WorkspaceDB } from "./store/database.js";
import { EmbeddingEngine } from "./engine/embeddings.js";
import type { SchedulerJobStatus } from "./server.js";
import { writeFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { homedir } from "os";
import path from "path";

import { reflectQueue, processReflectQueue, reflectPaused, setReflectPaused, spendPaused, setSpendPaused, startCreditAutoResume } from "./routes/state.js";
import { spendPauseFileExists, readSpendPauseReason } from "./middleware/reflect/cost-guard.js";
import { createBlocksRouter }      from "./routes/blocks.js";
import { createRecallRouter }      from "./routes/recall.js";
import { createReflectRouter }     from "./routes/reflect.js";
import { createSessionRouter }     from "./routes/session.js";
import { createWorkspaceRouter }   from "./routes/workspace.js";
import { createAdminRouter }       from "./routes/admin.js";
import { createInjectRouter }      from "./routes/inject.js";
import { createChatProxyRouter }   from "./routes/chat-proxy.js";
import { createQuarantineRouter }  from "./routes/quarantine.js";
import { createConversationsRouter } from "./routes/conversations.js";
import { createFlagsRouter }        from "./routes/flags.js";
import { createUsageRouter }         from "./routes/usage.js";
import { createMcpHttpRouter }       from "./routes/mcp-http.js";
import { startArcInactivityTimer } from "./middleware/reflect/arc-inactivity-timer.js";
import { startFlagReviewer } from "./middleware/reflect/flag-reviewer-startup.js";
import { startStageAuditTimer } from "./middleware/reflect/stage-audit-graph.js";
import { startDescriberTimer } from "./middleware/reflect/describe-roots.js";
import { startProvenanceReviewerTimer } from "./middleware/reflect/provenance-reviewer.js";
import { requireAuth, defaultAuthExempt, resolveBindHost, apiTokenEnabled } from "./middleware/auth.js";
import { startBackupTimer } from "./store/backup.js";
import { startSchemaHealTimer } from "./middleware/reflect/schema-heal.js";

export function startApiServer(
  db: WorkspaceDB,
  schedulerHealth?: Record<string, SchedulerJobStatus>,
  port = 3001,
  embeddings?: EmbeddingEngine,
): import("http").Server {
  const app = express();
  app.use(cors());

  // ─── Data directory ───────────────────────────────────────────────────────
  const __filename_api = fileURLToPath(import.meta.url);
  const __dirname_api  = path.dirname(__filename_api);
  const dataDir        = path.resolve(__dirname_api, "../../data");
  const serverStartFile = path.join(dataDir, "server_start.txt");

  // Stamp the current server start time — gap mirror uses this as session boundary
  try { writeFileSync(serverStartFile, new Date().toISOString(), "utf8"); } catch { /* non-fatal */ }
  // Larger limit on the chat-proxy path — LLM message arrays exceed the 100kb default.
  // Must precede the global json() so this path is parsed with the bigger cap.
  app.use("/api/chat", express.json({ limit: "16mb" }));
  app.use(express.json());

  // ─── API auth middleware (security slice 1) ───────────────────────────────
  // Whole-API token lock. Default OFF (NODEDEX_API_TOKEN unset) = open, and the
  // localhost bind below is the protection — keeps the live dogfood loop + a
  // naive install working. Set NODEDEX_API_TOKEN to require it on every /api/*
  // read AND write (a memory graph is maximally sensitive; reads = exfiltration).
  // Exempts /api/health (supervisors), /api/chat (BYO-key passthrough), /upgrade.
  // This is the forward-compat seam for the future multi-tenant server — see
  // middleware/auth.ts. Layered with the ADMIN_TOKEN gate below (which adds an
  // extra lock on the destructive paths even when the API token is off).
  app.use(requireAuth({ exempt: defaultAuthExempt }));

  // ─── Admin auth middleware ────────────────────────────────────────────────
  // Protects destructive/admin endpoints with NODEDEX_ADMIN_TOKEN env var.
  // Read-only endpoints (GET /api/blocks, /api/tree, /api/recall-fast, etc.) stay open.
  // If NODEDEX_ADMIN_TOKEN is not set, admin endpoints are unprotected (local dev default).
  // Token accepted via: Authorization: Bearer <token>  OR  x-admin-token: <token>
  const ADMIN_TOKEN = process.env.NODEDEX_ADMIN_TOKEN || "";
  const ADMIN_PATHS = new Set([
    "/api/admin/reembed-all",
    "/api/admin/backup",
    "/api/admin/config",
    "/api/session/reset",
    "/api/reflect/stats/reset",
    "/api/reflect/pause",
    "/api/reflect/resume",
  ]);
  app.use((req, res, next) => {
    if (!ADMIN_TOKEN) return next();
    if (!ADMIN_PATHS.has(req.path)) return next();
    const bearer = (req.headers["authorization"] || "").replace(/^Bearer\s+/i, "").trim();
    const header = (req.headers["x-admin-token"] || "") as string;
    if (bearer === ADMIN_TOKEN || header === ADMIN_TOKEN) return next();
    res.status(401).json({ error: "Unauthorized — NODEDEX_ADMIN_TOKEN required" });
  });

  // ─── Mount all route modules ──────────────────────────────────────────────
  app.use(createAdminRouter(db, schedulerHealth, embeddings));
  app.use(createBlocksRouter(db));
  app.use(createRecallRouter(db, embeddings));
  app.use(createReflectRouter(db, embeddings));
  app.use(createSessionRouter(db, dataDir));
  app.use(createWorkspaceRouter(db, embeddings));
  app.use(createInjectRouter(db, dataDir));
  app.use(createChatProxyRouter());
  app.use(createQuarantineRouter(db));
  app.use(createConversationsRouter(db));
  app.use(createFlagsRouter(db));
  app.use(createUsageRouter());

  // Streamable-HTTP MCP transport at /mcp — lets a NETWORKED MCP client (e.g. a
  // Dockerized host via host.docker.internal) use the tools when it can't spawn the
  // stdio binary itself. Same tool surface as stdio; self-gated by the owner token.
  // Needs embeddings to build the server (always provided by server.ts).
  if (embeddings) app.use(createMcpHttpRouter(db, embeddings));

  // DEBT 5 Phase 10: inactivity safety net (server-side timer).
  // Default OFF — opt-in via NODEDEX_ARC_INACTIVITY_ENABLED=on. No-op when
  // off; checks for stale pass01_done turns when on (default every 60s,
  // threshold 30 min idle). Idempotent — safe to call on each server start.
  startArcInactivityTimer(db);

  // DEBT 5 Slice 2: enrichment-cycle workers (both default OFF, opt-in).
  //   Flag reviewer — consumes pipeline_flags, decides merge/leave/split.
  //     NODEDEX_FLAG_REVIEWER_ENABLED=on (+ NODEDEX_FLAG_AUTO_MERGE=on for
  //     Level 2 auto-archive). Default OFF = flags accumulate for manual
  //     inspection via GET /api/flags.
  //   Stage AUDIT — periodic graph-health scan writing flags.
  //     NODEDEX_AUDIT_ENABLED=on. Default OFF.
  // Both idempotent — safe to call on each server start.
  startFlagReviewer(db);
  startStageAuditTimer(db);

  // Recognition Layer step 1: the DESCRIBER — maintains a surface description
  // (domain + owner) on each project root, the fuel the recognizer will compare
  // new knowledge against (docs/PIPELINE-RECOGNITION-LAYER-DESIGN.md §3/§6).
  // Async LLM worker (mirrors the reviewer, NOT flag-only AUDIT). Default OFF:
  // NODEDEX_DESCRIBER_ENABLED=on.
  startDescriberTimer(db);

  // Gap ④(b): the PROVENANCE MEANING-REVIEWER — consumes the HARD provenance_mismatch
  // flags the $0 detector wrote, judges grounded-or-fabricated by meaning, and
  // (Level 2) corrects/demotes. Async LLM worker. Default OFF:
  // NODEDEX_PROVENANCE_REVIEWER_ENABLED=on (+ NODEDEX_PROVENANCE_AUTO_ACT=on to mutate).
  startProvenanceReviewerTimer(db);

  // Ops gap 3: scheduled DB backups (store/backup.ts). DEFAULT ON ($0 +
  // protective, unlike the LLM timers above); checkpoint-then-copy = consistent
  // + encryption-preserving. NODEDEX_BACKUP_ENABLED=0 to disable.
  startBackupTimer(db);

  // Tier-1 LOCKED-ON ($0 deterministic): retroactively demote old mis-typed blocks
  // (e.g. an insight with no implication but an observation IS a fact) that predate the
  // save-time demote or slipped past it. The doc listed this as default-on but no timer
  // was wired — this closes that gap. NODEDEX_SCHEMA_HEAL_ENABLED=off to disable.
  startSchemaHealTimer(db);


  // ─── Upgrade page ────────────────────────────────────────────────────────
  // Served at /upgrade — users land here from 402 pro_required errors.
  const LEMON_CHECKOUT = process.env.NODEDEX_CHECKOUT_URL || "https://nodedex.lemonsqueezy.com/checkout";
  app.get("/upgrade", (_req, res) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Nodedex Pro</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: #0d0d0d; color: #e8e8e8;
      min-height: 100vh; display: flex; align-items: center; justify-content: center;
      padding: 2rem;
    }
    .card {
      background: #141414; border: 1px solid #2a2a2a; border-radius: 12px;
      max-width: 540px; width: 100%; padding: 2.5rem;
    }
    .badge {
      display: inline-block; background: #1a3a2a; color: #4ade80;
      font-size: 0.7rem; font-weight: 700; letter-spacing: 0.08em;
      text-transform: uppercase; padding: 0.25rem 0.6rem; border-radius: 99px;
      margin-bottom: 1.25rem;
    }
    h1 { font-size: 1.75rem; font-weight: 700; margin-bottom: 0.5rem; }
    .sub { color: #888; font-size: 0.95rem; margin-bottom: 2rem; line-height: 1.5; }
    .features { list-style: none; margin-bottom: 2rem; }
    .features li {
      display: flex; align-items: flex-start; gap: 0.75rem;
      padding: 0.6rem 0; border-bottom: 1px solid #1e1e1e; font-size: 0.9rem;
    }
    .features li:last-child { border-bottom: none; }
    .check { color: #4ade80; font-size: 1rem; flex-shrink: 0; margin-top: 0.05rem; }
    .desc { color: #aaa; font-size: 0.8rem; margin-top: 0.15rem; }
    .cta {
      display: block; width: 100%; padding: 0.85rem 1.5rem;
      background: #16a34a; color: #fff; font-size: 1rem; font-weight: 600;
      border: none; border-radius: 8px; cursor: pointer; text-align: center;
      text-decoration: none; transition: background 0.15s;
    }
    .cta:hover { background: #15803d; }
    .note { color: #555; font-size: 0.78rem; text-align: center; margin-top: 1rem; }
  </style>
</head>
<body>
  <div class="card">
    <div class="badge">Pro Required</div>
    <h1>Nodedex Pro</h1>
    <p class="sub">
      You hit a feature that requires a Pro license.<br />
      Unlock the full pipeline and advanced tooling with one key.
    </p>
    <ul class="features">
      <li>
        <span class="check">&#10003;</span>
        <div>
          <div><strong>Pass 4 — Causal Wiring</strong></div>
          <div class="desc">Automatically traces cause-effect chains across your entire knowledge graph.</div>
        </div>
      </li>
      <li>
        <span class="check">&#10003;</span>
        <div>
          <div><strong>Session Reports</strong></div>
          <div class="desc">Full session intelligence reports via <code>/api/session/report</code>.</div>
        </div>
      </li>
      <li>
        <span class="check">&#10003;</span>
        <div>
          <div><strong>workspace_challenge</strong></div>
          <div class="desc">Challenge stale beliefs and surface contradictions across the graph.</div>
        </div>
      </li>
      <li>
        <span class="check">&#10003;</span>
        <div>
          <div><strong>Free tier included</strong></div>
          <div class="desc">Pass 0-3 and all core graph operations remain free — no key needed.</div>
        </div>
      </li>
    </ul>
    <a class="cta" href="${LEMON_CHECKOUT}" target="_blank" rel="noopener">
      Get Nodedex Pro &rarr;
    </a>
    <p class="note">
      After purchase, set <code>NODEDEX_LICENSE_KEY=&lt;your-key&gt;</code> and restart the server.
    </p>
  </div>
</body>
</html>`);
  });

  // ── Honor the reflect-pause file at boot ────────────────────────────────────
  // ~/.nodedex/reflect-pause is the user's "stop reflecting" switch (also checked
  // by the hooks). The in-memory reflectPaused flag used to reset to false on
  // every restart, so a paused user who restarted the server silently resumed
  // per-turn reflection AND drained the recovered job queue — the surprise spend
  // hit on 2026-06-01. Seed the flag from the file so pause survives restarts.
  try {
    const pauseFile = path.join(homedir(), ".nodedex", "reflect-pause");
    if (existsSync(pauseFile)) {
      setReflectPaused(true);
      console.log("[reflect] reflect-pause file present at boot — reflection PAUSED (delete ~/.nodedex/reflect-pause + POST /api/reflect/resume to re-enable)");
    }
  } catch { /* non-fatal */ }

  // Honor the SPEND-pause file (cost-breaker / credit-out). Distinct from reflect-pause:
  // spending stays halted but CAPTURE KEEPS QUEUING, and the auto-resume timer drains it
  // once credit recovers — so a restart mid-outage doesn't burn credit OR drop turns.
  try {
    if (spendPauseFileExists()) {
      setSpendPaused(true);
      console.log(`[cost-breaker] spend-pause file present at boot — SPENDING PAUSED (${readSpendPauseReason() ?? "credit/budget"}); capture still queuing; auto-resumes on top-up`);
    }
  } catch { /* non-fatal */ }

  // ─── Startup: recover persisted reflect jobs ──────────────────────────────
  // Jobs stuck in 'processing' mean the server crashed mid-job — reset to pending.
  // Jobs in 'pending' or 'retry_wait' are loaded back into the in-memory queue.
  try {
    const cleaned = db.cleanupReflectJobs();
    if (cleaned > 0) console.log(`[reflect-queue] cleaned up ${cleaned} stale DB job(s)`);

    const staleJobs = db.getActiveReflectJobs();
    let recovered = 0;
    for (const row of staleJobs) {
      if (row.status === 'processing' || (row.status === 'dead' && row.error === 'max retries exceeded')) {
        db.updateReflectJob(row.id, { status: 'pending', retry_after: null });
        row.status = 'pending';
        row.retry_after = null;
      }
      try {
        const payload = JSON.parse(row.payload);
        const precomputed = row.precomputed ? JSON.parse(row.precomputed) : {};
        reflectQueue.push({
          agentResponse:    payload.agentResponse  ?? "",
          agentThinking:    payload.agentThinking  ?? "",
          userMessage:      payload.userMessage    ?? "",
          loadedBlockIds:   payload.loadedBlockIds ?? [],
          agentId:          row.agent_id           ?? undefined,
          precomputedPass0: precomputed.pass0      ?? undefined,
          precomputedPass1: precomputed.pass1      ?? undefined,
          precomputedPass2: precomputed.pass2      ?? undefined,
          precomputedPass3PendingBlockIds: precomputed.p3PendingBlockIds ?? undefined,
          retryAfter:       row.retry_after        ?? undefined,
          retryAttempts:    row.retry_attempts,
          dbId:             row.id,
        });
        recovered++;
      } catch { /* corrupt row — skip */ }
    }
    if (recovered > 0 && !reflectPaused && !spendPaused) {
      console.log(`[reflect-queue] recovered ${recovered} job(s) from DB — resuming`);
      processReflectQueue(db, embeddings || undefined).catch(e =>
        console.error("[reflect-queue] recovery worker error:", e)
      );
    } else if (recovered > 0 && spendPaused) {
      console.log(`[reflect-queue] recovered ${recovered} job(s) from DB — NOT draining (spending paused: credit/budget). Auto-resumes when the balance recovers.`);
    } else if (recovered > 0) {
      console.log(`[reflect-queue] recovered ${recovered} job(s) from DB — NOT draining (reflect paused). Delete ~/.nodedex/reflect-pause + POST /api/reflect/resume to drain.`);
    }
  } catch (e) {
    console.error("[reflect-queue] startup recovery failed:", e);
  }

  const bindHost = resolveBindHost();
  const server = app.listen(port, bindHost, () => {
    const shown = bindHost === "0.0.0.0" ? "localhost" : bindHost;
    const lock = apiTokenEnabled() ? "token-locked" : "open (localhost-only)";
    console.error(`Workspace Web UI API running on http://${shown}:${port} — bound ${bindHost}, ${lock}`);
    if (embeddings) console.error(`MCP (HTTP) endpoint: http://${shown}:${port}/mcp — for networked clients (e.g. Docker: http://host.docker.internal:${port}/mcp)`);
    if (bindHost === "0.0.0.0" && !apiTokenEnabled()) {
      console.error("⚠ SECURITY: bound to 0.0.0.0 (network-reachable) with NO NODEDEX_API_TOKEN — the graph is exposed unauthenticated. Set NODEDEX_API_TOKEN.");
    }
  });

  // Auto-resume the spend-pause once credit tops back up (a separate timer — the drain
  // loop breaks on spendPaused before it could re-check the budget itself). unref'd, so
  // it never holds the process open.
  startCreditAutoResume(db, embeddings || undefined);
  // Stale-process trap fix: db.init() already opened the DB, and the MCP stdio
  // transport keeps this process alive — so a server that CAN'T bind the port
  // would otherwise linger as a zombie holding the DB lock (the accumulation we
  // hit all session). On EADDRINUSE (or any listen error), release the DB and
  // EXIT instead of zombie-lingering.
  server.on("error", (e: NodeJS.ErrnoException) => {
    if (e.code === "EADDRINUSE") {
      console.error(`✖ port ${port} already in use — another nodedex server is running. Exiting (won't linger holding the DB). Stop the other first, or use scripts/restart.mjs.`);
    } else {
      console.error(`✖ API server error: ${e.message}. Exiting.`);
    }
    try { db.close(); } catch { /* ignore */ }
    process.exit(1);
  });
  return server;
}
