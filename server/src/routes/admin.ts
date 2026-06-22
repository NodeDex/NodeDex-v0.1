// routes/admin.ts — health, Gemini ping, stats, re-embed, backup, config.
// Reference: api-server.v1.ts (lines 383-443, 3229-3335)

import { Router } from "express";
import { WorkspaceDB } from "../store/database.js";
import { EmbeddingEngine, blockEmbeddingText } from "../engine/embeddings.js";
import { getLLMProvider, getEmbeddingProvider, resetProviders } from "../engine/providers/index.js";
import type { SchedulerJobStatus } from "../server.js";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";
import { resolveEnvWriteTarget } from "../home-env.js";
import { performBackup } from "../store/backup.js";
import { runProvenanceCheck } from "../middleware/reflect/provenance-check.js";
import { healSchemaDemotes } from "../middleware/reflect/schema-heal.js";
import { pruneCollapsedTypes } from "../middleware/reflect/prune-collapsed-types.js";

// ─── .env helpers ─────────────────────────────────────────────────────────────
// Env-file LOCATION + parsing live in ../home-env.ts (shared with boot-env.ts so a
// fresh install's ~/.nodedex/.env is loaded at boot). serializeEnvFile (below) is the
// write-side, used only by the config POST.

function serializeEnvFile(original: string, updates: Record<string, string>): string {
  const lines = original.split("\n");
  const written = new Set<string>();

  const result = lines.map(line => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return line;
    const eq = trimmed.indexOf("=");
    if (eq < 0) return line;
    const key = trimmed.slice(0, eq).trim();
    if (key in updates) {
      written.add(key);
      const val = updates[key];
      // preserve comment-style commented-out key if value is empty
      if (val === "") return `# ${key}=`;
      return `${key}=${val}`;
    }
    return line;
  });

  // Append keys not already present in the file
  for (const [key, val] of Object.entries(updates)) {
    if (!written.has(key) && val !== "") {
      result.push(`${key}=${val}`);
    }
  }

  return result.join("\n");
}

function maskKey(key: string): string {
  if (!key || key.length < 8) return key ? "••••••" : "";
  return `${key.slice(0, 4)}…${key.slice(-4)}`;
}

/** Slim an OpenRouter `/api/v1/models` entry to what the web-UI picker needs. Pure /
 *  testable. `max_completion_tokens` (under `top_provider`) is the OUTPUT ceiling that
 *  feeds NODEDEX_MODEL_CAPS; `context_length` is the whole input+output window (NOT the
 *  output cap — do not use it for caps). `supported_parameters` tells whether the model
 *  can do structured output, so the UI can warn/filter rather than discover it at the
 *  first pass failure. Shape verified live 2026-06-16 against the real endpoint. */
/** Parse NODEDEX_MODEL_CAPS (a JSON `{model: maxOutputTokens}` string) defensively. */
export function safeParseModelCaps(raw?: string): Record<string, number> {
  try { const o = JSON.parse(raw ?? "{}"); return o && typeof o === "object" && !Array.isArray(o) ? o : {}; }
  catch { return {}; }
}

type StageTier = "smart" | "mechanical" | "light";
export interface PassRoutingStage {
  stage: string; env: string; tier: StageTier; role: string;
  override: string; effective: string; hint: string;
}

/** The v2 engine stages, each with its model-override env knob, TIER (the "needs a
 *  smarter model" hint the web UI shows), role, and resolved model. Resolution mirrors
 *  the real call sites: comprehend → NODEDEX_COMPREHEND_MODEL (no tier); selector/build/
 *  connect → REASONING tier; fill → STRUCTURAL tier; chain → default. effective =
 *  override || tier model || default model. Pure / testable (reads env only). */
