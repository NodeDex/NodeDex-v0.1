#!/usr/bin/env node
// reconfigure.mjs — change your provider / model / key after onboarding.
// Edits ~/.nodedex/config.json in place (the same file the onboarding wizard writes).
//
//   npm run reconfigure                                  # interactive: provider → model → key
//   npm run reconfigure -- --model openai/gpt-4o-mini    # keep provider, change model
//   npm run reconfigure -- --key sk-or-...               # openrouter key (validated)
//   npm run reconfigure -- --provider local --base-url http://localhost:11434/v1 --model llama3
import { homedir } from "node:os";
import { resolve } from "node:path";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import readline from "node:readline/promises";

const HOME = resolve(homedir(), ".nodedex");
const CONFIG = resolve(HOME, "config.json");
const OPENROUTER_BASE = "https://openrouter.ai/api/v1";
const DEFAULT_LOCAL_BASE = "http://localhost:11434/v1"; // Ollama; LM Studio = :1234/v1, vLLM = your host
const OR_MODELS = [
  "google/gemini-2.5-flash   (recommended — cheap + capable)",
  "openai/gpt-4o-mini        (cheap, reliable)",
  "openrouter/owl-alpha      (FREE — but trains on your prompts)",
];

const load = () => { try { return JSON.parse(readFileSync(CONFIG, "utf8")); } catch { return {}; } };
const mask = (k) => (k && k.length > 10 ? k.slice(0, 8) + "…" : k || "(none)");
const arg = (name) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; };

async function validateKey(key) {
  try {
    const r = await fetch(`${OPENROUTER_BASE}/key`, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(8000) });
    if (r.ok) return { ok: true };
    if (r.status === 401) return { ok: false, error: "key rejected (401)" };
    return { ok: false, error: `OpenRouter returned ${r.status}` };
  } catch (e) { return { ok: false, error: `couldn't reach OpenRouter (${e?.message ?? e})` }; }
}

// Inline mirror of scanLocalModels() in src/config.ts — kept here so this stays a zero-dep script.
async function scanLocal() {
  const get = async (url) => { try { const r = await fetch(url, { signal: AbortSignal.timeout(1500) }); return r.ok ? await r.json() : null; } catch { return null; } };
  const out = [];
  const tags = await get("http://localhost:11434/api/tags"); // Ollama
  for (const m of tags?.models ?? []) { const id = m?.name ?? m?.model; if (id) out.push({ baseUrl: DEFAULT_LOCAL_BASE, model: id, server: "Ollama" }); }
  for (const [port, server] of [[1234, "LM Studio"], [8000, "vLLM"]]) { // OpenAI /v1/models
    const ms = await get(`http://localhost:${port}/v1/models`);
    for (const m of ms?.data ?? []) { const id = m?.id; if (id) out.push({ baseUrl: `http://localhost:${port}/v1`, model: id, server }); }
  }
  const seen = new Set();
  return out.filter((o) => { const k = `${o.baseUrl}::${o.model}`; if (seen.has(k)) return false; seen.add(k); return true; });
}

function save(cfg) {
  if ((cfg.openrouter_key || (cfg.provider === "local" && cfg.base_url && cfg.model)) && cfg.onboarded === undefined) cfg.onboarded = true;
  try { mkdirSync(HOME, { recursive: true }); } catch { /* exists */ }
  writeFileSync(CONFIG, JSON.stringify(cfg, null, 2));
  console.log(`\nSaved → ${CONFIG}`);
  console.log(`  provider: ${cfg.provider}    model: ${cfg.model ?? "(default)"}${cfg.provider === "local" ? `    endpoint: ${cfg.base_url}` : `    key: ${mask(cfg.openrouter_key)}`}`);
  console.log("Re-launch your server to apply (TUI Servers tab: [x] stop, [l] launch). New runs pick up the change.");
}

async function applyKey(cfg, raw) {
  const k = (raw || "").trim();
  if (!/^sk-or-/.test(k) || k.length < 40) { console.log(`✗ "${mask(k)}" doesn't look like a full OpenRouter key (sk-or-…, ~73 chars) — re-paste the whole key. Key NOT changed.`); return; }
  process.stdout.write("verifying key… ");
  const v = await validateKey(k);
  if (!v.ok) console.log(`✗ ${v.error}. Key NOT changed.`);
  else { cfg.openrouter_key = k; cfg.provider = "openrouter"; console.log("✓ ok"); }
}

