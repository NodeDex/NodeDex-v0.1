// chat.tsx — Chat workspace (two-column): the conversation on the LEFT, the live
// MEMORY on the RIGHT. Each turn:
//   1. RECALL — keyword-search the graph for the user's message; show the query +
//      the blocks it traversed, and INJECT them so the agent honors prior
//      decisions / dead-ends instead of re-deriving them.
//   2. CHAT — route through the server's /api/chat/completions proxy (so the turn
//      auto-captures) and render the reply.
//   3. EXTRACT — a spinner while the pipeline digests; then refresh the roots.
// v1: non-streaming send. Streaming + scrollback + multi-session are v2.
import React, { useEffect, useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import { Panel } from "./components.js";
import { theme, glyph, trunc, typeGlyphOf, typeColorOf } from "./theme.js";
import { useTermSize } from "./hooks.js";
import {
  getBase,
  fetchTree,
  fetchProjectBlocks,
  searchMemory,
  type TreeRoot,
  type BlockRow,
  type Dashboard,
} from "./api.js";
import { loadConfig } from "./config.js";

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
type Msg = { role: "user" | "assistant"; text: string };

/** Newest messages that fit a line budget, oldest-first so the latest stays visible. */
function visibleMessages(messages: Msg[], lineBudget: number, width: number): Array<Msg & { lines: number }> {
  const out: Array<Msg & { lines: number }> = [];
  let used = 0;
  const w = Math.max(20, width);
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    const room = lineBudget - used;
    if (room < 1 && out.length > 0) break;
    // The newest message may use the whole pane; older ones take only the leftover,
    // so a long latest reply shows in full (up to the pane height) instead of a 7-line cap.
    const full = Math.max(1, Math.ceil((m.text.length || 1) / w));
    const lines = Math.min(full, Math.max(1, room));
    out.unshift({ ...m, lines });
    used += lines;
    if (used >= lineBudget) break;
  }
  return out;
}

