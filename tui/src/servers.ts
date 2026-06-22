// servers.ts — multi-server registry + process manager for the Servers pane.
//
// The TUI is normally a pure read-client. This module is the one deliberate
// exception (user-approved): it can LAUNCH and STOP NodeDex servers. That
// crosses into process-management, so the footguns this project already hit are
// fenced HERE, in one place:
//   - launched servers run the FULL system: the maintenance workers (flag-reviewer,
//     describer, schema-heal, …) default ON — overridable via env / ~/.nodedex/.env.
//     The legacy per-turn NODEDEX_INACTIVITY_REFLECT stays 0 (arc mode supersedes it).
//   - user settings saved to ~/.nodedex/.env (arc auto-turns, etc.) are read here so they
//     survive a relaunch (the launcher's explicit env otherwise shadows the env-file)
//   - env overrides (PORT, WORKSPACE_DB_PATH) WIN over the server's .env because
//     node --env-file does not override already-set vars (the isolation the
//     RUNBOOK relies on)
//   - stdout/stderr are captured to a log file (no silent failures)
//   - the TUI can only STOP servers IT launched (we hold the child handle);
//     pre-existing servers are shown but never killed (containment)
//   - all launched children are killed when the TUI exits
import { spawn, type ChildProcess } from "child_process";
import { createServer } from "net";
import { fileURLToPath } from "url";
import { dirname, resolve, basename } from "path";
import { homedir } from "os";
import { mkdirSync, createWriteStream, readFileSync, writeFileSync, existsSync, readdirSync, statSync, renameSync, rmSync } from "fs";
import { probeServer, prefer127, registerToken } from "./api.js";
import { providerEnv } from "./config.js";
import { randomBytes } from "node:crypto";

// server dir resolved from this file (.../Nodedex/tui/src/servers.ts → ../../server)
const SERVER_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "server");
const NODEDEX_HOME = resolve(homedir(), ".nodedex");

/** Read the persisted ~/.nodedex/.env (the file POST /api/admin/config writes) so a user's
 *  saved settings — e.g. arc auto-turns — survive a TUI relaunch. The launcher sets some env
 *  keys explicitly, and those WIN over the spawned server's --env-file load, so without reading
 *  the saved file here a user's choice would be shadowed by the hardcoded default every relaunch.
 *  Precedence used below: explicit process.env > saved ~/.nodedex/.env > built-in default.
 *  Best-effort: a missing/garbled file yields {}. */
function readHomeEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    const p = resolve(NODEDEX_HOME, ".env");
    if (!existsSync(p)) return out;
    for (const raw of readFileSync(p, "utf8").split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq < 1) continue;
      out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
    }
  } catch { /* best-effort — fall back to defaults */ }
  return out;
}
const PINS_FILE = resolve(NODEDEX_HOME, "tui-servers.json");
const SESSION_FILE = resolve(NODEDEX_HOME, "tui-session.json");
const LOG_DIR = resolve(NODEDEX_HOME, "tui-logs");

// ports probed during discovery (plus any pinned urls). 127.0.0.1, not localhost —
// the IPv4 host skips Windows's ::1-first penalty (see prefer127 in api.ts).
const CANDIDATE_PORTS = [3001, 3002, 3003, 3004, 3005, 3099];
const candidateUrl = (p: number) => `http://127.0.0.1:${p}`;

export interface Pin {
  url: string;
  name?: string;
}

export interface ServerEntry {
  url: string;
  port: number | null;
  name?: string;
  up: boolean;
  db?: string;
  blocks?: number;
  managed: boolean; // launched by this TUI → stoppable
}

// ─── available DB files (for the launch/swap picker) ────────────────────────
// A port is just an access point; the DB is the content. Let the user pick the
// DB to run rather than type a path. Scan the dirs where DBs actually live.
// DBs live in the config home (~/.nodedex) — the same place the onboarding wizard
// (config.ts) creates + lists them, so both pickers agree. (Was repo/data + a hardcoded
// C:/tmp dev-scratch dir — dev leftovers that put user data inside the repo.)
const DATA_DIR = NODEDEX_HOME;
const DB_DIRS = [NODEDEX_HOME];

