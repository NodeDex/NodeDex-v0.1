/**
 * setup-gate.test.ts — the notice that makes NodeDex actually get WIRED IN, and the
 * verification that makes it honest.
 *
 * The failure it exists for (measured 2026-07-12): the memory reflex reaches the agent on
 * the MCP `instructions` field — ONCE, at connect. Hours into a task it has scrolled out of
 * context, which is exactly when the agent commits to an approach. An agent read the
 * dead_end list at 12:17, authored the room data at 16:44, and shipped the bug that list
 * warned about. `workspace_onboard` was built to fix this and NO agent ever called it —
 * a tool the model must REMEMBER to invoke has the very decay problem it is meant to cure.
 *
 * So the reminder rides the tool RESULT: the one channel that cannot decay (re-sent on
 * every call), that every MCP host shows the model, and that needs no hook.
 *
 * AND THE NOTICE DOES NOT STOP ON A CLAIM. The first version marked setup complete the
 * instant the tool was CALLED — so an agent could call it, write nothing, and silence the
 * nag forever: the same "model says it did a thing and didn't" failure, reproduced inside
 * the cure. Now each wire is verified by OBSERVED EFFECT (file read back / turn landed /
 * check hit the endpoint), and these tests pin exactly that.
 *
 * Driven through the REAL MCP server + client, not the helpers in isolation.
 *
 * Run: node --import=tsx/esm --test src/tools/__tests__/setup-gate.test.ts
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { WorkspaceDB } from "../../store/database.js";
import { EmbeddingEngine } from "../../engine/embeddings.js";
import { buildWorkspaceServer } from "../../mcp-server.js";
import { wireState, buildSetupNotice, gateShouldRemind, recordGraphRead, markGateSeen } from "../setup-state.js";
import { protocolBlock } from "../../agent-protocol.js";

const TEST_DB = "/tmp/wmcs_setup_gate_test.db";
// The MCP client name the test connects with — the identity the wires are keyed on.
const CLIENT = "setup-gate-test";
let db: WorkspaceDB;

/** Fresh client+server pair — the HTTP path builds one server per session, so this
 *  mirrors reality (a later session must see the CURRENT wire state). */
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

