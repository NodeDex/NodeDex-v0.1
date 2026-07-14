# Connect Hermes to NodeDex

End-to-end setup for a **Hermes** agent. Two halves, both needed:

- **Read** (MCP) — so the agent can traverse memory.
- **Capture** (the state.db watcher) — so your conversations *grow* the graph.

Throughout, **`<port>`** = the port your NodeDex server runs on (the TUI shows it; default `3001`).

> **Why a watcher and not a proxy or a hook?** Hermes resists every *cooperative* capture method:
> it **hardcodes its OpenRouter endpoint** (`credential_pool.py`) and ignores `model.base_url`, so a
> model-proxy never sees the traffic; and it **registers shell hooks but never invokes them** on the
> gateway path, so a `transform_llm_output` hook never fires. What Hermes *does* do is write every
> turn to its own `state.db`. So NodeDex captures by **reading that file** — zero Hermes cooperation,
> and it can't be silently ignored.

---

## 0. Prerequisites

- A NodeDex server running (the onboarding wizard starts one; the TUI relaunches it on a db
  switch, or use `nodedex run`). Same machine as Hermes — so loopback (`127.0.0.1`) reaches it
  and **no token is needed**.
- A valid **NodeDex pipeline key** (so extraction works — see *The two keys* below).
- Reflect **not paused** (`~/.nodedex/reflect-pause` absent).

---

## 1. Read — register the MCP server in Hermes

The Hermes **gateway** (the part that speaks MCP) runs on your **host**, so it reaches NodeDex on
loopback. Use **`127.0.0.1`**, not `localhost` (on Windows a `0.0.0.0`-bound server is IPv4-only and
`localhost` resolves to IPv6 `::1` first), and not `host.docker.internal` (that's only for code
running *inside* a container — the gateway isn't).

In `%LOCALAPPDATA%\hermes\config.yaml` (Windows) / `~/.hermes/config.yaml`:

```yaml
mcp_servers:
  nodedex:
    url: http://127.0.0.1:<port>/mcp
```

Reload Hermes's MCP connections (or `hermes mcp add nodedex --url http://127.0.0.1:<port>/mcp`) and
start a new session. The agent now has the read tools + the usage protocol (delivered via the MCP
`instructions` field — no prompt changes from you). On a localhost server there's **no token**; add
`headers: { Authorization: "Bearer <token>" }` only if you ran the server network-exposed (`0.0.0.0`).

---

## 2. Capture — turn on the state.db watcher

The watcher reads Hermes's `state.db`, assembles each finished turn, and POSTs it to NodeDex. The
**easiest way is the TUI** — it owns the watcher's lifecycle:

> **TUI → settings view (`3`) → capture watchers:**
> - **`hermes`** — press **Enter** to start it (the row shows `running`). Enter again stops it.
> - **`sources`** — press **Enter** to edit the **privacy filter**: a comma-separated list of which
>   Hermes session sources to capture. Default **`tui`** (your terminal sessions only). Add others
>   (`tui, telegram`) or set **`*`** for all sources. Changes apply **live** — no restart.

That's the whole setup. The watcher self-locates the live server from `~/.nodedex/tui-session.json`
(so switching DB/port never breaks it) and persists a cursor, so it only captures **new** turns from
when you enable it — it won't replay your whole history.

### What it captures (the turn, assembled)
One Hermes turn is many rows — `user → assistant(tool_call) → tool → … → assistant(final)`. The
watcher uses Hermes's `finish_reason` to assemble them into one turn:
- **response** = the final answer (`finish_reason='stop'`),
- **user message** = the prompt that opened the turn,
- **thinking** = the intermediate steps + tool results (where the dead-ends and reasoning live).

So a tool-using turn is captured *with its investigation*, not just the closing summary.

### Run it manually instead (optional)
The watcher is a plain script if you'd rather not use the TUI toggle:
```bash
cd server
node adapters/hermes-statedb-watcher.mjs            # watch + capture
node adapters/hermes-statedb-watcher.mjs --dry-run   # print assembled turns, POST nothing
node adapters/hermes-statedb-watcher.mjs --backfill   # also capture pre-existing history
```
Config (source filter, poll interval, a non-default `state.db` path) lives under `hermesCapture` in
`~/.nodedex/config.json` and is re-read each poll.

---

## The two keys — don't confuse them

| Key | Lives in | Used for |
|---|---|---|
| **Your provider key** (OpenRouter `sk-or-…`) | Hermes config | Hermes uses it for the agent's **answers** — NodeDex is never in the model path |
| **NodeDex pipeline key** | `~/.nodedex/config.json` | the **extraction** pipeline that turns captured turns into graph blocks |

If turns are captured but the graph stays empty, the **pipeline key** is the culprit (a `401` in the
server log). Fix it in the TUI — `nodedex tui` → **3 health** → Enter on **provider** → re-enter the
key — or headless (avoids terminal paste-truncation):
```
nodedex setup --provider openrouter --key sk-or-v1-<your-FULL-key> --model google/gemini-2.5-flash-lite
```

---

## Verify it's working

1. Send Hermes a message whose reply is **≥50 chars** (shorter is skipped).
2. Within a few seconds the watcher log (`~/.nodedex/tui-logs/hermes-watcher.log`) shows
   `captured stop_id=… → captured`, and the NodeDex **server log**
   (`~/.nodedex/tui-logs/server-<port>.log`) shows
   `Auto-Reflect COMPREHEND: … blocks` → `PIPELINE v2: … block(s)`.
3. The TUI **`blocks`** count climbs (give it ~30–90s — slower models can take a few minutes).

Reading the signal:
- **No `captured` line in the watcher log** → the watcher isn't running (settings view → `hermes` row
  → start) or there's no NodeDex server in `~/.nodedex/tui-session.json`. Try a manual `--dry-run` to
  see assembled turns without posting.
- **`captured` but `blocks` stays 0** → the turn was **<50 chars**, **reflect is paused**, or the
  **pipeline key** is failing extraction (a `401` in the server log) — see *The two keys*.

---

## Gotchas (every one hit during a real setup)

- **config silently ignored (the #1 cause of "nothing applies")** — if Hermes logs
  `unacceptable character #xNNNN … Falling back to default config` (on startup or `hermes mcp list`),
  it **rejected the entire `config.yaml`** and is ignoring *every* override, `mcp_servers` included. A
  single stray control character anywhere — often hidden in a mangled/mojibake comment Hermes itself
  ships — does this. The config *looks* right but never loads. Check by parsing it:
  `python -c "import yaml;yaml.safe_load(open(r'%LOCALAPPDATA%\hermes\config.yaml',encoding='utf-8'))"`
  then delete/fix the offending line (keep a backup) and restart.
- **MCP config shape** — under `mcp_servers:`, each entry is `<name>: { url }` directly. Don't paste a
  Claude-Desktop `{"mcpServers": {...}}` blob as the value — that double-wraps it and Hermes shows
  "No MCP servers".
- **wrong MCP host** — use `127.0.0.1`, not `localhost` (Windows `::1` trap) and not
  `host.docker.internal` (the gateway is on the host, not in a container).
- **reflect paused** — the graph won't grow. Delete `~/.nodedex/reflect-pause` and resume
  (TUI settings view → `capture` row → Enter, or restart the server).
- **truncated key** — a long key pasted into a terminal field can drop chars; use the
  `reconfigure --key` flag, which is shape-checked.
- **privacy** — by default only `tui` sessions are captured. If you use Hermes over telegram/discord
  and *don't* want those in the graph, leave `sources` as `tui`; to capture them, add them explicitly.