export interface DbFile {
  path: string;
  name: string;
  sizeKB: number;
  mtime: number;
  empty: boolean; // ~4KB freshly-created sqlite = no data
}

export function listDbs(): DbFile[] {
  const out: DbFile[] = [];
  const seen = new Set<string>();
  for (const dir of DB_DIRS) {
    let names: string[] = [];
    try { names = readdirSync(dir); } catch { continue; }
    for (const f of names) {
      if (!f.endsWith(".db")) continue; // excludes -wal/-shm and .backup-* sidecars
      const p = resolve(dir, f);
      if (seen.has(p)) continue;
      seen.add(p);
      try {
        const s = statSync(p);
        out.push({ path: p, name: f, sizeKB: Math.round(s.size / 1024), mtime: s.mtimeMs, empty: s.size <= 8192 });
      } catch { /* skip unreadable */ }
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime); // most-recent first
}

// ─── create / rename / delete a db file ─────────────────────────────────────
// New DBs land in ~/.nodedex (a dir the picker already scans). A NodeDex DB is just a
// SQLite file the server creates + inits on first open, so "create" only resolves a
// valid path — the file appears when a server launches on it. Rename/delete touch the
// file + its -wal/-shm sidecars. GUARD: never rename/delete a db a running server holds
// (the DB-corruption rule) — refuse if a TUI-managed server has it open, and the OS lock
// is the backstop for external servers.
const DB_SIDECARS = ["", "-wal", "-shm"];

function sanitizeDbName(name: string): string {
  return (name || "").trim().replace(/\.db$/i, "")
    .replace(/[^a-z0-9_-]/gi, "-")  // any unsafe char → dash
    .replace(/-+/g, "-")            // collapse runs of dashes
    .replace(/^-+|-+$/g, "");       // trim leading/trailing dashes
}

/** Is this db file currently open by a server THIS TUI launched? */
export function isDbInUse(dbPath: string): boolean {
  const norm = dbPath.replace(/\\/g, "/").toLowerCase();
  for (const m of managed.values()) {
    if ((m.dbPath ?? "").replace(/\\/g, "/").toLowerCase() === norm) return true;
  }
  return false;
}

/** Resolve a new db path from a user name (data/<name>.db). Rejects empties + collisions. */
export function resolveNewDbPath(name: string): { ok: boolean; path?: string; error?: string } {
  const safe = sanitizeDbName(name);
  if (!safe) return { ok: false, error: "name needs a letter or number" };
  const path = resolve(DATA_DIR, `${safe}.db`);
  if (existsSync(path)) return { ok: false, error: `"${safe}" already exists — pick it from the list` };
  return { ok: true, path };
}

export function renameDb(oldPath: string, newName: string): { ok: boolean; path?: string; error?: string } {
  const safe = sanitizeDbName(newName);
  if (!safe) return { ok: false, error: "name needs a letter or number" };
  if (isDbInUse(oldPath)) return { ok: false, error: "db is in use — stop its server first ([x])" };
  const path = resolve(dirname(oldPath), `${safe}.db`);
  if (path === oldPath) return { ok: true, path };
  if (existsSync(path)) return { ok: false, error: `"${safe}" already exists` };
  try {
    for (const s of DB_SIDECARS) { if (existsSync(oldPath + s)) renameSync(oldPath + s, path + s); }
    return { ok: true, path };
  } catch (e: any) {
    return { ok: false, error: e?.code === "EBUSY" || e?.code === "EPERM" ? "db is locked (a server has it open)" : String(e?.message ?? e) };
  }
}

export function deleteDb(dbPath: string): { ok: boolean; error?: string } {
  if (isDbInUse(dbPath)) return { ok: false, error: "db is in use — stop its server first ([x])" };
  try {
    for (const s of DB_SIDECARS) { if (existsSync(dbPath + s)) rmSync(dbPath + s, { force: true }); }
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e?.code === "EBUSY" || e?.code === "EPERM" ? "db is locked (a server has it open)" : String(e?.message ?? e) };
  }
}

// ─── pinned servers (~/.nodedex/tui-servers.json) ───────────────────────────
export function loadPins(): Pin[] {
  try {
    const raw = readFileSync(PINS_FILE, "utf8");
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((p) => p && typeof p.url === "string") : [];
  } catch {
    return [];
  }
}

