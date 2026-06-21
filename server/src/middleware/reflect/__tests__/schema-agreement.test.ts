// schema-agreement.test.ts — the drift guard ($0).
//
// The extraction prompt (PASS2_PROMPT) teaches the model a per-type field cheat-sheet
// ("event { what_happened, outcome, date }"); the validator (TYPE_UNIQUE_SCHEMA)
// enforces a per-type schema at save. These are TWO representations of one truth, and
// when they drift, a correctly-extracted block gets wrongly flagged — the bug is
// upstream of the model (e.g. the 2026-06-15 `event` case: prompt said `what_happened`,
// validator required `value`). This test fails the build if they ever drift again:
//   - every field the prompt TEACHES must be ACCEPTED by the validator (no rejected field)
//   - every field the validator REQUIRES must be TAUGHT by the prompt (model can fill it)
// Lenient on validator-only OPTIONAL extras (e.g. metric's transitional `value`) — those
// are the validator being more permissive, which never causes a wrongful flag.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { PASS2_PROMPT } from "../pass2.js";
import { COMPREHEND_PROMPT } from "../comprehend.js";
import { PRODUCE_PROMPT } from "../comprehend-pergroup.js";
import { TYPE_UNIQUE_SCHEMA } from "../schema-validator.js";

// Parse the prompt's "typename { f1, f2, ... }" lines. The field guard ([a-z_, ])
// excludes JSON/examples (quotes, colons), and we keep only real schema types.
function parsePromptTypeFields(prompt: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const m of prompt.matchAll(/^\s*([a-z_]+)\s*\{\s*([a-z_, ]+?)\s*\}\s*$/gim)) {
    const type = m[1];
    if (!(type in TYPE_UNIQUE_SCHEMA)) continue;
    out[type] = m[2].split(",").map((s) => s.trim()).filter(Boolean);
  }
  return out;
}

describe("schema agreement: extraction prompt ↔ validator (drift guard)", () => {
  const promptFields = parsePromptTypeFields(PASS2_PROMPT);

  test("the prompt's type cheat-sheet parses (sanity)", () => {
    assert.ok(Object.keys(promptFields).length >= 10,
      `expected to parse the type cheat-sheet, got ${Object.keys(promptFields).length} types`);
  });

  for (const [type, schema] of Object.entries(TYPE_UNIQUE_SCHEMA)) {
    const taught = promptFields[type];
    if (!taught) continue; // freeform types (project/process/note) aren't in the cheat-sheet
    const allowed = new Set([...schema.required, ...schema.optional]);

    test(`${type}: every field the prompt teaches is accepted by the validator`, () => {
      for (const f of taught) {
        assert.ok(allowed.has(f),
          `prompt teaches '${type}.${f}' but the validator rejects it (not required/optional) — DRIFT`);
      }
    });

    test(`${type}: every field the validator requires is taught by the prompt`, () => {
      const t = new Set(taught);
      for (const req of schema.required) {
        assert.ok(t.has(req),
          `validator requires '${type}.${req}' but the prompt never teaches it — the model won't fill it`);
      }
    });
  }
});

// The v2 COMPREHEND/PRODUCE prompts teach the SAME per-type fields but as
// "typename {f1, f2} — prose" (a trailing description), so the line does not END at
// the brace — a looser anchor than PASS2's. Same intent: keep the prompt the model
// fills and the validator the save checks in agreement, so an OTHER-type block
// (event/task/entity/hypothesis) isn't wrongly flagged on the DEFAULT v2 engine.
function parseComprehendTypeFields(prompt: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const m of prompt.matchAll(/^\s*([a-z_]+)\s+\{([a-z_, ]+)\}/gim)) {
    const type = m[1];
    if (!(type in TYPE_UNIQUE_SCHEMA)) continue;
    out[type] = m[2].split(",").map((s) => s.trim()).filter(Boolean);
  }
  return out;
}

describe("schema agreement: v2 COMPREHEND/PRODUCE prompts ↔ validator (drift guard)", () => {
  for (const [label, prompt] of [
    ["COMPREHEND_PROMPT", COMPREHEND_PROMPT],
    ["PRODUCE_PROMPT", PRODUCE_PROMPT],
  ] as const) {
    const fields = parseComprehendTypeFields(prompt);

    test(`${label}: type cheat-sheet parses (sanity)`, () => {
      assert.ok(Object.keys(fields).length >= 6,
        `expected to parse ${label}'s cheat-sheet, got ${Object.keys(fields).length} types`);
    });

    for (const [type, schema] of Object.entries(TYPE_UNIQUE_SCHEMA)) {
      const taught = fields[type];
      if (!taught) continue;
      const allowed = new Set([...schema.required, ...schema.optional]);

      test(`${label} ${type}: taught fields are accepted by the validator`, () => {
        for (const f of taught) {
          assert.ok(allowed.has(f),
            `${label} teaches '${type}.${f}' but the validator rejects it — DRIFT`);
        }
      });

      test(`${label} ${type}: validator-required fields are taught`, () => {
        const t = new Set(taught);
        for (const req of schema.required) {
          assert.ok(t.has(req),
            `validator requires '${type}.${req}' but ${label} never teaches it`);
        }
      });
    }
  }
});
