// ═══════════════════════════════════════════════════════════════════════════════
// PASS 2c — WIRE CAUSALITY  (Week 3 piece, debt #1, 2026-05-25)
//
// Role:  The third of three sub-passes in the Pass 2 split (see
//        docs/PASS2-SPLIT-DESIGN.md §2 Pass ownership). Takes the items 2a
//        classified and 2b filled, and decides their causal wiring:
//        triggered_by (counterfactual), based_on (evidence), and semantic
//        relations (contradicts / supports / resolves). BATCH visibility:
//        a single LLM call sees all items at once because Q3/Q5 reason
//        about pairs.
//
// What this pass DOES (§2 ownership):
//   - Q3 TRIGGERED_BY — counterfactual wiring, circularity guard,
//     REPLACEMENTS rule, HIERARCHY-level wiring rule
//   - Q4 BASED_ON — evidence wiring
//   - Q5 SEMANTIC RELATIONS — contradicts / supports / resolves
//     (Parity note: design §2 also lists `derived_from` + `affects`, but the
//      monolith pass2.ts Q5 emits ONLY the three above. Per §4 parity rule,
//      pass2c mirrors monolith Q5 EXACTLY; extending Q5 to 5 relation types
//      is a deliberate follow-up change, not part of this split.)
//
// What this pass does NOT do (anti-examples, §2 + Seam β contract):
//   - Touch `type`, `unique`, `text`, `id`, `project`, or any other field
//     written by 2a/2b — all READ-ONLY per §1 Seam β contract
//   - Reclassify (a model that wants to re-type must FAIL back, not mutate)
//   - Dedup — 2a already did Q0
//   - Emit `skipped[]` — items reach 2c only if they survived 2a + Seam α
//   - Validate the type↔unique{} schema — Tier 1B at Seam α did that pre-2c
//   - Touch other PROJECT GRAPH blocks via writes — read-only, the orchestrator
//     in pipeline.ts owns relation writes (this just RETURNS the wiring decisions)
//
// Status:
//   - Standalone file. NOT wired into pipeline.ts yet (next step:
//     composeForDownstream() then pipeline.ts behind NODEDEX_PASS2_SPLIT=1).
//   - `pass2.ts` is FROZEN per §4. This file does NOT replace it.
//
// Charter alignment:
//   - Rule 6 (guards catch failure, never override success): sanitizer strips
//     forbidden output keys (anything outside the wiring bundle) and filters
//     relation `type`s to the monolith-parity allowed set. A pass2c that emits
//     less is fine; a pass2c that smuggles new shape into downstream is not.
//   - Rule 7 (determinism is local): sanitizer + schema are pure code;
//     judgment (which pairs are causally linked) is the LLM's.
//   - Rule 9 (bugs live at seams): the Seam β contract that 2c MUST NOT mutate
//     read-only fields is enforced STRUCTURALLY by `snapshotForSeamBeta` +
//     `checkSeamBetaInvariant` in pass2-seams.ts — pass2c's output shape here
//     is designed so the read-only fields are not even in the schema.
//   - Rule 14 (store the path): one item ↔ one wiring bundle. The wiring
//     decisions pass2c made for an item are ONE conceptual record;
//     `Pass2cItemWiring` stores them as one unit, not split across arrays.
// ═══════════════════════════════════════════════════════════════════════════════

import { CONFIG } from "./config.js";
import type { LLMProvider } from "../../engine/ai-provider.js";

// ─── Types ─────────────────────────────────────────────────────────────────────

/**
 * Input to Pass 2c — what 2c sees per item. All fields are READ-ONLY for 2c
 * (Seam β contract, §1). `unique` is included so the model can reason about
 * pair semantics (Q5: does item A contradict item B? requires reading both
 * unique{}s), but 2c never emits a `unique` field on its output.
 *
 * `classification_reasoning` is included as context — the model can see WHY
 * 2a picked the type, which helps Q3 (a dead_end's triggered_by is the
 * decision that adopted the alternative, per REPLACEMENTS rule).
 */
export interface Pass2cInput {
  id: string;
  text: string;
  type: string;
  project?: string;
  unique: Record<string, string>;          // READ-ONLY — never mutated by 2c
  extends_item?: string;                   // READ-ONLY — from 2a
  supersedes_ref?: string;                 // READ-ONLY — from 2a
  resolved_ref?: string;                   // READ-ONLY — from 2a
  classification_reasoning?: string;       // READ-ONLY — from 2a
}

