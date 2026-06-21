// nl-accept.ts — flag-resolution part (b): apply the agent's NL decision.
//
// The agent is read-only and passive — it can't call a write endpoint. So when the
// system routes a question to it (a possible-duplicate it couldn't resolve alone,
// surfaced via workspace_stats.flags), the agent just STATES its decision in its
// normal reply ("those two are the same — keep customer-c's"). This module reads that
// reply, matches it back to the open flags, and applies the verdict via the shared
// applier. Read-only-preserving: the agent never writes; the pipeline does.
//
// SAFETY (this is auto-mutation triggered by parsing free text):
//   • DEFAULT OFF — NODEDEX_FLAG_NL_ACCEPT=on to enable (opt-in, per the 3-tier
//     release model: auto-mutation stays opt-in until validated).
//   • WORK-GATED — $0 when no flags are routed to the agent (no LLM call).
//   • NEVER-FABRICATE — a resolution is applied only if the LLM can QUOTE the agent's
//     own words for it AND that quote actually appears in the reply.
//   • CONSERVATIVE MERGE — a destructive merge fires only at high confidence with a
//     valid winner; a weak merge-lean is LEFT PENDING (explicit confirmation needed),
//     mirroring the autonomous reviewer. leave/split are non-destructive.

import type Database from "better-sqlite3";
import type { WorkspaceDB } from "../../store/database.js";
import type { LLMProvider } from "../../engine/ai-provider.js";
import type { PipelineFlag } from "./types.js";
import { getAgentPendingFlags } from "./pipeline-flags.js";
import { loadBlockSnapshot } from "./flag-reviewer.js";
import { scopeSegmentOfLabel } from "./retrieve-graph-slice.js";
import { renderAgentFlag } from "./render-agent-flag.js";
import { normalizeForMatch } from "./provenance-check.js";
import { applyFlagVerdict } from "./apply-flag-verdict.js";
import { getThinkingBudget } from "./config.js";

const NL_BATCH = 8; // bound the questions handed to one parse call

/** Opt-in. Default OFF — auto-mutation from parsed NL stays gated until validated. */
export function nlAcceptEnabled(): boolean {
  return (process.env.NODEDEX_FLAG_NL_ACCEPT ?? "").toLowerCase() === "on";
}

export interface NlResolution {
  flag_id: string;
  verdict: "merge" | "leave" | "split" | "none";
  winning_block_id?: string;
  confidence: "high" | "medium" | "low";
  quote: string;
}

export interface NlAcceptResult {
  addressed: number;       // resolutions the agent clearly made (quote-backed, verdict≠none)
  merged: number;
  left: number;
  split: number;
  skipped_low_conf: number; // merge-lean but not safely auto-executable → left pending
  errors: number;
}

const NL_ACCEPT_PROMPT = `You apply an agent's stated decisions about pending memory-graph questions.

You are given the AGENT'S MESSAGE (free text it just wrote) and a list of OPEN QUESTIONS the system asked it. Each question is a possible-duplicate the system couldn't resolve alone: two candidate entries A and B (each with an id).

For EACH open question, decide whether the agent's message EXPLICITLY answered it, and if so what it decided:
  - "merge": the agent said the two entries are the SAME thing. Set winning_block_id to the id of the entry it wants to KEEP (must be A's id or B's id for that question).
  - "leave": the agent said they are DIFFERENT / keep both separate.
  - "split": the agent said keep both but something structural must change, or it needs more work.
  - "none": the agent did NOT clearly address this question. THIS IS THE DEFAULT.

HARD RULES (a wrong apply corrupts the graph — be conservative):
  - NEVER invent a decision. If the agent did not clearly speak to a question, output "none".
  - \`quote\` MUST be the agent's own words (a verbatim substring of its message) that express the decision. If you cannot quote them, the verdict is "none".
  - winning_block_id must be exactly one of the two candidate ids GIVEN for that question.
  - "high" confidence only when the agent was explicit and unambiguous.

OUTPUT JSON per schema: one entry per question you were given (use "none" + empty quote for the ones the agent didn't address).`;

const NL_ACCEPT_SCHEMA = {
  type: "object",
  properties: {
    resolutions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          flag_id:          { type: "string" },
          verdict:          { type: "string", enum: ["merge", "leave", "split", "none"] },
          winning_block_id: { type: "string" },
          confidence:       { type: "string", enum: ["high", "medium", "low"] },
          quote:            { type: "string" },
        },
        required: ["flag_id", "verdict", "confidence", "quote"],
      },
    },
  },
  required: ["resolutions"],
} as const;

/** Build the parse input: the agent's message + each open question with its two
 *  candidate ids (the agent-facing surface hides ids; the internal parser needs
 *  them to name a winner). */
