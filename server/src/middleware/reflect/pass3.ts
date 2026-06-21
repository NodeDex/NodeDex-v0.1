import { reflectTokenStats } from "./context.js";
import { ALLOW_BACKGROUND_KNOWLEDGE, modelForPass } from "./config.js";
import type { LLMProvider } from "../../engine/ai-provider.js";
import type { Pass2Item } from "./types.js";

// ═══════════════════════════════════════════════════════════════════════════════
// PASS 3 — BUILD
// Job: assemble each classified item into a complete graph block.
// Saves blocks in priority order (dead_ends first, then decisions/constraints).
// ═══════════════════════════════════════════════════════════════════════════════

const BG_KNOWLEDGE_SECTION = ALLOW_BACKGROUND_KNOWLEDGE
  ? `── KNOWLEDGE SOURCE ──────────────────────────────────────────────────────────

Background knowledge is ENABLED.

You may draw on background knowledge to enrich blocks — filling in mechanisms,
implications, or connections not explicit in CLASSIFIED ITEMS.
Only add background knowledge when it directly supports a claim already in CLASSIFIED ITEMS.
Do not introduce speculative connections or mechanisms with no basis in the session content.

`
  : `── KNOWLEDGE SOURCE ──────────────────────────────────────────────────────────

Background knowledge is DISABLED.

Only use content from CLASSIFIED ITEMS to populate each block's fields.
Do not introduce claims, mechanisms, or details not present in CLASSIFIED ITEMS.
If you recognise a real-world connection from your background knowledge → skip it.
Every field (essence, unique{}, concepts[]) must be traceable to CLASSIFIED ITEMS.

`;

