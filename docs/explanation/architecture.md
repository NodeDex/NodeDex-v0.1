# Nodedex — How The Whole System Works

> ⚠ **Internals reference.** Block types, relations, pipeline shape, and TTL/quality_score mechanics are accurate. The "Agent protocol" section near the bottom (Rules 1-5: manual saves, anchor phrases, manual reflect trigger) is **superseded** by [agent.md](../../agent.md), the current agent protocol — read that for how the agent actually interacts with the graph. This file is kept for the system internals.

*Internal reference. The why behind every design decision, from first principles.*
*Updated April 2026 after live exploration of a running instance.*

---

## What the system actually is

A persistent, typed knowledge graph that an AI agent reads and writes across sessions.
Not a vector store. Not a chat log. A map of **what was decided, what failed, what is constrained, and why** — structured so an agent can navigate it deterministically without re-deriving anything.

The core loop:

```
Agent session happens
        ↓
POST /api/reflect/trigger  (agent calls this at end of turn)
        ↓
v2 pipeline runs (COMPREHEND → fill → JUSTIFY → INTEGRATE → chains)
        ↓
Blocks saved to graph
        ↓
Next agent session starts cold → reads graph → knows everything
```

---

## Block types — epistemic meaning

Each type answers a different question about what happened:

| Type | Question answered | TTL |
|---|---|---|
| `decision` | What was chosen, and why? | permanent |
| `dead_end` | What was tried/evaluated and abandoned, and why? | permanent |
| `constraint` | What is externally imposed and cannot be overridden? | permanent |
| `blueprint` | What is planned but not yet decided? | permanent |
| `question` | What is genuinely unresolved with no path forward? | project |
| `fact` | What was observed or measured that changed understanding? | project |
| `insight` | What was realized by combining multiple facts? | project |
| `task` | Who is doing what right now? | project |
| `entity` | What is this named thing and what role does it play? | project |
| `chain` | What is the causal arc of a cluster of connected blocks? | permanent |
| `project` | What is this project's scope? | permanent |

**Why these types and not others:**
The types are epistemic, not domain-specific. A dead_end in a clinical trial (protocol abandoned), a business pivot (model abandoned), or a software migration (approach abandoned) are all structurally identical. The type captures the *epistemic role* — not what domain it comes from.

**Dead ends are the highest-value blocks.** Before any agent suggests an approach, Rule 3 fires:
check dead ends first. A dead end with `unique.reason = "290ms write latency on clinical hardware"` stops an agent from re-proposing synchronous replication. No debate, no re-derivation.

---

## Session start — what an agent sees immediately

```bash
GET /api/session
```

Returns instantly:
- Total block count by type
- All project roots with essences
- Open tasks (with owners)
- Active constraints

```bash
GET /api/tree?depth=1
```

Project roots with their constraints surfaced at the top level. This gives the agent the
full project map in one call — no traversal needed to understand what exists.

From there, an agent navigates by label — not by search.

---

## Navigation: two modes

### Mode 1 — Deterministic (label-based)

The naming convention `{project}_{entity}_{type}_{concept}` is a file path.
When you know what you want, use label filters — no scoring, no variance:

```bash
# Rule 3: dead-end check before proposing anything
GET /api/blocks?label_prefix=forge_dead_end&q=jwt

# All constraints on a project
GET /api/blocks?type=constraint&project=helios

# What decisions exist?
GET /api/blocks?label_prefix=atlas_decision

# Read a specific block
GET /api/blocks/forge_decision_hs256-jwt-tokens
```

This is how Rule 3 dead-end checks work. Fully deterministic.
Label structure: `_` separates dimensions. `-` separates words within a concept.
Server rejects labels with 5+ `_`-separated segments.

### Mode 2 — Fuzzy recall (scored)

When exploring without a known label:

```bash
# Keyword + concept + 2-hop expansion, quality_score multiplied in
GET /api/recall-fast?q=jwt+authentication&limit=5

# Full semantic + keyword + per-field match breakdown (slower, needs embeddings)
GET /api/recall-smart?q=why+was+aws+api+gateway+rejected&limit=3
```

`recall-smart` shows exactly why each result matched:
```
match_reason: "label[aws→concept:...] | essence[aws, gateway, rejected] | concept[aws→aws-api-gateway]"
```

Use label navigation first. Fuzzy recall for exploration only.

---

## Relations — the graph edges

Every meaningful connection between blocks is a typed relation:

