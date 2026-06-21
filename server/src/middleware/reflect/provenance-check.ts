// ═══════════════════════════════════════════════════════════════════════════════
// GAP ④(a) — PROVENANCE INTEGRITY CHECK (the $0 deterministic detector)
// ═══════════════════════════════════════════════════════════════════════════════
//
// WHAT IT FIXES
//   The extractor is an LLM; it can FABRICATE provenance — a block stores a
//   `source_excerpt` ("the exact transcript words I came from") that was never
//   actually said. Nothing checks that today. This is the integrity FLOOR: for
//   every block carrying an excerpt, confirm the excerpt actually appears in its
//   source transcript. NO LLM — pure string-match → runs on ALL excerpt-bearing
//   blocks, cheaply, in the background AFTER extraction (never blocks the fast path).
//
// TRIAGE, NOT REPAIR (the design split, per the user 2026-06-13):
//   This detector only FLAGS (writes pipeline_flags rows, like Stage AUDIT). It is
//   the cheap-broad triage. The expensive-narrow step — the async meaning-reviewer
//   (b', future) — re-reads the STORED transcript + the block's chain and judges by
//   MEANING whether to correct the excerpt, re-type, or demote. Flag-don't-act.
//
// GRADED RESULT:
//   exact   — normalized excerpt IS a substring of the transcript → trusted, no flag.
//   fuzzy   — not verbatim but ≥ floor token-coverage → LLM paraphrased; soft flag.
//   missing — low coverage → the words aren't there → likely fabricated; hard flag.
//   no_link — block has no block_extractions row (pre-Debt-5 / atomic) → can't verify,
//             not a violation (counted separately, never flagged).
//
// Provenance path (all stored, queryable; same path Pass 4 provenance uses):
//   block → getBlockExtractions → conversation_turn_ranges → conversation_turns.

import type { WorkspaceDB, Block } from "../../store/database.js";
import { writePipelineFlag } from "./pipeline-flags.js";
import type Database from "better-sqlite3";

export type ProvenanceStatus = "exact" | "fuzzy" | "missing" | "no_link";

/** Lowercase, non-alphanumeric → space, collapse. Cosmetic only — a verbatim
 *  quote survives; genuinely-different words still diverge. */
