// health.tsx — ONE ops view. Server + capture + pipeline settings + the review
// queue, merged from v2's Servers/Settings/Review tabs. Everything is a row:
// ↑↓ to move, enter toggles or edits, overlays for db-switch and review.
//
// Deliberate v1 cuts from the old Servers tab: launch/stop/rename/pins moved to
// the CLI + onboarding (restoreSession auto-launches the last server at boot);
// here you can SWITCH the db on the running server and CONNECT to another
// discovered server — the two ops people actually do day-to-day.
import React, { useCallback, useEffect, useState } from "react";
import { Box, Text, useInput } from "ink";
import { Section, Row, Keys, Panel } from "./components.js";
import { theme, glyph, trunc, fmtMoney } from "./theme.js";
import {
  fetchConfig, postConfig, setReflectPausedRemote, getBase, setBase,
  type AdminConfig, type Dashboard, type Balance,
} from "./api.js";
import {
  loadHermesCapture, setHermesCapture, loadClaudeCapture, setClaudeCapture,
  parseSources, loadConfig,
} from "./config.js";
import {
  launchWatcher, stopWatcher, isWatcherRunning,
  listDbs, swapDb, isManaged, discover, saveLastServer,
  type ServerEntry,
} from "./servers.js";
import { ReviewTab } from "./review.js";

type RowId =
  | "server" | "db"
  | "reflect" | "model" | "fallback" | "autoturns" | "floor" | "cap"
  | "hermes" | "sources" | "claude" | "ccprojects"
  | "review";
const ROWS: RowId[] = ["server", "db", "reflect", "model", "fallback", "autoturns", "floor", "cap", "hermes", "sources", "claude", "ccprojects", "review"];

