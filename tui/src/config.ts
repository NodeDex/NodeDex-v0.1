// config.ts — the onboarding config home (~/.nodedex/config.json).
//
// The TUI owns onboarding config here (user's decision); it is injected into any
// server the TUI launches as env overrides (see servers.ts), so the secret never
// lives in the git repo. This is also the natural seat for the forward-compat
// auth/identity config later.
//
// Provider: OpenRouter (BYO key) — one platform for every model, spoken via the
// server's openai-compatible path.
import { homedir } from "os";
import { resolve } from "path";
import { mkdirSync, readFileSync, writeFileSync, readdirSync } from "fs";

const NODEDEX_HOME = resolve(homedir(), ".nodedex");
const CONFIG_FILE = resolve(NODEDEX_HOME, "config.json");

export const DEFAULT_PORT = 3001;
export const DEFAULT_DB = resolve(NODEDEX_HOME, "workspace.db");

export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
export const OPENROUTER_DEFAULT_MODEL = "google/gemini-2.5-flash";

// Local / self-hosted default (Ollama). LM Studio = :1234/v1, vLLM = your host. Used by the
// "Local / self-hosted" onboarding path — no API key, fully offline, $0.
export const DEFAULT_LOCAL_BASE_URL = "http://localhost:11434/v1";

// Models offered in the OpenRouter model step. The first is the recommended default
// (cheapest capable, 1M context). No free row: free OpenRouter models rate-limit (429)
// under the pipeline's multi-call bursts, and stealth models (owl-alpha) get delisted.
// Truly free = the Local provider path (Ollama / LM Studio), no key needed.
export interface ModelChoice { id: string; label: string; note: string; free?: boolean }
export const RECOMMENDED_MODELS: ModelChoice[] = [
  { id: "google/gemini-2.5-flash-lite", label: "Gemini 2.5 Flash Lite", note: "recommended — cheapest, 1M ctx" },
  { id: "google/gemini-2.5-flash",      label: "Gemini 2.5 Flash",      note: "cheap + capable" },
  { id: "openai/gpt-4o-mini",           label: "GPT-4o mini",           note: "cheap, reliable" },
];

// Models that train on submitted prompts — used to warn the user that their inputs may
// be used to improve the model. Matched case-insensitively as a substring so
// provider-prefixed and bare ids both hit. ":free" catches OpenRouter free variants,
// whose provider data policies generally allow prompt training.
const TRAINS_ON_PROMPTS = ["owl-alpha", ":free"];
export function isTrainsOnPrompts(model: string): boolean {
  const m = (model || "").toLowerCase();
  return TRAINS_ON_PROMPTS.some((needle) => m.includes(needle));
}

export type Provider = "openrouter" | "local";

// Hermes/Owl capture (the state.db watcher). Hermes ignores model-proxy + shell-hook capture, so
// the only working path is reading its own state.db. These knobs are owned by the TUI Settings tab
// and read live by server/adapters/hermes-statedb-watcher.mjs each poll (so a change applies without
// a watcher restart). `sources` is the privacy filter: only Hermes sessions whose `source` matches
// are captured (default ["tui"]; "*" = all sources).
export interface HermesCaptureConfig {
  enabled?: boolean;       // is the watcher meant to run (the TUI starts/stops it on this)
  sources?: string[];      // allow-list of Hermes session sources; ["*"] = all
  pollMs?: number;         // poll interval (default 4000)
  stateDbPath?: string;    // override Hermes state.db location (default %LOCALAPPDATA%/hermes/state.db)
}
export const DEFAULT_HERMES_SOURCES = ["tui"];

export interface NodedexConfig {
  provider?: Provider;
  openrouter_key?: string;       // openrouter path only
  base_url?: string;             // local path only — the OpenAI-compatible endpoint (e.g. Ollama)
  // chosen model (default applied if blank)
  model?: string;
  // chosen server port + DB path (picked during onboarding; reused on re-run)
  port?: number;
  dbPath?: string;
  onboarded?: boolean;
  hermesCapture?: HermesCaptureConfig;
}

export interface DbChoice { name: string; path: string }
/** Existing Nodedex DBs in ~/.nodedex (so the user can reuse one instead of a new graph). */
export function listDbs(): DbChoice[] {
  try {
    return readdirSync(NODEDEX_HOME)
      .filter((f) => f.endsWith(".db"))
      .map((f) => ({ name: f.replace(/\.db$/, ""), path: resolve(NODEDEX_HOME, f) }));
  } catch {
    return []; // home not created yet / unreadable → no existing DBs
  }
}

/** Resolve a user-typed DB name to a ~/.nodedex/<name>.db path (sanitized). */
export function dbPathForName(name: string): string {
  const safe = (name || "workspace").trim().replace(/[^a-z0-9_-]/gi, "-").replace(/^-+|-+$/g, "") || "workspace";
  return resolve(NODEDEX_HOME, `${safe}.db`);
}

