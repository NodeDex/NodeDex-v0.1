import { reflectTokenStats } from "./context.js";
import { getThinkingBudget, modelForPass } from "./config.js";
import type { LLMProvider } from "../../engine/ai-provider.js";
import type { Pass0Result } from "./types.js";

// ═══════════════════════════════════════════════════════════════════════════════
// PASS 0 — SCENE CARD
// Job: holistic read of the full transcript before itemization.
// Output: structured overview that Pass 1 uses to guide type derivation and
// skip decisions. No thinking budget — fast, cheap, runs before Pass 1.
// ═══════════════════════════════════════════════════════════════════════════════

export const PASS0_PROMPT = `You receive raw agent output — thinking and final response from an AI assistant.
Read the ENTIRE content as a whole before filling out this scene card.

── STATE CONVENTION ─────────────────────────────────────────────────────────
"State" in this prompt = text in marked regions below (TRANSCRIPT, AGENT THINKING,
KNOWN PROJECTS, OPEN BLUEPRINTS). Your training knowledge, pretrained familiarity,
and what is "well-known in the field" are NOT state. When you reference state —
e.g. matching a term against KNOWN PROJECTS — you must be able to point to the
exact line in the marked region. Familiarity ≠ recorded state.

Your goal: describe what happened in this session so that downstream extraction can
correctly classify and link each piece of information. Observe and describe — do not
assign types. Be concise — one line per entry.

Record names, labels, and terms exactly as they appear in the transcript. Do not
expand abbreviations or add parenthetical clarifications to terms not spelled out in
the source — your job is to record what is there, not infer what it means.

── INPUT TYPE ────────────────────────────────────────────────────────────────
Ask: "Does this text describe decisions and events from a specific session —
or does it synthesize general domain knowledge with no session frame?"

  Session-scoped: references to "this session", choices made now, trials run,
    approaches adopted or rejected in a specific context, work in progress,
    temporal markers ("today", "this sprint", "the team decided") → CONVERSATIONAL
    Note: the input is always an agent's summary — single voice narrating session
    events is still CONVERSATIONAL if the events have a session temporal frame.

  Domain knowledge synthesis: no session frame, conclusions stated as general
    findings ("X is proven", "Y has been superseded in the field", "Z remains
    an open problem"), no choices being made now → KNOWLEDGE_SYNTHESIS
    For KS input, SECTION 3 (actor-actions) and SECTION 4 (tasks) will be sparse
    or empty — that is correct. SECTION 7 (REPLACEMENTS) should also be empty
    unless a participant in THIS session is actively deciding to replace X with Y.
    "The industry moved from X to Y" is a domain fact, not a session replacement.

Set input_type field to CONVERSATIONAL or KNOWLEDGE_SYNTHESIS. This field is used
by downstream passes to adjust their framing.

── SECTION 1: PROJECTS ───────────────────────────────────────────────────────
Every project, product, or system this session is about.
Name + one-line scope.

If KNOWN PROJECTS are provided, check them first.
Transcripts use generic self-referential terms to describe participants: "the company",
"the team", "the organization", "our group", "the lab", "the division", "the firm".
These are pronouns — how participants refer to themselves. They are NOT project names.

Project names are specific coined identifiers: a code name, product name, initiative name,
or organization-specific proper noun. A generic noun that could describe any organization
is never a project name.

Rule: if the transcript uses a generic term that clearly refers to a known project →
use the known project name, not the generic term.
Rule: if no known project matches, use the most specific identifier from the transcript
(a product name, initiative name, proper noun) — never the generic noun itself.
Rule: express every project name in label format — lowercase, hyphens only, no underscores,
no spaces (e.g. "x-initiative" not "X Initiative"). This name becomes the project_creates[]
label in Pass 3. A name that is not label-safe breaks downstream processing.

SCOPE PROJECT — also identify the ONE overarching subject of the whole transcript.
Every transcript has exactly one. Specific systems and products still go in projects[];
the scope project is the umbrella they sit under — and the home for cross-cutting
knowledge that belongs to no single project. If the transcript is about a single
project, the scope project IS that project. Set scope_project = { name, scope },
name in the same label format. It must always be filled.

── SECTION 2: PEOPLE AND ROLES ──────────────────────────────────────────────
Everyone mentioned. For each person, set:
  role = what they contributed (decision_maker, constraint_source, executor, observer)
  signal_type = how they appear in the transcript (named, inferred, role_only)
Roles:
  decision_maker     — confirmed, approved, or chose something
  constraint_source  — imposed an external requirement (auditor, vendor, regulator)
  executor           — will build or implement something
  observer           — described facts without making choices

── SECTION 3: ACTOR-ACTION LOG ──────────────────────────────────────────────
Significant actions as tuples: [actor] → [verb] → [object] → [outcome or nil]
Only actions with lasting consequences. Skip narration and logistics.

── SECTION 4: APPROACHES AND OPTIONS ────────────────────────────────────────
Every approach, tool, system, method, model, hypothesis, methodology, or strategy
that appeared as a choice point — regardless of domain.
For each: name, project (if known), and a description of what happened to it.
Describe what was observed. Do not assign a type — use the descriptions below.

For each approach, ask: "What does the text say about this concept's current standing?"

Description formats — for CONVERSATIONAL input (session-temporal framing):
  In prior use, being replaced this session:
    "[name] has been in active use for [period], being replaced by Y this session"
  Adopted or confirmed this session:
    "[name] selected as the [role], confirmed this session"
  Explicitly excluded by named authority:
    "[name] ruled out by [authority]: [reason]"
  Formally evaluated and rejected (requires an actual trial, pilot, or dedicated time):
    "[name] formally evaluated for [duration], rejected: [reason]"
  Casually mentioned, no engagement:
    "[name] mentioned speculatively only: '[quote]'"
    "[name] briefly dismissed with reasons but no prior use"
  Currently in use, no change: "[name] in active use, no change this session"
  Committed for future evaluation: "[name] committed to formal evaluation in [period]: [what]"

Description formats — for KNOWLEDGE_SYNTHESIS input (domain-status framing):
  Historically dominant, now generally superseded:
    "[name] was the dominant approach for [period/context], now generally superseded by [Y]"
  Currently standard or widely adopted:
    "[name] is the current standard approach for [function]"
  Proposed or emerging, not yet established:
    "[name] proposed as alternative to [Y], [current evidence status]"
  Evaluated and abandoned in domain practice:
    "[name] tried in [context], abandoned: [reason]"
  Mentioned for comparison only:
    "[name] mentioned for comparison: [brief context]"

Format: "name [project] — description"
The [project] MUST be a short project label from SECTION 1 (e.g., "project-a", "my-initiative").
Never use a block ID, a full label string, or any value that contains underscores or numbers.
JSON field mapping: name → name field | [project] → project field (label only) | description → context field.
The project field contains ONLY the short label. The context field contains ONLY the description phrase. Never mix them.
Examples:
  "approach-A [project-x] — has been in use for months, being replaced by approach-B this session"
  "option-C [project-x] — mentioned speculatively only: 'would have handled problem P differently'"
  "option-D [project-y] — ruled out by [authority]: violates standing policy"
  "methodology-F [org] — formally evaluated for 3 months, rejected: high inter-rater variability"

KEY DISTINCTION — speculative mention vs substantive rejection:
  Ask: "Was a path into X actually entered — did anyone commit resources to it
  (time to investigate, a trial, a deployment, a structured comparison) —
  or did X enter this conversation as a suggestion and leave as a dismissal?
  Reasoning about what X would cost is not entering the path."

    Path entered — in active use:
      X was in use before this session, now being replaced → "in prior use, being replaced"
    Path entered — committed investigation:
      Someone was assigned to evaluate X, a trial ran, or resources were allocated to it.
      "Did someone actually try X — or reason about what trying X would cost?"
      Estimating the expense of X is not investing in X. → "formally evaluated, rejected"
    Path not entered — speculative:
      X raised and dismissed, no follow-up committed. Expert reasoning against X
      reflects knowledge about X, not prior investigation of X for this project.
      → "mentioned speculatively" or "briefly dismissed with reasons but no prior use"

  When ambiguous: default to "briefly dismissed" description.
  A misplaced speculative is recoverable. A misplaced "formally evaluated" creates false signal.

── SECTION 5: TASKS (work actively in progress) ─────────────────────────────
Work that is currently underway — NOT yet complete.
Ask: "Are resources actively committed to this — in progress, not yet done?"
Format: "project_name: person — what they are doing"
DO NOT include: status-only confirmations with no new content ("X is on track", "X is going well",
"X has no blockers"). Those add no new graph knowledge.
DO NOT include future evaluations or investigations not yet started — these belong in
SECTION 4 APPROACHES with the "committed for future evaluation" description.

── SECTION 6: CAUSAL LINKS ──────────────────────────────────────────────────
X → Y where X caused Y, even if they appear in different paragraphs.
Only clear causal chains. Keep entries short.

JOINT CAUSATION — multiple abandonments/failures jointly driving one adoption:
  Capture as ONE entry with compound cause. Format: "cause-A + cause-B → effect"
  Example: "[X-abandoned] + [Y-abandoned] → [Z-adopted]"

── SECTION 7: REPLACEMENTS ──────────────────────────────────────────────────
Things that were in active use and are being replaced THIS session — announced now, not already done.
Scan the ENTIRE transcript for replacement pairs — these are mandatory dead_end
candidates for Pass 1.

GATE: If INPUT TYPE = KNOWLEDGE SYNTHESIS, ask:
  "Is a participant in THIS session deciding to replace X with Y — or is the text
  reporting that X has generally been replaced by Y in the domain?"
  Reporting a domain-wide shift → not a replacement pair. Put in UNCHANGED instead.

A replacement pair exists when ALL THREE are true:
  - X was actively in use AND
  - X is being replaced or retired by Y AND
  - This replacement is announced NOW in this session, not referenced as already done

Ask: "Is this replacement happening now — or referenced as prior-session context?"
  Happening now → REPLACEMENTS. Already done → UNCHANGED instead.

Format: { predecessor: "X", replacement: "Y", function: "what both served" }
Use actual names from transcript. Leave empty if no replacement pairs exist.

── SECTION 8: UNCHANGED ─────────────────────────────────────────────────────
Things being reported as already resolved — surfaced as context for the current work,
not being worked out in this session.

GATE: If INPUT TYPE = KNOWLEDGE_SYNTHESIS, this section should be EMPTY.
  KS has no prior session — all content is domain knowledge, not recap.
  Downstream passes use UNCHANGED to skip items as duplicates — filling it for KS kills correct items.

For CONVERSATIONAL input only:

For each entry in SECTION 4 (APPROACHES), ask:
  "Is the speaker explicitly presenting this as carried-over context from a prior session —
  or is it being worked out now?"
    Being worked out now (chosen, rejected, evaluated, investigated this session) → SECTION 4 only
    Speaker presents it as prior-session context, not active work → SECTION 4 AND here

Also ask for anything else in the transcript:
  "Is a speaker explicitly presenting this as resolved prior context — or as something new?"
    Resolved prior context → include here
    New this session → do not include here

An entry can appear in both SECTION 4 and SECTION 8. They serve different purposes:
SECTION 4 = engagement description (Pass 2). SECTION 8 = recap signal (Pass 1). Both needed.

── SCENE CARD REASONING (diagnostic) ───────────────────────────────────────
scene_card_reasoning: In 1-2 sentences — what input type did you identify
(CONVERSATIONAL or KNOWLEDGE SYNTHESIS), and what drove the key APPROACHES
descriptions you chose (especially for any "formally evaluated" or "in prior use" entries)?`;

