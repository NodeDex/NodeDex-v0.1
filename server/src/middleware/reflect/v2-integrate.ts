// ═══════════════════════════════════════════════════════════════════════════════
// PIPELINE v2 (TRANSFORM) — INTEGRATE half (graph-AWARE): root-recognition wiring
// ═══════════════════════════════════════════════════════════════════════════════
//
// Design: docs/PIPELINE-TRANSFORM-DESIGN.md §15.4 (the INTEGRATE / LLM-2 contract).
//
// COMPREHEND (comprehend.ts) is GRAPH-BLIND by design — it reads ONLY the
// transcript. This module is the GRAPH-AWARE counterpart: it reconciles the v2
// fragment against the EXISTING graph. STEP 1 (this file) wires the already-built
// RECOGNIZER (recognize-root.ts) into the v2 path so a new cluster ATTACHES to an
// existing project root instead of forking a parallel root every session (the
// compounding property the whole recognition layer exists to protect).
//
// WHY THIS LIVES HERE, NOT IN pipeline.ts:
//   The live recognizer block (pipeline.ts:~1406) gates on
//   `checkpoint.arcEntityResolution` — a field the v2 checkpoint
//   (comprehendResultToCheckpoint → resumeFrom:"pass3") NEVER sets, so on the v2
//   path the recognizer is inert. But the recognizer CALL only needs
//   (items + knownRoots + provider); it does NOT read arcEntityResolution's
//   content (that field is purely the arc-mode gate). So v2 runs the SAME
//   recognizer here, in its own caller, BEFORE building the checkpoint. Zero edits
//   to the live pipeline; 100% reuse of recognize-root.ts. (v2 is a CALLER of
//   runAutoReflect, not an edit to it — the established v2 invariant.)
//
// FLAG: gated on recognizerEnabled() — DEFAULT ON since 2026-06-12
//   (NODEDEX_RECOGNIZER_ENABLED=0 opts out); the SAME switch the live path uses, so
//   "recognizer on/off" is ONE flag everywhere. When off (or when the graph has no
//   roots yet) this is a pure passthrough: no DB read beyond the root scan, no LLM,
//   items returned unchanged. (Runs in BOTH per-turn and arc v2 — it's in the front-half.)
//
// NEXT inhabitant of this module: the cross-group / cross-session LINKER (the
// islanding fix, design §15.4) — it joins here, also graph-aware, also a v2 caller.

import type { WorkspaceDB } from "../../store/database.js";
import { intFromEnv } from "./config.js";
import type { LLMProvider } from "../../engine/ai-provider.js";
import type { Pass2Item, Pass1Item, PipelineCheckpoint } from "./types.js";
import {
  recognizeRootsForArc,
  applyRootRemap,
  recognizerEnabled,
  type KnownRoot,
  type RecognizeRootsResult,
} from "./recognize-root.js";
import {
  callComprehendLLM,
  comprehendResultToPass2Items,
  type ComprehendResult,
  type ComprehendValidation,
} from "./comprehend.js";
import { pergroupEnabled, runComprehendPerGroup } from "./comprehend-pergroup.js";
import { runCrossGroupLink, type CrossGroupLinkResult } from "./cross-group-link.js";
import { runJustifyConclusions, type JustifyResult } from "./justify-decisions.js";
import { runV2Judge, v2JudgeEnabled } from "./v2-judge.js";
import { callPass2bLLM, callPass2bBatchedFill, v2FillBatchEnabled } from "./pass2b.js";
import { extractPrimaryValueFromUnique } from "./dedup-by-source-and-value.js";
import { getSpendBetween } from "../../engine/providers/usage-ledger.js";

/** Existing project ROOTS as recognizer fuel: {label, essence}. essence is the
 *  root's surface description (domain + owner), maintained by the describer —
 *  the recognizer judges the new cluster against THIS, not the label string. */
export function loadKnownRoots(db: WorkspaceDB): KnownRoot[] {
  return db
    .getAllBlocks()
    .filter((b) => b.type === "project")
    .map((b) => ({ label: b.label, essence: b.essence || "" }));
}

export interface IntegrateV2RootsResult {
  /** items with .project remapped to an existing root label on a confident attach;
   *  otherwise the input items unchanged. */
  items: Pass2Item[];
  /** true ⇔ the recognizer actually ran (flag ON AND >=1 existing root to match). */
  ran: boolean;
  /** the recognizer's batch outcome (candidates/attached/llm_calls), or null when skipped. */
  recognition: RecognizeRootsResult | null;
  /** number of items whose .project was rewritten to an existing root. */
  rewritten: number;
}

