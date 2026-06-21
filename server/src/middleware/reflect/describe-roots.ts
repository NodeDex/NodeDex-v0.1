// ═══════════════════════════════════════════════════════════════════════════════
// Recognition Layer — STEP 1: THE DESCRIBER (root description maintainer)
// ═══════════════════════════════════════════════════════════════════════════════
//
// Design: docs/PIPELINE-RECOGNITION-LAYER-DESIGN.md §3 + §6.
//
// JOB: give every project ROOT a SURFACE description — "what this project is
// about" = DOMAIN + OWNER, one line, signpost-not-textbook. This is the FUEL the
// recognizer (step 2, not built yet) compares new knowledge against. The
// recognizer only READS descriptions; the DESCRIBER is the sole maintainer
// (Rule 5 producer split — the only other writer is the create-path's initial
// essence). The recognizer NEVER writes descriptions.
//
// WHY a separate async worker (NOT folded into Stage AUDIT): AUDIT's contract is
// "no LLM, no mutate — flag only" (stage-audit-graph.ts). The describer DOES
// call the LLM and DOES write the root's essence, so it mirrors the flag-REVIEWER
// pattern (async LLM worker that mutates), not AUDIT. Default OFF
// (NODEDEX_DESCRIBER_ENABLED=on) so upgrading never silently starts LLM spend.
//
// LAZY (cost): only (re)describe a root when it's worth it — never described, OR
// grew by >= growthThreshold members since the last describe (tracked via
// content.last_described_member_count). Bounded per tick (maxRootsPerTick).
//
// Meaning-first: the description is the root's SCOPE identity (domain + owner) —
// NOT the leaf unique{} CLAIM identity. Surface only: the members ARE the
// contents; the description is a signpost, it does not enumerate them.

import type { WorkspaceDB, Block } from "../../store/database.js";
import { intFromEnv } from "./config.js";
import type { LLMProvider } from "../../engine/ai-provider.js";
import { getLLMProvider } from "../../engine/providers/index.js";
import { budgetTripped } from "./cost-guard.js";

// ─── Config (env-controlled; all have safe defaults) ────────────────────────────

function describerEnabled(): boolean {
  // Default ON (agent-facing root signposts — locked-on per release decision); set =off for dev/test.
  return (process.env.NODEDEX_DESCRIBER_ENABLED ?? "").toLowerCase() !== "off";
}
function describerIntervalMs(): number {
  return intFromEnv("NODEDEX_DESCRIBER_INTERVAL_MS", 1_800_000); // 30 min (slow background)
}
function minMembers(): number {
  return intFromEnv("NODEDEX_DESCRIBER_MIN_MEMBERS", 2); // a 1-member root has no real "domain" yet
}
function growthThreshold(): number {
  return intFromEnv("NODEDEX_DESCRIBER_GROWTH", 5); // re-describe after +5 members
}
function maxRootsPerTick(): number {
  return intFromEnv("NODEDEX_DESCRIBER_MAX_PER_TICK", 3); // bound LLM calls per tick
}
function maxMembersInPrompt(): number {
  return intFromEnv("NODEDEX_DESCRIBER_MAX_MEMBERS_IN_PROMPT", 40); // bound input tokens
}

// ─── Pure selection (no DB, no LLM — unit-testable) ─────────────────────────────

export interface RootDescribeInput {
  root: Block;
  memberCount: number;
  /** content.last_described_member_count; null = never described. */
  lastDescribedCount: number | null;
}

/** Returns the reason a root needs (re)describing, or false. Pure. */
export function rootNeedsDescription(
  inp: { memberCount: number; lastDescribedCount: number | null },
  opts: { minMembers: number; growthThreshold: number },
): false | "never" | "grew" {
  if (inp.memberCount < opts.minMembers) return false;
  if (inp.lastDescribedCount === null) return "never";
  if (inp.memberCount - inp.lastDescribedCount >= opts.growthThreshold) return "grew";
  return false;
}

export function selectRootsNeedingDescription(
  inputs: RootDescribeInput[],
  opts: { minMembers: number; growthThreshold: number },
): Array<RootDescribeInput & { reason: "never" | "grew" }> {
  const out: Array<RootDescribeInput & { reason: "never" | "grew" }> = [];
  for (const inp of inputs) {
    const r = rootNeedsDescription(inp, opts);
    if (r) out.push({ ...inp, reason: r });
  }
  return out;
}

