# MCP Tools Reference — Nodedex

> Source-verified 2026-06-17 against the active registrations in `src/tools/*`.
> **38 tools registered** (derive 2 · core 10 · tasks 3 · projects 4 · system 19).
> NOTE: the agent's MCP surface is READ-ONLY by default — only 10 tools register (get,
> search, filter, tree, list, stats, history, find_skill, onboard, install_capture). The write/admin/maintenance
> tools stay in code (REST-callable for pipeline/workers) but are hidden unless
> `NODEDEX_EXPOSE_WRITE_TOOLS=on` (and `NODEDEX_EXPOSE_TASKS=on` for tasks).
> Note: the boot-log "Tools:" string in `server.ts` had drifted — it listed a phantom
> `workspace_file_index` (archived) AND omitted the real `workspace_extract_arc`; both
> corrected. (The string is hardcoded — a future cleanup should generate it from the
> live registrations so it can't drift again.)

---

## At-a-glance — what's actually in use

The **pipeline writes** facts/constraints/insights/entities automatically, and **background
workers** handle maintenance — so the agent's *default* working set is small (mostly READ).
Most write/maintenance tools are **edge-case** (fix a graph error) or **worker-run**, not the
agent's per-turn path. Status: **[default]** primary path · **[edge]** manual write/fix ·
**[maint]** usually a worker/timer · **[multi]** multi-agent · **[schema]** rare vocab change.

| Group | Tool | For / when | Status |
|---|---|---|---|
| **Setup** | `workspace_onboard` | ONCE on first connect — offer to persist the reflexes into the agent's own config (consent-gated) | [default] |
| | `workspace_install_capture` | ONCE per host — deploy the non-intrusive tee capture adapter so turns feed the pipeline (consent-gated; agent self-deploys) | [default] |
| **Read** | `workspace_tree` | ORIENT/browse — roots + one-line descriptions + block counts (lean; empty-safe) | [default] |
| | `workspace_list` | structured typed list within a project (exhaustive dead-end check); each headline carries `on_chain` | [default] |
| | `workspace_get` | open a block by label/id (surface→full) — you know the label | [default] |
| | `workspace_search` | 3-signal search (semantic+keyword+concept; **embeds the query**) — you DON'T know the label | [default] |
| | `workspace_filter` | COLD-START orient — concept terms → ranked ROOT suggestions (concepts[]+label, not surface) — no anchor yet | [default] |
| | `workspace_stats` | block counts by type/status — orient / health | [default] |
| | `workspace_find_skill` | find a stored procedure/approach — before solving, reuse | [default] |
| | `workspace_history` | audit trail of changes — debugging pipeline output | [edge] |
| **Write** | `workspace_remember` | manual save of ONE block — edge (pipeline extracts the rest) | [edge] |
| | `workspace_batch_save` | save N blocks in one call — 3+ related at once | [edge] |
| | `workspace_update` | edit an existing block's fields — fix/enrich | [edge] |
| | `workspace_forget` | archive (soft-delete, Rule 2) — retire a block | [edge] |
| | `workspace_derive` | record a reasoning chain → an **insight** block — traceable synthesis | [edge] |
| | `workspace_promote` | temp block → permanent — keep a valuable scratch | [edge] |
| **Extract** | `workspace_extract_arc` | **trigger** arc extraction over recent turns — the MCP-native way to extract; host/agent calls it at an arc boundary | [default] |
| **Tasks** | `workspace_task_create` | create a task (auto-links constraints/decisions) | [default] |
| | `workspace_task_next` | claim the next task (atomic) | [default/multi] |
| | `workspace_task_update` | update task status | [default] |
| **Projects** | `workspace_project_create` | new project root | [edge] |
| | `workspace_project_log` | journal entry | [edge] |
| | `workspace_project_status` | project snapshot | [default] |
| | `workspace_project_resume` | full project briefing (`since=`) — session start | [default] |
| **Maint/heal** | `workspace_gc` | archive expired-TTL blocks (6h timer) | [maint] |
| | `workspace_stale` | find stale blocks | [maint] |
| | `workspace_gaps` | gap audit: open Qs / conflicts / missing links (1h timer) | [maint] |
| | `workspace_reembed` | backfill missing embeddings (10m timer) | [maint] |
| | `workspace_enrich` | upgrade concept tags via Gemini (5m timer) | [maint] |
| | `workspace_review` | Gemini review of a thin block (quality<3) | [edge] |
| | `workspace_review_pending` | approve inferred relations | [maint] |
| | `workspace_resolve` | resolve a `contradicts` pair | [edge] |
| | `workspace_resolve_conflict` | resolve a near-dup (conflicts table) | [edge] |
| | `workspace_challenge` | dispute another agent's block | [multi] |
| **Schema/IO** | `workspace_create_type` | new custom block type | [schema] |
| | `workspace_create_relation_type` | new custom relation type | [schema] |
| | `workspace_artifact_save` | save a produced file (code/doc/data) | [default] |
| | `workspace_export` | export blocks+relations (json/md/json-ld) — backup/interop | [edge] |

---

## How to read this (detailed sections below)

Each tool has:
- **What it is** — what it actually does
- **What it's for** — why it exists
- **When to use it** — when to reach for it

**v2 framing (current):** the pipeline extracts **all** residue from your conversation automatically — facts, constraints, **decisions, dead-ends**, insights, entities, chains (COMPREHEND + JUSTIFY ground them). So in the normal path you do **not** manually save anything. The manual **write** tools exist for **edge cases** — fixing a graph error, seeding something the pipeline can't see from the text, or multi-agent coordination. *(The older "manually save decisions and dead-ends" guidance was v1, before the pipeline extracted stance types — it no longer holds.)*

---

## Core Tools

### `workspace_remember`

**What it is:** Saves a new block to the graph. Checks for duplicate labels and near-duplicate content (cosine > 0.88) before saving. Auto-extracts keyword concepts if none provided. Warns if `triggered_by` is missing (no causal chain) or if the label has no project prefix (orphan block).

**What it's for:** The manual save **escape hatch**. In v2 the pipeline extracts decisions, dead-ends, facts, constraints, insights, entities and chains from your conversation automatically — so this is **not** the normal way knowledge enters the graph. It's for the cases the pipeline can't cover.

**When to use it:** Edge cases only — (a) **fixing a graph error** (a block the pipeline got wrong or missed that you need now), (b) **seeding** a block whose meaning isn't expressible in the conversation text, or (c) **multi-agent coordination** (one agent writing for another). If you include it, add `save_context.triggered_by` (so it joins a causal chain) and link it to a project. **Do not** call it "after every decision" — that duplicates what the pipeline already extracts.

**What NOT to use it for:** The normal flow. The pipeline handles facts, constraints, decisions, dead-ends, insights, entities — manual saves of those create duplicates the dedup layer then has to clean up.

---

### `workspace_onboard`

**What it is:** The persistent UPGRADE over the MCP `instructions` field. Returns a 4-step contract + the protocol as a marked, removable block (`protocol_block`). The agent: (1) checks whether it *can* persist standing instructions (file-write tool + a config it reads each session, e.g. a rules or system-prompt file); (2) if so, explains the reason to the user and asks permission; (3) on yes, writes `protocol_block` verbatim (replace-in-place via the `nodedex:protocol` markers, never duplicate); (4) if it can't persist or the user declines, does nothing — the session `instructions` field still applies.

**What it's for:** Closing the gap that the `instructions` field is only *advisory* (a host may not surface it; the agent may skip it). On a capable host this writes Nodedex's two reflexes (dead-end check before proposing; traverse-don't-search) into the agent's *own* standing config so they're reliably followed and survive across sessions. The server can't reach the host's config — the agent does the write; the server supplies the content + the consent/scope contract. Source of truth: `src/agent-protocol.ts` (shared with the `instructions` field, so they can't drift).

**When to use it:** ONCE, on first connect in a project. Consent-gated and content-scoped — it only ever offers to add the Nodedex protocol, shown to the user verbatim.

---

### `workspace_install_capture`

**What it is:** The host-side capture deployer. The MCP server is **passive** — it sees only tool-call args + its own responses, never the agent's natural-language output — so it can't capture turns itself; capture must be **pushed by the host**. This tool returns the canonical adapter source (`adapter_source`, read from `adapters/nodedex-capture.mjs` so it never drifts), three wiring snippets, the field-config reference, and a 4-step consent-gated deploy contract. The agent writes the file + wires the one-liner into its own post-turn seam (the server can't reach the host's filesystem — same model as `workspace_onboard`).

**What it's for:** Feeding the write side. Without capture nothing is ever stored, so the read side (traverse/retrieve) has nothing to surface. The adapter is a **non-intrusive tee**: it sends a *copy* of `{user_message, agent_response, reasoning}` to `POST /api/reflect/trigger`, **fire-and-forget, out of the agent's LLM path** — the agent's own model call is never touched or slowed (this is the chosen design over the in-path `chat-proxy`, which the user rejected as intrusive). The server does debounce / dedup / pause-gating / async extraction, so the adapter stays dumb. **Configurable** which fields are captured via env (`NODEDEX_CAPTURE_RESPONSE` / `_USER` / `_REASONING`, default all on) or a per-call `capture` override; `response` is the substrate (off ⇒ nothing is sent). Optional `NODEDEX_CAPTURE_BUFFER` buffers to `~/.nodedex/capture-buffer.jsonl` when the server is down, flushing on next success.

**When to use it:** ONCE per host during setup, after the user agrees. It deploys capture for any MCP host/SDK that has a post-turn seam. See [how-to/capture-adapter.md](../how-to/capture-adapter.md).

---

### `workspace_get`

**What it is:** Reads a block at one of four detail levels: `surface` (id + label + essence + concepts), `content` (+ unique/has fields), `relations` (+ outgoing/incoming links), `full` (everything including metadata). Default is `surface`. Detects stale derivations — warns if input blocks were updated after a derived block was created.

**What it's for:** Reading graph state. At `relations`/`full` the result folds in two fields:
- **`chains[]`** — the named Pass-5 causal arc(s) this block belongs to (label, essence, arc, conclusion, ordered members), read via `member_of` so a hinge block returns ALL its chains, not the lossy `chain_id` column.
- **`linked_chains[]`** — every OTHER chain reachable by a causal PATH from those chains (the connected component), each with `distance` (chain-hops; 1 = directly bridged) and the bridging `via` relation, **distance-ranked**. This is "the whole linked story back to this block" — NOT the whole root (unrelated islands are excluded), NOT just 1 hop (a consequence 2 chains away still surfaces). It's the "memory changes a decision" signal: anchor on a fix, see the problem it caused. Walked over the CHAIN graph (not blocks → no flood); capped (`LINKED_CHAINS_CAP`) for scale, deeper reached by navigating (each linked chain is a get-able anchor).

Server-side and portable (any MCP host). "Surface the chain and its linked path, not the bare block."

**When to use it:** When you need a specific block you already know the label or ID of. Start with `surface`; use `relations` to navigate — it returns the block's links AND the causal chain it sits on.

---

### `workspace_search`

**What it is:** Three-signal search: semantic similarity (embedding cosine), keyword match, and concept overlap. Applies a freshness multiplier and a precision penalty (blocks recalled but never used get a small penalty). Returns `match_types` showing why each result surfaced.

**What it's for:** Finding blocks when you don't know the label. The concept overlap signal enables cross-domain retrieval — a query about "flow control" can surface rate-limiting blocks tagged `backpressure`.

**When to use it:** When you don't know the exact label. For dead-end checks, use the REST endpoint (`GET /api/blocks?label_prefix=<project>_dead_end&q=<concept>`) — it's exact, never cross-project, and cheaper.

---

### `workspace_filter`

**What it is:** The COLD-START orientation filter. Takes first-principle concept terms (`["latency","n+1-query"]`) and returns ranked project-ROOT suggestions, each with its pre-made description (the DESCRIBER's root `essence`) and the specific blocks that matched (entry points). Matches over `concepts[]` (the abstract tag net, `conceptSearch`) + the strict label's own segments — deliberately NOT a surface scan of `essence`/`content`. Backed by `filterRootsByConcepts` (tools/helpers.ts).

**What it's for:** Finding *which root* is relevant when you have no anchor yet — the "amnesia move": distil current context into concept terms, see which roots light up, open one to anchor. Complements `workspace_search` (block-level fuzzy) and `workspace_get` (you already know the label).

**When to use it:** First move on a cold start, before you know any label. Enter the named things your task is ABOUT (technologies, mechanisms, failure-modes, domain nouns); NOT generic words ("fix","issue") or sentences. Results are SUGGESTIONS — open one with `workspace_get(label, "relations")` to anchor (its chain returns with it). Scales flat with root count (you filter, never enumerate).

---

### `workspace_update`

**What it is:** Edits an existing block's fields. Merges `unique` and `has` fields with existing content (doesn't replace). Regenerates embedding if essence or content changes. Has a `challenges_block` param — if set, creates a `contradicts` relation and lowers the challenged block's confidence by 0.05. All changes logged to history.

**What it's for:** Correcting or enriching a block after it's saved. The pipeline doesn't always get fields right.

**When to use it:** When a block has wrong or missing fields. When you want to record that new information contradicts an existing block.

---

### `workspace_forget`

**What it is:** Archives a block — sets status to `archived`. Block stays in the database and history. Hidden from recall and tree navigation only.

**What it's for:** Removing noise without destroying history. Blocks are never deleted — only archived.

**When to use it:** When a block is a duplicate, stale, or no longer relevant. Not for anything that might need later reference — archived blocks can be retrieved but won't surface in normal search.

---

### `workspace_batch_save`

**What it is:** Saves multiple blocks in one call. Same schema as `workspace_remember` per block. Optional `project_id` links all blocks to a project via `part_of`.

**What it's for:** Reducing round-trips when saving 3+ related blocks. The pipeline uses this internally.

**When to use it:** Rarely — the pipeline handles batch saving. If manually saving multiple related blocks in one turn, use this instead of multiple `workspace_remember` calls.

---

### `workspace_history`

**What it is:** Returns the audit trail of changes to a block or the whole workspace. Filters by block, timestamp, or agent. Excludes embedding changes. Every save, update, archive, and challenge is logged.

**What it's for:** Auditing. "What changed in this block?" "What did Gemini save last turn?" "What happened since I last ran?"

**When to use it:** When debugging pipeline output or tracking changes between sessions. Low frequency.

---

## Derive Tools

### `workspace_derive`

**What it is:** Records a reasoning chain the agent already performed. Takes input block IDs + the logic used + the conclusion reached. Creates an **`insight`** block (the `reasoning_chain` type was collapsed into `insight` on 2026-06-15) with `derived_from` relations to all input blocks, and assigns a shared `chain_id` to the derived block and its inputs so the synthesis joins their causal thread. *(`flow_role` was removed 2026-05-18 — it is always null now; causal ordering is computed from the edges, not a stored role.)*

Auto-inherits concepts from input blocks. Default TTL is `permanent` unless `promote: false` is passed (in which case `session`).

**What it's for:** Making synthesis traceable. Saves the record of which blocks were combined, what logic connected them, what conclusion they produced. A future agent sees not just the conclusion but how it was reached.

**When to use it:** After reasoning over multiple retrieved blocks to reach a conclusion that isn't obvious from any single block. The conclusion must come from combining things — if it's just a single block restated, use `workspace_update` or let Gemini save it as a fact.

**What NOT to use it for:** Single-block observations. Those are facts — Gemini saves them.

---

### `workspace_promote`

**What it is:** Upgrades a temporary block (any non-`permanent` TTL) to `permanent`. Can also rename the label or change the type at promotion time. Generates an embedding if one is missing.

**What it's for:** The TTL pattern for reasoning. Create a scratch block with `ttl: "session"`. If the reasoning turns out worth keeping, `workspace_promote` makes it permanent before the session ends.

**When to use it:** When a temp block produced useful insight you want in the permanent graph.

---

## Extraction Trigger

### `workspace_extract_arc`

**What it is:** Triggers **arc extraction** over a range of an agent's conversation turns. Reads the `pass01_done` turns, consolidates them into one arc input, runs Pass 2-5 (the write pipeline), writes the blocks with provenance, and flips the turns to `extracted`. Defaults to ALL pass01_done turns if no range given; `re_extract: true` marks it as an intentional re-extraction. Requires `NODEDEX_ARC_EXTRACTION=1` (so per-turn capture populated the turns) — otherwise returns `no_turns`.

**What it's for:** The **MCP-native way to trigger extraction**. This tool *is* how the host/agent says "extract the recent conversation now." (Capture and triggering are the host-specific bits; this tool covers the trigger. A server-side inactivity timer can also fire extraction automatically.)

**When to use it:** At a natural arc boundary — a problem solved, a decision reached, end of a work session — to fold the recent turns into the graph. Call it deliberately at the boundary, or rely on the server-side inactivity timer.

---

## Project Tools

### `workspace_project_create`

**What it is:** Creates a new project root block and initializes a project log.

**What it's for:** Every block must belong to a project via `part_of`. Before any blocks can be saved to a new domain, the project root must exist.

**When to use it:** When starting work on a genuinely new domain. Use this to create a properly named project before the conversation starts (the pipeline auto-creates orphan projects with generic labels).

---

### `workspace_project_log`

**What it is:** Appends a journal entry to a project's activity log. Separate from the block graph — a sequential human-readable narrative.

**What it's for:** Narrative continuity. The block graph captures structured knowledge; the project log captures the story of what happened. `workspace_task_update` auto-logs task status changes here.

**When to use it:** When something significant happens that doesn't fit neatly into a block — a direction change, a milestone reached, a key conversation.

---

### `workspace_project_status`

**What it is:** Returns recent activity (last 5 log entries) and all associated blocks for a project.

**What it's for:** Quick orientation within a specific project.

**When to use it:** Mid-session snapshot of a project's state without doing a full `workspace_project_resume`.

---

### `workspace_project_resume`

**What it is:** Full session briefing for a project. Returns open tasks, key decisions, active constraints, derived insights, other blocks, and recent log entries. Has a `since` parameter — pass a timestamp to get only what changed since your last session.

**What it's for:** Session start orientation. One call gives the full project context bucketed by type.

**When to use it:** Once at the start of a new session, before other project queries. Pass `since: <last_session_timestamp>` to get a delta.

---

## Task Tools

### `workspace_task_create`

**What it is:** Creates a task block. Auto-links to ALL active constraints (every task gets `constrained_by` relations automatically). Auto-links to semantically similar decisions (cosine > 0.65 via embedding). Supports `depends_on`, `milestone_id`, `acceptance_criteria`, `assigned_to`. TTL is `project`.

**What it's for:** Tracking active work items. Tasks are the only block type with a lifecycle (open → in_progress → done/blocked). The auto-linking to constraints means the agent picking up a task always sees what limits apply.

**When to use it:** When declaring new work that needs tracking. The pipeline creates most tasks from anchor phrases in conversation — manual creation is for work not mentioned in natural language.

---

### `workspace_task_next`

**What it is:** Returns the next open task, atomically claimed with a 10-minute TTL. Checks `depends_on` — won't surface a task whose dependencies aren't done. Prioritizes high > medium > low. Returns three layers: task + constraints + milestone (Layer 1), summaries of linked decisions/entities (Layer 2), hint to `workspace_get` for deeper detail (Layer 3).

**What it's for:** Multi-agent task coordination. The atomic claim prevents two agents from picking up the same task simultaneously.

**When to use it:** At the start of a work turn to pick up a task. Always use this instead of manually querying — it claims atomically and returns all linked context in one call.

---

### `workspace_task_update`

**What it is:** Updates a task's status (open → in_progress → done → blocked). Links produced artifact blocks via `produced` relations. Logs the status change to the project log if `project_id` is provided.

**What it's for:** Closing the task lifecycle loop. Without this, tasks stay `in_progress` forever.

**When to use it:** At the end of any turn where task work completed or got blocked.

---

## System / Maintenance Tools

### `workspace_gc`

**What it is:** Archives blocks whose TTL has expired. Never touches `permanent` blocks. Only affects temp blocks (`session`, `1hr`, `24hr`, `1week`). The scheduler runs this automatically every 6 hours.

**When to use it:** Rarely — the scheduler handles it. Run manually after a long session with many temp blocks.

---

### `workspace_stale`

**What it is:** Finds blocks that haven't been accessed recently relative to their history. Staleness score = `days_inactive / log(access_count + 2)`. Returns suggestions: "consider archiving" (> 10), "needs review" (> 6), "slightly stale" (> threshold). Does not archive anything.

**What it's for:** Graph hygiene. Identifies decisions, constraints, or facts that may be outdated.

**When to use it:** Periodic maintenance. Not a per-session tool.

---

### `workspace_challenge` *(Pro only)*

**What it is:** Creates a dispute block linked to the challenged block. Sets `contested: true` and drops the challenged block's confidence by 0.4. Creates a `challenges` relation.

**What it's for:** Multi-agent disagreement. When one agent believes another's block is wrong.

**When to use it:** When you have specific reasoning for why an existing block is incorrect.

---

### `workspace_resolve`

**What it is:** Resolves a conflict between two blocks. Three actions: `keep_this`, `keep_other`, `archive_this`. Reason stored in history. Nothing deleted — only archived.

**What it's for:** Closing `contradicts` pairs. When two blocks say conflicting things and you've determined which is correct.

**When to use it:** After `workspace_stale` or `GET /api/conflicts` surfaces a contradiction.

---

### `workspace_resolve_conflict`

**What it is:** Closes a conflict registered in the conflicts table (near-duplicate pairs from semantic similarity checks). Takes a `conflict_id` from `workspace_gaps()` output.

**What it's for:** Resolving near-duplicate blocks flagged by the save-time similarity check. Different from `workspace_resolve` — this operates on the conflicts registry.

**When to use it:** After `workspace_gaps` reports open near-duplicate conflicts.

---

### `workspace_export`

**What it is:** Exports blocks and relations in three formats: `json` (raw array — for backup/reimport), `markdown` (human-readable), `json-ld` (linked-data standard — for interop with Zep, Mem0, other knowledge graph systems). Supports filtering by type and archived status.

**When to use it:** Before major changes, for sharing project state, or for migrating data.

---

### `workspace_find_skill`

**What it is:** Searches all block types for stored procedures, patterns, or approaches that match a problem description. Three-signal scoring: semantic, keyword, concept overlap. Returns what matched, why, and how to apply it.

**What it's for:** Cross-domain pattern reuse. A debugging technique from one project can surface when solving a different problem if they share abstract concept tags.

**When to use it:** Before solving a new problem — check if a relevant approach already exists in the graph.

---

### `workspace_reembed`

**What it is:** Regenerates vector embeddings for blocks that are missing them or have stale embeddings. Background scheduler runs this every 10 minutes automatically.

**What it's for:** Blocks without embeddings are invisible to semantic search and `workspace_find_skill`.

**When to use it:** After bulk imports or server restart with new blocks not yet embedded. Rarely needed manually.

---

### `workspace_review_pending`

**What it is:** Lists pending relation approvals — relations created but not yet confirmed.

**When to use it:** Periodic maintenance.

---

### `workspace_gaps`

**What it is:** Gap audit on a project. Finds unanswered `question` blocks, open `contradicts` pairs, and missing causal links. Background scheduler runs every 1 hour.

**What it's for:** Graph health. Surfaces structural gaps — questions never answered, conflicts never resolved, blocks saved without causal wiring.

**When to use it:** After a long session to see what was left open. Run manually when the graph feels incomplete.

---

### `workspace_review`

**What it is:** Gets Gemini suggestions for enriching a thin block (quality score < 3). Tells you what fields are missing and suggests what to add.

**When to use it:** When you save a block and get a quality warning. Or after `workspace_gaps` flags thin blocks.

---

### `workspace_enrich`

**What it is:** Triggers Gemini concept enrichment on a specific block. Replaces keyword-auto concepts with abstract pattern tags. Background scheduler runs every 5 minutes on blocks with thin concepts.

**What it's for:** Concept tags determine cross-domain retrieval quality. Enriched concepts like `backpressure` or `bounded_queue` make `workspace_find_skill` and concept-overlap search work.

**When to use it:** When a block's concepts are clearly too literal. Rarely needed — scheduler handles it.

---

### `workspace_stats`

**What it is:** Returns block counts by type and status, plus whether embeddings are available.

**When to use it:** Quick workspace health check or monitoring.

---

### `workspace_create_type` / `workspace_create_relation_type`

**What it is:** Adds a new custom block type (extending a core type) or a new relation type to the schema.

**When to use it:** Very rarely. Before creating a new type, verify no existing type covers the case. Wrong type assignments cascade — the type is embedded in the label and permanent.

---

### `workspace_artifact_save`

**What it is:** Saves a concrete output (code, document, data) produced by agent work. Storage is automatic by size: < 8KB stored inline (fully searchable), 8KB–5MB written to `data/artifacts/<block_id>/<filename>` with path + SHA256 on block, > 5MB stored as reference only. Links to the task that produced it via `task_id`.

**What it's for:** The file-as-block pattern. The block is the searchable handle in the graph; the file is the data. A future agent can find the artifact through the graph without knowing the file path.

**When to use it:** When agent work produces a file output that should be findable and traceable.