const PASS0_SCHEMA = {
  type: "object",
  properties: {
    input_type: {
      type: "string",
      enum: ["CONVERSATIONAL", "KNOWLEDGE_SYNTHESIS"],
    },
    projects: {
      type: "array",
      items: {
        type: "object",
        properties: { name: { type: "string" }, scope: { type: "string" } },
        required: ["name", "scope"],
      },
    },
    scope_project: {
      type: "object",
      properties: { name: { type: "string" }, scope: { type: "string" } },
      required: ["name", "scope"],
    },
    people: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name:        { type: "string" },
          role:        { type: "string" },
          signal_type: { type: "string" },
        },
        required: ["name", "role", "signal_type"],
      },
    },
    actor_actions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          actor:   { type: "string" },
          action:  { type: "string" },
          object:  { type: "string" },
          outcome: { type: "string" },
        },
        required: ["actor", "action", "object"],
      },
    },
    technologies: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name:    { type: "string" },
          project: { type: "string", maxLength: 64 },
          context: { type: "string" },
        },
        required: ["name"],
      },
    },
    in_flight:    { type: "array", items: { type: "string" } },
    causal_links: {
      type: "array",
      items: {
        type: "object",
        properties: {
          cause:  { type: "string" },
          effect: { type: "string" },
        },
        required: ["cause", "effect"],
      },
    },
    replacements: {
      type: "array",
      items: {
        type: "object",
        properties: {
          predecessor:  { type: "string" },
          replacement:  { type: "string" },
          function:     { type: "string" },
        },
        required: ["predecessor", "replacement", "function"],
      },
    },
    unchanged:            { type: "array", items: { type: "string" } },
    scene_card_reasoning: { type: "string" },
  },
  required: [
    "input_type", "projects", "scope_project", "people", "actor_actions", "technologies",
    "in_flight", "causal_links", "replacements", "unchanged", "scene_card_reasoning",
  ],
};

