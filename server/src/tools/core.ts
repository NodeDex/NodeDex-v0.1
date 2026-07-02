import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { WorkspaceDB } from "../store/database.js";
import { EmbeddingEngine, blockEmbeddingText } from "../engine/embeddings.js";
import { ok, err, cosineSim, assembleBlockChains, filterRootsByConcepts } from "./helpers.js";

// ─── Keyword concept extractor ───────────────────────────────────
// Extracts meaningful tokens from text as placeholder concepts.
// Not abstract (that's the agent's job) but better than nothing.
const CONCEPT_STOPWORDS = new Set([
  "the","is","a","an","to","of","in","for","on","with","and","or","but",
  "it","this","that","how","what","why","can","do","be","are","was","were",
  "will","i","my","we","our","use","used","using","new","all","one","two",
  "via","way","when","where","which","who","would","should","could","may",
  "might","must","let","get","has","have","had","been","its","their","they",
  "them","from","than","then","there","these","those","into","out","over",
  "under","through","about","without","approach","method","system","based",
  "make","allows","enables","provides","ensure","ensures","called","known",
  "defined","given","contains","requires","return","returns","define",
]);

function extractKeywordConcepts(texts: string[]): string[] {
  const words = texts.join(" ")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 3 && !CONCEPT_STOPWORDS.has(w));
  return [...new Set(words)].slice(0, 6);
}