| Type | Meaning |
|---|---|
| `part_of` | Block belongs to a project root. **Required on every block.** Without this, the block is invisible in tree navigation and dead-end checks. |
| `triggered_by` | This block exists because that block happened. Causal predecessor. |
| `based_on` | This decision was justified by this fact or constraint. |
| `supersedes` | This block replaces an older one (same concept, new value). Old block stays as permanent history. |
| `extends` | This block adds detail to an existing block. Parent remains fully valid standalone. |
| `resolves` | This block answers a question block. |
| `implements` | This task block is doing the work described by a blueprint or decision. |

**Why `supersedes` keeps history:** When a decision changes, you want to know what it was before and why it changed. The old block stays, the new one points at it with `supersedes`. An agent sees the new block in recall but can traverse back to understand the history.

**Why `part_of` is non-negotiable:** Dead-end checks query by `label_prefix=project_dead_end`. Without a `part_of` relation to the project root, the block won't surface in that query. A dead end with no `part_of` is effectively invisible — it cannot protect against repeating past mistakes.

---

## Arc extraction — how turns become an arc

By default Nodedex runs in **arc mode** (`NODEDEX_ARC_EXTRACTION=1`, the shipped default). Instead
of extracting each turn in isolation, it **captures** turns cheaply and **extracts a whole arc at
once** — so a multi-turn thread (a bug hunt, a design decision) becomes one coherent set of blocks
with intact chains and supersession, not N fragmented per-turn extractions.

**Capture (per turn, no LLM).** Each `POST /api/reflect/trigger` stores the raw turn in
`conversation_turns` and marks it `pass01_done` — that's it, no extraction yet. (This is *lazy
capture*: the arc engine re-reads the raw transcript, so running passes per turn here would be pure
waste.) Send a monotonic `turn_number` per `agent_id` and the watermark below becomes exact.

**Triggers — what commits an arc.** Any of these runs the pipeline over the accumulated
`pass01_done` turns:

| Trigger | Fires when | Control |
|---|---|---|
| **agent / MCP** | the agent calls `workspace_extract_arc` at its own task boundary | the **quality path** — the agent knows where an arc ends |
| **auto (every-N)** | N turns have accumulated | `NODEDEX_ARC_AUTO_TURNS` (0 = off); **user-settable in TUI Settings**, applied live |
| **inactivity** | the conversation goes idle | `NODEDEX_ARC_INACTIVITY_ENABLED` |
| **api** | `POST /api/conversations/:agent_id/extract` | optional `start_turn`/`end_turn` range |
| **precompact** | the host is about to compact its context | host hook |

**Extract + watermark.** On a trigger, the engine reads the `pass01_done` turns, consolidates them
into one arc input, runs the reflect pipeline (below), writes the blocks with provenance, records a
`conversation_turn_ranges` row (`start/end_turn_number` = the **watermark**, plus `trigger_source`),
and flips the consumed turns to `extracted`. "Extracted = turn_number ≤ watermark", so the next
trigger only picks up what is new. A failed extract **fails clean** — turns stay `pass01_done` and
re-extractable, never silently lost.

> **Granularity matters.** A coherent arc extracts best as *one* unit: split it across triggers and
> the second half can read as a distinct sub-topic and fork its own (sub-)root (see INTEGRATE). So
> the agent firing `workspace_extract_arc` at a real task boundary is the highest-quality trigger;
> every-N and inactivity are safety nets.

---

## The reflect pipeline — how text becomes blocks

Runs over one input — a single turn, or (in **arc mode**, the default) a consolidated **arc** of
captured turns (see *Arc extraction* above). The engine is the **v2 "comprehend-and-structure"
pipeline** — it reads the input *holistically* and structures it, rather than atomizing and
reassembling it pass-by-pass. (A legacy v1 pass chain remains in-tree but is off and unreachable;
the stage names below are what actually runs and what the cost panel shows.)

```
COMPREHEND → [SELECTOR] → fill → JUSTIFY → [CROSS-LINK] → INTEGRATE → chains
```

Stages in `[brackets]` are flag-gated refinements (tunable per deployment); COMPREHEND, fill,
JUSTIFY and chains are the spine.

