// ═══════════════════════════════════════════════════════════════════════════════
// v2 SELECTOR — the worth-gate (Fix 1, 2026-06-07)
//
// First principles: forming memory is comprehension + SELECTION, two opposing stances
// (capture vs discard) that can't be one breath — so they're two LLMs. v2's COMPREHEND
// is the comprehender (high recall); this is the SELECTOR (precision). Without it,
// COMPREHEND keeps everything it forms (dogfood: 242 blocks from a 19KB doc, all kept).
//
// Placement: AFTER COMPREHEND-stitch + convert, BEFORE Pass 2b fill — so a dropped
// candidate never pays its per-block downstream cost (2b fill, naming, relations).
//
// Reuse: v1's PASS JUDGE (pass_judge.ts) IS the discard-biased selector we want — the
// path-specificity test, default-KEEP-on-uncertain (recall guard), the reason_category
// enum. We feed it the v2 candidates and apply the verdicts with a v2-aware override.
//
// Default-OFF: NODEDEX_V2_JUDGE.
// ═══════════════════════════════════════════════════════════════════════════════

import type { LLMProvider } from "../../engine/ai-provider.js";
import type { Pass1Item, Pass2Item } from "./types.js";
import { callPassJudgeLLM, type PassJudgeResult } from "./pass_judge.js";

export function v2JudgeEnabled(): boolean {
  // DEFAULT ON since 2026-06-12 (part of the validated v2 stack). =0 opts out.
  return process.env.NODEDEX_V2_JUDGE !== "0";
}

/** Context-aware judge (default OFF, NODEDEX_V2_JUDGE_CONTEXT): show the SELECTOR each
 *  block's structural ROLE (what depends on it / what it builds on) so it judges worth in
 *  context, not by the sentence alone — the proactive complement to the mechanical rescue
 *  below. Best paired with cross-link-first (so the role includes cross-group deps);
 *  degrades to within-group roles when cross-link runs after the judge. */
export function v2JudgeContextEnabled(): boolean {
  return process.env.NODEDEX_V2_JUDGE_CONTEXT === "1";
}

/** Strong causal dependencies: a KEPT item with one of these pointing at a DROPPED item
 *  would be orphaned (a decision losing its `based_on` evidence = the islanding failure).
 *  These get RESCUED. (Weak `relations[]` — supports/related_to/affects — are NOT rescued;
 *  their dangling targets are just cleaned.) Only within-batch item-ids match dropIds;
 *  external labels (supersedes_ref/resolved_ref can be labels) simply never match. */
function strongRefs(it: Pass2Item): string[] {
  const out: string[] = [];
  if (Array.isArray(it.based_on_items)) out.push(...it.based_on_items);
  if (Array.isArray(it.triggered_by_items)) out.push(...it.triggered_by_items);
  if (it.extends_item) out.push(it.extends_item);
  if (it.supersedes_ref) out.push(it.supersedes_ref);
  if (it.resolved_ref) out.push(it.resolved_ref);
  return out;
}

/** Each item's structural ROLE for the context-aware judge: what DEPENDS ON it (incoming
 *  edges — the load-bearing signal) and what it BUILDS ON (outgoing), summarized by the
 *  NEIGHBOUR blocks' TYPES (ids are noise to the judge). Built over the WHOLE item set, so
 *  cross-group roles appear when cross-link ran first; degrades to within-group otherwise.
 *  Isolated blocks get no entry (judged on text alone). Pure / testable. */
export function buildRoleContext(items: Pass2Item[]): Record<string, string> {
  const typeOf = new Map(items.map((it) => [it.id, it.type]));
  const outRefs = (it: Pass2Item): string[] => {
    const o = strongRefs(it).slice();
    if (Array.isArray(it.relations)) for (const r of it.relations) if (r?.target) o.push(r.target);
    return o.filter((id) => typeOf.has(id)); // only in-set refs (external labels never match)
  };
  const incoming = new Map<string, string[]>(); // id → types of blocks that point AT it
  for (const it of items) {
    for (const ref of outRefs(it)) {
      const arr = incoming.get(ref) ?? [];
      arr.push(it.type);
      incoming.set(ref, arr);
    }
  }
  const summarize = (types: string[]): string => {
    const counts = new Map<string, number>();
    for (const t of types) counts.set(t, (counts.get(t) ?? 0) + 1);
    return [...counts.entries()].map(([t, n]) => (n > 1 ? `${t}×${n}` : t)).join(", ");
  };
  const out: Record<string, string> = {};
  for (const it of items) {
    const inc = incoming.get(it.id) ?? [];
    const outg = outRefs(it).map((id) => typeOf.get(id)!);
    const parts: string[] = [];
    if (inc.length) parts.push(`needed-by ${summarize(inc)}`);
    if (outg.length) parts.push(`builds-on ${summarize(outg)}`);
    if (parts.length) out[it.id] = parts.join("; ");
  }
  return out;
}

/** Apply JUDGE verdicts to v2 candidates. DROP the low-worth; RESCUE any dropped item a
 *  KEPT item causally depends on (never orphan a kept decision's evidence); then CLEAN
 *  any remaining refs to still-dropped items so no edge dangles. judge=null → keep all
 *  (a failed selector must NEVER drop residue — precision is an improvement, not a gate).
 *  Mutates kept items' ref arrays in place (cleaning). Pure w.r.t. the input list otherwise. */