/**
 * Wiring decisions for ONE item — the entire output of pass2c per item.
 *
 * Per the design discussion 2026-05-25 (Shape A vs Shape B): one item ↔ one
 * wiring bundle, all three axes together. Reflects the conceptual unit ("what
 * causal wiring did 2c decide for this item?") and avoids forcing every
 * downstream consumer (composer, tests, telemetry, future enrichment) to JOIN
 * across two arrays by id forever.
 *
 * The composer (`composeForDownstream`, future) splits this bundle into the
 * shape Pass 3 expects: `causal_wiring[]` (triggered_by + based_on) and
 * per-classified-item `relations[]`.
 */
export interface Pass2cItemWiring {
  id: string;
  triggered_by: string[];                              // item ids OR block labels (PROJECT GRAPH)
  based_on: string[];                                  // item ids OR block labels (PROJECT GRAPH)
  // Q5 semantic relations. `reasoning` names which Q5 case (contradicts / supports /
  // resolves) fired AND cites the specific claim-pair from the items that grounded
  // it — so downstream (Pass 5 chains, agent inspection, audit) can see WHY each
  // semantic wire exists, not just THAT it does. Mirrors Pass 4's required `reason`.
  relations: Array<{ type: string; target: string; reasoning: string }>;
}

/**
 * Pass 2c result envelope. Single batch call → single result containing the
 * wiring bundles for every input item.
 *
 * No `skipped[]` (2a already filtered), no `classified[]` (2c doesn't re-emit
 * classification data — composer carries that forward from 2a/2b).
 */
export interface Pass2cResult {
  wiring: Pass2cItemWiring[];
}

// ─── Prompt ────────────────────────────────────────────────────────────────────
//
// Carved from PASS2_PROMPT in pass2.ts CAUSAL WIRING section (Q3 + Q4 + Q5
// verbatim, lines 167-189 in the monolith). Sections REMOVED per §2:
//   - Q0 DEDUP (2a)
//   - Q1 TYPE — 5 TESTs (2a)
//   - Q2 HIERARCHY (2a)
//   - PROJECT ATTRIBUTION (2a)
//   - SUPERSEDES_REF (2a; passed through as context)
//   - REVIEW FLAGS (2a)
//   - CLASSIFICATION REASONING (2a; passed through as context)
//   - UNIQUE FIELDS section (2b)
//   - NOVEL TYPE (2a)
//
// STATE CONVENTION preserved (Q5 references PROJECT GRAPH for cross-batch
// relations; the same "state = text in marked regions" discipline applies).
// SCENE CARD CONTEXT pared to just the CAUSAL LINKS note (Q3 still uses it;
// APPROACHES/UNCHANGED/TASKS were 2a-only signals).
//
// Top framing adds Seam β read-only callout — explicit guard against the
// model "fixing" what it thinks 2a got wrong by emitting new type/unique
// fields. The sanitizer + Seam β invariant check are the structural backup.

