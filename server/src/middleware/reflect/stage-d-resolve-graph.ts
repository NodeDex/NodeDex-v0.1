// ═══════════════════════════════════════════════════════════════════════════════
// DEBT 5 Slice 3 (Stage D) — Part 2: RESOLVE + Part 3: DECIDE
// ═══════════════════════════════════════════════════════════════════════════════
//
// For each arc entity (post Stage C), decide: does it already EXIST in the graph
// (attach), is it a NEW thing (create), or is it AMBIGUOUS (flag for review)?
//
// Two orthogonal axes — kept SEPARATE (the flag-reviewer Finding-C lesson: a
// single blunt "different scope = leave" rule collapsed them and mis-fired):
//   Q1 IDENTITY — same underlying thing? (judged on unique{} content, not label)
//   Q2 SCOPE    — same owner, or same KIND under a DIFFERENT owner?
//
// Match-to-competence (Rule 3):
//   - EXACT identity (normalized unique{} primary value equal) + decidable scope
//     → resolved in CODE, no LLM (the "only call the model when ambiguous" saver).
//   - Otherwise → the LLM resolver (spike-validated prompt, docs/PIPELINE-STAGE-D-
//     SPIKE-DESIGN.md §3 — 5/6 real pairs correct).
//
// Catch-all scope (spike pair-5 lesson): a candidate under a catch-all dump
// (scope.is_catch_all, detected STRUCTURALLY in retrieve-graph-slice.ts) is
// "owner UNKNOWN", not "owner different" → DECIDE routes same-identity + catch-all
// to FLAG, never auto-NEW.
//
// This module RESOLVES + DECIDES only. It does not name, write, or mutate the
// graph — its output is consumed by the Pass 3 seam (Part 4 wiring) + the flag
// table. (Mirrors flag-reviewer.ts's structure: input builder → LLM call →
// telemetry → orchestrator; here the orchestrator also holds the code-first gate.)

import type { LLMProvider } from "../../engine/ai-provider.js";
import type { WorkspaceDB } from "../../store/database.js";
import type { ArcEntityCluster, Pass2Item } from "./types.js";
import type { RetrievalCandidate, EntityQuery } from "./retrieve-graph-slice.js";
import { retrieveGraphSlice, normalizePrimaryValue, scopeSegmentOfLabel } from "./retrieve-graph-slice.js";
import { extractPrimaryValue, extractPrimaryValueFromUnique } from "./dedup-by-source-and-value.js";
import { reflectTokenStats } from "./context.js";
import { getThinkingBudget } from "./config.js";

const STAGE_D_MODEL_OVERRIDE = process.env.NODEDEX_STAGE_D_MODEL ?? null;