// ─── Scene card formatter ─────────────────────────────────────────────────────
// Converts Pass 0 JSON output to a compact, human-readable block for Pass 1 context.

export function formatSceneCard(card: Pass0Result): string {
  const lines: string[] = [];

  if (card.input_type) {
    lines.push(`INPUT TYPE: ${card.input_type}`);
  }

  if (card.scope_project && card.scope_project.name) {
    lines.push(`SCOPE PROJECT: ${card.scope_project.name} (${card.scope_project.scope}) — home for cross-cutting items`);
  }

  if (card.projects.length > 0) {
    lines.push(`PROJECTS: ${card.projects.map(p => `${p.name} (${p.scope})`).join(" | ")}`);
  }

  if (card.people.length > 0) {
    lines.push(`PEOPLE: ${card.people.map(p => `${p.name} [${p.signal_type}]`).join(", ")}`);
  }

  if (card.technologies.length > 0) {
    lines.push("APPROACHES:");
    for (const t of card.technologies) {
      const proj = t.project ? ` [${t.project}]` : "";
      const ctx  = t.context ? ` — ${t.context}` : "";
      lines.push(`  ${t.name}${proj}${ctx}`);
    }
  }

  if (card.actor_actions.length > 0) {
    lines.push("ACTOR-ACTIONS:");
    for (const a of card.actor_actions) {
      const outcome = a.outcome ? ` → ${a.outcome}` : "";
      lines.push(`  ${a.actor} → ${a.action} → ${a.object}${outcome}`);
    }
  }

  if (card.in_flight.length > 0) {
    lines.push(`TASKS (work in progress — extract as task type): ${card.in_flight.join(" | ")}`);
  }

  if (card.causal_links.length > 0) {
    lines.push("CAUSAL LINKS:");
    for (const c of card.causal_links) {
      lines.push(`  ${c.cause} → ${c.effect}`);
    }
  }

  if (card.replacements && card.replacements.length > 0) {
    lines.push("REPLACEMENTS (predecessor in active use → replaced this session):");
    for (const r of card.replacements) {
      lines.push(`  ${r.predecessor} → ${r.replacement} (${r.function})`);
    }
  }

  if (card.unchanged.length > 0) {
    lines.push(`UNCHANGED (established context — extract normally, Pass 3 deduplicates): ${card.unchanged.join(" | ")}`);
  }

  return lines.join("\n");
}

