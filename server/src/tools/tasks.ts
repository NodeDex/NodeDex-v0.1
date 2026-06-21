import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { WorkspaceDB } from "../store/database.js";
import { EmbeddingEngine, blockEmbeddingText } from "../engine/embeddings.js";
import { ok, err, cosineSim } from "./helpers.js";

export function registerTaskTools(server: McpServer, db: WorkspaceDB, embeddings: EmbeddingEngine): void {

  // ─── Tool: workspace_task_create ─────────────────────────────────
  server.tool(
    "workspace_task_create",
    `Create a task in the workspace. Automatically links to related decisions, constraints, and a milestone.
Returns the task block ID and all auto-linked blocks so the agent knows what context exists.`,
    {
      label:    z.string().describe("Short unique name, underscore-separated (e.g. 'build_auth_endpoint')"),
      essence:  z.string().describe("One sentence: what needs to be done"),
      priority: z.enum(["high", "medium", "low"]).optional().describe("Task priority. Default: medium"),
      milestone_id: z.string().optional().describe("Milestone block ID or label this task belongs to"),
      depends_on:   z.array(z.string()).optional().describe("Task block IDs that must be done first"),
      assigned_to:  z.string().optional().describe("Agent role assigned to this task (e.g. 'coder', 'reviewer')"),
      acceptance_criteria: z.array(z.string()).optional().describe("List of conditions that define done"),
      concepts: z.array(z.string()).optional().describe("Tags for semantic search"),
      project_id: z.string().optional().describe("Project to link this task to"),
    },
    async (params) => {
      try {
        const priority = params.priority || "medium";
        const relations: Array<{ type: string; target_id: string }> = [];

        // Link to milestone if provided
        if (params.milestone_id) {
          const ms = db.getBlock(params.milestone_id);
          if (ms) relations.push({ type: "belongs_to", target_id: ms.id });
        }

        // Link to dependencies
        for (const depId of (params.depends_on || [])) {
          const dep = db.getBlock(depId);
          if (dep) relations.push({ type: "depends_on", target_id: dep.id });
        }

        // Resolve project for project_id column
        let resolvedProjectId: string | undefined;
        if (params.project_id) {
          const proj = db.getBlock(params.project_id) ||
            db.getAllBlocks().find(b => b.type === "project" && b.label === params.project_id);
          if (proj) resolvedProjectId = proj.id;
        }

        // Auto-link ALL active constraints (tasks must always know their constraints)
        const allBlocks = db.getAllBlocks();
        const constraints = allBlocks.filter(b => b.type === "constraint" && b.status !== "archived");
        for (const c of constraints) {
          relations.push({ type: "constrained_by", target_id: c.id });
        }

        // Auto-link semantically related decisions (cosine > 0.65)
        const taskEmbedding = await embeddings.embed(blockEmbeddingText({ essence: params.essence, concepts: params.concepts }));
        const autoLinkedDecisions: string[] = [];
        if (taskEmbedding) {
          const decisions = allBlocks.filter(b => b.type === "decision" && b.status !== "archived" && b.embedding);
          for (const d of decisions) {
            try {
              const dVec = JSON.parse(d.embedding!) as number[];
              const sim = cosineSim(taskEmbedding, dVec);
              if (sim > 0.65) {
                relations.push({ type: "affected_by", target_id: d.id });
                autoLinkedDecisions.push(d.id);
              }
            } catch { /* skip */ }
          }
        }

        // Create the task block
        const embedding = taskEmbedding ?? undefined;
        const block = db.createBlock({
          label:  params.label,
          type:   "task",
          status: "active",
          essence: params.essence,
          content: {
            is_a:     "task",
            unique: {
              status:       "open",
              priority,
              assigned_to:  params.assigned_to || "unassigned",
            },
            has: {
              acceptance_criteria: params.acceptance_criteria || [],
              depends_on: params.depends_on || [],
            },
            relations,
            concepts: params.concepts || [],
          },
          ttl: "project",
          source: "workspace_task_create",
          embedding,
          project_id: resolvedProjectId,
        });

        return ok({
          task_id: block.id,
          label:   block.label,
          priority,
          status:  "open",
          auto_linked: {
            constraints:  constraints.map(c => ({ id: c.id, label: c.label, essence: c.essence })),
            decisions:    autoLinkedDecisions.map(id => {
              const d = db.getBlock(id);
              return d ? { id: d.id, label: d.label, essence: d.essence } : null;
            }).filter(Boolean),
          },
        });
      } catch (error) {
        return err("TASK_CREATE_FAILED", String(error));
      }
    }
  );

  // ─── Tool: workspace_task_next ────────────────────────────────────
  server.tool(
    "workspace_task_next",
    `Get the next task to work on — atomically claimed so no other agent can pick it up simultaneously.
Layer 1 (full): task + all constraints + milestone.
Layer 2 (summaries): linked decisions, files, artifacts, entities.
Layer 3: use workspace_get(id) on any summary to read it in full.
Marks task as in_progress and claims it for your agent_id.
Call workspace_heartbeat regularly while working so the claim doesn't expire.`,
    {
      project_id:  z.string().optional().describe("Filter tasks by project"),
      assigned_to: z.string().optional().describe("Filter by agent role"),
      agent_id:    z.string().optional().describe("Your agent ID — used to claim the task atomically. Falls back to WMCS_AGENT_ID env var."),
    },
    async (params) => {
      try {
        const allBlocks = db.getAllBlocks();

        // Find open tasks, respect project filter
        let tasks = allBlocks.filter(b => {
          if (b.type !== "task" || b.status === "archived") return false;
          const content = typeof b.content === "string" ? JSON.parse(b.content) : b.content;
          const taskStatus = content?.unique?.status;
          if (!taskStatus || taskStatus === "done" || taskStatus === "blocked") return false;
          if (params.assigned_to && content?.unique?.assigned_to !== params.assigned_to) return false;
          if (params.project_id) {
            const proj = allBlocks.find(bl => bl.type === "project" &&
              (bl.id === params.project_id || bl.label === params.project_id));
            if (!proj || b.project_id !== proj.id) return false;
          }
          return true;
        });

        if (tasks.length === 0) return ok({ message: "No open tasks found.", tasks_remaining: 0 });

        // Sort by priority: high > medium > low
        const priorityOrder: Record<string, number> = { high: 0, medium: 1, low: 2 };
        tasks.sort((a, b) => {
          const ca = typeof a.content === "string" ? JSON.parse(a.content) : a.content;
          const cb = typeof b.content === "string" ? JSON.parse(b.content) : b.content;
          const pa = priorityOrder[ca?.unique?.priority || "medium"] ?? 1;
          const pb = priorityOrder[cb?.unique?.priority || "medium"] ?? 1;
          return pa - pb;
        });

        // Filter out tasks with unmet dependencies
        const readyTasks = tasks.filter(t => {
          const content = typeof t.content === "string" ? JSON.parse(t.content) : t.content;
          const relations = content?.relations || [];
          const depIds = relations
            .filter((r: any) => r.type === "depends_on")
            .map((r: any) => r.target_id);
          return depIds.every((depId: string) => {
            const dep = db.getBlock(depId);
            if (!dep) return true;
            const depContent = typeof dep.content === "string" ? JSON.parse(dep.content) : dep.content;
            return depContent?.unique?.status === "done";
          });
        });

        if (readyTasks.length === 0) return ok({ message: "All open tasks are blocked by dependencies.", tasks_remaining: tasks.length });

        const task = readyTasks[0];
        const taskContent = typeof task.content === "string" ? JSON.parse(task.content) : task.content;
        const taskRelations: Array<{ type: string; target_id: string }> = taskContent?.relations || [];

        // ── LAYER 1: Full detail — task + constraints + milestone ──────
        const constraintIds = taskRelations
          .filter((r: any) => r.type === "constrained_by")
          .map((r: any) => r.target_id);
        const layer1Constraints = constraintIds
          .map((id: string) => db.getBlock(id))
          .filter(Boolean)
          .map((b: any) => ({
            id: b.id, label: b.label, essence: b.essence,
            unique: (typeof b.content === "string" ? JSON.parse(b.content) : b.content)?.unique,
          }));

        const milestoneRel = taskRelations.find((r: any) => r.type === "belongs_to");
        const milestone = milestoneRel ? db.getBlock(milestoneRel.target_id) : null;

        // ── LAYER 2: Summaries of linked blocks ────────────────────────
        const summarise = (b: any) => ({ id: b.id, label: b.label, type: b.type, essence: b.essence });

        const layer2: Record<string, any[]> = { decisions: [], files: [], artifacts: [], entities: [] };
        for (const rel of taskRelations) {
          const linked = db.getBlock(rel.target_id);
          if (!linked || linked.status === "archived") continue;
          if (linked.type === "decision")  layer2.decisions.push(summarise(linked));
          if (linked.type === "file")      layer2.files.push(summarise(linked));
          if (linked.type === "artifact")  layer2.artifacts.push(summarise(linked));
          if (linked.type === "entity")    layer2.entities.push(summarise(linked));
        }

        // Atomically claim the task before returning it
        const agentId = params.agent_id || process.env.WMCS_AGENT_ID || "anonymous";
        const claimResult = db.claimBlock(task.id, agentId, 600); // 10-min TTL
        if (!claimResult.claimed) {
          // Another agent just grabbed it — try the next one
          const nextReady = readyTasks.slice(1);
          if (nextReady.length === 0) return ok({ message: "All ready tasks are currently claimed by other agents.", tasks_remaining: 0 });
          // Recurse by returning a helpful hint
          return ok({ message: `Task '${task.label}' is claimed by '${claimResult.claimed_by}'. Call workspace_task_next again to get the next available task.`, tasks_remaining: nextReady.length });
        }

        // Mark task as in_progress
        db.updateBlock(task.id, {
          content: {
            ...taskContent,
            unique: { ...taskContent.unique, status: "in_progress", claimed_by: agentId },
          },
        }, `workspace_task_next: claimed by ${agentId}`);

        // Update agent heartbeat with current task
        db.agentHeartbeat(agentId, "worker", task.label);

        return ok({
          tasks_remaining: readyTasks.length,
          layer1: {
            task: {
              id:       task.id,
              label:    task.label,
              essence:  task.essence,
              priority: taskContent.unique?.priority,
              assigned_to: taskContent.unique?.assigned_to,
              acceptance_criteria: taskContent.has?.acceptance_criteria || [],
              depends_on: taskContent.has?.depends_on || [],
            },
            constraints: layer1Constraints,
            milestone: milestone ? { id: milestone.id, label: milestone.label, essence: milestone.essence } : null,
          },
          layer2,
          hint: "Use workspace_get(id) on any layer2 block to read it in full.",
        });
      } catch (error) {
        return err("TASK_NEXT_FAILED", String(error));
      }
    }
  );

  // ─── Tool: workspace_task_update ──────────────────────────────────
  server.tool(
    "workspace_task_update",
    `Update a task's status. Use after completing or getting blocked on a task.
Automatically logs the update to the project activity.`,
    {
      id:     z.string().describe("Task block ID or label"),
      status: z.enum(["open", "in_progress", "done", "blocked"]).describe("New status"),
      note:   z.string().optional().describe("What was done, or what is blocking this task"),
      artifact_ids: z.array(z.string()).optional().describe("Block IDs of artifacts produced by this task"),
      project_id:   z.string().optional().describe("Project to log this update to"),
    },
    async (params) => {
      try {
        const block = db.getBlock(params.id);
        if (!block) return err("NOT_FOUND", `Task '${params.id}' not found`);

        const content = typeof block.content === "string" ? JSON.parse(block.content) : block.content;

        // Link produced artifacts to this task
        const relations = [...(content?.relations || [])];
        for (const artId of (params.artifact_ids || [])) {
          const art = db.getBlock(artId);
          if (art && !relations.some((r: any) => r.target_id === art.id)) {
            relations.push({ type: "produced", target_id: art.id });
          }
        }

        db.updateBlock(block.id, {
          content: {
            ...content,
            unique: { ...content.unique, status: params.status, ...(params.status === "blocked" && params.note ? { blocked_reason: params.note } : {}) },
            relations,
          },
        }, params.note || `Status updated to ${params.status}`);

        // Log to project if provided
        if (params.project_id) {
          const emoji = { done: "✓", blocked: "⚠", in_progress: "→", open: "○" }[params.status] || "·";
          db.createProjectLog(params.project_id, `${emoji} Task '${block.label}' → ${params.status}${params.note ? `: ${params.note}` : ""}`);
        }

        return ok({
          id:     block.id,
          label:  block.label,
          status: params.status,
          note:   params.note,
          artifacts_linked: (params.artifact_ids || []).length,
        });
      } catch (error) {
        return err("TASK_UPDATE_FAILED", String(error));
      }
    }
  );
}