export function normalizeForMatch(s: string): string {
  return (s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

function tokens(s: string): string[] {
  return normalizeForMatch(s).split(" ").filter((t) => t.length > 2);
}

/**
 * Pure: is `excerpt` grounded in `transcript`? Exact substring → "exact". Else
 * token coverage (fraction of excerpt tokens present) decides fuzzy vs missing.
 */
export function excerptMatchStatus(
  excerpt: string,
  transcript: string,
  fuzzyFloor = 0.85,
): { status: Exclude<ProvenanceStatus, "no_link">; coverage: number } {
  const ne = normalizeForMatch(excerpt);
  const nt = normalizeForMatch(transcript);
  if (!ne) return { status: "missing", coverage: 0 };
  if (nt && nt.includes(ne)) return { status: "exact", coverage: 1 };
  const et = tokens(excerpt);
  if (et.length === 0) return { status: "missing", coverage: 0 };
  const ttSet = new Set(tokens(transcript));
  let found = 0;
  for (const t of et) if (ttSet.has(t)) found++;
  const coverage = found / et.length;
  return { status: coverage >= fuzzyFloor ? "fuzzy" : "missing", coverage };
}

/** Stitch the source transcript text for a block's MOST-RECENT extraction range. */
export function getBlockTranscript(db: WorkspaceDB, blockId: string): { text: string; rangeId: string } | null {
  const exts = db.getBlockExtractions(blockId);
  if (!exts || exts.length === 0) return null;
  const rangeId = exts[exts.length - 1].range_id; // chronological asc → last = newest
  const range = db.getConversationTurnRange(rangeId);
  if (!range) return null;
  const parts: string[] = [];
  for (let tn = range.start_turn_number; tn <= range.end_turn_number; tn++) {
    const turn = db.getConversationTurnByAgentTurn(range.agent_id, tn);
    if (!turn) continue;
    try {
      const tj = JSON.parse(turn.transcript_json || "{}");
      for (const k of ["user_message", "agent_response", "agent_thinking"]) {
        if (tj[k]) parts.push(String(tj[k]));
      }
    } catch { parts.push(turn.transcript_json || ""); }
  }
  return { text: parts.join("\n"), rangeId };
}

export interface ProvenanceCheckResult {
  checked: number;   // blocks with a non-empty source_excerpt that we evaluated
  exact: number;
  fuzzy: number;
  missing: number;
  no_link: number;   // had an excerpt but no provenance range → not verifiable
  flagged: number;   // fuzzy + missing that got a pipeline_flags row (when write)
}

/**
 * Scan blocks carrying a source_excerpt; verify each against its stored transcript;
 * write a provenance_mismatch flag for fuzzy/missing. Deterministic, $0.
 * `write:false` → dry-run (audit counts only). `limit` bounds the scan.
 */
export function runProvenanceCheck(
  db: WorkspaceDB,
  opts: { limit?: number; write?: boolean; flagFuzzy?: boolean } = {},
): ProvenanceCheckResult {
  const write = opts.write !== false;
  // The expensive meaning-reviewer (b') runs ONLY on HARD (missing) flags — a
  // 'fuzzy' is a benign paraphrase (the block IS grounded, just not verbatim) so
  // it must NEVER cost an LLM call. flagFuzzy keeps the soft flag as a $0 metric
  // ("how often does extraction paraphrase?"); set false to drop them entirely
  // and keep the flag table lean at scale. Either way, fuzzy never escalates.
  const flagFuzzy = opts.flagFuzzy !== false;
  const raw = (db as any).db; // raw better-sqlite3 handle for writePipelineFlag
  const res: ProvenanceCheckResult = { checked: 0, exact: 0, fuzzy: 0, missing: 0, no_link: 0, flagged: 0 };

  let candidates = db.getAllBlocks().filter(
    (b: Block) => typeof b.source_excerpt === "string" && (b.source_excerpt as string).trim().length > 0,
  );
  if (opts.limit && opts.limit > 0) candidates = candidates.slice(0, opts.limit);

  for (const b of candidates) {
    res.checked++;
    const src = getBlockTranscript(db, b.id);
    if (!src) { res.no_link++; continue; }
    const { status, coverage } = excerptMatchStatus(b.source_excerpt as string, src.text);
    if (status === "exact") { res.exact++; continue; }
    if (status === "fuzzy") res.fuzzy++; else res.missing++;
    // Hard (missing) always flags → reviewer territory. Soft (fuzzy) only when
    // flagFuzzy — and even then it's a metric, not an LLM trigger.
    const shouldFlag = write && (status === "missing" || flagFuzzy);
    if (shouldFlag) {
      writePipelineFlag(raw, {
        flag_type: "provenance_mismatch",
        block_id_a: b.id,
        block_id_b: null,
        criteria: {
          status,
          coverage: Number(coverage.toFixed(3)),
          severity: status === "missing" ? "hard" : "soft",
          excerpt_preview: (b.source_excerpt as string).slice(0, 160),
        },
        scope_check: "unknown",       // provenance is not a scope question
        origin_writer: "provenance_check",
        origin_range_id: src.rangeId, // lets the reviewer re-read the same transcript
      });
      res.flagged++;
    }
  }
  return res;
}

/** INLINE (at-extraction) provenance check — the cheap, immediate path.
 *  The LLM just wrote `excerpt` as the source of block `blockId`; verify those
 *  words actually appear in `transcript` (which the pipeline has in hand) and FLAG
 *  it if not. Flag-don't-act: the block STAYS; the reviewer/agent judges
 *  fabricated-vs-reworded. Only HARD ('missing' = the words aren't there = likely
 *  fabricated) flags — 'fuzzy' (reworded, same meaning) is fine. $0, no DB lookup,
 *  so it works for BOTH arc and per-turn (unlike runProvenanceCheck's scan path).
 *  Best-effort: NEVER throws (provenance bookkeeping must not break extraction).
 *  Returns the grade for logging/tests. */
export function flagBlockExcerptInline(
  rawDb: Database.Database,
  blockId: string,
  excerpt: string | undefined | null,
  transcript: string,
): ProvenanceStatus {
  try {
    if (!excerpt || !excerpt.trim()) return "no_link";
    const { status, coverage } = excerptMatchStatus(excerpt, transcript);
    if (status === "missing") {
      writePipelineFlag(rawDb, {
        flag_type: "provenance_mismatch",
        block_id_a: blockId,
        block_id_b: null,
        criteria: {
          status,
          coverage: Number(coverage.toFixed(3)),
          severity: "hard",
          excerpt_preview: excerpt.slice(0, 160),
          origin: "inline",
        },
        scope_check: "unknown",
        origin_writer: "provenance_check",
        origin_range_id: null,
      });
    }
    return status;
  } catch {
    return "no_link"; // best-effort — provenance must never break extraction
  }
}
