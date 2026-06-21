// ═══════════════════════════════════════════════════════════════════════════════
// PIPELINE v2 (TRANSFORM) — COMPREHEND fragment: schema + SEAM 1 + converter
// ═══════════════════════════════════════════════════════════════════════════════
//
// Design: docs/PIPELINE-TRANSFORM-DESIGN.md + docs/PIPELINE-V2-MOVING-PARTS.md.
//
// This is build STEP 2 (the schema foundation). $0 / no LLM. Default-OFF
// (NODEDEX_PIPELINE_V2). NOTHING here is wired into the live pipeline yet — it is
// the contract + the deterministic code that proves the fragment maps onto the
// EXISTING machinery (so LLM 2 / WRITE reuse is real, not aspirational).
//
// WHAT COMPREHEND (LLM 1, built in step 3) will emit:
//   one holistic read of an arc → topic GROUPS → typed schema blocks + the
//   within-group causal links it READ from the prose + a provenance excerpt per
//   block + PROVISIONAL names. It replaces Pass 0+1+JUDGE+2a+2b+2c and kills Pass
//   2c's O(n²) (links are read, not pair-compared).
//
// THE BRIDGE (this file): `comprehendResultToPass2Items` flattens the grouped
// fragment into Pass2Item[] — the exact shape Pass 3 / resolve / dedup / WRITE
// already consume. The within-group links distribute onto Pass2Item's existing
// causal fields (triggered_by_items / based_on_items / extends_item / relations).
// So the v2 producer feeds the v1 consumer: swap the engine, not the car.
//
// MEANING-FIRST reuse (not a parallel vocabulary):
//   - types + unique{} field shape ← schema-validator.ts (TYPE_UNIQUE_SCHEMA /
//     validateUniqueSchema) — the SAME source of truth Pass 2/save use.
//   - link relation types ← the subset of pipeline.ts ALLOWED_RELS a holistic
//     READ produces (see COMPREHEND_LINK_RELS).
//   - block shape ← Pass2Item (types.ts).
//
// NAMING IS PROVISIONAL ONLY here. Canonical strict labels + project-root
// resolution happen in LLM 2 (INTEGRATE), AFTER resolve — naming-before-resolve
// is the root-fork bug (recognizer design, Insight 2).

import { TYPE_UNIQUE_SCHEMA, validateUniqueSchema } from "./schema-validator.js";
import { getThinkingBudget, modelOverride, intFromEnv } from "./config.js";
import type { Pass1Item, Pass2Item, PipelineCheckpoint } from "./types.js";
import type { LLMProvider } from "../../engine/ai-provider.js";

// ─── Flag gate ──────────────────────────────────────────────────────────────
// Default OFF. Mirrors recognizerEnabled() ("1" convention). The current
// pipeline stays the default until the A/B (§12) earns a flip.
export function pipelineV2Enabled(): boolean {
  // ⚠ OLD v1 PIPELINE — DO NOT TURN ON. v2 (COMPREHEND / transform) is the ONLY
  // extraction engine in this release. The v1 front-half (pass2a / pass2c /
  // pass_judge / split-orchestrator / seams / quarantine / synthesizeFromSceneCard)
  // is RETIRED — kept in-tree for reference only, never executed. The
  // NODEDEX_PIPELINE_V2 env var is now INERT: there is no off-switch back to v1.
  // (Pre-release, =0 ran the v1 front-half as the primary engine; that path is
  // intentionally unreachable now.)
  return true;
}

/** Bounded inline retry budget for the v2 ARC path — applied at BOTH failure sites:
 *  the front-half (COMPREHEND failed / SEAM-1 invalid / threw) AND the back-half
 *  (Pass 3 returned a re-queue checkpoint = items dropped). On exhaustion the arc
 *  FAILS CLEAN: turns are left re-extractable (never marked extracted with unsaved
 *  residue) and — v2-only — it NEVER auto-falls to v1. A fresh COMPREHEND / a
 *  resume-from-pass3 re-run recovers LLM-variance failures; the cap stops a
 *  deterministic fault from looping. Default 2 (→ up to 3 attempts total); set 0 to
 *  fail clean on the first failure. NODEDEX_ARC_MAX_RETRIES. */
export function arcMaxRetries(): number {
  return intFromEnv("NODEDEX_ARC_MAX_RETRIES", 2, 0);
}

// Gap (cost): v2-aware LAZY CAPTURE. The v2 arc engine re-reads the RAW transcript
// and IGNORES the per-turn pass01 items, so running Pass 0-1 at capture is pure
// waste in v2 mode (~25% of an arc's spend). When ON, the per-turn capture stores
// the raw transcript + marks the turn arc-ready WITHOUT running Pass 0-1. If v2
// later fails at arc, the v1 fallback fills Pass 0-1 lazily from the raw transcript
// (so the safety net is preserved — the cost just moves to the rare failure path).
// Default ON (promoted 2026-06-14 — validated ~42% capture-cost win); set =0 to opt out.
// Only meaningful when v2 is the engine.
export function v2LazyCaptureEnabled(): boolean {
  return process.env.NODEDEX_V2_LAZY_CAPTURE !== "0";
}

