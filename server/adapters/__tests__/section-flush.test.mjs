// section-flush.test.mjs — STREAMING SECTION CAPTURE: bound the UNIT, keep the content.
//
// The failure this guards against: a one-shot agent producing megabytes under ONE user
// prompt meant (a) zero extraction until the run paused, and (b) thinking had to be
// clipped hard to keep the unbounded turn payload sane — losing the ENDINGS of long
// deliberations, where conclusions live. The fix: when the buffered raw span exceeds
// NODEDEX_CC_SECTION_BYTES, the watcher emits the buffer as a section-turn (cut only
// right after an assistant TEXT beat), carrying the same user prompt; thinking keeps a
// generous head+tail bound per thought instead of a 2000-char head clip.
//
// Both constants resolve at module load, and STATIC imports hoist above any env
// assignment — so the watcher must be imported DYNAMICALLY after env is set
// (same pattern as capture-caps.test.mjs).
import { test } from "node:test";
import assert from "node:assert";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";

process.env.NODEDEX_CC_SECTION_BYTES = "400";
process.env.NODEDEX_CC_SECTION_THINKING_CHARS = "150";
process.env.NODEDEX_CAPTURE_THINKING_BLOCK_MAX = "100";
const { passFile, newBuffer, clipThinking } = await import("../claude-code-watcher.mjs");

const SID = "sect1234-abcd-efgh";
const beat = (n) =>
  JSON.stringify({ type: "assistant", sessionId: SID, message: { content: [
    { type: "thinking", thinking: `deliberating about step ${n} of the build in some detail here` },
    { type: "text", text: `Step ${n} done — moving to step ${n + 1} of the long autonomous build now.` },
  ] } });
const lines = [
  JSON.stringify({ type: "user", sessionId: SID, message: { role: "user", content: "build the whole game in one shot" } }),
  beat(1), beat(2), beat(3), beat(4), beat(5), beat(6),
  JSON.stringify({ type: "user", sessionId: SID, message: { role: "user", content: "now write it up" } }),
];

function freshFileState() {
  return { offset: 0, pendingStart: 0, buf: newBuffer(), lastGrowth: Date.now(), sessionId: null, project: "test-project", stallUntil: 0 };
}

test("section flush: one giant turn arrives as multiple coherent section-turns", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ndx-section-"));
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
  process.env.NODEDEX_CAPTURE_URL = `http://127.0.0.1:${server.address().port}`;
  t.after(() => server.close());

  await passFile(freshFileState(), file, { idleFlushMs: 999_999 });

  assert.ok(received.length >= 2, `giant turn must arrive as >1 unit, got ${received.length}`);
  // every section carries the ORIGINAL prompt for context
  for (const r of received) assert.equal(r.user_message, "build the whole game in one shot");
  // section identity: byte offsets, strictly ascending, first = the prompt's own line (0)
  const nums = received.map((r) => r.turn_number);
  assert.equal(nums[0], 0, "first section anchors at the turn's opening line");
  for (let i = 1; i < nums.length; i++) assert.ok(nums[i] > nums[i - 1], "section turn_numbers ascend");
  // no content lost across the cuts: every beat's text lands in exactly one unit
  const allText = received.map((r) => r.agent_response).join("\n");
  for (let n = 1; n <= 6; n++) {
    const hits = received.filter((r) => r.agent_response.includes(`Step ${n} done`)).length;
    assert.equal(hits, 1, `beat ${n} appears exactly once across sections (got ${hits})`);
  }
  assert.ok(allText.includes("Step 6 done"), "the residue after the last cut is emitted at the boundary");
  // thinking rides each section
  assert.ok(received.every((r) => r.agent_thinking.includes("deliberating")), "thinking present per section");
});

test("thinking-driven flush: heavy reasoning between few beats still chunks under the extraction budget", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ndx-thinkflush-"));
  const SID2 = "think567-abcd-efgh";
  const file = join(dir, `${SID2}.jsonl`);
  // beats are tiny (byte trigger ~never fires at 400 only after ~4 beats) but each
  // carries ~90 chars of thinking → the 150-char thinking trigger must drive cuts.
  const beat2 = (n) =>
    JSON.stringify({ type: "assistant", sessionId: SID2, message: { content: [
      { type: "thinking", thinking: `deep deliberation segment ${n} ` + "x".repeat(60) },
      { type: "text", text: `Beat ${n}.` },
    ] } });
  const lines2 = [
    JSON.stringify({ type: "user", sessionId: SID2, message: { role: "user", content: "think hard" } }),
    beat2(1), beat2(2), beat2(3), beat2(4), beat2(5),
    JSON.stringify({ type: "user", sessionId: SID2, message: { role: "user", content: "done" } }),
  ];
  writeFileSync(file, lines2.join("\n") + "\n");
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
  process.env.NODEDEX_CAPTURE_URL = `http://127.0.0.1:${server.address().port}`;
  t.after(() => server.close());

  await passFile({ offset: 0, pendingStart: 0, buf: newBuffer(), lastGrowth: Date.now(), sessionId: null, project: "test-project", stallUntil: 0 }, file, { idleFlushMs: 999_999 });

  assert.ok(received.length >= 2, `thinking volume must force >1 section, got ${received.length}`);
  for (const r of received) {
    assert.ok(r.agent_thinking.length <= 150 + 120, `each section's thinking stays near the budget (got ${r.agent_thinking.length})`);
    assert.ok(r.agent_response.length > 0, "every reasoning chunk carries its own slice of output (never reasoning-only)");
  }
  // the full trace survives across sections
  const joined = received.map((r) => r.agent_thinking).join("\n");
  for (let n = 1; n <= 5; n++) assert.ok(joined.includes(`deep deliberation segment ${n}`), `segment ${n} present`);
});

test("clipThinking: short thoughts untouched; long thoughts keep head AND tail with a visible cut", () => {
  assert.equal(clipThinking("short thought"), "short thought");
  const long = "H".repeat(80) + "M".repeat(300) + "T".repeat(40); // max=100 → head 60, tail 40
  const out = clipThinking(long);
  assert.ok(out.includes("[…thought clipped…]"), "cut must be visible");
  assert.ok(out.startsWith("H".repeat(60)), "head (the framing) survives");
  assert.ok(out.endsWith("T".repeat(40)), "tail (the conclusion) survives");
  assert.ok(out.length < 100 + 30, "bounded");
});
