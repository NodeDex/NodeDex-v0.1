// ═══════════════════════════════════════════════════════════════════════════════
// PASS 2b — FILL UNIQUE{}  (Week 2 step 2, debt #1, 2026-05-25)
//
// Role:  The second of three sub-passes in the Pass 2 split (see
//        docs/PASS2-SPLIT-DESIGN.md §2 Pass ownership). Takes one item from
//        Pass 2a (type already assigned) and fills the `unique{}` fields
//        per the type's schema. NEVER changes the type. NEVER wires causal
//        relations. PER-ITEM, parallelizable.
//
// What this pass DOES (§2 ownership):
//   - UNIQUE FIELDS — populate using ONLY the assigned type's schema
//   - The insight discriminator check (implication vs reason vs proposal)
//   - Schema-shape self-check before emitting (structured output enforces it;
//     Seam α validation is the hard gate)
//
// What this pass does NOT do (anti-examples, §2):
//   - Change the `type` — read-only per Seam α contract; if 2b can't fill,
//     it emits its best attempt, the seam validator routes back to 2a
//   - Reclassify if the schema doesn't fit — that's the seam's job
//   - Wire relations (`triggered_by_items`, `based_on_items`, `relations`) —
//     that's Pass 2c
//   - Touch other items' fields — 2b is strictly per-item
//   - Use BATCH visibility — each item processed independently (parallelizable)
//
// Failure mode (per §3): if 2b can't fill the schema for the assigned type,
// it just emits what it has. The Seam α validator (`validateSeamAlpha` in
// pass2-seams.ts) catches the mismatch and routes back to 2a OR quarantines.
// 2b is not in the route-back decision loop; it just tries.
//
// Status:
//   - Standalone file. NOT wired into pipeline.ts yet (Week 2 wiring is the
//     next step). Callable in tests with synthetic inputs.
//   - `pass2.ts` is FROZEN per §4. This file does NOT replace it.
//
// Charter alignment:
//   - Rule 6 (guards catch failure): 2b emits its best attempt; the SEAM
//     catches mismatches. 2b never silently corrupts data.
//   - Rule 7 (determinism is local): per-item structured output, deterministic
//     schema per type, no batch interactions.
//   - Rule 14 (store the path): the type 2a assigned is the path 2b walks;
//     2b doesn't re-derive it.
// ═══════════════════════════════════════════════════════════════════════════════

import { CONFIG } from "./config.js";
import type { LLMProvider } from "../../engine/ai-provider.js";
import { TYPE_UNIQUE_SCHEMA } from "./schema-validator.js";

// ─── Types ─────────────────────────────────────────────────────────────────────

/**
 * Input to Pass 2b — a subset of Pass 2a's output. 2b needs only what's
 * required to fill `unique{}` for a single item.
 *
 * `classification_reasoning` is included for the LLM's context (so it knows
 * why 2a picked the type) but 2b does not act on it beyond that.
 */
export interface Pass2bInput {
  id: string;
  text: string;
  type: string;
  classification_reasoning?: string;
  /**
   * Set on a RE-FILL RETRY (seam α route-back). Carries the schema-validation
   * failure detail from the first attempt (e.g. "type=insight missing=[implication]")
   * so the prompt can tell 2b exactly which field to look harder for. Undefined
   * on the first fill. See pass2-split-orchestrator.ts re-fill stage.
   */
  retryFailureDetail?: string;
}

/**
 * Output per item — strictly `id` + `unique{}`. No other fields.
 * 2b owns `unique{}` exclusively; everything else from 2a passes through
 * the orchestrator unchanged (see future `composeForDownstream()`).
 */
export interface Pass2bResult {
  id: string;
  unique: Record<string, string>;
}

/**
 * Batch helper result. Per-item failures (LLM rate-limit, network) are
 * surfaced separately so the caller can decide whether to retry or
 * quarantine; they are NOT the same as schema-mismatch failures (those go
 * to the seam validator with whatever fields 2b managed to emit).
 */
export interface Pass2bBatchResult {
  results: Pass2bResult[];
  failures: Array<{ id: string; reason: "rate_limited" | "llm_error"; detail?: string }>;
  // Summed token usage across every per-item call in the batch (success AND
  // failure — a truncated/failed call still burns tokens). The orchestrator
  // stamps this into reflectTokenStats.pass2b so cost_breakdown is honest
  // (D-fix 2026-05-25; previously usage was discarded → pass2b billed $0).
  usage: { input: number; thinking: number; output: number };
}

