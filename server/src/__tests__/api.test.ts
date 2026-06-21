/**
 * WMCS API Layer Tests
 * Run: node --import=tsx/esm --test src/__tests__/api.test.ts
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { WorkspaceDB } from "../store/database.js";
import { startApiServer } from "../api-server.js";
import type { Server } from "http";

const TEST_DB = "/tmp/wmcs_api_test.db";
let db: WorkspaceDB;
let server: Server;
let baseUrl: string;
let readpathProjectId: string;
let readpathChildId: string;

before(async () => {
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  db = new WorkspaceDB(TEST_DB);
  await db.init();

  // Seed a few blocks for testing
  db.createBlock({ label: "api_test_fact", type: "fact", essence: "API test fact", content: { unique: { source: "test" } }, ttl: "permanent" });
  db.createBlock({ label: "api_test_decision", type: "decision", essence: "Use SQLite", content: {}, ttl: "permanent" });
  db.createBlock({ label: "api_test_task", type: "task", essence: "Build the thing", content: { unique: { status: "open", priority: "high" } }, ttl: "permanent" });

  // Read-path slice seeds: project hierarchy (root → sub-project → blocks), an archived
  // block, an orphan namespace (label-prefix but no root), and one relation.
  const proj = db.createBlock({ label: "readpath-proj", type: "project", essence: "Read-path test project", content: {}, ttl: "permanent" });
  readpathProjectId = proj.id;
  const sub = db.createBlock({ label: "readpath-proj_sub", type: "project", essence: "Sub project", content: {}, ttl: "permanent" });
  db.updateBlock(sub.id, { project_id: proj.id });
  const child = db.createBlock({ label: "readpath-proj_fact_child-one", type: "fact", essence: "Child fact", content: { unique: { value: "42" } }, ttl: "permanent" });
  db.updateBlock(child.id, { project_id: proj.id });
  readpathChildId = child.id;
  // Lives under the SUB-project and does NOT share the root's label prefix —
  // only reachable through the project_id descendant scope.
  const subChild = db.createBlock({ label: "subspace_fact_under-sub", type: "fact", essence: "Fact under sub-project", content: {}, ttl: "permanent" });
  db.updateBlock(subChild.id, { project_id: sub.id });
  const archived = db.createBlock({ label: "readpath-proj_fact_archived-one", type: "fact", essence: "Archived fact", content: {}, ttl: "permanent" });
  db.updateBlock(archived.id, { project_id: proj.id });
  db.archiveBlock(archived.id, "test");
  db.createBlock({ label: "orphanspace_fact_no-root", type: "fact", essence: "Orphan namespace fact", content: {}, ttl: "permanent" });
  db.createRelation({ source_id: child.id, target_id: subChild.id, type: "based_on" });

  // Start on random port (0 = OS assigns)
  server = startApiServer(db, undefined, 0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const addr = server.address() as { port: number };
  baseUrl = `http://localhost:${addr.port}`;
});

after(() => {
  server.close();
  try { (db as any)["db"]?.close(); } catch { /* ignore */ }
  try { if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB); } catch { /* ignore */ }
  try { if (fs.existsSync(TEST_DB + "-wal")) fs.unlinkSync(TEST_DB + "-wal"); } catch { /* ignore */ }
});

// ─── Health ──────────────────────────────────────────────────────

describe("GET /api/health", () => {
  test("returns overall status", async () => {
    const res = await fetch(`${baseUrl}/api/health`);
    assert.equal(res.status, 200);
    const data = await res.json() as any;
    assert.ok("overall" in data, "Should have overall field");
    assert.ok(["ok", "degraded", "error"].includes(data.overall), "Status should be valid value");
  });
});

