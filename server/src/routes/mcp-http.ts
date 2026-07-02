// routes/mcp-http.ts — Streamable-HTTP MCP transport.
//
// WHY: the stdio transport (server.ts) only works when the MCP CLIENT can spawn the
// server binary IN ITS OWN ENVIRONMENT. A containerized host (e.g. Hermes in Docker)
// can't spawn a binary that lives on the Windows host — so it needs to reach the running
// server over the NETWORK. This exposes the SAME tool surface (buildWorkspaceServer) over
// HTTP at POST/GET/DELETE /mcp, so a client connects to e.g. http://host.docker.internal:3001/mcp.
//
// Stateful sessions: a client `initialize` mints a session (mcp-session-id header); later
// requests reuse it. One McpServer per session (cheap), sharing the db/embeddings singletons.
//
// SECURITY: /mcp is NOT under /api, and the global requireAuth gate EXEMPTS non-/api paths
// (defaultAuthExempt). Since /mcp is the WHOLE tool surface over the network, we gate it
// HERE with the same owner token — otherwise binding 0.0.0.0 would expose it unauthenticated.

import { Router } from "express";
import type { Request, Response } from "express";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { WorkspaceDB } from "../store/database.js";
import { EmbeddingEngine } from "../engine/embeddings.js";
import { buildWorkspaceServer } from "../mcp-server.js";
import { apiTokenEnabled, validateCredential, extractCredential, isLoopbackRequest } from "../middleware/auth.js";

export function createMcpHttpRouter(db: WorkspaceDB, embeddings: EmbeddingEngine): Router {
  const router = Router();
  // sessionId → transport. Cleaned up on transport close.
  const transports: Record<string, StreamableHTTPServerTransport> = {};

  // Same owner-token check as the rest of the API (the global gate exempts non-/api paths).
  const authed = (req: Request, res: Response): boolean => {
    if (!apiTokenEnabled()) return true; // open when no token configured (localhost default)
    if (isLoopbackRequest(req)) return true; // own machine — the token gates the network
    if (validateCredential(extractCredential(req))) return true;
    res.status(401).json({
      jsonrpc: "2.0",
      error: { code: -32001, message: "Unauthorized — send 'x-nodedex-token' or 'Authorization: Bearer <token>' (NODEDEX_API_TOKEN is enabled)" },
      id: null,
    });
    return false;
  };

  router.post("/mcp", async (req: Request, res: Response) => {
    if (!authed(req, res)) return;
    try {
      const sid = req.headers["mcp-session-id"] as string | undefined;
      let transport: StreamableHTTPServerTransport;

      if (sid && transports[sid]) {
        transport = transports[sid];                       // existing session
      } else if (!sid && isInitializeRequest(req.body)) {
        // New session: mint a transport + a fresh server with the full tool surface.
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (newId: string) => { transports[newId] = transport; },
        });
        transport.onclose = () => { if (transport.sessionId) delete transports[transport.sessionId]; };
        const server = buildWorkspaceServer(db, embeddings);
        await server.connect(transport);
      } else {
        res.status(400).json({
          jsonrpc: "2.0",
          error: { code: -32000, message: "Bad Request: no valid session ID (call initialize first)" },
          id: null,
        });
        return;
      }

      // Cast: the SDK augments `req.auth` as AuthInfo, our auth.ts augments it as
      // AuthIdentity — two module augmentations of the same global clash at the type
      // level only. The runtime objects are plain Express req/res, which the SDK accepts.
      await transport.handleRequest(req as never, res as never, req.body);
    } catch (e) {
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: String(e) }, id: null });
      }
    }
  });

  // GET = open the SSE stream; DELETE = terminate the session. Both need an existing session.
  const bySession = async (req: Request, res: Response): Promise<void> => {
    if (!authed(req, res)) return;
    const sid = req.headers["mcp-session-id"] as string | undefined;
    if (!sid || !transports[sid]) { res.status(400).send("Invalid or missing mcp-session-id"); return; }
    await transports[sid].handleRequest(req as never, res as never);
  };
  router.get("/mcp", bySession);
  router.delete("/mcp", bySession);

  return router;
}