export const PASS3_PROMPT = `You receive a classified list of items from an agent session.
For each item: assemble it into a complete graph block. Build ONLY from CLASSIFIED
ITEMS FROM PASS 2 — every block must come from exactly one classified item.

── STATE CONVENTION ─────────────────────────────────────────────────────────
"State" in this prompt = text in marked regions below (KNOWN PROJECT ROOTS,
AGENT-SAVED BLOCKS THIS TURN, MANDATORY CREATES, MANDATORY ITEM ACCOUNTING,
PROJECT GRAPH, CLASSIFIED ITEMS FROM PASS 2). Your training
knowledge and "what's commonly known" are NOT state. A block already exists
ONLY if it appears in PROJECT GRAPH or AGENT-SAVED BLOCKS. Familiarity ≠ recorded.

${BG_KNOWLEDGE_SECTION}── NAMING: 4 DIMENSIONS ──────────────────────────────────────────────────────
{project}_{entity}_{type}_{concept}
  project = must be in KNOWN PROJECT ROOTS or project_creates[].
  entity  = optional sub-component — omit for top-level blocks.
  type    = block type. concept = 2-5 words, hyphens only, lowercase.
  RULE: underscores separate dimensions only. Hyphens within dimensions.
  essence: 1 sentence, ≤120 chars.

── CONCEPTS[] — SEARCH TAGS ────────────────────────────────────────────────
"What specific words would someone type to find this block?"
  → Named things, mechanisms, measurements, failure modes, people.
  NOT: category labels, type descriptions, vague process words.
  The type field captures category. concepts[] captures content.

── CONCEPT: THE WHAT ───────────────────────────────────────────────────────
Concept names WHAT changed/failed/is required — not the mechanism or reason.
Test: strip "because", "using", "via", "through", "by" — what remains is the concept.

For decisions: "What now exists or is true after this decision was made?"
  The new state is the concept. Not the mechanism. Not what was replaced.
  This question is item-scoped — sibling items do not influence it.

── PRE-SCAN: NEW PROJECTS ──────────────────────────────────────────────────
Before ANY output: scan all items, collect project values, compare against KNOWN PROJECT ROOTS.
Any project NOT in KNOWN PROJECT ROOTS → add to project_creates[] FIRST.
A project value not in KNOWN PROJECT ROOTS is NEW — it must appear in project_creates[].
project_creates[]: { label (hyphens, no underscores), essence, parent (optional) }

── FOR EACH ITEM ───────────────────────────────────────────────────────────

Q1. Project: copy Pass 2's project field verbatim into label.project. Pass 2 set
    a project on every item — never re-derive it, never blank it, never write "null".
    Unknown project (not a KNOWN PROJECT ROOT) → also add it to project_creates[].

Q2. Causal connections — fill using block labels (new_blocks[] or PROJECT GRAPH):

    triggered_by: "Would this block exist if (X) hadn't happened?" NO → X.
      Translate Pass 2 triggered_by_items: item IDs → labels via from_item_id.
      Empty triggered_by is valid whenever no in-graph cause exists — not only the genesis block.

    based_on: "Would this claim be unsupported without (X)'s specific finding?" YES → X.
      Translate Pass 2 based_on_items. Wire conclusion → evidence, not reverse.

    Both fields: item ID → resolve via from_item_id. Block label → verify in PROJECT GRAPH.

Q4. Replace or extend something in PROJECT GRAPH?
    Same concept, new value → supersedes. Adds detail → extends.
    Identical concept → updates[], not new_blocks[].
    "Is this the mechanism by which an existing block is achieved?" YES → extends.
    extends test: "Existing block valid without this? AND this only makes sense given existing?"
      Both YES → extends (new=source, existing=target).
    Scan PROJECT GRAPH ESSENCES (not labels) for cross-session matches.

── UNIQUE FIELDS ───────────────────────────────────────────────────────────
Copy unique{} from Pass 2. If empty, derive from item text. Min 2 non-empty fields.
Values must be specific (numbers, names, thresholds) — not generic paraphrases.

── PRE-COMPUTED FIELDS (copy from Pass 2 — do NOT re-derive) ───────────────
  is_a = item type. from_item_id = item id. extends_item = server resolves.
  supersedes_ref → add { type: "supersedes", target_id: value } to relations.
  triggered_by_items/based_on_items → translate to labels for Q2.

── DEDUP ───────────────────────────────────────────────────────────────────
Pass 2 already did all dedup — intra-batch and against the graph. Trust it
completely. Check only ONE thing here: label collision.
  LABEL COLLISION: only flag if an EXACT label string match exists in PROJECT GRAPH
    above. Do not guess that a similar block "probably exists". If a match is found,
    ask: "Is existing block's claim still true?" YES → updates[]. NO → supersedes.

SKIP EVIDENCE: When you put an item in skip_reasons[] for being a duplicate or
already-existing, why_skipped must reference an exact label from PROJECT GRAPH
or AGENT-SAVED BLOCKS. No reference → not a valid skip.

── SUPERSEDES_REF = CREATE, NOT UPDATE ─────────────────────────────────────
supersedes_ref items → ALWAYS new_blocks[] + supersedes relation. NEVER updates[].
Old block stays as permanent history. New block is current state.

── UPDATES[] ───────────────────────────────────────────────────────────────
"After this session, is the existing block's claim still accurate?"
  YES (incomplete, add detail) → updates[]. NO (state changed) → new_blocks[] + supersedes.

── TASKS ───────────────────────────────────────────────────────────────────
type=task + named owner → ALWAYS new block. unique: { status, description, owner }.
  relations: implements → the decision/blueprint being executed.
Scheduling details with no owner → updates[] or skip_reasons[].

── NEIGHBORHOOD ────────────────────────────────────────────────────────────
Item \`neighborhood\` shows closest existing block + story arc. Use for action decision.
"(no existing match)" → go straight to new_blocks[].

── RELATIONS & TTL ─────────────────────────────────────────────────────────
  triggered_by, based_on, supersedes, extends, implements, resolves
  permanent: decision, constraint, dead_end, blueprint, preference
  project: fact, insight, question, hypothesis, entity, metric, event

── CAUSAL WIRING ───────────────────────────────────────────────────────────
Wire every triggered_by/based_on you can — scan new_blocks[] and PROJECT GRAPH
for the block each one depends on. Connectivity makes the graph navigable; do it
diligently.

A missing link is NEVER a reason to skip a block — for ANY type. The graph is
built incrementally across sessions: a cause is often out of scope this session,
or arrives in a later one. Causality is universal, but the graph holds only what
THIS session extracted — you cannot wire a relation to a block that does not
exist. Create the block now with whatever links exist (empty is valid); a later
turn enriches it via updates[] and Pass 4 stitching. Deleting a confirmed,
GATE-passed block to enforce a link quota loses real knowledge permanently.
Never fabricate a link to fill the gap.

Novel types: fill unique{} from schema{} if present, else treat as fact. Set review_reason.

── FINAL SCAN ──────────────────────────────────────────────────────────────
1. Same-topic batch siblings with no relation? → add extends (narrower → broader).
2. Decision/constraint supersedes something in PROJECT GRAPH? → add supersedes.
3. Every MANDATORY ITEM ACCOUNTING ID in new_blocks[] or skip_reasons[]?

── OUTPUT VERIFICATION ─────────────────────────────────────────────────────
Empty relations[] is valid for ANY type when no in-graph predecessor exists —
  never skip a block for missing links, never fabricate one to fill a quota.
from_item_id MUST be set. Do not add part_of — server sets project_id automatically.`;

