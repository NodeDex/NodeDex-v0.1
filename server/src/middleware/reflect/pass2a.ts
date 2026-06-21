// ═══════════════════════════════════════════════════════════════════════════════
// PASS 2a — CLASSIFY ONLY  (Week 2, debt #1, 2026-05-25)
//
// Role:  The first of three sub-passes in the Pass 2 split (see
//        docs/PASS2-SPLIT-DESIGN.md §2 Pass ownership). Decides WHAT each
//        item IS — its epistemic type, project, hierarchy, dedup verdict,
//        and supersession references — but does NOT fill `unique{}` (2b's
//        job) and does NOT wire causal relations (2c's job).
//
// What this pass DOES (§2 ownership):
//   - Q0 DEDUP — intra-batch first, then against PROJECT GRAPH
//   - Q1 TYPE — 5 TEST structural checks for type override
//   - Q2 HIERARCHY — extends_item assignment
//   - PROJECT ATTRIBUTION — every item gets a project
//   - SUPERSEDES_REF / RESOLVED_REF — label/ID references
//   - REVIEW FLAGS — type_override, weak_match, etc.
//   - CLASSIFICATION REASONING — 1-2 sentence WHY per item
//   - NOVEL TYPE — defines schema{} if a novel type fires
//
// What this pass does NOT do (anti-examples, §2):
//   - Fill `unique{}` — that's Pass 2b
//   - Emit `triggered_by_items`, `based_on_items`, `relations` — that's Pass 2c
//   - Run schema validation — Tier 1B at Seam α (post-2b) does that
//   - Reach the live DB — pure data transform, no side effects
//
// Status:
//   - Standalone file. NOT wired into pipeline.ts yet (Week 2 wiring is the
//     next step). Callable in tests with synthetic inputs.
//   - `pass2.ts` is FROZEN per §4 — this file does NOT replace it. Both
//     coexist; routing is via NODEDEX_PASS2_SPLIT=1 flag (default off).
//
// Charter alignment:
//   - Rule 6 (guards catch failure, never override success): 2a is one
//     guard in a chain (2a → Seam α → 2b → Seam β → 2c). A guard that
//     fails simply hands a clean failure to the next layer; this pass
//     never destroys data.
//   - Rule 7 (determinism is local): structured output schema is
//     deterministic from the LLM's perspective; reasoning trace makes
//     each decision auditable.
//   - Rule 14 (store the path): every classified item carries
//     `classification_reasoning` — the WHY is not regenerable, must persist.
// ═══════════════════════════════════════════════════════════════════════════════

import { CONFIG } from "./config.js";
import type { LLMProvider } from "../../engine/ai-provider.js";
import type { Pass1Item } from "./types.js";

// ─── Types ─────────────────────────────────────────────────────────────────────

/**
 * Pass 2a output per item — a SUBSET of `Pass2Item` (defined in types.ts).
 *
 * Critical absences (enforced by schema, asserted by pass2-pass-ownership tests):
 *   - NO `unique` (2b populates it)
 *   - NO `triggered_by_items` / `based_on_items` / `relations` (2c populates them)
 *   - NO `note` (deferred — 2c may emit if needed)
 *
 * `text` is NOT emitted by the LLM (the schema omits it — see PASS2A_SCHEMA).
 * It is re-joined from the Pass 1 input by `id` inside callPass2aLLM so the
 * returned Pass2aResult is complete for downstream (orchestrator/composer →
 * Pass2Item.text). Source of truth = Pass 1, not an LLM echo — removes
 * output-token waste + paraphrase risk (project-future-enhancements #6).
 *
 * `schema` is populated ONLY for novel_type items where 2a coined a new type
 * and must declare its field definitions (§2 Pass 2a ownership, last bullet).
 */