export function buildPassRouting(): {
  default_model: string; reasoning_tier: string; structural_tier: string; stages: PassRoutingStage[];
} {
  const defaultModel = process.env.AI_MODEL ?? process.env.NODEDEX_PRIMARY_MODEL ?? "";
  const reasoning = process.env.NODEDEX_REASONING_MODEL ?? "";
  const structural = process.env.NODEDEX_STRUCTURAL_MODEL ?? "";
  const hintFor = (t: StageTier) =>
    t === "smart" ? "wants a strong model" : t === "mechanical" ? "a cheap model is fine" : "moderate";
  const defs: Array<{ stage: string; env: string; tier: StageTier; role: string; tierModel: string }> = [
    { stage: "comprehend", env: "NODEDEX_COMPREHEND_MODEL", tier: "smart",      role: "holistic read → typed blocks + links + provenance (the workhorse)", tierModel: "" },
    { stage: "selector",   env: "NODEDEX_JUDGE_MODEL",      tier: "smart",      role: "worth-gate: keep/drop candidates",                                 tierModel: reasoning },
    { stage: "fill",       env: "NODEDEX_PASS2B_MODEL",     tier: "mechanical", role: "fill unique{} fields per block",                                   tierModel: structural },
    { stage: "build",      env: "NODEDEX_PASS3_MODEL",      tier: "smart",      role: "write blocks + canonical names + relations",                       tierModel: reasoning },
    { stage: "connect",    env: "NODEDEX_PASS4_MODEL",      tier: "smart",      role: "cross-block linking",                                              tierModel: reasoning },
    { stage: "chain",      env: "NODEDEX_PASS5_MODEL",      tier: "light",      role: "chain narrative summary",                                          tierModel: "" },
  ];
  return {
    default_model: defaultModel, reasoning_tier: reasoning, structural_tier: structural,
    stages: defs.map((d) => {
      const override = process.env[d.env] ?? "";
      return { stage: d.stage, env: d.env, tier: d.tier, role: d.role, override, effective: override || d.tierModel || defaultModel, hint: hintFor(d.tier) };
    }),
  };
}

export function slimOpenRouterModel(m: any): {
  id: string; name: string; context_length: number | null;
  max_completion_tokens: number | null;
  pricing: { prompt: string; completion: string } | null;
  supports_structured: boolean; supports_tools: boolean; modality: string | null;
} {
  const tp = m?.top_provider ?? {};
  const sp: string[] = Array.isArray(m?.supported_parameters) ? m.supported_parameters : [];
  return {
    id: String(m?.id ?? ""),
    name: String(m?.name ?? m?.id ?? ""),
    context_length: m?.context_length ?? tp?.context_length ?? null,
    max_completion_tokens: tp?.max_completion_tokens ?? null,
    pricing: m?.pricing
      ? { prompt: String(m.pricing.prompt ?? ""), completion: String(m.pricing.completion ?? "") }
      : null,
    supports_structured: sp.includes("structured_outputs") || sp.includes("response_format"),
    supports_tools: sp.includes("tools"),
    modality: m?.architecture?.modality ?? null,
  };
}