const PASS3_SCHEMA = {
  type: "object",
  properties: {
    project_creates: {
      type: "array",
      items: {
        type: "object",
        properties: {
          label:   { type: "string" },
          essence: { type: "string" },
          parent:  { type: "string" },
        },
        required: ["label", "essence"],
      },
    },
    new_blocks: {
      type: "array",
      items: {
        type: "object",
        properties: {
          label: {
            type: "object",
            properties: {
              project:  { type: "string" },
              subgroup: { type: "string" },
              type:     { type: "string" },
              concept:  { type: "string" },
            },
            required: ["project", "type", "concept"],
          },
          is_a:          { type: "string" },
          triggered_by:  { type: "array", items: { type: "string" } },
          essence:       { type: "string" },
          relations: {
            type: "array",
            items: {
              type: "object",
              properties: {
                type:      { type: "string" },
                target_id: { type: "string" },
              },
              required: ["type", "target_id"],
            },
          },
          unique:        {
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
              lean:                 { type: "string" },
              over:                 { type: "string" },
              condition:            { type: "string" },
              definition:           { type: "string" },
              current_value:        { type: "string" },
              target:               { type: "string" },
              what_happened:        { type: "string" },
              date:                 { type: "string" },
            },
          },
          concepts:      { type: "array", items: { type: "string" } },
          ttl:           { type: "string" },
          novelty_reason:{ type: "string" },
          raw_excerpt:   { type: "string" },
          from_item_id:  { type: "string" },
          based_on:      { type: "array", items: { type: "string" } },
        },
        required: ["label", "is_a", "essence", "unique", "concepts", "relations", "from_item_id"],
      },
    },
    updates: {
      type: "array",
      items: {
        type: "object",
        properties: {
          block_id:     { type: "string" },
          essence:      { type: "string" },
          unique_patch: { type: "object" },
          relations_add: {
            type: "array",
            items: {
              type: "object",
              properties: {
                type:      { type: "string" },
                target_id: { type: "string" },
              },
            },
          },
          reason: { type: "string" },
        },
        required: ["block_id"],
      },
    },
    skip_reasons: {
      type: "array",
      items: {
        type: "object",
        properties: {
          item_id:     { type: "string" },
          text:        { type: "string" },
          why_skipped: { type: "string" },
        },
      },
    },
  },
  required: ["project_creates", "new_blocks", "updates", "skip_reasons"],
};

