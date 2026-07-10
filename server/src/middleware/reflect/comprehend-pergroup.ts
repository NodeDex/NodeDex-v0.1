// ═══════════════════════════════════════════════════════════════════════════════
// PIPELINE v2 — PER-GROUP COMPREHEND (the structural truncate fix; design §17)
// ═══════════════════════════════════════════════════════════════════════════════
//
// Splits the one monolithic COMPREHEND call (comprehend.ts) into two, each with ONE
// job, so each call's OUTPUT is BOUNDED and can't run away (the 307s truncate-retry
// root cause):
//   CALL 1  SEGMENT  (1 call, whole transcript)        → the group SKELETON only.
//   CALL 2  PRODUCE  (N calls, one per group, PARALLEL) → one group's blocks + links.
// A thin stitch reassembles the EXISTING ComprehendResult shape, so everything
// downstream (converter, Pass 2b, recognizer, checkpoint, Pass 3/4/5) is UNCHANGED.
//
// Default OFF: NODEDEX_COMPREHEND_PERGROUP=1 (only meaningful under v2). When off,
// runComprehendFrontHalf uses the original single callComprehendLLM.
//
// Prompt discipline (PROMPT-CHARTER): the STATE CONVENTION / worth-spine / STEP
// text is reused VERBATIM from COMPREHEND_PROMPT (copied, not refactored, to leave
// the validated 1-call prompt byte-untouched), recomposed for each narrower job.
// Each stage's MUST-NOTs (design §17.2) are stated in-prompt: SEGMENT never produces
// content; PRODUCE never re-decides the root or links across threads.

import { getThinkingBudget } from "./config.js";
import {
  validateComprehendResult,
  summarizeWarnings,
  comprehendModel,
  type ComprehendResult,
  type ComprehendGroup,
  type ComprehendBlock,
  type ComprehendLink,
  type ComprehendValidation,
  type ComprehendValidationIssue,
} from "./comprehend.js";
import type { LLMProvider } from "../../engine/ai-provider.js";
import { appendFileSync } from "node:fs";

export function pergroupEnabled(): boolean {
  // DEFAULT ON since 2026-06-12 (v2 promoted to default; chooseHolistic still
  // size-decides holistic-vs-pergroup per arc). NODEDEX_COMPREHEND_PERGROUP=0 opts out.
  return process.env.NODEDEX_COMPREHEND_PERGROUP !== "0";
}

/** DIAGNOSTIC (flag-gated NODEDEX_DEBUG_PERGROUP=1): dump what each group was told to
 *  extract (topic + turn_numbers — note PRODUCE also gets the FULL transcript) and what
 *  each block CITES (provenance), so cross-group duplicates can be traced to their cause
 *  (overlapping turn_numbers / the same source line claimed by >1 group). Off = no-op. */
function dumpPerGroupDebug(seg: SegmentResult, stitched: ComprehendResult): void {
  const file = process.env.NODEDEX_DEBUG_PERGROUP_FILE || "C:/tmp/pergroup-debug.jsonl";
  const segByGid = new Map((seg.groups ?? []).map((g) => [g.group_id, g]));
  const rec = {
    ts: new Date().toISOString(),
    segment_reasoning: seg.reasoning ?? "",
    groups: (stitched.groups ?? []).map((g) => {
      const sg = segByGid.get(g.group_id);
      return {
        group_id: g.group_id,
        topic: sg?.topic ?? "",
        turn_numbers: sg?.turn_numbers ?? [],
        blocks: (g.blocks ?? []).map((b) => ({
          local_id: b.local_id, type: b.type, unique: b.unique, essence: b.essence, provenance: b.provenance,
          keep_reason: b.keep_reason, type_reasoning: b.type_reasoning,
        })),
      };
    }),
  };
  try { appendFileSync(file, JSON.stringify(rec) + "\n"); } catch { /* diagnostic only */ }
}

// ═══════════════════════════════════════════════════════════════════════════════
// CALL 1 — SEGMENT (the outline; tiny output → cannot run away)
// ═══════════════════════════════════════════════════════════════════════════════

export interface SegmentGroup {
  group_id: string;
  topic: string;
  provisional_project?: string;
  turn_numbers?: number[];
}
export interface SegmentResult {
  groups: SegmentGroup[];
  reasoning?: string;
}