export function applyV2JudgeVerdicts(
  items: Pass2Item[],
  judge: PassJudgeResult | null,
): { kept: Pass2Item[]; droppedCount: number; rescued: number } {
  if (!judge) return { kept: items, droppedCount: 0, rescued: 0 };

  const allIds = new Set(items.map((i) => i.id));
  const dropIds = new Set(
    judge.verdicts.filter((v) => v.verdict === "DROP" && allIds.has(v.item_id)).map((v) => v.item_id),
  );

  // Anchor-override to fixpoint: rescue strong-causal deps of kept items.
  let rescued = 0, changed = true;
  while (changed) {
    changed = false;
    for (const it of items) {
      if (dropIds.has(it.id)) continue;        // a dropped item's deps don't rescue
      for (const ref of strongRefs(it)) {
        if (dropIds.has(ref)) { dropIds.delete(ref); rescued++; changed = true; }
      }
    }
  }

  const kept = items.filter((it) => !dropIds.has(it.id));

  // Clean refs to still-dropped items so nothing dangles downstream.
  for (const it of kept) {
    if (Array.isArray(it.based_on_items)) it.based_on_items = it.based_on_items.filter((r) => !dropIds.has(r));
    if (Array.isArray(it.triggered_by_items)) it.triggered_by_items = it.triggered_by_items.filter((r) => !dropIds.has(r));
    if (it.extends_item && dropIds.has(it.extends_item)) delete it.extends_item;
    if (it.supersedes_ref && dropIds.has(it.supersedes_ref)) delete it.supersedes_ref;
    if (it.resolved_ref && dropIds.has(it.resolved_ref)) delete it.resolved_ref;
    if (Array.isArray(it.relations)) it.relations = it.relations.filter((r) => !dropIds.has(r.target));
  }

  return { kept, droppedCount: dropIds.size, rescued };
}

/** Run the SELECTOR PER GROUP, all groups in PARALLEL. Judging per group is how v1's
 *  judge actually runs (per turn — never hundreds at once) and how PRODUCE already runs
 *  (per group): it keeps each call's VERDICT output bounded so the judge never truncates
 *  on a big arc (the one-shot-over-all-314 version did). The path-specificity test is
 *  per-item-independent, so splitting by group changes no verdict — only the call size.
 *
 *  Each group's items are judged with the transcript as shared session context. A group
 *  whose judge call FAILS contributes no verdicts → its items default to KEEP (recall
 *  guard — a failed selector never drops residue). Verdicts are merged and applied once
 *  (so anchor-override / dangling-clean see the whole item set). No-op (keep all) for <2.
 */
export async function runV2Judge(
  provider: LLMProvider,
  items: Pass2Item[],
  transcript: string,
  groupByItemId?: Record<string, string>,
): Promise<{ kept: Pass2Item[]; ran: boolean; droppedCount: number; rescued: number }> {
  if (items.length < 2) return { kept: items, ran: false, droppedCount: 0, rescued: 0 };

  // Bucket candidates by group (id is `{group_id}::{local_id}`; fall back to that prefix
  // when no map is given). The group is the v2-native small unit for the judge.
  const groupOf = (it: Pass2Item) => groupByItemId?.[it.id] ?? it.id.split("::")[0] ?? "_";
  const byGroup = new Map<string, Pass2Item[]>();
  for (const it of items) {
    const g = groupOf(it);
    let bucket = byGroup.get(g);
    if (!bucket) { bucket = []; byGroup.set(g, bucket); }
    bucket.push(it);
  }

  // Judge every group AT ONCE (parallel). Each call judges only its group's items (small,
  // bounded output) with the transcript as shared context. The v1 judge reads id /
  // provisional_type / text / excerpt only.
  const groups = [...byGroup.values()];
  // Context-aware judge (default OFF): each item's role is computed over ALL items (so a
  // cross-group dependency shows when cross-link ran first), then passed to every group's
  // judge call. Empty map when off → callPassJudgeLLM is byte-identical to before.
  const roleById = v2JudgeContextEnabled() ? buildRoleContext(items) : {};
  if (v2JudgeContextEnabled()) {
    console.log(`Auto-Reflect v2 SELECTOR: context-aware — roles for ${Object.keys(roleById).length}/${items.length} block(s)`);
  }
  const results = await Promise.all(groups.map(async (groupItems) => {
    const judgeItems = groupItems.map((it) => ({
      id: it.id, provisional_type: it.type, text: it.text, excerpt: it.excerpt,
    })) as unknown as Pass1Item[];
    const r = await callPassJudgeLLM(provider, judgeItems, undefined, "", transcript, 1024, "", roleById);
    return r.result; // PassJudgeResult | null (null → this group's items default to KEEP)
  }));

  // Merge verdicts from all groups; failed groups contribute none. anyRan=false → judge
  // fully failed → applyV2JudgeVerdicts(null) keeps all.
  const anyRan = results.some((r) => !!r);
  const merged: PassJudgeResult | null = anyRan ? { verdicts: results.flatMap((r) => r?.verdicts ?? []) } : null;
  const failedGroups = results.filter((r) => !r).length;

  const { kept, droppedCount, rescued } = applyV2JudgeVerdicts(items, merged);
  console.log(`Auto-Reflect v2 SELECTOR: ${items.length} → ${kept.length} kept (${droppedCount} dropped, ${rescued} rescued) over ${groups.length} group(s) in parallel${failedGroups ? ` [${failedGroups} group-judge(s) failed → those kept]` : ""}`);
  return { kept, ran: anyRan, droppedCount, rescued };
}