export function ChatTab({
  dash,
  isActive,
  onCapture,
}: {
  dash: Dashboard | null;
  isActive: boolean;
  onCapture: (v: boolean) => void;
}) {
  const { columns, rows } = useTermSize();

  const [messages, setMessages] = useState<Msg[]>([]);
  const [buf, setBuf] = useState("");
  const [mode, setMode] = useState<"chat" | "nav">("chat");
  const [sending, setSending] = useState(false);
  const [recalling, setRecalling] = useState(false);
  const [recallQuery, setRecallQuery] = useState("");
  const [recalled, setRecalled] = useState<BlockRow[] | null>(null);
  const [extracting, setExtracting] = useState(false);
  const [status, setStatus] = useState("");
  const [frame, setFrame] = useState(0);

  const [roots, setRoots] = useState<TreeRoot[] | null>(null);
  const [sel, setSel] = useState(0);
  const [openLabel, setOpenLabel] = useState<string | null>(null);
  const [children, setChildren] = useState<BlockRow[] | null>(null);

  const seq = useRef(0);
  const childSeq = useRef(0);
  const extractStart = useRef(0);
  const baseBlocks = useRef(0);

  useEffect(() => { onCapture(mode === "chat"); }, [mode, onCapture]);

  useEffect(() => {
    let alive = true;
    fetchTree().then((t) => { if (alive) setRoots(t); });
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    if (!sending && !extracting && !recalling) return;
    const id = setInterval(() => setFrame((f) => (f + 1) % SPINNER.length), 120);
    return () => clearInterval(id);
  }, [sending, extracting, recalling]);

  // Extraction watch — piggybacks the App's 2s dashboard poll.
  useEffect(() => {
    if (!extracting || !dash) return;
    const reflect = dash.reflect;
    const busy = !!reflect && (reflect.processing || (reflect.queue_depth ?? 0) > 0);
    const elapsed = Date.now() - extractStart.current;
    if (!busy && elapsed > 5000) {
      const now = dash.session?.total_blocks ?? baseBlocks.current;
      const delta = now - baseBlocks.current;
      setExtracting(false);
      setStatus(delta > 0 ? `${glyph.okMark} +${delta} block${delta === 1 ? "" : "s"}` : "no new blocks");
      fetchTree().then((t) => setRoots(t));
    } else if (elapsed > 180000) {
      setExtracting(false);
      setStatus("still extracting in background");
      fetchTree().then((t) => setRoots(t));
    }
  }, [dash, extracting]);

  const model = loadConfig().model || "google/gemini-2.5-flash";

  const send = (text: string) => {
    const history = [...messages, { role: "user" as const, text }];
    setMessages(history);
    setBuf("");
    setStatus("");
    setRecallQuery(text);
    setRecalled(null);
    setRecalling(true);
    setSending(true);
    const s = ++seq.current;
    (async () => {
      // 1. recall — what the agent queries + traverses for this turn
      let mem: BlockRow[] = [];
      try { mem = await searchMemory(text, 6); } catch { /* recall is best-effort */ }
      if (s !== seq.current) return;
      setRecalled(mem);
      setRecalling(false);
      const memMsg = mem.length
        ? [{
            role: "system" as const,
            content:
              "Relevant prior memory from this project (decisions, dead-ends, and constraints already established — honor them; do NOT re-propose ruled-out approaches):\n" +
              mem.map((b) => `- [${b.type}] ${b.label}: ${b.essence}`).join("\n"),
          }]
        : [];
      // 2. chat through the proxy (auto-captures)
      try {
        const r = await fetch(`${getBase()}/api/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model,
            messages: [...memMsg, ...history.map((m) => ({ role: m.role, content: m.text }))],
            stream: false,
          }),
          signal: AbortSignal.timeout(120000),
        });
        if (s !== seq.current) return;
        if (!r.ok) {
          const e = await r.text().catch(() => "");
          setMessages((m) => [...m, { role: "assistant", text: `${glyph.warn} proxy ${r.status}: ${trunc(e, 180)}` }]);
          setSending(false);
          return;
        }
        const j: any = await r.json();
        const c = j?.choices?.[0]?.message?.content;
        const text2 = typeof c === "string" ? c : c == null ? "(no content)" : JSON.stringify(c);
        if (s !== seq.current) return;
        setMessages((m) => [...m, { role: "assistant", text: text2 }]);
        setSending(false);
        baseBlocks.current = dash?.session?.total_blocks ?? 0;
        extractStart.current = Date.now();
        setExtracting(true);
      } catch (e) {
        if (s !== seq.current) return;
        setMessages((m) => [...m, { role: "assistant", text: `${glyph.warn} request failed: ${trunc(String(e), 180)}` }]);
        setSending(false);
      }
    })();
  };

  const visRoots = roots ?? [];
  const selRoot = visRoots[Math.min(sel, Math.max(0, visRoots.length - 1))];

  const openSelected = () => {
    if (!selRoot) return;
    if (openLabel === selRoot.label) { setOpenLabel(null); setChildren(null); return; }
    setOpenLabel(selRoot.label);
    setChildren(null);
    const c = ++childSeq.current;
    fetchProjectBlocks(selRoot.label).then((b) => { if (c === childSeq.current) setChildren(b); });
  };

  useInput(
    (input, key) => {
      if (mode === "chat") {
        if (key.escape) { setMode("nav"); return; }
        if (key.return) { const t = buf.trim(); if (t && !sending) send(t); return; }
        if (key.backspace || key.delete) { setBuf((b) => b.slice(0, -1)); return; }
        if (input && !key.ctrl && !key.meta) setBuf((b) => b + input);
        return;
      }
      if (input === "i" || (key.return && !selRoot)) { setMode("chat"); return; }
      if (input === "j" || key.downArrow) { setSel((i) => Math.min(i + 1, Math.max(0, visRoots.length - 1))); return; }
      if (input === "k" || key.upArrow) { setSel((i) => Math.max(0, i - 1)); return; }
      if (key.return) { openSelected(); return; }
    },
    { isActive }
  );

  // ── layout ──
  const spin = SPINNER[frame % SPINNER.length];
  const bodyH = Math.max(8, rows - 13);
  const leftW = Math.max(28, Math.floor((columns - 3) * 0.6));
  const rightW = Math.max(22, columns - 3 - leftW);
  const chatW = leftW - 4;
  const sideW = rightW - 4;
  const chatLines = Math.max(3, bodyH - 4);
  const recalledCap = Math.max(2, Math.floor(bodyH * 0.42) - 2);
  const memCap = Math.max(2, bodyH - Math.floor(bodyH * 0.42) - 2);

  const db = dash?.session?.db ?? "—";
  let port = "";
  try { port = new URL(getBase()).port; } catch { /* */ }
  const capturing = dash?.reflect ? (dash.reflect.paused ? "paused" : `capturing ${glyph.okMark}`) : "—";
  const vis = visibleMessages(messages, chatLines, chatW);

  return (
    <Box flexDirection="column">
      {/* connection header */}
      <Box paddingX={1}>
        <Text color={theme.ok}>{glyph.up} </Text>
        <Text color={theme.value}>{db}</Text>
        <Text color={theme.dim}>{`${port ? ` · :${port}` : ""} · ${capturing} · ${model}`}</Text>
      </Box>

      <Box flexDirection="row" height={bodyH}>
        {/* LEFT — conversation */}
        <Box flexDirection="column" width={leftW}>
          <Panel title="chat" flexGrow={1}>
            {messages.length === 0 ? (
              <Text color={theme.dim}>type a message — each turn recalls memory, injects it, and captures.</Text>
            ) : (
              vis.map((m, i) => (
                <Text key={i} color={m.role === "user" ? theme.accent : theme.value}>
                  <Text color={m.role === "user" ? theme.accent : theme.title}>{m.role === "user" ? "you › " : "ai  · "}</Text>
                  {trunc(m.text, chatW * m.lines)}
                </Text>
              ))
            )}
            {sending && !recalling ? <Text color={theme.warn}>{`${spin} thinking…`}</Text> : null}
          </Panel>
          {mode === "chat" ? (
            <Box borderStyle="round" borderColor={theme.accent} paddingX={1}>
              <Text color={theme.accent}>{"› "}</Text>
              <Text color={theme.value}>{trunc(buf, chatW - 2)}</Text>
              <Text color={theme.accent}>▌</Text>
            </Box>
          ) : (
            <Box borderStyle="round" borderColor={theme.dim} paddingX={1}>
              <Text color={theme.dim}>nav · ↑↓ select · enter expand · [i] back to chat</Text>
            </Box>
          )}
        </Box>

        {/* RIGHT — live memory */}
        <Box flexDirection="column" width={rightW} marginLeft={1}>
          <Panel title={recalling ? `recalled  ${spin} searching…` : "recalled this turn"} flexGrow={2}>
            {recallQuery ? (
              <Text color={theme.accent}>{`${glyph.read} ${trunc(recallQuery, sideW - 2)}`}</Text>
            ) : (
              <Text color={theme.dim}>the agent's query + traversed blocks show here</Text>
            )}
            {recalled && recalled.length === 0 ? <Text color={theme.dim}>no prior memory matched</Text> : null}
            {(recalled ?? []).slice(0, recalledCap).map((b) => (
              <Text key={b.id}>
                <Text color={typeColorOf(b.type)}>{typeGlyphOf(b.type)} </Text>
                <Text color={theme.dim}>{trunc(b.essence || b.label, sideW - 2)}</Text>
              </Text>
            ))}
          </Panel>
          <Panel title={extracting ? `memory  ${spin} extracting…` : status ? `memory  ${status}` : "memory"} hot={extracting} flexGrow={3}>
            {roots === null ? (
              <Text color={theme.dim}>loading…</Text>
            ) : visRoots.length === 0 ? (
              <Text color={theme.dim}>no roots yet</Text>
            ) : (
              visRoots.slice(0, memCap).map((r, i) => {
                const isSel = i === sel && mode === "nav";
                const isOpen = openLabel === r.label;
                return (
                  <Box key={r.id} flexDirection="column">
                    <Text bold={isSel} color={isSel ? theme.accent : theme.value}>
                      {`${isSel ? "▸" : " "}${isOpen ? "▾" : "▸"} ${trunc(r.label, sideW - 8)}`}
                      <Text color={theme.dim}>{typeof r.children_count === "number" ? ` (${r.children_count})` : ""}</Text>
                    </Text>
                    {isOpen
                      ? children === null
                        ? <Text color={theme.dim}>{"   …"}</Text>
                        : children.slice(0, Math.max(2, memCap - 2)).map((b) => (
                            <Text key={b.id}>
                              <Text color={theme.dim}>{"   "}</Text>
                              <Text color={typeColorOf(b.type)}>{typeGlyphOf(b.type)} </Text>
                              <Text color={theme.dim}>{trunc(b.essence || b.label, sideW - 6)}</Text>
                            </Text>
                          ))
                      : null}
                  </Box>
                );
              })
            )}
          </Panel>
        </Box>
      </Box>

      <Box paddingX={1}>
        <Text color={theme.dim}>
          {mode === "chat" ? "[enter] send · [esc] browse roots · recalls + injects memory each turn" : "[tab] switch view · [q] quit"}
        </Text>
      </Box>
    </Box>
  );
}