export const SEGMENT_PROMPT = `You read ONE complete work session between a user and an AI agent and split it into
the THREADS it contains. You do NOT extract any content yet — only the thread
structure. Read the whole session first.

Decide EVERYTHING by reasoning about MEANING in this session's context — what each
part was trying to DO. Never decide by matching surface words, phrasings, or
connectors. The same meaning appears in countless wordings across domains; you are
reading for the structure beneath the words.

── STATE CONVENTION ─────────────────────────────────────────────────────────
"State" = text in the TRANSCRIPT below. Your training knowledge and "what's
commonly known" are NOT state. If it is not in the transcript, it is not a thread
here. Familiarity ≠ recorded.

── SEGMENT into GROUPS (clusters under a root) ──────────────────────────────
Split the session into GROUPS. A group is one coherent sub-thread — a single
problem worked, question pursued, or thing decided. KEEP DISTINCT SUB-THREADS AS
SEPARATE GROUPS even when they belong to the same overall project; one sub-thread
scattered across the session is one group. Judge by what the participants were
trying to do, not by topic words. Do NOT collapse several sub-threads into one big
group — keep them fine-grained.

THEN assign each group a provisional_project — the ONE overarching ROOT it belongs
to. The ROOT is the project; the GROUP is a CLUSTER under it; ONE root has MANY
clusters. Sub-threads of the same overall effort SHARE a root but STAY SEPARATE
GROUPS — same root, several clusters; do NOT merge them into one group.
  • Use a DIFFERENT provisional_project ONLY for a genuinely separate topic — a
    real context-switch or an unrelated tangent.
  • A separate root must have a NAMEABLE SUBJECT: you must be able to say what the
    group's work is ABOUT without referring to the speaker's own remembering,
    reasoning, or composing of replies in this conversation. Recalling, weighing,
    and planning how to respond are the MEANS of every conversation, never a topic
    of their own — claims born of that procedure belong under the root of the work
    they serve.
  • When unsure whether two groups share a root, prefer the SAME root — splitting
    one topic across many roots (fragmentation) is worse than a slightly-broad root.
NAME the root with the most SPECIFIC identifier the session gives the SUBJECT the work
is ABOUT — named as specifically as the session itself names it. NEVER a generic
category word, a placeholder, or the group_id; if nothing that specific is named, use
the clearest phrase for what the work is about — never a bare "group"/number. Project
names are lowercase with hyphens only (no underscores), and provisional_project must
always be filled. This is provisional; cross-SESSION matching to existing roots happens later.

For each group, also list turn_numbers: the [TURN N] numbers whose content belongs
to this thread. A turn may belong to more than one group, and a thread may span
non-contiguous turns — list every turn the thread touches.

Output ONLY the thread structure: each group's group_id, topic, provisional_project
(the root), and turn_numbers. Do NOT produce any blocks, fields, content, or links —
a later step extracts those, one thread at a time. You need not emit a group for
pure greeting/closing chatter that did no work.`;

const SEGMENT_SCHEMA = {
  type: "object",
  properties: {
    groups: {
      type: "array",
      items: {
        type: "object",
        properties: {
          group_id: { type: "string" },
          topic: { type: "string" },
          provisional_project: { type: "string" },
          turn_numbers: { type: "array", items: { type: "number" } },
        },
        required: ["group_id", "topic", "provisional_project"],
      },
    },
    reasoning: { type: "string" },
  },
  required: ["groups"],
};

export interface SegmentCallResult {
  result: SegmentResult | null;
  rateLimited: boolean;
  model?: string;
  usage?: { input: number; thinking: number; output: number };
}

/** Run the SEGMENT call. Tiny maxOutputTokens (just the skeleton) — bounded by
 *  construction. Graph-blind (transcript only), like callComprehendLLM. */
export async function callSegmentLLM(
  provider: LLMProvider,
  transcript: string,
  thinkingBudget = 2048,
): Promise<SegmentCallResult> {
  const userInput = `TRANSCRIPT (one work session — read all of it, then list its threads):\n\n${transcript}`;
  const r = await provider.generateStructured<SegmentResult>(
    SEGMENT_PROMPT, userInput, SEGMENT_SCHEMA,
    { thinkingBudget: getThinkingBudget(thinkingBudget), maxOutputTokens: 4096, modelOverride: comprehendModel() },
  );
  return { result: r.result ?? null, rateLimited: r.rateLimited, model: r.model, usage: r.usage };
}

