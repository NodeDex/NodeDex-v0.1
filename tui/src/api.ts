// api.ts — read-only REST client for a running NodeDex server.
// The TUI NEVER touches the DB; it only reads endpoints that already exist
// (session, reflect/status, session/events, flags, blocks). Every fetch is
// failure-tolerant: a down/501 endpoint yields null, the rest still render.

// Force IPv4 for the loopback host. On Windows, "localhost" resolves to IPv6 ::1
// FIRST; servers bind IPv4 (127.0.0.1), so every localhost request pays a ~200ms
// ::1-refused → IPv4-retry penalty — the TUI's lag (measured: localhost 0.21s vs
// 127.0.0.1 0.001s per request). 127.0.0.1 also works when a server binds 0.0.0.0.
export function prefer127(url: string): string {
  return url.replace(/\/\/localhost(?=[:/]|$)/i, "//127.0.0.1");
}

import { loadConfig } from "./config.js";

// The active server. Mutable so the Servers pane can switch which graph the
// TUI reads at runtime (was a const — multi-server switching needs it live).
// Default base honors the CONFIG port — `nodedex run` starts the server on
// config.json's port, so the TUI must aim there by default, not a hardcoded 3001
// (the "ran nodedex, then nodedex tui, can't connect" bug).
const configPort = (() => { try { const p = loadConfig().port; return Number.isInteger(p) && (p as number) > 0 ? p : null; } catch { return null; } })();
let currentBase = prefer127((process.env.NODEDEX_TUI_API || `http://localhost:${configPort || 3001}`).replace(/\/$/, ""));
// Per-server API tokens. A server launched with NODEDEX_API_TOKEN gates its WHOLE REST API,
// so the TUI must send the token to read it. Keyed by normalized base url; setBase picks the
// active one up automatically, so every connect path authenticates without extra plumbing.
const tokenByBase = new Map<string, string>();
let currentToken = process.env.NODEDEX_TUI_TOKEN || "";
export function registerToken(url: string, token: string | undefined | null): void {
  const u = prefer127(url.replace(/\/$/, ""));
  if (token) tokenByBase.set(u, token);
  else tokenByBase.delete(u);
}
function authHeaders(forUrl?: string): Record<string, string> {
  const t = forUrl ? (tokenByBase.get(prefer127(forUrl.replace(/\/$/, ""))) || "") : currentToken;
  return t ? { "x-nodedex-token": t } : {};
}
export function getBase(): string {
  return currentBase;
}
export function setBase(url: string): void {
  currentBase = prefer127(url.replace(/\/$/, ""));
  currentToken = tokenByBase.get(currentBase) || (process.env.NODEDEX_TUI_TOKEN || "");
}

async function getJSON<T = any>(path: string, timeoutMs = 4000): Promise<T | null> {
  try {
    const r = await fetch(`${currentBase}${path}`, { headers: authHeaders(), signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) return null;
    return (await r.json()) as T;
  } catch {
    return null;
  }
}

// Probe an ARBITRARY url (not the active base) for a NodeDex server's identity —
// used by server discovery. One cheap GET /api/session; short timeout so a dead
// port fails fast.
export async function probeServer(url: string): Promise<{ up: boolean; db?: string; blocks?: number }> {
  const base = prefer127(url.replace(/\/$/, ""));
  try {
    const r = await fetch(`${base}/api/session`, { headers: authHeaders(url), signal: AbortSignal.timeout(1200) });
    if (r.ok) {
      const j = (await r.json()) as { db?: string; total_blocks?: number };
      return { up: true, db: j.db, blocks: j.total_blocks };
    }
    // Responded but gated (token required, not supplied) → still confirm liveness via the
    // always-open /api/health route, so a token-protected server shows UP (without its data).
    if (r.status === 401 || r.status === 403) {
      const h = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1200) });
      if (h.ok) return { up: true };
    }
    return { up: false };
  } catch {
    return { up: false }; // connection refused / timeout = genuinely down
  }
}

export interface RecentBlock {
  id: string;
  label: string;
  type: string;
  essence: string;
  created_at: string;
}

