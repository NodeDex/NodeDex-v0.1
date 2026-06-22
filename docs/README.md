# NodeDex documentation

Start with the root [README](../README.md) for setup and the big picture. These docs go deeper.

## How-to (task-oriented)

| Doc | What it covers |
|---|---|
| [how-to/getting-started.md](how-to/getting-started.md) | **Start here** — the whole workflow, install → using, same-machine vs Docker |
| [how-to/connect-mcp-over-http.md](how-to/connect-mcp-over-http.md) | Register the server with an agent host over Streamable-HTTP MCP (`/mcp`) |
| [how-to/capture-adapter.md](how-to/capture-adapter.md) | Wire capture — the tee (`workspace_install_capture`) or the model proxy — so turns flow into the graph |
| [how-to/connect-hermes.md](how-to/connect-hermes.md) | End-to-end Hermes/Owl setup — MCP read + the state.db capture watcher + the gotchas |
| [how-to/deploying-nodedex.md](how-to/deploying-nodedex.md) | Deployment model — same-machine (stdio) vs Docker / remote (HTTP) |
| [how-to/add-llm-provider.md](how-to/add-llm-provider.md) | Configure the AI provider + key (OpenRouter / OpenAI / Gemini / Anthropic) |

## Reference

| Doc | What it covers |
|---|---|
| [reference/tools.md](reference/tools.md) | Every MCP tool — what it is, what it's for, when to use it |
| [reference/block-types.md](reference/block-types.md) | All block types, fields, TTL |
| [reference/relations.md](reference/relations.md) | Relation types and what each causal edge means |
| [reference/rest-api.md](reference/rest-api.md) | REST endpoints (the read/ops surface alongside MCP) |
| [reference/compatible-models.md](reference/compatible-models.md) | Models known to work for the pipeline |

## Explanation (understanding-oriented)

| Doc | What it covers |
|---|---|
| [explanation/what-nodedex-is.md](explanation/what-nodedex-is.md) | The idea — agent memory as a navigable graph |
| [explanation/architecture.md](explanation/architecture.md) | Internals — pipeline passes, block anatomy, data model |
| [NODEDEX-MEMORY-MODEL.md](NODEDEX-MEMORY-MODEL.md) | How NodeDex differs from RAG + evidence (residue-inventory chart) from a live test |

## Agent protocol

[agent.md](../agent.md) — the protocol the agent follows (also delivered to the agent at
connect time via the MCP `instructions` field). Read this to understand how an agent is
expected to navigate and reason against the graph.
