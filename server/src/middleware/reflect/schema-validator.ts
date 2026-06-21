// ═══════════════════════════════════════════════════════════════════════════════
// SCHEMA VALIDATOR — Tier 1B (2026-05-24)
//
// Role:  At save time, verify that a block's `content.unique{}` key-set matches
//        the schema declared for its `type`. Catches type-vs-shape mismatches
//        that the type discriminator (Pass 1/2) failed to prevent.
//
// Mode:  SOFT — never rejects a save. On mismatch, flags the block with
//        review_status="needs_review" and a structured review_reason. Charter
//        rule 2 (never delete vetted blocks) + rule 6 (guards catch failure,
//        never override success). The flag is recoverable; deletion is not.
//
// Source of truth: docs/reference/block-types.md (last verified 2026-05-24).
//                  When a type's schema changes there, update TYPE_UNIQUE_SCHEMA
//                  here too — the doc and code drift independently otherwise.
//
// Not validated by this module:
//   - Whether the type name itself is in KNOWN_BLOCK_TYPES (pipeline already
//     handles that elsewhere).
//   - Whether the values inside unique{} are non-empty / semantically valid.
//     That's Pass 2/Pass 3's job; this validator only checks key-set shape.
//   - Novel types created by Pass 2 with their own schema{} — they're trusted.
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Required and optional unique{} keys per block type.
 *
 * `required[]` — keys that MUST be present (non-empty) for the type to be valid.
 * `optional[]` — keys that MAY appear. Anything outside required ∪ optional is
 *                an "extras" violation (probably wrong type for the content).
 * Empty arrays in BOTH → freeform / no-schema type (project, process, note),
 *                always passes validation.
 */
export const TYPE_UNIQUE_SCHEMA: Record<string, { required: string[]; optional: string[] }> = {
  // Permanent core types
  decision:        { required: ["choice"],                 optional: ["reason", "alternatives_rejected"] },
  dead_end:        { required: ["approach", "reason"],     optional: ["alternative"] },
  constraint:      { required: ["limit"],                  optional: ["reason", "source"] },
  blueprint:       { required: ["purpose"],                optional: ["status", "trigger_to_implement"] },
  preference:      { required: ["lean"],                   optional: ["over", "condition"] },
  // Chain — narrative summary. `conclusion` added 2026-05-18 (commit e0e41b8).
  chain:           { required: ["arc"],                    optional: ["conclusion"] },

  // Project-scoped types
  fact:            { required: ["value"],                  optional: ["why_matters"] },
  insight:         { required: ["observation", "implication"], optional: [] },
  // reasoning_chain collapsed → insight (2026-06-15): validator-identical; "derived-ness"
  // lives in the derived_from relations + workspace_derive's content sub-object, not the type.
  task:            { required: ["status", "description"],  optional: ["owner"] },
  question:        { required: ["question"],               optional: ["why_matters"] },
  hypothesis:      { required: ["proposal"],               optional: ["evidence_for", "evidence_against"] },
  entity:          { required: ["name"],                   optional: ["role"] },
  artifact:        { required: ["path"],                   optional: ["description"] },
  // claim / metric collapsed → fact (2026-06-15): the system never branched on them (a
  // fact + flavor); the distinguishing detail lives in fact.value/why_matters or a relation.
  // KEPT: hypothesis (an unverified guess ≠ a verified fact = a real stance) and entity (the
  // pipeline auto-creates entity blocks as label sub-group containers — a structural role).
  // An event is a timestamped OCCURRENCE — something that happened. It is distinct
  // from a `fact` (a standing truth) and a `task` (a not-yet-done). `what_happened`
  // is the irreducible core (the occurrence itself); the TYPE label carries the
  // happened-vs-true distinction, so the field schema stays thin. CAUSALITY lives in
  // RELATIONS (the causal chain is the unit of meaning), never in a field — so
  // `outcome` is optional and only for a trivial inline result (a significant
  // consequence becomes its own chain node), and `date` is optional, only when the
  // absolute time is itself the recall key. (2026-06-15: reconciled the prompt /
  // validator / doc, which had drifted — the validator wrongly required `value`;
  // `what_happened` is the honest field the extraction prompt already teaches.)
  event:           { required: ["what_happened"],          optional: ["outcome", "date"] },

  // Freeform / no-schema — always pass
  project:         { required: [], optional: [] },
  process:         { required: [], optional: [] },
  note:            { required: [], optional: [] },
  draft:           { required: [], optional: [] },
};

export type SchemaCheckResult =
  | { ok: true }
  | { ok: false; missing: string[]; extras: string[]; detail: string };

/**
 * Check if `unique{}` matches the type's declared schema.
 *
 * Returns `{ ok: true }` if:
 *   - the type has no declared schema (novel/freeform), OR
 *   - all required keys are present (non-empty) AND no unexpected keys are present.
 *
 * Returns `{ ok: false, missing, extras, detail }` otherwise.
 *
 * "Present" means: the key exists AND its value is not null/undefined/empty-string.
 * Whitespace-only strings are treated as empty.
 */
