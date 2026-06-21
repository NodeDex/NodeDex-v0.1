/**
 * Schema validator — pure-function tests.
 * Verifies type ↔ unique{} key-set matching per docs/reference/block-types.md.
 *
 * Run: node --import=tsx/esm --test src/middleware/reflect/__tests__/schema-validator.test.ts
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { validateUniqueSchema, schemaMismatchReason, TYPE_UNIQUE_SCHEMA, demoteForSave } from "../schema-validator.js";

// ─────────────────────────────────────────────────────────────────────────────
// Required keys present + no extras → ok
// ─────────────────────────────────────────────────────────────────────────────

describe("validateUniqueSchema — minimal valid shape per type", () => {
  test("decision with {choice} alone is valid (reason + alternatives_rejected optional)", () => {
    const r = validateUniqueSchema("decision", { choice: "FastAPI + Mangum" });
    assert.equal(r.ok, true);
  });

  test("dead_end with {approach, reason} is valid", () => {
    const r = validateUniqueSchema("dead_end", { approach: "Chalice", reason: "OpenAPI weak" });
    assert.equal(r.ok, true);
  });

  test("constraint with {limit} alone is valid", () => {
    const r = validateUniqueSchema("constraint", { limit: "Must use AWS Lambda" });
    assert.equal(r.ok, true);
  });

  test("blueprint with {purpose} alone is valid", () => {
    const r = validateUniqueSchema("blueprint", { purpose: "Evaluate Litestar" });
    assert.equal(r.ok, true);
  });

  test("chain with {arc, conclusion} is valid (verified 2026-05-24 — conclusion added e0e41b8)", () => {
    const r = validateUniqueSchema("chain", { arc: "fact -> dead_end -> decision", conclusion: "FastAPI adoption" });
    assert.equal(r.ok, true);
  });

  test("fact with {value, why_matters} is valid", () => {
    const r = validateUniqueSchema("fact", { value: "8s cold start", why_matters: "Too slow for API SLO" });
    assert.equal(r.ok, true);
  });

  // event = a timestamped OCCURRENCE; what_happened is the irreducible core,
  // outcome + date optional (causality lives in relations, not fields).
  test("event with {what_happened} alone is valid", () => {
    const r = validateUniqueSchema("event", { what_happened: "The build failed on cold start" });
    assert.equal(r.ok, true);
  });

  test("event with {what_happened, outcome, date} is valid", () => {
    const r = validateUniqueSchema("event", { what_happened: "Deploy ran", outcome: "succeeded", date: "2026-06-15" });
    assert.equal(r.ok, true);
  });

  test("event with the OLD `value` field is rejected (reconciled to what_happened 2026-06-15)", () => {
    const r = validateUniqueSchema("event", { value: "The build failed" });
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.ok(r.missing.includes("what_happened"), "should report what_happened missing");
      assert.ok(r.extras.includes("value"), "should report value as an extra");
    }
  });

  test("insight requires BOTH observation and implication", () => {
    const ok = validateUniqueSchema("insight", { observation: "X correlates with Y", implication: "Use X to predict Y" });
    assert.equal(ok.ok, true);
    const missing = validateUniqueSchema("insight", { observation: "X correlates with Y" });
    assert.equal(missing.ok, false);
    if (!missing.ok) assert.deepEqual(missing.missing, ["implication"]);
  });

  test("task requires status and description", () => {
    const r = validateUniqueSchema("task", { status: "open", description: "Set up FastAPI skeleton" });
    assert.equal(r.ok, true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The headline bug pattern: type=decision with unique={value, reason}
// This is the dead_end shape under a decision wrapper — exactly the
// pre-Tier-1A audit finding on 6 of 8 framework-choice decisions.
// ─────────────────────────────────────────────────────────────────────────────

describe("validateUniqueSchema — catches the type-vs-shape mismatch", () => {
  test("decision with {value, reason} (dead_end shape) is flagged", () => {
    const r = validateUniqueSchema("decision", { value: "Django/DRF", reason: "Too heavy for Lambda" });
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.deepEqual(r.missing, ["choice"]);
      assert.deepEqual(r.extras, ["value"]);
      assert.match(r.detail, /type=decision/);
      assert.match(r.detail, /missing=\[choice\]/);
      assert.match(r.detail, /extras=\[value\]/);
    }
  });

  test("dead_end with {choice, reason} (decision shape) is flagged", () => {
    const r = validateUniqueSchema("dead_end", { choice: "Litestar", reason: "Too new" });
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.deepEqual(r.missing, ["approach"]); // dead_end requires approach AND reason; reason is present
      assert.deepEqual(r.extras, ["choice"]);
    }
  });

  test("constraint with {approach, reason} (dead_end shape) is flagged", () => {
    const r = validateUniqueSchema("constraint", { approach: "Django", reason: "Too heavy" });
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.deepEqual(r.missing, ["limit"]);
      assert.deepEqual(r.extras.sort(), ["approach"]);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Empty / falsy / whitespace values are treated as missing (not "present")
// ─────────────────────────────────────────────────────────────────────────────

describe("validateUniqueSchema — empty values treated as missing", () => {
  test("null value treated as missing", () => {
    const r = validateUniqueSchema("decision", { choice: null });
    assert.equal(r.ok, false);
    if (!r.ok) assert.deepEqual(r.missing, ["choice"]);
  });

  test("undefined value treated as missing", () => {
    const r = validateUniqueSchema("decision", { choice: undefined });
    assert.equal(r.ok, false);
  });

  test("empty string treated as missing", () => {
    const r = validateUniqueSchema("decision", { choice: "" });
    assert.equal(r.ok, false);
    if (!r.ok) assert.deepEqual(r.missing, ["choice"]);
  });

  test("whitespace-only string treated as missing", () => {
    const r = validateUniqueSchema("decision", { choice: "   " });
    assert.equal(r.ok, false);
  });

  test("zero is treated as present (not missing)", () => {
    const r = validateUniqueSchema("constraint", { limit: 0 });
    assert.equal(r.ok, true);
  });

  test("false is treated as present (not missing)", () => {
    const r = validateUniqueSchema("preference", { lean: false });
    assert.equal(r.ok, true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Freeform / no-schema / unknown types pass without inspection
// ─────────────────────────────────────────────────────────────────────────────

describe("validateUniqueSchema — freeform and unknown types", () => {
  test("note with any unique{} passes (freeform)", () => {
    const r = validateUniqueSchema("note", { anything: "goes", more: "fields" });
    assert.equal(r.ok, true);
  });

  test("project with empty unique{} passes", () => {
    const r = validateUniqueSchema("project", {});
    assert.equal(r.ok, true);
  });

  test("process with empty unique{} passes", () => {
    const r = validateUniqueSchema("process", {});
    assert.equal(r.ok, true);
  });

  test("novel/unknown type passes (Pass 2 trusted for schema{})", () => {
    const r = validateUniqueSchema("stance", { position: "pro-async" });
    assert.equal(r.ok, true);
  });

  test("missing type label passes (cannot validate)", () => {
    assert.equal(validateUniqueSchema(undefined, { choice: "X" }).ok, true);
    assert.equal(validateUniqueSchema(null, { choice: "X" }).ok, true);
    assert.equal(validateUniqueSchema("", { choice: "X" }).ok, true);
  });

  test("null/undefined unique{} on a typed block flags missing required keys", () => {
    const r1 = validateUniqueSchema("decision", undefined);
    assert.equal(r1.ok, false);
    if (!r1.ok) assert.deepEqual(r1.missing, ["choice"]);
    const r2 = validateUniqueSchema("decision", null);
    assert.equal(r2.ok, false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// schemaMismatchReason helper
// ─────────────────────────────────────────────────────────────────────────────

describe("schemaMismatchReason", () => {
  test("returns null for ok results", () => {
    assert.equal(schemaMismatchReason({ ok: true }), null);
  });

  test("returns prefixed detail for mismatches", () => {
    const r = validateUniqueSchema("decision", { value: "Django", reason: "Too heavy" });
    const reason = schemaMismatchReason(r);
    assert.equal(typeof reason, "string");
    assert.match(reason!, /^schema_mismatch:/);
    assert.match(reason!, /type=decision/);
    assert.match(reason!, /missing=\[choice\]/);
    assert.match(reason!, /extras=\[value\]/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TYPE_UNIQUE_SCHEMA exposed for inspection (used by audits)
// ─────────────────────────────────────────────────────────────────────────────

describe("TYPE_UNIQUE_SCHEMA", () => {
  test("covers all 6 core permanent types from block-types.md", () => {
    for (const t of ["decision", "dead_end", "constraint", "blueprint", "chain", "preference"]) {
      assert.ok(TYPE_UNIQUE_SCHEMA[t], `${t} should be in TYPE_UNIQUE_SCHEMA`);
    }
  });

  test("freeform types have empty required AND optional arrays", () => {
    for (const t of ["note", "project", "process", "draft"]) {
      const s = TYPE_UNIQUE_SCHEMA[t];
      assert.ok(s);
      assert.equal(s.required.length, 0, `${t}.required should be empty`);
      assert.equal(s.optional.length, 0, `${t}.optional should be empty`);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// demoteForSave — Tier 1B demote-at-save (2026-06-12). Conservative contract:
// demote ONLY the exact case; everything else returns null → soft flag applies.
// ─────────────────────────────────────────────────────────────────────────────

describe("demoteForSave", () => {
  const LBL = "myproj_insight_some-finding";

  test("THE case: insight w/ observation, missing only implication → fact, observation→value, label renamed", () => {
    const d = demoteForSave("insight", { observation: "A and B imply trouble" }, LBL);
    assert.ok(d);
    assert.equal(d!.type, "fact");
    assert.deepEqual(d!.unique, { value: "A and B imply trouble" });
    assert.equal(d!.label, "myproj_fact_some-finding");
    assert.equal(d!.from_type, "insight");
  });

  test("valid insight (both fields) → null (nothing to repair)", () => {
    assert.equal(demoteForSave("insight", { observation: "o", implication: "i" }, LBL), null);
  });

  test("observation ALSO missing → null (worse failure, keep the flag)", () => {
    assert.equal(demoteForSave("insight", {}, LBL), null);
    assert.equal(demoteForSave("insight", { observation: "   " }, LBL), null);
  });

  test("extras present → null (shape fits neither type cleanly)", () => {
    assert.equal(demoteForSave("insight", { observation: "o", bonus: "x" }, LBL), null);
  });

  test("type without a DEMOTE_TARGETS row → null", () => {
    assert.equal(demoteForSave("decision", {}, "p_decision_x"), null);
    assert.equal(demoteForSave("task", { status: "open" }, "p_task_x"), null);
  });

  test("label missing the type segment → null (never half-demote: label/type must agree)", () => {
    assert.equal(demoteForSave("insight", { observation: "o" }, "weird-label-no-segment"), null);
  });

  test("null/undefined inputs → null", () => {
    assert.equal(demoteForSave(undefined, { observation: "o" }, LBL), null);
    assert.equal(demoteForSave("insight", { observation: "o" }, undefined), null);
    assert.equal(demoteForSave("insight", null, LBL), null);
  });
});
