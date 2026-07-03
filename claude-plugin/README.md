# NodeDex — Claude Code plugin

Wires Claude Code to a running NodeDex server in one install:

- **MCP connection** (`.mcp.json`) — the `workspace_*` read tools, pointed at the
  default server (`http://127.0.0.1:3001/mcp`).
- **`nodedex-memory` skill** — the five memory moves, loaded automatically when
  Claude is proposing an approach, making a design decision, or asked what was
  decided/tried/why. Chief among them: the dead-end check, so approaches the
  project already tried and abandoned never get re-proposed.

## Install

```bash
npx nodedex                 # once: setup wizard + starts the server
```

Then in Claude Code:

```
/plugin marketplace add NodeDex/NodeDex-v0.1
/plugin install nodedex
```

> Picked a non-default port in the wizard? The bundled MCP config assumes `3001` —
> point Claude Code at yours instead: `claude mcp add --transport http nodedex
> http://127.0.0.1:<your-port>/mcp` (and `nodedex connect` prints the right URL).

Capture is the server's job (the watcher reads `~/.claude/projects/*.jsonl` with
your consent from setup) — the plugin only adds the read side + discipline.