// SEAM 1.5 — validate the skeleton before fanning out to PRODUCE.
export function validateSegmentResult(result: unknown): ComprehendValidation {
  const errors: ComprehendValidationIssue[] = [];
  const warnings: ComprehendValidationIssue[] = [];
  const r = result as SegmentResult | null | undefined;
  if (!r || typeof r !== "object" || !Array.isArray(r.groups)) {
    errors.push({ severity: "error", message: "segment result.groups is missing or not an array" });
    return { valid: false, errors, warnings };
  }
  if (r.groups.length === 0) return { valid: true, errors, warnings }; // no residue — valid
  const seen = new Set<string>();
  for (const g of r.groups) {
    const gid = g?.group_id;
    if (!gid) { errors.push({ severity: "error", message: "group missing group_id" }); continue; }
    if (seen.has(gid)) errors.push({ severity: "error", message: `duplicate group_id "${gid}"`, group_id: gid });
    seen.add(gid);
    if (!g.topic || !String(g.topic).trim()) warnings.push({ severity: "warning", message: "group missing topic", group_id: gid });
    if (!g.provisional_project || !String(g.provisional_project).trim()) warnings.push({ severity: "warning", message: "group missing provisional_project", group_id: gid });
  }
  return { valid: errors.length === 0, errors, warnings };
}

// ═══════════════════════════════════════════════════════════════════════════════
// CALL 2 — PRODUCE (one group; bounded output, parallel, individually retryable)
// ═══════════════════════════════════════════════════════════════════════════════

export interface ProduceResult {
  blocks: ComprehendBlock[];
  within_group_links: ComprehendLink[];
}