// ─── Prompt + schema ────────────────────────────────────────────────────────────

export const DESCRIBE_ROOT_PROMPT = `You are writing a one-line SURFACE description of a project root in a knowledge graph.
Its ONLY job: let a later step decide "does a new piece of knowledge belong in THIS project?"

Capture TWO things in one line:
  1. DOMAIN — what this project is about (the topic).
  2. OWNER / SCOPE — whose it is (a client/customer name, a system name, or "personal")
     IF the members reveal one. Omit only if genuinely unknown.

RULES:
  - SIGNPOST, not table-of-contents. Do NOT list the individual members/decisions/facts.
  - Surface only. ONE line, <= 140 characters.
  - Base it ONLY on the MEMBERS shown. Never invent a domain or owner the members don't evidence.
  - Plain language. No label syntax, no underscores.`;

const DESCRIBE_ROOT_SCHEMA = {
  type: "object",
  properties: { description: { type: "string" } },
  required: ["description"],
};

export function buildDescribeInput(root: Block, members: Block[], cap: number): string {
  const head =
    `PROJECT ROOT label: ${root.label}\n` +
    `Current description (may be stale/generic): "${root.essence ?? ""}"\n\n` +
    `MEMBERS (${members.length} total${members.length > cap ? `, showing ${cap}` : ""}):`;
  const lines = members.slice(0, cap).map((m) => {
    let concepts: string[] = [];
    try {
      const p = JSON.parse((m.concepts as string) ?? "[]");
      if (Array.isArray(p)) concepts = p;
    } catch { /* tolerate */ }
    const c = concepts.length ? ` (${concepts.slice(0, 6).join(", ")})` : "";
    return `- [${m.type}] ${m.essence ?? ""}${c}`;
  });
  return `${head}\n${lines.join("\n")}`;
}

// ─── LLM describe (one root) ────────────────────────────────────────────────────

export async function describeRoot(
  provider: LLMProvider,
  root: Block,
  members: Block[],
): Promise<{ description: string | null; rateLimited: boolean; usage?: { input?: number; thinking?: number; output?: number } }> {
  const userInput = buildDescribeInput(root, members, maxMembersInPrompt());
  const r = await provider.generateStructured<{ description: string }>(
    DESCRIBE_ROOT_PROMPT,
    userInput,
    DESCRIBE_ROOT_SCHEMA,
    { thinkingBudget: 512, maxOutputTokens: 512 },
  );
  const desc = r.result?.description?.trim();
  return {
    description: desc && desc.length > 0 ? desc : null,
    rateLimited: r.rateLimited,
    usage: r.usage,
  };
}

// ─── Tick orchestrator ──────────────────────────────────────────────────────────

export interface DescriberTickResult {
  roots_total: number;
  roots_needing: number;
  described: number;
  llm_calls: number;
  rate_limited: number;
  errors: number;
  wall_ms: number;
}

/**
 * One describer tick: find roots needing a (re)description, describe up to
 * `limit` of them, write essence + the lazy marker. Async (LLM). Bounded.
 */