describe("setup gate — the wiring notice rides every tool result", () => {
  test("BEFORE setup: an ordinary read carries the notice, naming every unwired wire", async () => {
    const client = await connect();
    const res: any = await client.callTool({ name: "workspace_tree", arguments: {} });
    const text = textOf(res);
    assert.ok(text.includes("NOT FULLY WIRED"), "the notice must ride a plain read");
    assert.ok(text.includes("workspace_onboard"), "…and name the reflex call");
    assert.ok(text.includes("workspace_install_gate"), "…and the gate call");
    // The result itself must still be intact — the notice is additive, never destructive.
    assert.ok(text.includes("success"), "the tool's own payload survives");
    await client.close();
  });

  test("the notice states the CONSEQUENCE, not just the instruction", () => {
    // "call this tool" with no reason is exactly what an agent deprioritises under
    // momentum — which is the behaviour that caused the failure in the first place.
    const notice = buildSetupNotice(db, CLIENT) ?? "";
    assert.match(notice, /gone from your context/i);
    assert.match(notice, /exactly when this graph matters/i);
    assert.match(notice, /VERIFIED/i, "and it must say it will not take the agent's word for it");
  });

  test("CLAIMING is not enough: a bare workspace_onboard call does NOT silence the notice", async () => {
    // THE REGRESSION GUARD. This is the exact hole the previous version shipped with.
    const client = await connect();
    const onboard: any = await client.callTool({ name: "workspace_onboard", arguments: {} });
    const onboardText = textOf(onboard);
    assert.ok(!onboardText.includes("NOT FULLY WIRED"), "onboard must not nag about itself");
    assert.ok(onboardText.includes("reflex_block"), "onboard hands over the block to persist");

    assert.equal(wireState(db, CLIENT).reflex, false, "calling the tool proves NOTHING was written");
    const after: any = await client.callTool({ name: "workspace_tree", arguments: {} });
    assert.ok(textOf(after).includes("NOT FULLY WIRED"), "so the notice must keep nagging");
    await client.close();
  });

  test("a VERIFIED write silences the reflex wire — the server reads the file back", async () => {
    const file = path.join(os.tmpdir(), `wmcs_agents_${Date.now()}.md`);
    const client = await connect();

    // The agent claims a write it did not make → the server catches it.
    const lie: any = await client.callTool({
      name: "workspace_onboard",
      arguments: { written_to: path.join(os.tmpdir(), "does-not-exist-at-all.md") },
    });
    assert.ok(textOf(lie).includes("not_verified"), "an unreadable path is not a verified write");
    assert.equal(wireState(db, CLIENT).reflex, false);

    // The agent writes the block into a file that already has content (the real case —
    // it is the USER's file), then reports it.
    fs.writeFileSync(file, "# My existing agent instructions\n\nDo not break these.\n", "utf8");
    fs.appendFileSync(file, "\n" + protocolBlock() + "\n", "utf8");
    const real: any = await client.callTool({ name: "workspace_onboard", arguments: { written_to: file } });
    assert.ok(textOf(real).includes("verified"), "a real marked block verifies");
    assert.equal(wireState(db, CLIENT).reflex, true);

    // …and the user's existing content is untouched (the agent appended, never clobbered).
    assert.ok(fs.readFileSync(file, "utf8").includes("Do not break these."));

    await client.close();
    fs.unlinkSync(file);
  });

  test("a wrong-content write is caught too — the marker must actually be there", async () => {
    const file = path.join(os.tmpdir(), `wmcs_empty_${Date.now()}.md`);
    fs.writeFileSync(file, "# I wrote something, but not the block\n", "utf8");
    const client = await connect();
    const res: any = await client.callTool({ name: "workspace_onboard", arguments: { written_to: file } });
    assert.ok(textOf(res).includes("not_verified"), "no marker → not verified, however confident the agent is");
    await client.close();
    fs.unlinkSync(file);
  });

  test("a DECLINE is respected — recorded, and never nagged past", async () => {
    const client = await connect();
    await client.callTool({ name: "workspace_install_capture", arguments: { declined: true } });
    await client.callTool({ name: "workspace_install_gate", arguments: { declined: true } });
    const s = wireState(db, CLIENT);
    assert.equal(s.capture, true, "a decline settles the wire (a 'no' is a decision)");
    assert.equal(s.gate, true);

    // With reflex verified above + both declines, every wire is settled → silence, for good.
    const after: any = await client.callTool({ name: "workspace_tree", arguments: {} });
    assert.ok(!textOf(after).includes("NOT FULLY WIRED"), "fully settled → the notice stops");
    await client.close();

    // …and it stays stopped in a LATER session (persisted state, not in-memory).
    const client2 = await connect();
    const later: any = await client2.callTool({ name: "workspace_stats", arguments: {} });
    assert.ok(!textOf(later).includes("NOT FULLY WIRED"), "notice gone in every later session");
    await client2.close();
  });
});

