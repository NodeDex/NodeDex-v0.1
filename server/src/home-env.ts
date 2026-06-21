// home-env.ts — the user-home config home (~/.nodedex/.env).
//
// WHY: the engine is env-var-native (every setting is read from process.env). A FRESH
// install has no repo `server/.env`, so settings set via the web-UI config endpoint had
// nowhere durable to live (applied in-memory, lost on restart). This makes ~/.nodedex/.env
// that durable home — the same ~/.nodedex/ dir that already holds reflect-pause, pidfiles,
// and the TUI config. ONE config model end-to-end (env vars), no JSON↔env mapping layer.
//
// PRECEDENCE (highest → lowest): explicit process env / --env-file (e.g. dev server/.env)
// > ~/.nodedex/.env. loadHomeEnv only fills keys NOT already set, so a dev .env or a real
// env var always wins; the home file is the fallback that a fresh install relies on.

import { homedir } from "os";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { existsSync, readFileSync } from "fs";

export const NODEDEX_HOME = resolve(homedir(), ".nodedex");
export const HOME_ENV_PATH = resolve(NODEDEX_HOME, ".env");

/** Strip a trailing inline ` # comment` (whitespace-then-#, standard .env semantics) and
 *  surrounding whitespace. A bare `#` with NO preceding whitespace (e.g. a hex `#ff0000`)
 *  is kept as part of the value. */
export function stripInlineComment(value: string): string {
  const m = value.match(/\s#/);
  return (m ? value.slice(0, m.index) : value).trim();
}

/** Parse a flat KEY=VALUE .env file into a map. Ignores blank lines + full-line `#`
 *  comments, and strips trailing inline `# comments` from values (so an annotated
 *  `KEY=2  # note` parses to `2`, not `2  # note` → which would `Number()`→`NaN`).
 *  The first `=` splits key/value (values may contain `=`). Pure / testable. */
export function parseEnvFile(content: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of (content ?? "").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq < 0) continue;
    map.set(t.slice(0, eq).trim(), stripInlineComment(t.slice(eq + 1)));
  }
  return map;
}

/** Repo `.env` candidates (the DEV file): server/.env (one level up from src|dist) or
 *  the cwd .env. */
function repoEnvCandidates(): string[] {
  const here = dirname(fileURLToPath(import.meta.url)); // server/src or server/dist
  return [resolve(here, "../.env"), resolve(process.cwd(), ".env")];
}

/** An EXISTING repo `.env`, or null. */
export function findExistingRepoEnv(): string | null {
  for (const p of repoEnvCandidates()) if (existsSync(p)) return p;
  return null;
}

/** Where the config endpoint WRITES settings: an existing repo `.env` (so dev keeps using
 *  server/.env) else the user-home `~/.nodedex/.env` (created on first write — the
 *  fresh-install target). NEVER null, so a fresh install always has somewhere to persist. */
export function resolveEnvWriteTarget(): string {
  return findExistingRepoEnv() ?? HOME_ENV_PATH;
}

/** Apply a key→value map to process.env, but ONLY keys not already set (so an explicit
 *  env / --env-file / repo .env wins). Returns how many were applied. Pure-ish (mutates
 *  process.env, which is the point); separated for testability. */
export function applyUnsetEnv(map: Map<string, string>): number {
  let applied = 0;
  for (const [k, v] of map) {
    if (process.env[k] === undefined) { process.env[k] = v; applied++; }
  }
  return applied;
}

/** Load ~/.nodedex/.env at boot, applying only keys not already set. Returns the count
 *  applied (0 if the file is absent / unreadable). This is what makes web-UI-saved
 *  settings take effect on the next restart. `envPath` is injectable for tests. */
export function loadHomeEnv(envPath: string = HOME_ENV_PATH): number {
  try {
    if (!existsSync(envPath)) return 0;
    return applyUnsetEnv(parseEnvFile(readFileSync(envPath, "utf8")));
  } catch {
    return 0;
  }
}
