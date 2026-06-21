// render-agent-flag.ts — turn an owner-unknown pipeline_flag into a PLAIN-ENGLISH
// question for the agent. SINGLE SOURCE OF TRUTH for that rendering, used by BOTH:
//   • the REST surface   (routes/flags.ts  → GET /api/flags/agent-pending)
//   • the MCP pull surface (tools/flag-surface.ts → workspace_stats.flags)
//
// Extracted from routes/flags.ts so the two surfaces can't drift. The agent never
// sees ids/schema/verdict vocabulary — just "same thing? whose?" — and answers from
// its conversation context (or asks the user), then it's applied via the review path.
//
// Only owner-unknown dup flags are routed to the agent today (the reviewer's
// markFlagPendingClarification path); this renderer is shaped for them.

import type Database from "better-sqlite3";
import { loadBlockSnapshot } from "./flag-reviewer.js";
import { extractPrimaryValueFromUnique } from "./dedup-by-source-and-value.js";
import { scopeSegmentOfLabel } from "./retrieve-graph-slice.js";
import type { PipelineFlag, BlockReviewSnapshot } from "./types.js";

export interface RenderedAgentFlag {
  id: string;
  question: string;
  you_are_recording: { what: string; value: string; owner: string; source: string | null };
  existing_uncertain: { what: string; value: string; owner: string; source: string | null } | null;
  routed_reason: string | null;
}

/**
 * Render an owner-unknown flag as a plain-English question. Returns null if
 * block_a is gone (stale flag — skip it).
 */
export function renderAgentFlag(raw: Database.Database, flag: PipelineFlag): RenderedAgentFlag | null {
  const a = loadBlockSnapshot(raw, flag.block_id_a);
  if (!a) return null;
  const b = flag.block_id_b ? loadBlockSnapshot(raw, flag.block_id_b) : null;
  const describe = (s: BlockReviewSnapshot) => {
    let value = "";
    try { value = extractPrimaryValueFromUnique(s.type, (JSON.parse(s.content)?.unique) || {}); } catch { /* leave blank */ }
    return { what: s.essence, value, owner: scopeSegmentOfLabel(s.label), source: s.source ?? null };
  };
  const you = describe(a);
  const existing = b ? describe(b) : null;
  const question = existing
    ? `You're recording (owner: ${you.owner}): "${you.value || you.what}". An existing entry is already on file with an UNCERTAIN owner (${existing.owner}): "${existing.value || existing.what}". Are these the same thing, and does the existing one belong to ${you.owner}? If you can't tell from context, ask the user. (The existing one was captured from: ${existing.source || "no source recorded"}.)`
    : `An existing entry needs an owner assigned: "${you.value || you.what}" (owner: ${you.owner}). Who does it belong to? If unsure, ask the user.`;
  return { id: flag.id, question, you_are_recording: you, existing_uncertain: existing, routed_reason: flag.review_reason };
}
