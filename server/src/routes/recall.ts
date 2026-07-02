// routes/recall.ts — recall-fast, recall-smart, recall-chain, keyword search
// Reference: api-server.v1.ts lines 1472–2476
import { Router } from "express";
import { cosineSim } from "../engine/vector-math.js";
import { WorkspaceDB } from "../store/database.js";
import { EmbeddingEngine } from "../engine/embeddings.js";
import {
  sessionEvents, SESSION_EVENT_MAX,
  evaluateAlertsAfterRecall, incrementSessionEventCounter,
} from "./state.js";
import type { SessionRecallEvent } from "./state.js";

const RECALL_STOPWORDS = new Set([
  "the","is","a","an","to","of","in","for","on","with","and","or","but",
  "it","this","that","how","what","why","can","do","be","are","was","were",
  "will","you","your","me","my","we","our","so","now","get","got","let",
  "go","just","also","very","more","most","some","any","all","no","not",
  "have","has","had","been","would","could","should","may","might","must",
  "about","from","than","then","there","here","when","where","which","who",
  "did","does","its","their","them","they","these","those","into","out",
  "yes","okay","great","done","right","sure","good","bad","new","old",
  "system","model","approach","method","result","results","process",
  "way","means","make","makes","show","shows","use","uses","using",
  "work","works","need","needs","find","found","see","tell","know",
  "think","look","try","like","much","many","well","true","false",
  "ahead","alright","fixed","things","thing","something","anything",
  "session","fix","build","run","runs","running","restart","kill","start","stop",
  "test","tests","testing","done","check","checks","update","updates","updated",
  "change","changes","changed","add","added","adding","remove","removed","implement",
  "implemented","deploy","deployed","server","process","command","script","file","code",
  "solution","solutions","problem","problems","issue","issues","approach","approaches",
  "remediation","cause","causes","reason","reasons","error","errors","case","cases",
  "based","given","these","those","such","each","both","only","even","just",
]);

