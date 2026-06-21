// ═══════════════════════════════════════════════════════════════════════════════
// DEBT 5 Slice 1 Sub-step 1.2 — STAGE C: ARC ENTITY RESOLVE
// ═══════════════════════════════════════════════════════════════════════════════
//
// Runs ONCE per arc trigger BEFORE Pass 2-5 over the consolidated input.
//
// Why this exists (Phase 11 evidence):
//   In our 5-turn arc fixture, per-turn Pass 0 emitted 5 different
//   `scope_project.name` values for what was clearly ONE entity (a Python web
//   service): `json-api-service`, `service`, `this-service`, `the-service`,
//   `system-performance`. Pass 3 trusted those verbatim (pass3.ts:75-77),
//   producing 5 fragmented project roots for one arc.
//
// What this fixes:
//   The MISSING cognitive step #11 (PROJECT-RESOLVE) per
//   docs/PIPELINE-AUDIT-VS-FIRST-PRINCIPLES.md §2. Adds a reconciliation
//   seam at arc time so Pass 3 receives a canonical entity map instead of
//   per-turn-derived noise.
//
// Identity model (per docs/PIPELINE-AUDIT-DEPENDENCY-MAP.md §1):
//   - Within-arc: entity = clustered by LLM judgment using technology +
//     entity + scene-card-scope overlap signals
//   - LLM picks canonical_name following strict {project}_{type}_{concept}
//     naming rule — code does NOT pick names (rule 3 compliance)
//   - Code only assembles the input + parses the output (rule 3 split)
//
// What this does NOT do (Slice 1 scope):
//   - Cross-graph resolution (Slice 3 Stage D — checks scope/owner against
//     existing graph; this is within-arc only)
//   - Auto-merge — only emits canonical_name + cluster. Pass 3 uses the
//     canonical name; system never silently merges blocks.
//   - Flag unresolved mentions to pipeline_flags (could later via
//     'entity_unresolved' flag_type; Sub-step 1.2 just emits them in the
//     unresolved_mentions array for caller to inspect/decide)

import type { LLMProvider } from "../../engine/ai-provider.js";
import type { ConversationTurnRow } from "../../store/database.js";
import type { ArcEntityResolveResult, ArcEntityCluster, ArcEntityMention, Pass2Item } from "./types.js";
import { reflectTokenStats } from "./context.js";
import { getThinkingBudget } from "./config.js";

// Provider model override. Stage C is reasoning-heavy (anaphora judgment +
// canonical-name selection) — same shape as Pass 4 which defaults to Pro for
// Gemini. Defaults to provider's standard; opt-in to Pro via env.
const STAGE_C_MODEL_OVERRIDE = process.env.NODEDEX_STAGE_C_MODEL ?? null;

// ─── Prompt ────────────────────────────────────────────────────────────────────
//
// Design notes (per docs/PIPELINE-SLICE-1-DESIGN.md §7):
//   - Frames the work as ANAPHORA RESOLUTION (LLM-good) not generic-clustering
//   - Forces explicit evidence citation (model can't hand-wave "they seem related")
//   - Defers to LLM for canonical name (rule 3 — naming is LLM's job)
//   - Strict naming rule enforced at prompt level (no underscore in project segment)
//   - Multi-entity arcs explicitly permitted (don't over-cluster legitimately
//     distinct entities like auth-service + billing-service)
//   - Unresolved fallback explicit (not all mentions need to cluster)

