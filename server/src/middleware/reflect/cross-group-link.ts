// ═══════════════════════════════════════════════════════════════════════════════
// PIPELINE v2 — CROSS-GROUP LINKER (the INTEGRATE cross-thread step; design §15.4)
// ═══════════════════════════════════════════════════════════════════════════════
//
// Per-group PRODUCE wires links only WITHIN each thread (it never sees the other
// threads' blocks). This step runs AFTER all blocks exist (post-convert) and adds
// the sparse links that cross BETWEEN threads — e.g. a decision in one cluster
// grounded in a fact established in another. One bounded LLM call over the block
// essences (output is just links → can't run away).
//
// MEANING-FIRST / GATE-5 (no new vocabulary):
//   - relation types  = the SAME 10 (COMPREHEND_LINK_RELS).
//   - fields targeted = the SAME Pass2Item causal fields, via the SHARED
//     applyLinkToPass2Item helper (comprehend.ts) — the converter and this linker
//     never drift on which field a relation lands in.
//   - block identity  = the qualified item.id ({group}::{local}); no new id scheme.
//
// SCOPE: this builds CROSS-THREAD LINKING only. Cross-thread DEDUP (the duplicate
// blocks two PRODUCE calls extract from shared transcript) is a separate concern
// served by the existing block-dedup layer (dedupBySourceAndValue / stage-audit
// block_dup), not re-implemented here.
//
// Default OFF: NODEDEX_V2_CROSSLINK=1 (only meaningful under v2). When off → pure
// passthrough (no LLM). Reuse-not-rewrite: this IS the §15.4 INTEGRATE linker, now
// concretely targeted (the roaster↔dark-roast cross-thread edges Run 10/11 missed).

import { getThinkingBudget } from "./config.js";
import { COMPREHEND_LINK_RELS, applyLinkToPass2Item, comprehendModel } from "./comprehend.js";
import type { Pass2Item } from "./types.js";
import type { LLMProvider } from "../../engine/ai-provider.js";

export function crossGroupLinkEnabled(): boolean {
  // DEFAULT ON since 2026-06-12 (part of the validated v2 stack). =0 opts out.
  return process.env.NODEDEX_V2_CROSSLINK !== "0";
}

/** Orphan-aware linking (default OFF, NODEDEX_V2_CROSSLINK_ORPHAN_AWARE): mark the blocks
 *  that have no link yet (⚠ UNLINKED) in the linker's input so it targets those gaps
 *  instead of re-deriving blindly — the recall fix for the residual islands. Empirical
 *  (could it over-link a genuinely-standalone block?), so opt-in + A/B-able. Off → the
 *  linker input is byte-identical to before. */
export function orphanAwareLinkEnabled(): boolean {
  return process.env.NODEDEX_V2_CROSSLINK_ORPHAN_AWARE === "1";
}

export interface CrossGroupLink {
  from: string;
  to: string;
  type: string;
  reasoning?: string;
}

export const CROSS_GROUP_LINK_PROMPT = `You are given knowledge blocks from ONE work session, already grouped into THREADS,
with each thread's INTERNAL links already drawn. Your only job: add the links that
cross BETWEEN threads — where a block in one thread stands in a real relationship to
a block in another. The same kinds of relationships that hold within a thread hold
across them.

Decide by reasoning about MEANING — what actually relates to what across the
threads, whether or not any connecting word is present.

Each link is {from, to, type}, where "from" holds the relationship. Use the block
ids EXACTLY as given. Choose the type whose MEANING matches:
  prompted_by · based_on · extends · supersedes · resolves · supports ·
  contradicts · related_to · derived_from · affects
Reach for the SHARPEST relation the meaning supports; related_to and affects are a
last resort. The link type MUST be exactly one of these ten.

Look especially for the connections that orphan a block otherwise — these are easy to
miss across threads, for ANY block type: a block in one thread that REPLACED
(supersedes) an earlier approach, value, or state in another, or that was TRIGGERED BY
(prompted_by) an event or failure in another — not only where one thread's block is
EVIDENCE for another's. A superseded or triggering block left unlinked is the gap to close.

Blocks the input marks ⚠ UNLINKED have NO link at all yet — they are the ones most
likely to be wrongly orphaned. Give each marked block a deliberate pass: find its
cross-thread connection (what caused it, what it depends on, what it replaced or
answers), or judge it genuinely standalone.

Add ONLY links whose two blocks are in DIFFERENT threads — do NOT re-draw links
within a thread, those are already present. Do NOT invent blocks or ids. If no
genuine cross-thread relationship exists, return an empty list.`;