describe("the wires are PER-AGENT — one graph, many hosts", () => {
  /** Connect under a DIFFERENT client name — a second agent on the SAME graph. */
  async function connectAs(name: string) {
    const server = buildWorkspaceServer(db, new EmbeddingEngine());
    const client = new Client({ name, version: "0.0.0" });
    const [c, s] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(s), client.connect(c)]);
    return client;
  }

  test("a NEW agent does NOT inherit the first agent's setup — it gets nagged", async () => {
    // The bug this pins: wires stored per-GRAPH meant the second host to connect inherited a
    // "✓ wired" it never earned, was never nagged, and was exactly as blind as the agent whose
    // failure started all of this. The reflex lives in a file THIS agent reads; the gate in a
    // seam THIS agent runs. Another agent's setup does nothing for it.
    //
    // (By now `db` has CLIENT's reflex verified + gate declined from the tests above.)
    assert.equal(wireState(db, CLIENT).reflex, true, "precondition: the first agent IS wired");

    const other = await connectAs("some-other-agent");
    const res: any = await other.callTool({ name: "workspace_tree", arguments: {} });
    const text = textOf(res);
    assert.ok(text.includes("NOT FULLY WIRED"), "the new agent must still be nagged");
    assert.ok(text.includes("workspace_onboard"), "…to persist ITS OWN reflex");
    assert.equal(wireState(db, "some-other-agent").reflex, false, "and its wire state is its own");
    await other.close();
  });

  test("the new agent is TOLD another agent is set up, and how to confirm cheaply", async () => {
    // A shared file (AGENTS.md is picked for exactly this) may already contain the block —
    // in which case the new agent should verify, not rewrite. Say so, or it will duplicate.
    const notice = buildSetupNotice(db, "some-other-agent") ?? "";
    assert.match(notice, /another agent \(.*\) is already set up/i);
    assert.match(notice, /does NOT wire YOU/i);
    assert.match(notice, /AGENTS\.md/i, "and point at the shared file that makes it one call");
  });

  test("CAPTURE is per-agent too — another agent's turns prove nothing about yours", async () => {
    // The bug: capture was global, so a graph full of agent A's turns marked agent B "captured"
    // while B's work was being recorded NOWHERE. A healthy-looking graph is not evidence.
    const other = await connectAs("seam-agent");

    // B declares the id it posts under, and no turn with that id has landed.
    await other.callTool({ name: "workspace_install_capture", arguments: { capture_id: "seam-agent-1" } });
    assert.equal(wireState(db, "seam-agent").capture, false, "declared, but nothing has landed → still unproven");

    const nag: any = await other.callTool({ name: "workspace_tree", arguments: {} });
    assert.ok(textOf(nag).includes("CAPTURE"), "so it must still be nagged about capture");

    // Now a real turn lands under that id — the ONLY thing that proves it.
    db.createConversationTurn({
      agent_id: "seam-agent-1",
      turn_number: 1,
      transcript_json: JSON.stringify({ user_message: "hi", agent_response: "hello" }),
    });
    assert.equal(wireState(db, "seam-agent").capture, true, "a landed turn under the declared id proves capture");
    await other.close();
  });

  test("no post-turn seam? declare via_watcher — then turns landing at all is the honest proof", async () => {
    const watcherAgent = await connectAs("watcher-agent");
    await watcherAgent.callTool({ name: "workspace_install_capture", arguments: { via_watcher: true } });
    // Its host persists transcripts and the user's watcher feeds them in — the agent has no
    // seam of its own, so "turns are arriving" is the strongest claim we can honestly make.
    assert.equal(wireState(db, "watcher-agent").capture, true);
    await watcherAgent.close();
  });
});