export async function runDescriberTick(opts: {
  db: WorkspaceDB;
  provider: LLMProvider;
  limit?: number;
}): Promise<DescriberTickResult> {
  const t0 = Date.now();
  const result: DescriberTickResult = {
    roots_total: 0, roots_needing: 0, described: 0,
    llm_calls: 0, rate_limited: 0, errors: 0, wall_ms: 0,
  };
  const limit = opts.limit ?? maxRootsPerTick();

  let all: Block[];
  try {
    all = opts.db.getAllBlocks();
  } catch (e: any) {
    result.errors += 1;
    result.wall_ms = Date.now() - t0;
    console.warn(`[describer] getAllBlocks threw: ${e?.message ?? e}`);
    return result;
  }

  const roots = all.filter((b) => b.type === "project");
  result.roots_total = roots.length;

  // members grouped by their project_id (one pass)
  const membersByRoot = new Map<string, Block[]>();
  for (const b of all) {
    if (b.type === "project") continue;
    const pid = (b as any).project_id as string | null;
    if (!pid) continue;
    let arr = membersByRoot.get(pid);
    if (!arr) { arr = []; membersByRoot.set(pid, arr); }
    arr.push(b);
  }

  const inputs: RootDescribeInput[] = roots.map((root) => {
    let lastDescribedCount: number | null = null;
    try {
      const c = JSON.parse((root.content as string) ?? "{}");
      const v = c?.last_described_member_count;
      if (typeof v === "number" && Number.isFinite(v)) lastDescribedCount = v;
    } catch { /* tolerate */ }
    return { root, memberCount: membersByRoot.get(root.id)?.length ?? 0, lastDescribedCount };
  });

  const candidates = selectRootsNeedingDescription(inputs, {
    minMembers: minMembers(),
    growthThreshold: growthThreshold(),
  });
  result.roots_needing = candidates.length;

  for (const cand of candidates.slice(0, limit)) {
    const members = membersByRoot.get(cand.root.id) ?? [];
    if (members.length === 0) continue; // defensive (selection gates on minMembers>=1)
    try {
      result.llm_calls += 1;
      const { description, rateLimited } = await describeRoot(opts.provider, cand.root, members);
      if (rateLimited) { result.rate_limited += 1; continue; }
      if (!description) continue;

      // Merge the lazy marker into existing content; write essence + enriched_at.
      let content: Record<string, unknown> = {};
      try {
        const c = JSON.parse((cand.root.content as string) ?? "{}");
        if (c && typeof c === "object") content = c;
      } catch { /* tolerate */ }
      content.last_described_member_count = cand.memberCount;

      opts.db.updateBlock(
        cand.root.id,
        { essence: description, content, enriched_at: new Date().toISOString() },
        `describer: ${cand.reason} (members=${cand.memberCount})`,
        "describer",
      );
      result.described += 1;
    } catch (e: any) {
      result.errors += 1;
      console.warn(`[describer] root ${cand.root.label} threw: ${e?.message ?? e}`);
    }
  }

  result.wall_ms = Date.now() - t0;
  return result;
}

// ─── Timer wrapper (env-gated, default OFF — mirrors flag-reviewer-startup) ──────

let _handle: ReturnType<typeof setInterval> | null = null;
let _inFlight = false;

async function tick(db: WorkspaceDB): Promise<void> {
  if (_inFlight) {
    console.log("[describer] tick still running, skipping this interval");
    return;
  }
  _inFlight = true;
  try {
    // Cost breaker (production gap 2, Phase B): self-gate before spending.
    const budget = await budgetTripped();
    if (budget?.tripped) {
      console.warn(`[describer] tick skipped — cost breaker: ${budget.reason}`);
      return;
    }
    const provider = getLLMProvider();
    if (!provider.isAvailable()) {
      console.warn("[describer] provider unavailable — skipping tick");
      return;
    }
    const res = await runDescriberTick({ db, provider });
    if (res.described > 0 || res.errors > 0 || res.rate_limited > 0) {
      console.log(
        `[describer] tick: roots=${res.roots_total} needing=${res.roots_needing} ` +
        `described=${res.described} llm=${res.llm_calls} rate_limited=${res.rate_limited} ` +
        `errors=${res.errors} wall_ms=${res.wall_ms}`,
      );
    }
  } catch (e: any) {
    console.warn(`[describer] tick threw: ${e?.message ?? e}`);
  } finally {
    _inFlight = false;
  }
}

/** Start the describer timer. Idempotent; returns true if started. Default OFF. */
export function startDescriberTimer(db: WorkspaceDB): boolean {
  if (!describerEnabled()) {
    console.log("[describer] disabled (set NODEDEX_DESCRIBER_ENABLED=on to enable)");
    return false;
  }
  if (_handle !== null) return false;
  const intervalMs = describerIntervalMs();
  console.log(`[describer] starting: interval=${intervalMs}ms`);
  _handle = setInterval(() => {
    tick(db).catch((e) => console.warn(`[describer] interval tick rejected: ${e?.message ?? e}`));
  }, intervalMs);
  if (typeof _handle.unref === "function") _handle.unref();
  return true;
}

/** Stop the describer timer. Used on shutdown + by tests. */
export function stopDescriberTimer(): void {
  if (_handle !== null) {
    clearInterval(_handle);
    _handle = null;
  }
}

/** For tests only — reports whether the timer is currently running. */
export function _isDescriberTimerRunningForTests(): boolean {
  return _handle !== null;
}
