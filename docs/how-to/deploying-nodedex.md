# Deploying Nodedex — how an agent connects, starts, and uses it

The plain-language guide to wiring Nodedex into any agent. Read this first; the
HTTP/Docker specifics are in [connect-mcp-over-http.md](connect-mcp-over-http.md).

## The model (two sides)

Nodedex is **one local server** an agent's app talks to. It has two sides:

- **READ — the agent.** The agent's app connects to Nodedex and gets **tools**
  (`workspace_get`, `workspace_tree`, `workspace_search`, …). The agent calls them to look
  up what's been decided / tried / ruled out before it acts.
- **WRITE — automatic, behind the scenes.** A background pipeline reads your conversations
  and saves the durable bits (decisions, dead-ends, reasoning) into the graph. **The agent
  does not write** — it just reads.

It's **local-first**: runs on the user's own machine with the user's own LLM key. Nothing
hosted by us, no cloud.

## Two deployment shapes — pick by WHERE the agent runs

This is the one decision that determines everything.

| | **A. Agent on the same machine** (the easy, default path) | **B. Agent sandboxed / containerized / remote** (e.g. Hermes-in-Docker) |
|---|---|---|
| Examples | a local agent / CLI running on the same PC | an autonomous agent (e.g. Hermes) boxed in Docker, or on another machine |
| Transport | **stdio** (the app spawns Nodedex) | **HTTP** (the app connects to a URL) |
| Who starts Nodedex? | **The agent's app starts it automatically** every session. You do nothing. | **You run it once** (`npm start`); it stays running as a server. |
| Tools reach the agent | The app spawns Nodedex + injects the tools. | The app connects over the network + injects the tools. |
| Effort | Configure once → it just works | Run the server + give the app a URL |

### A. Same machine (stdio) — recommended whenever possible
In the agent app's MCP config, add a stdio server:
```json
{
  "command": "node",
  "args": ["<abs-path>/server/scripts/nodedex-entry.mjs"],
  "env": {}
}
```
The app launches Nodedex for you on every session. Keys/model/DB come from `~/.nodedex/.env`
(loaded on every boot). Nothing to start manually.

### B. Sandboxed / remote (HTTP) — when the app can't spawn a host process
A containerized agent can't reach a host process over stdio pipes — use HTTP:
1. Run the server on the host: `cd server && npm run build && npm start` (leave it running).
2. Expose it: `NODEDEX_BIND_HOST=0.0.0.0` in `~/.nodedex/.env` (+ `NODEDEX_API_TOKEN` to
   protect it, since `0.0.0.0` is network-reachable).
3. Point the agent app at the URL: `http://<host>:3001/mcp`.
4. Reload the app's MCP (e.g. `/reload-mcp`) or start a new session — tools register at startup.

**⚠ The URL perspective gotcha** (the thing that bites): use the hostname *from the
connecting process's point of view*.
- If the **host app / gateway** opens the connection (it runs on the host) → `http://localhost:3001/mcp`.
- If the **container itself** opens the connection → `http://host.docker.internal:3001/mcp`.
- Unsure? Try `localhost` first; if the app logs `ECONNREFUSED` / can't resolve, try the
  other. The app's own logs show the actual connection attempt.

## Do we need to "tell" the agent its tools?

- **Native MCP (either A or B): NO.** When the app injects the tools, each arrives
  **self-described** — name, input schema, and a description of what it does and when to use
  it. Nodedex also ships usage guidance via the MCP **`instructions`** field (the two
  reflexes + the traversal loop) and `workspace_onboard` (which can persist that into the
  agent's *own* config on capable hosts). So a properly-connected agent knows its tools
  automatically — you don't list anything.
- **Symptom to recognize:** if the agent starts hand-writing HTTP/`curl`/`urllib` calls to
  "find" the server, that means the tools were **not** injected (a config/connection problem),
  and it's improvising. Fix the connection — don't paper over it.
- **REST fallback (a crutch):** if you can't get native MCP injection working, you can point
  the agent at the plain REST API and **list the endpoints for it** (raw HTTP doesn't
  self-describe). Endpoints + shapes are in the web-UI kit / [connect-mcp-over-http.md]. This
  works when prompted but the agent won't use memory reflexively — prefer native MCP.

## The write side (how memory grows)

Separate from the agent's reads. Each turn is pushed to `POST /api/reflect/trigger`; the
pipeline extracts asynchronously. The agent host pushes each turn via the tee adapter
(`workspace_install_capture` deploys `adapters/nodedex-capture.mjs`). Reflection can be
paused with `~/.nodedex/reflect-pause`.

## Env essentials (`~/.nodedex/.env`, loaded on every boot)

```
AI_PROVIDER=openai-compatible           # or gemini / anthropic
OPENAI_BASE_URL=https://openrouter.ai/api/v1
OPENAI_API_KEY=sk-or-...                # the LLM key
AI_MODEL=openrouter/owl-alpha
EMBEDDING_PROVIDER=gemini               # embeddings (OpenRouter doesn't serve them)
GEMINI_API_KEY=...                      # for embeddings / semantic search
WORKSPACE_DB_PATH=<abs>/Nodedex/data/workspace.db
# HTTP exposure only:
NODEDEX_BIND_HOST=0.0.0.0
NODEDEX_API_TOKEN=<secret>              # sent as Authorization: Bearer <secret>
```

## TL;DR
- **Same machine → stdio → the app auto-starts it → done.** This is how it's meant to feel.
- **Sandboxed/remote → HTTP → you run the server, the app connects by URL** (mind the
  `localhost` vs `host.docker.internal` perspective).
- Either way, **a connected agent gets its tools automatically** — if it's probing by hand,
  the connection isn't set up.
