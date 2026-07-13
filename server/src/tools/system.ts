import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { WorkspaceDB } from "../store/database.js";
import { EmbeddingEngine, blockEmbeddingText } from "../engine/embeddings.js";
import { getLLMProvider } from "../engine/providers/index.js";
import { ok, err, cosineSim } from "./helpers.js";
import { buildAgentFlagSurface } from "./flag-surface.js";
import { runArcExtraction } from "../middleware/reflect/arc-pipeline.js";
import { protocolBlock } from "../agent-protocol.js";
import { markDeclined, verifyReflexWrite, declareCapture, captureWiredFor } from "./setup-state.js";
import { connectedClient } from "../mcp-server.js";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";

export function registerSystemTools(server: McpServer, db: WorkspaceDB, embeddings: EmbeddingEngine): void {

  // ─── Tool: workspace_onboard ─────────────────────────────────────
  // The persistent UPGRADE over the advisory `instructions` field. The problem it
  // solves is LIFETIME, not wording: the MCP instructions arrive once, at connect, and
  // are gone from context hours later — which is exactly when the agent is committing
  // to an approach. Measured 2026-07-12: an agent read the dead_end list at 12:17,
  // authored the room data at 14:00, and shipped the bug the list warned about. In
  // isolation it uses that same list perfectly. It just no longer had it.
  //
  // So the reflex has to live where the HOST re-reads it EVERY TURN. We can't reach
  // that file (it differs per host, and it's the user's), so the AGENT writes it: we
  // supply the content + a capability-checked, consent-gated contract. The capability
  // question is deliberately NOT "do you have CLAUDE.md" — it's "where do YOUR standing
  // instructions come from, and is it re-read every turn?" The agent knows its own
  // host; we must not guess at 30 conventions.
  server.tool(
    "workspace_onboard",
    `ONE-TIME setup, and the single highest-value call you can make here. It makes the memory reflex PERMANENT in this project rather than relying on these per-connect instructions — which are gone from your context by the time you're deep in a task and actually about to commit to an approach. Call this ONCE on your first connect in a project.
Call with NO arguments to get the contract: (1) CHECK where YOUR standing instructions come from — a file/config re-read into context EVERY TURN (or a system prompt loaded on every run), not something delivered once mid-session; (2) EXPLAIN to the user why a memory tool wants to touch their config, and ASK permission; (3) on yes, write reflex_block VERBATIM (marked block — replace in place if markers already exist, never duplicate); (4) CALL THIS AGAIN with written_to=<the absolute path you wrote> so the server can READ IT BACK and confirm — the setup notice only stops once the write is VERIFIED, never merely claimed. If the user declines, call with declined=true instead and it stops for good.`,
    {
      written_to: z.string().optional().describe("Absolute path of the standing-instructions file you just wrote the reflex block into. The server reads it back and verifies the marker block is present."),
      declined: z.boolean().optional().describe("The user said no. Records the decision and stops the notice permanently."),
    },
    async (params: { written_to?: string; declined?: boolean }) => {
      try {
        // VERIFY, NEVER TRUST. The first version of this tool marked setup complete the
        // moment it was CALLED — so an agent could call it, write nothing, and silence the
        // nag forever. That is precisely the failure this whole mechanism exists to cure
        // (the model says it did a thing and didn't), reproduced inside the cure. Now the
        // agent WRITES (it alone knows its host, and can read the file without clobbering
        // what is already there) and the SERVER READS IT BACK.
        if (params.declined) {
          markDeclined(db, "reflex", connectedClient(server));
          return ok({ status: "declined", note: "Recorded. The reflex notice will not appear again. The per-connect instructions still apply for this session." });
        }
        if (params.written_to) {
          const v = verifyReflexWrite(db, params.written_to, connectedClient(server));
          if (!v.ok) return ok({ status: "not_verified", problem: v.reason, next: "Fix the write and call again with written_to — or if the file is genuinely unreachable from this server, just proceed; the block still works where you wrote it." });
          return ok({ status: "verified", file: params.written_to, note: "Confirmed the marked block is present. The reflex is now re-read into your context on every turn, and the setup notice stops." });
        }
        return ok({
          reason_for_user:
            "NodeDex records what this project already tried, ruled out, and constrained. That only helps if I actually check it at the moment I'm about to make a decision — but the instruction to check arrives once when I connect, and it's long gone from my context by the time I'm hours into a task. I can save a short, clearly-marked note into this project's agent instructions file so the reflex is in front of me on every turn instead. It contains no project data — just the habit. You can delete the block anytime. Want me to?",

          step_1_find_your_standing_channel:
            "Where do YOUR standing instructions come from? Not any particular filename — the property that matters is: text that is in your context on EVERY TURN. That is usually a file the host re-reads each turn (AGENTS.md, CLAUDE.md, a rules file), but a SYSTEM PROMPT loaded from a file at every run qualifies too — it may only take effect on your next session, which is fine: this is a standing habit, not a hotfix. What does NOT qualify is anything delivered once, mid-session (like these instructions). You know your own host; we deliberately do not guess.",

          where_to_write:
            "Prefer AGENTS.md at the repo root when your host reads it — it is the cross-tool standard (Linux Foundation / Agentic AI Foundation; read by Codex, Claude Code, Copilot, Cursor, Aider, Windsurf, Zed, Gemini CLI and others), so the reflex carries to every agent that works in this repo, not just you. Otherwise use your host's native per-turn channel (CLAUDE.md, .cursor/rules/, .clinerules, your system-prompt file). Write it in ONE place — never duplicate it across files.",

          step_2_explain_and_ask:
            "Tell the user `reason_for_user` verbatim-in-spirit (so an MCP tool editing their config isn't alarming), name the exact file you intend to write, and ASK permission. Wait for a clear yes. Never write without it. If they say no → call workspace_onboard(declined=true) and stop.",

          step_3_persist:
            "On yes: append `reflex_block` VERBATIM to that file. READ THE FILE FIRST — it is the user's, it already has content, and you must not clobber or contradict it; place the block cleanly at the end. It is wrapped in nodedex:protocol markers — if those markers already exist, REPLACE that block in place (never duplicate, never nest).",

          step_4_verify:
            "Then call workspace_onboard AGAIN with written_to=<the absolute path>. The server reads the file back and confirms the marker block is really there. THIS is what stops the setup notice — not the claim, the verified fact. (If the server can't see your disk because you run in a container or on another machine, it will say so; just proceed — your write still works.)",

          reflex_block: protocolBlock(),
          // kept under the old key too — an agent that learned the previous contract
          // still finds the content rather than silently writing nothing.
          protocol_block: protocolBlock(),
        });
      } catch (error) {
        return err("ONBOARD_FAILED", String(error));
      }
    }
  );

  // ─── Tool: workspace_install_capture ─────────────────────────────
  // Deploy the NON-INTRUSIVE capture adapter into the host so finished turns flow
  // into the pipeline. The MCP server is PASSIVE — it can't grab the agent's output
  // itself; capture must be PUSHED by the host. This hands the agent the adapter
  // source + a consent-gated 4-step deploy contract (the agent writes the file + wires
  // it; we can't reach the host's filesystem). Out-of-path tee: the agent's own LLM is
  // NEVER touched. Configurable: pick which of response/user/reasoning to capture.
  // Single source of truth: read the canonical adapters/nodedex-capture.mjs from disk
  // (resolves the same from src/tools or dist/tools) so the tool never drifts from it.
  const readCaptureAdapter = (): { filename: string; source: string } => {
    const moduleDir = path.dirname(fileURLToPath(import.meta.url));
    const candidates = [
      path.resolve(moduleDir, "../../adapters/nodedex-capture.mjs"),       // src/tools|dist/tools → server/adapters
      path.resolve(process.cwd(), "adapters/nodedex-capture.mjs"),
      path.resolve(process.cwd(), "Nodedex/server/adapters/nodedex-capture.mjs"),
    ];
    for (const p of candidates) {
      try { if (fs.existsSync(p)) return { filename: "nodedex-capture.mjs", source: fs.readFileSync(p, "utf8") }; }
      catch { /* try next */ }
    }
    throw new Error(`capture adapter not found (looked in: ${candidates.join(" | ")})`);
  };

  // Same single-source-of-truth trick for the gate script (adapters/nodedex-gate.mjs).
  const readGateScript = (): { filename: string; source: string } => {
    const moduleDir = path.dirname(fileURLToPath(import.meta.url));
    const candidates = [
      path.resolve(moduleDir, "../../adapters/nodedex-gate.mjs"),
      path.resolve(process.cwd(), "adapters/nodedex-gate.mjs"),
      path.resolve(process.cwd(), "Nodedex/server/adapters/nodedex-gate.mjs"),
    ];
    for (const p of candidates) {
      try { if (fs.existsSync(p)) return { filename: "nodedex-gate.mjs", source: fs.readFileSync(p, "utf8") }; }
      catch { /* try next */ }
    }
    throw new Error(`gate script not found (looked in: ${candidates.join(" | ")})`);
  };

  server.tool(
    "workspace_install_capture",
    `Deploy Nodedex's capture adapter into THIS host so each finished turn is fed to the memory pipeline. Without it, nothing is ever stored — the MCP server is passive and can't read your output itself. Call this ONCE per host during setup, after the user agrees.
The adapter is a NON-INTRUSIVE tee: it sends a COPY of {user_message, agent_response, reasoning} to POST /api/reflect/trigger, fire-and-forget, OUT of your LLM's path — your own model call is never touched or slowed. You choose which fields to capture (response/user/reasoning).
The result gives you adapter_source (write it to a file) + wiring_examples (call it in your host's post-turn seam) + a 4-step contract: (1) CHECK you can write a file AND have a post-turn seam to call it from; (2) EXPLAIN reason_for_user + ASK permission (an MCP tool wiring capture into their agent shouldn't surprise them); (3) on yes, WRITE adapter_filename verbatim + add the one-line call in the post-turn seam, passing a stable agentId; (4) TELL US HOW YOU ARE CAPTURED — call again with capture_id=<that agentId>, or via_watcher=true if your host has NO post-turn seam and persists its own transcripts (then the NodeDex watcher is the path). If the user declines, call with declined=true.
CAPTURE IS PER-AGENT: a graph full of ANOTHER agent's turns proves nothing about yours. If your turns land nowhere, your work is recorded nowhere — however healthy the graph looks.`,
    {
      capture_id: z.string().optional().describe("The stable agentId your adapter posts turns under. The server verifies capture by finding a REAL turn with this id — not by your say-so."),
      via_watcher: z.boolean().optional().describe("You have NO post-turn seam and your host persists its own transcripts (e.g. Claude Code, Hermes). Capture is then the NodeDex watcher's job; the user enables it in the TUI."),
      declined: z.boolean().optional().describe("The user said no. Records the decision and stops the notice permanently."),
    },
    async (params: { capture_id?: string; via_watcher?: boolean; declined?: boolean }) => {
      try {
        const client = connectedClient(server);
        if (params.declined) {
          markDeclined(db, "capture", client);
          return ok({ status: "declined", note: "Recorded. We won't ask again. Note YOUR turns will not reach the graph — your work stays unrecorded." });
        }
        if (params.capture_id || params.via_watcher) {
          declareCapture(db, client, { capture_id: params.capture_id, via_watcher: params.via_watcher });
          const proven = captureWiredFor(db, client);
          return ok({
            status: proven ? "verified" : "declared_awaiting_first_turn",
            how: params.capture_id ? `adapter posting as "${params.capture_id}"` : "the host's transcripts + the NodeDex watcher",
            note: proven
              ? "A real turn has landed under this identity — capture is proven for you. The notice stops."
              : "Recorded. The notice will stop as soon as a REAL turn lands under this identity — we verify by effect, never by claim. If it never does, capture is silently broken and you should know.",
            ...(params.via_watcher ? { user_action: "This host keeps its own transcripts, so ask the user to enable the matching watcher in the NodeDex TUI (settings → capture watchers) and pick this project." } : {}),
          });
        }
        const { filename, source } = readCaptureAdapter();
        return ok({
          reason_for_user:
            "Nodedex only remembers what it's shown. Because it's a passive tool, it can't see my replies on its own — so to build memory, a tiny adapter sends a COPY of each turn (your message, my response, and my reasoning if available) to your local Nodedex server. It runs OUTSIDE my model call, so it never changes or slows what you already have, and you control which parts are captured — or turn it off anytime. Want me to set it up?",
          what_it_does:
            "Out-of-path tee → POST {NODEDEX_URL}/api/reflect/trigger, fire-and-forget. The server does the rest (debounce, dedup, async extraction). Honors the server-side reflect-pause as the global off switch.",
          post_endpoint: "POST {NODEDEX_URL or http://localhost:3001}/api/reflect/trigger",
          config: {
            note: "Set via env on the host, or per-call `capture` override. Default: all on.",
            NODEDEX_CAPTURE_RESPONSE: "the agent's emitted answer — the SUBSTRATE; off ⇒ nothing is sent (default on)",
            NODEDEX_CAPTURE_USER: "the user's message (default on)",
            NODEDEX_CAPTURE_REASONING: "the agent's reasoning/thinking, captured when the host exposes it (default on)",
            NODEDEX_URL: "where the Nodedex server lives (default http://localhost:3001)",
            NODEDEX_CAPTURE_BUFFER: "on ⇒ buffer to ~/.nodedex/capture-buffer.jsonl when the server is down, flush on next success (default off)",
          },
          adapter_filename: filename,
          adapter_source: source,
          wiring_examples: {
            generic:
              "import { nodedexCapture } from './nodedex-capture.mjs';\n// after your turn completes:\nnodedexCapture({ userMessage, agentResponse: out.text, agentId: sessionId });",
            openai_shape:
              "import { nodedexCapture, extractReasoning } from './nodedex-capture.mjs';\nconst c = await openai.chat.completions.create({ /* your call, untouched */ });\nconst msg = c.choices[0].message;\nnodedexCapture({ userMessage, agentResponse: msg.content, reasoning: extractReasoning(msg), agentId: sessionId });",
            framework_callback:
              "// In an Agent SDK / LangChain onTurnEnd, or a Stop hook: register nodedexCapture so it runs once per completed turn.",
            scoped_fields:
              "// capture response only (skip user + reasoning) for this call:\nnodedexCapture(turn, { capture: { user: false, reasoning: false } });",
          },
          step_1_check_capability:
            "Confirm you CAN deploy: you have a file-write tool AND a place that runs once per completed turn (a post-turn callback / Stop hook / the line right after your model call). If not → step_4.",
          step_2_explain_and_ask:
            "Tell the user `reason_for_user` and ASK permission — wiring capture into their agent shouldn't surprise them. Wait for a clear yes.",
          step_3_deploy:
            "On yes: (a) write `adapter_source` to `adapter_filename` next to your agent code; (b) add the matching one-liner from wiring_examples in your post-turn seam; (c) OPTIONAL: set NODEDEX_CAPTURE_* env to scope which fields are sent. Do this ONCE per host.",
          step_4_declare_how:
            "TELL US HOW YOU ARE CAPTURED, or we cannot verify it: call workspace_install_capture again with capture_id=<the stable agentId your adapter posts under>. If you have NO post-turn seam but your host persists its own transcripts (Claude Code, Hermes…), call with via_watcher=true instead — capture is then the NodeDex watcher's job, and you should ask the user to enable it in the TUI for this project. If neither is possible, declined=true.",
          verification:
            "We do NOT take your word for it. Capture counts as wired only when a REAL TURN LANDS under the identity you declared — until then the notice keeps saying capture is unproven for you. And it is PER-AGENT: a graph full of another agent's turns proves nothing about yours. If your turns land nowhere, your work is recorded nowhere, however healthy the graph looks.",
        });
      } catch (error) {
        return err("INSTALL_CAPTURE_FAILED", String(error));
      }
    }
  );

  // ─── Tool: workspace_install_gate ────────────────────────────────
  // The THIRD wire, and the only one that does not depend on the model remembering.
  //
  // The reflex is a persistent PROMPT — better than a per-connect one, but still a request.
  // This is a GUARANTEE: it runs on the HOST's schedule (before an edit / every turn), asks
  // the server whether the agent's view of the graph is STALE, and puts the answer back in
  // front of the agent at the moment it is choosing an approach. That is the exact moment
  // measured to fail: read the dead-ends at 12:17, ship the bug they warned about at 16:45.
  //
  // Universal by CAPABILITY, not by host list: we ask "what fires before you edit a file, or
  // on every turn?" and the agent — which knows its own host — installs there. We never guess
  // at thirty hook conventions.
  server.tool(
    "workspace_install_gate",
    `Install the memory GATE: a check that fires at the MOMENT YOU EDIT — not once at session start — and reminds you to consult the graph when your view of it has gone stale. This is the only NodeDex wire that doesn't depend on you remembering anything, which is why it's the strongest one. Call this ONCE per host during setup, after the user agrees.
It is a WARNING, never a block, and it FAILS OPEN — if NodeDex is down it says nothing and stops nothing. Measured: an agent read this project's dead-ends at 12:17, wrote the code at 16:44, and shipped the exact bug they warned about. A gate at the edit would have caught it; a prompt at connect did not.
The result gives you gate_source (a tiny script) + a 4-step contract: (1) CHECK you have a seam that runs before a file edit, or on every turn (a pre-tool hook, middleware, the line before your write call) — you know your host, we don't; (2) EXPLAIN reason_for_user + ASK permission, and READ their config before touching it — MERGE, never overwrite: it is their file and it may already have hooks in it; (3) on yes, write gate_source and wire it in so its stdout reaches your context; (4) if you have no such seam or they decline, call with declined=true.`,
    {
      declined: z.boolean().optional().describe("The user said no, or this host has no pre-edit/per-turn seam. Records the decision and stops the notice permanently."),
    },
    async (params: { declined?: boolean }) => {
      try {
        if (params.declined) {
          markDeclined(db, "gate", connectedClient(server));
          return ok({ status: "declined", note: "Recorded. We won't ask again. The reflex (if persisted) is still your floor — check the graph before you commit to an approach." });
        }
        const { filename, source } = readGateScript();
        const base = (process.env.NODEDEX_URL || "http://localhost:3001").replace(/\/$/, "");
        return ok({
          reason_for_user:
            "The memory graph only helps if I look at it at the moment I'm deciding something — and that's exactly when I'm most likely not to, because I feel confident and I'm hours deep in the work. This installs a small check that runs right before I edit a file: if I haven't consulted the graph recently, it reminds me. It never blocks anything, and if NodeDex isn't running it does nothing at all. It's the difference between me being asked to remember and me actually being reminded. Want me to set it up?",
          what_it_does: `Calls GET ${base}/api/gate/check before an edit. The server answers 'remind' only when this graph hasn't been read recently (stale view); otherwise it stays silent. Whatever the script prints should reach your context.`,
          why_time_not_session:
            "The check is about STALENESS, not 'did I read it this session'. The measured failure read the graph and shipped the bug FOUR HOURS LATER in the same session — session-scoped would have said 'already read' and stayed quiet.",
          gate_filename: filename,
          gate_source: source,
          wiring_examples: {
            pre_edit_hook: "// In your host's pre-file-edit hook: run `node nodedex-gate.mjs`. Anything it prints to stdout should be fed back into your context. Exit code is always 0.",
            per_turn: "// No pre-edit seam? A per-turn hook works too — slightly noisier, same effect.",
            custom_loop: "import { execFileSync } from 'node:child_process';\n// right before you apply a file edit:\nconst hint = execFileSync('node', ['nodedex-gate.mjs'], { encoding: 'utf8' });\nif (hint.trim()) messages.push({ role: 'user', content: hint });",
            envelope_note: "If your host requires a specific JSON envelope for hook output, wrap the script — the part that matters is the endpoint call, not the plumbing.",
          },
          step_1_check_capability:
            "Do you have a seam that runs BEFORE a file edit (best), or on every turn (acceptable)? A pre-tool hook, a middleware, or simply the line before your write call in your own loop. If not → step_4.",
          step_2_explain_and_ask:
            "Tell the user `reason_for_user` and ASK permission. If wiring it means touching a config file of theirs (e.g. a settings/hooks file): READ IT FIRST and MERGE — never overwrite. They may already have hooks there, and clobbering them is unforgivable.",
          step_3_deploy:
            "On yes: write `gate_source` to `gate_filename`, wire it into that seam, and make sure its stdout reaches your context. Keep the fail-open behaviour intact — a memory tool must never block someone's editor.",
          step_4_fallback:
            "No seam, or they decline → call workspace_install_gate(declined=true). The persisted reflex remains your floor.",
          verification:
            "We do NOT take your word for it. The gate counts as installed only when a real check HITS the endpoint. Until then the setup notice keeps saying so.",
        });
      } catch (error) {
        return err("INSTALL_GATE_FAILED", String(error));
      }
    }
  );

  // ─── Tool: workspace_create_type ─────────────────────────────────
  server.tool(
    "workspace_create_type",
    `Create a new custom block type that extends a core type (e.g., 'concept' extending 'note').`,
    {
      name: z.string().describe("Type name (lowercase, unspaced)"),
      extends: z.string().describe("Core type to extend (e.g., 'note', 'fact', 'entity')"),
      description: z.string().describe("What this type is used for"),
      typical_fields: z.array(z.string()).optional().describe("Fields often used in 'unique' or 'has' for this type"),
    },
    async (params) => {
      try {
        const success = db.createBlockType(params);
        if (!success) return err("DUPLICATE_TYPE", `Type '${params.name}' already exists`);
        return ok({ type: params.name, extends: params.extends, description: params.description });
      } catch (error) {
        return err("CREATE_TYPE_FAILED", String(error));
      }
    }
  );

  // ─── Tool: workspace_create_relation_type ────────────────────────
  server.tool(
    "workspace_create_relation_type",
    `Create a new custom relation type (e.g., 'uses', 'depends_on').`,
    {
      name: z.string().describe("Relation name (lowercase, unspaced)"),
      inverse: z.string().optional().describe("The inverse relation name (e.g., 'used_by' for 'uses')"),
      description: z.string().describe("What this relation signifies"),
    },
    async (params) => {
      try {
        const success = db.createRelationType(params);
        if (!success) return err("DUPLICATE_RELATION_TYPE", `Relation type '${params.name}' already exists`);
        return ok({ relation_type: params.name, inverse: params.inverse || null, description: params.description });
      } catch (error) {
        return err("CREATE_RELATION_TYPE_FAILED", String(error));
      }
    }
  );

  // ─── Tool: workspace_gc ──────────────────────────────────────────
  server.tool(
    "workspace_gc",
    `Run lifecycle garbage collection. Archives expired blocks (based on TTL) and marks old permanent blocks as stale.`,
    {},
    async () => {
      try {
        const results = db.runGC();
        return ok({
          message: "Garbage collection complete",
          archived_count: results.archived,
          protected_count: results.protected,
          promoted_count: results.promoted,
        });
      } catch (error) {
        return err("GC_FAILED", String(error));
      }
    }
  );

  // ─── Tool: workspace_stats ───────────────────────────────────────
  server.tool(
    "workspace_stats",
    `ORIENT — the landscape of the graph: how many blocks of each type/status exist, plus whether semantic embeddings are available. Call it to get your bearings (e.g. at session start) before drilling in.
The 'extraction' field reports EXTRACTION FRESHNESS — extraction is async (a background pipeline writes the graph AFTER you finish), so for a few seconds your latest work is NOT yet queryable. It disambiguates the look-alike "empty" states a plain query can't:
  • pending  — turns captured but not yet in the graph: a query may MISS them, so don't read "graph returned nothing" as "nothing exists". pending.failed=true means the last extraction attempt FAILED (re-trigger) rather than just being queued.
  • recent[] — recent arcs, each { topic (what it was about, so you recognize it), turns, blocks, chain (workspace_get this to read the whole story) }. blocks:0 means it ran and found nothing worth saving — final, not an error.
The 'flags' field reports SELF-MAINTENANCE items the system couldn't resolve alone and ROUTED TO YOU — the small residue the auto-cleaner refuses to guess on (it needs your conversation context, e.g. "are these two entries the same thing, and whose are they?"). needs_your_input = how many wait; items[] are plain-English questions (no ids/schema to fill). Answer from context or ask the user. Usually empty — the system cleans the clear cases itself.
Without agent_id this is the most recent activity (single-agent: that's you); pass your agent_id to scope it to YOUR work.
For relevant ROOTS use workspace_filter; for a specific block use workspace_get.`,
    { agent_id: z.string().optional().describe("Your agent_id — scopes extraction freshness to YOUR recent work. Omit for the most recent activity across all agents.") },
    async ({ agent_id }) => {
      try {
        const stats = db.getStats();
        return ok({
          ...stats,
          embeddings_enabled: embeddings.isAvailable(),
          extraction: db.getExtractionStatus(agent_id),
          flags: buildAgentFlagSurface(db),
        });
      } catch (error) {
        return err("STATS_FAILED", String(error));
      }
    }
  );

  // ─── Tool: workspace_artifact_save ──────────────────────────────
  server.tool(
    "workspace_artifact_save",
    `Save a concrete output (code, document, data, image) produced by agent work.

Storage is automatic based on size:
  < 8KB   → stored inline in the block (fully searchable, part of the knowledge graph)
  8KB–5MB → written to data/artifacts/<block_id>/<filename> on disk, block stores the path + SHA256
  > 5MB   → block stores reference only (path, URL, or external key — content not stored)

Always link to the task that produced it via task_id.
Use workspace_get(id, "content") to read back inline artifacts.
Use the returned path to read back file-based artifacts.`,
    {
      filename:    z.string().describe("Filename with extension, e.g. 'summary.md', 'analysis.py', 'results.json'"),
      content:     z.string().optional().describe("The artifact content as a string. Omit for external/binary artifacts."),
      mime_type:   z.string().optional().describe("MIME type, e.g. 'text/markdown', 'text/x-python', 'application/json'. Auto-detected from filename if omitted."),
      label:       z.string().optional().describe("Block label (auto-generated from filename if omitted)"),
      essence:     z.string().describe("One sentence: what this artifact is and what produced it"),
      task_id:     z.string().optional().describe("Task block ID or label that produced this artifact"),
      agent_id:    z.string().optional().describe("Agent that produced this artifact"),
      external_path: z.string().optional().describe("For large/binary artifacts: the path, URL, or external key where the content lives"),
      save_context: z.object({
        triggered_by: z.array(z.string()).optional().describe("Block IDs or labels that caused this artifact — creates prompted_by relations"),
        problem_being_solved: z.string().optional(),
      }).optional().describe("Causal chain — triggered_by links this artifact to what caused it"),
    },
    async (params) => {
      try {
        const INLINE_THRESHOLD  = 8 * 1024;        // 8KB
        const FILE_THRESHOLD    = 5 * 1024 * 1024; // 5MB

        // Detect MIME type from filename if not provided
        const ext = path.extname(params.filename).toLowerCase();
        const mimeMap: Record<string, string> = {
          ".md": "text/markdown", ".txt": "text/plain", ".py": "text/x-python",
          ".ts": "text/typescript", ".js": "text/javascript", ".json": "application/json",
          ".html": "text/html", ".css": "text/css", ".csv": "text/csv",
          ".yaml": "text/yaml", ".yml": "text/yaml", ".sh": "text/x-sh",
        };
        const mimeType = params.mime_type || mimeMap[ext] || "application/octet-stream";

        const label = params.label || `artifact_${params.filename.replace(/[^a-z0-9]/gi, "_").toLowerCase()}`;
        const contentBytes = params.content ? Buffer.byteLength(params.content, "utf8") : 0;
        const sha256 = params.content
          ? crypto.createHash("sha256").update(params.content).digest("hex").slice(0, 16)
          : null;

        let storage: string;
        let storedPath: string | null = null;
        let inlineBody: string | null = null;

        if (params.external_path) {
          // External reference — just store the pointer
          storage = "external";
          storedPath = params.external_path;
        } else if (!params.content) {
          return err("CONTENT_REQUIRED", "Provide content or external_path");
        } else if (contentBytes <= INLINE_THRESHOLD) {
          // Small — store inline in the block
          storage = "inline";
          inlineBody = params.content;
        } else if (contentBytes <= FILE_THRESHOLD) {
          // Medium — write to disk
          storage = "file";
        } else {
          // Large — store reference only, warn user to provide external_path next time
          storage = "truncated_reference";
        }

        // Create the artifact block first (we need the ID for the file path)
        const block = db.createBlock({
          label,
          type: "artifact",
          essence: params.essence,
          content: {
            unique: {
              filename:   params.filename,
              mime_type:  mimeType,
              size_bytes: String(contentBytes),
              storage,
              sha256:     sha256 || "",
              produced_by: params.agent_id || "",
            },
            has: {
              ...(inlineBody ? { body: inlineBody } : {}),
              ...(storedPath ? { path: storedPath } : {}),
            },
          },
          ttl: "permanent",
        });

        // For file storage: now write to disk using the block ID
        if (storage === "file" && params.content) {
          const dbDir = path.resolve(process.cwd(), "../../data");
          const artifactDir = path.join(dbDir, "artifacts", block.id);
          fs.mkdirSync(artifactDir, { recursive: true });
          storedPath = path.join(artifactDir, params.filename);
          fs.writeFileSync(storedPath, params.content, "utf8");

          // Update block with the path
          const content = typeof block.content === "string" ? JSON.parse(block.content) : block.content;
          db.updateBlock(block.id, {
            content: { ...content, has: { ...content.has, path: storedPath } }
          }, "file path set after write");
        }

        // Link to task if provided
        if (params.task_id) {
          const task = db.getBlock(params.task_id);
          if (task) {
            db.createRelation({
              source_id: block.id,
              target_id: task.id,
              type: "produced_by",
              bidirectional: false,
            });
          }
        }

        // prompted_by relations from save_context.triggered_by
        if (params.save_context?.triggered_by?.length) {
          for (const targetRef of params.save_context.triggered_by) {
            const targetBlock = db.getBlock(targetRef);
            if (targetBlock) {
              db.createRelation({ source_id: block.id, target_id: targetBlock.id, type: "prompted_by" });
            }
          }
        }

        // Compute quality score — artifact blocks score on unique{} + has{} + relations
        {
          const c = typeof block.content === "string" ? JSON.parse(block.content) : (block.content || {});
          let qScore = 1; // essence always present
          // is_a not set by artifact_save → skip
          if (c.unique && Object.keys(c.unique).length >= 2) qScore++; // filename + mime_type etc.
          // concepts not set → skip
          if (db.getRelations(block.id).length > 0) qScore++;
          db.updateBlock(block.id, { quality_score: qScore });
        }

        // Coordinates check
        const hasCausalChain =
          (params.save_context?.triggered_by?.length ?? 0) > 0 ||
          !!params.task_id;
        const missingCoords = hasCausalChain ? undefined
          : "No triggered_by — add save_context.triggered_by or task_id to establish causal chain.";

        return ok({
          id:       block.id,
          label:    block.label,
          storage,
          filename: params.filename,
          size_bytes: contentBytes,
          sha256,
          path: storedPath || null,
          ...(missingCoords ? { missing_coordinates: missingCoords } : {}),
          hint: storage === "inline"
            ? "Content stored in block. Read with workspace_get(id, 'content') → has.body"
            : storage === "file"
            ? `Content written to disk. Path: ${storedPath}`
            : storage === "external"
            ? `External reference stored. Path/URL: ${storedPath}`
            : "Content too large for storage. Store externally and use external_path parameter.",
        });
      } catch (error) {
        return err("ARTIFACT_SAVE_FAILED", String(error));
      }
    }
  );

  // ─── Tool: workspace_challenge ───────────────────────────────────
  server.tool(
    "workspace_challenge",
    `Challenge a fact or decision block made by another agent. Opens a dispute reasoning block.`,
    {
      id: z.string().describe("Block ID or label to challenge"),
      reasoning: z.string().describe("Why is this block incorrect or sub-optimal?"),
    },
    async (params) => {
try {
        const original = db.getBlock(params.id);
        if (!original) return err("BLOCK_NOT_FOUND", `Block '${params.id}' not found`);

        // Create a dispute block
        const challengeBlock = db.createBlock({
          label: `challenge_to_${original.label}`.slice(0, 60),
          type: "note",
          essence: `Challenge to: ${original.essence}`,
          content: {
            dispute_reasoning: params.reasoning,
            challenged_block_id: original.id,
          },
          ttl: "project",
        });

        // Link them
        db.createRelation({
          source_id: challengeBlock.id,
          target_id: original.id,
          type: "challenges",
          bidirectional: false,
        });

        // Mark original as contested
        const originalContent = JSON.parse(original.content);
        db.updateBlock(original.id, {
          content: { ...originalContent, contested: true, contested_by: challengeBlock.id },
        }, "Challenged");

        return ok({
          challenged: true,
          original_id: original.id,
          challenge_block_id: challengeBlock.id,
          status: "contested",
        });
      } catch (error) {
        return err("CHALLENGE_FAILED", String(error));
      }
    }
  );

  // ─── Tool: workspace_stale ───────────────────────────────────────
  server.tool(
    "workspace_stale",
    `Find blocks that have gone stale — not recently accessed relative to their usage history.
Useful for workspace maintenance: find outdated decisions, forgotten facts, or blocks that need review.
Staleness score = days_inactive / log(access_count + 2). Higher = staler.`,
    {
      threshold: z.number().optional().describe("Staleness score cutoff (default: 3.0). Lower = more results."),
      type: z.string().optional().describe("Filter by block type (e.g. 'decision', 'fact')"),
    },
    async (params) => {
      try {
        const threshold = params.threshold ?? 3.0;
        const now = Date.now();
        const allBlocks = db.getAllBlocks().filter((b) => b.status === "active");

        const stale = allBlocks
          .filter((b) => !params.type || b.type === params.type)
          .map((b) => {
            const days = (now - new Date(b.last_accessed).getTime()) / 86400000;
            const score = Math.round((days / Math.log(b.access_count + 2)) * 10) / 10;
            return { id: b.id, label: b.label, type: b.type, essence: b.essence,
              staleness_score: score, days_inactive: Math.floor(days),
              suggestion: score > 10 ? "consider archiving" : score > 6 ? "needs review" : "slightly stale" };
          })
          .filter((b) => b.staleness_score > threshold)
          .sort((a, b) => b.staleness_score - a.staleness_score);

        return ok({
          total_stale: stale.length,
          threshold,
          blocks: stale.slice(0, 20),
          hint: stale.length > 0
            ? "Use workspace_get(id) to review, workspace_update to refresh, or workspace_forget to archive."
            : "Workspace is fresh — no stale blocks found.",
        });
      } catch (error) {
        return err("STALE_FAILED", String(error));
      }
    }
  );

  // ─── Tool: workspace_resolve ──────────────────────────────────────
  server.tool(
    "workspace_resolve",
    `Resolve a contradiction or conflict between two blocks.
Use when two blocks say conflicting things about the same topic, or when a block is outdated.
Actions: keep_this (archive other), keep_other (archive this), archive_this (archive current block only).`,
    {
      block_id: z.string().describe("The block ID in conflict (the one you're acting on)"),
      action: z.enum(["keep_this", "keep_other", "archive_this"]).describe(
        "keep_this = archive the other block | keep_other = archive this block | archive_this = archive this block only"
      ),
      other_id: z.string().optional().describe("The other block ID (required for keep_this or keep_other)"),
      reason: z.string().optional().describe("Why this resolution was chosen — stored in history"),
    },
    async (params) => {
      try {
        const block = db.getBlock(params.block_id);
        if (!block) return err("BLOCK_NOT_FOUND", `Block '${params.block_id}' not found`);

        const other = params.other_id ? db.getBlock(params.other_id) : null;
        if ((params.action === "keep_this" || params.action === "keep_other") && !other) {
          return err("OTHER_REQUIRED", "other_id is required for keep_this / keep_other actions");
        }

        if (params.action === "keep_this") {
          db.archiveBlock(other!.id, params.reason || `Conflict resolved: kept '${block.label}'`);
          return ok({ resolved: true, kept: block.label, archived: other!.label, action: "keep_this" });
        }
        if (params.action === "keep_other") {
          db.archiveBlock(block.id, params.reason || `Conflict resolved: kept '${other!.label}'`);
          return ok({ resolved: true, kept: other!.label, archived: block.label, action: "keep_other" });
        }
        if (params.action === "archive_this") {
          db.archiveBlock(block.id, params.reason || "Archived via conflict resolution");
          return ok({ resolved: true, archived: block.label, action: "archive_this" });
        }

        return err("INVALID_ACTION", "action must be: keep_this | keep_other | archive_this");
      } catch (error) {
        return err("RESOLVE_FAILED", String(error));
      }
    }
  );

  // ─── Tool: workspace_export ───────────────────────────────────────
  server.tool(
    "workspace_export",
    `Export workspace blocks and relations for backup, sharing, or interop with other memory systems.

Formats:
  json      → raw block array (default) — good for backup and reimport
  markdown  → human-readable document — good for sharing with non-agents
  json-ld   → JSON-LD with @context — standard linked-data format for interop with other
              knowledge graph systems (Zep, Mem0, custom agents)`,
    {
      format: z.enum(["json", "markdown", "json-ld"]).optional().describe("Output format (default: json)"),
      include_archived: z.boolean().optional().describe("Include archived blocks (default: false)"),
      type: z.string().optional().describe("Filter by block type (e.g. 'fact', 'decision')"),
      include_relations: z.boolean().optional().describe("Include relations in export (default: true for json-ld)"),
    },
    async (params) => {
      try {
        const allBlocks = db.getAllBlocks();
        const allRelations = db.getAllRelations();
        const filtered = allBlocks.filter((b) => {
          if (!params.include_archived && b.status === "archived") return false;
          if (params.type && b.type !== params.type) return false;
          return true;
        });
        const filteredIds = new Set(filtered.map(b => b.id));

        if (params.format === "markdown") {
          const lines: string[] = [
            `# Workspace Export`,
            `> Generated: ${new Date().toISOString()} | Blocks: ${filtered.length}`,
            ``,
          ];
          for (const b of filtered) {
            lines.push(`## ${b.label}`);
            lines.push(`**Type:** ${b.type} | **TTL:** ${b.ttl}`);
            lines.push(`**Essence:** ${b.essence}`);
            if (b.source) lines.push(`**Source:** ${b.source}`);
            try {
              const content = JSON.parse(b.content as string);
              if (content.unique && Object.keys(content.unique).length) {
                lines.push(`**Properties:**`);
                for (const [k, v] of Object.entries(content.unique)) lines.push(`- ${k}: ${v}`);
              }
            } catch { /* ignore */ }
            const rels = allRelations.filter(r => r.source_id === b.id && filteredIds.has(r.target_id));
            if (rels.length > 0) {
              lines.push(`**Relations:**`);
              rels.forEach(r => {
                const tgt = filtered.find(x => x.id === r.target_id);
                lines.push(`- [${r.type}] → ${tgt?.label || r.target_id}`);
              });
            }
            lines.push(`*Created: ${b.created_at} | Accessed: ${b.access_count}x*`);
            lines.push(``);
          }
          return ok({ format: "markdown", block_count: filtered.length, export: lines.join("\n") });
        }

        if (params.format === "json-ld") {
          // JSON-LD format — standard linked data, interoperable with other knowledge graph systems
          const context = {
            "@vocab": "https://wmcs.agent/ontology#",
            "label":      { "@id": "rdfs:label" },
            "essence":    { "@id": "wmcs:essence" },
            "type":       { "@id": "wmcs:blockType" },
            "created_at": { "@id": "dcterms:created", "@type": "xsd:dateTime" },
            "source":     { "@id": "dcterms:source" },
            "relations":  { "@id": "wmcs:hasRelation", "@container": "@set" },
            "rdfs":    "http://www.w3.org/2000/01/rdf-schema#",
            "wmcs":    "https://wmcs.agent/ontology#",
            "xsd":     "http://www.w3.org/2001/XMLSchema#",
            "dcterms": "http://purl.org/dc/terms/",
          };

          const graph = filtered.map(b => {
            const content = (() => { try { return JSON.parse(b.content as string); } catch { return {}; } })();
            const rels = allRelations
              .filter(r => r.source_id === b.id && filteredIds.has(r.target_id))
              .map(r => ({ "@type": r.type, "target": r.target_id }));
            return {
              "@id":        `wmcs:block/${b.id}`,
              "@type":      `wmcs:${b.type}`,
              "label":      b.label,
              "essence":    b.essence,
              "created_at": b.created_at,
              ...(b.source ? { "source": b.source } : {}),
              ...(content.unique ? { "properties": content.unique } : {}),
              ...(content.concepts?.length ? { "concepts": content.concepts } : {}),
              ...(rels.length > 0 ? { "relations": rels } : {}),
            };
          });

          return ok({
            format: "json-ld",
            block_count: filtered.length,
            relation_count: allRelations.filter(r => filteredIds.has(r.source_id) && filteredIds.has(r.target_id)).length,
            export: { "@context": context, "@graph": graph },
          });
        }

        // Default: JSON with relations
        const withRelations = params.include_relations !== false;
        const exportData = filtered.map(b => ({
          ...b,
          ...(withRelations ? {
            relations: allRelations
              .filter(r => r.source_id === b.id)
              .map(r => ({ type: r.type, target_id: r.target_id }))
          } : {}),
        }));
        return ok({ format: "json", block_count: filtered.length, export: exportData });
      } catch (error) {
        return err("EXPORT_FAILED", String(error));
      }
    }
  );

  // ─── Tool: workspace_find_skill ──────────────────────────────────
  server.tool(
    "workspace_find_skill",
    `Find stored skills, procedures, or reusable knowledge that can help with a problem.
Searches across ALL block types — not just 'process'. Cross-domain retrieval: a debugging technique may surface when solving a negotiation problem if they share abstract concepts.
Each result tells you WHAT it is, WHY it matched, and HOW to apply it.
Use this before solving a problem to check if you've already stored a relevant approach.`,
    {
      problem:      z.string().describe("Describe what you are trying to do or the problem you face"),
      concepts:     z.array(z.string()).optional().describe("Explicit concept tags to search for (e.g. ['systematic_elimination', 'rate_limiting']). Added on top of extracted concepts."),
      block_types:  z.array(z.string()).optional().describe("Restrict to specific types (e.g. ['process', 'fact']). Default: all types."),
      limit:        z.number().optional().describe("Max results to return. Default: 5"),
    },
    async (params) => {
      try {
        const limit = params.limit ?? 5;
        const STOPWORDS = new Set(["the","is","a","an","to","of","in","for","on","with","and","or","but","it","this","that","how","what","why","can","do","be","are","was","were","will","i","my","we","our"]);

        // Extract concepts from problem description
        const queryConcepts = [
          ...params.problem.toLowerCase().replace(/[^a-z0-9_ ]/g, " ").split(/\s+/).filter((w) => w.length > 2 && !STOPWORDS.has(w)),
          ...(params.concepts ?? []).map((c) => c.toLowerCase()),
        ];

        const allBlocks = db.getAllBlocks().filter((b) => {
          if (b.status === "archived") return false;
          if (params.block_types?.length) return params.block_types.includes(b.type);
          return true;
        });

        // Score each block on three axes
        const scored: Array<{
          block: typeof allBlocks[0];
          score: number;
          matchedConcepts: string[];
          semanticSim: number;
          keywordHit: boolean;
        }> = [];

        // Semantic vector for the problem
        let queryVec: number[] | null = null;
        if (embeddings.isAvailable()) {
          try { queryVec = await embeddings.embed(params.problem); } catch { /* ignore */ }
        }

        for (const block of allBlocks) {
          let blockConcepts: string[] = [];
          let blockContent: any = {};
          try {
            blockContent = typeof block.content === "string" ? JSON.parse(block.content) : block.content;
            blockConcepts = (blockContent.concepts || []).map((c: string) => c.toLowerCase());
          } catch { /* ignore */ }

          // Concept overlap
          const matched = queryConcepts.filter((qc) =>
            blockConcepts.some((bc) => bc.includes(qc) || qc.includes(bc))
          );

          // Semantic similarity
          let semSim = 0;
          if (queryVec && block.embedding) {
            try {
              const bv = JSON.parse(block.embedding) as number[];
              semSim = cosineSim(queryVec, bv);
            } catch { /* ignore */ }
          }

          // Keyword hit
          const probLower = params.problem.toLowerCase();
          const keywordHit =
            block.label.toLowerCase().split("_").some((w) => probLower.includes(w)) ||
            block.essence.toLowerCase().split(" ").some((w) => w.length > 3 && probLower.includes(w));

          const score =
            matched.length * 0.4 +    // concept overlap — strongest signal
            semSim * 0.45 +            // semantic meaning
            (keywordHit ? 0.15 : 0);  // surface keyword bonus

          if (score > 0.1 || matched.length > 0) {
            scored.push({ block, score, matchedConcepts: matched, semanticSim: semSim, keywordHit });
          }
        }

        scored.sort((a, b) => b.score - a.score);
        const top = scored.slice(0, limit);

        if (top.length === 0) {
          return ok({
            found: 0,
            skills: [],
            hint: "No matching skills found. Consider saving a process block with workspace_remember(type:'process', concepts:[...]).",
          });
        }

        // Build clear, structured output — each result tells the agent exactly what it is
        const skills = top.map(({ block, score, matchedConcepts, semanticSim, keywordHit }) => {
          let content: any = {};
          try { content = typeof block.content === "string" ? JSON.parse(block.content) : block.content; } catch { /* ignore */ }

          // Determine WHY it was matched — shown to agent so they can judge relevance
          const reasons: string[] = [];
          if (matchedConcepts.length > 0) reasons.push(`shared concepts: ${matchedConcepts.join(", ")}`);
          if (semanticSim > 0.65) reasons.push(`semantically similar (${Math.round(semanticSim * 100)}%)`);
          if (keywordHit) reasons.push("keyword match");

          // Extract steps / procedure from 'has' field if available
          const steps: string[] = [];
          if (content.has) {
            for (const [k, v] of Object.entries(content.has)) {
              if (Array.isArray(v)) steps.push(...v.map((s) => `${k}: ${s}`));
              else if (typeof v === "string") steps.push(`${k}: ${v}`);
            }
          }

          // Determine if this is a transferable pattern vs domain-specific knowledge
          const isTransferable = matchedConcepts.length > 0 && semanticSim < 0.75;
          const domainNote = isTransferable
            ? `This ${block.type} is from a different domain but shares abstract concepts with your problem.`
            : `This ${block.type} directly relates to your problem.`;

          return {
            id:           block.id,
            label:        block.label,
            type:         block.type,
            what_it_is:   block.essence,
            match_reason: reasons.join(" + ") || "weak match",
            match_score:  Math.round(score * 100) / 100,
            is_transferable: isTransferable,
            domain_note:  domainNote,
            concepts:     (content.concepts as string[]) || [],
            steps:        steps.length > 0 ? steps : undefined,
            created_by:   block.created_by || null,
            how_to_use:   block.type === "process"
              ? "Apply the steps in 'content' field. Adapt to your specific context."
              : block.type === "fact"
              ? "Use as reference data. Verify if outdated (check updated_at)."
              : block.type === "decision"
              ? "Treat as established direction. Challenge via workspace_challenge() if you disagree."
              : "Use as supporting knowledge. Call workspace_get(id) for full detail.",
            full_detail: `workspace_get("${block.id}")`,
          };
        });

        return ok({
          found: skills.length,
          query_concepts: queryConcepts.slice(0, 10),
          skills,
          hint: skills.some((s) => s.is_transferable)
            ? "Some results are cross-domain transfers (different topic, same pattern). Check match_reason and domain_note before applying."
            : "Results are direct matches. Apply with confidence.",
        });
      } catch (error) {
        return err("FIND_SKILL_FAILED", String(error));
      }
    }
  );

  // ─── Tool: workspace_reembed ─────────────────────────────────────
  server.tool(
    "workspace_reembed",
    `Backfill semantic embeddings for blocks that are missing them.
Blocks without embeddings are invisible to semantic search, concept recall, workspace_find_skill,
and workspace_infer_relations — they silently return no results. Run this once after connecting
a Gemini API key, or after importing blocks from another source.
Use force:true to regenerate embeddings for ALL blocks (e.g., after changing the embedding model).`,
    {
      force: z.boolean().optional().describe("Re-embed ALL blocks, not just missing ones. Default: false"),
      limit: z.number().optional().describe("Max blocks to process in one call (to avoid rate limits). Default: 50"),
    },
    async (params) => {
      if (!embeddings.isAvailable()) {
        return err("EMBEDDINGS_UNAVAILABLE",
          "Embedding provider not available. Set GEMINI_API_KEY or OPENAI_API_KEY in .env and restart.");
      }

      try {
        const force = params.force ?? false;
        const limit = params.limit ?? 50;

        const targets = force
          ? db.getAllBlocks().filter((b) => b.status !== "archived")
          : db.getBlocksWithoutEmbeddings();

        const batch = targets.slice(0, limit);
        let embedded = 0;
        let skipped  = 0;
        let errors   = 0;
        const failed: string[] = [];

        for (const block of batch) {
          // Skip sensitive blocks — don't send encrypted content to external API
          if (block.is_sensitive) { skipped++; continue; }

          try {
            const vec = await embeddings.embedForBlock({
              essence:  block.essence,
              concepts: block.concepts,
            });
            if (vec) {
              db.updateEmbedding(block.id, vec);
              embedded++;
            } else {
              errors++;
              failed.push(block.label);
            }
          } catch {
            errors++;
            failed.push(block.label);
          }
        }

        // Save once after batch
        db.save();

        const remaining = targets.length - batch.length;
        return ok({
          processed: batch.length,
          embedded,
          skipped_sensitive: skipped,
          errors,
          failed_labels: failed.length > 0 ? failed : undefined,
          remaining_after_this_call: remaining,
          hint: remaining > 0
            ? `${remaining} blocks still need embeddings. Call workspace_reembed again (with limit:${limit}) to continue.`
            : "All blocks now have embeddings. Semantic search and skill retrieval are fully operational.",
        });
      } catch (error) {
        return err("REEMBED_FAILED", String(error));
      }
    }
  );

  // ─── Tool: workspace_review_pending ──────────────────────────────
  server.tool(
    "workspace_review_pending",
    `Review inferred relations waiting for approval. Three modes:
1. No params → list all pending (see what needs review)
2. approve_ids / reject_ids → manually act on specific relation IDs
3. use_ai:true → Gemini evaluates every pending relation and auto-approves/rejects/corrects

use_ai mode asks Gemini: "Is this relation type accurate between these two blocks?"
- Confident yes → approved (active)
- No → rejected (deleted)
- Better type exists → relation type is corrected then approved`,
    {
      approve_ids: z.array(z.string()).optional().describe("Relation IDs to approve"),
      reject_ids:  z.array(z.string()).optional().describe("Relation IDs to reject"),
      use_ai:      z.boolean().optional().describe("Let Gemini batch-evaluate all pending relations. Default: false"),
    },
    async (params) => {
      try {
        const approved: string[] = [];
        const rejected: string[] = [];
        const corrected: Array<{ id: string; old_type: string; new_type: string }> = [];

        // ── Manual actions ───────────────────────────────────────
        for (const id of (params.approve_ids ?? [])) { db.approveRelation(id); approved.push(id); }
        for (const id of (params.reject_ids  ?? [])) { db.rejectRelation(id);  rejected.push(id); }

        // ── AI bulk review ───────────────────────────────────────
        if (params.use_ai) {
          const reviewProvider = getLLMProvider();
          if (!reviewProvider.isAvailable()) {
            return err("NO_AI_KEY", "AI provider not available. Set an API key in .env to use AI review.");
          }

          const reviewSysInstr = `You are a knowledge graph curator. Given two knowledge blocks and a proposed relation type, decide if the relation is accurate.

Valid relation types: implements, enables, depends_on, affects, describes, conflicts_with, replaces, related_to, part_of

Respond with EXACTLY one of:
- "approve" — relation type is correct
- "reject"  — no meaningful relation between these blocks
- "change:NEW_TYPE" — relation exists but type is wrong (e.g. "change:enables")

Nothing else. One word or one phrase.`;

          const pending = db.getPendingRelations();
          for (const r of pending) {
            const prompt = `${reviewSysInstr}\n\nBlock A: [${r.source_label}] "${r.source_label}"
Block B: [${r.target_label}] "${r.target_label}"
Proposed relation (A → B): ${r.type}`;

            try {
              const reviewText = await reviewProvider.generate(prompt);
              const answer = (reviewText ?? "").trim().toLowerCase();

              if (answer === "approve") {
                db.approveRelation(r.id);
                approved.push(r.id);
              } else if (answer === "reject") {
                db.rejectRelation(r.id);
                rejected.push(r.id);
              } else if (answer.startsWith("change:")) {
                const newType = answer.replace("change:", "").trim().replace(/[^a-z_]/g, "");
                if (newType) {
                  // Update type then approve
                  (db as any)["db"].prepare(
                    `UPDATE relations SET type = ?, status = 'active' WHERE id = ?`
                  ).run(newType, r.id);
                  corrected.push({ id: r.id, old_type: r.type, new_type: newType });
                  approved.push(r.id);
                } else {
                  db.approveRelation(r.id);
                  approved.push(r.id);
                }
              }
            } catch { /* skip on error */ }
          }
        }

        const stillPending = db.getPendingRelations();
        return ok({
          approved:        approved.length,
          rejected:        rejected.length,
          corrected:       corrected.length > 0 ? corrected : undefined,
          still_pending:   stillPending.length,
          pending_relations: stillPending.map((r) => ({
            id:          r.id,
            from:        r.source_label,
            type:        r.type,
            to:          r.target_label,
            inferred_by: r.created_by,
          })),
          hint: stillPending.length > 0
            ? "Pass approve_ids/reject_ids to act manually, or use_ai:true for Gemini batch review."
            : "No pending relations — graph is fully reviewed.",
        });
      } catch (error) {
        return err("REVIEW_PENDING_FAILED", String(error));
      }
    }
  );

  // ─── Tool: workspace_gaps ────────────────────────────────────────
  server.tool(
    "workspace_gaps",
    `Detect knowledge gaps and structural issues in the workspace.
Runs three passes:
1. Orphan blocks — blocks with zero relations (isolated, under-connected)
2. Task coverage — open tasks with no linked decision or constraint (committed work with no direction)
3. Open questions — blocks of type 'question' that have no linked answer block
Use this to self-direct: find what's missing and what needs attention.`,
    {
      project: z.string().optional().describe("Scope to a specific project (by name). Omit for workspace-wide."),
    },
    async (params) => {
      try {
        const allBlocks = db.getAllBlocks().filter((b) => b.status !== "archived");
        const allRelations = db.getAllRelations(false);

        // Build set of block IDs with at least one relation
        const connectedIds = new Set<string>();
        for (const rel of allRelations) {
          connectedIds.add(rel.source_id);
          connectedIds.add(rel.target_id);
        }

        // Filter to project scope if given
        let scopeBlocks = allBlocks;
        if (params.project) {
          const projectKey = params.project.toLowerCase();
          const projectBlock = allBlocks.find((b) => b.type === "project" && b.label.toLowerCase() === projectKey);
          if (projectBlock) {
            const projectRelatedIds = new Set([
              projectBlock.id,
              ...allRelations
                .filter((r) => r.source_id === projectBlock.id || r.target_id === projectBlock.id)
                .map((r) => r.source_id === projectBlock.id ? r.target_id : r.source_id),
            ]);
            scopeBlocks = allBlocks.filter((b) => projectRelatedIds.has(b.id));
          }
        }

        // ── Pass 1: Orphan blocks ─────────────────────────────────
        const orphans = scopeBlocks
          .filter((b) =>
            b.type !== "project" &&
            !connectedIds.has(b.id) &&
            !b.label.startsWith("agent_session_") // session blocks are always unlinked by design
          )
          .map((b) => ({ id: b.id, label: b.label, type: b.type, essence: b.essence, created_at: b.created_at }));

        // ── Pass 2: Task coverage ─────────────────────────────────
        const tasks = scopeBlocks.filter((b) => b.type === "task");
        const taskGaps: Array<{ id: string; label: string; essence: string; missing: string[] }> = [];
        for (const task of tasks) {
          try {
            const c = JSON.parse(task.content);
            const status = c?.unique?.status || c?.status || "";
            if (["done", "completed", "archived"].includes(String(status).toLowerCase())) continue;
          } catch { /* check anyway */ }

          const taskRels = allRelations.filter((r) => r.source_id === task.id || r.target_id === task.id);
          const linkedTypes = new Set(taskRels.map((r) => {
            const otherId = r.source_id === task.id ? r.target_id : r.source_id;
            const other = allBlocks.find((b) => b.id === otherId);
            return other?.type;
          }));

          const missing: string[] = [];
          if (!linkedTypes.has("decision")) missing.push("decision");
          if (!linkedTypes.has("constraint")) missing.push("constraint");
          if (missing.length > 0) {
            taskGaps.push({ id: task.id, label: task.label, essence: task.essence, missing });
          }
        }

        // ── Pass 3: Open questions ────────────────────────────────
        const questions = scopeBlocks.filter((b) => b.type === "question");
        const openQuestions: Array<{ id: string; label: string; essence: string }> = [];
        for (const q of questions) {
          const qRels = allRelations.filter((r) => r.source_id === q.id || r.target_id === q.id);
          const hasAnswer = qRels.some((r) => {
            const otherId = r.source_id === q.id ? r.target_id : r.source_id;
            const other = allBlocks.find((b) => b.id === otherId);
            return other && ["fact", "decision", "answer"].includes(other.type);
          });
          if (!hasAnswer) {
            openQuestions.push({ id: q.id, label: q.label, essence: q.essence });
          }
        }

        // ── Pass 4: Open near-duplicate conflicts ─────────────────
        const openConflicts = db.getOpenConflicts();

        // ── Pass 5: Unlinked dead ends ────────────────────────────
        // Dead end blocks that have no `contradicts` relation — the failure was
        // captured but never linked to what it conflicted with, making it harder
        // to navigate to from the thing it negates.
        const deadEnds = scopeBlocks.filter((b) => b.type === "dead_end");
        const unlinkedDeadEnds = deadEnds.filter((b) => {
          const rels = allRelations.filter((r) => r.source_id === b.id || r.target_id === b.id);
          return !rels.some((r) => r.type === "contradicts");
        }).map((b) => ({ id: b.id, label: b.label, essence: b.essence,
          hint: "Add a `contradicts` relation linking this to the block it conflicts with" }));

        // ── Pass 6: Drafts never promoted ────────────────────────
        // Draft blocks older than 7 days that haven't been promoted to fact/decision
        const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
        const staleDrafts = scopeBlocks.filter((b) => {
          if (b.type !== "draft") return false;
          const c = (() => { try { return JSON.parse(b.content); } catch { return {}; } })();
          const draftStatus = c?.unique?.draft_status;
          return draftStatus !== "promoted" && b.created_at < sevenDaysAgo;
        }).map((b) => ({ id: b.id, label: b.label, essence: b.essence, created_at: b.created_at,
          hint: "Promote to fact/decision or archive if no longer needed" }));

        // ── Pass 7: next_questions from project blocks ─────────────
        const nextQuestions: Array<{ project: string; question: string }> = [];
        for (const b of scopeBlocks) {
          if (b.type !== "project") continue;
          try {
            const c = JSON.parse(b.content as string);
            const nq: string[] = c?.next_questions || c?.has?.next_questions || [];
            for (const q of nq) nextQuestions.push({ project: b.label, question: q });
          } catch { /* skip */ }
        }

        const totalGaps = orphans.length + taskGaps.length + openQuestions.length +
          openConflicts.length + unlinkedDeadEnds.length + staleDrafts.length;

        return ok({
          project:        params.project ?? "all",
          scoped_blocks:  scopeBlocks.length,
          gaps: {
            orphan_blocks:       { count: orphans.length, blocks: orphans },
            task_coverage:       { count: taskGaps.length, tasks: taskGaps },
            open_questions:      { count: openQuestions.length, questions: openQuestions },
            open_conflicts:      { count: openConflicts.length, conflicts: openConflicts },
            unlinked_dead_ends:  { count: unlinkedDeadEnds.length, dead_ends: unlinkedDeadEnds },
            stale_drafts:        { count: staleDrafts.length, drafts: staleDrafts },
            next_questions:      { count: nextQuestions.length, items: nextQuestions },
          },
          summary: totalGaps === 0
            ? `No gaps detected.${nextQuestions.length ? ` ${nextQuestions.length} next question(s) queued from project blocks.` : " Knowledge graph looks healthy."}`
            : `Found ${orphans.length} orphans, ${taskGaps.length} under-specified tasks, ${openQuestions.length} unanswered questions, ${openConflicts.length} duplicate conflicts, ${unlinkedDeadEnds.length} unlinked dead ends, ${staleDrafts.length} stale drafts.${nextQuestions.length ? ` ${nextQuestions.length} next question(s) from projects.` : ""}`,
        });
      } catch (error) {
        return err("GAPS_FAILED", String(error));
      }
    }
  );

  // ─── Tool: workspace_resolve_conflict ────────────────────────────
  server.tool(
    "workspace_resolve_conflict",
    `Resolve a near-duplicate conflict between two blocks.
Use workspace_gaps() to find open conflicts first.

Resolution options:
- keep_a: archive block_b, keep block_a as-is
- keep_b: archive block_a, keep block_b as-is
- merge:  write a combined essence to block_a, archive block_b`,
    {
      conflict_id:   z.string().describe("Conflict ID from workspace_gaps() output"),
      resolution:    z.enum(["keep_a", "keep_b", "merge"]).describe("How to resolve: keep_a, keep_b, or merge"),
      merged_essence: z.string().optional().describe("Required if resolution is 'merge' — the combined essence for the surviving block"),
      reason:        z.string().optional().describe("Why you chose this resolution"),
    },
    async (params) => {
      try {
        const conflicts = db.getOpenConflicts();
        const conflict = conflicts.find((c) => c.id === params.conflict_id);
        if (!conflict) {
          return err("CONFLICT_NOT_FOUND", `Conflict '${params.conflict_id}' not found or already resolved. Use workspace_gaps() to see open conflicts.`);
        }

        const blockA = db.getBlock(conflict.block_a.id);
        const blockB = db.getBlock(conflict.block_b.id);
        if (!blockA || !blockB) {
          return err("BLOCK_NOT_FOUND", "One or both blocks in this conflict no longer exist.");
        }

        let keptId: string;
        let archivedId: string;

        if (params.resolution === "keep_a") {
          keptId = blockA.id;
          archivedId = blockB.id;
          db.archiveBlock(blockB.id, `resolved near-duplicate conflict ${params.conflict_id}: kept ${blockA.label}`);
        } else if (params.resolution === "keep_b") {
          keptId = blockB.id;
          archivedId = blockA.id;
          db.archiveBlock(blockA.id, `resolved near-duplicate conflict ${params.conflict_id}: kept ${blockB.label}`);
        } else {
          // merge
          if (!params.merged_essence) {
            return err("MERGE_REQUIRES_ESSENCE", "Resolution 'merge' requires a merged_essence string.");
          }
          keptId = blockA.id;
          archivedId = blockB.id;
          db.updateBlock(blockA.id, { essence: params.merged_essence },
            `merged with ${blockB.label} (conflict ${params.conflict_id})`, undefined, true);
          db.archiveBlock(blockB.id, `merged into ${blockA.label} via conflict ${params.conflict_id}`);
        }

        db.resolveConflict(params.conflict_id, `${params.resolution}${params.reason ? `: ${params.reason}` : ""}`);

        return ok({
          resolved:  true,
          conflict_id: params.conflict_id,
          resolution: params.resolution,
          kept_block:     keptId,
          archived_block: archivedId,
          hint: params.resolution === "merge"
            ? `Blocks merged. Run workspace_infer_relations() to update graph links.`
            : `Conflict resolved. Archived block is preserved in history.`,
        });
      } catch (error) {
        return err("RESOLVE_FAILED", String(error));
      }
    }
  );

  // ─── Tool: workspace_review ──────────────────────────────────────
  // Agent↔Gemini dialog: ask Gemini to review a block and suggest improvements.
  // Gemini's response is stored as gemini_suggestions in the block AND as a linked note.
  // The agent stays in control — suggestions must be explicitly accepted via workspace_update.
  server.tool(
    "workspace_review",
    `Ask Gemini to review a block and suggest structural improvements.

This is the agent↔Gemini dialogue tool. Gemini analyzes the block and returns:
- Suggested is_a (parent category)
- Suggested unique{} properties (what makes it distinctive)
- Suggested has{} content (examples, extensions, caveats)
- Better concepts (domain-agnostic patterns)
- Essence rewrite if the current one is vague
- Conflict check against common knowledge

Gemini's suggestions are stored on the block as gemini_suggestions{} so future sessions can see them.
The agent decides what to accept — call workspace_update() to promote any suggestion to canonical data.
This keeps agent authority intact: Gemini advises, agent decides.`,
    {
      id:       z.string().describe("Block ID or label to review"),
      question: z.string().optional().describe("Specific question for Gemini (e.g. 'Is my is_a classification right?' or 'What properties am I missing?'). Default: general quality review."),
      save_response: z.boolean().optional().describe("Save Gemini's response as a linked note block for future recall. Default: true"),
    },
    async (params) => {
      try {
        const reviewProvider = getLLMProvider();
        if (!reviewProvider.isAvailable()) return err("NO_AI_KEY", "AI provider not available — check your API key in .env");

        const block = db.getBlock(params.id);
        if (!block) return err("BLOCK_NOT_FOUND", `Block '${params.id}' not found`);

        const content = (() => { try { return JSON.parse(block.content); } catch { return {}; } })();
        const concepts: string[] = (() => { try { return JSON.parse((block as any).concepts || "[]"); } catch { return []; } })();

        const prompt = `You are a knowledge quality reviewer for a semantic knowledge graph.
Review this knowledge block and return structured suggestions to improve it.

BLOCK:
- label: ${block.label}
- type: ${block.type}
- essence: ${block.essence}
- is_a: ${content.is_a || "NOT SET"}
- unique properties: ${content.unique ? JSON.stringify(content.unique) : "NONE"}
- has: ${content.has ? JSON.stringify(content.has) : "NONE"}
- concepts: ${concepts.join(", ") || "NONE"}

AGENT QUESTION: ${params.question || "General review — what is this block missing to be maximally useful for cross-domain recall and reasoning?"}

Return ONLY valid JSON with this exact shape:
{
  "is_a": "suggested parent category string",
  "unique": { "key": "value" },
  "has": { "key": "value" },
  "concepts": ["abstract1", "abstract2", "abstract3"],
  "essence_improvement": "improved one-liner or null if current is good",
  "quality_verdict": "thin|acceptable|rich",
  "quality_reasoning": "one sentence explaining the verdict",
  "conflict_check": "any factual concerns or null"
}`;

        const reviewText = await reviewProvider.generate(prompt);
        const raw = (reviewText ?? "").replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
        let suggestions: Record<string, unknown> = {};
        try { suggestions = JSON.parse(raw); } catch {
          return err("AI_PARSE_ERROR", `AI provider returned non-JSON: ${raw.slice(0, 200)}`);
        }

        // Store suggestions on the block (not overwriting canonical fields)
        const updatedContent = {
          ...content,
          gemini_suggestions: {
            ...suggestions,
            reviewed_at: new Date().toISOString(),
            question: params.question || "general review",
          },
        };
        db.updateBlock(block.id, { content: JSON.stringify(updatedContent) },
          `AI review stored as suggestions — agent must accept via workspace_update`, "ai_review");

        // Optionally save as a linked note block for future recall
        let reviewBlockId: string | null = null;
        if (params.save_response !== false) {
          const reviewBlock = db.createBlock({
            label:     `gemini_review_${block.label}`.slice(0, 60),
            type:      "note",
            essence:   `Gemini review of '${block.label}': ${suggestions.quality_verdict || "reviewed"} — ${suggestions.quality_reasoning || ""}`,
            content:   { review_of: block.id, suggestions },
            concepts:  concepts.slice(0, 4),
            ttl:       "permanent",
          });
          db.createRelation({ source_id: reviewBlock.id, target_id: block.id, type: "review_of", created_by: "gemini" });
          reviewBlockId = reviewBlock.id;
        }

        return ok({
          block_id:       block.id,
          block_label:    block.label,
          quality_verdict: suggestions.quality_verdict,
          quality_reasoning: suggestions.quality_reasoning,
          suggestions: {
            is_a:                suggestions.is_a,
            unique:              suggestions.unique,
            has:                 suggestions.has,
            concepts:            suggestions.concepts,
            essence_improvement: suggestions.essence_improvement,
            conflict_check:      suggestions.conflict_check,
          },
          review_block_id: reviewBlockId,
          next_step: `To accept suggestions: workspace_update("${block.id}", { is_a: "...", unique: {...}, concepts: [...] }). Suggestions also stored in block as gemini_suggestions{}.`,
        });
      } catch (error) {
        return err("REVIEW_FAILED", String(error));
      }
    }
  );

  // ─── Tool: workspace_enrich ──────────────────────────────────────
  server.tool(
    "workspace_enrich",
    `Batch-upgrade keyword-only concepts to abstract semantic patterns using Gemini Flash.
Targets blocks where concepts were auto-extracted (keyword_auto source) or have ≤3 concepts.
Run this in the background after a session to improve search quality over time.
Returns per-block results: old concepts → new concepts.`,
    {
      limit: z.number().optional().describe("Max blocks to enrich in this batch (default: 20)"),
      block_ids: z.array(z.string()).optional().describe("Specific block IDs to enrich (overrides auto-selection)"),
    },
    async (params) => {
      try {
        const enrichProvider = getLLMProvider();
        if (!enrichProvider.isAvailable()) return err("NO_AI_KEY", "AI provider not available — check your API key in .env");

        // Select targets: blocks with keyword_auto concepts or ≤3 concepts
        let targets: ReturnType<typeof db.getAllBlocks>;
        if (params.block_ids && params.block_ids.length > 0) {
          targets = params.block_ids
            .map((id) => db.getBlock(id))
            .filter(Boolean) as ReturnType<typeof db.getAllBlocks>;
        } else {
          const allBlocks = db.getAllBlocks();
          targets = allBlocks.filter((b) => {
            try {
              const content = JSON.parse(b.content);
              // Skip already-merged blocks; target keyword_auto, gemini_reflect, or sparse concepts
              if (content.concepts_source === "merged") return false;
              const concepts: string[] = JSON.parse(b.concepts as string || "[]");
              return content.concepts_source === "keyword_auto"
                || content.concepts_source === "gemini_reflect"
                || concepts.length <= 3;
            } catch { return false; }
          }).slice(0, params.limit ?? 20);
        }

        if (targets.length === 0) {
          return ok({ enriched: 0, message: "No blocks need enrichment." });
        }

        const enrichSysInstr = `You are a knowledge graph concept extractor.
Given a block's label, type, and essence, return 3-6 abstract conceptual tags.
Tags should be ABSTRACT PATTERNS (e.g., "iterative_refinement", "context_switching", "trust_signal")
NOT literal keywords from the text (e.g., not "workflow" from "workflow optimization").
Respond ONLY with a JSON array of strings, no explanation.`;

        const results: Array<{ id: string; label: string; old_concepts: string[]; new_concepts: string[]; status: string }> = [];

        for (const block of targets) {
          try {
            let content: Record<string, unknown> = {};
            try { content = JSON.parse(block.content); } catch { /* skip */ }
            // Read from first-class concepts column first; fall back to content JSON
            const oldConcepts: string[] = (() => {
              try { return JSON.parse(block.concepts as string || "[]"); } catch { return []; }
            })();

            const prompt = `${enrichSysInstr}

Block label: "${block.label}"
Type: ${block.type}
Essence: "${block.essence}"
Agent concepts (concrete, domain-specific — DO NOT remove these): ${JSON.stringify(oldConcepts)}

Your job: add 3-5 ABSTRACT cross-domain pattern tags that complement the agent's concepts.
These should capture the underlying patterns so this block surfaces in unexpected but relevant searches.
Example: agent has ["glymphatic","amyloid","alzheimers"] → you add ["waste_clearance","nocturnal_maintenance","neurodegeneration_risk"]
Do NOT repeat what the agent already has. Do NOT replace — only ADD.

Return ONLY a JSON array of your additional abstract tags (not the full merged list).`;

            const enrichText = await enrichProvider.generate(prompt);
            const raw = (enrichText ?? "").trim().replace(/```json\n?|```/g, "");
            const aiConcepts: string[] = JSON.parse(raw);

            if (Array.isArray(aiConcepts) && aiConcepts.length > 0) {
              // MERGE: agent concepts (concrete) + AI concepts (abstract) — never replace
              const merged = [...new Set([...oldConcepts, ...aiConcepts])].slice(0, 12);
              content.agent_concepts = oldConcepts;       // preserve originals
              content.gemini_concepts = aiConcepts;       // AI's additions (field name kept for compat)
              content.concepts = merged;                  // full merged set for search
              content.concepts_source = "merged";
              db.updateBlock(block.id, {
                content: JSON.stringify(content),
                concepts: merged,                         // update first-class column too
              }, "concepts enriched by workspace_enrich (merged)", "system");
              // Re-embed with full merged concept set for better semantic coverage
              if (embeddings.isAvailable()) {
                const embText = blockEmbeddingText({ essence: block.essence, concepts: merged });
                const vec = await embeddings.embed(embText);
                if (vec) db.updateEmbedding(block.id, vec);
              }
              results.push({ id: block.id, label: block.label, old_concepts: oldConcepts, new_concepts: merged, status: "enriched" });
            } else {
              results.push({ id: block.id, label: block.label, old_concepts: oldConcepts, new_concepts: oldConcepts, status: "unchanged" });
            }
          } catch (blockErr) {
            results.push({ id: block.id, label: block.label, old_concepts: [], new_concepts: [], status: `error: ${String(blockErr)}` });
          }
        }

        const enrichedCount = results.filter((r) => r.status === "enriched").length;
        return ok({
          enriched: enrichedCount,
          total_processed: results.length,
          results,
        });
      } catch (error) {
        return err("ENRICH_FAILED", String(error));
      }
    }
  );

  // ─── Tool: workspace_extract_arc (DEBT 5 Phase 7) ────────────────────────
  // Trigger arc extraction over a range of pass01_done turns for an agent.
  // Per design §3.1 trigger model. Composes with the same backend
  // (runArcExtraction) as the phase tag detector and /api/conversations/.../
  // extract endpoint — different invocation paths, same downstream effect.
  //
  // Naming per inventory §10: workspace_extract_arc — verb stem `extract` is
  // unused in the existing tool family; fits system.ts module.
  server.tool(
    "workspace_extract_arc",
    `Trigger arc extraction over a range of conversation turns for an agent.
Reads pass01_done turns (Phase 2 captured Pass 0-1 outputs), consolidates
them into a single arc input (D1 raw transcripts + D4 sew-as-event framing),
runs Pass 2-5, writes blocks with line-level provenance (D3 source_excerpt
column), creates a conversation_turn_ranges row, and flips the turns to
'extracted' status.

Defaults: if start_turn / end_turn are omitted, extracts ALL pass01_done turns
for the agent. If re_extract is true, creates a 're-extract' range (vs 'arc')
so the second extraction event is auditable as intentional.

Requires NODEDEX_ARC_EXTRACTION=1 in env for per-turn capture to populate the
table (otherwise no pass01_done turns will exist and this returns 'no_turns').`,
    {
      agent_id: z.string().describe("A stable identifier for the agent/session (e.g. the x-nodedex-agent-id request header, or your host's session id)"),
      start_turn: z.number().int().positive().optional().describe("Turn number to start from (default: first pass01_done turn)"),
      end_turn: z.number().int().positive().optional().describe("Turn number to end at, inclusive (default: latest pass01_done turn)"),
      re_extract: z.boolean().optional().describe("When true, marks the range as 're-extract' (vs 'arc'). Default false."),
    },
    async (params) => {
      try {
        if (params.start_turn !== undefined && params.end_turn !== undefined && params.end_turn < params.start_turn) {
          return err("INVALID_RANGE", `end_turn (${params.end_turn}) cannot be less than start_turn (${params.start_turn})`);
        }
        const result = await runArcExtraction(db, {
          agent_id: params.agent_id,
          start_turn: params.start_turn,
          end_turn: params.end_turn,
          re_extract: params.re_extract === true,
          trigger_source: "mcp_tool",
        });
        if (result.status === "no_turns") {
          return err("NO_TURNS", `No pass01_done turns found for agent ${params.agent_id} in range. Ensure NODEDEX_ARC_EXTRACTION=1 is set so per-turn capture populates conversation_turns.`);
        }
        if (result.status === "pipeline_failed") {
          return err("PIPELINE_FAILED", result.error ?? "arc extraction pipeline failed");
        }
        if (result.status === "pipeline_incomplete") {
          return err("PIPELINE_INCOMPLETE", result.error ?? "arc extraction incomplete after retries — turns left re-extractable, retry later");
        }
        return ok({
          range_id: result.range_id,
          turns_consumed: result.turns_consumed,
          start_turn: result.start_turn,
          end_turn: result.end_turn,
          saved_blocks: result.reflect_result?.saved ?? 0,
          updated_blocks: result.reflect_result?.updated ?? 0,
          saved_labels: result.reflect_result?.saved_labels ?? [],
        });
      } catch (error) {
        return err("EXTRACT_ARC_FAILED", String(error));
      }
    }
  );
}
