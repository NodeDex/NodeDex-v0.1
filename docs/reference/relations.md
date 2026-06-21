# Relations Reference — Nodedex

> Ground truth from source code. Last verified: 2026-05-24.
>
> Verified against: live reflect run (41 blocks, 15 edges) + code grep (`ALLOWED_RELS`, `CHAIN_RELS` in pipeline.ts; bidirectional pair table in database.ts:471).

---

## Two Separate Structures

The graph has two completely independent structures that coexist on every block:

**1. Containment (`part_of`)** — the filing cabinet. Where does this block live?

**2. Causal chain (`prompted_by`, `based_on`, `extends`, etc.)** — the reasoning thread. How did one thing lead to another?

Example — same four blocks, both structures active simultaneously:

```
CAUSAL CHAIN (vertical — what led to what):
  atlas_fact_json-no-schema-enforcement
          ↓  prompted_by
  atlas_dead_end_json-serialization
          ↓  prompted_by
  atlas_decision_avro-serialization
          ↓  prompted_by
  atlas_task_marcus-schema-registry

CONTAINMENT (horizontal — where each block lives):
  atlas_fact_json-no-schema-enforcement  ──part_of──▶  atlas
  atlas_dead_end_json-serialization      ──part_of──▶  atlas
  atlas_decision_avro-serialization      ──part_of──▶  atlas
  atlas_task_marcus-schema-registry      ──part_of──▶  atlas
```

`part_of` says nothing about causation. Causal relations say nothing about containment.

---

## All Relation Types

| Relation | Direction | What it carries | Created by |
|---|---|---|---|
| `part_of` | child → parent | Structural containment — block belongs to project | Pipeline Pass 3 (mandatory on every block) |
| `prompted_by` | consequence → trigger | Cognitive causation — event/failure that sparked this | Pipeline Pass 3/4; auto from `triggered_by` in save context |
| `based_on` | conclusion → evidence | Evidential grounding — fact/constraint that justified this | Pipeline Pass 2/3; required on every `decision` |
| `extends` | specific → broader | Mechanism elaboration — "this is how that works" | Pipeline Pass 3/4 |
| `supersedes` | new → old | Replacement — same concept, new value. Old block stays. | Pipeline Pass 3/4 or agent |
| `superseded_by` | old → new | Inverse of `supersedes` | Auto-created with `supersedes` |
| `derived_from` | derived → source | Logical inference — "reasoned from this" | `workspace_derive` |
| `contradicts` | A ↔ B | Conflict signal — these blocks disagree | `workspace_update(challenges_block)` or pipeline |
| `related_to` | A ↔ B | Loose association | Pipeline or agent |
| `resolves` | block → question | This block answers an open question | Pipeline Pass 3/4 |
| `supports` | fact → hypothesis | This fact provides evidence for a hypothesis | Pipeline |
| `affects` | agent → patient | Cross-project causal impact | Pipeline Pass 4 or agent |
| `constrained_by` | task → constraint | Auto-linked at task creation to ALL active constraints | `workspace_task_create` (auto) |
| `affected_by` | task → decision | Auto-linked at task creation to semantically similar decisions | `workspace_task_create` (auto) |
| `depends_on` | task → task | Hard dependency — target must complete first | Agent or pipeline |
| `implements` | task → decision/blueprint | This task executes that plan | Agent (manual only) |
| `enables` | enabler → enabled | Makes this possible | Agent (manual only) |
| `describes` | doc → subject | Documentation link | Agent (manual only) |

**Pipeline ALLOWED_RELS** — relations the pipeline will auto-create:
`contradicts`, `based_on`, `related_to`, `resolves`, `supports`, `prompted_by`, `extends`, `supersedes`, `superseded_by`, `derived_from`, `affects`

