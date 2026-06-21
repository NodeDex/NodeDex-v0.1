# Block Types Reference — Nodedex

> Ground truth from source code. Last verified: 2026-06-15.
>
> Verified against: live 41-block reflect run (chat-proxy entry, NODEDEX_WORTH_JUDGE_ENABLED=1, NODEDEX_CODE_DEDUP=1) + code grep + memory cross-reference.
>
> **2026-06-15 type collapse:** `reasoning_chain → insight` and `metric, claim → fact` were removed. The system never branched on them (a `fact`/`insight` + a little flavor); the distinguishing detail lives in a field or a relation. `workspace_derive` now emits `insight` (keeping its derivation sub-object). `entity`, `artifact`, and `hypothesis` were KEPT — each plays a real structural or behavioral role (entity = auto sub-group container, artifact = file-storage mechanism, hypothesis = the unverified-guess stance).

---

## Overview

Block types are **epistemic** — they classify the agent's relationship to a piece of knowledge, not what domain it comes from. A dead end in a clinical trial, a business pivot, and a software migration are all structurally identical: a path was entered, resources were committed, and it was abandoned for a specific reason.

| Type | Question answered | TTL | Save by |
|---|---|---|---|
| `decision` | What was chosen, and why? | permanent | Agent (manual) + pipeline |
| `dead_end` | What was tried and abandoned, and why? | permanent | Agent (manual) + pipeline |
| `constraint` | What is externally imposed and cannot be overridden? | permanent | Pipeline |
| `blueprint` | What is planned but outcome not yet decided? | permanent | Pipeline |
| `chain` | What is the complete causal arc that produced this outcome? | permanent | Pipeline Pass 5 |
| `project` | What is this project's scope and purpose? | permanent | Agent or pipeline |
| `question` | What is genuinely unresolved with no path forward? | project | Pipeline |
| `fact` | What was observed or measured that changed understanding? | project | Pipeline |
| `insight` | What was realized by combining multiple facts? | project | Pipeline |
| `task` | Who is doing what right now? | project | Pipeline + agent |
| `entity` | What is this named thing and what role does it play? | project | Pipeline (incl. auto sub-group containers) |
| `hypothesis` | What is proposed but not yet verified? | project | Pipeline |
| `preference` | What is a standing direction (not a committed choice)? | project | Pipeline |
| `note` | What is worth capturing that doesn't fit a sharper type? | project | Pipeline |
| `artifact` | What file, document, or generated output was produced? | project | `workspace_artifact_save` |
| `process` | *(internal)* Session state and repeatable workflow tracking | permanent | System |

**Rule:** Agents manually save only `decision` and `dead_end`. Everything else is saved by the pipeline or system tools.

---

## Permanent Types (never auto-archived)

### `decision`

A choice was made. The choosing is done. Implementation may be pending — that doesn't change that the choice was made.

**Identity:** The choice + the reason it was made. NOT the implementation details.

**`unique{}` fields:**
```
choice               "what was adopted"
reason               "why this over alternatives"
alternatives_rejected "what else was considered and why rejected"
```

**Required relation:** `based_on` → at least one fact or constraint that justified the choice.

**Triggers backward trace:** After every decision extraction, the pipeline asks "what was in use before this decision?" The predecessor is a dead_end candidate.

**Save rule (agent):** Save immediately when the user confirms ("yes", "let's do X"). Do not defer. Include `triggered_by` and `part_of`.

---

### `dead_end`

A path was entered. Resources were committed. It hit a wall from inside.

**Identity:** The approach + the specific reason it was abandoned.

**`unique{}` fields:**
```
approach    "what was tried or invested in"
reason      "why it was abandoned or failed — specific numbers/reasons if available"
alternative "what replaced it (if known)"
```

**Engagement check (mandatory before saving):** "Were resources actually committed to this path — active use, formal evaluation, dedicated work?" If not → it's a fact or skip, not a dead_end.

