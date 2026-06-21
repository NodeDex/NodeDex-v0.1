// ═══════════════════════════════════════════════════════════════════════════════
// v2 JUSTIFY — repair missing conclusion→evidence wiring (the route-back pattern)
// ═══════════════════════════════════════════════════════════════════════════════
//
// THE GAP (2026-06-11 React-arc retest): COMPREHEND's prompt demands "every
// decision needs >=1 based_on" and SEAM-1 already WARNS when one is missing
// (comprehend.ts validateComprehendResult) — but nothing consumed the warning.
// 7/7 decisions arrived with empty based_on_items → Pass 5 correctly assembled
// 0 chains (no causal path reached a committed conclusion) and the decisions
// lost their re-openable WHY. Prompt-asking is not enforcement (charter rule 4).
//
// GENERALIZED to all GROUNDED conclusions (2026-06-15): the same gap bites a
// hypothesis or insight that rests on a finding — COMPREHEND STEP 3 demands their
// based_on too. It paired with the evidence_for fix (the hypothesis observation now
// becomes its OWN block instead of folding into an evidence_for field), so the edge
// from conclusion → that observation must be enforced, not just asked for. DETECT now
// covers {decision, hypothesis, insight}; preference stays excluded (it extends
// decision — a standing lean is actionable without an evidence trail).
//
// THE FIX, each part at its competence (charter rule 3):
//   DETECT (code, pure)  — grounded-type items whose based_on_items is empty,
//                          checked on the POST-MERGE composed items.
//   REPAIR (LLM, judgment) — ONE batched call: each ungrounded conclusion + its
//                          OWN GROUP's sibling items; the model names which ids
//                          actually ground it. EMPTY IS A VALID ANSWER — the
//                          justifying evidence may be out-of-scope this session
//                          (missing-link discipline: never fabricate).
//   APPLY (code, pure)   — sanitize: only ids from the offered candidate list,
//                          no self-refs, dedup, never overwrite existing links.
//                          One attempt, no retry loop (seam-α's locked budget).
//                          Malformed result → no-op (the pass_judge lesson:
//                          a failed repairer must never make things worse).
//
// Default ON: NODEDEX_V2_JUSTIFY=0 opts out. Runs in v2-integrate after the
// cross-group MERGE (so candidates are the surviving items) and before the
// cross-group LINK / INTEGRATE.

import type { LLMProvider } from "../../engine/ai-provider.js";
import type { Pass2Item } from "./types.js";
import { getThinkingBudget } from "./config.js";

export function v2JustifyEnabled(): boolean {
  // DEFAULT ON since 2026-06-12 (part of the validated v2 stack). =0 opts out.
  return process.env.NODEDEX_V2_JUSTIFY !== "0";
}

// ─── DETECT (pure) ─────────────────────────────────────────────────────────────

/** Types that must rest on a based_on edge when they ground out of a finding.
 *  decision REQUIRES one (block-types.md). hypothesis / insight require one WHEN
 *  they rest on a finding (COMPREHEND STEP 3) — the detector flags every empty one
 *  and lets REPAIR return empty for the genuinely-self-standing ones (precision is
 *  the LLM's job, not the filter's). preference is excluded on purpose: it extends
 *  decision, and a standing lean is actionable without an evidence trail. */
export const GROUNDED_TYPES: ReadonlySet<string> = new Set(["decision", "hypothesis", "insight"]);

/** Grounded-type items with NO based_on wiring. */
export function findUngroundedConclusions(items: Pass2Item[]): Pass2Item[] {
  return items.filter(
    (it) => GROUNDED_TYPES.has(it.type) && (!Array.isArray(it.based_on_items) || it.based_on_items.length === 0),
  );
}

// ─── APPLY (pure) ──────────────────────────────────────────────────────────────

export interface JustifyVerdict {
  conclusion_id: string;
  evidence_ids: string[];
  reasoning: string;
}

/** Apply repair verdicts. Sanitizes hard: a cited id must be in the candidate
 *  set OFFERED for that conclusion (falsifiable contract — the model can only
 *  cite what it was shown), no self-refs, dedup, and existing links are never
 *  overwritten (repair fills absence; it does not re-judge presence).
 *  Mutates the matched items' based_on_items in place; returns repaired count. */
export function applyJustifications(
  items: Pass2Item[],
  verdicts: JustifyVerdict[],
  offeredCandidates: Map<string, ReadonlySet<string>>, // conclusion_id → candidate ids it was shown
): number {
  const byId = new Map(items.map((it) => [it.id, it]));
  let repaired = 0;
  for (const v of verdicts) {
    if (!v || typeof v.conclusion_id !== "string" || !Array.isArray(v.evidence_ids)) continue;
    const it = byId.get(v.conclusion_id);
    const offered = offeredCandidates.get(v.conclusion_id);
    if (!it || !offered) continue;                    // only conclusions we actually asked about
    if (Array.isArray(it.based_on_items) && it.based_on_items.length > 0) continue; // never overwrite
    const clean = [...new Set(v.evidence_ids)].filter(
      (id) => typeof id === "string" && id !== v.conclusion_id && offered.has(id),
    );
    if (clean.length === 0) continue;                  // legitimate-empty → stays unwired
    it.based_on_items = clean;
    repaired++;
  }
  return repaired;
}

