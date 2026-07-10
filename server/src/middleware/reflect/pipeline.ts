import { WorkspaceDB } from "../../store/database.js";
import { stampQualityScore } from "../../store/quality.js";
import { getLLMProvider } from "../../engine/providers/index.js";
import { EmbeddingEngine, blockEmbeddingText } from "../../engine/embeddings.js";
import { v4 as uuidv4 } from "uuid";
import * as fs from "fs";
import * as path from "path";
import { buildProjectContext, buildPreSearchContext, buildDuplicateAlerts, buildItemContext, reflectTokenStats, embeddingStats } from "./context.js";
import { getThinkingBudget, pass5Mode } from "./config.js";
import { callPass0LLM, formatSceneCard } from "./pass0.js";
import { callPass1LLM } from "./pass1.js";
import { callPass2LLM } from "./pass2.js";
import { runPass2Split, type Pass2SplitResult } from "./pass2-split-orchestrator.js";
import { buildCostBreakdown } from "./cost-breakdown.js";
import { callPassJudgeLLM, applyJudgeVerdicts, type PassJudgeVerdict } from "./pass_judge.js";
import { validateUniqueSchema, schemaMismatchReason, demoteForSave } from "./schema-validator.js";
import { normalizeWorkStatus } from "./resolution-heal.js";
import { callPass3LLM } from "./pass3.js";
import { callPass3Batched } from "./pass3-batch.js";
import { applyArcEntityCanonicalNames } from "./arc-entity-resolve.js";
import { recognizeRootsForArc, applyRootRemap, recognizerEnabled } from "./recognize-root.js";
import { resolveArcEntitiesForItems, type BatchResolveEntry } from "./stage-d-resolve-graph.js";
import { callPass4LLM, chunkForPass4 } from "./pass4.js";
import { buildPass4Slice, pass4SliceEnabled, pass4SliceMinGraph } from "./pass4-slice.js";
import { v2LazyCaptureEnabled } from "./comprehend.js";
import { callPass5LLM } from "./pass5.js";
import { assembleMechanicalChains } from "./pass5-mechanical.js";
import { CAUSAL_TRAVERSAL_RELS } from "../../relation-sets.js";
import { synthesizeFromSceneCard } from "./synthesizeFromSceneCard.js";
import { dedupBySourceAndValue } from "./dedup-by-source-and-value.js";
import { writePipelineFlag } from "./pipeline-flags.js";
import { flagBlockExcerptInline } from "./provenance-check.js";
import { inlineDedupEnabled, dedupNewBlocksInline } from "./inline-dedup.js";
import type { Pass0Result, Pass1Item, Pass1Result, Pass2Item, Pass2Result, Pass5Result, PipelineCheckpoint, ReflectCreatedBlock, ReflectUpdatedBlock, ReflectResult } from "./types.js";

// Re-export types needed by api-server.ts
export type { ReflectCreatedBlock, ReflectUpdatedBlock, ReflectResult };
export { reflectTokenStats };

// ─── Reflect debug log ────────────────────────────────────────────────────────
const REFLECT_LOG_PATH = path.join(process.cwd(), "data", "reflect-last.json");
const REFLECT_TURNS_DIR = path.join(process.cwd(), "data", "reflect-turns");
export function getReflectLogPath() { return REFLECT_LOG_PATH; }

// Turn-log sequence number. Two failure modes fixed 2026-06-12:
//   (1) the old `if (!checkpoint) _turnCounter++` guard meant v2 per-turn runs
//       (which always arrive WITH a fresh checkpoint from the front-half) never
//       advanced the counter → every run overwrote turn-00.json;
//   (2) the counter was process-local starting at 0 → every server restart
//       overwrote the previous process's logs.
// Now: the counter scan-initializes from the existing files once per process and
// increments at WRITE time — every written log gets a unique, monotonic file.
let _turnCounter = 0;
let _turnCounterInited = false;

/** Pure: next turn-log number given existing file names. Exported for tests. */
export function computeNextTurnNumber(names: string[]): number {
  let max = -1;
  for (const n of names) {
    const m = /^turn-(\d+)\.json$/.exec(n);
    if (m) { const v = parseInt(m[1], 10); if (v > max) max = v; }
  }
  return max + 1;
}

/**
 * Resolve a WITHIN-BATCH reference to a created block's label.
 *
 * A ref can be an item id — v1 `item_N` OR v2 `group::local_id` — or an
 * existing graph label. The old resolvers gated on `startsWith("item_")`,
 * a v1-ism: every v2 within-batch based_on / supersedes / semantic edge fell
 * into the treat-as-label branch and was SILENTLY DROPPED at save
 * (found 2026-06-13 via the graph-vs-log audit: all 5 decisions wired at item
 * level, zero based_on edges in the graph; likely depressed v2 connectivity
 * in every prior A/B). Item-map FIRST — it is authoritative for this batch,
 * and demote-at-save updates it to the final label before it's read — then
 * label fallback; an item-shaped ref that created no block must NEVER be
 * treated as a label.
 */
export function resolveWithinBatchRefLabel(
  ref: string,
  itemIdToLabel: Map<string, string>,
): { label: string; viaItemMap: boolean } | null {
  const viaMap = itemIdToLabel.get(ref);
  if (viaMap) return { label: viaMap, viaItemMap: true };
  if (ref.startsWith("item_") || ref.includes("::")) return null; // item ref with no created block
  return { label: ref, viaItemMap: false };
}

/** Wipes the per-turn log directory — call at benchmark start. */
export function clearTurnLogs() {
  try {
    if (fs.existsSync(REFLECT_TURNS_DIR)) {
      for (const f of fs.readdirSync(REFLECT_TURNS_DIR)) {
        fs.unlinkSync(path.join(REFLECT_TURNS_DIR, f));
      }
    }
    _turnCounter = 0;
    _turnCounterInited = true; // dir is known-empty — no rescan needed
  } catch { /* non-critical */ }
}

function writeReflectLog(entry: object) {
  try {
    fs.mkdirSync(path.dirname(REFLECT_LOG_PATH), { recursive: true });
    fs.writeFileSync(REFLECT_LOG_PATH, JSON.stringify({ ts: new Date().toISOString(), ...entry }, null, 2));
  } catch { /* non-critical */ }
}

/**
 * Recover a drifted/missing `from_item_id` on Pass-3 `new_blocks` by type-matching each
 * unlinked block to an as-yet-unclaimed Pass-2 item of the same type. Mirrors the
 * save-loop fallback, but is hoisted ahead of the mandatory-item accounting guard so a
 * single drifted id no longer discards the entire arc (every correctly-built block
 * included). Mutates `newBlocks` in place; returns the count recovered.
 *
 * Only touches blocks whose `from_item_id` is absent or points at no real Pass-2 item —
 * a valid id is never reassigned. Matching is greedy against unclaimed items, so the SET
 * of from_item_ids ends up covering every accounted item even if an individual pairing
 * is approximate (the block content was already built correctly by Pass 3; this only
 * re-establishes the item↔block join used for accounting, relation-wiring, provenance).
 */
export function recoverDriftedFromItemIds(
  newBlocks: Array<{ from_item_id?: unknown; is_a?: unknown; label?: unknown }>,
  classified: Array<{ id: string; type: string }>,
): number {
  if (!Array.isArray(newBlocks) || newBlocks.length === 0) return 0;
  const validIds = new Set(classified.map((i) => i.id));
  const claimed = new Set<string>(
    newBlocks
      .map((b) => b.from_item_id)
      .filter((id): id is string => typeof id === "string" && validIds.has(id)),
  );
  let recovered = 0;
  for (const b of newBlocks) {
    if (typeof b.from_item_id === "string" && validIds.has(b.from_item_id)) continue;
    const match = classified.find((i) => i.type === b.is_a && !claimed.has(i.id));
    if (match) {
      b.from_item_id = match.id;
      claimed.add(match.id);
      recovered++;
    }
  }
  return recovered;
}

function writeTurnLog(turnData: object) {
  try {
    fs.mkdirSync(REFLECT_TURNS_DIR, { recursive: true });
    if (!_turnCounterInited) {
      _turnCounter = computeNextTurnNumber(fs.readdirSync(REFLECT_TURNS_DIR));
      _turnCounterInited = true;
    }
    const n = String(_turnCounter).padStart(2, "0");
    const turnPath = path.join(REFLECT_TURNS_DIR, `turn-${n}.json`);
    // `turn` is the log SEQUENCE number (file identity), injected here so it can
    // never disagree with the filename.
    fs.writeFileSync(turnPath, JSON.stringify({ ...turnData, turn: _turnCounter }, null, 2));
    _turnCounter++;
  } catch { /* non-critical */ }
}

// ─── Exported deterministic rules (tested in __tests__/pipeline-rules.test.ts) ─

/** Pre-populates extends_item from Pass 1 extends_id when Pass 2 left it blank. */
export function prePopulateExtendsItem(pass1Items: Pass1Item[], pass2Items: Pass2Item[]): void {
  const pass1Map = new Map(pass1Items.map(i => [i.id, i]));
  for (const classified of pass2Items) {
    if (!classified.extends_item) {
      const p1Item = pass1Map.get(classified.id);
      if (p1Item?.extends_id) classified.extends_item = p1Item.extends_id;
    }
  }
}

/**
 * Seam contract: if Pass 2 changed an item's type but didn't set review_reason,
 * stamp "type_override". Pass 2's prompt (pass2.ts:100) tells the model to set
 * the flag when overriding, but the model sometimes forgets — and downstream
 * consumers (Tier 1B validator, agent UI) can't distinguish a model-asserted
 * reclassification from a kept Pass 1 type without it. Charter rule 4: don't
 * coordinate via LLM restraint; enforce the seam contract in code.
 *
 * Stamp ONLY when (a) the Pass 1 item exists for this id, (b) types differ,
 * (c) review_reason is empty — never overwrites a Pass 2-set reason (graph_align,
 * novel_type, weak_match, etc.). Returns the count of items stamped.
 */
export function stampTypeOverrides(pass1Items: Pass1Item[], pass2Items: Pass2Item[]): number {
  const pass1TypeById = new Map(pass1Items.map(p1 => [p1.id, p1.provisional_type]));
  let stamped = 0;
  for (const item of pass2Items) {
    const pass1Type = pass1TypeById.get(item.id);
    if (pass1Type && pass1Type !== item.type && !item.review_reason) {
      item.review_reason = "type_override";
      stamped++;
    }
  }
  return stamped;
}

/**
 * Code dedup guard — collapses Pass 2 items with byte-identical normalized text but
 * different type. This is the structurally-determined slice of cross-type dedup: the LLM
 * emits the same sentence twice under two provisional types (e.g. fact + constraint), and
 * Pass 2 inconsistently catches it (~1/3 of runs in the refund A/B). Identical text is not
 * a semantic call — it is structural — so code is the right layer (charter rule 3).
 *
 * Charter compliance:
 *  - Rule 3 (match-to-competence): exact-text equality is structurally determined.
 *  - Rule 6 (catches a failure, never overrides a success): no-op when Pass 2 already
 *    collapsed the twins. Only fires on the failure case.
 *  - Rule 6 (falsifiable): the test is normalized-text equality — checkable.
 *  - Rule 7 (deterministic on probabilistic input): only catches IDENTICAL text;
 *    paraphrase/near-dup remains Pass 2's job (semantic judgment, LLM competence).
 *    The function deliberately does NOT extend to embedding similarity.
 *  - Identical text rules out a "genuine role-split": a real role-split has DIFFERENT
 *    content reflecting two different epistemic roles (e.g. decision "chose Y" + a
 *    separately-stated constraint Y the decision creates). Two items with byte-identical
 *    text are redundancy by definition, even if Pass 2 wired an edge between them — the
 *    edge is a self-referential redundancy, vestigial after collapse, and is dropped.
 *
 * Winner pick (when collapsing): prefer the item with non-empty causal wiring (it carries
 * the structural role); else prefer a non-fact type (more-specific epistemic role —
 * matches the LLM's own "kept as the more specific constraint type" choice in the firing
 * runs); else earliest by id.
 *
 * Returns the kept set + a record of every drop with its merge target. Cross-references
 * in surviving items' triggered_by_items / based_on_items are rewired from the dropped
 * id to the winner; any self-reference that results from the merge is stripped.
 */
export function dedupIdenticalEssenceTwins(
  items: Pass2Item[],
): { kept: Pass2Item[]; dropped: Array<{ id: string; mergedInto: string; reason: string }> } {
  const normalize = (s: string) => (s || "").toLowerCase().trim().replace(/\s+/g, " ");
  const groups = new Map<string, Pass2Item[]>();
  for (const item of items) {
    const key = normalize(item.text);
    if (!key) continue;
    const arr = groups.get(key);
    if (arr) arr.push(item); else groups.set(key, [item]);
  }

  const dropIds = new Set<string>();
  const dropped: Array<{ id: string; mergedInto: string; reason: string }> = [];
  const replacement = new Map<string, string>(); // dropped id → kept id, for rewiring

  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const types = new Set(group.map(i => i.type));
    if (types.size < 2) continue; // same-type dups are Pass 2 STEP I's job, not ours

    const hasWiring = (i: Pass2Item) =>
      (i.triggered_by_items?.length || 0) + (i.based_on_items?.length || 0) > 0;
    const sorted = [...group].sort((a, b) => {
      const aw = hasWiring(a) ? 1 : 0; const bw = hasWiring(b) ? 1 : 0;
      if (aw !== bw) return bw - aw;
      const aFact = a.type === "fact" ? 1 : 0; const bFact = b.type === "fact" ? 1 : 0;
      if (aFact !== bFact) return aFact - bFact; // non-fact first
      return a.id.localeCompare(b.id);
    });
    const winner = sorted[0];
    for (let i = 1; i < sorted.length; i++) {
      const loser = sorted[i];
      dropIds.add(loser.id);
      replacement.set(loser.id, winner.id);
      dropped.push({
        id: loser.id,
        mergedInto: winner.id,
        reason: `identical normalized text — ${loser.type} merged into ${winner.type}`,
      });
    }
  }

  if (dropIds.size === 0) return { kept: items, dropped };

  const kept = items
    .filter(i => !dropIds.has(i.id))
    .map(i => {
      const rewire = (refs: string[]) =>
        // Map dropped → winner, deduplicate, then drop any self-reference that emerged from the merge
        Array.from(new Set((refs || []).map(ref => replacement.get(ref) ?? ref))).filter(r => r !== i.id);
      // extends_item is a single within-batch id ref. Rewire dropped→winner; strip if the merge
      // makes it self-referential — otherwise it dangles at a deleted twin → spurious
      // extends_item_unresolved skip downstream (pipeline.ts resolution). supersedes_ref/resolved_ref
      // are external graph LABELS, not within-batch ids, so they can't dangle here — left untouched.
      const rewiredExtends = i.extends_item ? (replacement.get(i.extends_item) ?? i.extends_item) : i.extends_item;
      return {
        ...i,
        triggered_by_items: rewire(i.triggered_by_items || []),
        based_on_items: rewire(i.based_on_items || []),
        extends_item: rewiredExtends === i.id ? undefined : rewiredExtends,
      };
    });

  return { kept, dropped };
}

/**
 * Tier 1C (2026-05-24): unique{}-content dedup.
 *
 * A block's identity is its content.unique{} (the structured data), NOT its
 * essence (a paraphrasable summary — see [[feedback-identity-is-unique-not-label]]).
 * dedupIdenticalEssenceTwins compares essence TEXT and so misses two real
 * duplicate patterns:
 *   - CROSS-TYPE: same claim emitted under two type labels with different essence
 *     wording AND different field NAMES — e.g. decision{value:"Chalice",reason:…}
 *     vs dead_end{approach:"Chalice",reason:…}. Same data, different shape.
 *   - PARAPHRASE: same claim, same type, slightly different essence wording but
 *     identical unique{} values.
 *
 * This groups items by their normalized unique{} VALUE-SET. Field NAMES are
 * ignored — only the values matter, because field names are interchangeable
 * across types for the same claim. Identical value-sets collapse to one.
 *
 * Safe against FRAGMENTATION: fragments carry DIFFERENT unique{} values (different
 * slices of one larger thing), so they never share a value-set key and are left
 * untouched. Only EXACT normalized value-set matches collapse — which makes the
 * false-positive risk near zero (byte-identical structured data IS the same claim).
 *
 * Winner selection prefers, in order: schema-valid (Tier 1B validateUniqueSchema)
 * → has causal wiring → non-fact → lowest id. The schema-valid preference means
 * the structurally-correct block survives (the dead_end{approach,reason} beats the
 * mis-typed decision{value,reason} for the same Chalice claim).
 *
 * Runs after dedupIdenticalEssenceTwins, behind NODEDEX_CODE_DEDUP. Charter rule 7
 * (deterministic guard on probabilistic input) + rule 2 (pre-commit collapse only).
 */
export function dedupIdenticalUniqueValues(
  items: Pass2Item[],
): { kept: Pass2Item[]; dropped: Array<{ id: string; mergedInto: string; reason: string }> } {
  const normalize = (s: string) => (s || "").toLowerCase().trim().replace(/\s+/g, " ");
  const valueSetKey = (item: Pass2Item): string => {
    const u = item.unique || {};
    const vals: string[] = [];
    for (const v of Object.values(u)) {
      if (v === null || v === undefined) continue;
      const s = normalize(String(v));
      if (s === "") continue;
      vals.push(s);
    }
    if (vals.length === 0) return ""; // nothing to compare (e.g. project/process)
    return vals.sort().join(" ¦ ");
  };

  const groups = new Map<string, Pass2Item[]>();
  for (const item of items) {
    const key = valueSetKey(item);
    if (!key) continue;
    const arr = groups.get(key);
    if (arr) arr.push(item); else groups.set(key, [item]);
  }

  const dropIds = new Set<string>();
  const dropped: Array<{ id: string; mergedInto: string; reason: string }> = [];
  const replacement = new Map<string, string>(); // dropped id → kept id, for rewiring

  const schemaValid = (i: Pass2Item) => validateUniqueSchema(i.type, i.unique || {}).ok;
  const hasWiring = (i: Pass2Item) =>
    (i.triggered_by_items?.length || 0) + (i.based_on_items?.length || 0) > 0;

  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const sorted = [...group].sort((a, b) => {
      const av = schemaValid(a) ? 1 : 0; const bv = schemaValid(b) ? 1 : 0;
      if (av !== bv) return bv - av;                       // schema-valid first
      const aw = hasWiring(a) ? 1 : 0; const bw = hasWiring(b) ? 1 : 0;
      if (aw !== bw) return bw - aw;                       // wired first
      const aFact = a.type === "fact" ? 1 : 0; const bFact = b.type === "fact" ? 1 : 0;
      if (aFact !== bFact) return aFact - bFact;           // non-fact first
      return a.id.localeCompare(b.id);                     // stable tiebreak
    });
    const winner = sorted[0];
    for (let i = 1; i < sorted.length; i++) {
      const loser = sorted[i];
      dropIds.add(loser.id);
      replacement.set(loser.id, winner.id);
      const crossType = loser.type !== winner.type;
      dropped.push({
        id: loser.id,
        mergedInto: winner.id,
        reason: `identical unique{} value-set — ${loser.type} merged into ${winner.type}${crossType ? " (cross-type)" : " (same-type paraphrase)"}`,
      });
    }
  }

  if (dropIds.size === 0) return { kept: items, dropped };

  const kept = items
    .filter(i => !dropIds.has(i.id))
    .map(i => {
      const rewire = (refs: string[]) =>
        // Map dropped → winner, deduplicate, then drop any self-reference that emerged from the merge
        Array.from(new Set((refs || []).map(ref => replacement.get(ref) ?? ref))).filter(r => r !== i.id);
      // extends_item is a single within-batch id ref. Rewire dropped→winner; strip if the merge
      // makes it self-referential — otherwise it dangles at a deleted twin → spurious
      // extends_item_unresolved skip downstream (pipeline.ts resolution). supersedes_ref/resolved_ref
      // are external graph LABELS, not within-batch ids, so they can't dangle here — left untouched.
      const rewiredExtends = i.extends_item ? (replacement.get(i.extends_item) ?? i.extends_item) : i.extends_item;
      return {
        ...i,
        triggered_by_items: rewire(i.triggered_by_items || []),
        based_on_items: rewire(i.based_on_items || []),
        extends_item: rewiredExtends === i.id ? undefined : rewiredExtends,
      };
    });

  return { kept, dropped };
}

