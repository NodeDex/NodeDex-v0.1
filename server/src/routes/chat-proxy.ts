// routes/chat-proxy.ts — universal LLM proxy with transparent memory capture.
//
// WHAT IT'S FOR
//   Zero-integration memory capture. A developer points their agent's LLM base_url at
//   this proxy instead of the provider's. No hooks, no SDK, no code change — just a URL
//   swap — and every turn's response *and reasoning* flow into the Nodedex pipeline.
//   This is the production path for thinking capture: real reasoning is only returned on
//   API-key requests, and it lives in the API response (e.g. `message.reasoning`), which
//   the transcript hook can't see but a proxy can.
//
// UNIVERSAL — ANY MODEL / ANY PROVIDER
//   Speaks the OpenAI `/chat/completions` shape, which is the de-facto standard: OpenAI,
//   OpenRouter, Together, Groq, Fireworks, vLLM, llama.cpp — and, via OpenRouter, Anthropic
//   and Gemini too. Reasoning is provider-shaped, so extraction PROBES every known field
//   (`message.reasoning`, `reasoning_content`, `reasoning_details[].text`, Anthropic-style
//   `content[].thinking`) rather than hard-coding one provider. The upstream target is
//   chosen per-request (`x-nodedex-target` header) or by env, so one proxy serves any provider.
//
// WHAT IT AFFECTS — and the rules that follow from it
//   • It sits in the agent's CRITICAL PATH. Therefore it must be fully transparent:
//     forward the request verbatim, relay the response — including status, content-type,
//     errors, and streaming (SSE) — unchanged, and add no latency. Capture happens AFTER
//     the client already has its bytes, fire-and-forget. A capture failure must NEVER
//     affect the agent's call.
//   • AUTH: the client's Authorization header is forwarded untouched. The proxy holds no
//     key of its own; it falls back to env OPENAI_API_KEY only for same-origin convenience.
//   • PIPELINE: it does not change the pipeline. It only feeds the existing
//     /api/reflect/trigger. Match-to-competence: deterministic relay+extraction here, all
//     knowledge work stays in the pipeline (which already honors the pause flag + debounce).
//   • SCOPE: it captures the agent's own turn (the developer's data) — same trust model as
//     the hooks. Server-side pause (/api/reflect/pause) still gates it via the trigger.

import { Router } from "express";

const REASONING_FIELDS = ["reasoning", "reasoning_content"] as const;

/** Last user message in an OpenAI-format messages[] (string or content-parts). */
function extractUserMessage(messages: unknown): string {
  if (!Array.isArray(messages)) return "";
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as any;
    if (m?.role !== "user") continue;
    if (typeof m.content === "string") return m.content;
    if (Array.isArray(m.content)) {
      return m.content
        .map((c: any) => (typeof c === "string" ? c : c?.type === "text" ? c.text : ""))
        .filter(Boolean)
        .join("\n");
    }
  }
  return "";
}

/** Pull visible content + reasoning from a non-streaming choices[0].message (any provider shape). */
function extractFromMessage(msg: any): { content: string; reasoning: string } {
  let content = "";
  let reasoning = "";
  if (!msg) return { content, reasoning };
  if (typeof msg.content === "string") {
    content = msg.content;
  } else if (Array.isArray(msg.content)) {
    for (const part of msg.content) {
      if (part?.type === "text" && part.text) content += part.text;
      if (part?.type === "thinking" && part.thinking) reasoning += part.thinking + "\n"; // Anthropic-style
    }
  }
  for (const f of REASONING_FIELDS) {
    if (typeof msg[f] === "string" && msg[f]) reasoning += msg[f];
  }
  if (Array.isArray(msg.reasoning_details)) {
    for (const rd of msg.reasoning_details) if (rd?.text) reasoning += rd.text;
  }
  return { content: content.trim(), reasoning: reasoning.trim() };
}

