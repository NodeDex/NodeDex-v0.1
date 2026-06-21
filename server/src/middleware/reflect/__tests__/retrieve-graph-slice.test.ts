import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  normalizePrimaryValue,
  scopeSegmentOfLabel,
  primaryValueTokenOverlap,
  isCatchAllScope,
} from "../retrieve-graph-slice.js";

describe("retrieve-graph-slice — pure helpers", () => {
  describe("normalizePrimaryValue", () => {
    it("strips backticks/quotes/trailing punctuation + collapses space", () => {
      assert.equal(
        normalizePrimaryValue("Server-side `reflectPaused` still works."),
        "server-side reflectpaused still works",
      );
    });
    it("makes two cosmetic variants of one value equal", () => {
      assert.equal(
        normalizePrimaryValue("Server-side `reflectPaused` works"),
        normalizePrimaryValue('server-side "reflectPaused"   works'),
      );
    });
    it("handles empty/nullish", () => {
      assert.equal(normalizePrimaryValue(""), "");
      // @ts-expect-error — defensive runtime check
      assert.equal(normalizePrimaryValue(undefined), "");
    });
  });

  describe("scopeSegmentOfLabel — owner read as discrete dimension, not soup", () => {
    it("returns the {project} segment before the first underscore", () => {
      assert.equal(scopeSegmentOfLabel("nodedex_event_server-side-reflectpaused-works"), "nodedex");
      assert.equal(scopeSegmentOfLabel("unspecified-project_fact_x"), "unspecified-project");
    });
    it("keeps multi-word hyphenated owner intact (does NOT split on hyphen)", () => {
      // The whole point: auth-service under CustomerA must read as one owner token,
      // not be flattened into ['auth','service'] word-soup.
      assert.equal(scopeSegmentOfLabel("customer-a_blueprint_auth-service"), "customer-a");
    });
    it("handles a label with no underscore", () => {
      assert.equal(scopeSegmentOfLabel("nodedex"), "nodedex");
    });
  });

  describe("primaryValueTokenOverlap — partial-identity (paraphrase) net", () => {
    it("is 1.0 for same tokens regardless of order/case/punct", () => {
      assert.equal(primaryValueTokenOverlap("reflectPaused still works", "works still reflectpaused"), 1);
    });
    it("is between 0 and 1 for partial overlap", () => {
      const o = primaryValueTokenOverlap("quadratic context risk untested", "quadratic context risk confirmed");
      assert.ok(o > 0 && o < 1, `expected partial, got ${o}`);
    });
    it("is 0 for disjoint values", () => {
      assert.equal(primaryValueTokenOverlap("vegan portioning constraint", "uncommitted state ignored"), 0);
    });
    it("ignores ≤2-char noise tokens", () => {
      // "a"/"is" dropped; only meaningful tokens count
      assert.equal(primaryValueTokenOverlap("a JWT is chosen", "JWT chosen"), 1);
    });
  });

  describe("isCatchAllScope — structural, not a sentinel list", () => {
    it("flags the explicit well-known marker", () => {
      assert.equal(isCatchAllScope("unspecified-project"), true);
    });
    it("flags a root whose ESSENCE advertises catch-all (structural signal)", () => {
      const roots = new Map([["misc-bucket", "Items without a specified project."]]);
      assert.equal(isCatchAllScope("misc-bucket", roots), true);
    });
    it("does NOT flag a real owner with a substantive essence", () => {
      const roots = new Map([["nodedex", "the overall Nodedex system"]]);
      assert.equal(isCatchAllScope("nodedex", roots), false);
    });
    it("does NOT flag an unknown scope absent any catch-all essence signal", () => {
      assert.equal(isCatchAllScope("customer-a", new Map()), false);
    });
  });
});
