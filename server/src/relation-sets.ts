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
