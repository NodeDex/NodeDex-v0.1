// demo-graph.mjs — builds the bundled DEMO graph: a small, synthetic, believable
// project history (payments-API rate limiter) an agent can traverse in minute one.
//
// Why this exists: a fresh install's graph is EMPTY — the product's value
// compounds from real work, so day one shows nothing. `nodedex demo` serves this
// graph instead, so the first five minutes demonstrate what weeks look like.
//
// Deterministic + $0: seeded through the real store API (WorkspaceDB), no LLM.
// The story is fictional but structurally honest — every block type carries the
// same unique{} identity fields the pipeline writes, and the edges form the same
// chains (evidence → dead-ends → decisions → consequences, plus one supersede
// pair so "current truth" is demonstrable).
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

export async function buildDemoGraph(dbPath) {
  const storePath = resolve(here, "../dist/store/database.js");
  if (!existsSync(storePath)) {
    throw new Error("dist/store/database.js not found — build the server first (`npm run build` in server/).");
  }
  const { WorkspaceDB } = await import(pathToFileURL(storePath).href);
  const db = new WorkspaceDB(dbPath);
  await db.init();

  let relations = 0;
  const mk = (p) => db.createBlock({ status: "active", created_by: "demo_seed", ...p });
  const rel = (source_id, target_id, type) => { db.createRelation({ source_id, target_id, type, created_by: "demo_seed" }); relations += 1; };

  // ── Root ──────────────────────────────────────────────────────────────────────
  const root = mk({
    label: "ratelimiter", type: "project", ttl: "permanent",
    essence: "Rate limiter for the payments API — protect downstream services while holding the 50ms p99 latency SLA.",
    content: { unique: { scope: "payments API rate limiting", goal: "downstream protection within the latency budget" } },
    concepts: ["rate limiting", "payments api", "latency", "redis"],
  });

  // ── Constraints (externally imposed — cannot be overridden) ───────────────────
  const slaC = mk({
    label: "ratelimiter_constraint_p99-latency-sla", type: "constraint", ttl: "permanent", project_id: root.id,
    essence: "Product-imposed: every API response must stay under 50ms p99 — the limiter's own overhead budget is ~5ms.",
    content: { unique: { rule: "50ms p99 end-to-end; limiter overhead <= 5ms", imposed_by: "product SLA" } },
    concepts: ["latency", "sla", "p99", "overhead budget"],
    source_excerpt: "USER: whatever we pick, the SLA is 50ms p99 and that's not negotiable — the limiter gets maybe 5ms of that.",
  });
  const redisC = mk({
    label: "ratelimiter_constraint_shared-redis-only", type: "constraint", ttl: "permanent", project_id: root.id,
    essence: "Ops-imposed: no new infrastructure — the limiter must run against the existing shared Redis instance.",
    content: { unique: { rule: "existing shared Redis only; no new infra", imposed_by: "ops" } },
    concepts: ["redis", "infrastructure", "ops"],
    source_excerpt: "USER: ops said no new infra for this — we use the shared redis or nothing.",
  });

  // ── Facts (observed / measured) ───────────────────────────────────────────────
  const memF = mk({
    label: "ratelimiter_fact_sliding-log-memory-growth", type: "fact", ttl: "project", project_id: root.id,
    essence: "Benchmark: sliding-window-log stores one timestamp per request per key — 1M active keys reached 2.1GB and grew linearly with traffic.",
    content: { unique: { value: "sliding-window-log memory grows linearly: 1M keys = 2.1GB in the benchmark" } },
    concepts: ["sliding window log", "memory", "benchmark"],
    source_excerpt: "AGENT: the 1M-key benchmark just finished — the sliding log is at 2.1GB resident and still climbing linearly.",
  });
  const rttF = mk({
    label: "ratelimiter_fact_redis-roundtrip-cost", type: "fact", ttl: "project", project_id: root.id,
    essence: "Measured: a Redis round-trip costs 3-4ms p99 from the API pods — two round-trips per request eats the entire limiter overhead budget.",
    content: { unique: { value: "Redis round-trip = 3-4ms p99 from API pods; 2 round-trips/request exceeds the 5ms budget" } },
    concepts: ["redis", "round-trip", "latency", "measurement"],
    source_excerpt: "AGENT: measured from the pods: redis round-trips are 3-4ms p99. Two of those per request and the whole 5ms budget is gone.",
  });
  const burstF = mk({
    label: "ratelimiter_fact_fixed-window-burst", type: "fact", ttl: "project", project_id: root.id,
    essence: "Fixed-window counters allow a 2x burst at window boundaries — clients can send double the limit around the reset tick.",
    content: { unique: { value: "fixed-window allows 2x burst at window boundaries" } },
    concepts: ["fixed window", "burst", "boundary"],
    source_excerpt: "AGENT: fixed windows have the boundary problem — a client can burst 2x the limit straddling the reset tick.",
  });
  const tbF = mk({
    label: "ratelimiter_fact_token-bucket-memory", type: "fact", ttl: "project", project_id: root.id,
    essence: "Token bucket needs only two numbers per key (token count, last-refill time) — O(1) memory regardless of traffic volume.",
    content: { unique: { value: "token bucket = O(1) memory: two numbers per key" } },
    concepts: ["token bucket", "memory", "o(1)"],
    source_excerpt: "AGENT: token bucket state is just (tokens, last_refill) per key — memory is flat no matter the traffic.",
  });

  // ── Dead ends (tried, resources committed, abandoned — with the why) ─────────
  const logDE = mk({
    label: "ratelimiter_dead-end_sliding-window-log", type: "dead_end", ttl: "permanent", project_id: root.id,
    essence: "Sliding window log — tried first for exact per-request fairness; abandoned after the memory benchmark, and per-request timestamp pruning added ~7ms p99 on top.",
    content: { unique: { approach: "sliding window log (timestamp per request per key)", why_abandoned: "linear memory growth (2.1GB at 1M keys) + ~7ms p99 pruning cost — breaks both the memory and latency budgets" } },
    concepts: ["sliding window log", "memory growth", "abandoned"],
    source_excerpt: "AGENT: killing the sliding log branch — the benchmark numbers make it unshippable at our key cardinality.",
  });
  const redisDE = mk({
    label: "ratelimiter_dead-end_per-request-redis-counters", type: "dead_end", ttl: "permanent", project_id: root.id,
    essence: "Synchronous Redis INCR per request — abandoned: two round-trips per request blew the 5ms overhead budget before any limiter logic ran.",
    content: { unique: { approach: "synchronous Redis counter check+increment per request", why_abandoned: "2 round-trips x 3-4ms p99 exceeds the entire 5ms overhead budget" } },
    concepts: ["redis", "synchronous counters", "abandoned", "latency"],
    source_excerpt: "AGENT: sync redis counters are out — the round-trip math alone breaks the budget, regardless of algorithm.",
  });

  // ── Decisions (chosen, with the why and what lost) ────────────────────────────
  const algoD = mk({
    label: "ratelimiter_decision_token-bucket-algorithm", type: "decision", ttl: "permanent", project_id: root.id,
    essence: "Token bucket chosen as the limiting algorithm: O(1) memory and constant-time refill math; accepts ~1% burst imprecision the SLA makes unpurchasable to remove anyway.",
    content: { unique: {
      choice: "token bucket algorithm",
      reason: "O(1) memory per key + constant-time math fits both the memory reality and the 5ms overhead budget",
      alternatives_rejected: "sliding window log (linear memory growth — see dead-end), fixed window (2x boundary bursts)",
    } },
    concepts: ["token bucket", "algorithm choice", "rate limiting"],
    source_excerpt: "USER: ok let's lock it in — token bucket it is, the imprecision is fine.",
  });
  const redisD = mk({
    label: "ratelimiter_decision_redis-synced-counters", type: "decision", ttl: "permanent", project_id: root.id,
    // No "SUPERSEDED:" text prefix on purpose — the supersedes EDGE is the currency
    // mechanism, and the demo must show the signal coming from structure, not from
    // an essence convention the real pipeline doesn't use.
    essence: "Keep bucket state in Redis, checked synchronously on each request — originally chosen for perfect cross-pod accuracy.",
    content: { unique: {
      choice: "bucket state in Redis, synchronous check per request",
      reason: "perfect cross-pod accuracy — every pod sees the same counter",
      alternatives_rejected: "per-pod local state (drift between pods)",
    } },
    concepts: ["redis", "shared state", "cross-pod accuracy"],
    source_excerpt: "USER: start with redis-backed buckets, accuracy first.",
  });
  const localD = mk({
    label: "ratelimiter_decision_local-buckets-async-sync", type: "decision", ttl: "permanent", project_id: root.id,
    essence: "In-process token buckets with async Redis reconciliation every 100ms — per-request cost becomes pure memory math; cross-pod drift stays bounded around 1%.",
    content: { unique: {
      choice: "in-process buckets + async Redis reconciliation (100ms)",
      reason: "removes Redis from the request path entirely (the measured round-trip cost was the budget-killer); reconciliation bounds drift to ~1%",
      alternatives_rejected: "synchronous Redis state (round-trip cost — see the dead-end and the superseded decision)",
    } },
    concepts: ["local buckets", "async reconciliation", "redis", "drift"],
    source_excerpt: "USER: agreed — local buckets with the async sync. 1% drift is a fine price for staying in budget.",
  });

  // ── Insight / open question / task ───────────────────────────────────────────
  const insight = mk({
    label: "ratelimiter_insight_sla-dominates-accuracy", type: "insight", ttl: "project", project_id: root.id,
    essence: "The latency SLA constrains the algorithm more than accuracy does: any precision that costs a Redis round-trip is unpurchasable — ~1% imprecision is simply the price of staying inside the budget.",
    content: { unique: { realization: "within this SLA, accuracy beyond ~1% cannot be bought — every mechanism that improves it spends latency we don't have" } },
    concepts: ["sla", "accuracy tradeoff", "latency budget"],
    source_excerpt: "AGENT: stepping back — every accuracy mechanism we priced spends the same currency (round-trips). The SLA, not fairness, is the real design constraint.",
  });
  const question = mk({
    label: "ratelimiter_question_multi-region-skew", type: "question", ttl: "project", project_id: root.id,
    essence: "Open: how should buckets reconcile across regions where clock skew exceeds 100ms? No approach chosen yet.",
    content: { unique: { question: "multi-region bucket reconciliation under >100ms clock skew — mechanism undecided" } },
    concepts: ["multi-region", "clock skew", "reconciliation"],
  });
  const task = mk({
    label: "ratelimiter_task_load-test-5k-rps", type: "task", ttl: "project", project_id: root.id,
    essence: "Load-test the local-bucket build at 5k rps before rollout — verify cross-pod drift stays under 1%.",
    content: { unique: { task: "5k rps load test; acceptance = drift < 1%", status: "open" } },
    concepts: ["load test", "drift", "rollout"],
  });

  // ── Edges: the chains that make blocks a story ────────────────────────────────
  for (const b of [slaC, redisC, memF, rttF, burstF, tbF, logDE, redisDE, algoD, redisD, localD, insight, question, task]) {
    rel(b.id, root.id, "part_of");
  }
  // Chain 1 — the algorithm arc: benchmark → dead-end → decision
  rel(logDE.id, memF.id, "based_on");
  rel(algoD.id, logDE.id, "triggered_by");
  rel(algoD.id, tbF.id, "based_on");
  rel(algoD.id, burstF.id, "based_on");
  rel(algoD.id, slaC.id, "based_on");
  // Chain 2 — the state arc: measurement → dead-end → superseding decision
  rel(redisDE.id, rttF.id, "based_on");
  rel(redisDE.id, slaC.id, "based_on");
  rel(redisD.id, redisC.id, "based_on");
  rel(localD.id, redisDE.id, "triggered_by");
  rel(localD.id, rttF.id, "based_on");
  rel(localD.id, redisD.id, "supersedes"); // current truth demo: old decision is STALE
  // Consequences
  rel(insight.id, rttF.id, "based_on");
  rel(insight.id, slaC.id, "based_on");
  rel(question.id, localD.id, "triggered_by");
  rel(task.id, localD.id, "triggered_by");

  const blocks = 15; // root + 14
  try { db.db?.close?.(); } catch { /* best-effort */ }
  return { blocks, relations };
}