export const ARC_ENTITY_RESOLVE_PROMPT = `You receive scene cards from N turns of ONE CONTINUOUS conversation arc.

── YOUR JOB ─────────────────────────────────────────────────────────────────
Identify entities mentioned across these turns. Group anaphoric mentions of
the same entity — where one turn names a thing specifically and a later turn
refers back to it with a generic noun or pronoun-like reference ("the X",
"this one", "it"). For each entity, pick a single canonical_name following the
strict naming rule.

This is ANAPHORA RESOLUTION over a single conversation. The entity IS the
unit the speaker keeps coming back to, even when they switch names for it.

── STATE CONVENTION ─────────────────────────────────────────────────────────
"State" in this prompt = text in the SCENE CARDS region below. Your training
knowledge and "what's commonly true about this domain" are NOT state. An
entity exists ONLY if the scene cards reference it. Familiarity ≠ recorded.

── WHEN TO CLUSTER (group mentions into ONE entity) ─────────────────────────
Two scene cards refer to the SAME entity when:
  - Heavy overlap in technologies mentioned (≥3 shared techs is a strong signal)
  - Same people/actors referenced across both
  - Anaphoric naming pattern: one scene card has a specific name and others
    use a generic noun or back-reference ("the X", "this X", "it") that fits
    the same concept
  - Scene card scope descriptions tell the same story

── WHEN TO KEEP SEPARATE (multiple entities, multiple clusters) ─────────────
Two scene cards refer to DIFFERENT entities when:
  - Disjoint signal sets — the technologies/tools/methods named in one do not
    overlap with the other
  - Different owners/contexts even when the kind of thing is similar (one
    party's instance vs another party's instance of the same kind)
  - The conversation legitimately covers multiple distinct topics

DO NOT force-cluster just because scene cards are sequential. Anaphora is a
LANGUAGE pattern (pronoun referencing) — only group when the signals say
"same entity," not "same conversation."

── CANONICAL NAME (the canonical_name field) ────────────────────────────────
The canonical_name is the project segment of the strict label rule
{project}_{type}_{concept}. Constraints:
  - lowercase, hyphens-only (NO underscores — underscores separate label
    DIMENSIONS, not words within a segment)
  - 2-5 words separated by hyphens
  - Use the MOST SPECIFIC name available across the scene cards: prefer a
    specific name over a generic back-reference — the specific one carries
    information, the generic one doesn't
  - If multiple scene cards agree on a specific name, use that
  - If all scene cards use generic names, synthesize the most specific name
    you can defend from the scope descriptions and the signals present

YOU pick the name. Do not return a bare generic noun just because that's what
some scene cards said — those are anaphoric forms, not the canonical name.

── EVIDENCE (the evidence field — REQUIRED per cluster) ─────────────────────
For each cluster you emit, populate evidence.{shared_technologies,
shared_entities, shared_concepts} with the OBSERVED OVERLAPS that made you
cluster these mentions. Empty arrays are valid when no overlap exists for
that dimension. But at least one of the three should be non-empty for a
real cluster (otherwise there's no evidence).

── REASONING (the reasoning field — REQUIRED per cluster) ───────────────────
For each cluster, the reasoning field MUST:
  1. Name which turns are in this cluster
  2. Name SPECIFIC overlap signals you used (the shared technologies,
     the anaphoric naming pattern, etc.)
  3. Explain why mentions NOT in this cluster were excluded (when applicable)

A reasoning that says only "these mentions are related" without naming
specifics fails. Cite the concrete signals.

── UNRESOLVED MENTIONS (the unresolved_mentions field — OPTIONAL) ──────────
If a turn's scene card is too thin or ambiguous to confidently assign to any
cluster, list it in unresolved_mentions instead of force-fitting. The caller
will decide whether to flag for review or fall back to per-turn naming.

── OUTPUT ───────────────────────────────────────────────────────────────────
Return a JSON object matching this SHAPE (placeholders show structure only —
fill every field from the actual scene cards, do not echo these labels):
  {
    "clusters": [
      {
        "canonical_name": "<specific-hyphenated-name-you-chose>",
        "mentions": [
          { "turn_number": <n>, "scope_project_name": "<what that turn called it>", "item_ids": ["item_T<n>_<id>", ...] }
        ],
        "evidence": {
          "shared_technologies": ["<observed overlapping tool/tech/method names>"],
          "shared_entities":     ["<observed shared people/orgs>"],
          "shared_concepts":     ["<observed shared concept tags>"]
        },
        "reasoning": "<which turns; the SPECIFIC overlap signals used; why excluded mentions were excluded>"
      }
    ],
    "unresolved_mentions": [],
    "arc_resolve_reasoning": "<one line: single- vs multi-entity arc, and why>"
  }`;

