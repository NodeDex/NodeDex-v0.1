// store/backup.ts — ops gap 3: consistent, scheduled DB backups.
//
// Two fixes over the old inline /api/admin/backup (which fs.copyFileSync'd the
// live DB directly):
//   1. CONSISTENCY: checkpoint (TRUNCATE) folds the WAL into the main file FIRST,
//      so the copy is a complete snapshot. A raw copy of a WAL DB misses the
//      uncommitted-to-main pages sitting in the -wal file.
//   2. ENCRYPTION-SAFE: a byte copy preserves the on-disk bytes — so an encrypted
//      DB's backup stays encrypted. SQLite's online .backup() API would copy the
//      DECRYPTED pages into an unkeyed file = a plaintext leak of an encrypted DB.
//
// Shared by the manual endpoint and the scheduled timer. Backups land in
// <db-dir>/backups/workspace-<ts>.db, rotated to the most recent `keep`.

import fs from "fs";
import path from "path";
import type { WorkspaceDB } from "./database.js";

export interface BackupResult {
  backed_up?: string;
  skipped?: boolean;
  reason?: string;
  kept: number;
}

const BACKUP_RE = /^workspace-.*\.db$/;

export function performBackup(db: WorkspaceDB, opts: { throttleMs?: number; keep?: number } = {}): BackupResult {
  const keep = opts.keep ?? 5;
  const throttleMs = opts.throttleMs ?? 0;
  const dbPath = db.dbPath;
  if (!dbPath || !fs.existsSync(dbPath)) throw new Error("DB path not found");

  const backupDir = path.join(path.dirname(dbPath), "backups");
  if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });

  const existing = fs.readdirSync(backupDir).filter((f) => BACKUP_RE.test(f)).sort();
  if (throttleMs > 0 && existing.length > 0) {
    const lastMs = fs.statSync(path.join(backupDir, existing[existing.length - 1])).mtimeMs;
    if (Date.now() - lastMs < throttleMs) {
      return { skipped: true, reason: `last backup < ${Math.round(throttleMs / 60000)}m ago`, kept: existing.length };
    }
  }

  // checkpoint THEN copy — consistent + encryption-preserving (see header).
  try { db.rawDb.pragma("wal_checkpoint(TRUNCATE)"); } catch { /* best-effort; copy still proceeds */ }
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const dest = path.join(backupDir, `workspace-${ts}.db`);
  fs.copyFileSync(dbPath, dest);

  const all = fs.readdirSync(backupDir).filter((f) => BACKUP_RE.test(f)).sort();
  if (all.length > keep) {
    for (const f of all.slice(0, all.length - keep)) {
      try { fs.unlinkSync(path.join(backupDir, f)); } catch { /* ignore */ }
    }
  }
  return { backed_up: dest, kept: Math.min(all.length, keep) };
}

// ─── Scheduled backups ─────────────────────────────────────────────────────────
// DEFAULT ON — unlike the LLM-spending timers (which default OFF for cost),
// backups are $0 and protective; the worst outcome for a memory tool is losing
// the graph. Disable with NODEDEX_BACKUP_ENABLED=0; interval via
// NODEDEX_BACKUP_INTERVAL_MS (default 6h). Keeps the 5 most recent.

let _handle: ReturnType<typeof setInterval> | null = null;

function backupEnabled(): boolean {
  const v = (process.env.NODEDEX_BACKUP_ENABLED ?? "on").toLowerCase();
  return v !== "0" && v !== "off" && v !== "false";
}

function backupIntervalMs(): number {
  const v = parseInt(process.env.NODEDEX_BACKUP_INTERVAL_MS ?? "", 10);
  return Number.isFinite(v) && v > 0 ? v : 6 * 60 * 60 * 1000; // 6h
}

export function startBackupTimer(db: WorkspaceDB): boolean {
  if (!backupEnabled()) {
    console.log("[backup] disabled (set NODEDEX_BACKUP_ENABLED=on to enable)");
    return false;
  }
  if (_handle !== null) return false;
  const interval = backupIntervalMs();
  console.log(`[backup] scheduled every ${Math.round(interval / 3600000)}h, keeping 5 in data/backups/ (NODEDEX_BACKUP_ENABLED=0 to disable)`);
  _handle = setInterval(() => {
    try {
      const r = performBackup(db, { throttleMs: Math.floor(interval / 2), keep: 5 });
      if (r.backed_up) console.log(`[backup] wrote ${path.basename(r.backed_up)} (kept ${r.kept})`);
    } catch (e: any) {
      console.warn(`[backup] failed: ${e?.message ?? e}`);
    }
  }, interval);
  if (typeof _handle.unref === "function") _handle.unref();
  return true;
}

export function stopBackupTimer(): void {
  if (_handle !== null) { clearInterval(_handle); _handle = null; }
}
