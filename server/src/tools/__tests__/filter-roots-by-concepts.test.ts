import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { WorkspaceDB } from "../../store/database.js";
import { filterRootsByConcepts } from "../helpers.js";

// filterRootsByConcepts is the cold-start orientation filter behind workspace_filter:
// concept terms in → ranked ROOT suggestions out (concepts[] + strict label, never
// the surface). These tests lock the contract.

const TEST_DB = path.resolve("/tmp/filter_roots_test.db");
let db: WorkspaceDB;

function cleanFiles() {
  for (const s of ["", "-wal", "-shm"]) {
    try { if (fs.existsSync(TEST_DB + s)) fs.unlinkSync(TEST_DB + s); } catch { /* ignore */ }
  }
}

before(async () => {
  cleanFiles();
  db = new WorkspaceDB(TEST_DB);
  await db.init();

  // Root A: a latency incident, with concept-tagged blocks.
  const incident = db.createBlock({ label: "checkout-incident", type: "project", essence: "Checkout API latency incident." });
  db.createBlock({ label: "checkout-incident_fact_n1", type: "fact", essence: "n+1 found",
    project_id: incident.id, concepts: ["n+1-query", "latency", "database"] });
  db.createBlock({ label: "checkout-incident_decision_dataloader", type: "decision", essence: "use dataloader",
    project_id: incident.id, concepts: ["dataloader", "caching"] });

  // Root B: a charting project — unrelated concepts.
  const charts = db.createBlock({ label: "analytics-charts", type: "project", essence: "Charting library selection." });
  db.createBlock({ label: "analytics-charts_decision_d3", type: "decision", essence: "pick d3",
    project_id: charts.id, concepts: ["d3", "rendering", "svg"] });
});
after(() => { try { (db as any)["db"]?.close(); } catch { /* ignore */ } cleanFiles(); });

describe("filterRootsByConcepts", () => {
  test("concept terms surface the relevant root with its description + entry blocks", () => {
    const out = filterRootsByConcepts(db, ["n+1-query", "latency"]);
    assert.equal(out.length, 1, "only the incident root matches latency concepts");
    const r = out[0]!;
    assert.equal(r.root, "checkout-incident");
    assert.equal(r.description, "Checkout API latency incident.", "returns the pre-made root description");
    assert.ok(r.entries.some((e) => e.label === "checkout-incident_fact_n1"), "matching block is an entry point");
    assert.deepEqual(r.terms_matched.sort(), ["latency", "n+1-query"]);
  });

  test("a root covering MORE of the query terms ranks first", () => {
    // 'caching' + 'latency' + 'n+1-query' all live under the incident; 'd3' under charts.
    const out = filterRootsByConcepts(db, ["latency", "caching", "d3"]);
    assert.equal(out[0]!.root, "checkout-incident", "incident covers 2 terms, charts covers 1");
    assert.ok(out[0]!.terms_matched.length >= 2);
  });

  test("the strict label is a match field, not just concepts (project-name term finds the root)", () => {
    // 'analytics' is only in the label/segment, not any concepts[] tag.
    const out = filterRootsByConcepts(db, ["analytics"]);
    assert.ok(out.some((r) => r.root === "analytics-charts"), "label-segment hit resolves the root");
  });

  test("unmatched concepts return no suggestions (no fuzzy surface fallback)", () => {
    assert.deepEqual(filterRootsByConcepts(db, ["quantum-entanglement"]), []);
  });

  test("empty / junk terms return nothing", () => {
    assert.deepEqual(filterRootsByConcepts(db, ["", " ", "a"]), []);
  });
});
