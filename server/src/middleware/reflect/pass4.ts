import { reflectTokenStats } from "./context.js";
import { modelForPass } from "./config.js";
import type { LLMProvider } from "../../engine/ai-provider.js";

// Pass 4 model (resolved at call time via modelForPass("pass4")):
//   NODEDEX_PASS4_MODEL override → NODEDEX_REASONING_MODEL tier → (Gemini) gemini-2.5-pro
//   default (Pro reliably thinks where Flash skips + produces shallow links) → provider default.
// Set a stronger reasoning model (o4-mini, deepseek-reasoner) for non-Gemini providers.
// See docs/Compatible-Models-Reference.md for per-provider recommendations.

// ═══════════════════════════════════════════════════════════════════════════════
// PASS 4 — CONNECT (cross-session only)
// Job: link new blocks to existing graph blocks from prior sessions.
// Runs after all Pass 3 blocks are saved. Output: relation tuples only.
// Does NOT re-derive intra-batch wiring (Pass 2 owns that).
// ═══════════════════════════════════════════════════════════════════════════════

export const PASS4_PROMPT = `You receive two things:
  NEW BLOCKS — blocks just saved this turn (label, id, type, essence, existing relations)
  PROJECT GRAPH — existing blocks from prior sessions

── STATE CONVENTION ─────────────────────────────────────────────────────────
"State" in this prompt = text in marked regions below (NEW BLOCKS, PROJECT GRAPH).
Your training knowledge and "what's commonly true in this domain" are NOT state.
A block exists ONLY if it appears in one of the two marked regions. Familiarity ≠
recorded. When the DIRECTNESS CHECK asks "is there another block Z that already
connects X to Y?", Z must be a real label from NEW BLOCKS or PROJECT GRAPH — not
a block you imagine should exist.

Your ONLY job: find missing connections between a NEW BLOCK and an EXISTING block.
Output relation tuples only. No new blocks. No block content. Just arrows.

── SCOPE ───────────────────────────────────────────────────────────────────

  New block ↔ existing block: YES — this is your job.
  New block ↔ new block (same batch): NEVER — already decided by an earlier pass.
  Reversing an existing relation: NEVER — earlier passes had the transcript.

If a new block already has relations in its "chain:" section, those are DECIDED.
Do not re-derive, reverse, or duplicate them.

── DIRECTION ───────────────────────────────────────────────────────────────

THE SOURCE DEPENDS ON THE TARGET.
"Which block needs the other to make sense?" — that block is the source.

── FOR EACH (NEW BLOCK, EXISTING BLOCK) PAIR — RUN THIS TREE ──────────────

Answer from the essences only. When uncertain at any step, answer NO.
A missing link is recoverable next session; a wrong link is not.

In all steps, (X) and (Y) can be either the new block or the existing block.
Direction follows the question's answer, not which block is newer.

STEP 1 — IDENTITY: "Are (X) and (Y) about the same concept, mechanism, or role?"

  NO → go to STEP 2.

  YES → STEP 1b: "Does (X) make (Y) obsolete — same role, newer state?"
    YES → supersedes  { source: X (newer), target: Y (older) }
          Only valid between same category (decision↔decision, blueprint↔blueprint,
          decision↔blueprint). STOP — do not continue to STEP 2 for this pair.
    NO  → STEP 1c: "Does (X) add scope on top of (Y), where (Y) still stands alone?"
      YES → extends  { source: X (addition), target: Y (foundation) }
            STOP — do not continue to STEP 2 for this pair.
      NO  → go to STEP 2.

STEP 2 — CAUSALITY: Ask 2a and 2b independently. A pair can produce both.

  2a — "Would (X) exist if (Y) had never happened?"
    YES → no prompted_by for this pair.
    NO  → DIRECTNESS CHECK before wiring:
      "Is there another block (Z) — in (X)'s chain or in NEW BLOCKS — that (X)
      depends on more directly, where (Z) itself depends on or relates to (Y)?"
        YES → (Y) is an ancestor, not the direct cause. The path from (X) to (Y)
              already runs through (Z). Skip — do not wire prompted_by.
        NO  → (Y) is the most immediate cause.
              prompted_by  { source: X (effect), target: Y (cause) }

  2b — "Would (X)'s claim be unsupported without (Y)'s specific finding?"
    NO  → no based_on for this pair.
    YES → DIRECTNESS CHECK before wiring:
      "Is there another block (Z) that (X) already relies on, where (Z) itself
      draws on (Y) as its evidence?"
        YES → (Y)'s evidence already reaches (X) through (Z). Skip.
        NO  → (Y) is direct evidence for (X).
              based_on  { source: X (claim), target: Y (evidence) }

STEP 3 — RESOLVES: Only ask when (Y) has type = question OR type = hypothesis.

  "Does (X) directly answer or settle what (Y) asks or proposes?"
    YES → resolves  { source: X (answer/finding), target: Y (question/hypothesis) }
    NO  → no relation for this pair.

── TERMINAL ────────────────────────────────────────────────────────────────

After checking every (new block, existing block) pair:
  No question answered YES for any pair → output empty relations array.

── REASONING (REQUIRED PER RELATION) ────────────────────────────────────────

For each emitted relation, the reason field MUST cite SPECIFIC source-target
labels and name which TREE STEP fired (1b supersedes / 1c extends / 2a
prompted_by / 2b based_on / 3 resolves), in ≤200 chars. Mirror Pass 5's
per-chain reasoning shape: WHY this direction, citing the concrete labels.

A reason that says only "they are related" or "X relates to Y" without
naming the TREE STEP that fired fails the contract — do not emit relations
whose direction you cannot defend by naming the specific step.

Examples of valid reasons:
  "2a prompted_by: project-X_decision_databricks would not exist without
   project-X_constraint_no-vendor-lock — constraint was prior."
  "1b supersedes: project-Y_decision_use-postgres is newer same-role
   replacement for project-Y_decision_use-sqlite."

── RULES ───────────────────────────────────────────────────────────────────

- Only output MISSING relations — not already in the graph or in a block's chain
- Only use: extends, supersedes, superseded_by, prompted_by, based_on, resolves
- source_id and target_id must be block labels exactly as shown
- Every relation MUST include a reason field per REASONING above
- Candidates under "[semantically related — UNCONFIRMED]" were surfaced by SIMILARITY,
  not a recorded connection. Link one ONLY when its MEANING clearly matches per the
  tree above — surface resemblance is never enough. When uncertain, answer NO.`;

