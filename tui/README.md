# nodedex-tui

Live mission-control for a running NodeDex memory server. It **reads the REST API only** — it never touches the DB and makes **no LLM calls**, so running it is free and safe.

```
┌─ Live ──────────────────────────────────────────────────┐
│  connection · agent reads · pipeline saves · attention   │
└──────────────────────────────────────────────────────────┘
```

## Run

```bash
cd tui
npm install
npm run dev          # connects to http://localhost:3001 by default
```

Point it at a different server with an env var:

```bash
NODEDEX_TUI_API=http://localhost:3099 npm run dev
```

## Keys

| key        | action            |
|------------|-------------------|
| `1`–`4` / `Tab` / `←` `→` | switch view |
| `r`        | refresh now       |
| `a`        | toggle auto-refresh (2s) |
| `q` / `Esc`| quit              |

## Views

- **Live** — connection + reflect state, recent agent reads, recent pipeline saves, and a *needs-attention* panel (routed-to-you merge questions, dup candidates, review queue).
- **Flags** — the full routed-to-you questions + review queue (read-only in v1).
- **Stats** — block counts by type, balance, last reflect.
- **Graph** — project roots + open tasks.

## Data sources (all existing endpoints)

`/api/session` · `/api/reflect/status` · `/api/session/events` · `/api/flags/agent-pending` · `/api/flags/summary` · `/api/blocks/review-queue` · `/api/usage/balance`

## Roadmap

- **v1** (this) — read-only auto-refreshing dashboard.
- **v2** — actionable Flags tab (`Enter` on a routed flag → resolve merge / keep / assign owner via `POST /api/flags/:id/review`).
- **v3** — Graph tab traversal (tree + chains via `/api/tree`, `/api/blocks/:id/chain`).

Block types are colored by epistemic role: `decision` green · `dead_end` red · `constraint` yellow · `insight` magenta · `fact` blue.
