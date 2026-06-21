# REST API Reference — Nodedex

> Ground truth from source code. Last verified: 2026-05-12.

---

## Quick Reference

```bash
# Orient
GET  /api/session                                        # block count, projects, tasks, agents
GET  /api/tree?depth=1                                   # project tree with constraints at top level

# Dead-end check (always before proposing an approach)
GET  /api/blocks?project=X&label_prefix=X_dead_end&q=Y  # exact structural filter — zero false positives
GET  /api/blocks?project=X&type=constraint               # constraint check

# Recall
GET  /api/recall-fast?q=...&limit=5&min_quality=3        # hybrid search (semantic + keyword + concept)
GET  /api/recall-fast?q=...&project=X&strict=1           # project-scoped search

# Navigation
GET  /api/blocks/:id/nav                                 # navigable view with causal relations
GET  /api/blocks/:id/chain                               # full causal chain, ordered by depth
GET  /api/chains/:chain_id                               # all blocks in a chain, cause-first

# Agent Injection
GET  /api/agent-inject?project=X                        # per-turn context (goals + dead ends + constraints + tasks)


# Pipeline
POST /api/reflect/trigger                                # trigger pipeline with hint
GET  /api/reflect/status                                 # queue depth + pause state
POST /api/reflect/pause                                  # pause pipeline
POST /api/reflect/resume                                 # resume pipeline

# Tasks
GET  /api/blocks?type=task&status=in_progress&project=X
GET  /api/blocks?type=task&status=open&project=X

# Relations
POST /api/relations                                      # wire a relation manually (any type accepted)
GET  /api/relations?source_id=<id>                       # all outgoing relations

# Graph health
GET  /api/health                                         # server + scheduler status
GET  /api/admin/graph-health                             # unlinked blocks
GET  /api/conflicts/near-duplicates                      # semantic near-duplicate pairs
```

---

## Session and Tree

### `GET /api/session`
Returns immediately:
- Total block count by type
- All project roots with essences
- Open tasks (with assignees)
- Active constraints

Use this at session start for fast orientation before any traversal.

### `GET /api/tree?depth=N`
Returns project hierarchy. `depth=1` gives project roots with their direct children and active constraints surfaced at the top level. No traversal required to understand what exists.

---

## Block Queries

### `GET /api/blocks`

Filters (combine freely):

| Parameter | Type | Description |
|---|---|---|
| `project` | string | Project root prefix |
| `label_prefix` | string | Label starts with (exact prefix match) |
| `type` | string | Block type |
| `status` | string | `open`, `in_progress`, `done`, `archived` |
| `q` | string | Keyword search within matching blocks |
| `chain_id` | uuid | All blocks in a chain |
| `min_quality` | 0–6 | Minimum quality score |
| `limit` | int | Max results (default 20) |

**Dead-end check pattern (Rule 3):**
```bash
GET /api/blocks?project=forge&label_prefix=forge_dead_end&q=jwt
```
This is exact structural filtering — it only returns blocks from the `forge` project with `dead_end` in the label. No false positives from other projects.

### `GET /api/blocks/:id`
Returns block at surface level. Add `?detail=content`, `?detail=relations`, or `?detail=full` for more.

### `GET /api/blocks/:id/nav`
Returns:
- Block itself
- `part_of` path up to project root
- All causal outgoing/incoming relations with neighbor essences

### `GET /api/blocks/:id/chain`
BFS traversal on `prompted_by`, `derived_from`, `based_on` — up 6 levels (ancestors) and down 4 levels (descendants). Returns flat ordered list with causal depth (`-N` = ancestor, `0` = focal, `+N` = descendant).

---

## Recall

### `GET /api/recall-fast`

Three-signal search: semantic similarity (embedding cosine) + keyword match + concept overlap. Applies freshness multiplier (recently accessed blocks score higher).

| Parameter | Description |
|---|---|
| `q` | Query string |
| `limit` | Max results (default 5) |
| `min_quality` | Minimum quality score filter |
| `project` | Restrict to project prefix |
| `strict=1` | Project-scoped only (no cross-project) |

