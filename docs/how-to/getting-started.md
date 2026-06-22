# Getting started — the whole workflow, install → using

This is the end-to-end map: what you install, what each setup step does, and the two ways to
run it (**same machine** vs **agent in Docker / remote**). Throughout, **`<port>`** is the port
your server runs on (the TUI shows it; the wizard picks a free one, often `3001`/`3002`).

The mental model: **the TUI sets up and runs the *server*; you connect your *agent* to it.**
Those are two separate jobs, and "connecting" itself has two halves — **read** (the agent can
traverse memory) and **capture** (your turns grow the graph).

---

## 0. Pick your setup first — it changes a few values

| | **Same machine** (agent on this PC) | **Docker / remote agent** (e.g. Hermes) |
|---|---|---|
| Server bind | `localhost` (127.0.0.1) | `0.0.0.0` (all interfaces) |
| Access token | none | **yes** — the TUI generates one |
| Agent reaches server at | `localhost:<port>` | `host.docker.internal:<port>` |
| Capture path | tee / host hook | **model proxy** (base_url) |
| Why | loopback is private + simplest | a container can't see your `localhost` |

> **The #1 rule for Docker:** inside a container, `localhost`/`127.0.0.1` mean *the container
> itself*. To reach NodeDex on your host, the agent must use **`host.docker.internal`** — for
> *both* the MCP URL and the model base_url. And the server must bind `0.0.0.0`, or you get
> *connection refused*.

---

## 1. Install (one-time, both setups)

**Prerequisites:** Node.js 20+ and a C/C++ toolchain (for the native SQLite driver).
- macOS: `xcode-select --install`
- Linux: `build-essential` (e.g. `sudo apt install build-essential`)
- Windows: [VS C++ Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) → "Desktop development with C++"

```bash
git clone https://github.com/NodeDex/NodeDex-v0.1.git
cd NodeDex-v0.1
cd server      # then:
npm install    # compiles the native SQLite driver (one-time)
cd ../tui      # then:
npm install
```
> Run each line on its own — **Windows PowerShell 5.1 doesn't support `&&`** to chain commands
> (use separate lines, or `;`). bash/zsh/cmd are fine either way.

No build step in the normal flow — the TUI runs the server from source. (`npm run build` is only
needed for the stdio-spawn path.)

---

## 2. First-run setup (the wizard)

From `tui/`:
```bash
npm run dev      # first run launches the setup wizard
```

The wizard is one screen at a time (↑↓ + Enter):

| Step | What it asks / does |
|---|---|
| **Welcome / Consent** | Notes: memory is stored on *your* machine; the AI pipeline can be wrong; you bring your own model key (billed to you). |
| **OpenRouter key** | Paste `sk-or-…`. It's **verified live** (a bad/truncated key fails here, not later). Saved to `~/.nodedex/config.json`. |
| **Model** | Pick a recommended model or type any OpenRouter id. A **free** model warns *"trains on your prompts"* — use only with non-sensitive work. |
| **Port** | Scans `3001–3008`, you pick a free one. |
| **Database** | Pick an existing `~/.nodedex/*.db` or **＋ create + name a new graph**. |
| **Where will your agent run?** | **← the setup branch.** *This machine* → localhost, no token. *Docker / another machine* → binds `0.0.0.0` + generates a **token** (shown once — save it). |
| **Starting** | Launches the server. **First run downloads the local embedding model** (one-time) so search works offline, no extra key. |
| **✓ Server running** | Shows the `/mcp` URL (and, for Docker, the token + `Authorization` header). |

Everything lives in `~/.nodedex/` (`C:\Users\<you>\.nodedex` on Windows); your key never enters
the repo.

---

## 3. Connect your agent — READ side (MCP)

Register the running server with your agent host over **Streamable-HTTP MCP** (`/mcp`).

**Same machine:**
```json
{ "mcpServers": { "nodedex": { "url": "http://localhost:<port>/mcp" } } }
```

**Docker / remote agent** (note the host + token):
```json
{ "mcpServers": { "nodedex": {
  "url": "http://host.docker.internal:<port>/mcp",
  "headers": { "Authorization": "Bearer <your-token>" }
} } }
```
(Linux Docker: also run the container with `--add-host=host.docker.internal:host-gateway`.)

The agent now has the **read tools** and the usage protocol (delivered via the MCP `instructions`
field — no prompt changes from you).