describe("the gate — staleness is TIME, not session", () => {
  test("never read → remind", () => {
    const fresh = new WorkspaceDB("/tmp/wmcs_gate_time_test.db");
    fresh.init();
    assert.equal(gateShouldRemind(fresh), true, "an agent that has never looked must be reminded");
    fresh.close();
    try { fs.unlinkSync("/tmp/wmcs_gate_time_test.db"); } catch { /* best-effort */ }
  });

  test("just read → silent; long ago → remind (the 12:17 → 16:45 failure)", async () => {
    const fresh = new WorkspaceDB("/tmp/wmcs_gate_time2.db");
    fresh.init();

    recordGraphRead(fresh);
    assert.equal(gateShouldRemind(fresh), false, "read seconds ago → the agent still has it; stay quiet");

    // The measured failure: the agent DID read the graph — four hours before it wrote the
    // code. A session-scoped check would have said "already read" and stayed silent, and
    // the bug would have shipped exactly as it did. Here we shrink the staleness window
    // instead of waiting four hours: same predicate, same verdict.
    const prev = process.env.NODEDEX_GATE_STALE_MIN;
    process.env.NODEDEX_GATE_STALE_MIN = "0.0005"; // 30ms window
    await new Promise((r) => setTimeout(r, 60)); // the "four hours"
    assert.equal(gateShouldRemind(fresh), true, "a stale read must remind, same session or not");
    if (prev === undefined) delete process.env.NODEDEX_GATE_STALE_MIN;
    else process.env.NODEDEX_GATE_STALE_MIN = prev;

    fresh.close();
    try { fs.unlinkSync("/tmp/wmcs_gate_time2.db"); } catch { /* best-effort */ }
  });

  test("a fresh read is not a RELEVANT read — a NEW FILE still gets checked", () => {
    // The hole in a time-only gate: the agent reads the graph about the font system, then four
    // minutes later starts a different task — enemy placement — and sails straight through,
    // because the clock says "recent". A new task shows up as NEW FILES, and the reflex already
    // names this trigger in its own words: "before your first edit to a file you have not
    // touched this session".
    const fresh = new WorkspaceDB("/tmp/wmcs_gate_files.db");
    fresh.init();
    // Grace off: this test is about RELEVANCE (new file), not about the just-read grace window.
    const prevGrace = process.env.NODEDEX_GATE_GRACE_SEC;
    process.env.NODEDEX_GATE_GRACE_SEC = "0";
    recordGraphRead(fresh, "agent-x");

    assert.equal(gateShouldRemind(fresh, "agent-x", "src/font.js"), true, "first touch of a file → check");
    assert.equal(gateShouldRemind(fresh, "agent-x", "src/font.js"), false, "same file again → silent (same task)");
    assert.equal(gateShouldRemind(fresh, "agent-x", "src/rooms.js"), true, "a DIFFERENT file → new task → check");

    // …and consulting the graph again re-opens the files it was about: having just read, the
    // agent is entitled to work across them without being nagged for each one.
    recordGraphRead(fresh, "agent-x");
    assert.equal(gateShouldRemind(fresh, "agent-x", "src/rooms.js"), true, "after a new read, the next file is checked once more");

    if (prevGrace === undefined) delete process.env.NODEDEX_GATE_GRACE_SEC;
    else process.env.NODEDEX_GATE_GRACE_SEC = prevGrace;
    fresh.close();
    try { fs.unlinkSync("/tmp/wmcs_gate_files.db"); } catch { /* best-effort */ }
  });

  test("the gate wire is proven by a check ARRIVING, not by a claim", () => {
    const fresh = new WorkspaceDB("/tmp/wmcs_gate_seen.db");
    fresh.init();
    assert.equal(wireState(fresh, CLIENT).gate, false);
    markGateSeen(fresh, CLIENT); // what /api/gate/check does on a real hit
    assert.equal(wireState(fresh, CLIENT).gate, true, "an actual check reaching us is the only proof it is wired");
    fresh.close();
    try { fs.unlinkSync("/tmp/wmcs_gate_seen.db"); } catch { /* best-effort */ }
  });
});

describe("the gate does not nag an agent that just did the right thing", () => {
  test("GRACE: it consulted the graph moments ago → silent even on a new file", () => {
    // A gate that fires the instant after a read is a gate that gets uninstalled. The window is
    // short on purpose: it covers the burst of edits that FOLLOWS a read, and comes nowhere near
    // the four-hour gap that produced the bug we are actually chasing.
    const db2 = new WorkspaceDB("/tmp/wmcs_gate_grace.db");
    db2.init();
    recordGraphRead(db2, "agent-g");
    assert.equal(gateShouldRemind(db2, "agent-g", "src/brand-new.js"), false, "just read → let it work");

    const prev = process.env.NODEDEX_GATE_GRACE_SEC;
    process.env.NODEDEX_GATE_GRACE_SEC = "0"; // the grace has passed; it is now 'working'
    assert.equal(gateShouldRemind(db2, "agent-g", "src/brand-new.js"), true, "…but a new file later IS checked");
    if (prev === undefined) delete process.env.NODEDEX_GATE_GRACE_SEC;
    else process.env.NODEDEX_GATE_GRACE_SEC = prev;

    db2.close();
    try { fs.unlinkSync("/tmp/wmcs_gate_grace.db"); } catch { /* best-effort */ }
  });
});
