// ═══════════════════════════════════════════════════════════════════════════════
// PASS 2 SEAMS — Week 1, debt #1 (2026-05-25)
//
// Role:  Pure-function validators between the Pass 2 sub-passes.
//        Per PASS2-SPLIT-DESIGN.md §3, this is where Tier 1B moves from
//        save-time soft-flag to seam-time HARD CONTRACT.
//
//   Seam α (2a → 2b → validate → 2c-or-quarantine):
//     - 2a emits classified items (type, project, reasoning); 2b fills unique{}
//     - This validator checks the type↔unique{} contract
//     - On failure: caller may route back to 2a (one retry) or quarantine
//
//   Seam β (2b → 2c):
//     - 2c is forbidden to mutate type/unique/text/id (§1 contract)
//     - This validator asserts the invariant before 2c runs
//
// What this module does NOT do:
//   - It does NOT call any LLM (no `pass2a.ts` import; that's a separate file)
//   - It does NOT write to the database directly (callers do, after deciding
//     route-back vs quarantine vs proceed)
//   - It does NOT contain prompt text
//   - It does NOT decide retry policy beyond exposing the verdict — the
//     orchestrator in pipeline.ts owns the retry counter
//
// Charter alignment:
//   - Rule 6 (guards catch failure, never override success): a guard that
//     REJECTS bad input is doing its job; a guard that silently passes bad
//     input through is the failure mode this design exists to prevent
//   - Rule 7 (determinism is local): seam validation is pure — same input,
//     same verdict; LLM calls live elsewhere
// ═══════════════════════════════════════════════════════════════════════════════

import { validateUniqueSchema, DEMOTE_TARGETS, type SchemaCheckResult } from "./schema-validator.js";
import type { Pass2aItem, Pass2aResult } from "./pass2a.js";
import type { Pass2bResult } from "./pass2b.js";
import type { Pass2cResult, Pass2cItemWiring } from "./pass2c.js";
import type { Pass2Item, Pass2Result, Pass2CausalWiring } from "./types.js";

// ─── Types ─────────────────────────────────────────────────────────────────────

/**
 * Input to Seam α validation: a Pass 2 item AFTER 2a classified it AND 2b
 * filled the unique{} fields. This is the data shape that exits 2b.
 *
 * Mirrors the relevant subset of `Pass2Item` but typed independently so the
 * seam doesn't entangle with Pass 2 monolith types during migration.
 */
export interface SeamAlphaItem {
  id: string;
  type: string;
  unique: Record<string, unknown>;

  /** Set when 2a flagged a novel type with its own schema — validator passes those through. */
  schema?: Record<string, unknown>;

  /** Retry counter — caller increments and reads. Validator uses it for verdict only. */
  _seam_alpha_retries?: number;
}

/**
 * Verdict returned by `validateSeamAlpha`. Three terminal outcomes:
 *
 * - `proceed`     — schema valid; item moves to 2c
 * - `route_back`  — schema invalid AND retry budget remains; caller should
 *                   re-run 2a with the failure detail and try again
 * - `quarantine`  — schema invalid AND retry exhausted; caller should write to
 *                   quarantine and drop from the live pipeline
 *
 * The verdict carries the schema check result so the caller can build a
 * `pass2b_failure_reason` string for quarantine without re-running validation.
 */
export type SeamAlphaVerdict =
  | { kind: "proceed"; item: SeamAlphaItem }
  | { kind: "route_back"; item: SeamAlphaItem; failure: SchemaCheckResult; failure_detail: string }
  | { kind: "quarantine"; item: SeamAlphaItem; failure: SchemaCheckResult; failure_detail: string }
  // `demote` (2026-05-27, debt-3 structural-small): when an item fails schema at
  // retry-exhaustion BUT a structurally-equivalent type's content IS present in
  // unique{}, re-type instead of quarantining. The verdict carries the new type
  // and the field-remapped unique{}; the orchestrator applies them and routes
  // the re-typed item to `proceed` (forward to 2c). See DEMOTE_TARGETS below.
  // Charter alignment: rule 2 (no delete — re-types, doesn't drop), rule 6
  // (guard catches failure, routes to recoverable type, never overrides success),
  // rule 11 (bounded: one new verdict kind, no other seam invariants change).
  // remapped_unique is Record<string, string> to match Pass2bResult.unique
  // (which is what flows into the orchestrator's filledById). The implementation
  // enforces this at runtime via a typeof check before adding to the map.
  | { kind: "demote"; item: SeamAlphaItem; new_type: string; remapped_unique: Record<string, string>; reason: string };

