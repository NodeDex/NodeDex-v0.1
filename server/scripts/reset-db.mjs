/**
 * Wipe all graph data from the database. Disables FK checks to allow block deletion.
 */

import Database from "better-sqlite3";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(__dirname, "..", "..", "data", "workspace.db");

const db = new Database(DB_PATH);

db.pragma("foreign_keys = OFF");

// Show all tables
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(r => r.name);
console.log("Tables found:", tables.join(", "));

let total = 0;
for (const table of tables) {
  if (table.startsWith("sqlite_")) continue;
  const { changes } = db.prepare(`DELETE FROM ${table}`).run();
  console.log(`  ${table}: deleted ${changes} rows`);
  total += changes;
}

db.pragma("foreign_keys = ON");
db.close();
console.log(`\nDone — ${total} rows deleted. Database is empty.`);