// ─── The resolver prompt (docs/PIPELINE-STAGE-D-SPIKE-DESIGN.md §3, spike-validated) ──
export const STAGE_D_RESOLVE_PROMPT = `You receive ONE entity resolved from a single conversation arc, and a set of
CANDIDATE blocks already in the graph that a retrieval step found potentially
related. For each candidate, decide whether the arc entity is the SAME entity
already present, or a NEW entity to record separately.

── STATE CONVENTION ──
"State" = the arc entity and the candidate blocks shown below. Your training
knowledge and what is "commonly true" about any domain are NOT state. An entity
exists in the graph ONLY if a candidate block shows it. Familiarity is not record.

── SCOPE BOUNDARY ──
You decide MATCH-or-NEW only. You do not name, wire relations, merge, or write.
Your output is a resolution judgment the naming step consumes.

── TWO INDEPENDENT QUESTIONS (answer SEPARATELY — collapsing them is the failure mode) ──

Q1 — IDENTITY: Do the arc entity and the candidate describe the same underlying
thing, or two different things that merely share a name or topic?
  Inspect the identity-bearing content — the specific recorded values and claims,
  not the label. A shared label with divergent content is NOT identity. Divergent
  labels carrying the same specific content IS identity.

Q2 — SCOPE: If Q1 is yes — is this the same instance under the same owner/context,
or the same KIND of thing under a DIFFERENT owner/context?
  Inspect the scope evidence each carries (its parent/owner, the surrounding
  context that places it). Ask whether the scope difference reflects a genuinely
  different owner, or whether both could be one thing recorded under two
  organizational labels. Do not treat a difference in the scope field as decisive
  by itself — reason about what the scope MEANS from the evidence shown. A scope
  marked as a catch-all / unspecified bucket is owner-UNKNOWN, not owner-different.

── COST ASYMMETRY AND DEFAULT ──
A false MATCH fuses two distinct things into one node — it mixes owners and is
costly to reverse. A false NEW leaves a duplicate a later audit can still merge.
The directions are NOT equal. Therefore: when Q1 or Q2 cannot be answered from the
content shown, default to NEW. Treat "same entity" as a claim you must EARN from
the evidence, not assume from resemblance.

── FALSIFIABILITY ──
Every "same entity" or "same scope" judgment must cite the SPECIFIC content that
supports it — the overlapping value, the specific shared claim, the scope evidence.
A judgment that says only "they seem related" without citing what overlapped fails.

── DECISION ──
  Q1 yes + Q2 same-scope       -> match_existing  (reuse the candidate's identity)
  Q1 yes + Q2 different-scope   -> new_entity      (same kind, different owner)
  Q1 yes + Q2 owner-unknown     -> match_existing  (let the naming step / review decide ownership)
  Q1 no                         -> new_entity
  Q1 or Q2 unanswerable         -> new_entity      (the conservative default above)

── OUTPUT ──
Return JSON matching the schema: your two-axis judgment and the verdict, each with
the specific evidence that supports it.`;

const STAGE_D_RESOLVE_SCHEMA = {
  type: "object",
  properties: {
    same_entity:       { type: "boolean" },
    identity_evidence: { type: "string" },
    same_scope:        { type: "string", enum: ["same", "different", "owner_unknown"] },
    scope_evidence:    { type: "string" },
    verdict:           { type: "string", enum: ["match_existing", "new_entity"] },
    reasoning:         { type: "string" },
  },
  required: ["same_entity", "identity_evidence", "same_scope", "scope_evidence", "verdict", "reasoning"],
};

// ─── Output contract (what Part 4 + the flag writer consume) ───────────────────

export type StageDDecision = "attach_existing" | "new_entity" | "flag_for_review";

export interface StageDEntityResult {
  canonical_name: string;          // the Stage C entity this resolves
  decision: StageDDecision;
  /** Set when decision='attach_existing' — the graph block to reuse. */
  matched_block_id?: string;
  matched_block_label?: string;
  /** How the decision was reached — CODE (exact identity) or LLM (judgment). */
  resolved_by: "code_exact" | "llm" | "no_candidates";
  /** Why — falsifiability/audit trail. */
  reasoning: string;
  /** When flagged: the scope situation that triggered review. */
  flag_reason?: string;
}

// ─── Input builder (mirrors flag-reviewer.buildReviewerInput) ──────────────────

function formatCandidate(c: RetrievalCandidate): string {
  const b = c.block;
  let primaryVal = "";
  try {
    const content = typeof b.content === "string" ? JSON.parse(b.content) : (b.content || {});
    primaryVal = extractPrimaryValueFromUnique(b.type, content.unique || {});
  } catch { /* leave blank */ }
  return [
    `  candidate_block_id: ${b.id}`,
    `  label: ${b.label}`,
    `  type: ${b.type}`,
    `  identity_value (unique{}): ${primaryVal || "(none)"}`,
    `  essence: ${b.essence}`,
    `  scope/owner: ${c.scope.value}${c.scope.is_catch_all ? " [CATCH-ALL — owner unknown, not a distinct owner]" : ""}`,
    `  source_excerpt (evidence only): ${(b as any).source_excerpt ?? "(none)"}`,
  ].join("\n");
}