export const PASS2C_PROMPT = `You receive classified items from Pass 2a (type, project, refs)
already filled by Pass 2b (unique{}). Your ONE job: wire causal relations
between these items (and to existing blocks in PROJECT GRAPH).

── SEAM β CONTRACT — READ-ONLY ─────────────────────────────────────────────
DO NOT change any item's type. DO NOT touch unique{} fields. DO NOT change
text, id, project, supersedes_ref, resolved_ref, or extends_item. DO NOT add
or remove items. DO NOT emit skipped[]. DO NOT re-dedup (Pass 2a did Q0).
DO NOT re-classify (Pass 2a did Q1). If you think 2a or 2b got something
wrong, EMIT ONLY YOUR WIRING DECISIONS anyway — the seam validator will
catch the mismatch.

── STATE CONVENTION ─────────────────────────────────────────────────────────
"State" in this prompt = text in marked regions below (PROJECT GRAPH, SCENE
CARD, ITEMS). Your training knowledge and "what's commonly known about this
domain" are NOT state. A causal link to an existing block is valid ONLY if a
block in PROJECT GRAPH has that exact label.

For EACH item: walk Q3 → Q4 → Q5 in order.

── Q3: TRIGGERED_BY — "In a world where (X) didn't happen, would (Y) still have occurred?"
  YES → no link. NO → X goes in triggered_by.
  UNCERTAIN → no link. Wrong wiring (false narrative) costs more than missing wiring (recoverable).
  CIRCULARITY GUARD: before adding A→B, check "Did I already put B→A?" YES → skip.
  Use item IDs for batch, block labels for PROJECT GRAPH. Genesis → triggered_by: [].
  REPLACEMENTS "X→Y": dead_end for X is triggered_by the decision that adopted Y.
  HIERARCHY: "Did cause make the DECISION necessary, or only this mechanism?"
    Decision → triggered_by on parent. Mechanism only → triggered_by on child.

── Q4: BASED_ON — "Would this claim be UNSUPPORTED without that specific finding?"
  NO → no link. YES → based_on.
  UNCERTAIN → no link. False evidence link costs more than missing one.
  Applies to conclusions, decisions justified by findings.

── Q5: SEMANTIC RELATIONS — for each item pair in this batch:
  "Does (X) directly contradict, support, or answer (Y)?"
  contradicts: opposite claims about the same specific thing.
  supports: independent evidence strengthening the same claim.
  resolves: (X) answers the question or settles the hypothesis (Y) poses.
  Use ONLY these three relation types. Other relation kinds are emitted by
  other passes (e.g. supersedes, extends, derived_from) — do not emit them here.

  PER-RELATION REASONING: every emitted relation MUST carry a reasoning field
  that NAMES the case (contradicts / supports / resolves) AND CITES the specific
  claim from each item that grounded the decision — e.g. a contradicts entry
  should read "contradicts: item_5 claims X always Y; item_9 reports X did not Y in case Z".
  This is the audit trail downstream consumers (chains, agent inspection) read to
  understand WHY this wire exists. A wire without grounded reasoning is corruption;
  if you cannot cite a specific claim-pair, do not emit the relation.

── SCENE CARD CONTEXT ──────────────────────────────────────────────────────
CAUSAL LINKS in the scene card name explicit cause→effect pairs the agent
stated in this session — use them as Q3 input.

── OUTPUT ──────────────────────────────────────────────────────────────────
For EACH item, emit one wiring entry: { id, triggered_by[], based_on[], relations[] }.
Each entry in relations[] is { type, target, reasoning } — reasoning REQUIRED per
Q5 (names the case + cites the claim-pair). Use [] (empty array) for any axis
with no links — do not omit fields. The id MUST match an input item's id exactly.
Do NOT emit wiring for items not in the input.

`;

// ─── Output schema ─────────────────────────────────────────────────────────────
//
// Mirrors `Pass2cResult` — { wiring: [{ id, triggered_by, based_on, relations }] }.
// Read-only fields (type, unique, text, project, etc.) are deliberately ABSENT
// so any leakage is visible in pass-log output. Per Seam β contract, structural
// exclusion is the first line of defense; the sanitizer + Seam β invariant
// check are deeper backstops.

const PASS2C_SCHEMA = {
  type: "object",
  properties: {
    wiring: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id:           { type: "string" },
          triggered_by: { type: "array", items: { type: "string" } },
          based_on:     { type: "array", items: { type: "string" } },
          relations: {
            type: "array",
            items: {
              type: "object",
              properties: {
                type:      { type: "string" },
                target:    { type: "string" },
                reasoning: { type: "string" },   // Q5 case + claim-pair evidence (per meaning-first)
              },
              required: ["type", "target", "reasoning"],
            },
          },
        },
        required: ["id", "triggered_by", "based_on", "relations"],
      },
    },
  },
  required: ["wiring"],
};

// ─── Sanitizers ────────────────────────────────────────────────────────────────
//
// Two structural guards (charter rule 6):
//
// (1) FORBIDDEN_KEYS — keys outside the wiring bundle that some model may
//     leak (especially if it "corrects" type or unique{}). Stripped at sanitize
//     time so the leakage never reaches downstream. Includes the read-only
//     Seam β fields plus a few false-friends (skipped, classified) that exist
//     in the monolith schema but have no place in 2c output.
//
// (2) ALLOWED_PASS2C_RELATION_TYPES — Q5 emits only contradicts / supports /
//     resolves per monolith parity. Other relation types come from other
//     passes (Pass 4 cross-session, post-process CHAIN_RELS) or other 2a/2b
//     mechanisms (supersedes, extends). Filter to keep the split's "what each
//     pass owns" boundary structural, not just prompted.