// ─── LLM call ─────────────────────────────────────────────────────────────────

// Appended ONLY when a USER turn is present (NODEDEX_EXTRACT_ALL_SOURCES on). Frames
// the user's turn for PASS 0's job — DESCRIBE what happened, for BOTH parties.
const PASS0_TWO_PARTY_SUFFIX = `

── TWO-PARTY INPUT (a USER turn is present) ────────────────────────────────
This session is an exchange, not a single agent voice: a USER turn plus the AGENT's
thinking + response. Both are session events. Describe the USER's side as faithfully
as the agent's — what they asked, decided, committed to, ruled out, or stated as
their own situation/constraint. A decision or constraint often ORIGINATES in the
user's turn and is merely elaborated by the agent's reply. Attribute each observation
to the right party. Still: observe and describe, do not assign types.`;

export async function callPass0LLM(
  provider: LLMProvider,
  agentThinking: string,
  agentOutput: string,
  openBlueprints: Array<{ label: string; essence: string }> = [],
  knownRoots: Array<{ label: string; essence: string }> = [],
  userMessage: string = "",
): Promise<{ result: Pass0Result | null; rateLimited: boolean; model?: string; attempts?: Array<{ model: string; outcome: string }> }> {
  const today = new Date().toLocaleDateString("en-US", {
    weekday: "long", year: "numeric", month: "long", day: "numeric",
  });

  const blueprintSection = openBlueprints.length > 0
    ? `OPEN BLUEPRINTS (currently planned in graph — if completed in this transcript, reference the exact label in SECTION 6):\n${openBlueprints.map(b => `- ${b.label}: "${b.essence}"`).join("\n")}\n\n`
    : "";

  const projectSection = knownRoots.length > 0
    ? `KNOWN PROJECTS:\n${knownRoots.map(p => `- ${p.label}`).join("\n")}\n\n`
    : "";

  const thinkingSection = agentThinking
    ? `AGENT THINKING:\n${agentThinking}\n\n---\n\n`
    : "";
  const userSection = userMessage && userMessage.trim()
    ? `USER:\n${userMessage}\n\n---\n\n`
    : "";
  const userInput = `TODAY: ${today}\n\n${blueprintSection}${projectSection}${userSection}${thinkingSection}AGENT OUTPUT:\n${agentOutput}`;
  const p0Prompt = userSection ? PASS0_PROMPT + PASS0_TWO_PARTY_SUFFIX : PASS0_PROMPT;

  const r = await provider.generateStructured<Pass0Result>(p0Prompt, userInput, PASS0_SCHEMA, {
    thinkingBudget: getThinkingBudget(2048),
    modelOverride: modelForPass("pass0"),
    // Bumped 16384 → 32768 (2026-05-31) — slice 1 verify T4 truncated TWICE at
    // both 16384 base and 24576 bump on openai-compatible/gemini-2.5-flash path.
    // Comparable T1/T2/T3/T5 used ~1000-1100 output tokens, so the 16384 ceiling
    // was being eaten by runaway thinking (the `reasoning.max_tokens=2048` hint
    // sent via openai.ts:81 is advisory on OpenRouter and was ignored for T4).
    // Bumping the OUTER budget gives total-completion-budget headroom: even with
    // 25K of thinking, 32768 leaves room for ~1KB of JSON output. The bumped-
    // retry path (openai.ts:60) then escalates to min(32768*1.5, 65536) = 49152.
    // Cost-neutral — provider bills only for tokens used, not the cap.
    maxOutputTokens: 32768,
  });

  if (r.result) {
    reflectTokenStats.pass0.input    += r.usage?.input    ?? 0;
    reflectTokenStats.pass0.thinking += r.usage?.thinking ?? 0;
    reflectTokenStats.pass0.output   += r.usage?.output   ?? 0;
    reflectTokenStats.pass0.calls    += 1;
    const tag = provider.getName() !== "gemini" ? ` [${provider.getName()}]` : "";
    const approaches    = r.result.technologies.length;
    const inFlight      = r.result.in_flight.length;
    const causal        = r.result.causal_links.length;
    const replacements  = r.result.replacements?.length ?? 0;
    console.log(`Auto-Reflect Pass 0: scene card built — approaches=${approaches} in-flight=${inFlight} causal=${causal} replacements=${replacements} | tokens: in=${r.usage?.input ?? "?"} think=${r.usage?.thinking ?? "?"} out=${r.usage?.output ?? "?"}${tag}`);
  } else {
    console.warn(`Auto-Reflect Pass 0: ${r.rateLimited ? "rate limited" : "failed"} — proceeding without scene card [${provider.getName()}]`);
  }

  return { result: r.result, rateLimited: r.rateLimited, model: r.model, attempts: r.attempts };
}
