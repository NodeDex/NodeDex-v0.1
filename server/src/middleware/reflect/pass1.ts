import { reflectTokenStats } from "./context.js";
import { getThinkingBudget, modelForPass } from "./config.js";
import { withOverride } from "./promptOverride.js";
import type { LLMProvider } from "../../engine/ai-provider.js";
import type { Pass1Result } from "./types.js";

// ═══════════════════════════════════════════════════════════════════════════════
// PASS 1 — EXTRACT
// Job: find every discrete piece of information in the agent's output.
// Assigns provisional types using scene card APPROACHES context as primary signal.
// Runs BACKWARD TRACE and CONTRAST CHECK after every decision extraction.
// Tuned for recall — a missed item is gone forever; a wrong type is fixable in Pass 2.
// ═══════════════════════════════════════════════════════════════════════════════

export const PASS1_PROMPT = withOverride("NODEDEX_TEST_PROMPT_PASS1", `You receive raw agent output — thinking and final response from an AI assistant.
For each passage, read it in two steps, then decide whether to keep it.

── STATE CONVENTION ─────────────────────────────────────────────────────────
"State" in this prompt = text in marked regions below (SCENE CARD, RECENTLY SAVED,
OPEN BLUEPRINTS, AGENT THINKING, AGENT OUTPUT). Your training knowledge and
"what's commonly known" are NOT state. When you skip an item as redundant with
RECENTLY SAVED, you must be able to quote the matching entry. Familiarity ≠ recorded.

── THINKING vs OUTPUT ──────────────────────────────────────────────────────
Same session, two angles. If the same event appears in both → extract ONCE from OUTPUT.
Only extract from thinking when it contains information NOT present in output.
Ask: "Does the output already capture this event, even in different words?"
  YES → skip. NO → extract from thinking.

── SCENE CARD CONTEXT (if provided) ────────────────────────────────────────
The scene card describes what was observed — it does not assign types.
The scene card is NOT a substitute for extraction. Every discrete claim in the
transcript must still be extracted as its own item — the scene card provides context
for classification (engagement level, source tagging), not content to be saved.
Use it as INPUT CONTEXT when answering the classification tree below:
  APPROACHES descriptions → consult at Q3b for engagement level.
  REPLACEMENTS → predecessors have confirmed engagement (Q3b = YES).
  UNCHANGED entries / resolved APPROACHES → source = "recap".
  TASKS entries → extract as task. CAUSAL LINKS → consult at backward trace.
  OPEN BLUEPRINTS → if passage shows one completing → extract as decision.
When scene card conflicts with transcript text → trust the transcript.

── GATE ────────────────────────────────────────────────────────────────────
"Would a future agent reading only this block learn something that changes
what they should do or avoid?"
  YES → enter the classification tree.
  NO  → skip this passage entirely.
Core types (decision, dead_end, constraint, blueprint, preference) always pass.
Tasks pass IF: "Would a future agent's approach change knowing this exists?"

── CLASSIFICATION TREE — Q1 through Q7 ────────────────────────────────────
Answer YES or NO from passage text alone. Stop at the first YES.
Write the full Q1…Qn trace in extraction_reasoning before provisional_type.

Q1: Are two values of the same measured quantity named — a starting state and a
    later state — where the CHANGE between them is what is being reported?
    YES → metric (always its own item, even co-located with a decision).
    NO  → Q2.

Q2: Is something stated as an expected answer or proposed mechanism that had
    not yet been confirmed or denied when put forward?
    YES → hypothesis (extract even if same passage reports the outcome).
    NO  → Q3.

Q3: Is something recorded as closed off, committed to, or imposed from outside?
    YES → Q3a–Q3d in order, stop at first YES:

      Q3a: Closure set by something outside those involved (rule, law, policy)?
           YES → constraint.

      Q3b: Were resources committed INSIDE this approach before it was closed?
           Test: "If I removed the closing event, would there be active work to stop?"
           The scene card's APPROACHES section states each approach's engagement
           level. Actual use, a trial, or a structured evaluation count as
           committed resources. A suggestion raised and dropped without any trial
           does not. Judge from the engagement the APPROACHES entry describes.
           YES → dead_end. NO → Q3c.

      Q3c: Was a specific outcome selected, AND IS THIS ITEM the selected outcome
           (not a competing alternative that was considered and rejected)?
           YES → decision. (Pending implementation ≠ unmade choice.)
           NO  → Q3d. An item naming a rejected/considered alternative is NOT a
                 decision even if a decision was made elsewhere this session.
                 If engagement existed for this alternative, Q3b above would have
                 caught it as dead_end. If no engagement, it falls through to Q7
                 (fact). REDUNDANCY check at KEEP OR SKIP applies after the tree.

      Q3d: Was a specific path committed to, but destination still unknown?
           YES → blueprint. (Brainstorming/non-binding → Q4.)

      Q3a–Q3d all NO → Q4.
    NO  → Q4.

Q4: Something left open and unresolved, no path committed to resolving it?
    YES → question. (Pure affirmation with no subject → skip.)
    NO  → Q5.

Q5: Specific work actively assigned or already underway right now?
    YES → task. NO → Q6.

Q6: A standing direction that shapes repeated situations, not a one-time choice?
    YES → preference. NO → Q7.

Q7: Q7a: Discrete occurrence at a specific point in time? YES → event.
    Q7b: Conclusion combining 2+ things not directly connected before? YES → insight.
    Otherwise → fact.

── POST-TYPE RULES — implied additional roles ──────────────────────────────

A single passage can carry multiple distinct claims that play different roles
in agent reasoning. After assigning the primary type, check whether the passage
also carries a second role; if so, extract a second item for that role and link
it with based_on. Different roles → different blocks, related by causality.

type = decision:
  BACKWARD TRACE (mandatory): "What was in active use before this?"
    Check scene card CAUSAL LINKS. Produce one of:
      Predecessor + engagement confirmed → extract dead_end
      Predecessor + engagement unclear → extract dead_end (uncertain = true)
      Greenfield (no replacement language) → nothing
  CONTRAST CHECK: "Competing path genuinely weighed but not chosen?"
    YES + engagement → dead_end. YES + speculative → fact. YES + unclear → dead_end (uncertain).
  TWO-LEVEL: "Also describes HOW?" YES → extract detail item (extends_id = this item).

type = dead_end:
  ENGAGEMENT: "Work done INSIDE this path?" No → reclassify as fact. From REPLACEMENTS → skip check.
  "Also ruled out by external rule?" YES → also extract constraint.

type = blueprint: "Also announces a committed outcome?" YES → also extract decision.
type = hypothesis: "Same passage reports the finding?" YES → also extract fact.
type = constraint: "Excluded option also previously tried?" YES → also extract dead_end.

type = fact OR insight:
  IMPLIED-CONSTRAINT CHECK (mandatory):
  "If the project accepted this item as true, does it make any choice the
   project could otherwise have made unavailable — or force a specific choice
   that would otherwise have been open?"

    YES → also extract constraint, linked to this item via based_on.
          Fill unique{} per the constraint schema, drawing the limit, reason,
          and source from the item's content as stated.
    NO → no additional item.

── KEEP OR SKIP ────────────────────────────────────────────────────────────
REDUNDANCY: "Can this content be recovered from another item?" YES → skip.
Always keep: core types (decision, dead_end, constraint, blueprint, preference).
Always keep: state snapshots with concrete measured values.
fact → keep if specific value/finding. Skip if vague. question → keep if unresolved.
Skip: agent narration, pure logistics, exact re-statements of RECENTLY SAVED
  (same claim AND same values). If a value has CHANGED → extract as new item.

SKIP EVIDENCE: A skip claim that cites RECENTLY SAVED must reference the
matching label/value visible in that section. If RECENTLY SAVED is empty or
the claim cannot be quoted from it, you may NOT skip on that grounds.

── EXTRACTION RULES ────────────────────────────────────────────────────────
1. One outcome = one item. "X failed, adopted Y" → TWO items.
2. Two-level: commitment + detail → two items. extends_id test:
   "If I deleted Item A, would Item B make sense standalone?" NO → extends_id.
3. Preserve exact quotes, names, numbers verbatim.
4. source: "output" | "thinking" (from thinking only) | "recap" (UNCHANGED/resolved).
5. Item IDs: item_1, item_2, … Never block-label format.
6. uncertain = true for core types with incomplete context. Never on fact/question/task.
7. extraction_reasoning — REQUIRED. Format:
     "<Q-tree trace> → <Q-tree type>. [post-type rules]: <fired rule(s) + verdict, or 'none'>. [final]: <type>."
   Example: "Q1=NO. Q2=NO. Q3=YES. Q3b=YES → dead_end. [post-type rules]: ENGAGEMENT=no → revise to fact. [final]: fact."
8. provisional_type = the [final] type from the trace — NOT the Q-tree's intermediate output.
   Post-type rules can REVISE this item's type (e.g. dead_end ENGAGEMENT check → fact).
   Post-type rules that ADD SEPARATE items (BACKWARD TRACE → separate predecessor dead_end,
   IMPLIED-CONSTRAINT → separate companion constraint, CONTRAST → separate dead_end, etc.)
   produce ADDITIONAL items with their own provisional_type; they do NOT alter THIS item's
   provisional_type. Read each post-type rule carefully: "extract X" with a SEPARATE subject
   means add an item; "revise to X" or "reclassify as X" means change this item's type.
`);

