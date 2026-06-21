/**
 * DEBT 5 Phase 4 (D2) — dedupBySourceAndValue tests
 *
 * Per design §2.5.1: identity for a block is (source_excerpt, primary_value),
 * NOT label or type. These tests verify:
 *   - dedup catches (source + value) twins
 *   - non-empty excerpt required (NULL/empty conservatively kept)
 *   - non-empty primary value required (defensive: don't collapse on source-only)
 *   - first-occurrence-wins preserves chronological order in arc input
 *   - per-type PRIMARY_KEYS extract the right field
 *   - novel/unknown type falls back to first non-empty value
 *   - duplicates[] reports id + duplicate_of + key
 *
 * Run: node --import=tsx/esm --test src/middleware/reflect/__tests__/dedup-by-source-and-value.test.ts
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { dedupBySourceAndValue, extractPrimaryValue } from "../dedup-by-source-and-value.js";
import type { Pass2Item } from "../types.js";

function mkItem(overrides: Partial<Pass2Item> & { id: string; type: string }): Pass2Item {
  return {
    text: "default text",
    triggered_by_items: [],
    based_on_items: [],
    ...overrides,
  } as Pass2Item;
}

// ─── extractPrimaryValue — per-type field lookup ─────────────────────────────

describe("extractPrimaryValue — type-specific primary field", () => {
  test("fact → unique.value", () => {
    const v = extractPrimaryValue(mkItem({ id: "i1", type: "fact", unique: { value: "the chosen value" } }));
    assert.equal(v, "the chosen value");
  });

  test("decision → unique.choice", () => {
    const v = extractPrimaryValue(mkItem({ id: "i2", type: "decision", unique: { choice: "go with X" } }));
    assert.equal(v, "go with X");
  });

  test("dead_end → legacy unique.dropped still resolves when no approach present", () => {
    const v = extractPrimaryValue(mkItem({ id: "i3", type: "dead_end", unique: { dropped: "buffet line", reason: "cross-contamination" } }));
    assert.equal(v, "buffet line", "dropped (legacy alias) resolves; reason is secondary");
  });

  test("dead_end without dropped → falls through to reason", () => {
    const v = extractPrimaryValue(mkItem({ id: "i4", type: "dead_end", unique: { reason: "fallback reason" } }));
    assert.equal(v, "fallback reason");
  });

  test("constraint → legacy unique.requirement still resolves when no limit present", () => {
    const v = extractPrimaryValue(mkItem({ id: "i5", type: "constraint", unique: { requirement: "must be gluten-free" } }));
    assert.equal(v, "must be gluten-free");
  });

  test("blueprint → unique.purpose", () => {
    const v = extractPrimaryValue(mkItem({ id: "i6", type: "blueprint", unique: { purpose: "deferred plan for X" } }));
    assert.equal(v, "deferred plan for X");
  });

  // ── canonical field wins over legacy/other (2026-06-07 schema sync) ──────────
  // These FAIL on the pre-sync PRIMARY_KEYS: the canonical identity field was either a
  // lucky alphabetical-fallback hit or — for insight/hypothesis/artifact — silently WRONG.
  test("constraint → unique.limit (canonical) wins over legacy requirement", () => {
    const v = extractPrimaryValue(mkItem({ id: "c1", type: "constraint", unique: { limit: "at-least-once delivery", requirement: "legacy wording", source: "contract" } }));
    assert.equal(v, "at-least-once delivery");
  });
  test("dead_end → unique.approach (canonical) wins over legacy dropped", () => {
    const v = extractPrimaryValue(mkItem({ id: "d1", type: "dead_end", unique: { approach: "inline sync delivery", dropped: "legacy", reason: "blocks threads" } }));
    assert.equal(v, "inline sync delivery");
  });
  test("insight → unique.observation (pre-sync fallback wrongly picked implication)", () => {
    const v = extractPrimaryValue(mkItem({ id: "in1", type: "insight", unique: { observation: "the queue is the bottleneck", implication: "scale the queue" } }));
    assert.equal(v, "the queue is the bottleneck");
  });
  test("preference → unique.lean (pre-sync had no entry)", () => {
    const v = extractPrimaryValue(mkItem({ id: "p1", type: "preference", unique: { lean: "visibility-first", over: "silent absorb" } }));
    assert.equal(v, "visibility-first");
  });
  test("hypothesis → unique.proposal (pre-sync fallback wrongly picked evidence_against)", () => {
    const v = extractPrimaryValue(mkItem({ id: "h1", type: "hypothesis", unique: { proposal: "batching will cut p99", evidence_for: "x", evidence_against: "y" } }));
    assert.equal(v, "batching will cut p99");
  });
  test("artifact → unique.path (pre-sync fallback wrongly picked description)", () => {
    const v = extractPrimaryValue(mkItem({ id: "a1", type: "artifact", unique: { path: "/docs/handoff.md", description: "the handoff doc" } }));
    assert.equal(v, "/docs/handoff.md");
  });

  test("novel/unknown type → first non-empty value alphabetically (stable)", () => {
    const v = extractPrimaryValue(mkItem({ id: "i7", type: "novel_custom_type", unique: { zeta: "z", alpha: "a", mid: "m" } }));
    assert.equal(v, "a", "alphabetically-first non-empty value wins (stable across runs)");
  });

  test("trims whitespace from primary value", () => {
    const v = extractPrimaryValue(mkItem({ id: "i8", type: "fact", unique: { value: "   spaced   " } }));
    assert.equal(v, "spaced");
  });

  test("returns empty string when no primary value found", () => {
    const v = extractPrimaryValue(mkItem({ id: "i9", type: "fact", unique: {} }));
    assert.equal(v, "");
  });

  test("returns empty string when unique{} is undefined", () => {
    const v = extractPrimaryValue(mkItem({ id: "i10", type: "fact" }));
    assert.equal(v, "");
  });
});

// ─── dedupBySourceAndValue — the core dedup ──────────────────────────────────

describe("dedupBySourceAndValue — (excerpt, primary_value) detect (FLAG, not drop)", () => {
  // SLICE 1 SUB-STEP 1.4 behavior change: this function no longer drops items;
  // it DETECTS duplicate candidates so pipeline.ts can write pipeline_flags
  // rows for the async LLM reviewer (Slice 2). `kept` ALWAYS equals input.
  test("identical (excerpt, primary_value) detected as duplicate; kept=input (NOT dropped)", () => {
    const items: Pass2Item[] = [
      mkItem({ id: "i1", type: "fact", excerpt: "The user has 30 guests.", unique: { value: "30 guests" } }),
      mkItem({ id: "i2", type: "fact", excerpt: "The user has 30 guests.", unique: { value: "30 guests" } }),
    ];
    const r = dedupBySourceAndValue(items);
    // FLAG-not-drop: both kept
    assert.equal(r.kept.length, 2, "Sub-step 1.4: kept = input (no auto-drop)");
    assert.deepEqual(r.kept.map(i => i.id), ["i1", "i2"]);
    // Duplicate-pair correctly detected
    assert.equal(r.duplicates.length, 1);
    assert.equal(r.duplicates[0]!.id, "i2", "second occurrence is the loser");
    assert.equal(r.duplicates[0]!.duplicate_of, "i1", "first occurrence is the winner");
  });

  test("same excerpt + DIFFERENT primary_value → both kept (different facts from same line)", () => {
    const items: Pass2Item[] = [
      mkItem({ id: "i1", type: "fact",       excerpt: "30 guests, 2 celiac, 1 vegan.", unique: { value: "30 guests" } }),
      mkItem({ id: "i2", type: "constraint", excerpt: "30 guests, 2 celiac, 1 vegan.", unique: { requirement: "2 celiac diners" } }),
    ];
    const r = dedupBySourceAndValue(items);
    assert.equal(r.kept.length, 2, "same source but different facts → KEEP BOTH");
    assert.equal(r.duplicates.length, 0);
  });

  test("DIFFERENT excerpt + same primary_value → both kept (different sources)", () => {
    const items: Pass2Item[] = [
      mkItem({ id: "i1", type: "fact", excerpt: "Source one mentions thirty guests.", unique: { value: "30 guests" } }),
      mkItem({ id: "i2", type: "fact", excerpt: "Source two also mentions thirty guests.", unique: { value: "30 guests" } }),
    ];
    const r = dedupBySourceAndValue(items);
    assert.equal(r.kept.length, 2, "same value but different sources → distinct claims");
    assert.equal(r.duplicates.length, 0);
  });

  test("empty excerpt items are NEVER deduped (pre-Debt-5 atomic convention)", () => {
    const items: Pass2Item[] = [
      mkItem({ id: "i1", type: "fact", excerpt: "", unique: { value: "30 guests" } }),
      mkItem({ id: "i2", type: "fact", excerpt: "", unique: { value: "30 guests" } }),
    ];
    const r = dedupBySourceAndValue(items);
    assert.equal(r.kept.length, 2, "empty excerpt → conservative: both kept");
    assert.equal(r.duplicates.length, 0);
  });

  test("missing excerpt (undefined) items are NEVER deduped", () => {
    const items: Pass2Item[] = [
      mkItem({ id: "i1", type: "fact", unique: { value: "30 guests" } }),
      mkItem({ id: "i2", type: "fact", unique: { value: "30 guests" } }),
    ];
    const r = dedupBySourceAndValue(items);
    assert.equal(r.kept.length, 2);
  });

  test("empty primary_value items are NEVER deduped (defensive)", () => {
    const items: Pass2Item[] = [
      mkItem({ id: "i1", type: "fact", excerpt: "Same source line here.", unique: {} }),
      mkItem({ id: "i2", type: "fact", excerpt: "Same source line here.", unique: {} }),
    ];
    const r = dedupBySourceAndValue(items);
    assert.equal(r.kept.length, 2, "empty primary value → can't establish identity → keep both");
  });

  test("whitespace-only differences in excerpt are normalized (trim) — DETECTED as duplicate", () => {
    const items: Pass2Item[] = [
      mkItem({ id: "i1", type: "fact", excerpt: "the chosen approach is X", unique: { value: "X" } }),
      mkItem({ id: "i2", type: "fact", excerpt: "  the chosen approach is X  ", unique: { value: "X" } }),
    ];
    const r = dedupBySourceAndValue(items);
    // Sub-step 1.4: kept=input (both), duplicate-pair detected via trim normalization
    assert.equal(r.kept.length, 2);
    assert.equal(r.duplicates.length, 1);
  });

  test("preserves chronological order for non-duplicates", () => {
    const items: Pass2Item[] = [
      mkItem({ id: "i1", type: "fact", excerpt: "first", unique: { value: "a" } }),
      mkItem({ id: "i2", type: "fact", excerpt: "second", unique: { value: "b" } }),
      mkItem({ id: "i3", type: "fact", excerpt: "third", unique: { value: "c" } }),
    ];
    const r = dedupBySourceAndValue(items);
    assert.deepEqual(r.kept.map((i) => i.id), ["i1", "i2", "i3"]);
  });

  test("multi-detect: 5 items, 2 duplicate pairs detected; kept=input (all 5)", () => {
    const items: Pass2Item[] = [
      mkItem({ id: "i1", type: "fact",     excerpt: "line A",   unique: { value: "A" } }),
      mkItem({ id: "i2", type: "decision", excerpt: "line B",   unique: { choice: "B" } }),
      mkItem({ id: "i3", type: "fact",     excerpt: "line A",   unique: { value: "A" } }),  // duplicate of i1
      mkItem({ id: "i4", type: "fact",     excerpt: "line C",   unique: { value: "C" } }),
      mkItem({ id: "i5", type: "decision", excerpt: "line B",   unique: { choice: "B" } }),  // duplicate of i2
    ];
    const r = dedupBySourceAndValue(items);
    // Sub-step 1.4: all 5 kept (no drop). Duplicate pairs detected for flag writes.
    assert.equal(r.kept.length, 5);
    assert.deepEqual(r.kept.map(i => i.id), ["i1", "i2", "i3", "i4", "i5"]);
    assert.deepEqual(r.duplicates.map(d => d.id).sort(), ["i3", "i5"]);
    // Each duplicate names its winner (first occurrence)
    assert.equal(r.duplicates.find(d => d.id === "i3")!.duplicate_of, "i1");
    assert.equal(r.duplicates.find(d => d.id === "i5")!.duplicate_of, "i2");
  });

  test("empty input returns empty result", () => {
    const r = dedupBySourceAndValue([]);
    assert.deepEqual(r.kept, []);
    assert.deepEqual(r.duplicates, []);
  });

  test("provider-variance scenario (D2 raison d'être): same source, different type assignment", () => {
    // Per [[project-pass1-pass2a-provider-drift-2026-05-30]]: same source line
    // produced 'blueprint' type one day, 'decision' type the next. D2 dedup is
    // SUPPOSED to recognize these as the SAME block — but only if primary
    // values match. Different types may pull different primary fields:
    //   blueprint → unique.purpose
    //   decision  → unique.choice
    // So even with same source, IF the LLM extracts different fields, dedup
    // misses. The user-visible effect: type-precision drift surfaces as
    // duplicate blocks. Phase 9's write-time dedup will add a fuzzy fallback;
    // this commit's pre-Pass-3 dedup is exact-match only.
    const items: Pass2Item[] = [
      mkItem({ id: "i_yesterday", type: "blueprint", excerpt: "Run family-style menu.", unique: { purpose: "family-style menu" } }),
      mkItem({ id: "i_today",     type: "decision",  excerpt: "Run family-style menu.", unique: { choice:  "family-style menu" } }),
    ];
    const r = dedupBySourceAndValue(items);
    // EXACT-MATCH semantics: blueprint pulls unique.purpose="family-style menu",
    // decision pulls unique.choice="family-style menu" — both same dedup key
    // (excerpt + "family-style menu"). Sub-step 1.4: DETECT (flag), not drop.
    assert.equal(r.kept.length, 2, "Sub-step 1.4: kept=input (no auto-drop); provider-variance flagged for reviewer");
    assert.equal(r.duplicates.length, 1, "duplicate-pair correctly detected across type-drift case");
    assert.equal(r.duplicates[0]!.id, "i_today");
    assert.equal(r.duplicates[0]!.duplicate_of, "i_yesterday");
  });
});