function savePins(pins: Pin[]): void {
  try {
    mkdirSync(NODEDEX_HOME, { recursive: true });
    writeFileSync(PINS_FILE, JSON.stringify(pins, null, 2));
  } catch {
    /* best-effort; a read-only home just means no persistence */
  }
}

export function addPin(url: string, name?: string): void {
  const u = url.replace(/\/$/, "");
  const pins = loadPins().filter((p) => p.url.replace(/\/$/, "") !== u);
  pins.push({ url: u, name: name?.trim() || undefined });
  savePins(pins);
}

export function namePin(url: string, name: string): void {
  const u = url.replace(/\/$/, "");
  const pins = loadPins();
  const hit = pins.find((p) => p.url.replace(/\/$/, "") === u);
  if (hit) hit.name = name.trim() || undefined;
  else pins.push({ url: u, name: name.trim() || undefined });
  savePins(pins);
}

// ─── session (~/.nodedex/tui-session.json) ──────────────────────────────────
// Remember EVERY server the TUI launched (port + dbPath) + which one was the focus, so a
// restart brings them ALL back — not just the latest. We persist the launch ingredients
// rather than keep processes alive on exit (the zombie-port/DB-lock footgun). On startup we
// relaunch each managed server that isn't already up and reconnect to the focused one.
export interface LastServer { url: string; port: number | null; dbPath?: string; managed: boolean }
interface ManagedRec { port: number; dbPath: string; bindHost?: string; token?: string }
interface SessionState { managed: ManagedRec[]; connected?: LastServer }

function loadSession(): SessionState {
  try {
    const r = JSON.parse(readFileSync(SESSION_FILE, "utf8"));
    // back-compat with the OLD single-server format ({url, port, dbPath, managed})
    if (r && typeof r.url === "string") {
      return { managed: r.managed && r.port && r.dbPath ? [{ port: r.port, dbPath: r.dbPath }] : [], connected: r };
    }
    return {
      managed: Array.isArray(r?.managed) ? r.managed.filter((m: any) => m && typeof m.port === "number" && m.dbPath) : [],
      connected: r?.connected,
    };
  } catch {
    return { managed: [] };
  }
}

function saveSession(s: SessionState): void {
  try {
    mkdirSync(NODEDEX_HOME, { recursive: true });
    writeFileSync(SESSION_FILE, JSON.stringify(s, null, 2));
  } catch { /* best-effort; read-only home just means no restore */ }
}

/** Snapshot the CURRENTLY-managed servers into the session. Called on launch + stop — NOT
 *  on child-exit, so a quit (which kills every child) can't wipe the list it should restore. */
function persistManagedSnapshot(): void {
  const list = [...managed.values()].map((m) => ({ port: m.port, dbPath: m.dbPath, bindHost: m.bindHost, token: m.token }));
  saveSession({ ...loadSession(), managed: list });
}

/** Record which server the user is focused on (the one to reconnect to first on restart). */
export function saveLastServer(rec: LastServer): void {
  saveSession({ ...loadSession(), connected: rec });
}

/**
 * Restore the session on startup: relaunch EVERY saved managed server that isn't already up,
 * then reconnect to the focused one (or the first managed). Returns the URL to connect to,
 * or null. We never resurrect an external (non-managed) url — only ones we have a db path for.
 */
export async function restoreSession(): Promise<string | null> {
  const s = loadSession();
  for (const m of s.managed) {
    if (!existsSync(m.dbPath)) continue;                          // db moved/deleted → skip
    if (managed.has(candidateUrl(m.port))) continue;             // we already launched it
    if ((await probeServer(candidateUrl(m.port))).up) continue;   // something already there
    launchServer({ port: m.port, dbPath: m.dbPath, bindHost: m.bindHost, token: m.token });
  }
  const target = s.connected?.url ?? (s.managed[0] ? candidateUrl(s.managed[0].port) : null);
  if (!target) return null;
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    if ((await probeServer(target)).up) return target;
    await new Promise((res) => setTimeout(res, 300));
  }
  return target; // hand back even if slow; the poll shows its state
}

