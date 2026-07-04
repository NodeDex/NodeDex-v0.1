// agent-protocol.ts — the ONE source of truth for what an agent must know to use
// Nodedex well. Consumed by BOTH:
//   • the MCP `instructions` field (server.ts) — the advisory FLOOR, every host,
//     re-sent each connect, may or may not be surfaced.
//   • workspace_onboard (tools/system.ts) — the persistent UPGRADE: on a capable
//     host the agent writes this into its OWN standing config (CLAUDE.md / rules
//     file) so the reflexes survive and are reliably followed.
// We can't reprogram the agent (we're a tool), so this is how the reflexes reach it.
// Keep it tight — it costs context tokens on every connect.

export const AGENT_PROTOCOL = `Nodedex is your persistent memory — a graph of what was decided, tried, ABANDONED, and constrained across sessions. You did NOT write it — a background pipeline extracts it from your conversation, so DON'T call save/write tools in normal work (they're for fixing graph errors only). READ before you act.

REACH THE GRAPH ONLY THROUGH THESE TOOLS. Don't go hunting the filesystem or shell — never read Nodedex's database, log, or config files directly, and don't run raw SQL: you'd get rows stripped of the chains that carry the meaning, and you'd miss the dedup/heal the tools apply. NAVIGATE (traverse), don't blindly query. Touch the underlying DB/files ONLY if you genuinely need something no tool can reach — that's the rare exception, not the default.

TWO REFLEXES — do these unprompted:
1. BEFORE proposing ANY approach, check what already failed — suggesting something abandoned, or that breaks a constraint, is the worst outcome. → workspace_filter the approach's concepts (or workspace_get a dead_end label); read the dead_ends + constraints FIRST.
2. When you need context, TRAVERSE — don't keyword-search. A block is a headline; the causal CHAIN it sits on is the story. Anchor on a block, then walk.

THE LOOP (traversal-first):
- Cold start? → workspace_tree — every project root with a one-line description. Pick your root by DESCRIPTION, not by name.
- New task, no anchor? → workspace_filter(concepts) — first-principle terms of your task (technologies, mechanisms, failure-modes; NOT "fix"/"issue"). Returns relevant project ROOTS + entry blocks.
- Know it exists but not the label? → workspace_search (fuzzy — the LAST resort; isolated matches). A weak-results note means the graph has NOTHING on this — say so plainly instead of stretching the nearest hits.
- Know exactly what you want? → CONSTRUCT the label and get it directly: {project}_{entity}_{type}_{concept} ('_' between dimensions, '-' within a concept, entity optional).
- Have a block? → workspace_get(label, detail="relations") — returns the block PLUS the chain(s) it sits on AND the chains they lead to / rest on (the connected story). That is the unit of meaning; read it, open the next block, keep walking.

CURRENT TRUTH: a block carrying superseded_by is STALE — read the superseding block and use THAT; never present the old one as current. And judge every block by its CONTENT (essence, unique fields, source_excerpt — the verbatim transcript evidence), never by its label: names drift.

detail: surface (scan) → relations (block + its chain — the traversal default) → full. The graph is established MEMORY, not ground truth: your own untested conclusions are hypotheses until the graph or reality agrees — and when the graph conflicts with code or output you can verify RIGHT NOW, reality wins; flag the discrepancy so the graph can heal.`;

// Markers wrap the persisted block so a re-run can REPLACE it in place (never
// duplicate) and the user can remove it in one move.
export const NODEDEX_BEGIN = "<!-- nodedex:protocol:begin -->";
export const NODEDEX_END = "<!-- nodedex:protocol:end -->";

/** The protocol as a marked, removable block for the agent to persist into its own
 *  standing config — only ever with explicit user permission (workspace_onboard). */
export function protocolBlock(): string {
  return `${NODEDEX_BEGIN}
# Nodedex memory protocol — added with your permission. Delete this whole block to opt out.

${AGENT_PROTOCOL}
${NODEDEX_END}`;
}