export interface Pass2aItem {
  id: string;
  text: string;
  type: string;
  project?: string;
  extends_item?: string;
  supersedes_ref?: string;
  resolved_ref?: string;
  schema?: Record<string, string>;
  review_reason?: string;
  classification_reasoning?: string;
  source_type?: string;  // set by the orchestrator on demote (e.g. "seam_demoted"); carried by composeForDownstream → Pass2Item → blocks.source_type. Not emitted by the 2a LLM.
  excerpt?: string;      // DEBT 5 D3 (§2.3.2): re-joined from Pass1Item.excerpt in callPass2aLLM. Not emitted by the LLM (PASS2A_SCHEMA omits it — same pattern as text). Carries through composeForDownstream → Pass2Item.excerpt → blocks.source_excerpt for line-level provenance.
}

/**
 * Pass 2a result envelope. `skipped[]` carries Q0 dedup drops only — items
 * that failed structural checks at Seam α are NOT in `skipped[]` here;
 * they reach quarantine via the seam validator (see pass2-seams.ts).
 */
export interface Pass2aResult {
  skipped:    Array<{ id: string; reason: string }>;
  classified: Pass2aItem[];
}

// ─── Prompt ────────────────────────────────────────────────────────────────────
//
// Derived from PASS2_PROMPT in pass2.ts by REMOVING two sections per §2:
//   - "UNIQUE FIELDS — populate AFTER type is final" (Pass 2b's job)
//   - "CAUSAL WIRING (output AFTER classified[])" + Q3/Q4/Q5 (Pass 2c's job)
//
// All other sections preserved verbatim from pass2.ts. The processing-order
// line at top is updated since 2a no longer outputs `unique` or
// `causal_wiring[]`. SCENE CARD CONTEXT note about CAUSAL LINKS is
// retained because dedup (Q0) still benefits from scene-card context;
// the "use in Q3" instruction inside that block is moot but harmless
// (it references rules that aren't in this prompt — the model just
// can't use them).
//
// DELIBERATE PRESERVATION:
//   - Q5 SEMANTIC RELATIONS belongs to 2c — removed here.
//   - The "ASYMMETRIC COST" callout stays (it's a dedup discipline, not a
//     wiring discipline).
//   - REVIEW FLAGS enum stays whole (2a sets these flags).

