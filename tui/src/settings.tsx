// settings.tsx — operator-essentials settings pane.
//
// Scope (user-confirmed 2026-06-21): the daily-concern knobs only —
//   · reflect (capture) running/paused
//   · extraction model + fallback
//   · cost breaker (credit floor + daily cap) with the live balance/spend
// Deeper tuning (per-pass routing, caps, thinking budget, retries, worker toggles)
// stays out of the TUI — it belongs in the web UI / reconfigure script.
//
// Navigation: ONE list. ↑/↓ (or j/k) move the selection, Enter acts — toggles a
// toggle row, opens an inline editor for a value row. (Replaced the per-field
// hotkeys [space]/[m]/[b]/[f]/[d], which were inconsistent.)
//
// Live values (reflect state, breaker config, balance, 24h spend) ride the App's 2s
// dashboard poll; only the model fields need their own fetch (/api/admin/config). Writes
// go to POST /api/admin/config (applies live + persists ~/.nodedex/.env) and the reflect
// pause/resume endpoints.
import React, { useCallback, useEffect, useState } from "react";
import { Box, Text, useInput } from "ink";
import { Panel } from "./components.js";
import { theme, glyph, fmtMoney } from "./theme.js";
import { fetchConfig, postConfig, setReflectPausedRemote, type AdminConfig, type Dashboard, type Balance } from "./api.js";

// The selectable rows, in navigation order (read-only rows are NOT in this list).
type FieldId = "reflect" | "model" | "fallback" | "floor" | "cap";
const FIELDS: FieldId[] = ["reflect", "model", "fallback", "floor", "cap"];

// A row inside a panel. `selected` draws the ▸ cursor + highlight; read-only rows
// pass selected=undefined (never highlighted, skipped by navigation).
function Row({ selected, label, value, valueColor, hint }: {
  selected?: boolean; label: string; value: string; valueColor?: string; hint?: string;
}) {
  const sel = selected === true;
  return (
    <Box>
      <Text color={theme.accent}>{selected === undefined ? "   " : sel ? " ▸ " : "   "}</Text>
      <Box width={14}><Text color={sel ? theme.accent : theme.label} bold={sel}>{label}</Text></Box>
      <Text color={valueColor ?? theme.value}>{value}</Text>
      {sel && hint ? <Text color={theme.dim}>{`   ${hint}`}</Text> : null}
    </Box>
  );
}