**TTL is always `permanent`** — hardcoded. Dead ends never expire.

**`part_of` is non-negotiable.** Without it the dead end is invisible to Rule 3 dead-end checks. A dead end with no `part_of` cannot protect against repeating past mistakes.

**Rule 3:** Before any agent proposes an approach:
```bash
GET /api/blocks?project=<project>&label_prefix=<project>_dead_end&q=<concept>
```

---

### `constraint`

An external requirement that cannot be overridden by the people working on the project. Law, regulation, vendor mandate, or standing policy.

**`unique{}` fields:**
```
limit   "the specific rule or boundary"
reason  "why it exists or what it protects"
source  "who imposed it — external authority, regulation, vendor"
```

**Distinction from dead_end:** A constraint is the external rule that blocks an option. The abandoned path is a dead_end (if it was engaged with) or a fact (if it was never entered).

**Auto-linked to tasks:** Every new task created via `workspace_task_create` automatically gets a `constrained_by` relation to ALL active constraints. An agent picking up a task always sees what limits apply.

---

### `blueprint`

A future investigation or action was committed to. The WHAT is decided, not the outcome.

**`unique{}` fields:**
```
purpose              "what it will achieve"
status               "deferred | planned"
trigger_to_implement "what condition or event activates this"
```

**Status:**
- `planned` — next immediate step
- `deferred` — scheduled for later

**Distinction from decision:** If a specific outcome was committed to → decision. If only a path or investigation was committed to → blueprint.

**Blueprint promotion:** When a blueprint is executed and completes, it becomes a `decision`. Pass 3 sets `supersedes_ref` pointing to the blueprint.

---

### `chain`

The assembled narrative arc of a causally connected cluster of blocks. Created by Pass 5 after all relations are wired.

**What it represents:** The complete story — what was tried or failed, what was imposed, what was concluded. It is a retrievable summary of how a cluster of blocks resolved into an outcome.

**`unique{}` fields:**
```
arc          "type sequence — e.g. fact → dead_end → decision"
conclusion   "the capability/outcome the arc resolved (≤80 chars)"
```

> **2026-05-24 — `conclusion` added** by commit `e0e41b8` ("fix chain block score=0 and ghost UUID"). Older docs only listed `arc`. The `members[]` field that `relations.md` previously claimed is **not** present in the chain block — see "Members" below.

**Other fields:**
- `essence` — one sentence (≤140 chars), the compressed story: what was tried/required, what failed or was imposed, what was adopted
- `label` — `{project}_chain_{capability-area}` — names the system capability the arc resolved, not the mechanism or cause

