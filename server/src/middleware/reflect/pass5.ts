import { reflectTokenStats } from "./context.js";
import { getThinkingBudget, modelForPass } from "./config.js";
import type { LLMProvider } from "../../engine/ai-provider.js";
import type { Pass5Result } from "./types.js";

// ═══════════════════════════════════════════════════════════════════════════════
// PASS 5 — CHAIN ASSEMBLY
// Job: find causally connected clusters in this turn's new blocks and name them
// as retrievable chain objects. Runs after Pass 4 has wired all relations.
// ═══════════════════════════════════════════════════════════════════════════════

const PASS5_PROMPT = `You receive blocks saved this turn and the causal relations between them.

── STATE CONVENTION ─────────────────────────────────────────────────────────
"State" in this prompt = text in marked regions below (NEW BLOCKS THIS TURN,
CAUSAL RELATIONS BETWEEN THEM). Your training knowledge of "how such arcs
typically conclude" is NOT state. A committed conclusion exists ONLY if a
member block in NEW BLOCKS has the right type and the cluster's relations
terminate on it. Familiarity with the domain's typical patterns is irrelevant.

Your job: find clusters of causally connected blocks and assemble each into a named chain.

── WHAT IS A CHAIN ───────────────────────────────────────────────────────────

A chain is a named arc that captures a complete story: evidence or failures led
to a committed conclusion. It is a retrievable summary of how a cluster of blocks
resolved into an outcome.

A chain requires:
  - At least 2 blocks connected by a causal-thread relation: prompted_by, based_on,
    supports (X is evidence for Y — e.g. a specific failure supports a general
    dead-end), supersedes, or resolves
  - A committed conclusion — ask: "Does this cluster end in a block that represents
    a closed outcome — something the cluster produced or resolved — not just an
    observation, a work-in-progress, or accumulated context?"

    Committed conclusion (valid terminus):
      (X) was chosen from real alternatives              → decision
      (X) was established as an external boundary        → constraint
      (A) + (B) were synthesised into a new conclusion   → insight, reasoning_chain
      (X) was definitively replaced or abandoned         → dead_end as final block

    NOT a committed conclusion (do not create a chain):
      (X) is true — observation with no resolution attached  → fact alone
      (X) is planned but not yet built or confirmed          → blueprint
      (X) is being worked on                                 → task
      A cluster where every block is accumulated context with no arc produced

  - The blocks must be from the same project

Do NOT create a chain for:
  - A single block with no causal connections
  - A cluster with no committed conclusion (open arcs, pure accumulation, tasks only)
  - Blocks from different projects (each project gets its own chain)

── CHAIN NAMING ──────────────────────────────────────────────────────────────

{project}_chain_{capability-area}

  project          = the project prefix (same as member blocks)
  capability-area  = the system capability this arc resolved
                     Name the WHAT (the capability), not the HOW (mechanism)
                     and not the WHY (cause). 2-4 words, hyphens only.

  "What system capability now exists or changed because of this arc?"
  That answer is the capability-area.

  Test: "What system capability now exists or changed because of this arc?"
  The answer to that question is the capability-area.
  Strip "because", "using", "via", "from" — what remains is the concept.
  Name the RESULT (what now works), not the PROCESS (how it was achieved).

── CHAIN ESSENCE ─────────────────────────────────────────────────────────────

One sentence, ≤140 chars. The compressed story: what was tried/required, what
failed or was imposed, what was adopted. Should stand alone as a summary.

  "First approach hit scaling limit; second approach had prohibitive overhead cost; third approach adopted as primary solution"
  "First method showed high variance across sites; second method validated at acceptable consistency; second method adopted as standard"

── MEMBERS AND ARC ───────────────────────────────────────────────────────────

members: block labels in causal order — cause-first, outcome-last.
arc:     type sequence matching members order, e.g. "fact → dead_end → decision"

── CONCLUSION ────────────────────────────────────────────────────────────────

conclusion: the specific committed outcome this arc produced.
            A noun phrase (≤80 chars) naming what now exists or is established.
            This is the terminal answer to "what did this arc resolve into?"

  NOT a restatement of the essence. NOT a sentence. NOT the mechanism.
  The WHAT — the named capability, decision, or practice that now exists.

  Test: "What named capability, decision, or practice now exists?"
  Must be a noun phrase (≤80 chars), not a sentence.
  Name the WHAT (capability), not the HOW (mechanism).
  Strip "by", "through", "via" — what remains is the conclusion.

── REASONING (REQUIRED PER CHAIN) ────────────────────────────────────────────

For each chain emit a reasoning field that explains WHY in two parts, naming
specific member blocks:

  1. WHY THESE MEMBERS: which causal relations make these blocks one cluster
     (cite the specific prompted_by / based_on / supports / supersedes / resolves
     links that bind them; explain why excluded blocks are excluded if relevant).
  2. WHY THIS CONCLUSION: which member block is the committed terminus and
     which terminus test it passes ("decision: chosen from real alternatives" /
     "constraint: established as external boundary" / "insight: synthesised
     from A+B" / "dead_end: definitively abandoned as final").

Reasoning must reference SPECIFIC block labels — not generic phrasing. A
chain whose reasoning cannot name the concrete cluster-link and the concrete
terminus-block fails the WHAT-IS-A-CHAIN test; do not emit it.

── OUTPUT ────────────────────────────────────────────────────────────────────

Return chains[] with one entry per valid cluster. Each entry includes the
reasoning field per the section above.
If no valid clusters exist → return chains: []`;

