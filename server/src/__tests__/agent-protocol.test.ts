import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { AGENT_REFLEX, AGENT_PROTOCOL, protocolBlock, NODEDEX_BEGIN, NODEDEX_END } from "../agent-protocol.js";

// The protocol is delivered on TWO channels with DIFFERENT lifetimes, and the split is
// the load-bearing design:
//   • AGENT_REFLEX   — persisted into the agent's OWN standing config (AGENTS.md /
//     CLAUDE.md / rules file) → re-read EVERY TURN. Must stay SMALL; it is paid forever.
//   • AGENT_PROTOCOL — reflex + reference manual, on the MCP instructions field, ONCE
//     per connect → DECAYS.
// Measured 2026-07-12: an agent read the dead_end list at 12:17, authored the room data
// at 14:00, and shipped the exact bug the list warned about. Controlled tests showed it
// uses that same list perfectly when it HAS it. The failure was lifetime, not wording.

describe("agent-protocol — the reflex/reference split", () => {
  test("protocolBlock persists the REFLEX, not the whole manual (it is paid every turn)", () => {
    const block = protocolBlock();
    assert.ok(block.includes(AGENT_REFLEX), "the persisted block carries the reflex");
    assert.ok(!block.includes("── REFERENCE"), "the reference manual must NOT be persisted every turn");
    // Size guard: a reflex re-read on every turn, forever. If this fails, someone is
    // pushing the manual back into the every-turn channel.
    assert.ok(AGENT_REFLEX.length < 1600, `reflex must stay small, got ${AGENT_REFLEX.length} chars`);
  });

  test("AGENT_PROTOCOL = reflex + reference (one source of truth, no drift)", () => {
    assert.ok(AGENT_PROTOCOL.startsWith(AGENT_REFLEX), "the connect-time protocol opens with the same reflex");
    assert.ok(AGENT_PROTOCOL.includes("── REFERENCE"), "…and adds the manual behind it");
    assert.ok(AGENT_PROTOCOL.length > AGENT_REFLEX.length, "the manual is additive");
  });
});

describe("agent-protocol — the reflex's trigger design", () => {
  test("fires AT THE MOMENT of the decision, explicitly NOT at session start", () => {
    // The whole failure: the check ran once at 12:17 and the decision happened at 14:00.
    assert.match(AGENT_REFLEX, /AT THE MOMENT YOU COMMIT/i);
    assert.match(AGENT_REFLEX, /not once at session start/i);
  });

  test("the trigger moments are MECHANICAL, not self-classified", () => {
    // "before proposing an approach" requires the agent to notice it is proposing —
    // and momentum destroys that noticing. These are observable events instead.
    assert.match(AGENT_REFLEX, /before your first edit to a file/i);
    assert.match(AGENT_REFLEX, /change \/ replace \/ improve \/ fix/i);
    assert.match(AGENT_REFLEX, /choosing between implementation options/i);
  });

  test("the confidence clause is INVERTED — the trap is certainty, not doubt", () => {
    // Every earlier version said "when you suspect it may have failed before", which
    // requires DOUBT — and doubt is absent exactly when the agent is confidently about
    // to re-run a recorded dead-end.
    assert.match(AGENT_REFLEX, /WHEN THE ANSWER FEELS OBVIOUS/i);
    assert.ok(
      !/feels like it may have failed|suspect .* failed before/i.test(AGENT_REFLEX),
      "must not gate on doubt — that is the clause that never fires when it matters",
    );
  });

  test("ends in TRAVERSAL, and carries no graph data (so it scales)", () => {
    assert.match(AGENT_REFLEX, /TRAVERSE/);
    assert.match(AGENT_REFLEX, /workspace_get\(label, detail="relations"\)/);
    assert.match(AGENT_REFLEX, /chain is the story/i);
    // Data would not scale — a 500-block project cannot ride in every turn. Traversal
    // scales; the reflex's only job is to make the agent walk.
    for (const t of ["workspace_filter", "workspace_list", "workspace_get", "workspace_task_update"]) {
      assert.ok(AGENT_REFLEX.includes(t), `reflex must name ${t}`);
    }
    assert.match(AGENT_REFLEX, /dead_end/);
    assert.match(AGENT_REFLEX, /constraint/);
  });

  test("keeps the boundary: pipeline writes knowledge, the agent maintains only its task state", () => {
    assert.match(AGENT_REFLEX, /You do not write knowledge/i);
    assert.match(AGENT_REFLEX, /pipeline/i);
    assert.match(AGENT_REFLEX, /workspace_task_update/);
  });
});

describe("agent-protocol — the reference manual (per-connect)", () => {
  test("keeps the traversal loop, currency, and trust rules", () => {
    for (const t of ["workspace_tree", "workspace_filter", "workspace_search", "workspace_get"]) {
      assert.ok(AGENT_PROTOCOL.includes(t), `protocol must name ${t}`);
    }
    assert.match(AGENT_PROTOCOL, /superseded_by/);            // currency
    assert.match(AGENT_PROTOCOL, /names drift/i);              // judge content, not labels
    assert.match(AGENT_PROTOCOL, /reality wins/i);             // verifiable reality outranks memory
    assert.match(AGENT_PROTOCOL, /THIN block .* VALID/i);      // thin ≠ defect
  });
});

describe("agent-protocol — the marker contract", () => {
  test("exactly one removable, replace-in-place marker pair", () => {
    const block = protocolBlock();
    assert.ok(block.includes(NODEDEX_BEGIN) && block.includes(NODEDEX_END), "has both markers");
    assert.equal(block.split(NODEDEX_BEGIN).length - 1, 1, "exactly one begin marker");
    assert.equal(block.split(NODEDEX_END).length - 1, 1, "exactly one end marker");
    assert.ok(block.indexOf(NODEDEX_BEGIN) < block.indexOf(NODEDEX_END), "begin precedes end");
    assert.match(block, /remove|delete|opt out/i, "self-describing opt-out");
  });
});