// ─── Prompt builder ────────────────────────────────────────────────────────────
//
// 2b's prompt is much shorter than 2a's because:
//   - No dedup (Q0 is 2a's)
//   - No type assignment (Q1 is 2a's)
//   - No hierarchy / project / supersession (all 2a's)
//   - No causal wiring (2c's)
//   - No PROJECT GRAPH (no dedup needed)
//   - No SCENE CARD (no classification needed)
//
// 2b sees only: this item's text + type + which fields to fill.
// The schema is INJECTED per call from TYPE_UNIQUE_SCHEMA, so 2b prompts
// don't enumerate all 18 type schemas every call (cost discipline per §7).
//
// The insight discriminator is preserved verbatim from monolith for the
// insight type — that's the Bug-3-class fix this design targets at the
// Seam α layer, but 2b still does the structural disambiguation in the
// prompt as a first line of defense.

/**
 * Build the Pass 2b prompt for a single item. The type's schema is injected
 * directly so the prompt is concise and type-specific.
 *
 * Exposed for tests (so prompt structure can be asserted without an LLM call).
 */
export function buildPass2bPrompt(item: Pass2bInput): string {
  const schema = TYPE_UNIQUE_SCHEMA[item.type];

  // Novel / unknown type: 2a should have provided schema{} in the seam payload,
  // but at the per-item-fill level we just instruct the model to fill whatever
  // fields make sense; the seam validator will pass through novel types per
  // its bypass rule (see validateSeamAlpha).
  const isNovel = !schema;
  const isFreeform = schema && schema.required.length === 0 && schema.optional.length === 0;

  // Build the type-specific field guidance.
  let fieldGuidance: string;
  if (isNovel) {
    fieldGuidance =
      `This item's type is "${item.type}" — a novel type defined by Pass 2a.\n` +
      `Fill 1-3 fields in unique{} that capture the essential structured data.\n` +
      `Use short, lowercase, snake_case field names that describe the role of each value.`;
  } else if (isFreeform) {
    fieldGuidance =
      `This item's type is "${item.type}" — a freeform type with no required schema.\n` +
      `If structured data is present in the text, capture it. Otherwise leave unique{} empty.`;
  } else {
    const required = schema.required.join(", ");
    const optional = schema.optional.join(", ");
    fieldGuidance =
      `This item's type is "${item.type}".\n` +
      `REQUIRED fields (must all be present and non-empty): ${required}\n` +
      (optional.length > 0 ? `OPTIONAL fields (include only if the text actually says them): ${optional}\n` : "") +
      `Use ONLY these field names. Do not invent new fields. Do not include fields not listed above.`;
  }

  // Insight discriminator: preserved verbatim from the monolith UNIQUE FIELDS
  // section. Only fires when the type is insight, but kept in every prompt
  // (cheap and reinforces the discipline even when the type is something else).
  const insightDiscriminator =
    item.type === "insight"
      ? `\n\nINSIGHT FIELD DISCIPLINE: insight's second field is "implication" (what the observation MEANS going forward) — NOT "proposal" (that field belongs to hypothesis: an unverified guess) and NOT a bare "reason". If the text only gives an observation and a reason without a forward-looking implication, you cannot fill insight cleanly — emit whatever you have and let the seam validator route back. Do NOT invent an implication that isn't in the text.`
      : "";

  // Re-fill retry context (seam α route-back). Tells 2b exactly which required
  // field the first attempt missed, and to LOOK HARDER for it in the text —
  // without licensing fabrication (charter rule 4: don't ask for a weak skill;
  // rule 14: don't invent path-content). The "leave empty if genuinely absent"
  // escape preserves the seam's ability to quarantine a truly-unfillable item.
  const retrySection = item.retryFailureDetail
    ? `\n\nRETRY — a previous fill of this item failed schema validation: ${item.retryFailureDetail}.
Re-read the text carefully. If the missing field's content IS present — for example a
forward-looking consequence for "implication", or the action being described for
"description" — extract and fill it now (the first pass may have been too conservative).
If the required field is genuinely NOT in the text, leave it empty: the item will be set
aside rather than saved incorrectly. Never invent content that isn't in the text.`
    : "";

  return `You receive ONE classified item from Pass 2a. Your job is to fill
its unique{} fields per the assigned type's schema. DO NOT change the type.
DO NOT wire causal relations (later pass handles that).

${fieldGuidance}

EXTRACTION RULES (apply regardless of type):
- Omit fields that have no value in the text — do not fabricate.
- Use verbatim language from the text when possible; light paraphrase OK for clarity.
- Specific named things (a tool name, a number, a date) belong in unique{}.
- Each field value should be a single concise string.${insightDiscriminator}${retrySection}

OUTPUT FORMAT:
{ "id": "<the item's id>", "unique": { <field>: <value>, ... } }
`;
}