export const PASS2A_PROMPT = `You receive extracted items from an agent session.
Each item has a provisional_type set by Pass 1 based on surface form.

── ARC-MODE NOTE (DEBT 5 D4, applies when input is multi-turn arc) ──────────
If the input begins with "[ARC EXTRACTION — agent_id=..., turns S-E, N turn(s)]"
header AND items carry IDs prefixed "item_T<turn>_<n>", you are reading ONE
CONTINUOUS CONVERSATION ARC, not N independent turns. Treat it that way:
  - Items mentioned in MULTIPLE turns about the SAME thing → ONE item, not
    duplicates needing supersedes. Sew them together via your DEDUP pass (Q0).
  - The conversation flowed as one ongoing thought; [TURN N] headers mark
    sequence only.
  - Use the chronological order to reason about cross-turn causal links
    (decisions built progressively, dead-ends abandoned then re-considered).
For single-turn input (no ARC header), behave as before — this section is a
no-op.

── STATE CONVENTION ─────────────────────────────────────────────────────────
"State" in this prompt = text in marked regions below (PROJECT GRAPH, SCENE CARD,
PREVIOUS TURN ENTITY MAP, ITEMS FROM PASS 1). Your training knowledge and
"what's commonly known about this domain" are NOT state. A claim is "already
recorded" ONLY if a block in PROJECT GRAPH has a matching essence text or
unique{} field value. Familiarity ≠ recorded. The fact that something is widely
known, famous, or established in the field is irrelevant to dedup.

Your job: verify the type, dedup the batch, assign project + supersession refs.
Processing order: DEDUP (Q0) → TYPE (Q1) → HIERARCHY (Q2) → classified[].
DO NOT output unique{} fields and DO NOT output causal links — those are
handled by later passes. Output ONLY the type + project + reasoning + refs.
Reference each item by its id only — do NOT echo the item's text back; the
system already has it from Pass 1.

── Q0: DEDUP — intra-batch first, then against PROJECT GRAPH ──
"Does this item add a claim not already covered — by another item in this same
batch, or by a block in PROJECT GRAPH?"

For EVERY item, walk these steps in order. Stop at the first verdict.

STEP I — Intra-batch duplicate (check before the graph):
  "Does another ITEM in this batch make the SAME claim — same type, same
  specific subject and values? Two items can word it differently and still be
  the same claim; a merely related claim is NOT the same claim."
  YES → keep exactly ONE — the item with the more complete text. The other
        does not become a block: do not emit it in classified[], and do not
        put it in skipped[] — simply omit it. In the kept item's
        classification_reasoning, name the dropped item's id.
  NO  → proceed to STEP 0.

STEP 0 — Pre-check before graph dedup:
  PROJECT GRAPH empty (no blocks shown at all) → item is GENUINELY NEW. Stop.
  Item's project absent from PROJECT GRAPH → item is GENUINELY NEW. Stop.
  Item's (project, provisional_type) pair has no matching blocks → GENUINELY NEW. Stop.
  Only when one or more concrete candidate blocks exist → proceed to STEP A.

STEP A — Identify candidate blocks in PROJECT GRAPH by project prefix + provisional type.
  Each candidate has a visible essence and (sometimes) unique{} values.
  Ask: "Would the item and the candidate be saying the SAME THING or DIFFERENT
  THINGS as graph blocks?" Same = same specific claim with same values. Related
  topic ≠ same claim.

STEP B — "Is this turn CHANGING the recorded state, or CONFIRMING what is
recorded in PROJECT GRAPH?" The comparison is against the candidate's ESSENCE
TEXT and UNIQUE FIELD VALUES — not against domain knowledge.

  NOTHING NEW (same claim, same value, candidate already says it) → skipped[].
  UPDATES (same claim, CHANGES outcome/value) → classify + supersedes_ref = candidate label.
    "Is the old block still the CURRENT STATE?" NO → supersedes_ref. YES but wrong → contradicts.
    NOT UPDATES: item USES or BUILDS ON the candidate → GENUINELY NEW.
  GENUINELY NEW → classify normally.

SKIP EVIDENCE — falsifiability rule:
  A skip in skipped[] makes a claim about PROJECT GRAPH state. The reason must
  reference the specific block — by label or by its essence text — that the
  skip is checked against. If you cannot point to a block in PROJECT GRAPH that
  a reader could verify the claim against, the claim is unfalsifiable: classify
  the item, do not skip it.

ASYMMETRIC COST: false skip = permanent data loss. false save = minor bloat.
When in doubt at any step, default to GENUINELY NEW.

── Q1: TYPE — "What is the speaker's EPISTEMIC STANCE toward this claim?" ──
Type = speaker's relationship to knowledge, not content topic.
extends_id and type are independent axes. Apply Q1 regardless.

Pass 1's type is correct unless one of these structural tests fires:

  TEST 1: "Same quantity at two distinct points — showing a change?"
    YES → metric. Single value alone = fact.

  TEST 2: "Expected answer or proposed mechanism BEFORE confirmation?"
    YES → hypothesis. Already confirmed → remains fact.

  TEST 3: "CLOSING something or ADOPTING something?"
    ADOPTING → decision.
    CLOSING → "Were resources committed INTO this path before closure?"
      "If I removed the closing event, would there be active work to stop?"
      YES → dead_end. NO (only analysis, never entered) → fact.
      EXTERNAL FORCE closed it → constraint.

  TEST 4: "Has an outcome already been selected and closed?"
    YES → decision. Path committed, destination unknown → blueprint. Nothing committed → question.

  TEST 5: "PROJECT GRAPH has same concept with different type?"
    YES → align with graph's type. Set review_reason = "graph_align".

When overriding, set review_reason = "type_override".
When keeping, fill classification_reasoning explaining why it held.

NOVEL TYPE: all three must pass — (1) future agent would behave differently than any existing type,
(2) can't be expressed as existing type + richer unique{}, (3) name describes epistemic stance not content shape.
→ set type, define schema{} with 2-3 fields, review_reason = "novel_type".

BLUEPRINT → DECISION: planned/uncertain → active/current? → decision + supersedes_ref to blueprint label.
UNCERTAIN ITEMS: preserve type. Never downgrade. Set review_reason = "incomplete_context".

── Q2: HIERARCHY — "Can this item stand alone as knowledge?" ───────────────
"If I deleted the item it points to, would THIS item make sense standalone?"
  YES → clear extends_item. NO → set extends_item = that item's ID.
Captures MEANING DEPENDENCY, not topic relatedness. Type does not change.

── PROJECT ATTRIBUTION ─────────────────────────────────────────────────────
Every item MUST get a project. Decide in order:
  1. Item is about one specific named system/project → that project (a valid root
     from PROJECT GRAPH or scene card PROJECTS; use APPROACHES project tags).
  2. Item is cross-cutting — background/intro context, a field-level conclusion,
     or a question or comparison spanning multiple projects → the SCOPE PROJECT
     named in the scene card.
The scene card always names a scope project; it is the home for anything that
belongs to no single project. "null", "", "unknown", "general" are never valid
project values — if you cannot name a specific project, the answer is the scope
project, not a placeholder.

── SUPERSEDES_REF ──────────────────────────────────────────────────────────
"After this item exists, is the old block still the CURRENT STATE?"
  NO → supersedes_ref = old label. YES but wrong → contradicts relation (handled by Pass 2c).
  Within-batch: predecessor item ID. Cross-batch: exact label from PROJECT GRAPH.
resolved_ref — label for same entity by different name. High confidence only.

── REVIEW FLAGS ────────────────────────────────────────────────────────────
Set review_reason when not confident: type_override, weak_match, no_evidence,
project_uncertain, incomplete_context, graph_align, novel_type. Empty when confident.

── CLASSIFICATION REASONING (required) ─────────────────────────────────────
For EVERY item: 1-2 sentences — which test determined the outcome and what evidence.

── SCENE CARD CONTEXT ──────────────────────────────────────────────────────
APPROACHES → engagement level (for TEST 3) and project tags.
UNCHANGED → source="recap", Q0 handles. TASKS → active work.

`;