describe("cost display endpoints", () => {
  test("GET /api/usage/passes returns a per-pass cost shape", async () => {
    const res = await fetch(`${baseUrl}/api/usage/passes`);
    assert.equal(res.status, 200);
    const data = await res.json() as any;
    assert.ok(Array.isArray(data.passes), "passes is an array");
    assert.ok("total_usd" in data, "has total_usd");
    assert.ok("turn" in data, "has turn");
  });

  test("GET /api/usage/budget returns a verdict shape", async () => {
    const res = await fetch(`${baseUrl}/api/usage/budget`);
    assert.equal(res.status, 200);
    const data = await res.json() as any;
    assert.equal(typeof data.tripped, "boolean", "tripped is boolean");
    assert.ok(data.config && "minCreditUsd" in data.config, "has config.minCreditUsd");
    assert.ok(data.observed, "has observed");
  });
});

// ─── Stats ───────────────────────────────────────────────────────

describe("GET /api/stats", () => {
  test("returns block counts", async () => {
    const res = await fetch(`${baseUrl}/api/stats`);
    assert.equal(res.status, 200);
    const data = await res.json() as any;
    assert.ok(typeof data.total_blocks === "number", "Should have total_blocks");
    assert.ok(data.total_blocks >= 3, "Should have at least our 3 seeded blocks");
  });
});

// ─── Blocks ──────────────────────────────────────────────────────

describe("GET /api/blocks", () => {
  test("returns list of blocks", async () => {
    const res = await fetch(`${baseUrl}/api/blocks`);
    assert.equal(res.status, 200);
    const data = await res.json() as any[];
    assert.ok(Array.isArray(data), "Should be an array");
    assert.ok(data.length >= 3, "Should include seeded blocks");
  });

  test("filters by type", async () => {
    const res = await fetch(`${baseUrl}/api/blocks?type=fact`);
    assert.equal(res.status, 200);
    const data = await res.json() as any[];
    assert.ok(data.every((b: any) => b.type === "fact"), "All returned blocks should be facts");
  });
});

describe("GET /api/blocks/:id", () => {
  test("returns full block detail by label", async () => {
    const res = await fetch(`${baseUrl}/api/blocks/api_test_fact`);
    assert.equal(res.status, 200);
    const data = await res.json() as any;
    assert.equal(data.label, "api_test_fact");
    assert.equal(data.type, "fact");
    assert.ok("outgoing" in data, "Should have outgoing relations");
    assert.ok("incoming" in data, "Should have incoming relations");
  });

  test("returns 404 for unknown block", async () => {
    const res = await fetch(`${baseUrl}/api/blocks/this_does_not_exist_xyz`);
    assert.equal(res.status, 404);
  });
});

// ─── Read-path slice: list filters ───────────────────────────────

describe("GET /api/blocks — project filter resolution", () => {
  test("project= accepts the project ID and returns the same set as the label", async () => {
    const byId = await (await fetch(`${baseUrl}/api/blocks?project=${readpathProjectId}`)).json() as any[];
    const byLabel = await (await fetch(`${baseUrl}/api/blocks?project=readpath-proj`)).json() as any[];
    const idLabels = byId.map((b) => b.label).sort();
    const labelLabels = byLabel.map((b) => b.label).sort();
    assert.deepEqual(idLabels, labelLabels, "ID form and label form must return the same blocks");
    assert.ok(idLabels.includes("readpath-proj_fact_child-one"), "Should include the child block");
  });

  test("project scope includes sub-project blocks that don't share the label prefix", async () => {
    const data = await (await fetch(`${baseUrl}/api/blocks?project=readpath-proj`)).json() as any[];
    assert.ok(data.some((b) => b.label === "subspace_fact_under-sub"),
      "Block under the sub-project must be reachable via the project_id descendant scope");
  });

  test("unknown project fails loud with known_projects", async () => {
    const res = await fetch(`${baseUrl}/api/blocks?project=blk_does_not_exist`);
    assert.equal(res.status, 404);
    const data = await res.json() as any;
    assert.ok(Array.isArray(data.known_projects), "404 body should list known projects");
    assert.ok(data.known_projects.some((p: any) => p.label === "readpath-proj"));
  });

  test("orphan namespace (label prefix, no project root) still returns its blocks", async () => {
    const data = await (await fetch(`${baseUrl}/api/blocks?project=orphanspace`)).json() as any[];
    assert.ok(data.some((b) => b.label === "orphanspace_fact_no-root"));
  });
});

