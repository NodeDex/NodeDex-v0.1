// engine/search-core.ts — the ONE three-signal search scorer.
//
// Shared by the MCP tool (workspace_search) and REST (GET /api/search) so every
// door into the graph ranks the same way. Before this module, REST ran a bare
// LIKE scan ordered by access_count — popularity, not relevance — while the MCP
// tool scored properly; agents got different answers depending on which surface
// they entered through.
//
// RANKING PRINCIPLE — match quality ONLY:
//   Relevance is a property of the QUESTION, not the block. The graph's
//   highest-value blocks (dead-ends, constraints) are old and rarely accessed BY
//   DESIGN — they sit dormant until the bad idea returns. So no freshness decay
//   and no usage-based penalty (both removed 2026-07-03): a clock or popularity
//   prior biases against exactly the blocks the system exists to surface.
//   Currency has its own explicit machinery — the supersedes edge — and callers
//   annotate hits with superseded_by; scoring never second-guesses it.
//   updated_at breaks EXACT ties only (deterministic ordering, nothing more).
import { WorkspaceDB, Block } from "../store/database.js";
import { EmbeddingEngine } from "./embeddings.js";
import { cosineSim } from "./vector-math.js";

const SEARCH_STOPWORDS = new Set([
  "the","is","a","an","to","of","in","for","on","with","and","or","but","it",
  "this","that","how","what","why","can","do","be","are","was","were","will",
  "i","my","we","our",
]);

export interface SearchHit {
  block: Block;
  score: number;
  matchTypes: string[];
}

export interface SearchSignals {
  semantic: boolean;
  keyword: boolean;
  concept: boolean;
}

export interface SearchOptions {
  query: string;
  type?: string;   // restrict to one block type
  limit?: number;  // max hits returned (default 10)
}

/** Three-signal search: semantic similarity (embedding cosine) + keyword match +
 *  concept overlap. Signals ADD, so a block matching two ways beats one matching
 *  once; each hit carries matchTypes explaining why it surfaced. Embeddings are
 *  optional — without them the semantic signal is skipped and the other two
 *  still work (signals.semantic reports what actually ran). */
export async function searchBlocks(
  db: WorkspaceDB,
  embeddings: EmbeddingEngine | undefined,
  opts: SearchOptions,
): Promise<{ hits: SearchHit[]; signals: SearchSignals }> {
  const limit = opts.limit || 10;

  const queryConcepts = opts.query
    .toLowerCase().replace(/[^a-z0-9_ ]/g, " ").split(/\s+/)
    .filter((w) => w.length > 2 && !SEARCH_STOPWORDS.has(w));

  const scoreMap = new Map<string, { block: Block; score: number; matchTypes: Set<string> }>();
  const add = (block: Block, delta: number, tag: string) => {
    const e = scoreMap.get(block.id);
    if (e) { e.score += delta; e.matchTypes.add(tag); }
    else scoreMap.set(block.id, { block, score: delta, matchTypes: new Set([tag]) });
  };

  // ── 1. Semantic — meaning, not wording ("auth" finds the "login" block) ──
  const queryEmbedding = embeddings ? await embeddings.embed(opts.query) : null;
  if (queryEmbedding) {
    const semResults = db.semanticSearch(queryEmbedding, limit * 2, opts.type);
    for (const block of semResults) {
      const bv = JSON.parse(block.embedding!) as number[];
      add(block, cosineSim(queryEmbedding, bv) * 0.5, "semantic");
    }
  }

  // ── 2. Keyword — exact words in label/essence/content ──
  const kwResults = db.keywordSearch(opts.query, limit * 2, opts.type);
  for (const block of kwResults) add(block, 0.3, "keyword");

  // ── 3. Concept overlap — pipeline-stamped tags bridge domains ──
  if (queryConcepts.length > 0) {
    const allBlocks = db.getAllBlocks().filter(
      (b) => b.status !== "archived" && (!opts.type || b.type === opts.type)
    );
    for (const block of allBlocks) {
      let blockConcepts: string[] = [];
      try {
        const c = typeof block.content === "string" ? JSON.parse(block.content) : block.content;
        blockConcepts = (c?.concepts || []).map((x: string) => x.toLowerCase());
      } catch { /* ignore */ }
      if (!blockConcepts.length) continue;

      const matched = queryConcepts.filter((qc) =>
        blockConcepts.some((bc) => bc.includes(qc) || qc.includes(bc))
      );
      if (matched.length > 0) {
        add(block, Math.min(matched.length * 0.2, 0.6) * 0.4, `concept(${matched.join(",")})`);
      }
    }
  }

  const hits = Array.from(scoreMap.values())
    .sort((a, b) =>
      b.score - a.score ||
      String(b.block.updated_at ?? "").localeCompare(String(a.block.updated_at ?? "")))
    .slice(0, limit)
    .map(({ block, score, matchTypes }) => ({ block, score, matchTypes: [...matchTypes] }));

  return {
    hits,
    signals: {
      semantic: !!queryEmbedding,
      keyword: true,
      concept: queryConcepts.length > 0,
    },
  };
}

// ── Weak-result detection ─────────────────────────────────────────────────────
// The semantic signal is nearest-neighbor: it always returns the CLOSEST blocks,
// even when nothing is actually close — so an off-graph query ("kubernetes" on a
// garden db) still yields hits. Measured signature of that noise (dogfood graph,
// 2026-07-03): EVERY hit semantic-only at a flat ~0.26, while any real result
// set has at least one multi-signal hit scoring 0.4+. We LABEL it, never drop
// it: a silent [] can't be told apart from "search broke" (fail-loud rule), and
// a weak semantic hit is occasionally a true one (measured: a relevant dead-end
// at 0.22).
const WEAK_SCORE = 0.3;

/** True when the ENTIRE result set is weak (semantic-only, sub-0.3): the graph
 *  likely has nothing on this topic. One strong hit anywhere → not weak. */
export function allWeak(hits: SearchHit[]): boolean {
  return hits.length > 0 && hits.every(
    (h) => h.score < WEAK_SCORE && h.matchTypes.length === 1 && h.matchTypes[0] === "semantic"
  );
}

export const WEAK_NOTE =
  "weak matches only — nothing matched by keyword or concept; the graph likely has nothing on this topic. These are just the nearest blocks, not an answer.";

export interface RootContext {
  root_label: string;
  root_essence: string;
}

/** Root context for a set of hits — the same containment the tree query renders,
 *  attached to retrieval results so the agent can judge "which world is this hit
 *  from?" per line instead of resolving project_id block-by-block. One lookup per
 *  DISTINCT root. */
export function rootContextFor(db: WorkspaceDB, blocks: Block[]): Map<string, RootContext> {
  const out = new Map<string, RootContext>();
  for (const b of blocks) {
    const pid = b.project_id;
    if (!pid || typeof pid !== "string" || out.has(pid)) continue;
    const root = db.getBlock(pid);
    if (!root) continue;
    const ess = root.essence || "";
    out.set(pid, {
      root_label: root.label,
      root_essence: ess.length > 100 ? ess.slice(0, 100) + "…" : ess,
    });
  }
  return out;
}
