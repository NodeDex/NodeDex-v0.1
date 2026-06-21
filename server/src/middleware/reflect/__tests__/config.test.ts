/**
 * config.modelForPass — per-pass model routing (user-configurable, tier-based).
 *
 * Resolution: NODEDEX_PASS{ID}_MODEL override → tier var (REASONING/STRUCTURAL)
 * → undefined (provider default). Pure (reads env only).
 *
 * Run: node --import=tsx/esm --test src/middleware/reflect/__tests__/config.test.ts
 */
import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { modelForPass, type PassId } from "../config.js";

const VARS = [
  "NODEDEX_REASONING_MODEL", "NODEDEX_STRUCTURAL_MODEL",
  "NODEDEX_PASS0_MODEL", "NODEDEX_PASS1_MODEL", "NODEDEX_JUDGE_MODEL",
  "NODEDEX_PASS2A_MODEL", "NODEDEX_PASS2B_MODEL", "NODEDEX_PASS2C_MODEL",
  "NODEDEX_PASS3_MODEL", "NODEDEX_PASS4_MODEL", "NODEDEX_PASS5_MODEL",
];
const ALL: PassId[] = ["pass0", "pass1", "judge", "pass2a", "pass2b", "pass2c", "pass3", "pass4", "pass5"];
function clear() { for (const v of VARS) delete process.env[v]; }

describe("modelForPass — per-pass model resolution", () => {
  beforeEach(clear);

  test("nothing set → undefined (provider default) for every pass", () => {
    for (const p of ALL) assert.equal(modelForPass(p), undefined, `${p} default`);
  });

  test("REASONING_MODEL routes the reasoning tier (2a/2c/judge/3/4), not the others", () => {
    process.env.NODEDEX_REASONING_MODEL = "reason-model";
    for (const p of ["pass2a", "pass2c", "judge", "pass3", "pass4"] as PassId[]) assert.equal(modelForPass(p), "reason-model", p);
    for (const p of ["pass2b", "pass0", "pass1", "pass5"] as PassId[]) assert.equal(modelForPass(p), undefined, `${p} not reasoning`);
  });

  test("STRUCTURAL_MODEL routes the structural tier (2b/0) only", () => {
    process.env.NODEDEX_STRUCTURAL_MODEL = "cheap-model";
    for (const p of ["pass2b", "pass0"] as PassId[]) assert.equal(modelForPass(p), "cheap-model", p);
    for (const p of ["pass2a", "pass1", "pass5"] as PassId[]) assert.equal(modelForPass(p), undefined, `${p} not structural`);
  });

  test("per-pass override WINS over the tier", () => {
    process.env.NODEDEX_REASONING_MODEL = "reason-model";
    process.env.NODEDEX_PASS2A_MODEL = "pinned-2a";
    assert.equal(modelForPass("pass2a"), "pinned-2a", "per-pass override beats the tier");
    assert.equal(modelForPass("pass2c"), "reason-model", "other reasoning passes still take the tier");
  });

  test("blank/whitespace env values are ignored; real values are trimmed", () => {
    process.env.NODEDEX_PASS3_MODEL = "   ";
    process.env.NODEDEX_REASONING_MODEL = "  reason-trimmed  ";
    assert.equal(modelForPass("pass3"), "reason-trimmed", "blank per-pass ignored; tier value trimmed");
  });

  test("default-tier passes (1, 5) never take a tier var, but accept a per-pass override", () => {
    process.env.NODEDEX_REASONING_MODEL = "r";
    process.env.NODEDEX_STRUCTURAL_MODEL = "s";
    assert.equal(modelForPass("pass1"), undefined);
    assert.equal(modelForPass("pass5"), undefined);
    process.env.NODEDEX_PASS1_MODEL = "pinned-1";
    assert.equal(modelForPass("pass1"), "pinned-1");
  });
});