/**
 * Output schema for a single 2b call.
 *
 * Defense in depth: `unique` is `type: "object"` with no constraint on which
 * keys appear. This means we cannot prevent the model from emitting extra
 * fields at the schema layer — `sanitizePass2bResult` (below) strips any
 * fields not in the type's allowed set. The seam validator then runs the
 * canonical `validateUniqueSchema` on what survives.
 *
 * Why not constrain the schema to the type's allowed keys?
 *   - The per-type set would have to be built dynamically per call
 *   - Structured output JSON schemas typically can't express "exactly these
 *     keys or those keys" (the union shape varies)
 *   - Sanitizer + seam validator gives layered defense without per-call
 *     schema gymnastics
 */
const PASS2B_SCHEMA = {
  type: "object",
  properties: {
    id:     { type: "string" },
    unique: {
      type: "object",
      // All known fields as optional strings; model fills what applies for the
      // assigned type. Sanitizer strips anything outside the type's allowed set.
      properties: {
        choice:                { type: "string" },
        reason:                { type: "string" },
        alternatives_rejected: { type: "string" },
        approach:              { type: "string" },
        alternative:           { type: "string" },
        limit:                 { type: "string" },
        source:                { type: "string" },
        value:                 { type: "string" },
        name:                  { type: "string" },
        role:                  { type: "string" },
        purpose:               { type: "string" },
        status:                { type: "string" },
        trigger_to_implement:  { type: "string" },
        question:              { type: "string" },
        why_matters:           { type: "string" },
        observation:           { type: "string" },
        implication:           { type: "string" },
        description:           { type: "string" },
        owner:                 { type: "string" },
        outcome:               { type: "string" },
        proposal:              { type: "string" },
        evidence_for:          { type: "string" },
        evidence_against:      { type: "string" },
        definition:            { type: "string" },
        current_value:         { type: "string" },
        target:                { type: "string" },
        what_happened:         { type: "string" },
        date:                  { type: "string" },
        lean:                  { type: "string" },
        over:                  { type: "string" },
        condition:             { type: "string" },
      },
    },
  },
  required: ["id", "unique"],
};

// ─── Sanitizer ─────────────────────────────────────────────────────────────────
//
// Strip `unique{}` fields that aren't allowed for the assigned type.
//
// Why: the structured-output schema accepts ALL known fields as optional, so a
// model emitting `{observation, reason}` for an insight (Bug-3 territory)
// passes JSON-schema validation but FAILS the type-vs-schema validator. The
// sanitizer removes the extras BEFORE the seam runs, so:
//   - Seam validator sees only the fields that should be there
//   - If required fields are missing, seam routes back / quarantines as designed
//   - If extras were the model's misread, they're not preserved into the live graph
//
// For novel/freeform types: pass through unchanged (no canonical schema to
// strip against).

export function sanitizePass2bUnique(
  type: string,
  unique: Record<string, unknown>,
): { unique: Record<string, string>; strippedKeys: string[] } {
  const schema = TYPE_UNIQUE_SCHEMA[type];

  // Coerce values to strings (the schema declares them as strings; defensive).
  const coerced: Record<string, string> = {};
  for (const [k, v] of Object.entries(unique ?? {})) {
    if (v === null || v === undefined) continue;
    if (typeof v === "string" && v.trim() === "") continue;
    coerced[k] = typeof v === "string" ? v : String(v);
  }

  // Novel / unknown type: trust the model (no canonical schema to validate against).
  if (!schema) return { unique: coerced, strippedKeys: [] };

  // Freeform (project/process/note): pass through.
  if (schema.required.length === 0 && schema.optional.length === 0) {
    return { unique: coerced, strippedKeys: [] };
  }

  const allowed = new Set([...schema.required, ...schema.optional]);
  const strippedKeys: string[] = [];
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(coerced)) {
    if (allowed.has(k)) out[k] = v;
    else strippedKeys.push(k);
  }
  return { unique: out, strippedKeys };
}

