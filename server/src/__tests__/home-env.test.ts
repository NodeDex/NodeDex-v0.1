// home-env.ts — ~/.nodedex/.env persistence (H2 increment 3).
// Run: node --import=tsx/esm --test src/__tests__/home-env.test.ts
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { parseEnvFile, applyUnsetEnv, loadHomeEnv } from "../home-env.js";
import { writeFileSync, unlinkSync } from "fs";
import { resolve } from "path";

describe("parseEnvFile", () => {
  test("parses KEY=VALUE, ignores blank lines + # comments", () => {
    const m = parseEnvFile("A=1\n\n# a comment\nB=hello world\n");
    assert.equal(m.get("A"), "1");
    assert.equal(m.get("B"), "hello world");
    assert.equal(m.size, 2);
  });
  test("first '=' splits; values may contain '='", () => {
    const m = parseEnvFile('NODEDEX_MODEL_CAPS={"x":1}\nURL=https://a.b/v1?q=1');
    assert.equal(m.get("URL"), "https://a.b/v1?q=1");
    assert.equal(m.get("NODEDEX_MODEL_CAPS"), '{"x":1}');
  });
  test("empty / garbage lines → no throw, only valid pairs", () => {
    assert.equal(parseEnvFile("").size, 0);
    assert.equal(parseEnvFile("noequalshere").size, 0);
  });
  test("strips trailing inline # comments, keeps a bare # in a value", () => {
    const m = parseEnvFile("N=2        # rolling-24h cap\nC=#ff0000\nU=https://a.b/v1?q=1");
    assert.equal(m.get("N"), "2", "inline comment stripped → Number() works");
    assert.equal(m.get("C"), "#ff0000", "bare # (no preceding space) kept");
    assert.equal(m.get("U"), "https://a.b/v1?q=1", "# absent → value untouched");
  });
});

describe("applyUnsetEnv — existing env WINS (precedence)", () => {
  const SET = "NODEDEX_TEST_SET_KEY";
  const UNSET = "NODEDEX_TEST_UNSET_KEY";
  afterEach(() => { delete process.env[SET]; delete process.env[UNSET]; });

  test("only fills keys not already set; returns count applied", () => {
    process.env[SET] = "original";
    const n = applyUnsetEnv(new Map([[SET, "from-file"], [UNSET, "new"]]));
    assert.equal(process.env[SET], "original", "an already-set env var must WIN over the file");
    assert.equal(process.env[UNSET], "new", "an unset key gets filled from the file");
    assert.equal(n, 1, "exactly one key applied");
  });
});

describe("loadHomeEnv", () => {
  const tmp = resolve("/tmp", `home-env-test-${process.pid}.env`);
  const KEY = "NODEDEX_TEST_HOME_KEY";
  afterEach(() => { try { unlinkSync(tmp); } catch { /* ignore */ } delete process.env[KEY]; });

  test("absent file → 0 applied, no throw", () => {
    assert.equal(loadHomeEnv(resolve("/tmp", "definitely-not-here-12345.env")), 0);
  });
  test("loads a real file, applying unset keys", () => {
    writeFileSync(tmp, `${KEY}=loaded\n`, "utf8");
    assert.equal(loadHomeEnv(tmp), 1);
    assert.equal(process.env[KEY], "loaded");
  });
  test("does NOT override an already-set key (env wins on restart too)", () => {
    process.env[KEY] = "preset";
    writeFileSync(tmp, `${KEY}=loaded\n`, "utf8");
    assert.equal(loadHomeEnv(tmp), 0);
    assert.equal(process.env[KEY], "preset");
  });
});