export const PRODUCE_PROMPT = `You are extracting ONE thread from a work session between a user and an AI agent.
The whole transcript is given for context, but you extract ONLY the thread identified
below — its TOPIC and PROJECT are already decided (do not change them) and its turns
are listed.

Decide EVERYTHING by reasoning about MEANING in this session's context — what role
each piece played in what actually happened here. Never decide by matching surface
words, phrasings, or connectors. The same meaning appears in countless wordings
across domains; you are reading for the structure beneath the words.

── STATE CONVENTION ─────────────────────────────────────────────────────────
"State" = text in the TRANSCRIPT below. Your training knowledge and "what's
commonly known" are NOT state. Every block must quote a verbatim excerpt from the
transcript as its provenance. If it is not in the transcript, do not write it.
Familiarity ≠ recorded.

── WHAT TO KEEP (reason per candidate, from this thread) ────────────────────
Keep the irreplaceable RESIDUE of this thread — what was DECIDED, TRIED-AND-
ABANDONED, CONSTRAINED, OBSERVED, or STATED here — together with the REASONING.

The spine question, per candidate:
  "Could a competent model — given the project context but WITHOUT having lived
   this session — already produce this?"
     YES → it is knowledge the model already carries → do not emit.
     NO  → it exists only because this session happened → emit it.

Asymmetric cost: anything that exists ONLY because this session happened is
unrecoverable once dropped — not just a decision / dead_end / constraint, but also a
session-specific observation, measurement, or stated value. Only what the model
ALREADY carries regenerates for free; a value measured or stated here is not that.
When unsure → keep.

Consulting the agent's own memory is not such a happening. A statement whose subject
is that MEMORY itself — that what is already stored is complete, was reviewed, or that
reading it changed nothing — is not residue, even though the reading occurred this
session; reading memory is not an action in the work. Emit only what the work produced
about ITS subject, never the agent's reading of what it had already stored.

A conclusion's EVIDENCE is residue too — the observation, measurement, or result it
is reasoned from. Keep it as its own block and ground the conclusion to it
(based_on / supports); a conclusion saved without what it rests on is
half the record. Keep that evidence EVEN when nothing links to it yet — a later
session grounds it; never drop a session-specific observation for lack of a link.

Do not emit:
  • an option that was only RAISED in thought — never chosen, entered, or acted on.
  • a bare sequence of steps carrying no reason that nothing rests on — the WHEN with
    no WHY. (A step or value a conclusion is reasoned from is not bare — keep it.)

If the same claim appears more than once (e.g. restated in a recap), write it once,
using its most complete statement. If this thread holds no residue at all — pure
procedure, scaffolding, or chatter — output no blocks.

Every block carries keep_reason: one line, from the session, naming what makes it
residue (it was chosen / entered-then-abandoned / imposed / measured / asserted by
a party), or why you kept it when it was borderline.

Every block also carries type_reasoning: one line stating why THIS type's epistemic
role fits — what distinguishes it from the neighbouring types, judged by the role the
block plays for a future reader, not by surface wording. Decide this before you commit
the type.

── WRITE TYPED blocks for THIS thread ───────────────────────────────────────
A type is the agent's RELATIONSHIP to the knowledge, not its subject matter — the
same type spans every domain. For each piece of residue, reason about which
relationship fits, then FILL THAT TYPE'S unique{} FIELDS — this is the block's
structured identity and is REQUIRED, never empty. Put the actual content there
(the choice + reason, the value, the limit, the approach + why it failed), in the
session's own language. essence is only a one-line SUMMARY of those fields — it
does not replace them. One passage can carry several relationships → several blocks.

CORE relationships (consider these first):
  decision   {choice, reason, alternatives_rejected} — the participants CLOSED a
             fork: a path was committed to, adopted, or acted on. The decision is
             the path TAKEN; a path they CLOSED OFF is a dead_end (below), not a
             decision — even when one passage both settles the choice and rules out
             the alternative. A path one participant PUT FORWARD for another to
             accept leaves the fork open — that is a blueprint (below), not a
             decision, no matter how strongly it was urged. To type decision you
             must be able to point at WHERE the fork closed, not just where a path
             was proposed. Justify it: link based_on >=1 fact/constraint (below).
  dead_end   {approach, reason, alternative} — an approach CLOSED OFF for a stated
             reason, so a future reader should not re-open it. Covers one tried then
             abandoned AND one evaluated and definitively rejected before trying. A
             path merely floated with no verdict is NOT a dead_end — the close-off
             must be definite and reasoned.
  constraint {limit, reason, source} — a boundary that bounds EVERY option and that
             the participants must work within. May be imposed from outside OR set by
             the participants as a fixed limit; what makes it a constraint is that it
             GOVERNS the other choices rather than being one of them.
  fact       {value, why_matters} — a specific observed value or concrete state.
  insight    {observation, implication} — a realization drawn from combining things.
  blueprint  {purpose, status, trigger_to_implement} — a planned or proposed path
             whose outcome is not yet settled: a plan adopted but not yet executed,
             OR a path put forward that no one has yet accepted. The fork is still
             open; when it later closes, a decision supersedes this.
  preference {lean, over, condition} — a standing lean that shapes future choices,
             short of a committed decision.
  question   {question, why_matters} — left genuinely open, with no path forward.

When the level of commitment is unclear, type the LESS-committed role (blueprint
over decision, preference over constraint): the residue is still captured, and a
later session promotes it (a decision supersedes its blueprint). A false decision
misleads every future reader into treating an open fork as closed.

OTHER roles, with their REQUIRED fields (fill these exact field names), when none of
the above fits:
  hypothesis {proposal, evidence_against} — a claim offered as possibly true but
             NOT yet verified: reasoned TOWARD, not asserted as established. What it
             rests on is recorded as its OWN block and linked (based_on), not
             restated here; evidence_against is only what would weigh against it.
  entity     {name, role} — a thing the work REFERS TO by name, not a claim about it;
             identity is the name, role is the part it plays in the work.
  task       {status, description, owner} — work still TO BE DONE, tracked by its state
             of completion and who holds it.
  event      {what_happened, outcome, date} — a thing that OCCURRED at a point in time,
             as opposed to a standing truth that simply holds.
  note       {} — no field schema; the catch-all, only when no sharper role fits.
If a genuinely distinct epistemic role STILL fits none of these, name the type and
include schema{} (field -> what it captures).

Each block also carries: essence (one sentence, <=120 chars — what it is and why
it matters), concepts (a few terms naming what it is about), provisional_name (a
short slug for the thing — provisional, not a final label), provenance, keep_reason.

── WIRE the relationships WITHIN this thread ────────────────────────────────
Where the thread shows one block standing in a real relationship to another — one
thing led to another, justified it, replaced it, answered it, elaborates it,
provides evidence for it, or conflicts with it — record that link. Infer it from
what happened, whether or not any connecting word is present.

Each link is {from, to, type}, where "from" holds the relationship. Choose the
type whose MEANING matches:
  prompted_by  — from happened as a consequence of to (to is the trigger)
  based_on     — from is a conclusion grounded in to (evidence)
  extends      — from is a more specific case of to (broader)
  supersedes   — from replaces an earlier to
  resolves     — from answers the open question to, OR completes the open task /
                 executes the blueprint to (work that finishes what to called for)
  supports     — from is evidence for the proposal to
  contradicts  — from and to conflict
  related_to   — from and to are associated, with no sharper relationship
  derived_from — from was reasoned out from to
  affects      — from has an impact on to

Reach for the SHARPEST relation the meaning supports. related_to and affects are
the WEAKEST — a last resort, used ONLY when no grounding, consequence, replacement,
or answer actually holds between the two. When a sharper relation is true, name it.

Every block sits in a HISTORY — wire each way it connects BACKWARD to what came
before, not only its evidence:
  - what it was REASONED FROM: the observation, measurement, or result a later
    realization, boundary, choice, or lean rests on (based_on / supports / derived_from);
  - what it REPLACED: an earlier approach, value, or state this makes obsolete. The
    earlier block stays as history and MUST be linked FROM the newer one (supersedes) —
    never leave a superseded block standing as if nothing replaced it;
  - what TRIGGERED it: the event, failure, or need it arose as a consequence of
    (prompted_by);
  - the open item it CLOSES: the question it answers, or the task/blueprint this
    work completes (resolves). When the turn reports finishing something an open
    item called for, the link is resolves — NOT a bare based_on/related_to; a
    completion wired only as based_on leaves the item looking forever open.
The trap to avoid, for ANY block type: a block that REPLACED or was TRIGGERED BY
another, but is wired only to its supporting evidence, leaves that other block
ORPHANED — you recorded why it is justified but dropped what it displaced or
responded to. Both are how the state was reached; wire both.

The link type MUST be exactly one of these ten relations — never invent one, and
never use a block's unique{} field name as a link type. A detail that belongs to a
single block (a decision's rejected alternatives, a constraint's source, and the
like) is recorded INSIDE that block's own fields — never as a link, and never as a
separate block created only so something can link to it.

Every decision — and every hypothesis or insight that rests on a finding — needs >=1
based_on to the observation it is reasoned from. If that evidence is genuinely not in
this session, mark the block uncertain — never supply the evidence yourself.

The PROJECT is already assigned — do not change it. Do not assign final names, do
not match against any existing memory, and do NOT link to blocks in OTHER threads
(cross-thread links are a later stage). Output only this thread's blocks and
within-thread links.`;

