// ═══════════════════════════════════════════════════════════════════
// Archived tools — not registered
// These server.tool() blocks were removed from active registration.
// Preserved here for reference only.
// ═══════════════════════════════════════════════════════════════════

// ─────────────────────────────────────────────────────────────────
// FROM: core.ts
// ─────────────────────────────────────────────────────────────────

/*
  // ─── Tool: workspace_validate ────────────────────────────────────
  server.tool(
    "workspace_validate",
    `Signal whether a block's knowledge turned out to be correct, wrong, or outdated based on actual use.
This closes the learning loop — confidence adjusts based on real-world outcomes, not just save-time estimates.

Outcomes:
- "correct"  → knowledge was verified as accurate (+0.05 confidence, max 1.0)
- "useful"   → helped solve a problem even if not fully verified (+0.03)
- "wrong"    → information was factually incorrect (-0.25, recorded in history)
- "outdated" → was correct once but no longer applies (-0.15, marked stale)

Use after applying a recalled block to a task. Keeps the workspace self-correcting.`,
    {
      id:      z.string().describe("Block ID or label that was used"),
      outcome: z.enum(["correct", "useful", "wrong", "outdated"])
               .describe("What happened when you applied this knowledge"),
      note:    z.string().optional().describe("Optional context — what the block was used for, or why it was wrong"),
    },
    async (params) => {
      try {
        const block = db.getBlock(params.id);
        if (!block) return err("BLOCK_NOT_FOUND", `No block found: '${params.id}'`);

        const delta: Record<string, number> = {
          correct:  +0.05,
          useful:   +0.03,
          wrong:    -0.25,
          outdated: -0.15,
        };

        const newConf = Math.min(1.0, Math.max(0.0, block.confidence + delta[params.outcome]));
        const changes: Record<string, unknown> = { confidence: newConf };

        if (params.outcome === "outdated") {
          changes.status = "stale";
        }

        db.updateBlock(
          block.id,
          changes,
          `validate:${params.outcome}${params.note ? ` — ${params.note}` : ""}`,
        );

        // Close the feedback loop — mark this block as "used" in recall log
        db.markRecallUsed(block.id);

        return ok({
          id:            block.id,
          label:         block.label,
          outcome:       params.outcome,
          confidence_before: block.confidence,
          confidence_after:  newConf,
          status:        params.outcome === "outdated" ? "stale" : block.status,
          hint: params.outcome === "wrong"
            ? "Consider calling workspace_update to correct it, or workspace_forget to remove it."
            : params.outcome === "outdated"
            ? "Block marked stale. Update with workspace_update or remove with workspace_forget."
            : "Confidence updated. Keep using workspace_validate to keep knowledge accurate.",
        });
      } catch (error) {
        return err("VALIDATE_FAILED", String(error));
      }
    }
  );

  // ─── Tool: workspace_compare ─────────────────────────────────────
  server.tool(
    "workspace_compare",
    `Compare two or more blocks side-by-side on specified dimensions. Creates a temporary comparison block.`,
    {
      block_ids: z.array(z.string()).min(2).describe("Block IDs or labels to compare"),
      dimensions: z
        .array(z.string())
        .optional()
        .describe("Aspects to compare (e.g., ['cost', 'quality']). Auto-detected from block fields if omitted."),
    },
    async (params) => {
      try {
        // Load all blocks
        const blocks = [];
        for (const id of params.block_ids) {
          const block = db.getBlock(id);
          if (!block) return err("BLOCK_NOT_FOUND", `Block '${id}' not found`);
          blocks.push(block);
        }

        // Auto-detect dimensions from unique + has fields if not specified
        let dimensions = params.dimensions;
        if (!dimensions || dimensions.length === 0) {
          const allKeys = new Set<string>();
          for (const block of blocks) {
            const content = JSON.parse(block.content);
            if (content.unique) Object.keys(content.unique).forEach((k) => allKeys.add(k));
            if (content.has) Object.keys(content.has).forEach((k) => allKeys.add(k));
          }
          dimensions = Array.from(allKeys);
        }

        // Build comparison matrix
        const comparison: Record<string, Record<string, unknown>> = {};
        for (const dim of dimensions) {
          comparison[dim] = {};
          for (const block of blocks) {
            const content = JSON.parse(block.content);
            comparison[dim]![block.label] =
              content.unique?.[dim] || content.has?.[dim] || "—";
          }
        }

        // Create temp comparison block
        const comparisonBlock = db.createBlock({
          label: `compare_${blocks.map((b) => b.label).join("_vs_")}`.slice(0, 60),
          type: "note",
          essence: `Comparison of ${blocks.map((b) => b.label).join(" vs ")}`,
          content: {
            compared_blocks: blocks.map((b) => ({ id: b.id, label: b.label, type: b.type })),
            dimensions: comparison,
            compared_at: new Date().toISOString(),
          },
          ttl: "24hr",
          confidence: 0.9,
        });

        return ok({
          comparison_id: comparisonBlock.id,
          blocks: blocks.map((b) => ({ id: b.id, label: b.label, essence: b.essence })),
          dimensions: comparison,
          ttl: "24hr (use workspace_promote to keep)",
        });
      } catch (error) {
        return err("COMPARE_FAILED", String(error));
      }
    }
  );

  // ─── Tool: workspace_restore ─────────────────────────────────────
  server.tool(
    "workspace_restore",
    `Restore a block's essence or content to a previous state using a history entry.
Use workspace_history(block_id) first to find the history entry ID to restore from.
Useful when an update introduced wrong information and you need to undo it.`,
    {
      block_id:        z.string().describe("Block ID or label to restore"),
      history_entry_id: z.string().describe("History entry ID to restore from (from workspace_history)"),
    },
    async (params) => {
      try {
        const block = db.getBlock(params.block_id);
        if (!block) return err("BLOCK_NOT_FOUND", `No block found: '${params.block_id}'`);

        // Find the history entry
        const history = db.getHistory(block.id, 100);
        const entry = history.find((h) => h.id === params.history_entry_id);
        if (!entry) {
          return err("HISTORY_NOT_FOUND",
            `History entry '${params.history_entry_id}' not found for block '${block.label}'. ` +
            `Call workspace_history('${block.id}') to see available entries.`
          );
        }

        // Try to extract the snapshot (stored for essence/content changes)
        let restoredField = entry.field_changed;
        let restoredValue = entry.old_value;

        if ((entry.field_changed === "essence" || entry.field_changed === "content") && entry.old_value) {
          try {
            const parsed = JSON.parse(entry.old_value);
            if (parsed.snapshot) {
              // Full snapshot stored — restore entire block state
              const snap = JSON.parse(parsed.snapshot);
              const restoreChanges: Record<string, unknown> = {
                essence: snap.essence,
                content: snap.content,
              };
              db.updateBlock(block.id, restoreChanges,
                `restored from history entry ${params.history_entry_id}`, undefined, true);
              return ok({
                restored: true,
                block_id: block.id,
                label:    block.label,
                restored_field: "essence+content (full snapshot)",
                from_entry: params.history_entry_id,
              });
            } else if (parsed.field_value !== undefined) {
              restoredValue = parsed.field_value;
            }
          } catch { /* use raw old_value */ }
        }

        if (!restoredValue) {
          return err("NO_SNAPSHOT", "History entry has no restorable value. This field may not have been snapshotted.");
        }

        const restoreChanges: Record<string, unknown> = { [restoredField]: restoredValue };
        db.updateBlock(block.id, restoreChanges,
          `restored field '${restoredField}' from history entry ${params.history_entry_id}`,
          undefined, true);

        return ok({
          restored: true,
          block_id:       block.id,
          label:          block.label,
          restored_field: restoredField,
          restored_value: restoredValue.length > 100 ? restoredValue.slice(0, 100) + "..." : restoredValue,
          from_entry:     params.history_entry_id,
        });
      } catch (error) {
        return err("RESTORE_FAILED", String(error));
      }
    }
  );

  // ─── Tool: workspace_recall_stats ────────────────────────────────
  server.tool(
    "workspace_recall_stats",
    `Show recall precision stats: which blocks are recalled most vs. actually used.
Blocks with low precision (recalled often, used rarely) are noise candidates.
Use this to audit recall quality and decide what to archive or improve.`,
    {
      limit: z.number().optional().describe("Max blocks to return. Default: 20"),
    },
    async (params) => {
      try {
        const stats = db.getRecallStats(params.limit ?? 20);

        const noisy   = stats.filter((s) => s.recall_count >= 3 && s.precision < 0.2);
        const precise = stats.filter((s) => s.recall_count >= 3 && s.precision >= 0.8);
        const unused  = stats.filter((s) => s.recall_count >= 5 && s.use_count === 0);

        return ok({
          total_tracked: stats.length,
          all:           stats,
          analysis: {
            high_noise:    noisy.map((s) => ({ id: s.block_id, label: s.label, recalled: s.recall_count, used: s.use_count })),
            high_precision: precise.slice(0, 5).map((s) => ({ id: s.block_id, label: s.label, precision: s.precision })),
            never_used_but_recalled: unused.map((s) => ({ id: s.block_id, label: s.label, recalled: s.recall_count })),
          },
          hint: noisy.length > 0
            ? `${noisy.length} noisy block(s) detected. Consider archiving or lowering their confidence.`
            : "Recall precision looks healthy.",
        });
      } catch (error) {
        return err("RECALL_STATS_FAILED", String(error));
      }
    }
  );

  // ─── Tool: workspace_checkpoint ──────────────────────────────────
  server.tool(
    "workspace_checkpoint",
    `Record what was learned this turn and get forward-looking suggestions for what to explore next.
Turns the system from purely backward-looking (what do you know?) into forward-looking (what should you find out next?).

Use at natural breakpoints: after solving a problem, after research, before ending a long session.

What it does:
1. Saves any new facts you provide (one call — no round trips)
2. Auto-derives a synthesis block if 2+ facts are saved
3. Returns suggested_next: underexplored concepts + open project questions

The forward signal: it finds concepts that appear in only one block (no depth yet) and surfaces them as research leads.`,
    {
      summary: z.string().describe("One sentence: what was accomplished or learned this turn"),
      facts: z.array(z.object({
        label:    z.string().describe("Block label (lowercase_underscore)"),
        essence:  z.string().describe("One-line description"),
        type:     z.string().optional().describe("Block type: fact, decision, note, etc."),
        concepts: z.array(z.string()).optional().describe("Abstract concept tags"),
        ttl:      z.enum(["session","1hr","24hr","1week","project","permanent"]).optional().describe("TTL override. Default: permanent. Use '1week' for research/test session facts that are not product knowledge."),
      })).optional().describe("New facts to save as permanent blocks (optional)"),
      project_id:   z.string().optional().describe("Project to link facts to and scope suggestions from"),
      derive:       z.boolean().optional().describe("Auto-derive a synthesis block if 2+ facts saved. Default: true"),
      canvas_entry: z.string().optional().describe("Reasoning step label stamped on all blocks saved this checkpoint — e.g. 'Step 2: Core paradox identified'. Appended to session canvas log at GET /api/session/canvas."),
    },
    async (params) => {
      try {
        const saved: Array<{ id: string; label: string }> = [];

        // ── 1. Save new facts ─────────────────────────────────────
        for (const fact of (params.facts || [])) {
          const embedding = await embeddings.embed(fact.essence);
          const factContent: Record<string, unknown> = {};
          if (params.canvas_entry) {
            factContent.save_context = { reasoning_step: params.canvas_entry };
          }
          const block = db.createBlock({
            label:     fact.label,
            type:      fact.type || "fact",
            essence:   fact.essence,
            content:   factContent,
            concepts:  fact.concepts || [],
            ttl:       fact.ttl || "permanent",
            confidence: 0.8,
            embedding: embedding || undefined,
          });
          if (params.project_id) {
            const project = db.getBlock(params.project_id);
            if (project) db.createRelation({ source_id: block.id, target_id: project.id, type: "part_of" });
          }
          // Compute quality score so block surfaces in recall (not filtered as quality_score=0)
          const factConcepts = fact.concepts || [];
          let factQScore = 1; // essence present
          // is_a and unique not provided in checkpoint — skip those points
          // has{}: auto-grant for non-process (checkpoint facts don't have has{})
          if ((fact.type || "fact") !== "process") factQScore++;
          if (factConcepts.length >= 3) factQScore++;
          if (params.project_id) factQScore++; // will have a relation
          db.updateBlock(block.id, { quality_score: factQScore });

          saved.push({ id: block.id, label: block.label });
        }

        // ── 2. Auto-derive synthesis ──────────────────────────────
        let derived: { id: string; label: string; essence: string } | null = null;
        if (params.derive !== false && saved.length >= 2) {
          const inputs = saved.map(b => db.getBlock(b.id)).filter(Boolean) as any[];
          const concepts = new Set<string>();
          for (const b of inputs) {
            try { (JSON.parse(b.concepts || "[]") as string[]).forEach(c => concepts.add(c)); } catch { /* skip */ }
          }
          const synthBlock = db.createBlock({
            label:     `checkpoint_${Date.now().toString(36)}`,
            type:      "note",
            essence:   params.summary,
            content:   {
              derivation: {
                inputs:     inputs.map(b => ({ id: b.id, label: b.label, essence: b.essence })),
                logic:      "Auto-synthesized at checkpoint",
                derived_at: new Date().toISOString(),
              },
            },
            concepts:   [...concepts].slice(0, 8),
            ttl:        "permanent",
            confidence: 0.8,
          });
          for (const b of inputs) {
            db.createRelation({ source_id: synthBlock.id, target_id: b.id, type: "derived_from" });
          }
          if (params.project_id) {
            const project = db.getBlock(params.project_id);
            if (project) db.createRelation({ source_id: synthBlock.id, target_id: project.id, type: "part_of" });
          }
          // Quality score for the synthesis block — has derivation (satisfies recall filter)
          const synthConcepts = [...concepts].slice(0, 8);
          let synthQScore = 1; // essence
          synthQScore++; // has{} auto-grant (non-process)
          if (synthConcepts.length >= 3) synthQScore++;
          synthQScore++; // has derived_from relations
          db.updateBlock(synthBlock.id, { quality_score: synthQScore });

          derived = { id: synthBlock.id, label: synthBlock.label, essence: synthBlock.essence };
        }

        // ── 3. Forward signal: find underexplored concepts ────────
        // Concepts that appear in only 1 block are "thin" — good leads for deeper research
        const newConcepts = new Set<string>();
        for (const s of saved) {
          const b = db.getBlock(s.id);
          if (b) {
            try { (JSON.parse((b as any).concepts || "[]") as string[]).forEach(c => newConcepts.add(c)); } catch { /* skip */ }
          }
        }
        const allBlocks = db.getAllBlocks();
        const conceptCounts = new Map<string, number>();
        for (const b of allBlocks) {
          try { (JSON.parse((b as any).concepts || "[]") as string[]).forEach(c => conceptCounts.set(c, (conceptCounts.get(c) || 0) + 1)); } catch { /* skip */ }
        }
        const underexplored = [...newConcepts]
          .filter(c => (conceptCounts.get(c) || 0) <= 1)
          .slice(0, 3)
          .map(c => `Explore concept with only one block: "${c}"`);

        // Also surface open questions from the project block
        const projectQuestions: string[] = [];
        if (params.project_id) {
          const project = db.getBlock(params.project_id);
          if (project) {
            try {
              const content = JSON.parse(project.content);
              const qs: string[] = content?.has?.next_questions || [];
              projectQuestions.push(...qs.slice(0, 3).map(q => `Open question: ${q}`));
            } catch { /* skip */ }
          }
        }

        const suggestedNext = [...underexplored, ...projectQuestions];

        // ── 4. Append canvas entry to session canvas log ──────────
        if (params.canvas_entry) {
          try {
            const { appendFileSync } = await import("fs");
            const { resolve, dirname } = await import("path");
            const { fileURLToPath } = await import("url");
            const dataDir = resolve(dirname(fileURLToPath(import.meta.url)), "../../../data");
            const canvasLog = resolve(dataDir, "session_canvas.jsonl");
            const entry = JSON.stringify({
              reasoning_step: params.canvas_entry,
              summary: params.summary,
              block_labels: saved.map(b => b.label),
              timestamp: new Date().toISOString(),
            }) + "\n";
            appendFileSync(canvasLog, entry, "utf8");
          } catch { /* non-fatal */ }
        }

        return ok({
          checkpoint:     params.summary,
          canvas_entry:   params.canvas_entry || null,
          saved_blocks:   saved,
          derived,
          ...(suggestedNext.length ? { suggested_next: suggestedNext } : {}),
        });
      } catch (error) {
        return err("CHECKPOINT_FAILED", String(error));
      }
    }
  );

  // ─── Tool: workspace_write_log ───────────────────────────────────
  server.tool(
    "workspace_write_log",
    `View the audit trail of all writes to the workspace database.
Captures INSERT and UPDATE operations on blocks and relations via SQLite triggers —
including direct SQL writes that bypass the MCP tools.
Use this to debug unexpected changes or verify that writes happened.`,
    {
      limit: z.number().optional().describe("Number of entries to return. Default: 30"),
      table: z.enum(["blocks", "relations", "all"]).optional().describe("Filter by table. Default: all"),
    },
    async (params) => {
      try {
        const entries = db.getWriteLog(params.limit ?? 30);
        const filtered = params.table && params.table !== "all"
          ? entries.filter(e => e.table_name === params.table)
          : entries;
        return ok({
          count: filtered.length,
          entries: filtered.map(e => ({
            ...e,
            snapshot: (() => { try { return JSON.parse(e.snapshot); } catch { return e.snapshot; } })(),
          })),
        });
      } catch (error) {
        return err("WRITE_LOG_FAILED", String(error));
      }
    }
  );

  // ─── Tool: workspace_quick_save ──────────────────────────────────
  server.tool(
    "workspace_quick_save",
    `Lowest-friction save. Write one sentence — the system builds the full block.

Use mid-thought when you notice something worth keeping but don't want to break focus.
Gemini auto-generates: label, type, is_a, unique{}, concepts[].
You just provide the insight.

Examples:
  workspace_quick_save({ sentence: "IDF filter prevents product blocks bridging to research via generic tags" })
  workspace_quick_save({ sentence: "recall-chain returns 0 when derive blocks have quality_score=0", type_hint: "dead_end" })
  workspace_quick_save({ sentence: "auto-link confidence 0.3 keeps relations inert until Gemini validates", context: "debugging false link creation" })

After saving, the block is live in recall. If the result is wrong, workspace_update(id) to fix it.`,
    {
      sentence:  z.string().describe("One sentence: what did you just find, decide, notice, or rule out?"),
      type_hint: z.enum(["fact","decision","insight","constraint","dead_end"]).optional().describe("Block type hint — Gemini will infer if omitted"),
      context:   z.string().optional().describe("Optional: what were you doing when this insight occurred? Helps Gemini pick better concepts."),
    },
    async ({ sentence, type_hint, context }) => {
      try {
        const resp = await fetch("http://localhost:3001/api/quick-save", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: sentence, type_hint, context }),
          signal: AbortSignal.timeout(8000),
        });
        if (!resp.ok) return err("QUICK_SAVE_FAILED", await resp.text());
        const data = await resp.json() as { id: string; label: string; type: string; essence: string; is_a: string; concepts: string[]; quality_score: number };
        return ok({
          saved: true,
          id: data.id,
          label: data.label,
          type: data.type,
          essence: data.essence,
          is_a: data.is_a,
          concepts: data.concepts,
          quality_score: data.quality_score,
          note: data.quality_score < 3 ? "Block is thin — call workspace_review(id) or workspace_update to add has{} and relations" : "Block saved. Link cause via prompted_by relation if not already set.",
        });
      } catch (error) {
        return err("QUICK_SAVE_FAILED", String(error));
      }
    }
  );
