// Unit tests for the RECOGNIZER's pure logic (no DB, no LLM).
// Covers guard #4 (decideAction: bias to NOT-attach), new-root-candidate
// extraction, the remap application, and the prompt-input builder. The LLM
// judgment (recognizeClusterRoot) + the wiring run behind NODEDEX_RECOGNIZER_ENABLED=1.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { Pass2Item } from "../types.js";
import {
  decideAction,
  newRootCandidateNames,
  applyRootRemap,
  buildRecognizeInput,
  type RecognizerVerdict,
  type KnownRoot,
} from "../recognize-root.js";

const KNOWN = new Set<string>(["home-coffee-roasting", "acme-billing"]);

function verdict(over: Partial<RecognizerVerdict>): RecognizerVerdict {
  return { decision: "attach", matched_root: "home-coffee-roasting", same_owner: true, shared_subject: "the user's home coffee-roasting setup", reasoning: "x", ...over };
}

describe("decideAction (guard #4 — bias to NOT-attach)", () => {
  test("confident attach to an existing root + same owner → attach", () => {
    assert.deepEqual(decideAction(verdict({}), KNOWN), { action: "attach", root: "home-coffee-roasting" });
  });

  test("decision='new' → keep (fork)", () => {
    assert.deepEqual(decideAction(verdict({ decision: "new", matched_root: "" }), KNOWN), { action: "keep" });
  });

  test("decision='uncertain' → keep (the safe fork)", () => {
    assert.deepEqual(decideAction(verdict({ decision: "uncertain" }), KNOWN), { action: "keep" });
  });

  test("attach but DIFFERENT owner → keep (scope guard #2)", () => {
    assert.deepEqual(decideAction(verdict({ same_owner: false }), KNOWN), { action: "keep" });
  });

  test("attach to a root that does NOT exist → keep (no hallucinated target)", () => {
    assert.deepEqual(decideAction(verdict({ matched_root: "no-such-root" }), KNOWN), { action: "keep" });
  });

  test("attach with empty matched_root → keep", () => {
    assert.deepEqual(decideAction(verdict({ matched_root: "" }), KNOWN), { action: "keep" });
  });

  test("attach with NO named shared subject → keep (guard #6 — unevidenced attach)", () => {
    assert.deepEqual(decideAction(verdict({ shared_subject: "" }), KNOWN), { action: "keep" });
  });

  test("attach with whitespace-only shared subject → keep (guard #6)", () => {
    assert.deepEqual(decideAction(verdict({ shared_subject: "   " }), KNOWN), { action: "keep" });
  });

  test("attach missing shared_subject field entirely → keep (older-shaped verdict)", () => {
    const v = verdict({});
    delete (v as any).shared_subject;
    assert.deepEqual(decideAction(v, KNOWN), { action: "keep" });
  });
});

describe("newRootCandidateNames", () => {
  const items = [
    { id: "1", project: "home-coffee-roasting" },       // existing root → skip
    { id: "2", project: "home-coffee-roasting-activities" }, // new → candidate
    { id: "3", project: "home-coffee-roasting-activities" }, // dup → once
    { id: "4", project: "garden" },                      // new → candidate
    { id: "5" },                                         // no project → skip
  ] as unknown as Pass2Item[];

  test("distinct project names not already roots, in order, deduped", () => {
    assert.deepEqual(
      newRootCandidateNames(items, KNOWN),
      ["home-coffee-roasting-activities", "garden"],
    );
  });

  test("no candidates when all projects are existing roots", () => {
    const allKnown = [{ id: "a", project: "acme-billing" }] as unknown as Pass2Item[];
    assert.deepEqual(newRootCandidateNames(allKnown, KNOWN), []);
  });
});

describe("applyRootRemap", () => {
  const items = [
    { id: "1", project: "home-coffee-roasting-activities", text: "a" },
    { id: "2", project: "home-coffee-roasting-activities", text: "b" },
    { id: "3", project: "garden", text: "c" },
  ] as unknown as Pass2Item[];

  test("rewrites only the matching project, returns count", () => {
    const { items: out, rewritten } = applyRootRemap(items, [
      { from: "home-coffee-roasting-activities", to: "home-coffee-roasting" },
    ]);
    assert.equal(rewritten, 2);
    assert.equal((out[0] as any).project, "home-coffee-roasting");
    assert.equal((out[1] as any).project, "home-coffee-roasting");
    assert.equal((out[2] as any).project, "garden"); // untouched
    // original array not mutated
    assert.equal((items[0] as any).project, "home-coffee-roasting-activities");
  });

  test("empty remap → same array, 0 rewritten", () => {
    const { items: out, rewritten } = applyRootRemap(items, []);
    assert.equal(rewritten, 0);
    assert.equal(out, items);
  });
});

describe("buildRecognizeInput", () => {
  const roots: KnownRoot[] = [
    { label: "home-coffee-roasting", essence: "Home coffee roasting — equipment and methods." },
    { label: "acme-billing", essence: "Billing decisions for client Acme." },
  ];
  const cluster = [
    { id: "1", type: "dead_end", text: "fluid-bed past second crack is a dead end" },
    { id: "2", type: "constraint", text: "not for very dark roasts" },
  ] as unknown as Pass2Item[];

  test("includes the proposed name, member lines, and root descriptions", () => {
    const out = buildRecognizeInput("home-coffee-roasting-activities", cluster, roots, 30, 40);
    assert.ok(out.includes("home-coffee-roasting-activities"));
    assert.ok(out.includes("[dead_end] fluid-bed past second crack"));
    assert.ok(out.includes("home-coffee-roasting: \"Home coffee roasting"));
    assert.ok(out.includes("acme-billing"));
  });

  test("caps roots and items", () => {
    const manyRoots = Array.from({ length: 5 }, (_, i) => ({ label: `r${i}`, essence: `e${i}` }));
    const out = buildRecognizeInput("p", cluster, manyRoots, 1, 2);
    assert.ok(out.includes("r0"));
    assert.ok(out.includes("r1"));
    assert.ok(!out.includes("r4")); // root cap = 2
    assert.ok(out.includes("[dead_end]"));
    assert.ok(!out.includes("[constraint]")); // item cap = 1
  });
});