describe("GET /api/blocks — limit, label, archived status", () => {
  test("limit caps the result count", async () => {
    const data = await (await fetch(`${baseUrl}/api/blocks?limit=2`)).json() as any[];
    assert.equal(data.length, 2);
  });

  test("invalid limit fails loud", async () => {
    const res = await fetch(`${baseUrl}/api/blocks?limit=abc`);
    assert.equal(res.status, 400);
  });

  test("label= is an exact-match filter", async () => {
    const data = await (await fetch(`${baseUrl}/api/blocks?label=readpath-proj_fact_child-one`)).json() as any[];
    assert.equal(data.length, 1);
    assert.equal(data[0].label, "readpath-proj_fact_child-one");
  });

  test("status=archived returns archived blocks (excluded from the default list)", async () => {
    const archivedList = await (await fetch(`${baseUrl}/api/blocks?status=archived`)).json() as any[];
    assert.ok(archivedList.some((b) => b.label === "readpath-proj_fact_archived-one"), "Archived block should be listable");
    const defaultList = await (await fetch(`${baseUrl}/api/blocks`)).json() as any[];
    assert.ok(!defaultList.some((b) => b.label === "readpath-proj_fact_archived-one"), "Default list must exclude archived");
  });
});

describe("GET /api/blocks — detail levels (list)", () => {
  test("detail=surface returns compact rows", async () => {
    const data = await (await fetch(`${baseUrl}/api/blocks?project=readpath-proj&detail=surface`)).json() as any[];
    assert.ok(data.length > 0);
    for (const b of data) {
      assert.ok("label" in b && "essence" in b && "type" in b, "Surface keeps the signal fields");
      assert.ok(!("access_count" in b), "Surface drops bookkeeping fields");
      assert.ok(!("content" in b), "Surface drops the content body");
    }
  });

  test("detail=content adds unique{}", async () => {
    const data = await (await fetch(`${baseUrl}/api/blocks?label=readpath-proj_fact_child-one&detail=content`)).json() as any[];
    assert.equal(data.length, 1);
    assert.equal(data[0].unique?.value, "42");
    assert.ok(!("access_count" in data[0]));
  });

  test("invalid detail fails loud", async () => {
    const res = await fetch(`${baseUrl}/api/blocks?detail=everything`);
    assert.equal(res.status, 400);
  });
});

// ─── Read-path slice: single-block detail levels ─────────────────

describe("GET /api/blocks/:id?detail=", () => {
  test("surface omits relations and bookkeeping", async () => {
    const data = await (await fetch(`${baseUrl}/api/blocks/readpath-proj_fact_child-one?detail=surface`)).json() as any;
    assert.equal(data.detail_level, "surface");
    assert.equal(data.essence, "Child fact");
    assert.ok(!("outgoing" in data), "Surface has no relations");
    assert.ok(!("staleness_score" in data), "Surface skips derived metadata");
    assert.ok(!("access_count" in data), "Surface drops bookkeeping");
  });

  test("content adds unique{}", async () => {
    const data = await (await fetch(`${baseUrl}/api/blocks/readpath-proj_fact_child-one?detail=content`)).json() as any;
    assert.equal(data.detail_level, "content");
    assert.equal(data.unique?.value, "42");
  });

  test("relations returns compact typed edges", async () => {
    const data = await (await fetch(`${baseUrl}/api/blocks/${readpathChildId}?detail=relations`)).json() as any;
    assert.equal(data.detail_level, "relations");
    assert.ok(Array.isArray(data.outgoing) && Array.isArray(data.incoming));
    const edge = data.outgoing.find((r: any) => r.type === "based_on");
    assert.ok(edge, "Should expose the seeded based_on edge");
    assert.equal(edge.target_label, "subspace_fact_under-sub");
    assert.ok(!("staleness_score" in data), "Relations view skips the conflicts/staleness computation");
  });

  test("default (no detail param) keeps the full legacy shape", async () => {
    const data = await (await fetch(`${baseUrl}/api/blocks/readpath-proj_fact_child-one`)).json() as any;
    assert.ok("outgoing" in data && "incoming" in data && "staleness_score" in data,
      "Existing consumers depend on the full shape staying default");
  });

  test("invalid detail fails loud", async () => {
    const res = await fetch(`${baseUrl}/api/blocks/readpath-proj_fact_child-one?detail=huge`);
    assert.equal(res.status, 400);
  });
});

