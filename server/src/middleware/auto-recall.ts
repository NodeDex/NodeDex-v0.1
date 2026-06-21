import { WorkspaceDB } from "../store/database.js";
import { EmbeddingEngine } from "../engine/embeddings.js";
import { cosineSim } from "../engine/vector-math.js";

function extractEntities(message: string): string[] {
  const capsRegex = /(?<!^|\.\s+)\b[A-Z][a-z]+\b/g;
  const capitalized = message.match(capsRegex) || [];
  const targetRegex = /\b(?:about|on|for|with|using|fix|debug|build|create|find)\s+([a-zA-Z0-9_-]+)\b/gi;
  const targets: string[] = [];
  let match;
  while ((match = targetRegex.exec(message)) !== null) targets.push(match[1]);
  return [...new Set([...capitalized, ...targets, message])];
}

// Extract plain concept-like tokens from a message (lowercase, 2+ chars, no stopwords)
const STOPWORDS = new Set(["the", "is", "a", "an", "to", "of", "in", "for", "on", "with", "and", "or", "but", "it", "this", "that", "how", "what", "why", "can", "do", "be", "are", "was", "were", "will"]);

function extractConcepts(message: string): string[] {
  return message
    .toLowerCase()
    .replace(/[^a-z0-9_ ]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));
}

// Why a block was recalled — surfaced to agent so they know what to trust
type RecallReason = "keyword" | "semantic" | "concept" | "context" | "active_session";

