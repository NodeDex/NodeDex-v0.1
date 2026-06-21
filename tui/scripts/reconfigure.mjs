#!/usr/bin/env node
// reconfigure.mjs — change your OpenRouter API key or model after onboarding.
// Edits ~/.nodedex/config.json in place (the same file the onboarding wizard writes).
//
//   npm run reconfigure                              # interactive prompts
//   npm run reconfigure -- --model openai/gpt-4o-mini
//   npm run reconfigure -- --key sk-or-...           # validated before saving
import { homedir } from "node:os";
import { resolve } from "node:path";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import readline from "node:readline/promises";

const HOME = resolve(homedir(), ".nodedex");
const CONFIG = resolve(HOME, "config.json");
const OPENROUTER_BASE = "https://openrouter.ai/api/v1";
const MODELS = [
  "google/gemini-2.5-flash   (recommended — cheap + capable)",
  "openai/gpt-4o-mini        (cheap, reliable)",
  "openrouter/owl-alpha      (FREE — but trains on your prompts)",
];

const load = () => { try { return JSON.parse(readFileSync(CONFIG, "utf8")); } catch { return {}; } };
const mask = (k) => (k && k.length > 10 ? k.slice(0, 8) + "…" : k || "(none)");
const arg = (name) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; };

async function validateKey(key) {
  try {
    const r = await fetch(`${OPENROUTER_BASE}/key`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(8000),
    });
    if (r.ok) return { ok: true };
    if (r.status === 401) return { ok: false, error: "key rejected (401)" };
    return { ok: false, error: `OpenRouter returned ${r.status}` };
  } catch (e) {
    return { ok: false, error: `couldn't reach OpenRouter (${e?.message ?? e})` };
  }
}

const cfg = load();
console.log(`\nNodedex config — ${CONFIG}`);
console.log(`  provider: ${cfg.provider ?? "openrouter"}`);
console.log(`  model:    ${cfg.model ?? "(default: google/gemini-2.5-flash)"}`);
console.log(`  key:      ${mask(cfg.openrouter_key)}\n`);

let newKey = arg("--key");
let newModel = arg("--model");

// Interactive only when no flags were given AND we have a real terminal.
if (newKey === undefined && newModel === undefined) {
  if (!process.stdin.isTTY) {
    console.log("Non-interactive shell — pass --key <key> and/or --model <id>, or run in a terminal.");
    process.exit(1);
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  newKey = (await rl.question("New OpenRouter API key (blank = keep): ")).trim();
  console.log("\nOpenRouter model slugs (vendor/model — only OpenRouter's own models");
  console.log("use the openrouter/ prefix; everything else keeps its vendor's):");
  for (const m of MODELS) console.log("  " + m);
  newModel = (await rl.question(`New model id (blank = keep ${cfg.model ?? "default"}): `)).trim();
  rl.close();
}

if (newKey) {
  process.stdout.write("verifying key… ");
  const v = await validateKey(newKey.trim());
  if (!v.ok) console.log(`✗ ${v.error}. Key NOT changed.`);
  else { cfg.openrouter_key = newKey.trim(); cfg.provider = "openrouter"; console.log("✓ ok"); }
}
if (newModel) cfg.model = newModel.trim();

if (cfg.openrouter_key && cfg.onboarded === undefined) cfg.onboarded = true;
try { mkdirSync(HOME, { recursive: true }); } catch { /* exists */ }
writeFileSync(CONFIG, JSON.stringify(cfg, null, 2));

console.log(`\nSaved → ${CONFIG}`);
console.log("Re-launch your server to apply: in the TUI Servers tab press [x] stop then [l]");
console.log("launch (or restart the server). New runs pick up the new key/model.");
