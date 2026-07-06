// model-caps-probe.ts — auto-learn a model's output ceiling from the provider catalog.
//
// WHY (2026-07-06 hy3 incident): a model set OUTSIDE the web-UI picker (config.json,
// admin POST, raw env) gets no caps entry, so modelOutputCeiling falls back to the
// conservative default — and a reasoning-heavy model whose thinking tokens bill inside
// max_tokens then truncates every structured pass (COMPREHEND failed for an hour at
// $0 output). The metadata that prevents this is one FREE catalog call away
// (OpenRouter /models declares top_provider.max_completion_tokens) but only the
// web-UI picker consumed it. This module wires the probe into the model-SET paths:
// probe → remember (NODEDEX_MODEL_CAPS in process.env now, .env for next boot).
//
// Scope + safety:
//   - OpenRouter catalogs only (the one middle-platform catalog the server targets);
//     other base URLs (local ollama, direct OpenAI) skip quietly — KNOWN_CAPS or the
//     default cover those.
//   - Never overwrites an existing entry (user-set override or KNOWN_CAPS wins).
//   - Never throws, never blocks: callers fire-and-forget; a failed probe just leaves
//     the conservative default (and the truncation-bump retry) in place.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname } from "path";
import { capOverrides, hasCapEntry } from "./model-caps.js";
import { resolveEnvWriteTarget, serializeEnvFile } from "../../home-env.js";

const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";

export interface ProbeOpts {
  baseUrl?: string;          // default: process.env.OPENAI_BASE_URL
  apiKey?: string;           // default: OPENROUTER_API_KEY / OPENAI_API_KEY
  fetchImpl?: typeof fetch;  // injectable for tests
  envPath?: string;          // default: resolveEnvWriteTarget()
}

export interface ProbeResult { applied: boolean; cap?: number; reason: string }

/** The catalog's declared output ceiling for `model` (top_provider.max_completion_tokens),
 *  or null when the base URL isn't OpenRouter / the model isn't listed / no ceiling is
 *  declared. NOTE: context_length is the whole input+output window, NOT the output cap —
 *  never fall back to it here. */
export async function probeCatalogCap(model: string, opts: ProbeOpts = {}): Promise<number | null> {
  const base = opts.baseUrl ?? process.env.OPENAI_BASE_URL ?? "";
  if (!/openrouter\.ai/i.test(base)) return null;
  const f = opts.fetchImpl ?? fetch;
  const key = opts.apiKey ?? process.env.OPENROUTER_API_KEY ?? process.env.OPENAI_API_KEY ?? "";
  const r = await f(OPENROUTER_MODELS_URL, {
    headers: key ? { Authorization: `Bearer ${key}` } : {},
  });
  if (!r.ok) return null;
  const j: any = await r.json();
  const entry = (Array.isArray(j?.data) ? j.data : []).find((m: any) => m?.id === model);
  const cap = entry?.top_provider?.max_completion_tokens;
  return typeof cap === "number" && cap > 0 ? Math.floor(cap) : null;
}

/** Ensure `model` has a caps entry: skip when one exists, else probe the catalog and
 *  REMEMBER the declared ceiling in NODEDEX_MODEL_CAPS — applied to process.env
 *  immediately (model-caps.ts reads it fresh per call, so in-flight retries benefit)
 *  and persisted to the .env write target for the next boot. */
export async function ensureModelCap(model: string | undefined, opts: ProbeOpts = {}): Promise<ProbeResult> {
  if (!model) return { applied: false, reason: "no model set" };
  if (hasCapEntry(model)) return { applied: false, reason: "cap already known" };

  let cap: number | null = null;
  try { cap = await probeCatalogCap(model, opts); } catch { cap = null; }
  if (cap === null) return { applied: false, reason: "catalog has no ceiling for this model" };

  const json = JSON.stringify({ ...capOverrides(), [model]: cap });
  process.env.NODEDEX_MODEL_CAPS = json;
  try {
    const envPath = opts.envPath ?? resolveEnvWriteTarget();
    const original = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
    mkdirSync(dirname(envPath), { recursive: true });
    writeFileSync(envPath, serializeEnvFile(original, { NODEDEX_MODEL_CAPS: json }));
  } catch { /* in-memory cap still applies this run; next boot just re-probes */ }
  console.log(`[model-caps] probed ${model} → output ceiling ${cap} (provider catalog) — remembered in NODEDEX_MODEL_CAPS`);
  return { applied: true, cap, reason: "probed" };
}