export function loadConfig(): NodedexConfig {
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, "utf8")) as NodedexConfig;
  } catch {
    return {};
  }
}

export function saveConfig(patch: Partial<NodedexConfig>): void {
  const cfg = { ...loadConfig(), ...patch };
  try {
    mkdirSync(NODEDEX_HOME, { recursive: true });
    writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
  } catch {
    /* read-only home → no persistence; the in-session launch env still works */
  }
}

/** The current Hermes-capture config, with defaults filled in. */
export function loadHermesCapture(): Required<HermesCaptureConfig> {
  const h = loadConfig().hermesCapture ?? {};
  const sources = Array.isArray(h.sources) && h.sources.length ? h.sources.map(String) : [...DEFAULT_HERMES_SOURCES];
  return {
    // Default ON: capture should "just work" for a normal user. The watcher idles harmlessly
    // when no Hermes state.db exists, and the user can turn it off in Settings (sets enabled:false).
    enabled: h.enabled !== false,
    sources,
    pollMs: Number.isFinite(h.pollMs) && (h.pollMs as number) >= 500 ? (h.pollMs as number) : 4000,
    stateDbPath: h.stateDbPath ?? "",
  };
}

/** Patch the Hermes-capture block (nested merge — saveConfig is a shallow merge, so do it here). */
export function setHermesCapture(patch: Partial<HermesCaptureConfig>): void {
  const current = loadConfig().hermesCapture ?? {};
  saveConfig({ hermesCapture: { ...current, ...patch } });
}

/** Parse a user-typed source list ("tui, telegram" or "*") into a clean array. */
export function parseSources(input: string): string[] {
  const parts = (input || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (parts.includes("*")) return ["*"];
  return parts.length ? Array.from(new Set(parts)) : [...DEFAULT_HERMES_SOURCES];
}

/** First run = not yet onboarded, or the chosen provider isn't usable yet. */
export function needsOnboarding(): boolean {
  const c = loadConfig();
  if (!c.onboarded) return true;
  if (c.provider === "openrouter") return !c.openrouter_key;
  if (c.provider === "local") return !c.base_url || !c.model;  // local needs an endpoint + model, no key
  return true;
}

/** The provider env a TUI-launched server needs. Both paths speak the openai-compatible API:
 *  OpenRouter (cloud, BYO key) or a local/self-hosted endpoint (Ollama/LM Studio/vLLM, no key).
 *  Empty when un-configured (so launchServer stays a no-op for un-onboarded use). These WIN over
 *  the server's .env because node --env-file won't override set vars. */
export function providerEnv(): Record<string, string> {
  const c = loadConfig();
  if (c.provider === "openrouter" && c.openrouter_key) {
    return {
      AI_PROVIDER: "openai-compatible",
      OPENAI_BASE_URL: OPENROUTER_BASE_URL,
      OPENAI_API_KEY: c.openrouter_key,
      AI_MODEL: c.model || OPENROUTER_DEFAULT_MODEL,
    };
  }
  if (c.provider === "local" && c.base_url && c.model) {
    return {
      AI_PROVIDER: "openai-compatible",
      OPENAI_BASE_URL: c.base_url,
      OPENAI_API_KEY: "local",         // local servers ignore the key; a non-empty value keeps clients happy
      AI_MODEL: c.model,
    };
  }
  return {};
}

// ─── local model discovery (so the wizard can list your models, not ask for a URL) ──────────
export interface LocalModel { label: string; baseUrl: string; model: string }

/** Probe the usual local LLM servers (Ollama, LM Studio, vLLM) and list the models they serve,
 *  so onboarding can show a pick-list instead of asking for a URL + model id. Each server that
 *  isn't running just fails fast and is skipped. Returns [] if nothing local is up. */
export async function scanLocalModels(): Promise<LocalModel[]> {
  const out: LocalModel[] = [];
  const seen = new Set<string>();
  const add = (baseUrl: string, model: string, server: string) => {
    const m = (model || "").trim();
    const key = `${baseUrl}::${m}`;
    if (m && !seen.has(key)) { seen.add(key); out.push({ label: `${m}  ·  ${server}`, baseUrl, model: m }); }
  };
  const get = async (url: string): Promise<any | null> => {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(1500) });
      return r.ok ? await r.json() : null;
    } catch { return null; }
  };
  // Ollama's native tags API (richest model list).
  const tags = await get("http://localhost:11434/api/tags");
  for (const m of tags?.models ?? []) add("http://localhost:11434/v1", m?.name ?? m?.model, "Ollama");
  // OpenAI-compatible /v1/models on the common local ports.
  for (const [port, server] of [[1234, "LM Studio"], [8000, "vLLM"], [11434, "Ollama"]] as const) {
    const base = `http://localhost:${port}/v1`;
    const j = await get(`${base}/models`);
    for (const m of j?.data ?? []) add(base, m?.id, server);
  }
  return out;
}

export { NODEDEX_HOME, CONFIG_FILE };