/** Reconstruct content + reasoning from an accumulated SSE stream body. */
function extractFromSSE(raw: string): { content: string; reasoning: string } {
  let content = "";
  let reasoning = "";
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("data:")) continue;
    const payload = t.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      const delta = JSON.parse(payload)?.choices?.[0]?.delta;
      if (!delta) continue;
      if (typeof delta.content === "string") content += delta.content;
      if (typeof delta.reasoning === "string") reasoning += delta.reasoning;
      if (typeof delta.reasoning_content === "string") reasoning += delta.reasoning_content;
    } catch { /* partial / non-JSON keepalive line */ }
  }
  return { content: content.trim(), reasoning: reasoning.trim() };
}

function slugifyTurn(userMessage: string): string {
  return (
    userMessage.split(/\s+/).slice(0, 5).join("-").toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 60) ||
    "proxy-turn"
  );
}

export function createChatProxyRouter(): Router {
  const router = Router();

  router.post("/api/chat/completions", async (req, res) => {
    const body = req.body ?? {};
    const isStream = body?.stream === true;
    const agentId = (req.headers["x-nodedex-agent-id"] as string) || "proxy";
    const userMessage = extractUserMessage(body?.messages);

    // Target provider: per-request header → env → pipeline's own base → OpenRouter.
    const targetBase =
      (req.headers["x-nodedex-target"] as string) ||
      process.env.NODEDEX_PROXY_TARGET ||
      process.env.OPENAI_BASE_URL ||
      "https://openrouter.ai/api/v1";
    const url = targetBase.replace(/\/+$/, "") + "/chat/completions";

    // Forward the client's key untouched; fall back to env only for same-origin convenience.
    const clientAuth = req.headers["authorization"] as string | undefined;
    const auth = clientAuth || (process.env.OPENAI_API_KEY ? `Bearer ${process.env.OPENAI_API_KEY}` : undefined);

    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (auth) headers["Authorization"] = auth;
    // OpenRouter attribution headers — harmless to other providers.
    headers["HTTP-Referer"] = (req.headers["http-referer"] as string) || "https://nodedex.local";
    headers["X-Title"] = (req.headers["x-title"] as string) || "nodedex-proxy";

    // Fire-and-forget capture — runs only AFTER the client has its bytes; never throws upward.
    const capture = (content: string, reasoning: string) => {
      if (!content || content.trim().length < 50) return; // trigger rejects <50 anyway
      const triggerUrl = `${req.protocol}://${req.get("host")}/api/reflect/trigger`;
      fetch(triggerUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          hint: "discovery",
          agent_response: content.slice(0, 16000),
          agent_thinking: reasoning.slice(0, 8000),
          user_message: userMessage.slice(0, 2000),
          agent_id: agentId,
          turn_name: slugifyTurn(userMessage),
        }),
      }).catch(() => { /* capture must never affect the agent's call */ });
    };

    let upstream: Response;
    try {
      upstream = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
    } catch (e) {
      return res.status(502).json({ error: "proxy_upstream_unreachable", detail: String(e) });
    }

    // ── Non-streaming: relay the JSON verbatim, then capture. ──
    if (!isStream) {
      const text = await upstream.text();
      res.status(upstream.status);
      res.setHeader("Content-Type", upstream.headers.get("content-type") || "application/json");
      res.send(text);
      if (upstream.ok) {
        try {
          const { content, reasoning } = extractFromMessage(JSON.parse(text)?.choices?.[0]?.message);
          capture(content, reasoning);
        } catch { /* non-JSON / error body — skip capture */ }
      }
      return;
    }

    // ── Streaming: pass each chunk straight through, accumulate for capture. ──
    res.status(upstream.status);
    res.setHeader("Content-Type", upstream.headers.get("content-type") || "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    const reader = upstream.body?.getReader();
    if (!reader) { res.end(); return; }
    const decoder = new TextDecoder();
    let raw = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        raw += chunk;
        res.write(chunk);
      }
    } catch { /* upstream stream broke — end gracefully */ }
    res.end();
    if (upstream.ok) {
      const { content, reasoning } = extractFromSSE(raw);
      capture(content, reasoning);
    }
  });

  return router;
}