const ARC_ENTITY_RESOLVE_SCHEMA = {
  type: "object",
  properties: {
    clusters: {
      type: "array",
      items: {
        type: "object",
        properties: {
          canonical_name: { type: "string" },
          mentions: {
            type: "array",
            items: {
              type: "object",
              properties: {
                turn_number:        { type: "integer" },
                scope_project_name: { type: "string" },
                item_ids:           { type: "array", items: { type: "string" } },
              },
              required: ["turn_number", "scope_project_name", "item_ids"],
            },
          },
          evidence: {
            type: "object",
            properties: {
              shared_technologies: { type: "array", items: { type: "string" } },
              shared_entities:     { type: "array", items: { type: "string" } },
              shared_concepts:     { type: "array", items: { type: "string" } },
            },
            required: ["shared_technologies", "shared_entities", "shared_concepts"],
          },
          reasoning: { type: "string" },
        },
        required: ["canonical_name", "mentions", "evidence", "reasoning"],
      },
    },
    unresolved_mentions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          turn_number:        { type: "integer" },
          scope_project_name: { type: "string" },
          item_ids:           { type: "array", items: { type: "string" } },
        },
        required: ["turn_number", "scope_project_name", "item_ids"],
      },
    },
    arc_resolve_reasoning: { type: "string" },
  },
  required: ["clusters"],
};

// ─── Input building ───────────────────────────────────────────────────────────
//
// Stage C receives the per-turn scene cards stacked + a chronological summary
// of what's available per turn. Pass 0's structured output already carries
// the identity-bearing fields (technologies, projects, scope_project, people)
// — this just formats them for the LLM.
//
// Per-turn item_ids in arc mode follow the `item_T<turn>_<id>` convention
// established in buildArcConsolidatedInput (arc-pipeline.ts:367). Stage C
// emits the same id format in its `mentions[].item_ids` output so Pass 3
// can join correctly.

export interface StageCInputContext {
  agent_id: string;
  turns: ConversationTurnRow[];   // all pass01_done turns in this arc, ASC by turn_number
}

export function buildArcEntityResolveInput(ctx: StageCInputContext): string {
  const header = `[ARC ENTITY RESOLVE — agent_id=${ctx.agent_id}, ${ctx.turns.length} turn(s)]
This is ONE continuous conversation arc. Identify entities across turns and
group anaphoric mentions. Pick canonical names following strict naming rule.
`;

  const sections: string[] = [header];

  for (const turn of ctx.turns) {
    let pass01: any = null;
    try { pass01 = turn.pass01_output_json ? JSON.parse(turn.pass01_output_json) : null; } catch { /* malformed */ }
    const sc = pass01?.scene_card ?? {};

    const scopeName = sc.scope_project?.name ?? "(no scope project)";
    const scopeDesc = sc.scope_project?.scope ?? "";
    const projects: any[] = Array.isArray(sc.projects) ? sc.projects : [];
    const technologies: any[] = Array.isArray(sc.technologies) ? sc.technologies : [];
    const people: any[] = Array.isArray(sc.people) ? sc.people : [];
    const items: any[] = Array.isArray(pass01?.items) ? pass01.items : [];

    // Mirror the arc-prefix id convention from buildArcConsolidatedInput so
    // the LLM emits matching item_ids (Pass 3 joins on these later).
    const itemIds = items.map((it: any) => {
      const cleanId = String(it.id ?? '').replace(/^item_/, '') || '?';
      return `item_T${turn.turn_number}_${cleanId}`;
    });

    sections.push(
`[TURN ${turn.turn_number}${turn.turn_name ? ` — ${turn.turn_name}` : ''}]
Scope project:    ${scopeName}${scopeDesc ? ` — "${scopeDesc}"` : ''}
Projects:         ${projects.length === 0 ? "(none)" : projects.map(p => `${p.name}${p.scope ? ` ("${p.scope}")` : ''}`).join(", ")}
Technologies:     ${technologies.length === 0 ? "(none)" : technologies.map(t => t.name).join(", ")}
People/Actors:    ${people.length === 0 ? "(none)" : people.map(p => `${p.name} (${p.role})`).join(", ")}
Item IDs:         ${itemIds.length === 0 ? "(none)" : itemIds.join(", ")}`
    );
  }

  return sections.join("\n\n");
}

