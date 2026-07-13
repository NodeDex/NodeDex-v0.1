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

# 3 · Wiring NodeDex INTO the agent — the step people skip

Connecting the tools is not enough, and this is the part that decides whether NodeDex
actually helps you. Measured: an agent read this project's recorded dead-ends at 12:17,
wrote the code at 16:44, and shipped the exact bug those dead-ends warned about. It
understood them perfectly. It just no longer had them — the instruction to look arrived
once, at connect, and was long gone from its context by the time it chose an approach.

So there are THREE wires, each with a different lifetime. Your agent installs them itself.
Say this to it, once:

    Set up NodeDex

It will be nagged on every tool result until all three are done, so it is hard to skip:

  · **CAPTURE**  — feeds finished turns to the graph. Without it the graph stays EMPTY.
  · **REFLEX**   — a short marked block in AGENTS.md (or CLAUDE.md / your rules file), so
                   the habit is re-read into its context on EVERY turn, not just at connect.
  · **GATE**     — a check that fires right before it edits a file, and reminds it to
                   consult the graph if it hasn't looked recently. Warns; never blocks;
                   does nothing at all if NodeDex isn't running.

It asks your permission for each, and it reads your files before touching them (it appends
a marked block; it does not overwrite what's already there). Delete the block to opt out.

**None of it is taken on trust.** NodeDex verifies each wire by what actually HAPPENS —
it reads the file back, waits for a real turn to land, waits for a real check to arrive.
An agent that says it did the setup and didn't will keep being nagged.

## If your agent has no file-write tool

Then it can't install anything, and you wire it yourself. The reflex block:

    curl ${p.mcpUrl.replace(/\/mcp$/, "")}/api/agent-reflex?format=text

Paste it into that agent's system prompt — it must be present on EVERY turn. For capture,
POST each finished turn to \`/api/reflect/trigger\`; for the gate, call
\`GET /api/gate/check\` before a file edit and feed anything it returns back into context.

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