/**
 * v2 INTEGRATE — STEP 1: root recognition.
 *
 * For each NEW-root candidate cluster in the v2 fragment (an item.project that is
 * not already an existing root), ask the recognizer "does this belong to an
 * EXISTING root — same domain AND same owner?" On a confident attach, rewrite the
 * cluster's items' .project to that root's EXACT label. Pass 3 (downstream) then
 * finds it in KNOWN PROJECT ROOTS and attaches — no fork. Anything short of a
 * confident same-owner fit keeps the new root (a fork is the safe failure; the
 * post-hoc AUDIT-heal pass surfaces fork-pairs for the agent/user).
 *
 * Reuses the validated recognizer wholesale: recognizeRootsForArc (LLM judgment +
 * the 5 guards + bias-to-fork) and applyRootRemap (pure remap). This function is
 * the thin v2-side glue (load roots → recognize → apply). Default OFF →
 * passthrough.
 */
export async function integrateV2Roots(
  db: WorkspaceDB,
  provider: LLMProvider,
  items: Pass2Item[],
): Promise<IntegrateV2RootsResult> {
  if (!recognizerEnabled()) {
    return { items, ran: false, recognition: null, rewritten: 0 };
  }
  const knownRoots = loadKnownRoots(db);
  if (knownRoots.length === 0) {
    // No roots to attach to (e.g. a brand-new graph) → nothing to recognize.
    return { items, ran: false, recognition: null, rewritten: 0 };
  }
  const recognition = await recognizeRootsForArc({ provider, items, knownRoots });
  const { items: remapped, rewritten } = applyRootRemap(items, recognition.remap);
  return { items: remapped, ran: true, recognition, rewritten };
}

// ═══════════════════════════════════════════════════════════════════════════════
// v2 FRONT-HALF ORCHESTRATOR — the single reusable entry (harness + production)
// ═══════════════════════════════════════════════════════════════════════════════
//
// Consolidates the COMPREHEND → fill → integrate → checkpoint sequence that was
// duplicated inline across scripts/v2-{roundtrip,fill-test,e2e}.mjs. The caller
// (a harness OR the live arc path) passes the resulting checkpoint to
// runAutoReflect, which runs the EXISTING Pass 3/4/5. The ONLY new LLM call is
// COMPREHEND; fill (Pass 2b) + the recognizer reuse existing calls.

export interface V2FrontHalfResult {
  /** resumeFrom:pass3 checkpoint, or NULL → the caller must fall back to the v1
   *  path (COMPREHEND failed, SEAM 1 invalid, or no residue worth saving). */
  checkpoint: PipelineCheckpoint | null;
  reason?: "comprehend_failed" | "seam1_invalid" | "empty" | "insufficient_credit";
  groups: number;
  blocks: number;
  filled: number;
  recognizer: { ran: boolean; attached: number; rewritten: number };
  crossLinks: number;   // cross-thread links added (0 when off / <2 threads)
  selector?: { ran: boolean; dropped: number; rescued: number };  // worth-gate (Fix 1; absent/0s when off)
  merged?: number;      // cross-group dups collapsed before selector (0 when off)
  justify?: JustifyResult;  // grounded-conclusion→based_on repair (default-ON NODEDEX_V2_JUSTIFY)
}

/**
 * Run the v2 TRANSFORM front-half over a raw arc transcript:
 *   COMPREHEND → SEAM 1 → convert → Pass 2b unique{}-fill (parallel) →
 *   INTEGRATE (recognizer, default-OFF passthrough) → resumeFrom:pass3 checkpoint.
 *
 * Graph-aware only via the recognizer (COMPREHEND itself is graph-blind — it reads
 * the transcript only). Returns checkpoint=null on any path where v2 should not
 * produce a graph, so the caller can degrade to v1 (mirrors the arc path's
 * graceful-degrade contract). Never throws on a bad fragment.
 */
export function mergeCrossGroupDupsEnabled(): boolean {
  // DEFAULT ON since 2026-06-12 (part of the validated v2 stack). =0 opts out.
  return process.env.NODEDEX_V2_MERGE_DUPS !== "0";
}