export function sanitizePass2bResult(
  type: string,
  raw: { id: string; unique?: Record<string, unknown> },
): { result: Pass2bResult; strippedKeys: string[] } {
  const { unique, strippedKeys } = sanitizePass2bUnique(type, raw.unique ?? {});
  return { result: { id: raw.id, unique }, strippedKeys };
}

// ─── LLM call ──────────────────────────────────────────────────────────────────
//
// Per-item LLM call. Returns the filled unique{} (sanitized). Mirrors the
// rate-limit / model / attempts shape of callPass2aLLM so wiring is uniform.

export async function callPass2bLLM(
  provider: LLMProvider,
  item: Pass2bInput,
  thinkingBudget = 512,  // Smaller than 2a — fill is structural, not reasoning-heavy
  // Multi-model routing (C, 2026-05-25): 2b is structural per-item fill
  // (Haiku-class territory per PASS2-SPLIT-DESIGN.md §7). Universal — string
  // model name, no provider assumption.
  modelOverride?: string,
): Promise<{
  result: Pass2bResult | null;
  thinking: string;
  rateLimited: boolean;
  model?: string;
  attempts?: Array<{ model: string; outcome: string }>;
  usage?: { input?: number; thinking?: number; output?: number };
  strippedKeys?: string[];
}> {
  const prompt = buildPass2bPrompt(item);

  // User input: just the item's text + classification_reasoning so model has
  // the context for why 2a picked this type. NO project graph, NO scene card.
  const reasonLine = item.classification_reasoning
    ? `\nCLASSIFICATION REASONING from Pass 2a: ${item.classification_reasoning}\n`
    : "";
  const userInput =
    `ITEM:\n  id: ${item.id}\n  type: ${item.type}\n  text: ${item.text}\n${reasonLine}`;

  const r = await provider.generateStructured<{ id: string; unique: Record<string, unknown> }>(
    prompt,
    userInput,
    PASS2B_SCHEMA,
    {
      thinkingBudget,
      maxOutputTokens: CONFIG.pass2.maxOutputTokens,
      ...(modelOverride ? { modelOverride } : {}),
    },
  );

  if (!r.result) {
    return {
      result: null,
      thinking: r.thinking ?? "",
      rateLimited: r.rateLimited,
      model: r.model,
      attempts: r.attempts,
      usage: r.usage, // a failed/truncated call still burned tokens — surface for the batch roll-up
    };
  }

  const { result: clean, strippedKeys } = sanitizePass2bResult(item.type, r.result);

  if (strippedKeys.length > 0) {
    // Sanitizer fired — model emitted fields outside the type's schema.
    // Log loudly so the contract violation is auditable; the seam validator
    // will then run on the sanitized output.
    console.log(`Auto-Reflect Pass 2b: SANITIZER stripped ${strippedKeys.length} extra field(s) on ${item.id} [${item.type}]: ${strippedKeys.join(", ")}`);
  }

  return {
    result: clean,
    thinking: r.thinking ?? "",
    rateLimited: r.rateLimited,
    model: r.model,
    attempts: r.attempts,
    usage: r.usage,
    strippedKeys: strippedKeys.length > 0 ? strippedKeys : undefined,
  };
}

// ─── Batch helper ──────────────────────────────────────────────────────────────
//
// Calls callPass2bLLM for each item, with configurable parallelism. On
// rate-limit, an item lands in `failures[]` with reason: 'rate_limited'; the
// caller can retry-with-backoff or quarantine the item. Sequential fallback is
// achieved by passing parallelism=1.
//
// Default parallelism = 10 — Stage C-1 (2026-05-30). Bumped from 5 after the
// popup-dinner empirical baseline (28 items, Pass 2 = 143s wall ≈ 59.5% of the
// 253s reflect run) showed Pass 2b chunked execution dominating Pass 2 wall.
// At ~20 items, parallelism=5 = 4 chunks sequential; parallelism=10 = 2 chunks
// ≈ 50% Pass 2b wall reduction when not provider-rate-limited. Existing
// failure capture (failures[] with reason: 'rate_limited') means a 10-wide
// burst is safe — 429'd items land in failures[] and the orchestrator
// retry-with-backoff path handles them. Sequential fallback: parallelism=1.
//
// Buying-time-against: Debt 5 (atomic + arc extraction, atlas §9). Per-turn
// Pass 2 will reshape under Variant A; until then, parallelism is the smallest
// data-model-independent win on the table.
//
// Override precedence (high → low):
//   1. options.parallelism — explicit caller arg (tests + future per-call tuning)
//   2. NODEDEX_PASS2B_PARALLELISM env var — operator dial; mirrors NODEDEX_PASS2{A,B,C}_MODEL family
//   3. DEFAULT_PASS2B_PARALLELISM — compile-time fallback

