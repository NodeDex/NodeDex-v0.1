// onboarding.tsx — first-run setup wizard (static, no animation).
//
// Flow: welcome → consent → key (OpenRouter) → model → port → db → starting → connect.
// Onboarding sets up + starts the SERVER (OpenRouter key, model, picked port, named DB).
// Connecting an autonomous agent (e.g. Hermes) to the running /mcp endpoint + wiring
// capture is the USER's own step — the final screen points at the GitHub README for the
// format. Config + secrets go to ~/.nodedex/config.json and are injected into the server
// the TUI launches (servers.ts). Rolls its own inputs + spinner (no input/spinner deps).
import React, { useState, useEffect, useCallback } from "react";
import { Box, Text, useApp, useInput } from "ink";
import { Logo } from "./components.js";
import { theme } from "./theme.js";
import {
  saveConfig, DEFAULT_PORT,
  OPENROUTER_BASE_URL,
  RECOMMENDED_MODELS, isTrainsOnPrompts, listDbs, dbPathForName,
  type DbChoice,
} from "./config.js";
import { launchServer, genToken } from "./servers.js";
import { probeServer, setBase } from "./api.js";

const README_URL = "https://github.com/NodeDex/NodeDex#connect-your-agent";

type Step =
  | "welcome" | "consent" | "openrouter"
  | "model" | "port" | "db" | "agentloc" | "starting" | "connect";

/** Verify the OpenRouter key before saving — a typo fails here, not at first
 *  extraction. GET /key returns the key's usage/limit for a valid key. */
async function validateOpenRouter(key: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const r = await fetch(`${OPENROUTER_BASE_URL}/key`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(8000),
    });
    if (r.ok) return { ok: true };
    if (r.status === 401) return { ok: false, error: "Key rejected (401) — check it and try again." };
    return { ok: false, error: `OpenRouter returned ${r.status}.` };
  } catch (e: any) {
    return { ok: false, error: `Couldn't reach OpenRouter (${e?.message ?? e}).` };
  }
}

// Show a secret's prefix (confirms shape) but mask the tail.
function maskSecret(k: string): string {
  if (!k) return "";
  if (k.length <= 10) return k;
  return k.slice(0, 8) + "•".repeat(Math.min(k.length - 8, 28));
}

function Spinner() {
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  const [i, setI] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setI((n) => (n + 1) % frames.length), 80);
    return () => clearInterval(id);
  }, []);
  return <Text color={theme.accent}>{frames[i]}</Text>;
}

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <Box flexDirection="column" alignItems="center" marginTop={1}>
      <Logo />
      <Box flexDirection="column" alignItems="center" marginTop={1} width={66}>
        {children}
      </Box>
    </Box>
  );
}

function FieldBox({ label, value, focused, mask, placeholder }: {
  label: string; value: string; focused: boolean; mask?: boolean; placeholder?: string;
}) {
  const shown = mask ? maskSecret(value) : value;
  return (
    <Box borderStyle="round" borderColor={focused ? theme.borderHot : theme.border} paddingX={1} width={56}>
      <Box width={7}><Text color={theme.label}>{label}</Text></Box>
      <Text color={value ? theme.value : theme.dim}>{shown || placeholder || " "}</Text>
      {focused ? <Text color={theme.accent}>▏</Text> : null}
    </Box>
  );
}

function Hint({ keys }: { keys: [string, string][] }) {
  return (
    <Box marginTop={1}>
      {keys.map(([k, label], i) => (
        <Box key={k}>
          <Text color={theme.accent}>{`[${k}]`}</Text>
          <Text color={theme.dim}>{` ${label}${i < keys.length - 1 ? "    " : ""}`}</Text>
        </Box>
      ))}
    </Box>
  );
}

/** A vertical pick-list row: ▸ marker + bold-on-select + a dim note/aside. */
function Row({ selected, label, width, aside, asideColor }: {
  selected: boolean; label: string; width: number; aside?: React.ReactNode; asideColor?: string;
}) {
  return (
    <Box>
      <Text color={selected ? theme.accent : theme.dim}>{selected ? "▸ " : "  "}</Text>
      <Box width={width}><Text bold={selected} color={selected ? theme.value : theme.dim}>{label}</Text></Box>
      {typeof aside === "string" ? <Text color={asideColor ?? theme.dim}>{aside}</Text> : aside}
    </Box>
  );
}