// ─── managed children (only these can be stopped/killed) ────────────────────
interface Managed {
  child: ChildProcess;
  logPath: string;
  port: number;
  dbPath: string;
  bindHost?: string;
  token?: string;
}
const managed = new Map<string, Managed>(); // keyed by normalized url

/** The DB path a managed server was launched with (for last-session restore). */
export function managedDbPath(url: string): string | undefined {
  return managed.get(norm(url))?.dbPath;
}

const norm = (url: string) => prefer127(url.replace(/\/$/, ""));
const portOf = (url: string): number | null => {
  const m = url.match(/:(\d+)/);
  return m ? Number(m[1]) : null;
};

// ─── discovery ───────────────────────────────────────────────────────────────
// Probe candidate ports + pinned urls in parallel; merge with managed state.
export async function discover(): Promise<ServerEntry[]> {
  const pins = loadPins();
  const urls = new Set<string>([
    ...CANDIDATE_PORTS.map(candidateUrl),
    ...pins.map((p) => norm(p.url)),
    ...managed.keys(),
  ]);
  const nameFor = (u: string) => pins.find((p) => norm(p.url) === u)?.name;

  const entries = await Promise.all(
    [...urls].map(async (url): Promise<ServerEntry> => {
      const r = await probeServer(url);
      return {
        url,
        port: portOf(url),
        name: nameFor(url),
        up: r.up,
        db: r.db,
        blocks: r.blocks,
        managed: managed.has(url),
      };
    })
  );
  // up first, then by port
  return entries.sort((a, b) => Number(b.up) - Number(a.up) || (a.port ?? 0) - (b.port ?? 0));
}

// ─── free-port scan ──────────────────────────────────────────────────────────
// Return ports that are actually BINDABLE (can host a new server) — not merely "no
// Nodedex responding". A port held by ANY process (the user's ":3001 always used up")
// fails the bind, so it won't be suggested. Used by onboarding + the launch flow so the
// user never has to guess. Momentary bind + close; the launch-fails-loudly path covers
// the small TOCTOU race if something grabs the port in between.
function portBindable(port: number, timeoutMs = 600): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = createServer();
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const done = (free: boolean) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);          // don't leave a stray timer per scan
      try { srv.close(); } catch { /* */ }
      resolve(free);
    };
    srv.once("error", () => done(false));       // EADDRINUSE / EACCES → not free
    srv.once("listening", () => done(true));    // bound ok → free
    try { srv.listen(port, "127.0.0.1"); } catch { done(false); }
    timer = setTimeout(() => done(false), timeoutMs);
    timer.unref?.();                            // never keep the event loop alive on this
  });
}

export async function scanFreePorts(
  range: number[] = [3001, 3002, 3003, 3004, 3005, 3006, 3007, 3008, 3009, 3099],
  max = 6,
): Promise<number[]> {
  const free: number[] = [];
  for (const p of range) {
    // Free ⟺ bindable AND no Nodedex answering. The probe catches the Windows case
    // where 127.0.0.1 binds OK even though a server holds the port on 0.0.0.0.
    if (await portBindable(p) && !(await probeServer(candidateUrl(p))).up) free.push(p);
    if (free.length >= max) break;
  }
  return free;
}

// ─── launch ──────────────────────────────────────────────────────────────────
export interface LaunchResult {
  ok: boolean;
  url: string;
  logPath?: string;
  error?: string;
}

/** Random secret for NODEDEX_API_TOKEN when launching a network-reachable (0.0.0.0) server. */
export function genToken(): string {
  return randomBytes(18).toString("hex");
}

