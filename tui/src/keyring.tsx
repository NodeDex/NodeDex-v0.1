// keyring.tsx — the multi-key manager. Reached from BOTH `nodedex config` (lands
// here directly) and the "keyring" row in the settings/health view, so the two are
// consistent, not redundant.
//
// The ring lives in ~/.nodedex/config.json (TUI-owned). Only the ACTIVE + FALLBACK
// keys ever cross the seam into a running server, as env, via POST /api/admin/config
// (which resets the provider on an OPENAI_API_KEY change — a live swap, no relaunch).
// Secrets are masked everywhere here; the raw key is never rendered.
import React, { useCallback, useEffect, useState } from "react";
import { Box, Text, useInput } from "ink";
import { Panel, Row, Keys } from "./components.js";
import { theme, trunc } from "./theme.js";
import { postConfig } from "./api.js";
import {
  listKeys, activeKey, fallbackKey, addKey, removeKey, setActiveKey, setFallbackKey,
  maskSecret, loadConfig, saveConfig, validateOpenRouterKey, OPENROUTER_BASE_URL,
  type StoredKey,
} from "./config.js";

// list = the ring + the three setting rows; the rest are the add/edit sub-modes that
// capture the keyboard while open (label → secret for a new key; a model text field).
type Mode = "list" | "add-label" | "add-secret" | "fbmodel";