/**
 * FOLD constituent reason-facts into the state-change unit they justify.
 *
 * The problem (traversal-proven 2026-06-04, [[project-fragmentation-not-worth-fold-2026-06-04]]):
 * the pipeline's over-extraction is GRANULARITY, not WORTH. Pass 1 fragments one
 * coherent unit — a decision/dead_end/constraint and its REASONS — into many
 * separate blocks (e.g. decision "raised beds" + standalone facts "better
 * drainage" / "soil control" / "easier weeding"). Every fragment is genuine
 * residue, so JUDGE (which keeps/drops WHOLE items) correctly keeps them all and
 * physically CANNOT consolidate. WORTH and GRANULARITY are different jobs at
 * different seams: worth = JUDGE (residue vs scaffolding); granularity = here.
 *
 * The fix is FOLD, not dedup. Dedup = "A and B are the same claim, keep one."
 * Fold = "B is A's REASON; it already belongs inside A's rationale — absorb it,
 * don't scatter it as a redundant standalone block." Charter §3: the graph grows
 * by ENRICHMENT, not just addition. A block that merely restates a parent's reason
 * carries no distinct meaning forward.
 *
 * Why HERE (post-2c, pre-Pass-3) and not Pass 1/2a or JUDGE:
 *  - A fact sits on MULTIPLE within-batch paths; foldability needs the FULL wired
 *    relationship set, which only exists after Pass 2c wired causality. At
 *    classify time (2a) the path picture is unknown — you'd fold blind.
 *  - Pass 1 has weak restraint/decomposition (charter Rule 4: "a fix that relies
 *    on the LLM holding back will fail") — fragmentation ORIGINATES there.
 *  - JUDGE is worth, not granularity.
 *
 * Detection is STRUCTURAL / deterministic (charter Rule 3 — count wired edges,
 * never semantic similarity). A fact F folds into unit U iff:
 *   (1) F.type === "fact"                          — only facts fold; units never do.
 *   (2) EXACTLY ONE classified item references F at all, counting based_on +
 *       triggered_by + extends_item — the "sole-constituent / no shared anchor"
 *       guard. >1 referrer → KEEP (a shared root like a shelf-life fact reused by
 *       two decisions). This is the un-fenced over-folding risk, made REAL by
 *       counting the wiring instead of guessing.
 *   (3) that single referrer U references F via based_on_items — the RATIONALE
 *       edge. We deliberately do NOT fold on triggered_by/extends alone: a fact
 *       that merely TRIGGERED a decision is often independently valuable (e.g.
 *       "budget cut 40%"), whereas a based_on fact is a pure justification. This
 *       is MORE conservative than the design memo's "based_on/prompted_by" wording
 *       — chosen on the asymmetric-cost rule (a false fold loses data permanently;
 *       a redundant block is mere clutter), matching the code-dedup stance above.
 *   (4) U.type ∈ {decision, dead_end, constraint} — only state-change units have a
 *       `reason` slot to absorb into.
 *   (5) F has NO outgoing reason edge (based_on/extends) — a true leaf. A fact with
 *       its own provenance is not a pure constituent; folding would dangle it.
 *
 * ENRICH, never delete (charter Rule 2 safe): F's content is appended to U's
 * unique.reason (if not already substantively present — 2b often already filled
 * it, in which case F was pure redundancy), then F is removed from the classified
 * set so Pass 3 never builds it as a standalone block. Nothing is deleted — F was
 * never a block; its meaning is RELOCATED into the unit it always belonged to.
 *
 * Source/mode-independent: the agent's own "I chose X because Y" folds the same as
 * a user-sourced reason. Default OFF (NODEDEX_FOLD_CONSTITUENTS=1).
 */
const FOLD_STATE_CHANGE_TYPES: ReadonlySet<string> = new Set(["decision", "dead_end", "constraint"]);

export function foldConstituentFacts(
  items: Pass2Item[],
): { kept: Pass2Item[]; folded: Array<{ id: string; foldedInto: string; enriched: boolean; reason: string }> } {
  const folded: Array<{ id: string; foldedInto: string; enriched: boolean; reason: string }> = [];
  const foldedIds = new Set<string>();

  // Inverted reference index over the WIRED within-batch edges.
  //  - rationaleRefs[F] = units U with based_on F (F is U's justification).
  //  - anyRefs[F]       = every item referencing F via based_on | triggered_by |
  //                       extends — the "no shared anchor" guard population.
  const rationaleRefs = new Map<string, Pass2Item[]>();
  const anyRefs = new Map<string, Pass2Item[]>();
  const push = (m: Map<string, Pass2Item[]>, key: string, v: Pass2Item) => {
    const a = m.get(key); if (a) a.push(v); else m.set(key, [v]);
  };
  for (const u of items) {
    for (const ref of u.based_on_items || []) { push(rationaleRefs, ref, u); push(anyRefs, ref, u); }
    for (const ref of u.triggered_by_items || []) { push(anyRefs, ref, u); }
    if (u.extends_item) push(anyRefs, u.extends_item, u);
  }

  for (const f of items) {
    if (f.type !== "fact") continue;                                    // guard 1
    const refs = anyRefs.get(f.id) || [];
    if (refs.length !== 1) continue;                                    // guard 2 — sole referrer
    const u = refs[0];
    if (!(u.based_on_items || []).includes(f.id)) continue;             // guard 3 — rationale edge
    if (!FOLD_STATE_CHANGE_TYPES.has(u.type)) continue;                 // guard 4 — unit absorbs
    if ((f.based_on_items || []).length > 0 || f.extends_item) continue; // guard 5 — F is a leaf

    // ENRICH (Rule 2 safe) — relocate F's claim into U's rationale. F's `text` is
    // the human-readable claim at this stage (essence is derived later by Pass 3);
    // fall back to the first non-empty unique{} value.
    const claim = ((f.text || "").trim())
      || (Object.values(f.unique || {}).map(v => (v ?? "").toString().trim()).find(v => v !== "") || "");
    if (!u.unique) u.unique = {};
    const existing = (u.unique.reason || "").trim();
    const normExisting = existing.toLowerCase().replace(/\s+/g, " ");
    const normClaimHead = claim.toLowerCase().replace(/\s+/g, " ").slice(0, 40);
    let enriched = false;
    if (claim && normClaimHead && !normExisting.includes(normClaimHead)) {
      u.unique.reason = existing ? `${existing}; ${claim}` : claim;
      enriched = true;
    }
    // Drop F's now-absorbed edge from U so it does not dangle at an item Pass 3
    // never builds. (By guard 2, U is the ONLY referrer — nothing else to rewire.)
    u.based_on_items = (u.based_on_items || []).filter(r => r !== f.id);

    foldedIds.add(f.id);
    folded.push({
      id: f.id,
      foldedInto: u.id,
      enriched,
      reason: `constituent reason-fact folded into ${u.type} ${u.id}`
        + (enriched ? " (rationale enriched)" : " (already in rationale — redundant block removed)"),
    });
  }

  if (foldedIds.size === 0) return { kept: items, folded };
  return { kept: items.filter(i => !foldedIds.has(i.id)), folded };
}

/** Returns true if a block label already exists — label-level dedup. */
export function isDuplicateLabel(label: string, allBlocks: Array<{ label: string }>): boolean {
  return allBlocks.some(b => b.label === label);
}

/**
 * Commit this turn's pending blocks → 'active', but ONLY those STILL pending.
 *
 * A block created this turn (status='pending') can be archived in the interim by a
 * SAME-TURN supersede: Pass 4 creates a `supersedes` edge, and database.ts:981 archives
 * a superseded decision/blueprint. The old blind loop set every pending id to 'active'
 * unconditionally → it RESURRECTED the just-archived block, undoing the supersede-archive
 * (the activate-pending race; surfaced by the 5-turn deep test 2026-05-26, T5 retrospective).
 *
 * This rule lives HERE (the committer), not in the DB layer, deliberately: only the committer
 * has the context "these are THIS turn's new blocks." The DB can't enforce "archived↛active"
 * because that transition is legitimately used for reactivation-on-recreate (database.ts:603).
 * The committer reads each block's CURRENT status (not the stale create-time snapshot) and
 * commits only the still-pending ones; an interim archive is respected.
 *
 * Pure-ish: takes a minimal structural db (getBlock + updateBlock) so it's unit-testable
 * without a real DB. Returns counts for logging/audit.
 */
export function activatePendingBlocks(
  db: {
    getBlock: (id: string) => { status: string } | null | undefined;
    updateBlock: (id: string, patch: { status: string }) => unknown;
  },
  pendingIds: string[],
): { activated: number; skippedArchived: number } {
  let activated = 0;
  let skippedArchived = 0;
  for (const id of pendingIds) {
    const b = db.getBlock(id);
    if (b && b.status === "pending") {
      db.updateBlock(id, { status: "active" });
      activated++;
    } else if (b && b.status === "archived") {
      skippedArchived++;  // archived in-turn (same-turn supersede) — leave it; never resurrect
    }
  }
  return { activated, skippedArchived };
}

/**
 * Relation dedup guard — prevents exact duplicate relations.
 * Only skips when source + type + target are all identical.
 * Does NOT collapse different relation types to the same target —
 * prompted_by, based_on, and extends are semantically distinct even when
 * they point at the same block.
 */
export function shouldSkipRelation(
  sourceId: string,
  targetId: string,
  relType: string,
  db: WorkspaceDB,
): boolean {
  if (sourceId === targetId) return true; // self-referential relation
  const existing = db.getRelations(sourceId)
    .filter(r => r.direction === "outgoing" && r.target_id === targetId);
  return existing.some(r => r.type === relType);
}

/** Returns true if the project prefix is recognised (known or just created this batch). */
export function isKnownProject(
  project: string,
  knownProjects: Set<string>,
  newProjectLabels: Set<string>,
): boolean {
  return knownProjects.has(project) || newProjectLabels.has(project);
}

/** Returns true if the label has an acceptable number of underscore-separated segments. */
export function isValidLabelSegmentCount(label: string, knownBlockTypes: Set<string>): boolean {
  const segs = label.split("_");
  if (segs.length <= 4) return true;
  const hasCompound = knownBlockTypes.has(segs.slice(1, 3).join("_")) ||
                      knownBlockTypes.has(segs.slice(2, 4).join("_"));
  return hasCompound;
}

/**
 * Bug 3 fix (2026-05-28): resolve the effective parent for a project_creates[]
 * entry. Pass 3's `parent` is optional and the LLM effectively never sets it
 * (0 part_of edges across 10 transcripts in the scale audit), but Pass 0's
 * scope_project IS the parent by design for any sub-project in the same batch.
 *
 * Rule:
 *   - If pass3 set `parent` explicitly → respect it (don't override LLM intent).
 *   - Else, if scope_project exists AND the projDef isn't the scope itself →
 *     default parent = scope.
 *   - Else → no parent (top-level project).
 *
 * Charter rule 3 — structurally-determined transformation belongs in code, not
 * delegated to LLM judgment.
 */
export function resolveProjectParent(
  projDef: { label: string; parent?: string },
  scopeProjectLabel: string | undefined,
): string | undefined {
  if (projDef.parent) return projDef.parent;
  if (scopeProjectLabel && projDef.label !== scopeProjectLabel) return scopeProjectLabel;
  return undefined;
}

/**
 * Bug 2 fix (2026-05-28): repair labels that use a multi-word type's literal
 * form (`dead_end`, or any custom multi-word type) where the canonical rule
 * (pass3.ts:50) requires hyphens within the type dimension (`dead-end`).
 *
 * Empirical: 2/6 dead_end blocks in the 2026-05-28 scale audit were buggy
 * underscore-form, adding a phantom dimension to label-parsers. Same anti-
 * pattern as Bug 3 — a structurally-determined transformation delegated to
 * LLM judgment (charter rule 3). Pure idempotent function: a clean label is
 * unchanged.
 *
 * Anchoring: replaces only `_${type}_` (within-label) and trailing `_${type}`
 * (end-of-label) — never matches coincidental concept-token occurrences.
 * Idempotent: hyphenated form has no underscores to find on a second pass.
 */
export function normalizeMultiWordTypeInLabel(
  label: string,
  multiWordTypes: Set<string>,
): string {
  if (!label || typeof label !== "string") return label;
  let result = label;
  for (const t of multiWordTypes) {
    if (!t.includes("_")) continue;
    const hyphenated = t.replaceAll("_", "-");
    // Within-label: project_dead_end_concept → project_dead-end_concept
    result = result.split(`_${t}_`).join(`_${hyphenated}_`);
    // End-of-label: project_dead_end → project_dead-end (rare; defensive)
    if (result.endsWith(`_${t}`)) {
      result = result.slice(0, result.length - t.length) + hyphenated;
    }
  }
  return result;
}