export function createAdminRouter(
  db: WorkspaceDB,
  schedulerHealth?: Record<string, SchedulerJobStatus>,
  embeddings?: EmbeddingEngine,
): Router {
  const router = Router();

  // ─── Health check ──────────────────────────────────────────────────────────
  router.get("/api/health", (_req, res) => {
    const now = Date.now();
    const jobs = Object.entries(schedulerHealth ?? {}).map(([key, job]) => {
      const lastRunMs = job.last_run ? new Date(job.last_run).getTime() : null;
      const overdueMs = job.interval_ms * 1.5;
      const overdue = lastRunMs !== null && (now - lastRunMs) > overdueMs;
      const status = job.last_error ? "error" : overdue ? "overdue" : job.run_count === 0 ? "pending" : "ok";
      return { key, ...job, overdue, status };
    });
    const overall = jobs.some(j => j.status === "error") ? "error"
      : jobs.some(j => j.status === "overdue") ? "degraded"
      : "ok";
    res.json({ overall, jobs, server_time: new Date().toISOString() });
  });

  // ─── AI provider ping ─────────────────────────────────────────────────────
  async function handleProviderPing(_req: any, res: any) {
    const provider = getLLMProvider();
    if (!provider.isAvailable()) {
      return res.status(503).json({ ok: false, error: `no API key configured for provider '${provider.getName()}'` });
    }
    try {
      const ok = await provider.ping();
      if (ok) return res.json({ ok: true, provider: provider.getName() });
      return res.status(503).json({ ok: false, provider: provider.getName(), error: "ping failed" });
    } catch (e: any) {
      return res.status(500).json({ ok: false, error: String(e).slice(0, 120) });
    }
  }
  router.get("/api/provider/ping", handleProviderPing);
  router.get("/api/gemini/ping",   handleProviderPing); // legacy alias

  // ─── Structured ping — same code path as reflect passes ──────────────────
  // Uses generateStructured so it catches JSON/schema failures that plain ping misses.
  router.get("/api/gemini/ping-structured", async (_req, res) => {
    const provider = getLLMProvider();
    if (!provider.isAvailable()) {
      return res.status(503).json({ ok: false, error: `no API key configured for provider '${provider.getName()}'` });
    }
    try {
      const schema = {
        type: "object",
        properties: { ok: { type: "boolean" } },
        required: ["ok"],
      };
      const r = await (provider as any).generateStructured(
        "Reply with {\"ok\": true}.",
        "ping",
        schema,
        { thinkingBudget: 0, maxOutputTokens: 32 },
      );
      if (r?.result?.ok === true) return res.json({ ok: true, provider: provider.getName() });
      return res.status(503).json({ ok: false, provider: provider.getName(), error: "structured ping failed" });
    } catch (e: any) {
      return res.status(500).json({ ok: false, error: String(e).slice(0, 120) });
    }
  });

  // ─── Stats ────────────────────────────────────────────────────────────────
  router.get("/api/stats", (_req, res) => {
    try {
      const stats = db.getStats();
      const allBlocks = db.getAllBlocks();
      const withEmbeddings = allBlocks.filter((b) => b.embedding).length;
      res.json({ ...stats, with_embeddings: withEmbeddings, total_all: allBlocks.length });
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  // ─── Graph health — unlinked blocks only ────────────────────────────────
  // Unlinked = no part_of relation → invisible to project-scoped dead-end checks.
  // TTL expiry and relation cleanup are handled by the GC scheduler.
  router.get("/api/admin/graph-health", (_req, res) => {
    try {
      const health = db.getGraphHealth();
      res.json({
        unlinked: { count: health.unlinked.length, blocks: health.unlinked },
        clean: health.unlinked.length === 0,
      });
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  // ─── Admin: provenance integrity check (gap ④a — $0, deterministic, no LLM) ──
  // Verifies each block's source_excerpt actually appears in its source transcript;
  // writes provenance_mismatch flags for fuzzy/missing. POST { limit?, write? }.
  // write:false = dry-run audit (counts only, no flags).
  router.post("/api/admin/provenance-check", (req, res) => {
    try {
      const limitRaw = Number((req.body as any)?.limit);
      const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : undefined;
      const write = (req.body as any)?.write !== false;
      const flagFuzzy = (req.body as any)?.flagFuzzy !== false; // soft flags = $0 metric; false = only hard
      const result = runProvenanceCheck(db, { limit, write, flagFuzzy });
      res.json(result);
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  // ─── Admin: heal schema-mismatch flags via the deterministic demote ─────────
  // Retroactively applies demoteForSave() to needs_review blocks created before
  // demote-at-save shipped. CORRECTS (re-types), never deletes; collisions are left
  // flagged for the dup-reviewer. $0 (no LLM). The server's single connection — safe
  // to run live (unlike a script against the open DB).
  router.post("/api/admin/heal-schema-demotes", (_req, res) => {
    try {
      res.json(healSchemaDemotes(db));
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  // ─── Admin: prune the collapsed block-type rows from the registry ───────────
  // reasoning_chain/metric/claim were collapsed (2026-06-15) but their block_types
  // rows persist in pre-collapse DBs (INSERT OR IGNORE never deletes) and still
  // surface to the agent via /api/session. Deletes EXACTLY those three by name (no
  // heuristic → user-created custom types are untouched). Existing BLOCKS stay
  // forward-only. $0, idempotent, through the server's single connection (safe live).
  router.post("/api/admin/prune-collapsed-types", (_req, res) => {
    try {
      res.json(pruneCollapsedTypes(db));
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  // ─── Admin: re-embed all blocks ───────────────────────────────────────────
  // Reembeds EVERY non-archived block through the canonical recipe (essence +
  // concepts) — this is the one-time migration tool for the Tier 2 recipe-drift
  // fix (2026-06-15). Was a contextual "[label|type|project] / related_to:" header;
  // dropped so every stored vector shares the recipe used at save time. See
  // blockEmbeddingText.
  router.post("/api/admin/reembed-all", async (_req, res) => {
    if (!embeddings?.isAvailable()) {
      return res.status(503).json({ error: "Embedding engine not available" });
    }
    try {
      const allBlocks = db.getAllBlocks().filter(b => b.status !== "archived");

      let reembedded = 0;
      let errors = 0;

      for (const block of allBlocks) {
        try {
          const vec = await embeddings!.embed(
            blockEmbeddingText({ essence: block.essence, concepts: block.concepts }),
          );
          if (vec) {
            db.updateEmbedding(block.id, vec);
            reembedded++;
          }
        } catch {
          errors++;
        }
      }

      res.json({ reembedded, errors });
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  // ─── Config: read current server config ───────────────────────────────────
  router.get("/api/admin/config", (_req, res) => {
    const envPath = resolveEnvWriteTarget();
    const geminiKey   = process.env.GEMINI_API_KEY   ?? "";
    const openaiKey   = process.env.OPENAI_API_KEY   ?? "";
    const anthropicKey = process.env.ANTHROPIC_API_KEY ?? "";
    const adminToken  = process.env.NODEDEX_ADMIN_TOKEN ?? "";

    res.json({
      provider:            process.env.AI_PROVIDER          ?? "gemini",
      model:               process.env.AI_MODEL             ?? process.env.NODEDEX_PRIMARY_MODEL ?? "",
      fallback_model:      process.env.NODEDEX_FALLBACK_MODEL ?? "",
      pass4_model:         process.env.NODEDEX_PASS4_MODEL  ?? "",
      gemini_key_set:      geminiKey.length > 0,
      gemini_key_preview:  maskKey(geminiKey),
      openai_key_set:      openaiKey.length > 0,
      openai_key_preview:  maskKey(openaiKey),
      anthropic_key_set:   anthropicKey.length > 0,
      anthropic_key_preview: maskKey(anthropicKey),
      openai_base_url:     process.env.OPENAI_BASE_URL      ?? "",
      embedding_provider:  process.env.EMBEDDING_PROVIDER   ?? "",
      embedding_model:     process.env.NODEDEX_EMBEDDING_MODEL ?? "",
      // ⚠ embeddings power semantic recall + dedup (H3's value); false here = recall
      // silently degrades to keyword-only. The UI should WARN, not bury this.
      embedding_configured: (() => { try { return getEmbeddingProvider().isAvailable(); } catch { return false; } })(),
      // Per-pass / tier model routing (advanced) — see GET /api/settings/passes for the
      // resolved per-stage model + the smartness hint.
      comprehend_model:    process.env.NODEDEX_COMPREHEND_MODEL ?? "",
      judge_model:         process.env.NODEDEX_JUDGE_MODEL    ?? "",
      pass2b_model:        process.env.NODEDEX_PASS2B_MODEL   ?? "",
      pass3_model:         process.env.NODEDEX_PASS3_MODEL    ?? "",
      pass5_model:         process.env.NODEDEX_PASS5_MODEL    ?? "",
      reasoning_model:     process.env.NODEDEX_REASONING_MODEL  ?? "",
      structural_model:    process.env.NODEDEX_STRUCTURAL_MODEL ?? "",
      // Per-model output caps (populated by the web UI from /api/models).
      model_caps:          safeParseModelCaps(process.env.NODEDEX_MODEL_CAPS),
      // Cost controls. min_credit floor is OpenRouter-only (live balance); daily cap
      // is provider-agnostic (ledger-estimated).
      min_credit_usd:      process.env.NODEDEX_MIN_CREDIT_USD   ?? "",
      daily_budget_usd:    process.env.NODEDEX_DAILY_BUDGET_USD ?? "",
      // Write-robustness (H1).
      arc_max_retries:     process.env.NODEDEX_ARC_MAX_RETRIES  ?? "",
      // Arc auto-extract cadence: auto-commit captured turns every N (0/blank = off →
      // rely on inactivity + the agent's own workspace_extract_arc). Read LIVE by
      // arcAutoTurns(), so a POST here takes effect on the running server with no restart.
      arc_auto_turns:      process.env.NODEDEX_ARC_AUTO_TURNS   ?? "",
      pass3_batch_size:    process.env.NODEDEX_PASS3_BATCH_SIZE ?? "",
      thinking_budget:     process.env.NODEDEX_THINKING_BUDGET ?? "high",
      background_knowledge: (process.env.NODEDEX_BACKGROUND_KNOWLEDGE ?? "off").toLowerCase() === "on",
      pass1_version:       process.env.NODEDEX_PASS1_VERSION ?? "v1",
      pass_extract:        (process.env.NODEDEX_PASS_EXTRACT ?? "off").toLowerCase() === "on",
      admin_token_set:     adminToken.length > 0,
      env_file_path:       envPath,
      env_file_found:      existsSync(envPath),
    });
  });

  // ─── Config: update server config ─────────────────────────────────────────
  router.post("/api/admin/config", (req, res) => {
    const body = req.body ?? {};

    // Build env updates map — only include fields that were provided
    const envUpdates: Record<string, string> = {};

    if (body.provider          !== undefined) envUpdates["AI_PROVIDER"]                  = body.provider;
    if (body.model             !== undefined) envUpdates["AI_MODEL"]                     = body.model;
    if (body.fallback_model    !== undefined) envUpdates["NODEDEX_FALLBACK_MODEL"]        = body.fallback_model;
    if (body.pass4_model       !== undefined) envUpdates["NODEDEX_PASS4_MODEL"]           = body.pass4_model;
    if (body.gemini_key        !== undefined) envUpdates["GEMINI_API_KEY"]               = body.gemini_key;
    if (body.openai_key        !== undefined) envUpdates["OPENAI_API_KEY"]               = body.openai_key;
    if (body.anthropic_key     !== undefined) envUpdates["ANTHROPIC_API_KEY"]            = body.anthropic_key;
    if (body.openai_base_url   !== undefined) envUpdates["OPENAI_BASE_URL"]              = body.openai_base_url;
    if (body.embedding_provider !== undefined) envUpdates["EMBEDDING_PROVIDER"]          = body.embedding_provider;
    if (body.embedding_model   !== undefined) envUpdates["NODEDEX_EMBEDDING_MODEL"]     = body.embedding_model;
    // Per-pass / tier model routing (advanced). These take effect WITHOUT a provider
    // reset — modelForPass / modelOverride read env fresh per call.
    if (body.comprehend_model  !== undefined) envUpdates["NODEDEX_COMPREHEND_MODEL"]    = body.comprehend_model;
    if (body.judge_model       !== undefined) envUpdates["NODEDEX_JUDGE_MODEL"]         = body.judge_model;
    if (body.pass2b_model      !== undefined) envUpdates["NODEDEX_PASS2B_MODEL"]        = body.pass2b_model;
    if (body.pass3_model       !== undefined) envUpdates["NODEDEX_PASS3_MODEL"]         = body.pass3_model;
    if (body.pass5_model       !== undefined) envUpdates["NODEDEX_PASS5_MODEL"]         = body.pass5_model;
    if (body.reasoning_model   !== undefined) envUpdates["NODEDEX_REASONING_MODEL"]     = body.reasoning_model;
    if (body.structural_model  !== undefined) envUpdates["NODEDEX_STRUCTURAL_MODEL"]    = body.structural_model;
    // Per-model output caps — accepts an object or a JSON string; stored as JSON.
    if (body.model_caps        !== undefined) envUpdates["NODEDEX_MODEL_CAPS"]          = typeof body.model_caps === "string" ? body.model_caps : JSON.stringify(body.model_caps);
    // Cost controls + write-robustness (numbers stored as strings).
    if (body.min_credit_usd    !== undefined) envUpdates["NODEDEX_MIN_CREDIT_USD"]      = String(body.min_credit_usd);
    if (body.daily_budget_usd  !== undefined) envUpdates["NODEDEX_DAILY_BUDGET_USD"]    = String(body.daily_budget_usd);
    if (body.arc_max_retries   !== undefined) envUpdates["NODEDEX_ARC_MAX_RETRIES"]     = String(body.arc_max_retries);
    if (body.arc_auto_turns    !== undefined) envUpdates["NODEDEX_ARC_AUTO_TURNS"]      = String(body.arc_auto_turns);
    if (body.pass3_batch_size  !== undefined) envUpdates["NODEDEX_PASS3_BATCH_SIZE"]    = String(body.pass3_batch_size);
    if (body.thinking_budget   !== undefined) envUpdates["NODEDEX_THINKING_BUDGET"]      = body.thinking_budget;
    if (body.background_knowledge !== undefined) envUpdates["NODEDEX_BACKGROUND_KNOWLEDGE"] = body.background_knowledge ? "on" : "off";
    if (body.pass1_version     !== undefined) envUpdates["NODEDEX_PASS1_VERSION"]        = body.pass1_version;
    if (body.pass_extract      !== undefined) envUpdates["NODEDEX_PASS_EXTRACT"]         = body.pass_extract ? "on" : "off";
    if (body.admin_token       !== undefined) envUpdates["NODEDEX_ADMIN_TOKEN"]          = body.admin_token;

    // Apply to process.env immediately (hot-reload for provider/keys)
    for (const [k, v] of Object.entries(envUpdates)) {
      if (v === "") {
        delete process.env[k];
      } else {
        process.env[k] = v;
      }
    }

    // Provider/key changes: reset singletons so next call re-reads from process.env
    const providerChanged = ["AI_PROVIDER", "GEMINI_API_KEY", "OPENAI_API_KEY",
      "ANTHROPIC_API_KEY", "OPENAI_BASE_URL", "EMBEDDING_PROVIDER"].some(k => k in envUpdates);
    if (providerChanged) resetProviders();

    // Persist to the resolved .env target: an existing repo .env (dev), else
    // ~/.nodedex/.env (created on first write — the fresh-install home). NEVER null,
    // so a fresh install can always save. boot-env.ts loads ~/.nodedex/.env next start.
    const envPath = resolveEnvWriteTarget();
    try {
      const existed = existsSync(envPath);
      const original = existed ? readFileSync(envPath, "utf8") : "";
      const updated = serializeEnvFile(original, envUpdates);
      mkdirSync(dirname(envPath), { recursive: true });
      writeFileSync(envPath, updated, "utf8");
      return res.json({ saved: true, env_file: envPath, created: !existed, hot_reloaded: providerChanged });
    } catch (e) {
      return res.status(500).json({ error: `Failed to write ${envPath}: ${String(e)}` });
    }
  });

  // ─── GET /api/models — provider model catalog (web-UI model picker) ─────────
  // Proxies OpenRouter's model list (the one middle-platform catalog the web UI
  // targets first). FREE metadata call — NO inference. Done server-side so the key
  // never round-trips through the browser. Each entry carries the OUTPUT ceiling
  // (→ NODEDEX_MODEL_CAPS), context window, pricing, and structured-output capability.
  // ?q= filters by id/name substring. (Other providers' catalogs come later — the
  // user's H2 scope is OpenRouter first.)
  router.get("/api/models", async (req, res) => {
    const key = process.env.OPENROUTER_API_KEY || process.env.OPENAI_API_KEY || "";
    try {
      const r = await fetch("https://openrouter.ai/api/v1/models", {
        headers: key ? { Authorization: `Bearer ${key}` } : {},
      });
      if (!r.ok) return res.status(502).json({ error: `OpenRouter /models fetch failed (${r.status})` });
      const j: any = await r.json();
      let models = (Array.isArray(j?.data) ? j.data : []).map(slimOpenRouterModel);
      const q = String(req.query.q ?? "").trim().toLowerCase();
      if (q) models = models.filter((m: any) => m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q));
      res.json({ source: "openrouter:/api/v1/models", count: models.length, models });
    } catch (e: any) {
      res.status(502).json({ error: `models fetch failed: ${String(e?.message ?? e).slice(0, 200)}` });
    }
  });

  // ─── GET /api/settings/passes — per-pass model routing + smartness hint ─────
  // For the web-UI "advanced models" panel: each v2 engine stage, its override env
  // knob, the resolved (effective) model, and a TIER hint ("wants a strong model" /
  // "a cheap model is fine" / "moderate") so the user knows where to spend on a
  // smarter model. Read-only → general auth gate (not ADMIN_PATHS).
  router.get("/api/settings/passes", (_req, res) => {
    res.json(buildPassRouting());
  });

  // ─── Admin: backup DB ─────────────────────────────────────────────────────
  // Shares performBackup with the scheduled timer (store/backup.ts) — consistent
  // (checkpoint-then-copy) + encryption-preserving. 1h throttle on the manual path.
  router.post("/api/admin/backup", (_req, res) => {
    try {
      res.json(performBackup(db, { throttleMs: 60 * 60 * 1000, keep: 5 }));
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  return router;
}