export function createRecallRouter(db: WorkspaceDB, embeddings?: EmbeddingEngine): Router {
  const router = Router();

  // ─── Keyword search ────────────────────────────────────────────────────────
  router.get("/api/search", (req, res) => {
    try {
      const q = (req.query.q as string) || "";
      const limit = Number(req.query.limit) || 5;
      if (!q) return res.json([]);
      const results = db.keywordSearch(q, limit);
      // Currency annotation — superseded blocks stay active (edge = currency, not status);
      // a bare search hit must carry what replaced it so stale can't read as current.
      const supersededBy = db.getSupersededByLabels(results.map((b) => b.id));
      const slim = results.map(({ embedding: _e, content: _c, ...b }) => ({
        ...b,
        ...(supersededBy.has(b.id) ? { superseded_by: supersededBy.get(b.id) } : {}),
      }));
      res.json(slim);
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  // ─── recall-fast ────────────────────────────────────────────────────────────
  router.get("/api/recall-fast", async (req, res) => {
    try {
      const q = (req.query.q as string) || "";
      const limit = Number(req.query.limit) || 3;
      const projectIds = ((req.query.project as string) || "").split(",").map(s => s.trim()).filter(Boolean);
      const blockTypes = ((req.query.types as string) || "").split(",").map(s => s.trim()).filter(Boolean);
      const strictScope = req.query.strict === "1";
      if (!q) return res.json([]);

      let scopedBlockIds: Set<string> | null = null;
      if (projectIds.length > 0) {
        const resolvedProjectIds = projectIds.map(pid => db.getBlock(pid)?.id ?? pid);
        const projectIdSet = new Set(resolvedProjectIds);
        const allActiveBlocks = db.getAllBlocks();
        scopedBlockIds = new Set<string>(resolvedProjectIds);
        for (const b of allActiveBlocks) {
          if (b.project_id && projectIdSet.has(b.project_id)) scopedBlockIds.add(b.id);
        }
      }

      const allTokens = q.toLowerCase().replace(/[^a-z0-9_ ]/g, " ").split(/\s+/)
        .filter((w) => w.length > 2 && !RECALL_STOPWORDS.has(w));
      if (allTokens.length === 0) return res.json([]);

      const conceptTerms = allTokens;
      const scored = new Map<string, { block: any; score: number }>();

      const kwResults = db.keywordSearch(allTokens.join(" "), limit * 5);
      for (const b of kwResults) {
        if (scopedBlockIds && !scopedBlockIds.has(b.id)) continue;
        const labelLower = (b.label || "").toLowerCase();
        const labelHits = allTokens.filter(t => labelLower.includes(t.toLowerCase())).length;
        const labelScore = labelHits >= 3 ? 1.8 : labelHits === 2 ? 1.5 : labelHits === 1 ? 1.2 : 1.0;
        scored.set(b.id, { block: b, score: labelScore });
      }

      if (conceptTerms.length > 0) {
        const conceptMatches = db.conceptSearch(conceptTerms);
        for (const [id, { block, matches }] of conceptMatches) {
          if (scopedBlockIds && !scopedBlockIds.has(id)) continue;
          const bonus = Math.min(matches * 0.5, 0.6);
          const existing = scored.get(id);
          if (existing) { existing.score += bonus; }
          else { scored.set(id, { block, score: bonus }); }
        }
      }

      const hop2Ids = new Set<string>();
      const hopConcepts = new Set<string>();
      const top5Hop1 = Array.from(scored.values()).sort((a, b) => b.score - a.score).slice(0, 5);
      for (const { block } of top5Hop1) {
        try {
          const blockConcepts: string[] = JSON.parse((block as any).concepts || "[]");
          for (const c of blockConcepts) { if (hopConcepts.size >= 20) break; hopConcepts.add(c.toLowerCase()); }
        } catch { /* ignore */ }
      }
      if (hopConcepts.size > 0 && allTokens.length >= 1) {
        const totalBlocks = db.getTotalBlockCount();
        const idfThreshold = Math.max(5, Math.floor(totalBlocks * 0.10));
        const specificConcepts = [...hopConcepts].filter(c => db.countBlocksWithConcept(c) <= idfThreshold);
        const hopMatches = specificConcepts.length > 0 ? db.conceptSearch(specificConcepts) : new Map();
        for (const [id, { block, matches }] of hopMatches) {
          if (scopedBlockIds && !scopedBlockIds.has(id)) continue;
          const bonus = Math.min(matches * 0.25, 0.75);
          const existing = scored.get(id);
          if (existing) { existing.score += bonus * 0.5; }
          else { scored.set(id, { block, score: bonus }); hop2Ids.add(id); }
        }
      }

      if (projectIds.length > 0) {
        const allRelations = db.getAllRelations(false);
        const projectLinkedIds = new Set<string>(projectIds);
        for (const r of allRelations) {
          if (projectIds.includes(r.source_id)) projectLinkedIds.add(r.target_id);
          if (projectIds.includes(r.target_id)) projectLinkedIds.add(r.source_id);
        }
        for (const entry of scored.values()) { if (projectLinkedIds.has(entry.block.id)) entry.score *= 1.1; }
      }

      for (const entry of scored.values()) {
        if (entry.block.type === "insight") entry.score *= 1.3;
        try { const c = JSON.parse(entry.block.content || "{}"); if (c?.reasoning_chain || c?.derivation) entry.score *= 1.2; } catch { /* ignore */ }
        const st = entry.block.source_type || "agent_derived";
        if (st === "agent_derived" || st === "derived_from_blocks") entry.score *= 1.05;
      }

      for (const [id, entry] of scored.entries()) {
        if (hop2Ids.has(id)) continue;
        const raw = entry.block.quality_score;
        const qScore = (typeof raw === "number" && raw > 0) ? raw : 3;
        entry.score *= 0.75 + (qScore / 6) * 0.25;
      }

      const minQuality = Number(req.query.min_quality) || 0;
      // Bug 1 fix (2026-05-28): q=0 used to be an unconditional reject — but
      // STRUCTURAL_TYPES (project, process) historically shipped at q=0
      // (pipeline didn't call computeQualityScore on them; only manual POST
      // paths did). That conflated "junk content" with "structurally-empty
      // container," making recall-fast?types=project return zero hits for any
      // query. Part A (stampQualityScore in pipeline) now sets a real score on
      // new structural blocks; this guard catches the long tail (old blocks +
      // any code path that misses Part A). Charter rule 6: defense-in-depth.
      const STRUCTURAL_TYPES = ["project", "process"];
      let ranked = Array.from(scored.values()).filter(({ score, block }) => {
        if (score < 0.2) return false;
        const q = block.quality_score ?? 0;
        if (q === 0 && !STRUCTURAL_TYPES.includes(block.type)) return false;
        if (minQuality > 0 && q < minQuality) return false;
        if (blockTypes.length > 0 && !blockTypes.includes(block.type)) return false;
        return true;
      }).sort((a, b) => b.score - a.score).slice(0, limit);

      if (scopedBlockIds && ranked.length < 2 && !strictScope) {
        const unscopedScored = new Map<string, { block: any; score: number }>();
        const kwAll = db.keywordSearch(allTokens.join(" "), limit * 5);
        for (const b of kwAll) {
          if (scopedBlockIds.has(b.id)) continue;
          const labelLower = (b.label || "").toLowerCase();
          const labelHits = allTokens.filter(t => labelLower.includes(t.toLowerCase())).length;
          const labelScore = labelHits >= 3 ? 1.8 : labelHits === 2 ? 1.5 : labelHits === 1 ? 1.2 : 1.0;
          unscopedScored.set(b.id, { block: b, score: labelScore });
        }
        if (conceptTerms.length > 0) {
          const conceptMatches = db.conceptSearch(conceptTerms);
          for (const [id, { block, matches }] of conceptMatches) {
            if (scopedBlockIds.has(id)) continue;
            const bonus = Math.min(matches * 0.5, 0.6);
            const existing = unscopedScored.get(id);
            if (existing) { existing.score += bonus; } else { unscopedScored.set(id, { block, score: bonus }); }
          }
        }
        for (const entry of unscopedScored.values()) {
          const raw = entry.block.quality_score;
          const qScore = (typeof raw === "number" && raw > 0) ? raw : 3;
          entry.score *= 0.75 + (qScore / 6) * 0.25;
        }
        const fallback = Array.from(unscopedScored.values()).filter(({ score, block }) => {
          if (score < 0.2) return false;
          const q = block.quality_score ?? 0;
          // Bug 1 fix: same structural-type exemption as the primary filter above.
          if (q === 0 && !STRUCTURAL_TYPES.includes(block.type)) return false;
          if (blockTypes.length > 0 && !blockTypes.includes(block.type)) return false;
          return true;
        }).sort((a, b) => b.score - a.score).slice(0, limit - ranked.length);
        ranked = [...ranked, ...fallback];
      }

      const resultIds = ranked.map(({ block }) => block.id);
      const challengesMap = db.getChallengesForBlocks(resultIds);
      const incomingMap = db.getIncomingCounts(resultIds);

      const decayRates: Record<string, number> = { session: 2.0, "1hr": 1.0, "24hr": 0.5, "1week": 0.1, project: 0.01, permanent: 0.001 };
      const maxBaseScore = Math.max(...ranked.map(r => r.score), 1);
      const rankedWithComposite = ranked.map(({ block, score: rawScore }) => {
        const normScore  = rawScore / maxBaseScore;
        const ageDays    = (Date.now() - new Date(block.created_at).getTime()) / 86400000;
        const decayRate  = decayRates[block.ttl ?? "permanent"] ?? 0.01;
        const recency    = 1 / (1 + ageDays * decayRate);
        const compositeScore = normScore * recency;
        return { block, similarity: normScore, composite_score: compositeScore, pick_components: { similarity: Math.round(normScore * 10000) / 10000, recency: Math.round(recency * 10000) / 10000 } };
      }).sort((a, b) => b.composite_score - a.composite_score);

      const pickReason: string | undefined = undefined;
      const _allBlocksForCoord = db.getAllBlocks();
      const _blockMapForCoord = new Map(_allBlocksForCoord.map((b: any) => [b.id, b]));
      function resolveProject(blockId: string): { id: string; label: string } | null {
        const b = _blockMapForCoord.get(blockId) as any;
        if (!b) return null;
        if (b.type === "project") return { id: b.id, label: b.label };
        if (!b.project_id) return null;
        const proj = _blockMapForCoord.get(b.project_id) as any;
        return proj ? { id: proj.id, label: proj.label } : null;
      }

      const results = rankedWithComposite.map(({ block, composite_score, pick_components }, idx) => {
        const proj = resolveProject(block.id);
        return {
          id: block.id, label: block.label, type: block.type, essence: block.essence,
          quality_score: block.quality_score,
          source_type: block.source_type || "agent_derived",
          incoming_count: incomingMap.get(block.id) ?? 0,
          challenges: challengesMap.get(block.id) ?? [],
          composite_score: Math.round(composite_score * 10000) / 10000,
          project_id: proj?.id ?? null, project_label: proj?.label ?? null,
          pick_components: { similarity: Math.round(pick_components.similarity * 10000) / 10000, recency: Math.round(pick_components.recency * 10000) / 10000 },
          ...(idx === 0 && pickReason ? { pick_reason: pickReason } : {}),
        };
      });

      if (sessionEvents.length < SESSION_EVENT_MAX) {
        const recalledItems = results.map((r: any) => ({
          label: r.label, type: r.type,
          project: r.project_label ?? (r.label || "").split("_")[0] ?? "unknown",
          quality: r.quality_score ?? 0,
        }));
        const activeProj = (results[0] as any)?.project_label ?? "";
        const crossProjectCount = activeProj ? recalledItems.filter(r => r.project !== activeProj && r.project !== "unknown").length : 0;
        const projectCount = db.getAllBlocks().filter((b: any) => b.type === "project").length;
        sessionEvents.push({ id: incrementSessionEventCounter(), timestamp: new Date().toISOString(), type: "recall", query: q, recalled: recalledItems, cross_project_count: crossProjectCount, total_injected: recalledItems.length, project_count: projectCount } as SessionRecallEvent);
        evaluateAlertsAfterRecall(sessionEvents[sessionEvents.length - 1] as SessionRecallEvent);
      }

      res.json(results);
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  // ─── recall-smart ────────────────────────────────────────────────────────────
  router.get("/api/recall-smart", async (req, res) => {
    try {
      const q = (req.query.q as string) || "";
      const limit = Math.min(Number(req.query.limit) || 5, 20);
      const agentId = (req.query.agent_id as string) || "";
      const explicitProject = (req.query.project as string) || "";
      const minTicks = Number(req.query.min_ticks) || 1;

      if (!q) return res.json({ results: [], meta: { query_tokens: [], active_project: null, total_candidates: 0 } });

      function stem(word: string): string {
        if (word.length < 4) return word;
        if (word.endsWith("ation"))  return word.slice(0, -5);
        if (word.endsWith("tion"))   return word.slice(0, -4);
        if (word.endsWith("sion"))   return word.slice(0, -4);
        if (word.endsWith("ment"))   return word.slice(0, -4);
        if (word.endsWith("ness"))   return word.slice(0, -4);
        if (word.endsWith("ity"))    return word.slice(0, -3);
        if (word.endsWith("age"))    return word.slice(0, -3);
        if (word.endsWith("ing"))    return word.slice(0, -3);
        if (word.endsWith("ed"))     return word.slice(0, -2);
        if (word.endsWith("er"))     return word.slice(0, -2);
        if (word.endsWith("ion"))    return word.slice(0, -3);
        if (word.endsWith("al"))     return word.slice(0, -2);
        if (word.endsWith("ly"))     return word.slice(0, -2);
        if (word.endsWith("s") && word.length > 4) return word.slice(0, -1);
        return word;
      }

      const rawTokens = q.toLowerCase().replace(/[^a-z0-9_\- ]/g, " ").split(/\s+/).filter(w => w.length > 1 && !RECALL_STOPWORDS.has(w));
      const tokenPairs: Array<{ raw: string; stem: string }> = rawTokens.map(w => ({ raw: w, stem: stem(w) }));
      const tokens = rawTokens;

      if (tokens.length === 0) return res.json({ results: [], meta: { query_tokens: [], active_project: null, total_candidates: 0 } });

      let queryEmbedding: number[] | null = null;
      if (embeddings?.isAvailable()) queryEmbedding = await embeddings.embed(q).catch(() => null);

      let activeProjectLabel: string | null = null;
      if (explicitProject) {
        const projBlock = db.getBlock(explicitProject);
        activeProjectLabel = projBlock?.label ?? explicitProject;
      } else if (agentId) {
        const cutoff = Date.now() - 30 * 60 * 1000;
        const recentAccessed = db.getAllBlocks().filter((b: any) => b.last_accessed && new Date(b.last_accessed).getTime() > cutoff && b.type !== "project" && b.status === "active").sort((a: any, b: any) => new Date(b.last_accessed).getTime() - new Date(a.last_accessed).getTime()).slice(0, 15);
        if (recentAccessed.length > 0) {
          const projectCounts = new Map<string, number>();
          for (const b of recentAccessed) { const prefix = (b as any).label?.split("_")[0]; if (prefix && prefix.length > 1) projectCounts.set(prefix, (projectCounts.get(prefix) || 0) + 1); }
          if (projectCounts.size > 0) activeProjectLabel = [...projectCounts.entries()].sort((a, b) => b[1] - a[1])[0][0];
        }
      }

      const kwCandidates = db.keywordSearch(tokens.join(" "), 200) as any[];
      const conceptCandidates = tokens.length > 0 ? [...db.conceptSearch(tokens).values()].map((v: any) => v.block) : [];
      const candidateMap = new Map<string, any>();
      for (const b of [...kwCandidates, ...conceptCandidates]) { if (b && b.id && b.status === "active") candidateMap.set(b.id, b); }
      const candidates = candidateMap.size >= 10 ? [...candidateMap.values()] : db.getAllBlocks().filter((b: any) => b.status === "active" && b.type !== "project");

      type MatchBreakdown = { label_segments: string[]; essence: string[]; unique_keys: string[]; unique_values: string[]; concepts: string[]; project_context: string[] };
      const scored: Array<{ block: any; score: number; ticks: number; breakdown: MatchBreakdown; semanticSim: number }> = [];
      const embeddingMap = new Map<string, number[]>();
      if (queryEmbedding) {
        for (const b of candidates) {
          if (b.embedding) { try { const vec = typeof b.embedding === "string" ? JSON.parse(b.embedding) : b.embedding; if (Array.isArray(vec)) embeddingMap.set(b.id, vec); } catch { /* skip */ } }
        }
      }

      function matchesToken(text: string, pair: { raw: string; stem: string }): boolean {
        if (text.includes(pair.raw)) return true;
        const stemText = stem(text.replace(/[-_]/g, ""));
        return stemText.includes(pair.stem) || text.includes(pair.stem);
      }

      for (const block of candidates) {
        const bd: MatchBreakdown = { label_segments: [], essence: [], unique_keys: [], unique_values: [], concepts: [], project_context: [] };
        const segs = (block.label || "").toLowerCase().split("_");
        for (let i = 1; i < segs.length; i++) {
          const seg = segs[i].replace(/-/g, " ");
          const dimLabel = i === 1 ? "entity" : i === segs.length - 1 ? "concept" : "type";
          for (const pair of tokenPairs) { if (matchesToken(seg, pair)) bd.label_segments.push(`${pair.raw}→${dimLabel}:${segs[i]}`); }
        }
        const essenceLower = (block.essence || "").toLowerCase();
        for (const pair of tokenPairs) { if (matchesToken(essenceLower, pair)) bd.essence.push(pair.raw); }
        try {
          const raw = typeof block.content === "string" ? JSON.parse(block.content) : (block.content || {});
          const unique = raw?.unique || {};
          for (const [key, val] of Object.entries(unique)) {
            const keyLower = key.toLowerCase().replace(/_/g, " ");
            const valLower = String(val).toLowerCase();
            for (const pair of tokenPairs) {
              if (matchesToken(keyLower, pair)) { bd.unique_keys.push(`${pair.raw}→key:${key}`); }
              else if (matchesToken(valLower, pair)) { bd.unique_values.push(`${pair.raw}→val:${key}`); }
            }
          }
        } catch { /* malformed content */ }
        try {
          const conceptTags: string[] = JSON.parse(block.concepts || "[]");
          for (const c of conceptTags) { const cNorm = c.toLowerCase().replace(/[-_]/g, " "); for (const pair of tokenPairs) { if (matchesToken(cNorm, pair)) bd.concepts.push(`${pair.raw}→${c}`); } }
        } catch { /* skip */ }
        if (activeProjectLabel && (block.label || "").startsWith(activeProjectLabel + "_")) bd.project_context.push(`project:${activeProjectLabel}`);

        const ticks = bd.label_segments.length + bd.essence.length + bd.unique_keys.length + bd.unique_values.length + bd.concepts.length + bd.project_context.length;
        const blockVec = embeddingMap.get(block.id);
        const semanticSim = (queryEmbedding && blockVec) ? cosineSim(queryEmbedding, blockVec) : 0;
        if (ticks < minTicks && semanticSim < 0.5) continue;

        let structScore = 0;
        structScore += bd.label_segments.length * 2.0;
        structScore += bd.essence.length       * 1.5;
        structScore += bd.unique_keys.length   * 2.5;
        structScore += bd.unique_values.length * 1.0;
        structScore += bd.concepts.length      * 0.5;
        structScore += bd.project_context.length * 1.5;

        const normStruct = Math.min(structScore / 20, 1.0);
        const blended = (normStruct * 0.6) + (semanticSim * 0.4);

        const DEAD_END_SIGNALS = ["why", "rejected", "failed", "abandoned", "not", "avoid", "revert", "dropped", "gave up"];
        const queryHasDeadEndSignal = DEAD_END_SIGNALS.some(s => q.toLowerCase().includes(s));
        const deadEndBoost = (block.type === "dead_end" && queryHasDeadEndSignal) ? 1.5 : 1.0;
        const qScore = typeof block.quality_score === "number" && block.quality_score > 0 ? block.quality_score : 3;
        const finalScore = blended * (0.75 + (qScore / 6) * 0.25) * deadEndBoost;
        scored.push({ block, score: finalScore, ticks, breakdown: bd, semanticSim });
      }

      scored.sort((a, b) => b.score === a.score ? b.ticks - a.ticks : b.score - a.score);
      const scopedScored = explicitProject && activeProjectLabel ? scored.filter(({ block }) => (block.label || "").startsWith(activeProjectLabel + "_") || block.label === activeProjectLabel) : scored;
      const toSlice = (explicitProject && scopedScored.length === 0) ? scored : scopedScored;
      const top = toSlice.slice(0, limit);

      const results = top.map(({ block, score, ticks, breakdown, semanticSim }) => {
        const parts: string[] = [];
        if (breakdown.label_segments.length) parts.push(`label[${breakdown.label_segments.join(", ")}]`);
        if (breakdown.essence.length)         parts.push(`essence[${breakdown.essence.join(", ")}]`);
        if (breakdown.unique_keys.length)     parts.push(`field[${breakdown.unique_keys.join(", ")}]`);
        if (breakdown.unique_values.length)   parts.push(`value[${breakdown.unique_values.join(", ")}]`);
        if (breakdown.concepts.length)        parts.push(`concept[${breakdown.concepts.join(", ")}]`);
        if (breakdown.project_context.length) parts.push(`context[${breakdown.project_context[0]}]`);
        if (ticks === 0 && semanticSim > 0.5) parts.push(`semantic[sim:${Math.round(semanticSim * 100)}%]`);
        return { id: block.id, label: block.label, type: block.type, essence: block.essence, quality_score: block.quality_score, ticks, score: Math.round(score * 1000) / 1000, semantic_sim: Math.round(semanticSim * 1000) / 1000, match_reason: parts.join(" | "), breakdown };
      });

      if (sessionEvents.length < SESSION_EVENT_MAX) {
        const activeProj = activeProjectLabel ?? "";
        const recalledItems = results.map((r: any) => { const proj = (r.label || "").split("_")[0] ?? "unknown"; return { label: r.label, type: r.type, project: proj, quality: r.quality_score ?? 0 }; });
        const crossProjectCount = activeProj ? recalledItems.filter((r: any) => r.project !== activeProj && r.project !== "unknown").length : 0;
        const projectCount = db.getAllBlocks().filter((b: any) => b.type === "project").length;
        sessionEvents.push({ id: incrementSessionEventCounter(), timestamp: new Date().toISOString(), type: "recall", query: q, recalled: recalledItems, cross_project_count: crossProjectCount, total_injected: recalledItems.length, project_count: projectCount } as SessionRecallEvent);
        evaluateAlertsAfterRecall(sessionEvents[sessionEvents.length - 1] as SessionRecallEvent);
      }

      res.json({ results, meta: { query_tokens: tokens, stemmed_pairs: tokenPairs.map(p => p.raw !== p.stem ? `${p.raw}→${p.stem}` : p.raw), semantic_enabled: !!queryEmbedding, active_project: activeProjectLabel, total_candidates: candidates.length, total_scored: scored.length } });
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  // ─── recall-chain ────────────────────────────────────────────────────────────
  router.get("/api/recall-chain", (req, res) => {
    try {
      const q = (req.query.q as string) || "";
      const limit = Math.min(Number(req.query.limit) || 2, 4);
      const minQuality = Number(req.query.min_quality) || 3;
      if (!q) return res.json({ chains: [] });

      const queryTerms = q.toLowerCase().replace(/[^a-z0-9_ ]/g, " ").split(/\s+/).filter(w => w.length > 3);
      if (queryTerms.length === 0) return res.json({ chains: [] });

      const allBlocks = db.getAllBlocks();
      const candidates = allBlocks.filter(b => {
        if (b.status === "archived") return false;
        let content: Record<string, unknown> = {};
        try { content = JSON.parse(b.content as string || "{}"); } catch { return false; }
        const hasDerivation = !!(content.derivation);
        const hasProblem = !!((content.save_context as Record<string,unknown>)?.problem_being_solved);
        if (!hasDerivation && !hasProblem) return false;
        if (!hasDerivation && (b.quality_score ?? 0) < minQuality) return false;
        return true;
      });

      const scored = candidates.map(block => {
        let content: Record<string, unknown> = {};
        try { content = JSON.parse(block.content as string || "{}"); } catch { /* ok */ }
        const saveCtx = content.save_context as Record<string, unknown> | undefined;
        const derivation = content.derivation as Record<string, unknown> | undefined;
        const searchText = [block.essence, saveCtx?.problem_being_solved, derivation?.logic].filter(Boolean).join(" ").toLowerCase();
        const matches = queryTerms.filter(t => searchText.includes(t)).length;
        return { block, score: matches / Math.max(queryTerms.length, 1), saveCtx, derivation };
      }).filter(x => x.score > 0).sort((a, b) => b.score - a.score).slice(0, limit);

      type InputBlock = { id: string; label: string; essence: string };
      const chains = scored.map(({ block, saveCtx, derivation }) => {
        const inputs: InputBlock[] = (derivation?.inputs as InputBlock[]) || [];
        return {
          problem: (saveCtx?.problem_being_solved as string) || block.essence.slice(0, 80),
          tip: { id: block.id, label: block.label, conclusion: block.essence, type: block.type, role: "synthesis", logic: (derivation?.logic as string)?.slice(0, 200) || null },
          chain: inputs.map(inp => ({ id: inp.id, label: inp.label, essence: (inp.essence || "").slice(0, 100), role: "premise" })),
        };
      });

      res.json({ chains });
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  return router;
}