*/

// ─────────────────────────────────────────────────────────────────
// FROM: derive.ts
// ─────────────────────────────────────────────────────────────────

/*
  // ─── Tool: workspace_branch ──────────────────────────────────────
  server.tool(
    "workspace_branch",
    `Create a what-if copy of a block for hypothetical exploration. Modify the branch without affecting the original.`,
    {
      id: z.string().describe("Block ID or label to branch from"),
      modifications: z
        .record(z.string(), z.string())
        .optional()
        .describe("Fields to change in the branch (unique properties to modify)"),
      hypothesis: z.string().optional().describe("What-if scenario description"),
    },
    async (params) => {
      try {
        const original = db.getBlock(params.id);
        if (!original) return err("BLOCK_NOT_FOUND", `Block '${params.id}' not found`);

        const originalContent = JSON.parse(original.content);

        // Apply modifications to unique fields
        const branchedContent = { ...originalContent };
        if (params.modifications) {
          branchedContent.unique = { ...(originalContent.unique || {}), ...params.modifications };
        }
        if (params.hypothesis) {
          branchedContent.hypothesis = params.hypothesis;
        }

        const branch = db.createBlock({
          label: `branch_${original.label}`.slice(0, 60),
          type: original.type,
          essence: params.hypothesis || `What-if branch of ${original.label}`,
          content: branchedContent,
          ttl: "session",
          confidence: 0.6, // lower confidence — it's hypothetical
        });

        // Link to original
        db.createRelation({
          source_id: branch.id,
          target_id: original.id,
          type: "branched_from",
          bidirectional: false,
        });

        return ok({
          branch_id: branch.id,
          original_id: original.id,
          original_label: original.label,
          modifications: params.modifications,
          hypothesis: params.hypothesis,
          ttl: "session (use workspace_promote to keep)",
        });
      } catch (error) {
        return err("BRANCH_FAILED", String(error));
      }
    }
  );
*/