/** Run the cross-group linker BEFORE the SELECTOR instead of after JUSTIFY (default OFF,
 *  NODEDEX_V2_CROSSLINK_FIRST). Cross-link needs only id/type/text (not the filled
 *  unique{}), so it can run right after convert — giving the judge each block's
 *  cross-thread role before it decides keep/drop (its rescue then protects cross-group
 *  deps, not just within-group), and pre-computing the cross-group links so they wire
 *  across Pass-3 batches. The expensive 2b fill still runs AFTER the judge, so dropped
 *  blocks never pay it. Off → cross-link runs in its original slot, byte-identical. */
export function v2CrossLinkFirstEnabled(): boolean {
  // Default ON (promoted 2026-06-14 — validated SOUND); set =0 to opt out.
  return process.env.NODEDEX_V2_CROSSLINK_FIRST !== "0";
}

/** Transcript size (chars) up to which ONE COMPREHEND call is the default.
 *  Per-group exists ONLY to survive output-truncation on a BIG arc (the 307s
 *  truncate-retry root cause); on input that fits one call it over-splits and
 *  its N blind parallel PRODUCE calls re-extract shared claims → cross-group
 *  dups + ~3× wall time (measured 2026-06-11: 1 group=175s vs 7 groups=554s on
 *  comparable single turns). Env-tunable: NODEDEX_V2_HOLISTIC_MAX_CHARS. */
export function holisticMaxChars(): number {
  return intFromEnv("NODEDEX_V2_HOLISTIC_MAX_CHARS", 20000);
}

/** Which COMPREHEND mode for this input — the size discriminator is structural,
 *  so code decides (charter rule 3); `forced` (a caller's explicit opts.holistic)
 *  always wins. Pure / testable. */
export function chooseHolistic(transcriptLength: number, forced?: boolean): boolean {
  if (forced !== undefined) return forced;
  return transcriptLength <= holisticMaxChars();
}

/**
 * Collapse CROSS-GROUP DUPLICATES — the same residue extracted by multiple PRODUCE
 * groups (per-group PRODUCE runs each group in isolation, so a claim relevant to
 * several threads gets written once PER group → N copies of one block; the dup we
 * proved via provenance: 3 "Leaky Bucket" blocks citing the identical source line).
 *
 * Keep ONE survivor; re-point every reference (causal fields + relations[].target)
 * from the dropped copies → the survivor, and UNION the survivor's links so it stays
 * connected to all the threads its copies touched. (This is "one block, many threads"
 * — realized by links, because v2 groups are an extraction scaffold, not persisted
 * graph entities; final chains come from causal edges.)
 *
 * KEY = type + unique{} primary_value (via extractPrimaryValueFromUnique — the SAME
 * identity the block-dedup layer uses). Essence AND even the source excerpt DRIFT
 * across per-group PRODUCE calls (each phrases its own summary, "AGENT:"-prefix vs
 * not), but the primary_value — the approach / choice / limit — is STABLE, so it's
 * what actually catches the real dups (validated against the dup run: excerpt+essence
 * caught 0; primary_value catches them). Within one extraction, same type + same
 * primary_value = the same claim → safe to merge (the established identity rule).
 * MUST run AFTER 2b fill (primary_value is empty before that). Default OFF
 * (NODEDEX_V2_MERGE_DUPS).
 */