export function registerCoreTools(server: McpServer, db: WorkspaceDB, embeddings: EmbeddingEngine): void {

  // ─── Tool: workspace_remember ────────────────────────────────────
  server.tool(
    "workspace_remember",
    `EDGE / escape-hatch — you rarely call this. A background pipeline already extracts facts, decisions, dead-ends, constraints, insights, etc. from your conversation automatically. Use workspace_remember ONLY to: fix a graph error, deliberately seed a block, or coordinate in a multi-agent setup. In normal work just DO the work — the pipeline captures it.

FIELDS:
- essence: One-line description — what this IS (REQUIRED)
- is_a: Parent category (e.g. 'pricing_model', 'api_provider', 'debugging_technique')
- unique: Key-value pairs of what makes this distinct
- has: Properties, components, steps (for process blocks: put the procedure steps here)
- concepts: IMPORTANT — abstract concept tags that enable cross-domain retrieval.
    Tag with domain-agnostic patterns, not just topic words.
    Example: a debugging process → ['systematic_elimination', 'hypothesis_testing', 'isolation']
    Good concepts let this block surface when future problems share the PATTERN, not just the topic.
- relations: Links to other blocks (e.g. triggered_by, based_on, part_of)

COMMON BLOCK TYPES (epistemic — your relationship to the knowledge; full schemas → docs/reference/block-types.md):
- fact        → an observation or measurement that changed understanding
- decision    → a choice made and why (binding — don't re-open unless asked)
- dead_end    → an approach tried and ABANDONED, and why (this is what Rule 1 checks against — protects future agents from repeating it)
- constraint  → an external limit that cannot be overridden
- insight     → a conclusion from combining multiple facts
- question    → a known unknown, still open (workspace_gaps() surfaces these)
- hypothesis  → proposed but not yet verified
- preference  → a standing lean, not a committed choice
- entity      → a named thing (person, system, organization)
- process     → a SKILL / PROCEDURE — put steps in has:{}
- note        → catch-all when nothing sharper fits

For skills/procedures: type='process', steps in has:{}, abstract patterns in concepts:[].`,
    {
      label: z.string().describe("Block label (lowercase, underscore-separated, e.g. 'vapi_pricing')"),
      type: z
        .string()
        .describe("Block type (e.g., 'fact', 'decision', 'note', or a custom type)"),
      essence: z.string().describe("One-line description of this block's core meaning"),
      is_a: z
        .string()
        .optional()
        .describe("Parent category or what this is a type of (e.g., 'pricing_data', 'voice_api', 'person')"),
      unique: z
        .record(z.string(), z.string())
        .optional()
        .describe("Key-value pairs of what makes this distinct (e.g., { price: '$0.12/min', model: 'flat_rate' })"),
      has: z
        .record(z.string(), z.union([z.string(), z.array(z.string())]))
        .optional()
        .describe("Properties, components, features (e.g., { features: ['voice', 'realtime'], limitations: ['no SMS'] })"),
      concepts: z
        .array(z.string())
        .optional()
        .describe("Abstract tags or ideas (e.g., ['voice_api', 'pricing', 'saas'])"),
      source: z
        .string()
        .optional()
        .describe("Where this information came from"),
      ttl: z
        .enum(["session", "1hr", "24hr", "1week", "project", "permanent"])
        .optional()
        .describe("Time-to-live. Default: permanent"),
      priority: z
        .enum(["high", "medium", "low"])
        .optional()
        .describe("Importance signal — high: check before acting, medium: notable, low: background. Shown in tree view."),
      flow_role: z
        .enum(["problem", "cause", "mechanism", "outcome", "solution", "trigger"])
        .optional()
        .describe("Semantic position in a reasoning chain — problem→cause→mechanism→outcome. Enriches chain view."),
      is_sensitive: z
        .boolean()
        .optional()
        .describe("If true, essence and content will be encrypted in the database using AES-256. (Requires WORKSPACE_ENCRYPTION_KEY env var)"),
      relations: z
        .array(
          z.object({
            type: z.string().describe("Relation type (e.g., 'uses', 'related_to', 'part_of')"),
            target_id: z.string().describe("Target block ID or label"),
          })
        )
        .optional()
        .describe("Relations to existing blocks"),
      agent_id: z
        .string()
        .optional()
        .describe("Agent name or ID saving this block (e.g., 'planner', 'coder', 'claude'). Used for attribution."),
      project_id: z
        .string()
        .optional()
        .describe("Project block ID or label to assign this block to"),
      force: z
        .boolean()
        .optional()
        .describe("If true, save even when a semantic conflict is detected. Default: false"),
      save_context: z
        .object({
          trigger: z.string().optional().describe("Why you are saving this block right now — the insight or question that prompted it"),
          triggered_by: z.array(z.string()).optional().describe("Block IDs or labels that you were reading when this insight occurred. Creates prompted_by relations."),
          problem_being_solved: z.string().optional().describe("What problem or question this block addresses"),
          block_role: z.enum(["foundation", "derived", "synthesis"]).optional().describe("foundation=others will build from this, derived=builds on existing blocks, synthesis=bridges multiple clusters"),
        })
        .optional()
        .describe("Why this block is being saved right now. Preserves cognitive context that the block content alone cannot capture."),
    },
    async (params) => {
      try {
        // ── Label duplicate check ──────────────────────────────────
        const existing = db.keywordSearch(params.label, 3);
        const duplicate = existing.find(
          (b) => b.label.toLowerCase() === params.label.toLowerCase()
        );
        if (duplicate) {
          // Multi-agent conflict: different agent trying to save same label
          if (duplicate.created_by && params.agent_id && duplicate.created_by !== params.agent_id) {
            return err("AGENT_CONFLICT",
              `Block '${duplicate.label}' was already saved by agent '${duplicate.created_by}'. ` +
              `Use workspace_update to modify it, or workspace_challenge if you believe it is incorrect.`,
              { existing_block: { id: duplicate.id, label: duplicate.label, essence: duplicate.essence, created_by: duplicate.created_by } }
            );
          }
          return err("DUPLICATE_DETECTED",
            `Similar block exists: '${duplicate.label}' (id: ${duplicate.id}). Use workspace_update instead.`,
            { existing_block: { id: duplicate.id, label: duplicate.label, essence: duplicate.essence } }
          );
        }

        // ── Near-duplicate detection ───────────────────────────────
        // High similarity (>0.88) = probably the same block with different wording.
        // Warn the agent rather than silently creating redundant knowledge.
        if (!params.force && embeddings.isAvailable()) {
          const vec = await embeddings.embed(params.essence);
          if (vec) {
            const nearMatches = db.semanticSearch(vec, 3, undefined, 0.88);
            for (const match of nearMatches) {
              if (match.label.toLowerCase() === params.label.toLowerCase()) continue;
              // Register this as an open conflict for review
              const vec2 = await embeddings.embed(match.essence);
              const sim = vec && vec2 ? cosineSim(vec, vec2) : 0.9;
              // Save incoming block first so we can register conflict between the two
              // (We'll log a temporary "pending_save" label for tracing)
              try { db.createConflict(match.id, match.id, sim); } catch { /* non-critical */ }
              return err("NEAR_DUPLICATE",
                `Block '${match.label}' (${match.id}) is very similar to what you're saving (similarity: ${Math.round(sim * 100)}%). ` +
                `This is probably the same knowledge with different wording. ` +
                `Options: (1) workspace_update('${match.id}', ...) to update it, ` +
                `(2) workspace_resolve_conflict to merge, ` +
                `(3) force:true to save anyway.`,
                {
                  similar_block: { id: match.id, label: match.label, essence: match.essence },
                  similarity:    Math.round(sim * 100) / 100,
                  your_essence:  params.essence,
                }
              );
            }
          }
        }

        // ── Auto-concepts if none provided ─────────────────────────
        // Extracts keyword-level concepts immediately (zero latency, no API).
        // These are placeholder concepts — the agent should improve them with
        // workspace_update(id, {concepts:[...]}) using more abstract patterns.
        const agentConcepts = params.concepts ?? [];
        const autoConceptsGenerated = agentConcepts.length === 0;
        const finalConcepts = agentConcepts.length > 0
          ? agentConcepts
          : extractKeywordConcepts([
              params.label.replace(/_/g, " "),
              params.essence,
              params.is_a ?? "",
            ]);

        // Build structured content
        const content: Record<string, unknown> = {};
        if (params.is_a) content.is_a = params.is_a;
        if (params.unique) content.unique = params.unique;
        if (params.has) content.has = params.has;
        content.concepts = finalConcepts;
        if (params.save_context) content.save_context = params.save_context;
        // Track concept origin so enrichment never overwrites agent-tagged concepts
        content.concepts_source = agentConcepts.length > 0 ? "agent" : "keyword_auto";

        // Embedding — canonical recipe (essence + concepts), Tier 2 cleanup 2026-06-15.
        // Was a contextual "[label | type | project] / related_to: …" header (the old
        // "Change 4"). Dropped so a manually-remembered block embeds with the SAME recipe
        // as a pipeline block — otherwise the cosine drifts when these are compared
        // stored-vs-stored (dedup / Stage-D / Pass-4). Uses finalConcepts (what the block
        // is actually stored with at createBlock below), not the raw params. See
        // blockEmbeddingText for the recipe rationale.
        const embedding = await embeddings.embed(
          blockEmbeddingText({ essence: params.essence, concepts: finalConcepts }),
        );

        // Create block
        const block = db.createBlock({
          label: params.label,
          type: params.type,
          essence: params.essence,
          content,
          concepts: finalConcepts,
          ttl: params.type === "dead_end" ? "permanent" : (params.ttl || "permanent"),
          source: params.source,
          created_by: params.agent_id,
          embedding: embedding || undefined,
          is_sensitive: params.is_sensitive || false,
          ...(params.priority  ? { priority:  params.priority  } : {}),
          ...(params.flow_role ? { flow_role: params.flow_role } : {}),
        });

        // Create explicit relations
        const explicitRelTypes = new Set<string>();
        if (params.relations) {
          for (const rel of params.relations) {
            const targetBlock = db.getBlock(rel.target_id);
            if (targetBlock) {
              db.createRelation({
                source_id: block.id,
                target_id: targetBlock.id,
                type: rel.type,
                bidirectional: true,
              });
              explicitRelTypes.add(rel.type);
            }
          }
        }

        // Create prompted_by relations from save_context.triggered_by
        if (params.save_context?.triggered_by?.length) {
          for (const targetRef of params.save_context.triggered_by) {
            const targetBlock = db.getBlock(targetRef);
            if (targetBlock) {
              db.createRelation({
                source_id: block.id,
                target_id: targetBlock.id,
                type: "prompted_by",
                created_by: params.agent_id || "agent",
              });
            }
          }
        }

        // No auto-link: agent must explicitly specify part_of relations.
        // Blind auto-linking to the first project causes hub contamination.

        // ── Quality score — immediate feedback on block depth ────────
        const qc = (() => { try { return typeof block.content === "string" ? JSON.parse(block.content) : (block.content || {}); } catch { return {}; } })();
        const qMissing: string[] = [];
        let qScore = 1; // essence always present
        if (qc.is_a)                                              qScore++; else qMissing.push("is_a");
        if (qc.unique && Object.keys(qc.unique).length >= 2)     qScore++; else qMissing.push("unique{} (≥2 props)");
        if (finalConcepts.length >= 3)                            qScore++; else qMissing.push(`concepts (have ${finalConcepts.length}, need ≥3)`);
        // project-root blocks earn this point automatically — children link to them later
        if (params.type === "project") {
          qScore++;
        } else {
          const savedRelCount = db.getRelations(block.id).length;
          if (savedRelCount > 0) qScore++; else qMissing.push("relations");
        }

        // Persist quality score so recall ranking can use it without recomputing
        db.updateBlock(block.id, { quality_score: Math.min(qScore, 5) });

        const result: Record<string, unknown> = {
          id:                 block.id,
          label:              block.label,
          type:               block.type,
          status:             block.status,
          created_by:         block.created_by || null,
          concepts:           finalConcepts,
          embedding_generated: embedding !== null,
          quality: {
            score: qScore,
            max: 6,
            thin: qScore < 3,
            missing: qMissing,
          },
        };

        if (qScore < 3) {
          result.quality_hint = `Block is thin (${qScore}/6). Missing: ${qMissing.slice(0, 2).join(", ")}. Call workspace_review("${block.id}") for Gemini suggestions, or add fields now.`;
        }

        // ── Tag vocabulary hints ─────────────────────────────────────
        // Surface concept tags that are new to the workspace vocabulary.
        // Helps agents reuse existing tags instead of fragmenting the concept graph.
        if (agentConcepts.length > 0) {
          const allBlocks = db.getAllBlocks();
          const existingTagSet = new Set<string>();
          for (const b of allBlocks) {
            if (b.id === block.id) continue; // exclude the block we just saved
            const tags: string[] = JSON.parse(b.concepts || "[]");
            for (const t of tags) existingTagSet.add(t);
          }
          const newTags: Array<{ tag: string; similar_existing: string[] }> = [];
          for (const tag of agentConcepts) {
            if (existingTagSet.has(tag)) continue; // already in vocabulary
            // Find existing tags that share a common prefix (first 5 chars) or substring
            const similar = [...existingTagSet].filter(t =>
              t !== tag && (
                t.startsWith(tag.slice(0, 5)) ||
                tag.startsWith(t.slice(0, 5)) ||
                t.includes(tag.slice(0, 6)) ||
                tag.includes(t.slice(0, 6))
              )
            ).slice(0, 2);
            newTags.push({ tag, similar_existing: similar });
          }
          if (newTags.length > 0) {
            result.tag_hints = newTags.map(t =>
              t.similar_existing.length > 0
                ? `'${t.tag}' is new — similar existing: ${t.similar_existing.map(s => `'${s}'`).join(", ")}. Reuse if meaning matches.`
                : `'${t.tag}' is new to the vocabulary.`
            );
          }
        }

        // Nudge agent to improve auto-extracted concepts with abstract patterns
        if (autoConceptsGenerated) {
          result.concepts_source = "keyword_auto";
          result.concepts_hint =
            `Concepts were auto-extracted from your text. For cross-domain retrieval to work well, ` +
            `update with abstract patterns: workspace_update("${block.id}", { ` +
            `concepts: ["pattern_name", "abstract_principle", ...] })`;
        }

        // ── Coordinates check: flag missing causal chain ──────────────────
        // Every block except projects needs triggered_by — it is the primary coordinate.
        // "What block was I reading when this occurred to me?"
        // If the cause isn't in the graph yet → create it first, then re-save with triggered_by.
        if (block.type !== "project") {
          const hasCausalChain =
            (params.save_context?.triggered_by?.length ?? 0) > 0 ||
            (params.relations ?? []).some((r: any) =>
              ["prompted_by", "derived_from", "based_on", "triggered_by"].includes(r.type)
            );
          if (!hasCausalChain) {
            result.missing_coordinates =
              `No triggered_by — this block has no causal chain. ` +
              `Ask: "what block was I reading when this occurred?" ` +
              `Then re-save with save_context.triggered_by: ["<that_block_id>"], or create the cause block first if it isn't in the graph yet.`;
          }
        }

        // ── Project link check: flag orphan blocks ────────────────────────
        // Every block except projects should have a project_id or a known project prefix.
        if (block.type !== "project" && !block.project_id) {
          const projectLabels = db.getAllBlocks()
            .filter((b: any) => b.type === "project")
            .map((b: any) => b.label as string);
          const hasProjectPrefix = projectLabels.some((pl: string) =>
            block.label.startsWith(pl + "_")
          );
          if (!hasProjectPrefix) {
            const suggestions = projectLabels.map((pl: string) => `${pl}_${block.label}`).join(" | ");
            result.missing_project_link =
              `Label "${block.label}" has no project prefix — ` +
              `this block is invisible in project tree navigation. ` +
              `Rename to: ${suggestions}`;
          }
        }

        return ok(result);
      } catch (error) {
        return err("CREATE_FAILED", String(error));
      }
    }
  );

  // ─── Tool: workspace_get ─────────────────────────────────────────
  server.tool(
    "workspace_get",
    `Retrieve a knowledge block at the level of detail you actually need.

DETAIL LEVELS (default: "surface" — start here, drill down only if needed):
- "surface"   → id, label, type, essence, concepts[]
                 Use when: scanning, checking existence, deciding if worth reading
- "content"   → + is_a, unique{}, has{} (the full knowledge body / procedure steps)
                 Use when: you need the actual facts, properties, or skill steps
- "relations" → surface + outgoing/incoming links + the causal CHAIN(s) this block sits on
                 Use when: navigating the graph — surfaces the whole arc (cause→outcome), not the bare block
- "full"      → everything: content + relations + metadata (source, dates, ttl, aliases)
                 Use when: auditing, debugging, or you genuinely need all fields

Tip: use "surface" first. If the essence tells you what you need, stop there.`,
    {
      id:     z.string().describe("Block ID (blk_xxx) or label"),
      detail: z.enum(["surface", "content", "relations", "full"]).optional()
               .describe("Level of detail to return. Default: 'surface'"),
    },
    async (params) => {
      try {
        const block = db.getBlock(params.id);
        if (!block) {
          return err("BLOCK_NOT_FOUND", `No block found with id or label '${params.id}'`,
            { suggestion: "Try workspace_search to find the block." });
        }

        const detail = params.detail ?? "surface";
        let content: Record<string, unknown> = {};
        try { content = JSON.parse(block.content); } catch { /* ignore */ }

        // ── surface (always included) ─────────────────────────────
        const base: Record<string, unknown> = {
          id:         block.id,
          label:      block.label,
          type:       block.type,
          status:     block.status,
          essence:    block.essence,
          concepts:   (content.concepts as string[]) || [],
          created_by: block.created_by || null,
          locked:     block.locked || false,
          flow_role:  block.flow_role || null,
          chain_id:   (block as any).chain_id || null,
        };

        // Derivation staleness warning: if any input block was updated after this block was created
        const derivation = content?.derivation as Record<string, unknown> | undefined;
        const inputIds: string[] = Array.isArray(derivation?.input_ids) ? (derivation!.input_ids as string[]) : [];
        if (inputIds.length > 0) {
          const staleInputs = inputIds.filter((inputId: string) => {
            const inputBlock = db.getBlock(inputId);
            return inputBlock && new Date(inputBlock.updated_at).getTime() > new Date(block.created_at).getTime();
          });
          if (staleInputs.length > 0) {
            base.derivation_warning = `${staleInputs.length} source block(s) were updated after this insight was derived. Re-derive with workspace_derive() to refresh.`;
            base.stale_inputs = staleInputs;
          }
        }

        if (detail === "surface") {
          return ok({ ...base, detail_level: "surface",
            hint: "Call workspace_get(id, 'content') for the full knowledge body, or 'relations' for links + the causal chain(s) this block sits on." });
        }

        // ── content ───────────────────────────────────────────────
        if (detail === "content" || detail === "full") {
          base.is_a   = content.is_a   || null;
          base.unique = content.unique  || {};
          base.has    = content.has     || {};
        }

        // ── relations ─────────────────────────────────────────────
        if (detail === "relations" || detail === "full") {
          const outgoing = db.getRelations(block.id).filter((r) => r.direction === "outgoing");
          const incoming = db.getAllIncomingRelations(block.id);
          base.outgoing = outgoing.map((r) => ({ type: r.type, to: r.target_label, id: r.target_id }));
          base.incoming = incoming.map((r) => ({ type: r.type, from: r.source_label, id: r.source_id }));
          // Surface the causal arc(s) this block sits on (chains) PLUS every chain
          // reachable by a causal path from them (linked_chains = the connected
          // component, distance-ranked) — the whole linked story, not the bare node
          // and not the whole root. member_of-based (overlap-aware). See assembleBlockChains.
          const { chains, linked_chains } = assembleBlockChains(db, block);
          if (chains.length > 0) base.chains = chains;
          if (linked_chains.length > 0) base.linked_chains = linked_chains;
        }

        // ── full metadata ─────────────────────────────────────────
        if (detail === "full") {
          base.metadata = {
            source:        block.source,
            created_at:    block.created_at,
            updated_at:    block.updated_at,
            last_accessed: block.last_accessed,
            access_count:  block.access_count,
            ttl:           block.ttl,
            aliases:       JSON.parse(block.aliases || "[]"),
            is_sensitive:  block.is_sensitive,
          };
        }

        base.detail_level = detail;
        return ok(base);
      } catch (error) {
        return err("GET_FAILED", String(error));
      }
    }
  );

  // ─── Tool: workspace_search ──────────────────────────────────────
  server.tool(
    "workspace_search",
    `FALLBACK search — use only when you can't construct the label or orient with workspace_filter. Returns ISOLATED blocks (headlines), not the story; after a hit, workspace_get(label, "relations") to anchor and walk the chain.
Three signals: semantic similarity, keyword match, and concept overlap. Concept matching enables cross-domain results — a query about "flow control" may surface rate-limiting or traffic-shaping blocks sharing abstract concept tags. Each result shows match_types so you know why it surfaced.
(Prefer: construct the label and workspace_get it directly when you know what you want; workspace_filter(concepts) to orient on a new task.)`,
    {
      query: z.string().describe("Natural language search query"),
      type:  z.string().optional().describe("Filter by block type (e.g. 'process', 'fact')"),
      limit: z.number().optional().describe("Max results. Default: 10"),
    },
    async (params) => {
      try {
        const limit = params.limit || 10;
        const STOPWORDS = new Set(["the","is","a","an","to","of","in","for","on","with","and","or","but","it","this","that","how","what","why","can","do","be","are","was","were","will","i","my","we","our"]);

        // Extract concept tokens from query
        const queryConcepts = params.query
          .toLowerCase().replace(/[^a-z0-9_ ]/g, " ").split(/\s+/)
          .filter((w) => w.length > 2 && !STOPWORDS.has(w));

        // Per-block score accumulator
        const scoreMap = new Map<string, {
          block: any; score: number; matchTypes: Set<string>;
        }>();

        const add = (block: any, delta: number, tag: string) => {
          const e = scoreMap.get(block.id);
          if (e) { e.score += delta; e.matchTypes.add(tag); }
          else scoreMap.set(block.id, { block, score: delta, matchTypes: new Set([tag]) });
        };

        // ── 1. Semantic ──────────────────────────────────────────
        const queryEmbedding = await embeddings.embed(params.query);
        if (queryEmbedding) {
          const semResults = db.semanticSearch(queryEmbedding, limit * 2, params.type);
          for (const block of semResults) {
            const bv = JSON.parse(block.embedding!) as number[];
            const sim = cosineSim(queryEmbedding, bv);
            add(block, sim * 0.5, "semantic");
          }
        }

        // ── 2. Keyword ───────────────────────────────────────────
        const kwResults = db.keywordSearch(params.query, limit * 2, params.type);
        for (const block of kwResults) add(block, 0.3, "keyword");

        // ── 3. Concept overlap ───────────────────────────────────
        if (queryConcepts.length > 0) {
          const allBlocks = db.getAllBlocks().filter(
            (b) => b.status !== "archived" && (!params.type || b.type === params.type)
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

        // ── Rank + format ────────────────────────────────────────
        // Apply freshness multiplier: blocks accessed recently score higher
        const now = Date.now();
        const recallStats = db.getRecallStats(200);
        const precisionMap = new Map(recallStats.map((s) => [s.block_id, s.precision]));

        const ranked = Array.from(scoreMap.values())
          .map(({ block, score, matchTypes }) => {
            // Freshness: 1.0 if accessed today, decays to 0.7 at 30+ days
            const daysSince = (now - new Date(block.last_accessed || block.updated_at).getTime()) / 86400000;
            const freshness = Math.max(0.7, 1.0 - (daysSince / 30) * 0.3);
            // Precision: blocks that are recalled but never used get a small penalty
            const precision = precisionMap.get(block.id) ?? 1.0; // new blocks: no penalty
            const precisionWeight = 0.85 + precision * 0.15; // range 0.85-1.0
            return { block, score: score * freshness * precisionWeight, matchTypes };
          })
          .sort((a, b) => b.score - a.score)
          .slice(0, limit);

        // Currency annotation: superseded blocks stay ACTIVE (the supersedes edge is the
        // currency marker, not status) — so a bare search hit must say what replaced it,
        // or stale would leak as current. Batched single query over the result ids.
        const supersededBy = db.getSupersededByLabels(ranked.map(({ block }) => block.id));

        const results = ranked.map(({ block, score, matchTypes }) => ({
          id:          block.id,
          label:       block.label,
          type:        block.type,
          essence:     block.essence,
          status:      block.status,
          score:       Math.round(score * 100) / 100,
          match_types: [...matchTypes],
          is_sensitive: block.is_sensitive,
          locked:      block.locked || false,
          ...(supersededBy.has(block.id)
            ? { superseded_by: supersededBy.get(block.id), note: "SUPERSEDED — read the superseding block for current truth" }
            : {}),
        }));

        return ok({
          query: params.query,
          total_results: results.length,
          results,
          signals_used: {
            semantic: !!queryEmbedding,
            keyword: true,
            concept: queryConcepts.length > 0,
          },
        });
      } catch (error) {
        return err("SEARCH_FAILED", String(error));
      }
    }
  );

  // ─── Tool: workspace_filter ──────────────────────────────────────
  server.tool(
    "workspace_filter",
    `COLD-START orientation — find which project ROOT(s) are relevant when you don't know any labels yet.

Give the first-principle CONCEPTS of what you're working on; get back ranked root suggestions, each with its one-line description and the specific blocks that matched (your entry points). This is a FILTER over concept tags + the strict label — NOT a fuzzy surface search.

ENTER the named things your task is ABOUT (technologies, mechanisms, failure-modes, domain nouns), e.g. ["latency","n+1-query","caching"]. Multiple terms — more is better.
DON'T enter generic/process words ("fix","issue","system","help") or full sentences.

These are SUGGESTIONS, not "the" root: open one with workspace_get(label, "relations") to anchor, then navigate from there (its chain comes back with it).`,
    {
      concepts: z.array(z.string()).describe("First-principle concept terms of your current task. Multiple, e.g. ['latency','n+1-query']."),
      limit:    z.number().optional().describe("Max root suggestions. Default 8."),
    },
    async (params) => {
      try {
        const suggestions = filterRootsByConcepts(db, params.concepts, { limit: params.limit });
        return ok({
          concepts: params.concepts,
          total:    suggestions.length,
          suggestions,
          hint: suggestions.length === 0
            ? "No roots matched. Try broader/abstract terms, or workspace_search for a fuzzy surface search."
            : "Open a suggested root or entry block with workspace_get(label, 'relations') to anchor — its causal chain returns with it.",
        });
      } catch (error) {
        return err("FILTER_FAILED", String(error));
      }
    }
  );

  // ─── Tool: workspace_tree ────────────────────────────────────────
  server.tool(
    "workspace_tree",
    `ORIENT (browse) — list the project ROOTS with their one-line descriptions, for when you don't have concepts to filter by yet. LEAN by design: roots + descriptions + block counts only — NOT the deep tree (that would bloat your context). Empty graph → says so plainly. Then drill in: workspace_filter(concepts) for the relevant root, or workspace_get(root-label, "relations").`,
    {},
    async () => {
      try {
        const all = db.getAllBlocks(); // excludes archived by design
        const projects = all.filter((b) => b.type === "project");
        if (projects.length === 0) {
          return ok({
            projects: [],
            hint: "The graph is empty — nothing has been stored yet. As you and the user work, the pipeline creates project roots and fills them in.",
          });
        }
        // block count per root (cheap signal of how substantial each root is)
        const childCount = new Map<string, number>();
        for (const b of all) {
          if (b.project_id) childCount.set(b.project_id, (childCount.get(b.project_id) ?? 0) + 1);
        }
        const roots = projects
          .map((p) => ({ root: p.label, description: p.essence || null, blocks: childCount.get(p.id) ?? 0 }))
          .sort((a, b) => b.blocks - a.blocks); // most substantial first
        return ok({
          projects: roots,
          hint: "Drill into a root with workspace_filter(concepts) or workspace_get(root-label, \"relations\").",
        });
      } catch (error) {
        return err("TREE_FAILED", String(error));
      }
    }
  );

  // ─── Tool: workspace_list ────────────────────────────────────────
  server.tool(
    "workspace_list",
    `Structured browse/CHECK — list blocks by project + type (+ exact label_prefix / concept). The precise form of the dead-end check: workspace_list(project, type="dead_end") returns EVERY dead-end in a project (zero false positives), and likewise constraints, decisions, etc.
Results are HEADLINES (label, type, essence) — and most blocks mean little alone, so each carries on_chain (the named chain it sits on). To get the actual story, workspace_get(label, "relations") the one you care about and walk its chain. Use workspace_filter when you have concepts but not a project; use this when you want an exhaustive typed list within a project.`,
    {
      project:      z.string().optional().describe("Scope to a project (root label or id). Pulls the root + sub-projects + its label-prefix namespace."),
      type:         z.string().optional().describe("Block type filter, e.g. 'dead_end', 'constraint', 'decision', 'fact'."),
      label_prefix: z.string().optional().describe("Exact label-prefix filter (zero false positives), e.g. 'checkout-incident_dead_end'."),
      concept:      z.string().optional().describe("Filter to blocks tagged with this concept."),
      limit:        z.number().optional().describe("Max results. Default 50."),
    },
    async (params) => {
      try {
        const all = db.getAllBlocks(); // active, non-archived
        let blocks = all;
        if (params.project) {
          const root = db.getBlock(params.project);
          if (root && root.type === "project") {
            const scope = new Set<string>([root.id]);
            const projs = all.filter((b) => b.type === "project");
            let grew = true;
            while (grew) {
              grew = false;
              for (const p of projs) if (p.project_id && scope.has(p.project_id) && !scope.has(p.id)) { scope.add(p.id); grew = true; }
            }
            const prefix = root.label + "_";
            blocks = blocks.filter((b) => scope.has(b.id) || (b.project_id != null && scope.has(b.project_id)) || b.label.startsWith(prefix));
          } else {
            // FAIL LOUD — a silent [] here would poison a dead-end check.
            const matched = blocks.filter((b) => b.label.startsWith(params.project + "_") || b.label === params.project);
            if (matched.length === 0) {
              return err("PROJECT_NOT_FOUND", `No project matches '${params.project}' (by id or label), and no labels start with '${params.project}_'.`,
                { known_projects: all.filter((b) => b.type === "project").map((p) => p.label) });
            }
            blocks = matched;
          }
        }
        if (params.type)         blocks = blocks.filter((b) => b.type === params.type);
        if (params.label_prefix) blocks = blocks.filter((b) => b.label.startsWith(params.label_prefix!));
        if (params.concept) {
          const c = params.concept.toLowerCase();
          blocks = blocks.filter((b) => {
            try { return (JSON.parse((b as any).concepts || "[]") as string[]).some((x) => String(x).toLowerCase().includes(c)); }
            catch { return false; }
          });
        }
        const limit = params.limit ?? 50;
        const sliced = blocks.slice(0, limit);
        // Annotate each headline with the chain it sits on (a block alone means little).
        const chainName = new Map<string, string | null>();
        const onChain = (cid: string | null | undefined): string | null => {
          if (!cid) return null;
          if (!chainName.has(cid)) chainName.set(cid, db.getBlock(cid)?.label ?? cid);
          return chainName.get(cid) ?? null;
        };
        // Currency annotation: superseded blocks stay ACTIVE (the edge is the currency
        // marker, not status) — a typed list must say what replaced them or a stale
        // decision reads as current. Batched single query over the page.
        const supersededBy = db.getSupersededByLabels(sliced.map((b) => b.id));
        const results = sliced.map((b) => {
          const row: Record<string, any> = { label: b.label, type: b.type, essence: b.essence, on_chain: onChain((b as any).chain_id) };
          if (supersededBy.has(b.id)) row.superseded_by = supersededBy.get(b.id);
          // For tasks, status is the headline ("what's still open?") — surface it (+ priority)
          // so the list is usable as a task view without opening each one.
          if (b.type === "task") {
            try {
              const u = (typeof b.content === "string" ? JSON.parse(b.content) : b.content)?.unique || {};
              if (u.status) row.status = u.status;
              if (u.priority) row.priority = u.priority;
            } catch { /* ignore malformed content */ }
          }
          return row;
        });
        return ok({
          total: blocks.length, returned: results.length, results,
          hint: "Headlines only — a block means little alone. Open one with workspace_get(label, \"relations\") to walk its chain (on_chain shows where each sits).",
        });
      } catch (error) {
        return err("LIST_FAILED", String(error));
      }
    }
  );

  // ─── Tool: workspace_history ─────────────────────────────────────
  server.tool(
    "workspace_history",
    `Retrieve the audit trail of changes made to the workspace.
Use to answer: "what changed in this block?", "what did agent X do?", "what happened since I last ran?".
Every workspace_remember, workspace_update, workspace_validate, and workspace_forget is logged.`,
    {
      block_id:   z.string().optional().describe("Show history for one specific block (ID or label). Omit for workspace-wide."),
      since:      z.string().optional().describe("ISO timestamp — only show changes after this time. E.g. '2026-03-15T10:00:00Z'"),
      changed_by: z.string().optional().describe("Filter by agent name (e.g. 'claude', 'planner')"),
      limit:      z.number().optional().describe("Max entries to return. Default: 20"),
    },
    async (params) => {
      try {
        const limit = params.limit ?? 20;

        // Resolve label → id if needed
        let blockId: string | undefined;
        if (params.block_id) {
          const b = db.getBlock(params.block_id);
          blockId = b?.id ?? params.block_id;
        }

        const raw = db.getHistory(blockId, limit * 3); // over-fetch, filter in JS

        const sinceMs = params.since ? new Date(params.since).getTime() : 0;
        const filtered = raw
          .filter((h) => {
            if (h.field_changed === "embedding") return false; // skip vector noise
            if (sinceMs && new Date(h.changed_at).getTime() < sinceMs) return false;
            if (params.changed_by && h.changed_by !== params.changed_by) return false;
            return true;
          })
          .slice(0, limit);

        if (filtered.length === 0) {
          return ok({
            entries: [],
            hint: params.since
              ? `No changes found since ${params.since}.`
              : "No history found for these filters.",
          });
        }

        // Enrich with block labels for readability
        const allBlocks = db.getAllBlocks();
        const blockMap = new Map(allBlocks.map((b) => [b.id, b.label]));

        const entries = filtered.map((h) => ({
          at:          h.changed_at,
          block:       blockMap.get(h.block_id) ?? h.block_id,
          block_id:    h.block_id,
          field:       h.field_changed,
          from:        h.old_value ?? "(none)",
          to:          h.new_value ?? "(none)",
          by:          h.changed_by ?? "unknown",
          reason:      h.reason ?? undefined,
        }));

        return ok({
          total: entries.length,
          filters: {
            block:      params.block_id ?? "all",
            since:      params.since ?? "all time",
            changed_by: params.changed_by ?? "all agents",
          },
          entries,
        });
      } catch (error) {
        return err("HISTORY_FAILED", String(error));
      }
    }
  );

  // ─── Tool: workspace_update ──────────────────────────────────────
  server.tool(
    "workspace_update",
    `Update an existing block. Can update any field: essence, is_a, unique, has, concepts, source. Creates an audit trail.`,
    {
      id: z.string().describe("Block ID or label to update"),
      changes: z.object({
        essence: z.string().optional().describe("Updated one-line description"),
        is_a: z.string().optional().describe("Updated parent category"),
        unique: z.record(z.string(), z.string()).optional().describe("Updated unique properties (merged with existing)"),
        has: z.record(z.string(), z.union([z.string(), z.array(z.string())])).optional().describe("Updated properties (merged with existing)"),
        concepts: z.array(z.string()).optional().describe("Updated concept tags (replaces existing)"),
        source: z.string().optional().describe("Updated source"),
        label: z.string().optional().describe("Updated label"),
        is_sensitive: z.boolean().optional().describe("Encrypt the block data (cannot be undone via update)"),
        locked: z.boolean().optional().describe("Lock (true) or unlock (false) this block. Locked blocks cannot be updated without force:true."),
      }).describe("Fields to update"),
      reason: z.string().optional().describe("Why this update was made (stored in history)"),
      force: z.boolean().optional().describe("If true, update even if the block is locked. Default: false"),
      challenges_block: z.string().optional().describe("ID or label of a block this update contradicts — creates a 'contradicts' relation"),
    },
    async (params) => {
      try {
        const block = db.getBlock(params.id);
        if (!block) {
          return err("BLOCK_NOT_FOUND", `No block found with id or label '${params.id}'`);
        }

        const dbChanges: Record<string, unknown> = {};
        const existingContent = JSON.parse(block.content);

        // Handle structured content fields — merge with existing
        if (params.changes.is_a !== undefined || params.changes.unique !== undefined ||
            params.changes.has !== undefined || params.changes.concepts !== undefined) {
          const newContent = { ...existingContent };
          if (params.changes.is_a !== undefined) newContent.is_a = params.changes.is_a;
          if (params.changes.unique !== undefined) newContent.unique = { ...(existingContent.unique || {}), ...params.changes.unique };
          if (params.changes.has !== undefined) newContent.has = { ...(existingContent.has || {}), ...params.changes.has };
          if (params.changes.concepts !== undefined) newContent.concepts = params.changes.concepts;
          dbChanges.content = JSON.stringify(newContent);
        }

        // Handle flat fields
        if (params.changes.essence !== undefined) dbChanges.essence = params.changes.essence;
        if (params.changes.source !== undefined) dbChanges.source = params.changes.source;
        if (params.changes.label !== undefined) dbChanges.label = params.changes.label;
        if (params.changes.is_sensitive !== undefined) dbChanges.is_sensitive = params.changes.is_sensitive;
        if (params.changes.locked !== undefined) dbChanges.locked = params.changes.locked ? 1 : 0;

        // Prevent removing encryption
        if (params.changes.is_sensitive === false && block.is_sensitive === true) {
          return err("UPDATE_FAILED", "Removing encryption (is_sensitive: false) is not allowed.");
        }

        // Regenerate embedding if content changed
        if (dbChanges.essence || dbChanges.content) {
          const essenceForEmbed = (dbChanges.essence as string) || block.essence;
          const conceptsForEmbed = (dbChanges.concepts as string[] | undefined) ?? block.concepts;
          const newEmbedding = await embeddings.embed(blockEmbeddingText({ essence: essenceForEmbed, concepts: conceptsForEmbed }));
          if (newEmbedding) {
            dbChanges.embedding = JSON.stringify(newEmbedding);
          }
        }

        const updated = db.updateBlock(block.id, dbChanges, params.reason, undefined, params.force);

        // Handle challenges_block — creates contradicts relation
        let challengeResult: Record<string, unknown> | undefined;
        if (params.challenges_block) {
          const challenged = db.getBlock(params.challenges_block);
          if (challenged) {
            db.createRelation({ source_id: block.id, target_id: challenged.id, type: "contradicts", created_by: "agent" });
            challengeResult = { challenged_id: challenged.id, challenged_label: challenged.label };
          }
        }

        return ok({
          id: updated!.id,
          label: updated!.label,
          updated_fields: Object.keys(params.changes),
          reason: params.reason,
          ...(challengeResult ? { challenged: challengeResult } : {}),
        });
      } catch (error) {
        return err("UPDATE_FAILED", String(error));
      }
    }
  );

  // ─── Tool: workspace_forget ──────────────────────────────────────
  server.tool(
    "workspace_forget",
    `Archive a block (soft delete). Preserved in history but hidden from recall.`,
    {
      id: z.string().describe("Block ID or label to archive"),
      reason: z.string().optional().describe("Why this block is being archived"),
    },
    async (params) => {
      try {
        const success = db.archiveBlock(params.id, params.reason);
        if (!success) return err("BLOCK_NOT_FOUND", `No block found with id or label '${params.id}'`);
        return ok({ archived: true, id: params.id, reason: params.reason || "Archived by agent" });
      } catch (error) {
        return err("ARCHIVE_FAILED", String(error));
      }
    }
  );

  // ─── Tool: workspace_batch_save ──────────────────────────────────
  server.tool(
    "workspace_batch_save",
    `Save multiple knowledge blocks in a single call. Reduces round-trips when saving 3+ related facts at once.
Each block follows the same schema as workspace_remember. Returns created block IDs in order.
Use this during research sessions to collapse 5-10 workspace_remember calls into one.`,
    {
      blocks: z.array(z.object({
        label:      z.string().describe("Block label (lowercase_underscore)"),
        type:       z.string().describe("Block type: fact, decision, insight, note, etc."),
        essence:    z.string().describe("One-line description"),
        is_a:       z.string().optional(),
        unique:     z.record(z.string(), z.string()).optional(),
        has:        z.record(z.string(), z.union([z.string(), z.array(z.string())])).optional(),
        concepts:   z.array(z.string()).optional(),
        ttl:        z.enum(["session","1hr","24hr","1week","project","permanent"]).optional(),
        relations:  z.array(z.object({ type: z.string(), target_id: z.string() })).optional(),
        save_context: z.object({
          triggered_by: z.array(z.string()).optional().describe("Block IDs or labels that caused this block — creates prompted_by relations"),
          problem_being_solved: z.string().optional(),
        }).optional().describe("Causal chain — triggered_by is the primary coordinate"),
      })).min(1).describe("Array of blocks to save"),
      project_id: z.string().optional().describe("Project to link all blocks to (creates part_of relations)"),
    },
    async (params) => {
      try {
        const created: Array<{ id: string; label: string; type: string; missing_coordinates?: string }> = [];
        for (const spec of params.blocks) {
          const content: Record<string, unknown> = {};
          if (spec.is_a)         content.is_a    = spec.is_a;
          if (spec.unique)       content.unique  = spec.unique;
          if (spec.has)          content.has     = spec.has;
          if (spec.save_context) content.save_context = spec.save_context;

          const embedding = await embeddings.embed(blockEmbeddingText({ essence: spec.essence, concepts: spec.concepts }));
          const block = db.createBlock({
            label:      spec.label,
            type:       spec.type || "fact",
            essence:    spec.essence,
            content,
            concepts:   spec.concepts || [],
            ttl:        spec.type === "dead_end" ? "permanent" : (spec.ttl || "permanent"),
            embedding:  embedding || undefined,
          });

          // Relations provided in spec
          for (const rel of (spec.relations || [])) {
            const target = db.getBlock(rel.target_id);
            if (target) db.createRelation({ source_id: block.id, target_id: target.id, type: rel.type });
          }
          // prompted_by relations from save_context.triggered_by
          if (spec.save_context?.triggered_by?.length) {
            for (const targetRef of spec.save_context.triggered_by) {
              const targetBlock = db.getBlock(targetRef);
              if (targetBlock) {
                db.createRelation({ source_id: block.id, target_id: targetBlock.id, type: "prompted_by" });
              }
            }
          }
          // Auto-link to project via project_id column
          if (params.project_id) {
            const project = db.getBlock(params.project_id);
            if (project) db.updateBlock(block.id, { project_id: project.id });
          }

          // Compute quality score (same 6-point rubric as workspace_remember)
          const qc = (() => { try { return typeof block.content === "string" ? JSON.parse(block.content) : (block.content || {}); } catch { return {}; } })();
          const blockConcepts = spec.concepts || [];
          let qScore = 1;
          if (qc.is_a)                                           qScore++;
          if (qc.unique && Object.keys(qc.unique).length >= 2)  qScore++;
          if (blockConcepts.length >= 3)                         qScore++;
          if (spec.type === "project") {
            qScore++;
          } else {
            if (db.getRelations(block.id).length > 0)           qScore++;
          }
          db.updateBlock(block.id, { quality_score: Math.min(qScore, 5) });

          // ── Coordinates check: warn if no causal chain ───────────
          const entry: any = { id: block.id, label: block.label, type: block.type, quality_score: qScore };
          if (spec.type !== "project") {
            const hasCausalChain =
              (spec.save_context?.triggered_by?.length ?? 0) > 0 ||
              (spec.relations ?? []).some((r: any) =>
                ["prompted_by", "derived_from", "based_on", "triggered_by"].includes(r.type)
              );
            if (!hasCausalChain) {
              entry.missing_coordinates =
                `No triggered_by — add save_context.triggered_by to establish causal chain.`;
            }

            // ── Project link check: warn if orphan ───────────────
            if (!block.project_id) {
              const projectLabels = db.getAllBlocks()
                .filter((b: any) => b.type === "project")
                .map((b: any) => b.label as string);
              const hasProjectPrefix = projectLabels.some((pl: string) =>
                block.label.startsWith(pl + "_")
              );
              if (!hasProjectPrefix) {
                entry.missing_project_link =
                  `Label "${block.label}" has no project prefix — invisible in tree navigation.`;
              }
            }
          }
          created.push(entry);
        }
        db.save();
        return ok({ saved: created.length, blocks: created });
      } catch (error) {
        return err("BATCH_SAVE_FAILED", String(error));
      }
    }
  );

}
