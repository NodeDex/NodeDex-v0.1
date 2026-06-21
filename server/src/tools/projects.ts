import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { WorkspaceDB } from "../store/database.js";
import { EmbeddingEngine } from "../engine/embeddings.js";
import { ok, err } from "./helpers.js";

export function registerProjectTools(server: McpServer, db: WorkspaceDB, _embeddings: EmbeddingEngine): void {

  // ─── Tool: workspace_project_create ──────────────────────────────
  server.tool(
    "workspace_project_create",
    `Create a new project space in the workspace. Automatically creates a project block.`,
    {
      name: z.string().describe("Project name (lowercase, unspaced)"),
      description: z.string().optional().describe("What the project is about"),
    },
    async (params) => {
      try {
        const block = db.createBlock({
          label: params.name,
          type: "project",
          essence: params.description || `Project: ${params.name}`,
          ttl: "permanent",
        });
        db.createProjectLog(params.name, "Project created.");
        return ok({
          project: params.name,
          block_id: block.id,
          status: "created",
        });
      } catch (error) {
        return err("PROJECT_CREATE_FAILED", String(error));
      }
    }
  );

  // ─── Tool: workspace_project_log ─────────────────────────────────
  server.tool(
    "workspace_project_log",
    `Add a journal entry to a project's activity log.`,
    {
      project: z.string().describe("Project name"),
      entry: z.string().describe("Log entry describing what happened or was decided"),
    },
    async (params) => {
      try {
        const log = db.createProjectLog(params.project, params.entry);
        return ok({
          project: params.project,
          entry_id: log.id,
          logged: true,
        });
      } catch (error) {
        return err("PROJECT_LOG_FAILED", String(error));
      }
    }
  );

  // ─── Tool: workspace_project_status ──────────────────────────────
  server.tool(
    "workspace_project_status",
    `Get the current state of a project: recent activity and key blocks.`,
    {
      project: z.string().describe("Project name"),
    },
    async (params) => {
      try {
        const logs = db.getProjectLogs(params.project, 5);
        const blocks = db.getProjectBlocks(params.project);

        const projectBlock = db.getBlock(params.project);
        if (!projectBlock && blocks.length === 0 && logs.length === 0) {
          return err("PROJECT_NOT_FOUND", `Project '${params.project}' has no logs or blocks.`);
        }

        return ok({
          project: params.project,
          metadata: projectBlock ? { id: projectBlock.id, essence: projectBlock.essence } : null,
          recent_activity: logs,
          associated_blocks: blocks.map(b => ({ id: b.id, label: b.label, type: b.type, essence: b.essence })),
        });
      } catch (error) {
        return err("PROJECT_STATUS_FAILED", String(error));
      }
    }
  );

  // ─── Tool: workspace_project_resume ──────────────────────────────
  server.tool(
    "workspace_project_resume",
    `Resume a project session — returns a full briefing so the agent can pick up exactly where it left off.
Returns: open tasks, key decisions, active constraints, recent activity, and derived insights.
Call this ONCE at the start of a new conversation, before workspace_auto_recall.

Pass 'since' to get a delta of what changed since your last session:
  workspace_project_resume({ project: "wmcs", since: "2026-03-15T10:00:00Z" })
Returns new blocks, updated blocks, and a history summary — so you know what happened while you were away.`,
    {
      project: z.string().describe("Project name"),
      since:   z.string().optional().describe("ISO timestamp — return a delta of what changed since this time"),
    },
    async (params) => {
      try {
        const logs  = db.getProjectLogs(params.project, 10);
        let blocks = db.getProjectBlocks(params.project);

        // Fallback: if sparse project links, supplement with recently active blocks
        if (blocks.filter((b) => b.type !== "project").length < 3) {
          const recent = db.getRecentBlocks(15);
          const existingIds = new Set(blocks.map((b) => b.id));
          blocks = [...blocks, ...recent.filter((b) => !existingIds.has(b.id))];
        }

        // Parse content safely
        const parsed = blocks.map((b) => {
          let content: Record<string, unknown> = {};
          try { content = JSON.parse(b.content); } catch { /* ignore */ }
          return { ...b, _content: content };
        });

        // Bucket by type — agent needs different things for different types
        const tasks       = parsed.filter((b) => b.type === "task");
        const decisions   = parsed.filter((b) => b.type === "decision");
        const constraints = parsed.filter((b) => b.type === "constraint");
        const derived     = parsed.filter((b) => b._content?.derivation);
        const other       = parsed.filter(
          (b) => !["task", "decision", "constraint", "project"].includes(b.type) && !b._content?.derivation
        );

        // Summarise helper — strips DB noise, keeps what the agent needs
        const summarise = (b: any) => ({
          id:         b.id,
          label:      b.label,
          type:       b.type,
          essence:    b.essence,
          unique:     b._content.unique   || undefined,
          has:        b._content.has      || undefined,
          concepts:   b._content.concepts || undefined,
          created_at: b.created_at,
          updated_at: b.updated_at !== b.created_at ? b.updated_at : undefined,
          created_by: b.created_by || undefined,
        });

        // Open tasks only (not archived/done)
        const openTasks = tasks.filter((t) => {
          const status = (t._content?.unique as any)?.status;
          return !status || !["done", "completed", "archived"].includes(status.toLowerCase());
        });

        // ── Session delta (since param) ──────────────────────────────
        let since_last_session: Record<string, unknown> | undefined;
        if (params.since) {
          const sinceMs = new Date(params.since).getTime();
          const allBlocks = db.getAllBlocks();
          const newBlocks = allBlocks.filter(
            (b) => new Date(b.created_at).getTime() > sinceMs
          );
          const updatedBlocks = allBlocks.filter(
            (b) =>
              new Date(b.updated_at).getTime() > sinceMs &&
              new Date(b.created_at).getTime() <= sinceMs
          );
          const recentHistory = db.getHistory(undefined, 100).filter(
            (h) => new Date(h.changed_at).getTime() > sinceMs
          );
          since_last_session = {
            since: params.since,
            new_blocks: newBlocks.map((b) => ({
              id: b.id, label: b.label, type: b.type, essence: b.essence, created_at: b.created_at,
            })),
            updated_blocks: updatedBlocks.map((b) => ({
              id: b.id, label: b.label, type: b.type, essence: b.essence, updated_at: b.updated_at,
            })),
            change_log: recentHistory.slice(0, 30).map((h) => ({
              block_id: h.block_id, field: h.field_changed, at: h.changed_at, by: h.changed_by,
            })),
            summary: {
              new_blocks: newBlocks.length,
              updated_blocks: updatedBlocks.length,
              changes: recentHistory.length,
            },
          };
        }

        return ok({
          project: params.project,
          resume_briefing: {
            open_tasks:      openTasks.map(summarise),
            key_decisions:   decisions.map(summarise),
            constraints:     constraints.map(summarise),
            derived_insights: derived.slice(0, 5).map((b) => ({
              id:         b.id,
              label:      b.label,
              essence:    b.essence,
              reasoning:  (b._content.derivation as any)?.logic || undefined,
            })),
            other_blocks:    other.slice(0, 10).map(summarise),
          },
          recent_activity: logs.map((l) => ({ at: l.created_at, entry: l.entry })),
          ...(since_last_session ? { since_last_session } : {}),
          summary: {
            total_blocks:  blocks.length,
            open_tasks:    openTasks.length,
            decisions:     decisions.length,
            constraints:   constraints.length,
          },
        });
      } catch (error) {
        return err("PROJECT_RESUME_FAILED", String(error));
      }
    }
  );
}
