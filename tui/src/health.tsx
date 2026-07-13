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
  fetchConfig, postConfig, setReflectPausedRemote, getBase, setBase, fetchSetup,
  type AdminConfig, type Dashboard, type Balance, type SetupStatus,
} from "./api.js";
import {
  loadHermesCapture, setHermesCapture, loadClaudeCapture, setClaudeCapture,
  parseSources, loadConfig, saveConfig,
  captureScope,
  RECOMMENDED_MODELS, isTrainsOnPrompts, validateOpenRouterKey, scanLocalModels,
  DEFAULT_LOCAL_BASE_URL,
  type Provider, type LocalModel,
} from "./config.js";
import {
  launchWatcher, stopWatcher, isWatcherRunning,
  listDbs, swapDb, isManaged, discover, saveLastServer, resolveNewDbPath,
  type ServerEntry,
} from "./servers.js";
import { ReviewTab } from "./review.js";

type RowId =
  | "server" | "db"
  | "reflect" | "provider" | "model" | "fallback" | "autoturns" | "floor" | "cap"
  | "w-capture" | "w-reflex" | "w-gate" | "w-read"
  | "hermes" | "sources" | "claude" | "ccprojects"
  | "review";
// The w-* rows are STATUS, not settings — they report what the agent did, so there is
// nothing here for the user to toggle. Absent from ROWS ⇒ rendered, never selectable.
const ROWS: RowId[] = ["server", "db", "reflect", "provider", "model", "fallback", "autoturns", "floor", "cap", "hermes", "sources", "claude", "ccprojects", "review"];