/**
 * Maximum route-back retries before quarantine. ONE retry — per §3:
 *   "One retry max. Stop infinite loops with a retry counter."
 *
 * This is deliberately not configurable. Increasing it past 1 is a structural
 * decision that requires a design revision, not a flag flip.
 */
export const SEAM_ALPHA_MAX_RETRIES = 1;

/**
 * DEMOTE_TARGETS — type re-targeting map for the demote-edge (2026-05-27, debt-3
 * structural-small; see memory: project-insight-fact-typing-gap).
 *
 * Each row encodes a UNIVERSAL meaning-equivalence (per docs/reference/block-types.md
 * definitions), NEVER a domain-specific heuristic. The gate for adding a row:
 *
 *   "If type X's required field is genuinely unfillable AND the equivalent content
 *    is fillable as type Y, then 'X without that field' IS Y, by Y's definition."
 *
 * If you can't state that equivalence cleanly from the type definitions in
 * block-types.md, the row doesn't belong here — that's a heuristic, not a
 * universal, and §5 universal framing forbids it.
 *
 * Current rows:
 *   - insight → fact: An insight is `observation + implication` (block-types.md:205-213).
 *     A fact is `value + why_matters?` (line 187-200). An insight whose implication
 *     is unfillable while observation is present IS, BY DEFINITION, a fact whose
 *     `value` is that observation. The demote encodes this; it does not invent it.
 */
// Relocated to schema-validator.ts (2026-06-12) so seam-α and the Tier-1B
// save-time demote share ONE source of truth. Re-exported here to preserve
// this module's public surface for existing importers.
export { DEMOTE_TARGETS };

// ─── Seam α validator ──────────────────────────────────────────────────────────

/**
 * Validate a single item at Seam α.
 *
 * - If `item.schema` is present (novel_type from 2a): pass through with `proceed`.
 *   Novel-type schemas are 2a's responsibility; Tier 1B doesn't validate them
 *   (no canonical schema to validate against).
 * - Otherwise: run `validateUniqueSchema(item.type, item.unique)`. On OK →
 *   `proceed`. On failure → consult `_seam_alpha_retries`:
 *     0 (or undefined) → `route_back` (one retry available)
 *     ≥ SEAM_ALPHA_MAX_RETRIES → `quarantine`
 */
/**
 * Validator options.
 *
 * `enable_demote` (2026-05-27, debt-3 structural-small): opt-in for the demote
 * behavior. Default FALSE so existing callers (orchestrator, tests) keep their
 * current contract — items that would previously quarantine still quarantine.
 * Set to TRUE only by callers that handle the `demote` verdict (re-type item +
 * route to proceed). Orchestrator gates this via env (`NODEDEX_SEAM_ALPHA_DEMOTE`).
 *
 * Pure-function discipline (charter rule 7): the option is a DETERMINISTIC
 * INPUT, not env-reading inside the validator. Same inputs → same verdict.
 */
export interface ValidateSeamAlphaOptions {
  enable_demote?: boolean;
}

