import { readFileSync } from "node:fs";

/**
 * Wrap a pass's default prompt so the test harness can swap it for an alternative
 * without modifying source. If the named env var is set to a file path, the file
 * contents replace the default. Otherwise the default is used.
 *
 * Used by passN.ts:
 *   export const PASS1_PROMPT = withOverride("NODEDEX_TEST_PROMPT_PASS1", `…default prompt…`);
 *
 * The test harness (scripts/test-pipeline.mjs) sets NODEDEX_TEST_PROMPT_PASS1=path
 * when spawning the server. With no env var set, behaviour is identical to the
 * default — production paths are unaffected.
 */
export function withOverride(envVar: string, defaultPrompt: string): string {
  const path = process.env[envVar];
  if (!path) return defaultPrompt;
  try {
    const override = readFileSync(path, "utf8");
    console.log(`[promptOverride] ${envVar} → using override from ${path} (${override.length} chars)`);
    return override;
  } catch (e) {
    console.warn(`[promptOverride] failed to load ${envVar}=${path}: ${(e as Error).message} — using default`);
    return defaultPrompt;
  }
}
