import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { reflectQueue, processReflectQueue, setReflectPaused, setSpendPaused } from "../state.js";

// Credit-exhaustion handling (2026-06-21): a SPEND pause halts the drain (stop spending)
// while CAPTURE keeps queuing — distinct from reflectPaused (which stops capture too). This
// locks the drain-halt half: processReflectQueue must return WITHOUT touching the DB while
// spendPaused, leaving every job queued for a top-up. (The capture-keeps-queuing half lives
// in the /trigger handler, which is gated on reflectPaused ONLY — not spendPaused.)
describe("reflect drain respects the SPEND pause (credit-out)", () => {
  beforeEach(() => { reflectQueue.length = 0; setReflectPaused(false); setSpendPaused(false); });
  afterEach(() => { reflectQueue.length = 0; setReflectPaused(false); setSpendPaused(false); });

  it("does not drain (no DB access) while spend-paused, and leaves jobs queued for top-up", async () => {
    const throwingDb: any = new Proxy({}, {
      get() { throw new Error("db must not be touched while spending is paused"); },
    });
    reflectQueue.push({
      agentResponse: "x".repeat(60),
      agentThinking: "",
      userMessage: "",
      loadedBlockIds: [],
      agentId: "test-agent",
      dbId: "job-1",
    } as any);

    setSpendPaused(true);
    await processReflectQueue(throwingDb, undefined); // must not throw, must not drain

    assert.equal(reflectQueue.length, 1, "job remains queued while spend-paused (preserved for top-up)");
  });

  it("drains normally once the spend pause clears (auto-resume path)", async () => {
    // Empty queue + both pauses off → loop runs and exits cleanly without touching db.
    let dbTouched = false;
    const watchDb: any = new Proxy({}, { get() { dbTouched = true; return () => undefined; } });
    setSpendPaused(false);
    await processReflectQueue(watchDb, undefined);
    assert.equal(reflectQueue.length, 0);
    assert.equal(dbTouched, false, "empty queue means no db access regardless");
  });
});
