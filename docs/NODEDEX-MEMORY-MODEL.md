# Nodedex — what it serves, how it differs from RAG, and evidence it works

## What Nodedex serves

Nodedex is persistent memory for AI agents that remembers **reasoning residue** — the
**decisions** made (and why), the **dead-ends** hit (and why they were abandoned), the
**constraints** that apply, and the **causal chains** that link them — so an agent doesn't
re-derive what it already worked out or repeat a mistake it already made.

The value is **compounding decision quality across sessions**: at a decision point, the agent
retrieves the relevant prior reasoning instead of starting cold. What it stores are *epistemic*
block types — `decision`, `dead_end`, `constraint`, `fact`, `insight`, `chain` — linked by causal
relations (`based_on`, `leads_to`, `supersedes`).

## Is it a RAG? Is it a replacement for other memory? — No, and no.

**Nodedex is not a RAG.** A RAG embeds your query, pulls the top-k text chunks, and pastes them into
the prompt — passive, flat, one-shot, document-centric. Nodedex is a **navigable causal graph of the
agent's own reasoning**, which the agent **traverses**: orient on the project tree → construct the
label → open the block → read its chain → follow causal links → decide. That is **active and
multi-step**, not a one-shot paste.

| | RAG / passive-vector memory | Nodedex |
|---|---|---|
| unit stored | text chunk / chat summary | typed reasoning residue (decision / dead-end / constraint / chain) |
| structure | flat vectors | causal graph (chains, `based_on`, `supersedes`) |
| how it's read | embed query → top-k → inject (**one shot**) | agent **traverses** (orient → get → walk chain → hop) |
| question it answers | "what does this document say?" | "what did we decide / try / rule out — and why?" |

**Not a replacement — complementary.** Use RAG for external documents and knowledge; use Nodedex for
the agent's *own* accumulated reasoning. Against other agent-memory systems (vector or summary stores
that also do passive recall-and-inject), Nodedex is a **different architecture**: structured, typed,
chained, and *navigated* rather than passively recalled. *(For the conceptual comparison to other
graph-memory tools like Zep/Graphiti, see [explanation/what-nodedex-is.md](explanation/what-nodedex-is.md).
This doc is the empirical companion: what the system actually saved and retrieved in a live test.)*

> **The distinction that matters for evaluation:** a one-shot injection *cannot be* navigation. Bolt
> Nodedex onto a passive "retrieve-and-inject" interface and you've collapsed the graph back into a
> RAG — throwing away the exact thing that makes it different.

## Evidence it does its job

The intended test is: **extract reasoning through the pipeline → check the health of the whole graph
→ see if the agent can traverse to what it needs.** We ran that by feeding research-paper derivations
through the pipeline and reading the resulting graph directly (not inferring from scores).

### 1. It saves rich, correctly-typed, chained residue

From a single paper, the pipeline captured — verified by reading the live graph:

![What the pipeline saves per paper, by block type](assets/ma-residue-inventory.svg)

| block type | bound-derivation paper | theorem-proving paper |
|---|---|---|
| dead_end | 2 | ~0 |
| decision | 10 | 6 |
| constraint | 5 | ~0 |
| fact | 14 | 15 |
| insight | 5 | 1 |
| chain | 8 | 4 |
| **total blocks** | **53** | ~26 |

Actual residue captured (verbatim essences):
- **dead_end:** *"Frobenius norm too loose for operator norm; matrix concentration gives the correct N/n scaling"*
- **decision:** *"Chose the infimum definition since Theorem 3.1 gives the wrong direction"*
- **constraint:** *"The bound C·N/n requires n ≥ N"*; *"assumes sub-Gaussian tails"*

The profile **mirrors the source's reasoning style** — a bound-derivation is *try → reject → choose →
constrain* (rich in dead-ends/constraints); a clean theorem proof is *establish → conclude* (fact and
chain heavy). The system captures whatever reasoning is actually there, faithfully and correctly typed.

### 2. The graph is healthy

On a representative paper: **55 blocks, only 1 flagged** for review (the rest validated clean),
decisions wired to their justifying facts via `based_on`, chains coherent, and **zero islanded roots**
(every topic root is connected by real dependency edges). "Healthy" here means *faithful, well-structured
capture* — it stores the agent's conclusions exactly as reasoned (judging the content is the agent's
job, not the pipeline's).

### 3. The agent can traverse to what it needs

Acting as the agent, navigating the graph as designed (tree → recognize the matching root → open the
decision → walk its chain), the system handed over the **scoped result with its derivation** — e.g.
*"metric entropy of F_N ~ N log N"* arriving inside its covering-number chain, so the agent knows
*what it's for* and *where it came from*, not a decontextualized fragment. The same graph, navigated,
delivers the right prior on demand.

## A note on benchmark scores

This residue was extracted while testing Nodedex on MemoryArena. That benchmark's interface is a single
passive call (`wrap_user_prompt → blob`) — i.e. it uses any memory backend as a **RAG**. As explained
above, a one-shot injection can't exercise traversal, so the benchmark's pass-rate measures the *agent's
task skill*, not the memory. For that reason we do **not** report a benchmark score as a Nodedex result.
The honest measure of whether the system did its job is the evidence above: **what it saves, how healthy
the graph is, and whether the agent can traverse to what it needs** — all three hold.
