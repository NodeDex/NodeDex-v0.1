/**
 * setup-gate.test.ts — the notice that makes workspace_onboard actually happen.
 *
 * The failure it exists for (measured 2026-07-12): the memory reflex reaches the agent
 * on the MCP `instructions` field — ONCE, at connect. Hours into a task it has scrolled
 * out of context, which is exactly when the agent commits to an approach. An agent read
 * the dead_end list at 12:17, authored room data at 14:00, and shipped the bug the list
 * warned about. `workspace_onboard` was built to fix this (persist the reflex where the
 * host re-reads it EVERY turn) and NO agent has ever called it — because a tool the model
 * must REMEMBER to invoke has the very decay problem it is meant to cure.
 *
 * So the reminder rides the tool RESULT: the one channel that cannot decay (re-sent on
 * every call), that every MCP host shows the model, and that needs no hook. Driven here
 * through the REAL MCP server + client, not the helper in isolation.
 *
 * Run: node --import=tsx/esm --test src/tools/__tests__/setup-gate.test.ts
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { WorkspaceDB } from "../../store/database.js";
import { EmbeddingEngine } from "../../engine/embeddings.js";
import { buildWorkspaceServer } from "../../mcp-server.js";
import { isReflexOnboarded, SETUP_NOTICE } from "../onboarding-state.js";

const TEST_DB = "/tmp/wmcs_setup_gate_test.db";
let db: WorkspaceDB;

/** Fresh client+server pair — the HTTP path builds one server per session, so this
 *  mirrors reality (a later session must see the CURRENT onboarded state). */
async function connect() {
  const server = buildWorkspaceServer(db, new EmbeddingEngine());
  const client = new Client({ name: "setup-gate-test", version: "0.0.0" });
  const [c, s] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(s), client.connect(c)]);
  return client;
}

/** Every text part of a tool result — the notice is appended as its own content part. */
const textOf = (res: any): string => (res.content ?? []).map((p: any) => p.text ?? "").join("\n");

before(() => {
  try { fs.unlinkSync(TEST_DB); } catch { /* fresh */ }
  db = new WorkspaceDB(TEST_DB);
  db.init();
});
after(() => { try { db.close(); fs.unlinkSync(TEST_DB); } catch { /* best-effort */ } });

describe("setup gate — the reflex-persistence notice rides every tool result", () => {
  test("BEFORE onboard: an ordinary read carries the notice", async () => {
    assert.equal(isReflexOnboarded(db), false, "fresh workspace starts un-onboarded");
    const client = await connect();
    const res: any = await client.callTool({ name: "workspace_tree", arguments: {} });
    const text = textOf(res);
    assert.ok(text.includes("SETUP INCOMPLETE"), "the notice must ride a plain read");
    assert.ok(text.includes("workspace_onboard"), "…and name the call that resolves it");
    // The result itself must still be intact — the notice is additive, never destructive.
    assert.ok(text.includes("success"), "the tool's own payload survives");
    await client.close();
  });

  test("the notice states the CONSEQUENCE, not just the instruction", () => {
    // "call this tool" with no reason is exactly what an agent deprioritises under
    // momentum — which is the behaviour that caused the failure in the first place.
    assert.match(SETUP_NOTICE, /ONCE, at connect/i);
    assert.match(SETUP_NOTICE, /gone from your context/i);
    assert.match(SETUP_NOTICE, /exactly when this graph matters/i);
    assert.match(SETUP_NOTICE, /stops after that call/i);
  });

  test("calling workspace_onboard extinguishes it — for THIS session and every later one", async () => {
    const client = await connect();

    const onboard: any = await client.callTool({ name: "workspace_onboard", arguments: {} });
    const onboardText = textOf(onboard);
    // onboard's own result is exempt (it already carries the full contract)
    assert.ok(!onboardText.includes("SETUP INCOMPLETE"), "onboard must not nag about itself");
    assert.ok(onboardText.includes("reflex_block"), "onboard hands over the block to persist");
    assert.equal(isReflexOnboarded(db), true, "the CALL is the extinguishing event");

    // same session
    const after1: any = await client.callTool({ name: "workspace_tree", arguments: {} });
    assert.ok(!textOf(after1).includes("SETUP INCOMPLETE"), "notice gone in this session");
    await client.close();

    // a LATER session (new server instance, same db) — state is persisted, not in-memory
    const client2 = await connect();
    const after2: any = await client2.callTool({ name: "workspace_stats", arguments: {} });
    assert.ok(!textOf(after2).includes("SETUP INCOMPLETE"), "notice gone in every later session");
    await client2.close();
  });

  test("the extinguishing event is the CALL, not the write — a decline is respected", () => {
    // We cannot see the user's config file, so we cannot verify the write. And a user
    // who says no has made a decision; nagging past it would be the wrong behaviour.
    // Either way the agent has been told, once, in full — which is all we can honestly do.
    assert.equal(isReflexOnboarded(db), true);
  });
});