const CROSS_GROUP_LINK_SCHEMA = {
  type: "object",
  properties: {
    links: {
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
  required: ["links"],
};

/** Block ids that currently have NO link at all — no outgoing causal ref AND no in-set
 *  block points at them. These are the islands the cross-group pass should target: the
 *  linker sees every block but, without this, can't tell which are already connected, so
 *  it re-derives blindly and misses a few. Considers the within-thread links already on
 *  the items (based_on/triggered_by/extends/supersedes/resolves/relations). Refs to
 *  out-of-set labels (existing-graph) count as "connected". Pure / testable. */
export function unlinkedIds(items: Pass2Item[]): Set<string> {
  const idSet = new Set(items.map((it) => it.id));
  const hasOut = new Set<string>();   // blocks with >=1 outgoing causal ref
  const isTarget = new Set<string>(); // in-set blocks something points at
  for (const it of items) {
    const refs = [
      ...(it.based_on_items ?? []),
      ...(it.triggered_by_items ?? []),
      it.extends_item,
      it.supersedes_ref,
      it.resolved_ref,
      ...((it.relations ?? []).map((r) => r?.target)),
    ];
    for (const r of refs) {
      if (!r) continue;
      hasOut.add(it.id);
      if (idSet.has(r)) isTarget.add(r);
    }
  }
  const out = new Set<string>();
  for (const it of items) if (!hasOut.has(it.id) && !isTarget.has(it.id)) out.add(it.id);
  return out;
}

/** Render the blocks grouped by thread, each as `id [type] essence`, so the model sees
 *  the cluster structure and references blocks by their exact id. Islands (no link yet)
 *  are marked ⚠ UNLINKED so the linker prioritises closing those gaps. */
export function buildCrossGroupLinkInput(
  items: Pass2Item[],
  groupByItemId: Record<string, string>,
): string {
  const islands = orphanAwareLinkEnabled() ? unlinkedIds(items) : new Set<string>();
  const byGroup = new Map<string, Pass2Item[]>();
  for (const it of items) {
    const g = groupByItemId[it.id] ?? "?";
    let arr = byGroup.get(g);
    if (!arr) { arr = []; byGroup.set(g, arr); }
    arr.push(it);
  }
  const parts: string[] = [];
  for (const [g, its] of byGroup) {
    parts.push(`[thread: ${g}]`);
    for (const it of its) {
      const mark = islands.has(it.id) ? " ⚠ UNLINKED" : "";
      parts.push(`  - ${it.id} [${it.type}]${mark} ${(it.text ?? "").replace(/\s+/g, " ").slice(0, 140)}`);
    }
  }
  const islandNote = islands.size > 0
    ? `\n\n${islands.size} block(s) are marked ⚠ UNLINKED — give each a deliberate pass (see prompt).`
    : "";
  return `THREADS (each block's within-thread links are already drawn; add ONLY links BETWEEN threads):\n\n${parts.join("\n")}${islandNote}`;
}

export interface CrossGroupLinkCallResult {
  links: CrossGroupLink[] | null;
  rateLimited: boolean;
  usage?: { input: number; thinking: number; output: number };
}

export async function callCrossGroupLinkLLM(
  provider: LLMProvider,
  items: Pass2Item[],
  groupByItemId: Record<string, string>,
  thinkingBudget = 2048,
): Promise<CrossGroupLinkCallResult> {
  const userInput = buildCrossGroupLinkInput(items, groupByItemId);
  const r = await provider.generateStructured<{ links: CrossGroupLink[] }>(
    CROSS_GROUP_LINK_PROMPT, userInput, CROSS_GROUP_LINK_SCHEMA,
    { thinkingBudget: getThinkingBudget(thinkingBudget), maxOutputTokens: 4096, modelOverride: comprehendModel() },
  );
  return { links: r.result?.links ?? null, rateLimited: r.rateLimited, usage: r.usage };
}

/**
 * Apply cross-group links onto the items' causal fields (via the shared
 * applyLinkToPass2Item). Pure-ish: MUTATES the matched items. Every guard a
 * cross-thread link must pass: both ids resolve, not a self-link, the two blocks
 * are in DIFFERENT groups (within-thread links already exist), and the type is one
 * of the ten relations. Anything failing a guard is skipped (never throws).
 */
export function applyCrossGroupLinks(
  items: Pass2Item[],
  links: CrossGroupLink[],
  groupByItemId: Record<string, string>,
): { added: number; skipped: number } {
  const byId = new Map(items.map((it) => [it.id, it]));
  let added = 0, skipped = 0;
  for (const link of links ?? []) {
    const from = byId.get(link?.from);
    if (!from || !byId.has(link?.to)) { skipped++; continue; }                 // unknown id
    if (link.from === link.to) { skipped++; continue; }                         // self-link
    if (groupByItemId[link.from] === groupByItemId[link.to]) { skipped++; continue; } // SAME thread → not cross-group
    if (!COMPREHEND_LINK_RELS.has(link.type)) { skipped++; continue; }          // unknown relation type
    applyLinkToPass2Item(from, link.type, link.to, link.reasoning);
    added++;
  }
  return { added, skipped };
}

export interface CrossGroupLinkResult {
  items: Pass2Item[];   // same array, mutated in place with cross-group links
  added: number;
  skipped: number;
  llm_calls: number;
}

/**
 * Run the cross-group linker over the converted items. Default OFF → passthrough.
 * No-op when there are <2 threads (nothing can be cross-group). One bounded LLM
 * call; never blocks the pipeline (any failure → 0 links added).
 */
export async function runCrossGroupLink(
  provider: LLMProvider,
  items: Pass2Item[],
  groupByItemId: Record<string, string>,
): Promise<CrossGroupLinkResult> {
  if (!crossGroupLinkEnabled()) return { items, added: 0, skipped: 0, llm_calls: 0 };
  const groupCount = new Set(Object.values(groupByItemId)).size;
  if (groupCount < 2 || items.length < 2) return { items, added: 0, skipped: 0, llm_calls: 0 };
  try {
    const r = await callCrossGroupLinkLLM(provider, items, groupByItemId);
    if (!r.links) return { items, added: 0, skipped: 0, llm_calls: 1 };
    const { added, skipped } = applyCrossGroupLinks(items, r.links, groupByItemId);
    console.log(`[cross-group-link] added ${added} cross-thread link(s), skipped ${skipped} — 1 LLM call`);
    return { items, added, skipped, llm_calls: 1 };
  } catch (e: any) {
    console.warn(`[cross-group-link] threw (${e?.message ?? e}) — 0 links added`);
    return { items, added: 0, skipped: 0, llm_calls: 1 };
  }
}
