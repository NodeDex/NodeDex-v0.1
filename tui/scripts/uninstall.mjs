#!/usr/bin/env node
// uninstall.mjs — remove Nodedex's local data + config (~/.nodedex). DESTRUCTIVE.
// Does NOT remove the code (delete the repo folder for that) or the Nodedex entry in
// your agent's MCP config (remove that on the host yourself). Run: npm run uninstall
import { homedir } from "node:os";
import { resolve } from "node:path";
import { existsSync, readdirSync, rmSync } from "node:fs";
import readline from "node:readline/promises";

const HOME = resolve(homedir(), ".nodedex");
if (!existsSync(HOME)) {
  console.log(`Nothing to remove — ${HOME} doesn't exist.`);
  process.exit(0);
}

let dbs = [];
try { dbs = readdirSync(HOME).filter((f) => f.endsWith(".db")); } catch { /* unreadable */ }

console.log(`\nThis will permanently DELETE:\n  ${HOME}\n`);
console.log("Including:");
console.log("  • your config + OpenRouter API key");
console.log(`  • ${dbs.length} knowledge-graph database(s): ${dbs.join(", ") || "(none)"}`);
console.log("  • server logs + reflect-pause state");
console.log("\nThis cannot be undone. It does NOT remove the code, or the Nodedex entry in");
console.log("your agent's MCP config — remove those yourself.\n");

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ans = (await rl.question('Type "delete" to confirm: ')).trim().toLowerCase();
rl.close();
if (ans !== "delete") {
  console.log("Aborted — nothing removed.");
  process.exit(0);
}

try {
  rmSync(HOME, { recursive: true, force: true });
} catch (e) {
  console.log(`\nFailed to remove ${HOME}: ${e?.message ?? e}`);
  console.log("A server may still be holding a database file. Stop all Nodedex servers, then re-run.");
  process.exit(1);
}

console.log(`\nRemoved ${HOME}.`);
console.log("Next steps (the parts we can't touch):");
console.log("  • remove the Nodedex MCP server from your agent host's config");
console.log("  • delete the repo folder to remove the code itself");