export function buildStageDInput(entity: EntityQuery, candidate: RetrievalCandidate): string {
  return `── ARC ENTITY (newly resolved, seeking match) ──
  canonical_name: ${entity.canonical_name}
  identity_value(s) (unique{}): ${entity.primary_values.join(" | ") || "(none)"}
  concepts: [${entity.concepts.join(", ")}]

── CANDIDATE (already in graph) ──
${formatCandidate(candidate)}

Resolve per the two questions (identity, then scope). Cite specific overlap.`;
}

// ─── LLM call (mirrors flag-reviewer.callReviewerLLM) ──────────────────────────

interface ResolverLLMOutput {
  same_entity: boolean;
  identity_evidence: string;
  same_scope: "same" | "different" | "owner_unknown";
  scope_evidence: string;
  verdict: "match_existing" | "new_entity";
  reasoning: string;
}

export async function callStageDResolver(
  provider: LLMProvider,
  entity: EntityQuery,
  candidate: RetrievalCandidate,
): Promise<{ result: ResolverLLMOutput | null; model?: string; rateLimited: boolean }> {
  const userInput = buildStageDInput(entity, candidate);
  const r = await provider.generateStructured<ResolverLLMOutput>(
    STAGE_D_RESOLVE_PROMPT, userInput, STAGE_D_RESOLVE_SCHEMA,
    { thinkingBudget: getThinkingBudget(1024), maxOutputTokens: 2048, modelOverride: STAGE_D_MODEL_OVERRIDE ?? undefined },
  );
  if (r.usage) {
    reflectTokenStats.pass_d_resolve.input    += r.usage.input    ?? 0;
    reflectTokenStats.pass_d_resolve.thinking += r.usage.thinking ?? 0;
    reflectTokenStats.pass_d_resolve.output   += r.usage.output   ?? 0;
  }
  reflectTokenStats.pass_d_resolve.calls += 1;
  return { result: r.result, model: r.model, rateLimited: r.rateLimited };
}

// ─── DECIDE (Part 3) — map (identity, scope) → one outcome ─────────────────────
//
// The 3-way rule. Pure given the resolver output (or the code-exact path).
// Catch-all scope is the load-bearing branch: same-identity under a catch-all is
// "owner unknown" → FLAG (let review/naming decide), never auto-NEW (would
// duplicate) and never silent-attach (would guess the owner).

export function decideFromResolution(
  same_entity: boolean,
  same_scope: "same" | "different" | "owner_unknown",
  candidate: RetrievalCandidate,
): { decision: StageDDecision; flag_reason?: string } {
  if (!same_entity) return { decision: "new_entity" };
  // same_entity === true below
  if (same_scope === "same")      return { decision: "attach_existing" };
  if (same_scope === "different") return { decision: "new_entity" };
  // owner_unknown (incl. catch-all candidate): don't guess — flag for review.
  return {
    decision: "flag_for_review",
    flag_reason: candidate.scope.is_catch_all
      ? `Same identity as ${candidate.block.label}, but its scope is a catch-all (owner unknown) — needs review to assign the real owner.`
      : `Same identity as ${candidate.block.label}, but scope ownership is undetermined — needs review.`,
  };
}

// ─── Orchestrator (Part 2+3): resolve ONE arc entity against the graph ─────────
//
// Code-first gate (Rule 3): if the top candidate is an EXACT normalized unique{}
// match AND its scope is decidable (real owner, same or different), resolve in
// CODE — no LLM. Only ambiguous cases (partial identity, catch-all scope, or
// genuine multi-candidate contention) call the resolver.

export interface ResolveEntityOpts {
  db: WorkspaceDB;
  provider: LLMProvider;
  entity: EntityQuery;
  /** The arc entity's own scope (the project it's being filed under this arc) —
   *  used to decide same/different when resolving in code. */
  arc_scope?: string;
  k?: number;
  /** When true, never call the LLM (verify harness / cost-free dry run). The
   *  code-exact path still resolves; ambiguous cases return 'new_entity' with
   *  resolved_by='code_exact' note. */
  codeOnly?: boolean;
  /** COST GATE: only spend an LLM call when the top candidate's identity_score
   *  is at least this. Below it, there's no plausible duplicate worth judging →
   *  return new_entity for free. Bounds cost to items that actually have a
   *  candidate. Default 0.5 (a partial token-overlap ≥0.5, or any exact match). */
  minIdentityForLLM?: number;
}