export interface RecallEvent {
  id: number;
  timestamp: string;
  type: "recall";
  query: string;
  recalled: Array<{ label: string; type: string; project: string; quality: number }>;
  total_injected: number;
}

export interface AgentFlag {
  id: string;
  question: string;
  you_are_recording?: { what?: string; value?: string; owner?: string };
  existing_uncertain?: { what?: string; value?: string; owner?: string } | null;
  routed_reason?: string;
}

export interface ReviewBlock {
  id: string;
  label: string;
  type: string;
  essence: string;
  review_reason?: string;
}

export interface ProjectRef {
  id: string;
  label: string;
  essence: string;
}

export interface SessionInfo {
  db?: string; // basename of the server's DB file — server identity
  total_blocks?: number;
  by_type?: Record<string, number>;
  recent_blocks?: RecentBlock[];
  projects?: ProjectRef[];
  open_tasks?: ProjectRef[];
  last_reflect?: {
    blocks_created: number;
    blocks_updated: number;
    turn_name?: string | null;
    timestamp?: string;
  } | null;
}

export interface ReflectStatus {
  paused: boolean;
  // SPENDING paused (cost-breaker / credit-out) while CAPTURE keeps queuing — distinct
  // from `paused` (which stops capture). Set true when the account is out of credit.
  spend_paused?: boolean;
  spend_pause_reason?: string | null;
  queue_depth: number;
  processing: boolean;
}

export interface RelatedPair {
  root_a: string;
  root_b: string;
  categories: Partial<Record<string, number>>;
  total: number;
  parent: string | null;
  parent_subordinating_edges: number;
}
export interface RootRelatedness {
  pairs: RelatedPair[];
  standalone: string[];
}

// Cost breaker verdict (GET /api/usage/budget). config null fields = guard off.
export interface BudgetVerdict {
  tripped: boolean;
  reason: string | null;
  config: { minCreditUsd: number | null; dailyBudgetUsd: number | null };
  observed: { credit: { kind: string; remaining?: number }; spend24h: number };
}

// Per-pass cost of the latest reflect run (GET /api/usage/passes).
export interface PassCost { name: string; usd: number | null }
export interface PassCosts {
  turn: number | null;
  turn_name: string | null;
  total_usd: number | null;
  passes: PassCost[];
  note?: string;
}

// Monitoring alert (GET /api/alerts) — rate-limits, processing lag, queue backup,
// quality drops, credit-exhaustion. The Live tab's error terminal renders these.
export interface AlertRecord {
  id: number;
  timestamp: string;
  condition: string;
  severity: "warn" | "critical";
  message: string;
  context?: Record<string, unknown>;
}

export interface Dashboard {
  ok: boolean;
  base: string;
  fetchedAt: Date;
  session: SessionInfo | null;
  reflect: ReflectStatus | null;
  reads: RecallEvent[];
  agentFlags: AgentFlag[];
  flagSummary: { total?: number; unreviewed?: number; by_type?: Record<string, number> } | null;
  reviewQueue: ReviewBlock[];
  related: RootRelatedness | null;
  budget: BudgetVerdict | null;
  passes: PassCosts | null;
  alerts: AlertRecord[];
}

export interface Balance {
  remaining: number | null;
  available: boolean;
}

