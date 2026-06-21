# Connect Hermes / Owl to NodeDex

End-to-end setup for a **Hermes-style hosted agent** — the agent runs in a Docker sandbox while
the Hermes **gateway** runs on your host. There are two halves, and you need **both**:

- **Read** (MCP) — so the agent can traverse memory.
- **Capture** (model proxy) — so your conversations *grow* the graph.

Throughout, **`<port>`** = the port your NodeDex server runs on (the TUI shows it; default `3001`,
examples here assume you picked one like `3002`).

---

## 0. Prerequisites

- A NodeDex server running, **bound `0.0.0.0` + protected with a token**. The TUI's
  **Servers → launch → "Docker / another machine"** does this for you and shows the token + URL.
- A valid **NodeDex pipeline key** (so extraction works — see *Two keys* below).
- Reflect **not paused** (`~/.nodedex/reflect-pause` absent).

---

## 1. Read — register the MCP server in Hermes

Hermes (the agent) is in a container, so it reaches your host via `host.docker.internal`. Add an
**HTTP MCP server** in Hermes with the token:

```json
{
  "url": "http://host.docker.internal:<port>/mcp",
  "headers": { "Authorization": "Bearer <your-token>" }
}
```

That gives the agent the read tools. (On Linux Docker, also run the container with
`--add-host=host.docker.internal:host-gateway`.)

---

## 2. Capture — route Hermes's model through NodeDex

A sandboxed agent **can't deploy a capture tee** (no host filesystem, no control of the loop). So
instead, point Hermes's **model base URL** at NodeDex's `/api` proxy: it relays each call to your
real provider unchanged *and* captures the turn.

Edit `%LOCALAPPDATA%\hermes\config.yaml` (Windows) / `~/.hermes/config.yaml`, under `model:`:

```yaml
model:
  default: openrouter/owl-alpha
  provider: openrouter
  base_url: http://127.0.0.1:<port>/api    # was https://openrouter.ai/api/v1
  api_mode: chat_completions
```

Or: `hermes config set model.base_url http://127.0.0.1:<port>/api`. **Then restart the Hermes
gateway** (config is read at gateway start).

> **⚠ Use `127.0.0.1`, NOT `localhost`.** A `0.0.0.0`-bound server is **IPv4-only**, and on
> Windows `localhost` resolves to IPv6 `::1` first → the connection times out and **0 turns reach
> the proxy**. The gateway runs on the host, so `127.0.0.1` is correct (use `host.docker.internal`
> only if the model call originates *inside* the container).

No tee, no NodeDex token for this leg (the `/api/chat` proxy is token-exempt and forwards your own
provider key).

---

## The two keys — don't confuse them

| Key | Lives in | Used for |
|---|---|---|
| **Your provider key** (OpenRouter `sk-or-…`) | Hermes config | the proxy forwards it to OpenRouter for Owl's **answers** |
| **NodeDex pipeline key** | `~/.nodedex/config.json` | the **extraction** pipeline that turns captured turns into graph blocks |

If turns are captured but the graph stays empty, the **pipeline key** is the culprit (a `401` in
the server log). Fix it — using the flag to avoid terminal paste-truncation:
```
cd tui && npm run reconfigure -- --key sk-or-v1-<your-FULL-key>
```

---

## Verify it's working

1. Restart Hermes, send Owl a message whose **reply is >50 chars** (the pipeline ignores shorter).
2. The NodeDex **server log** (`~/.nodedex/tui-logs/server-<port>.log`) shows a
   `POST /api/chat/completions` line per turn — that proves Owl is routing through the proxy.
3. The TUI **`blocks`** count climbs above 0 within a few seconds.

If step 2 shows **0** proxy hits after a turn, Hermes isn't using the config `base_url` (restart
the gateway; confirm the port; confirm `127.0.0.1`). If hits appear but `blocks` stays 0, it's the
**pipeline key** or **reflect is paused**.

---

## Gotchas (every one hit during a real setup)

- **`localhost` vs `127.0.0.1`** — use `127.0.0.1` (IPv6 trap above).
- **reflect paused** — the graph won't grow. Delete `~/.nodedex/reflect-pause` and resume
  (TUI Settings → reflect → Enter, or restart the server).
- **truncated key** — a long key pasted into a terminal field can drop chars; use the
  `reconfigure --key` flag, which is shape-checked.
- **port mismatch** — NodeDex must be on the port your `base_url` points at.
- **coupling** — once routed, Owl's model calls flow *through* NodeDex; if NodeDex is down Owl
  can't reach the model. **Revert:** set `base_url` back to `https://openrouter.ai/api/v1`.

---

## Fallback — log-tailer

If Hermes ever can't route the model through the proxy, it still stores conversations on the host
(`%LOCALAPPDATA%\hermes\sessions` + `state.db`). A small watcher that tails those and POSTs to
`/api/reflect/trigger` (with the token) is an alternative capture path that needs no agent and no
host hook. (Not shipped — a build-it-if-you-need-it option.)
