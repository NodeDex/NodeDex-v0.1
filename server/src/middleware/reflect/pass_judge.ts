import { reflectTokenStats } from "./context.js";
import { getThinkingBudget, modelForPass } from "./config.js";
import type { LLMProvider } from "../../engine/ai-provider.js";
import type { Pass1Item } from "./types.js";

// ═══════════════════════════════════════════════════════════════════════════════
// PASS JUDGE — PRECISION FILTER (between Pass 1 and Pass 2)
//
// Job:   For each Pass 1 item, apply the charter §2.1 path-specificity test and
//        return one binary verdict (KEEP | DROP) with a reason_category.
//        Does NOT change types, merge items, or extract anything new.
//
// Role:  Pass 1 maximises recall (finds everything). JUDGE filters for
//        precision (drops scaffolding / general knowledge / merely-named
//        options). Pass 2 then dedups and wires what survived.
//
// Why this is OK to ask the LLM (where the failed pass1-residue reframe was not):
//   • The reframe asked Pass 1 to NOT-EMIT things during extraction — restraint,
//     a weak LLM skill (charter rule 4). The result was inconsistent across
//     domains (over-extraction doc).
//   • JUDGE asks "given this item, is it path-specific?" — a local binary
//     judgment on an existing artifact. That is the LLM's competence.
//
// Charter compliance:
//   rule 3 — semantic per-item judgment → LLM (this), not code.
//   rule 4 — schema enforces per-item local verdict, no batch coordination.
//   rule 6 — never overrides a success: filters at extraction layer, pre-commit;
//            nothing committed to the DB is touched.
//   rule 7 — deterministic on probabilistic input is still probabilistic.
//            Document validation as multi-run + read reasoning, not single-run.
//   rule 14 — uses the §2.1 sharpened worth test verbatim.
// ═══════════════════════════════════════════════════════════════════════════════

export const PASS_JUDGE_PROMPT = `You receive items extracted from one session of an AI agent
working on a project. The extractor maximises RECALL — it finds every discrete claim it can.
Your job is to apply a single binary worth test to each item and decide KEEP or DROP.

You do NOT change item types. You do NOT merge items. You do NOT extract anything new.
Cover every input item exactly once.

── THE TEST (one question, applied per item) ────────────────────────────────
"Could a competent instance of the model — given the project context, but WITHOUT having
lived this session — already know this item, or trivially produce it?"

  YES → general knowledge / scaffolding the model already carries → DROP.
  NO  → specific to this session's lived path → KEEP.

The session is what makes an item path-specific. "The model already knows it" is what makes
it scaffolding. The test is the same for every type.

── ASYMMETRIC COST (calibration, not restraint) ─────────────────────────────
A dropped decision, dead_end, or constraint is UNRECOVERABLE — it was forged in this
session and will not come back if discarded. So is a session-specific observation,
measurement, or stated value: a model cannot reproduce a number someone measured here,
and a conclusion loses its grounding when the finding it rests on is dropped.
Only a GENERAL-KNOWLEDGE fact — one the model already carries — is FREE; that, and only
that, the model produces again on demand.

  When uncertain → KEEP.
  The default verdict is KEEP. DROP only when you can name the general source the item
  duplicates, or identify the specific scaffolding test it fails (below).

── CLARIFYING TESTS — two faces of the same one question ────────────────────

TEST A — Considered options.
  If the item describes an approach or option the agent considered:
    • Did the agent CHOOSE this approach? → residue (decision). KEEP.
    • Did the agent ENTER this approach then ABANDON it with a reason? → residue
      (dead_end). KEEP.
    • Did the agent merely NAME this approach while thinking, without choosing
      or trying it? → it left no residue; the list of options is general knowledge
      the model would generate on demand. DROP with reason_category = option_merely_named.

TEST B — Why vs When.
  If the item describes causality or sequence:
    • Does it carry a WHY — the transferable validity condition (this holds because
      of that)? → residue future sessions can use. KEEP.
    • Does it carry only a WHEN — a procedural sequence (do X, then Y, then Z) with
      no reason recorded? → procedural scaffolding the model can re-derive from
      the decisions. DROP with reason_category = procedural_when_sequence.

If neither clarifying test applies and the spine question above returns DROP, use
reason_category = general_knowledge.

── PER-ITEM LOCALITY ────────────────────────────────────────────────────────
Judge each item INDEPENDENTLY against the spine question. Do not look at how many you
have kept or dropped overall. Do not balance the batch. Do not consider what other
items might do. Each verdict is local to its item.

── OUTPUT ──────────────────────────────────────────────────────────────────
For every input item, emit exactly one verdict record:
  { item_id, verdict: "KEEP" | "DROP", reason_category, notes? }

reason_category is REQUIRED.
  For KEEP : "path_specific_residue"
  For DROP : "general_knowledge" | "option_merely_named" | "procedural_when_sequence"
notes is OPTIONAL — one short sentence — use only when the standard reason_category does
not adequately capture why you decided as you did.

Do not invent item ids. Do not change item types. Do not omit any input item.
`;