// Fast poll — all LOCAL endpoints (no external calls), safe to hit every couple seconds.
export async function fetchDashboard(): Promise<Dashboard> {
  const [session, reflect, eventsRes, agentFlagsRes, flagSummary, reviewRes, relatedRes, budget, passes, alertsRes] = await Promise.all([
    getJSON<SessionInfo>("/api/session"),
    getJSON<ReflectStatus>("/api/reflect/status"),
    getJSON<{ events: any[] }>("/api/session/events"),
    getJSON<{ flags: AgentFlag[] }>("/api/flags/agent-pending"),
    getJSON<{ total: number; unreviewed: number; by_type: Record<string, number> }>("/api/flags/summary"),
    getJSON<{ blocks: ReviewBlock[] }>("/api/blocks/review-queue"),
    getJSON<RootRelatedness>("/api/roots/related"),
    // budget hits OpenRouter only when a credit floor is set, and that fetch is
    // cached ~60s server-side, so it's safe on the 2s poll.
    getJSON<BudgetVerdict>("/api/usage/budget"),
    getJSON<PassCosts>("/api/usage/passes"),
    getJSON<{ alerts: AlertRecord[] }>("/api/alerts"),
  ]);

  const reads: RecallEvent[] = Array.isArray(eventsRes?.events)
    ? (eventsRes!.events.filter((e: any) => e?.type === "recall") as RecallEvent[]).slice(-8).reverse()
    : [];

  return {
    ok: !!session || !!reflect,
    base: currentBase,
    fetchedAt: new Date(),
    session,
    reflect,
    reads,
    agentFlags: Array.isArray(agentFlagsRes?.flags) ? agentFlagsRes!.flags : [],
    flagSummary,
    reviewQueue: Array.isArray(reviewRes?.blocks) ? reviewRes!.blocks : [],
    related: relatedRes,
    budget,
    passes,
    alerts: Array.isArray(alertsRes?.alerts) ? alertsRes!.alerts.slice(-20).reverse() : [],
  };
}

// ─── Settings (operator essentials) — admin config + reflect toggle ──────────
// The breaker floor/cap live in dash.budget.config and reflect state in dash.reflect,
// so the Settings tab reuses the 2s poll for those; only the model fields need a fetch.
export interface AdminConfig {
  provider?: string;
  model?: string;
  fallback_model?: string;
  embedding_provider?: string;
  thinking_budget?: string;
  min_credit_usd?: string;
  daily_budget_usd?: string;
  arc_auto_turns?: string;
  env_file_path?: string;
}

export async function fetchConfig(): Promise<AdminConfig | null> {
  return getJSON<AdminConfig>("/api/admin/config", 6000);
}

/** Persist a config patch (model/fallback/breaker). Applies live + writes .env. */
export async function postConfig(patch: Record<string, string | number>): Promise<boolean> {
  try {
    const r = await fetch(`${currentBase}/api/admin/config`, {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders() },
      body: JSON.stringify(patch),
      signal: AbortSignal.timeout(8000),
    });
    return r.ok;
  } catch { return false; }
}

/** Pause or resume the reflect pipeline (capture). */
export async function setReflectPausedRemote(paused: boolean): Promise<boolean> {
  try {
    const r = await fetch(`${currentBase}/api/reflect/${paused ? "pause" : "resume"}`, {
      method: "POST", headers: authHeaders(), signal: AbortSignal.timeout(6000),
    });
    return r.ok;
  } catch { return false; }
}

// ─── Browse pane (on-demand reads, not part of the 2s poll) ─────────────────

export interface TreeRoot {
  id: string;
  label: string;
  type: string;
  essence: string;
  children_count?: number;
}

export async function fetchTree(): Promise<TreeRoot[]> {
  const r = await getJSON<{ tree: TreeRoot[] }>("/api/tree?depth=1");
  return Array.isArray(r?.tree) ? r!.tree : [];
}

export interface BlockRow {
  id: string;
  label: string;
  type: string;
  essence: string;
  project_id: string | null;
  chain_id: string | null;
  review_status: string | null;
  quality_score?: number | null;
  created_at?: string;
}

export async function fetchProjectBlocks(projectLabel: string): Promise<BlockRow[]> {
  const r = await getJSON<BlockRow[]>(`/api/blocks?project=${encodeURIComponent(projectLabel)}&limit=500`);
  return Array.isArray(r) ? r : [];
}

// Search — the same three-signal /api/search agents use (semantic + keyword +
// concept, ranked by match quality only). Slim rows plus per-hit context:
// root_label/root_essence (which world is this from), superseded_by (stale →
// current truth), weak_match (nearest-neighbor shrug — nothing really matched).
export interface SearchRow extends BlockRow {
  score?: number;
  match_types?: string[];
  root_label?: string;
  root_essence?: string;
  superseded_by?: string;
  weak_match?: boolean;
}

export async function searchMemory(q: string, limit = 6): Promise<SearchRow[]> {
  if (!q.trim()) return [];
  const r = await getJSON<SearchRow[]>(`/api/search?q=${encodeURIComponent(q)}&limit=${limit}`);
  return Array.isArray(r) ? r : [];
}

