// routes/blocks.ts — block CRUD + navigation + graph + review + conflicts + relations + agents
// Reference: api-server.v1.ts lines 328–1343
import { Router } from "express";
import { WorkspaceDB } from "../store/database.js";
import { computeQualityScore } from "../store/quality.js";
import { CAUSAL_TRAVERSAL_RELS, SPINE_RELS } from "../relation-sets.js";
import { deriveRootRelatedness } from "../middleware/reflect/root-relatedness.js";
import { assembleBlockChains, assembleFullThread, orderMembersCausally } from "../tools/helpers.js";

export function createBlocksRouter(db: WorkspaceDB): Router {
  const router = Router();

  // ─── Root-relatedness map (which roots relate + how, derived from edges) ──────
  // Meaning-classified (dependency/containment/evolution/conflict/loose), directional.
  // Read-only derivation, no LLM. The "Venn overlap" of project roots.
  router.get("/api/roots/related", (_req, res) => {
    try { res.json(deriveRootRelatedness(db)); }
    catch (e) { res.status(500).json({ error: String(e) }); }
  });

  // ─── Review queue ────────────────────────────────────────────────
  router.get("/api/blocks/review-queue", (req, res) => {
    try {
      const { project } = req.query as Record<string, string>;
      let blocks = db.getAllBlocks().filter((b: any) => b.review_status === "needs_review");
      if (project) {
        // Same id-or-label resolution as /api/blocks — a project ID here used to silently match nothing.
        const root = db.getBlock(project);
        const prefix = (root && root.type === "project") ? root.label + "_" : project + "_";
        blocks = blocks.filter((b: any) =>
          (b.label || "").startsWith(prefix) ||
          (root && (b.project_id === root.id || b.id === root.id)));
      }
      const result = blocks.map((b: any) => {
        let unique: Record<string, any> = {};
        try { unique = (typeof b.content === "string" ? JSON.parse(b.content) : b.content)?.unique ?? {}; } catch { /* */ }
        return { id: b.id, label: b.label, type: b.type, essence: b.essence, review_reason: b.review_reason, unique, created_at: b.created_at };
      });
      res.json({ total: result.length, blocks: result });
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  router.patch("/api/blocks/:id/review", (req, res) => {
    try {
      const { action } = req.body as { action: "approve" | "corrected" };
      if (!["approve", "corrected"].includes(action)) return res.status(400).json({ error: "action must be 'approve' or 'corrected'" });
      const block = db.getBlock(req.params.id);
      if (!block) return res.status(404).json({ error: "Block not found" });
      db.updateBlock(block.id, { review_status: action === "approve" ? "reviewed_ok" : "corrected" });
      if (action === "approve") db.stampReflectedAt([block.id]);
      res.json({ ok: true, review_status: action === "approve" ? "reviewed_ok" : "corrected" });
    } catch (e: any) { res.status(500).json({ error: e.message }); }
  });

  // ─── Blocks list ────────────────────────────────────────────────
  // This is the agent's QUERY surface (Rule-1 dead-end/constraint checks are filtered
  // lists on this route). Failure discipline: a filter that didn't apply must be loud,
  // never an empty array the agent reads as "truly none".
  router.get("/api/blocks", (req, res) => {
    try {
      const { q, type, status, since, updated_since, project, label_prefix, label, flow_role, concept, detail, limit } = req.query as Record<string, string>;

      const LIST_DETAILS = new Set(["surface", "content", "full"]);
      const detailLevel = detail ?? "full";
      if (!LIST_DETAILS.has(detailLevel)) {
        return res.status(400).json({ error: `Unknown detail '${detail}'. Allowed on the list endpoint: surface, content, full. ('relations' is available on GET /api/blocks/:id.)` });
      }

      // getAllBlocks() excludes archived by design — an archived-status query needs the explicit fetch.
      let blocks = status === "archived" ? db.getBlocksByStatus("archived") : db.getAllBlocks();
      if (type)         blocks = blocks.filter((b) => b.type === type);
      if (status) {
        const TASK_STATUSES = new Set(["open", "in_progress", "done", "blocked"]);
        if (type === "task" && TASK_STATUSES.has(status)) {
          blocks = blocks.filter((b) => { try { return JSON.parse(b.content as string)?.unique?.status === status; } catch { return false; } });
        } else {
          blocks = blocks.filter((b) => b.status === status);
        }
      }
      if (since)        blocks = blocks.filter((b) => (b as any).created_at > since);
      if (updated_since) blocks = blocks.filter((b) => (b as any).updated_at > updated_since || (b as any).created_at > updated_since);
      if (project) {
        // Resolve id-or-label via getBlock (same dual resolution the single-block route has).
        // Scope = the root + descendant sub-projects (project_id chain), unioned with the
        // label-prefix namespace — strictly wider than the old prefix-only match, so no regression.
        const root = db.getBlock(project);
        if (root && root.type === "project") {
          const scope = new Set<string>([root.id]);
          const projectBlocks = db.getAllBlocks().filter((b) => b.type === "project");
          let grew = true;
          while (grew) {
            grew = false;
            for (const p of projectBlocks) {
              if (p.project_id && scope.has(p.project_id) && !scope.has(p.id)) { scope.add(p.id); grew = true; }
            }
          }
          const prefix = root.label + "_";
          blocks = blocks.filter((b) =>
            scope.has(b.id) ||
            (b.project_id != null && scope.has(b.project_id)) ||
            b.label.startsWith(prefix));
        } else {
          // No project root resolves — keep the namespace query for label-prefixed blocks
          // without a root (back-compat), but FAIL LOUD when nothing matches at all:
          // a silent [] here poisons the dead-end check.
          const matched = blocks.filter((b) => b.label.startsWith(project + "_") || b.label === project);
          if (matched.length === 0) {
            const known = db.getAllBlocks().filter((b) => b.type === "project").map((p) => ({ id: p.id, label: p.label }));
            return res.status(404).json({
              error: `No project matches '${project}' (by id or label), and no block labels start with '${project}_'.`,
              known_projects: known,
            });
          }
          blocks = matched;
        }
      }
      if (label)        blocks = blocks.filter((b) => b.label === label);
      if (label_prefix) blocks = blocks.filter((b) => b.label.startsWith(label_prefix));
      if (flow_role)    blocks = blocks.filter((b) => (b as any).flow_role === flow_role);
      if (concept) {
        const conceptLower = concept.toLowerCase();
        blocks = blocks.filter((b) => {
          const concepts: string[] = Array.isArray(b.concepts) ? b.concepts : (typeof b.concepts === "string" ? JSON.parse(b.concepts || "[]") : []);
          return concepts.some((c) => c.toLowerCase().includes(conceptLower));
        });
      }
      if (q) {
        const lower = q.toLowerCase();
        blocks = blocks.filter((b) => b.label.toLowerCase().includes(lower) || b.essence.toLowerCase().includes(lower));
      }
      if (limit !== undefined) {
        const n = Number(limit);
        if (!Number.isInteger(n) || n < 0) {
          return res.status(400).json({ error: `limit must be a non-negative integer, got '${limit}'.` });
        }
        blocks = blocks.slice(0, n);
      }
      if (detailLevel === "surface") {
        return res.json(blocks.map((b) => ({
          id: b.id, label: b.label, type: b.type, status: b.status, essence: b.essence,
          project_id: (b as any).project_id ?? null, chain_id: (b as any).chain_id ?? null,
        })));
      }
      if (detailLevel === "content") {
        return res.json(blocks.map((b) => {
          let c: any = {};
          try { c = typeof b.content === "string" ? JSON.parse(b.content) : b.content; } catch { /* malformed content → empty */ }
          return {
            id: b.id, label: b.label, type: b.type, status: b.status, essence: b.essence,
            project_id: (b as any).project_id ?? null, chain_id: (b as any).chain_id ?? null,
            is_a: c?.is_a ?? null, unique: c?.unique ?? {},
          };
        }));
      }
      const slim = blocks.map(({ embedding: _e, ...rest }) => rest);
      res.json(slim);
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  // ─── Single block with backlinks ────────────────────────────────
  // detail levels ported from the MCP workspace_get tool (tools/core.ts) — the agent
  // read surface. REST default stays "full" for existing consumers (TUI, scripts);
  // surface/content/relations skip the whole-graph conflicts scan below.
  router.get("/api/blocks/:id", (req, res) => {
    try {
      const DETAILS = new Set(["surface", "content", "relations", "full"]);
      const detail = (req.query.detail as string) ?? "full";
      if (!DETAILS.has(detail)) {
        return res.status(400).json({ error: `Unknown detail '${req.query.detail}'. Allowed: surface, content, relations, full.` });
      }
      const block = db.getBlock(req.params.id);
      if (!block) return res.status(404).json({ error: "Not found" });
      if (detail !== "full") {
        let c: any = {};
        try { c = typeof block.content === "string" ? JSON.parse(block.content) : block.content; } catch { /* malformed content → empty */ }
        const base: Record<string, unknown> = {
          id: block.id, label: block.label, type: block.type, status: block.status,
          essence: block.essence,
          project_id: (block as any).project_id ?? null, chain_id: (block as any).chain_id ?? null,
          detail_level: detail,
        };
        if (detail === "content") {
          base.is_a   = c?.is_a   ?? null;
          base.unique = c?.unique ?? {};
          base.has    = c?.has    ?? {};
        }
        if (detail === "relations") {
          const outgoing = db.getRelations(block.id).filter((r: any) => r.direction === "outgoing");
          const incoming = db.getAllIncomingRelations(block.id);
          // PARITY with the MCP workspace_get relations view (the two read surfaces
          // must not drift): each edge carries the neighbor's one-line essence
          // (signpost — decide whether to walk without an extra call) AND its
          // currency (superseded_by = what replaced it). The currency annotation is
          // the "stale premise shines through the edge" fix (Reddit field question,
          // 2026-07-06): a dead-end whose killing constraint was superseded must
          // show the rot in THIS view, not one hop away. Batched, one query.
          const gist = (id: string): string | undefined => {
            const b = db.getBlock(id);
            if (!b?.essence) return undefined;
            return b.essence.length > 140 ? b.essence.slice(0, 137) + "…" : b.essence;
          };
          const staleNeighbors = db.getSupersededByLabels([
            ...outgoing.map((r: any) => r.target_id),
            ...incoming.map((r: any) => r.source_id),
          ]);
          const currency = (id: string) =>
            staleNeighbors.has(id) ? { superseded_by: staleNeighbors.get(id) } : {};
          base.outgoing = outgoing.map((r: any) => ({ type: r.type, target_label: r.target_label, target_id: r.target_id, essence: gist(r.target_id), ...currency(r.target_id) }));
          base.incoming = incoming.map((r: any) => ({ type: r.type, source_label: r.source_label, source_id: r.source_id, essence: gist(r.source_id), ...currency(r.source_id) }));
          // PARITY (chains): the MCP relations view surfaces the causal arc(s)
          // the block sits on plus the linked story (assembleBlockChains,
          // member_of-based) — the REST view returned bare edges, so a REST
          // consumer got headlines without the arc (third read-path drift,
          // found by walking the graph 2026-07-06). Same helper, both windows.
          const { chains, linked_chains } = assembleBlockChains(db, block as any);
          if (chains.length > 0) base.chains = chains;
          if (linked_chains.length > 0) base.linked_chains = linked_chains;
        }
        return res.json(base);
      }
      const { embedding: _e, ...blockData } = block;
      const content = typeof block.content === "string" ? JSON.parse(block.content) : block.content;
      const outgoing = db.getRelations(block.id);
      const incoming = db.getAllIncomingRelations(block.id);
      const days = (Date.now() - new Date(block.last_accessed).getTime()) / 86400000;
      const staleness_score = Math.round((days / Math.log(block.access_count + 2)) * 10) / 10;
      const allRelations = db.getAllRelations();
      const allBlocks = db.getAllBlocks();
      const conflicts = allRelations
        .filter((r) => (r.type === "conflicts_with" || r.type === "challenges") && (r.source_id === block.id || r.target_id === block.id))
        .map((r) => {
          const otherId = r.source_id === block.id ? r.target_id : r.source_id;
          const other = allBlocks.find((b) => b.id === otherId);
          return other ? { relation_id: r.id, type: r.type, other_id: other.id, other_label: other.label, other_essence: other.essence } : null;
        }).filter(Boolean);
      res.json({ ...blockData, content, outgoing, incoming, conflicts, staleness_score, days_inactive: Math.floor(days) });
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  // ─── Block graph navigation ──────────────────────────────────────
  router.get("/api/blocks/:id/nav", (req, res) => {
    try {
      const block = db.getBlock(req.params.id);
      if (!block) return res.status(404).json({ error: "Block not found" });
      const allBlocks = db.getAllBlocks();
      const allRelations = db.getAllRelations();
      // Build breadcrumb path using project_id
      const path: { id: string; label: string; type: string }[] = [{ id: block.id, label: block.label, type: block.type }];
      if (block.type !== "project" && block.project_id) {
        const proj = allBlocks.find(b => b.id === block.project_id);
        if (proj) path.unshift({ id: proj.id, label: proj.label, type: proj.type });
      }
      const depth = path.length > 1 ? path.length - 1 : 0;
      // Siblings: other blocks with the same project_id
      const siblings = block.project_id
        ? allBlocks.filter(b => b.id !== block.id && b.project_id === block.project_id)
            .map(b => ({ id: b.id, label: b.label })).slice(0, 8)
        : [];
      // Children: project blocks use part_of for nesting; non-project blocks have no children in this model
      const children = block.type === "project"
        ? allBlocks.filter(b => b.project_id === block.id)
            .map(b => ({ id: b.id, label: b.label })).slice(0, 8)
        : [];
      const parent = block.project_id ? allBlocks.find(b => b.id === block.project_id) ?? null : null;
      const CAUSAL_RELS = CAUSAL_TRAVERSAL_RELS; // shared single source — relation-sets.ts
      const outgoing = allRelations.filter(r => r.source_id === block.id && CAUSAL_RELS.has(r.type))
        .map(r => { const target = allBlocks.find(b => b.id === r.target_id); return target ? { type: r.type, label: target.label, block_type: target.type, flow_role: target.flow_role || null } : null; })
        .filter((r): r is NonNullable<typeof r> => !!r);
      const incoming = allRelations.filter(r => r.target_id === block.id && CAUSAL_RELS.has(r.type))
        .map(r => { const source = allBlocks.find(b => b.id === r.source_id); return source ? { type: r.type, label: source.label, block_type: source.type, flow_role: source.flow_role || null } : null; })
        .filter((r): r is NonNullable<typeof r> => !!r);
      res.json({ label: block.label, type: block.type, essence: block.essence || null, flow_role: block.flow_role || null, chain_id: block.chain_id || null, path: path.map(p => p.label), children, children_count: children.length, relations: { outgoing, incoming } });
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  // ─── Tree view ────────────────────────────────────────────────────
  router.get("/api/tree", (req, res) => {
    try {
      const rawDepth = req.query.depth !== undefined ? Number(req.query.depth) : 1;
      const maxDepth = Math.min(rawDepth, 4);
      const projectFilter = req.query.project as string | undefined;
      const allBlocks = db.getAllBlocks();
      // Build childrenOf map from project_id column (replaces part_of relation scan)
      const childrenOf = new Map<string, string[]>();
      for (const b of allBlocks) {
        if (b.project_id) {
          const list = childrenOf.get(b.project_id) || [];
          list.push(b.id);
          childrenOf.set(b.project_id, list);
        }
      }
      const blockMap = new Map(allBlocks.map((b: any) => [b.id, b]));
      function buildNode(blockId: string, depth: number): any {
        const b = blockMap.get(blockId) as any;
        if (!b) return null;
        const ess = b.essence || "";
        const node: any = {
          id: b.id, label: b.label, type: b.type,
          ...(b.type === "project" ? { essence: ess.length > 80 ? ess.slice(0, 80) + "…" : ess } : {}),
          ...(b.priority  ? { priority:  b.priority  } : {}),
          ...(b.flow_role ? { flow_role: b.flow_role } : {}),
          ...(b.status && b.status !== "active" && b.status !== "created" ? { status: b.status } : {}),
          children_count: (childrenOf.get(blockId) || []).length,
        };
        if (depth < maxDepth) {
          const childIds = childrenOf.get(blockId) || [];
          const allKids = childIds.map((id: string) => blockMap.get(id) as any).filter((k: any) => k && k.type !== "project" && k.status !== "archived");
          if (b.type === "project") {
            // STANCE types pinned at the project node — they're the action-
            // changing residue an agent needs at orientation (agent.md Rule 1:
            // dead-end + constraint check before proposing; decisions are the
            // project's spine; blueprints are planned-but-pending). active_tasks
            // pinned alongside (kept from prior convention).
            const STANCE_TYPES = ["constraint", "dead_end", "decision", "blueprint"];
            const isActiveTask = (k: any) => { if (k.type !== "task") return false; try { return JSON.parse(k.content)?.unique?.status === "in_progress"; } catch { return false; } };
            const slim = (k: any) => ({ id: k.id, label: k.label, essence: (k.essence || "").slice(0, 100) });
            for (const t of STANCE_TYPES) {
              const matches = allKids.filter((k: any) => k.type === t);
              if (matches.length > 0) node[`${t}s`] = matches.map(slim);
            }
            const activeTasks = allKids.filter(isActiveTask);
            if (activeTasks.length > 0) node.active_tasks = activeTasks.map(slim);
            const rest = allKids.filter((k: any) => !STANCE_TYPES.includes(k.type) && !isActiveTask(k));
            const kids = rest.map((k: any) => buildNode(k.id, depth + 1)).filter(Boolean);
            if (kids.length > 0) node.children = kids;
          } else {
            const kids = allKids.map((k: any) => buildNode(k.id, depth + 1)).filter(Boolean);
            if (kids.length > 0) node.children = kids;
          }
        }
        return node;
      }
      let projects = allBlocks.filter((b: any) => b.type === "project" && b.status !== "archived");
      if (projectFilter) projects = projects.filter((p: any) => p.id === projectFilter || p.label === projectFilter);
      const tree = projects.map((p: any) => buildNode(p.id, 0));
      // Cross-root entanglement at orient-time: which roots relate + how, meaning-
      // classified from real edges (same derivation as GET /api/roots/related).
      let related_roots: ReturnType<typeof deriveRootRelatedness>["pairs"] = [];
      try { related_roots = deriveRootRelatedness(db).pairs; } catch { /* best-effort at orient — tree must not fail on it */ }
      res.json({ tree, depth: maxDepth, total_projects: projects.length, related_roots });
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  // ─── Causal chain ─────────────────────────────────────────────────
  router.get("/api/blocks/:id/chain", (req, res) => {
    try {
      const block = db.getBlock(req.params.id);
      if (!block) return res.status(404).json({ error: "Not found" });
      const allBlocks = db.getAllBlocks();
      const allRels = db.getAllRelations(false).filter((r: any) => r.status === "active");
      const blockMap = new Map(allBlocks.map((b: any) => [b.id, b]));
      // Order the arc on the SPINE (relation-sets.ts): order-bearing, uniform direction
      // (source=effect, target=cause). Grounding edges like `supports` are the INVERSE
      // direction, so including them here made evidence sort backwards — kept OUT of the
      // linearized walk (they belong on a node as evidence, not as a step).
      const CAUSAL = SPINE_RELS;
      const focalId = (block as any).id;
      const depthMap = new Map<string, number>();
      const viaMap   = new Map<string, string>();
      depthMap.set(focalId, 0);
      const upQueue: Array<{ id: string; depth: number }> = [{ id: focalId, depth: 0 }];
      while (upQueue.length) {
        const { id, depth } = upQueue.shift()!;
        if (depth < -6) continue;
        const parents = allRels.filter((r: any) => CAUSAL.has(r.type) && r.source_id === id);
        for (const r of parents) {
          if (!depthMap.has(r.target_id)) {
            depthMap.set(r.target_id, depth - 1);
            viaMap.set(r.target_id, r.type);
            upQueue.push({ id: r.target_id, depth: depth - 1 });
          }
        }
      }
      const downQueue: Array<{ id: string; depth: number }> = [{ id: focalId, depth: 0 }];
      while (downQueue.length) {
        const { id, depth } = downQueue.shift()!;
        if (depth > 4) continue;
        const children = allRels.filter((r: any) => CAUSAL.has(r.type) && r.target_id === id);
        for (const r of children) {
          if (!depthMap.has(r.source_id)) {
            depthMap.set(r.source_id, depth + 1);
            viaMap.set(r.source_id, r.type);
            downQueue.push({ id: r.source_id, depth: depth + 1 });
          }
        }
      }
      const chainBlocks = [...depthMap.entries()].sort((a, b) => a[1] - b[1]).map(([id, depth]) => {
        const b = blockMap.get(id) as any;
        if (!b) return null;
        const ess = (b.essence || "") as string;
        return { label: b.label, type: b.type, flow_role: b.flow_role || null, essence: ess.length > 120 ? ess.slice(0, 120) + "…" : ess, depth, via: viaMap.get(id) || null, is_focal: id === focalId };
      }).filter(Boolean);
      res.json({ chain: chainBlocks, length: chainBlocks.length });
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  // ─── Whole thread (Mode 2) — the entire causal thread in one call ─
  // The computed, always-current sibling of /chain: every member of the SPINE thread
  // this block sits on, cause→effect ordered, with role + grounding tags. Lets a caller
  // read a whole reasoning arc without N block-by-block hops. REST parity for the MCP
  // workspace_get(id, "thread").
  router.get("/api/blocks/:id/thread", (req, res) => {
    try {
      const block = db.getBlock(req.params.id);
      if (!block) return res.status(404).json({ error: "Not found" });
      const thread = assembleFullThread(db, block.id);
      if (!thread) return res.json({ focal: block.label, count: 0, members: [], note: "standalone — not on a causal thread" });
      res.json(thread);
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  // ─── Graph data ─────────────────────────────────────────────────
  router.get("/api/graph", (_req, res) => {
    try {
      const blocks = db.getAllBlocks();
      const allRelations = db.getAllRelations();
      const now = Date.now();
      const nodes = blocks.map((b) => {
        const days = (now - new Date(b.last_accessed).getTime()) / 86400000;
        const staleness = Math.round((days / Math.log(b.access_count + 2)) * 10) / 10;
        return { id: b.id, label: b.label, type: b.type, status: b.status, essence: b.essence, access_count: b.access_count, created_at: b.created_at, created_by: b.created_by || null, staleness_score: staleness, days_inactive: Math.floor(days) };
      });
      const nodeIds = new Set(nodes.map((n) => n.id));
      const edges = allRelations.filter((r) => nodeIds.has(r.source_id) && nodeIds.has(r.target_id)).map((r) => ({ id: r.id, source: r.source_id, target: r.target_id, type: r.type, bidirectional: r.bidirectional }));
      res.json({ nodes, edges });
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  router.get("/api/templates", (_req, res) => {
    try { res.json(db.getBlockTypes()); } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  router.get("/api/history", (req, res) => {
    try { res.json(db.getHistory(undefined, Number(req.query.limit) || 20)); } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  router.get("/api/projects/:name/logs", (req, res) => {
    try { res.json(db.getProjectLogs(req.params.name, 50)); } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  router.get("/api/chains/:chain_id", (req, res) => {
    try {
      const id = req.params.chain_id;
      // Members link to a chain block via member_of edges — the AUTHORITATIVE
      // many-to-many. The chain_id COLUMN is lossy single-attribution (a chain
      // block has chain_id=null and few members carry its id), so a column query
      // returns ~nothing for a chain-block id. Prefer the edges; fall back to the
      // column for callers that pass a chain_id-column value.
      const memberRels = db.getAllIncomingRelations(id).filter((r: any) => r.type === "member_of");
      let blocks = memberRels
        .map((r: any) => db.getBlock(r.source_id))
        .filter((b: any): b is NonNullable<typeof b> => !!b && b.status !== "archived");
      if (blocks.length === 0) blocks = db.getBlocksByChain(id);
      if (blocks.length === 0) return res.status(404).json({ error: "Chain not found" });
      // Present members in the chain's causal FLOW (cause → effect), not creation time —
      // created_at disagreed with causal order in 20/20 real chains (conclusions sorted first).
      blocks = orderMembersCausally(db, blocks as any) as any;
      res.json({ chain_id: id, count: blocks.length, blocks: blocks.map((b) => ({ id: b.id, label: b.label, type: b.type, flow_role: b.flow_role, essence: b.essence, quality_score: b.quality_score })) });
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  router.get("/api/blocks/stale", (req, res) => {
    try {
      const threshold = parseFloat((req.query.threshold as string) || "3");
      const now = Date.now();
      const stale = db.getAllBlocks().filter((b) => b.status === "active").map((b) => {
        const days = (now - new Date(b.last_accessed).getTime()) / 86400000;
        const score = Math.round((days / Math.log(b.access_count + 2)) * 10) / 10;
        return { id: b.id, label: b.label, type: b.type, essence: b.essence, created_by: b.created_by, staleness_score: score, days_inactive: Math.floor(days) };
      }).filter((b) => b.staleness_score > threshold).sort((a, b) => b.staleness_score - a.staleness_score);
      res.json(stale);
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  router.get("/api/conflicts", (_req, res) => {
    try {
      const allRelations = db.getAllRelations();
      const allBlocks = db.getAllBlocks();
      const conflicts = allRelations.filter((r) => r.type === "conflicts_with" || r.type === "challenges").map((r) => {
        const src = allBlocks.find((b) => b.id === r.source_id);
        const tgt = allBlocks.find((b) => b.id === r.target_id);
        if (!src || !tgt) return null;
        return { relation_id: r.id, type: r.type, source: { id: src.id, label: src.label, essence: src.essence, type: src.type, created_by: src.created_by }, target: { id: tgt.id, label: tgt.label, essence: tgt.essence, type: tgt.type, created_by: tgt.created_by } };
      }).filter(Boolean);
      res.json(conflicts);
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  // ─── Create block ────────────────────────────────────────────────
  router.post("/api/blocks", (req, res) => {
    try {
      const { label, type, essence, ttl, content, concepts, is_a, unique, has, relations } = req.body as { label: string; type?: string; essence?: string; ttl?: string; content?: Record<string, unknown>; concepts?: string[]; is_a?: string; unique?: Record<string, string>; has?: Record<string, unknown>; relations?: Array<{ type: string; target_id: string }> };
      if (!label) return res.status(400).json({ error: "label is required" });
      const mergedContent: Record<string, unknown> = { ...(content || {}) };
      if (is_a)   mergedContent.is_a   = is_a;
      if (unique) mergedContent.unique = unique;
      if (has)    mergedContent.has    = has;
      const blockConcepts = concepts || [];
      const resolvedTtl = (type === "dead_end") ? "permanent" : (ttl || "permanent");
      const block = db.createBlock({ label, type: type || "note", essence: essence || "", ttl: resolvedTtl, content: mergedContent, concepts: blockConcepts, source: "ui", created_by: "user" });
      const qScore = computeQualityScore(block, blockConcepts);
      db.updateBlock(block.id, { quality_score: qScore });
      const createdRelations: string[] = [];
      if (relations?.length) {
        for (const rel of relations) {
          if (rel.type && rel.target_id) { try { const r = db.createRelation({ source_id: block.id, target_id: rel.target_id, type: rel.type, created_by: "user" }); createdRelations.push(r.id); } catch { /* skip */ } }
        }
      }
      db.save();
      res.status(201).json({ ...block, quality_score: qScore, relations_created: createdRelations });
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  router.post("/api/blocks/batch", (req, res) => {
    try {
      const { blocks, project_id } = req.body as { blocks: Array<{ label: string; type?: string; essence?: string; ttl?: string; concepts?: string[]; relations?: Array<{ type: string; target_id: string }> }>; project_id?: string };
      if (!Array.isArray(blocks) || blocks.length === 0) return res.status(400).json({ error: "blocks array is required" });
      const created = blocks.map((spec: any) => {
        if (!spec.label) throw new Error("each block requires a label");
        const concepts = spec.concepts || [];
        const content: Record<string, unknown> = typeof spec.content === "object" && spec.content ? { ...spec.content } : {};
        if (spec.is_a)   content.is_a   = spec.is_a;
        if (spec.unique) content.unique = spec.unique;
        if (spec.has)    content.has    = spec.has;
        const resolvedSpecTtl = (spec.type === "dead_end") ? "permanent" : (spec.ttl || "permanent");
        const block = db.createBlock({ label: spec.label, type: spec.type || "fact", essence: spec.essence || "", ttl: resolvedSpecTtl, content, source: "ui", created_by: "user", concepts });
        const qScore = computeQualityScore(block, concepts);
        db.updateBlock(block.id, { quality_score: qScore });
        if (project_id) { const project = db.getBlock(project_id); if (project) db.updateBlock(block.id, { project_id: project.id }); }
        if (spec.relations?.length) { for (const rel of spec.relations) { if (rel.type && rel.target_id) { try { db.createRelation({ source_id: block.id, target_id: rel.target_id, type: rel.type, created_by: "user" }); } catch { /* skip */ } } } }
        return { id: block.id, label: block.label, type: block.type };
      });
      db.save();
      res.status(201).json({ saved: created.length, blocks: created });
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  router.patch("/api/blocks/:id", (req, res) => {
    try {
      const { essence, ttl, status, label, type, content, priority, flow_role, updated_by } = req.body as { essence?: string; ttl?: string; status?: string; label?: string; type?: string; content?: Record<string, unknown>; priority?: string | null; flow_role?: string | null; updated_by?: string };
      if (priority !== undefined && !["high", "medium", "low", null].includes(priority as any)) return res.status(400).json({ error: "priority must be high|medium|low|null" });
      if (flow_role !== undefined && !["problem", "cause", "mechanism", "outcome", "solution", "trigger", null].includes(flow_role as any)) return res.status(400).json({ error: "flow_role must be problem|cause|mechanism|outcome|solution|trigger|null" });
      const changes: Record<string, unknown> = {};
      if (essence    !== undefined) changes.essence    = essence;
      if (ttl        !== undefined) changes.ttl        = ttl;
      if (status     !== undefined) changes.status     = status;
      if (label      !== undefined) changes.label      = label;
      if (type       !== undefined) changes.type       = type;
      if (content    !== undefined) changes.content    = JSON.stringify(content);
      if (priority   !== undefined) changes.priority   = priority;
      if (flow_role  !== undefined) changes.flow_role  = flow_role;
      if (Object.keys(changes).length === 0) return res.status(400).json({ error: "No valid fields to update" });
      const updated = db.updateBlock(req.params.id, changes, "Updated via API", updated_by || "user");
      if (!updated) return res.status(404).json({ error: "Block not found" });
      db.save();
      res.json(updated);
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  router.delete("/api/blocks/:id", (req, res) => {
    try {
      const block = db.getBlock(req.params.id);
      if (!block) return res.status(404).json({ error: "Block not found" });
      if (block.locked) return res.status(403).json({ error: "Block is locked" });
      db.archiveBlock(req.params.id, "Archived via UI");
      db.save();
      res.json({ archived: true, id: req.params.id });
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  router.delete("/api/blocks", (req, res) => {
    try {
      const pattern = (req.query.pattern as string || "").trim();
      if (!pattern) return res.status(400).json({ error: "pattern query param required" });
      const all = db.getAllBlocks();
      const prefix = pattern.endsWith("*") ? pattern.slice(0, -1) : pattern;
      const targets = all.filter(b => b.label.startsWith(prefix) && !b.locked);
      for (const b of targets) db.archiveBlock(b.id, `Bulk archive: matches pattern ${pattern}`);
      if (targets.length > 0) db.save();
      res.json({ archived: targets.length, labels: targets.map(b => b.label) });
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  router.post("/api/blocks/:id/feedback", (req, res) => {
    try {
      const { useful } = req.body as { useful: boolean };
      const block = db.getBlock(req.params.id);
      if (!block) return res.status(404).json({ error: "Block not found" });
      db.updateBlock(req.params.id, { access_count: (block.access_count || 0) + (useful ? 1 : 0) }, useful ? "Positive recall feedback" : "Negative recall feedback", "user");
      db.save();
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  router.post("/api/blocks/:id/resolve", (req, res) => {
    try {
      const { action, other_id, reason } = req.body as { action: string; other_id: string; reason?: string };
      const block = db.getBlock(req.params.id);
      const other = other_id ? db.getBlock(other_id) : null;
      if (!block) return res.status(404).json({ error: "Block not found" });
      if (action === "keep_this" && other) { db.archiveBlock(other.id, reason || `Conflict resolved: kept ${block.label}`); db.save(); return res.json({ resolved: true, kept: block.id, archived: other.id }); }
      if (action === "keep_other" && other) { db.archiveBlock(block.id, reason || `Conflict resolved: kept ${other.label}`); db.save(); return res.json({ resolved: true, kept: other.id, archived: block.id }); }
      if (action === "archive_this") { db.archiveBlock(block.id, reason || "Archived via conflict resolution"); db.save(); return res.json({ resolved: true, archived: block.id }); }
      return res.status(400).json({ error: "action must be: keep_this | keep_other | archive_this" });
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  router.get("/api/blocks/:id/expand", (req, res) => {
    try {
      const anchor = db.getBlock(req.params.id);
      if (!anchor) return res.status(404).json({ error: "Block not found" });
      const EXPAND_TYPES = new Set(["related_to", "derived_from", "based_on", "caused_by", "part_of"]);
      const SKIP_TYPES   = new Set(["contradicts"]);
      const allRelations = db.getAllRelations(false);
      const neighborMap = new Map<string, string>();
      for (const r of allRelations) {
        if (SKIP_TYPES.has(r.type)) continue;
        if (!EXPAND_TYPES.has(r.type)) continue;
        if (r.source_id === anchor.id) neighborMap.set(r.target_id, r.type);
        else if (r.target_id === anchor.id) neighborMap.set(r.source_id, r.type);
      }
      const decayRates: Record<string, number> = { session: 2.0, "1hr": 1.0, "24hr": 0.5, "1week": 0.1, project: 0.01, permanent: 0.001 };
      const computeComposite = (block: any, similarity: number) => {
        const ageDays = (Date.now() - new Date(block.created_at).getTime()) / 86400000;
        const decayRate = decayRates[block.ttl ?? "permanent"] ?? 0.01;
        const recency = 1 / (1 + ageDays * decayRate);
        return { composite_score: similarity * recency, recency };
      };
      const neighbors = Array.from(neighborMap.entries())
        .map(([id, relType]) => ({ block: db.getBlock(id), relType }))
        .filter((entry): entry is { block: NonNullable<ReturnType<typeof db.getBlock>>; relType: string } => entry.block !== null && entry.block !== undefined && entry.block.status !== "archived")
        .map(({ block: b, relType }) => {
          const sim = Math.min(1.0, ((b.quality_score ?? 3) / 6) * 1.2);
          const { composite_score, recency } = computeComposite(b, sim);
          const { embedding: _e, content: _c, ...rest } = b as any;
          return { ...rest, relation_type: relType, composite_score: Math.round(composite_score * 10000) / 10000, pick_components: { similarity: Math.round(sim * 10000) / 10000, recency: Math.round(recency * 10000) / 10000 } };
        }).sort((a, b) => b.composite_score - a.composite_score);
      const { embedding: _ae, content: _ac, ...anchorData } = anchor as any;
      res.json({ anchor: anchorData, neighbors, total_context_blocks: 1 + neighbors.length });
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  router.get("/api/conflicts/near-duplicates", (_req, res) => {
    try { res.json(db.getOpenConflicts()); } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  router.post("/api/conflicts/near-duplicates/:id/resolve", (req, res) => {
    try {
      const { resolution, merged_essence, reason } = req.body as { resolution: "keep_a" | "keep_b" | "merge"; merged_essence?: string; reason?: string };
      const conflicts = db.getOpenConflicts();
      const conflict = conflicts.find((c) => c.id === req.params.id);
      if (!conflict) return res.status(404).json({ error: "Conflict not found or already resolved" });
      if (resolution === "keep_a") { db.archiveBlock(conflict.block_b.id, `resolved duplicate: kept ${conflict.block_a.label}`); }
      else if (resolution === "keep_b") { db.archiveBlock(conflict.block_a.id, `resolved duplicate: kept ${conflict.block_b.label}`); }
      else if (resolution === "merge" && merged_essence) { db.updateBlock(conflict.block_a.id, { essence: merged_essence }, `merged with ${conflict.block_b.label}`, undefined, true); db.archiveBlock(conflict.block_b.id, `merged into ${conflict.block_a.label}`); }
      else { return res.status(400).json({ error: "resolution must be keep_a | keep_b | merge (merge requires merged_essence)" }); }
      db.resolveConflict(req.params.id, `${resolution}${reason ? `: ${reason}` : ""}`);
      res.json({ resolved: true, conflict_id: req.params.id, resolution });
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  // ─── Agents ─────────────────────────────────────────────────────
  router.get("/api/agents", (_req, res) => {
    try {
      const agents = db.getRegisteredAgents();
      const allBlocks = db.getAllBlocks();
      const blockCounts: Record<string, number> = {};
      for (const b of allBlocks) { const a = b.created_by || "unknown"; blockCounts[a] = (blockCounts[a] || 0) + 1; }
      res.json(agents.map(a => ({ ...a, block_count: blockCounts[a.agent_id] || 0 })));
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  router.post("/api/agents/register", (req, res) => {
    try {
      const { agent_id, name, role, metadata } = req.body as { agent_id: string; name?: string; role?: string; metadata?: Record<string, unknown> };
      if (!agent_id) return res.status(400).json({ error: "agent_id required" });
      db.registerAgent(agent_id, name, role || "general", metadata);
      res.json({ registered: true, agent_id });
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  // ─── Relations ─────────────────────────────────────────────────
  router.post("/api/relations", (req, res) => {
    try {
      const { source_id, target_id, type, bidirectional } = req.body as { source_id: string; target_id: string; type: string; bidirectional?: boolean };
      if (!source_id || !target_id || !type) return res.status(400).json({ error: "source_id, target_id, and type are required" });
      if (!db.getBlock(source_id)) return res.status(400).json({ error: `source block "${source_id}" not found` });
      if (!db.getBlock(target_id)) return res.status(400).json({ error: `target block "${target_id}" not found` });
      const relation = db.createRelation({ source_id, target_id, type, bidirectional, created_by: "user" });
      db.save();
      res.status(201).json(relation);
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  router.get("/api/relations", (req, res) => {
    try {
      const { source_id, target_id, type } = req.query as { source_id?: string; target_id?: string; type?: string };
      let rels = db.getAllRelations(false);
      if (source_id) rels = rels.filter(r => r.source_id === source_id);
      if (target_id) rels = rels.filter(r => r.target_id === target_id);
      if (type) rels = rels.filter(r => r.type === type);
      res.json(rels);
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  router.get("/api/relations/pending", (_req, res) => {
    try { res.json(db.getPendingRelations()); } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  router.post("/api/relations/:id/approve", (req, res) => {
    try { db.approveRelation(req.params.id); res.json({ approved: true, id: req.params.id }); } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  router.post("/api/relations/:id/reject", (req, res) => {
    try { db.rejectRelation(req.params.id); res.json({ rejected: true, id: req.params.id }); } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  router.post("/api/relations/:id/invalidate", (req, res) => {
    try { const reason = (req.body as any)?.reason; res.json({ invalidated: db.invalidateRelation(req.params.id, reason), id: req.params.id }); } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  return router;
}