export function validateSeamAlpha(item: SeamAlphaItem, options?: ValidateSeamAlphaOptions): SeamAlphaVerdict {
  // Novel-type bypass: 2a declared its own schema; this layer can't validate.
  // The novel schema's fitness is a debt-3 concern (schema evolution), not a
  // seam concern.
  if (item.schema && Object.keys(item.schema).length > 0) {
    return { kind: "proceed", item };
  }

  const check = validateUniqueSchema(item.type, item.unique);

  if (check.ok) {
    return { kind: "proceed", item };
  }

  const retries = item._seam_alpha_retries ?? 0;
  // `detail` is always present on `ok: false` results per schema-validator.ts contract.
  const failure_detail = check.detail;

  if (retries >= SEAM_ALPHA_MAX_RETRIES) {
    // Demote-edge (2026-05-27): conservative — only fires AFTER 2b's retry
    // exhausted (let the retry try first), AND only when caller opted in via
    // `enable_demote` (rule 2: callers that don't handle demote must not see
    // it, else items disappear silently). If the type has a DEMOTE_TARGETS
    // row AND all source fields in field_map are present in unique{}, the
    // re-typing is structurally valid (per the universal meaning-equivalence
    // each row encodes — see DEMOTE_TARGETS doc). "Present" mirrors
    // schema-validator's definition: non-null, non-undefined, non-empty-string.
    if (options?.enable_demote) {
      const target = DEMOTE_TARGETS[item.type];
      if (target) {
        const unique = item.unique ?? {};
        // Record<string, string> to match Pass2bResult.unique shape downstream.
        // Non-string source values cause demote to abort (defensive: 2b only
        // emits strings, but the seam item type is wider via SeamAlphaItem).
        const remapped_unique: Record<string, string> = {};
        let allSourcesPresent = true;
        for (const [src, dst] of Object.entries(target.field_map)) {
          const v = (unique as Record<string, unknown>)[src];
          if (v === null || v === undefined) { allSourcesPresent = false; break; }
          if (typeof v !== "string") { allSourcesPresent = false; break; }
          if (v.trim() === "") { allSourcesPresent = false; break; }
          remapped_unique[dst] = v;
        }
        if (allSourcesPresent) {
          const mapStr = Object.entries(target.field_map).map(([s, d]) => `${s}→${d}`).join(",");
          const reason = `demote ${item.type}→${target.to}: ${failure_detail}; remapped {${mapStr}}`;
          return { kind: "demote", item, new_type: target.to, remapped_unique, reason };
        }
      }
    }
    return { kind: "quarantine", item, failure: check, failure_detail };
  }
  return { kind: "route_back", item, failure: check, failure_detail };
}

/**
 * Batch helper — runs `validateSeamAlpha` over an array, returning the items
 * partitioned by verdict. Caller drives downstream handling.
 *
 * Pure function: does not write to any database or call any LLM.
 */
export function validateSeamAlphaBatch(items: SeamAlphaItem[], options?: ValidateSeamAlphaOptions): {
  proceed:     Array<{ item: SeamAlphaItem }>;
  route_back:  Array<{ item: SeamAlphaItem; failure: SchemaCheckResult; failure_detail: string }>;
  quarantine:  Array<{ item: SeamAlphaItem; failure: SchemaCheckResult; failure_detail: string }>;
  // `demote` partition added 2026-05-27 (debt-3 structural-small). Populated
  // ONLY when caller passes { enable_demote: true } — default-off preserves
  // existing-caller contract (no silent data loss). Orchestrator consumes this
  // separately: re-types item to verdict.new_type with verdict.remapped_unique,
  // then routes the result to the proceed path (→ 2c).
  demote:      Array<{ item: SeamAlphaItem; new_type: string; remapped_unique: Record<string, string>; reason: string }>;
} {
  const result = { proceed: [] as any[], route_back: [] as any[], quarantine: [] as any[], demote: [] as any[] };
  for (const item of items) {
    const verdict = validateSeamAlpha(item, options);
    if (verdict.kind === "proceed") {
      result.proceed.push({ item: verdict.item });
    } else if (verdict.kind === "route_back") {
      result.route_back.push({ item: verdict.item, failure: verdict.failure, failure_detail: verdict.failure_detail });
    } else if (verdict.kind === "demote") {
      result.demote.push({ item: verdict.item, new_type: verdict.new_type, remapped_unique: verdict.remapped_unique, reason: verdict.reason });
    } else {
      result.quarantine.push({ item: verdict.item, failure: verdict.failure, failure_detail: verdict.failure_detail });
    }
  }
  return result;
}

// ─── Seam β validator ──────────────────────────────────────────────────────────

/**
 * Snapshot of the fields 2c is FORBIDDEN to mutate (§1 contract):
 *   - type, unique, text, id
 *
 * Snapshot is taken before 2c runs; assertion is checked after 2c returns.
 * Catches accidental mutation in 2c (a future contract violation will fail
 * the assertion BEFORE the bad data ships downstream).
 */
export interface SeamBetaSnapshot {
  id: string;
  type: string;
  unique_json: string;   // JSON-stringified for stable comparison; objects can have key-order quirks
  text: string;
}

export type SeamBetaInvariantResult =
  | { ok: true }
  | { ok: false; id: string; violations: Array<{ field: string; before: string; after: string }> };

/**
 * Take a snapshot of the read-only fields BEFORE handing to 2c.
 */
