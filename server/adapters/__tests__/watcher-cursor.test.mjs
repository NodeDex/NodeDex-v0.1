// watcher-cursor.test.mjs — ACK-SAFE capture cursors (audit F-02).
//
// The failure this guards against: a watcher advancing its durable cursor past a turn
// whose POST never reached the server — a transient outage silently and PERMANENTLY
// dropping source turns. The fix: transient statuses stall the file (claude watcher
// rewinds to the un-acked turn's start; hermes ends the pass at the last acked stop-id),
// and replay is safe because the server reuses the existing (agent_id, turn_number) row.
//
// These tests drive the REAL claude-code passFile against a REAL local HTTP target
// (resolved via NODEDEX_CAPTURE_URL — branch 1 of resolveNodedexTarget, no ~/.nodedex
// involvement) and assert the audit's acceptance shape:
//   server DOWN → cursor holds · server UP → turns arrive in order, exactly once.

import { test } from "node:test";
import assert from "node:assert";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { passFile, newBuffer } from "../claude-code-watcher.mjs";
import { isTransientCaptureStatus } from "../nodedex-capture-core.mjs";

// ─── fixture: a Claude Code JSONL with two complete turns + a third opening prompt ─────────────
const SID = "sess1234-abcd-efgh";
const lines = [
  { type: "user", sessionId: SID, message: { role: "user", content: "please fix the flaky sleep threshold in physics" } },
  { type: "assistant", sessionId: SID, message: { content: [{ type: "text", text: "Done — I raised the damping instead of tightening the threshold." }] } },
  { type: "user", sessionId: SID, message: { role: "user", content: "now run the winnability check to confirm topple still works" } },
  { type: "assistant", sessionId: SID, message: { content: [{ type: "text", text: "Winnability check passed — towers still topple, boxes still sleep." }] } },
  { type: "user", sessionId: SID, message: { role: "user", content: "great, write it up" } },
].map((o) => JSON.stringify(o));

// Byte offset where line i starts (each line + "\n").
const offsetOfLine = (i) => lines.slice(0, i).reduce((n, l) => n + Buffer.byteLength(l, "utf8") + 1, 0);
const TURN1_START = offsetOfLine(0); // 0
const TURN2_START = offsetOfLine(2);
const TURN3_START = offsetOfLine(4);

function freshFileState() {
  return { offset: 0, pendingStart: 0, buf: newBuffer(), lastGrowth: Date.now(), sessionId: null, project: "test-project", stallUntil: 0 };
}

test("watcher-cursor: ack-safe capture (claude-code passFile)", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ndx-watcher-"));
  const file = join(dir, `${SID}.jsonl`);
  writeFileSync(file, lines.join("\n") + "\n");
  t.after(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ } });

  const received = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      received.push(JSON.parse(body));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ triggered: true }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const livePort = server.address().port;
  t.after(() => server.close());

  const cfg = { idleFlushMs: 999_999 }; // idle flush out of the way — boundaries drive emits

  await t.test("server DOWN → stall: cursor holds at the unsent turn, offset rewound", async () => {
    process.env.NODEDEX_CAPTURE_URL = "http://127.0.0.1:9"; // reserved port — nothing listens
    const fs_ = freshFileState();
    await passFile(fs_, file, cfg);
    assert.equal(fs_.pendingStart, TURN1_START, "durable cursor must NOT pass the unsent turn");
    assert.equal(fs_.offset, TURN1_START, "offset rewound to the turn's opening line for replay");
    assert.ok(fs_.stallUntil > Date.now(), "stall backoff armed — no hot loop against a dead port");
    assert.equal(received.length, 0, "nothing was delivered");
  });

  await t.test("stall backoff: passFile is a no-op until stallUntil passes", async () => {
    process.env.NODEDEX_CAPTURE_URL = `http://127.0.0.1:${livePort}`; // server now UP
    const fs_ = freshFileState();
    fs_.stallUntil = Date.now() + 60_000;
    await passFile(fs_, file, cfg);
    assert.equal(received.length, 0, "backoff window suppresses the retry");
  });

  await t.test("server UP → replay from the held cursor: in order, exactly once", async () => {
    process.env.NODEDEX_CAPTURE_URL = `http://127.0.0.1:${livePort}`;
    const fs_ = freshFileState(); // = restart from the persisted (held) cursor
    await passFile(fs_, file, cfg);
    assert.equal(received.length, 2, "both complete turns delivered");
    assert.equal(received[0].turn_number, TURN1_START, "turn 1 first (source order)");
    assert.equal(received[1].turn_number, TURN2_START, "turn 2 second");
    assert.equal(fs_.pendingStart, TURN3_START, "cursor advanced exactly to the still-open turn");
    // exactly once: another pass over the same bytes emits nothing new
    await passFile(fs_, file, cfg);
    assert.equal(received.length, 2, "no re-delivery of acked turns");
  });

  await t.test("idle flush failure keeps the buffered turn (cursor unmoved)", async () => {
    process.env.NODEDEX_CAPTURE_URL = "http://127.0.0.1:9"; // down again
    const fs_ = freshFileState();
    fs_.pendingStart = TURN3_START;
    fs_.offset = TURN3_START;
    // complete the third turn on disk so it buffers, then goes idle
    const extra = JSON.stringify({ type: "assistant", sessionId: SID, message: { content: [{ type: "text", text: "Write-up done: damping over threshold, topple preserved." }] } });
    writeFileSync(file, lines.join("\n") + "\n" + extra + "\n");
    await passFile(fs_, file, cfg);          // reads turn 3 into the buffer
    fs_.lastGrowth = Date.now() - 10_000;    // simulate idle
    await passFile(fs_, file, { idleFlushMs: 1 });
    assert.equal(fs_.pendingStart, TURN3_START, "idle-flush failure must not advance the cursor");
    assert.ok(fs_.buf.user.length > 0, "the turn stays buffered for a later retry");
    assert.ok(fs_.stallUntil > Date.now(), "backoff armed");
  });
});

test("isTransientCaptureStatus: only server-reachability failures are transient", () => {
  assert.equal(isTransientCaptureStatus("skipped:no-server"), true);
  assert.equal(isTransientCaptureStatus("failed:post"), true);
  assert.equal(isTransientCaptureStatus("captured"), false, "done is done");
  assert.equal(isTransientCaptureStatus("skipped:short"), false, "content-determined — retrying can't change it");
  assert.equal(isTransientCaptureStatus("dry-run"), false);
});
