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
1. Run the server on the host — from `server/`, run `npm run build` then `npm start` on separate
   lines (PowerShell 5.1 has no `&&`). Leave it running.
2. Expose it: `NODEDEX_BIND_HOST=0.0.0.0` in `~/.nodedex/.env` (+ `NODEDEX_API_TOKEN` to
   protect it, since `0.0.0.0` is network-reachable).
3. Point the agent app at the URL: `http://<host>:3001/mcp`.
4. Reload the app's MCP (e.g. `/reload-mcp`) or start a new session — tools register at startup.

**⚠ The URL perspective gotcha** (the thing that bites): use the hostname *from the
connecting process's point of view*.
- If the **host app / gateway** opens the connection (it runs on the host) → `http://127.0.0.1:3001/mcp` (use `127.0.0.1`, not `localhost` — on Windows `localhost` hits IPv6 `::1` first and an IPv4-bound server won't answer).
- If the **container itself** opens the connection → `http://host.docker.internal:3001/mcp`.
- Unsure? Try `127.0.0.1` first; if the app logs `ECONNREFUSED` / can't resolve, try the
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

## The write side (capture) — a SEPARATE wire, pick by host

Capture is **independent of the agent's reads** and is what actually grows the graph:
something has to push each finished turn to `POST /api/reflect/trigger`, and the pipeline
extracts asynchronously. **A connected agent does NOT do this** — MCP is read-only, so
**without a capture wire the graph stays empty.** (The #1 gotcha: people connect MCP, see an
empty graph, and assume it's broken. It isn't — capture is a second wire you set up.)

Three mechanisms; pick the one that fits your host:

| Mechanism | How | Use when |
|---|---|---|
| **Tee** | `workspace_install_capture` returns a small out-of-path adapter (`adapters/nodedex-capture.mjs`) you drop into the agent's post-turn seam; it POSTs `{user, response, reasoning}` to `${NODEDEX_URL}/api/reflect/trigger`, fire-and-forget (your model call is never touched). | You **control the agent's loop/code** (Agent SDK, your own loop, a container you build). |
| **Proxy** | Point the agent's **model base-URL** at `…/api`; NodeDex relays each call to your real provider (your key, unchanged, no added latency, streaming intact) and captures the turn in passing. | The host lets you **redirect its model endpoint** and honors a custom base-URL. |
| **Watcher** | A host-side process reads the agent's own conversation store (e.g. Hermes `state.db`) and POSTs each turn. Needs **zero cooperation** from the agent. | The agent is a **closed sandbox** you can't modify (e.g. Hermes — it ignores a custom base-URL and never fires shell hooks). Turn it on in TUI → health view → `hermes` (capture watchers). |

> ⚠ **The tee can't be deployed inside a sandbox you don't control** (no host filesystem, no
> loop hook) — that's exactly why the proxy and watcher exist. For **Hermes specifically, only
> the watcher works** (it ignores base-URLs and never invokes hooks).

On a token-gated server (`NODEDEX_API_TOKEN` set), the tee and watcher must send the token
(`NODEDEX_TOKEN` where the tee runs); the **proxy is exempt** (it carries your own provider
key). Reflection can be paused globally with `~/.nodedex/reflect-pause`.

## Putting both wires together — by setup

| Setup | READ (connect) | CAPTURE (write) |
|---|---|---|
| Same machine, you control its config | **stdio** (app auto-spawns) | **tee** in its post-turn seam; or **proxy** if it honors a base-URL |
| Same machine, closed agent (Hermes on host) | **HTTP** `/mcp` @ `127.0.0.1:<port>` | **watcher** (reads its `state.db`) — tee/proxy don't work for Hermes |
| Docker, you control the loop/code | **HTTP** `/mcp` @ `host.docker.internal:<port>` (+ token) | **tee inside the container**, `NODEDEX_URL=http://host.docker.internal:<port>` |
| Docker, honors model base-URL | **HTTP** `/mcp` @ `host.docker.internal` | **proxy**: model base-URL → `http://host.docker.internal:<port>/api` |
| Docker, closed sandbox (store inside container) | **HTTP** `/mcp` @ `host.docker.internal` | **watcher** — mount the store out to the host (the genuinely hard case) |

## Env essentials (`~/.nodedex/.env`, loaded on every boot)

```
AI_PROVIDER=openai-compatible           # or gemini / anthropic
OPENAI_BASE_URL=https://openrouter.ai/api/v1
OPENAI_API_KEY=sk-or-...                # the LLM key
AI_MODEL=google/gemini-2.5-flash-lite
EMBEDDING_PROVIDER=gemini               # embeddings (OpenRouter doesn't serve them)
GEMINI_API_KEY=...                      # for embeddings / semantic search
WORKSPACE_DB_PATH=<abs>/Nodedex/data/workspace.db
# HTTP exposure only:
NODEDEX_BIND_HOST=0.0.0.0
NODEDEX_API_TOKEN=<secret>              # sent as Authorization: Bearer <secret>
```

## TL;DR
- **Two wires, set up separately:** READ (MCP — stdio or HTTP `/mcp`) and CAPTURE (tee /
  proxy / watcher). Connecting MCP alone gives an **empty graph** — capture is the second wire.
- **Same machine → stdio → the app auto-starts it → done.** This is how it's meant to feel.
- **Sandboxed/remote → HTTP → you run the server, the app connects by URL** (mind the
  `localhost` vs `host.docker.internal` perspective).
- **Capture by host:** loop you control → **tee**; honors a base-URL → **proxy**; closed
  sandbox (Hermes) → **watcher**.
- Either way, **a connected agent gets its tools automatically** — if it's probing by hand,
  the connection isn't set up.
