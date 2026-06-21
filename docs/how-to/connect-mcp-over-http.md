# Connect a remote / Docker MCP client over HTTP

Nodedex's MCP server speaks **two transports**:
- **stdio** (default) — the host *spawns* `node …/nodedex-entry.mjs` as a child process. Works
  only when the client can run that binary **in its own environment**.
- **Streamable HTTP** (`/mcp`) — the client reaches a *running* server **over the network**.

**Use HTTP when the client can't spawn the binary** — most importantly a **containerized host**
(e.g. Hermes in Docker): the repo + `node` live on the host, not in the container, so stdio fails
("Cannot find / can't spawn"). The container talks to the host server over HTTP instead.

## 1. Run the server on the host (network-reachable + token-protected)

Add to `~/.nodedex/.env` (or the repo `.env`):
```
NODEDEX_BIND_HOST=0.0.0.0     # so a container can reach it via host.docker.internal
NODEDEX_API_TOKEN=<a-secret>  # REQUIRED once on 0.0.0.0 — /mcp enforces it
```
Then start it on the host:
```
cd server && npm run build && npm start     # or in dev: npm run dev
```
Boot log confirms the endpoint:
```
MCP (HTTP) endpoint: http://127.0.0.1:3001/mcp — for networked clients (e.g. Docker: http://host.docker.internal:3001/mcp)
```

> ⚠ `0.0.0.0` makes the graph reachable on the network. The `NODEDEX_API_TOKEN` is what protects
> it — `/mcp` is gated by it (the boot log warns if you bind `0.0.0.0` with no token). Don't expose
> it without the token.

## 2. Point the client at it (HTTP, not stdio)

In the host app's MCP settings, add an **HTTP / streamable-HTTP server** (not the stdio
command/args form):
- **URL:** `http://host.docker.internal:3001/mcp`  *(from a Docker Desktop container on Windows/Mac;
  on Linux Docker, add `--add-host=host.docker.internal:host-gateway` to the container)*
- **Auth header:** `Authorization: Bearer <your-token>`  *(or `x-nodedex-token: <your-token>` —
  both are accepted)*

The agent then gets the same read-only tool surface as stdio (get, search, filter, tree, list,
stats, history, find_skill, onboard, install_capture).

## 3. Capture (write side), if wired in the container

If the capture adapter runs inside the container, point it at the host too:
```
NODEDEX_URL=http://host.docker.internal:3001
```

## How it works

`/mcp` is a native MCP **Streamable HTTP** transport (stateful sessions keyed by `mcp-session-id`)
serving the **same tool surface** as stdio (one `buildWorkspaceServer` factory feeds both, so they
can't drift). The server, the graph (SQLite), and the LLM keys all stay on the **host** — only the
MCP protocol crosses the boundary. See `server/src/routes/mcp-http.ts`.
