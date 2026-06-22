# Capture adapter — feed turns into the pipeline from any host

Nodedex's MCP server is **passive**: it only ever sees tool-call arguments and its own
responses — never the agent's natural-language output or reasoning. So it **cannot capture
turns itself**. Something host-side has to *push* each finished turn into the pipeline.

There are three host-side ways to push turns, by host type:
- **Hermes / Owl → the `state.db` watcher.** Hermes ignores a model proxy (hardcoded endpoint)
  and never fires shell hooks, so NodeDex reads its `state.db`. This is THE Hermes path — see
  [connect-hermes.md](connect-hermes.md). (Not covered further here.)
- **Agent whose loop you control (SDK, your own loop) → the tee**, installed once via
  `workspace_install_capture` (the rest of this doc).
- **OpenAI-compatible host that honors a custom base URL → the model proxy** (see
  *"When the tee can't be deployed"* below). Note: Hermes is **not** one of these.

## Why a tee (and not the proxy)

There are four ways to get turns into `POST /api/reflect/trigger`:

| Path | In/out of path | Blast radius | Works for |
|---|---|---|---|
| `state.db` watcher | out-of-path | none | Hermes/Owl (reads its DB) |
| `chat-proxy` (swap the LLM `base_url`) | **in-path** | a bug here breaks the agent's call | hosts that honor `base_url` (**not** Hermes) |
| Claude-Code `Stop` hook | out-of-path | none | CC-only |
| **capture adapter (tee)** | **out-of-path** | none | any host whose loop you control |

The tee is the chosen default: it keeps the agent's own LLM call **untouched** (just sends a
copy *after* the turn finishes), yet can still read reasoning off the response object, and runs
on any host. A capture failure is invisible to the agent — fire-and-forget with a 4s timeout.

## When the tee can't be deployed — use the model proxy

A **sandboxed or closed-app agent** (running inside a container, or a host whose turn loop you
don't control) often **can't deploy the tee at all** — it can't write the adapter to a useful
place or wire a post-turn callback. For these, use the **`/api/chat` proxy**: point the agent's
**model base URL** at Nodedex, and it captures each turn as it relays the call to your real
provider — transparently (same response, no added latency, streaming intact).

In the host's model/provider settings:
- **base URL** → `http://127.0.0.1:<port>/api` (same machine). A containerized/remote agent uses
  the host address instead (e.g. `http://host.docker.internal:<port>/api`) and needs the server
  bound `0.0.0.0`.
- **API key / model** → unchanged — forwarded untouched to your provider

No file, no post-turn seam, and **no Nodedex token** for capture (the `/api/chat` path is exempt
and uses your own provider key). Works for any host that speaks OpenAI `/chat/completions` **and
actually honors a custom base URL**.

> ⚠ **Not Hermes.** Hermes hardcodes its OpenRouter endpoint and ignores `model.base_url`, so the
> proxy never sees its traffic. For Hermes/Owl use the **`state.db` watcher** —
> [connect-hermes.md](connect-hermes.md).

## What gets captured

The adapter sends to `POST {NODEDEX_URL}/api/reflect/trigger`:

| field | from | notes |
|---|---|---|
| `agent_response` | your turn's answer | **the substrate; required ≥50 chars** (server rejects shorter) |
| `user_message` | the user's message | COMPREHEND reads user + response together |
| `agent_thinking` | reasoning, if the host exposes it | captured & stored now; consumed by a later pipeline change |
| `agent_id` | a stable per-conversation id | groups turns + drives the inactivity auto-extract |
| `turn_number` / `turn_name` | ordering + naming | supports arc/range extraction |
| `loaded_block_ids` | memory in context this turn | provenance |

The server does debounce (5s), dedup, **pause-gating** (`POST /api/reflect/pause` is the global
off switch), and runs extraction async — so the adapter stays dumb.

## Install (agent self-deploy)

On a capable host the agent can deploy this itself: it calls the **`workspace_install_capture`**
MCP tool, which returns the adapter source + wiring + a consent-gated 4-step contract (check it
can write a file & has a post-turn seam → explain + ask the user → write the file & wire the
one-liner → otherwise do nothing). Or do it by hand:

1. Copy `adapters/nodedex-capture.mjs` next to your agent code.
2. Call `nodedexCapture(...)` once per completed turn, in whatever post-turn seam your host has.

```js
// A. Generic — you have the strings:
import { nodedexCapture } from "./nodedex-capture.mjs";
const out = await runMyAgentTurn(userMessage);
nodedexCapture({ userMessage, agentResponse: out.text, agentId: sessionId });

// B. Raw OpenAI-shape response — reasoning comes free:
import { nodedexCapture, extractReasoning } from "./nodedex-capture.mjs";
const c = await openai.chat.completions.create({ /* your call, untouched */ });
const msg = c.choices[0].message;
nodedexCapture({ userMessage, agentResponse: msg.content, reasoning: extractReasoning(msg), agentId: sessionId });

// C. Framework with a post-turn callback (Agent SDK / LangChain onTurnEnd, a Stop hook):
//    register nodedexCapture so it runs once per completed turn.
```

## Configure which fields to capture

Per-call override (wins) or env (default all on). `response` is the substrate — turning it off
disables capture entirely (the pipeline needs something to extract).

```js
// per-call: capture response only, skip user + reasoning
nodedexCapture(turn, { capture: { user: false, reasoning: false } });
```

| env var | default | effect |
|---|---|---|
| `NODEDEX_CAPTURE_RESPONSE` | on | the agent's answer — the substrate; off ⇒ nothing is sent |
| `NODEDEX_CAPTURE_USER` | on | the user's message |
| `NODEDEX_CAPTURE_REASONING` | on | reasoning, when the host exposes it |
| `NODEDEX_URL` | `http://localhost:3001` | where the server lives |
| `NODEDEX_TOKEN` | (none) | sent as `x-nodedex-token` when the server is token-gated (`0.0.0.0` + `NODEDEX_API_TOKEN`); without it those captures 401 |
| `NODEDEX_CAPTURE_BUFFER` | off | on ⇒ buffer to `~/.nodedex/capture-buffer.jsonl` when the server is down, flush on next success |

## Guarantees

- **Out-of-path**: runs after the turn completes; never blocks or slows the agent's call.
- **Never throws upward**: all failure (server down, timeout) is swallowed; with buffering on,
  payloads survive a server restart.
- **Universal**: dependency-free; runs on Node / Bun / Deno; probes every known reasoning shape
  (OpenAI `reasoning` / `reasoning_content`, OpenRouter `reasoning_details[]`, Anthropic
  `content[].thinking`).
- **Privacy is the host's call**: the adapter just ships a copy to *your* server running *your*
  configured model. The server-side reflect-pause is the kill switch.