export function mergeCrossGroupDups(items: Pass2Item[]): { items: Pass2Item[]; merged: number } {
  const norm = (s?: string) => (s ?? "").toLowerCase().replace(/\s+/g, " ").trim();
  const survivorByKey = new Map<string, Pass2Item>();
  const remap = new Map<string, string>();           // dropped id → survivor id
  const kept: Pass2Item[] = [];
  for (const it of items) {
    const pv = norm(extractPrimaryValueFromUnique(it.type, it.unique ?? {}));
    const key = `${it.type}|${pv}`;
    const survivor = pv.length > 0 ? survivorByKey.get(key) : undefined; // need a real claim to merge on
    if (survivor) {
      remap.set(it.id, survivor.id);
      survivor.based_on_items.push(...it.based_on_items);
      survivor.triggered_by_items.push(...it.triggered_by_items);
      survivor.extends_item ??= it.extends_item;
      survivor.supersedes_ref ??= it.supersedes_ref;
      survivor.resolved_ref ??= it.resolved_ref;
      if (it.relations?.length) (survivor.relations ??= []).push(...it.relations);
    } else {
      if (pv.length > 0) survivorByKey.set(key, it);
      kept.push(it);
    }
  }
  if (remap.size === 0) return { items, merged: 0 };
  // Re-point every reference from a dropped copy → its survivor; drop self-refs + dedup.
  const fix = (id: string) => remap.get(id) ?? id;
  const uniqNoSelf = (arr: string[], self: string) => [...new Set(arr.map(fix))].filter((x) => x !== self);
  for (const it of kept) {
    it.based_on_items = uniqNoSelf(it.based_on_items, it.id);
    it.triggered_by_items = uniqNoSelf(it.triggered_by_items, it.id);
    if (it.extends_item) it.extends_item = fix(it.extends_item);
    if (it.supersedes_ref) it.supersedes_ref = fix(it.supersedes_ref);
    if (it.resolved_ref) it.resolved_ref = fix(it.resolved_ref);
    if (it.relations) {
      const seen = new Set<string>();
      const out: NonNullable<Pass2Item["relations"]> = [];
      for (const r of it.relations) {
        const t = fix(r.target);
        const k = r.type + "|" + t;
        if (t !== it.id && !seen.has(k)) { seen.add(k); out.push({ ...r, target: t }); }
      }
      it.relations = out;
    }
  }
  return { items: kept, merged: remap.size };
}