const PASS5_SCHEMA = {
  type: "object",
  properties: {
    chains: {
      type: "array",
      items: {
        type: "object",
        properties: {
          chain_label:   { type: "string" },
          chain_essence: { type: "string" },
          arc:           { type: "string" },
          conclusion:    { type: "string" },
          members:       { type: "array", items: { type: "string" } },
          reasoning:     { type: "string" },   // per-chain WHY (members + conclusion)
        },
        required: ["chain_label", "chain_essence", "arc", "conclusion", "members", "reasoning"],
      },
    },
  },
  required: ["chains"],
};

export type Pass5CallResult = {
  result: Pass5Result | null;
  rateLimited: boolean;
  model?: string;
  attempts?: Array<{ model: string; outcome: string }>;
};

export async function callPass5LLM(
  provider: LLMProvider,
  newBlocks: Array<{ id: string; label: string; type: string; essence: string }>,
  causalRels: Array<{ source_id: string; target_id: string; type: string }>,
): Promise<Pass5CallResult> {
  if (newBlocks.length < 2) return { result: null, rateLimited: false };

  const blockById = new Map(newBlocks.map(b => [b.id, b]));

  // Only include relations where both ends are in new blocks
  const relevantRels = causalRels.filter(r => blockById.has(r.source_id) && blockById.has(r.target_id));
  if (relevantRels.length === 0) return { result: null, rateLimited: false };

  const blocksSection = `NEW BLOCKS THIS TURN:\n${newBlocks.map(b => {
    return `  ${b.label} [${b.type}] — "${b.essence}"`;
  }).join("\n")}\n`;

  const relsSection = `\nCAUSAL RELATIONS BETWEEN THEM:\n${relevantRels.map(r => {
    const src = blockById.get(r.source_id);
    const tgt = blockById.get(r.target_id);
    return `  ${src?.label} --[${r.type}]--> ${tgt?.label}`;
  }).join("\n")}`;

  const userInput = blocksSection + relsSection;

  const r = await provider.generateStructured<Pass5Result>(PASS5_PROMPT, userInput, PASS5_SCHEMA, {
    thinkingBudget: getThinkingBudget(512), // respects NODEDEX_THINKING_BUDGET; pass5 bills its share
    modelOverride: modelForPass("pass5"),
  });

  // debt-4 §3: pass5 has its OWN bucket. Pre-fix this incremented pass4's bucket
  // ("pass5 is lightweight, no separate counter needed") which inflated pass4
  // cost AND hid pass5 from cost_breakdown. Empirically pass5 wall_ms is ~5-12s
  // and it bills thinking — not lightweight enough to merge.
  if (r.usage) {
    reflectTokenStats.pass5.input    += r.usage.input    ?? 0;
    reflectTokenStats.pass5.thinking += r.usage.thinking ?? 0;
    reflectTokenStats.pass5.output   += r.usage.output   ?? 0;
  }
  reflectTokenStats.pass5.calls += 1;

  if (r.result) {
    console.log(`Auto-Reflect Pass 5: ${r.result.chains?.length ?? 0} chain(s) assembled | tokens: in=${r.usage?.input ?? "?"} think=${r.usage?.thinking ?? "?"} out=${r.usage?.output ?? "?"}`);
  } else {
    console.warn(`Auto-Reflect Pass 5: ${r.rateLimited ? "rate limited" : "failed"} — skipping (non-critical)`);
  }

  return { result: r.result ?? null, rateLimited: r.rateLimited, model: r.model, attempts: r.attempts };
}