// Block + link item schemas — identical to COMPREHEND_SCHEMA's (kept in sync by
// copy; the per-group path is default-OFF/experimental).
const PRODUCE_SCHEMA = {
  type: "object",
  properties: {
    blocks: {
      type: "array",
      items: {
        type: "object",
        properties: {
          local_id: { type: "string" },
          type: { type: "string" },
          unique: {
            type: "object",
            description: "REQUIRED structured identity fields for the type — never empty. e.g. decision: {choice, reason, alternatives_rejected}; fact: {value, why_matters}; dead_end: {approach, reason, alternative}; constraint: {limit, reason, source}; insight: {observation, implication}. Fill from the transcript.",
          },
          schema: { type: "object" },
          essence: { type: "string" },
          concepts: { type: "array", items: { type: "string" } },
          provisional_name: { type: "string" },
          provenance: { type: "string" },
          keep_reason: { type: "string" },
          type_reasoning: { type: "string" },
          uncertain: { type: "boolean" },
        },
        required: ["local_id", "type", "unique", "essence", "provenance", "keep_reason"],
      },
    },
    within_group_links: {
      type: "array",
      items: {
        type: "object",
        properties: {
          from: { type: "string" },
          to: { type: "string" },
          type: { type: "string" },
          reasoning: { type: "string" },
        },
        required: ["from", "to", "type"],
      },
    },
  },
  required: ["blocks", "within_group_links"],
};

export interface ProduceCallResult {
  result: ProduceResult | null;
  rateLimited: boolean;
  truncated: boolean;   // genuine over-generation truncation (finish=length) — caller may split+retry
  usage?: { input: number; thinking: number; output: number };
}

/** Produce ONE group's blocks + within-group links. maxOutputTokens is bounded to
 *  one thread's worth (24576, still under the 32768 cap) — the runaway can't fire.
 *  Was 16384, but a normal group in a 6-turn convo occasionally overflowed it →
 *  truncation-bump round-trip (worktest run 5); 24576 absorbs the dense-group case
 *  up front. Genuine over-generation past this still splits via produceGroupBounded. */