// ─── Within-group link relations COMPREHEND may emit ──────────────────────────
// The subset of pipeline.ts ALLOWED_RELS that a holistic READ of the prose
// produces. EXCLUDES: superseded_by (auto-inverse, written at WRITE), part_of /
// member_of (structural containment / clustering, not the causal thread — wired
// at WRITE from project resolution + groups).
// ⚠ KEEP IN SYNC with ALLOWED_RELS in pipeline.ts (it is duplicated inline there,
//   not exported; if that set changes, change this).
export const COMPREHEND_LINK_RELS: ReadonlySet<string> = new Set([
  "prompted_by",  // consequence → trigger   → Pass2Item.triggered_by_items[]
  "based_on",     // conclusion → evidence   → Pass2Item.based_on_items[]
  "extends",      // specific → broader      → Pass2Item.extends_item (single)
  "supersedes",   // new → old               → Pass2Item.supersedes_ref (single)
  "resolves",     // answer → question       → Pass2Item.resolved_ref (single)
  "supports",     // fact → hypothesis       → Pass2Item.relations[]
  "contradicts",  // A ↔ B                   → Pass2Item.relations[]
  "related_to",   // A ↔ B                   → Pass2Item.relations[]
  "derived_from", // derived → source        → Pass2Item.relations[]
  "affects",      // agent → patient (x-proj)→ Pass2Item.relations[]
]);

// ═══════════════════════════════════════════════════════════════════════════════
// The COMPREHEND fragment (LLM 1 output schema)
// ═══════════════════════════════════════════════════════════════════════════════

/** One typed knowledge block inside a group. Designed to convert 1:1 to a
 *  Pass2Item. `local_id` is an arc-local handle for within-group linking — NOT a
 *  graph id; the canonical strict label is assigned later by LLM 2. */
export interface ComprehendBlock {
  local_id: string;                  // unique within the result; used by links
  type: string;                      // an epistemic type (block-types.md); novel ok with schema{}
  unique: Record<string, string>;    // type-specific identity fields (TYPE_UNIQUE_SCHEMA)
  schema?: Record<string, string>;   // novel types only — field → what it captures
  essence: string;                   // one sentence, ≤120 chars: what + why it matters
  concepts?: string[];               // provisional tags (label {concept} dimension)
  provisional_name?: string;         // {concept} guess; NOT the canonical label
  provenance: string;                // REQUIRED — verbatim excerpt (anti-confab + dedup evidence)
  keep_reason?: string;              // why this is residue not noise. A/B diagnostic — travels to the
                                     // turn-log like other reasoning fields, NOT a block column.
  type_reasoning?: string;           // why THIS type's epistemic role fits (vs a neighbouring type).
                                     // Diagnostic — travels to the turn-log, NOT a block column, and NOT
                                     // the unique{} `reason` (which is content). Charter §5: LLM steps
                                     // record their reasoning; here it also CoT-improves the type choice.
  uncertain?: boolean;               // extracted with incomplete context (save-first, clarify later)
}

/** A causal link COMPREHEND READ from the prose. `from` is the block that HOLDS
 *  the relation (the source); `to` is the target. Both are local_ids. */
export interface ComprehendLink {
  from: string;
  to: string;
  type: string;                      // a COMPREHEND_LINK_RELS member
  reasoning?: string;                // why the link (carried to Pass2Item.relations[].reasoning where applicable)
}

/** A coherent thread the conversation actually had (the roaster-choice
 *  discussion, the sourcing thread). A group ≈ a chain and feeds the
 *  {project}/{concept} label dims (chain_id-from-groups, build step 5). */
export interface ComprehendGroup {
  group_id: string;                  // arc-local
  topic: string;                     // human-readable thread label
  provisional_project?: string;      // a GUESS; LLM 2 resolves the real root
  blocks: ComprehendBlock[];
  within_group_links: ComprehendLink[];
}

export interface ComprehendResult {
  groups: ComprehendGroup[];
  reasoning?: string;                // diagnostic: segmentation rationale
}

// ═══════════════════════════════════════════════════════════════════════════════
// SEAM 1 — validate the fragment before it propagates
// ═══════════════════════════════════════════════════════════════════════════════
//
// SOFT-tiered, mirroring schema-validator.ts: ERRORS are hard structural breaks
// (no provenance, dup id, missing type) → the fragment is not usable as-is.
// WARNINGS are recoverable shape issues (unique{} key mismatch, decision without
// based_on, unknown block type, an unknown link RELATION, and a DANGLING link
// ENDPOINT) → kept, surfaced. `valid` = no errors.
//
// LINKS are never fatal (2026-06-12, demoted from error after a live arc): a
// dangling endpoint is the LLM's most predictable slip — it remembers the MEANING
// of the target but not the exact local_id it assigned (charter rule 4: exact
// bookkeeping is an LLM weak skill). The converter already defensively SKIPS
// unresolvable links, and links have three repair nets downstream (JUSTIFY for a
// decision's empty based_on, the cross-group linker, Pass 4 + island-heal). One
// droppable link must not abort 30+ good blocks — failing the whole fragment here
// cost a full v1 re-run and discarded a better v2 result (a guard overriding
// successes, charter rule 6). BLOCK-level breaks stay fatal: a missing provenance
// is unrepairable downstream (anti-confab), a dup id corrupts every reference.

export type ComprehendIssueSeverity = "error" | "warning";