Returns `match_types` on each result explaining why it surfaced.

### `GET /api/recall-smart`

Full semantic + keyword + per-field match breakdown. Slower — requires embeddings. Shows exact match reasoning:
```
match_reason: "label[jwt→concept:...] | essence[jwt, auth] | concept[auth_token→jwt]"
```

Use `recall-fast` first. Only escalate to `recall-smart` when you need to understand why something surfaced or didn't.

---

## Pipeline

### `POST /api/reflect/trigger`

Queues the 6-pass pipeline to run.

```json
{
  "hint": "decision",
  "agent_response": "...",
  "user_message": "..."
}
```

`hint` values: `decision` | `dead_end` | `chain` | `discovery` | `state_change`

The hint tells the pipeline which pass should prioritize. An automatic trigger (e.g. the server-side inactivity timer) fires without a hint (safety net) — an explicit trigger with a hint is the primary path.

### `GET /api/reflect/status`

Returns queue depth, current pass running, and pause state. Use for debugging when blocks aren't appearing.

---

## Relations

### `POST /api/relations`

```json
{
  "source_id": "blk_xxx",
  "target_id": "blk_yyy",
  "type": "prompted_by",
  "confidence": 0.9,
  "bidirectional": false
}
```

**Any relation type string is accepted** — the API does not filter by ALLOWED_RELS. This means relation types like `implements`, `constrained_by`, `affected_by`, and `depends_on` can be created manually even though the pipeline won't auto-create them.

### `POST /api/relations/:id/invalidate`

Stamps `valid_to` on a relation (bitemporal invalidation). The relation is not deleted — it records that it existed up to that timestamp. History is always preserved.

---

## Chains

### `GET /api/chains/:chain_id`

Returns all blocks sharing a `chain_id` UUID, sorted cause-first to outcome-last. This is a direct field query — very fast.

Different from `GET /api/blocks/:id/chain` (which does BFS traversal around a specific block).

---

## Agent Injection (Per-Turn Context)

### `GET /api/agent-inject`

Returns structural context for injection into an agent's prompt each turn. Combines goals (if a goals source is configured), dead ends, constraints, and open tasks into a single payload. No semantic recall — agents call `recall-fast` or traverse the graph separately when they need topical context.

Designed for:
- The `/api/chat` proxy (internally, before forwarding to LLM)
- "Two-line mode" agents (direct HTTP call each turn)
- Any agent framework that wants Nodedex context without hooks

| Parameter | Type | Description |
|---|---|---|
| `project` | string | Project label — scopes dead ends, constraints, tasks |
| `agent_id` | string | Agent identifier for session tracking |
| `format` | string | `"text"` (default) or `"json"` |

**Text format response** (default):
```json
{
  "context": "═══ GOALS ═══\nVISION: ...\n═══ DEAD ENDS ═══\n...\n═══ REMINDERS ═══\n...",
  "block_ids": ["blk_xxx", ...],
  "project": "forge",
  "char_count": 1234
}
```

**JSON format response** (`format=json`):
```json
{
  "goals": { "vision": "...", "macro": "...", "micro": "...", "task": "..." },
  "dead_ends": [{ "label": "forge_dead_end_redis", "essence": "...", "unique": { "reason": "..." } }],
  "constraints": [{ "label": "forge_constraint_hipaa", "essence": "..." }],
  "open_tasks": [{ "label": "forge_task_setup-db", "essence": "..." }],
  "block_ids": ["blk_xxx", ...],
  "project": "forge"
}
```

---

# Health and Maintenance

### `GET /api/health`

Server status + scheduler last-run times (GC, embedding, enrichment).

### `GET /api/admin/graph-health`

Lists blocks with no `part_of` relation (orphan blocks) that are invisible to tree navigation and dead-end checks.

### `GET /api/conflicts/near-duplicates`

Semantic near-duplicate pairs flagged at save time (cosine > 0.88). Use to find and resolve duplicate blocks.