const PASS_JUDGE_SCHEMA = {
  type: "object",
  properties: {
    verdicts: {
      type: "array",
      items: {
        type: "object",
        properties: {
          item_id: { type: "string" },
          verdict: { type: "string", enum: ["KEEP", "DROP"] },
          reason_category: {
            type: "string",
            enum: ["path_specific_residue", "general_knowledge", "option_merely_named", "procedural_when_sequence"],
          },
          notes: { type: "string" },
          reasoning: { type: "string" },
        },
        required: ["item_id", "verdict", "reason_category"],
      },
    },
  },
  required: ["verdicts"],
};

export interface PassJudgeVerdict {
  item_id: string;
  verdict: "KEEP" | "DROP";
  reason_category: "path_specific_residue" | "general_knowledge" | "option_merely_named" | "procedural_when_sequence";
  notes?: string;
  reasoning?: string; // all-sources mode: per-item two-prong rationale (changes-action AND unrecoverable)
}

export interface PassJudgeResult {
  verdicts: PassJudgeVerdict[];
}

// Appended ONLY when a USER turn is present (NODEDEX_EXTRACT_ALL_SOURCES on). Gives
// JUDGE the verbatim excerpt + the user turn so the (novelty) worth spine judges the
// SOURCE not the paraphrase, and requests a per-item rationale (auditability, Rule 8).
// The worth AXIS is unchanged — the spine's path-specific test (charter §1/§2.1).
// (The two-prong worth-axis was reverted 2026-06-04: over-extraction is GRANULARITY,
//  not worth — fixed by the Pass 2 fold, not a sharper filter. See fragmentation memo.)
const PASS_JUDGE_TWO_PARTY_SUFFIX = `

── TWO-PARTY INPUT + VERBATIM (present) ────────────────────────────────────
The session evidence includes a USER turn, and each item now carries its excerpt — the
verbatim source span. Judge worth against the verbatim and the full exchange, not the
paraphrased text alone: a paraphrase can read like general knowledge even when the
source shows it was chosen, tried, or stated by the user this session.
For each verdict, put a one-line rationale in the reasoning field: what makes it
path-specific residue, or which general source it duplicates.`;

// Appended ONLY when the caller supplies each item's structural ROLE (the
// context-aware judge, NODEDEX_V2_JUDGE_CONTEXT). Lets worth include a block's role in
// the session's reasoning — NOT a quota signal. Threads the PER-ITEM LOCALITY needle
// explicitly so the judge doesn't start balancing the batch.
const PASS_JUDGE_ROLE_SUFFIX = `

── STRUCTURAL ROLE (present) ────────────────────────────────────────────────
Each item now carries a "role" field — what DEPENDS ON it and what it BUILDS ON in this
session's reasoning (e.g. "needed-by decision; builds-on fact"). Weigh it: a block that
another block's reasoning RESTS ON is path-specific residue BY ITS ROLE — keep it even
when its sentence reads like plain knowledge, because dropping it strands what depends on
it. A block with no role line is judged on its text alone, exactly as before.
This does NOT relax the per-item rule: you are still judging whether THIS item carries
residue (now including its structural role) — never balancing the set or matching a quota.
When the role changed your verdict, say so in the reasoning field (e.g. "kept — needed-by
a decision, would strand it").`;