**Manual-only** (pipeline won't auto-create, but `POST /api/relations` accepts any type):
`implements`, `enables`, `describes`, `constrained_by`, `affected_by`, `depends_on`

**Auto-wired outside pipeline** (always created regardless of ALLOWED_RELS):
- `part_of` — every block
- `prompted_by` — from `triggered_by[]` array on each block
- `based_on` — from `based_on[]` array on each block
- `extends` — from `extends_item` resolution server-side
- `constrained_by` + `affected_by` — from `workspace_task_create`

---

## Key Relations in Detail

### `part_of`

**Direction**: child holds the relation, points UP to parent.
```
atlas_decision_avro  ──part_of──▶  atlas
(source = child)                   (target = parent)
```

**Non-negotiable rule:** Every non-root block MUST have `part_of` pointing to its project root. Without it the block is invisible to tree navigation AND dead-end checks. A dead end with no `part_of` cannot protect against repeating past mistakes.

Top-level project roots have NO `part_of`. Nested project roots point to their parent root.

**Three-level example:**
```
crm                       ← top root, no part_of
 └── acme-corp            ← nested root, part_of ──▶ crm
      └── acme-corp_fact  ← block, part_of ──▶ acme-corp
```

### `prompted_by`

The primary causal coordinate. "I exist because that happened."

In the agent protocol ([agent.md](../../agent.md)), `triggered_by` is used as the save context field — this gets translated to `prompted_by` in the database. `triggered_by` is NOT a stored relation type; it is an alias that pipeline Pass 3 translates to `prompted_by` (line 944 of pipeline.ts).

### `based_on`

Required on every `decision`. "This choice was justified by this fact/constraint."

### `supersedes` / `superseded_by`

When a decision changes, the old block stays as permanent history. The new block points at it with `supersedes`. An agent sees the new block in recall but can traverse back to understand the history.

> **2026-05-24 — auto-inverse gap.** `database.ts:471-472` defines the bidirectional pair (`supersedes ↔ superseded_by`), but the pipeline writes `supersedes` rows with `bidirectional: false`, so the inverse row is **not** auto-created. Live audit: 1 `supersedes` edge, 0 `superseded_by` edges. To recover the inverse view today, query incoming `supersedes` on the older block. Fix is small (flip `bidirectional: true` on the writer, or explicitly insert the inverse row) but not yet applied.

### `contradicts`

Symmetric conflict — both blocks hold conflicting information. Created by:
- `workspace_update(challenges_block=true)` — drops challenged block's confidence by 0.05
- `workspace_challenge` (Pro) — drops challenged block's confidence by 0.4
- Pipeline when it detects contradiction

### `constrained_by` + `affected_by`

Auto-created by `workspace_task_create`:
- `constrained_by` — links every new task to ALL active constraints automatically
- `affected_by` — links every new task to semantically similar decisions (cosine > 0.65)

The agent picking up a task via `workspace_task_next` always sees what limits apply and what decisions are relevant.

---

## Chain IDs — Two Separate Things

### 1. `chain_id` field on blocks

A UUID stamped on blocks by `stampFlowRolesAndChains()` after Pass 5 completes.

**How it works:**
- BFS over `prompted_by`, `based_on`, `extends` finds connected block clusters
- Every block in the same cluster gets the same UUID in its `chain_id` field
- Standalone blocks (no causal connections) get `chain_id = null`
- Cross-batch stitching: if a new block connects to an existing block that already has a `chain_id`, the new block inherits it (merging clusters if needed). Chains grow across sessions.

**Query:** `GET /api/chains/:chain_id` — returns all blocks sharing that UUID, sorted cause-first, outcome-last.

### 2. `chain` block type (NOT `reasoning_chain` — those are different types)

An explicit block created by Pass 5 that summarises the causal arc as a single record. **Distinct from `reasoning_chain`**, which is a separate type for synthesized conclusions across recalled blocks (see `block-types.md`).

**Label format:** `{project}_chain_{capability-area}`

**`unique{}` fields** (verified 2026-05-24 from live reflect runs):

| Field | What it holds |
|---|---|
| `arc` | Type sequence — e.g. `"fact → dead_end → decision"` |
| `conclusion` | The capability/outcome the arc resolved (≤80 chars) |

**`essence`** carries the compressed story (≤140 chars).

> **Earlier versions of this doc claimed a `members[]` field on the chain block. That is wrong.** Members are tracked via `chain_id` on each member block (the chain block's own `id` IS the chain_id). See `block-types.md` for retrieval — use `GET /api/chains/<chain-id>`, NOT the block-level `/chain` endpoint.

**Example:**
```json
{
  "label":   "atlas_event-streaming",
  "type":    "chain",
  "essence": "RabbitMQ lacked replay; Kafka adopted; Marcus assigned schema registry integration.",
  "content": {
    "unique": {
      "arc":        "dead_end → decision → task",
      "conclusion": "Kafka event streaming"
    }
  }
}

// Members retrieved separately:
GET /api/chains/<this-chain-block-id>
// → returns: [dead_end_rabbitmq-no-replay, decision_kafka-adopted, task_marcus-schema-registry]
```

**When a chain is valid (Pass 5 rules):**
- ≥ 2 blocks connected by causal relations
- Ends in a committed conclusion: `decision`, `constraint`, `insight`, `reasoning_chain`, or `dead_end`
- NOT valid: single facts, unresolved blueprints, tasks alone, open questions

### Two chain endpoints — different mechanisms

| Endpoint | Mechanism | Use |
|---|---|---|
| `GET /api/chains/:chain_id` | Direct field query (no traversal) | All blocks in the same cluster |
| `GET /api/blocks/:id/chain` | BFS on `prompted_by`, `derived_from`, `based_on` (±6 levels) | Causal ancestry around one block |

---

## `flow_role` — REMOVED from pipeline (2026-05-18)

> **2026-05-24 — historical only.** `flow_role` was a block-level narrative tag (`trigger | cause | problem | mechanism | solution | outcome`). It was **removed from the pipeline path** in commits `c2412a6` + `a92c44f` on 2026-05-18. Pass 2/3/5 no longer set it. `deriveFlowRole()` and `applyFlowRoleOverrides()` were deleted from `pipeline.ts`. The DB column stays. **Pipeline-generated blocks have `flow_role = null`.**

**What still writes flow_role:**
- `workspace_derive` tool — sets `outcome` on derived block, `cause` on inputs (`tools/derive.ts:126-129`).
- `workspace_remember` tool — accepts agent-provided value (`tools/core.ts:106, 277`).
- Direct `PATCH /api/blocks/:id` — validates against the enum at `routes/blocks.ts:362`.

**UI replacement:** chain display order is computed at render time from `prompted_by` edges (Kahn's toposort in `computeChainPositions()`). Dot colors come from block type, not flow_role. Connector verbs are type-pair based.

**Why removed:** flow_role had dual-duty — semantic label AND UI sort key. The model assigned it stochastically (same block got different values across runs), and three sites in pipeline.ts forcefully overwrote it. Separating sort (from graph topology) and semantics (from type) made both deterministic.

**Historical enum values** (still accepted by `workspace_remember` and `derive`):

| Value | Meaning | Typical block type |
|---|---|---|
| `trigger` | External event that started the discussion | event, fact |
| `cause` | Blocker or failure that forced a pivot | dead_end |
| `problem` | External obstacle or constraint | constraint |
| `mechanism` | How something works; supporting observation | fact, process |
| `solution` | Decision or plan resolving the cause/problem | decision, blueprint |
| `outcome` | Achieved result; confirmed metric | decision, fact |

---

## How Endpoints Use Relations

| Endpoint | Relations traversed | Purpose |
|---|---|---|
| `GET /api/tree` | `part_of` only (upward) | Organizational structure |
| `GET /api/blocks/:id/nav` | `part_of` (up to root) + all causal relations | Block context: where it lives + neighbors |
| `GET /api/blocks/:id/chain` | BFS on `prompted_by`, `derived_from`, `based_on` | Full causal ancestry/descendants |
| `GET /api/chains/:chain_id` | Direct field query (no traversal) | All blocks in the same cluster |
| `GET /api/graph` | All active relations | Full graph visualization |

---

## Domain Label Patterns

The naming convention `{project}_{entity}_{type}_{concept}` maps to different patterns by agent type:

| Agent type | Root = | Entity dimension = | Dominant block types |
|---|---|---|---|
| Software project | product name (`atlas`) | sub-component (`api`, `auth`) | decision, dead_end, constraint |
| Research / study | study name (`meridian`) | layer (`data`, `protocol`) | decision, hypothesis, fact, constraint |
| Business initiative | initiative name (`compass`) | _(usually omitted)_ | decision, dead_end, blueprint |
| CRM / client mgmt | system name (`crm`) | client name (`acme-corp`) | fact, preference, decision |
| Events / HR | org unit (`people-ops`) | event name (`jamie-workiversary`) | fact, task, decision |
| Operations / infra | system name (`infra`) | service name (`postgres`) | fact, constraint, decision |