// ─── Read-path slice step 3: cross-root entanglement at orient ───

describe("GET /api/tree — related_roots", () => {
  test("tree response carries meaning-classified cross-root pairs", async () => {
    const data = await (await fetch(`${baseUrl}/api/tree?depth=1`)).json() as any;
    assert.ok(Array.isArray(data.related_roots), "tree should include related_roots");
    const pair = data.related_roots.find((p: any) =>
      [p.root_a, p.root_b].includes("readpath-proj") &&
      [p.root_a, p.root_b].includes("readpath-proj_sub"));
    assert.ok(pair, "seeded cross-root based_on edge should surface as a pair");
    assert.ok(pair.total >= 1);
    assert.ok((pair.categories?.dependency ?? 0) >= 1, "based_on classifies as dependency");
  });
});

// ─── Session ─────────────────────────────────────────────────────

describe("GET /api/session", () => {
  test("returns session summary", async () => {
    const res = await fetch(`${baseUrl}/api/session`);
    assert.equal(res.status, 200);
    const data = await res.json() as any;
    assert.ok(typeof data.total_blocks === "number", "Should have total_blocks");
    assert.ok(Array.isArray(data.projects), "Should have projects array");
    assert.ok(Array.isArray(data.open_tasks), "Should have open_tasks array");
    assert.ok(Array.isArray(data.active_agents), "Should have active_agents array");
  });

  test("open_tasks only includes non-done tasks", async () => {
    const res = await fetch(`${baseUrl}/api/session`);
    const data = await res.json() as any;
    const doneTask = data.open_tasks.find((t: any) =>
      t.label === "api_test_task" && t.status === "done"
    );
    assert.equal(doneTask, undefined, "Done tasks should not appear in open_tasks");
  });
});

// ─── Search ──────────────────────────────────────────────────────

describe("GET /api/search", () => {
  test("finds blocks by keyword", async () => {
    const res = await fetch(`${baseUrl}/api/search?q=API+test`);
    assert.equal(res.status, 200);
    const data = await res.json() as any;
    assert.ok(Array.isArray(data), "Should return an array");
  });

  test("returns empty array for unknown query", async () => {
    const res = await fetch(`${baseUrl}/api/search?q=xyzzy_no_such_block_ever`);
    assert.equal(res.status, 200);
    const data = await res.json() as any;
    assert.ok(Array.isArray(data), "Should return an array even when empty");
  });
});

// ─── Schema ──────────────────────────────────────────────────────

describe("GET /api/schema", () => {
  test("returns relation types and block types", async () => {
    const res = await fetch(`${baseUrl}/api/schema`);
    assert.equal(res.status, 200);
    const data = await res.json() as any;
    assert.ok(Array.isArray(data.relation_types), "Should have relation_types");
    assert.ok(Array.isArray(data.block_types), "Should have block_types");
    assert.ok(data.relation_types.length > 0, "Should have at least one relation type");
    assert.ok(data.block_types.length > 0, "Should have at least one block type");
  });
});

