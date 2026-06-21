import { CONFIG } from "./config.js";
import { reflectTokenStats } from "./context.js";
import type { LLMProvider } from "../../engine/ai-provider.js";
import type { Pass1Item, Pass2Result } from "./types.js";

// ═══════════════════════════════════════════════════════════════════════════════
// PASS 2 — CLASSIFY + CAUSALITY
// Job: verify type, draw causal arrows, fill unique fields, set project.
// ═══════════════════════════════════════════════════════════════════════════════

export const PASS2_PROMPT = `You receive extracted items from an agent session.
Each item has a provisional_type set by Pass 1 based on surface form.

── STATE CONVENTION ─────────────────────────────────────────────────────────
"State" in this prompt = text in marked regions below (PROJECT GRAPH, SCENE CARD,
PREVIOUS TURN ENTITY MAP, ITEMS FROM PASS 1). Your training knowledge and
"what's commonly known about this domain" are NOT state. A claim is "already
recorded" ONLY if a block in PROJECT GRAPH has a matching essence text or
unique{} field value. Familiarity ≠ recorded. The fact that something is widely
known, famous, or established in the field is irrelevant to dedup.

Your job: verify the type, draw causal links, fill unique fields.
Processing order: DEDUP (Q0) → TYPE (Q1) → HIERARCHY (Q2) → UNIQUE FIELDS → classified[].
Then: CAUSAL WIRING (Q3–Q4) → causal_wiring[].

── Q0: DEDUP — intra-batch first, then against PROJECT GRAPH ──
"Does this item add a claim not already covered — by another item in this same
batch, or by a block in PROJECT GRAPH?"

For EVERY item, walk these steps in order. Stop at the first verdict.

STEP I — Intra-batch duplicate (check before the graph):
  "Does another ITEM in this batch make the SAME claim — same type, same
  specific subject and values? Two items can word it differently and still be
  the same claim; a merely related claim is NOT the same claim."
  YES → keep exactly ONE — the item with the more complete text and unique
        values. The other does not become a block: do not emit it in
        classified[], and do not put it in skipped[] — simply omit it. In the
        kept item's classification_reasoning, name the dropped item's id. Any
        causal link wires to the kept item.
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
    NOT UPDATES: item USES or BUILDS ON the candidate → GENUINELY NEW (wire in causal_wiring).
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

  TEST 1: "Expected answer or proposed mechanism BEFORE confirmation?"
    YES → hypothesis. Already confirmed → remains fact.

  TEST 2: "CLOSING something or ADOPTING something?"
    ADOPTING → decision.
    CLOSING → "Were resources committed INTO this path before closure?"
      "If I removed the closing event, would there be active work to stop?"
      YES → dead_end. NO (only analysis, never entered) → fact.
      EXTERNAL FORCE closed it → constraint.

  TEST 3: "Has an outcome already been selected and closed?"
    YES → decision. Path committed, destination unknown → blueprint. Nothing committed → question.

  TEST 4: "PROJECT GRAPH has same concept with different type?"
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
  NO → supersedes_ref = old label. YES but wrong → contradicts relation.
  Within-batch: predecessor item ID. Cross-batch: exact label from PROJECT GRAPH.
resolved_ref — label for same entity by different name. High confidence only.

── REVIEW FLAGS ────────────────────────────────────────────────────────────
Set review_reason when not confident: type_override, weak_match, no_evidence,
project_uncertain, incomplete_context, graph_align, novel_type. Empty when confident.

── CLASSIFICATION REASONING (required) ─────────────────────────────────────
For EVERY item: 1-2 sentences — which test determined the outcome and what evidence.

── UNIQUE FIELDS — populate AFTER type is final ────────────────────────────
Use ONLY the assigned type's fields. Fields NEVER determine type.

  decision   { choice, reason, alternatives_rejected }
  dead_end   { approach, reason, alternative }
  blueprint  { purpose, status, trigger_to_implement }
  question   { question, why_matters }
  fact       { value, why_matters }
  constraint { limit, reason, source }
  hypothesis { proposal, evidence_for, evidence_against }
  insight    { observation, implication }
  preference { lean, over, condition }
  entity     { name, role }
  event      { what_happened, outcome, date }
  task       { status, description, owner }

Omit empty fields. Use verbatim excerpt language. Specific named things → unique{}.
insight's second field is "implication" (what the observation means going forward) — NOT
"proposal" (that field belongs to hypothesis: an unverified guess) and NOT a bare "reason".
Discriminator when the content is "X, therefore/because Y": a guess or theory → hypothesis;
a single observed effect or state → fact; a realization combining 2+ things → insight.

── SCENE CARD CONTEXT ──────────────────────────────────────────────────────
APPROACHES → engagement level (for TEST 3) and project tags.
CAUSAL LINKS → use in Q3. UNCHANGED → source="recap", Q0 handles. TASKS → active work.

── CAUSAL WIRING (output AFTER classified[]) ───────────────────────────────
After all items are in classified[], output causal_wiring[] with full batch visibility.

Q3: TRIGGERED_BY — "In a world where (X) didn't happen, would (Y) still have occurred?"
  YES → no link. NO → X goes in triggered_by.
  UNCERTAIN → no link. Wrong wiring (false narrative) costs more than missing wiring (recoverable).
  CIRCULARITY GUARD: before adding A→B, check "Did I already put B→A?" YES → skip.
  Use item IDs for batch, block labels for PROJECT GRAPH. Genesis → triggered_by: [].
  REPLACEMENTS "X→Y": dead_end for X is triggered_by the decision that adopted Y.
  HIERARCHY: "Did cause make the DECISION necessary, or only this mechanism?"
    Decision → triggered_by on parent. Mechanism only → triggered_by on child.

Q4: BASED_ON — "Would this claim be UNSUPPORTED without that specific finding?"
  NO → no link. YES → based_on.
  UNCERTAIN → no link. False evidence link costs more than missing one.
  Applies to conclusions, decisions justified by findings.

Q5: SEMANTIC RELATIONS — for each item pair in this batch:
  "Does (X) directly contradict, support, or answer (Y)?"
  contradicts: opposite claims about the same specific thing.
  supports: independent evidence strengthening the same claim.
  resolves: (X) answers the question or settles the hypothesis (Y) poses.

`;

