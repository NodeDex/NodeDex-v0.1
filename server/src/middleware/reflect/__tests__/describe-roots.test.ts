// Unit tests for the DESCRIBER's pure logic (no DB, no LLM).
// Covers the lazy-selection rule + the prompt-input builder (the deterministic
// parts). The LLM call (describeRoot) and the timer are exercised separately /
// behind the default-OFF flag.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { Block } from "../../../store/database.js";
import {
  rootNeedsDescription,
  selectRootsNeedingDescription,
  buildDescribeInput,
  type RootDescribeInput,
} from "../describe-roots.js";

const OPTS = { minMembers: 2, growthThreshold: 5 };

// minimal Block stub — selection only reads memberCount/lastDescribedCount;
// root is passed through untouched.
function stubRoot(id: string): Block {
  return { id, label: id, type: "project", essence: "", content: "{}" } as unknown as Block;
}

describe("rootNeedsDescription", () => {
  test("below minMembers → false (1-member root has no domain yet)", () => {
    assert.equal(rootNeedsDescription({ memberCount: 1, lastDescribedCount: null }, OPTS), false);
  });

  test("never described + enough members → 'never'", () => {
    assert.equal(rootNeedsDescription({ memberCount: 2, lastDescribedCount: null }, OPTS), "never");
  });

  test("described, grew by >= threshold → 'grew'", () => {
    assert.equal(rootNeedsDescription({ memberCount: 8, lastDescribedCount: 3 }, OPTS), "grew");
  });

  test("described, grew by < threshold → false (lazy: don't churn)", () => {
    assert.equal(rootNeedsDescription({ memberCount: 6, lastDescribedCount: 3 }, OPTS), false);
  });

  test("described, no growth → false", () => {
    assert.equal(rootNeedsDescription({ memberCount: 4, lastDescribedCount: 4 }, OPTS), false);
  });
});

describe("selectRootsNeedingDescription", () => {
  test("filters to candidates and carries the reason", () => {
    const inputs: RootDescribeInput[] = [
      { root: stubRoot("a"), memberCount: 1, lastDescribedCount: null },  // too few → out
      { root: stubRoot("b"), memberCount: 3, lastDescribedCount: null },  // never → in
      { root: stubRoot("c"), memberCount: 9, lastDescribedCount: 3 },     // grew → in
      { root: stubRoot("d"), memberCount: 5, lastDescribedCount: 4 },     // grew<thresh → out
    ];
    const out = selectRootsNeedingDescription(inputs, OPTS);
    assert.equal(out.length, 2);
    assert.deepEqual(out.map((c) => c.root.id), ["b", "c"]);
    assert.equal(out.find((c) => c.root.id === "b")!.reason, "never");
    assert.equal(out.find((c) => c.root.id === "c")!.reason, "grew");
  });

  test("empty input → empty output", () => {
    assert.deepEqual(selectRootsNeedingDescription([], OPTS), []);
  });
});

describe("buildDescribeInput", () => {
  function stubMember(type: string, essence: string, concepts: string[]): Block {
    return { id: "m", label: "m", type, essence, concepts: JSON.stringify(concepts) } as unknown as Block;
  }

  test("includes label, current essence, and member lines", () => {
    const root = { id: "r", label: "home-coffee-roasting", type: "project", essence: "old blurb", content: "{}" } as unknown as Block;
    const members = [
      stubMember("decision", "Chose a fluid-bed roaster", ["fluid-bed roaster", "drum roaster"]),
      stubMember("constraint", "Outdoor only due to smoke", ["smoke", "ventilation"]),
    ];
    const out = buildDescribeInput(root, members, 40);
    assert.ok(out.includes("home-coffee-roasting"));
    assert.ok(out.includes("old blurb"));
    assert.ok(out.includes("[decision] Chose a fluid-bed roaster"));
    assert.ok(out.includes("fluid-bed roaster"));
  });

  test("caps the number of members shown", () => {
    const root = { id: "r", label: "p", type: "project", essence: "", content: "{}" } as unknown as Block;
    const members = Array.from({ length: 10 }, (_, i) => stubMember("fact", `fact ${i}`, []));
    const out = buildDescribeInput(root, members, 3);
    assert.ok(out.includes("showing 3"));
    assert.ok(out.includes("fact 0"));
    assert.ok(out.includes("fact 2"));
    assert.ok(!out.includes("fact 5"));
  });
});