export interface ComprehendValidationIssue {
  severity: ComprehendIssueSeverity;
  message: string;
  group_id?: string;
  local_id?: string;
}

export interface ComprehendValidation {
  valid: boolean;                    // true ⇔ zero errors (warnings allowed)
  errors: ComprehendValidationIssue[];
  warnings: ComprehendValidationIssue[];
}

export function validateComprehendResult(result: unknown): ComprehendValidation {
  const errors: ComprehendValidationIssue[] = [];
  const warnings: ComprehendValidationIssue[] = [];
  const err = (message: string, group_id?: string, local_id?: string) =>
    errors.push({ severity: "error", message, group_id, local_id });
  const warn = (message: string, group_id?: string, local_id?: string) =>
    warnings.push({ severity: "warning", message, group_id, local_id });

  const r = result as ComprehendResult | null | undefined;
  if (!r || typeof r !== "object" || !Array.isArray(r.groups)) {
    err("result.groups is missing or not an array");
    return { valid: false, errors, warnings };
  }
  // Legitimately empty = the session had no residue worth saving. VALID → the
  // pipeline saves nothing (not an error, not a retry). Distinct from malformed
  // above. A real outcome of the worth gate (e.g. pure debugging chatter — the
  // noise trap that produced the old 87-job junk).
  if (r.groups.length === 0) return { valid: true, errors, warnings };

  // local_ids are GROUP-SCOPED — the LLM numbers blocks per group (block_1, block_2,
  // … restart in each group). So uniqueness + link resolution are checked WITHIN
  // each group; within_group_links only reference blocks of their own group (a
  // reference to another group's block = not a within-group link → LLM 2's job, and
  // surfaces here as "no block in this group"). The converter qualifies ids by
  // group to make them globally unique downstream.
  for (const group of r.groups) {
    const gid = group?.group_id;
    if (!gid) err("group missing group_id");
    if (!Array.isArray(group?.blocks)) {
      err("group missing blocks[]", gid);
      continue;
    }

    const idsInGroup = new Set<string>();
    const decisionIds = new Set<string>();
    for (const b of group.blocks) {
      const lid = b?.local_id;
      if (!lid) {
        err("block missing local_id", gid);
        continue;
      }
      if (idsInGroup.has(lid)) err(`duplicate local_id "${lid}" within group`, gid, lid);
      idsInGroup.add(lid);

      if (!b.type) {
        err("block missing type", gid, lid);
      } else {
        if (b.type === "decision") decisionIds.add(lid);
        // Unknown type with no schema{} → warning (novel types are trusted IF
        // they declare schema{}, exactly like schema-validator.ts).
        if (!(b.type in TYPE_UNIQUE_SCHEMA) && !b.schema) {
          warn(`unknown type "${b.type}" without schema{}`, gid, lid);
        }
      }

      if (!b.provenance || !b.provenance.trim()) {
        err("block missing provenance excerpt", gid, lid);       // HARD — anti-confab key
      }
      if (!b.essence || !b.essence.trim()) {
        warn("block missing essence", gid, lid);
      }
      // unique{} key-set shape — SOFT (reuse the save-time validator)
      const chk = validateUniqueSchema(b.type, b.unique);
      if (!chk.ok) warn(`unique{} ${chk.detail}`, gid, lid);
    }

    // Links resolve WITHIN this group. ALL link defects are warnings — every one
    // is dropped at convert (the converter skips unresolvable/unknown links), and
    // a dropped link is repairable downstream; a degraded arc is not (see the seam
    // header). A dangling endpoint usually means the LLM renamed a block it DID
    // emit (it recalls the meaning, not the exact id) — the blocks are fine.
    const links = Array.isArray(group?.within_group_links) ? group.within_group_links : [];
    const hasBasedOnFrom = new Set<string>();
    for (const link of links) {
      if (!COMPREHEND_LINK_RELS.has(link?.type)) {
        warn(`link with unknown/unsupported relation "${link?.type}" (dropped at convert)`, gid);
      }
      if (!idsInGroup.has(link?.from)) warn(`link.from "${link?.from}" references no block in this group (dropped at convert)`, gid);
      if (!idsInGroup.has(link?.to)) warn(`link.to "${link?.to}" references no block in this group (dropped at convert)`, gid);
      // Only a link that will actually SURVIVE convert satisfies the decision's
      // based_on requirement — a dangling one is dropped, leaving the decision
      // unwired, which the warning below must report truthfully (JUSTIFY's
      // detect step then finds the genuinely-empty based_on and repairs it).
      if (link?.type === "based_on" && link?.from && idsInGroup.has(link?.to)) hasBasedOnFrom.add(link.from);
    }

    // decision must be justified by ≥1 based_on (block-types.md:54). SOFT: if the
    // evidence isn't in the transcript that's a flag, not a fabrication.
    for (const did of decisionIds) {
      if (!hasBasedOnFrom.has(did)) {
        warn("decision has no based_on link (block-types.md requires one)", gid, did);
      }
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}

/** Bucket COMPREHEND validation WARNINGS for a quieter, honest log line. Most fire on
 *  the raw draft and are REPAIRED DOWNSTREAM — unique{} shape by Pass 2b fill, dangling
 *  within-group links dropped at convert, a decision's missing based_on by JUSTIFY — so
 *  counting them raw made a clean arc look alarming ("warnings=35"). `notable` is the few
 *  worth a glance (missing essence, unknown type, a group with no topic/root). Pure. */
export function summarizeWarnings(warnings: ComprehendValidationIssue[]): string {
  let draft = 0;
  let notable = 0;
  for (const w of warnings ?? []) {
    const m = w?.message ?? "";
    if (m.includes("unique{}") || m.includes("link") || m.includes("based_on")) draft++;
    else notable++;
  }
  return `${notable} notable` + (draft ? `, ${draft} draft (repaired downstream)` : "");
}

// ═══════════════════════════════════════════════════════════════════════════════
// CONVERTER — fragment → Pass2Item[] (the bridge to the existing downstream)
// ═══════════════════════════════════════════════════════════════════════════════

export interface ComprehendConversion {
  items: Pass2Item[];
  /** qualified item id (`{group_id}::{local_id}`) → group_id. Carries the grouping
   *  forward so chain_id can be stamped from groups (build step 5) instead of
   *  re-derived. */
  groupByItemId: Record<string, string>;
}

/** Group-scoped local_id → a globally-unique Pass2Item id. The LLM numbers
 *  blocks per group (block_1 in every group), so we namespace by group. */
function qualifyId(groupId: string, localId: string): string {
  return `${groupId}::${localId}`;
}

/**
 * Distribute ONE link onto the SOURCE item's existing causal field by relation
 * type — the single source of truth for the link→field mapping. Used by the
 * within-group converter AND the cross-group linker (cross-group-link.ts) so they
 * never drift on which field a relation lands in. Caller must pre-validate that
 * `type` ∈ COMPREHEND_LINK_RELS and that `toId` resolves to a real item.
 */
export function applyLinkToPass2Item(
  from: Pass2Item,
  type: string,
  toId: string,
  reasoning?: string,
): void {
  switch (type) {
    case "prompted_by": from.triggered_by_items.push(toId); break;
    case "based_on":     from.based_on_items.push(toId);    break;
    case "extends":      from.extends_item = toId;          break; // single; last wins
    case "supersedes":   from.supersedes_ref = toId;        break;
    case "resolves":     from.resolved_ref = toId;          break;
    default: // supports / contradicts / related_to / derived_from / affects
      (from.relations ??= []).push({ type, target: toId, reasoning });
      break;
  }
}

/**
 * A project name is a single label DIMENSION ({project}_{entity}_{type}_{concept}),
 * so it MUST be hyphens-only — an underscore would fake a dimension boundary and
 * make Pass 3 fork a DUPLICATE root (the hyphenated project_creates root vs the
 * verbatim underscore block label). COMPREHEND occasionally emits underscores
 * (e.g. "backend_api_service"); the other passes enforce hyphens via a PROMPT
 * instruction (pass0/pass3), which COMPREHEND doesn't carry — so we enforce it
 * deterministically here, where item.project is born. Lossless for already-valid
 * names; undefined in → undefined out (no project). (Run 9 big-arc bug.)
 */
export function normalizeProjectName(p: string | undefined): string | undefined {
  if (!p) return undefined;
  const out = p.trim().toLowerCase()
    .replace(/[\s_]+/g, "-")    // underscores + whitespace → hyphen (the dimension rule)
    .replace(/[^a-z0-9-]/g, "") // strip anything not lowercase-alnum-hyphen
    .replace(/-+/g, "-")        // collapse repeats
    .replace(/^-|-$/g, "");     // trim edge hyphens
  return out.length > 0 ? out : undefined;
}

/** The most common normalized provisional_project across an arc's groups — the arc's
 *  ROOT to inherit when an individual group's guess is missing. Groups in one arc
 *  usually belong to ONE root, so inheriting the dominant guess keeps clusters together
 *  rather than fragmenting (each empty group otherwise becoming its own topic-named
 *  root). undefined only when NO group named a project. Pure / testable. */
export function dominantProvisionalProject(groups: ComprehendGroup[]): string | undefined {
  const counts = new Map<string, number>();
  for (const g of groups ?? []) {
    const p = normalizeProjectName(g.provisional_project);
    if (p) counts.set(p, (counts.get(p) ?? 0) + 1);
  }
  let best: string | undefined;
  let bestN = 0;
  for (const [p, n] of counts) if (n > bestN) { best = p; bestN = n; }
  return best;
}

/**
 * Flatten the grouped fragment into Pass2Item[], distributing each within-group
 * link onto the SOURCE item's existing causal field by relation type. local_ids
 * are GROUP-SCOPED → qualified to `{group_id}::{local_id}` for global uniqueness;
 * links resolve within their own group. Pure + defensive: skips links whose
 * endpoints don't resolve (the validator reports those as errors; the converter
 * must not throw on them).
 *
 * NOTE: `project` is set to the group's PROVISIONAL project. LLM 2 / the
 * recognizer overrides it with the canonical root before WRITE.
 */
export function comprehendResultToPass2Items(result: ComprehendResult): ComprehendConversion {
  const items: Pass2Item[] = [];
  const groupByItemId: Record<string, string> = {};
  const itemById = new Map<string, Pass2Item>();

  // item.project is BORN here from the GUESS (provisional_project). The holistic
  // COMPREHEND schema once made that guess OPTIONAL, so it could arrive empty — and an
  // undefined item.project starves the recognizer (newRootCandidateNames skips
  // undef-project items) AND leaves Pass 3 to coin a placeholder root (the "group_1"
  // regression, 2026-06-14). Guarantee a real name: the group's own guess, else the
  // arc's DOMINANT guess (groups in one arc usually share a root — keeps "one root,
  // many clusters" instead of fragmenting on topic), else the group's topic. Only
  // undefined when the arc named nothing at all.
  const arcRoot = dominantProvisionalProject(result.groups ?? []);

  for (const group of result.groups ?? []) {
    const gid = group.group_id;
    const groupProject =
      normalizeProjectName(group.provisional_project) ?? arcRoot ?? normalizeProjectName(group.topic);
    for (const b of group.blocks ?? []) {
      const id = qualifyId(gid, b.local_id);
      const item: Pass2Item = {
        id,
        text: b.essence ?? "",
        type: b.type,
        project: groupProject,
        unique: b.unique,
        schema: b.schema,
        excerpt: b.provenance,
        triggered_by_items: [],
        based_on_items: [],
        relations: [],
        // Observability: the LLM's own worth + typing rationale MUST survive to the
        // turn-log (charter rule 8 — diagnose from reasoning). Dropped here before
        // 2026-06-12 → per-turn v2 logs had no auditable reasoning. Pass 3 strips
        // these from its prompt copy, so they never reach a downstream LLM.
        keep_reason: b.keep_reason,
        type_reasoning: b.type_reasoning,
      };
      if (b.uncertain) item.review_reason = "comprehend_uncertain";
      items.push(item);
      itemById.set(id, item);
      groupByItemId[id] = gid;
    }
  }

  for (const group of result.groups ?? []) {
    const gid = group.group_id;
    for (const link of group.within_group_links ?? []) {
      // Drop links the model mis-typed (a relation outside COMPREHEND_LINK_RELS —
      // usually a unique{} field name). SEAM 1 warns; the info lives in the block's
      // own field. Dropping here keeps junk relations out of the graph.
      if (!COMPREHEND_LINK_RELS.has(link.type)) continue;
      const fromId = qualifyId(gid, link.from);
      const toId = qualifyId(gid, link.to);
      const from = itemById.get(fromId);
      if (!from || !itemById.has(toId)) continue; // the designed drop — seam 1 warns on these (never fatal)
      applyLinkToPass2Item(from, link.type, toId, link.reasoning);
    }
  }

  return { items, groupByItemId };
}

// ═══════════════════════════════════════════════════════════════════════════════
// BRIDGE TO RUNNABLE — fragment → a Pass-3-resume checkpoint
// ═══════════════════════════════════════════════════════════════════════════════
//
// runAutoReflect already supports resuming from a checkpoint: when
// `checkpoint.pass2Classified` is set it SKIPS Pass 0/1/2 and runs Pass 3+ on
// those items (pipeline.ts:934). v2 reuses that seam — COMPREHEND produces the
// classified items, this builds the checkpoint, and the EXISTING back-half
// (Pass 3→5 + recognizer/Stage D + chain-stamp) runs unchanged. No hot-path edit.
//
// pass1Items are derived (minimal) so Pass 3's budget hint + any pass1 reference
// is satisfied; pass0.sceneCard is left undefined (Pass 3 handles its absence).

export function comprehendResultToCheckpoint(result: ComprehendResult): PipelineCheckpoint {
  const { items } = comprehendResultToPass2Items(result);
  const pass1Items: Pass1Item[] = items.map((it) => ({
    id: it.id,
    text: it.text,
    source: "comprehend",
    excerpt: it.excerpt ?? "",
    provisional_type: it.type,
  }));
  return {
    resumeFrom: "pass3",
    pass0: { sceneCard: undefined, raw: undefined },
    pass1Items,
    pass2Classified: items,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// LLM 1 — COMPREHEND: the prompt + the call (build step 3)
// ═══════════════════════════════════════════════════════════════════════════════
//
// One holistic read of the whole session → grouped typed blocks + the links it
// READ from the prose + provenance. Replaces Pass 0/1/JUDGE/2a/2b/2c. The output
// is validated by SEAM 1 (validateComprehendResult) and converted to Pass2Item[]
// (comprehendResultToPass2Items) which the EXISTING Pass 3+ back-half consumes.
//
// Prompt discipline (PROMPT-CHARTER): reason about MEANING, never match surface
// words; universal across domains (no signal words, no domain examples); reuse the
// worth spine + STATE CONVENTION verbatim from the current JUDGE/Pass-1 prompts;
// types defined by epistemic role, not text shape.

export const COMPREHEND_PROMPT = `You read ONE complete work session between a user and an AI agent, and transcribe
its already-structured story into the memory schema. Read the whole session first,
then write.

Decide EVERYTHING by reasoning about MEANING in this session's context — what role
each piece played in what actually happened here. Never decide by matching surface
words, phrasings, or connectors. The same meaning appears in countless wordings
across domains; you are reading for the structure beneath the words.

── STATE CONVENTION ─────────────────────────────────────────────────────────
"State" = text in the TRANSCRIPT below. Your training knowledge and "what's
commonly known" are NOT state. Every block must quote a verbatim excerpt from the
transcript as its provenance. If it is not in the transcript, do not write it.
Familiarity ≠ recorded.

── WHAT TO KEEP (reason per candidate, from this session) ───────────────────
Keep the irreplaceable RESIDUE of this session — what was DECIDED, TRIED-AND-
ABANDONED, CONSTRAINED, OBSERVED, or STATED here — together with the REASONING.

The spine question, per candidate:
  "Could a competent model — given the project context but WITHOUT having lived
   this session — already produce this?"
     YES → it is knowledge the model already carries → do not emit.
     NO  → it exists only because this session happened → emit it.

Asymmetric cost: anything that exists ONLY because this session happened is
unrecoverable once dropped — not just a decision / dead_end / constraint, but also a
session-specific observation, measurement, or stated value. Only what the model
ALREADY carries regenerates for free; a value measured or stated here is not that.
When unsure → keep.

Consulting the agent's own memory is not such a happening. A statement whose subject
is that MEMORY itself — that what is already stored is complete, was reviewed, or that
reading it changed nothing — is not residue, even though the reading occurred this
session; reading memory is not an action in the work. Emit only what the work produced
about ITS subject, never the agent's reading of what it had already stored.

A conclusion's EVIDENCE is residue too — the observation, measurement, or result it
is reasoned from. Keep it as its own block and ground the conclusion to it
(based_on / supports); a conclusion saved without what it rests on is
half the record. Keep that evidence EVEN when nothing links to it yet — a later
session grounds it; never drop a session-specific observation for lack of a link.

Do not emit:
  • an option that was only RAISED in thought — never chosen, entered, or acted on.
  • a bare sequence of steps carrying no reason that nothing rests on — the WHEN with
    no WHY. (A step or value a conclusion is reasoned from is not bare — keep it.)

If the same claim appears more than once in the session (e.g. restated in a recap),
write it once, using its most complete statement.

If the session holds no residue at all — pure procedure, scaffolding, or chatter —
write nothing. An empty result is correct when nothing here could only have come
from this session.

Every block carries keep_reason: one line, from the session, naming what makes it
residue (it was chosen / entered-then-abandoned / imposed / measured / asserted by
a party), or why you kept it when it was borderline.

Every block also carries type_reasoning: one line stating why THIS type's epistemic
role fits — what distinguishes it from the neighbouring types, judged by the role the
block plays for a future reader, not by surface wording. Decide this before you commit
the type.

── STEP 1 — SEGMENT into GROUPS (clusters under a root) ─────────────────────
FIRST split the session into GROUPS. A group is one coherent sub-thread — a single
problem worked, question pursued, or thing decided. KEEP DISTINCT SUB-THREADS AS
SEPARATE GROUPS even when they belong to the same overall project; one sub-thread
scattered across the session is one group. Judge by what the participants were
trying to do, not by topic words. Do NOT collapse several sub-threads into one big
group — keep them fine-grained.

THEN assign each group a provisional_project — the ONE overarching ROOT it belongs
to. The ROOT is the project; the GROUP is a CLUSTER under it; ONE root has MANY
clusters. Sub-threads of the same overall effort SHARE a root but STAY SEPARATE
GROUPS — same root, several clusters; do NOT merge them into one group.
  • Use a DIFFERENT provisional_project ONLY for a genuinely separate topic — a
    real context-switch or an unrelated tangent.
  • A separate root must have a NAMEABLE SUBJECT: you must be able to say what the
    group's work is ABOUT without referring to the speaker's own remembering,
    reasoning, or composing of replies in this conversation. Recalling, weighing,
    and planning how to respond are the MEANS of every conversation, never a topic
    of their own — claims born of that procedure belong under the root of the work
    they serve (and only those that pass the residue test above).
  • When unsure whether two groups share a root, prefer the SAME root — splitting
    one topic across many roots (fragmentation) is worse than a slightly-broad root.
  • NAME the root with the most SPECIFIC identifier the session gives the SUBJECT the
    work is ABOUT — named as specifically as the session itself names it. NEVER a
    generic category word, a placeholder, or the group_id. If nothing that specific is
    named, use the clearest phrase for what the work is about — never a bare
    "group"/number. lowercase, hyphens only, no underscores. provisional_project must
    always be filled.
This is provisional; cross-SESSION matching to existing roots happens later.

── STEP 2 — within each group, write TYPED blocks ───────────────────────────
A type is the agent's RELATIONSHIP to the knowledge, not its subject matter — the
same type spans every domain. For each piece of residue, reason about which
relationship fits, then FILL THAT TYPE'S unique{} FIELDS — this is the block's
structured identity and is REQUIRED, never empty. Put the actual content there
(the choice + reason, the value, the limit, the approach + why it failed), in the
session's own language. essence is only a one-line SUMMARY of those fields — it
does not replace them. A block whose unique{} is empty is incomplete; fill every
field of the type that the session supports. One passage can carry several
relationships → several blocks.

CORE relationships (consider these first):
  decision   {choice, reason, alternatives_rejected} — the participants CLOSED a
             fork: a path was committed to, adopted, or acted on. The decision is
             the path TAKEN; a path they CLOSED OFF is a dead_end (below), not a
             decision — even when one passage both settles the choice and rules out
             the alternative. A path one participant PUT FORWARD for another to
             accept leaves the fork open — that is a blueprint (below), not a
             decision, no matter how strongly it was urged. To type decision you
             must be able to point at WHERE the fork closed, not just where a path
             was proposed. Justify it: link based_on >=1 fact/constraint (Step 3).
  dead_end   {approach, reason, alternative} — an approach CLOSED OFF for a stated
             reason, so a future reader should not re-open it. Covers one tried then
             abandoned AND one evaluated and definitively rejected before trying. A
             path merely floated with no verdict is NOT a dead_end — the close-off
             must be definite and reasoned.
  constraint {limit, reason, source} — a boundary that bounds EVERY option and that
             the participants must work within. May be imposed from outside OR set by
             the participants as a fixed limit; what makes it a constraint is that it
             GOVERNS the other choices rather than being one of them.
  fact       {value, why_matters} — a specific observed value or concrete state.
  insight    {observation, implication} — a realization drawn from combining things.
  blueprint  {purpose, status, trigger_to_implement} — a planned or proposed path
             whose outcome is not yet settled: a plan adopted but not yet executed,
             OR a path put forward that no one has yet accepted. The fork is still
             open; when it later closes, a decision supersedes this.
  preference {lean, over, condition} — a standing lean that shapes future choices,
             short of a committed decision.
  question   {question, why_matters} — left genuinely open, with no path forward.

When the level of commitment is unclear, type the LESS-committed role (blueprint
over decision, preference over constraint): the residue is still captured, and a
later session promotes it (a decision supersedes its blueprint). A false decision
misleads every future reader into treating an open fork as closed.

OTHER roles, with their REQUIRED fields (fill these exact field names), when none of
the above fits:
  hypothesis {proposal, evidence_against} — a claim offered as possibly true but
             NOT yet verified: reasoned TOWARD, not asserted as established. What it
             rests on is recorded as its OWN block and linked (based_on), not
             restated here; evidence_against is only what would weigh against it.
  entity     {name, role} — a thing the work REFERS TO by name, not a claim about it;
             identity is the name, role is the part it plays in the work.
  task       {status, description, owner} — work still TO BE DONE, tracked by its state
             of completion and who holds it.
  event      {what_happened, outcome, date} — a thing that OCCURRED at a point in time,
             as opposed to a standing truth that simply holds.
  note       {} — no field schema; the catch-all, only when no sharper role fits.
If a genuinely distinct epistemic role STILL fits none of these, name the type and
include schema{} (field -> what it captures).

Each block also carries: essence (one sentence, <=120 chars — what it is and why
it matters), concepts (a few terms naming what it is about), provisional_name (a
short slug for the thing — provisional, not a final label), provenance, keep_reason.

── STEP 3 — WIRE the relationships WITHIN each group ─────────────────────────
Where the session shows one block standing in a real relationship to another —
one thing led to another, justified it, replaced it, answered it, elaborates it,
provides evidence for it, or conflicts with it — record that link. Infer it from
what happened, whether or not any connecting word is present.

Each link is {from, to, type}, where "from" holds the relationship. Choose the
type whose MEANING matches:
  prompted_by  — from happened as a consequence of to (to is the trigger)
  based_on     — from is a conclusion grounded in to (evidence)
  extends      — from is a more specific case of to (broader)
  supersedes   — from replaces an earlier to
  resolves     — from answers the open question to
  supports     — from is evidence for the proposal to
  contradicts  — from and to conflict
  related_to   — from and to are associated, with no sharper relationship
  derived_from — from was reasoned out from to
  affects      — from has an impact on to

Reach for the SHARPEST relation the meaning supports. related_to and affects are the
WEAKEST — a last resort, used ONLY when no grounding, consequence, replacement, or
answer actually holds.

Every block sits in a HISTORY — wire each way it connects BACKWARD to what came
before, not only its evidence:
  - what it was REASONED FROM: the observation, measurement, or result a later
    realization, boundary, choice, or lean rests on (based_on / supports / derived_from);
  - what it REPLACED: an earlier approach, value, or state this makes obsolete. The
    earlier block stays as history and MUST be linked FROM the newer one (supersedes) —
    never leave a superseded block standing as if nothing replaced it;
  - what TRIGGERED it: the event, failure, or need it arose as a consequence of
    (prompted_by);
  - the open QUESTION it answers (resolves).
The trap to avoid, for ANY block type: a block that REPLACED or was TRIGGERED BY
another, but is wired only to its supporting evidence, leaves that other block
ORPHANED — you recorded why it is justified but dropped what it displaced or
responded to. Both are how the state was reached; wire both.

The link type MUST be exactly one of these ten relations — never invent one, and
never use a block's unique{} field name as a link type. A detail that belongs to a
single block (a decision's rejected alternatives, a constraint's source, and the
like) is recorded INSIDE that block's own fields — never as a link, and never as a
separate block created only so something can link to it.

Every decision — and every hypothesis or insight that rests on a finding — needs >=1
based_on to the observation it is reasoned from. If that evidence is genuinely not in
this session, mark the block uncertain — never supply the evidence yourself.

Stay within this session: do not assign final names, do not match against any
existing memory, do not link across groups. Those are later stages.`;

// Structured-output schema for COMPREHEND. Mirrors ComprehendResult. unique{} and
// schema{} are freeform maps (type:object) — the system's most complex schema, so
// the universality path (tool-use for Anthropic + prompt-JSON fallback, b8513a5)
// carries it; round-trip-verify on the target model before any A/B spend.
export const COMPREHEND_SCHEMA = {
  type: "object",
  properties: {
    groups: {
      type: "array",
      items: {
        type: "object",
        properties: {
          group_id: { type: "string" },
          topic: { type: "string" },
          provisional_project: { type: "string" },
          blocks: {
            type: "array",
            items: {
              type: "object",
              properties: {
                local_id: { type: "string" },
                type: { type: "string" },
                unique: {
                  type: "object",
                  description: "REQUIRED structured identity fields for the type — never empty. e.g. decision: {choice, reason, alternatives_rejected}; fact: {value, why_matters}; dead_end: {approach, reason, alternative}; constraint: {limit, reason, source}; insight: {observation, implication}. Fill from the transcript.",
                },
                schema: { type: "object" },
                essence: { type: "string" },
                concepts: { type: "array", items: { type: "string" } },
                provisional_name: { type: "string" },
                provenance: { type: "string" },
                keep_reason: { type: "string" },
                type_reasoning: { type: "string" },
                uncertain: { type: "boolean" },
              },
              required: ["local_id", "type", "unique", "essence", "provenance", "keep_reason"],
            },
          },
          within_group_links: {
            type: "array",
            items: {
              type: "object",
              properties: {
                from: { type: "string" },
                to: { type: "string" },
                type: { type: "string" },
                reasoning: { type: "string" },
              },
              required: ["from", "to", "type"],
            },
          },
        },
        required: ["group_id", "topic", "provisional_project", "blocks", "within_group_links"],
      },
    },
    reasoning: { type: "string" },
  },
  required: ["groups"],
};

// Model override for COMPREHEND (the bet → strong model). Undefined → provider
// default. Own env var (PassId union has no "comprehend", so modelForPass can't
// route it).
/** Single source for all three COMPREHEND-path callers (here, per-group, cross-link). */
export function comprehendModel(): string | undefined {
  return modelOverride("NODEDEX_COMPREHEND_MODEL");
}

export interface ComprehendCallResult {
  result: ComprehendResult | null;
  validation: ComprehendValidation | null; // SEAM 1 outcome (null when the call itself failed)
  rateLimited: boolean;
  creditExhausted?: boolean;                // the call failed because the account is out of credit (402)
  model?: string;
  attempts?: Array<{ model: string; outcome: string }>;
  usage?: { input: number; thinking: number; output: number }; // returned for cost attribution at the branch
}

/**
 * Run the single COMPREHEND read over a session transcript. Graph-blind: input is
 * the raw transcript ONLY (the caller assembles user+agent turns — the all-sources
 * lesson). Validates via SEAM 1 but does not throw or mutate global token stats —
 * the caller decides retry/quarantine and attributes cost.
 */
export async function callComprehendLLM(
  provider: LLMProvider,
  transcript: string,
  thinkingBudget = 8192,
): Promise<ComprehendCallResult> {
  const userInput = `TRANSCRIPT (one work session — read all of it before writing):\n\n${transcript}`;
  const r = await provider.generateStructured<ComprehendResult>(
    COMPREHEND_PROMPT,
    userInput,
    COMPREHEND_SCHEMA,
    {
      thinkingBudget: getThinkingBudget(thinkingBudget),
      // INTERIM PATCH (latency, not capture): 65536 (the model max) let a runaway
      // generation burn the full budget before failing a JSON.parse → "truncated"
      // → re-roll, costing ~200s+ (the 307s arc). 32768 fails ~2x faster AND gives
      // the provider's 1.5x truncation-bump real headroom (32768→49152, vs a no-op
      // at 65536). Biggest legit fragment seen = 13347 tokens (Run 9, 57 blocks),
      // so 32768 keeps a ~2.4x margin. DEBT this buys time against: the SINGLE
      // monolithic COMPREHEND call is a latency/single-point wildcard — the
      // structural fix is PER-GROUP COMPREHEND (segment once → bounded parallel
      // per-group production; design §11 risk 3). Capture is already safe (a
      // persistent COMPREHEND failure degrades to v1 in arc-pipeline.ts).
      maxOutputTokens: 32768,
      modelOverride: comprehendModel(),
    },
  );

  let validation: ComprehendValidation | null = null;
  if (r.result) {
    validation = validateComprehendResult(r.result);
    const groups = r.result.groups?.length ?? 0;
    const blocks = (r.result.groups ?? []).reduce((n, g) => n + (g.blocks?.length ?? 0), 0);
    console.log(
      `Auto-Reflect COMPREHEND: ${groups} groups, ${blocks} blocks | valid=${validation.valid} ` +
      `errors=${validation.errors.length} warnings: ${summarizeWarnings(validation.warnings)} | ` +
      `tokens: in=${r.usage?.input ?? "?"} think=${r.usage?.thinking ?? "?"} out=${r.usage?.output ?? "?"}`,
    );
    for (const e of validation.errors) {
      console.warn(`  [COMPREHEND error] ${e.message}${e.local_id ? ` (${e.local_id})` : ""}`);
    }
  } else {
    console.warn(`Auto-Reflect COMPREHEND: ${r.rateLimited ? "rate limited" : "failed"} — no fragment produced`);
  }

  return { result: r.result, validation, rateLimited: r.rateLimited, creditExhausted: r.creditExhausted, model: r.model, attempts: r.attempts, usage: r.usage };
}