### COMPREHEND (+ SEAM 1)
**Sees:** the whole turn (user + agent), holistically.
**Job:** read the turn and emit typed blocks (`fact` / `decision` / `dead_end` / `insight` /
`constraint` / …) **grouped by topic-thread**, with the within-group causal links and verbatim
provenance for each block. One call — or per-group on a very large turn, to survive output
truncation. This is the comprehender: tuned for **recall** (miss nothing). SEAM 1 then validates
the structured result before anything downstream runs.

The backward-trace rule lives here: after a decision, ask "what does this replace?" — the
predecessor is a `dead_end` candidate even without explicit "failed/abandoned" language.

### SELECTOR — the worth-gate *(flag-gated)*
**Sees:** the comprehended candidates + the transcript.
**Job:** the **precision** half. Drop low-worth candidates *before* the per-block fill, so dropped
ones never pay downstream cost. It keeps a kept block's causal evidence (anchor-override), and if
the selector itself fails it **keeps everything** — a failed judge must never drop residue.
COMPREHEND maximizes recall; the SELECTOR adds precision — together they are the selective half
memory requires.

Worth guard: "was this invested in?" Committed resources = time, money, actual use, formal
evaluation. A casual mention or speculation is not investment.

### fill — `unique{}`
**Job:** fill each block's structured per-type `unique{}` fields from its verbatim source — the
focused step the holistic COMPREHEND can't reliably do for every block under load. Runs per-block
(bounded concurrency) or batched (N blocks per call), with a per-item fallback so a fill is never
lost.

### JUSTIFY
**Job:** repair grounded conclusions (`decision` / `hypothesis` / `insight`) that arrived without
their `based_on` wiring, so a conclusion keeps its re-openable WHY. Without it the chain step can't
reach the conclusion (no causal path) and the reasoning behind it is lost. Runs on the survivors;
a conclusion whose grounding is genuinely out-of-scope this turn is left unwired (never fabricated).

### CROSS-LINK *(flag-gated)*
**Job:** add the sparse causal links that cross *between* topic-threads — within-thread links
already come from COMPREHEND. Bounded output (just edges), so it can't run away; a no-op for a
single thread.

### INTEGRATE *(flag-gated recognizer)*
**Job:** graph-aware reconciliation — assign the canonical `{project}_{entity}_{type}_{concept}`
labels and decide where each new topic-cluster belongs in the existing graph (the only valid orphan
is a `project`). Off → blocks keep their as-extracted labels.

The **recognizer** judges each new cluster against existing roots *by meaning* — it reads the root
`essence`, not the label. It only **folds** a cluster into an existing root when the cluster has the
**same owner** AND names a specific **shared subject** (a shared *manner* — "both involve debugging"
— is not a subject). Otherwise it **forks** a new root: *a fork is the safe failure*, because
wrongly merging two distinct topics is hard to undo, while forking now and letting the
self-maintenance dedup loop merge later is reversible.

A forked cluster that is a **sub-topic** of an existing root is nested under it — a new root wired
`part_of` the parent (the *collection-member* / sub-root rule; this nesting is determined
structurally in code, not left to LLM judgment). `GET /api/roots/related` then reports the pair as
containment/dependency and names the parent. Net: a strong model tends to fold a related thread into
one root, a weaker one tends to fork a properly-subordinated sub-root — either way the relationship
is preserved and reachable.

### chains
**Job:** find causal clusters across the turn's blocks, name them, and write a `chain` block with
the `arc` (type sequence) + a one-sentence `chain_essence`. A block alone is a headline; its chain
is the story. The chain block gets `chain_id = its own id`; members are stamped with that
`chain_id` via server-side BFS and are findable via `?chain_id=blk_xxx`.

---

## Block anatomy — what a block actually contains

From a live block read (`forge_decision_hs256-jwt-tokens`):

```json
{
  "label":        "forge_decision_hs256-jwt-tokens",
  "type":         "decision",
  "essence":      "JWT access tokens signed with HS256 using a single shared secret...",
  "confidence":   0.8,
  "quality_score": 3,
  "ttl":          "permanent",
  "chain_id":     "010e275c-23b1-405f-8fea-f8a912f5abae",
  "flow_role":    null,
  "content": {
    "unique": {
      "choice":               "HS256 HMAC signing with shared secret",
      "reason":               "Simple to implement, single key to manage",
      "alternatives_rejected":"RS256 considered but deemed unnecessary complexity"
    }
  }
}
```

**`essence`** — one sentence, ≤120 chars. What is this and why does it matter.
The primary field agents read in recall results.