// ─── chain_id post-processing ─────────────────────────────────────────────────
// Stamps a shared chain_id on blocks connected by prompted_by, based_on, or extends.
function stampFlowRolesAndChains(
  savedLabels: string[],
  allBlocks: any[],
  db: WorkspaceDB,
): void {
  if (savedLabels.length === 0) return;

  const labelToId = new Map<string, string>();
  for (const b of allBlocks) labelToId.set(b.label, b.id);
  const newIds = new Set<string>(savedLabels.map(l => labelToId.get(l)).filter(Boolean) as string[]);
  if (newIds.size === 0) return;

  // chain_id clustering uses the shared causal-thread set (relation-sets.ts) —
  // unified 2026-06-05 with read-side traversal + Pass 5 assembly so the three
  // "chain" notions agree on which edges are the causal thread. This ADDS
  // supports / supersedes / superseded_by / resolves (supports alone is ~half of
  // all causal edges) so supports-linked residue — e.g. a user's lived failure
  // wired as "specific instance SUPPORTS the general dead-end" — joins its arc
  // instead of orphaning. Validated by a clustering simulation (C:/tmp): pulls
  // orphans into their arc, keeps genuinely edge-less blocks out, no cross-arc
  // over-merge (components stay within-project + topically coherent).
  const allRels = db.getAllRelations(false).filter((r: any) => r.status === "active" && CAUSAL_TRAVERSAL_RELS.has(r.type));

  const modifiedChainIds = new Set<string>();

  // Build adjacency graph among new blocks only (within-batch connections)
  const graph = new Map<string, Set<string>>();
  for (const id of newIds) graph.set(id, new Set());
  for (const rel of allRels) {
    if (newIds.has(rel.source_id) && newIds.has(rel.target_id)) {
      graph.get(rel.source_id)!.add(rel.target_id);
      graph.get(rel.target_id)!.add(rel.source_id);
    }
  }

  // BFS — find connected components within this batch and stamp shared chain_id
  const visited = new Set<string>();
  for (const startId of newIds) {
    if (visited.has(startId)) continue;
    const component: string[] = [];
    const queue = [startId];
    while (queue.length > 0) {
      const id = queue.shift()!;
      if (visited.has(id)) continue;
      visited.add(id);
      component.push(id);
      for (const neighbor of graph.get(id) ?? []) {
        if (!visited.has(neighbor)) queue.push(neighbor);
      }
    }
    if (component.length >= 2) {
      const chainId = uuidv4();
      for (const id of component) {
        db.updateBlock(id, { chain_id: chainId });
        const b = allBlocks.find((x: any) => x.id === id);
        if (b) b.chain_id = chainId;
      }
      modifiedChainIds.add(chainId);
    }
  }

  // Cross-batch stitching: connect new blocks to existing blocks via CHAIN_RELs.
  const idToBlock = new Map<string, any>();
  for (const b of allBlocks) idToBlock.set(b.id, b);

  for (const newId of newIds) {
    const newBlock = idToBlock.get(newId);
    if (!newBlock) continue;

    for (const rel of allRels) {
      const newIsSource = rel.source_id === newId && !newIds.has(rel.target_id);
      const newIsTarget = rel.target_id === newId && !newIds.has(rel.source_id);
      if (!newIsSource && !newIsTarget) continue;

      const existingId = newIsSource ? rel.target_id : rel.source_id;
      const existingBlock = db.getBlock(existingId);
      if (!existingBlock || existingBlock.status === "archived") continue;

      const existingChainId: string | null = existingBlock.chain_id ?? null;
      const newChainId: string | null = newBlock.chain_id ?? null;

      if (existingChainId && newChainId) {
        if (existingChainId !== newChainId) {
          // blk_ chain_ids are canonical (assigned by Pass 5, saved in DB).
          // UUID chain_ids are ephemeral (scratch, assigned during this batch's BFS).
          // Canonical always beats ephemeral — never let a UUID overwrite a blk_ chain.
          const existingIsCanonical = existingChainId.startsWith("blk_");
          const newIsCanonical      = newChainId.startsWith("blk_");
          const winner = (existingIsCanonical && !newIsCanonical) ? existingChainId
                       : (!existingIsCanonical && newIsCanonical) ? newChainId
                       : (existingChainId < newChainId ? existingChainId : newChainId);
          const loser  = winner === existingChainId ? newChainId : existingChainId;
          const toMerge = allBlocks.filter((b: any) => b.chain_id === loser);
          for (const b of toMerge) {
            db.updateBlock(b.id, { chain_id: winner });
            b.chain_id = winner;
          }
          db.updateBlock(existingId, { chain_id: winner });
          newBlock.chain_id = winner;
          modifiedChainIds.delete(loser);
          modifiedChainIds.add(winner);
        } else {
          modifiedChainIds.add(existingChainId);
        }
      } else if (existingChainId && !newChainId) {
        db.updateBlock(newId, { chain_id: existingChainId });
        newBlock.chain_id = existingChainId;
        modifiedChainIds.add(existingChainId);
      } else if (!existingChainId && newChainId) {
        db.updateBlock(existingId, { chain_id: newChainId });
        modifiedChainIds.add(newChainId);
      } else {
        const chainId = uuidv4();
        db.updateBlock(newId, { chain_id: chainId });
        db.updateBlock(existingId, { chain_id: chainId });
        newBlock.chain_id = chainId;
        modifiedChainIds.add(chainId);
      }
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// PIPELINE ORCHESTRATOR
// ═══════════════════════════════════════════════════════════════════════════════

export async function runAutoReflect(
  db: WorkspaceDB,
  agentResponse: string,
  loadedBlocks: string[],
  _userMessage?: string,
  agentThinking?: string,
  embeddings?: EmbeddingEngine,
  recalledBlocks?: Array<{ id: string; label: string; essence: string; type: string }>,
  agentId?: string,
  checkpoint?: PipelineCheckpoint,
  // ── DEBT 5 Phase 2: turn identity for conversation_turns persistence ──
  // Required when NODEDEX_ARC_EXTRACTION=1 + agentId is set. When the flag
  // is on AND all three (agentId + turnNumber) are present, the pipeline
  // INSERTs a conversation_turns row at start, runs Pass 0-1, UPDATEs with
  // pass01_output_json, then early-returns (Pass 2-5 will run at arc trigger,
  // Phase 3). When the flag is off OR turn identity is missing, behaves
  // identically to today (no new code paths fire). Per Variant A §2.1, §2.6.
  turnNumber?: number,
  turnName?: string,
): Promise<ReflectResult> {
  const empty: ReflectResult = { saved: 0, updated: 0, skipped: 0, saved_labels: [], uncertain_count: 0, created_blocks: [], updated_blocks: [] };
  const provider = getLLMProvider();
  if (!provider.isAvailable()) return empty;

  const stateLabel = agentId ? `agent_session_state_${agentId}` : "agent_session_state";
  const geminiCreatedBy = agentId ? `gemini_reflect_${agentId.slice(0, 8)}` : "gemini_reflect";

  const KNOWN_BLOCK_TYPES = new Set([
    "fact", "question", "hypothesis", "decision", "dead_end", "insight",
    "preference", "constraint", "blueprint", "process",
    "note", "project", "event", "entity",
    // reasoning_chain/metric/claim collapsed → insight/fact (2026-06-15)
  ]);

  // Skip only EMPTY turns. NODEDEX_EXTRACT_ALL_SOURCES disables the LENGTH heuristic
  // entirely (length != residue — a 12-char user turn can be a decision); empty turns
  // then self-handle (extraction finds nothing -> JUDGE keeps nothing -> no blocks).
  // NODEDEX_MIN_TURN_CHARS tunes the floor (default 10 — extraction itself, not length, is
  // the real filter; a short turn with no residue simply yields 0 blocks). Raise it to cut
  // pipeline calls on tiny turns when running a PAID extraction model (free models = $0).
  const extractAllSources = process.env.NODEDEX_EXTRACT_ALL_SOURCES === "1";
  const minTurnChars = (() => {
    const n = parseInt(process.env.NODEDEX_MIN_TURN_CHARS ?? "", 10);
    return Number.isFinite(n) && n >= 0 ? n : 10;
  })();
  const combinedLength = (agentResponse?.length ?? 0) + (agentThinking?.length ?? 0);
  if (!extractAllSources && combinedLength < minTurnChars) {
    console.log(`Auto-Reflect: skipping trivial turn (< ${minTurnChars} chars)`);
    return empty;
  }

  // ─── DEBT 5 Phase 2: arc-extraction mode — capture turn at start ──────────
  // Required gating: flag on AND we have an agent+turn identity. Captures the
  // transcript even if Pass 0/1 fail (charter Rule 2 spirit: don't lose source).
  // The row gets UPDATEd to status='pass01_done' after Pass JUDGE completes.
  // If the flag is off OR identity is missing → _conversationTurnId stays null
  // and the existing per-turn pipeline runs unchanged.
  let _conversationTurnId: string | null = null;
  const _arcExtractionOn = process.env.NODEDEX_ARC_EXTRACTION === "1";
  if (_arcExtractionOn && agentId && turnNumber !== undefined) {
    try {
      const transcriptJson = JSON.stringify({
        user_message:    _userMessage ?? "",
        agent_response:  agentResponse,
        agent_thinking:  agentThinking ?? "",
      });
      const existing = db.getConversationTurnByAgentTurn(agentId, turnNumber);
      if (existing) {
        // Idempotency: pipeline re-fire for same (agent, turn) — reuse the row.
        // Common path: reflect-queue retry after rate-limit puts the same job back.
        _conversationTurnId = existing.id;
        console.log(`[arc-extract] re-entering existing conversation_turn id=${existing.id} status=${existing.status} (agent=${agentId.slice(0, 8)} turn=${turnNumber})`);
      } else {
        const row = db.createConversationTurn({
          agent_id:        agentId,
          turn_number:     turnNumber,
          turn_name:       turnName ?? null,
          transcript_json: transcriptJson,
        });
        _conversationTurnId = row.id;
        console.log(`[arc-extract] captured conversation_turn id=${row.id} agent=${agentId.slice(0, 8)} turn=${turnNumber}`);
      }
    } catch (e: any) {
      console.warn(`[arc-extract] conversation_turn INSERT failed (${e?.message}) — falling back to per-turn pipeline (no arc capture for this turn)`);
      _conversationTurnId = null;
    }
  } else if (_arcExtractionOn) {
    // Flag on but identity missing — possible misconfig. Log once + degrade.
    console.warn(`[arc-extract] NODEDEX_ARC_EXTRACTION=1 but agentId/turnNumber missing (agentId=${agentId ?? "<none>"} turnNumber=${turnNumber ?? "<none>"}) — running per-turn pipeline (no arc capture)`);
  }

  // ARC CAPTURE — ALWAYS lazy (v1 retired & disabled 2026-06-22). The v2 arc engine
  // re-reads the RAW transcript (arc-pipeline.ts) and IGNORES per-turn pass01 items;
  // v1 — the only thing that ever consumed them — is now disabled, so running Pass 0-1
  // at capture is pure waste with NO consumer. The transcript is already stored above;
  // persist an EMPTY pass01 (status → pass01_done = the arc-ready signal) and return,
  // SKIPPING Pass 0-1 BEFORE any LLM call. The NODEDEX_V2_LAZY_CAPTURE gate is dropped:
  // capture is unconditionally lazy now (the v2 arc always reads raw).
  if (_conversationTurnId) {
    try {
      db.updateConversationTurnPass01(_conversationTurnId, JSON.stringify({ scene_card: null, items: [] }));
      console.log(`[arc-extract] lazy-capture: stored raw, SKIPPED Pass 0-1 (v2 reads raw at arc) — id=${_conversationTurnId}`);
    } catch (e: any) {
      console.warn(`[arc-extract] lazy-capture persist failed id=${_conversationTurnId}: ${e?.message}`);
    }
    return empty;
  }

  try {
    const allBlocks = db.getAllBlocks();
    const allRels = db.getAllRelations(false);

    // ── Orphan heal: set project_id on blocks whose label prefix matches a project ──
    {
      const projectMap = new Map(allBlocks.filter((b) => b.type === "project").map((b) => [b.label, b]));
      for (const block of allBlocks) {
        if (block.type === "project" || block.project_id) continue;
        const parts = block.label.split("_");
        const proj = projectMap.get(parts[0]);
        if (!proj) continue;

        db.updateBlock(block.id, { project_id: proj.id });
        block.project_id = proj.id; // keep in-memory allBlocks current
        console.log(`Auto-Reflect: healed orphan "${block.label}" → project "${proj.label}"`);
      }
    }

    // ── Read session state ──
    let recentSaves = "";
    let prevEntityMap: Array<{ reference: string; resolved_to: string }> = [];
    try {
      const stateBlock = db.getBlock(stateLabel);
      if (stateBlock) {
        const sc = JSON.parse(stateBlock.content as string);
        const recents: any[] = sc.gemini_recent_saves || [];
        if (recents.length > 0) {
          recentSaves = recents.map((r: any) => {
            let line = `- ${r.label}: "${r.essence}"`;
            if (r.values) line += ` [values: ${r.values}]`;
            return line;
          }).join("\n");
        }
        if (sc.prev_turn_context?.entity_map) {
          prevEntityMap = sc.prev_turn_context.entity_map;
        }
      }
    } catch { /* */ }

    // ── Agent-saved blocks this turn (last 20 min, non-Gemini) ──
    const twentyMinutesAgo = Date.now() - 20 * 60 * 1000;
    const agentSavedBlocks = allBlocks
      .filter((b: any) => {
        if (!b.created_at || b.type === "project") return false;
        if (typeof b.created_by === "string" && b.created_by.startsWith("gemini_reflect")) return false;
        return new Date(b.created_at).getTime() >= twentyMinutesAgo;
      })
      .map((b: any) => {
        let unique: Record<string, any> = {};
        try { unique = (typeof b.content === "string" ? JSON.parse(b.content) : b.content)?.unique ?? {}; } catch { /* */ }
        return { id: b.id, label: b.label, type: b.type, essence: b.essence || "", unique };
      });

    if (agentSavedBlocks.length > 0) {
      console.log(`Auto-Reflect: ${agentSavedBlocks.length} agent-saved block(s) this turn`);
    }

    // ── Known project roots ──
    const knownRoots = allBlocks
      .filter((b) => b.type === "project")
      .map((b) => ({ label: b.label, essence: b.essence || "" }));

    const allProjectPrefixes = new Set(knownRoots.map((r) => r.label));

    // Infer active project from loaded blocks
    const activeProjectPrefixes = new Set<string>();
    for (const id of loadedBlocks) {
      const b = allBlocks.find((x: any) => x.id === id);
      if (!b) continue;
      const prefix = (b.label || "").split("_")[0];
      if (allProjectPrefixes.has(prefix)) activeProjectPrefixes.add(prefix);
    }
    if (activeProjectPrefixes.size === 0) {
      for (const p of allProjectPrefixes) activeProjectPrefixes.add(p);
    }

    // Full project context for Pass 3
    const { context: projectContext, reflectedIds: _reflectedIds0 } = buildProjectContext(allBlocks, allRels, allProjectPrefixes, loadedBlocks);
    db.stampReflectedAt(_reflectedIds0);

    // ── PASS 1 + 2: Extract & Classify ──
    let pass1: Pass1Result | null = null;
    let pass2: Pass2Result | null = null;
    let _pass0Raw: any = null;
    let _sceneCard: string | undefined;
    let _pass1Thinking = "";
    let _pass2Thinking = "";
    let _pass2Context = "";
    let _pass4Thinking = "";
    let _pass4Result: { relations: Array<{ source_id: string; type: string; target_id: string; reason?: string }> } | null = null;
    // Pass 5 chain-assembly result captured for the turn log. The chains carry
    // the per-chain `reasoning` field (commit 450d631) — debug instrumentation
    // that has no graph-persistence path (chain blocks store arc/conclusion/essence
    // only), so the turn log is where it's read post-run. Without this, the
    // reasoning the LLM produces is dropped on the floor.
    let _pass5Result: Pass5Result | null = null;
    // Per-pass provider instrumentation (model actually used + attempt trail). Surfaces
    // the run-to-run non-determinism: a primary truncation → fallback escalation produces
    // a wildly different graph (different model classifies differently). The turn log gets
    // these in writeTurnLog → providers.passN so an A/B can correlate divergence with model.
    type ProviderInfo = { model?: string; attempts?: Array<{ model: string; outcome: string }> };
    let _pass0Provider: ProviderInfo | undefined;
    let _pass1Provider: ProviderInfo | undefined;
    let _pass2Provider: ProviderInfo | undefined;
    let _pass3Provider: ProviderInfo | undefined;
    let _pass4Provider: ProviderInfo | undefined;
    let _pass5Provider: ProviderInfo | undefined;
    // Pass 2 split orchestrator returns auditable per-stage counts (2a/2b/2c
    // throughput, seam α verdicts, re-fill salvage outcomes, quarantine
    // writes). Captured only when NODEDEX_PASS2_SPLIT=1 fires the split
    // branch — surfaces in writeTurnLog so split runs are debuggable
    // without querying the quarantine table directly. Per
    // PASS2-SPLIT-DESIGN.md §7 telemetry requirement.
    let _pass2SplitAudit: Pass2SplitResult["splitAudit"] | undefined;
    // JUDGE (precision filter between Pass 1 and Pass 2) — flag-gated via
    // NODEDEX_WORTH_JUDGE_ENABLED. Captures the per-call provider trail + the verdicts
    // for the turn log so drops can be content-audited (per the lesson: verdict lives
    // in the pass-log reasoning, never in block counts).
    let _passJudgeProvider: ProviderInfo | undefined;
    let _passJudgeKeptCount: number | undefined;
    let _passJudgeDropped: PassJudgeVerdict[] = [];
    let _passJudgeAnchorOverrides: string[] = [];

    // debt-4 Stage A — per-pass wall time tracking. Local to this runReflect call
    // (resets implicitly per turn since it's a fresh closure). Each pass measured
    // by Date.now() bracketing around the await callPassNLLM(...) site.
    // Surfaces in turn-log so a future reader can see where time goes per pass,
    // not just aggregate cost. The current cost_breakdown only covers $$;
    // wall_ms covers time (the two correlate but aren't identical — thinking
    // budget dominates time while output tokens dominate cost).
    const _passWallMs: Record<string, number> = {};
    // debt-4 Stage A — embedding stats are accumulated globally (same lifecycle
    // as reflectTokenStats). Capture snapshot at runReflect start so the
    // turn-log can record per-turn DELTA (consumers can also reconstruct from
    // cross-turn diff). This is the hidden time tax exposed: ~100+ sequential
    // embedding calls per moderate turn at ~300ms each = ~30s/turn invisible
    // to cost_breakdown today.
    const _embStart = { calls: embeddingStats.calls, ms_total: embeddingStats.ms_total, input_chars: embeddingStats.input_chars };

    // IDs of blocks written as status='pending' during Pass 3 — activated after Pass 4 succeeds.
    // Ensures blocks are invisible to users until the full pipeline (through Pass 4) completes.
    const p3PendingBlockIds: string[] = [];

    // ── Resume from checkpoint or run passes fresh ──────────────────────────────
    // Restore the outputs of every pass that already completed successfully.
    // Each pass always runs fresh — it receives only the previous passes' outputs,
    // never any partial work from its own aborted attempt.
    if (checkpoint?.pass0) { _sceneCard = checkpoint.pass0.sceneCard; _pass0Raw = checkpoint.pass0.raw; }
    if (checkpoint?.pass1Items) pass1 = { items: checkpoint.pass1Items };
    if (checkpoint?.pass2Classified) pass2 = { skipped: [], classified: checkpoint.pass2Classified };
    if (checkpoint?.p3PendingBlockIds) p3PendingBlockIds.push(...checkpoint.p3PendingBlockIds);

    if (!pass2) {
      // Open blueprints context needed by Pass 0 and Pass 1
      const openBlueprints = allBlocks
        .filter((b) => b.type === "blueprint" && b.status === "active")
        .map((b) => ({ label: b.label, essence: b.essence || "" }));

      if (!pass1) {
        // ⚠ v1 SCENE-CARD FRONT-HALF — RETIRED & DISABLED (2026-06-22). v2 (COMPREHEND)
        // ALWAYS supplies pass1/pass2 via a checkpoint (resumeFrom:'pass3' on both the
        // per-turn and arc paths), so this block is unreachable on every live path.
        // Guarded to FAIL LOUD on a routing regression rather than silently extracting
        // through the retired scene-card engine. The Pass 0-1 code below is kept verbatim
        // for the follow-up deletion PR (which removes pass0.ts / pass1.ts /
        // synthesizeFromSceneCard.ts and this whole block).
        throw new Error(
          "v1 scene-card pipeline is retired and disabled — Pass 1 must arrive from a v2 " +
          "COMPREHEND checkpoint. Reaching runAutoReflect's Pass 0-1 path indicates an " +
          "extraction routing bug (see arc-pipeline.ts / routes/state.ts).",
        );
      }

      // ─── DEBT 5 Phase 2: arc-extraction flag-gated early-return ──────────
      // If we captured a conversation_turn at start (flag on + identity present),
      // persist Pass 0-1 output and skip Pass 2-5. Pass 2-5 will run at the arc-
      // extract trigger time (Phase 3) over consolidated input from all
      // pass01_done turns in the conversation. Per Variant A §2.6.
      //
      // The empty-items case STILL persists pass01_done (with empty items[]) —
      // the conversation_turns record is the canonical source-of-truth even
      // when this turn yielded nothing extractable; Phase 3 must distinguish
      // "ran-and-empty" from "didn't-run-yet" via status.
      if (_conversationTurnId) {
        const pass01Output = {
          scene_card: _pass0Raw ?? null,
          items:      pass1?.items ?? [],
        };
        try {
          db.updateConversationTurnPass01(_conversationTurnId, JSON.stringify(pass01Output));
          console.log(`[arc-extract] persisted Pass 0-1 to conversation_turn id=${_conversationTurnId} items=${pass1?.items.length ?? 0} — Pass 2-5 deferred to arc trigger`);
        } catch (e: any) {
          // Most likely cause: row already past 'captured' (idempotency re-fire on
          // a turn whose pass01 was previously saved). Tolerate, log, move on.
          console.warn(`[arc-extract] updateConversationTurnPass01 failed for id=${_conversationTurnId}: ${e?.message} — Pass 0-1 may already be persisted from prior run`);
        }
        writeReflectLog({ pass1, pass2: null, pass3: null });
        return empty;
      }

      if (!pass1 || pass1.items.length === 0) {
        writeReflectLog({ pass1, pass2: null, pass3: null });
        console.log("Auto-Reflect Pass 1: nothing extracted — skipping passes 2 and 3");
        return empty;
      }

      // Re-derive active project from Pass 0 output.
      // loadedBlocks is empty on external triggers (no agent session) — the fallback
      // at line ~358 adds ALL projects, so activeProjectPrefixes is wrong by this point.
      // Pass 0 identifies the correct project in two places:
      //   1. projects[] — when the transcript explicitly names the project
      //   2. technologies[].project — always populated from KNOWN PROJECTS matching
      // Use both; technologies[].project is the reliable fallback when projects[] is empty.
      const pass0ProjectNames = new Set<string>();
      for (const p of (_pass0Raw?.projects ?? []) as Array<{ name: string }>) {
        pass0ProjectNames.add(p.name);
      }
      for (const t of (_pass0Raw?.technologies ?? []) as Array<{ project?: string }>) {
        if (t.project) pass0ProjectNames.add(t.project);
      }
      const pass0Matched = [...pass0ProjectNames].filter(n => allProjectPrefixes.has(n));
      if (pass0Matched.length > 0) {
        activeProjectPrefixes.clear();
        for (const n of pass0Matched) activeProjectPrefixes.add(n);
      }
      // If Pass 0 found nothing known (brand-new project), keep the existing set

      // Pre-search: build targeted context for Pass 2 (always fresh — queries current graph state)
      const pass2Context = await buildPreSearchContext(
        pass1.items, allBlocks, allRels, knownRoots, embeddings ?? null, activeProjectPrefixes,
      );
      _pass2Context = pass2Context;

      // Thinking budget — tiered by Pass 1 item count, capped by NODEDEX_THINKING_BUDGET
      const itemCount = pass1.items.length;
      const p2Budget = getThinkingBudget(itemCount <= 3 ? 512 : itemCount <= 10 ? 4096 : 8192);
      console.log(`Auto-Reflect: ${itemCount} item(s) → thinking budget P2=${p2Budget}`);

      // Pass 2: always runs fresh — receives Pass 1 items + Pass 0 scene card.
      // Flag-gated routing per PASS2-SPLIT-DESIGN.md §4 (parallel migration).
      // DEFAULT-ON FLIP 2026-05-25 (§9 Week 4-5): split is now the default path;
      // set NODEDEX_PASS2_SPLIT=0 for emergency rollback to monolith pass2.ts
      // (kept in tree per §9, removed in a later commit after the stabilization
      // window). Flip rationale: cost gate closed + reconciled to dashboard
      // within ~1% (all 4 fixtures Acceptable+), Bug-3 quarantine containment
      // audit-confirmed, truncation gone. Reversible (this flag) + failures
      // contained (quarantine) — see commit + sticky. ON → split orchestrator
      // (2a → seam α → 2b → seam β → 2c → composer + quarantine routing). Result
      // shape is identical so the downstream graft + Pass 3 don't care.
      let p2: Awaited<ReturnType<typeof callPass2LLM>>;
      const _t2 = Date.now();
      if (process.env.NODEDEX_PASS2_SPLIT !== "0") {
        const sourceSessionId = agentId ?? "default";
        const split = await runPass2Split(
          provider, db, pass1.items, pass2Context, prevEntityMap, p2Budget, _sceneCard, sourceSessionId,
        );
        p2 = {
          result:      split.result,
          thinking:    split.thinking,
          rateLimited: split.rateLimited,
          model:       split.model,
          attempts:    split.attempts,
        };
        _pass2SplitAudit = split.splitAudit;
      } else {
        p2 = await callPass2LLM(provider, pass1.items, pass2Context, prevEntityMap, p2Budget, _sceneCard);
      }
      _pass2Thinking = p2.thinking;
      _pass2Provider = { model: p2.model, attempts: p2.attempts };
      _passWallMs.pass2 = Date.now() - _t2;

      // Pre-populate extends_item from Pass 1 extends_id
      if (p2.result) {
        prePopulateExtendsItem(pass1.items, p2.result.classified);
      }

      if (!p2.result || p2.result.classified.length === 0) {
        writeReflectLog({ pass1, pass2: p2.result, pass3: null });
        if (p2.rateLimited || !p2.result) {
          const reason = p2.rateLimited ? "rate limited" : "API failure";
          console.log(`Auto-Reflect Pass 2: ${reason} — re-queuing with Pass 0+1 output`);
          return { ...empty, checkpoint: { resumeFrom: 'pass2', pass0: { sceneCard: _sceneCard, raw: _pass0Raw }, pass1Items: pass1.items } };
        }
        console.log("Auto-Reflect Pass 2: nothing classified — skipping pass 3");
        return empty;
      }
      pass2 = p2.result;
    }

    // Seam contract enforcement: code-stamp "type_override" when Pass 2 changed
    // an item's type but didn't set review_reason. See stampTypeOverrides() docs.
    if (pass1) {
      const stamped = stampTypeOverrides(pass1.items, pass2.classified);
      if (stamped > 0) {
        console.log(`Auto-Reflect Pass 2: code-stamped type_override on ${stamped} item(s) (Pass 2 changed type without setting review_reason)`);
      }
    }

    // Merge causal_wiring[] into classified items (schema separates them for reasoning order)
    if (pass2.causal_wiring && Array.isArray(pass2.causal_wiring)) {
      const wiringMap = new Map<string, any>();
      for (const w of pass2.causal_wiring) {
        if (w.item_id) wiringMap.set(w.item_id, w);
      }
      for (const item of pass2.classified) {
        const wiring = wiringMap.get(item.id);
        if (wiring) {
          item.triggered_by_items = wiring.triggered_by ?? [];
          item.based_on_items = wiring.based_on ?? [];
        } else {
          if (!item.triggered_by_items) item.triggered_by_items = [];
          if (!item.based_on_items) item.based_on_items = [];
        }
      }
    }

    // Log Pass 2 skipped items (graph existence check)
    if (pass2.skipped && pass2.skipped.length > 0) {
      for (const s of pass2.skipped) {
        console.log(`Auto-Reflect Pass 2: skipped item ${s.id} — ${s.reason}`);
      }
    }

    // Falsifiable-skip guard: a Pass 2 skip is legitimate only if its reason
    // cites something verifiable — a real label or essence fragment from
    // allBlocks (an "already in graph" skip), OR a sibling item id from this
    // batch (an intra-batch-duplicate skip — Pass 2 Q0 STEP I sometimes
    // routes here despite the prompt's "drop, don't skip" instruction). A
    // skip citing nothing verifiable is unfalsifiable; the item is rescued
    // into classified[] with its Pass 1 provisional type.
    // No phrase matching — pure verification against real state or batch
    // siblings. Deterministic backstop for the STATE CONVENTION rule.
    if (pass2.skipped && pass2.skipped.length > 0 && pass1) {
      const knownLabels = allBlocks
        .map((b: any) => (b.label || "").toLowerCase())
        .filter((l: string) => l.length >= 4);
      const knownEssences = allBlocks
        .map((b: any) => (b.essence || "").toLowerCase().trim())
        .filter((e: string) => e.length >= 20);
      // Same-batch sibling item ids (e.g. "item_8", "syn_1"). A skip whose
      // reason cites a sibling is a legitimate intra-batch-duplicate skip —
      // the sibling exists in pass1.items, so the citation is verifiable.
      const siblingIds = (pass1?.items || [])
        .map((i: any) => (i.id || "").toLowerCase())
        .filter((id: string) => id.length >= 3);

      const citesRealState = (reason: string): boolean => {
        const r = (reason || "").toLowerCase();
        if (knownLabels.some((lbl: string) => r.includes(lbl))) return true;
        if (siblingIds.some((id: string) => r.includes(id))) return true;
        // Any 20-char window of a real essence appearing in the reason = a citation
        for (const ess of knownEssences) {
          for (let i = 0; i + 20 <= ess.length; i++) {
            if (r.includes(ess.slice(i, i + 20))) return true;
          }
        }
        return false;
      };

      const rescued: Pass2Item[] = [];
      pass2.skipped = pass2.skipped.filter(s => {
        if (citesRealState(s.reason || "")) return true; // verifiable — keep the skip
        const item = pass1?.items.find((i: any) => i.id === s.id);
        if (!item) return true; // cannot rescue — leave as skip
        rescued.push({
          id: item.id,
          text: item.text,
          type: item.provisional_type,
          project: "",
          unique: {},
          classification_reasoning: `[rescued by guard — Pass 2 skip claim could not be verified against PROJECT GRAPH or any sibling item in this batch; reverting to provisional_type=${item.provisional_type}]`,
          triggered_by_items: [],
          based_on_items: [],
        } as any);
        return false;
      });

      if (rescued.length > 0) {
        console.warn(`Auto-Reflect Pass 2 guard: rescued ${rescued.length} item(s) with unverifiable skip claims — types: ${rescued.map(r => r.type).join(',')}`);
        pass2.classified.push(...rescued);
      }
    }

    // SLICE 1 SUB-STEP 1.4 — collected duplicate pairs detected by D2 dedup.
    // Hoisted out of the dedup block scope so the post-Pass-3 Stage FLAG writer
    // (after stampFlowRolesAndChains) can iterate them, resolve item_id →
    // block_id via itemIdToLabel + db.getBlock, and writePipelineFlag for each.
    // Empty array on per-turn paths where no D2 detect runs.
    const atomicDupCandidates: Array<{ id: string; duplicate_of: string; key: string }> = [];

    // DEBT 5 Slice 3 Part 4 — Stage D cross-arc resolve results, hoisted like
    // atomicDupCandidates so the post-Pass-3 flag writer (Touchpoint B) can
    // resolve item_id → block_id and write cross_arc_dup_candidate flags.
    // Empty unless arc mode + NODEDEX_STAGE_D_ENABLED + Stage D found attach/flag.
    let stageDEntries: BatchResolveEntry[] = [];

    // Code dedup guard (charter rule 3/6) — DEFAULT ON since 2026-05-24. Validated
    // across 4 domains (framework-choice, rl-fixed, garden-blight, refund): 0 false
    // collapses, stays idle when no exact dups exist. Set NODEDEX_CODE_DEDUP=0 to disable.
    // Two deterministic, exact-match-only steps; never extends to embedding similarity
    // (that is semantic judgment — Pass 2's job, not code's). Conservative on role-splits.
    if (process.env.NODEDEX_CODE_DEDUP !== "0") {
      // Step 1 — identical-essence-text twins (cross-type). The original guard.
      {
        const before = pass2.classified.length;
        const { kept, dropped } = dedupIdenticalEssenceTwins(pass2.classified);
        if (dropped.length > 0) {
          console.log(`[code-dedup] collapsed ${dropped.length} identical-essence twin(s) (${before} → ${kept.length}):`);
          for (const d of dropped) console.log(`  - dropped ${d.id} → merged into ${d.mergedInto} | ${d.reason}`);
          pass2.classified = kept;
        }
      }
      // Step 2 (Tier 1C) — identical unique{} value-set. Catches cross-type AND
      // same-type-paraphrase dups that differ in essence wording but carry the
      // same structured data. Identity = unique{}, not essence. Runs after Step 1
      // on the already-reduced set. Winner = schema-valid block (Tier 1B validator).
      {
        const before = pass2.classified.length;
        const { kept, dropped } = dedupIdenticalUniqueValues(pass2.classified);
        if (dropped.length > 0) {
          console.log(`[code-dedup] collapsed ${dropped.length} identical-unique{}-value twin(s) (${before} → ${kept.length}):`);
          for (const d of dropped) console.log(`  - dropped ${d.id} → merged into ${d.mergedInto} | ${d.reason}`);
          pass2.classified = kept;
        }
      }
      // Step 3 (DEBT 5 D2 §2.5.1) — dedup by (source_excerpt, primary_value).
      // Catches what Step 1 (essence) and Step 2 (unique-value) miss: items
      // with DIFFERENT unique-value-text but pinned to THE SAME source line
      // (e.g., arc-mode where two turns each extracted "the celebration of
      // family-style menu" and the LLM phrased the value slightly differently
      // across turns — different unique.value, same source_excerpt → still
      // the same observation).
      //
      // This is the provider-agnostic dedup per D2: identity = (where it came
      // from + what's the canonical fact), NOT label or type. Per
      // [[project-pass1-pass2a-provider-drift-2026-05-30]] this is the
      // structural answer to LLM-typing variance across providers.
      //
      // Only fires on items with non-empty excerpt — pre-Debt-5 atomic blocks
      // (NULL/empty source_excerpt) are conservatively left as-is.
      //
      // SLICE 1 SUB-STEP 1.4 behavior change: D2 now DETECTS (flags) instead
      // of auto-dropping. Both blocks survive to Pass 3 + DB write; after
      // createBlock loop, the Stage FLAG writer below (post-stampFlowRoles)
      // resolves item_ids → block_ids and writes pipeline_flags rows for
      // the async LLM reviewer (Slice 2) to decide merge/leave/split.
      // Per user direction: system FLAGS, reasoning MERGES.
      {
        const { duplicates } = dedupBySourceAndValue(pass2.classified);
        if (duplicates.length > 0) {
          console.log(`[code-dedup D2] DETECTED ${duplicates.length} (source_excerpt, primary_value)-twin(s) — FLAGGING (not dropping):`);
          for (const d of duplicates) console.log(`  - flag candidate ${d.id} as duplicate of ${d.duplicate_of}`);
          atomicDupCandidates.push(...duplicates);
        }
      }
    }

    // ── FOLD constituent reason-facts (granularity fix; default OFF) ─────────────
    // Over-extraction is GRANULARITY not worth: Pass 1 fragments a decision + its
    // reasons into separate blocks (traversal-proven 2026-06-04). JUDGE (keep/drop
    // whole items) cannot consolidate fragments. foldConstituentFacts absorbs a
    // sole-constituent reason-fact INTO the state-change unit it justifies (enrich
    // unique.reason) so it is not built as a redundant standalone block. ENRICH not
    // delete (Rule 2 — content relocated, nothing lost). Runs AFTER code-dedup (so
    // based_on references are already consistent) and BEFORE Pass 3 build. Detection
    // is structural/deterministic (Rule 3 — counts wired based_on edges, never
    // semantic similarity). Mode-independent (arc + per-turn). Default OFF:
    // NODEDEX_FOLD_CONSTITUENTS=1. Design + guards:
    // [[project-fragmentation-not-worth-fold-2026-06-04]].
    if (process.env.NODEDEX_FOLD_CONSTITUENTS === "1") {
      const before = pass2.classified.length;
      const { kept, folded } = foldConstituentFacts(pass2.classified);
      if (folded.length > 0) {
        console.log(`[fold] folded ${folded.length} constituent reason-fact(s) (${before} → ${kept.length}):`);
        for (const f of folded) console.log(`  - ${f.id} → ${f.foldedInto} | ${f.reason}`);
        pass2.classified = kept;
      }
    }

    // Outer-scope state — populated by Pass 3 (normal run) or restored from pending blocks (pass4 retry)
    const result: ReflectResult = { saved: 0, updated: 0, skipped: 0, saved_labels: [], uncertain_count: 0, created_blocks: [], updated_blocks: [] };
    const pipelineSkips: Array<{ label: string; reason: string }> = [];
    const _pendingRecentSaves: Array<{ label: string; essence: string; update_note?: string; values?: string }> = [];
    let analysis: any = null;
    let geminiThinking = "";

    if (checkpoint?.resumeFrom !== 'pass4') {
    // Thinking budget for Pass 3 — cap at 2048 to prevent Flash over-deliberation
    const p3ThinkBudget = getThinkingBudget(pass1
      ? (pass1.items.length <= 3 ? 1024 : 2048)
      : 2048);

    console.log(`Auto-Reflect Pass 2: ${pass2.classified.length} blocks to build (${pass2.skipped?.length ?? 0} skipped by graph check) → proceeding to Pass 3 (thinking=${p3ThinkBudget})`);

    // Semantic duplicate pre-filter
    let duplicateAlerts = "";
    if (embeddings?.isAvailable()) {
      try {
        duplicateAlerts = await buildDuplicateAlerts(pass2.classified, allBlocks, embeddings);
      } catch { /* non-critical */ }
    }

    // Per-item neighborhood context for Pass 3
    let itemContext: Record<string, string> = {};
    try {
      itemContext = await buildItemContext(pass2.classified, allBlocks, allRels, embeddings ?? null);
    } catch { /* non-critical */ }

    // Filter superseded blocks from project context — prevents Pass 3 from deduping
    // a new block against the block it's meant to replace (supersedes_ref conflict)
    const supersededLabels = new Set(
      pass2.classified
        .filter(item => item.supersedes_ref)
        .map(item => item.supersedes_ref!)
    );
    const p3AllBlocks = supersededLabels.size > 0
      ? allBlocks.filter((b: any) => !supersededLabels.has(b.label))
      : allBlocks;
    let p3ProjectContext = projectContext;
    if (supersededLabels.size > 0) {
      const { context: filteredCtx, reflectedIds: _reflectedIds1 } = buildProjectContext(p3AllBlocks, allRels, allProjectPrefixes, loadedBlocks);
      db.stampReflectedAt(_reflectedIds1);
      p3ProjectContext = filteredCtx;
    }

    if (supersededLabels.size > 0) {
      console.log(`Auto-Reflect Pass 3: filtered ${supersededLabels.size} superseded block(s) from project context: [${[...supersededLabels].join(", ")}]`);
    }

    // ── DEBT 5 Slice 1 Sub-step 1.3 — apply Stage C canonical names ──────────
    // Between Pass 2 and Pass 3 in ARC mode only: walk Pass 2 classified items,
    // for each item that appears in a Stage C entity cluster, overwrite its
    // .project field with the cluster's canonical_name. Pass 3 trusts Pass 2's
    // project field verbatim (pass3.ts:75-77), so this is the seam where the
    // 5-projects-for-1-arc fix lands without modifying Pass 3's prompt.
    //
    // Degrade path: when checkpoint.arcEntityResolution is undefined (Stage C
    // skipped/failed OR non-arc per-turn runs), the helper is a no-op — items
    // keep Pass 2's per-turn names. Phase 11 5-projects-bug is the cost; we
    // accept it as the original behavior, not a regression.
    if (pass2.classified.length > 0 && checkpoint?.arcEntityResolution) {
      const result = applyArcEntityCanonicalNames(pass2.classified, checkpoint.arcEntityResolution);
      pass2 = { skipped: pass2.skipped, classified: result.items };
      console.log(`Auto-Reflect Pass 3 (arc): canonicalized ${result.renamed_count} item(s) across ${result.clusters_used} cluster(s); ${result.unmatched_item_ids.length} item(s) kept per-turn names`);
    }

    // ── Recognition Layer step 2 — RECOGNIZER (root-fork fix; default OFF) ───────
    // After Stage C named the clusters, ask for each NEW-root candidate: does this
    // cluster actually belong to an EXISTING root (same domain + same owner)? On a
    // confident attach, rewrite the cluster's .project to that root's EXACT label so
    // Pass 3's root-create finds it (no fork). Else keep the new root (the safe fork
    // per §1; the post-hoc AUDIT-heal pass surfaces fork-pairs for the agent/user).
    // "Stage D for roots" — LLM-primary, judges on the root DESCRIPTION (essence) +
    // scope, with the 5 guards (recognize-root.ts). Default OFF
    // (NODEDEX_RECOGNIZER_ENABLED=1), arc mode only. Graceful degrade on any error.
    if (
      recognizerEnabled() &&
      checkpoint?.arcEntityResolution &&
      pass2.classified.length > 0 &&
      knownRoots.length > 0
    ) {
      try {
        const rec = await recognizeRootsForArc({ provider, items: pass2.classified, knownRoots });
        if (rec.remap.length > 0) {
          const applied = applyRootRemap(pass2.classified, rec.remap);
          pass2 = { skipped: pass2.skipped, classified: applied.items };
          console.log(`Auto-Reflect Recognizer (arc): ${rec.attached} attach / ${rec.candidates} candidate(s); rewrote ${applied.rewritten} item(s) — ${rec.llm_calls} LLM call(s)`);
        } else if (rec.candidates > 0) {
          console.log(`Auto-Reflect Recognizer (arc): 0 attach / ${rec.candidates} candidate(s) kept as new — ${rec.llm_calls} LLM call(s)`);
        }
      } catch (e: any) {
        console.warn(`[recognizer] threw (${e?.message}) — keeping Stage C names (extraction continues)`);
      }
    }

    // ── DEBT 5 Slice 3 Part 4 — STAGE D: cross-arc resolve (Touchpoint A) ────────
    // After Stage C applied canonical names, ask for each classified item: does
    // this entity ALREADY EXIST in the graph (attach), or is it a different-owner
    // collision / ambiguous (flag)? Stage D DETECTS + JUDGES + FLAGS only — it does
    // NOT mutate the graph (the async reviewer ACTS; charter flag-vs-auto-act,
    // PIPELINE-FIRST-PRINCIPLES §4 Insight 3). Results are drained into
    // cross_arc_dup_candidate flags at Touchpoint B (after the createBlock loop,
    // when item→block_id is resolvable).
    //
    // Default OFF — opt-in via NODEDEX_STAGE_D_ENABLED=1. Arc mode only (needs the
    // Stage C resolution that runs at arc time). The cost gate (minIdentityForLLM)
    // bounds spend to items with a plausible duplicate candidate. Graceful degrade:
    // any failure here is caught and logged — it must never block extraction.
    if (
      process.env.NODEDEX_STAGE_D_ENABLED === "1" &&
      checkpoint?.arcEntityResolution &&
      pass2.classified.length > 0
    ) {
      try {
        const batch = await resolveArcEntitiesForItems({ db, provider, items: pass2.classified });
        stageDEntries = batch.entries;
        console.log(`Auto-Reflect Stage D (arc): resolved ${batch.items_resolved} item(s) — ${batch.attached} attach, ${batch.flagged} flag, ${batch.llm_calls} LLM call(s)`);
      } catch (e: any) {
        console.warn(`[stage-d] resolve threw (${e?.message}) — skipping cross-arc flags (extraction continues)`);
        stageDEntries = [];
      }
    }

    // ── PASS 3: Build ──
    // callPass3Batched is a drop-in for callPass3LLM: when NODEDEX_PASS3_BATCH=1 AND
    // the item count exceeds the batch size it splits the write into chunks (the model
    // gives up past ~25 items in one call); otherwise it delegates to a single call =
    // byte-identical to before. Cross-chunk relations wire server-side at save.
    const _t3 = Date.now();
    const p3 = await callPass3Batched(
      provider,
      pass2.classified,
      knownRoots,
      p3ProjectContext,
      agentSavedBlocks,
      p3ThinkBudget,
      duplicateAlerts,
      itemContext,
    );
    _passWallMs.pass3 = Date.now() - _t3;
    analysis = p3.analysis;
    geminiThinking = p3.geminiThinking;
    const rateLimited = p3.rateLimited;
    _pass3Provider = { model: p3.model, attempts: p3.attempts };

    writeReflectLog({ pass1, pass2, pass3: analysis, pass4: null });
    if (!analysis) {
      const reason = rateLimited ? "rate limited" : "API failure";
      console.warn(`Auto-Reflect Pass 3: ${reason} — saving ${pass2.classified.length} classified items for re-queue`);
      return { ...empty, checkpoint: { resumeFrom: 'pass3', pass0: { sceneCard: _sceneCard, raw: _pass0Raw }, pass1Items: pass1?.items, pass2Classified: pass2.classified } };
    }

    // ── Recover a drifted/missing from_item_id BEFORE the accounting guards ──
    // Pass 3 (the model) must echo each block's source item id as from_item_id, but
    // Gemini occasionally omits or drifts it on ONE block in a large batched write.
    // The save loop already has a type-match fallback for this (see ~"inferred
    // from_item_id by type match" below), but it runs DOWNSTREAM of the mandatory-item
    // guard — so a single unrecovered id there would discard the WHOLE analysis (every
    // correctly-built block included) before the recovery ever runs. Hoist the same
    // recovery here so the guard evaluates the recovered state: one drifted id no
    // longer nukes the entire arc.
    {
      const _recovered = recoverDriftedFromItemIds(analysis.new_blocks as any[], pass2.classified as any[]);
      if (_recovered > 0) console.log(`Auto-Reflect Pass 3: recovered ${_recovered} drifted/missing from_item_id(s) by pre-accounting type-match`);
    }

    // Truncation detection: if Pass 3 accounts for far fewer items than Pass 2 sent,
    // the model returned a syntactically valid but incomplete response. Re-queue.
    {
      const substantiveItems = pass2.classified.filter(i => i.type !== "task").length;
      const accounted = (analysis.new_blocks?.length ?? 0)
        + (analysis.skip_reasons?.length ?? 0)
        + (analysis.updates?.length ?? 0);
      if (substantiveItems >= 3 && accounted < Math.ceil(substantiveItems / 2)) {
        console.warn(`Auto-Reflect Pass 3: truncated response detected (${accounted} accounted / ${substantiveItems} expected) — re-queuing`);
        return { ...empty, checkpoint: { resumeFrom: 'pass3', pass0: { sceneCard: _sceneCard, raw: _pass0Raw }, pass1Items: pass1?.items, pass2Classified: pass2.classified } };
      }

      // Mandatory item check: verify all tier-1/tier-3 items are accounted for.
      // Tier 1 — decision/constraint/dead_end/blueprint + supersedes_ref items.
      // Tier 3 — facts with no existing neighborhood match (new state data).
      // If any are missing from new_blocks/skip_reasons/updates → re-queue.
      const MANDATORY_PASS3_TYPES = new Set(["decision", "constraint", "dead_end", "blueprint"]);
      const mandatoryItems = pass2.classified.filter(i => {
        if (MANDATORY_PASS3_TYPES.has(i.type) || !!i.supersedes_ref) return true; // tier 1
        if (i.type === "fact") {
          const ctx = itemContext[i.id];
          return !ctx || ctx === "(no existing match — create new block)"; // tier 3
        }
        return false;
      });
      if (mandatoryItems.length > 0) {
        const fromItemIds = new Set((analysis.new_blocks || []).map((b: any) => b.from_item_id).filter(Boolean));
        const skipItemIds = new Set((analysis.skip_reasons || []).map((s: any) => s.item_id).filter(Boolean));
        const updateBlockIds = new Set((analysis.updates || []).map((u: any) => u.block_id).filter(Boolean));
        const missing = mandatoryItems.filter(i => !fromItemIds.has(i.id) && !skipItemIds.has(i.id) && !updateBlockIds.has(i.id));
        if (missing.length > 0) {
          const labels = missing.map(i => `${i.id}[${i.type}]`).join(", ");
          console.warn(`Auto-Reflect Pass 3: mandatory item(s) unaccounted: ${labels} — re-queuing`);
          return { ...empty, checkpoint: { resumeFrom: 'pass3', pass0: { sceneCard: _sceneCard, raw: _pass0Raw }, pass1Items: pass1?.items, pass2Classified: pass2.classified } };
        }
      }
    }

    // ── Supersedes-ref guard: items with supersedes_ref must be in new_blocks, not updates ──
    // The prompt says "supersedes_ref → ALWAYS new_blocks + supersedes relation, NEVER updates".
    // If the model violates this, warn and let it through (updates[] still processes, but the
    // superseded block won't be properly archived as history).
    {
      const supersedesItemIds = new Set(
        pass2.classified.filter(i => !!i.supersedes_ref).map(i => i.id)
      );
      if (supersedesItemIds.size > 0) {
        const newBlockItemIds = new Set(
          (analysis.new_blocks || []).map((b: any) => b.from_item_id).filter(Boolean)
        );
        for (const itemId of supersedesItemIds) {
          if (!newBlockItemIds.has(itemId)) {
            const item = pass2.classified.find(i => i.id === itemId);
            console.warn(`Auto-Reflect Pass 3 guard: supersedes_ref item "${itemId}" [${item?.type}] not in new_blocks[] — superseded block may not be properly archived`);
            pipelineSkips.push({ label: itemId, reason: `supersedes_ref_not_in_new_blocks` });
          }
        }
      }
    }

    result.skipped = (analysis.skip_reasons || []).length;

    // ── Scope project: the guaranteed home for cross-cutting blocks ──
    // Pass 0 names one overarching subject per transcript. Ensure it exists as a
    // root BEFORE the project_creates[] loop so that:
    //   (1) the sentinel guard in the build loop has somewhere to re-home blocks
    //   (2) sub-projects in project_creates[] can default their `parent` to the
    //       scope project and find it in allBlocks immediately (Bug 3 fix —
    //       structurally-determined nesting belongs in code, not delegated to
    //       LLM judgment via the optional pass3 `parent` field; charter rule 3).
    const SENTINEL_PROJECT_NAMES = new Set(["null", "undefined", "unknown", "general", "misc", "none", ""]);
    // A COMPREHEND group_id leaking as a project name ("group_1", "g-2") is a
    // placeholder, not a root — treat it as sentinel so it is re-homed (v1) rather than
    // becoming a root. In v2 the converter (comprehendResultToPass2Items) already
    // guarantees a real item.project; this is the WRITE-seam backstop.
    const GROUP_ID_PLACEHOLDER = /^(?:group|g)[-_]?\d+$/i;
    const isSentinelProject = (p: any): boolean =>
      p == null
      || SENTINEL_PROJECT_NAMES.has(String(p).trim().toLowerCase())
      || GROUP_ID_PLACEHOLDER.test(String(p).trim());

    const newProjectLabels = new Set<string>();
    const scopeProjectLabel: string | undefined =
      typeof _pass0Raw?.scope_project?.name === "string" && !isSentinelProject(_pass0Raw.scope_project.name)
        ? _pass0Raw.scope_project.name.trim()
        : undefined;
    if (scopeProjectLabel) {
      let scopeProj = allBlocks.find((b) => b.label === scopeProjectLabel && b.type === "project");
      if (!scopeProj) {
        const dbScope = db.getBlock(scopeProjectLabel);
        if (dbScope && dbScope.type === "project") {
          scopeProj = dbScope;
          allBlocks.push(dbScope);
        } else {
          scopeProj = db.createBlock({
            label: scopeProjectLabel, type: "project", status: "active",
            essence: _pass0Raw?.scope_project?.scope || `Overarching subject: ${scopeProjectLabel}`,
            content: { is_a: "project", concepts: [], unique: {} },
            ttl: "permanent", source: "Auto-Reflect", created_by: geminiCreatedBy,
          });
          stampQualityScore(db, scopeProj, []);  // Bug 1 fix: pipeline-created blocks must have quality_score set, else recall filters reject them at q=0
          allBlocks.push(scopeProj);
          console.log(`Auto-Reflect: ensured scope project root "${scopeProjectLabel}"`);
        }
      }
      newProjectLabels.add(scopeProjectLabel);
    }

    // ── Create new project roots ──
    for (const projDef of (analysis.project_creates || [])) {
      if (!projDef?.label || !projDef?.essence) continue;

      // Bug 3 fix: default `parent` to scope_project for non-scope sub-projects.
      // See resolveProjectParent doc for full rationale.
      const desiredParent = resolveProjectParent(projDef, scopeProjectLabel);

      const existingProj = allBlocks.find((b) => b.label === projDef.label && b.type === "project");
      if (existingProj) {
        // Project already exists — still wire parent relation if specified and not yet present
        if (desiredParent) {
          const alreadyLinked = db.getRelations(existingProj.id).some((r: any) => r.type === "part_of");
          if (!alreadyLinked) {
            const parentBlock = allBlocks.find((b: any) => b.label === desiredParent && b.type === "project")
              ?? db.getBlock(desiredParent);
            if (parentBlock) {
              db.createRelation({ source_id: existingProj.id, target_id: parentBlock.id, type: "part_of", bidirectional: false });
              console.log(`Auto-Reflect: retroactively linked existing project "${projDef.label}" → parent "${desiredParent}"`);
            } else {
              console.warn(`Auto-Reflect: existing project "${projDef.label}" — parent "${desiredParent}" not found, skipping nest`);
            }
          }
        }
        continue;
      }

      const newProj = db.createBlock({
        label: projDef.label, type: "project", status: "active",
        essence: projDef.essence,
        content: { is_a: "project", concepts: [], unique: {} },
        ttl: "permanent", source: "Auto-Reflect", created_by: geminiCreatedBy,
      });
      stampQualityScore(db, newProj, []);  // Bug 1 fix
      allBlocks.push(newProj);
      newProjectLabels.add(projDef.label);

      // Wire nested root → parent if specified (collection-member pattern)
      if (desiredParent) {
        const parentBlock = allBlocks.find((b: any) => b.label === desiredParent && b.type === "project")
          ?? db.getBlock(desiredParent);
        if (parentBlock) {
          db.createRelation({ source_id: newProj.id, target_id: parentBlock.id, type: "part_of", bidirectional: false });
          console.log(`Auto-Reflect: created project root "${projDef.label}" (nested under "${desiredParent}")`);
        } else {
          console.warn(`Auto-Reflect: created project root "${projDef.label}" — parent "${desiredParent}" not found in graph, skipping nest`);
        }
      } else {
        console.log(`Auto-Reflect: created project root "${projDef.label}"`);
      }

      const prefix = projDef.label;
      const orphans = allBlocks.filter((b) =>
        b.type !== "project" && b.label.startsWith(prefix + "_") && !b.project_id
      );
      for (const orphan of orphans) {
        db.updateBlock(orphan.id, { project_id: newProj.id });
        orphan.project_id = newProj.id;
      }
    }

    // Priority-tier ordering
    const TIER1 = new Set(["dead_end"]);
    const TIER2 = new Set(["decision", "constraint", "preference"]);
    const rawBlocks: any[] = (analysis.new_blocks || []).filter((b: any) => b?.essence && b?.label);
    const tier1 = rawBlocks.filter((b: any) => TIER1.has(b.is_a) || (b.relations || []).some((r: any) => r.type === "contradicts"));
    const tier2 = rawBlocks.filter((b: any) => !tier1.includes(b) && TIER2.has(b.is_a));
    const tier3 = rawBlocks.filter((b: any) => !tier1.includes(b) && !tier2.includes(b));
    const orderedBlocks = [...tier1, ...tier2, ...tier3];

    // Review map: item_id → review_reason from Pass 2
    const reviewMap = new Map<string, string>();
    for (const item of pass2.classified) {
      if (item.review_reason) reviewMap.set(item.id, item.review_reason);
    }

    // Source-type map: item_id → source_type provenance from Pass 2 (debt-3
    // demote-edge sets "seam_demoted"). Looked up at createBlock via
    // blockDef.from_item_id, mirroring reviewMap. Monolith path never sets it →
    // map empty → source_type defaults to "agent_derived" (backward compatible).
    const sourceTypeMap = new Map<string, string>();
    for (const item of pass2.classified) {
      if (item.source_type) sourceTypeMap.set(item.id, item.source_type);
    }

    // DEBT 5 D3 (§2.3.2) Phase 5: item_id → source_excerpt. Pinned from Pass 1's
    // excerpt field, carried through Pass 2a re-join (mirrors text re-join),
    // through composeForDownstream into Pass2Item.excerpt. Pass 3 reads via
    // blockDef.from_item_id at createBlock to populate blocks.source_excerpt
    // column. Empty string when Pass 1 left it empty (defensive — Pass 2a logs
    // a re-join miss but doesn't fail). Map keeps non-empty values only so
    // createBlock falls back to NULL for items without provenance.
    const sourceExcerptMap = new Map<string, string>();
    for (const item of pass2.classified) {
      if (item.excerpt && item.excerpt.length > 0) sourceExcerptMap.set(item.id, item.excerpt);
    }

    // Seed type set
    const seedTypeNames = new Set([
      "artifact", "constraint", "dead_end", "decision", "draft", "fact", "insight",
      "note", "process", "project", "question", "task",
      "hypothesis", "preference", "blueprint", "event", "entity",
      // reasoning_chain/metric/claim collapsed → insight/fact (2026-06-15)
    ]);
    const allDbTypes: any[] = db.getBlockTypes?.() ?? [];
    allDbTypes.filter((t: any) => !seedTypeNames.has(t.name)).forEach((t: any) => seedTypeNames.add(t.name));

    // Cache the multi-word type set once — used by normalizeMultiWordTypeInLabel
    // to repair labels the LLM occasionally writes with underscores in the type
    // segment (e.g. `garden_dead_end_x`) where the rule is hyphens-within-dimension
    // (`garden_dead-end_x`). Bug 2 fix, 2026-05-28.
    const MULTI_WORD_TYPES = new Set([...seedTypeNames].filter((t) => t.includes("_")));

    // from_item_id → assembled label, for server-side extends_item resolution
    const itemIdToLabel = new Map<string, string>();
    const pendingTriggeredBy: Array<{ sourceId: string; labelRef: string }> = [];

    // item_id → triggered_by_items from Pass 2, for TS-layer fallback when Pass 3 omits triggered_by
    const itemTriggeredByItems = new Map<string, string[]>();
    for (const item of pass2.classified) {
      if (item.id && Array.isArray(item.triggered_by_items)) {
        itemTriggeredByItems.set(item.id, item.triggered_by_items);
      }
    }

    for (const _blockDefRaw of orderedBlocks) {
      if (!_blockDefRaw?.essence || !_blockDefRaw?.label) continue;

      // Assemble label from object
      let blockDef: any = _blockDefRaw;
      let labelFromObject = false;
      if (typeof blockDef.label === "object" && blockDef.label !== null) {
        const lp = blockDef.label as any;
        // Sentinel-project guard: Pass 3 gave no real project → re-home to the
        // scope project so "null"/"" can never become a project root.
        if (isSentinelProject(lp.project) && scopeProjectLabel) lp.project = scopeProjectLabel;
        if (lp.project && lp.type && lp.concept) {
          const parts = lp.subgroup
            ? [lp.project, lp.subgroup, lp.type, lp.concept]
            : [lp.project, lp.type, lp.concept];
          blockDef = { ...blockDef, label: parts.join("_") };
          labelFromObject = true;
        } else {
          console.warn(`Auto-Reflect: skipped block — incomplete label object`);
          pipelineSkips.push({ label: JSON.stringify(_blockDefRaw.label), reason: "incomplete_label_object" });
          result.skipped++;
          continue;
        }
      }

      // Bug 2 fix (2026-05-28): normalize multi-word type segments in the
      // block's own label AND in cross-block references that target labels
      // with the same convention. Catches LLM cases where the type's literal
      // underscore form leaked through into the label (`dead_end` → `dead-end`).
      // Idempotent; refs starting with blk_/__item_ref__/__based_on__ are
      // markers, not labels — leave them alone.
      blockDef = {
        ...blockDef,
        label: normalizeMultiWordTypeInLabel(blockDef.label, MULTI_WORD_TYPES),
        ...(Array.isArray(blockDef.triggered_by) ? {
          triggered_by: blockDef.triggered_by.map((r: any) =>
            typeof r === "string" && !r.startsWith("blk_") && !r.startsWith("__item_ref__") && !r.startsWith("__based_on__")
              ? normalizeMultiWordTypeInLabel(r, MULTI_WORD_TYPES)
              : r
          ),
        } : {}),
        ...(Array.isArray(blockDef.based_on) ? {
          based_on: blockDef.based_on.map((r: any) =>
            typeof r === "string" && !r.startsWith("blk_")
              ? normalizeMultiWordTypeInLabel(r, MULTI_WORD_TYPES)
              : r
          ),
        } : {}),
        ...(Array.isArray(blockDef.relations) ? {
          relations: blockDef.relations.map((rel: any) =>
            rel && typeof rel === "object" && typeof rel.target_id === "string"
              && !rel.target_id.startsWith("blk_") && rel.target_id !== "null"
              ? { ...rel, target_id: normalizeMultiWordTypeInLabel(rel.target_id, MULTI_WORD_TYPES) }
              : rel
          ),
        } : {}),
      };

      // Project root validation — if project is unknown, auto-create rather than reject
      // (mirrors the flat-string path below; project_creates[] is a hint not a gate)
      if (labelFromObject) {
        const lp = _blockDefRaw.label as any;
        const blockProject = lp.project as string;
        if (!isKnownProject(blockProject, allProjectPrefixes, newProjectLabels)) {
          const existingProj = db.getBlock(blockProject);
          if (existingProj && existingProj.type === "project") {
            allBlocks.push(existingProj);
          } else {
            const autoProj = db.createBlock({
              label: blockProject, type: "project", status: "active",
              essence: `Auto-created project for '${blockProject}' domain`,
              content: { is_a: "project", unique: {}, concepts: [] },
              ttl: "permanent", source: "Auto-Reflect", created_by: geminiCreatedBy,
            });
            stampQualityScore(db, autoProj, []);  // Bug 1 fix
            allBlocks.push(autoProj);
            newProjectLabels.add(blockProject);
            console.log(`Auto-Reflect: auto-created project root "${blockProject}" for "${blockDef.label}"`);
          }
        }
      }

      // Label dedup — merge computed metadata into existing block instead of skipping
      if (isDuplicateLabel(blockDef.label, allBlocks)) {
        const existing = allBlocks.find((b) => b.label === blockDef.label) ?? db.getBlock(blockDef.label);
        if (existing) {
          // Apply concepts if existing block has none
          let existingConcepts: string[] = [];
          try { existingConcepts = JSON.parse(typeof existing.concepts === "string" ? existing.concepts : "[]"); } catch { /* */ }
          const newConcepts: string[] = blockDef.concepts || [];
          if (existingConcepts.length === 0 && newConcepts.length > 0) {
            const existingContent: any = typeof existing.content === "string" ? (JSON.parse(existing.content) || {}) : (existing.content || {});
            existingContent.concepts = newConcepts;
            db.updateBlock(existing.id, { concepts: newConcepts, content: JSON.stringify(existingContent) });
          }

          // Create prompted_by relations from blockDef.triggered_by (resolved inline — triggeredByIds not yet declared)
          for (const ref of (blockDef.triggered_by || [])) {
            if (ref.startsWith("__item_ref__")) { pendingTriggeredBy.push({ sourceId: existing.id, labelRef: ref }); continue; }
            const tb = ref.startsWith("blk_") ? db.getBlock(ref) : allBlocks.find((bl: any) => bl.label === ref) ?? null;
            if (tb) {
              if (!shouldSkipRelation(existing.id, tb.id, "prompted_by", db))
                db.createRelation({ source_id: existing.id, target_id: tb.id, type: "prompted_by", bidirectional: false });
            } else {
              pendingTriggeredBy.push({ sourceId: existing.id, labelRef: ref });
            }
          }

          // Create based_on relations
          for (const ref of (blockDef.based_on || [])) {
            const targetBlock = ref.startsWith("blk_")
              ? db.getBlock(ref)
              : allBlocks.find((b: any) => b.label === ref) ?? null;
            if (!targetBlock) {
              pendingTriggeredBy.push({ sourceId: existing.id, labelRef: `__based_on__${ref}` });
              continue;
            }
            if (!shouldSkipRelation(existing.id, targetBlock.id, "based_on", db))
              db.createRelation({ source_id: existing.id, target_id: targetBlock.id, type: "based_on", bidirectional: false });
          }

          // Create other relations
          const ALLOWED_RELS_MERGE = new Set(["contradicts", "based_on", "related_to", "resolves", "supports", "prompted_by", "extends", "supersedes", "superseded_by", "derived_from", "affects"]);
          for (const rel of (blockDef.relations || [])) {
            if (!rel?.type || !rel?.target_id || rel.type === "part_of" || rel.type === "null" || rel.target_id === "null") continue;
            const relType = rel.type === "triggered_by" ? "prompted_by" : rel.type;
            if (!ALLOWED_RELS_MERGE.has(relType)) continue;
            const targetBlock = db.getBlock(rel.target_id) ?? allBlocks.find((b: any) => b.label === rel.target_id) ?? null;
            if (!targetBlock) continue;
            if (!shouldSkipRelation(existing.id, targetBlock.id, relType, db))
              db.createRelation({ source_id: existing.id, target_id: targetBlock.id, type: relType, bidirectional: false });
          }

          console.log(`Auto-Reflect: duplicate_label merged — "${blockDef.label}" (applied: concepts=${newConcepts.length})`);
          pipelineSkips.push({ label: blockDef.label, reason: "duplicate_merged" });
        } else {
          pipelineSkips.push({ label: blockDef.label, reason: "duplicate_label" });
        }
        result.skipped++;
        continue;
      }

      // Segment validation (max 4 underscore-separated segments)
      if (!labelFromObject) {
        if (!isValidLabelSegmentCount(blockDef.label, KNOWN_BLOCK_TYPES)) {
          const segs = blockDef.label.split("_");
          console.warn(`Auto-Reflect: rejected "${blockDef.label}" — ${segs.length} segments (max 4)`);
          pipelineSkips.push({ label: blockDef.label, reason: `too_many_segments: ${segs.length}` });
          result.skipped++;
          continue;
        }
      }

      // is_a validation
      if (blockDef.is_a && !seedTypeNames.has(blockDef.is_a)) {
        console.warn(`Auto-Reflect: rejected "${blockDef.label}" — unknown is_a "${blockDef.is_a}"`);
        pipelineSkips.push({ label: blockDef.label, reason: `unknown_type: "${blockDef.is_a}"` });
        result.skipped++;
        continue;
      }

      // Embedding
      let embedding: number[] | undefined;
      if (embeddings?.isAvailable()) {
        const embText = blockEmbeddingText({ essence: blockDef.essence, concepts: blockDef.concepts });
        embedding = await embeddings.embed(embText) ?? undefined;
      }

      // Infer project from label prefix
      const relations = [...(blockDef.relations || [])];
      const projectBlocks = allBlocks.filter((b) => b.type === "project");
      let inferredProj = projectBlocks.find((p) => blockDef.label.startsWith(p.label + "_"));
      if (!inferredProj) {
        const prefix = blockDef.label.split("_")[0];
        if (prefix && prefix !== blockDef.label) {
          const existingProj = db.getBlock(prefix);
          if (existingProj && existingProj.type === "project") {
            inferredProj = existingProj;
            allBlocks.push(existingProj);
          } else {
            const autoProj = db.createBlock({
              label: prefix, type: "project", status: "active",
              essence: `Auto-created project for '${prefix}' domain`,
              content: { is_a: "project", unique: {}, concepts: [] },
              ttl: "permanent", source: "Auto-Reflect", created_by: geminiCreatedBy,
            });
            stampQualityScore(db, autoProj, []);  // Bug 1 fix
            allBlocks.push(autoProj);
            newProjectLabels.add(prefix);
            inferredProj = autoProj;
            console.log(`Auto-Reflect: auto-created project root "${prefix}" for "${blockDef.label}"`);
          }
        }
      }

      // TS-layer fallback: if Pass 3 omitted triggered_by, synthesize from Pass 2 triggered_by_items.
      // Pass 3 is required to output triggered_by but Gemini sometimes omits it despite schema enforcement.
      // triggered_by_items values are either item IDs ("item_N") or existing block labels.
      if (!Array.isArray(blockDef.triggered_by) || blockDef.triggered_by.length === 0) {
        let fromItemId = blockDef.from_item_id as string | undefined;
        // Secondary fallback: if from_item_id is missing, match by type against unmatched Pass 2 items
        if (!fromItemId) {
          const usedItemIds = new Set(itemIdToLabel.keys());
          const matchedItem = pass2.classified.find(
            (item: any) => item.type === blockDef.is_a && !usedItemIds.has(item.id)
          );
          if (matchedItem) {
            fromItemId = matchedItem.id;
            blockDef = { ...blockDef, from_item_id: fromItemId };
            console.log(`Auto-Reflect: inferred from_item_id="${fromItemId}" for "${blockDef.label}" by type match`);
          }
        }
        const p2Items = fromItemId ? (itemTriggeredByItems.get(fromItemId) ?? []) : [];
        if (p2Items.length > 0) {
          const synthesized: string[] = [];
          for (const ref of p2Items) {
            if (ref.startsWith("item_")) {
              // item ID → resolve after itemIdToLabel is populated (add to pending)
              // We can't resolve yet since other blocks may not have labels yet —
              // store as a special marker to process in second pass
              synthesized.push(`__item_ref__${ref}`);
            } else {
              // existing block label — use directly
              synthesized.push(ref);
            }
          }
          if (synthesized.length > 0) blockDef = { ...blockDef, triggered_by: synthesized };
        }
      }

      // Resolve triggered_by
      const triggeredByIds: string[] = [];
      const unresolvedTriggeredByRefs: string[] = [];
      for (const ref of (blockDef.triggered_by || [])) {
        if (ref.startsWith("blk_")) {
          const b = db.getBlock(ref);
          if (b) triggeredByIds.push(b.id);
        } else if (ref.startsWith("__item_ref__")) {
          // Synthesized item ID reference — defer to second pass once itemIdToLabel is fully populated
          const itemId = ref.slice("__item_ref__".length);
          unresolvedTriggeredByRefs.push(`__item_ref__${itemId}`);
        } else {
          const b = allBlocks.find((bl) => bl.label === ref);
          if (b) {
            triggeredByIds.push(b.id);
          } else {
            unresolvedTriggeredByRefs.push(ref);
          }
        }
      }

      const hasTrigger = triggeredByIds.length > 0;

      const explicitReviewReason: string | null =
        (blockDef.review_reason as string | undefined) ||
        (blockDef.from_item_id ? (reviewMap.get(blockDef.from_item_id as string) ?? null) : null);

      // Tier 1B demote-at-save (2026-06-12, default-OFF NODEDEX_SAVE_DEMOTE=1):
      // the v2 path skips seam-α, so demotable insights (observation present,
      // implication unfillable) were arriving here FLAGGED instead of demoted.
      // Apply the SAME universal DEMOTE_TARGETS equivalence at the final seam —
      // exact-case only; label's type segment renamed so label/type agree; any
      // shape mismatch falls through to the soft flag below (capture-first).
      const demotion = process.env.NODEDEX_SAVE_DEMOTE !== "0"
        ? demoteForSave(blockDef.is_a, (blockDef.unique || {}) as Record<string, unknown>, blockDef.label)
        : null;
      if (demotion) {
        console.log(`Auto-Reflect Tier1B: demoted ${demotion.from_type}→${demotion.type} at save (required field unfillable): ${demotion.label}`);
        blockDef.is_a = demotion.type;
        blockDef.unique = demotion.unique;
        blockDef.label = demotion.label;
      }

      // Tier 1B (2026-05-24): type ↔ unique{} schema validator. Soft mode —
      // flags mismatches via review_status, never rejects. Charter rule 2 (never
      // delete vetted blocks) + rule 6 (guards catch failure, never override success).
      // Source of truth for schemas: docs/reference/block-types.md (verified 2026-05-24).
      const schemaCheck = validateUniqueSchema(blockDef.is_a, (blockDef.unique || {}) as Record<string, unknown>);
      const schemaReason = schemaMismatchReason(schemaCheck);

      const reviewReason: string | null = explicitReviewReason && schemaReason
        ? `${explicitReviewReason} | ${schemaReason}`
        : (explicitReviewReason || schemaReason);

      // Block provenance: default "agent_derived"; demote-edge marks "seam_demoted"
      // (looked up by from_item_id, mirroring reviewMap). Only the split path with
      // NODEDEX_SEAM_ALPHA_DEMOTE sets this — monolith leaves the map empty.
      // Save-time demote (above) marks "save_demoted" — distinct value so the
      // audit trail shows WHICH seam applied the equivalence.
      const blockSourceType = demotion
        ? "save_demoted"
        : (blockDef.from_item_id ? sourceTypeMap.get(blockDef.from_item_id as string) : undefined);

      // DEBT 5 D3 (§2.3.2) Phase 5: line-level provenance pinning. Look up
      // Pass 1's excerpt by from_item_id and pass to createBlock as
      // source_excerpt (separate column from content.raw_excerpt — which is
      // the LLM-emitted Pass 3 justification, may differ across runs).
      // source_excerpt is STABLE across runs because Pass 1 produces it once
      // per turn and arc re-extract re-uses the same pass01_output_json.
      // Falls back to undefined when from_item_id is missing OR Pass 1 left
      // excerpt empty → createBlock writes NULL → dedup logic (D2) treats
      // NULL as "pre-Debt-5 atomic" / no-pin and falls through to label dedup.
      const blockSourceExcerpt = blockDef.from_item_id ? sourceExcerptMap.get(blockDef.from_item_id as string) : undefined;

      // Fix 2 (2026-07-10): work-status vocabulary gate. Extraction wrote free text
      // into task/blueprint unique.status ("REQUIRED", whole sentences) — nothing
      // downstream could ever match it against open|in_progress|done, so items looked
      // permanently open. Normalize at save; unrecognized text is preserved in
      // has.status_note (never silently destroyed).
      const savedType = blockDef.is_a || "note";
      if ((savedType === "task" || savedType === "blueprint") && blockDef.unique && "status" in blockDef.unique) {
        const norm = normalizeWorkStatus((blockDef.unique as Record<string, unknown>).status);
        (blockDef.unique as Record<string, unknown>).status = norm.status;
        if (norm.note && norm.note.toLowerCase() !== norm.status) {
          blockDef.has = { ...(blockDef.has ?? {}), status_note: norm.note };
        }
      }

      const created = db.createBlock({
        label: blockDef.label,
        type: blockDef.is_a || "note",
        status: "pending",  // activated after Pass 4 — invisible to users until pipeline completes
        essence: blockDef.essence,
        content: {
          is_a: blockDef.is_a,
          unique: blockDef.unique || {},
          ...(blockDef.has && Object.keys(blockDef.has).length ? { has: blockDef.has } : {}),
          relations,
          concepts: blockDef.concepts || [],
          concepts_source: "gemini_reflect",
          novelty_reason: blockDef.novelty_reason || "",
          raw_excerpt: blockDef.raw_excerpt || "",
        },
        concepts: blockDef.concepts || [],
        ttl: blockDef.ttl || "permanent",
        source: "Auto-Reflect",
        ...(blockSourceType ? { source_type: blockSourceType } : {}),
        ...(blockSourceExcerpt ? { source_excerpt: blockSourceExcerpt } : {}),
        embedding,
        created_by: geminiCreatedBy,
      } as any);
      stampQualityScore(db, created, blockDef.concepts || []);  // Bug 1 fix: pipeline-created blocks must have quality_score set, else recall filters reject them at q=0
      p3PendingBlockIds.push(created.id);

      // Inline PROVENANCE check (followup 2026-06-20): the LLM extractor can
      // FABRICATE source_excerpt. We have the excerpt + the transcript right here,
      // so verify the quote actually appears in the transcript and FLAG it if not
      // (flag-don't-act: the block stays, the reviewer/agent judges; best-effort,
      // never throws). Inline because the transcript is in hand — works arc AND
      // per-turn, no block_extractions lookup; only 'missing' (totally-wrong) flags.
      if (blockSourceExcerpt) {
        flagBlockExcerptInline((db as any).db, created.id, blockSourceExcerpt,
          `${_userMessage ?? ""}\n${agentThinking ?? ""}\n${agentResponse ?? ""}`);
      }

      if (schemaReason) {
        console.warn(`Auto-Reflect schema-validator: ${blockDef.label} ${schemaReason}`);
      }

      if (reviewReason) {
        db.updateBlock(created.id, { review_status: "needs_review", review_reason: reviewReason });
        result.uncertain_count++;
      }

      // 4-part label: auto-create subgroup entity if needed
      let subgroupBlock: any = null;
      const labelParts = blockDef.label.split("_");
      if (
        labelParts.length >= 4 && inferredProj &&
        !KNOWN_BLOCK_TYPES.has(labelParts[1]) && KNOWN_BLOCK_TYPES.has(labelParts[2])
      ) {
        const subgroupLabel = `${labelParts[0]}_${labelParts[1]}`;
        subgroupBlock = allBlocks.find((b) => b.label === subgroupLabel) ?? db.getBlock(subgroupLabel);
        if (!subgroupBlock) {
          subgroupBlock = db.createBlock({
            label: subgroupLabel, type: "entity", status: "active",
            essence: `${labelParts[1]} sub-group within ${labelParts[0]}`,
            content: { is_a: "entity", unique: {}, concepts: [] },
            ttl: "permanent", source: "Auto-Reflect", created_by: geminiCreatedBy,
            project_id: inferredProj.id,
          });
          stampQualityScore(db, subgroupBlock, []);  // Bug 1 fix
          allBlocks.push(subgroupBlock);
          console.log(`Auto-Reflect: created subgroup "${subgroupLabel}" under "${inferredProj.label}"`);
        }
      }

      // project_id — set directly on the block (subgroup entity or project root)
      const projectOwner = subgroupBlock ?? inferredProj;
      if (projectOwner) {
        db.updateBlock(created.id, { project_id: projectOwner.id });
        created.project_id = projectOwner.id;
      }

      // prompted_by from triggered_by
      for (const targetId of triggeredByIds) {
        if (!shouldSkipRelation(created.id, targetId, "prompted_by", db))
          db.createRelation({ source_id: created.id, target_id: targetId, type: "prompted_by", bidirectional: false });
      }

      // Defer unresolved triggered_by refs
      for (const ref of unresolvedTriggeredByRefs) {
        pendingTriggeredBy.push({ sourceId: created.id, labelRef: ref });
      }

      // based_on from Pass 3 top-level based_on[] field (same resolution as triggered_by)
      for (const ref of (blockDef.based_on || [])) {
        const targetBlock = ref.startsWith("blk_")
          ? db.getBlock(ref)
          : allBlocks.find((b: any) => b.label === ref) ?? null;
        if (!targetBlock) {
          pendingTriggeredBy.push({ sourceId: created.id, labelRef: `__based_on__${ref}` });
          continue;
        }
        if (!shouldSkipRelation(created.id, targetBlock.id, "based_on", db)) {
          db.createRelation({ source_id: created.id, target_id: targetBlock.id, type: "based_on", bidirectional: false });
          console.log(`Auto-Reflect: based_on (Pass 3) — "${blockDef.label}" → "${targetBlock.label}"`);
        }
      }

      // Extra relations
      const ALLOWED_RELS = new Set(["contradicts", "based_on", "related_to", "resolves", "supports", "prompted_by", "extends", "supersedes", "superseded_by", "derived_from", "affects"]);
      for (const rel of (blockDef.relations || [])) {
        if (!rel?.type || !rel?.target_id || rel.type === "part_of" || rel.type === "null" || rel.target_id === "null") continue;
        // triggered_by is a Pass 3 alias for prompted_by — translate it
        const relType = rel.type === "triggered_by" ? "prompted_by" : rel.type;
        if (!ALLOWED_RELS.has(relType)) {
          console.warn(`Auto-Reflect: relation type "${rel.type}" on "${blockDef.label}" not in ALLOWED_RELS — dropped`);
          pipelineSkips.push({ label: blockDef.label, reason: `relation_type_not_allowed: ${rel.type} → ${rel.target_id}` });
          continue;
        }
        const targetBlock = db.getBlock(rel.target_id) ?? allBlocks.find((b: any) => b.label === rel.target_id) ?? null;
        if (!targetBlock) continue;
        if (!shouldSkipRelation(created.id, targetBlock.id, relType, db))
          db.createRelation({ source_id: created.id, target_id: targetBlock.id, type: relType, bidirectional: false });
      }

      // Quality score
      let qScore = 1;
      {
        const qc: any = typeof created.content === "string" ? (JSON.parse(created.content) || {}) : (created.content || {});
        if (qc.is_a) qScore++;
        if (qc.unique && Object.keys(qc.unique).length >= 2) qScore++;
        if ((blockDef.concepts || []).length >= 3) qScore++;
        if (db.getRelations(created.id).length > 0) qScore++;
        qScore = Math.min(qScore, 5);
        db.updateBlock(created.id, { quality_score: qScore });
      }

      if (blockDef.from_item_id) itemIdToLabel.set(blockDef.from_item_id as string, blockDef.label as string);

      allBlocks.push(created);
      result.saved++;
      result.saved_labels.push(blockDef.label);
      result.created_blocks.push({
        label: blockDef.label,
        type: blockDef.is_a || "note",
        quality: qScore,
        project: inferredProj?.label ?? blockDef.label.split("_")[0] ?? "unknown",
      });
      const uniqueVals = blockDef.unique && typeof blockDef.unique === "object" && Object.keys(blockDef.unique).length > 0
        ? Object.entries(blockDef.unique).map(([k, v]) => `${k}: ${v}`).join(", ")
        : undefined;
      _pendingRecentSaves.push({ label: blockDef.label, essence: blockDef.essence, values: uniqueVals });
    }

    // Second-pass triggered_by resolution
    if (pendingTriggeredBy.length > 0) {
      for (const { sourceId, labelRef } of pendingTriggeredBy) {
        // Resolve __item_ref__ markers from TS-layer synthesis fallback
        let resolvedRef = labelRef;
        if (labelRef.startsWith("__item_ref__")) {
          const itemId = labelRef.slice("__item_ref__".length);
          const resolvedLabel = itemIdToLabel.get(itemId);
          if (!resolvedLabel) continue;
          resolvedRef = resolvedLabel;
        }
        const isBased = labelRef.startsWith("__based_on__");
        if (isBased) resolvedRef = labelRef.slice("__based_on__".length);
        const target = allBlocks.find((b) => b.label === resolvedRef);
        if (!target) continue;
        const relType = isBased ? "based_on" : "prompted_by";
        if (shouldSkipRelation(sourceId, target.id, relType, db)) continue;
        db.createRelation({ source_id: sourceId, target_id: target.id, type: relType, bidirectional: false });
        console.log(`Auto-Reflect: deferred ${relType} resolved — "${resolvedRef}"`);
      }
    }

    // Shared fresh lookup for server-side resolution — allBlocks is built incrementally during
    // the Pass 3 loop but may miss blocks if any were skipped. A fresh DB fetch is authoritative.
    const freshBlockByLabel = new Map(db.getAllBlocks().map((b: any) => [b.label, b]));

    // Server-side extends_item resolution
    if (itemIdToLabel.size > 0) {
      for (const item of pass2.classified) {
        if (!item.extends_item) continue;
        const sourceLabel = itemIdToLabel.get(item.id);
        let targetLabel = itemIdToLabel.get(item.extends_item);
        if (!targetLabel && !item.extends_item.startsWith("item_") && !item.extends_item.includes("::")) {
          targetLabel = item.extends_item; // Pass 2 emitted a label (target was skipped); item-shaped refs (v1 item_ / v2 ::) never are
        }
        if (!sourceLabel || !targetLabel || sourceLabel === targetLabel) {
          if (!sourceLabel || !targetLabel) {
            const missing = !sourceLabel ? `source item_id=${item.id}` : `target extends_item=${item.extends_item}`;
            console.warn(`Auto-Reflect: extends_item resolution skipped — ${missing} not in itemIdToLabel and not a label`);
            pipelineSkips.push({ label: item.id, reason: `extends_item_unresolved: ${missing}` });
          }
          continue;
        }
        const sourceBlock = freshBlockByLabel.get(sourceLabel);
        const targetBlock = freshBlockByLabel.get(targetLabel) ?? db.getBlock(targetLabel);
        if (!sourceBlock || !targetBlock) continue;
        const existingRels = db.getRelations(sourceBlock.id);
        if (existingRels.some((r: any) => r.type === "extends" && r.target_id === targetBlock.id)) continue;
        db.createRelation({ source_id: sourceBlock.id, target_id: targetBlock.id, type: "extends", bidirectional: false });
        console.log(`Auto-Reflect: extends resolved server-side — "${sourceLabel}" → "${targetLabel}"`);
      }
    }

    // Server-side based_on_items resolution
    // Mirrors triggered_by_items translation — Pass 2 based_on_items[] → based_on relations in DB.
    // Values are item IDs ("item_N") resolved via itemIdToLabel, or existing block labels.
    for (const item of pass2.classified) {
      if (!Array.isArray(item.based_on_items) || item.based_on_items.length === 0) continue;
      const sourceLabel = itemIdToLabel.get(item.id);
      if (!sourceLabel) continue;
      const sourceBlock = freshBlockByLabel.get(sourceLabel);
      if (!sourceBlock) continue;
      for (const ref of item.based_on_items) {
        const resolved = resolveWithinBatchRefLabel(ref, itemIdToLabel);
        if (!resolved) continue;
        const targetBlock = freshBlockByLabel.get(resolved.label)
          ?? (resolved.viaItemMap ? null : db.getBlock(resolved.label));
        if (!targetBlock) continue;
        if (shouldSkipRelation(sourceBlock.id, targetBlock.id, "based_on", db)) continue;
        db.createRelation({ source_id: sourceBlock.id, target_id: targetBlock.id, type: "based_on", bidirectional: false });
        console.log(`Auto-Reflect: based_on resolved server-side — "${sourceLabel}" → "${targetBlock.label}"`);
      }
    }

    // Server-side triggered_by_items resolution (2026-06-15 — the prompted_by edge-loss fix).
    // MIRRORS the based_on_items loop above. prompted_by was the ONE causal relation never
    // given a server-side resolver: cefbb2d (May) added one for based_on, and later supersedes
    // / the semantic rels got theirs, but triggered_by was left on the fragile inline path that
    // resolves the Pass 3 LLM's RE-EMITTED LABELS during the save loop. That broke two ways —
    // the Pass 3 LLM silently dropped forward edges it was handed, and demote-at-save renamed a
    // target out from under a label reference (a `_insight_` → `_fact_` demote orphaned every
    // prompted_by pointing at the old label). Reading the AUTHORITATIVE item.triggered_by_items
    // (item-ids) here, AFTER all blocks are saved + demoted, via the demote-aware item-map, fixes
    // both — identical to how based_on works. shouldSkipRelation dedupes against the inline path.
    // (2026-06-15 aquarium arc: a blueprint whose only edge was prompted_by was orphaned; live
    //  graphs carried 0 prompted_by edges as a result.)
    for (const item of pass2.classified) {
      if (!Array.isArray(item.triggered_by_items) || item.triggered_by_items.length === 0) continue;
      const sourceLabel = itemIdToLabel.get(item.id);
      if (!sourceLabel) continue;
      const sourceBlock = freshBlockByLabel.get(sourceLabel);
      if (!sourceBlock) continue;
      for (const ref of item.triggered_by_items) {
        const resolved = resolveWithinBatchRefLabel(ref, itemIdToLabel);
        if (!resolved) continue;
        const targetBlock = freshBlockByLabel.get(resolved.label)
          ?? (resolved.viaItemMap ? null : db.getBlock(resolved.label));
        if (!targetBlock) continue;
        if (shouldSkipRelation(sourceBlock.id, targetBlock.id, "prompted_by", db)) continue;
        db.createRelation({ source_id: sourceBlock.id, target_id: targetBlock.id, type: "prompted_by", bidirectional: false });
        console.log(`Auto-Reflect: prompted_by resolved server-side — "${sourceLabel}" → "${targetBlock.label}"`);
      }
    }

    // Server-side within-batch supersedes resolution (Pass 2 supersedes_ref = item ID)
    // When Pass 2 sets supersedes_ref to an item ID (not a block label), resolve it here.
    // Within-batch test = map membership, NOT an id-prefix (v2 ids are group::local).
    for (const item of pass2.classified) {
      if (!item.supersedes_ref || !itemIdToLabel.has(item.supersedes_ref)) continue;
      const sourceLabel = itemIdToLabel.get(item.id);
      if (!sourceLabel) continue;
      const sourceBlock = freshBlockByLabel.get(sourceLabel);
      if (!sourceBlock) continue;
      const targetLabel = itemIdToLabel.get(item.supersedes_ref);
      if (!targetLabel) continue;
      const targetBlock = freshBlockByLabel.get(targetLabel);
      if (!targetBlock) continue;
      if (shouldSkipRelation(sourceBlock.id, targetBlock.id, "supersedes", db)) continue;
      db.createRelation({ source_id: sourceBlock.id, target_id: targetBlock.id, type: "supersedes", bidirectional: false });
      console.log(`Auto-Reflect: supersedes resolved server-side (within-batch) — "${sourceLabel}" → "${targetLabel}"`);
    }

    // Server-side semantic relations resolution (Pass 2 relations[] field)
    // Handles contradicts, supports, resolves, derived_from, affects wired by Pass 2 Q5.
    // Values are item IDs ("item_N") or existing block labels — same pattern as based_on_items.
    const SEMANTIC_RELS = new Set(["contradicts", "supports", "resolves", "derived_from", "affects", "related_to"]);
    for (const item of pass2.classified) {
      if (!Array.isArray(item.relations) || item.relations.length === 0) continue;
      const sourceLabel = itemIdToLabel.get(item.id);
      if (!sourceLabel) continue;
      const sourceBlock = freshBlockByLabel.get(sourceLabel);
      if (!sourceBlock) continue;
      for (const rel of item.relations) {
        if (!rel?.type || !rel?.target || !SEMANTIC_RELS.has(rel.type)) continue;
        const resolved = resolveWithinBatchRefLabel(rel.target, itemIdToLabel);
        if (!resolved) continue;
        const targetBlock = freshBlockByLabel.get(resolved.label)
          ?? (resolved.viaItemMap ? null : db.getBlock(resolved.label));
        if (!targetBlock) continue;
        if (shouldSkipRelation(sourceBlock.id, targetBlock.id, rel.type, db)) continue;
        db.createRelation({ source_id: sourceBlock.id, target_id: targetBlock.id, type: rel.type, bidirectional: false });
        console.log(`Auto-Reflect: ${rel.type} resolved server-side — "${sourceLabel}" → "${targetBlock.label}"`);
      }
    }

    // Stamp chain_id on connected groups
    stampFlowRolesAndChains(result.saved_labels, allBlocks, db);

    // ── SLICE 1 SUB-STEP 1.4 — STAGE FLAG writer ──────────────────────────────
    // For each (source_excerpt, primary_value)-twin DETECTED by D2 dedup
    // earlier in this run, write a pipeline_flags row of type='atomic_dup_
    // candidate'. The async LLM reviewer (Slice 2) will consume these and
    // decide merge/leave/split with full graph context.
    //
    // Resolution: dedup detected at the item-id level (e.g., "item_T1_3");
    // pipeline_flags FK requires block_id. We resolve via itemIdToLabel
    // (populated during createBlock loop) → db.getBlock(label) → block.id.
    // When either side fails to resolve, we skip the flag (graceful degrade;
    // the duplicate already exists in the graph, just without the flag —
    // Slice 2 AUDIT will catch the missed ones later).
    //
    // origin_range_id is NULL here — pipeline.ts doesn't know arc range_id
    // (arc-pipeline.ts owns range creation, after runAutoReflect returns).
    // Stage AUDIT (Slice 2) can backfill if needed; for Sub-step 1.4 the
    // flag without range linkage is still actionable for the reviewer.
    if (atomicDupCandidates.length > 0) {
      let flagsWritten = 0;
      let flagsSkipped = 0;
      const rawDb = (db as any).rawDb ?? (db as any).db;
      if (!rawDb) {
        console.warn(`[stage-flag] cannot write ${atomicDupCandidates.length} flag(s) — no raw DB handle`);
      } else {
        for (const dup of atomicDupCandidates) {
          try {
            const loserLabel  = itemIdToLabel.get(dup.id);
            const winnerLabel = itemIdToLabel.get(dup.duplicate_of);
            if (!loserLabel || !winnerLabel) { flagsSkipped++; continue; }
            const loserBlock  = db.getBlock(loserLabel);
            const winnerBlock = db.getBlock(winnerLabel);
            if (!loserBlock || !winnerBlock) { flagsSkipped++; continue; }
            writePipelineFlag(rawDb, {
              flag_type:       'atomic_dup_candidate',
              block_id_a:      loserBlock.id,
              block_id_b:      winnerBlock.id,
              criteria:        {
                detected_by:        'dedup_by_source_and_value',
                dedup_key:          dup.key,
                loser_item_id:      dup.id,
                winner_item_id:     dup.duplicate_of,
                loser_label:        loserLabel,
                winner_label:       winnerLabel,
              },
              scope_check:     'unknown',
              origin_writer:   'stage_flag_dedup',
              origin_range_id: null,
            });
            flagsWritten++;
          } catch (e: any) {
            console.warn(`[stage-flag] writePipelineFlag failed for ${dup.id}: ${e?.message}`);
            flagsSkipped++;
          }
        }
        if (flagsWritten > 0 || flagsSkipped > 0) {
          console.log(`[stage-flag] wrote ${flagsWritten} atomic_dup_candidate flag(s), skipped ${flagsSkipped} (block resolution failed)`);
        }
      }
    }

    // ── DEBT 5 Slice 3 Part 4 — STAGE D flag writer (Touchpoint B) ──────────────
    // Drain the cross-arc resolve results (Touchpoint A) into cross_arc_dup_candidate
    // flags, now that item_id → block_id is resolvable via itemIdToLabel. Same
    // pattern + same graceful-degrade as the atomic_dup writer above. Stage D
    // FLAGS only — the async reviewer (flag-reviewer.ts) decides merge/leave and is
    // the sole actor that mutates the graph.
    //   block_id_a = THIS arc's newly-created block (the new item)
    //   block_id_b = the existing graph block it matched against (now set for
    //                flag_for_review too, not just attach_existing)
    // Which side WINS is decided at REVIEW time, not here. For attach_existing the
    // existing block (b) is canonical; for flag_for_review (owner-unknown) the winner
    // is undetermined — the agent/reviewer/user adjudicates (often the owned new block
    // adopts the orphan). So a/b are just "the pair", NOT a fixed loser/winner.
    if (stageDEntries.length > 0) {
      let sdWritten = 0, sdSkipped = 0;
      const rawDb = (db as any).rawDb ?? (db as any).db;
      if (!rawDb) {
        console.warn(`[stage-d] cannot write ${stageDEntries.length} flag(s) — no raw DB handle`);
      } else {
        for (const e of stageDEntries) {
          try {
            const newLabel = itemIdToLabel.get(e.item_id);
            if (!newLabel) { sdSkipped++; continue; }          // item wasn't written as a block (skipped) — nothing to flag
            const newBlock = db.getBlock(newLabel);
            if (!newBlock) { sdSkipped++; continue; }
            writePipelineFlag(rawDb, {
              flag_type:       'cross_arc_dup_candidate',
              block_id_a:      newBlock.id,
              block_id_b:      e.matched_block_id ?? null,
              criteria:        {
                detected_by:    'stage_d_resolve',
                decision:       e.decision,             // 'attach_existing' | 'flag_for_review'
                resolved_by:    e.resolved_by,          // 'code_exact' | 'llm' | 'no_candidates'
                new_item_id:    e.item_id,
                new_label:      newLabel,
                matched_label:  e.matched_block_label ?? null,
                reasoning:      e.reasoning,
                flag_reason:    e.flag_reason ?? null,
              },
              // attach_existing = resolver judged same scope; flag_for_review = owner unknown.
              scope_check:     e.decision === 'attach_existing' ? 'same' : 'unknown',
              origin_writer:   'stage_d_resolve',
              origin_range_id: null,
            });
            sdWritten++;
          } catch (err: any) {
            console.warn(`[stage-d] writePipelineFlag failed for ${e.item_id}: ${err?.message}`);
            sdSkipped++;
          }
        }
        if (sdWritten > 0 || sdSkipped > 0) {
          console.log(`[stage-d] wrote ${sdWritten} cross_arc_dup_candidate flag(s), skipped ${sdSkipped} (block resolution failed)`);
        }
      }
    }

    // Process updates
    const ALLOWED_RELS = new Set(["contradicts", "based_on", "related_to", "resolves", "supports", "prompted_by", "extends", "supersedes", "superseded_by", "derived_from", "affects"]);
    for (const updateDef of (analysis.updates || [])) {
      if (!updateDef?.block_id) continue;
      const existing = db.getBlock(updateDef.block_id);
      if (!existing) continue;

      const content: Record<string, unknown> = typeof existing.content === "string"
        ? JSON.parse(existing.content)
        : Object.assign({}, existing.content as object);

      if (updateDef.unique_patch && typeof updateDef.unique_patch === "object") {
        content.unique = { ...(content.unique || {}), ...updateDef.unique_patch };
      }

      const blockUpdates: Record<string, unknown> = { content };
      if (updateDef.essence) blockUpdates.essence = updateDef.essence;

      if (updateDef.ttl) {
        console.warn(`Auto-Reflect: ttl "${updateDef.ttl}" on update for "${existing.label}" ignored — updates do not apply ttl changes`);
        pipelineSkips.push({ label: existing.label, reason: `update_ttl_ignored: ${updateDef.ttl}` });
      }

      db.updateBlock(updateDef.block_id, blockUpdates, updateDef.reason || "Auto-Reflect Update");
      result.updated++;
      result.updated_blocks.push({ label: existing.label, type: existing.type });

      if (updateDef.relations_add && Array.isArray(updateDef.relations_add)) {
        for (const rel of updateDef.relations_add) {
          if (!rel?.type || !rel?.target_id) continue;
          // triggered_by is a Pass 3 alias for prompted_by — translate it
          const relType = rel.type === "triggered_by" ? "prompted_by" : rel.type;
          if (!ALLOWED_RELS.has(relType)) {
            console.warn(`Auto-Reflect: relation type "${rel.type}" in relations_add on "${existing.label}" not in ALLOWED_RELS — dropped`);
            pipelineSkips.push({ label: existing.label, reason: `update_relation_type_not_allowed: ${rel.type} → ${rel.target_id}` });
            continue;
          }
          const targetBlock = db.getBlock(rel.target_id) ?? allBlocks.find((b: any) => b.label === rel.target_id) ?? null;
          if (!targetBlock) continue;
          if (!shouldSkipRelation(existing.id, targetBlock.id, relType, db)) {
            db.createRelation({ source_id: existing.id, target_id: targetBlock.id, type: relType, bidirectional: false });
            console.log(`Auto-Reflect: added ${relType} link on "${existing.label}" → "${targetBlock.label}"`);
          }
        }
      }

      const updContent: Record<string, any> = typeof existing.content === "string"
        ? (JSON.parse(existing.content) || {})
        : (existing.content || {});
      const updUnique = updContent.unique && typeof updContent.unique === "object" && Object.keys(updContent.unique).length > 0
        ? Object.entries(updContent.unique).map(([k, v]) => `${k}: ${v}`).join(", ")
        : undefined;
      _pendingRecentSaves.push({
        label: existing.label,
        essence: updateDef.essence || existing.essence || "",
        update_note: updateDef.reason || "fields updated",
        values: updUnique,
      });
    }

    } else {
      // ── resumeFrom 'pass4': restore result from blocks already written as 'pending' in DB ──
      // Pass 3 completed on a prior attempt; blocks exist in DB as status='pending'.
      // Restore result state so Pass 4 can wire relations, then activate blocks after.
      const pendingBlocksInDb = db.getAllBlocks().filter((b: any) => p3PendingBlockIds.includes(b.id));
      for (const b of pendingBlocksInDb) {
        result.saved++;
        result.saved_labels.push(b.label);
        result.created_blocks.push({
          label: b.label,
          type: b.type,
          quality: (b as any).quality_score ?? 1,
          project: b.label.split('_')[0] ?? 'unknown',
        });
        const bContent: Record<string, any> = typeof b.content === "string" ? (JSON.parse(b.content) || {}) : (b.content || {});
        const bUnique = bContent.unique && typeof bContent.unique === "object" && Object.keys(bContent.unique).length > 0
          ? Object.entries(bContent.unique).map(([k, v]) => `${k}: ${v}`).join(", ")
          : undefined;
        _pendingRecentSaves.push({ label: b.label, essence: b.essence || "", values: bUnique });
        if (!allBlocks.find((x: any) => x.id === b.id)) allBlocks.push(b);
      }
      console.log(`Auto-Reflect Pass 4 retry: restored ${result.saved} pending block(s) from DB`);
    } // end if (checkpoint?.resumeFrom !== 'pass4')

    // ── PASS 4: Connect ──
    if (result.saved > 0) {
      // ── INLINE DEDUP (recognize-before-write) ──
      // Merge this-turn's cross-turn duplicates BEFORE Pass 4 links them, so no
      // spurious `extends` edge forms between a block and its own restatement
      // (which the reviewer would then read as "elaboration, keep both" and
      // refuse to merge — the async-after-linking failure). Serves compounding:
      // one residue → one block. Default-off NODEDEX_INLINE_DEDUP; the async
      // AUDIT stays the cross-session backstop. Losers are archived, so the
      // freshBlocks re-query below naturally excludes them from Pass 4 / Pass 5.
      if (inlineDedupEnabled() && p3PendingBlockIds.length > 0) {
        try {
          const { flagsWritten, merges, routed, mergedAway, mergedAwayLabels } =
            await dedupNewBlocksInline(db, provider, p3PendingBlockIds);
          if (mergedAway.size > 0) {
            for (let i = p3PendingBlockIds.length - 1; i >= 0; i--) {
              if (mergedAway.has(p3PendingBlockIds[i]!)) p3PendingBlockIds.splice(i, 1);
            }
            result.saved_labels = result.saved_labels.filter((l) => !mergedAwayLabels.has(l));
            result.saved = Math.max(0, result.saved - mergedAway.size);
          }
          console.log(`Auto-Reflect inline-dedup: ${flagsWritten} flag(s), ${merges} merged, ${routed} routed-to-agent (before Pass 4)`);
        } catch (e: any) {
          console.warn(`Auto-Reflect inline-dedup failed (continuing to Pass 4): ${e?.message ?? e}`);
        }
      }

      const freshBlocks = db.getAllBlocks();
      const freshRels   = db.getAllRelations(false);
      const savedLabelSet = new Set(result.saved_labels);
      // Pass 4's job is to link THIS-TURN's new blocks to the EXISTING graph from prior sessions.
      // The PROJECT GRAPH context must therefore exclude this-turn's just-saved blocks — otherwise
      // Pass 4 can match a new block against itself and emit self-referential supersedes.
      // (Also prevents stampReflectedAt from prematurely stamping the new blocks.)
      // Gap ⑤ (scale): feed Pass 4 a RETRIEVED SLICE instead of the whole-graph
      // dump — but only above the small-graph threshold (below it the dump is
      // cheaper than k retrievals). Default OFF; identical output contract.
      let freshContext: string;
      let _reflectedIds2: string[];
      let p4SliceMode = false;
      if (pass4SliceEnabled() && freshBlocks.length >= pass4SliceMinGraph()) {
        p4SliceMode = true;
        const newBlocksRaw = freshBlocks.filter((b) => savedLabelSet.has(b.label));
        const slice = buildPass4Slice(db, newBlocksRaw);
        freshContext = slice.context;
        _reflectedIds2 = slice.reflectedIds;
        console.log(`Auto-Reflect Pass 4: slice mode — ${_reflectedIds2.length} candidate block(s) from ${freshBlocks.length} total`);
      } else {
        const contextBlocks = freshBlocks.filter((b) => !savedLabelSet.has(b.label));
        const built = buildProjectContext(contextBlocks, freshRels, allProjectPrefixes, loadedBlocks);
        freshContext = built.context;
        _reflectedIds2 = built.reflectedIds;
      }
      db.stampReflectedAt(_reflectedIds2);
      const freshBlockById = new Map(freshBlocks.map((b) => [b.id, b]));

      const p4RelMap = new Map<string, Array<{ type: string; targetId: string }>>();
      for (const r of freshRels) {
        if (r.status !== "active" || r.type === "part_of") continue;
        if (!p4RelMap.has(r.source_id)) p4RelMap.set(r.source_id, []);
        p4RelMap.get(r.source_id)!.push({ type: r.type, targetId: r.target_id });
      }

      const newBlocksForP4 = freshBlocks
        .filter((b) => savedLabelSet.has(b.label))
        .map((b) => {
          let uniqueFields = "";
          try {
            const c = typeof b.content === "string" ? JSON.parse(b.content) : b.content;
            const u = c?.unique ?? {};
            const pairs = Object.entries(u)
              .filter(([, v]) => v && String(v).trim())
              .map(([k, v]) => `${k}: "${String(v).slice(0, 80)}"`)
              .slice(0, 4);
            if (pairs.length > 0) uniqueFields = ` | unique: { ${pairs.join(", ")} }`;
          } catch { /* skip */ }

          const rels = p4RelMap.get(b.id) ?? [];
          const chainLines = rels
            .filter((r) => ["prompted_by", "based_on", "supersedes", "extends", "derived_from"].includes(r.type))
            .slice(0, 4)
            .map((r) => {
              const linked = freshBlockById.get(r.targetId);
              if (!linked) return null;
              let linkedUnique = "";
              try {
                const lc = typeof linked.content === "string" ? JSON.parse(linked.content) : linked.content;
                const lu = lc?.unique ?? {};
                const lp = Object.entries(lu).filter(([, v]) => v).map(([k, v]) => `${k}:"${String(v).slice(0, 60)}"`).slice(0, 2);
                if (lp.length) linkedUnique = ` {${lp.join(", ")}}`;
              } catch { /* skip */ }
              return `      ${r.type}→ ${linked.label} — "${(linked.essence || "").slice(0, 80)}"${linkedUnique}`;
            })
            .filter(Boolean);

          return {
            id: b.id,
            label: b.label,
            type: b.type,
            essence: b.essence || "",
            uniqueFields,
            chain: chainLines as string[],
          };
        });

      if (newBlocksForP4.length > 0) {
        // ── Batched emission (2026-07-03) ──────────────────────────────────────
        // ONE call per ≤NODEDEX_PASS4_BATCH new blocks (default 20), mirroring
        // fill_2b. The input-side slice was always capped; the OUTPUT grows with
        // the new-block count — 157 new blocks in one call blew the model's output
        // cap in the dogfood run (truncated twice → whole pass failed → every
        // cross-group conclusion orphaned). Batching bounds each call's output and
        // isolates failures: a truncated batch loses only its own links.
        // Relations still accumulate and apply AFTER all batches (same contract as
        // the old single call), so the rate-limit checkpoint semantics are
        // unchanged: nothing is applied on a mid-run rate limit, and the retry
        // re-runs the whole pass (createRelation is idempotent regardless).
        const p4Queue = chunkForPass4(newBlocksForP4);
        const p4BatchTotal = p4Queue.length;
        const p4Relations: Array<{ source_id: string; type: string; target_id: string; reason?: string }> = [];
        let p4AnySuccess = false;
        let p4RateLimited = false;
        let p4Processed = 0;
        let p4Splits = 0;
        // A FAILED batch (truncation-shaped: result null, not rate-limited) is REQUEUED
        // BY BISECTION: output size scales with batch size, so halving and retrying both
        // halves is the retry that can actually succeed — unlike the provider's same-size
        // retry, which is a no-op at the model's output ceiling. Split floor of 4 (halves
        // of ≥2): a 2-3 block batch that still fails is not a size problem — skip it.
        // Split budget caps the extra calls so a systemically-failing provider can't loop.
        const P4_MAX_SPLITS = 8;
        const p4ThinkingParts: string[] = [];
        const _t4 = Date.now();
        while (p4Queue.length > 0) {
          const batch = p4Queue.shift()!;
          p4Processed++;
          // Slice mode: rebuild the candidate slice for THIS batch only — tighter,
          // more relevant context per call. Whole-graph mode: the context is the
          // existing graph (independent of the new blocks), so reuse it.
          let batchContext = freshContext;
          if (p4SliceMode && (p4BatchTotal > 1 || p4Splits > 0)) {
            const raw = batch.map((nb) => freshBlockById.get(nb.id)).filter((b): b is NonNullable<typeof b> => !!b);
            batchContext = buildPass4Slice(db, raw).context;
          }
          const p4Budget = getThinkingBudget(batch.length <= 5 ? 1024 : 2048);
          const p4 = await callPass4LLM(provider, batch, batchContext, p4Budget, _sceneCard);
          if (!_pass4Provider || p4.model) _pass4Provider = { model: p4.model, attempts: p4.attempts };
          if (p4.rateLimited) { p4RateLimited = true; break; }
          if (p4.thinking) p4ThinkingParts.push(p4.thinking);
          const total = p4BatchTotal + p4Splits;
          if (p4.result) {
            p4AnySuccess = true;
            if (p4.result.relations?.length) p4Relations.push(...p4.result.relations);
            if (total > 1) console.log(`Auto-Reflect Pass 4: batch ${p4Processed}/${total} (${batch.length} block(s)) → ${p4.result.relations?.length ?? 0} relation(s)`);
          } else if (batch.length >= 4 && p4Splits < P4_MAX_SPLITS) {
            const mid = Math.ceil(batch.length / 2);
            p4Queue.unshift(batch.slice(0, mid), batch.slice(mid));
            p4Splits++;
            console.log(`Auto-Reflect Pass 4: batch ${p4Processed}/${total} (${batch.length} block(s)) failed → split ${mid}+${batch.length - mid}, requeued`);
          } else {
            console.log(`Auto-Reflect Pass 4: batch ${p4Processed}/${total} (${batch.length} block(s)) failed — skipped (${batch.length} block(s) left unlinked this run)`);
          }
        }
        _passWallMs.pass4 = Date.now() - _t4;

        if (p4RateLimited) {
          // Blocks are in DB as 'pending' — save checkpoint so Pass 4 retries with those blocks.
          // Do NOT activate pending blocks yet; they stay invisible until Pass 4 completes.
          console.log(`Auto-Reflect Pass 4: rate limited — ${p3PendingBlockIds.length} block(s) kept pending, re-queuing`);
          return { ...empty, checkpoint: {
            resumeFrom: 'pass4' as const,
            pass0: { sceneCard: _sceneCard, raw: _pass0Raw },
            pass1Items: pass1?.items,
            pass2Classified: pass2?.classified,
            p3PendingBlockIds: p3PendingBlockIds.length > 0 ? p3PendingBlockIds : undefined,
          } };
        }

        const p4Merged = p4AnySuccess ? { relations: p4Relations } : null;
        _pass4Thinking = p4ThinkingParts.join("\n");
        _pass4Result = p4Merged;
        writeReflectLog({ pass1, pass2, pass3: analysis, pass4: p4Merged });
        if (p4Merged?.relations?.length) {
          const PASS4_ALLOWED = new Set(["extends", "supersedes", "superseded_by", "prompted_by", "based_on", "resolves"]);
          let linked = 0;
          for (const rel of p4Merged.relations) {
            if (!rel?.source_id || !rel?.type || !rel?.target_id) continue;
            if (!PASS4_ALLOWED.has(rel.type)) continue;
            const src = freshBlocks.find((b) => b.label === rel.source_id || b.id === rel.source_id);
            const tgt = freshBlocks.find((b) => b.label === rel.target_id || b.id === rel.target_id);
            if (!src || !tgt || src.id === tgt.id) continue;
            // Skip project-type blocks — they are containers, not knowledge
            if (src.type === 'project' || tgt.type === 'project') continue;
            // Skip intra-batch: Pass 2 already wired same-batch relations
            if (savedLabelSet.has(src.label) && savedLabelSet.has(tgt.label)) continue;
            const EXCLUDED_REL_PREFIXES = new Set(["agent-meta", "system"]);
            if (EXCLUDED_REL_PREFIXES.has((src.label || "").split("_")[0]) ||
                EXCLUDED_REL_PREFIXES.has((tgt.label || "").split("_")[0])) continue;
            if (shouldSkipRelation(src.id, tgt.id, rel.type, db)) continue;
            // Skip if reverse relation already exists (prevents bidirectional cycles)
            if (db.getRelations(tgt.id).some(r => r.direction === "outgoing" && r.target_id === src.id)) continue;
            db.createRelation({ source_id: src.id, target_id: tgt.id, type: rel.type, bidirectional: false });
            console.log(`Auto-Reflect Pass 4: "${src.label}" --[${rel.type}]--> "${tgt.label}"`);
            linked++;
          }
          if (linked > 0) console.log(`Auto-Reflect Pass 4: ${linked} relation(s) applied`);
        }
      }
    }

    // Activate pending blocks — Pass 4 has completed (or was skipped — no new blocks).
    // Blocks are now visible to users and appear in graph navigation.
    if (p3PendingBlockIds.length > 0) {
      const { activated, skippedArchived } = activatePendingBlocks(db, p3PendingBlockIds);
      console.log(
        `Auto-Reflect: activated ${activated}/${p3PendingBlockIds.length} pending block(s)` +
        (skippedArchived > 0 ? ` (${skippedArchived} archived in-turn by same-turn supersede — left as history)` : "")
      );
    }

    // ── PASS 5: Chain Assembly ──
    if (result.saved >= 2) {
      const freshBlocks5 = db.getAllBlocks();
      const freshRels5   = db.getAllRelations(false);
      const savedLabelSet5 = new Set(result.saved_labels);
      const freshBlockById5 = new Map(freshBlocks5.map((b: any) => [b.id, b]));

      const p5Blocks = freshBlocks5
        .filter((b: any) => savedLabelSet5.has(b.label))
        .map((b: any) => ({
          id: b.id,
          label: b.label,
          type: b.type,
          essence: b.essence || "",
        }));

      // Pass 5 sees the full causal-thread set (relation-sets.ts), same as the
      // chain_id clustering above — so supports-linked blocks (the dominant
      // evidential edge) are visible to assembly and can join a chain block,
      // not just the narrow prompted_by/based_on/supersedes spine. The Pass 5
      // prompt's connector list is aligned to match (pass5.ts).
      const p5Rels = freshRels5.filter((r: any) =>
        r.status === "active" &&
        CAUSAL_TRAVERSAL_RELS.has(r.type) &&
        (savedLabelSet5.has(freshBlockById5.get(r.source_id)?.label ?? "") ||
         savedLabelSet5.has(freshBlockById5.get(r.target_id)?.label ?? ""))
      );

      const _t5 = Date.now();
      // Pass 5 mode: "mechanical" (deterministic, no LLM) or "llm" (default). Both return
      // the same Pass5Result → identical downstream chain-block creation below.
      const p5Response = pass5Mode() === "mechanical"
        ? { result: assembleMechanicalChains(p5Blocks, p5Rels), rateLimited: false, model: "mechanical", attempts: [{ model: "mechanical", outcome: "ok" }] }
        : await callPass5LLM(provider, p5Blocks, p5Rels);
      _passWallMs.pass5 = Date.now() - _t5;
      const p5 = p5Response.result;
      _pass5Result = p5;  // capture for turn-log persistence (carries per-chain reasoning)
      _pass5Provider = { model: p5Response.model, attempts: p5Response.attempts };  // debt-4 §3: pass5 now has own provider slot

      if (p5?.chains?.length) {
        // Track all blk_ chain_ids assigned this pass for straggler sweep
        const assignedChainIds = new Map<string, string>(); // blk_chainId → chain block id

        for (const chain of p5.chains) {
          let chainBlock = db.getBlock(chain.chain_label);
          const chainContent = {
            is_a: "chain",
            unique: { arc: chain.arc, ...(chain.conclusion ? { conclusion: chain.conclusion } : {}) },
            concepts: [],
          };
          if (!chainBlock) {
            chainBlock = db.createBlock({
              label: chain.chain_label,
              type: "chain",
              status: "active",
              essence: chain.chain_essence,
              content: chainContent,
              ttl: "permanent",
              source: "Auto-Reflect",
              created_by: geminiCreatedBy,
            });
            // Compute quality score — createBlock always initializes to 0
            if (chainBlock) {
              let qScore = 0;
              if (chain.chain_essence?.trim()) qScore++;
              if (chainContent.is_a) qScore++;
              const uFields = Object.values(chainContent.unique).filter(v => v && String(v).trim());
              if (uFields.length >= 2) qScore++;
              db.updateBlock(chainBlock.id, { quality_score: Math.min(qScore, 5) });
            }
          } else {
            db.updateBlock(chainBlock.id, { essence: chain.chain_essence, content: chainContent });
          }

          if (chainBlock) {
            for (const memberLabel of chain.members) {
              const member = freshBlocks5.find((b: any) => b.label === memberLabel);
              if (member) {
                // chain_id column: backward-compat write. Single-attribution.
                // When Pass 5 emits overlapping chains, the LAST chain processed
                // wins this column (UI Kahn toposort, derive.ts, straggler sweep
                // still consume it). Pre-debt-4 this was the ONLY membership
                // record and overlapping arcs lost members silently (S1.3).
                db.updateBlock(member.id, { chain_id: chainBlock.id });
                // member_of relation: many-to-many. Preserves ALL memberships
                // across overlapping chains. Idempotent — createRelation
                // returns the existing row on duplicate insert. Per debt-4 §2.3.
                // The chain block's `members[]` field carries the CANONICAL
                // ORDERED narrative; this relation is the unordered fact.
                db.createRelation({
                  source_id: member.id,
                  target_id: chainBlock.id,
                  type: "member_of",
                  created_by: geminiCreatedBy,
                });
                assignedChainIds.set(member.id, chainBlock.id);
              }
            }

            const projectLabel = chain.chain_label.split("_")[0];
            const projectBlock = freshBlocks5.find((b: any) => b.label === projectLabel && b.type === "project");
            if (projectBlock && !chainBlock.project_id) {
              db.updateBlock(chainBlock.id, { project_id: projectBlock.id });
            }
            console.log(`Auto-Reflect Pass 5: chain "${chain.chain_label}" assembled (${chain.members.length} members)`);
          }
        }

        // Straggler sweep — Pass 5 LLM may omit connected blocks from members[].
        // Any freshly-saved block still holding a UUID chain_id (not "blk_" prefixed)
        // that has a causal relation to a confirmed chain member gets patched in.
        const freshRels5Final = db.getAllRelations(false).filter((r: any) => r.status === "active");
        const CAUSAL_TYPES = CAUSAL_TRAVERSAL_RELS; // MATCH the Pass-5 chain-clustering set (L689) — was a hardcoded subset that had drifted
        for (const b of freshBlocks5) {
          if (!savedLabelSet5.has(b.label)) continue;
          if (!b.chain_id || String(b.chain_id).startsWith("blk_")) continue; // already patched or no chain
          // This block has a UUID chain_id — check if any causal relation connects it to a patched member
          const connectedChainId = (() => {
            for (const rel of freshRels5Final) {
              if (!CAUSAL_TYPES.has(rel.type)) continue;
              if (rel.source_id !== b.id && rel.target_id !== b.id) continue;
              const otherId = rel.source_id === b.id ? rel.target_id : rel.source_id;
              if (assignedChainIds.has(otherId)) return assignedChainIds.get(otherId)!;
            }
            return null;
          })();
          if (connectedChainId) {
            // Dual-write: chain_id column (backward-compat) + member_of
            // relation (many-to-many). Per debt-4 §2.3. Same idempotency as
            // the main Pass 5 loop — createRelation dedups by (source,target,type).
            db.updateBlock(b.id, { chain_id: connectedChainId });
            db.createRelation({
              source_id: b.id,
              target_id: connectedChainId,
              type: "member_of",
              created_by: geminiCreatedBy,
            });
            console.log(`Auto-Reflect Pass 5: straggler "${b.label}" swept into chain ${connectedChainId}`);
          }
        }

      }

      // UUID cleanup — any new block still holding a UUID chain_id after the straggler
      // sweep was never canonicalized by Pass 5 (no committed conclusion in its cluster).
      // Clear it: the block is standalone. A UUID chain_id pointing to nothing is worse
      // than no chain_id.
      // NOTE: freshBlocks5 was loaded before Pass 5 ran, so b.chain_id may be stale.
      // Re-read from DB to get the current value before deciding to clear.
      for (const b of freshBlocks5) {
        if (!savedLabelSet5.has(b.label)) continue;
        const current = db.getBlock(b.id);
        if (!current?.chain_id || String(current.chain_id).startsWith("blk_")) continue;
        db.updateBlock(b.id, { chain_id: null });
      }
    }

    // flow_role: NO LONGER SET BY THE PIPELINE (removed 2026-05-18, commits c2412a6 + a92c44f).
    // Pass 2/3/5 no longer write it; deriveFlowRole() + applyFlowRoleOverrides() were deleted.
    // Pipeline-generated blocks have flow_role = null. Still written by:
    //   - tools/derive.ts (workspace_derive): outcome on derived, cause on inputs
    //   - tools/core.ts   (workspace_remember): agent-supplied value
    // UI computes chain display order from prompted_by edges via Kahn's toposort.

    // Persist session state
    {
      let stateBlock = db.getBlock(stateLabel);
      if (!stateBlock) {
        stateBlock = db.createBlock({
          label: stateLabel, type: "process", status: "active",
          essence: `Session state${agentId ? ` for agent ${agentId.slice(0, 8)}` : ""}`,
          content: {}, ttl: "permanent", source: "Auto-Reflect",
          created_by: agentId || undefined,
        });
        if (stateBlock) stampQualityScore(db, stateBlock, []);  // Bug 1 fix
      }
      if (stateBlock) {
        let sc: Record<string, unknown> = {};
        try { sc = JSON.parse(stateBlock.content as string); } catch { /* */ }

        if (_pendingRecentSaves.length > 0) {
          const existing: any[] = (sc.gemini_recent_saves as any[]) || [];
          sc.gemini_recent_saves = [..._pendingRecentSaves, ...existing].slice(0, 8);
        }

        sc.gemini_last_review = {
          thinking: geminiThinking || "",
          output: analysis,
          saved: result.saved,
          skipped: result.skipped,
          skip_reasons: analysis?.skip_reasons || [],
          ts: new Date().toISOString(),
        };

        const resolvedRefs = pass2.classified
          .filter((item) => item.resolved_ref)
          .map((item) => ({ reference: item.text.slice(0, 60), resolved_to: item.resolved_ref! }));
        sc.prev_turn_context = {
          active_blocks: knownRoots.map((r) => r.label),
          entity_map: resolvedRefs,
          in_flight: "",
        };

        sc.total_reflect_sessions = ((sc.total_reflect_sessions as number) || 0) + 1;

        db.updateBlock(stateLabel, { content: JSON.stringify(sc) });
      }
    }

    // ── Per-turn debug log ──
    writeTurnLog({
      turn: _turnCounter,
      ts: new Date().toISOString(),
      // Per-pass provider trail: which model actually produced each pass + the attempt
      // sequence (primary→fallback escalation on truncation/429). This is what makes the
      // run-to-run non-determinism visible — without it, a slow divergent run is unattributable.
      providers: {
        pass0: _pass0Provider,
        pass1: _pass1Provider,
        pass_judge: _passJudgeProvider,
        pass2: _pass2Provider,
        pass3: _pass3Provider,
        pass4: _pass4Provider,
        pass5: _pass5Provider,
      },
      pass0: {
        scene_card_text: _sceneCard ?? null,
        raw: _pass0Raw,
      },
      pass1: pass1 ? {
        thinking: _pass1Thinking || undefined,
        item_count: pass1.items.length,
        items: pass1.items.map(i => ({
          id: i.id,
          provisional_type: i.provisional_type,
          source: i.source,
          text: i.text,
          excerpt: i.excerpt?.slice(0, 120),
          extends_id: i.extends_id,
          extraction_reasoning: i.extraction_reasoning,
        })),
      } : null,
      // JUDGE pass audit trail — present only when NODEDEX_WORTH_JUDGE_ENABLED=1 fired this turn.
      // dropped[] lets us content-verify each drop offline (item_id + reason_category + optional notes).
      // anchor_overrides[] records ids the judge wanted to drop but were saved because a kept item
      // extends them (the asymmetric-cost ref-cleanup rule).
      pass_judge: _passJudgeProvider ? {
        kept_count: _passJudgeKeptCount,
        dropped_count: _passJudgeDropped.length,
        dropped: _passJudgeDropped,
        anchor_overrides: _passJudgeAnchorOverrides,
      } : undefined,
      pass2: pass2 ? {
        thinking: _pass2Thinking || undefined,
        context: _pass2Context || undefined,
        item_count: pass2.classified.length,
        skipped: pass2.skipped?.length ? pass2.skipped : undefined,
        items: pass2.classified.map(i => ({
          id: i.id,
          type: i.type,
          text: i.text,
          unique: i.unique,
          triggered_by_items: i.triggered_by_items,
          based_on_items: i.based_on_items,
          extends_item: i.extends_item,
          supersedes_ref: i.supersedes_ref,
          review_reason: i.review_reason,
          classification_reasoning: i.classification_reasoning,
          // v2 COMPREHEND reasoning (2026-06-12): the conversion carries these on the
          // items, but this WHITELIST is what reaches the turn-log — omitting them
          // here silently re-lost the reasoning a second time (caught live: the
          // first fix updated the conversion, verified by unit test, and the log
          // still showed nothing — the writer was the second strip point).
          keep_reason: i.keep_reason,
          type_reasoning: i.type_reasoning,
          // Per-relation semantic wiring + its reasoning (Pass 2c, commit 450d631).
          // Persisted here because the graph relations table has no `reason` column —
          // the turn log is the only readable home for this debug instrumentation.
          relations: i.relations,
          note: i.note,
        })),
      } : null,
      pass3: analysis ? {
        thinking: geminiThinking || undefined,
        project_creates: analysis.project_creates || [],
        new_blocks: (analysis.new_blocks || []).map((b: any) => ({
          label: typeof b.label === "object"
            ? [b.label.project, b.label.subgroup, b.label.type, b.label.concept].filter(Boolean).join("_")
            : b.label,
          is_a: b.is_a,
          essence: b.essence,
          unique: b.unique,
          triggered_by: b.triggered_by,
          novelty_reason: b.novelty_reason,
        })),
        skip_reasons: analysis.skip_reasons || [],
        updates: (analysis.updates || []).map((u: any) => ({ block_id: u.block_id, reason: u.reason })),
      } : null,
      pass4: (_pass4Thinking || _pass4Result) ? {
        thinking: _pass4Thinking || undefined,
        relations: _pass4Result?.relations ?? [],
      } : undefined,
      // Pass 5 chain assembly. Each chain carries its per-chain `reasoning`
      // (commit 450d631: WHY-these-members + WHY-this-conclusion). Chain BLOCKS
      // store only arc/conclusion/essence, so the turn log is the only readable
      // home for the reasoning — the debug payoff the deep test relies on.
      pass5: _pass5Result?.chains?.length ? {
        chains: _pass5Result.chains,
      } : undefined,
      pipeline_skips: pipelineSkips.length > 0 ? pipelineSkips : undefined,
      // Pass 2 split-orchestrator audit (per PASS2-SPLIT-DESIGN.md §7).
      // Surfaces: 2a/2b/2c throughput, seam α verdicts, re-fill salvage
      // outcomes, quarantine writes. Present only when the split path ran
      // this turn (NODEDEX_PASS2_SPLIT=1). Undefined on monolith path — the
      // turn-log reader can use presence/absence to detect which path ran.
      pass2_split_audit: _pass2SplitAudit,
      // Per-pass $$ cost telemetry. Extracted to cost-breakdown.ts for unit
      // testability — see cost-breakdown.test.ts for the three meaningful
      // states (ran:false / ran:true+priced / ran:true+null) verified.
      // Per PASS2-SPLIT-DESIGN.md §7 + debt-4 §3 + S1.1 (checkpoint NULL fix).
      cost_breakdown: buildCostBreakdown(
        {
          pass0: _pass0Provider,
          pass1: _pass1Provider,
          pass_judge: _passJudgeProvider,
          pass2: _pass2Provider,
          pass3: _pass3Provider,
          pass4: _pass4Provider,
          pass5: _pass5Provider,
          // Stage C ran upstream in arc-pipeline.ts; its provider trail is
          // pinned on the checkpoint (slice-1.2 design contract). When Stage C
          // gracefully degraded (LLM returned null), arcEntityResolution.model
          // stays undefined → ran:false here, matching the pass5 pattern.
          // Followup #2 from project-slice1-verified-2026-05-31 (cost slot).
          pass_c_resolve: checkpoint?.arcEntityResolution?.model
            ? { model: checkpoint.arcEntityResolution.model, attempts: checkpoint.arcEntityResolution.attempts }
            : undefined,
        },
        reflectTokenStats,
      ),
      // debt-4 Stage A — per-pass WALL TIME. Covers what cost_breakdown's $$
      // doesn't: where TIME goes. Thinking-budget-heavy passes (Pass 3 at
      // 4096, Pass 2c at dynamic 1024-8192) dominate time while output tokens
      // dominate cost — the two metrics correlate but aren't identical.
      // Populated only for passes that actually ran this turn (omitted on
      // checkpoint-resume non-contributions, consistent with cost_breakdown's
      // ran:false semantics).
      // v2 front-half stage timings (COMPREHEND / judge / 2b fill / justify /
      // crosslink / integrate) arrive via the checkpoint — the front-half runs
      // before this function. Merged here so ONE field answers "where did the
      // wall time go" for both halves (2026-06-12: the front-half was the
      // unmeasured majority of arc wall time).
      pass_wall_ms: checkpoint?.v2WallMs ? { ...checkpoint.v2WallMs, ..._passWallMs } : _passWallMs,
      // v2 front-half per-stage COST (USD), the cost twin of the wall timings —
      // closes the "front-half spend invisible in cost_breakdown" gap. Attributed
      // from the usage ledger over each stage's window (v2-integrate.ts). Only
      // present on v2 runs; undefined on v1/checkpoint-less turns.
      v2_front_cost_usd: checkpoint?.v2FrontCostUsd,
      // debt-4 Stage A — embedding telemetry. ~100+ sequential embedding API
      // calls per moderate turn was a HIDDEN time tax (~15-20% of per-turn
      // wall time) invisible to cost_breakdown. Now surfaced. Per-turn DELTAS
      // (calls/ms/chars accumulated globally; we subtract the start snapshot).
      // Stage B (embedding batching) will use this as the baseline to prove
      // its saving against.
      embedding_stats: {
        calls:       embeddingStats.calls       - _embStart.calls,
        ms_total:    embeddingStats.ms_total    - _embStart.ms_total,
        input_chars: embeddingStats.input_chars - _embStart.input_chars,
      },
      result: {
        saved: result.saved,
        saved_labels: result.saved_labels,
        skipped: result.skipped,
        updated: result.updated,
      },
    });

    return result;
  } catch (e) {
    console.error("Auto-Reflect: pipeline error", e);
    return empty;
  }
}
