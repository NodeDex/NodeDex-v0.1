# NODEDEX KEYRING + AUTO-FAILOVER — BUILD PLAN (2026-07-14)

**Status: PLAN ONLY. Not started. Next session builds from here.**
Option **B (automatic failover)** chosen by the user. Read this whole file before writing code.

---

## 0. THE GOAL (in the user's words)

Real users have **multiple keys** — different accounts/providers, and one kept as a **fallback**.
`nodedex config` should be a real page (NOT just re-opening `nodedex tui`) that shows every
stored key + the current active provider/model/local-or-cloud, lets the user **add / swap the
active key / set a fallback key + fallback model**, and the running server must **automatically
fail over** to the fallback key when the active one dies (out of credit / spend-capped / bad
key). Whatever the page changes must **reflect in `nodedex tui`** (both read the same store).

---

## 1. WHAT EXISTS TODAY (verified 2026-07-14 — do not re-derive, but DO re-open before coding)

- **Config store** `~/.nodedex/config.json` (TUI-owned): `provider · openrouter_key (ONE) ·
  base_url · model · port · dbPath`. **No keyring. No fallback KEY. No fallback model persisted**
  (fallback_model is env-only). Plaintext.  → `tui/src/config.ts` (`NodedexConfig`).
- **The seam — config never reaches the server directly.** The TUI translates config → ENV at
  launch: `providerEnv()` (`tui/src/config.ts:313`) emits `OPENAI_API_KEY / OPENAI_BASE_URL /
  AI_MODEL / AI_PROVIDER`. **The server only ever reads ENV** (`getLLMProvider()` →
  `new OpenAIProvider(process.env.OPENAI_API_KEY, process.env.OPENAI_BASE_URL)`,
  `server/src/engine/providers/index.ts:18`). Keep this: the server stays keyring-agnostic; it
  only ever sees ACTIVE + FALLBACK.
- **Live reconfigure already exists** — `POST /api/admin/config` maps body → env at RUNTIME and
  resets the provider (`server/src/routes/admin.ts:436`): it already honors `openai_key`,
  `openai_base_url`, `model`, `fallback_model`, `gemini_key`, etc. So a live key-swap from the
  TUI is a one-field POST; no new transport needed.
- **Model-level failover ALREADY WORKS** and is the pattern to mirror. `openai.ts:61` builds
  `modelsToTry = [model, fallbackModel]` and the loop at `:104` escalates on rate_limit/timeout/
  empty per `failure-policy.ts`. **Single client (single key) throughout.**
- **THE KEY-FAILOVER TRIGGER ALREADY EXISTS** — `failure-policy.ts:~104` has a SEPARATE
  account-can't-pay detector (HTTP 402 / "insufficient credit/funds/balance" / OpenRouter 403
  "Key limit exceeded (total limit)"), deliberately kept apart from transient 429. **THAT is the
  signal to switch KEY, not model.** classifyGenError's kinds: empty|timeout|rate_limited|
  truncated|mechanism_or_other.

---

## 2. THE DATA MODEL (the one real schema change)

`NodedexConfig` (config.json) gains a keyring. Keep the old field for a migration window:

```ts
interface StoredKey {
  id: string;            // stable, e.g. `key_ab12`
  label: string;         // human name ("openrouter-main", "work account")
  provider: "openrouter" | "openai" | "anthropic" | "gemini";  // start: openrouter only, shape for more
  secret: string;        // the API key (PLAINTEXT today — see §6 security)
  base_url?: string;     // provider override; default per provider
  added_at: string;
}
interface NodedexConfig {
  keys?: StoredKey[];        // the ring
  active_key_id?: string;    // which key the server uses
  fallback_key_id?: string;  // which key it fails over to
  fallback_model?: string;   // NEW: persist it (today env-only)
  // ...existing: provider, base_url, model, port, dbPath, captures...
  // openrouter_key?: string;  // KEEP during migration; on load, fold into keys[] as key #1
}
```

**Migration (do it in `loadConfig`, idempotent):** if `openrouter_key` is set and `keys` is
empty, synthesize `keys=[{id, label:"openrouter", provider:"openrouter", secret:openrouter_key}]`,
`active_key_id = that id`. Never lose a user's existing key. Leave `openrouter_key` in place
(read-through) until a later cleanup release.

---

## 3. THE FAILOVER MECHANISM (server side — the core of option B)

**Where it slots in:** the `modelsToTry` loop in `openai.ts:104`. Today it's a list of MODELS on
one client. Generalize to a list of ATTEMPTS = `{ client, model }`:

- Active attempt(s): `{activeClient, model}` then `{activeClient, fallbackModel}` — the CURRENT
  behaviour, unchanged, for model-level failures (rate_limit/timeout/empty).
- Then the KEY-failover attempt(s): `{fallbackClient, model}` (and its fallback model) — reached
  ONLY when the failure is account-level (the billing-out detector fires) or an auth failure
  (401/403 bad key).

**classifyGenError gets one new kind or a sibling check:** `account_or_auth` → switch CLIENT
(key), not model. Wire the existing billing-out detector + 401/403-auth into it. Guard the
determinism rule already documented in failure-policy: a KEY swap keeps the SAME model, so it
does not trip the "different model = different classification" trap.

**How the fallback key reaches the provider (keep it env-driven):** `providerEnv()` emits, in
addition to the active `OPENAI_API_KEY`:
`NODEDEX_FALLBACK_API_KEY`, `NODEDEX_FALLBACK_BASE_URL` (default = active base url). The provider
lazily constructs `fallbackClient` from those (like `fallbackModel` is read live from env at
`openai.ts:46`, NOT cached at construction — so a live swap takes effect without a full reset).

---

## 4. THE UI — `nodedex config` becomes the keyring page (NOT the tui health view)

Today `nodedex config` just opens `tui → health` (redundant, the user's exact complaint). Make it
a distinct view/overlay:

- **Shows:** active provider (cloud/local), active model + fallback model, and the KEYRING — every
  stored key (label + masked secret + provider), with the active one and the fallback one marked.
- **Actions:** add key (label + paste secret, validated via the existing `/key` probe —
  `config.ts:53`), remove key, set-active, set-fallback, set fallback model, scan local models
  (reuse `scanLocalModels`).
- **Reflects to `nodedex tui`:** both read/write the same `config.json`; a live swap also POSTs
  `/api/admin/config` so the RUNNING server picks it up without relaunch (mirror the health view's
  existing save path).

Decide: a new tab in the App shell, or a full-screen overlay launched by `--config`. Given the
health view already has provider/model rows, cleanest is a **dedicated keyring overlay** reachable
from BOTH `nodedex config` and an entry on the health view (so they're consistent, not redundant).

---

## 5. WHAT EACH THING AFFECTS (the file map)

| File | Change |
|---|---|
| `tui/src/config.ts` | `StoredKey` + keyring fields; migration in `loadConfig`; `providerEnv()` emits active + `NODEDEX_FALLBACK_API_KEY/BASE_URL`; helpers: `addKey/removeKey/setActive/setFallback/listKeys`. |
| `tui/src/health.tsx` (or new `keyring.tsx`) | the keyring page/overlay; masked display; add/swap/fallback; live-save via POST /api/admin/config. |
| `tui/src/App.tsx` + `cli.tsx` | route `--config` to the keyring overlay (replace the current "open health" stub). |
| `server/src/engine/providers/openai.ts` | attempts = `{client, model}`; lazy `fallbackClient` from env; key-failover branch. |
| `server/src/engine/providers/failure-policy.ts` | add `account_or_auth` classification (401/403-auth + existing billing-out) → "switch key". |
| `server/src/engine/providers/index.ts` | pass fallback key/base to the provider (or provider reads env itself — preferred, matches fallbackModel). |
| `server/src/routes/admin.ts` | accept `fallback_api_key` / `fallback_base_url` in the live-config body (already does `openai_key`). |
| `server/adapters/*` / launch | `run-btest`/launchServer inherit env; verify fallback env propagates through the TUI spawner (same path that already forwards parity keys). |
| docs + `nodedex help` | the config/keyring story; AGENT-INSTALL if headless gains `--fallback-key`. |

---

## 6. WHAT TO TAKE INTO ACCOUNT (the traps)

1. **SECURITY — plaintext secrets multiply.** Today one key sits in plaintext `config.json`; a ring
   is several. Decide BEFORE building: (a) ship with a loud plaintext warning + `chmod 600`, or
   (b) encrypt the ring at rest (there is already `NODEDEX_DB_ENCRYPTION_KEY` for the DB — reuse
   the same passphrase pattern for config). Do NOT log secrets; mask everywhere (first-8 + …).
2. **The server is ENV-driven, not config-driven — keep it that way.** Do not make the server read
   `config.json`. The ring lives in the TUI; only ACTIVE + FALLBACK cross the seam as env. This is
   why live-swap works via the admin route and why the server stays testable.
3. **Live vs relaunch.** Read the fallback key LIVE from env per call (like `fallbackModel` at
   `openai.ts:46`) so a swap takes effect without a full provider reset. A provider-lane switch
   (cloud↔local) still needs the reset the admin route already does.
4. **Local provider has no key.** Keyring is a CLOUD concept. When `provider=local`, the ring is
   inert (base_url + model only). Don't show/require keys in local mode.
5. **Embeddings share `OPENAI_API_KEY`** (`index.ts:50`) — but default embeddings are LOCAL
   (bge-small), so cloud-key failover only touches embeddings if `EMBEDDING_PROVIDER=openai`. Note
   it; don't fail over embeddings to a chat-only fallback key blindly.
6. **Determinism trap (already documented).** A KEY swap must keep the SAME model. Only a MODEL
   swap risks the "two graphs from one input" trap. Keep them separate in the attempts loop.
7. **Don't double-charge / infinite-loop.** Failover is at most: active-model → active-fallback-
   model → fallback-key-model → degrade. Bounded. Never loop keys.
8. **The billing-out detector currently PAUSES spend** (cost-guard). Decide the interaction: on
   active-key billing-out, do we fail over to the fallback key AND keep going, or fail over once
   then respect the pause? Likely: fail over, and only pause when BOTH keys are out.
9. **Validation on add** — reuse `validateOpenRouterKey` (`config.ts:53`), so a typo fails at
   add-time, not at first extraction (same principle as the wizard).
10. **`nodedex setup` headless** may want `--fallback-key` for agents/scripts — optional, phase 2.

---

## 7. BUILD ORDER (phased — each phase shippable, verify before the next)

- **P1 — data model + migration (no behaviour change).** Add keyring types + `loadConfig`
  migration + helpers. `providerEnv()` still emits only the active key. Verify: existing single-key
  users unaffected; `keys[]` is populated from `openrouter_key`. TESTS: migration idempotent.
- **P2 — the keyring page.** `nodedex config` → the overlay; add/remove/swap/set-fallback; live-save
  via admin route; reflects in health view. No server failover yet. Verify: swap active key in the
  page → running server uses it (a real extraction with the new key).
- **P3 — server key-failover.** `providerEnv` emits fallback key env; `failure-policy` gains
  `account_or_auth`; `openai.ts` attempts loop does key-failover. Verify with a DELIBERATELY dead
  active key + valid fallback → extraction succeeds on the fallback; logs show the switch. TESTS:
  a mocked 402/403 on the active client escalates to the fallback client, same model.
- **P4 — polish.** headless `--fallback-key`, docs, security decision (§6.1) implemented, masking
  audit.

---

## 8. VERIFICATION (drive it, don't just typecheck — per the verify discipline)

- P1: unit — migration from `{openrouter_key}` → `{keys:[…], active_key_id}`; idempotent on re-load.
- P2: LIVE — open `nodedex config`, add a 2nd key, set active, confirm `config.json` + a real
  extraction uses it; confirm the health view shows the same active key.
- P3: LIVE — set active = a revoked/empty key, fallback = the real key; run an extraction; it must
  SUCCEED via the fallback and the server log must show the key switch (not a silent degrade).
  Unit — mock account-out on client A → assert client B (fallback) is tried with the SAME model.
- Every phase: `npm test` (currently 1313/1313), tsc clean (server + tui), then a live drive.

---

## 9. OPEN DECISIONS FOR THE USER (settle at the start of the build session)

1. **Security (§6.1):** plaintext + warning, or encrypt-at-rest (reuse `NODEDEX_DB_ENCRYPTION_KEY`)?
   — recommend encrypt-at-rest before shipping multi-key; plaintext for P1/P2 dev is fine.
2. **Billing-out interaction (§6.8):** fail over then keep going, or fail over once then pause when
   both out? — recommend: fail over; pause only when BOTH keys are exhausted.
3. **Providers beyond OpenRouter:** ship openrouter-only first (shape the type for openai/anthropic/
   gemini but don't build their pages yet)? — recommend yes.
4. **`nodedex config` UI:** dedicated keyring overlay reachable from both `config` and the health
   view (recommended), vs a new top-level tab.

---

## 10. NON-GOALS (do not scope-creep into these)
- Per-project keys, team/shared keyrings, OAuth device flows — no.
- A secrets vault / OS keychain integration — nice, but not this build (note as future).
- Failover across PROVIDERS (openrouter→anthropic) — no; failover is key→key within a provider.
- Touching the extraction pipeline's model routing — untouched; only the client/key changes.