export function HealthTab({ dash, balance, isActive, onCapture, onConnect }: {
  dash: Dashboard | null;
  balance: Balance;
  isActive: boolean;
  onCapture: (v: boolean) => void;
  onConnect: () => void;
}) {
  const [sel, setSel] = useState(0);
  const [cfg, setCfg] = useState<AdminConfig | null>(null);
  const [editing, setEditing] = useState<RowId | null>(null);
  const [buf, setBuf] = useState("");
  const [notice, setNotice] = useState("");
  const [hc, setHc] = useState(loadHermesCapture());
  const [cc, setCc] = useState(loadClaudeCapture());
  const [overlay, setOverlay] = useState<"none" | "db" | "servers" | "review">("none");
  const [dbs, setDbs] = useState(listDbs());
  const [dbSel, setDbSel] = useState(0);
  const [servers, setServers] = useState<ServerEntry[]>([]);
  const [srvSel, setSrvSel] = useState(0);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => { void fetchConfig().then(setCfg); }, []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { onCapture(editing !== null || overlay !== "none"); }, [editing, overlay, onCapture]);
  useEffect(() => {
    if (!notice) return;
    const id = setTimeout(() => setNotice(""), 4000);
    return () => clearTimeout(id);
  }, [notice]);

  const reflect = dash?.reflect;
  const paused = !!reflect?.paused;
  const budgetCfg = dash?.budget?.config;
  const floor = budgetCfg?.minCreditUsd;
  const cap = budgetCfg?.dailyBudgetUsd;
  const unreviewed = dash?.flagSummary?.unreviewed ?? 0;

  const save = useCallback(async (patch: Record<string, string | number>, msg: string) => {
    setNotice("saving…");
    const ok = await postConfig(patch);
    setNotice(ok ? msg : "save failed");
    if (ok) load();
  }, [load]);

  const act = useCallback((id: RowId) => {
    if (id === "server") {
      setBusy(true);
      void discover().then((s) => { setServers(s); setSrvSel(0); setBusy(false); setOverlay("servers"); });
      return;
    }
    if (id === "db") { setDbs(listDbs()); setDbSel(0); setOverlay("db"); return; }
    if (id === "review") { setOverlay("review"); return; }
    if (id === "reflect") {
      const next = !paused;
      setNotice(next ? "pausing capture…" : "resuming capture…");
      void setReflectPausedRemote(next).then((ok) => setNotice(ok ? (next ? "capture paused" : "capture resumed") : "toggle failed"));
      return;
    }
    if (id === "hermes" || id === "claude") {
      const host = id === "hermes" ? "hermes" : "claude-code" as const;
      const on = id === "hermes" ? !hc.enabled : !cc.enabled;
      if (id === "hermes") setHermesCapture({ enabled: on }); else setClaudeCapture({ enabled: on });
      if (on) launchWatcher(host); else stopWatcher(host);
      setHc(loadHermesCapture()); setCc(loadClaudeCapture());
      setNotice(`${id === "hermes" ? "hermes" : "claude code"} capture ${on ? "started" : "stopped"}`);
      return;
    }
    setBuf(
      id === "model" ? (cfg?.model ?? "") :
      id === "fallback" ? (cfg?.fallback_model ?? "") :
      id === "autoturns" ? (cfg?.arc_auto_turns ?? "") :
      id === "sources" ? hc.sources.join(", ") :
      id === "ccprojects" ? cc.projects.join(", ") :
      id === "floor" ? (floor != null ? String(floor) : "") :
      cap != null ? String(cap) : "",
    );
    setEditing(id);
  }, [paused, cfg, floor, cap, hc, cc]);

  const submit = useCallback(async () => {
    const v = buf.trim();
    const id = editing;
    setEditing(null); setBuf("");
    if (id === "model")    return save({ model: v }, v ? `model → ${v}` : "model cleared");
    if (id === "fallback") return save({ fallback_model: v }, v ? `fallback → ${v}` : "fallback cleared");
    if (id === "autoturns") { if (v && (!Number.isInteger(Number(v)) || Number(v) < 0)) { setNotice("auto-turns must be a whole number ≥ 0"); return; } return save({ arc_auto_turns: v }, v && Number(v) > 0 ? `auto-extract every ${v} turns` : "auto-extract off"); }
    if (id === "sources")  { const arr = parseSources(v); setHermesCapture({ sources: arr }); setHc(loadHermesCapture()); setNotice(`hermes sources → ${arr.join(", ")}`); return; }
    if (id === "ccprojects") { const arr = parseSources(v); setClaudeCapture({ projects: arr }); setCc(loadClaudeCapture()); setNotice(`claude projects → ${arr.join(", ")}`); return; }
    if (id === "floor")    { if (v && !Number.isFinite(Number(v))) { setNotice("floor must be a number"); return; } return save({ min_credit_usd: v }, v ? `credit floor → $${v}` : "credit floor off"); }
    if (id === "cap")      { if (v && !Number.isFinite(Number(v))) { setNotice("cap must be a number"); return; } return save({ daily_budget_usd: v }, v ? `daily cap → $${v}` : "daily cap off"); }
  }, [buf, editing, save]);

  useInput((input, key) => {
    if (overlay === "review") { if (key.escape) setOverlay("none"); return; } // ReviewTab owns the rest
    if (overlay === "db") {
      if (key.escape) { setOverlay("none"); return; }
      if (key.upArrow) { setDbSel((s) => Math.max(0, s - 1)); return; }
      if (key.downArrow) { setDbSel((s) => Math.min(dbs.length - 1, s + 1)); return; }
      if (key.return && dbs[dbSel]) {
        const target = dbs[dbSel]!;
        const base = getBase();
        const port = Number(new URL(base).port) || 3001;
        if (!isManaged(base)) { setNotice("current server isn't TUI-managed — switch db via onboarding"); setOverlay("none"); return; }
        setBusy(true); setOverlay("none"); setNotice(`switching db → ${target.name}…`);
        void swapDb(base, port, target.path).then((r) => {
          setBusy(false);
          setNotice(r.ok ? `db → ${target.name}` : `switch failed: ${r.error}`);
          onConnect();
        });
      }
      return;
    }
    if (overlay === "servers") {
      if (key.escape) { setOverlay("none"); return; }
      if (key.upArrow) { setSrvSel((s) => Math.max(0, s - 1)); return; }
      if (key.downArrow) { setSrvSel((s) => Math.min(servers.length - 1, s + 1)); return; }
      if (key.return && servers[srvSel]) {
        const s = servers[srvSel]!;
        setBase(s.url);
        saveLastServer({ url: s.url, port: Number(new URL(s.url).port) || null, managed: isManaged(s.url) });
        setOverlay("none"); setNotice(`connected → ${s.url}`);
        onConnect();
      }
      return;
    }
    if (editing) {
      if (key.escape) { setEditing(null); setBuf(""); setNotice("cancelled"); }
      else if (key.return) void submit();
      else if (key.backspace || key.delete) setBuf((b) => b.slice(0, -1));
      else if (input && !key.ctrl && !key.meta) setBuf((b) => b + input);
      return;
    }
    if (key.downArrow || input === "j") { setSel((i) => Math.min(i + 1, ROWS.length - 1)); return; }
    if (key.upArrow || input === "k")   { setSel((i) => Math.max(i - 1, 0)); return; }
    if (key.return)                     { act(ROWS[Math.min(sel, ROWS.length - 1)]!); return; }
    if (input.toLowerCase() === "r")    { load(); setHc(loadHermesCapture()); setCc(loadClaudeCapture()); setNotice("refreshed"); return; }
  }, { isActive });

  if (overlay === "review") {
    return (
      <Box flexDirection="column" flexGrow={1}>
        {dash ? (
          <ReviewTab dash={dash} isActive={isActive} onCapture={onCapture} />
        ) : (
          <Text color={theme.dim}>no server connected — nothing to review</Text>
        )}
        <Keys items={[["esc", "back to health"]]} />
      </Box>
    );
  }

  const selId = ROWS[Math.min(sel, ROWS.length - 1)];
  const savedProvider = loadConfig().provider;
  const editLabel =
    editing === "model" ? "model id:" :
    editing === "fallback" ? "fallback model id (blank = none):" :
    editing === "autoturns" ? "auto-extract every N turns (0/blank = off):" :
    editing === "sources" ? "hermes sources (comma-sep, * = all):" :
    editing === "ccprojects" ? "claude project dirs (comma-sep, * = all):" :
    editing === "floor" ? "credit floor USD (blank = off):" :
    editing === "cap" ? "daily cap USD (blank = off):" : "";

  const R = ({ id, label, value, color, hint }: { id: RowId; label: string; value: string; color?: string; hint: string }) => (
    <Row selected={selId === id} focused>
      <Box width={13}><Text color={selId === id ? theme.accent : theme.label}>{label}</Text></Box>
      <Text color={color ?? theme.value}>{value}</Text>
      {selId === id ? <Text color={theme.dim}>{`   ${hint}`}</Text> : null}
    </Row>
  );

  return (
    <Box flexDirection="column" flexGrow={1}>
      <Section title="server">
        <R id="server" label="connected" value={getBase()} color={dash?.ok ? theme.value : theme.danger} hint="enter = find + switch server" />
        <R id="db" label="database" value={dash?.session?.db ?? "—"} hint="enter = switch db (relaunches)" />
      </Section>

      <Section title="pipeline" right={<Text color={theme.dim}>{savedProvider ? `provider: ${savedProvider}` : ""}</Text>}>
        <R id="reflect" label="capture" value={paused ? `${glyph.paused} paused` : reflect?.spend_paused ? `${glyph.paused} spend paused` : `${glyph.up} running`} color={paused || reflect?.spend_paused ? theme.warn : theme.ok} hint="enter = pause/resume" />
        <R id="model" label="model" value={cfg?.model || "(default)"} hint="enter = edit" />
        <R id="fallback" label="fallback" value={cfg?.fallback_model || "(none)"} hint="enter = edit" />
        <R id="autoturns" label="auto-turns" value={cfg?.arc_auto_turns && Number(cfg.arc_auto_turns) > 0 ? `every ${cfg.arc_auto_turns}` : "off"} hint="enter = edit" />
        <R id="floor" label="credit floor" value={floor != null ? fmtMoney(floor) : "off"} hint="enter = edit" />
        <R id="cap" label="daily cap" value={cap != null ? fmtMoney(cap) : "off"} hint="enter = edit" />
      </Section>

      <Section title="capture watchers">
        <R id="hermes" label="hermes" value={isWatcherRunning("hermes") ? `${glyph.up} running` : hc.enabled ? `${glyph.paused} enabled (stopped)` : "off"} color={isWatcherRunning("hermes") ? theme.ok : hc.enabled ? theme.warn : theme.dim} hint="enter = start/stop" />
        <R id="sources" label="  sources" value={hc.sources.join(", ")} hint="enter = edit (* = all)" />
        <R id="claude" label="claude code" value={isWatcherRunning("claude-code") ? `${glyph.up} running` : cc.enabled ? `${glyph.paused} enabled (stopped)` : "off"} color={isWatcherRunning("claude-code") ? theme.ok : cc.enabled ? theme.warn : theme.dim} hint="enter = start/stop" />
        <R id="ccprojects" label="  projects" value={cc.projects.join(", ")} hint="enter = edit (* = all)" />
      </Section>

      <Section title="review">
        <R id="review" label="queue" value={unreviewed > 0 ? `${glyph.flag} ${unreviewed} unreviewed` : "clear"} color={unreviewed > 0 ? theme.warn : theme.dim} hint="enter = open review" />
      </Section>

      {overlay === "db" ? (
        <Panel title="switch database" hot>
          {dbs.map((d, i) => (
            <Row key={d.path} selected={i === dbSel}>
              <Text color={i === dbSel ? theme.value : theme.label}>{d.name}</Text>
              <Text color={theme.dim}>{`  ${trunc(d.path, 50)}`}</Text>
            </Row>
          ))}
          {dbs.length === 0 ? <Text color={theme.dim}>no dbs in ~/.nodedex</Text> : null}
        </Panel>
      ) : null}
      {overlay === "servers" ? (
        <Panel title="servers found" hot>
          {busy ? <Text color={theme.dim}>scanning…</Text> : null}
          {servers.map((s, i) => (
            <Row key={s.url} selected={i === srvSel}>
              <Text color={s.up ? theme.ok : theme.dim}>{`${glyph.up} `}</Text>
              <Text color={i === srvSel ? theme.value : theme.label}>{s.url}</Text>
              <Text color={theme.dim}>{`  ${s.db ?? ""}${s.blocks != null ? ` · ${s.blocks} blk` : ""}`}</Text>
            </Row>
          ))}
          {!busy && servers.length === 0 ? <Text color={theme.dim}>none up — launch via onboarding or `nodedex run`</Text> : null}
        </Panel>
      ) : null}
      {editing ? (
        <Box borderStyle="round" borderColor={theme.borderHot} paddingX={1}>
          <Text color={theme.warn}>{`${editLabel} `}</Text>
          <Text color={theme.value}>{buf}</Text>
          <Text color={theme.accent}>▏</Text>
          <Text color={theme.dim}>  (enter ok · esc cancel)</Text>
        </Box>
      ) : null}
      {notice ? <Text color={theme.warn}>{notice}</Text> : null}
      <Box flexGrow={1} />
      <Keys items={[["↑↓", "move"], ["enter", "toggle / edit / open"], ["r", "refresh"]]} />
    </Box>
  );
}