const PASS2_SCHEMA = {
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
          id:                  { type: "string" },
          text:                { type: "string" },
          type:                { type: "string" },
          project:             { type: "string" },
          unique:              {
            type: "object",
            properties: {
              choice:               { type: "string" },
              reason:               { type: "string" },
              alternatives_rejected:{ type: "string" },
              approach:             { type: "string" },
              alternative:          { type: "string" },
              limit:                { type: "string" },
              source:               { type: "string" },
              value:                { type: "string" },
              name:                 { type: "string" },
              role:                 { type: "string" },
              purpose:              { type: "string" },
              status:               { type: "string" },
              trigger_to_implement: { type: "string" },
              question:             { type: "string" },
              why_matters:          { type: "string" },
              observation:          { type: "string" },
              implication:          { type: "string" },
              description:          { type: "string" },
              owner:                { type: "string" },
              outcome:              { type: "string" },
              proposal:             { type: "string" },
              evidence_for:         { type: "string" },
              evidence_against:     { type: "string" },
              definition:           { type: "string" },
              current_value:        { type: "string" },
              target:               { type: "string" },
              what_happened:        { type: "string" },
              date:                 { type: "string" },
              lean:                 { type: "string" },
              over:                 { type: "string" },
              condition:            { type: "string" },
            },
          },
          extends_item:        { type: "string" },
          supersedes_ref:      { type: "string" },
          resolved_ref:        { type: "string" },
          relations: {
            type: "array",
            items: {
              type: "object",
              properties: {
                type:   { type: "string" },
                target: { type: "string" },
              },
              required: ["type", "target"],
            },
          },
          note:                    { type: "string" },
          review_reason:           { type: "string" },
          schema:                  { type: "object" },
          classification_reasoning: { type: "string" },
        },
        required: ["id", "text", "type", "project", "unique", "classification_reasoning"],
      },
    },
    causal_wiring: {
      type: "array",
      items: {
        type: "object",
        properties: {
          item_id:         { type: "string" },
          triggered_by:    { type: "array", items: { type: "string" } },
          based_on:        { type: "array", items: { type: "string" } },
        },
        required: ["item_id", "triggered_by", "based_on"],
      },
    },
  },
  required: ["skipped", "classified", "causal_wiring"],
};