// ─── REPAIR prompt (definitional, falsifiable, universal) ──────────────────────

const JUSTIFY_PROMPT = `Some CONCLUSIONS extracted from a session are missing their evidence wiring — the
link to what each one was actually reasoned from. Your job is to restore ONLY the
links that the session itself supports.

A based_on link means: the conclusion RESTS ON that block — the finding, limit,
observation, or prior conclusion that grounds it. Remove the evidence and the
conclusion loses its footing.

For each conclusion below, read its candidate blocks (the other knowledge from the
SAME thread of the session) and name the ids whose content grounds it.

RULES:
  - Cite ONLY ids from that conclusion's own candidate list.
  - Nearness is not grounding: a block from the same thread that the conclusion
    does not rest on is NOT evidence. To cite a block you must be able to state how
    the conclusion depends on it.
  - EMPTY is a correct answer: when the grounding evidence is not among the
    candidates (it may live outside this session), return an empty list. Never
    pick a "best available" block that does not actually ground the conclusion.
  - reasoning: one line per conclusion naming HOW the cited blocks ground it (or
    why the list is empty).`;

const JUSTIFY_SCHEMA = {
  type: "object",
  properties: {
    justifications: {
      type: "array",
      items: {
        type: "object",
        properties: {
          conclusion_id: { type: "string" },
          evidence_ids: { type: "array", items: { type: "string" } },
          reasoning: { type: "string" },
        },
        required: ["conclusion_id", "evidence_ids", "reasoning"],
      },
    },
  },
  required: ["justifications"],
};

/** Build the one batched user input: each ungrounded conclusion + its own group's
 *  sibling items as candidates. Returns the input text + the per-conclusion
 *  candidate sets (the falsifiable offer applyJustifications checks against). */
export function buildJustifyInput(
  ungrounded: Pass2Item[],
  items: Pass2Item[],
  groupByItemId?: Record<string, string>,
): { input: string; offered: Map<string, ReadonlySet<string>> } {
  const groupOf = (it: Pass2Item) => groupByItemId?.[it.id] ?? it.id.split("::")[0] ?? "_";
  const offered = new Map<string, ReadonlySet<string>>();
  const sections: string[] = [];
  for (const d of ungrounded) {
    const g = groupOf(d);
    const candidates = items.filter((it) => it.id !== d.id && groupOf(it) === g);
    offered.set(d.id, new Set(candidates.map((c) => c.id)));
    const candLines = candidates
      .map((c) => `    - ${c.id} [${c.type}] ${String(c.text ?? "").slice(0, 160)}`)
      .join("\n");
    sections.push(
      `CONCLUSION ${d.id} [${d.type}]: ${String(d.text ?? "").slice(0, 200)}\n` +
      `  CANDIDATES (this conclusion's thread):\n${candLines || "    (none)"}`,
    );
  }
  return { input: sections.join("\n\n"), offered };
}

// ─── Orchestrator (one batched call, one attempt) ──────────────────────────────

export interface JustifyResult {
  ran: boolean;
  ungrounded: number;
  repaired: number;
}

export async function runJustifyConclusions(
  provider: LLMProvider,
  items: Pass2Item[],
  groupByItemId?: Record<string, string>,
): Promise<JustifyResult> {
  if (!v2JustifyEnabled()) return { ran: false, ungrounded: 0, repaired: 0 };
  const ungrounded = findUngroundedConclusions(items);
  if (ungrounded.length === 0) return { ran: false, ungrounded: 0, repaired: 0 };

  const { input, offered } = buildJustifyInput(ungrounded, items, groupByItemId);
  try {
    const r = await provider.generateStructured<{ justifications: JustifyVerdict[] }>(
      JUSTIFY_PROMPT, input, JUSTIFY_SCHEMA,
      { thinkingBudget: getThinkingBudget(1024), maxOutputTokens: 4096 },
    );
    // SEAM contract: a truthy result without justifications[] is malformed → no-op
    // (a failed repairer must never make things worse).
    const verdicts = Array.isArray(r.result?.justifications) ? r.result!.justifications : [];
    const repaired = applyJustifications(items, verdicts, offered);
    console.log(`Auto-Reflect v2 JUSTIFY: ${ungrounded.length} ungrounded conclusion(s) → ${repaired} repaired`);
    return { ran: true, ungrounded: ungrounded.length, repaired };
  } catch (e: any) {
    console.warn(`Auto-Reflect v2 JUSTIFY failed (${e?.message ?? e}) — conclusions left as-is (already SEAM-1-warned)`);
    return { ran: true, ungrounded: ungrounded.length, repaired: 0 };
  }
}