export async function callPassJudgeLLM(
  provider: LLMProvider,
  pass1Items: Pass1Item[],
  sceneCard: string | undefined,
  agentThinking: string,
  agentOutput: string,
  thinkingBudget = 1024,
  userMessage: string = "",
  roleById: Record<string, string> = {},
): Promise<{ result: PassJudgeResult | null; rateLimited: boolean; model?: string; attempts?: Array<{ model: string; outcome: string }> }> {
  const sceneCardSection = sceneCard
    ? `SCENE CARD (structural shape of this session's path):\n${sceneCard}\n\n---\n\n`
    : "";
  const thinkingSection = agentThinking
    ? `AGENT THINKING:\n${agentThinking}\n\n---\n\n`
    : "";
  // Compact items payload — id + provisional_type + text — schema-shaped so the
  // model can address them by id without seeing internal Pass 1 fields.
  const includeUserTurn = !!(userMessage && userMessage.trim());
  const includeRole = Object.keys(roleById).length > 0; // context-aware judge (v2)
  const compactItems = pass1Items.map(i => {
    const c: Record<string, unknown> = { id: i.id, provisional_type: i.provisional_type, text: i.text };
    if (includeUserTurn) c.excerpt = i.excerpt; // carry the verbatim so worth is judged on source, not paraphrase
    if (includeRole && roleById[i.id]) c.role = roleById[i.id]; // structural role for context-aware worth
    return c;
  });
  const itemsSection = `ITEMS TO JUDGE (each receives exactly one verdict):\n${JSON.stringify(compactItems, null, 2)}`;

  const userSection = includeUserTurn ? `USER:\n${userMessage}\n\n---\n\n` : "";
  const userInput = `${sceneCardSection}${userSection}${thinkingSection}AGENT OUTPUT:\n${agentOutput}\n\n---\n\n${itemsSection}`;
  let judgePrompt = PASS_JUDGE_PROMPT;
  if (includeUserTurn) judgePrompt += PASS_JUDGE_TWO_PARTY_SUFFIX;
  if (includeRole) judgePrompt += PASS_JUDGE_ROLE_SUFFIX;

  const r = await provider.generateStructured<PassJudgeResult>(judgePrompt, userInput, PASS_JUDGE_SCHEMA, {
    thinkingBudget,
    maxOutputTokens: 8192,
    modelOverride: modelForPass("judge"),
  });

  if (r.result && !Array.isArray((r.result as any).verdicts)) {
    // SEAM contract: a judge result MUST carry verdicts[]. Provider variance can
    // return a truthy object without it, and consuming that crashes every caller
    // (.filter on undefined took down the whole v2 front-half, 2026-06-11).
    // Malformed = failed → null it so the KEEP-ALL degrade below applies (a failed
    // selector must never drop residue).
    console.warn("Auto-Reflect JUDGE: malformed result (missing verdicts[]) — treating as failed");
    r.result = null;
  }
  if (r.result) {
    // Judge has its own token slot so cost_breakdown attributes it once, to the
    // judge — not double-counted against pass1 (D-fix 2026-05-25).
    reflectTokenStats.pass_judge.input    += r.usage?.input    ?? 0;
    reflectTokenStats.pass_judge.thinking += r.usage?.thinking ?? 0;
    reflectTokenStats.pass_judge.output   += r.usage?.output   ?? 0;
    reflectTokenStats.pass_judge.calls    += 1;
    const drops = r.result.verdicts.filter(v => v.verdict === "DROP");
    const cats = drops.reduce<Record<string, number>>((acc, v) => { acc[v.reason_category] = (acc[v.reason_category] || 0) + 1; return acc; }, {});
    const catSummary = Object.entries(cats).map(([k, n]) => `${k}=${n}`).join(", ") || "(none)";
    console.log(`Auto-Reflect JUDGE: ${pass1Items.length} → ${pass1Items.length - drops.length} kept (${drops.length} dropped: ${catSummary}) | tokens: in=${r.usage?.input ?? "?"} think=${r.usage?.thinking ?? "?"} out=${r.usage?.output ?? "?"}`);
    for (const v of drops) {
      const note = v.notes ? ` — ${v.notes}` : "";
      console.log(`  [JUDGE drop] ${v.item_id} [${v.reason_category}]${note}`);
    }
    // all-sources mode emits a two-prong rationale per item — log it so keep/drop is auditable
    for (const v of r.result.verdicts) {
      if (v.reasoning) console.log(`  [JUDGE ${v.verdict}] ${v.item_id} :: ${v.reasoning}`);
    }
  } else {
    console.warn(`Auto-Reflect JUDGE: ${r.rateLimited ? "rate limited" : "failed"} — degrading to KEEP-ALL (no items dropped)`);
  }

  return { result: r.result, rateLimited: r.rateLimited, model: r.model, attempts: r.attempts };
}

/**
 * Apply judge verdicts to Pass 1 items, with safe ref-cleanup.
 *
 * Rules:
 *   1. If judge result is null (call failed), pass-through ALL items — judge failure
 *      must never silently drop residue. Precision is an improvement, not a blocker.
 *   2. If a KEPT item references a DROPPED item via extends_id (the only intra-batch
 *      reference Pass 1 carries), override the drop and KEEP the parent too. Never
 *      lose an anchor of something we're keeping — preserves the asymmetric cost.
 *      Records the override for audit.
 *   3. Items missing from the judge's verdicts default to KEEP (defensive — never
 *      silently drop on judge omission).
 *
 * Returns the kept item set, the final dropped verdicts (post-override), and the list
 * of anchor overrides for the turn log.
 */
export function applyJudgeVerdicts(
  pass1Items: Pass1Item[],
  judge: PassJudgeResult | null,
): { kept: Pass1Item[]; dropped: PassJudgeVerdict[]; anchorOverrides: string[] } {
  if (!judge) return { kept: pass1Items, dropped: [], anchorOverrides: [] };

  const verdictById = new Map<string, PassJudgeVerdict>(judge.verdicts.map(v => [v.item_id, v]));
  const dropIds = new Set<string>();
  for (const v of judge.verdicts) {
    if (v.verdict === "DROP") dropIds.add(v.item_id);
  }

  // Anchor override: if a kept item's extends_id points to a dropped item, override
  // the drop. Pass 1's "extends_id" by definition means the child is meaningless
  // without the parent — keeping the child requires keeping the parent.
  const anchorOverrides: string[] = [];
  for (const item of pass1Items) {
    if (!item.extends_id) continue;
    if (dropIds.has(item.id)) continue; // child is dropped too — cascade is fine
    if (dropIds.has(item.extends_id)) {
      dropIds.delete(item.extends_id);
      anchorOverrides.push(item.extends_id);
    }
  }

  // Final dropped set: only verdicts whose ids are still in dropIds after overrides
  const dropped = judge.verdicts.filter(v => v.verdict === "DROP" && dropIds.has(v.item_id));
  const kept = pass1Items.filter(i => !dropIds.has(i.id));
  return { kept, dropped, anchorOverrides };
}