**Members:** Member blocks point to the chain block via their `chain_id` field (the chain block's own `id` IS the chain_id). The chain block itself does not inline the member list and its own `chain_id` field is intentionally `null`. Retrieve members with EITHER:
```bash
GET /api/chains/<chain-block-id>      # direct field query, returns member blocks
GET /api/blocks?chain_id=<chain-id>   # equivalent filter
```

**Do NOT use `GET /api/blocks/<chain-block-id>/chain` to get members** — that endpoint does BFS over causal relations (`prompted_by`/`based_on`/`extends`/`supersedes`/`superseded_by`/`derived_from`) from the focal block. Chain blocks have no outgoing causal edges of their own, so the BFS returns just the chain block (`length: 1`). The `/chain` endpoint is for causal ancestry around an ARBITRARY block, not for chain membership.

**Requires:**
- ≥2 blocks connected by `prompted_by`, `based_on`, or `supersedes`
- A committed conclusion: decision, constraint, insight, or dead_end as the final block
- All blocks from the same project

**Not a chain:** single blocks, open arcs (blueprint/task terminus), pure context accumulation with no outcome.

---

### `project`

The root block for a domain. Every non-project block must have `part_of` pointing to its project root.

**Created by:** `workspace_project_create` or pipeline auto-create.

---

## Project-scoped Types (archived when project closes)

### `question`

Something is genuinely unresolved with no committed path forward.

**`unique{}` fields:**
```
question    "the exact open question"
why_matters "what depends on the answer"
```

**Keep only if:** explicitly left unresolved by the end of the passage. If ANY committed path exists (even a vague one) → blueprint, not question.

**Resolved by:** a `resolves` relation from the answer block.

---

### `fact`

An observation of current reality. A specific measurement, state snapshot, or finding that changed understanding.

**`unique{}` fields:**
```
value       "the specific measurement or finding — the extracted number/threshold/named result"
why_matters "what this implies — what a future agent needs to know from it"
```

**Keep only if:** records a specific measured value or concrete state (a number, version, count, capacity). Skip if vague with no measurement ("X is working fine", "going well").

**`event` — a timestamped OCCURRENCE** (something that *happened*), distinct from a `fact` (a standing truth) and a `task` (a not-yet-done). Its `unique{}` is `{ what_happened (required), outcome?, date? }`. `what_happened` is the occurrence itself — the irreducible core; the **type label** carries the happened-vs-true distinction, so the field schema stays thin. Causality lives in **relations** (the causal chain is the unit of meaning), never in a field — so `outcome` is optional and only for a trivial inline result (a real consequence becomes its own chain node), and `date` is optional, only when the absolute time is itself the recall key. *(2026-06-15: reconciled prompt/validator/doc — the validator had drifted to require `value`; `what_happened` is the honest field the extraction prompt already teaches.)*

**Tracking a metric:** a measured value — whether one-time or tracked over time — is a `fact`. Put the current value in `value` and any target or trend in `why_matters`. *(The former `metric` type collapsed into `fact` on 2026-06-15 — the system never treated it differently from a fact.)*

---

### `insight`

A conclusion reached by combining two or more things not directly connected in the original text.

**`unique{}` fields:**
```
observation "what was realized"
implication "what it means"
```

**Distinct from fact:** A fact records a single observation. An insight synthesises multiple things.

> **`reasoning_chain` collapsed → `insight` (2026-06-15).** A conclusion drawn from combining 2+ recalled graph blocks is an `insight`; that it was *derived* lives in its `based_on`/`derived_from` relations, not in a separate type. `workspace_derive` emits an `insight` and keeps a `reasoning_chain` content sub-object (the recall boost keys on it). Not to be confused with `chain` (the narrative container) — that is unchanged.

---

### `task`

Active work in progress by a named person or group.

**`unique{}` fields:**
```
status      "open | in_progress | done | blocked"
description "what needs to be done"
owner       "who is responsible (if named)"
```

**Lifecycle:** open → in_progress → done / blocked. Use `workspace_task_update` to advance state.

**Auto-links at creation:**
- `constrained_by` → all active constraints
- `affected_by` → semantically similar decisions (cosine > 0.65)

---

### `entity`

A named thing with a specific role — person, organization, system, document.

**`unique{}` fields:**
```
name "canonical name"
role "what it does or who they are"
```

---

### `hypothesis`

A proposed claim presented as not yet verified — offered as a possible answer, explicitly hedged or uncertain.

**`unique{}` fields:**
```
proposal         "the theory"
evidence_for     "supporting signals"
evidence_against "counter-signals"
```

**Distinct from fact:** A hypothesis is explicitly unconfirmed. A fact is an established observation. The `hypothesis` stance is kept precisely because "an unverified guess" must not be relabelled as a verified `fact`.

---

### `preference`

A standing tendency — not a committed choice, but a stated direction that shapes recurring decisions.

**`unique{}` fields:**
```
lean      "what direction or approach is favored"
over      "what alternatives it is preferred over"
condition "when this preference applies"
```

---

### `note`

A general observation or annotation that doesn't fit a sharper epistemic type.

**`unique{}` fields:** freeform — define what fits.

**Use only as last resort.** If the content fits `fact`, `insight`, or any other type → use that type. `note` is the catch-all when nothing else applies.

---

### `artifact`

A file, document, or generated output produced during work.

**Created by:** `workspace_artifact_save` tool. Not produced by the pipeline.

**`unique{}` fields:**
```
path        "file path or location"
description "what it contains or what it's for"
```

---

## Novel Types

Pass 2 can create novel types when all three gates pass:

1. **Action gate** — would a future agent behave differently toward this than any existing type?
2. **Metadata gate** — cannot be expressed as an existing type with richer `unique{}` fields
3. **Name gate** — the name describes epistemic status (agent's relationship to knowledge), not content shape or domain

**Examples:** `stance`, `commitment`, `mandate` pass. `clinical_finding`, `sprint_goal`, `user_story` fail Gate 3.

When a novel type is first created, Pass 2 defines its `schema{}` (the unique{} field structure) but does not automatically register the type definition to the `block_types` table. Use `workspace_create_type` to formally register a novel type with a description and typical fields so future sessions recognise it.

---

## Block Anatomy

From a live block:

```json
{
  "label":         "forge_decision_hs256-jwt-tokens",
  "type":          "decision",
  "essence":       "JWT access tokens signed with HS256 using a single shared secret...",
  "quality_score": 3,
  "ttl":           "permanent",
  "chain_id":      "010e275c-23b1-405f-8fea-f8a912f5abae",
  "flow_role":     "solution",
  "content": {
    "unique": {
      "choice":               "HS256 HMAC signing with shared secret",
      "reason":               "Simple to implement, single key to manage",
      "alternatives_rejected":"RS256 considered but deemed unnecessary complexity"
    }
  }
}
```

**`essence`** — one sentence, ≤120 chars. What is this and why does it matter. The primary field agents read in recall results.

**`unique{}`** — structured fields per type. What agents read when they open the block. Filled by Pass 2. Copied by Pass 3. Never re-derived downstream.

**`quality_score` (0–5)** — structural completeness. Starts at 1, then +1 for each: type set / unique{} ≥2 fields / concepts[] ≥3 terms / ≥1 relation. Recomputed when a relation is added. Used directly in recall ranking.

**`flow_role`** — narrative role: `trigger | problem | cause | mechanism | solution | outcome`.

> **2026-05-24 — `flow_role` REMOVED from the pipeline path** (commits `c2412a6` + `a92c44f`, 2026-05-18). Pass 2/3/5 no longer set it. `deriveFlowRole()` and `applyFlowRoleOverrides()` were deleted from `pipeline.ts`. The DB column stays. **Pipeline-generated blocks have `flow_role = null`.** Still written by: `workspace_derive` (sets `outcome` on derived block, `cause` on inputs) and `workspace_remember` (accepts agent-provided value). UI computes chain display order from `prompted_by` edges via toposort instead.

**`chain_id`** — UUID shared by all blocks in a causal cluster. Stamped server-side by BFS after save. For `chain` blocks specifically, member blocks carry this ID pointing back to the chain block.

---

## TTL Values

TTL is primarily an **agent tool for temporary reasoning blocks**. All knowledge blocks saved by the pipeline are `permanent` by default — the agent only sets TTL when creating scratch/working-memory blocks mid-session.

| Value | Meaning | When an agent uses it |
|---|---|---|
| `permanent` | Never expires | Default for all knowledge — never pass this manually, it's the default |
| `session` | Expires when session ends | Scratch reasoning block: create → reason → promote or let expire |
| `1hr` / `24hr` / `1week` | Expires after duration | Short-lived working memory with a known shelf life |
| `project` | Archived when project closes | Not set by agents — applied by the pipeline to tasks/questions/facts |

**Dead ends are always `permanent`** — hardcoded. Passing a different TTL for a dead_end is silently overridden.

**The temp block pattern:** `workspace_remember(ttl: "session")` → reason with the block in context → `workspace_promote` if worth keeping → `workspace_gc` archives it automatically (runs every 6h) if not.