// ─────────────────────────────────────────────────────────────────
// FROM: system.ts
// ─────────────────────────────────────────────────────────────────

/*
  // ─── Tool: workspace_share ───────────────────────────────────────
  server.tool(
    "workspace_share",
    `Mark a block as intentionally shared/published. Useful in multi-agent environments to broadcast knowledge.`,
    {
      id: z.string().describe("Block ID or label to share"),
      recipient: z.string().optional().describe("Tag a specific agent role or 'all'"),
    },
    async (params) => {
      try {
        const block = db.getBlock(params.id);
        if (!block) return err("BLOCK_NOT_FOUND", `Block '${params.id}' not found`);

        const changes = {
          shared_with: params.recipient || "all",
        };

        const content = JSON.parse(block.content);
        db.updateBlock(block.id, { content: { ...content, ...changes } }, "Shared with " + (params.recipient || "all"));

        return ok({
          shared: true,
          id: block.id,
          recipient: params.recipient || "all",
        });
      } catch (error) {
        return err("SHARE_FAILED", String(error));
      }
    }
  );

  // ─── Tool: workspace_claim ───────────────────────────────────────
  server.tool(
    "workspace_claim",
    `Atomically claim a task or block for exclusive work. Guaranteed race-free — only one agent can claim at a time.
Claims expire after ttl_seconds (default: 300s / 5 min). Release with workspace_claim when done, or it expires automatically.
Always call workspace_heartbeat regularly while working on a claimed task so others know you're still alive.`,
    {
      id: z.string().describe("Block ID or label to claim"),
      agent_id: z.string().describe("Your agent name or ID"),
      ttl_seconds: z.number().optional().describe("How long to hold the claim in seconds (default: 300)"),
    },
    async (params) => {
      try {
        const block = db.getBlock(params.id);
        if (!block) return err("BLOCK_NOT_FOUND", `Block '${params.id}' not found`);

        const result = db.claimBlock(block.id, params.agent_id, params.ttl_seconds ?? 300);

        if (!result.claimed) {
          return err("ALREADY_CLAIMED",
            `Block '${block.label}' is already claimed by agent '${result.claimed_by}'. ` +
            `Wait for it to be released or expire before claiming.`,
            { claimed_by: result.claimed_by }
          );
        }

        // Register heartbeat so others can see this agent is alive
        db.agentHeartbeat(params.agent_id, "worker", block.label);

        return ok({
          claimed: true,
          id: block.id,
          label: block.label,
          claimed_by: params.agent_id,
          expires_at: result.expires_at,
          reminder: "Call workspace_heartbeat every 60s while working. Release with workspace_claim when done.",
        });
      } catch (error) {
        return err("CLAIM_FAILED", String(error));
      }
    }
  );

  // ─── Tool: workspace_heartbeat ───────────────────────────────────
  server.tool(
    "workspace_heartbeat",
    `Register your agent as alive and update your current task. Call every ~60s while working on a claimed task.
Agents that stop heartbeating are considered gone — their claims expire and tasks become available again.`,
    {
      agent_id: z.string().describe("Your agent name or ID"),
      role: z.string().optional().describe("Your role (e.g. 'researcher', 'coder', 'reviewer')"),
      current_task: z.string().optional().describe("What you are currently working on"),
    },
    async (params) => {
      try {
        db.agentHeartbeat(params.agent_id, params.role || "general", params.current_task);
        const activeAgents = db.getActiveAgents();
        return ok({
          registered: true,
          agent_id: params.agent_id,
          active_agents: activeAgents.map(a => ({
            id: a.agent_id, role: a.role,
            task: a.current_task, last_seen: a.last_heartbeat,
          })),
        });
      } catch (error) {
        return err("HEARTBEAT_FAILED", String(error));
      }
    }
  );

  // ─── Tool: workspace_orient ──────────────────────────────────────
  server.tool(
    "workspace_orient",
    `Establish your agent identity AND get a workspace briefing in one call.

FIRST THING every agent should call at session start.
- If you have a WMCS_AGENT_ID env var → pass it as agent_id
- If not → omit agent_id and one will be auto-assigned (stored in your session block)

Returns:
  identity   → your agent_id, your session block, your open tasks, other live agents
  workspace  → project state, recent decisions, block stats

Your agent_id persists across sessions via your agent_session block.
Other agents will see you as "online" until you stop heartbeating.`,
    {
      agent_id:   z.string().optional().describe("Your agent ID (read from WMCS_AGENT_ID env var). Omit to auto-assign."),
      role:       z.string().optional().describe("Your role — e.g. 'researcher', 'coder', 'reviewer'. Stored in registry."),
      project_id: z.string().optional().describe("Project to scope open tasks and briefing to."),
      topic:      z.string().optional().describe("Optional topic to focus the knowledge briefing."),
    },
    async (params) => {
      try {
        const allBlocks = db.getAllBlocks().filter((b) => b.status !== "archived");

        // ── Resolve or assign agent identity ──────────────────────
        const agentId = params.agent_id || process.env.WMCS_AGENT_ID || `agent_${Date.now()}`;
        const role    = params.role || process.env.WMCS_AGENT_ROLE || "general";
        const sessionLabel = `agent_session_${agentId}`;

        // Create or update session block for this agent
        let sessionBlock = db.getBlock(sessionLabel);
        if (!sessionBlock) {
          sessionBlock = db.createBlock({
            label:      sessionLabel,
            type:       "note",
            essence:    `Persistent session block for agent '${agentId}' (role: ${role})`,
            content:    { agent_id: agentId, role, first_seen: new Date().toISOString(), sessions: 1 },
            ttl:        "permanent",
            confidence: 1,
          });
        } else {
          const existing = (() => { try { return JSON.parse(sessionBlock.content); } catch { return {}; } })();
          db.updateBlock(sessionBlock.id, {
            content: { ...existing, role, sessions: (existing.sessions || 0) + 1, last_seen: new Date().toISOString() },
          }, `Session resumed by ${agentId}`);
          sessionBlock = db.getBlock(sessionLabel)!;
        }

        // Register heartbeat so other agents see us as online
        db.agentHeartbeat(agentId, role, undefined);

        // ── Find open tasks for this agent ────────────────────────
        const myTasks = allBlocks.filter((b) => {
          if (b.type !== "task" || b.status === "archived") return false;
          const c = (() => { try { return JSON.parse(b.content); } catch { return {}; } })();
          const s = c?.unique?.status;
          if (!s || s === "done" || s === "blocked") return false;
          // Include tasks assigned to this agent's role or unassigned
          const assigned = c?.unique?.assigned_to;
          if (assigned && assigned !== role && assigned !== agentId) return false;
          if (params.project_id) {
            const rels = c?.relations || [];
            const inProject = rels.some((r: any) =>
              r.type === "part_of" && (r.target_id === params.project_id ||
                allBlocks.find(b => b.id === r.target_id)?.label === params.project_id)
            );
            if (!inProject) return false;
          }
          return true;
        }).map((b) => {
          const c = (() => { try { return JSON.parse(b.content); } catch { return {}; } })();
          return { id: b.id, label: b.label, essence: b.essence,
                   priority: c?.unique?.priority ?? "medium", status: c?.unique?.status };
        });

        // ── Other active agents ───────────────────────────────────
        const liveAgents = db.getActiveAgents(120).filter(a => a.agent_id !== agentId);

        // ── Workspace briefing ────────────────────────────────────
        const project = params.project_id
          ? allBlocks.find((b) => b.id === params.project_id || b.label === params.project_id)
          : allBlocks.find((b) => b.type === "project");

        let scored = allBlocks.filter((b) => b.type !== "project" && b.type !== "task");
        if (params.topic && embeddings.isAvailable()) {
          const topicVec = await embeddings.embed(params.topic);
          if (topicVec) {
            scored = scored
              .filter((b) => b.embedding)
              .map((b) => {
                const bVec = JSON.parse(b.embedding!) as number[];
                const dot = topicVec.reduce((s, v, i) => s + v * bVec[i], 0);
                const ma  = Math.sqrt(topicVec.reduce((s, v) => s + v * v, 0));
                const mb  = Math.sqrt(bVec.reduce((s, v) => s + v * v, 0));
                return { block: b, score: ma && mb ? dot / (ma * mb) : 0 };
              })
              .sort((a, b) => b.score - a.score)
              .slice(0, 10)
              .map((s) => s.block);
          }
        } else {
          scored = scored.sort((a, b) => (b.access_count ?? 0) - (a.access_count ?? 0)).slice(0, 10);
        }

        const recentDecisions = allBlocks
          .filter((b) => b.type === "decision")
          .sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime())
          .slice(0, 3)
          .map((b) => ({ id: b.id, label: b.label, essence: b.essence, confidence: b.confidence }));

        const byType: Record<string, number> = {};
        allBlocks.forEach((b) => { byType[b.type] = (byType[b.type] ?? 0) + 1; });

        // ── Mining candidates — unsaved insights extracted from last session ──
        let miningCandidates: Array<{ id: string; text: string; type_hint: string; turn_number: number; conversation_phase: string }> = [];
        try {
          const mineRes = await fetch("http://localhost:3001/api/mining-candidates", { signal: AbortSignal.timeout(1000) });
          if (mineRes.ok) {
            const md = await mineRes.json() as { candidates: typeof miningCandidates };
            miningCandidates = md.candidates || [];
          }
        } catch { /* non-fatal */ }

        // ── Gap mirror — what was discussed last session but not saved ──
        let gapMirror: { previous_session: unknown; unsaved_topics: string[]; blocks_saved: number } | null = null;
        try {
          const gapRes = await fetch("http://localhost:3001/api/session-gaps", { signal: AbortSignal.timeout(1000) });
          if (gapRes.ok) {
            const gd = await gapRes.json() as { previous_session: unknown; gaps: string[]; blocks_saved_that_session: number };
            if (gd.previous_session && gd.gaps.length > 0) {
              gapMirror = { previous_session: gd.previous_session, unsaved_topics: gd.gaps, blocks_saved: gd.blocks_saved_that_session };
            }
          }
        } catch { /* non-fatal — orient works without gap data */ }

        return ok({
          identity: {
            agent_id:       agentId,
            role,
            session_block:  { id: sessionBlock.id, label: sessionBlock.label },
            my_open_tasks:  myTasks,
            agents_online:  liveAgents.map(a => ({ id: a.agent_id, role: a.role, task: a.current_task })),
          },
          workspace: {
            project: project ? { id: project.id, label: project.label, essence: project.essence } : null,
            top_blocks: scored.map((b) => ({
              id: b.id, label: b.label, type: b.type, essence: b.essence, confidence: b.confidence,
            })),
            recent_decisions: recentDecisions,
            stats: { total: allBlocks.length, by_type: byType },
          },
          ...(miningCandidates.length > 0 ? { unmined_insights: { count: miningCandidates.length, candidates: miningCandidates.map(c => ({ id: c.id, text: c.text, type: c.type_hint, turn: c.turn_number, phase: c.conversation_phase })) } } : {}),
          ...(gapMirror ? { gap_mirror: gapMirror } : {}),
          next_steps: myTasks.length > 0
            ? `You have ${myTasks.length} open task(s). Call workspace_task_next(agent_id: "${agentId}") to begin.`
            : "No tasks assigned. Browse workspace or await assignment.",
        });
      } catch (error) {
        return err("ORIENT_FAILED", String(error));
      }
    }
  );

  // ─── Tool: workspace_auto_recall ─────────────────────────────────
  server.tool(
    "workspace_auto_recall",
    `Run the Auto-Recall middleware to get a pre-populated workspace context string based on the user's message.`,
    {
      message: z.string().describe("The user's raw message"),
      project_id: z.string().optional().describe("Current active project ID"),
      active_blocks: z.array(z.string()).optional().describe("List of block IDs recently accessed in this session"),
    },
    async (params) => {
      try {
        const prompt = await runAutoRecall(db, embeddings, params.message, {
          projectId: params.project_id,
          activeBlocks: params.active_blocks,
        });
        return ok({ context_prompt: prompt });
      } catch (error) {
        return err("AUTO_RECALL_FAILED", String(error));
      }
    }
  );

  // ─── Tool: workspace_auto_reflect ────────────────────────────────
  server.tool(
    "workspace_auto_reflect",
    `Run the Auto-Reflect middleware to automatically extract and save facts and decisions from your response.`,
    {
      response: z.string().describe("Your raw response back to the user"),
      user_message: z.string().optional().describe("The user's original message that prompted this response"),
      loaded_blocks: z.array(z.string()).optional().describe("List of blocks used to generate this response"),
      project_id: z.string().optional().describe("Active project ID — saved blocks will be auto-linked to this project"),
    },
    async (params) => {
      try {
        const result = await runAutoReflect(db, params.response, params.loaded_blocks || [], params.user_message, embeddings, params.project_id);
        return ok({
          auto_reflect: "complete",
          saved: result.saved,
          updated: result.updated,
          contradictions_flagged: result.contradictions,
          skipped: result.skipped,
          saved_labels: result.saved_labels,
        });
      } catch (error) {
        return err("AUTO_REFLECT_FAILED", String(error));
      }
    }
  );

  // ─── Tool: workspace_milestone_create ────────────────────────────
  server.tool(
    "workspace_milestone_create",
    `Create a milestone block that groups tasks toward a project goal. Link tasks to this milestone using workspace_task_create(milestone_id).`,
    {
      label: z.string().describe("Milestone label (lowercase, underscore-separated)"),
      essence: z.string().describe("One-line description of what this milestone achieves"),
      project_id: z.string().describe("Project block ID or label this milestone belongs to"),
      success_criteria: z.array(z.string()).describe("List of conditions that define milestone completion"),
      target_date: z.string().optional().describe("Target completion date (ISO string or human-readable)"),
    },
    async (params) => {
      try {
        const project = db.getBlock(params.project_id);
        if (!project) return err("BLOCK_NOT_FOUND", `Project '${params.project_id}' not found`);

        const block = db.createBlock({
          label: params.label,
          type: "milestone",
          status: "active",
          essence: params.essence,
          content: {
            is_a: "milestone",
            unique: {
              status: "active",
              ...(params.target_date ? { target_date: params.target_date } : {}),
            },
            has: {
              success_criteria: params.success_criteria,
            },
          },
          confidence: 1.0,
          ttl: "project",
        });

        // Link to project via part_of
        db.createRelation({
          source_id: block.id,
          target_id: project.id,
          type: "part_of",
          bidirectional: false,
        });

        return ok({
          milestone_id: block.id,
          label: block.label,
          project_id: project.id,
          project_label: project.label,
          success_criteria: params.success_criteria,
          target_date: params.target_date || null,
        });
      } catch (error) {
        return err("MILESTONE_CREATE_FAILED", String(error));
      }
    }
  );

  // ─── Tool: workspace_milestone_status ────────────────────────────
  server.tool(
    "workspace_milestone_status",
    `Get the status of a milestone: task counts by status, % complete, and list of tasks.`,
    {
      milestone_id: z.string().describe("Milestone block ID or label"),
    },
    async (params) => {
      try {
        const milestone = db.getBlock(params.milestone_id);
        if (!milestone) return err("BLOCK_NOT_FOUND", `Milestone '${params.milestone_id}' not found`);

        // Find all tasks that belong_to this milestone
        const allBlocks = db.getAllBlocks();
        const tasks = allBlocks.filter(b => {
          if (b.type !== "task") return false;
          const content = typeof b.content === "string" ? JSON.parse(b.content) : b.content;
          const relations: Array<{ type: string; target_id: string }> = content?.relations || [];
          return relations.some(r => r.type === "belongs_to" && r.target_id === milestone.id);
        });

        // Count tasks by status
        const counts = { open: 0, in_progress: 0, done: 0, blocked: 0 };
        const taskList = tasks.map(t => {
          const content = typeof t.content === "string" ? JSON.parse(t.content) : t.content;
          const status = (content?.unique?.status as string) || "open";
          if (status in counts) counts[status as keyof typeof counts]++;
          return {
            id: t.id,
            label: t.label,
            essence: t.essence,
            status,
            priority: content?.unique?.priority || "medium",
          };
        });

        const total = tasks.length;
        const pct_complete = total === 0 ? 0 : Math.round((counts.done / total) * 100);

        const milestoneContent = typeof milestone.content === "string" ? JSON.parse(milestone.content) : milestone.content;

        return ok({
          milestone: {
            id: milestone.id,
            label: milestone.label,
            essence: milestone.essence,
            status: milestoneContent?.unique?.status || "active",
            target_date: milestoneContent?.unique?.target_date || null,
            success_criteria: milestoneContent?.has?.success_criteria || [],
          },
          task_counts: { ...counts, total },
          pct_complete,
          tasks: taskList,
        });
      } catch (error) {
        return err("MILESTONE_STATUS_FAILED", String(error));
      }
    }
  );

  // ─── Tool: workspace_file_index ──────────────────────────────────
  server.tool(
    "workspace_file_index",
    `Index a source file in the workspace. Creates or updates a 'file' type block. Link files to tasks for traceability.`,
    {
      file_path: z.string().describe("Relative or absolute file path (e.g. 'src/tools/core.ts')"),
      purpose: z.string().describe("What this file does / its role in the project"),
      key_exports: z.array(z.string()).optional().describe("Main exports from this file (functions, classes, constants)"),
      task_id: z.string().optional().describe("Task block ID that this file is used by"),
      project_id: z.string().optional().describe("Project block ID to link this file to"),
    },
    async (params) => {
      try {
        const label = params.file_path.replace(/[\/\\.]/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "");
        const essence = `${params.file_path} — ${params.purpose}`;

        // Check if file block already exists (same path)
        const allBlocks = db.getAllBlocks();
        const existing = allBlocks.find(b => {
          if (b.type !== "file") return false;
          const content = typeof b.content === "string" ? JSON.parse(b.content) : b.content;
          return content?.unique?.path === params.file_path;
        });

        let blockId: string;
        let action: "created" | "updated";

        if (existing) {
          // UPDATE existing file block
          const existingContent = typeof existing.content === "string" ? JSON.parse(existing.content) : existing.content;
          db.updateBlock(existing.id, {
            essence,
            content: {
              ...existingContent,
              unique: { ...existingContent.unique, path: params.file_path },
              has: { ...(existingContent.has || {}), key_exports: params.key_exports || existingContent.has?.key_exports || [] },
            },
          }, `File re-indexed: ${params.file_path}`);
          blockId = existing.id;
          action = "updated";
        } else {
          // CREATE new file block
          const block = db.createBlock({
            label,
            type: "file",
            essence,
            content: {
              is_a: "source_file",
              unique: { path: params.file_path, purpose: params.purpose },
              has: { key_exports: params.key_exports || [] },
            },
            confidence: 1.0,
            ttl: "project",
          });
          blockId = block.id;
          action = "created";
        }

        // Link to task via uses_file if provided
        if (params.task_id) {
          const task = db.getBlock(params.task_id);
          if (task) {
            db.createRelation({
              source_id: task.id,
              target_id: blockId,
              type: "uses_file",
              bidirectional: false,
            });
          }
        }

        // Link to project if provided
        if (params.project_id) {
          const project = db.getBlock(params.project_id);
          if (project && action === "created") {
            db.createRelation({
              source_id: blockId,
              target_id: project.id,
              type: "part_of",
              bidirectional: false,
            });
          }
        }

        return ok({
          block_id: blockId,
          label,
          file_path: params.file_path,
          action,
        });
      } catch (error) {
        return err("FILE_INDEX_FAILED", String(error));
      }
    }
  );

  // ─── Tool: workspace_infer_relations ─────────────────────────────
  server.tool(
    "workspace_infer_relations",
    `Scan all blocks and infer typed semantic relations between them.
Use use_ai:true for Gemini-powered inference (accurate). AI-inferred relations are auto-approved (active).
Keyword-inferred relations are marked pending and require review via workspace_review_pending.
Use wipe_inferred:true to clear all previous inferred relations before re-running (clean slate).`,
    {
      dry_run:        z.boolean().optional().describe("If true, return candidates without writing. Default: false"),
      min_similarity: z.number().optional().describe("Minimum cosine similarity to consider a pair (0.0–1.0). Default: 0.65"),
      use_ai:         z.boolean().optional().describe("Use Gemini to determine relation types (accurate but slower). Default: false"),
      wipe_inferred:  z.boolean().optional().describe("Delete all previously inferred relations before re-running. Default: false"),
    },
    async (params) => {
      try {
        const minSim      = params.min_similarity ?? 0.65;
        const dryRun      = params.dry_run ?? false;
        const useAI       = params.use_ai ?? false;
        const wipeFirst   = params.wipe_inferred ?? false;

        let wiped = 0;
        if (wipeFirst && !dryRun) {
          wiped = db.deleteInferredRelations();
        }

        const allBlocks    = db.getAllBlocks().filter((b) => b.status !== "archived");
        // includePending=true so we don't create duplicate pending+active edges
        const allRelations = db.getAllRelations(true);
        const existingPairs = new Set(allRelations.map((r) => `${r.source_id}::${r.target_id}`));

        // ── Cosine similarity ───────────────────────────────────────
        function cosineSim(a: number[], b: number[]): number {
          let dot = 0, ma = 0, mb = 0;
          for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; ma += a[i] * a[i]; mb += b[i] * b[i]; }
          return ma && mb ? dot / (Math.sqrt(ma) * Math.sqrt(mb)) : 0;
        }

        // ── Keyword fallback ────────────────────────────────────────
        function keywordInfer(src: typeof allBlocks[0], tgt: typeof allBlocks[0]): string | null {
          const s = [src.label, src.essence, ...((() => { try { return JSON.parse(src.content).concepts || []; } catch { return []; } })())].join(" ").toLowerCase();
          const t = [tgt.label, tgt.essence, ...((() => { try { return JSON.parse(tgt.content).concepts || []; } catch { return []; } })())].join(" ").toLowerCase();
          if ((s.includes("encrypt") || s.includes("security")) && (t.includes("sqlite") || t.includes("database") || t.includes("db"))) return "affects";
          if ((s.includes("save") || s.includes("hierarchy")) && (t.includes("memory") || t.includes("hot") || t.includes("cold"))) return "depends_on";
          if ((s.includes("memory") && (s.includes("hot") || s.includes("cold"))) && (t.includes("sqlite") || t.includes("database"))) return "depends_on";
          if (src.type === "fact" && s.includes("model") && (t.includes("memory") || t.includes("reflect"))) return "enables";
          if (src.type === "decision" && (t.includes("purpose") || t.includes("goal"))) return "implements";
          return null;
        }

        // ── Gemini AI inference ─────────────────────────────────────
        const RELATION_PROMPT = `You are a knowledge graph expert. Given two knowledge blocks, determine the most accurate semantic relationship FROM Block A TO Block B.

Choose EXACTLY ONE from this list or "none":
- implements  (A realizes or builds toward B's goal)
- enables     (A makes B possible or functional)
- depends_on  (A requires B to work)
- affects     (A changes or constrains B's behavior)
- describes   (A defines or explains B)
- conflicts_with (A contradicts or trades off with B)
- replaces    (A supersedes or obsoletes B)
- none        (no meaningful directional relationship)

Rules:
- Only output the relation name (one word or two words with underscore), nothing else
- If the relationship is symmetric or unclear, prefer "none"
- "part_of" is structural (auto-assigned), never choose it here`;

        let geminiModel: any = null;
        if (useAI && process.env.GEMINI_API_KEY) {
          const { GoogleGenerativeAI } = await import("@google/generative-ai");
          const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
          geminiModel = genAI.getGenerativeModel({ model: "gemini-2.5-flash", systemInstruction: RELATION_PROMPT });
        }

        async function aiInfer(src: typeof allBlocks[0], tgt: typeof allBlocks[0]): Promise<string | null> {
          if (!geminiModel) return null;
          const prompt = `Block A: [${src.type}] "${src.label}" — ${src.essence}\nBlock B: [${tgt.type}] "${tgt.label}" — ${tgt.essence}`;
          try {
            const result = await geminiModel.generateContent(prompt);
            const answer = result.response.text().trim().toLowerCase().replace(/[^a-z_]/g, "");
            return answer === "none" || !answer ? null : answer;
          } catch { return null; }
        }

        // ── Collect candidates ──────────────────────────────────────
        const candidates: Array<{
          source: string; source_label: string;
          target: string; target_label: string;
          type: string; confidence: number; similarity: number;
          method: string; status: string; created: boolean;
        }> = [];

        for (let i = 0; i < allBlocks.length; i++) {
          for (let j = 0; j < allBlocks.length; j++) {
            if (i === j) continue;
            const src = allBlocks[i], tgt = allBlocks[j];
            if (src.type === "project" || tgt.type === "project") continue;
            if (!src.embedding || !tgt.embedding) continue;

            const sim = cosineSim(JSON.parse(src.embedding), JSON.parse(tgt.embedding));
            if (sim < minSim) continue;

            // Skip if already any relation exists between this pair (in either direction)
            if (existingPairs.has(`${src.id}::${tgt.id}`)) continue;

            // Determine relation type
            let relType: string | null = null;
            let method = "keyword";

            if (useAI && geminiModel) {
              relType = await aiInfer(src, tgt);
              method = "gemini";
            }
            if (!relType) {
              relType = keywordInfer(src, tgt);
              method = "keyword";
            }
            if (!relType) continue;

            // AI-inferred → active (trusted). Keyword-inferred → pending (needs review).
            const confidence = method === "gemini" ? 0.85 : 0.70;
            const status     = method === "gemini" ? "active" : "pending";

            candidates.push({
              source: src.id, source_label: src.label,
              target: tgt.id, target_label: tgt.label,
              type: relType, confidence, similarity: Math.round(sim * 100) / 100,
              method, status, created: false,
            });

            if (!dryRun) {
              db.createRelation({ source_id: src.id, target_id: tgt.id, type: relType, confidence, created_by: `infer_${method}`, status });
              existingPairs.add(`${src.id}::${tgt.id}`);
              candidates[candidates.length - 1].created = true;
            }
          }
        }

        // ── Concept bridging pass ────────────────────────────────────
        // Link blocks that share 2+ abstract concepts regardless of embedding distance.
        // This is what enables cross-domain skill transfer.
        let conceptBridged = 0;
        for (let i = 0; i < allBlocks.length; i++) {
          for (let j = i + 1; j < allBlocks.length; j++) {
            const src = allBlocks[i], tgt = allBlocks[j];
            if (src.type === "project" || tgt.type === "project") continue;
            if (existingPairs.has(`${src.id}::${tgt.id}`) || existingPairs.has(`${tgt.id}::${src.id}`)) continue;

            let srcConcepts: string[] = [];
            let tgtConcepts: string[] = [];
            try {
              const sc = typeof src.content === "string" ? JSON.parse(src.content) : src.content;
              srcConcepts = (sc?.concepts || []).map((c: string) => c.toLowerCase());
            } catch { /* ignore */ }
            try {
              const tc = typeof tgt.content === "string" ? JSON.parse(tgt.content) : tgt.content;
              tgtConcepts = (tc?.concepts || []).map((c: string) => c.toLowerCase());
            } catch { /* ignore */ }

            if (srcConcepts.length === 0 || tgtConcepts.length === 0) continue;

            const shared = srcConcepts.filter((c) =>
              tgtConcepts.some((tc) => tc === c || tc.includes(c) || c.includes(tc))
            );
            if (shared.length < 2) continue;

            // 3+ shared → trusted cross-domain link (active); 2 shared → pending
            const confidence = shared.length >= 3 ? 0.75 : 0.65;
            const status     = shared.length >= 3 ? "active" : "pending";

            candidates.push({
              source: src.id, source_label: src.label,
              target: tgt.id, target_label: tgt.label,
              type: "related_to", confidence,
              similarity: 0,
              method: `concept_bridge(${shared.join(",")})`,
              status, created: false,
            });

            if (!dryRun) {
              db.createRelation({
                source_id: src.id, target_id: tgt.id,
                type: "related_to", confidence,
                created_by: `infer_concept`, status,
                bidirectional: true,
              });
              existingPairs.add(`${src.id}::${tgt.id}`);
              existingPairs.add(`${tgt.id}::${src.id}`);
              candidates[candidates.length - 1].created = true;
              conceptBridged++;
            }
          }
        }

        return ok({
          dry_run: dryRun,
          use_ai: useAI && !!geminiModel,
          wiped_count: wiped,
          found: candidates.length,
          created: candidates.filter((c) => c.created).length,
          pending: candidates.filter((c) => c.created && c.status === "pending").length,
          active: candidates.filter((c) => c.created && c.status === "active").length,
          concept_bridges: conceptBridged,
          relations: candidates,
          hint: "Keyword-inferred relations are marked 'pending'. Review them with workspace_review_pending.",
        });
      } catch (error) {
        return err("INFER_RELATIONS_FAILED", String(error));
      }
    }
  );
*/