export interface EdgeRef {
  type: string;
  target_id?: string;
  target_label?: string;
  source_id?: string;
  source_label?: string;
}

export interface BlockDetail extends BlockRow {
  content: any; // detail endpoint returns parsed JSON ({ is_a, unique, ... })
  outgoing: EdgeRef[];
  incoming: EdgeRef[];
  conflicts: EdgeRef[];
  source_excerpt?: string | null;
  access_count?: number;
}

export async function fetchBlockDetail(id: string): Promise<BlockDetail | null> {
  return getJSON<BlockDetail>(`/api/blocks/${encodeURIComponent(id)}?detail=relations`);
}

// ─── Chains pane ─────────────────────────────────────────────────────────────

// chain blocks (type:"chain") — content carries unique.arc + unique.conclusion
export async function fetchChains(): Promise<BlockRow[]> {
  const r = await getJSON<BlockRow[]>(`/api/blocks?type=chain&limit=200`);
  return Array.isArray(r) ? r : [];
}

export interface ChainMember {
  id: string;
  label: string;
  type: string;
  flow_role: string | null;
  essence: string;
  quality_score?: number | null;
}

export async function fetchChainMembers(chainBlockId: string): Promise<ChainMember[]> {
  const r = await getJSON<{ blocks: ChainMember[] }>(`/api/chains/${encodeURIComponent(chainBlockId)}`);
  return Array.isArray(r?.blocks) ? r!.blocks : [];
}

// ─── Review pane (the TUI's only write surface: flag verdicts) ──────────────

export interface PipelineFlagRow {
  id: string;
  flag_type: string;
  block_id_a: string;
  block_id_b: string | null;
  origin_writer: string;
  review_reason?: string | null;
  reviewed_at?: string | null;
  review_verdict?: string | null;
  created_at?: string;
  // detector context — carries the human-readable labels so the queue can show
  // WHAT the blocks are, not just their IDs (the snapshot detail is fetched lazily).
  criteria?: {
    signal?: string;
    shared_concepts?: number;
    type_a?: string | null;
    type_b?: string | null;
    label_a?: string | null;
    label_b?: string | null;
  } | null;
}

export interface FlagBlockSnapshot {
  id: string;
  label: string;
  type: string;
  essence: string;
  content: string;
  source?: string | null;
}

export async function fetchUnreviewedFlags(): Promise<PipelineFlagRow[]> {
  const r = await getJSON<{ flags: PipelineFlagRow[] }>(`/api/flags?reviewed=false&limit=50`);
  return Array.isArray(r?.flags) ? r!.flags : [];
}

export async function fetchFlagDetail(
  id: string
): Promise<{ flag: PipelineFlagRow; block_a: FlagBlockSnapshot | null; block_b: FlagBlockSnapshot | null } | null> {
  return getJSON(`/api/flags/${encodeURIComponent(id)}`);
}

// the ONE write: POST a verdict (merge can execute: archive loser + wire
// superseded_by). Returns the server's reply verbatim so errors surface in UI.
export async function postFlagReview(
  id: string,
  body: { verdict: string; reason: string; execute?: boolean; winning_block_id?: string }
): Promise<{ ok?: boolean; error?: string } | null> {
  try {
    const r = await fetch(`${currentBase}/api/flags/${encodeURIComponent(id)}/review`, {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders() },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8000),
    });
    return (await r.json()) as { ok?: boolean; error?: string };
  } catch (e) {
    return { error: String(e) };
  }
}

// Slow poll — balance hits OpenRouter (external), so it runs on its own ~30s cadence.
export async function fetchBalance(): Promise<Balance> {
  const b = await getJSON<{ remaining: number | null }>("/api/usage/balance", 8000);
  if (!b || typeof b.remaining === "undefined") return { remaining: null, available: false };
  return { remaining: b.remaining, available: true };
}

// back-compat: a few callers imported BASE for display. getBase() is the live
// value; this stays as the INITIAL base only.
export const BASE = currentBase;
