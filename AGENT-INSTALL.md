# Agent install — paste this to your AI agent

> **You (the human):** copy everything below the line into your agent (Claude Code, OpenClaw,
> Hermes, or any agent with shell access) and answer its questions. It will install NodeDex,
> start it, and connect itself. ~2 minutes, everything stays on this machine.

---

You are installing **NodeDex** — a local, self-maintaining graph of the project's decision
history (decisions, dead-ends, constraints — your long-term record across sessions) that you
(the agent) will read and feed. Follow these steps exactly; prefer the given commands over
improvising. Ask the user only the questions in step 2.

**1. Prerequisite**
Check `node --version` (need Node ≥ 18). No clone, no build — NodeDex installs from npm.

**2. Ask the user these three questions, then run headless setup**
1. *"Extraction model: OpenRouter (cloud, needs an `sk-or-…` API key, ~½¢ per extraction) or
   local (Ollama/LM Studio, free, needs it running)?"*
2. *"Name for your memory database?"* (default `workspace`)
3. *"NodeDex builds memory by reading agent conversation logs on this machine — may I enable
   capture for the hosts you use?"* Offer only what exists: `~/.claude/projects` → `claude-code`;
   Hermes `state.db` → `hermes`. **Do not enable capture without an explicit yes.**

Then ONE command:

```bash
# OpenRouter:
npx nodedex setup --provider openrouter --key sk-or-REPLACE \
  --db THEIR_DB_NAME --capture claude-code   # or: hermes,claude-code | none
# Local (Ollama example):
npx nodedex setup --provider local \
  --base-url http://localhost:11434/v1 --model llama3 --db THEIR_DB_NAME --capture none
```

It validates the key and writes `~/.nodedex/config.json`. Add `--dry-run` first if you want
to show the user what will be written. (The first `npx` run downloads the package — ~1 min.)

**3. Start the server (keep it running in the background)**

```bash
npx nodedex run
```

Verify: `curl http://127.0.0.1:3001/api/health` → JSON with `"overall":"ok"`. Enabled capture
watchers start with it (you'll see `capture watcher started` lines).

**4. Connect yourself (the read side)** — pick the row for the host you're running as. The AGENT
picks the config file, not the editor (the Claude Code extension uses `.mcp.json` even inside
Cursor/VS Code). Use `127.0.0.1`, not `localhost`.
- **Claude Code (CLI):** `claude mcp add --transport http nodedex http://127.0.0.1:3001/mcp` (add `--scope user` for every project).
- **Claude Code (VS Code / JetBrains / Cursor extension):** write `.mcp.json` in the project root — `{ "mcpServers": { "nodedex": { "type": "http", "url": "http://127.0.0.1:3001/mcp" } } }` — and approve it in `.claude/settings.local.json`: `{ "enableAllProjectMcpServers": true, "enabledMcpjsonServers": ["nodedex"] }`. Then tell the user to start a NEW session (MCP attaches at session start).
- **Cursor (its own AI):** write `~/.cursor/mcp.json` (all projects) or `.cursor/mcp.json` — `{ "mcpServers": { "nodedex": { "url": "http://127.0.0.1:3001/mcp" } } }`.
- **VS Code (Copilot agent):** write `.vscode/mcp.json` (top key is `servers`, not `mcpServers`) — `{ "servers": { "nodedex": { "type": "http", "url": "http://127.0.0.1:3001/mcp" } } }`.
- **Any other MCP host:** add a server entry pointing at `http://127.0.0.1:3001/mcp` (Streamable HTTP).

Capture note: only **Claude Code** and **Hermes** have capture watchers today — **Cursor / VS Code can read the graph but can't feed it yet**, so they'll read what your other hosts leave.

Then verify: call `workspace_stats` — a fresh graph reports 0 blocks without erroring.

Connection trouble (Docker, wrong port, token confusion)? Run `npx nodedex connect` — it
prints the correct URL + a test command for every client location. The one token rule:
same machine = no token; Docker/remote = token.

**5. Report back to the user**
Tell them: server running (port, db name), capture on/off per host, and that memory builds
automatically as they work — browsable anytime with `npx nodedex tui`. To remove everything
later: `npx nodedex uninstall`. If any step failed, show the exact error; logs live in
`~/.nodedex/tui-logs/`.