export async function runAutoRecall(
  db: WorkspaceDB,
  embeddings: EmbeddingEngine,
  userMessage: string,
  context?: { projectId?: string; activeBlocks?: string[] }
): Promise<string> {
  let semanticActive = false;
  let queryVector: number[] = [];

  if (embeddings.isAvailable()) {
    try {
      const v = await embeddings.embed(userMessage);
      if (v) { queryVector = v; semanticActive = true; }
    } catch { /* fall through to keyword */ }
  }

  const entities      = extractEntities(userMessage);
  const queryConcepts = extractConcepts(userMessage);

  const weights = { keyword: 0.3, semantic: 0.5, concept: 0.4, context: 0.2 };

  // score + reason tracking per block
  const scoredBlocks = new Map<string, { block: any; score: number; reasons: Set<RecallReason> }>();

  const addScore = (block: any, score: number, reason: RecallReason) => {
    const existing = scoredBlocks.get(block.id);
    if (existing) {
      existing.score  += score;
      existing.reasons.add(reason);
    } else {
      scoredBlocks.set(block.id, { block, score, reasons: new Set([reason]) });
    }
  };

  const allBlocks = db.getAllBlocks();

  // ── 1. Keyword match ────────────────────────────────────────────
  for (const entity of entities) {
    const term = entity.toLowerCase();
    for (const block of allBlocks) {
      let aliases: string[] = [];
      try { aliases = JSON.parse(block.aliases || "[]"); } catch { /* ignore */ }
      if (
        block.label.toLowerCase().includes(term) ||
        block.essence.toLowerCase().includes(term) ||
        aliases.some((a: string) => a.toLowerCase().includes(term))
      ) {
        addScore(block, weights.keyword, "keyword");
      }
    }
  }

  // ── 2. Semantic similarity ───────────────────────────────────────
  if (semanticActive && queryVector.length > 0) {
    for (const block of allBlocks) {
      if (!block.embedding) continue;
      try {
        const bv = JSON.parse(block.embedding) as number[];
        const sim = cosineSim(queryVector, bv);
        if (sim > 0.6) addScore(block, sim * weights.semantic, "semantic");
      } catch { /* ignore */ }
    }
  }

  // ── 3. Concept overlap ─────────────────────────────────────────
  // Uses SQL json_each() to search concept arrays in the DB — no JS-level JSON-parse loop.
  // This is the cross-domain bridge: finds blocks whose abstract concepts overlap with the
  // query even when the topic/domain differs.
  if (queryConcepts.length > 0) {
    const conceptMatches = db.conceptSearch(queryConcepts);
    for (const [, { block, matches }] of conceptMatches) {
      const bonus = Math.min(matches * 0.2, 0.8);
      addScore(block, bonus * weights.concept, "concept");
    }
  }

  // ── 4. Context boost + project-scope precision ────────────────
  // Blocks linked to the current project score higher.
  // Unrelated non-skill blocks get a subtle penalty to keep recall project-focused.
  const projectRelatedIds = new Set<string>();
  if (context?.projectId) {
    const allRelations = db.getAllRelations(false);
    for (const rel of allRelations) {
      if (rel.source_id === context.projectId) projectRelatedIds.add(rel.target_id);
      if (rel.target_id === context.projectId) projectRelatedIds.add(rel.source_id);
    }
    projectRelatedIds.add(context.projectId);

    for (const block of allBlocks) {
      if (block.id === context.projectId) {
        addScore(block, weights.context * 2, "context");
      } else if (projectRelatedIds.has(block.id)) {
        addScore(block, weights.context * 1.2, "context");
      } else if (block.type !== "process" && block.type !== "skill") {
        // Skills/process blocks are exempt — cross-project use is intentional
        const existing = scoredBlocks.get(block.id);
        if (existing) existing.score *= 0.85;
      }
      try {
        const c = typeof block.content === "string" ? JSON.parse(block.content) : block.content;
        if (c?.project_id === context.projectId) addScore(block, weights.context, "context");
      } catch { /* ignore */ }
    }
  }
  if (context?.activeBlocks) {
    for (const blockId of context.activeBlocks) {
      const b = db.getBlock(blockId);
      if (b) addScore(b, weights.context, "active_session");
    }
  }

  // ── Boost derive/insight blocks — synthesized knowledge ranks above raw inputs ──
  // Apply quality weight so thin auto-reflect blocks don't compete equally with rich agent-saved blocks.
  for (const entry of scoredBlocks.values()) {
    try {
      const c = typeof entry.block.content === "string" ? JSON.parse(entry.block.content) : entry.block.content;
      if (c?.derivation) entry.score += 0.15; // derived insight boost
    } catch { /* ignore */ }
    if (entry.block.type === "insight") entry.score += 0.1;

    // quality_score 0–6 (0 means "not yet scored", treat as neutral default 3)
    const raw = (entry.block as any).quality_score;
    const q = (typeof raw === "number" && raw > 0) ? raw : 3;
    entry.score *= q / 6;
  }

  // ── Rank + budget ────────────────────────────────────────────
  // Without a project scope, concept overlap alone can surface loosely related blocks.
  // A higher minimum threshold keeps recall focused when no project is active.
  const MIN_SCORE = context?.projectId ? 0.1 : 0.2;
  const ranked = Array.from(scoredBlocks.values())
    .filter(({ block, score }) => !block.label.startsWith("agent_session_") && score >= MIN_SCORE)
    .sort((a, b) => b.score - a.score);

  const MAX_LOADED  = 5;
  const MAX_HINTS   = 15;
  const CHAR_BUDGET = 3000;

  const loadedBlocks: Array<{ block: any; reasons: Set<RecallReason> }> = [];
  const hintBlocks:   Array<{ block: any; reasons: Set<RecallReason> }> = [];
  let   charUsed = 0;

  const sanitize = (block: any) => {
    let content: Record<string, unknown> = {};
    try { content = typeof block.content === "string" ? JSON.parse(block.content) : block.content; } catch { /* ignore */ }
    let aliases: string[] = [];
    try { aliases = JSON.parse(block.aliases || "[]"); } catch { /* ignore */ }
    return {
      id:         block.id,
      label:      block.label,
      type:       block.type,
      status:     block.status,
      ttl:        block.ttl,
      essence:    block.essence,
      is_a:       content.is_a      || undefined,
      unique:     content.unique    || undefined,
      has:        content.has       || undefined,
      concepts:   (() => { try { const c = JSON.parse((block as any).concepts || "[]"); return c.length ? c : undefined; } catch { return undefined; } })(),
      created_at: block.created_at,
      updated_at: block.updated_at,
      aliases:    aliases.length ? aliases : undefined,
      created_by: block.created_by || undefined,
    };
  };

  const reasonLabel: Record<RecallReason, string> = {
    keyword:        "keyword match",
    semantic:       "semantic similarity",
    concept:        "shared concept",
    context:        "active project",
    active_session: "used in this session",
  };

  for (const { block, reasons } of ranked) {
    const clean = sanitize(block);
    const str   = JSON.stringify(clean);
    if (loadedBlocks.length < MAX_LOADED && charUsed + str.length < CHAR_BUDGET) {
      loadedBlocks.push({ block: clean, reasons });
      charUsed += str.length;
      // Touch access count only for blocks actually loaded (not hints)
      db.updateBlock(block.id, { access_count: (block.access_count || 0) + 1 });
      // Log recall as used=true for LOADED blocks — they were surfaced to the agent
      db.logRecall(block.id, context?.projectId, [...reasons].join(","), true);
    } else if (hintBlocks.length < MAX_HINTS) {
      hintBlocks.push({ block, reasons });
    }
  }

  if (loadedBlocks.length === 0 && hintBlocks.length === 0) {
    return `\n═══ WORKSPACE CONTEXT ═══\n(No relevant blocks found for this query)\n═════════════════════════\n`;
  }

  // ── Format prompt ────────────────────────────────────────────
  let prompt = `\n═══ WORKSPACE CONTEXT ═══\n`;

  if (loadedBlocks.length > 0) {
    prompt += `LOADED (use directly in your reasoning):\n`;
    for (const { block: b, reasons } of loadedBlocks) {
      const why = [...reasons].map((r) => reasonLabel[r]).join(", ");
      prompt += `\n[${b.id}] ${b.label} (${b.type}`;
      if (b.type === "process") prompt += ` ← SKILL/PROCEDURE`;
      prompt += `) — recalled via: ${why}\n`;
      prompt += `  what it is: ${b.essence}\n`;
      if (b.is_a)                                   prompt += `  is_a: ${b.is_a}\n`;
      if (b.unique && Object.keys(b.unique).length) prompt += `  properties: ${JSON.stringify(b.unique)}\n`;
      if (b.has   && Object.keys(b.has).length)    prompt += `  content: ${JSON.stringify(b.has)}\n`;
      if (b.concepts?.length)                       prompt += `  concepts: ${b.concepts.join(", ")}\n`;
      if (b.type === "process")
        prompt += `  usage_hint: This is a stored skill/procedure. Apply it to your current task if the concepts match.\n`;
      if (b.created_by) prompt += `  saved_by: ${b.created_by}\n`;
      prompt += `  saved: ${b.created_at?.slice(0, 10)}${b.updated_at !== b.created_at ? ` (updated ${b.updated_at?.slice(0, 10)})` : ""}\n`;
    }
  }

  if (hintBlocks.length > 0) {
    prompt += `\nAVAILABLE (hints — call workspace_get(id) for full detail):\n`;
    for (const { block: b, reasons } of hintBlocks) {
      const why  = [...reasons].map((r) => reasonLabel[r]).join(", ");
      const tag  = b.type === "process" ? " [SKILL]" : "";
      prompt += `  [${b.id}]${tag} ${b.label}: ${b.essence} — ${why}\n`;
    }
  }

  prompt += `═════════════════════════\n`;
  return prompt;
}