// ─── Output schema ─────────────────────────────────────────────────────────────
//
// Subset of PASS2_SCHEMA (defined in pass2.ts) — drops `unique`,
// `triggered_by_items`, `based_on_items`, `relations`, `note`, the
// `causal_wiring` top-level array, AND `text` (project-future-enhancements #6,
// 2026-05-25: 2a echoing verbatim text inflated output → caused refund
// truncation@16384 → 321s; text is already known from Pass 1 input, so
// callPass2aLLM re-joins it by `id` after the LLM returns).
//
// Why explicitly forbidding `unique` (not just omitting it)?
//   - Schema-only output. If the model emits `unique`, structured-output
//     validation will silently accept extra properties unless we constrain.
//     Defense in depth: keep `unique` out of the schema so any leakage is
//     visible in pass-log output.
//
// Exported so tests can lock the contract (text-not-required, etc).

export const PASS2A_SCHEMA = {
  type: "object",
  properties: {
    skipped: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id:     { type: "string" },
          reason: { type: "string" },
        },
        required: ["id", "reason"],
      },
    },
    classified: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id:                       { type: "string" },
          type:                     { type: "string" },
          project:                  { type: "string" },
          extends_item:             { type: "string" },
          supersedes_ref:           { type: "string" },
          resolved_ref:             { type: "string" },
          review_reason:            { type: "string" },
          schema:                   { type: "object" },
          classification_reasoning: { type: "string" },
        },
        required: ["id", "type", "project", "classification_reasoning"],
      },
    },
  },
  required: ["skipped", "classified"],
};

// ─── Output sanitizer ──────────────────────────────────────────────────────────
//
// Defense in depth: even if the model leaks `unique` or `triggered_by_items`
// (e.g. by ignoring the schema), strip those keys from each classified item.
// This enforces §1 Seam α contract: 2b is the only writer of `unique`; 2c is
// the only writer of wiring.
//
// Exposed as a pure function so tests can verify the contract independently.

