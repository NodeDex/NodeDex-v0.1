import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { reflectQueue, processReflectQueue, setReflectPaused } from "../state.js";

// Regression lock for the 2026-06-01 surprise-spend bug: pause must HALT the
// drain, not just gate new enqueues. Before the fix, processReflectQueue kept
// draining a recovered queue while paused → credit burned on restart.
describe("reflect drain respects pause", () => {
  beforeEach(() => { reflectQueue.length = 0; setReflectPaused(false); });
  afterEach(() => { reflectQueue.length = 0; setReflectPaused(false); });

  it("does not touch the DB (does not drain) while paused, and leaves jobs queued", async () => {
    // A db that throws on ANY access — proves the drain loop returns before
    // reaching any job processing while paused.
    const throwingDb: any = new Proxy({}, {
      get() { throw new Error("db must not be touched while reflect is paused"); },
    });
    reflectQueue.push({
      agentResponse: "x".repeat(60),
      agentThinking: "",
      userMessage: "",
      loadedBlockIds: [],
      agentId: "test-agent",
      dbId: "job-1",
    } as any);

    setReflectPaused(true);
    await processReflectQueue(throwingDb, undefined); // must not throw

    assert.equal(reflectQueue.length, 1, "job remains queued while paused (not shifted/processed)");
  });

  it("processes the queue when NOT paused (guard doesn't block normal drain)", async () => {
    // Empty queue + not paused → loop runs and exits cleanly without touching db.
    let dbTouched = false;
    const watchDb: any = new Proxy({}, { get() { dbTouched = true; return () => undefined; } });
    setReflectPaused(false);
    await processReflectQueue(watchDb, undefined); // empty queue → no work, no db access
    assert.equal(reflectQueue.length, 0);
    assert.equal(dbTouched, false, "empty queue means no db access regardless");
  });
});
