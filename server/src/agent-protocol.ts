// agent-protocol.ts — the ONE source of truth for what an agent must know to use
// Nodedex well. It is delivered on TWO channels with DIFFERENT lifetimes, and the
// split between them is the whole point:
//
//   • AGENT_REFLEX — the BEHAVIOUR. Persisted by workspace_onboard into the agent's
//     OWN standing config (AGENTS.md / CLAUDE.md / rules file) → re-read into context
//     on EVERY TURN. Survives compaction. Present at hour four, at the line where the
//     decision is actually made.
//   • AGENT_PROTOCOL — the reflex PLUS the reference manual (how to judge a block,
//     detail levels, label construction). Delivered on the MCP `instructions` field,
//     ONCE per connect → it DECAYS. Fine for reference; useless as a reflex.
//
// WHY THE SPLIT (measured, 2026-07-12): an agent read the dead_end list at 12:17,
// authored the room data at 14:00, and shipped the exact bug the list warned about.
// It did not fail to understand — in isolation it uses the same list perfectly (two
// controlled tests). It failed because the instruction to LOOK was delivered in a
// channel that had scrolled out of context four hours earlier. So the reflex must be
// SMALL (it is paid on every turn) and PERSISTENT; the manual can be big and transient.
//
// The reflex carries NO graph data — only the discipline. Data would not scale (a
// 500-block project cannot ride in every turn); traversal scales, so the reflex's job
// is to make the agent WALK, and nothing more.

/** The persisted BEHAVIOUR. Small on purpose — every token here is paid on every turn. */
export const AGENT_REFLEX = `This project has a NodeDex memory graph: what was DECIDED, TRIED-AND-ABANDONED, and
CONSTRAINED here — reasoning the code does not carry, and that is NOT in your context.

YOUR CONFIDENCE IS NOT EVIDENCE HERE. You are competent, so an approach feels obviously
right. But what makes it right or wrong IN THIS PROJECT is in neither your training nor
your context — unless you read it from the graph THIS session. If you did not, you do
not know; you are guessing with conviction. Obviousness is the signal to CHECK, never
the licence to skip.

CHECK AT THE MOMENT YOU COMMIT TO AN APPROACH — not once at session start (a long task
scrolls that away long before the decision):
  · before you begin work in a project you have not checked THIS session
  · before your first edit to a file you have not touched this session
  · when asked to change / replace / improve / fix existing behaviour
  · when choosing between implementation options
  · whenever the answer feels obvious — see above

    workspace_filter(concepts)                  → the relevant project + entry blocks
    workspace_list(project, type="dead_end")    → what is already closed
    workspace_list(project, type="constraint")  → what must not break

Then TRAVERSE: workspace_get(label, detail="relations") returns the block WITH its causal
chain. A block is the headline; the chain is the story.

If a dead-end matches your idea: cite it and propose differently — or say what changed
that makes it worth re-trying.

You do not write knowledge (a pipeline extracts it from this conversation). The ONE thing
you maintain is your own work-state: workspace_task_update(id, "done"|"blocked", note) at
a task boundary — only you know when work is actually finished.`;

/** The reflex + the reference manual. Sent on the MCP `instructions` field each connect. */
export const AGENT_PROTOCOL = `${AGENT_REFLEX}

── REFERENCE ────────────────────────────────────────────────────────────────

REACH THE GRAPH ONLY THROUGH THESE TOOLS. Don't go hunting the filesystem or shell — never read Nodedex's database, log, or config files directly, and don't run raw SQL: you'd get rows stripped of the chains that carry the meaning, and you'd miss the dedup/heal the tools apply. Touch the underlying DB/files ONLY if you genuinely need something no tool can reach — the rare exception, not the default.

THE LOOP (traversal-first):
- Cold start? → workspace_tree — every project root with a one-line description. Pick your root by DESCRIPTION, not by name.
- New task, no anchor? → workspace_filter(concepts) — first-principle terms of your task (technologies, mechanisms, failure-modes; NOT "fix"/"issue"). Returns relevant project ROOTS + entry blocks.
- Know it exists but not the label? → workspace_search (fuzzy — the LAST resort; isolated matches). A weak-results note means the graph has NOTHING on this — say so plainly instead of stretching the nearest hits.
- Know exactly what you want? → CONSTRUCT the label and get it directly: {project}_{entity}_{type}_{concept} ('_' between dimensions, '-' within a concept, entity optional).
- Have a block? → workspace_get(label, detail="relations") — the block PLUS the causal SIGN it sits on. That is the unit of meaning; read it, open the next block, keep walking.

WHICH FIELD IS THE ROAD (a block hands you several, and they are not equal):
- chains[].leads_to  → THE ROAD. The very next thing this block led to, ranked — follow this. On a dead_end it is the fix.
- chains[].conclusion → where that next step lands, in one line. chains[].members → what this block CAME from (arc = that path; null when the block is itself the origin).
- outgoing / incoming → the RAW edges, unranked, including non-causal ones (related_to, contradicts, grounding). Your fallback when the sign did not show what you need. Expect the same neighbour to appear more than once (one edge per relation type) — that is one relationship, not several.
- linked_chains → a jump to a DIFFERENT thread that touches this one. Use it to change subject, not to continue.

CURRENT TRUTH: a block carrying superseded_by is STALE — read the superseding block and use THAT; never present the old one as current. But a DEAD_END IS NEVER STALE: a resolved dead-end carries resolved_by, not superseded_by, and it means the door STAYS CLOSED — resolved_by is HOW the project got around it, not permission to re-try the approach that failed. Re-open a dead-end only if some block says what CHANGED. And judge every block by its CONTENT (essence, unique fields, source_excerpt — the verbatim transcript evidence), never by its label: names drift.

JUDGING A BLOCK — weigh the WHOLE block in context, one field is never the verdict: essence = the claim · unique/has = the content · source_excerpt = the evidence (check it on load-bearing claims) · superseded_by = the currency · the chain = why it exists and what it led to. source_excerpt null is NORMAL on structural blocks (roots, chains, derived, manual saves) — their evidence lives in their members/inputs. A THIN block (few filled fields) is VALID — the essence is the load-bearing part. Distrust an extracted block only when its evidence can't support its claim — never for null, never for thin.

detail: surface (scan) → relations (block + its chain — the traversal default) → full. The graph is established MEMORY, not ground truth: your own untested conclusions are hypotheses until the graph or reality agrees — and when the graph conflicts with code or output you can verify RIGHT NOW, reality wins; flag the discrepancy so the graph can heal.`;

// Markers wrap the persisted block so a re-run can REPLACE it in place (never
// duplicate) and the user can remove it in one move.
export const NODEDEX_BEGIN = "<!-- nodedex:protocol:begin -->";
export const NODEDEX_END = "<!-- nodedex:protocol:end -->";

/** The REFLEX as a marked, removable block for the agent to persist into its own
 *  standing config — only ever with explicit user permission (workspace_onboard).
 *  Deliberately the reflex and NOT the full protocol: this text is re-read on every
 *  turn for the life of the project, so it must stay small. The reference manual
 *  rides the per-connect instructions instead. */
export function protocolBlock(): string {
  return `${NODEDEX_BEGIN}
## Project memory (NodeDex) — added with your permission. Delete this whole block to opt out.

${AGENT_REFLEX}
${NODEDEX_END}`;
}