const FORBIDDEN_KEYS_ON_PASS2A_OUTPUT = ["unique", "triggered_by_items", "based_on_items", "relations", "note"] as const;

export function sanitizePass2aItem(raw: Record<string, unknown>): { item: Pass2aItem; stripped: string[] } {
  const stripped: string[] = [];
  const item: any = { ...raw };
  for (const k of FORBIDDEN_KEYS_ON_PASS2A_OUTPUT) {
    if (k in item) {
      stripped.push(k);
      delete item[k];
    }
  }
  return { item: item as Pass2aItem, stripped };
}

export function sanitizePass2aResult(raw: { skipped?: any[]; classified?: any[] }): {
  result: Pass2aResult;
  totalStrippedFields: number;
  perItemStripped: Array<{ id: string; stripped: string[] }>;
} {
  const perItemStripped: Array<{ id: string; stripped: string[] }> = [];
  let totalStrippedFields = 0;

  const classified = (raw.classified ?? []).map((c: any) => {
    const { item, stripped } = sanitizePass2aItem(c);
    if (stripped.length > 0) {
      perItemStripped.push({ id: item.id, stripped });
      totalStrippedFields += stripped.length;
    }
    return item;
  });

  const skipped = (raw.skipped ?? []).map((s: any) => ({
    id:     String(s.id ?? ""),
    reason: String(s.reason ?? ""),
  }));

  return { result: { skipped, classified }, totalStrippedFields, perItemStripped };
}

// ─── LLM call ──────────────────────────────────────────────────────────────────
//
// Mirrors the signature shape of `callPass2LLM` in pass2.ts so wiring later
// can route between monolith and split with minimal call-site change. Differs
// only in:
//   - returns Pass2aResult (no `unique`, no `causal_wiring`)
//   - uses PASS2A_PROMPT + PASS2A_SCHEMA
//   - does NOT update reflectTokenStats yet (that's a wiring concern — adding
//     pass2a/2b/2c slots to context.ts is part of the §9 Week 2 wiring step,
//     not this isolated module)
//
// Returns usage so callers (tests + future wiring) can capture token counts
// without touching global state.

