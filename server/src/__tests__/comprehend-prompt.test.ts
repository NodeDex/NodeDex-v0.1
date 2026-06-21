/**
 * COMPREHEND prompt invariants — the commitment boundary (decision vs blueprint).
 *
 * The stance-type definitions live in TWO prompt copies (COMPREHEND_PROMPT holistic
 * + PRODUCE_PROMPT per-group). This guards the load-bearing definitional sentences
 * against drift between the copies: a definition sharpened in one copy but not the
 * other reintroduces typing variance silently.
 *
 * These assert MEANING-bearing sentences, not signal words — per charter §5 the
 * definitions themselves are structural (who closed the fork); this test only pins
 * that the structural language is present in both copies.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { COMPREHEND_PROMPT } from "../middleware/reflect/comprehend.js";
import { PRODUCE_PROMPT, SEGMENT_PROMPT } from "../middleware/reflect/comprehend-pergroup.js";

const PROMPTS = {
  COMPREHEND_PROMPT,
  PRODUCE_PROMPT,
};

// The fork-closing invariants (2026-06-12 fix: offered-but-unconfirmed options were
// typed decision; the fork was never closed — see Test_transcript_multiTurn turn 3).
const INVARIANTS = [
  "PUT FORWARD for another to accept leaves the fork open",  // decision: proposing != closing
  "point at WHERE the fork closed",                          // decision: falsifiable test
  "put forward that no one has yet accepted",                // blueprint: carries the open fork
  "type the LESS-committed role",                            // calibration: type down when unclear
  // worth-test: observed evidence is residue, and conclusions must be grounded in it
  // (2026-06-15 — the aquarium arc dropped readings + left the hypothesis floating).
  "A conclusion's EVIDENCE is residue too",                  // keep the evidence behind conclusions
  "never drop a session-specific observation for lack of a link", // keep islands, heal later (pass3:145 lifted up)
  // worth-test: the agent CONSULTING its own memory (navigation/review) is not residue
  // (2026-06-17 — a pure-review transcript produced a "memory is complete" meta-insight).
  "reading memory is not an action in the work",             // navigation-meta is not residue
];

// Whitespace-insensitive: prompts hard-wrap at ~78 cols, and reflowing a
// definition must not break the invariant check.
const norm = (s: string) => s.replace(/\s+/g, " ");

describe("COMPREHEND stance definitions — commitment boundary in both prompt copies", () => {
  for (const [name, prompt] of Object.entries(PROMPTS)) {
    const flat = norm(prompt);
    for (const phrase of INVARIANTS) {
      test(`${name} carries: "${phrase}"`, () => {
        assert.ok(flat.includes(norm(phrase)), `${name} lost the definitional sentence: "${phrase}"`);
      });
    }
  }
});

// The root-NAMING rule (2026-06-14 group_1 regression fix): COMPREHEND must coin a
// SPECIFIC root name, never a placeholder/group_id. The rule lives in the two paths
// that assign provisional_project — COMPREHEND_PROMPT (holistic) + SEGMENT_PROMPT
// (per-group). PRODUCE never names the root, so it is NOT checked here.
const NAMING_PROMPTS = { COMPREHEND_PROMPT, SEGMENT_PROMPT };
const NAMING_INVARIANTS = [
  "most SPECIFIC identifier the session gives",  // the specificity rule (ported from Pass 0)
  "a placeholder, or the group_id",              // never name the root after the group_id
];

describe("COMPREHEND root-naming rule — specificity in both naming prompts", () => {
  for (const [name, prompt] of Object.entries(NAMING_PROMPTS)) {
    const flat = norm(prompt);
    for (const phrase of NAMING_INVARIANTS) {
      test(`${name} carries: "${phrase}"`, () => {
        assert.ok(flat.includes(norm(phrase)), `${name} lost the naming rule: "${phrase}"`);
      });
    }
  }
});