export async function callPass3LLM(
  provider: LLMProvider,
  classified: Pass2Item[],
  knownRoots: Array<{ label: string; essence: string }>,
  projectContext: string,
  agentSavedBlocks: Array<{ id: string; label: string; type: string; essence: string; unique: Record<string, any> }>,
  thinkingBudget = 4096,
  duplicateAlerts = "",
  itemContext: Record<string, string> = {},
): Promise<{ analysis: any; geminiThinking: string; rateLimited: boolean; model?: string; attempts?: Array<{ model: string; outcome: string }> }> {
  const rootsSection = knownRoots.length > 0
    ? `KNOWN PROJECT ROOTS:\n${knownRoots.map((p) => `  ${p.label}: "${p.essence}"`).join("\n")}\n\n`
    : `KNOWN PROJECT ROOTS: (empty — any prefix is valid)\n\n`;

  const agentSavedSection = agentSavedBlocks.length > 0
    ? `AGENT-SAVED BLOCKS THIS TURN (do not recreate these concepts):\n${agentSavedBlocks.map((b) =>
        `[${b.label} | ${b.id}] type:${b.type} "${b.essence}"`).join("\n")}\n\n`
    : "";

  const projectSection = projectContext
    ? `PROJECT GRAPH (existing blocks — use for dedup, novelty check, and relation targets):\n${projectContext}\n\n`
    : `PROJECT GRAPH: (workspace is empty)\n\n`;

  // Mandatory creates: items with supersedes_ref MUST become new blocks
  const mandatoryCreates = classified.filter(item => item.supersedes_ref);
  const mandatorySection = mandatoryCreates.length > 0
    ? `MANDATORY CREATES — Pass 2 set supersedes_ref on these items. They MUST appear in new_blocks[]. Do NOT skip, do NOT put in updates[]:\n${
        mandatoryCreates.map(item =>
          `  ${item.id} [${item.type}] supersedes "${item.supersedes_ref}" — "${item.text.slice(0, 90)}"`
        ).join("\n")
      }\n\n`
    : "";

  // Targeted accountability:
  //   Tier 1 — always mandatory: decisions, constraints, dead_ends, blueprints, questions,
  //            supersedes_ref items, and task items with a named owner
  //   Tier 2 — mandatory if they're causal evidence for a Tier 1 item (appear in based_on_items or triggered_by_items)
  //   Tier 3 — facts with no existing match (new state data that must be created or explicitly skipped)
  //   Facts/tasks without a named owner that extend existing blocks remain silently droppable
  const MANDATORY_ITEM_TYPES = new Set(["decision", "constraint", "dead_end", "blueprint", "question"]);
  const tier1Items = classified.filter(
    item => MANDATORY_ITEM_TYPES.has(item.type) || !!item.supersedes_ref
      || (item.type === "task" && !!(item.unique as any)?.owner)
  );
  const tier1Ids = new Set(tier1Items.map(i => i.id));
  const tier2Items = classified.filter(item => {
    if (tier1Ids.has(item.id)) return false; // already in tier 1
    // mandatory if referenced as causal evidence by any tier-1 item
    return tier1Items.some(t1 =>
      (t1.based_on_items ?? []).includes(item.id) ||
      (t1.triggered_by_items ?? []).includes(item.id)
    );
  });
  const tier2Ids = new Set(tier2Items.map(i => i.id));
  // Tier 3: facts with no existing neighborhood match — must be explicitly created or skipped
  const tier3Items = classified.filter(item => {
    if (tier1Ids.has(item.id) || tier2Ids.has(item.id)) return false;
    if (item.type !== "fact") return false;
    const ctx = itemContext[item.id];
    return !ctx || ctx === "(no existing match — create new block)";
  });
  const mandatoryAccountingItems = [...tier1Items, ...tier2Items, ...tier3Items];
  const accountingSection = mandatoryAccountingItems.length > 0
    ? `MANDATORY ITEM ACCOUNTING — every item below MUST appear in new_blocks[from_item_id] or skip_reasons[item_id] with a specific reason. Do not stop until all are addressed:\n${
        mandatoryAccountingItems.map(item => {
          const sup = item.supersedes_ref ? ` [supersedes ${item.supersedes_ref}]` : "";
          const evidence = tier2Ids.has(item.id) ? " [causal evidence]" : "";
          const newFact = tier3Items.some(t3 => t3.id === item.id) ? " [new fact — no existing match]" : "";
          return `  ${item.id} [${item.type}]${sup}${evidence}${newFact}`;
        }).join("\n")
      }\n\n`
    : "";

  // Inject per-item neighborhood context into classified items.
  // keep_reason/type_reasoning are debug observability fields (v2 COMPREHEND) bound
  // for the turn-log — strip them from the PROMPT copy so they cost no tokens and
  // can't nudge Pass 3. (v1's classification_reasoning keeps its existing behavior.)
  const classifiedWithContext = classified.map(item => {
    const { keep_reason: _kr, type_reasoning: _tr, ...rest } = item;
    return {
      ...rest,
      neighborhood: itemContext[item.id] ?? "(no existing match — create new block)",
    };
  });
  const classifiedSection = `CLASSIFIED ITEMS FROM PASS 2:\n${JSON.stringify(classifiedWithContext, null, 2)}`;
  const userInput = `${rootsSection}${agentSavedSection}${mandatorySection}${accountingSection}${duplicateAlerts}${projectSection}${classifiedSection}`;

  // 32768 (not the 65536 ceiling): batching already bounds a chunk to <=20 blocks
  // (~13K tokens typical), so 32768 fits with room AND leaves the truncation-bump
  // real headroom up to the model ceiling. 65536 + thinking over-requested past the
  // ceiling → a provider glitch dropped the whole write (2026-06-16 deep-stress find).
  const r = await provider.generateStructured<any>(PASS3_PROMPT, userInput, PASS3_SCHEMA, { thinkingBudget, maxOutputTokens: 32768, modelOverride: modelForPass("pass3") });

  if (r.usage) {
    reflectTokenStats.pass3.input    += r.usage.input;
    reflectTokenStats.pass3.thinking += r.usage.thinking;
    reflectTokenStats.pass3.output   += r.usage.output;
  }
  reflectTokenStats.pass3.calls += 1;

  const tag = provider.getName() !== "gemini" ? ` [${provider.getName()}]` : "";
  if (r.result) {
    console.log(`Auto-Reflect Pass 3 tokens — in=${r.usage?.input ?? "?"} think=${r.usage?.thinking ?? "?"} out=${r.usage?.output ?? "?"}${tag}`);
  } else {
    console.error(`Auto-Reflect Pass 3: ${r.rateLimited ? "rate limited" : "failed"} [${provider.getName()}]`);
  }

  return { analysis: r.result, geminiThinking: r.thinking ?? "", rateLimited: r.rateLimited, model: r.model, attempts: r.attempts };
}
