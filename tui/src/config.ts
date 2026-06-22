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

// Models offered in the OpenRouter model step. The first is the recommended default
// (cheap + capable, paid). owl-alpha is FREE but trains on prompts (flagged below).
export interface ModelChoice { id: string; label: string; note: string; free?: boolean }
export const RECOMMENDED_MODELS: ModelChoice[] = [
  { id: "google/gemini-2.5-flash", label: "Gemini 2.5 Flash", note: "recommended — cheap + capable" },
  { id: "openai/gpt-4o-mini",      label: "GPT-4o mini",      note: "cheap, reliable" },
  { id: "openrouter/owl-alpha",    label: "Owl Alpha",        note: "FREE — trains on your prompts", free: true },
];

// Known free models that train on submitted prompts — used to warn the user that their
// inputs may be used to improve the model. Matched case-insensitively as a substring so
// provider-prefixed ids (openrouter/owl-alpha) and bare ids both hit.
const TRAINS_ON_PROMPTS = ["owl-alpha"];
export function isTrainsOnPrompts(model: string): boolean {
  const m = (model || "").toLowerCase();
  return TRAINS_ON_PROMPTS.some((needle) => m.includes(needle));
}

export type Provider = "openrouter";

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
  openrouter_key?: string;
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
  return true;
}

/** The provider env a TUI-launched server needs (OpenRouter via the openai-compatible
 *  path). Empty when un-configured (so launchServer stays a no-op for un-onboarded use).
 *  These WIN over the server's .env because node --env-file won't override set vars. */
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
  return {};
}

export { NODEDEX_HOME, CONFIG_FILE };