const DEFAULT_PASS2B_PARALLELISM = 10;

function parsePass2bParallelismEnv(): number | undefined {
  const raw = process.env.NODEDEX_PASS2B_PARALLELISM;
  if (!raw) return undefined;
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n) || n < 1) return undefined;
  return n;
}

export async function callPass2bBatch(
  provider: LLMProvider,
  items: Pass2bInput[],
  options?: {
    parallelism?: number;
    thinkingBudget?: number;
    // Multi-model routing (C, 2026-05-25): all per-item 2b calls in this batch
    // use the same modelOverride. Universal: provider-agnostic string.
    modelOverride?: string;
  },
): Promise<Pass2bBatchResult> {
  // Env-var dial — read per call so test overrides take effect without
  // module reload. Bad / NaN / negative → fall through to DEFAULT.
  const envParallelism = parsePass2bParallelismEnv();
  const parallelism = Math.max(
    1,
    options?.parallelism ?? envParallelism ?? DEFAULT_PASS2B_PARALLELISM,
  );
  const thinkingBudget = options?.thinkingBudget;
  const modelOverride = options?.modelOverride;

  const results: Pass2bResult[] = [];
  const failures: Array<{ id: string; reason: "rate_limited" | "llm_error"; detail?: string }> = [];
  const usage = { input: 0, thinking: 0, output: 0 };

  // Simple chunked-parallelism: take `parallelism` items at a time, await all,
  // then take the next chunk. Avoids requiring a heavier concurrency lib.
  for (let i = 0; i < items.length; i += parallelism) {
    const chunk = items.slice(i, i + parallelism);
    const settled = await Promise.allSettled(
      chunk.map((item) =>
        callPass2bLLM(provider, item, thinkingBudget, modelOverride).then((r) => ({ item, r })),
      ),
    );

    for (const s of settled) {
      if (s.status === "rejected") {
        // Promise rejection (unusual — callPass2bLLM normally returns rateLimited
        // or null instead of throwing); capture as llm_error.
        failures.push({ id: "<unknown>", reason: "llm_error", detail: String(s.reason).slice(0, 200) });
        continue;
      }
      const { item, r } = s.value;
      // Roll up usage from every settled call — success or failure — since a
      // truncated/failed call still consumed tokens at the provider.
      if (r.usage) {
        usage.input    += r.usage.input    ?? 0;
        usage.thinking += r.usage.thinking ?? 0;
        usage.output   += r.usage.output   ?? 0;
      }
      if (r.result) {
        results.push(r.result);
      } else if (r.rateLimited) {
        failures.push({ id: item.id, reason: "rate_limited" });
      } else {
        failures.push({ id: item.id, reason: "llm_error", detail: "callPass2bLLM returned null result" });
      }
    }
  }

  return { results, failures, usage };
}

// ─── STAGE B — SINGLE-CALL BATCHED FILL (Debt 4 Stage B, 2026-06-13) ────────────
//
// The per-item fill above is correct but its fan-out dominates v2 front-half
// wall time (~1 call per block; ~19 calls on a 3-turn arc). This fills N items
// in ONE structured call: same TYPE_UNIQUE_SCHEMA, same sanitizer, same
// never-fabricate rules — only the call SHAPE changes. The risk profile differs
// from the known fused-call failure (COMPREHEND could not fill *while
// comprehending*): here fill is still the ONLY job, just over several items.
//
// Resilience contract: batching may speed up, it must NEVER lose a fill —
// any item missing from a batch response (or a whole failed chunk) FALLS BACK
// to the proven per-item call. Flag: NODEDEX_V2_FILL_BATCH (default ON; =0
// reverts the v2 front-half to the per-item path).

export function v2FillBatchEnabled(): boolean {
  return process.env.NODEDEX_V2_FILL_BATCH !== "0";
}