/** "3m ago" — a timestamp the user can act on, not an ISO string they have to decode. */
function ago(iso: string | null): string {
  if (!iso) return "never";
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "just now";
  const m = Math.floor(ms / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

// Provider-overlay steps: pick cloud/local → OpenRouter (key if none saved → model
// list) | Local (auto-scan Ollama/LM Studio/vLLM → pick, or manual url+model).
type PStep = "pick" | "key" | "model" | "scan" | "lurl" | "lmodel";

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
  const [overlay, setOverlay] = useState<"none" | "db" | "servers" | "review" | "provider">("none");
  const [dbs, setDbs] = useState(listDbs());
  const [dbSel, setDbSel] = useState(0);
  const [dbNew, setDbNew] = useState<string | null>(null); // switch-db overlay: name being typed for a NEW db (null = list mode)
  const [servers, setServers] = useState<ServerEntry[]>([]);
  const [srvSel, setSrvSel] = useState(0);
  const [busy, setBusy] = useState(false);
  // provider overlay state (pSel is reused as the cursor of whichever step's list is showing)
  const [pStep, setPStep] = useState<PStep>("pick");
  const [pSel, setPSel] = useState(0);
  const [pModels, setPModels] = useState<LocalModel[]>([]);
  const [pScanning, setPScanning] = useState(false);
  const [pScanNonce, setPScanNonce] = useState(0);
  const [pBuf, setPBuf] = useState("");   // key / custom model / url / manual model input
  const [pUrl, setPUrl] = useState("");   // manual local endpoint carried from lurl → lmodel
  const [pBusy, setPBusy] = useState(false);
  const [pErr, setPErr] = useState("");

  const load = useCallback(() => { void fetchConfig().then(setCfg); }, []);
  useEffect(() => { load(); }, [load]);

  // The wires: is NodeDex actually plugged into the agent, and is anything reaching it?
  // Polled from the SERVER (not from local config) because the answer is about observed
  // effect — a turn that landed, a file that really contains the block, a check that fired.
  const [setup, setSetup] = useState<SetupStatus | null>(null);
  useEffect(() => {
    const poll = () => { void fetchSetup().then(setSetup).catch(() => { /* server down — leave last known */ }); };
    poll();
    const id = setInterval(poll, 5000);
    return () => clearInterval(id);
  }, []);
  useEffect(() => { onCapture(editing !== null || overlay !== "none"); }, [editing, overlay, onCapture]);
  useEffect(() => {
    if (!notice) return;
    const id = setTimeout(() => setNotice(""), 4000);
    return () => clearTimeout(id);
  }, [notice]);

  // Auto-scan local model servers when the provider overlay enters the scan step
  // (same probe onboarding uses); [r] bumps the nonce to rescan.
  useEffect(() => {
    if (overlay !== "provider" || pStep !== "scan") return;
    let cancelled = false;
    setPScanning(true); setPErr("");
    void scanLocalModels().then((models) => {
      if (cancelled) return;
      setPModels(models); setPSel(0); setPScanning(false);
    });
    return () => { cancelled = true; };
  }, [overlay, pStep, pScanNonce]);

  const reflect = dash?.reflect;
  const paused = !!reflect?.paused;
  const budgetCfg = dash?.budget?.config;
  const floor = budgetCfg?.minCreditUsd;
  const cap = budgetCfg?.dailyBudgetUsd;
  const unreviewed = dash?.flagSummary?.unreviewed ?? 0;
  // Glanceable pending-work breakdown: "12 dup · 2 island" (short names; older
  // servers without unreviewed_by_type just render the bare count).
  const FLAG_SHORT: Record<string, string> = {
    block_dup_candidate: "dup", atomic_dup_candidate: "dup",
    project_dup_candidate: "root-dup", island_candidate: "island",
    scope_disagreement: "scope", provenance_mismatch: "provenance",
    entity_unresolved: "entity",
  };
  const pendingByShort = new Map<string, number>();
  for (const r of dash?.flagSummary?.unreviewed_by_type ?? []) {
    const k = FLAG_SHORT[r.flag_type] ?? r.flag_type.replace(/_candidate$/, "").replace(/_/g, " ");
    pendingByShort.set(k, (pendingByShort.get(k) ?? 0) + r.count);
  }
  const queueBreakdown = [...pendingByShort].map(([k, n]) => `${n} ${k}`).join(" · ");

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
    if (id === "provider") {
      setPSel(loadConfig().provider === "local" ? 1 : 0);
      setPStep("pick"); setPBuf(""); setPUrl(""); setPErr(""); setPModels([]);
      setOverlay("provider");
      return;
    }
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
      id === "sources" ? hc.sources.map(captureScope("hermes").toDisplay).join(", ") :
      id === "ccprojects" ? cc.projects.map(captureScope("claude-code").toDisplay).join(", ") :
      id === "floor" ? (floor != null ? String(floor) : "") :
      cap != null ? String(cap) : "",
    );
    setEditing(id);
  }, [paused, cfg, floor, cap, hc, cc]);

  // Persist the provider choice to ~/.nodedex/config.json (what launchServer injects).
  // A model change WITHIN the same lane (same provider + endpoint) also applies LIVE via
  // admin config; a lane switch only takes full effect when the server relaunches
  // (switch db or restart) — the notice says which happened.
  const applyProvider = useCallback((prov: Provider, baseUrl: string | undefined, model: string) => {
    const prev = loadConfig();
    saveConfig(prov === "local" ? { provider: "local", base_url: baseUrl, model } : { provider: "openrouter", model });
    setOverlay("none"); setPBuf(""); setPErr("");
    const sameLane = prev.provider === prov && (prov === "openrouter" || prev.base_url === baseUrl);
    if (sameLane) {
      void save({ model }, `model → ${model}`);
    } else {
      setNotice(`provider saved: ${prov === "local" ? `local (${baseUrl})` : "openrouter"} · ${model} — applies when the server relaunches (switch db or restart)`);
    }
  }, [save]);

  const submit = useCallback(async () => {
    const v = buf.trim();
    const id = editing;
    setEditing(null); setBuf("");
    // Also persist to config.json — the launch env (providerEnv) wins over ~/.nodedex/.env
    // on relaunch, so a live-only change would silently revert at the next launch.
    if (id === "model")    { saveConfig({ model: v || undefined }); return save({ model: v }, v ? `model → ${v}` : "model cleared"); }
    if (id === "fallback") return save({ fallback_model: v }, v ? `fallback → ${v}` : "fallback cleared");
    // Ceiling 6: arc survival ≈ per-call success ^ n_calls — big arcs fail multiplicatively
    // on weak models and delay freshness on any model. The chunk cap (ARC_MAX_TURNS)
    // rides this value, so this one knob bounds both the trigger and the arc size.
    if (id === "autoturns") { if (v && (!Number.isInteger(Number(v)) || Number(v) < 0 || Number(v) > 6)) { setNotice("auto-turns must be 0-6 (0 = off; small chunks survive, big arcs fail multiplicatively)"); return; } return save({ arc_auto_turns: v }, v && Number(v) > 0 ? `auto-extract every ${v} turns` : "auto-extract off"); }
    // Both capture hosts go through the SAME seam (captureScope): the user types what a human
    // would type, code converts it to that host's dialect, and we echo back ground truth. A
    // user who pasted a folder path used to get no error, no warning, and a watcher that
    // silently captured NOTHING — which is how we lost a whole session's capture.
    if (id === "sources") {
      const sc = captureScope("hermes");
      const arr = parseSources(v).map(sc.toId);
      setHermesCapture({ sources: arr }); setHc(loadHermesCapture());
      setNotice(`hermes sources → ${arr.map(sc.toDisplay).join(", ")}`);
      return;
    }
    if (id === "ccprojects") {
      const sc = captureScope("claude-code");
      const arr = parseSources(v).map(sc.toId);
      setClaudeCapture({ projects: arr }); setCc(loadClaudeCapture());
      setNotice(`claude projects → ${arr.map(sc.toDisplay).join(", ")}`);
      return;
    }
    if (id === "floor")    { if (v && !Number.isFinite(Number(v))) { setNotice("floor must be a number"); return; } return save({ min_credit_usd: v }, v ? `credit floor → $${v}` : "credit floor off"); }
    if (id === "cap")      { if (v && !Number.isFinite(Number(v))) { setNotice("cap must be a number"); return; } return save({ daily_budget_usd: v }, v ? `daily cap → $${v}` : "daily cap off"); }
  }, [buf, editing, save]);

  useInput((input, key) => {
    if (overlay === "review") { if (key.escape) setOverlay("none"); return; } // ReviewTab owns the rest
    if (overlay === "provider") {
      if (pBusy) return;
      const typeInto = () => {
        if (key.backspace || key.delete) setPBuf((b) => b.slice(0, -1));
        else if (input && !key.ctrl && !key.meta && !key.tab) setPBuf((b) => b + input.replace(/[\r\n]/g, ""));
      };
      if (key.escape) {
        setPErr("");
        if (pStep === "key" || pStep === "model" || pStep === "scan") { setPBuf(""); setPStep("pick"); }
        else if (pStep === "lurl") { setPBuf(""); setPStep("scan"); }
        else if (pStep === "lmodel") { setPBuf(pUrl); setPStep("lurl"); }
        else setOverlay("none");
        return;
      }
      if (pStep === "pick") {
        if (key.upArrow || key.downArrow) setPSel((s) => (s === 0 ? 1 : 0));
        else if (key.return) {
          setPErr(""); setPBuf("");
          if (pSel === 1) { setPStep("scan"); }
          else if (loadConfig().openrouter_key) {
            const cur = RECOMMENDED_MODELS.findIndex((m) => m.id === loadConfig().model);
            setPSel(cur >= 0 ? cur : 0); setPStep("model");
          } else setPStep("key");
        }
        return;
      }
      if (pStep === "key") {
        if (key.return) {
          const k = pBuf.trim();
          if (!/^sk-or-/.test(k) || k.length < 40) { setPErr("that doesn't look like a full OpenRouter key (sk-or-…) — re-paste the whole key"); return; }
          setPBusy(true); setPErr("");
          void validateOpenRouterKey(k).then((v) => {
            setPBusy(false);
            if (!v.ok) { setPErr(v.error ?? "invalid key"); return; }
            saveConfig({ openrouter_key: k });
            setPBuf(""); setPSel(0); setPStep("model");
          });
        } else typeInto();
        return;
      }
      if (pStep === "model") {
        const total = RECOMMENDED_MODELS.length + 1; // + custom row
        if (key.upArrow) setPSel((s) => (s - 1 + total) % total);
        else if (key.downArrow) setPSel((s) => (s + 1) % total);
        else if (key.return) {
          const m = pSel >= RECOMMENDED_MODELS.length ? pBuf.trim() : RECOMMENDED_MODELS[pSel]!.id;
          if (!m) { setPErr("pick a model or type a custom id"); return; }
          applyProvider("openrouter", undefined, m);
        } else if (pSel >= RECOMMENDED_MODELS.length) typeInto();
        return;
      }
      if (pStep === "scan") {
        if (pScanning) return;
        const total = pModels.length + 1; // + "enter manually" row
        if (key.upArrow) setPSel((s) => (s - 1 + total) % total);
        else if (key.downArrow) setPSel((s) => (s + 1) % total);
        else if (input === "r") setPScanNonce((n) => n + 1);
        else if (key.return) {
          setPErr("");
          if (pSel >= pModels.length) { setPBuf(loadConfig().base_url || DEFAULT_LOCAL_BASE_URL); setPStep("lurl"); return; }
          const pick = pModels[pSel]!;
          applyProvider("local", pick.baseUrl, pick.model);
        }
        return;
      }
      if (pStep === "lurl") {
        if (key.return) {
          const url = pBuf.trim();
          if (!url) { setPErr("enter the endpoint URL (e.g. http://localhost:11434/v1)"); return; }
          const c = loadConfig();
          setPUrl(url); setPBuf(c.provider === "local" && c.model ? c.model : ""); setPErr(""); setPStep("lmodel");
        } else typeInto();
        return;
      }
      // lmodel
      if (key.return) {
        const m = pBuf.trim();
        if (!m) { setPErr("enter the model id your server serves (e.g. qwen3:30b)"); return; }
        applyProvider("local", pUrl, m);
      } else typeInto();
      return;
    }
    if (overlay === "db") {
      // Typing a name for a NEW db — create-in-place, no onboarding round-trip.
      if (dbNew !== null) {
        if (key.escape) { setDbNew(null); return; }
        if (key.return) {
          const res = resolveNewDbPath(dbNew);
          if (!res.ok) { setNotice(res.error ?? "invalid name"); return; }
          const base = getBase();
          const port = Number(new URL(base).port) || 3001;
          const name = res.path!.split(/[\\/]/).pop()!.replace(/\.db$/, "");
          setDbNew(null); setBusy(true); setOverlay("none"); setNotice(`creating ${name}…`);
          void swapDb(base, port, res.path!).then((r) => {
            setBusy(false);
            setNotice(r.ok ? `db → ${name}` : `create failed: ${r.error}`);
            onConnect();
          });
          return;
        }
        if (key.backspace || key.delete) { setDbNew((s) => (s ?? "").slice(0, -1)); return; }
        if (input && !key.ctrl && !key.meta) { setDbNew((s) => (s ?? "") + input); return; }
        return;
      }
      const total = dbs.length + 1; // existing dbs + the "+ new database" row (last)
      if (key.escape) { setOverlay("none"); return; }
      if (key.upArrow) { setDbSel((s) => Math.max(0, s - 1)); return; }
      if (key.downArrow) { setDbSel((s) => Math.min(total - 1, s + 1)); return; }
      if (key.return) {
        if (dbSel >= dbs.length) { setDbNew(""); return; } // "+ new database…" row
        const target = dbs[dbSel]!;
        const base = getBase();
        const port = Number(new URL(base).port) || 3001;
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
        <Keys items={[["esc", "back to settings"]]} />
      </Box>
    );
  }

  const selId = ROWS[Math.min(sel, ROWS.length - 1)];
  const cfgFile = loadConfig();
  const providerValue =
    cfgFile.provider === "local" ? `local · ${trunc(cfgFile.base_url ?? "?", 36)}` :
    cfgFile.provider === "openrouter" ? "openrouter (cloud)" : "not set";
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

      <Section title="pipeline">
        <R id="reflect" label="capture" value={paused ? `${glyph.paused} paused` : reflect?.spend_paused ? `${glyph.paused} spend paused` : `${glyph.up} running`} color={paused || reflect?.spend_paused ? theme.warn : theme.ok} hint="enter = pause/resume" />
        <R id="provider" label="provider" value={providerValue} hint="enter = switch cloud/local + pick model" />
        <R id="model" label="model" value={cfg?.model || "(default)"} hint="enter = edit" />
        <R id="fallback" label="fallback" value={cfg?.fallback_model || "(none)"} hint="enter = edit" />
        <R id="autoturns" label="auto-turns" value={cfg?.arc_auto_turns && Number(cfg.arc_auto_turns) > 0 ? `every ${cfg.arc_auto_turns}` : "off"} hint="enter = edit" />
        <R id="floor" label="credit floor" value={floor != null ? fmtMoney(floor) : "off"} hint="enter = edit" />
        <R id="cap" label="daily cap" value={cap != null ? fmtMoney(cap) : "off"} hint="enter = edit" />
      </Section>

      {/* WIRED INTO YOUR AGENT — the three wires, reported from observed effect.
          Source-agnostic on purpose: a user running their own loop has every watcher below
          switched OFF and is capturing perfectly. This section is true for them too.

          UNKNOWN ≠ BROKEN. If the server is old or down, /api/setup does not answer and we
          show "—", never "nothing has ever arrived". Raising a false alarm from missing data
          is the same confidently-wrong-display failure the c-- slug taught us to refuse. */}
      <Section title="wired into your agent">
        <R
          id="w-capture" label="turns in graph"
          value={
            !setup ? "— (server not reporting)"
              : setup.capture.turns > 0
                ? `${setup.capture.turns} from ${setup.capture.sources.map((s) => s.agent_id).join(", ")}`
                : setup.capture.arrived ? 'arrived, not yet stored as turns (arc mode off)'
                : `${glyph.flag} none — nothing has ever been captured`
          }
          color={!setup ? theme.dim : setup.capture.turns > 0 || setup.capture.arrived ? theme.value : theme.warn}
          hint="whatever fed them: a watcher, the adapter, or your own POST"
        />
        {/* PER-AGENT — ALL THREE WIRES. The reflex sits in a file ONE agent reads, the gate in
            a seam ONE agent runs, and capture in that agent's OWN post-turn seam (or the
            watcher, if it has none). Nothing is inherited: a graph full of one agent's turns
            says NOTHING about whether a second agent's work is being recorded. Showing it per
            agent is the only way a user switching hosts can SEE the new one is blind. */}
        {(setup?.agents ?? []).map((a) => {
          const mark = (w: { done: boolean; declined: boolean }) => (w.done ? glyph.up : w.declined ? "–" : glyph.flag);
          const allGood = [a.reflex, a.capture, a.gate].every((w) => w.done || w.declined);
          return (
            <R
              key={a.agent} id="w-reflex" label={`  ${trunc(a.agent, 14)}`}
              value={
                `capture ${mark(a.capture)}${a.capture.how ? ` (${a.capture.how})` : ""}` +
                ` · reflex ${mark(a.reflex)}${a.reflex.file ? ` ${trunc(a.reflex.file.split(/[\\/]/).pop() ?? "", 16)}` : ""}` +
                ` · gate ${mark(a.gate)}`
              }
              color={allGood ? theme.ok : theme.warn}
              hint="each agent wires ITSELF — nothing is inherited"
            />
          );
        })}
        {setup && setup.agents.length === 0 ? (
          <R id="w-reflex" label="  agents" value={`${glyph.flag} none set up — say "Set up NodeDex" to your agent`} color={theme.warn} hint="every agent needs its own capture + reflex + gate" />
        ) : null}
        <R
          id="w-gate" label="gate checks"
          value={!setup ? "—" : setup.gate.checks > 0 ? `${glyph.up} ${setup.gate.checks} · last ${ago(setup.gate.last_check_at)}` : `${glyph.flag} never fired — nothing checks at the edit`}
          color={!setup ? theme.dim : setup.gate.checks > 0 ? theme.ok : theme.warn}
          hint="fires before your agent edits a file"
        />
        <R
          id="w-read" label="last consulted"
          value={!setup ? "—" : setup.last_graph_read_at ? ago(setup.last_graph_read_at) : "never"}
          color={!setup ? theme.dim : setup.last_graph_read_at ? theme.value : theme.warn}
          hint="what the gate measures staleness against"
        />
      </Section>

      {/* Watchers are ONE way to feed capture above — for hosts that keep their own
          transcripts and expose no post-turn seam. Off is perfectly fine if something
          else (the adapter, your own loop) is posting turns. */}
      <Section title="capture watchers (optional — for hosts with no post-turn seam)">
        <R id="hermes" label="hermes" value={isWatcherRunning("hermes") ? `${glyph.up} running` : hc.enabled ? `${glyph.paused} enabled (stopped)` : "off"} color={isWatcherRunning("hermes") ? theme.ok : hc.enabled ? theme.warn : theme.dim} hint="enter = start/stop" />
        <R id="sources" label="  sources" value={hc.sources.map(captureScope("hermes").toDisplay).join(", ")} hint={captureScope("hermes").hint} />
        <R id="claude" label="claude code" value={isWatcherRunning("claude-code") ? `${glyph.up} running` : cc.enabled ? `${glyph.paused} enabled (stopped)` : "off"} color={isWatcherRunning("claude-code") ? theme.ok : cc.enabled ? theme.warn : theme.dim} hint="enter = start/stop" />
        <R id="ccprojects" label="  projects" value={cc.projects.map(captureScope("claude-code").toDisplay).join(", ")} hint={captureScope("claude-code").hint} />
      </Section>

      <Section title="review">
        <R id="review" label="queue" value={unreviewed > 0 ? `${glyph.flag} ${unreviewed} unreviewed${queueBreakdown ? ` — ${queueBreakdown}` : ""}` : "clear"} color={unreviewed > 0 ? theme.warn : theme.dim} hint="enter = open review" />
      </Section>

      {overlay === "provider" ? (
        <Panel title="extraction provider" hot>
          {pStep === "pick" ? (
            <>
              <Row selected={pSel === 0}>
                <Box width={12}><Text bold={pSel === 0} color={pSel === 0 ? theme.value : theme.label}>OpenRouter</Text></Box>
                <Text color={theme.dim}>cloud — your API key</Text>
              </Row>
              <Row selected={pSel === 1}>
                <Box width={12}><Text bold={pSel === 1} color={pSel === 1 ? theme.value : theme.label}>Local</Text></Box>
                <Text color={theme.dim}>Ollama / LM Studio / vLLM — auto-scanned, no key, $0</Text>
              </Row>
              <Text color={theme.dim}>↑↓ move · enter choose · esc close</Text>
            </>
          ) : null}
          {pStep === "key" ? (
            <>
              <Text color={theme.dim}>Paste your OpenRouter key (openrouter.ai/keys)</Text>
              <Box>
                <Text color={theme.warn}>{"key: "}</Text>
                <Text color={theme.value}>{pBuf ? pBuf.slice(0, 8) + "•".repeat(Math.min(Math.max(pBuf.length - 8, 0), 28)) : ""}</Text>
                <Text color={theme.accent}>▏</Text>
              </Box>
              {pBusy ? <Text color={theme.dim}>verifying key…</Text> : <Text color={theme.dim}>enter verify · esc back</Text>}
            </>
          ) : null}
          {pStep === "model" ? (
            <>
              {RECOMMENDED_MODELS.map((m, i) => (
                <Row key={m.id} selected={i === pSel}>
                  <Box width={22}><Text bold={i === pSel} color={i === pSel ? theme.value : theme.label}>{m.label}</Text></Box>
                  <Text color={m.free ? theme.danger : theme.dim}>{m.note}</Text>
                </Row>
              ))}
              <Row selected={pSel >= RECOMMENDED_MODELS.length}>
                <Box width={22}><Text bold={pSel >= RECOMMENDED_MODELS.length} color={pSel >= RECOMMENDED_MODELS.length ? theme.value : theme.label}>Custom…</Text></Box>
                {pSel >= RECOMMENDED_MODELS.length
                  ? <Text color={pBuf ? theme.value : theme.dim}>{pBuf || "type any OpenRouter model id"}<Text color={theme.accent}>▏</Text></Text>
                  : <Text color={theme.dim}>any OpenRouter model id</Text>}
              </Row>
              {(pSel >= RECOMMENDED_MODELS.length ? isTrainsOnPrompts(pBuf) : !!RECOMMENDED_MODELS[pSel]?.free)
                ? <Text color={theme.danger}>⚠ free — trains on your prompts (inputs may improve the model)</Text>
                : null}
              <Text color={theme.dim}>↑↓ move · enter apply · esc back</Text>
            </>
          ) : null}
          {pStep === "scan" ? (
            pScanning ? <Text color={theme.dim}>scanning Ollama / LM Studio / vLLM…</Text> : (
              <>
                {pModels.length === 0
                  ? <Text color={theme.dim}>no local server found — start it (e.g. `ollama serve`) and press [r], or enter manually</Text>
                  : pModels.map((m, i) => (
                      <Row key={`${m.baseUrl}:${m.model}`} selected={i === pSel}>
                        <Box width={30}><Text bold={i === pSel} color={i === pSel ? theme.value : theme.label}>{trunc(m.model, 29)}</Text></Box>
                        <Text color={theme.dim}>{m.baseUrl.replace(/^https?:\/\//, "")}</Text>
                      </Row>
                    ))}
                <Row selected={pSel >= pModels.length}>
                  <Box width={30}><Text bold={pSel >= pModels.length} color={pSel >= pModels.length ? theme.value : theme.label}>⌨ Enter manually</Text></Box>
                  <Text color={theme.dim}>type a URL + model id</Text>
                </Row>
                <Text color={theme.dim}>↑↓ move · enter apply · r rescan · esc back</Text>
              </>
            )
          ) : null}
          {pStep === "lurl" || pStep === "lmodel" ? (
            <>
              <Text color={theme.dim}>{pStep === "lurl" ? "your OpenAI-compatible endpoint (Ollama, LM Studio, vLLM)" : "the model id your server serves"}</Text>
              <Box>
                <Text color={theme.warn}>{pStep === "lurl" ? "url: " : "model: "}</Text>
                <Text color={pBuf ? theme.value : theme.dim}>{pBuf || (pStep === "lurl" ? DEFAULT_LOCAL_BASE_URL : "qwen3:30b")}</Text>
                <Text color={theme.accent}>▏</Text>
              </Box>
              <Text color={theme.dim}>{pStep === "lurl" ? "enter continue · esc back" : "enter apply · esc back"}</Text>
            </>
          ) : null}
          {pErr ? <Text color={theme.danger}>{`⚠ ${pErr}`}</Text> : null}
        </Panel>
      ) : null}
      {overlay === "db" ? (
        <Panel title="switch database" hot>
          {dbNew !== null ? (
            <>
              <Box>
                <Text color={theme.warn}>new db name: </Text>
                <Text color={dbNew ? theme.value : theme.dim}>{dbNew || "my-project"}</Text>
                <Text color={theme.accent}>▏</Text>
              </Box>
              <Text color={theme.dim}>{"creates ~/.nodedex/<name>.db · enter create · esc back"}</Text>
            </>
          ) : (
            <>
              {dbs.map((d, i) => (
                <Row key={d.path} selected={i === dbSel}>
                  <Text color={i === dbSel ? theme.value : theme.label}>{d.name}</Text>
                  <Text color={theme.dim}>{`  ${trunc(d.path, 50)}`}</Text>
                </Row>
              ))}
              <Row key="__new_db__" selected={dbSel === dbs.length}>
                <Text color={dbSel === dbs.length ? theme.value : theme.accent}>+ new database…</Text>
              </Row>
            </>
          )}
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
