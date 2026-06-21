// routes/usage.ts — API-key usage tracking (2026-06-01).
//
// GET /api/usage           — local per-call ledger: totals + per-model + recent
// GET /api/usage?recent=N  — cap the recent-calls tail (default 20)
//
// Backed by the append-only ledger at ~/.nodedex/api-usage.jsonl, written at the
// provider seam (engine/providers/usage-ledger.ts). Each line carries cost_source
// ("openrouter_actual" = real billed cost, "estimated" = static-table guess); the
// summary's `cost_sources` says how many of each, so you know how much to trust
// cost_usd. The provider dashboard remains ground truth for the actual bill.
//
// Path convention matches routes/flags.ts: full /api/... paths declared inside the
// router; mounted with app.use(createUsageRouter()).

import { Router } from "express";
import { readdirSync, readFileSync, existsSync } from "fs";
import path from "path";
import { getUsageSummary } from "../engine/providers/usage-ledger.js";
import { fetchOpenRouterCredits, evaluateBudgetLive } from "../middleware/reflect/cost-guard.js";

// Per-pass cost lives in the per-turn logs (cost_breakdown + v2_front_cost_usd),
// not the ledger (which is per-model). Read the LATEST turn log and merge the two
// decompositions into one ordered per-stage list so the TUI/web UI can show
// "where did the last run's money go" without the user opening a file.
function latestTurnLog(): any | null {
  const dir = path.join(process.cwd(), "data", "reflect-turns"); // matches pipeline.ts REFLECT_TURNS_DIR
  if (!existsSync(dir)) return null;
  let files: string[];
  try { files = readdirSync(dir).filter((f) => /^turn-\d+\.json$/.test(f)); } catch { return null; }
  if (files.length === 0) return null;
  files.sort((a, b) => (parseInt(b.match(/\d+/)?.[0] ?? "0", 10)) - (parseInt(a.match(/\d+/)?.[0] ?? "0", 10)));
  try { return JSON.parse(readFileSync(path.join(dir, files[0]), "utf8")); } catch { return null; }
}

function perPassCost(log: any): { turn: number | null; turn_name: string | null; total_usd: number | null; passes: Array<{ name: string; usd: number | null }> } {
  const cb = log?.cost_breakdown ?? {};
  const front = log?.v2_front_cost_usd ?? null;
  const passes: Array<{ name: string; usd: number | null }> = [];
  if (front && Object.keys(front).length > 0) {
    // v2 run: the front-half stages (which cost_breakdown's pass slots couldn't
    // represent) + the back-half passes that ran.
    for (const k of ["v2_comprehend", "v2_judge", "v2_fill_2b", "v2_justify", "v2_crosslink", "v2_integrate"]) {
      if (k in front) passes.push({ name: k.replace(/^v2_/, ""), usd: front[k] ?? 0 });
    }
    for (const k of ["pass3", "pass4", "pass5"]) { const p = cb[k]; if (p?.ran) passes.push({ name: k, usd: p.usd ?? null }); }
  } else {
    // v1 run: cost_breakdown's ran passes.
    for (const k of ["pass0", "pass1", "pass_judge", "pass2", "pass3", "pass4", "pass5"]) { const p = cb[k]; if (p?.ran) passes.push({ name: k, usd: p.usd ?? null }); }
  }
  // Total = sum of what we show (the front-half spend was the bit cb.total_usd
  // missed); null only if some shown pass ran unpriced.
  const allNumeric = passes.length > 0 && passes.every((p) => typeof p.usd === "number");
  const total_usd = allNumeric ? Math.round(passes.reduce((a, p) => a + (p.usd as number), 0) * 1e6) / 1e6 : null;
  return { turn: log?.turn ?? null, turn_name: log?.turn_name ?? null, total_usd, passes };
}

export function createUsageRouter(): Router {
  const router = Router();

  router.get("/api/usage", (req, res) => {
    try {
      const recent = req.query.recent ? parseInt(String(req.query.recent), 10) : 20;
      res.json(getUsageSummary({ recent: Number.isFinite(recent) ? recent : 20 }));
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  // Live account balance straight from OpenRouter — the dashboard number, free
  // to call (account metadata, not a generation). Verified API:
  //   GET https://openrouter.ai/api/v1/credits → { data: { total_credits, total_usage } }
  // Uses the same key the provider bills against (OPENAI_API_KEY on the
  // OpenRouter path); OPENROUTER_API_KEY takes precedence if set separately.
  router.get("/api/usage/balance", async (_req, res) => {
    const c = await fetchOpenRouterCredits();
    if (c.kind === "unconfigured") {
      return res.status(501).json({
        error: "live balance requires an OpenRouter setup (OPENAI_BASE_URL → openrouter + a key)",
        hint: "the local per-call ledger at GET /api/usage works regardless",
      });
    }
    if (c.kind === "error") {
      return res.status(502).json({ error: "OpenRouter credits fetch failed" });
    }
    res.json({
      total_credits: c.total_credits,
      total_usage: c.total_usage,
      remaining: c.remaining,
      unit: "USD (OpenRouter credits, 1 credit = $1)",
      source: "openrouter:/api/v1/credits",
      fetched_at: new Date().toISOString(),
    });
  });

  // Cost breaker status: the evaluated budget verdict (production gap 2). Shows
  // whether the breaker is tripped + why, the configured limits, and the
  // observed live remaining-credit + rolling-24h spend. No-op verdict when no
  // budget is configured (NODEDEX_MIN_CREDIT_USD / NODEDEX_DAILY_BUDGET_USD).
  router.get("/api/usage/budget", async (_req, res) => {
    try {
      res.json(await evaluateBudgetLive());
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  // Per-pass cost of the LATEST reflect run (cost twin of pass_wall_ms) — so the
  // cost breakdown is glanceable on the TUI/web main page, no file-opening.
  router.get("/api/usage/passes", (_req, res) => {
    try {
      const log = latestTurnLog();
      if (!log) return res.json({ turn: null, turn_name: null, total_usd: null, passes: [], note: "no reflect turn logs yet" });
      res.json(perPassCost(log));
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  return router;
}