const FORBIDDEN_KEYS_ON_PASS2C_OUTPUT = [
  "type",
  "unique",
  "text",
  "project",
  "extends_item",
  "supersedes_ref",
  "resolved_ref",
  "review_reason",
  "classification_reasoning",
  "schema",
  "skipped",
  "classified",
  "note",
] as const;

export const ALLOWED_PASS2C_RELATION_TYPES: ReadonlySet<string> = new Set([
  "contradicts",
  "supports",
  "resolves",
]);

/**
 * Strip forbidden keys from a single wiring entry. Returns the cleaned wiring
 * + the list of stripped keys (so callers can audit-log contract violations).
 *
 * If `triggered_by` / `based_on` / `relations` are missing, default to empty
 * arrays (the schema requires them; this is defensive). If `relations` items
 * have type values outside ALLOWED_PASS2C_RELATION_TYPES, those entries are
 * dropped — reported in `strippedRelationTypes`.
 */
export function sanitizePass2cItem(raw: Record<string, unknown>): {
  item: Pass2cItemWiring;
  stripped: string[];
  strippedRelationTypes: string[];
} {
  const stripped: string[] = [];
  const cleaned: any = { ...raw };

  for (const k of FORBIDDEN_KEYS_ON_PASS2C_OUTPUT) {
    if (k in cleaned) {
      stripped.push(k);
      delete cleaned[k];
    }
  }

  const id = typeof cleaned.id === "string" ? cleaned.id : String(cleaned.id ?? "");
  const triggered_by = Array.isArray(cleaned.triggered_by)
    ? cleaned.triggered_by.filter((x: unknown): x is string => typeof x === "string" && x.trim() !== "")
    : [];
  const based_on = Array.isArray(cleaned.based_on)
    ? cleaned.based_on.filter((x: unknown): x is string => typeof x === "string" && x.trim() !== "")
    : [];

  // Relations: filter to allowed types, coerce target to string, default reasoning
  // to empty string if the model omitted it (the schema requires it, but be
  // defensive — a missing reasoning is a contract failure to log, not a crash).
  const strippedRelationTypes: string[] = [];
  const relations: Array<{ type: string; target: string; reasoning: string }> = [];
  if (Array.isArray(cleaned.relations)) {
    for (const r of cleaned.relations) {
      if (!r || typeof r !== "object") continue;
      const rType = typeof (r as any).type === "string" ? (r as any).type : "";
      const rTarget = typeof (r as any).target === "string" ? (r as any).target : String((r as any).target ?? "");
      const rReasoning = typeof (r as any).reasoning === "string" ? (r as any).reasoning : "";
      if (!rType || !rTarget.trim()) continue;
      if (!ALLOWED_PASS2C_RELATION_TYPES.has(rType)) {
        strippedRelationTypes.push(rType);
        continue;
      }
      relations.push({ type: rType, target: rTarget, reasoning: rReasoning });
    }
  }

  return {
    item: { id, triggered_by, based_on, relations },
    stripped,
    strippedRelationTypes,
  };
}

/**
 * Sanitize the full pass2c result. Aggregates per-item stripped keys + relation
 * types so the caller can log the contract-violation surface.
 */
export function sanitizePass2cResult(raw: { wiring?: any[] }): {
  result: Pass2cResult;
  totalStrippedFields: number;
  perItemStripped: Array<{ id: string; stripped: string[] }>;
  perItemStrippedRelationTypes: Array<{ id: string; types: string[] }>;
} {
  const perItemStripped: Array<{ id: string; stripped: string[] }> = [];
  const perItemStrippedRelationTypes: Array<{ id: string; types: string[] }> = [];
  let totalStrippedFields = 0;

  const wiring = (raw.wiring ?? []).map((w: any) => {
    const { item, stripped, strippedRelationTypes } = sanitizePass2cItem(w);
    if (stripped.length > 0) {
      perItemStripped.push({ id: item.id, stripped });
      totalStrippedFields += stripped.length;
    }
    if (strippedRelationTypes.length > 0) {
      perItemStrippedRelationTypes.push({ id: item.id, types: strippedRelationTypes });
    }
    return item;
  });

  return {
    result: { wiring },
    totalStrippedFields,
    perItemStripped,
    perItemStrippedRelationTypes,
  };
}