export async function runComprehendFrontHalf(
  db: WorkspaceDB,
  provider: LLMProvider,
  transcript: string,
  opts: { fillConcurrency?: number; holistic?: boolean } = {},
): Promise<V2FrontHalfResult> {
  const empty = (reason: V2FrontHalfResult["reason"]): V2FrontHalfResult => ({
    checkpoint: null, reason, groups: 0, blocks: 0, filled: 0,
    recognizer: { ran: false, attached: 0, rewritten: 0 }, crossLinks: 0, merged: 0,
  });

  // Stage wall-time telemetry (observability before optimization — the front-half
  // was the pipeline's unmeasured majority of wall time). Travels via the checkpoint
  // into the turn-log's pass_wall_ms.
  const wall: Record<string, number> = {};
  // Per-stage [start,end] windows → per-stage COST, attributed from the usage
  // ledger after the run (stages are sequential, so windows don't overlap and
  // every front-half LLM call falls in exactly one stage). Avoids threading
  // usage out of all six stage functions; reuses the complete ledger.
  const window: Record<string, { start: number; end: number }> = {};
  const timed = async <T>(key: string, fn: () => Promise<T>): Promise<T> => {
    const t0 = Date.now();
    try { return await fn(); } finally {
      const end = Date.now();
      wall[key] = (wall[key] ?? 0) + (end - t0);
      window[key] = { start: window[key]?.start ?? t0, end };
    }
  };

  // 1. COMPREHEND + SEAM 1 — the single holistic call, OR PER-GROUP (design §17,
  //    the structural truncate fix) when NODEDEX_COMPREHEND_PERGROUP=1. Both return
  //    the same {result, validation}: per-group SEGMENTs then PRODUCEs per group and
  //    stitches back to the identical ComprehendResult shape, so the rest of this
  //    function is unchanged.
  //    opts.holistic FORCES a mode; when the caller doesn't force one, SIZE decides
  //    (chooseHolistic): per-group exists ONLY to survive truncation on a BIG arc, so
  //    input that fits one call's budget gets the holistic call — which cannot produce
  //    the cross-group dups that N blind parallel PRODUCE calls do (they can't see each
  //    other's output). Per-group (+ the merge safety net) engages only on genuinely
  //    big input where truncation is the greater risk.
  const usePerGroup = pergroupEnabled() && !chooseHolistic(transcript.length, opts.holistic);
  const comp = await timed<{ result: ComprehendResult | null; validation: ComprehendValidation | null; creditExhausted?: boolean }>(
    "v2_comprehend",
    async () =>
      usePerGroup
        ? await runComprehendPerGroup(provider, transcript)
        : await callComprehendLLM(provider, transcript));
  // Out-of-credit is surfaced DISTINCTLY (not "comprehend_failed") so the reflect queue
  // pauses-the-spend + requeues the turn instead of counting it toward the drop cap.
  if (!comp.result) return empty(comp.creditExhausted ? "insufficient_credit" : "comprehend_failed");
  if (comp.validation && !comp.validation.valid) return empty("seam1_invalid");
  const groups = comp.result.groups ?? [];
  if (groups.length === 0) return empty("empty"); // no residue — nothing to save

  // 2. convert to Pass2Item[] (groupByItemId carries the thread membership forward
  //    for the cross-group linker).
  const { items: candidateItems, groupByItemId } = comprehendResultToPass2Items(comp.result);
  if (candidateItems.length === 0) return empty("empty");

  // 2.4 CROSS-LINK FIRST (default-OFF NODEDEX_V2_CROSSLINK_FIRST) — when on, draw the
  //     cross-group links NOW, before the SELECTOR, so the judge sees each block's
  //     cross-thread role (its rescue then protects cross-group deps, not just
  //     within-group) and Pass 3 gets the links pre-computed. runCrossGroupLink no-ops
  //     if NODEDEX_V2_CROSSLINK is off. The expensive 2b fill still runs AFTER the
  //     judge, so dropped blocks never pay it; the judge cleans links to dropped blocks.
  let earlyCrossLink: CrossGroupLinkResult | undefined;
  if (v2CrossLinkFirstEnabled()) {
    earlyCrossLink = await timed("v2_crosslink", () => runCrossGroupLink(provider, candidateItems, groupByItemId));
  }

  // 2.5 SELECTOR (Fix 1, default-OFF NODEDEX_V2_JUDGE) — the worth-gate. Drops low-worth
  //     candidates BEFORE the per-block 2b fill, so dropped ones never pay downstream cost
  //     (fill / naming / relations). Keeps a kept item's causal evidence (anchor-override);
  //     judge-fail → keep all. COMPREHEND is the comprehender (high recall); this is the
  //     SELECTOR (precision) — the selective half memory requires (design: worth-gate doc).
  const sel = v2JudgeEnabled()
    ? await timed("v2_judge", () => runV2Judge(provider, candidateItems, transcript, groupByItemId))
    : { kept: candidateItems, ran: false, droppedCount: 0, rescued: 0 };
  let items = sel.kept;
  if (items.length === 0) return empty("empty");

  // 3. Pass 2b unique{}-fill (parallel, bounded) — the fused COMPREHEND can't fill
  //    unique{} under load (the bet's limit), so this focused per-block step does.
  const provById = new Map<string, { essence?: string; prov?: string }>();
  for (const g of groups) {
    for (const b of g.blocks ?? []) {
      provById.set(`${g.group_id}::${b.local_id}`, { essence: b.essence, prov: b.provenance });
    }
  }
  const CONC = opts.fillConcurrency ?? 5;
  let fillMode = "per-item";
  await timed("v2_fill_2b", async () => {
    const fillInput = (it: Pass2Item) => {
      const p = provById.get(it.id) ?? { essence: it.text, prov: it.excerpt ?? "" };
      return { id: it.id, type: it.type, text: `${p.essence ?? it.text}\n\nSOURCE (verbatim): ${p.prov ?? ""}` };
    };
    if (v2FillBatchEnabled()) {
      // Stage B: N blocks per call instead of one each (the measured fan-out was
      // the front-half's dominant wall cost). Falls back per-item for anything
      // the batch can't account for — never loses a fill.
      const b = await callPass2bBatchedFill(provider, items.map(fillInput));
      const byId = new Map(b.results.map((r) => [r.id, r.unique]));
      for (const it of items) {
        const u = byId.get(it.id);
        if (u) it.unique = u;
      }
      fillMode = `batch:${b.llmCalls} call(s)${b.fellBackIds.length ? `, ${b.fellBackIds.length} fell back per-item` : ""}`;
    } else {
      for (let i = 0; i < items.length; i += CONC) {
        await Promise.all(items.slice(i, i + CONC).map(async (it) => {
          const r = await callPass2bLLM(provider, fillInput(it));
          if (r.result?.unique) it.unique = r.result.unique;
        }));
      }
      fillMode = `per-item conc=${CONC}`;
    }
  });
  // 3.25 MERGE cross-group dups (default-OFF NODEDEX_V2_MERGE_DUPS) — NOW that 2b has
  //      filled unique{}, collapse copies of the same residue produced by overlapping
  //      groups, keyed on the STABLE identity (type + unique{} primary_value). Re-points
  //      refs to the survivor; the cross-group linker (next) connects it to the threads
  //      its copies touched. Off → passthrough.
  let merged = 0;
  if (mergeCrossGroupDupsEnabled()) {
    const m = mergeCrossGroupDups(items);
    items = m.items;
    merged = m.merged;
  }
  const filled = items.filter((i) => i.unique && Object.keys(i.unique).length > 0).length;

  // 3.4 JUSTIFY (default-ON NODEDEX_V2_JUSTIFY) — repair grounded conclusions
  //     (decision / hypothesis / insight) that arrived with no based_on wiring
  //     (SEAM-1 warns; this consumes the warning). Runs on the POST-MERGE survivors
  //     so repaired links can't point at dropped copies. One batched call, one
  //     attempt; legitimate-empty stays unwired (the grounding may be out-of-scope
  //     this session). Without this, Pass 5 correctly assembles no chain (no causal
  //     path reaches the conclusion) and the conclusion loses its re-openable WHY
  //     (2026-06-11 React-arc finding; generalized to hypothesis/insight 2026-06-15).
  const justify: JustifyResult = await timed("v2_justify", () => runJustifyConclusions(provider, items, groupByItemId));

  // 3.5 CROSS-GROUP LINK (design §15.4; default-OFF NODEDEX_V2_CROSSLINK). Per-group
  //     PRODUCE wires only WITHIN each thread; this adds the sparse links that cross
  //     BETWEEN threads, over all blocks. Mutates items in place. No-op for <2
  //     threads / when off. Bounded output (just links) → can't run away.
  //     When cross-link-first already ran (before the judge), reuse its result; else
  //     run it here in the original slot (after justify) — byte-identical to before.
  const crossLink = earlyCrossLink ?? await timed("v2_crosslink", () => runCrossGroupLink(provider, items, groupByItemId));

  // 4. INTEGRATE (recognizer; default-OFF → passthrough). Graph-aware root match.
  const integ = await timed("v2_integrate", () => integrateV2Roots(db, provider, items));
  const finalItems = integ.items;

  // Per-stage COST attribution: sum the ledger over each stage's timing window.
  // Closes the "front-half spend invisible in cost_breakdown" gap — the breaker
  // never needed it (the ledger total is complete), but this shows WHICH stage
  // spent what, the cost twin of v2WallMs. Sits beside v2WallMs rather than in
  // cost_breakdown's pass slots (comprehend/justify/crosslink/integrate have no
  // pass slot; this is a different, v2-native decomposition).
  const v2FrontCostUsd: Record<string, number> = {};
  for (const [k, w] of Object.entries(window)) v2FrontCostUsd[k] = getSpendBetween(w.start, w.end);

  // 5. resumeFrom:pass3 checkpoint from the FINAL (filled + recognized) items.
  const pass1Items: Pass1Item[] = finalItems.map((it) => ({
    id: it.id, text: it.text, source: "comprehend",
    excerpt: it.excerpt ?? "", provisional_type: it.type,
  }));
  const checkpoint: PipelineCheckpoint = {
    resumeFrom: "pass3",
    pass0: { sceneCard: undefined, raw: undefined },
    pass1Items,
    pass2Classified: finalItems,
    v2WallMs: wall,
    v2FrontCostUsd,
  };

  const s = (k: string) => ((wall[k] ?? 0) / 1000).toFixed(1);
  const c = (k: string) => (v2FrontCostUsd[k] ?? 0).toFixed(4);
  const frontTotal = Object.values(v2FrontCostUsd).reduce((a, b) => a + b, 0);
  console.log(
    `[v2-front] wall: comprehend=${s("v2_comprehend")}s judge=${s("v2_judge")}s ` +
    `fill_2b=${s("v2_fill_2b")}s (${items.length} blocks, ${fillMode}) ` +
    `justify=${s("v2_justify")}s crosslink=${s("v2_crosslink")}s integrate=${s("v2_integrate")}s`,
  );
  console.log(
    `[v2-front] cost: $${frontTotal.toFixed(4)} total — comprehend=$${c("v2_comprehend")} ` +
    `judge=$${c("v2_judge")} fill_2b=$${c("v2_fill_2b")} justify=$${c("v2_justify")} ` +
    `crosslink=$${c("v2_crosslink")} integrate=$${c("v2_integrate")}`,
  );

  return {
    checkpoint,
    groups: groups.length,
    blocks: items.length,
    filled,
    recognizer: { ran: integ.ran, attached: integ.recognition?.attached ?? 0, rewritten: integ.rewritten },
    crossLinks: crossLink.added,
    selector: { ran: sel.ran, dropped: sel.droppedCount, rescued: sel.rescued },
    merged,
    justify,
  };
}