export async function callPass2LLM(
  provider: LLMProvider,
  pass1Items: Pass1Item[],
  projectContext: string,
  prevEntityMap: Array<{ reference: string; resolved_to: string }>,
  thinkingBudget = 1024,
  sceneCard?: string,
): Promise<{ result: Pass2Result | null; thinking: string; rateLimited: boolean; model?: string; attempts?: Array<{ model: string; outcome: string }> }> {
  const sceneCardSection = sceneCard
    ? `SCENE CARD (APPROACHES entries give investment level and blueprint/dead_end context; ACTOR-ACTIONS confirm who committed to what):\n${sceneCard}\n\n`
    : "";

  const projectSection = projectContext
    ? `PROJECT GRAPH (all existing blocks — use for causality and dedup):\n${projectContext}\n\n`
    : "";

  const prevMapSection = prevEntityMap.length > 0
    ? `PREVIOUS TURN ENTITY MAP:\n${prevEntityMap.map((e) => `"${e.reference}" → ${e.resolved_to}`).join("\n")}\n\n`
    : "";

  const itemsSection = `ITEMS FROM PASS 1:\n${JSON.stringify(pass1Items, null, 2)}`;
  const userInput = `${sceneCardSection}${projectSection}${prevMapSection}${itemsSection}`;

  const r = await provider.generateStructured<Pass2Result>(PASS2_PROMPT, userInput, PASS2_SCHEMA, {
    thinkingBudget,
    maxOutputTokens: CONFIG.pass2.maxOutputTokens,
  });

  if (r.result) {
    reflectTokenStats.pass2.input    += r.usage?.input    ?? 0;
    reflectTokenStats.pass2.thinking += r.usage?.thinking ?? 0;
    reflectTokenStats.pass2.output   += r.usage?.output   ?? 0;
    reflectTokenStats.pass2.calls    += 1;
    const tag = provider.getName() !== "gemini" ? ` [${provider.getName()}]` : "";
    console.log(`Auto-Reflect Pass 2: classified ${pass1Items.length} items | tokens: in=${r.usage?.input ?? "?"} think=${r.usage?.thinking ?? "?"} out=${r.usage?.output ?? "?"}${tag}`);
    for (const item of r.result.classified) {
      if (item.classification_reasoning) {
        console.log(`  [Pass 2 reasoning] ${item.id} [${item.type}]: ${item.classification_reasoning}`);
      }
    }

    const groupingItems = r.result.classified.filter(i => i.extends_item || i.supersedes_ref);
    if (groupingItems.length > 0) {
      for (const item of groupingItems) {
        const ext = item.extends_item ? ` extends_item=${item.extends_item}` : "";
        const sup = item.supersedes_ref ? ` supersedes_ref=${item.supersedes_ref}` : "";
        console.log(`Auto-Reflect Pass 2 grouping: [${item.type}] "${item.text.slice(0, 60)}"${ext}${sup}`);
      }
    } else {
      console.log(`Auto-Reflect Pass 2 grouping: no extends_item or supersedes_ref set`);
    }
  } else {
    console.error(`Auto-Reflect Pass 2: ${r.rateLimited ? "rate limited" : "failed"} [${provider.getName()}]`);
  }

  return { result: r.result, thinking: r.thinking ?? "", rateLimited: r.rateLimited, model: r.model, attempts: r.attempts };
}
