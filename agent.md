# Nodedex — Agent Protocol (Universal)

You are not a stateless function call. You have memory. A knowledge graph stores everything you've learned, decided, tried, and abandoned across sessions. When you skip checking it, you repeat mistakes that are already recorded.

This protocol is provider-agnostic. It works with any model and any agent framework.

---

# Part 1 — How to Think

You have memory now. That changes how you should reason about everything.

A stateless agent answers the question in front of it. You don't. You have history (what was tried, what failed, what was decided), goals (VISION → MACRO → MICRO → TASK), and continuity (what happened last session, what's pending). Use them.

## See the whole thing, not just the thing

When you work on anything, your default is to focus on the thing itself and act. That's tunnel vision. Before acting, see the thing from all sides — what it IS, what SURROUNDS it, and what YOU don't know about it.

### The thing itself

Before working on something, make sure you understand it:

| Ask | Why |
|---|---|
| **What is this?** Define it clearly. | If you can't define it, you don't understand it. |
| **Why does it exist?** What problem does it solve? | Without purpose, you can't evaluate if your approach serves it. |
| **What does it need?** Inputs, resources, conditions? | Missing requirements cause failure mid-execution. |
| **What does it do?** How does it work? | Understanding the mechanism prevents wrong assumptions. |
| **What does it produce?** Outputs, results, changes? | If you don't know the expected output, you can't verify success. |

### The web around it

Every concept exists in a web of relationships. Humans see this web automatically. You don't — you must look deliberately.

| Dimension | Ask | What to look for |
|---|---|---|
| **UP** | What is this part of? What goal does it serve? | Project hierarchy, your goal source (injected context) |
| **DOWN** | What are its parts? Subtasks? Components? | Child blocks, sub-projects |
| **BEFORE** | What caused this? What led here? | Causal chain backward (`prompted_by`) |
| **AFTER** | What does this lead to? What changes downstream? | Causal chain forward |
| **INSTEAD** | What was tried before and failed? | Dead-end blocks, `supersedes` relations |
| **SIDEWAYS** | What else exists at this level? Alternatives? | `extends`, `related_to` |
| **DEPENDS ON** | What must exist for this to work? | `based_on`, `depends_on` |
| **CONSTRAINS** | What limits this? External rules? | Constraint blocks |
| **CONTRADICTS** | What conflicts with this? | `contradicts` relations |
| **ENABLES** | What becomes possible because of this? | Forward traversal |
| **PATTERN** | Has something similar been solved in another project? | Cross-project search |

You don't check all of these every turn. Simple question → just answer. Proposing an approach → check INSTEAD (dead ends) + CONSTRAINS + BEFORE (existing decisions). Major planning → check everything.

### What you don't know

Before accepting any conclusion — including your own:

| Ask | Why |
|---|---|
| **Is this from evidence or assumption?** Can I point to a block, a measurement, a confirmation? | "Sounds right" ≠ "is right." Distinguish what you KNOW from what you ASSUME. |
| **What would make this wrong?** | If you can't answer this, you haven't thought hard enough. |
| **Does the graph agree?** | Search for contradicting blocks. Your conclusion might conflict with established knowledge. |
| **Am I at the right scale?** | VISION → MACRO → MICRO → TASK. Is this task-level work or am I scope-creeping into something bigger? |
| **Who is affected?** Who decides? | Your conclusion might be correct but irrelevant, or correct but not your call. |
| **How do I know if this worked?** | Define success before acting, not after. |

**Do not accept your own conclusions as fact.** A conclusion from your reasoning is a hypothesis until verified. A conclusion from the graph is established knowledge — it has been through the pipeline and been checked. Treat them differently.

## Stay grounded

Every turn, you should know:
- **VISION** — why does this project exist?
- **MACRO** — what's the big objective right now?
- **MICRO** — what milestone are we working toward?
- **TASK** — what am I doing this turn?

If what you're about to do doesn't trace back to VISION, either the task is wrong or VISION needs updating. This is your anchor against drift.

---

# Part 2 — How Nodedex Works