const PASS1_SCHEMA = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id:               { type: "string" },
          text:             { type: "string" },
          source:           { type: "string" },
          excerpt:          { type: "string" },
          extraction_reasoning: { type: "string" },
          provisional_type: { type: "string" },
          extends_id:       { type: "string" },
          uncertain:        { type: "boolean" },
        },
        required: ["id", "text", "source", "excerpt", "extraction_reasoning", "provisional_type"],
      },
    },
  },
  required: ["items"],
};

// Appended ONLY when a USER turn is present (NODEDEX_EXTRACT_ALL_SOURCES on). Frames
// the user's turn for PASS 1's job — RECALL is source-agnostic; the user is a source
// of claims (decisions/constraints/preferences/lived attempts), equal to the agent.
const PASS1_TWO_PARTY_SUFFIX = `

── TWO-PARTY INPUT (a USER turn is present) ────────────────────────────────
Extract claims from BOTH the USER turn and the AGENT turn — recall is source-agnostic.
The USER turn is frequently where a decision, constraint, preference, or lived attempt
ORIGINATES ("use X not Y", "must be Z", "I tried W and it failed"); the agent's reply
often only elaborates or confirms it. Do not privilege the agent's wording. Attribute
each item to what was actually said, and put the verbatim source span in the excerpt
field regardless of which party said it.`;

