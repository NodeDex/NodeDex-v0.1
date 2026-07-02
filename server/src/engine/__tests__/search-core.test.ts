/**
 * search-core tests — the shared three-signal scorer (MCP workspace_search +
 * REST /api/search rank identically through this).
 *
 * Pins the ranking principle: MATCH QUALITY ONLY. No popularity ranking
 * (access_count), no freshness decay, no usage penalty — the graph's
 * highest-value blocks (dead-ends) are old and rarely accessed by design.
 * Run: node --import=tsx/esm --test src/engine/__tests__/search-core.test.ts
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { WorkspaceDB } from "../../store/database.js";
import { searchBlocks, rootContextFor, allWeak } from "../search-core.js";
import type { SearchHit } from "../search-core.js";

const TEST_DB = path.resolve("/tmp/search_core_test.db");

let db: WorkspaceDB;

before(async () => {
  for (const s of ["", "-wal", "-shm"]) {
    if (fs.existsSync(TEST_DB + s)) fs.unlinkSync(TEST_DB + s);
  }
  db = new WorkspaceDB(TEST_DB);
  await db.init();
});

after(() => {
  try { (db as any)["db"]?.close(); } catch { /* ignore */ }
  for (const s of ["", "-wal", "-shm"]) {
    try { if (fs.existsSync(TEST_DB + s)) fs.unlinkSync(TEST_DB + s); } catch { /* ignore */ }
  }
});

describe("searchBlocks — match-quality ranking", () => {
  test("strong match beats popular weak match (no access_count ranking)", async () => {
    const strong = db.createBlock({
      label: "garden_dead-end_aphid-spray-failed",
      type: "dead_end",
      essence: "Aphid spray failed — neem oil burned the tomato leaves",
      content: { concepts: ["aphid-spray", "neem-oil", "tomato"] },
      ttl: "permanent",
    });
    const popular = db.createBlock({
      label: "garden_fact_watering-schedule",
      type: "fact",
      essence: "Watering twice a week; the spray bottle is under the sink",
      content: { concepts: ["watering"] },
      ttl: "permanent",
    });
    // Make the weak block "popular": many reads bump access_count. The OLD REST
    // path (ORDER BY access_count DESC) would rank it first on any shared term.
    for (let i = 0; i < 25; i++) db.getBlock(popular.id);

    const { hits } = await searchBlocks(db, undefined, { query: "aphid spray neem", limit: 5 });
    assert.ok(hits.length >= 2, "both blocks share the 'spray' term");
    assert.equal(hits[0]!.block.id, strong.id, "the actual match must outrank the popular block");
  });

  test("signals add: keyword+concept hit outranks keyword-only", async () => {
    db.createBlock({
      label: "forge_fact_jwt-mention",
      type: "fact",
      essence: "The doc mentions jwt once in passing",
      content: {},
      ttl: "permanent",
    });
    const both = db.createBlock({
      label: "forge_decision_jwt-hs256",
      type: "decision",
      essence: "Use HS256 jwt tokens for service auth",
      content: { concepts: ["jwt", "hs256", "auth-tokens"] },
      ttl: "permanent",
    });

    const { hits, signals } = await searchBlocks(db, undefined, { query: "jwt auth", limit: 5 });
    assert.equal(hits[0]!.block.id, both.id, "keyword+concept beats keyword-only");
    assert.ok(hits[0]!.matchTypes.some((t) => t.startsWith("concept(")), "concept match is explained");
    assert.equal(signals.semantic, false, "no embeddings passed → semantic signal reported off");
    assert.equal(signals.keyword, true);
  });

  test("type filter restricts hits", async () => {
    const { hits } = await searchBlocks(db, undefined, { query: "jwt", type: "decision", limit: 5 });
    assert.ok(hits.length > 0);
    assert.ok(hits.every((h) => h.block.type === "decision"));
  });

  test("no query tokens → empty, never throws", async () => {
    const { hits } = await searchBlocks(db, undefined, { query: "zzzz_nothing_matches_this", limit: 5 });
    assert.equal(hits.length, 0);
  });
});

describe("allWeak — the nearest-neighbor shrug detector", () => {
  const hit = (score: number, matchTypes: string[]): SearchHit =>
    ({ block: {} as any, score, matchTypes });

  test("all semantic-only sub-0.3 hits → weak (off-graph query signature)", () => {
    assert.equal(allWeak([hit(0.26, ["semantic"]), hit(0.26, ["semantic"])]), true);
  });

  test("one strong or multi-signal hit anywhere → not weak", () => {
    assert.equal(allWeak([hit(0.63, ["semantic", "keyword"]), hit(0.22, ["semantic"])]), false);
    assert.equal(allWeak([hit(0.45, ["semantic"])]), false, "high score alone disarms it");
    assert.equal(allWeak([hit(0.25, ["keyword"])]), false, "keyword match alone disarms it");
  });

  test("empty result set is not weak (it is simply empty)", () => {
    assert.equal(allWeak([]), false);
  });
});

describe("rootContextFor — containment attached to hits", () => {
  test("resolves project_id to root label + truncated essence, once per root", async () => {
    const root = db.createBlock({
      label: "garden",
      type: "project",
      essence: "Backyard vegetable garden project — pests, soil, and the greenhouse build. " + "x".repeat(60),
      content: {},
      ttl: "permanent",
    });
    const child = db.createBlock({
      label: "garden_fact_soil-ph",
      type: "fact",
      essence: "Soil pH is 6.2",
      content: {},
      ttl: "permanent",
    });
    db.updateBlock(child.id, { project_id: root.id });
    const fresh = db.getBlock(child.id)!;

    const ctx = rootContextFor(db, [fresh, fresh]); // duplicate input → single lookup
    assert.equal(ctx.size, 1);
    const rc = ctx.get(root.id)!;
    assert.equal(rc.root_label, "garden");
    assert.ok(rc.root_essence.endsWith("…"), "long root essence is truncated");
    assert.ok(rc.root_essence.length <= 101);
  });

  test("blocks without project_id or with dangling project_id are skipped", () => {
    const orphan = db.getBlock("forge_fact_jwt-mention")!;
    const ctx = rootContextFor(db, [orphan]);
    assert.equal(ctx.size, 0);
  });
});