export function Onboarding({ onDone }: { onDone: () => void }) {
  const { exit } = useApp();
  const [step, setStep] = useState<Step>("welcome");
  const [orKey, setOrKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");

  // model step
  const [modelSel, setModelSel] = useState(0);    // index into RECOMMENDED_MODELS; === length → custom
  const [customModel, setCustomModel] = useState("");
  // port step
  const [freePorts, setFreePorts] = useState<number[]>([]);
  const [portSel, setPortSel] = useState(0);
  const [chosenPort, setChosenPort] = useState(DEFAULT_PORT);
  // db step
  const [dbs] = useState<DbChoice[]>(() => listDbs());
  const [dbSel, setDbSel] = useState(0);          // 0..dbs.length-1 existing; === dbs.length → new
  const [newDbName, setNewDbName] = useState("");
  // agent-location step (local vs docker/remote) + the resulting bind/token
  const [pendingDb, setPendingDb] = useState("");
  const [agentSel, setAgentSel] = useState(0);    // 0 = this machine, 1 = docker/remote
  const [netToken, setNetToken] = useState("");    // set when launching network-reachable
  // connect step
  const [serverUrl, setServerUrl] = useState("");

  // Detect free ports when entering the port step (reuse probeServer: a port with no
  // Nodedex responding is free enough to claim; launch fails loudly otherwise).
  useEffect(() => {
    if (step !== "port" || freePorts.length > 0) return;
    let cancelled = false;
    (async () => {
      setStatus("Scanning for free ports…");
      const found: number[] = [];
      for (const p of [3001, 3002, 3003, 3004, 3005, 3006, 3007, 3008]) {
        const probe = await probeServer(`http://localhost:${p}`);
        if (!probe.up) found.push(p);
        if (found.length >= 5) break;
      }
      if (cancelled) return;
      setStatus("");
      setFreePorts(found.length ? found : [DEFAULT_PORT]);
      setPortSel(0);
    })();
    return () => { cancelled = true; };
  }, [step, freePorts.length]);

  // Launch the server with the chosen port + db, poll until up, then hand off to connect.
  const finishSetup = useCallback(async (port: number, dbPath: string, bindHost?: string, token?: string) => {
    setStep("starting");
    setStatus("Starting the Nodedex server (downloading the local embedding model on first run — one-time)…");
    setError("");
    const res = launchServer({ port, dbPath, bindHost, token });
    if (!res.ok) { setBusy(false); setStatus(""); setError(`Server failed to start: ${res.error}`); setStep("db"); return; }
    const url = `http://localhost:${port}`;
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      const probe = await probeServer(url);
      if (probe.up) { setBase(url); setBusy(false); setServerUrl(url); setStep("connect"); return; }
      await new Promise((r) => setTimeout(r, 500));
    }
    setBusy(false); setStatus(""); setError("Server didn't come up in time — see ~/.nodedex/tui-logs/."); setStep("db");
  }, []);

  const submitOpenRouter = useCallback(async () => {
    const k = orKey.trim();
    if (!k) { setError("Paste your OpenRouter API key first."); return; }
    // Shape check before the network call: catches a truncated paste fast (a long key pasted
    // into a terminal can drop characters) with a clearer message than a generic 401.
    if (!/^sk-or-/.test(k) || k.length < 40) {
      setError("That doesn't look like a full OpenRouter key (sk-or-…, ~73 chars). A long paste can get cut off — re-paste the whole key.");
      return;
    }
    setBusy(true); setError(""); setStatus("Verifying key…");
    const v = await validateOpenRouter(k);
    if (!v.ok) { setBusy(false); setStatus(""); setError(v.error || "Invalid key."); return; }
    saveConfig({ provider: "openrouter", openrouter_key: k });
    setBusy(false); setStatus(""); setModelSel(0); setStep("model");
  }, [orKey]);

  const submitModel = useCallback(() => {
    const m = modelSel >= RECOMMENDED_MODELS.length ? customModel.trim() : RECOMMENDED_MODELS[modelSel]!.id;
    if (!m) { setError("Pick a model or type a custom id."); return; }
    saveConfig({ model: m });
    setError(""); setStep("port");
  }, [modelSel, customModel]);

  const submitPort = useCallback(() => {
    const port = freePorts[portSel] ?? DEFAULT_PORT;
    setChosenPort(port); saveConfig({ port }); setError(""); setStep("db");
  }, [freePorts, portSel]);

  const submitDb = useCallback(() => {
    let dbPath: string;
    if (dbSel >= dbs.length) {
      const name = newDbName.trim();
      if (!name) { setError("Name your new database."); return; }
      dbPath = dbPathForName(name);
    } else {
      dbPath = dbs[dbSel]!.path;
    }
    saveConfig({ dbPath, onboarded: true });
    setPendingDb(dbPath); setAgentSel(0); setError(""); setStep("agentloc");
  }, [dbSel, dbs, newDbName]);

  const typeInto = (setter: React.Dispatch<React.SetStateAction<string>>, input: string, k: any) => {
    if (k.backspace || k.delete) setter((s) => s.slice(0, -1));
    else if (input && !k.ctrl && !k.meta && !k.tab && !k.return && !k.escape) setter((s) => s + input.replace(/[\r\n]/g, ""));
    setError("");
  };

  useInput((input, k) => {
    if (k.ctrl && input === "c") { exit(); return; }
    if (busy) return;
    if (step === "welcome") {
      if (k.return) setStep("consent"); else if (input === "q") exit();
    } else if (step === "consent") {
      if (k.return) setStep("openrouter"); else if (input === "q") exit();
    } else if (step === "openrouter") {
      if (k.return) void submitOpenRouter();
      else if (k.escape) setStep("consent");
      else typeInto(setOrKey, input, k);
    } else if (step === "model") {
      const total = RECOMMENDED_MODELS.length + 1; // + custom row
      if (k.upArrow) setModelSel((s) => (s - 1 + total) % total);
      else if (k.downArrow) setModelSel((s) => (s + 1) % total);
      else if (k.escape) setStep("openrouter");
      else if (k.return) submitModel();
      else if (modelSel >= RECOMMENDED_MODELS.length) typeInto(setCustomModel, input, k);
    } else if (step === "port") {
      if (freePorts.length === 0) return; // still scanning
      if (k.upArrow) setPortSel((s) => (s - 1 + freePorts.length) % freePorts.length);
      else if (k.downArrow) setPortSel((s) => (s + 1) % freePorts.length);
      else if (k.return) submitPort();
      else if (k.escape) setStep("model");
    } else if (step === "db") {
      const total = dbs.length + 1; // + new row
      if (k.upArrow) setDbSel((s) => (s - 1 + total) % total);
      else if (k.downArrow) setDbSel((s) => (s + 1) % total);
      else if (k.escape) setStep("port");
      else if (k.return) submitDb();
      else if (dbSel >= dbs.length) typeInto(setNewDbName, input, k);
    } else if (step === "agentloc") {
      if (k.upArrow || k.downArrow) setAgentSel((s) => (s === 0 ? 1 : 0));
      else if (k.escape) setStep("db");
      else if (k.return) {
        if (agentSel === 1) {
          const tok = genToken();
          setNetToken(tok);
          void finishSetup(chosenPort, pendingDb, "0.0.0.0", tok);
        } else {
          setNetToken("");
          void finishSetup(chosenPort, pendingDb);
        }
      }
    } else if (step === "connect") {
      if (k.return) onDone();
    }
  });

  if (step === "welcome") {
    return (
      <Frame>
        <Text color={theme.value}>Welcome — let's get your agent's memory set up.</Text>
        <Hint keys={[["Enter", "begin"], ["q", "quit"]]} />
      </Frame>
    );
  }

  if (step === "consent") {
    return (
      <Frame>
        <Text color={theme.title} bold>Before you start</Text>
        <Box marginTop={1} flexDirection="column">
          <Text color={theme.value}>· Nodedex stores your work as a knowledge graph on your machine.</Text>
          <Text color={theme.value}>· An AI pipeline extracts that knowledge — it can be wrong or</Text>
          <Text color={theme.value}>  incomplete. Treat saved blocks as notes, not ground truth.</Text>
          <Text color={theme.value}>· You bring your own model provider; usage is billed to you.</Text>
        </Box>
        <Hint keys={[["Enter", "I understand & agree"], ["q", "quit"]]} />
      </Frame>
    );
  }

  if (step === "openrouter") {
    return (
      <Frame>
        <Text color={theme.title} bold>Connect OpenRouter</Text>
        <Box marginTop={1} flexDirection="column" alignItems="center">
          <Text color={theme.dim}>Get a key at openrouter.ai/keys</Text>
          <Box marginTop={1}>
            <FieldBox label="key" value={orKey} focused mask placeholder="sk-or-..." />
          </Box>
          {error ? <Text color={theme.danger}>{`⚠ ${error}`}</Text> : <Text> </Text>}
          {status ? <Box><Spinner /><Text color={theme.dim}>{` ${status}`}</Text></Box> : null}
        </Box>
        <Hint keys={[["Enter", "verify & continue"], ["Esc", "back"]]} />
      </Frame>
    );
  }

  if (step === "model") {
    const custom = modelSel >= RECOMMENDED_MODELS.length;
    const warn = custom ? isTrainsOnPrompts(customModel) : !!RECOMMENDED_MODELS[modelSel]!.free;
    return (
      <Frame>
        <Text color={theme.title} bold>Choose a model</Text>
        <Text color={theme.dim}>OpenRouter slugs — vendor/model (custom: any OpenRouter id)</Text>
        <Box marginTop={1} flexDirection="column">
          {RECOMMENDED_MODELS.map((m, i) => (
            <Row key={m.id} selected={i === modelSel} label={m.label} width={20}
              aside={m.note} asideColor={m.free ? theme.danger : theme.dim} />
          ))}
          <Row selected={custom} label="Custom…" width={20}
            aside={custom
              ? <Text color={customModel ? theme.value : theme.dim}>{(customModel || "type a model id")}<Text color={theme.accent}>▏</Text></Text>
              : "enter any model id"} />
        </Box>
        {warn
          ? <Box marginTop={1}><Text color={theme.danger}>⚠ Free — but it trains on your prompts (your inputs may be used to improve the model).</Text></Box>
          : <Text> </Text>}
        {error ? <Text color={theme.danger}>{`⚠ ${error}`}</Text> : null}
        <Hint keys={[["↑↓", "move"], ["Enter", "select"], ["Esc", "back"]]} />
      </Frame>
    );
  }

  if (step === "port") {
    return (
      <Frame>
        <Text color={theme.title} bold>Pick a port</Text>
        {freePorts.length === 0
          ? <Box marginTop={1}><Spinner /><Text color={theme.dim}>{` ${status || "Scanning…"}`}</Text></Box>
          : (
            <Box marginTop={1} flexDirection="column">
              {freePorts.map((p, i) => (
                <Row key={p} selected={i === portSel} label={`localhost:${p}`} width={18} aside="free" />
              ))}
            </Box>
          )}
        {error ? <Text color={theme.danger}>{`⚠ ${error}`}</Text> : null}
        <Hint keys={[["↑↓", "move"], ["Enter", "select"], ["Esc", "back"]]} />
      </Frame>
    );
  }

  if (step === "db") {
    const newSel = dbSel >= dbs.length;
    return (
      <Frame>
        <Text color={theme.title} bold>Choose a database</Text>
        <Box marginTop={1} flexDirection="column">
          {dbs.map((d, i) => (
            <Row key={d.path} selected={i === dbSel} label={d.name} width={18} aside="existing" />
          ))}
          <Row selected={newSel} label="＋ New database" width={18}
            aside={newSel
              ? <Text color={newDbName ? theme.value : theme.dim}>{(newDbName || "name it")}<Text color={theme.accent}>▏</Text></Text>
              : "create + name a new graph"} />
        </Box>
        {error ? <Text color={theme.danger}>{`⚠ ${error}`}</Text> : null}
        <Hint keys={[["↑↓", "move"], ["Enter", "select"], ["Esc", "back"]]} />
      </Frame>
    );
  }

  if (step === "agentloc") {
    return (
      <Frame>
        <Text color={theme.title} bold>Where will your agent run?</Text>
        <Text color={theme.dim}>This sets how the server is reachable.</Text>
        <Box marginTop={1} flexDirection="column">
          <Row selected={agentSel === 0} label="This machine" width={24}
            aside="localhost — simplest & private (default)" />
          <Row selected={agentSel === 1} label="Docker / another machine" width={24}
            aside="binds 0.0.0.0 + makes an access token" asideColor={theme.warn} />
        </Box>
        {agentSel === 1
          ? <Box marginTop={1}><Text color={theme.warn}>⚠ Reachable on your network; the token keeps it private.</Text></Box>
          : <Text> </Text>}
        {error ? <Text color={theme.danger}>{`⚠ ${error}`}</Text> : null}
        <Hint keys={[["↑↓", "move"], ["Enter", "start server"], ["Esc", "back"]]} />
      </Frame>
    );
  }

  if (step === "connect") {
    const mcpUrl = netToken ? `http://host.docker.internal:${chosenPort}/mcp` : `${serverUrl}/mcp`;
    return (
      <Frame>
        <Text color={theme.title} bold>✓ Server running</Text>
        <Box marginTop={1} flexDirection="column" alignItems="center">
          <Text color={theme.value}>{mcpUrl}</Text>
          {netToken ? (
            <Box flexDirection="column" alignItems="center">
              <Text color={theme.dim}>your agent must send this header:</Text>
              <Text color={theme.accent}>{`Authorization: Bearer ${netToken}`}</Text>
              <Text color={theme.warn}>⚠ keep this token safe &amp; secret — it won't be shown again</Text>
            </Box>
          ) : null}
          <Box marginTop={1} flexDirection="column">
            <Text color={theme.value}>Connect your agent (e.g. Hermes) to that URL, then have</Text>
            <Text color={theme.value}>it run the workspace_install_capture tool once so your</Text>
            <Text color={theme.value}>turns flow into the graph.</Text>
          </Box>
          <Box marginTop={1}><Text color={theme.dim}>Exact config + capture steps in the README:</Text></Box>
          <Text color={theme.accent}>{README_URL}</Text>
        </Box>
        <Hint keys={[["Enter", "open dashboard"]]} />
      </Frame>
    );
  }

  // starting
  return (
    <Frame>
      <Box>
        <Spinner />
        <Text color={theme.value}>{` ${status || "Starting…"}`}</Text>
      </Box>
      {error ? <Text color={theme.danger}>{`⚠ ${error}`}</Text> : null}
    </Frame>
  );
}