export function snapshotForSeamBeta(item: { id: string; type: string; unique: Record<string, unknown>; text: string }): SeamBetaSnapshot {
  return {
    id:          item.id,
    type:        item.type,
    unique_json: JSON.stringify(item.unique ?? {}),
    text:        item.text,
  };
}

/**
 * Check that 2c did not mutate any read-only field. Returns ok or a list of
 * violations naming each changed field.
 */
export function checkSeamBetaInvariant(
  snapshot: SeamBetaSnapshot,
  after: { id: string; type: string; unique: Record<string, unknown>; text: string },
): SeamBetaInvariantResult {
  const violations: Array<{ field: string; before: string; after: string }> = [];

  if (snapshot.id !== after.id) {
    violations.push({ field: "id", before: snapshot.id, after: after.id });
  }
  if (snapshot.type !== after.type) {
    violations.push({ field: "type", before: snapshot.type, after: after.type });
  }
  const afterUniqueJson = JSON.stringify(after.unique ?? {});
  if (snapshot.unique_json !== afterUniqueJson) {
    violations.push({ field: "unique", before: snapshot.unique_json, after: afterUniqueJson });
  }
  if (snapshot.text !== after.text) {
    violations.push({ field: "text", before: snapshot.text, after: after.text });
  }

  if (violations.length === 0) return { ok: true };
  return { ok: false, id: snapshot.id, violations };
}

// ─── Compose downstream payload ────────────────────────────────────────────────
//
// composeForDownstream takes the outputs of pass2a / pass2b / pass2c (after
// the orchestrator has handled Seam α + Seam β + quarantine routing) and
// produces the existing `Pass2Result` shape Pass 3 already consumes. The
// result is the same shape whether the monolith path or the split path
// produced it — Pass 3 doesn't care which.
//
// Inputs assumed to come from the orchestrator AFTER:
//   - Seam α has filtered classified items (only schema-valid ones reach here)
//   - 2b failure/quarantine paths handled UPSTREAM (rate-limited / errored 2b
//     items are NOT in `pass2b_results` — they were quarantined)
//   - Seam β invariant verified on 2c output (no read-only field mutation)
//
// Shape grafts (per the 2026-05-25 design discussion locked Shape A):
//   - 2b's per-item `unique{}`             → `Pass2Item.unique`
//   - 2c's per-item `triggered_by[]`       → `Pass2Item.triggered_by_items`
//   - 2c's per-item `based_on[]`           → `Pass2Item.based_on_items`
//   - 2c's per-item `relations[]`          → `Pass2Item.relations`
//   - Legacy `causal_wiring[]` ALSO emitted at top-level (for consumers that
//     still read the monolith schema's separate array — the existing graft
//     code at pipeline.ts:761-777 reads it; keeping it means that path
//     remains untouched, defense in depth per rule 6)
//
// What this function does NOT do:
//   - Decide whether to write blocks (Pass 3's job)
//   - Validate schemas (Seam α did, save-time Tier 1B is the backstop)
//   - Throw on inconsistency — surfaces as `inconsistencies[]` so the
//     orchestrator decides whether to quarantine, abort, or just log
//   - Mutate any input — pure function (charter rule 7 spirit)
//
// Inconsistency kinds (audit surface, not silent drops):
//   - missing_pass2b_fill   — classified item has no matching 2b result
//                             (compose with empty unique{}; save-time Tier 1B
//                             will flag the resulting block as needs_review)
//   - missing_pass2c_wiring — classified item has no matching 2c wiring
//                             (default to empty arrays — less severe; no
//                             wiring is a valid state for a genesis item)
//   - orphan_pass2b         — 2b result has id not in classified[] (dropped)
//   - orphan_pass2c         — 2c wiring has id not in classified[] (dropped)

export interface ComposeInput {
  /** Pass 2a output — items that survived Q0 dedup + Seam α validation */
  pass2a: Pass2aResult;
  /** Pass 2b per-item successes (failures handled upstream by quarantine path) */
  pass2b_results: Pass2bResult[];
  /** Pass 2c batch wiring output */
  pass2c: Pass2cResult;
}

export type ComposeInconsistencyKind =
  | "missing_pass2b_fill"
  | "missing_pass2c_wiring"
  | "orphan_pass2b"
  | "orphan_pass2c";

export interface ComposeInconsistency {
  id: string;
  kind: ComposeInconsistencyKind;
  detail: string;
}