export function buildNlAcceptInput(raw: Database.Database, agentText: string, flags: PipelineFlag[]): string {
  const sections: string[] = ["AGENT'S MESSAGE:", agentText.trim(), "", "OPEN QUESTIONS:"];
  for (const flag of flags) {
    const rendered = renderAgentFlag(raw, flag);
    if (!rendered) continue;
    const a = loadBlockSnapshot(raw, flag.block_id_a);
    const b = flag.block_id_b ? loadBlockSnapshot(raw, flag.block_id_b) : null;
    sections.push(
      "",
      `QUESTION flag_id=${flag.id}:`,
      `  asked: ${rendered.question}`,
      a ? `  Candidate A: id=${a.id} owner=${scopeSegmentOfLabel(a.label)} says="${a.primary_value || a.essence}"` : `  Candidate A: (gone)`,
      b ? `  Candidate B: id=${b.id} owner=${scopeSegmentOfLabel(b.label)} says="${b.primary_value || b.essence}"` : `  Candidate B: (none)`,
    );
  }
  return sections.join("\n");
}

async function callNlAcceptLLM(
  provider: LLMProvider,
  input: string,
): Promise<{ resolutions: NlResolution[] } | null> {
  try {
    const r = await provider.generateStructured<{ resolutions: NlResolution[] }>(
      NL_ACCEPT_PROMPT, input, NL_ACCEPT_SCHEMA,
      { thinkingBudget: getThinkingBudget(1024), maxOutputTokens: 4096 },
    );
    return r.result ?? null;
  } catch {
    return null;
  }
}

/** The agent's quote must actually be in its message (never-fabricate anchor). */
function quoteIsGrounded(agentText: string, quote: string): boolean {
  if (!quote || !quote.trim()) return false;
  const nt = normalizeForMatch(agentText);
  const nq = normalizeForMatch(quote);
  return nq.length > 0 && nt.includes(nq);
}

/**
 * Read the agent's reply, match it to its routed flags, apply the confident verdicts.
 * Gated + work-gated + cost-aware: returns a no-op result with no LLM call when
 * disabled or when nothing is routed. `opts.force` bypasses ONLY the enabled-gate
 * (tests); the work-gate + safety checks always hold.
 */
export async function resolveRoutedFlagsFromText(
  db: WorkspaceDB,
  provider: LLMProvider,
  agentText: string,
  opts: { force?: boolean } = {},
): Promise<NlAcceptResult> {
  const result: NlAcceptResult = { addressed: 0, merged: 0, left: 0, split: 0, skipped_low_conf: 0, errors: 0 };
  if (!opts.force && !nlAcceptEnabled()) return result;            // gate (default off)
  if (!agentText || agentText.trim().length < 20) return result;

  const raw = (db as unknown as { db: Database.Database }).db;
  const flags = getAgentPendingFlags(raw, { limit: NL_BATCH });
  if (flags.length === 0) return result;                           // work-gate ($0)

  const llm = await callNlAcceptLLM(provider, buildNlAcceptInput(raw, agentText, flags));
  if (!llm || !Array.isArray(llm.resolutions)) { result.errors += 1; return result; }

  const flagById = new Map(flags.map((f) => [f.id, f]));
  for (const r of llm.resolutions) {
    const flag = flagById.get(r.flag_id);
    if (!flag) continue;                                           // defense vs hallucinated id
    if (r.verdict === "none") continue;
    if (!quoteIsGrounded(agentText, r.quote)) continue;            // never-fabricate
    result.addressed += 1;

    if (r.verdict === "merge") {
      const validWinner = r.winning_block_id === flag.block_id_a || r.winning_block_id === flag.block_id_b;
      if (r.confidence === "high" && validWinner) {
        const applied = applyFlagVerdict(db, flag, {
          verdict: "merge", execute: true, winning_block_id: r.winning_block_id,
          reason: `Agent confirmed duplicate in conversation: "${r.quote}"`,
        });
        if (applied.ok && applied.action_taken !== "none") result.merged += 1; else result.errors += 1;
      } else {
        // Merge-lean but weak (low/medium confidence, or winner not in the pair) —
        // do NOT auto-archive on weak NL evidence. Leave the flag PENDING so it can
        // be confirmed explicitly (the agent can re-state, or the user decides).
        result.skipped_low_conf += 1;
      }
    } else if (r.verdict === "leave" || r.verdict === "split") {
      const applied = applyFlagVerdict(db, flag, {
        verdict: r.verdict,
        reason: `Agent decided in conversation: "${r.quote}"`,
      });
      if (applied.ok) { if (r.verdict === "leave") result.left += 1; else result.split += 1; }
      else result.errors += 1;
    }
  }
  return result;
}
