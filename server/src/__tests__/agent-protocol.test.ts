import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { AGENT_PROTOCOL, protocolBlock, NODEDEX_BEGIN, NODEDEX_END } from "../agent-protocol.js";

// The protocol is the ONE source of truth shared by the MCP instructions field and
// workspace_onboard. protocolBlock() is what the agent persists into its own config,
// so the marker contract (replace-in-place, removable) must hold.

describe("agent-protocol", () => {
  test("AGENT_PROTOCOL teaches the two reflexes + the traversal loop", () => {
    // reflex 1 = dead-end/constraint check before proposing; reflex 2 = traverse-not-search
    assert.match(AGENT_PROTOCOL, /dead_end/i);
    assert.match(AGENT_PROTOCOL, /constraint/i);
    assert.match(AGENT_PROTOCOL, /TRAVERSE/);
    // the loop names the actual tools
    for (const t of ["workspace_filter", "workspace_search", "workspace_get"]) {
      assert.ok(AGENT_PROTOCOL.includes(t), `protocol must name ${t}`);
    }
    // "pipeline writes, you read" — don't-save framing
    assert.match(AGENT_PROTOCOL, /pipeline/i);
  });

  test("protocolBlock wraps the protocol in exactly one removable, replace-in-place marker pair", () => {
    const block = protocolBlock();
    assert.ok(block.includes(NODEDEX_BEGIN) && block.includes(NODEDEX_END), "has both markers");
    // exactly one pair → a re-run can REPLACE in place without ambiguity
    assert.equal(block.split(NODEDEX_BEGIN).length - 1, 1, "exactly one begin marker");
    assert.equal(block.split(NODEDEX_END).length - 1, 1, "exactly one end marker");
    assert.ok(block.indexOf(NODEDEX_BEGIN) < block.indexOf(NODEDEX_END), "begin precedes end");
    // carries the full protocol + a self-describing opt-out line
    assert.ok(block.includes(AGENT_PROTOCOL), "contains the protocol verbatim");
    assert.match(block, /remove|delete|opt out/i);
  });
});