export function launchServer(opts: { port: number; dbPath: string; name?: string; bindHost?: string; token?: string }): LaunchResult {
  const url = candidateUrl(opts.port); // 127.0.0.1 — keep managed keys IPv4 like discovery
  if (managed.has(url)) return { ok: false, url, error: "already launched by this TUI" };
  if (!existsSync(SERVER_DIR)) return { ok: false, url, error: `server dir not found: ${SERVER_DIR}` };

  try {
    mkdirSync(LOG_DIR, { recursive: true });
    const logPath = resolve(LOG_DIR, `server-${opts.port}.log`);
    const out = createWriteStream(logPath, { flags: "a" });
    out.write(`\n=== launch ${new Date().toISOString()}  port=${opts.port}  db=${opts.dbPath} ===\n`);

    // --env-file=.env is a DEV convenience (repo-local overrides). A fresh clone has
    // NO repo .env — config comes from ~/.nodedex/.env (loaded by boot-env) + the env
    // passed below. `node --env-file` HARD-FAILS if the file is missing, so only add it
    // when it actually exists; otherwise a clean install can't launch at all.
    const nodeArgs = ["--import=tsx/esm", "src/server.ts"];
    if (existsSync(resolve(SERVER_DIR, ".env"))) nodeArgs.unshift("--env-file=.env");
    const homeEnv = readHomeEnv(); // persisted user settings (Settings → ~/.nodedex/.env)
    const child = spawn(
      process.execPath, // the same node running the TUI
      nodeArgs,
      {
        cwd: SERVER_DIR,
        env: {
          ...process.env,
          // OpenRouter key/provider from ~/.nodedex/config.json (onboarding). Empty
          // when un-configured. WINS over .env (node --env-file won't override set vars).
          ...providerEnv(),
          PORT: String(opts.port),
          WORKSPACE_DB_PATH: opts.dbPath,
          // Docker/remote launch: bind all interfaces + require a token (set by the launcher
          // when the user picks "agent in a container / on another machine"). Omitted →
          // the server's default localhost bind, no token.
          ...(opts.bindHost ? { NODEDEX_BIND_HOST: opts.bindHost } : {}),
          ...(opts.token ? { NODEDEX_API_TOKEN: opts.token } : {}),
          // FULL RUN: the maintenance workers (flag-reviewer, describer, schema-heal, …) are ON
          // by default — that's the complete system the pipeline is designed to run with.
          // flag-reviewer is set explicitly so the intent is legible (the gate treats anything
          // ≠ "off" as on). OVERRIDABLE: an explicit env or the saved ~/.nodedex/.env wins, so a
          // user who wants to cut the idle reviewer can set NODEDEX_FLAG_REVIEWER_ENABLED=off.
          NODEDEX_FLAG_REVIEWER_ENABLED: process.env.NODEDEX_FLAG_REVIEWER_ENABLED ?? homeEnv.NODEDEX_FLAG_REVIEWER_ENABLED ?? "on",
          // Legacy per-turn inactivity-reflect stays OFF — arc mode uses NODEDEX_ARC_INACTIVITY_ENABLED.
          NODEDEX_INACTIVITY_REFLECT: "0",
          // v2 ARC EXTRACTION is the default pipeline (the validated one; per-turn scene-card is
          // legacy). DEFAULTED here but OVERRIDABLE — an explicit env OR a saved ~/.nodedex/.env
          // value wins (`process.env ?? homeEnv ?? default`), so a user's Settings choice SURVIVES
          // a relaunch. Arc captures turns for batched extraction; the triggers that commit them:
          //   · ARC_AUTO_TURNS=N  → auto-extract every N captured turns (0 = off; user-settable in Settings)
          //   · ARC_INACTIVITY    → auto-extract after the conversation goes idle (last-resort sweep)
          // (the agent can still fire workspace_extract_arc sooner at its own task boundaries).
          NODEDEX_ARC_EXTRACTION:         process.env.NODEDEX_ARC_EXTRACTION         ?? homeEnv.NODEDEX_ARC_EXTRACTION         ?? "1",
          NODEDEX_ARC_INACTIVITY_ENABLED: process.env.NODEDEX_ARC_INACTIVITY_ENABLED ?? homeEnv.NODEDEX_ARC_INACTIVITY_ENABLED ?? "on",
          NODEDEX_ARC_AUTO_TURNS:         process.env.NODEDEX_ARC_AUTO_TURNS         ?? homeEnv.NODEDEX_ARC_AUTO_TURNS         ?? "8",
        },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      }
    );
    child.stdout?.pipe(out);
    child.stderr?.pipe(out);
    child.on("exit", () => managed.delete(url));

    managed.set(url, { child, logPath, port: opts.port, dbPath: opts.dbPath, bindHost: opts.bindHost, token: opts.token });
    if (opts.token) registerToken(url, opts.token); // so the TUI's own reads authenticate
    if (opts.name) addPin(url, opts.name);
    // Track it among the servers to restore next start (the WHOLE managed set, not just one).
    persistManagedSnapshot();
    return { ok: true, url, logPath };
  } catch (e) {
    return { ok: false, url, error: String(e) };
  }
}

