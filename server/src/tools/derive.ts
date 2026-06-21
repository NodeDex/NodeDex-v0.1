import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { WorkspaceDB } from "../store/database.js";
import { EmbeddingEngine, blockEmbeddingText } from "../engine/embeddings.js";
import { ok, err } from "./helpers.js";

export function registerDeriveTools(server: McpServer, db: WorkspaceDB, embeddings: EmbeddingEngine): void {

  // ─── Tool: workspace_derive ──────────────────────────────────────
  server.tool(
    "workspace_derive",
    `Record a reasoning chain the agent already performed. The agent reasons — this tool saves the traceable result.

Use this AFTER you have already thought through a conclusion using retrieved blocks.
Creates a permanent record: which blocks you used + what logic you applied + what you concluded.
This lets future sessions retrace why a conclusion was reached, not just what it was.

Example flow:
1. Agent calls workspace_auto_recall → gets relevant blocks
2. Agent reasons over those blocks in its own context
3. Agent calls workspace_derive to record: inputs=[block IDs used], logic="my reasoning", conclusion="what I concluded"`,
    {
      input_ids: z.array(z.string()).min(1).describe("IDs OR labels of the blocks you used — both work. Use labels when you know them (e.g. 'sir_model', 'r0_reproduction_number'), use IDs when you have them from a recent save or recall."),
      logic: z.string().describe("Your reasoning — what you inferred from the input blocks and why"),
      conclusion: z.string().describe("The conclusion you reached — one clear sentence"),
      label: z.string().optional().describe("Label for the derived block (auto-generated if omitted)"),
      type: z
        .enum(["fact", "decision", "note", "insight"])
        .optional()
        .describe("Type for the derived block. Default: insight"),
      promote: z.boolean().optional().describe("If true, save as permanent block. Default: false (session only)"),
      project_id: z.string().optional().describe("Project to anchor this derived block to (creates a part_of relation)"),
      concepts: z.array(z.string()).optional().describe("Abstract concept tags — if omitted, auto-inherited from input blocks"),
    },
    async (params) => {
      try {
        // Validate inputs exist
        const inputs = [];
        for (const id of params.input_ids) {
          const block = db.getBlock(id);
          if (!block) return err("BLOCK_NOT_FOUND", `Input block '${id}' not found`);
          inputs.push(block);
        }

        // Auto-inherit concepts: agent-provided > union of input block concepts > keyword extraction from conclusion
        let concepts: string[] = params.concepts || [];
        if (concepts.length === 0) {
          // Inherit from input blocks (deduplicated)
          // concepts are stored in a first-class column, not inside content JSON
          const inherited = new Set<string>();
          for (const input of inputs) {
            try {
              const inputConcepts: string[] = JSON.parse((input as any).concepts || "[]");
              inputConcepts.forEach((t) => inherited.add(t));
            } catch { /* skip */ }
          }
          // Also pull from the block's aliases field which stores concepts in some versions
          // Fall back to keyword extraction from conclusion
          if (inherited.size === 0) {
            const stopwords = new Set(["the", "is", "a", "an", "to", "of", "in", "for", "on", "with", "and", "or", "but", "it", "this", "that", "how", "what", "why", "can", "do", "be", "are", "was", "were", "will", "via", "use", "used", "all", "one", "two", "most", "more", "best", "than", "its", "their", "they", "makes", "make", "which", "have", "has", "both", "each", "only", "any", "also", "that", "these", "those", "single", "every", "currently", "available", "zero", "four", "five", "six"]);
            const words = params.conclusion
              .toLowerCase()
              .replace(/[^a-z0-9]/g, " ")
              .split(/\s+/)
              .filter((w) => w.length > 4 && !stopwords.has(w));
            concepts = [...new Set(words)].slice(0, 6);
          } else {
            concepts = [...inherited].slice(0, 8);
          }
        }

        const label = params.label || `derived_${Date.now().toString(36)}`;
        const embedding = await embeddings.embed(blockEmbeddingText({ essence: params.conclusion, concepts }));

        const derived = db.createBlock({
          label,
          type: params.type || "insight",
          essence: params.conclusion,
          content: {
            is_a: "insight",
            unique: {
              conclusion: params.conclusion,
              input_count: String(inputs.length),
            },
            // `reasoning_chain` content sub-object kept INTENTIONALLY after the type
            // collapsed → insight (2026-06-15): the recall boost (recall.ts) keys on this
            // content field, NOT the type, and the derivation detail lives here. Do not rename.
            reasoning_chain: {
              inputs: inputs.map((b) => ({ id: b.id, label: b.label, essence: b.essence })),
              logic: params.logic,
              derived_at: new Date().toISOString(),
            },
          },
          concepts,
          ttl: params.promote === false ? "session" : "permanent",
          embedding: embedding || undefined,
        });

        // Create derived_from relations to all input blocks
        for (const input of inputs) {
          db.createRelation({
            source_id: derived.id,
            target_id: input.id,
            type: "derived_from",
            bidirectional: false,
          });
        }

        // Anchor to project via project_id column
        if (params.project_id) {
          const project = db.getBlock(params.project_id);
          if (project) db.updateBlock(derived.id, { project_id: project.id });
        }

        // Compute quality score — derive blocks now populate is_a + unique so can reach 6/6
        {
          let qScore = 1; // essence always present
          qScore++; // is_a = "insight" always set above
          qScore++; // unique{} has conclusion + input_count (≥2 props)
          if (concepts.length >= 3) qScore++;
          if (db.getRelations(derived.id).length > 0) qScore++;
          db.updateBlock(derived.id, { quality_score: qScore });
        }

        // ── Chain grouping ────────────────────────────────────────────
        // Stamp chain_id on derived block (flow_role: outcome) and all inputs.
        // Input flow_role is only set if the block has none — preserves agent-set roles.
        const chainId = `chain_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
        db.updateBlock(derived.id, { chain_id: chainId, flow_role: "outcome" });
        for (const input of inputs) {
          const updates: Record<string, unknown> = { chain_id: chainId };
          if (!input.flow_role) updates.flow_role = "cause";
          db.updateBlock(input.id, updates);
        }

        return ok({
          id: derived.id,
          label: derived.label,
          essence: derived.essence,
          concepts,
          ttl: params.promote === false ? "session" : "permanent",
          chain_id: chainId,
          reasoning_chain: {
            inputs: inputs.map((b) => b.label),
            logic: params.logic,
            conclusion: params.conclusion,
          },
        });
      } catch (error) {
        return err("DERIVE_FAILED", String(error));
      }
    }
  );

  // ─── Tool: workspace_promote ─────────────────────────────────────
  server.tool(
    "workspace_promote",
    `Promote a temporary block to permanent storage. Useful for keeping valuable comparisons, derivations, or hypotheses.`,
    {
      id: z.string().describe("Block ID to promote"),
      label: z.string().optional().describe("New label for the permanent block"),
      type: z.enum(["fact", "decision", "entity", "task", "preference", "template", "note"]).optional().describe("Override the block type"),
    },
    async (params) => {
      try {
        const block = db.getBlock(params.id);
        if (!block) return err("BLOCK_NOT_FOUND", `Block '${params.id}' not found`);
        if (block.ttl === "permanent") return err("ALREADY_PERMANENT", `Block '${params.id}' is already permanent`);

        const changes: Record<string, unknown> = { ttl: "permanent" };
        if (params.label) changes.label = params.label;
        if (params.type) changes.type = params.type;

        const updated = db.updateBlock(block.id, changes, "Promoted from temporary to permanent");
        // Generate embedding after promote — use setEmbedding to avoid bloating history
        if (!block.embedding) {
          const embedding = await embeddings.embed(blockEmbeddingText({ essence: block.essence, concepts: block.concepts }));
          if (embedding) db.updateEmbedding(block.id, embedding);
        }
        return ok({
          id: updated!.id,
          label: updated!.label,
          type: updated!.type,
          ttl: "permanent",
          promoted: true,
        });
      } catch (error) {
        return err("PROMOTE_FAILED", String(error));
      }
    }
  );
}
