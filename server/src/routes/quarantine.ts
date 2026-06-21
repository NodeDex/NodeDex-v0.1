// routes/quarantine.ts — READ-ONLY observability for the Pass-2-split audit quarantine.
//
// Purpose (debt-2 step 4, 2026-05-26): surface the `pass2_audit_quarantine` table
// so we can gather REAL data on what accumulates there before designing the full
// enrichment cycle (§§4-9 of DEBT2-ENRICHMENT-DESIGN.md). The reader API already
// exists in middleware/reflect/pass2-quarantine.ts; this just wires it to HTTP.
//
// SCOPE: read-only. No promote, no clarify, no writes. Those are the enrichment
// surface and wait on the §§4-9 design + empirical evidence this endpoint gathers.
//
// Visibility contract (PASS2-SPLIT-DESIGN §3): quarantine is an explicit opt-in
// surface, NEVER part of default agent navigation. These /api/quarantine/* routes
// ARE that explicit opt-in — they don't leak into /api/blocks, /api/tree, search.

import { Router } from "express";
import { WorkspaceDB } from "../store/database.js";
import {
  ensureQuarantineTable,
  getQuarantineEntry,
  getQuarantineEntries,
  summarizeQuarantine,
  type QuarantineFilters,
} from "../middleware/reflect/pass2-quarantine.js";

export function createQuarantineRouter(db: WorkspaceDB): Router {
  const router = Router();
  const raw = (db as any)["db"] as import("better-sqlite3").Database;

  // Idempotent: guarantees reads succeed even on a DB that never ran split-mode
  // (the table just comes back empty). CREATE IF NOT EXISTS — safe to call once here.
  ensureQuarantineTable(raw);

  // ─── Summary (tier-signal primitive) ──────────────────────────────────────
  // MUST be declared before /:id so "summary" isn't captured as an id.
  router.get("/api/quarantine/summary", (_req, res) => {
    try {
      res.json(summarizeQuarantine(raw));
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  // ─── List (filtered) ───────────────────────────────────────────────────────
  router.get("/api/quarantine", (req, res) => {
    try {
      const filters: QuarantineFilters = {};
      if (typeof req.query.batch_id === "string")          filters.batch_id = req.query.batch_id;
      if (typeof req.query.source_session_id === "string") filters.source_session_id = req.query.source_session_id;
      if (typeof req.query.failure_reason === "string")    filters.failure_reason = req.query.failure_reason;
      if (typeof req.query.queued_for_enrichment === "string") {
        filters.queued_for_enrichment = req.query.queued_for_enrichment === "true";
      }
      const entries = getQuarantineEntries(raw, filters);
      res.json({ count: entries.length, entries });
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  // ─── Single entry (full audit trail) ──────────────────────────────────────
  router.get("/api/quarantine/:id", (req, res) => {
    try {
      const entry = getQuarantineEntry(raw, req.params.id);
      if (!entry) return res.status(404).json({ error: `no quarantine entry ${req.params.id}` });
      res.json(entry);
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  return router;
}
