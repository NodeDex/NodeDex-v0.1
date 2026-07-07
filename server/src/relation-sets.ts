// relation-sets.ts — single source of truth for the CAUSAL TRAVERSAL thread.
//
// "Which relation types are 'how was this reached?'" Every READ-SIDE traversal
// endpoint imports this ONE set so they walk a consistent causal graph, instead of
// the historical inconsistency where /chain walked only 3 types and `extends` /
// `supports` (the bulk of real elaboration edges) were invisible — making
// genuinely-connected blocks render as orphans.
//
// IN  — the cause-and-effect reasoning thread the agent walks to understand how a
//       state was reached.
// OUT — `part_of` (containment), `member_of` (chain membership — a grouping, like a
//       folder), `related_to` (loose), `contradicts` (conflict, not "how reached"),
//       and task/manual edges. Those are real, but they are not the causal thread.
//
// SCOPE: this is now the single source of truth for the causal thread across all
// three "chain" notions — read-side TRAVERSAL (/chain, /nav), the chain_id
// clustering WRITER (stampFlowRolesAndChains), AND Pass 5 chain assembly — unified
// 2026-06-05 so they agree on which edges are "how was this reached?". (Earlier
// the clustering writer was deliberately fenced off on a narrower set; that fence
// was reversed once a clustering simulation showed adding supports/supersedes/
// resolves pulls supports-linked residue into its arc WITHOUT cross-arc over-merge.
// supports alone is ~half of all causal edges, so excluding it orphaned real
// members like a user's lived failure.) The pipeline's internal CONTEXT-BUILDING
// sets remain tuned independently — they shape extraction, not the causal thread.
export const CAUSAL_TRAVERSAL_RELS: ReadonlySet<string> = new Set([
  "prompted_by",   // consequence → trigger (primary causal coordinate)
  "based_on",      // conclusion → evidence
  "derived_from",  // derived → source (logical inference)
  "extends",       // specific → broader (mechanism elaboration)
  "supports",      // fact → hypothesis (evidential grounding)
  "supersedes",    // new → old (replacement — walk back to history)
  "superseded_by", // old → new (inverse)
  "resolves",      // answer → question
]);

// ─── The SPINE vs GROUNDING split (2026-07-07) ──────────────────────────────────
// CAUSAL_TRAVERSAL_RELS above answers "which edges connect a thread?" (membership /
// reachability — undirected, inclusive). But COMPOSING a thread into an ordered arc
// is a *directional* job, and not every causal edge is a narrative step. So the
// thread composer (walkThread / composeSign in tools/helpers.ts) reads two sub-sets:
//
//   SPINE — order-bearing "this LED TO that". Every member shares ONE direction
//   convention: source = the EFFECT (later), target = the CAUSE (earlier). Verified
//   against pass4.ts prompt (based_on {source: claim, target: evidence};
//   prompted_by {source: effect, target: cause}). So a single up/down walk orients
//   the whole thread correctly — no per-type direction map needed. `derived_from`
//   (derived ← source) and `resolves` (answer ← question) belong here: they ARE
//   narrative steps and share the source=EFFECT direction — the discriminator for
//   SPINE isn't "semantic vs not", it's "order-bearing with the spine direction".
export const SPINE_RELS: ReadonlySet<string> = new Set([
  "prompted_by",   // effect ← trigger
  "based_on",      // claim  ← evidence
  "extends",       // specific ← broader
  "supersedes",    // new    ← old
  "derived_from",  // derived ← source (logical inference — a narrative step)
  "resolves",      // answer  ← question (poses → answered — a narrative step)
]);

//   GROUNDING — the ONLY genuinely non-sequential causal edge: `supports` is a
//   many-to-one evidential fan-in (evidence → claim), the INVERSE direction of
//   based_on. Folding it into the ordered walk is what made evidence read
//   "backwards". It belongs on a node as a "backed by N" tag, never as a hop.
export const GROUNDING_RELS: ReadonlySet<string> = new Set([
  "supports",
]);