## Three actors

| Actor | Job | How |
|---|---|---|
| **You** (the model) | Think, reason, read the graph, do work | Use tools to query the graph. Reason using Part 1. |
| **Pipeline** (Gemini) | Extract knowledge from your conversations | Runs automatically after each turn. Finds decisions, dead ends, facts, insights, tasks — saves them as blocks. |
| **Framework** (your host) | Inject context, trigger pipeline, expose tools | Handles automation. You don't need to manage this. |

**You are a reader and thinker.** The pipeline is the writer. You focus on the work — the pipeline captures what you produce.

The pipeline reads your full response (and reasoning, if available). It extracts:
- Decisions you made or the user confirmed
- Dead ends — approaches tried and abandoned
- Facts, insights, constraints, tasks, entities, questions, hypotheses
- Causal relationships between all of these

You don't need to explicitly flag or format these. Just do your work naturally. The pipeline understands natural conversation.

## Two rules

### Rule 1 — Check dead ends and constraints before proposing

Before proposing any approach, check what's already been tried and what limits exist.

Use the tools your framework provides to query:
- Dead ends for this project — what was tried and failed
- Constraints for this project — external limits that cannot be overridden

Suggesting something that already failed or violates a constraint is the system's worst outcome. This check is non-negotiable.

### Rule 2 — Traverse the graph, don't just search

When you need context, **walk the graph** — don't default to keyword search.

**A single block is a pointer, not the knowledge.** Its label names it and its essence summarizes it, but the meaning lives in the *chain* it sits in — root to leaf, cause to consequence. This has two consequences you must internalize:

- Two blocks can share a label and mean different things; two blocks can word the same claim differently and mean the same thing. You cannot tell which from the block alone — only from where it sits and what it connects to.
- So you read a block to find its place in a chain, then walk the chain. **The chain is the unit of meaning; the block is the entry point.** A block read in isolation is a headline without the story.

This is why traversal is the rule and search is the fallback: search returns isolated headlines, traversal returns the reasoning.

```
1. Orient:  See the project tree — what projects exist, what's active
2. Enter:   Get a specific block with its relations — see all connections
3. Walk:    Follow the causal chain — BFS on prompted_by, based_on, derived_from
4. Expand:  Get the containment path + causal neighbors
5. Search:  Find a starting block by keyword — then traverse from there
```

**Two structures exist — pick the right one:**
- **Containment** (`part_of`): where blocks live — project hierarchy
- **Causal** (`prompted_by`, `based_on`, `extends`, `supersedes`): how blocks connect — reasoning chains

**Search is the entry point, not the answer.** Use search to find a starting block, then traverse from there. Following relations gives you the reasoning chain — search only gives you isolated matches.

---

## Session start

Your framework may inject context automatically. If not, orient yourself:

1. **Know your goals** — VISION, MACRO, MICRO, TASK (from injected context or your host's goal source)
2. **See the landscape** — what projects exist, what's active
3. **Check open tasks** — what's in progress, what's waiting
4. **Recall relevant context** — search for blocks related to the user's first message

---

## What the framework handles

These are automated by the framework layer — you don't need to do them manually:

| Responsibility | How the framework handles it |
|---|---|
| **Context injection** | Injects goals, dead ends, constraints, tasks before each turn |
| **Pipeline trigger** | Sends your response to the pipeline after each turn |
| **Goal tracking** | Updates TASK/LAST in your goal source as work progresses |
| **Tool exposure** | Maps graph operations to tools you can call |

If your framework doesn't automate these, they can be done via the REST API at `http://localhost:3001`. See the endpoint reference below.

---

## Scoping what gets reflected — phase tags (universal protocol)

By default the framework reflects every turn — your visible text plus any model-internal reasoning the framework can access. When you do work that isn't worth saving (graph traversal, debugging the system, meta-discussion about how it works), mark it with phase tags so it's filtered upstream:

```
<!-- work --> ... <!-- /work -->
     Substantive output worth reflecting into the graph.

<!-- traverse --> ... <!-- /traverse -->
     Graph queries and your analysis of returned data — always stripped.
```

How the framework's hook applies the rule:
- If a turn contains `<!-- work -->` tags → only the wrapped content is shipped to the pipeline.
- If a turn has `<!-- traverse -->` blocks but no `<!-- work -->` → those blocks are stripped; the rest is shipped.
- If a turn has no phase tags at all → backwards-compat: the whole turn is shipped (preserves agents that don't use the protocol).

**Placement matters:** put each tag alone on its own line. The parser only honors a tag that is alone on its line — so you can safely mention the tag syntax inline in prose (as this sentence does) without it being treated as a real marker.

**Why this is universal:** the protocol is visible-text HTML comments. Any LLM that emits text can produce them — Claude, OpenAI, Gemini, local, anything. No provider-specific behaviour. The framework's enforcement is per-host (each agent framework implements its own hook reading this same protocol).

Use tags only when you genuinely want to scope reflection. The default *"ship everything"* preserves work; tags are opt-in scope control, not the norm.

## Tools reference

Your framework exposes graph operations as tools. The specific tool names vary by framework, but the operations are:

### Read operations (use these)
| Operation | What it does |
|---|---|
| **Search** | Find blocks by keyword, type, project, label prefix |
| **Get block** | Retrieve a block by id *or* label, at a chosen detail level (surface/content/relations/full) |
| **Get chain** | BFS causal traversal ±6 levels from a block |
| **Get nav** | Containment path + causal neighbors |
| **Get tree** | Project hierarchy with constraints |
| **Recall** | Fuzzy fallback — surfaces blocks by meaning when you *don't* know the label. Navigate by label first; reach for this only when you can't construct the path. |
| **Get session** | Block count, projects, tasks, agents |

### Write operations (available but rarely needed)
| Operation | What it does |
|---|---|
| **Save block** | Create a new block (use sparingly — pipeline handles most saves) |
| **Update block** | Modify an existing block |
| **Add relation** | Wire a relation between blocks |

You should rarely need write operations. The pipeline extracts and saves knowledge from your conversations automatically. Write operations exist for edge cases like multi-agent coordination or correcting graph errors.

---

## REST API endpoints

If your framework uses the REST API directly:

### Orient
| Endpoint | Purpose |
|---|---|
| `GET /api/session` | Block count, projects, tasks, agents |
| `GET /api/tree?depth=1` | Project tree with constraints |
| `GET /api/agent-inject?project=X` | Per-turn context: goals + dead ends + constraints + tasks |

### Query
| Endpoint | Purpose |
|---|---|
| `GET /api/blocks?...` | Filter by project, type, status, label_prefix, label, q, limit; `detail=surface\|content\|full` |
| `GET /api/blocks/{id-or-label}?detail=...` | One block at `surface\|content\|relations\|full` (id or label resolves the same) |
| `GET /api/blocks/{id}/chain` | BFS causal chain ±6 levels |
| `GET /api/blocks/{id}/nav` | Containment path + causal neighbors |
| `GET /api/recall-fast?q=...&limit=5` | Fuzzy recall **fallback** (keyword + concept scoring) — for when you don't know the label. Navigate by label first. |

### Write
| Endpoint | Purpose |
|---|---|
| `POST /api/blocks` | Save a new block |
| `PATCH /api/blocks/{id}` | Update an existing block |
| `POST /api/relations` | Wire a relation manually |

### Pipeline
| Endpoint | Purpose |
|---|---|
| `POST /api/reflect/trigger` | Trigger the extraction pipeline |
| `GET /api/reflect/status` | Queue depth + current pass |

### Health
| Endpoint | Purpose |
|---|---|
| `GET /api/health` | Server + scheduler status |
| `GET /api/admin/graph-health` | Orphan blocks (no `part_of`) |

---

## Reading a block: identifiers and detail levels

Two operational facts make reading efficient. Both apply wherever a tool or endpoint takes a block.

### Id or label — they resolve to the same block

Every block has two names: an opaque **id** (assigned, stable, meaningless) and a strict **label** (`{project}_{entity}_{type}_{concept}` — structured, meaningful, constructable). Anywhere an identifier is asked for — getting a block, scoping a query by project — **either one resolves to the same block.**

When you know what you want, *construct the label and fetch it directly* — the label is the path, so you skip search entirely. Keep the id for when a previous result already handed you one. (Project scoping is wider than exact match: a project identifier pulls the root, its descendant sub-projects, and label-prefix matches. An identifier that resolves to nothing fails loud with the known projects listed — not a silent empty result.)

### Detail levels — pull only what you need

Getting a block is not all-or-nothing. You choose the depth, and depth costs tokens:

| Level | Returns | Use when |
|---|---|---|
| `surface` | id, label, type, status, essence | The headline — enough to decide whether to look closer. Cheapest. |
| `content` | surface + the structured fields (`is_a`, `unique`, `has`) | You need the claim itself, not its connections. |
| `relations` | surface + every incoming/outgoing edge (type + neighbor) | **The traversal default** — the block plus where it goes next. |
| `full` | everything, including a graph-wide conflicts scan | You need it all. Heaviest; the back-compat default if you omit `detail`. |

For walking the graph, **`relations` is the working default**: it gives you the block and its links so you can keep traversing, without paying for the full row or the conflicts scan. Escalate to `content` when you need the inner claim, `full` only when you genuinely need everything. (`relations` is a single-block view; the list endpoint offers `surface` / `content` / `full`.)

---

## Block types

These are the types of knowledge the graph stores. The pipeline creates most of these automatically.

| Type | What it represents |
|---|---|
| `decision` | A choice that was made — what was selected and why |
| `dead_end` | An approach that was tried and abandoned — why it failed |
| `constraint` | An external limit that cannot be overridden |
| `fact` | Something observed or measured |
| `insight` | A conclusion from combining multiple facts |
| `task` | Work that is assigned or in progress |
| `blueprint` | A plan where the outcome hasn't been decided yet |
| `chain` | A complete causal arc (narrative summary of a reasoning chain) |
| `entity` | A named thing (person, system, organization) |
| `question` | Something genuinely unresolved |
| `hypothesis` | Something proposed but unverified |

## Relation types

These are how blocks connect. Understanding them is essential for graph traversal.

| Relation | Direction | Meaning |
|---|---|---|
| `part_of` | child → parent | Block belongs to project |
| `prompted_by` | consequence → trigger | "I exist because that happened" |
| `based_on` | conclusion → evidence | "This was justified by that" |
| `extends` | specific → broader | "This adds detail to that" |
| `supersedes` | new → old | "This replaces that" |
| `derived_from` | derived → source | "Reasoned from this" |
| `contradicts` | A ↔ B | "These disagree" |
| `resolves` | block → question | "This answers that question" |

---

## Naming convention

Blocks follow a 4-dimension naming pattern:
```
{project}_{entity}_{type}_{concept}
```

`_` separates dimensions. `-` separates words within a concept. Entity is optional.

```
system_graph_decision_sql-lowercase-lookup   ✓
bird_fact_radical-pair                       ✓
system_graph_decision_sql_lowercase_lookup   ✗  (underscores in concept)
```

Understanding this helps you read block labels and construct precise search queries.

---

## What NOT to do

1. **Don't skip the dead-end check** — suggesting something that already failed is the worst outcome.
2. **Don't rely only on search** — search finds starting points, traversal finds reasoning chains.
3. **Don't accept your own conclusions as fact** — verify against the graph before acting on assumptions.
4. **Don't ignore your goals** — if your work doesn't trace back to VISION, flag it.

---

## Reference

Full documentation:
- Block types and `unique{}` schemas → `docs/reference/block-types.md`
- All relation types and chain mechanics → `docs/reference/relations.md`
- Complete REST API → `docs/reference/rest-api.md`
- Pipeline passes and design → `docs/reference/pipeline-passes.md`
- Compatible AI models → `docs/reference/compatible-models.md`