export async function callProduceGroupLLM(
  provider: LLMProvider,
  transcript: string,
  group: SegmentGroup,
  thinkingBudget = 4096,
): Promise<ProduceCallResult> {
  const turns = group.turn_numbers?.length ? ` (turns ${group.turn_numbers.join(", ")})` : "";
  const userInput =
    `THREAD TO EXTRACT — topic: "${group.topic}"; project: "${group.provisional_project ?? ""}"${turns}\n\n` +
    `FULL TRANSCRIPT (context; extract ONLY the thread above):\n\n${transcript}`;
  const r = await provider.generateStructured<ProduceResult>(
    PRODUCE_PROMPT, userInput, PRODUCE_SCHEMA,
    { thinkingBudget: getThinkingBudget(thinkingBudget), maxOutputTokens: 24576, modelOverride: comprehendModel() },
  );
  // truncated = the call failed specifically because output hit the token ceiling
  // (finish=length → openai.ts marks the attempt "truncated"), distinct from empty/
  // rate-limit/other. Only this case is worth a split-and-retry (the output was too big).
  const truncated = !r.result && (r.attempts ?? []).some((a) => a.outcome === "truncated");
  return { result: r.result ?? null, rateLimited: r.rateLimited, truncated, usage: r.usage };
}

// ── Output-bound (Fix 2 Layer 1, 2026-06-07) ─────────────────────────────────────
// A statement-dense group can make PRODUCE emit more JSON than the output-token budget
// → genuine truncation (finish=length) → the whole group was silently dropped by
// keep-partial. Instead: on truncation, split the transcript in half and recurse,
// merging the sub-results. local_ids are namespaced so they stay unique; within-group
// links across the split seam are dropped (the cross-group linker bridges boundaries
// later). Depth-capped; past the cap, keep whatever parsed. GUARANTEES a group is never
// silently lost to truncation. (Dogfood doc-feed 2026-06-07: a 19KB doc truncated a
// PRODUCE call at finish=length and lost the group.)
const MAX_PRODUCE_SPLIT_DEPTH = 3;

/** Split a transcript roughly in half by lines. Returns [t] when it can't be split. */
export function splitTranscriptForRetry(transcript: string): string[] {
  const lines = transcript.split("\n");
  if (lines.length < 2) return [transcript];
  const mid = Math.floor(lines.length / 2);
  return [lines.slice(0, mid).join("\n"), lines.slice(mid).join("\n")];
}

/** Merge PRODUCE sub-results, NAMESPACING each part's local_ids (and the link endpoints
 *  that reference them) so the merged group has unique ids. within_group_links only ever
 *  reference blocks within their own part, so prefixing both endpoints per-part is safe. */
export function mergeProduceResults(parts: ProduceResult[]): ProduceResult {
  const blocks: ComprehendBlock[] = [];
  const within_group_links: ComprehendLink[] = [];
  parts.forEach((part, i) => {
    const pfx = `s${i}_`;
    for (const b of part?.blocks ?? []) blocks.push({ ...b, local_id: pfx + b.local_id });
    for (const l of part?.within_group_links ?? []) within_group_links.push({ ...l, from: pfx + l.from, to: pfx + l.to });
  });
  return { blocks, within_group_links };
}

/** PRODUCE one group, BOUNDED against truncation: on a genuine truncation, split the
 *  transcript and recurse. ok=false only when it truly couldn't produce (a non-truncation
 *  failure, or still truncating at the depth cap) — a legit empty group is ok=true.
 *  `onCall` is invoked once per actual (sub-)call so the caller can count them. */
export async function produceGroupBounded(
  provider: LLMProvider,
  transcript: string,
  group: SegmentGroup,
  depth: number,
  onCall: () => void,
): Promise<{ result: ProduceResult; ok: boolean }> {
  onCall();
  const p = await callProduceGroupLLM(provider, transcript, group);
  if (p.result && Array.isArray(p.result.blocks)) return { result: p.result, ok: true };
  if (p.truncated && depth < MAX_PRODUCE_SPLIT_DEPTH) {
    const halves = splitTranscriptForRetry(transcript);
    if (halves.length === 2) {
      console.warn(`  [per-group PRODUCE] group "${group.group_id}" truncated — splitting transcript (depth ${depth + 1}) and retrying`);
      const [a, b] = await Promise.all([
        produceGroupBounded(provider, halves[0], group, depth + 1, onCall),
        produceGroupBounded(provider, halves[1], group, depth + 1, onCall),
      ]);
      return { result: mergeProduceResults([a.result, b.result]), ok: a.ok || b.ok };
    }
  }
  return { result: { blocks: [], within_group_links: [] }, ok: false };
}

// ═══════════════════════════════════════════════════════════════════════════════
// STITCH + ORCHESTRATE
// ═══════════════════════════════════════════════════════════════════════════════

/** Reassemble the SEGMENT skeleton + per-group PRODUCE outputs into the EXISTING
 *  ComprehendResult shape. A group with no produce output → empty blocks/links
 *  (valid; keep-partial). Pure. */
