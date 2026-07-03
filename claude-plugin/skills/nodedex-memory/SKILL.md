---
name: nodedex-memory
description: Consult the project's NodeDex memory graph (the workspace_* MCP tools) before proposing an approach or design decision, when starting work on an existing project, when the user asks what was decided/tried/why, or when an approach being attempted feels like it may have failed before. NodeDex holds decisions with reasoning, permanent dead-ends, constraints, and causal chains, extracted automatically from past conversations.
---

# NodeDex memory — the five moves

Read-only for you: a background pipeline captures the conversation automatically — do
not `workspace_remember` in normal work. Tools missing? Say so once and continue;
never invent remembered content.

**Before proposing any approach** — the reflex this skill exists for:
`workspace_list(project, type="dead_end")` and `type="constraint"`.
Filter by TYPE, never label prefix. If a dead-end matches your idea: cite it, tell the
user ("tried, abandoned because …"), propose differently — or say what changed.

**New session on an existing project:**
`workspace_tree` — the project roots with one-line descriptions (lean by design).
Pick the relevant root, then run the dead-end + constraint check above on it;
open specific items with `workspace_get(label, "relations")`.

**"Why did we decide X?":**
`workspace_get(label, "relations")` → walk its chain: evidence → alternatives that
lost → decision → consequences. Quote the blocks, not a paraphrase.

**Stale check:** any block carrying `superseded_by` is stale — read the superseding
block for current truth; never present the old one as current.

**No label known:** `workspace_search(query)` — hits show their root + match reasons.
A weak-results note on the response means the graph has nothing on this; say that
plainly instead of treating the nearest blocks as an answer.

**Trust rule:** blocks carry `source_excerpt` (verbatim transcript evidence) — check it
for load-bearing claims. If the graph conflicts with code you can verify directly,
the code wins; flag the discrepancy.