const PASS4_SCHEMA = {
  type: "object",
  properties: {
    relations: {
      type: "array",
      items: {
        type: "object",
        properties: {
          source_id: { type: "string" },
          type:      { type: "string" },
          target_id: { type: "string" },
          reason:    { type: "string" },
        },
        required: ["source_id", "type", "target_id", "reason"],
      },
    },
  },
  required: ["relations"],
};

export async function callPass4LLM(
  provider: LLMProvider,
  newBlocks: Array<{ id: string; label: string; type: string; essence: string; uniqueFields?: string; chain?: string[] }>,
  projectContext: string,
  thinkingBudget = 512,
  sceneCard?: string,
): Promise<{ result: { relations: Array<{ source_id: string; type: string; target_id: string; reason?: string }> } | null; thinking: string; rateLimited: boolean; model?: string; attempts?: Array<{ model: string; outcome: string }> }> {
  const newBlocksSection = `NEW BLOCKS (just saved this turn):\n${newBlocks.map(b => {
    const chainStr = b.chain && b.chain.length > 0 ? `\n    chain:\n${b.chain.join("\n")}` : "";
    return `  ${b.label} | ${b.id} [${b.type}] — "${b.essence}"${b.uniqueFields ?? ""}${chainStr}`;
  }).join("\n")}\n\n`;

  const projectSection = projectContext
    ? `PROJECT GRAPH (existing blocks — find missing links against these):\n${projectContext}`
    : `PROJECT GRAPH: (empty)`;

  // Scene card is session-level framing — Pass 4 is cross-session linking only,
  // so we don't inject it (it encouraged intra-batch re-derivation).
  const userInput = `${newBlocksSection}${projectSection}`;

  // Resolve the model to use for Pass 4:
  // 1. NODEDEX_PASS4_MODEL env var (explicit override, works for any provider)
  // 2. For Gemini with no override: default to gemini-2.5-pro (Pro thinks reliably)
  // 3. All other providers with no override: use their configured AI_MODEL
  const modelOverride = modelForPass("pass4")
    ?? (provider.getName() === "gemini" ? "gemini-2.5-pro" : undefined);

  const r = await provider.generateStructured<{ relations: Array<{ source_id: string; type: string; target_id: string; reason?: string }> }>(
    PASS4_PROMPT, userInput, PASS4_SCHEMA, { thinkingBudget, modelOverride }
  );

  if (r.usage) {
    reflectTokenStats.pass4.input    += r.usage.input;
    reflectTokenStats.pass4.thinking += r.usage.thinking;
    reflectTokenStats.pass4.output   += r.usage.output;
  }
  reflectTokenStats.pass4.calls += 1;

  if (r.result) {
    const modelTag = modelOverride ? ` [${modelOverride}]` : (provider.getName() !== "gemini" ? ` [${provider.getName()}]` : "");
    console.log(`Auto-Reflect Pass 4: ${r.result.relations?.length ?? 0} relation(s) found | tokens: in=${r.usage?.input ?? "?"} think=${r.usage?.thinking ?? "?"}${modelTag}`);
  } else {
    console.warn(`Auto-Reflect Pass 4: ${r.rateLimited ? "rate limited" : "failed"} — skipping (non-critical)`);
  }

  return { result: r.result, thinking: r.thinking ?? "", rateLimited: r.rateLimited, model: r.model, attempts: r.attempts };
}