export function stitchToComprehendResult(
  seg: SegmentResult,
  produced: Map<string, ProduceResult>,
): ComprehendResult {
  const groups: ComprehendGroup[] = (seg.groups ?? []).map((g) => {
    const p = produced.get(g.group_id);
    return {
      group_id: g.group_id,
      topic: g.topic,
      provisional_project: g.provisional_project,
      blocks: Array.isArray(p?.blocks) ? p!.blocks : [],
      within_group_links: Array.isArray(p?.within_group_links) ? p!.within_group_links : [],
    };
  });
  return { groups, reasoning: seg.reasoning };
}

// ── REDO + QUARANTINE helpers (per-group SEAM-1 recovery, 2026-06-07) ─────────────

/** The group_ids that appear in any validation ERROR — i.e. which groups are "bad".
 *  Every post-stitch hard error carries a group_id (SEAM 1.5 guarantees each stitched
 *  group has one), so this attributes a failed validation to the responsible group(s),
 *  letting us redo / quarantine ONLY those — never the whole arc. */
export function groupIdsWithErrors(errors: ComprehendValidationIssue[]): Set<string> {
  const ids = new Set<string>();
  for (const e of errors ?? []) if (e.group_id) ids.add(e.group_id);
  return ids;
}

/** Empty the named groups (blocks + within-group links), leaving the rest untouched —
 *  the QUARANTINE floor. Pure. An emptied group is VALID (0 blocks), exactly like
 *  keep-partial, and carries no dangling links (cross-group links don't exist yet at
 *  this stage). The group skeleton stays so counts/grouping downstream are unchanged. */
export function quarantineGroups(result: ComprehendResult, gids: Set<string>): ComprehendResult {
  if (!gids.size) return result;
  return {
    ...result,
    groups: (result.groups ?? []).map((g) =>
      gids.has(g.group_id) ? { ...g, blocks: [], within_group_links: [] } : g),
  };
}

export interface PerGroupCallResult {
  result: ComprehendResult | null;       // null → caller degrades to v1
  validation: ComprehendValidation | null;
  rateLimited: boolean;
  segmentGroups: number;
  produceCalls: number;
  produceFailures: number;
  redoneGroups: number;        // invalid groups re-run after SEAM 1 (full-context redo)
  quarantinedGroups: number;   // groups still invalid after redo → emptied so the rest survive
  model?: string;
}

/**
 * Orchestrate per-group COMPREHEND: SEGMENT → SEAM 1.5 → PRODUCE per group
 * (parallel, bounded) → stitch → SEAM 1 (validateComprehendResult). Returns the
 * SAME {result, validation} shape as callComprehendLLM so runComprehendFrontHalf
 * uses it interchangeably. KEEP-PARTIAL: one group's PRODUCE failing → that group
 * is empty, the rest proceed (the single-point-of-failure removal). Degrades
 * (result=null) only when SEGMENT itself fails/invalidates.
 */