export async function resolveArcEntity(opts: ResolveEntityOpts): Promise<StageDEntityResult> {
  const { db, provider, entity } = opts;
  const candidates = retrieveGraphSlice(db, entity, { k: opts.k ?? 20 });

  if (candidates.length === 0) {
    return { canonical_name: entity.canonical_name, decision: "new_entity", resolved_by: "no_candidates",
             reasoning: "No candidate blocks retrieved — this entity is new to the graph." };
  }

  const top = candidates[0];
  const normEntityValues = entity.primary_values.map(normalizePrimaryValue).filter(Boolean);

  // ── Code-first gate: exact identity + decidable real-owner scope ──
  if (top.identity_score >= 1.0 && !top.scope.is_catch_all && opts.arc_scope) {
    const sameScope = top.scope.value === opts.arc_scope;
    return {
      canonical_name: entity.canonical_name,
      decision: sameScope ? "attach_existing" : "new_entity",
      matched_block_id: sameScope ? top.block.id : undefined,
      matched_block_label: sameScope ? top.block.label : undefined,
      resolved_by: "code_exact",
      reasoning: `Exact unique{} identity match with ${top.block.label}; scope ${sameScope ? `same (${opts.arc_scope})` : `differs (${opts.arc_scope} vs ${top.scope.value})`} — resolved without LLM.`,
    };
  }

  // ── COST GATE: no plausible duplicate → new_entity for free, no LLM ──
  const minForLLM = opts.minIdentityForLLM ?? 0.5;
  if (top.identity_score < minForLLM) {
    return { canonical_name: entity.canonical_name, decision: "new_entity", resolved_by: "no_candidates",
             reasoning: `Top candidate ${top.block.label} identity_score ${top.identity_score.toFixed(2)} < ${minForLLM} — no plausible duplicate; new_entity without LLM.` };
  }

  // ── Ambiguous → LLM resolver (unless codeOnly) ──
  if (opts.codeOnly) {
    return { canonical_name: entity.canonical_name, decision: "new_entity", resolved_by: "code_exact",
             reasoning: `codeOnly: top candidate ${top.block.label} not an exact-identity+real-scope match (identity=${top.identity_score.toFixed(2)}, catch_all=${top.scope.is_catch_all}); deferred to new_entity.` };
  }

  const r = await callStageDResolver(provider, entity, top);
  if (!r.result) {
    return { canonical_name: entity.canonical_name, decision: "new_entity", resolved_by: "llm",
             reasoning: `Resolver ${r.rateLimited ? "rate-limited" : "failed"} — conservative default new_entity (false-NEW is recoverable, false-MATCH is not).` };
  }

  const { decision, flag_reason } = decideFromResolution(r.result.same_entity, r.result.same_scope, top);
  // Carry the matched candidate for BOTH attach AND flag — in both, top.block is the
  // existing block this item resolved against. attach_existing → the block to reuse;
  // flag_for_review → the ambiguous match the agent/reviewer must adjudicate. Only
  // new_entity has no meaningful match (left undefined). Before this, flag_for_review
  // dropped the match → Touchpoint B wrote block_id_b=null → the flag was un-actionable
  // (reviewer/agent had nothing to compare the new block against).
  const matched = decision === "attach_existing" || decision === "flag_for_review";
  return {
    canonical_name: entity.canonical_name,
    decision,
    matched_block_id: matched ? top.block.id : undefined,
    matched_block_label: matched ? top.block.label : undefined,
    resolved_by: "llm",
    reasoning: r.result.reasoning,
    flag_reason,
  };
}