// ─── runArcEntityResolve — orchestrator ───────────────────────────────────────
//
// Public entry point. Called by arc-pipeline.ts at the Stage C insertion
// point (between buildArcConsolidatedInput and PipelineCheckpoint
// construction). Returns:
//   - ArcEntityResolveResult on success — Pass 3 consumes the canonical names
//   - undefined on failure — Pass 3 falls back to per-turn names (today's
//     behavior; graceful degrade so Stage C cannot block extraction)
//
// Telemetry: increments reflectTokenStats.pass_c_resolve (own slot, per
// debt-4 §3 uniform observability — avoids the pre-742f50d mis-attribution
// pattern).

export interface RunArcEntityResolveOpts {
  provider: LLMProvider;
  agent_id: string;
  turns: ConversationTurnRow[];
  /** Stage C is skipped entirely when this is true (Sub-step 1.5 fixture
   * may want to A/B compare with and without). Default false (Stage C runs). */
  disabled?: boolean;
  /** When set, the helper returns AFTER the LLM call without parsing the
   * result schema (used by unit tests). Production callers leave this false. */
  _testHookReturnRaw?: boolean;
}

export async function runArcEntityResolve(
  opts: RunArcEntityResolveOpts,
): Promise<ArcEntityResolveResult | undefined> {
  if (opts.disabled) {
    console.log("[arc-entity-resolve] skipped (disabled flag)");
    return undefined;
  }
  if (opts.turns.length === 0) {
    console.warn("[arc-entity-resolve] no turns to resolve — returning empty result");
    return { clusters: [], unresolved_mentions: [] };
  }
  if (!opts.provider.isAvailable()) {
    console.warn("[arc-entity-resolve] provider unavailable — degrading (Pass 3 will use per-turn names)");
    return undefined;
  }

  const userInput = buildArcEntityResolveInput({ agent_id: opts.agent_id, turns: opts.turns });

  const r = await opts.provider.generateStructured<{
    clusters: Array<{
      canonical_name: string;
      mentions: Array<{ turn_number: number; scope_project_name: string; item_ids: string[] }>;
      evidence: { shared_technologies: string[]; shared_entities: string[]; shared_concepts: string[] };
      reasoning: string;
    }>;
    unresolved_mentions?: Array<{ turn_number: number; scope_project_name: string; item_ids: string[] }>;
    arc_resolve_reasoning?: string;
  }>(
    ARC_ENTITY_RESOLVE_PROMPT,
    userInput,
    ARC_ENTITY_RESOLVE_SCHEMA,
    {
      thinkingBudget: getThinkingBudget(2048),
      maxOutputTokens: 16384,
      modelOverride: STAGE_C_MODEL_OVERRIDE ?? undefined,
    },
  );

  // Telemetry — own slot per debt-4 §3
  if (r.usage) {
    reflectTokenStats.pass_c_resolve.input    += r.usage.input    ?? 0;
    reflectTokenStats.pass_c_resolve.thinking += r.usage.thinking ?? 0;
    reflectTokenStats.pass_c_resolve.output   += r.usage.output   ?? 0;
  }
  reflectTokenStats.pass_c_resolve.calls += 1;

  if (!r.result) {
    const reason = r.rateLimited ? "rate limited" : "failed";
    console.warn(`[arc-entity-resolve] LLM call ${reason} — degrading (Pass 3 will use per-turn names) [${opts.provider.getName()}]`);
    return undefined;
  }

  // Map raw LLM output → typed ArcEntityResolveResult. We trust the schema
  // validator + sanitize defensively (LLM may emit extra fields the schema
  // doesn't reject; we ignore them).
  const clusters: ArcEntityCluster[] = (r.result.clusters ?? []).map(c => {
    const mentions: ArcEntityMention[] = (c.mentions ?? []).map(m => {
      const sourceTurn = opts.turns.find(t => t.turn_number === m.turn_number);
      return {
        turn_id:            sourceTurn?.id ?? `unknown_turn_${m.turn_number}`,
        turn_number:        m.turn_number,
        scope_project_name: m.scope_project_name ?? "",
        item_ids:           Array.isArray(m.item_ids) ? m.item_ids : [],
      };
    });
    return {
      canonical_name: c.canonical_name ?? "",
      mentions,
      evidence: {
        shared_technologies: c.evidence?.shared_technologies ?? [],
        shared_entities:     c.evidence?.shared_entities ?? [],
        shared_concepts:     c.evidence?.shared_concepts ?? [],
      },
      reasoning: c.reasoning ?? "",
    };
  });

  const unresolved: ArcEntityMention[] = (r.result.unresolved_mentions ?? []).map(m => {
    const sourceTurn = opts.turns.find(t => t.turn_number === m.turn_number);
    return {
      turn_id:            sourceTurn?.id ?? `unknown_turn_${m.turn_number}`,
      turn_number:        m.turn_number,
      scope_project_name: m.scope_project_name ?? "",
      item_ids:           Array.isArray(m.item_ids) ? m.item_ids : [],
    };
  });

  console.log(`[arc-entity-resolve] resolved ${clusters.length} cluster(s), ${unresolved.length} unresolved mention(s) [${opts.provider.getName()}]`);

  return {
    clusters,
    unresolved_mentions: unresolved,
    arc_resolve_reasoning: r.result.arc_resolve_reasoning,
    // Provider trail — buildCostBreakdown reads these to bill Stage C in
    // its own pass_c_resolve slot (mirror of 742f50d pass5 own-slot fix).
    model: r.model,
    attempts: r.attempts,
  };
}