// ─── LLM call ──────────────────────────────────────────────────────────────────
//
// BATCH call (single LLM invocation for all items) — per §2, pass2c needs full
// batch visibility because Q3 counterfactuals and Q5 semantic relations reason
// about PAIRS. Per-item parallelism would lose that visibility.
//
// Signature mirrors callPass2aLLM as far as practical so wiring code can
// uniformly route between sub-passes. Returns usage + sanitization stats so
// the caller can stamp the turn log without touching global state. Does NOT
// update reflectTokenStats (wiring concern, deferred to pipeline.ts wiring step).

export async function callPass2cLLM(
  provider: LLMProvider,
  items: Pass2cInput[],
  projectContext: string,
  thinkingBudget = 1024,
  sceneCard?: string,
  // Multi-model routing (C, 2026-05-25): 2c is semantic wiring — typically
  // the expensive-model slot (Gemini Flash/Pro) while 2a/2b go to Haiku.
  // Universal — provider-agnostic string. Undefined → use provider default.
  modelOverride?: string,
): Promise<{
  result: Pass2cResult | null;
  thinking: string;
  rateLimited: boolean;
  model?: string;
  attempts?: Array<{ model: string; outcome: string }>;
  usage?: { input?: number; thinking?: number; output?: number };
  strippedFields?: Array<{ id: string; stripped: string[] }>;
  strippedRelationTypes?: Array<{ id: string; types: string[] }>;
}> {
  // Defensive: an empty batch is a valid (degenerate) input — emit empty wiring,
  // skip the LLM. Spares cost on trivially-empty turns.
  if (items.length === 0) {
    return {
      result: { wiring: [] },
      thinking: "",
      rateLimited: false,
    };
  }

  const sceneCardSection = sceneCard
    ? `SCENE CARD (CAUSAL LINKS name explicit cause→effect pairs from the session):\n${sceneCard}\n\n`
    : "";

  const projectSection = projectContext
    ? `PROJECT GRAPH (existing blocks — use labels for cross-batch triggered_by/based_on/relations targets):\n${projectContext}\n\n`
    : "";

  const itemsSection = `ITEMS:\n${JSON.stringify(items, null, 2)}`;
  const userInput = `${sceneCardSection}${projectSection}${itemsSection}`;

  const r = await provider.generateStructured<{ wiring: any[] }>(
    PASS2C_PROMPT,
    userInput,
    PASS2C_SCHEMA,
    {
      thinkingBudget,
      maxOutputTokens: CONFIG.pass2.maxOutputTokens,
      ...(modelOverride ? { modelOverride } : {}),
    },
  );

  if (!r.result) {
    console.error(`Auto-Reflect Pass 2c: ${r.rateLimited ? "rate limited" : "failed"} [${provider.getName()}]`);
    return {
      result: null,
      thinking: r.thinking ?? "",
      rateLimited: r.rateLimited,
      model: r.model,
      attempts: r.attempts,
    };
  }

  const {
    result: clean,
    totalStrippedFields,
    perItemStripped,
    perItemStrippedRelationTypes,
  } = sanitizePass2cResult(r.result);

  const tag = provider.getName() !== "gemini" ? ` [${provider.getName()}]` : "";
  console.log(
    `Auto-Reflect Pass 2c: wired ${items.length} items | tokens: in=${r.usage?.input ?? "?"} think=${r.usage?.thinking ?? "?"} out=${r.usage?.output ?? "?"}${tag}`,
  );

  if (totalStrippedFields > 0) {
    console.log(`Auto-Reflect Pass 2c: SANITIZER stripped ${totalStrippedFields} forbidden field(s) across ${perItemStripped.length} item(s)`);
    for (const s of perItemStripped) {
      console.log(`  ${s.id}: removed ${s.stripped.join(", ")}`);
    }
  }
  if (perItemStrippedRelationTypes.length > 0) {
    console.log(`Auto-Reflect Pass 2c: SANITIZER dropped non-parity relation type(s) across ${perItemStrippedRelationTypes.length} item(s)`);
    for (const s of perItemStrippedRelationTypes) {
      console.log(`  ${s.id}: dropped relation types ${s.types.join(", ")}`);
    }
  }

  return {
    result: clean,
    thinking: r.thinking ?? "",
    rateLimited: r.rateLimited,
    model: r.model,
    attempts: r.attempts,
    usage: r.usage,
    strippedFields: perItemStripped.length > 0 ? perItemStripped : undefined,
    strippedRelationTypes: perItemStrippedRelationTypes.length > 0 ? perItemStrippedRelationTypes : undefined,
  };
}
