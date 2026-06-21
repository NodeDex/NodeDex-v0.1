// routes/inject.ts — per-turn context injection for non-Claude-Code agents.
// Returns compact context (goals, dead ends, constraints, relevant blocks)
// that an agent framework can prepend to messages each turn.
//
// Used by:
//   - /api/chat proxy (internally, before forwarding to LLM)
//   - "Two-line mode" agents (direct HTTP call each turn)
//   - Any agent framework that wants Nodedex context without hooks

import { Router } from "express";
import { existsSync, readFileSync } from "fs";
import path from "path";
import { WorkspaceDB } from "../store/database.js";

// ─── Sticky.md parser ────────────────────────────────────────────────────────
function parseStickyFile(dataDir: string): Record<string, string> | null {
  // Try common locations for sticky.md
  const candidates = [
    path.resolve(dataDir, "../../sticky.md"),          // Nodedex/sticky.md
    path.resolve(dataDir, "../../../sticky.md"),        // project root sticky.md
  ];
  for (const p of candidates) {
    if (existsSync(p)) {
      try {
        const text = readFileSync(p, "utf8");
        const result: Record<string, string> = {};
        for (const line of text.split("\n")) {
          const match = line.match(/^(VISION|MACRO|MICRO|TASK|LAST|NAV):\s*(.+)/);
          if (match) result[match[1].toLowerCase()] = match[2].trim();
        }
        return Object.keys(result).length > 0 ? result : null;
      } catch { /* skip */ }
    }
  }
  return null;
}

export function createInjectRouter(db: WorkspaceDB, dataDir: string): Router {
  const router = Router();

  // ─── GET /api/agent-inject ─────────────────────────────────────────────────
  // Returns compact context for injection into an agent's prompt each turn.
  //
  // Query params:
  //   project  — project label (required for scoped results)
  //   agent_id — agent identifier (for session tracking)
  //   format   — "text" (default) or "json"
  router.get("/api/agent-inject", (req, res) => {
    try {
      const project  = (req.query.project as string) || "";
      const agentId  = (req.query.agent_id as string) || undefined;
      const format   = (req.query.format as string) || "text";

      if (agentId) db.registerAgent(agentId);

      const allBlocks = db.getAllBlocks();

      // ── Goals from sticky.md ────────────────────────────────────────
      const goals = parseStickyFile(dataDir);

      // ── Dead ends for this project ──────────────────────────────────
      const deadEnds = project
        ? allBlocks.filter(b =>
            b.type === "dead_end" &&
            b.status !== "archived" &&
            b.label.startsWith(project + "_")
          ).map(b => ({
            label: b.label,
            essence: (b.essence || "").slice(0, 120),
            unique: (() => {
              try {
                const c = typeof b.content === "string" ? JSON.parse(b.content) : b.content;
                return c?.unique ?? {};
              } catch { return {}; }
            })(),
          }))
        : [];

      // ── Constraints for this project ────────────────────────────────
      const constraints = project
        ? allBlocks.filter(b =>
            b.type === "constraint" &&
            b.status !== "archived" &&
            b.label.startsWith(project + "_")
          ).map(b => ({
            label: b.label,
            essence: (b.essence || "").slice(0, 120),
          }))
        : [];

      // ── Open tasks ──────────────────────────────────────────────────
      const openTasks = allBlocks.filter(b => {
        if (b.type !== "task" || b.status === "archived") return false;
        if (project && !b.label.startsWith(project + "_")) return false;
        try {
          const c = JSON.parse(b.content as string);
          return c?.unique?.status !== "done";
        } catch { return true; }
      }).map(b => ({
        label: b.label,
        essence: (b.essence || "").slice(0, 100),
      }));

      // ── Collect block IDs for pipeline reflectedIds tracking ────────
      const blockIds: string[] = [];
      for (const de of deadEnds) {
        const b = allBlocks.find(bl => bl.label === de.label);
        if (b) blockIds.push(b.id);
      }
      for (const c of constraints) {
        const b = allBlocks.find(bl => bl.label === c.label);
        if (b) blockIds.push(b.id);
      }
      for (const t of openTasks) {
        const b = allBlocks.find(bl => bl.label === t.label);
        if (b) blockIds.push(b.id);
      }

      // ── Format response ─────────────────────────────────────────────
      if (format === "json") {
        return res.json({
          goals,
          dead_ends: deadEnds,
          constraints,
          open_tasks: openTasks,
          block_ids: [...new Set(blockIds)],
          project: project || null,
        });
      }

      // Default: compact text format for direct injection
      const lines: string[] = [];

      if (goals) {
        lines.push("═══ GOALS ═══");
        if (goals.vision) lines.push(`VISION: ${goals.vision}`);
        if (goals.macro)  lines.push(`MACRO:  ${goals.macro}`);
        if (goals.micro)  lines.push(`MICRO:  ${goals.micro}`);
        if (goals.task)   lines.push(`TASK:   ${goals.task}`);
        lines.push("");
      }

      if (deadEnds.length > 0) {
        lines.push("═══ DEAD ENDS (do NOT re-propose these) ═══");
        for (const de of deadEnds) {
          const reason = de.unique?.reason ? ` — ${de.unique.reason}` : "";
          lines.push(`  ${de.label}: ${de.essence}${reason}`);
        }
        lines.push("");
      }

      if (constraints.length > 0) {
        lines.push("═══ CONSTRAINTS (cannot be overridden) ═══");
        for (const c of constraints) {
          lines.push(`  ${c.label}: ${c.essence}`);
        }
        lines.push("");
      }

      if (openTasks.length > 0) {
        lines.push("═══ OPEN TASKS ═══");
        for (const t of openTasks) {
          lines.push(`  ${t.label}: ${t.essence}`);
        }
        lines.push("");
      }

      // Reminders — critical rules that agents forget
      lines.push("═══ REMINDERS ═══");
      lines.push("• Check dead ends before proposing any approach");
      lines.push("• Reason in natural language — the pipeline extracts decisions, dead ends, and chains automatically");
      lines.push("• Traverse the graph — search is the entry point, not the answer");
      lines.push("• Does your current task trace back to VISION? If not, flag it.");

      const text = lines.join("\n");

      res.json({
        context: text,
        block_ids: [...new Set(blockIds)],
        project: project || null,
        char_count: text.length,
      });
    } catch (e) { res.status(500).json({ error: String(e) }); }
  });

  return router;
}