// ─── applyArcEntityCanonicalNames — Sub-step 1.3 consumer ────────────────────
//
// Called by pipeline.ts between Pass 2 and Pass 3 in arc mode. Walks Pass 2
// classified items, for each item-id that appears in a Stage C cluster's
// mention.item_ids, overwrites the item's `project` field with the cluster's
// canonical_name. Pass 3 then uses these canonical names (it trusts Pass 2's
// project field verbatim per pass3.ts:75-77, so this is the seam where the
// fix lands without modifying Pass 3's prompt).
//
// Falls through (no mutation) when:
//   - resolution is undefined (Stage C failed or skipped)
//   - resolution.clusters is empty
//   - An item's id doesn't appear in any cluster (unresolved → keep Pass 2's
//     per-turn name)
//
// Returns a NEW items array (does not mutate the input array). Each item is a
// shallow copy with `project` possibly overwritten — preserves all other
// fields exactly.
//
// Per docs/PIPELINE-AUDIT-VS-FIRST-PRINCIPLES.md G2: this is the within-arc
// reconciliation Pass 3 needed but didn't have. Phase 11 5-projects bug fix.

export interface ApplyCanonicalNamesResult {
  items: Pass2Item[];
  renamed_count: number;       // how many items had project overwritten
  clusters_used: number;       // how many distinct clusters contributed renames
  unmatched_item_ids: string[]; // item_ids that no cluster claimed (kept per-turn name)
}

export function applyArcEntityCanonicalNames(
  items: Pass2Item[],
  resolution: ArcEntityResolveResult | undefined,
): ApplyCanonicalNamesResult {
  // Degrade path — no resolution available
  if (!resolution || resolution.clusters.length === 0) {
    return {
      items,
      renamed_count: 0,
      clusters_used: 0,
      unmatched_item_ids: items.map(i => i.id),
    };
  }

  // Build item_id → canonical_name map. If the same item_id appears in
  // multiple clusters (shouldn't happen, but defensive), the first wins.
  const idToCanonical = new Map<string, string>();
  const clustersUsedSet = new Set<string>();
  for (const cluster of resolution.clusters) {
    for (const mention of cluster.mentions) {
      for (const itemId of mention.item_ids) {
        if (!idToCanonical.has(itemId)) {
          idToCanonical.set(itemId, cluster.canonical_name);
        }
      }
    }
  }

  const unmatched: string[] = [];
  let renamedCount = 0;
  const out: Pass2Item[] = items.map(item => {
    const canonical = idToCanonical.get(item.id);
    if (!canonical) {
      unmatched.push(item.id);
      return item;
    }
    if (canonical === item.project) {
      // Already named correctly — count as cluster_used but not as rename
      clustersUsedSet.add(canonical);
      return item;
    }
    // Overwrite project. Shallow copy preserves all other fields.
    renamedCount++;
    clustersUsedSet.add(canonical);
    return { ...item, project: canonical };
  });

  return {
    items: out,
    renamed_count: renamedCount,
    clusters_used: clustersUsedSet.size,
    unmatched_item_ids: unmatched,
  };
}
