// ═══════════════════════════════════════════════════════════════════════════════
// Recognition Layer — STEP 2: THE RECOGNIZER ("Stage D for roots")
// ═══════════════════════════════════════════════════════════════════════════════
//
// Design: docs/PIPELINE-RECOGNITION-LAYER-DESIGN.md §2 (LLM-primary spine) + §3.
//
// JOB: for each NEW project-root candidate an arc would create, decide — does
// this cluster of new knowledge actually belong to an EXISTING root? One LLM
// judgment over (the new cluster's content) + (the candidate roots' DESCRIPTIONS
// + scope). Verdict: attach / new / uncertain.
//
// HOOK: runs in pipeline.ts right after applyArcEntityCanonicalNames (the seam
// where Stage C's canonical names are written onto items, BEFORE Pass 3). On a
// confident ATTACH it rewrites the cluster's items' .project to the existing
// root's EXACT label → Pass 3's root-create exact-match finds it → blocks attach,
// no fork. Default OFF (NODEDEX_RECOGNIZER_ENABLED=1), arc-mode only.
//
// THE 6 GUARDS (§2 — non-negotiable; without them this is a silent-merge risk):
//   1. judges against the root DESCRIPTION (essence), not the raw label string
//   2. SCOPE/OWNER is an explicit axis — same domain AND same owner to attach
//   3. cite EVIDENCE in reasoning (auditable, not a vibe)
//   4. bias hard to NOT-attach — anything short of a confident same-owner fit
//      keeps the new root (a FORK is the safe failure; §1). Enforced
//      deterministically in decideAction(), not left to the prompt alone.
//   5. judge against the description (members are not dumped here)
//   6. attach must NAME the shared subject-matter (shared_subject) — shared
//      MANNER (both involve the speaker reasoning/remembering/planning) names no
//      subject, so it can never justify an attach. Added 2026-06-11 after a
//      transcript test where a process-narration root became an attractor and
//      absorbed an unrelated domain. Enforced in decideAction().
//
// v1 SCOPE: ACT on ATTACH only (the value-add: stop the fork by attaching when
// confident). "new" and "uncertain" both → keep the new root (the safe fork).
// At-ingest flag-to-agent is deferred to the AUDIT-heal pass (step 4): blocks
// don't exist yet at this pre-Pass-3 seam, so a fork is created and the post-hoc
// project_dup_candidate detector surfaces the pair for the agent/user.

import type { LLMProvider } from "../../engine/ai-provider.js";
import { intFromEnv } from "./config.js";
import type { Pass2Item } from "./types.js";

// ─── Config ──────────────────────────────────────────────────────────────────

export function recognizerEnabled(): boolean {
  // DEFAULT ON since 2026-06-12 (v2's cross-session root matching — without it the
  // default engine fragments roots across sessions). =0 opts out.
  return process.env.NODEDEX_RECOGNIZER_ENABLED !== "0";
}
function maxCandidateRoots(): number {
  return intFromEnv("NODEDEX_RECOGNIZER_MAX_ROOTS", 40); // bound prompt size; scale-prefilter = TODO
}
function maxItemsInCluster(): number {
  return intFromEnv("NODEDEX_RECOGNIZER_MAX_ITEMS", 30);
}

// ─── Types ───────────────────────────────────────────────────────────────────

export interface KnownRoot {
  label: string;
  essence: string; // the surface description (domain + owner) maintained by the describer
}

export interface RecognizerVerdict {
  decision: "attach" | "new" | "uncertain";
  matched_root: string;   // existing root label when decision=attach; "" otherwise
  same_owner: boolean;    // the scope axis (guard #2)
  shared_subject: string; // guard #6 — the named subject-matter both share; "" when none nameable
  reasoning: string;      // cited evidence (guard #3)
}

/** The deterministic action after applying guard #4 (bias to NOT-attach). */
export interface RecognizerAction {
  action: "attach" | "keep";
  root?: string; // the existing root label to attach to (only when action=attach)
}

// ─── Pure decision (guard #4 enforced in code, not just the prompt) ────────────

/**
 * Map an LLM verdict → an action. ATTACH only when the model is confident
 * (decision==="attach"), names a root that ACTUALLY EXISTS, confirms same
 * owner, AND names the shared subject-matter (guard #6 — an attach must carry
 * its falsifiable evidence; an unevidenced attach is a contract violation, so
 * the safe direction is fork). Everything else → keep. Pure / testable.
 */