export function SettingsTab({
  dash,
  balance,
  isActive,
  onCapture,
}: {
  dash: Dashboard | null;
  balance: Balance;
  isActive: boolean;
  onCapture: (v: boolean) => void;
}) {
  const [cfg, setCfg] = useState<AdminConfig | null>(null);
  const [sel, setSel] = useState(0);
  const [editing, setEditing] = useState<FieldId | null>(null);
  const [buf, setBuf] = useState("");
  const [notice, setNotice] = useState("");

  const load = useCallback(() => { fetchConfig().then(setCfg); }, []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { onCapture(editing !== null); }, [editing, onCapture]);
  useEffect(() => {
    if (!notice) return;
    const id = setTimeout(() => setNotice(""), 4000);
    return () => clearTimeout(id);
  }, [notice]);

  const reflect = dash?.reflect;
  const paused = !!reflect?.paused;
  const spendPaused = !!reflect?.spend_paused;
  const budgetCfg = dash?.budget?.config;
  const floor = budgetCfg?.minCreditUsd;
  const cap = budgetCfg?.dailyBudgetUsd;
  const spend24h = dash?.budget?.observed?.spend24h;

  const save = useCallback(async (patch: Record<string, string | number>, msg: string) => {
    setNotice("saving…");
    const ok = await postConfig(patch);
    setNotice(ok ? msg : "save failed");
    if (ok) load();
  }, [load]);

  // Enter on a row: toggle the toggle, open the editor for a value field.
  const act = useCallback((id: FieldId) => {
    if (id === "reflect") {
      const next = !paused;
      setNotice(next ? "pausing capture…" : "resuming capture…");
      void setReflectPausedRemote(next).then((ok) => setNotice(ok ? (next ? "capture paused" : "capture resumed") : "toggle failed"));
      return;
    }
    setBuf(
      id === "model" ? (cfg?.model ?? "") :
      id === "fallback" ? (cfg?.fallback_model ?? "") :
      id === "floor" ? (floor != null ? String(floor) : "") :
      cap != null ? String(cap) : "",
    );
    setEditing(id);
  }, [paused, cfg, floor, cap]);

  const submit = useCallback(async () => {
    const v = buf.trim();
    const id = editing;
    setEditing(null); setBuf("");
    if (id === "model")    return save({ model: v }, v ? `model → ${v}` : "model cleared");
    if (id === "fallback") return save({ fallback_model: v }, v ? `fallback → ${v}` : "fallback cleared (none)");
    if (id === "floor")    { if (v && !Number.isFinite(Number(v))) { setNotice("floor must be a number (or blank to disable)"); return; } return save({ min_credit_usd: v }, v ? `credit floor → $${v}` : "credit floor disabled"); }
    if (id === "cap")      { if (v && !Number.isFinite(Number(v))) { setNotice("cap must be a number (or blank to disable)"); return; } return save({ daily_budget_usd: v }, v ? `daily cap → $${v}` : "daily cap disabled"); }
  }, [buf, editing, save]);

  useInput((input, key) => {
    if (editing) {
      if (key.escape) { setEditing(null); setBuf(""); setNotice("cancelled"); }
      else if (key.return) void submit();
      else if (key.backspace || key.delete) setBuf((b) => b.slice(0, -1));
      else if (input && !key.ctrl && !key.meta) setBuf((b) => b + input);
      return;
    }
    if (key.downArrow || input === "j") { setSel((i) => Math.min(i + 1, FIELDS.length - 1)); return; }
    if (key.upArrow || input === "k")   { setSel((i) => Math.max(i - 1, 0)); return; }
    if (key.return)                     { act(FIELDS[Math.min(sel, FIELDS.length - 1)]); return; }
    if (input.toLowerCase() === "r")    { load(); setNotice("refreshed"); return; }
  }, { isActive });

  const selId = FIELDS[Math.min(sel, FIELDS.length - 1)];
  const editLabel =
    editing === "model" ? "model id:" :
    editing === "fallback" ? "fallback model id (blank = none):" :
    editing === "floor" ? "credit floor USD (blank = off):" :
    editing === "cap" ? "daily cap USD (blank = off):" : "";

  return (
    <Box flexDirection="column">
      <Panel title="pipeline" minHeight={6}>
        <Row selected={selId === "reflect"} label="reflect"
          value={paused ? `${glyph.paused} paused` : spendPaused ? `${glyph.paused} spending paused (credit)` : `${glyph.up} running`}
          valueColor={paused || spendPaused ? theme.warn : theme.ok}
          hint="enter = pause/resume capture" />
        <Row selected={selId === "model"} label="model" value={cfg?.model || "(default)"} hint="enter = edit" />
        <Row selected={selId === "fallback"} label="fallback" value={cfg?.fallback_model || "(none)"} hint="enter = edit" />
        <Row label="provider" value={cfg?.provider || "—"} valueColor={theme.dim} />
      </Panel>

      <Panel title="cost guardrails" minHeight={6}>
        <Row selected={selId === "floor"} label="credit floor" value={floor != null ? `$${floor}` : "off"}
          valueColor={floor != null ? theme.value : theme.dim} hint="enter = edit · pauses spend below this" />
        <Row selected={selId === "cap"} label="daily cap" value={cap != null ? `$${cap}/24h` : "off"}
          valueColor={cap != null ? theme.value : theme.dim} hint="enter = edit" />
        <Row label="balance" value={balance.available && balance.remaining != null ? `$${balance.remaining.toFixed(2)}` : "n/a"}
          valueColor={balance.available ? theme.value : theme.dim} />
        <Row label="24h spend" value={typeof spend24h === "number" ? fmtMoney(spend24h) : "—"} valueColor={theme.dim} />
      </Panel>

      {editing ? (
        <Box borderStyle="round" borderColor={theme.warn} paddingX={1}>
          <Text color={theme.warn}>{`${editLabel} `}</Text>
          <Text color={theme.accent}>{buf}</Text>
          <Text color={theme.dim}>▌  (enter ok · esc cancel)</Text>
        </Box>
      ) : (
        <>
          <Text color={theme.dim}> ↑↓ select · enter edit/toggle · [r] refresh</Text>
          <Text color={notice ? theme.accent : theme.dim}>
            {notice ? ` ${notice}` : " changes apply live + persist to ~/.nodedex/.env. Advanced tuning lives in the web UI."}
          </Text>
        </>
      )}
    </Box>
  );
}
