#!/usr/bin/env node
// scripts/db-encryption.mjs — security slice 2 migration: encrypt or decrypt a
// Nodedex SQLite DB in place, with a timestamped backup of the original.
//
//   NODEDEX_DB_ENCRYPTION_KEY=... node scripts/db-encryption.mjs encrypt <db-path>
//   NODEDEX_DB_ENCRYPTION_KEY=... node scripts/db-encryption.mjs decrypt <db-path>
//
// encrypt: a plaintext DB → encrypted (then set the SAME key in .env so the server
//          opens it). decrypt: an encrypted DB → plaintext.
// Uses `PRAGMA rekey` (better-sqlite3-multiple-ciphers, aliased as better-sqlite3),
// which re-encrypts every page IN PLACE with the default cipher — the same cipher
// the server's `PRAGMA key` open uses, so the result round-trips. The original is
// COPIED to <path>.pre-<cmd>-<ts> first so you can roll back.

import Database from "better-sqlite3";
import fs from "fs";

const key = process.env.NODEDEX_DB_ENCRYPTION_KEY;
const [, , cmd, dbPath] = process.argv;

function fail(msg) { console.error("ERROR: " + msg); process.exit(1); }

if (!key) fail("set NODEDEX_DB_ENCRYPTION_KEY");
if (cmd !== "encrypt" && cmd !== "decrypt") fail("usage: db-encryption.mjs <encrypt|decrypt> <db-path>");
if (!dbPath || !fs.existsSync(dbPath)) fail(`db not found: ${dbPath}`);

const esc = key.replace(/'/g, "''");

// 1. open, verify the source state, fold any WAL into the main image, close.
{
  const db = new Database(dbPath);
  if (cmd === "decrypt") db.pragma(`key = '${esc}'`); // source is encrypted
  try {
    db.prepare("SELECT count(*) FROM sqlite_master").get();
  } catch {
    fail(cmd === "decrypt"
      ? "could not open the encrypted DB with this key (wrong key?)"
      : "source is not a readable plaintext DB — already encrypted? use decrypt");
  }
  db.pragma("wal_checkpoint(TRUNCATE)");
  db.pragma("journal_mode = DELETE"); // rekey rewrites pages; avoid WAL during the rewrite
  db.close();
}

// 2. back up the (now consistent, WAL-folded) main file.
const backup = `${dbPath}.pre-${cmd}-${Date.now()}`;
fs.copyFileSync(dbPath, backup);
for (const ext of ["-wal", "-shm"]) { const f = dbPath + ext; if (fs.existsSync(f)) try { fs.unlinkSync(f); } catch {} }

// 3. reopen and rekey in place (encrypt → keyed; decrypt → '' plaintext).
{
  const db = new Database(dbPath);
  if (cmd === "decrypt") db.pragma(`key = '${esc}'`);
  db.pragma(`rekey = '${cmd === "encrypt" ? esc : ""}'`);
  db.close();
}

console.log(`${cmd}ed: ${dbPath}`);
console.log(`  original backed up at: ${backup}`);
console.log(cmd === "encrypt"
  ? "  → set NODEDEX_DB_ENCRYPTION_KEY (same value) in .env so the server opens it."
  : "  → unset NODEDEX_DB_ENCRYPTION_KEY in .env (the DB is now plaintext).");
