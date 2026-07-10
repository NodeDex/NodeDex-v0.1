/**
 * mcp-read-surface.test.ts — what the AGENT actually receives over MCP (audit F-04).
 *
 * The trust protocol (agent-protocol.ts + the skill) instructs the agent to judge a
 * record by its verbatim source_excerpt — so the default read path (workspace_get)
 * must actually RETURN it. Until 0.1.18 it didn't (REST did, MCP didn't): the agent
 * was told to run a provenance check its own read surface couldn't perform.
 *
 * First test that talks to the REAL MCP server surface (buildWorkspaceServer over an
 * in-memory linked transport) rather than internals — guards the extract → store →
 * MCP-read seam end to end.
 *
 * Run: node --import=tsx/esm --test src/tools/__tests__/mcp-read-surface.test.ts
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { WorkspaceDB } from "../../store/database.js";
import { EmbeddingEngine } from "../../engine/embeddings.js";
import { buildWorkspaceServer } from "../../mcp-server.js";

const TEST_DB = "/tmp/wmcs_mcp_read_surface_test.db";
const EXCERPT = "We rejected tightening the sleep threshold: speed²<4 was too strict and b2 oscillates at vy≈4, so it never sleeps.";

let db: WorkspaceDB;
let client: Client;
let blockLabel: string;
let rangeId: string;

async function callGet(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = (await client.callTool({ name: "workspace_get", arguments: args })) as {
    content: Array<{ type: string; text: string }>;
  };
  const parsed = JSON.parse(res.content[0]!.text) as { success: boolean; data: Record<string, unknown> };
  assert.equal(parsed.success, true, "workspace_get must succeed");
  return parsed.data;
}

before(async () => {
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  db = new WorkspaceDB(TEST_DB);
  await db.init();

  // An arc-extracted-shaped block: verbatim excerpt + an extraction receipt.
  const b = db.createBlock({
    label: "mcpsurface_dead-end_strict-sleep-threshold",
    type: "dead_end",
    essence: "tightening the sleep threshold fails — b2 never sleeps",
    content: { unique: { approach: "tighten sleep threshold", why_failed: "b2 oscillates at vy≈4" } },
    ttl: "permanent",
    source_excerpt: EXCERPT,
  });
  blockLabel = b.label;
  db.createConversationTurn({ agent_id: "mcp-surface-test", turn_number: 1, transcript_json: "{}" });
  const range = db.createConversationTurnRange({
    agent_id: "mcp-surface-test", start_turn_number: 1, end_turn_number: 1, extraction_type: "arc",
  });
  rangeId = range.id;
  db.recordBlockExtraction(b.id, range.id);
  // And one non-extracted block (manual-save shape) — provenance must read null, not lie.
  db.createBlock({ label: "mcpsurface_fact_manual", type: "fact", essence: "manually saved", content: { unique: { value: "x" } }, ttl: "permanent" });

  const server = buildWorkspaceServer(db, new EmbeddingEngine());
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  client = new Client({ name: "read-surface-test", version: "0.0.0" });
  await client.connect(clientTransport);
});

after(async () => {
  try { await client.close(); } catch { /* already closed */ }
  db.close();
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
});

describe("the default agent surface (what tools the agent actually sees)", () => {
  test("task maintenance is ON by default; task create/claim stay opt-in; knowledge writes hidden", async () => {
    const tools = (await client.listTools()).tools.map((t) => t.name);
    assert.ok(tools.includes("workspace_task_update"),
      "the ONE agent write — its own work-state — must be on the default surface");
    assert.ok(!tools.includes("workspace_task_create"), "task creation stays opt-in (NODEDEX_EXPOSE_TASKS)");
    assert.ok(!tools.includes("workspace_task_next"), "task claiming stays opt-in (multi-agent feature)");
    assert.ok(!tools.includes("workspace_remember"), "knowledge writes stay hidden");
    assert.ok(!tools.includes("workspace_update"), "knowledge updates stay hidden");
  });
});

describe("workspace_get carries provenance to the agent", () => {
  test("surface (default) returns the verbatim source_excerpt", async () => {
    const got = await callGet({ id: blockLabel });
    assert.equal(got.detail_level, "surface");
    assert.equal(got.source_excerpt, EXCERPT, "the trust anchor must ride the DEFAULT read");
  });

  test("every other detail level carries it too", async () => {
    for (const detail of ["content", "relations", "full"]) {
      const got = await callGet({ id: blockLabel, detail });
      assert.equal(got.source_excerpt, EXCERPT, `source_excerpt missing at detail=${detail}`);
    }
  });

  test("full exposes the turn-range receipt (extracted_from → range id)", async () => {
    const got = await callGet({ id: blockLabel, detail: "full" });
    const meta = got.metadata as { extracted_from: Array<{ range_id: string }> };
    assert.equal(meta.extracted_from.length, 1, "one extraction receipt");
    assert.equal(meta.extracted_from[0]!.range_id, rangeId, "points at the producing range");
  });

  test("non-extracted block reads source_excerpt: null — never fabricated", async () => {
    const got = await callGet({ id: "mcpsurface_fact_manual" });
    assert.equal(got.source_excerpt, null);
    const full = await callGet({ id: "mcpsurface_fact_manual", detail: "full" });
    assert.deepEqual((full.metadata as { extracted_from: unknown[] }).extracted_from, [], "no receipt to point at");
  });
});
