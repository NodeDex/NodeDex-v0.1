// routes/workspace.ts — workspace scratchpad, prefetch, classify, challenge.
// Reference: api-server.v1.ts (lines 2478-2893)

import { Router } from "express";
import { WorkspaceDB } from "../store/database.js";
import { EmbeddingEngine, blockEmbeddingText } from "../engine/embeddings.js";
import { getLLMProvider } from "../engine/providers/index.js";
import { CAUSAL_TRAVERSAL_RELS } from "../relation-sets.js";

interface WorkspaceEntry {
  block_id: string; label: string; essence: string;
  quality_score: number; incoming_count: number;
  challenges: Array<{ label: string; essence: string }>;
  query: string;
  relevance: "high" | "medium" | "uncertain" | "pending";
  state: "prepared" | "used" | "ignored";
  prepared_at: number;
}

export function createWorkspaceRouter(db: WorkspaceDB, embeddings?: EmbeddingEngine): Router {
  const router = Router();

  // Local state — scoped to this router closure (not shared with other routers)
  const workspaceStore: WorkspaceEntry[] = [];
  let prefetchCache: { type: string; search_terms: string[]; ignored_labels: string[]; timestamp: number } | null = null;
  let currentSessionTurn = 0;

  // ─── Session turn tracker ─────────────────────────────────────────────────
  // Hook posts the current turn number before every message.
  // quick-save reads currentSessionTurn to stamp session_turn on every saved block.
  router.post("/api/session-turn", (req, res) => {
    const { turn } = req.body as { turn: number };
    if (typeof turn === "number") currentSessionTurn = turn;
    res.json({ ok: true, turn: currentSessionTurn });
  });
  router.get("/api/session-turn", (_req, res) => {
    res.json({ turn: currentSessionTurn });
  });

  // ─── Quick-save: one sentence → Gemini builds full block ─────────
  router.post("/api/quick-save", async (req, res) => {
    try {
      const { text, type_hint, context } = req.body as { text: string; type_hint?: string; context?: string };
      if (!text?.trim()) return res.status(400).json({ error: "text required" });

      const aiProvider = getLLMProvider();

      let draft: { label: string; type: string; essence: string; is_a: string; unique: Record<string,string>; concepts: string[] };

      if (aiProvider.isAvailable()) {
        const prompt = `You are a knowledge block generator for a persistent agent memory workspace.
Given a one-sentence insight from an AI agent working mid-task, generate a complete knowledge block.

Sentence: "${text.slice(0, 400)}"
${context ? `Context: "${context.slice(0, 300)}"` : ""}
${type_hint ? `Preferred type: ${type_hint}` : ""}

Return valid JSON only — no markdown, no explanation:
{
  "label": "short_3_5_word_label",
  "type": "fact|decision|insight|constraint|dead_end",
  "essence": "refined precise one-line description",
  "is_a": "specific category (e.g. system_behavior, design_decision, test_result)",
  "unique": { "key1": "value1", "key2": "value2", "key3": "value3" },
  "concepts": ["abstract_pattern1", "abstract_pattern2", "abstract_pattern3", "abstract_pattern4"]
}
Rules:
- label: 3-5 words, lowercase, underscores only, no numbers
- type: fact=observation/result, decision=made choice, insight=pattern noticed, constraint=hard limit, dead_end=failed approach
- essence: more precise than input if possible
- is_a: specific parent category, NOT "information" or "thing"
- unique: 2-4 distinct key-value properties
- concepts: 3-5 abstract domain-agnostic patterns (NOT topic words — "lazy_validation" not "Gemini", "threshold_crossing" not "quantum")`;

        const raw = (await aiProvider.generate(prompt) ?? "").replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "");
        draft = JSON.parse(raw);
      } else {
        const slug = text.toLowerCase().replace(/[^a-z0-9]+/g, "_").slice(0, 40).replace(/_+$/, "");
        draft = { label: slug, type: type_hint || "fact", essence: text, is_a: "agent_observation", unique: { source: "quick_save" }, concepts: [] };
      }

      if (!draft.label || draft.label.length < 2) draft.label = text.slice(0, 30).toLowerCase().replace(/[^a-z0-9]+/g, "_");
      if (!draft.type) draft.type = type_hint || "fact";
      const concepts = Array.isArray(draft.concepts) ? draft.concepts : [];

      const turn = currentSessionTurn;
      const phase = turn <= 5 ? "early" : turn <= 20 ? "mid" : "late";

      const block = db.createBlock({
        label: draft.label,
        type: draft.type,
        essence: draft.essence || text,
        content: {
          is_a: draft.is_a || "", unique: draft.unique || {}, has: {},
          session_context: { turn, phase, saved_at: new Date().toISOString() }
        },
        concepts,
        created_by: "quick_save",
      } as any);

      let qScore = 1;
      if (draft.is_a) qScore++;
      if (draft.unique && Object.keys(draft.unique).length >= 2) qScore++;
      if (concepts.length >= 3) qScore++;
      db.updateBlock(block.id, { quality_score: Math.min(qScore, 5) });

      if (embeddings?.isAvailable()) {
        embeddings.embed(blockEmbeddingText({ essence: draft.essence || text, concepts })).then(vec => {
          if (vec) db.updateBlock(block.id, { embedding: JSON.stringify(vec) } as any);
        }).catch(() => {});
      }

      res.json({ id: block.id, label: block.label, type: block.type, essence: block.essence, is_a: draft.is_a, concepts, quality_score: qScore, saved: true });
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  // ─── Workspace — in-memory session scratchpad ─────────────────────────────
  router.post("/api/workspace", async (req, res) => {
    const { blocks, query } = req.body as { blocks: any[]; query: string };
    const newEntries: WorkspaceEntry[] = [];
    for (const b of (blocks || [])) {
      const existing = workspaceStore.find(e => e.block_id === b.id);
      if (!existing) {
        const entry: WorkspaceEntry = {
          block_id: b.id, label: b.label, essence: b.essence || "",
          quality_score: b.quality_score || 0, incoming_count: b.incoming_count || 0,
          challenges: b.challenges || [], query: query || "",
          relevance: "pending", state: "prepared", prepared_at: Date.now(),
        };
        workspaceStore.push(entry);
        newEntries.push(entry);
      } else if (existing.state !== "prepared") {
        existing.state = "prepared";
        existing.query = query || "";
        existing.relevance = "pending";
        existing.prepared_at = Date.now();
        newEntries.push(existing);
      }
    }
    res.json({ added: newEntries.length, total: workspaceStore.length });

    if (newEntries.length > 0 && query && getLLMProvider().isAvailable()) {
      try {
        const prompt = `Rate each block's relevance to the query. Respond with valid JSON only.\nQuery: "${query}"\nBlocks:\n${newEntries.map(e => `- id: "${e.block_id}", text: "${e.essence.slice(0, 120)}"`).join("\n")}\nSchema: {"ratings":[{"id":"...","relevance":"high"|"medium"|"uncertain"}]}`;
        const text = (await getLLMProvider().generate(prompt) ?? "").replace(/```json\n?|\n?```/g, "").trim();
        const parsed = JSON.parse(text);
        for (const r of (parsed.ratings || [])) {
          const entry = workspaceStore.find(e => e.block_id === r.id);
          if (entry && ["high","medium","uncertain"].includes(r.relevance)) entry.relevance = r.relevance;
        }
      } catch { /* relevance stays "pending" — non-fatal */ }
    }
  });

  router.get("/api/workspace", (req, res) => {
    const stateFilter = (req.query.state as string) || "prepared";
    const entries = stateFilter === "all"
      ? workspaceStore
      : workspaceStore.filter(e => e.state === stateFilter);
    res.json({
      total: workspaceStore.length,
      prepared: workspaceStore.filter(e => e.state === "prepared").length,
      used: workspaceStore.filter(e => e.state === "used").length,
      entries: entries.sort((a, b) => b.prepared_at - a.prepared_at),
    });
  });

  router.patch("/api/workspace/:blockId", (req, res) => {
    const entry = workspaceStore.find(e => e.block_id === req.params.blockId);
    if (!entry) return res.status(404).json({ error: "not found" });
    const { state } = req.body as { state: string };
    if (!["used","ignored","prepared"].includes(state)) return res.status(400).json({ error: "invalid state" });
    entry.state = state as WorkspaceEntry["state"];
    res.json({ ok: true, entry });
  });

  router.delete("/api/workspace", (_req, res) => {
    workspaceStore.length = 0;
    res.json({ ok: true });
  });

  // ─── Prefetch cache — single-read ────────────────────────────────────────
  router.get("/api/prefetch", (_req, res) => {
    const TTL = 5 * 60 * 1000;
    if (!prefetchCache || Date.now() - prefetchCache.timestamp > TTL) {
      prefetchCache = null;
      return res.json({ type: "unknown", search_terms: [], ignored_labels: [] });
    }
    const result = prefetchCache;
    prefetchCache = null;
    res.json(result);
  });

  // ─── Gemini query classifier ──────────────────────────────────────────────
  router.post("/api/classify", async (req, res) => {
    try {
      const { message } = req.body as { message: string };
      if (!message?.trim()) return res.status(400).json({ error: "message required" });

      const classifyProvider = getLLMProvider();
      if (!classifyProvider.isAvailable()) return res.json({ type: "unknown", search_terms: [], ignored_labels: [] });

      const classifyPrompt = `You are a query classifier for a knowledge workspace.
Given a user message, determine what concepts to search for.
Respond with valid JSON only — no markdown, no explanation.

Schema: {"type":"meta"|"topical"|"continuation"|"system","search_terms":["term1"],"ignored_labels":["label"]}

Rules:
- "meta": conversational, command, status ("go ahead", "alright", "what do you think", "how about now", "can you explain") → search_terms: []
- "topical": question about a concept/domain → extract 3-5 abstract domain terms
- "continuation": continuing prior research → extract terms from context
- "system": question about the agent, WMCS, knowledge graph, tasks, decisions, build status, system health ("where are we at", "how is the system", "what tasks are open", "whats done", "what did we build") → search_terms: []
- Words with underscores (e.g. "sir_model", "dp_grand_unification_all_thresholds") are block label REFERENCES — add to ignored_labels, never fragment them into search_terms
- Keep search_terms as domain concepts, never meta-words (system, explain, tell, show, think, feel, about)

Classify this message:
"${message.slice(0, 500)}"`;

      const text = (await classifyProvider.generate(classifyPrompt) ?? "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "");
      const parsed = JSON.parse(text) as { type: string; search_terms: string[]; ignored_labels: string[] };

      prefetchCache = { ...parsed, timestamp: Date.now() };
      res.json(prefetchCache);
    } catch (e) {
      res.json({ type: "unknown", search_terms: [], ignored_labels: [] });
    }
  });

  // ─── Adversarial Challenger ───────────────────────────────────────────────
  async function runAdversarialChallenger(limit = 5, onlyRecentMins?: number): Promise<{ challenged: number; skipped: number }> {
    const challengeProvider = getLLMProvider();
    if (!challengeProvider.isAvailable()) return { challenged: 0, skipped: 0 };

    const RECHALLENGED_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;
    const now = Date.now();

    const allBlocks = db.getAllBlocks().filter(b => {
      if (b.status === "archived") return false;
      if (b.type !== "fact") return false;
      if (!b.essence) return false;
      if (b.created_by === "adversarial_challenger") return false;
      if (b.last_challenged_at && (now - new Date(b.last_challenged_at).getTime()) < RECHALLENGED_COOLDOWN_MS) return false;
      if (onlyRecentMins) {
        const cutoff = new Date(now - onlyRecentMins * 60 * 1000).toISOString();
        if ((b.created_at ?? "") < cutoff) return false;
      }
      return true;
    });

    const allRelations = db.getAllRelations(false);
    const incomingCount = new Map<string, number>();
    for (const r of allRelations) {
      incomingCount.set(r.target_id, (incomingCount.get(r.target_id) ?? 0) + 1);
    }
    const alreadyChallenged = new Set(
      allRelations.filter(r => r.type === "contradicts").map(r => r.target_id)
    );
    const candidates = allBlocks
      .filter(b => !alreadyChallenged.has(b.id))
      .sort((a, b) => (incomingCount.get(a.id) ?? 0) - (incomingCount.get(b.id) ?? 0))
      .slice(0, limit);
    if (candidates.length === 0) return { challenged: 0, skipped: allBlocks.length };

    const BATCH = 5;
    let challenged = 0;
    for (let i = 0; i < candidates.length; i += BATCH) {
      const batch = candidates.slice(i, i + BATCH);
      try {
        const batchPrompt = `You are an adversarial fact-checker. For each block, do two things:
1. Find the single strongest objection to the claim — a specific counterexample, documented exception, or known contradiction. Be direct and specific, not hedging. Use null only if a claim is a mathematical definition, tautology, or truly unassailable.
2. Review the concept_tags for accuracy. Flag any tags that are inaccurate, misleading, or too broad for this specific block. Leave tag_issues empty [] if all tags are accurate.

Respond with valid JSON only — no markdown.

Blocks:
${batch.map(b => `{"id":"${b.id}","claim":"${b.essence.replace(/"/g, "'").slice(0, 150)}","concept_tags":${b.concepts || "[]"}}`).join("\n")}

Schema: {"challenges":[{"id":"...","challenge":"one direct sentence or null","tag_issues":["inaccurate_tag_name"]}]}`;
        const text = (await challengeProvider.generate(batchPrompt) ?? "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "");
        const parsed = JSON.parse(text) as { challenges: Array<{ id: string; challenge: string | null; tag_issues?: string[] }> };

        const challengedAt = new Date().toISOString();
        for (const item of (parsed.challenges || [])) {
          const block = batch.find(b => b.id === item.id);
          if (!block) continue;
          try { db.updateBlock(block.id, { last_challenged_at: challengedAt }); } catch { /* ignore */ }

          if (item.tag_issues && item.tag_issues.length > 0) {
            try {
              const currentContent = (() => {
                try { return typeof block.content === "string" ? JSON.parse(block.content as string) : (block.content || {}); } catch { return {}; }
              })() as Record<string, unknown>;
              currentContent.tag_issues_flagged_by_gemini = item.tag_issues;
              db.updateBlock(block.id, { content: JSON.stringify(currentContent) });
            } catch { /* non-critical */ }
          }

          if (!item.challenge || item.challenge === "null") continue;
          try {
            const projectPrefix = block.label.split("_")[0];
            const labelParts = block.label.split("_");
            const conceptPart = (labelParts.length >= 3 ? labelParts.slice(2) : labelParts.slice(1)).join("-").slice(0, 20);
            const challengerLabel = `${projectPrefix}_fact_challenge-${conceptPart}-${Date.now().toString(36)}`;
            const challenger = db.createBlock({
              label: challengerLabel, type: "fact", essence: item.challenge,
              source: "adversarial_challenger", source_type: "gemini_suggested",
              created_by: "adversarial_challenger",
              project_id: block.project_id || null,
              concepts: ["adversarial_challenge", "epistemic_immunity", "counterargument"],
            } as any);
            db.save();
            db.createRelation({ source_id: challenger.id, target_id: block.id, type: "contradicts", created_by: "adversarial_challenger" });
            db.save();
            challenged++;
          } catch { /* skip individual block */ }
        }
      } catch { /* skip batch, continue */ }
    }
    return { challenged, skipped: candidates.length - challenged };
  }

  router.post("/api/challenge/run", async (req, res) => {
    try {
      const limit = Number((req.body as any)?.limit) || 10;
      const result = await runAdversarialChallenger(limit);
      res.json({ ok: true, ...result });
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  // Startup catch-up and periodic sweeps — disabled by default (2026-05-23).
  // Per docs/OVER-EXTRACTION-FINDING.md the Challenger amplifies noise: it fires on every
  // fact including the weak q2 enumerated-option ones, producing empty-unique challenge_*
  // blocks (noise-on-noise). Set NODEDEX_CHALLENGER_ENABLED=1 to re-enable the timers.
  // The manual route POST /api/challenge/run above is always live for explicit triggers.
  // .unref() so timers don't prevent process exit (e.g. in tests).
  if (process.env.NODEDEX_CHALLENGER_ENABLED === "1") {
    console.log("[challenger] periodic sweeps enabled (NODEDEX_CHALLENGER_ENABLED=1)");
    setImmediate(() => { runAdversarialChallenger(200).catch(() => {}); });
    setInterval(() => { runAdversarialChallenger(20).catch(() => {}); }, 60 * 60 * 1000).unref();
    setInterval(() => { runAdversarialChallenger(3, 6).catch(() => {}); }, 5 * 60 * 1000).unref();
  } else {
    console.log("[challenger] periodic sweeps disabled — set NODEDEX_CHALLENGER_ENABLED=1 to re-enable; manual /api/challenge/run is still available");
  }

  // ─── Graph chain traversal ─────────────────────────────────────────────────
  // GET /api/blocks/:label/chain
  // Returns the full causal chain for a block: predecessors (cause→) + successors (→outcome).
  // Traverses prompted_by, based_on, supersedes, extends edges bidirectionally.
  router.get("/api/blocks/:label/chain", (req, res) => {
    try {
      const { label } = req.params;
      const maxDepth = Math.min(parseInt(req.query.depth as string) || 5, 10);

      const origin = db.getBlock(label);
      if (!origin) return res.status(404).json({ error: `Block not found: ${label}` });

      const allBlocks = db.getAllBlocks();
      const allRels = db.getAllRelations(false).filter((r: any) => r.status === "active");

      const blockById = new Map<string, any>(allBlocks.map((b: any) => [b.id, b]));

      const CAUSAL_RELS = CAUSAL_TRAVERSAL_RELS; // shared causal-thread set — relation-sets.ts (was a narrower straggler)

      // Build adjacency maps
      const outgoing = new Map<string, Array<{ targetId: string; type: string }>>();
      const incoming = new Map<string, Array<{ sourceId: string; type: string }>>();
      for (const rel of allRels) {
        if (!CAUSAL_RELS.has(rel.type)) continue;
        if (!outgoing.has(rel.source_id)) outgoing.set(rel.source_id, []);
        outgoing.get(rel.source_id)!.push({ targetId: rel.target_id, type: rel.type });
        if (!incoming.has(rel.target_id)) incoming.set(rel.target_id, []);
        incoming.get(rel.target_id)!.push({ sourceId: rel.source_id, type: rel.type });
      }

      const fmt = (b: any) => ({
        id: b.id, label: b.label, type: b.type,
        essence: (b.essence || "").slice(0, 120),
        flow_role: b.flow_role ?? null,
      });

      // BFS backward — predecessors (what caused / led to this block)
      const predecessors: Array<{ block: any; depth: number; via: string }> = [];
      const visitedBack = new Set<string>([origin.id]);
      let queue: Array<{ id: string; depth: number }> = [{ id: origin.id, depth: 0 }];
      while (queue.length > 0) {
        const { id, depth } = queue.shift()!;
        if (depth >= maxDepth) continue;
        for (const { targetId, type } of (outgoing.get(id) || [])) {
          if (visitedBack.has(targetId)) continue;
          const block = blockById.get(targetId);
          if (!block) continue;
          visitedBack.add(targetId);
          predecessors.push({ block, depth: depth + 1, via: type });
          queue.push({ id: targetId, depth: depth + 1 });
        }
      }

      // BFS forward — successors (what this block caused / led to)
      const successors: Array<{ block: any; depth: number; via: string }> = [];
      const visitedFwd = new Set<string>([origin.id]);
      queue = [{ id: origin.id, depth: 0 }];
      while (queue.length > 0) {
        const { id, depth } = queue.shift()!;
        if (depth >= maxDepth) continue;
        for (const { sourceId, type } of (incoming.get(id) || [])) {
          if (visitedFwd.has(sourceId)) continue;
          const block = blockById.get(sourceId);
          if (!block) continue;
          visitedFwd.add(sourceId);
          successors.push({ block, depth: depth + 1, via: type });
          queue.push({ id: sourceId, depth: depth + 1 });
        }
      }

      // Ordered chain: deepest predecessors first → origin → successors shallowest first
      const chain = [
        ...predecessors
          .sort((a, b) => b.depth - a.depth)
          .map(p => ({ ...fmt(p.block), direction: "predecessor" as const, via: p.via })),
        { ...fmt(origin), direction: "origin" as const, via: null },
        ...successors
          .sort((a, b) => a.depth - b.depth)
          .map(s => ({ ...fmt(s.block), direction: "successor" as const, via: s.via })),
      ];

      res.json({
        origin: fmt(origin),
        predecessors: predecessors.map(p => ({ ...fmt(p.block), via: p.via, depth: p.depth })),
        successors:   successors.map(s => ({ ...fmt(s.block), via: s.via, depth: s.depth })),
        chain,
      });
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  return router;
}