export interface ComposeOutput {
  result: Pass2Result;
  inconsistencies: ComposeInconsistency[];
}

/**
 * Pure assembly function. Takes the three sub-pass outputs and produces the
 * Pass2Result shape Pass 3 consumes. Surfaces structural inconsistencies as
 * a separate array — never throws, never silently drops a classified item.
 */
export function composeForDownstream(input: ComposeInput): ComposeOutput {
  const { pass2a, pass2b_results, pass2c } = input;
  const inconsistencies: ComposeInconsistency[] = [];

  // Index 2b + 2c outputs by id for O(1) lookup per classified item.
  const fillById = new Map<string, Pass2bResult>();
  for (const r of pass2b_results) fillById.set(r.id, r);

  const wiringById = new Map<string, Pass2cItemWiring>();
  for (const w of pass2c.wiring) wiringById.set(w.id, w);

  // Track which 2b/2c entries get consumed so we can detect orphans.
  const classifiedIds = new Set<string>(pass2a.classified.map((c) => c.id));

  const classified: Pass2Item[] = pass2a.classified.map((c: Pass2aItem) => {
    const fill = fillById.get(c.id);
    const wiring = wiringById.get(c.id);

    if (!fill) {
      inconsistencies.push({
        id: c.id,
        kind: "missing_pass2b_fill",
        detail: `classified item ${c.id} (type=${c.type}) has no Pass 2b result; composing with empty unique{}`,
      });
    }
    if (!wiring) {
      inconsistencies.push({
        id: c.id,
        kind: "missing_pass2c_wiring",
        detail: `classified item ${c.id} (type=${c.type}) has no Pass 2c wiring; defaulting to empty triggered_by/based_on/relations`,
      });
    }

    // Build the composed item. 2a fields pass through unchanged (read-only
    // per Seam α contract). 2b fills unique. 2c fills the three wiring fields.
    // Pass2Item requires triggered_by_items + based_on_items — default to []
    // when wiring missing (matches pipeline.ts:773-774 monolith behavior).
    const composed: Pass2Item = {
      id:                       c.id,
      text:                     c.text,
      type:                     c.type,
      project:                  c.project,
      unique:                   fill?.unique ?? {},
      schema:                   c.schema,
      triggered_by_items:       wiring?.triggered_by ?? [],
      based_on_items:           wiring?.based_on ?? [],
      extends_item:             c.extends_item,
      supersedes_ref:           c.supersedes_ref,
      resolved_ref:             c.resolved_ref,
      relations:                wiring?.relations,    // undefined if missing; consumers handle ?? []
      review_reason:            c.review_reason,
      classification_reasoning: c.classification_reasoning,
      source_type:              c.source_type,         // demote-edge provenance (e.g. "seam_demoted") → blocks.source_type at save
      excerpt:                  c.excerpt,             // DEBT 5 D3 (§2.3.2): line-level provenance pinned from Pass 1 → carried through 2a re-join → Pass 3 persists to blocks.source_excerpt
    };
    return composed;
  });

  // Orphan detection — 2b/2c emitted ids not in classified[].
  for (const r of pass2b_results) {
    if (!classifiedIds.has(r.id)) {
      inconsistencies.push({
        id: r.id,
        kind: "orphan_pass2b",
        detail: `Pass 2b emitted fill for unknown item ${r.id}; not in classified[]`,
      });
    }
  }
  for (const w of pass2c.wiring) {
    if (!classifiedIds.has(w.id)) {
      inconsistencies.push({
        id: w.id,
        kind: "orphan_pass2c",
        detail: `Pass 2c emitted wiring for unknown item ${w.id}; not in classified[]`,
      });
    }
  }

  // Legacy top-level causal_wiring[] — duplicates triggered_by_items/based_on_items
  // for consumers that read the monolith schema's separate array (defense in
  // depth; the existing graft at pipeline.ts:761-777 reads it).
  const causal_wiring: Pass2CausalWiring[] = classified
    .filter((c) => (c.triggered_by_items?.length ?? 0) > 0 || (c.based_on_items?.length ?? 0) > 0)
    .map((c) => ({
      item_id:      c.id,
      triggered_by: c.triggered_by_items ?? [],
      based_on:     c.based_on_items ?? [],
    }));

  return {
    result: {
      skipped:       pass2a.skipped,
      classified,
      causal_wiring,
    },
    inconsistencies,
  };
}
