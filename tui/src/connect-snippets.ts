// connect-snippets.ts — ready-to-paste "connect your agent" config, per host.
//
// The wizard's last screen can only show one-liners (a TUI frame is a bad place to
// copy multi-line JSON from), so the full snippets are WRITTEN TO A FILE the user
// can open and paste from: ~/.nodedex/connect-snippets.md. Regenerated on every
// server start from the wizard, so the port/token in it always match the live server.
//
// Two wires per host (the model users must internalize): READ = the MCP endpoint
// below; CAPTURE = how finished turns reach the pipeline (without it the graph
// stays empty). Hermes capture is automatic (the state.db watcher); other hosts
// point at the README's capture section.

import { homedir } from "os";
import { resolve } from "path";
import { mkdirSync, writeFileSync } from "fs";

const NODEDEX_HOME = resolve(homedir(), ".nodedex");
export const SNIPPETS_FILE = resolve(NODEDEX_HOME, "connect-snippets.md");

export interface SnippetParams {
  /** Full MCP endpoint, e.g. http://127.0.0.1:3001/mcp */
  mcpUrl: string;
  /** Bearer token when the server is network-exposed; omit for localhost. */
  token?: string;
  readmeUrl: string;
}

export function buildConnectSnippets(p: SnippetParams): string {
  const auth = p.token ? ` --header "Authorization: Bearer ${p.token}"` : "";
  const authJsonLine = p.token ? `\n      "headers": { "Authorization": "Bearer ${p.token}" },` : "";
  return `# Connect your agent to NodeDex

MCP endpoint (Streamable HTTP): ${p.mcpUrl}
${p.token ? `Auth header: Authorization: Bearer ${p.token}\n` : ""}
The ONE token rule: connections from THIS machine never need the token; Docker/remote
connections always do. Lost? \`nodedex connect\` prints the right URL + test command
for every client location.

Two wires, set up separately:
1. **READ** — connect your agent to the MCP endpoint below (gives it the memory tools).
2. **CAPTURE** — wire finished turns into the pipeline (without this the graph stays EMPTY).
   Hermes: automatic (the state.db watcher, on by default in the TUI).
   Everything else: see ${p.readmeUrl}

One graph, many hosts: connect as many agents as you like — they all READ and FEED the SAME
graph. Switching tools, or adding one (Hermes today, Claude Code tomorrow), moves NO data — the
new host connects and immediately sees everything the others left behind.

---

## Claude Code (CLI)

\`\`\`bash
claude mcp add --transport http nodedex ${p.mcpUrl}${auth}
\`\`\`
Add \`--scope user\` to expose it in EVERY project, not just this one.

## Claude Code in an IDE (VS Code / JetBrains / the Cursor extension)

A GUI editor has no \`claude\` command — register with files. In your PROJECT root create
\`.mcp.json\`:
\`\`\`json
{ "mcpServers": { "nodedex": { "type": "http", "url": "${p.mcpUrl}" } } }
\`\`\`
…and approve it once in \`.claude/settings.local.json\`:
\`\`\`json
{ "enableAllProjectMcpServers": true, "enabledMcpjsonServers": ["nodedex"] }
\`\`\`
Then start a NEW session in that project — MCP attaches at session start. (Gated server? add
\`"headers": { "Authorization": "Bearer <token>" }\` inside the nodedex block.)

## Cursor (Cursor's own AI)

Cursor's built-in agent reads Cursor's config, NOT Claude Code's. Global \`~/.cursor/mcp.json\`
(all projects) or \`.cursor/mcp.json\` in one project:
\`\`\`json
{ "mcpServers": { "nodedex": { "url": "${p.mcpUrl}" } } }
\`\`\`

## VS Code (Copilot agent mode)

VS Code's Copilot uses \`.vscode/mcp.json\` — the top key is "servers", not "mcpServers":
\`\`\`json
{ "servers": { "nodedex": { "type": "http", "url": "${p.mcpUrl}" } } }
\`\`\`

It's the AGENT that picks the file, not the editor: the Claude Code extension always uses
\`.mcp.json\` even inside Cursor or VS Code; Cursor's and VS Code's OWN agents use their files above.

Note: these coding agents' built-in memory is per-tool notes. NodeDex complements them — ONE
self-maintaining graph that every agent you run reads and feeds, so your context follows you
across tools instead of living in one.

## Hermes

Add to Hermes's MCP config (Settings → MCP servers):

\`\`\`json
{
  "mcpServers": {
    "nodedex": {
      "url": "${p.mcpUrl}"${authJsonLine}
    }
  }
}
\`\`\`

Use 127.0.0.1, not localhost (localhost can resolve to IPv6 ::1 and fail).
Capture is automatic — the NodeDex TUI watches Hermes's state.db (Settings → hermes capture).

## Codex CLI

In \`~/.codex/config.toml\` (needs a Codex version with HTTP MCP support):

\`\`\`toml
[mcp_servers.nodedex]
url = "${p.mcpUrl}"
${p.token ? `http_headers = { "Authorization" = "Bearer ${p.token}" }\n` : ""}\`\`\`

## Any other MCP host

Point it at the Streamable-HTTP endpoint: ${p.mcpUrl}
${p.token ? `Send header: Authorization: Bearer ${p.token}` : "(no auth needed on localhost)"}

Docker'd agent on this machine? Use http://host.docker.internal:<port>/mcp instead.

---

# 3 · The memory reflex — the wire people forget

Connecting the tools is not enough. The instruction to CHECK the graph reaches the agent
ONCE, when it connects — and it is gone from context hours later, which is exactly when
the agent is deep in a task and actually choosing an approach. Measured: an agent read
the recorded dead-ends at 12:17, wrote the code at 14:00, and shipped the bug the graph
had warned about.

So the reflex has to live where the agent re-reads it EVERY turn.

## If your agent has a standing instructions file (Claude Code, Cursor, Codex, Copilot…)

It can install the reflex itself. Say this to it, once:

    Run workspace_onboard

It will check its own config channel, ask your permission, and write a short marked block
into AGENTS.md (or CLAUDE.md / its rules file). No project data — just the habit. Delete
the marked block to opt out. You will also see the agent nudged to do this on every tool
result until it does.

## If your agent's system prompt is STATIC (most autonomous agents + custom loops)

There is no per-turn file for it to write, so it cannot install anything — YOU have to
paste it. Get the block:

    curl ${p.mcpUrl.replace(/\/mcp$/, "")}/api/agent-reflex?format=text

Paste it into that agent's system prompt. It must be present on EVERY turn — an
instruction delivered once at launch has the exact decay problem this fixes.

---

Full connect + capture reference: ${p.readmeUrl}
`;
}

/** Write the snippets file; returns its path. Never throws (best-effort). */
export function writeConnectSnippets(p: SnippetParams): string | null {
  try {
    mkdirSync(NODEDEX_HOME, { recursive: true });
    writeFileSync(SNIPPETS_FILE, buildConnectSnippets(p), "utf8");
    return SNIPPETS_FILE;
  } catch {
    return null;
  }
}