export async function callPass1LLM(
  provider: LLMProvider,
  agentThinking: string,
  agentOutput: string,
  recentSaves: string,
  sceneCard?: string,
  openBlueprints: Array<{ label: string; essence: string }> = [],
  userMessage: string = "",
): Promise<{ result: Pass1Result | null; thinking: string; rateLimited: boolean; model?: string; attempts?: Array<{ model: string; outcome: string }> }> {
  const sceneCardSection = sceneCard
    ? `SCENE CARD (use to guide extraction):\n${sceneCard}\n\n---\n\n`
    : "";

  const recentSection = recentSaves
    ? `RECENTLY SAVED THIS SESSION (do not re-extract these):\n${recentSaves}\n\n---\n\n`
    : "";

  const blueprintSection = openBlueprints.length > 0
    ? `OPEN BLUEPRINTS (from graph — if any appear as completed or deployed in this session, extract as decision and include the blueprint label in item text for Pass 2 to set supersedes_ref):\n${openBlueprints.map(b => `- ${b.label}: "${b.essence}"`).join("\n")}\n\n---\n\n`
    : "";

  const thinkingSection = agentThinking
    ? `AGENT THINKING:\n${agentThinking}\n\n---\n\n`
    : "";

  const userSection = userMessage && userMessage.trim()
    ? `USER:\n${userMessage}\n\n---\n\n`
    : "";
  const userInput = `${sceneCardSection}${recentSection}${blueprintSection}${userSection}${thinkingSection}AGENT OUTPUT:\n${agentOutput}`;
  const p1Prompt = userSection ? PASS1_PROMPT + PASS1_TWO_PARTY_SUFFIX : PASS1_PROMPT;

  const r = await provider.generateStructured<Pass1Result>(p1Prompt, userInput, PASS1_SCHEMA, { thinkingBudget: getThinkingBudget(1024), maxOutputTokens: 16384, modelOverride: modelForPass("pass1") });

  if (r.result) {
    reflectTokenStats.pass1.input    += r.usage?.input    ?? 0;
    reflectTokenStats.pass1.thinking += r.usage?.thinking ?? 0;
    reflectTokenStats.pass1.output   += r.usage?.output   ?? 0;
    reflectTokenStats.pass1.calls    += 1;
    const tag = provider.getName() !== "gemini" ? ` [${provider.getName()}]` : "";
    console.log(`Auto-Reflect Pass 1: ${r.result.items.length} item(s) extracted | tokens: ${r.usage?.input ?? "?"}→${r.usage?.output ?? "?"}${tag}`);
    for (const item of r.result.items) {
      console.log(`  [Pass 1 item] ${item.id} provisional_type=${item.provisional_type} text="${item.text.slice(0, 80)}"`);
    }
  } else {
    console.error(`Auto-Reflect Pass 1: ${r.rateLimited ? "rate limited" : "failed"} [${provider.getName()}]`);
  }

  return { result: r.result, thinking: r.thinking ?? "", rateLimited: r.rateLimited, model: r.model, attempts: r.attempts };
}