export async function runComprehendPerGroup(
  provider: LLMProvider,
  transcript: string,
  opts: { produceConcurrency?: number } = {},
): Promise<PerGroupCallResult> {
  const base: PerGroupCallResult = {
    result: null, validation: null, rateLimited: false,
    segmentGroups: 0, produceCalls: 0, produceFailures: 0,
    redoneGroups: 0, quarantinedGroups: 0,
  };

  // CALL 1 — SEGMENT
  const seg = await callSegmentLLM(provider, transcript);
  if (!seg.result) {
    console.warn(`Auto-Reflect COMPREHEND (per-group): SEGMENT ${seg.rateLimited ? "rate limited" : "failed"} — returning null (arc path: bounded retry then fail-clean; v1 does NOT run)`);
    return { ...base, rateLimited: seg.rateLimited };
  }
  const segVal = validateSegmentResult(seg.result);
  if (!segVal.valid) {
    console.warn(`Auto-Reflect COMPREHEND (per-group): SEAM 1.5 invalid (${segVal.errors.length} error(s)) — returning null (arc path: bounded retry then fail-clean; v1 does NOT run)`);
    return base;
  }
  const groups = seg.result.groups ?? [];
  base.segmentGroups = groups.length;
  base.model = seg.model;

  // No residue → a valid empty result (the caller treats groups.length===0 as "nothing to save").
  if (groups.length === 0) {
    const emptyResult: ComprehendResult = { groups: [] };
    return { ...base, result: emptyResult, validation: validateComprehendResult(emptyResult) };
  }

  // CALL 2 — PRODUCE per group, parallel + bounded; keep-partial on failure.
  const produced = new Map<string, ProduceResult>();
  const CONC = opts.produceConcurrency ?? 4;
  for (let i = 0; i < groups.length; i += CONC) {
    await Promise.all(groups.slice(i, i + CONC).map(async (g) => {
      try {
        // Output-bound (Fix 2 Layer 1): split-and-retry on genuine truncation so a
        // dense group is never silently dropped. onCall counts every (sub-)call.
        const { result, ok } = await produceGroupBounded(provider, transcript, g, 0, () => { base.produceCalls += 1; });
        produced.set(g.group_id, result);
        if (!ok) base.produceFailures += 1;
      } catch (e: any) {
        base.produceFailures += 1;
        produced.set(g.group_id, { blocks: [], within_group_links: [] });
        console.warn(`  [per-group PRODUCE] group "${g.group_id}" threw: ${e?.message ?? e}`);
      }
    }));
  }

  let stitched = stitchToComprehendResult(seg.result, produced);
  let validation = validateComprehendResult(stitched);

  // ── REDO bad groups, then QUARANTINE the unrecoverable ───────────────────────
  // Per-group PRODUCE isolates failures, but SEAM 1 validates the WHOLE stitched
  // result: ONE group's HARD error (e.g. a block missing its provenance excerpt —
  // common when an empty draw escalated to a weaker fallback model) fails the entire
  // arc → the caller degrades to v1 → the whole session's residue is lost. Instead:
  //   1. RE-RUN PRODUCE for ONLY the invalid groups. Each redo gets the SAME context
  //      the first call did (full transcript + that group's scope, via
  //      produceGroupBounded) and re-uses the provider's empty→escalate path, so a
  //      redraw usually lands valid.
  //   2. Any group STILL invalid after the redo is QUARANTINED (emptied) so the VALID
  //      groups survive — one bad thread no longer sinks the others.
  // Degrade to v1 only when NO group survives (every group bad, or errors that can't
  // be attributed to a group) — the existing total-failure path, unchanged.
  if (!validation.valid) {
    const badIds = groupIdsWithErrors(validation.errors);
    if (badIds.size > 0) {
      const segByGid = new Map((seg.result.groups ?? []).map((g) => [g.group_id, g]));
      console.warn(`Auto-Reflect COMPREHEND (per-group): ${badIds.size} group(s) invalid at SEAM 1 — redoing ONLY those`);
      await Promise.all([...badIds].map(async (gid) => {
        const g = segByGid.get(gid);
        if (!g) return;                                    // no segment to redo from (shouldn't happen)
        try {
          const { result } = await produceGroupBounded(provider, transcript, g, 0, () => { base.produceCalls += 1; });
          produced.set(gid, result);
          base.redoneGroups += 1;
        } catch (e: any) {
          console.warn(`  [per-group REDO] group "${gid}" threw: ${e?.message ?? e}`);
        }
      }));
      stitched = stitchToComprehendResult(seg.result, produced);
      validation = validateComprehendResult(stitched);

      // QUARANTINE floor — keep the good groups, empty the still-bad ones. Only when at
      // least one group survives; if every group is still bad, leave it invalid so the
      // caller degrades to v1.
      if (!validation.valid) {
        const stillBad = groupIdsWithErrors(validation.errors);
        if (stillBad.size > 0 && stillBad.size < stitched.groups.length) {
          stitched = quarantineGroups(stitched, stillBad);
          validation = validateComprehendResult(stitched);
          base.quarantinedGroups = stillBad.size;
          console.warn(`Auto-Reflect COMPREHEND (per-group): quarantined ${stillBad.size} unrecoverable group(s) — kept ${stitched.groups.length - stillBad.size} valid group(s)`);
        }
      }
    }
  }

  const blockCount = stitched.groups.reduce((n, g) => n + (g.blocks?.length ?? 0), 0);
  const extra =
    (base.redoneGroups ? `, ${base.redoneGroups} redone` : "") +
    (base.quarantinedGroups ? `, ${base.quarantinedGroups} quarantined` : "");
  console.log(
    `Auto-Reflect COMPREHEND (per-group): ${groups.length} group(s), ${blockCount} block(s) | ` +
    `produce ${base.produceCalls} call(s), ${base.produceFailures} fail${extra} | valid=${validation.valid} ` +
    `errors=${validation.errors.length} warnings: ${summarizeWarnings(validation.warnings)}`,
  );
  if (process.env.NODEDEX_DEBUG_PERGROUP === "1") dumpPerGroupDebug(seg.result, stitched);
  return { ...base, result: stitched, validation };
}
