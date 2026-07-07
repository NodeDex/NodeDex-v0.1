// mcp-server.ts — the ONE factory that builds a fully-configured Workspace MCP server
// (the `instructions` field + the read-only agent gating + all tools). Used by BOTH
// transports so the tool surface CANNOT drift between them:
//   • stdio  — server.ts (the local, host-spawned path)
//   • HTTP   — routes/mcp-http.ts (per session; the networked path, e.g. a Dockerized
//              host reaching the server over host.docker.internal)
//
// Extracted from server.ts when the HTTP transport was added (Option B) so a containerized
// MCP client — which can't spawn a host stdio binary — can still reach the same tools.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WorkspaceDB } from "./store/database.js";
import { EmbeddingEngine } from "./engine/embeddings.js";
import { registerCoreTools } from "./tools/core.js";
import { registerDeriveTools } from "./tools/derive.js";
import { registerProjectTools } from "./tools/projects.js";
import { registerTaskTools } from "./tools/tasks.js";
import { registerSystemTools } from "./tools/system.js";
import { appendFlagNudge } from "./tools/flag-surface.js";
import { AGENT_PROTOCOL } from "./agent-protocol.js";

// The MCP `instructions` field — the advisory FLOOR the host injects on connect. Installs
// the two reflexes + traversal loop (shared AGENT_PROTOCOL) + the onboard nudge.
export const WORKSPACE_INSTRUCTIONS = `${AGENT_PROTOCOL}

First time connecting in this project? Call workspace_onboard ONCE — it offers to persist these reflexes into your own standing config (it checks whether you can, and you explain why + ask the user first). If you can't persist, this advisory copy still applies for the session.`;

// The agent surface is READ-ONLY by default — it traverses/queries/retrieves; the pipeline
// does all writing. Pure reads only. (extract_arc etc. are INFRA, triggered by host/timer.)
const READ_TOOLS_BASE = [
  "workspace_get", "workspace_thread", "workspace_search", "workspace_filter", "workspace_tree",
  "workspace_list", "workspace_stats", "workspace_history", "workspace_find_skill",
  "workspace_onboard", "workspace_install_capture",
];
// Task tools are opt-in (a host often has its own task system).
const TASK_TOOLS = ["workspace_task_next", "workspace_task_create", "workspace_task_update"];

/** Whether write/admin/maintenance tools are exposed (default off → read-only surface). */
export function writesExposed(): boolean {
  return (process.env.NODEDEX_EXPOSE_WRITE_TOOLS ?? "").toLowerCase() === "on";
}

/** The tool names the agent surface exposes given current env flags (for boot logging). */
export function agentToolAllowlist(): Set<string> {
  const allow = new Set<string>(READ_TOOLS_BASE);
  if ((process.env.NODEDEX_EXPOSE_TASKS ?? "").toLowerCase() === "on") {
    for (const t of TASK_TOOLS) allow.add(t);
  }
  return allow;
}

/** Build a Workspace MCP server: instructions, read-only gating, and every tool registered.
 *  A fresh instance is cheap (registration is pure) — the HTTP path builds one per session;
 *  db + embeddings are shared singletons passed in. */
export function buildWorkspaceServer(db: WorkspaceDB, embeddings: EmbeddingEngine): McpServer {
  const server = new McpServer(
    { name: "workspace", version: "1.0.0-MVP" },
    { instructions: WORKSPACE_INSTRUCTIONS },
  );

  // Wrap server.tool BEFORE the register calls so two cross-cutting concerns apply to
  // every tool without touching a single handler:
  //   1. read-only gating  — skip tools not in the allowlist (unless writes exposed).
  //   2. flag nudge        — append a passive "N items need your input" note to each
  //      result when self-maintenance routed work to the agent. A passive MCP tool
  //      can't push, so the agent discovers pending flags by bumping into this on a
  //      call it was already making. Best-effort, never breaks the tool.
  {
    const allow = writesExposed() ? null : agentToolAllowlist();
    const registerTool = server.tool.bind(server) as (...a: unknown[]) => unknown;
    (server as unknown as { tool: (...a: unknown[]) => unknown }).tool = (...args: unknown[]) => {
      const name = args[0] as string;
      if (allow && !allow.has(name)) return undefined; // gated out of the read-only surface
      const handler = args[args.length - 1];
      if (typeof handler === "function") {
        const orig = handler as (...h: unknown[]) => unknown;
        args[args.length - 1] = async (...h: unknown[]) =>
          appendFlagNudge((await orig(...h)) as never, db, name);
      }
      return registerTool(...args);
    };
  }

  registerCoreTools(server, db, embeddings);
  registerDeriveTools(server, db, embeddings);
  registerProjectTools(server, db, embeddings);
  registerTaskTools(server, db, embeddings);
  registerSystemTools(server, db, embeddings);
  return server;
}