**`unique{}`** — structured fields per type. What agents read when they open the block.
Decision: `{choice, reason, alternatives_rejected}`.
Dead end: `{approach, reason, alternative}`.
Constraint: `{limit, reason, source}`.
Filled by the extraction pipeline (the `fill` stage). Never re-derived downstream.

**`quality_score` (0–6)** — structural completeness. Each criterion = +1:
essence is specific / type valid / unique{} ≥2 fields / has{} present / concepts ≥3 terms / ≥1 relation.
Recomputed when a relation is added. Used directly in recall ranking.

**`confidence` (0.0–1.0)** — vestigial epistemic trust. Stays at 0.8 for almost all blocks.
Rarely changes because `derived_from` propagation almost never fires (pipeline uses `triggered_by`,
`based_on`, not `derived_from`). Does protect permanent blocks from archival:
`ttl=permanent AND confidence≥0.8` = protected. Accepted design debt — not worth removing.

**`ttl`** — survival:
- `permanent` — decisions, dead_ends, constraints, blueprints. Never auto-archived.
- `project` — facts, insights, questions, tasks, entities. Archived when project closes.
- `session` — calculations, temporary lookups. Cleaned up after session ends.

**`flow_role`** — narrative role in a causal chain: `trigger | problem | cause | mechanism | solution | outcome`.
Set during extraction. Used when assembling chain arcs.

**`chain_id`** — UUID shared by all blocks in a causal cluster. Stamped server-side by BFS
after save. Not a relation — just a flat tag. Chain block has `chain_id = its own id`.

---

## TTL and archival

Blocks survive based on type + access:

| TTL | Survival rule |
|---|---|
| `permanent` + `confidence ≥ 0.8` | Protected — never archived |
| `permanent` + `confidence < 0.5` + zero access + 30 days | Archival risk |
| `project` | Archived when project closes |
| `session` | Cleaned up automatically |

**Important:** An unused block is not a low-value block. A constraint about a regulation
that hasn't been accessed in months is exactly what must survive — it's future-relevant
institutional memory. The whole point is that agents shouldn't re-derive constraints they
don't know exist yet. Permanent blocks are safe from this risk.

---

## Agent protocol (rules the agent must follow)

**Rule 1 — Coordinates before save**
Every block needs `triggered_by` pointing to the block that led to this realization.
Naming: `{project}_{entity}_{type}_{concept}`. 4 dimensions. Never 5.

**Rule 2 — Only decisions and dead ends (save manually)**
Everything else is saved by the pipeline. Manual saving only for decisions (user confirmed)
and dead ends (approach abandoned). Double-saving creates duplicates.

**Rule 3 — Check dead ends before suggesting**
```bash
GET /api/blocks?label_prefix={project}_dead_end&q={concept}
GET /api/blocks?type=constraint&project={project}
```
Suggesting something that already failed is the system's worst outcome.

**Rule 4 — Tasks: claim before working, declare at end of turn**
Claim: `workspace_task_next({ project: "X" })` — sets in_progress, returns context.
Declare: use anchor phrases so pipeline creates task blocks:
`Next task: <desc> | <label>` / `Task done: <label> | outcome: <X>`

**Rule 5 — Trigger reflect at end of every turn**
```bash
POST /api/reflect/trigger
{ "hint": "decision|dead_end|chain|discovery|state_change", "agent_response": "...", "user_message": "..." }
```

---

## Known gaps (April 2026)

| Gap | Impact |
|---|---|
| Task assignments not reliably saved | Person → task ownership lost. Both benchmarks miss N12. |
| Dead_end → decision causal links drawn inconsistently | Chain arcs fragmented — some pairs linked, some not |
| Question suppression sometimes too broad | Valid unresolved questions can be dropped if topically near a decision |
| Chain member traversal requires a second query | Chain block itself doesn't inline members — use `GET /api/blocks?chain_id=xxx` to list them |
| `unique{}` empty on blocks saved before April 2026 | Older blocks have content only in `essence`, not structured fields |

---

## Benchmark status

Two benchmarks test different properties:

**v11 (40/42, 95%)** — Real-world gaps: authority signals, hypothetical filtering,
PRD format, same-batch contradiction resolution.

**v12 (42/42, 100%)** — Domain-agnostic universality: clinical research, business strategy,
email thread format, task assignment, pure noise filtering.

All needle types (decision, dead_end, constraint, blueprint, question, fact) score reliably.
Consistent miss in v11: task assignment (N12).