export function KeyringPanel({ isActive, onClose, provider }: {
  isActive: boolean;
  onClose: () => void;
  provider?: string;   // "local" → the ring is inert (no cloud key needed); we say so
}) {
  const cfg0 = loadConfig();
  const [keys, setKeys] = useState<StoredKey[]>(listKeys());
  const [activeId, setActiveId] = useState<string | undefined>(activeKey()?.id);
  const [fbId, setFbId] = useState<string | undefined>(fallbackKey()?.id);
  const [fbModel, setFbModel] = useState(cfg0.fallback_model ?? "");
  const [failoverOn, setFailoverOn] = useState(cfg0.failover_on_billing !== false); // default true
  const [sel, setSel] = useState(0);
  const [mode, setMode] = useState<Mode>("list");
  const [buf, setBuf] = useState("");
  const [addLabel, setAddLabel] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  // Re-read the ring from disk after any mutation — config.json is the source of truth,
  // and helpers write it directly, so the panel mirrors the file rather than a local copy.
  const refresh = useCallback(() => {
    setKeys(listKeys());
    setActiveId(activeKey()?.id);
    setFbId(fallbackKey()?.id);
    const c = loadConfig();
    setFbModel(c.fallback_model ?? "");
    setFailoverOn(c.failover_on_billing !== false);
  }, []);

  useEffect(() => {
    if (!notice) return;
    const id = setTimeout(() => setNotice(""), 4000);
    return () => clearTimeout(id);
  }, [notice]);

  // Row layout: one row per key, then + add, then the two setting rows.
  const addRow = keys.length;
  const fbRow = keys.length + 1;
  const billRow = keys.length + 2;
  const total = keys.length + 3;

  const typeInto = useCallback((input: string, key: { backspace?: boolean; delete?: boolean; ctrl?: boolean; meta?: boolean; tab?: boolean }) => {
    if (key.backspace || key.delete) setBuf((b) => b.slice(0, -1));
    else if (input && !key.ctrl && !key.meta && !key.tab) setBuf((b) => b + input.replace(/[\r\n]/g, ""));
  }, []);

  useInput((input, key) => {
    if (busy) return;

    // ── add a key: label step ──
    if (mode === "add-label") {
      if (key.escape) { setMode("list"); setBuf(""); setErr(""); return; }
      if (key.return) { setAddLabel(buf.trim() || `key ${keys.length + 1}`); setBuf(""); setErr(""); setMode("add-secret"); return; }
      typeInto(input, key);
      return;
    }
    // ── add a key: secret step (validated before it lands, like onboarding) ──
    if (mode === "add-secret") {
      if (key.escape) { setMode("add-label"); setBuf(""); setErr(""); return; }
      if (key.return) {
        const secret = buf.trim();
        if (!/^sk-or-/.test(secret) || secret.length < 40) { setErr("that doesn't look like a full OpenRouter key (sk-or-…) — re-paste the whole key"); return; }
        setBusy(true); setErr("");
        void validateOpenRouterKey(secret).then((v) => {
          setBusy(false);
          if (!v.ok) { setErr(v.error ?? "invalid key"); return; }
          const k = addKey({ label: addLabel, provider: "openrouter", secret, base_url: OPENROUTER_BASE_URL });
          setBuf(""); setMode("list"); refresh();
          setNotice(`added ${k.label}${listKeys().length === 1 ? " (now active)" : ""}`);
        });
        return;
      }
      typeInto(input, key);
      return;
    }
    // ── edit the fallback model ──
    if (mode === "fbmodel") {
      if (key.escape) { setMode("list"); setBuf(""); return; }
      if (key.return) {
        const v = buf.trim();
        saveConfig({ fallback_model: v || undefined });
        void postConfig({ fallback_model: v }); // live: server reads NODEDEX_FALLBACK_MODEL fresh per call
        setMode("list"); setBuf(""); refresh();
        setNotice(v ? `fallback model → ${v}` : "fallback model cleared");
        return;
      }
      typeInto(input, key);
      return;
    }

    // ── list mode ──
    if (key.escape) { onClose(); return; }
    if (key.upArrow || input === "k") { setSel((s) => Math.max(0, s - 1)); return; }
    if (key.downArrow || input === "j") { setSel((s) => Math.min(total - 1, s + 1)); return; }

    // a key row: enter = set active, f = toggle fallback, x = remove
    if (sel < keys.length) {
      const k = keys[sel]!;
      if (key.return) {
        setActiveKey(k.id);
        // Live swap: the running server re-reads OPENAI_API_KEY and resets the provider.
        void postConfig({ openai_key: k.secret, openai_base_url: k.base_url ?? OPENROUTER_BASE_URL });
        refresh(); setNotice(`active → ${k.label}`);
        return;
      }
      if (input === "f") {
        const next = fbId === k.id ? undefined : k.id; // pressing f on the current fallback clears it
        setFallbackKey(next);
        // Live: hand the running server the fallback key (or clear it). "" deletes the env var.
        void postConfig({
          fallback_api_key: next ? k.secret : "",
          fallback_base_url: next ? (k.base_url ?? OPENROUTER_BASE_URL) : "",
        });
        refresh(); setNotice(next ? `fallback → ${k.label}` : "fallback cleared");
        return;
      }
      if (input === "x") {
        removeKey(k.id);
        refresh();
        setSel((s) => Math.max(0, Math.min(s, listKeys().length + 2)));
        setNotice(`removed ${k.label}`);
        return;
      }
      return;
    }
    // the setting rows
    if (sel === addRow && key.return) { setMode("add-label"); setBuf(""); setErr(""); return; }
    if (sel === fbRow && key.return) { setMode("fbmodel"); setBuf(fbModel); return; }
    if (sel === billRow && key.return) {
      const next = !failoverOn;
      saveConfig({ failover_on_billing: next });
      void postConfig({ failover_on_billing: next }); // live: server reads NODEDEX_FAILOVER_ON_BILLING per call
      refresh();
      setNotice(`on billing-out: ${next ? "fail over & keep going" : "fail over once, then pause"}`);
      return;
    }
  }, { isActive });

  return (
    <Box flexDirection="column" flexGrow={1}>
      <Panel title="keyring" hot>
        {provider === "local" ? (
          <Text color={theme.dim}>provider is Local — no cloud key needed. Switch to OpenRouter in settings to use the ring.</Text>
        ) : null}
        {keys.length === 0 ? (
          <Text color={theme.dim}>no keys yet — add one below (real users keep several: one active, one fallback)</Text>
        ) : keys.map((k, i) => {
          const isActiveK = k.id === activeId;
          const isFb = k.id === fbId;
          const tag = [isActiveK ? "active" : "", isFb ? "fallback" : ""].filter(Boolean).join(" · ");
          return (
            <Row key={k.id} selected={sel === i}>
              <Text color={isActiveK ? theme.ok : theme.dim}>{isActiveK ? "● " : "○ "}</Text>
              <Box width={18}><Text color={sel === i ? theme.value : theme.label}>{trunc(k.label, 17)}</Text></Box>
              <Box width={20}><Text color={theme.dim}>{maskSecret(k.secret)}</Text></Box>
              <Text color={isFb ? theme.warn : theme.accent}>{tag ? `[${tag}]` : ""}</Text>
            </Row>
          );
        })}
        <Row selected={sel === addRow}>
          <Text color={sel === addRow ? theme.value : theme.accent}>+ add key…</Text>
        </Row>
        <Box marginTop={1} />
        <Row selected={sel === fbRow}>
          <Box width={20}><Text color={sel === fbRow ? theme.accent : theme.label}>fallback model</Text></Box>
          <Text color={theme.value}>{fbModel || "(none)"}</Text>
          {sel === fbRow ? <Text color={theme.dim}>   enter = edit</Text> : null}
        </Row>
        <Row selected={sel === billRow}>
          <Box width={20}><Text color={sel === billRow ? theme.accent : theme.label}>on billing-out</Text></Box>
          <Text color={theme.value}>{failoverOn ? "fail over & keep going" : "fail over once, then pause"}</Text>
          {sel === billRow ? <Text color={theme.dim}>   enter = toggle</Text> : null}
        </Row>
      </Panel>

      {mode === "add-label" ? (
        <Box borderStyle="round" borderColor={theme.borderHot} paddingX={1}>
          <Text color={theme.warn}>{"label: "}</Text>
          <Text color={theme.value}>{buf}</Text><Text color={theme.accent}>▏</Text>
          <Text color={theme.dim}>  (a name you'll recognise — enter next · esc cancel)</Text>
        </Box>
      ) : null}
      {mode === "add-secret" ? (
        <Box flexDirection="column" borderStyle="round" borderColor={theme.borderHot} paddingX={1}>
          <Box>
            <Text color={theme.warn}>{"paste key: "}</Text>
            <Text color={theme.value}>{buf ? buf.slice(0, 8) + "•".repeat(Math.min(Math.max(buf.length - 8, 0), 28)) : ""}</Text>
            <Text color={theme.accent}>▏</Text>
          </Box>
          {busy ? <Text color={theme.dim}>verifying key…</Text> : <Text color={theme.dim}>enter verify + add · esc back</Text>}
        </Box>
      ) : null}
      {mode === "fbmodel" ? (
        <Box borderStyle="round" borderColor={theme.borderHot} paddingX={1}>
          <Text color={theme.warn}>{"fallback model id (blank = none): "}</Text>
          <Text color={theme.value}>{buf}</Text><Text color={theme.accent}>▏</Text>
          <Text color={theme.dim}>  (enter ok · esc cancel)</Text>
        </Box>
      ) : null}

      {err ? <Text color={theme.danger}>{`⚠ ${err}`}</Text> : null}
      {notice ? <Text color={theme.warn}>{notice}</Text> : null}
      <Box flexGrow={1} />
      <Keys items={[["↑↓", "move"], ["enter", "set active / edit"], ["f", "fallback"], ["x", "remove"], ["esc", "back"]]} />
    </Box>
  );
}
