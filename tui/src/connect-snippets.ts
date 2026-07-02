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

---

## Claude Code

\`\`\`bash
claude mcp add --transport http nodedex ${p.mcpUrl}${auth}
\`\`\`

Then in any session the workspace_* read tools are available. Capture: Claude Code's
own transcripts can feed NodeDex — see the README's capture section.

Note: Claude Code's built-in auto-memory is per-project notes for Claude Code alone.
NodeDex complements it: one structured, self-maintaining graph that EVERY agent you
run (Claude Code, Hermes, Codex, custom) reads and feeds — your experience follows
you across tools instead of living in one.

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