// ─── Batch entry (Part 4 — pipeline.ts consumer) ───────────────────────────────
//
// Resolve every Pass 2 classified item against the graph at arc time. Called from
// pipeline.ts Touchpoint A (after Stage C names are applied, before Pass 3). Returns
// only the items that resolved to an EXISTING block (attach_existing) or are
// AMBIGUOUS (flag_for_review) — those become cross_arc_dup_candidate flags at
// Touchpoint B. Items resolving to new_entity are omitted (the default; nothing to flag).
//
// Each item's EntityQuery is built from its OWN identity-bearing fields:
//   - primary_values: extractPrimaryValue(item) — the unique{} primary value (Signal 1)
//   - canonical_name + concepts: from item.project (post-Stage-C name) + text tokens
//   - arc_scope: item.project (the scope it's being filed under THIS arc) — Signal 2
//
// The cost gate (minIdentityForLLM) is what bounds spend: items whose retrieval
// surfaces no plausible identity candidate resolve to new_entity for FREE (no LLM).
// So per-arc LLM cost ≈ (# items with a real candidate), not (# items).

export interface BatchResolveOpts {
  db: WorkspaceDB;
  provider: LLMProvider;
  items: Pass2Item[];
  /** Exclude items whose own (about-to-be-created) labels would self-match.
   *  Pass the set of this-arc item labels so retrieval doesn't flag an item
   *  against its own freshly-written sibling. */
  thisArcItemValues?: Set<string>;
  k?: number;
  minIdentityForLLM?: number;
  codeOnly?: boolean;
}

export interface BatchResolveEntry {
  item_id: string;
  decision: StageDDecision;          // 'attach_existing' | 'flag_for_review' (new_entity omitted)
  matched_block_id?: string;
  matched_block_label?: string;
  resolved_by: "code_exact" | "llm" | "no_candidates";
  reasoning: string;
  flag_reason?: string;
}

export interface BatchResolveResult {
  entries: BatchResolveEntry[];      // only attach/flag outcomes
  items_resolved: number;            // total items examined
  llm_calls: number;                 // how many actually hit the model (cost visibility)
  attached: number;
  flagged: number;
}

export async function resolveArcEntitiesForItems(opts: BatchResolveOpts): Promise<BatchResolveResult> {
  const result: BatchResolveResult = { entries: [], items_resolved: 0, llm_calls: 0, attached: 0, flagged: 0 };
  const callsBefore = reflectTokenStats.pass_d_resolve.calls;

  for (const item of opts.items) {
    result.items_resolved += 1;
    const primaryVal = extractPrimaryValue(item);
    if (!primaryVal) continue; // no identity value → nothing to resolve (e.g. project rows)

    const arcScope = item.project ? scopeSegmentOfLabel(`${item.project}_x_y`) : undefined; // {project} as discrete owner
    const entity: EntityQuery = {
      canonical_name: item.project ?? "",
      primary_values: [primaryVal],
      // Concepts for the FINDING step: cheap token set from the item text + value.
      concepts: Array.from(new Set(
        `${item.project ?? ""} ${primaryVal}`.toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length > 3),
      )).slice(0, 12),
    };

    const res = await resolveArcEntity({
      db: opts.db, provider: opts.provider, entity, arc_scope: arcScope,
      k: opts.k, minIdentityForLLM: opts.minIdentityForLLM, codeOnly: opts.codeOnly,
    });

    // Only attach/flag outcomes produce a flag at Touchpoint B; new_entity is the no-op default.
    if (res.decision === "attach_existing" || res.decision === "flag_for_review") {
      result.entries.push({
        item_id: item.id,
        decision: res.decision,
        matched_block_id: res.matched_block_id,
        matched_block_label: res.matched_block_label,
        resolved_by: res.resolved_by,
        reasoning: res.reasoning,
        flag_reason: res.flag_reason,
      });
      if (res.decision === "attach_existing") result.attached += 1; else result.flagged += 1;
    }
  }

  result.llm_calls = reflectTokenStats.pass_d_resolve.calls - callsBefore;
  return result;
}