const cfg = load();
const curProvider = cfg.provider ?? "openrouter";
console.log(`\nNodedex config — ${CONFIG}`);
console.log(`  provider: ${curProvider}`);
console.log(`  model:    ${cfg.model ?? "(default: google/gemini-2.5-flash)"}`);
console.log(curProvider === "local" ? `  endpoint: ${cfg.base_url ?? DEFAULT_LOCAL_BASE}` : `  key:      ${mask(cfg.openrouter_key)}`);
console.log();

// ── Non-interactive (flags) ──────────────────────────────────────────────────
const fProvider = arg("--provider"), fModel = arg("--model"), fKey = arg("--key"), fBase = arg("--base-url");
if (fProvider || fModel || fKey || fBase) {
  const goLocal = fProvider === "local" || (curProvider === "local" && !fKey && fProvider !== "openrouter");
  if (goLocal) {
    cfg.provider = "local";
    if (fBase) cfg.base_url = fBase;
    if (!cfg.base_url) cfg.base_url = DEFAULT_LOCAL_BASE;
    if (fModel) cfg.model = fModel.trim();
  } else {
    if (fKey) await applyKey(cfg, fKey);
    else if (fProvider === "openrouter") cfg.provider = "openrouter";
    if (fModel) cfg.model = fModel.trim();
  }
  save(cfg);
  process.exit(0);
}

// ── Interactive: provider → model → key ──────────────────────────────────────
if (!process.stdin.isTTY) {
  console.log("Non-interactive shell — pass --provider / --model / --key / --base-url, or run in a terminal.");
  process.exit(1);
}
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => rl.question(q).then((s) => s.trim());

// 1) Provider FIRST
console.log("Provider:");
console.log("  [1] openrouter  — cloud, bring your own key (one platform, every model)");
console.log("  [2] local       — Ollama / LM Studio / vLLM, offline, $0, no key");
const provAns = await ask(`Choose [1/2] (blank = keep ${curProvider}): `);
const provider = provAns === "1" ? "openrouter" : provAns === "2" ? "local" : curProvider;

if (provider === "local") {
  cfg.provider = "local";
  console.log("\nScanning for local models (Ollama / LM Studio / vLLM)…");
  const found = await scanLocal();
  if (found.length) {
    found.forEach((f, i) => console.log(`  [${i + 1}] ${f.model}   ·  ${f.server}`));
    const pick = await ask(`Pick a model [1-${found.length}], 'm' = enter manually (blank = keep ${cfg.model ?? "—"}): `);
    const hit = found[Number(pick) - 1];
    if (hit) { cfg.model = hit.model; cfg.base_url = hit.baseUrl; }
    else if (pick.toLowerCase() === "m") {
      const base = await ask(`Endpoint (OpenAI-compatible, blank = ${cfg.base_url ?? DEFAULT_LOCAL_BASE}): `);
      const model = await ask(`Model id (blank = keep ${cfg.model ?? "—"}): `);
      if (base) cfg.base_url = base;
      if (model) cfg.model = model;
    }
    // blank → keep existing model + endpoint
  } else {
    console.log("  (none detected — start Ollama/LM Studio, or enter the endpoint manually)");
    const base = await ask(`Endpoint (OpenAI-compatible, blank = ${cfg.base_url ?? DEFAULT_LOCAL_BASE}): `);
    const model = await ask(`Model id (blank = keep ${cfg.model ?? "—"}): `);
    if (base) cfg.base_url = base;
    if (model) cfg.model = model;
  }
  if (!cfg.base_url) cfg.base_url = DEFAULT_LOCAL_BASE;
} else {
  cfg.provider = "openrouter";
  const key = await ask("OpenRouter API key (blank = keep): ");
  if (key) await applyKey(cfg, key);
  console.log("\nOpenRouter model slugs (vendor/model — only OpenRouter's own models use the openrouter/ prefix):");
  for (const m of OR_MODELS) console.log("  " + m);
  const model = await ask(`Model id (blank = keep ${cfg.model ?? "default"}): `);
  if (model) cfg.model = model;
}
rl.close();
save(cfg);