export function decideAction(
  verdict: RecognizerVerdict,
  knownRootLabels: ReadonlySet<string>,
): RecognizerAction {
  if (
    verdict.decision === "attach" &&
    verdict.same_owner === true &&
    typeof verdict.matched_root === "string" &&
    verdict.matched_root.length > 0 &&
    knownRootLabels.has(verdict.matched_root) &&
    typeof verdict.shared_subject === "string" &&
    verdict.shared_subject.trim().length > 0
  ) {
    return { action: "attach", root: verdict.matched_root };
  }
  return { action: "keep" };
}

/** Distinct project names among items that are NOT existing roots = the
 *  new-root candidates the recognizer should judge. Pure / testable. */
export function newRootCandidateNames(
  items: Pass2Item[],
  knownRootLabels: ReadonlySet<string>,
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const it of items) {
    const p = (it as any).project as string | undefined;
    if (!p || knownRootLabels.has(p) || seen.has(p)) continue;
    seen.add(p);
    out.push(p);
  }
  return out;
}

// ─── Prompt + schema ────────────────────────────────────────────────────────

export const RECOGNIZE_ROOT_PROMPT = `A knowledge graph is about to create a NEW project root for a cluster of new
knowledge. Decide whether that cluster actually belongs to an EXISTING project
instead — so related knowledge COMPOUNDS onto one project rather than fragmenting.

You are given:
  - NEW CLUSTER: the new knowledge (its proposed project name + member items).
  - EXISTING PROJECTS: each as a one-line DESCRIPTION (domain + owner).

Decide ONE:
  - "attach"    — the cluster clearly belongs to one EXISTING project: SAME DOMAIN
                  AND SAME OWNER. Set matched_root to that project's exact label and
                  shared_subject to the specific subject-matter they share.
  - "new"       — no existing project fits; this is genuinely a new project.
  - "uncertain" — plausibly related to an existing project but you are NOT confident
                  (e.g. similar domain but unclear/different owner, or a weak fit).

RULES (read carefully):
  - Judge on the DESCRIPTION's meaning, NOT on label string similarity. Two similar
    names can be different projects; two different names can be the same project.
  - SAME OWNER is required for "attach". Same domain but a DIFFERENT or UNKNOWN owner
    (e.g. one customer's data vs another's) is NOT the same project → "new" or "uncertain".
  - "attach" requires a NAMEABLE SHARED SUBJECT: shared_subject must name the specific
    thing both bodies of work are ABOUT. A shared MANNER is not a subject — that both
    involve someone remembering, reasoning, or planning a response names no subject,
    because every conversation involves those. If you cannot name what they are both
    about, the fit is not real → "new" or "uncertain", with shared_subject "".
  - When the fit is merely plausible, choose "uncertain", NOT "attach". A wrong attach
    silently merges two real projects (hard to undo); a fork is recoverable. Bias to caution.
  - reasoning MUST cite the specific evidence (which description, which overlapping
    content) — not "they seem related".`;

const RECOGNIZE_ROOT_SCHEMA = {
  type: "object",
  properties: {
    decision: { type: "string", enum: ["attach", "new", "uncertain"] },
    matched_root: { type: "string" },
    same_owner: { type: "boolean" },
    shared_subject: { type: "string" },
    reasoning: { type: "string" },
  },
  required: ["decision", "matched_root", "same_owner", "shared_subject", "reasoning"],
};

export function buildRecognizeInput(
  newProjectName: string,
  clusterItems: Pass2Item[],
  candidateRoots: KnownRoot[],
  itemCap: number,
  rootCap: number,
): string {
  const roots = candidateRoots.slice(0, rootCap)
    .map((r) => `  - ${r.label}: "${r.essence || "(no description)"}"`)
    .join("\n");
  const members = clusterItems.slice(0, itemCap).map((it) => {
    const t = (it as any).type ?? "?";
    const txt = ((it as any).text ?? "").toString().slice(0, 160);
    return `  - [${t}] ${txt}`;
  }).join("\n");
  return (
    `NEW CLUSTER (proposed project: ${newProjectName}):\n${members || "  (no items)"}\n\n` +
    `EXISTING PROJECTS:\n${roots || "  (none)"}`
  );
}

