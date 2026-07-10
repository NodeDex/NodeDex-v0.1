import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { AGENT_PROTOCOL, protocolBlock, NODEDEX_BEGIN, NODEDEX_END } from "../agent-protocol.js";

// The protocol is the ONE source of truth shared by the MCP instructions field and
// workspace_onboard. protocolBlock() is what the agent persists into its own config,
// so the marker contract (replace-in-place, removable) must hold.

describe("agent-protocol", () => {
  test("AGENT_PROTOCOL teaches the three reflexes + the traversal loop", () => {
    // reflex 1 = dead-end/constraint check before proposing; reflex 2 = traverse-not-search;
    // reflex 3 = maintain your own task status (the ONE agent write — only the agent
    // knows completion; the pipeline's heal/sweep are the net for passive hosts)
    assert.match(AGENT_PROTOCOL, /dead_end/i);
    assert.match(AGENT_PROTOCOL, /constraint/i);
    assert.match(AGENT_PROTOCOL, /TRAVERSE/);
    assert.match(AGENT_PROTOCOL, /YOURS TO MAINTAIN/);
    assert.match(AGENT_PROTOCOL, /workspace_task_update/);
    // the loop names the actual tools
    for (const t of ["workspace_tree", "workspace_filter", "workspace_search", "workspace_get"]) {
      assert.ok(AGENT_PROTOCOL.includes(t), `protocol must name ${t}`);
    }
    // "pipeline writes, you read" — don't-save framing
    assert.match(AGENT_PROTOCOL, /pipeline/i);
    // currency: supersede = the answer changed — the universal tier must teach it
    assert.match(AGENT_PROTOCOL, /superseded_by/);
    // meaning lives in content, not labels (name-drift is real — proven in the dogfood graph)
    assert.match(AGENT_PROTOCOL, /never.*label|label.*drift|names drift/i);
    // trust polarity: verifiable reality outranks memory
    assert.match(AGENT_PROTOCOL, /reality wins/i);
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