export function buildPass2bBatchPrompt(): string {
  return `You receive SEVERAL classified items. For EACH item, fill its unique{}
fields per the field list given WITH that item. DO NOT change any type. DO NOT
wire causal relations. Items are independent — never copy content between items.

EXTRACTION RULES (apply to every item):
- Use ONLY the field names listed for that item. Do not invent new fields.
- Omit fields that have no value in the item's text — do not fabricate.
- Use verbatim language from the text when possible; light paraphrase OK.
- Specific named things (a tool name, a number, a date) belong in unique{}.
- Each field value is a single concise string.
- When the text states content for an OPTIONAL field (a reason, a status, a
  condition), fill it as its OWN field — do not fold it into the primary field.

INSIGHT FIELD DISCIPLINE: insight's second field is "implication" (what the
observation MEANS going forward) — NOT "proposal" (hypothesis territory) and NOT
a bare "reason". If an insight's text has no forward-looking implication, emit
what you have; never invent one.

OUTPUT FORMAT:
{ "items": [ { "id": "<item id>", "unique": { <field>: <value>, ... } }, ... ] }
Return ONE entry per input item, using the exact input ids.`;
}

/** One compact schema line per item (the per-item prompt's fieldGuidance, condensed). */
export function batchFieldLine(type: string): string {
  const schema = TYPE_UNIQUE_SCHEMA[type];
  if (!schema) return "novel type — fill 1-3 snake_case fields capturing the essential structured data";
  if (schema.required.length === 0 && schema.optional.length === 0) return "freeform — capture structured data if present, else leave unique{} empty";
  const opt = schema.optional.length > 0 ? ` | OPTIONAL: ${schema.optional.join(", ")}` : "";
  return `REQUIRED: ${schema.required.join(", ")}${opt}`;
}

const PASS2B_BATCH_SCHEMA = {
  type: "object",
  properties: {
    items: { type: "array", items: PASS2B_SCHEMA },
  },
  required: ["items"],
};

export async function callPass2bBatchedFill(
  provider: LLMProvider,
  items: Pass2bInput[],
  opts: { chunkSize?: number; thinkingBudget?: number; modelOverride?: string } = {},
): Promise<{
  results: Pass2bResult[];
  fellBackIds: string[];   // ids that needed the per-item fallback
  llmCalls: number;        // batch + fallback calls — the Stage B before/after metric
  usage: { input: number; thinking: number; output: number };
}> {
  const chunkSize = Math.max(1, opts.chunkSize ?? 12);
  const usage = { input: 0, thinking: 0, output: 0 };
  const results: Pass2bResult[] = [];
  const fellBackIds: string[] = [];
  let llmCalls = 0;

  const addUsage = (u?: { input?: number; thinking?: number; output?: number }) => {
    if (!u) return;
    usage.input += u.input ?? 0; usage.thinking += u.thinking ?? 0; usage.output += u.output ?? 0;
  };

  // The never-lose-a-fill floor: anything the batch path can't account for goes
  // through the proven per-item call.
  const perItemFallback = async (item: Pass2bInput) => {
    llmCalls += 1;
    fellBackIds.push(item.id);
    const r = await callPass2bLLM(provider, item, 512, opts.modelOverride);
    addUsage(r.usage);
    if (r.result) results.push(r.result);
  };

  for (let i = 0; i < items.length; i += chunkSize) {
    const chunk = items.slice(i, i + chunkSize);
    const userInput = chunk
      .map((it) => `ITEM ${it.id}\n  type: ${it.type}\n  fields: ${batchFieldLine(it.type)}\n  text: ${it.text}`)
      .join("\n\n");
    llmCalls += 1;
    const r = await provider.generateStructured<{ items: Array<{ id: string; unique: Record<string, unknown> }> }>(
      buildPass2bBatchPrompt(),
      userInput,
      PASS2B_BATCH_SCHEMA,
      {
        thinkingBudget: opts.thinkingBudget ?? 1024,
        maxOutputTokens: CONFIG.pass2.maxOutputTokens,
        ...(opts.modelOverride ? { modelOverride: opts.modelOverride } : {}),
      },
    );
    addUsage(r.usage);

    const got = new Map<string, Record<string, unknown>>();
    if (r.result?.items) {
      for (const e of r.result.items) if (e && e.id) got.set(e.id, e.unique ?? {});
    }
    // A failed chunk (null result) leaves `got` empty → every chunk item falls back.
    for (const it of chunk) {
      const raw = got.get(it.id);
      if (raw === undefined) { await perItemFallback(it); continue; }
      const { result: clean, strippedKeys } = sanitizePass2bResult(it.type, { id: it.id, unique: raw });
      if (strippedKeys.length > 0) {
        console.log(`Auto-Reflect Pass 2b(batch): SANITIZER stripped ${strippedKeys.length} extra field(s) on ${it.id} [${it.type}]: ${strippedKeys.join(", ")}`);
      }
      results.push(clean);
    }
  }

  return { results, fellBackIds, llmCalls, usage };
}