// ─── LLM judgment (one cluster) ───────────────────────────────────────────────

export async function recognizeClusterRoot(
  provider: LLMProvider,
  newProjectName: string,
  clusterItems: Pass2Item[],
  candidateRoots: KnownRoot[],
): Promise<{ verdict: RecognizerVerdict | null; rateLimited: boolean; usage?: { input?: number; thinking?: number; output?: number } }> {
  const userInput = buildRecognizeInput(
    newProjectName, clusterItems, candidateRoots, maxItemsInCluster(), maxCandidateRoots(),
  );
  const r = await provider.generateStructured<RecognizerVerdict>(
    RECOGNIZE_ROOT_PROMPT, userInput, RECOGNIZE_ROOT_SCHEMA, { thinkingBudget: 1024, maxOutputTokens: 1024 },
  );
  return { verdict: r.result ?? null, rateLimited: r.rateLimited, usage: r.usage };
}

// ─── Batch entry (one arc) ────────────────────────────────────────────────────

export interface RecognizeRootsResult {
  /** project-name → existing-root-label rewrites to apply to items. */
  remap: Array<{ from: string; to: string }>;
  candidates: number;
  attached: number;
  llm_calls: number;
  rate_limited: number;
  errors: number;
}

/**
 * For each new-root candidate cluster, ask the recognizer "attach to an existing
 * root?" and collect the confident-attach rewrites. Caller applies the remap to
 * item.project (then Pass 3 + root-create attach to the existing root). Does NOT
 * mutate items itself (pure-ish: returns the remap). LLM-bounded (one call per
 * new-root candidate). NO knownRoots → nothing to attach to → empty remap.
 */
export async function recognizeRootsForArc(opts: {
  provider: LLMProvider;
  items: Pass2Item[];
  knownRoots: KnownRoot[];
}): Promise<RecognizeRootsResult> {
  const result: RecognizeRootsResult = {
    remap: [], candidates: 0, attached: 0, llm_calls: 0, rate_limited: 0, errors: 0,
  };
  if (opts.knownRoots.length === 0) return result; // nothing to recognize against

  const knownLabels = new Set(opts.knownRoots.map((r) => r.label));
  const candidates = newRootCandidateNames(opts.items, knownLabels);
  result.candidates = candidates.length;

  for (const name of candidates) {
    const clusterItems = opts.items.filter((it) => (it as any).project === name);
    try {
      result.llm_calls += 1;
      const { verdict, rateLimited } = await recognizeClusterRoot(
        opts.provider, name, clusterItems, opts.knownRoots,
      );
      if (rateLimited) { result.rate_limited += 1; continue; }
      if (!verdict) continue;
      const action = decideAction(verdict, knownLabels);
      if (action.action === "attach" && action.root) {
        result.remap.push({ from: name, to: action.root });
        result.attached += 1;
        console.log(`[recognizer] attach "${name}" → "${action.root}" (same_owner=${verdict.same_owner}, shared_subject="${verdict.shared_subject}"): ${verdict.reasoning.slice(0, 140)}`);
      } else {
        console.log(`[recognizer] keep "${name}" (decision=${verdict.decision}, same_owner=${verdict.same_owner}): ${verdict.reasoning.slice(0, 120)}`);
      }
    } catch (e: any) {
      result.errors += 1;
      console.warn(`[recognizer] cluster "${name}" threw: ${e?.message ?? e}`);
    }
  }
  return result;
}

/** Apply a remap (from recognizeRootsForArc) to items' .project — returns a NEW
 *  array (shallow-copies only the rewritten items). Pure / testable. */
export function applyRootRemap(
  items: Pass2Item[],
  remap: Array<{ from: string; to: string }>,
): { items: Pass2Item[]; rewritten: number } {
  if (remap.length === 0) return { items, rewritten: 0 };
  const map = new Map(remap.map((r) => [r.from, r.to]));
  let rewritten = 0;
  const out = items.map((it) => {
    const to = map.get((it as any).project);
    if (!to) return it;
    rewritten += 1;
    return { ...it, project: to } as Pass2Item;
  });
  return { items: out, rewritten };
}