export function validateUniqueSchema(
  type: string | undefined | null,
  unique: Record<string, unknown> | undefined | null,
): SchemaCheckResult {
  if (!type) return { ok: true }; // can't validate without a type label

  const schema = TYPE_UNIQUE_SCHEMA[type];
  if (!schema) return { ok: true }; // novel/unknown type — Pass 2 trusted for these

  // Freeform: both arrays empty → always pass.
  if (schema.required.length === 0 && schema.optional.length === 0) return { ok: true };

  const u = unique || {};
  const present = new Set<string>();
  for (const [k, v] of Object.entries(u)) {
    if (v === null || v === undefined) continue;
    if (typeof v === "string" && v.trim() === "") continue;
    present.add(k);
  }

  const missing = schema.required.filter((k) => !present.has(k));
  const allowed = new Set([...schema.required, ...schema.optional]);
  const extras = [...present].filter((k) => !allowed.has(k));

  if (missing.length === 0 && extras.length === 0) return { ok: true };

  const parts: string[] = [];
  if (missing.length > 0) parts.push(`missing=[${missing.join(",")}]`);
  if (extras.length > 0)  parts.push(`extras=[${extras.join(",")}]`);
  const detail = `type=${type} ${parts.join(" ")}`;
  return { ok: false, missing, extras, detail };
}

/**
 * Compose a review_reason string for a schema mismatch, prefixed so downstream
 * consumers (UI, audits) can recognize the source.
 */
export function schemaMismatchReason(check: SchemaCheckResult): string | null {
  if (check.ok) return null;
  return `schema_mismatch: ${check.detail}`;
}

/**
 * DEMOTE_TARGETS — type re-targeting map for the demote-edge (2026-05-27, debt-3
 * structural-small; relocated here 2026-06-12 so seam-α and the save-time demote
 * share ONE source of truth — pass2-seams re-exports it).
 *
 * Each row encodes a UNIVERSAL meaning-equivalence (per docs/reference/block-types.md
 * definitions), NEVER a domain-specific heuristic. The gate for adding a row:
 *
 *   "If type X's required field is genuinely unfillable AND the equivalent content
 *    is fillable as type Y, then 'X without that field' IS Y, by Y's definition."
 *
 * Current rows:
 *   - insight → fact: an insight is `observation + implication`; a fact is
 *     `value + why_matters?`. An insight whose implication is unfillable while
 *     observation is present IS, by definition, a fact whose value is that
 *     observation. The demote encodes this; it does not invent it.
 */
export const DEMOTE_TARGETS: Record<string, { to: string; field_map: Record<string, string> }> = {
  insight: { to: "fact", field_map: { observation: "value" } },
};

export interface SaveDemotion {
  type: string;
  unique: Record<string, unknown>;
  label: string;
  from_type: string;
}

/**
 * Tier 1B demote-at-save (2026-06-12). The v1 path applies DEMOTE_TARGETS at
 * seam-α (before naming); the v2 TRANSFORM path enters at Pass 3 and SKIPS that
 * seam — so schema-clean-but-demotable blocks were arriving at save flagged
 * (`schema_mismatch: missing=[implication]`) instead of demoted (6/6 of the
 * 2026-06-12 audit's flags). This applies the SAME equivalence at the final seam.
 *
 * CONSERVATIVE by contract — demotes ONLY the exact case:
 *   - the type has a DEMOTE_TARGETS row, AND
 *   - the ONLY schema problem is that every missing key is a mapped source key
 *     whose target content is present (no extras, nothing else missing), AND
 *   - the label's type segment can be renamed so label and type stay in
 *     agreement (a half-demote that leaves `_insight_` in the label would break
 *     findability — then we keep the flag instead).
 * Anything outside that → return null → the existing soft-flag path applies
 * (capture-first: a wrong flag is recoverable; a wrong rewrite is not).
 */
export function demoteForSave(
  type: string | undefined | null,
  unique: Record<string, unknown> | undefined | null,
  label: string | undefined | null,
): SaveDemotion | null {
  if (!type || !label) return null;
  const row = DEMOTE_TARGETS[type];
  if (!row) return null;
  const check = validateUniqueSchema(type, unique);
  if (check.ok) return null;                                  // nothing to repair
  if (check.extras.length > 0) return null;                   // shape doesn't cleanly fit either type
  const mappedSources = new Set(Object.keys(row.field_map));  // e.g. {observation}
  const u = unique || {};
  // every missing key must be a non-source required key (i.e. the unfillable one),
  // and every mapped source must be present with real content
  for (const m of check.missing) {
    if (mappedSources.has(m)) return null;                    // the SOURCE itself is missing → worse failure, keep flag
  }
  const newUnique: Record<string, unknown> = {};
  for (const [src, dst] of Object.entries(row.field_map)) {
    const v = u[src];
    if (typeof v !== "string" || v.trim() === "") return null;
    newUnique[dst] = v;
  }
  // the demoted shape must actually validate as the target type
  if (!validateUniqueSchema(row.to, newUnique).ok) return null;
  const newLabel = label.replace(`_${type}_`, `_${row.to}_`);
  if (newLabel === label) return null;                        // type segment not found → don't half-demote
  return { type: row.to, unique: newUnique, label: newLabel, from_type: type };
}