> **Watch out (the silent killer):** if your host *parses a config file* (e.g. Hermes's
> `config.yaml`), one stray/garbage character makes it **throw out the whole file and ignore every
> override**. If MCP "isn't there" or settings don't apply, validate the file parses before
> debugging anything else. See [connect-hermes.md](connect-hermes.md).

---

## 4. Turn on capture — WRITE side (required, or the graph stays empty)

NodeDex is a *passive* MCP server: it sees tool calls, **not** your agent's replies. Something must
push each finished turn to it. **Pick the path that fits your host:**

| Your agent is… | Capture path | How |
|---|---|---|
| **Hermes / Owl** | **state.db watcher** | Hermes ignores a model proxy + never fires hooks, so NodeDex reads its `state.db`. Turn it on in **TUI → Settings → `hermes capture`** (Enter to start; `sources` = the privacy filter). Full walkthrough: [connect-hermes.md](connect-hermes.md). |
| **OpenAI-compatible host** that honors a custom base URL | **Model proxy** | Point the agent's **model base_url** at `http://127.0.0.1:<port>/api`. It relays to your real provider *and* captures. Token-exempt; forwards your own provider key. (A remote/Docker agent uses the host address instead.) |
| **Code/loop you control** (Agent SDK, LangChain, own loop) | **Tee** | Have the agent run `workspace_install_capture` once; wire the returned snippet into a post-turn hook. |
| **Claude Code** | **Stop hook** | Built in (not part of this autonomous-agent release). |

---

## 5. Verify it's working

Send your agent a message that gets a reply **>50 chars** (shorter is ignored), then look for the
turn arriving — **which log depends on your capture path:**
- **Hermes / Owl (watcher):** `~/.nodedex/tui-logs/hermes-watcher.log` shows `captured stop_id=… → captured`.
- **Proxy:** the server log (`~/.nodedex/tui-logs/server-<port>.log`) shows `[chat-proxy] inbound turn … → relaying to …` then `[chat-proxy] capture queued`.
- Either way, the server log then shows `Auto-Reflect COMPREHEND: … blocks` → `PIPELINE v2: … block(s)`, and in the TUI **`blocks`** climbs within ~30–90s (owl-alpha is slow through all passes).

If the turn never arrives: watcher not running / no server in `tui-session.json` (watcher), or wrong
host/port / config not loaded (proxy). If it arrives but **`blocks`** stays flat → reply <50 chars,
reflect paused, or the **pipeline key** is failing extraction (a `401` in the log).

---

## 6. Monitor + day-to-day (the TUI)

Launch the TUI any time with `npm run dev` (in `tui/`). Tabs: **Live · Browse · Chains · Review ·
Servers · Stats · Settings**.

- **Reading the data is token-gated.** The TUI authenticates automatically **only for servers it
  launched itself** (*managed*). A server started another way shows as **`up · external`** with a
  `?`, and Live says *"unreachable"* — it just lacks the token.
  - **Managed** (launch from the **Servers** tab) → every tab works; `[c] change db`, `[x] stop`,
    rescan, etc. are all available.
  - **External** → start the TUI with `NODEDEX_TUI_API=http://127.0.0.1:<port>` and
    `NODEDEX_TUI_TOKEN=<token>` set.
- **Change/swap DB, stop, relaunch** only work on a *managed* (TUI-launched) server.

---

## 7. The keys + config (don't confuse them)

| Thing | Where | Job |
|---|---|---|
| **OpenRouter key** | `~/.nodedex/config.json` | the **pipeline** (extraction) — and, on the proxy path, forwarded for your agent's answers |
| **NodeDex API token** | generated by the TUI (Docker mode) | gates the REST/MCP surface when the server is network-exposed (`0.0.0.0`) |
| **Embedding model** | bundled local model, default | semantic search — offline, free, no key (override with `EMBEDDING_PROVIDER=gemini\|openai` in `~/.nodedex/.env`) |

Change key/model later: from `tui/`, run `npm run reconfigure -- --key sk-or-… --model vendor/model`.
Remove everything (config + graphs, not the code): `npm run uninstall`.

---

## The shortest version

1. `git clone …` → `npm install` in `server/` then `tui/`.
2. `npm run dev` in `tui/` → wizard: key → model → port → db → **where the agent runs**.
3. **Read:** register `…/mcp` with your agent (token if Docker).
4. **Capture:** point the agent's model `base_url` at `…/api` (hosted/Docker), or `workspace_install_capture` (SDK).
5. Message the agent → watch **blocks** climb in the TUI.