// ─── stop (managed only) ──────────────────────────────────────────────────────
export function stopServer(url: string): { ok: boolean; error?: string } {
  const m = managed.get(norm(url));
  if (!m) return { ok: false, error: "not managed by this TUI — won't kill a server it didn't launch" };
  killChild(m);
  managed.delete(norm(url));
  persistManagedSnapshot(); // explicit stop → drop it from the restore set
  return { ok: true };
}

export function isManaged(url: string): boolean {
  return managed.has(norm(url));
}

// ─── swap: run a DIFFERENT db on the SAME port ──────────────────────────────
// "a single port that can run different db at a time" — stop the managed server
// on this port, wait for the port to actually release (polling, not a fixed
// guess — the OS frees it in a few hundred ms but timing varies), then relaunch
// it on the new db. Only valid for a TUI-managed port.
export async function swapDb(url: string, port: number, dbPath: string): Promise<LaunchResult> {
  if (!managed.has(norm(url))) return { ok: false, url, error: "not managed by this TUI" };
  stopServer(url);
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const r = await probeServer(candidateUrl(port));
    if (!r.up) break;
    await new Promise((res) => setTimeout(res, 250));
  }
  return launchServer({ port, dbPath });
}

function killChild(m: Managed): void {
  try {
    if (process.platform === "win32") {
      // tree-kill: --import=tsx/esm runs in-process, but be safe against children
      spawn("taskkill", ["/PID", String(m.child.pid), "/T", "/F"], { windowsHide: true });
    } else {
      m.child.kill("SIGTERM");
    }
  } catch {
    /* already gone */
  }
}

// ─── Hermes capture watcher (singleton) ─────────────────────────────────────
// The state.db watcher is the ONLY working Hermes capture path. It's a plain .mjs adapter that
// reads Hermes's state.db read-only + posts turns; the TUI owns its lifecycle so the user controls
// it from Settings (toggle = start/stop) instead of a separate terminal. Its config (source filter,
// poll) lives in ~/.nodedex/config.json and is re-read by the watcher each poll — so editing the
// filter in the TUI applies WITHOUT a restart here.
const WATCHER_SCRIPT = resolve(SERVER_DIR, "adapters", "hermes-statedb-watcher.mjs");
let watcher: ChildProcess | null = null;

export function isWatcherRunning(): boolean {
  return !!watcher && watcher.exitCode === null && !watcher.killed;
}

export function launchWatcher(): { ok: boolean; error?: string } {
  if (isWatcherRunning()) return { ok: true };
  if (!existsSync(WATCHER_SCRIPT)) return { ok: false, error: `watcher not found: ${WATCHER_SCRIPT}` };
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    const out = createWriteStream(resolve(LOG_DIR, "hermes-watcher.log"), { flags: "a" });
    out.write(`\n=== watcher launch ${new Date().toISOString()} ===\n`);
    // cwd=SERVER_DIR so the watcher's createRequire resolves better-sqlite3 from server/node_modules.
    const child = spawn(process.execPath, [WATCHER_SCRIPT], {
      cwd: SERVER_DIR,
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    child.stdout?.pipe(out);
    child.stderr?.pipe(out);
    child.on("exit", () => { if (watcher === child) watcher = null; });
    watcher = child;
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export function stopWatcher(): void {
  if (!watcher) return;
  try {
    if (process.platform === "win32") spawn("taskkill", ["/PID", String(watcher.pid), "/T", "/F"], { windowsHide: true });
    else watcher.kill("SIGTERM");
  } catch { /* already gone */ }
  watcher = null;
}

// kill everything the TUI launched (call on app exit)
export function killAllManaged(): void {
  for (const m of managed.values()) killChild(m);
  managed.clear();
  stopWatcher();
}

export { LOG_DIR, SERVER_DIR };
