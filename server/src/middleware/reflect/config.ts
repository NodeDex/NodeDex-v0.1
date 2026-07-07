// ─── Model config (Phase 2 — env var override) ────────────────────────────────
// Set NODEDEX_PRIMARY_MODEL / NODEDEX_FALLBACK_MODEL to override defaults.
// Fallback is tried immediately on 503 before re-queuing.
export const PRIMARY_MODEL  = process.env.NODEDEX_PRIMARY_MODEL  ?? "gemini-2.5-flash";
export const FALLBACK_MODEL = process.env.NODEDEX_FALLBACK_MODEL ?? "gemini-2.5-pro";

// ─── Arc auto-extract cadence ──────────────────────────────────────────────────
// In arc mode each captured turn waits (pass01_done) until an arc is extracted. The
// agent SHOULD fire workspace_extract_arc at its own task boundaries (cleanest), but as
// a safety net we auto-extract once N turns have piled up. NODEDEX_ARC_AUTO_TURNS:
//   0 / unset → OFF (agent-driven + inactivity timer only)
//   N > 0     → after each capture, if pending turns >= N, auto-fire arc extraction.
// Read live (not cached) so the user/TUI — or the agent via /api/admin/config — can
// retune it without a restart. The recognizer (default-on) means a coarse boundary still
// won't duplicate roots, so N is a quality/cost knob, not a correctness one.
export function arcAutoTurns(): number {
  const n = parseInt(process.env.NODEDEX_ARC_AUTO_TURNS ?? "0", 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// Pass 5 chain assembly: "llm" (default — the LLM summarizes clusters into chain blocks)
// or "mechanical" (deterministic clusterer, no model call). The mechanical path produces
// the same chain-block shape from the causal edges; consumers (pass4-slice / context /
// provenance) read membership + a summary line + the arc, all of which it computes.
export function pass5Mode(): "llm" | "mechanical" {
  return (process.env.NODEDEX_PASS5_MODE ?? "llm").toLowerCase() === "mechanical" ? "mechanical" : "llm";
}

// ─── Per-pass model routing (user-configurable; defaults to the provider model) ──
// VISION: users bring ANY model/provider. They set 2-3 TIER vars and the pipeline
// routes each pass to the right tier by its competence need; a per-pass override
// wins for fine control. Everything resolves to `undefined` (→ the provider's
// configured default model, AI_MODEL) until a user opts in — so behaviour is
// byte-identical to today out of the box. The universality fix (openai.ts
// mechanism-by-model + prompt-JSON fallback) makes any chosen model actually work.
//
//   NODEDEX_REASONING_MODEL   → 2a, 2c, JUDGE, 3, 4  (typing / dedup / wiring / naming / links)
//   NODEDEX_STRUCTURAL_MODEL  → 2b, 0                (fill unique{}, scene card — mechanical)
//   (default tier: 1, 5 — no tier var; provider default unless a per-pass override)
//   NODEDEX_PASS{ID}_MODEL    → per-pass override (HIGHEST priority)
export type PassId =
  | "pass0" | "pass1" | "judge" | "pass2a" | "pass2b" | "pass2c" | "pass3" | "pass4" | "pass5";

const PASS_TIER: Record<PassId, "reasoning" | "structural" | "default"> = {
  pass0: "structural", pass1: "default", judge: "reasoning",
  pass2a: "reasoning", pass2b: "structural", pass2c: "reasoning",
  pass3: "reasoning", pass4: "reasoning", pass5: "default",
};
const PASS_ENV: Record<PassId, string> = {
  pass0: "NODEDEX_PASS0_MODEL", pass1: "NODEDEX_PASS1_MODEL", judge: "NODEDEX_JUDGE_MODEL",
  pass2a: "NODEDEX_PASS2A_MODEL", pass2b: "NODEDEX_PASS2B_MODEL", pass2c: "NODEDEX_PASS2C_MODEL",
  pass3: "NODEDEX_PASS3_MODEL", pass4: "NODEDEX_PASS4_MODEL", pass5: "NODEDEX_PASS5_MODEL",
};

/**
 * Resolve the model for a pass: per-pass override → tier model → undefined.
 * Returns undefined when nothing is set so the caller omits modelOverride and the
 * provider uses its configured default. Pure (reads env only) + trims blanks.
 */
export function modelForPass(pass: PassId): string | undefined {
  const override = process.env[PASS_ENV[pass]];
  if (override && override.trim()) return override.trim();
  const tier = PASS_TIER[pass];
  if (tier === "reasoning") {
    const m = process.env.NODEDEX_REASONING_MODEL;
    if (m && m.trim()) return m.trim();
  } else if (tier === "structural") {
    const m = process.env.NODEDEX_STRUCTURAL_MODEL;
    if (m && m.trim()) return m.trim();
  }
  return undefined; // → provider default model (AI_MODEL); behaviour unchanged
}

/** A bare env model override: the trimmed value, or undefined → use the provider's
 *  default model. Single source for the per-feature `NODEDEX_*_MODEL` overrides
 *  (comprehend, reviewers, …) that each used to re-implement this. */
export function modelOverride(envName: string): string | undefined {
  const m = process.env[envName];
  return m && m.trim() ? m.trim() : undefined;
}

/** Parse a positive integer from env: a finite integer ≥ min, else `def`. Single
 *  source for the per-worker `NODEDEX_*_INTERVAL_MS` getters AND the batch-size
 *  parsers that each re-implemented this. */
export function intFromEnv(envName: string, def: number, min = 1): number {
  const n = Number.parseInt(process.env[envName] ?? "", 10);
  return Number.isFinite(n) && n >= min ? n : def;
}

// ─── Pipeline config ──────────────────────────────────────────────────────────
// All tunable thresholds in one place. Change here, takes effect everywhere.
export const CONFIG = {
  // Dedup: defaultThreshold used by buildDuplicateAlerts to classify strong (≥0.88)
  // vs related (0.72–0.88) similarity alerts injected into the Pass 3 prompt.
  // Gemini handles semantic dedup decisions; TypeScript only enforces exact label dedup.
  dedup: {
    defaultThreshold: 0.88,
  },
  // Pass 2 (and split sub-passes 2a/2b/2c) output cap. This is the visible-JSON
  // budget at the provider (Gemini/OpenRouter), summed with thinkingBudget into
  // the API's max_tokens — see openai.ts:74 + project-openrouter-token-budget-fix.
  //
  // When hit: openai.ts handles TRUNCATION as same-model retry with
  // max_tokens × 1.5 (commit f484568 — NOT a fallback-model swap, which would
  // silently change semantics; see project-thinking-budget-fix memory). The
  // retry recovers data but adds ~50-100s wall time (one extra Pass 2a call).
  //
  // History:
  //  - 16384 (orig) → truncated on refund 10-item batch 2026-05-25 → 321s/461s
  //  - 24576 (= retry × 1.5 from 16384) → set 2026-05-25 → ALSO truncated on
  //    27-item popup-dinner 2026-05-30 (verbose classification_reasoning per
  //    item pushed visible JSON past 24576). +112s wall via retry path.
  //  - 65536 (current) → matches Pass 3's proven-safe value, well inside
  //    Gemini 2.5 Flash's output cap. Eliminates the retry tax at typical
  //    batch sizes (~25-50 items × ~1KB/item JSON). You pay only for actual
  //    tokens used, not the cap, so this is ~free in $$.
  pass2: {
    maxOutputTokens: 65536,
  },
  // Pre-search context for Pass 2.
  preSearch: {
    // Minimum cosine similarity to include a block as a semantic match for an item.
    semanticMatchThreshold: 0.72,
    // How many recent decisions to always include (for supersedes detection).
    recentDecisionsLimit: 8,
  },
};

// ─── Background knowledge toggle ─────────────────────────────────────────────
// NODEDEX_BACKGROUND_KNOWLEDGE=on  → pipeline may draw on background knowledge
//                                    to enrich blocks with supporting mechanisms
//                                    and implications not explicit in session content
// NODEDEX_BACKGROUND_KNOWLEDGE=off → (default) pipeline only uses session content;
//                                    background knowledge injection is prohibited
export const ALLOW_BACKGROUND_KNOWLEDGE =
  (process.env.NODEDEX_BACKGROUND_KNOWLEDGE ?? "off").toLowerCase() === "on";

// ─── Thinking budget override ─────────────────────────────────────────────────
// NODEDEX_THINKING_BUDGET=off     → 0 tokens for all passes (fastest, mild quality drop)
// NODEDEX_THINKING_BUDGET=low     → cap at 512 tokens (~2-3x faster than default)
// NODEDEX_THINKING_BUDGET=medium  → cap at 2048 tokens (good middle ground)
// NODEDEX_THINKING_BUDGET=high    → default behaviour (no cap)
export function getThinkingBudget(requested: number): number {
  const setting = (process.env.NODEDEX_THINKING_BUDGET ?? "high").toLowerCase();
  if (setting === "off" || setting === "0") return 0;
  if (setting === "low")    return Math.min(requested, 512);
  if (setting === "medium") return Math.min(requested, 2048);
  return requested; // "high" or unset
}

export function is503(e: any): boolean {
  return e?.status === 429 || e?.status === 503 ||
    String(e?.message ?? "").includes("429") || String(e?.message ?? "").includes("503") ||
    String(e?.message ?? "").includes("quota") || String(e?.message ?? "").includes("RESOURCE_EXHAUSTED") ||
    String(e?.message ?? "").includes("high demand");
}