export async function callPass2aLLM(
  provider: LLMProvider,
  pass1Items: Pass1Item[],
  projectContext: string,
  prevEntityMap: Array<{ reference: string; resolved_to: string }>,
  thinkingBudget = 1024,
  sceneCard?: string,
  // Multi-model routing (C, 2026-05-25): per PASS2-SPLIT-DESIGN.md §7 cost
  // recalibration, 2a is structural work — cheap-model territory (Haiku-class
  // via OpenRouter). When set, overrides the provider's default model for this
  // call only. Undefined → use provider default (backward compat). Universal:
  // model name is a string, no provider assumption (works for any model the
  // upstream provider can serve).
  modelOverride?: string,
): Promise<{
  result: Pass2aResult | null;
  thinking: string;
  rateLimited: boolean;
  model?: string;
  attempts?: Array<{ model: string; outcome: string }>;
  usage?: { input?: number; thinking?: number; output?: number };
  strippedFields?: Array<{ id: string; stripped: string[] }>;
}> {
  const sceneCardSection = sceneCard
    ? `SCENE CARD (APPROACHES entries give investment level and blueprint/dead_end context; ACTOR-ACTIONS confirm who committed to what):\n${sceneCard}\n\n`
    : "";

  const projectSection = projectContext
    ? `PROJECT GRAPH (all existing blocks — use for dedup and supersession refs):\n${projectContext}\n\n`
    : "";

  const prevMapSection = prevEntityMap.length > 0
    ? `PREVIOUS TURN ENTITY MAP:\n${prevEntityMap.map((e) => `"${e.reference}" → ${e.resolved_to}`).join("\n")}\n\n`
    : "";

  const itemsSection = `ITEMS FROM PASS 1:\n${JSON.stringify(pass1Items, null, 2)}`;
  const userInput = `${sceneCardSection}${projectSection}${prevMapSection}${itemsSection}`;

  const r = await provider.generateStructured<{ skipped: any[]; classified: any[] }>(
    PASS2A_PROMPT,
    userInput,
    PASS2A_SCHEMA,
    {
      thinkingBudget,
      maxOutputTokens: CONFIG.pass2.maxOutputTokens,
      ...(modelOverride ? { modelOverride } : {}),
    },
  );

  if (!r.result) {
    console.error(`Auto-Reflect Pass 2a: ${r.rateLimited ? "rate limited" : "failed"} [${provider.getName()}]`);
    return {
      result: null,
      thinking: r.thinking ?? "",
      rateLimited: r.rateLimited,
      model: r.model,
      attempts: r.attempts,
    };
  }

  const { result: clean, totalStrippedFields, perItemStripped } = sanitizePass2aResult(r.result);

  // Re-join `text` by id from Pass 1 input. 2a no longer echoes verbatim text
  // (PASS2A_SCHEMA omits it). Source of truth for text = Pass 1, not the LLM.
  // See project-future-enhancements #6 for the WHY (refund truncation@16384).
  // Defensive: a classified id with no matching pass1 id is an anomaly (Q0
  // dedup only ever drops items, never creates new ids) — log + fall back to
  // "" so downstream never gets undefined on a string-typed field.
  const textById = new Map(pass1Items.map((p) => [p.id, p.text]));
  // ── DEBT 5 D3: also re-join excerpt by id (same pattern as text) ──
  // Source of truth for excerpt = Pass 1 (matches the prompt's source rule).
  // Pass 2a doesn't need the LLM to echo it — we paste it back from Pass 1
  // input by id. Phase 5 propagation: Pass1Item.excerpt → Pass2Item.excerpt →
  // (Pass 2b passes through unchanged) → Pass 3 → blocks.source_excerpt column.
  const excerptById = new Map(pass1Items.map((p) => [p.id, p.excerpt]));
  let textRejoinMisses = 0;
  let excerptRejoinMisses = 0;
  for (const item of clean.classified) {
    const t = textById.get(item.id);
    if (t === undefined) textRejoinMisses++;
    item.text = t ?? item.text ?? "";

    const e = excerptById.get(item.id);
    if (e === undefined) excerptRejoinMisses++;
    item.excerpt = e ?? "";  // empty string is safe — Pass 3 treats "" as "no excerpt available" same as NULL
  }
  if (textRejoinMisses > 0) {
    console.log(`Auto-Reflect Pass 2a: WARNING ${textRejoinMisses} classified item(s) had no matching Pass 1 id for text re-join (defensive)`);
  }
  if (excerptRejoinMisses > 0) {
    console.log(`Auto-Reflect Pass 2a: WARNING ${excerptRejoinMisses} classified item(s) had no matching Pass 1 id for excerpt re-join (D3 source_excerpt — block will have NULL provenance)`);
  }

  const tag = provider.getName() !== "gemini" ? ` [${provider.getName()}]` : "";
  console.log(
    `Auto-Reflect Pass 2a: classified ${pass1Items.length} items | tokens: in=${r.usage?.input ?? "?"} think=${r.usage?.thinking ?? "?"} out=${r.usage?.output ?? "?"}${tag}`,
  );

  if (totalStrippedFields > 0) {
    // Sanitizer fired — model leaked fields it wasn't supposed to emit.
    // Log loudly so the contract violation is auditable in turn logs.
    console.log(`Auto-Reflect Pass 2a: SANITIZER stripped ${totalStrippedFields} leaked field(s) across ${perItemStripped.length} item(s)`);
    for (const s of perItemStripped) {
      console.log(`  ${s.id}: removed ${s.stripped.join(", ")}`);
    }
  }

  for (const item of clean.classified) {
    if (item.classification_reasoning) {
      console.log(`  [Pass 2a reasoning] ${item.id} [${item.type}]: ${item.classification_reasoning}`);
    }
  }

  return {
    result: clean,
    thinking: r.thinking ?? "",
    rateLimited: r.rateLimited,
    model: r.model,
    attempts: r.attempts,
    usage: r.usage,
    strippedFields: perItemStripped.length > 0 ? perItemStripped : undefined,
  };
}
