// onboarding.tsx — first-run setup wizard (static, no animation).
//
// Flow: welcome → consent → provider → {OpenRouter: key → model | Local: endpoint → model}
//   → port → db → starting → connect.
// Two model paths: OpenRouter (cloud, BYO key) or Local / self-hosted (Ollama/LM Studio/vLLM —
// offline, no key, $0). Same-machine server only (localhost, no token); the Docker/remote
// deployment branch was removed — reachable-on-network setup is a later concern, not first-run.
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
  saveConfig, DEFAULT_PORT, DEFAULT_LOCAL_BASE_URL,
  OPENROUTER_BASE_URL,
  RECOMMENDED_MODELS, isTrainsOnPrompts, listDbs, dbPathForName, scanLocalModels,
  type DbChoice, type LocalModel,
} from "./config.js";
import { launchServer } from "./servers.js";
import { probeServer, setBase } from "./api.js";

const README_URL = "https://github.com/NodeDex/NodeDex-v0.1#connect-your-agent";

type Step =
  | "welcome" | "consent" | "provider" | "openrouter" | "model"
  | "localscan" | "localendpoint" | "localmodel"
  | "port" | "db" | "starting" | "connect";

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
  // provider step (0 = OpenRouter cloud, 1 = Local/self-hosted) + local fields
  const [providerSel, setProviderSel] = useState(0);
  const [localBaseUrl, setLocalBaseUrl] = useState(DEFAULT_LOCAL_BASE_URL);
  const [localModel, setLocalModel] = useState("");
  // local-scan step: discovered models + selection (=== length → "enter manually")
  const [localScanning, setLocalScanning] = useState(false);
  const [localModels, setLocalModels] = useState<LocalModel[]>([]);
  const [localModelSel, setLocalModelSel] = useState(0);
  const [localScanNonce, setLocalScanNonce] = useState(0);   // bump to rescan
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
  // connect step
  const [serverUrl, setServerUrl] = useState("");

  // Scan local LLM servers when entering the local-scan step (so the user picks a model, not a
  // URL). Re-runs when localScanNonce bumps ([r] rescan — e.g. after starting the server).
  useEffect(() => {
    if (step !== "localscan") return;
    let cancelled = false;
    setLocalScanning(true); setError("");
    scanLocalModels().then((models) => {
      if (cancelled) return;
      setLocalModels(models);
      setLocalModelSel(0);
      setLocalScanning(false);
    });
    return () => { cancelled = true; };
  }, [step, localScanNonce]);

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

  const submitProvider = useCallback(() => {
    setError("");
    setStep(providerSel === 1 ? "localscan" : "openrouter");
  }, [providerSel]);

  const submitLocalScan = useCallback(() => {
    if (localModelSel >= localModels.length) { setError(""); setStep("localendpoint"); return; } // manual entry
    const pick = localModels[localModelSel]!;
    saveConfig({ provider: "local", base_url: pick.baseUrl, model: pick.model });
    setError(""); setStep("port");
  }, [localModelSel, localModels]);

  const submitLocalEndpoint = useCallback(() => {
    const url = localBaseUrl.trim();
    if (!url) { setError("Enter your local endpoint URL (e.g. http://localhost:11434/v1)."); return; }
    saveConfig({ provider: "local", base_url: url });
    setError(""); setStep("localmodel");
  }, [localBaseUrl]);

  const submitLocalModel = useCallback(() => {
    const m = localModel.trim();
    if (!m) { setError("Enter the model id your server serves (e.g. qwen3:30b)."); return; }
    saveConfig({ model: m });
    setError(""); setStep("port");
  }, [localModel]);

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
    setError("");
    // same-machine only: launch straight on localhost (no bindHost/token).
    void finishSetup(chosenPort, dbPath);
  }, [dbSel, dbs, newDbName, chosenPort, finishSetup]);

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
      if (k.return) setStep("provider"); else if (input === "q") exit();
    } else if (step === "provider") {
      if (k.upArrow || k.downArrow) setProviderSel((s) => (s === 0 ? 1 : 0));
      else if (k.escape) setStep("consent");
      else if (k.return) submitProvider();
    } else if (step === "openrouter") {
      if (k.return) void submitOpenRouter();
      else if (k.escape) setStep("provider");
      else typeInto(setOrKey, input, k);
    } else if (step === "localscan") {
      if (localScanning) return;
      const total = localModels.length + 1; // + "enter manually" row
      if (k.upArrow) setLocalModelSel((s) => (s - 1 + total) % total);
      else if (k.downArrow) setLocalModelSel((s) => (s + 1) % total);
      else if (k.escape) setStep("provider");
      else if (input === "r") setLocalScanNonce((n) => n + 1);
      else if (k.return) submitLocalScan();
    } else if (step === "localendpoint") {
      if (k.return) submitLocalEndpoint();
      else if (k.escape) setStep("localscan");
      else typeInto(setLocalBaseUrl, input, k);
    } else if (step === "localmodel") {
      if (k.return) submitLocalModel();
      else if (k.escape) setStep("localendpoint");
      else typeInto(setLocalModel, input, k);
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
      else if (k.escape) setStep(providerSel === 1 ? "localscan" : "model");
    } else if (step === "db") {
      const total = dbs.length + 1; // + new row
      if (k.upArrow) setDbSel((s) => (s - 1 + total) % total);
      else if (k.downArrow) setDbSel((s) => (s + 1) % total);
      else if (k.escape) setStep("port");
      else if (k.return) submitDb();
      else if (dbSel >= dbs.length) typeInto(setNewDbName, input, k);
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
          <Text color={theme.value}>· An AI pipeline builds your agent's memory from your turns — it</Text>
          <Text color={theme.value}>  can be wrong or incomplete; the agent's notes, not ground truth.</Text>
          <Text color={theme.value}>· You bring your own model — a cloud key (billed to you) or a local one.</Text>
        </Box>
        <Hint keys={[["Enter", "I understand & agree"], ["q", "quit"]]} />
      </Frame>
    );
  }

  if (step === "provider") {
    return (
      <Frame>
        <Text color={theme.title} bold>How will you run the extraction model?</Text>
        <Text color={theme.dim}>NodeDex's pipeline uses it to turn your turns into the graph.</Text>
        <Box marginTop={1} flexDirection="column">
          <Row selected={providerSel === 0} label="OpenRouter" width={12}
            aside="cloud — bring your API key (recommended)" />
          <Row selected={providerSel === 1} label="Local" width={12}
            aside="self-hosted (Ollama / LM Studio) — offline, no key, $0" />
        </Box>
        <Hint keys={[["↑↓", "move"], ["Enter", "select"], ["Esc", "back"]]} />
      </Frame>
    );
  }

  if (step === "localscan") {
    const manualSel = localModelSel >= localModels.length;
    return (
      <Frame>
        <Text color={theme.title} bold>Pick a local model</Text>
        <Text color={theme.dim}>Make sure your model server (Ollama / LM Studio / vLLM) is running first.</Text>
        {localScanning ? (
          <Box marginTop={1}><Spinner /><Text color={theme.dim}>{` Scanning Ollama / LM Studio / vLLM…`}</Text></Box>
        ) : (
          <Box marginTop={1} flexDirection="column">
            {localModels.length === 0
              ? <Text color={theme.dim}>No local server found. Start it (e.g. `ollama serve`) and press [r], or enter it manually.</Text>
              : localModels.map((m, i) => (
                  <Row key={`${m.baseUrl}:${m.model}`} selected={i === localModelSel} label={m.model} width={30}
                    aside={m.baseUrl.replace(/^https?:\/\//, "")} />
                ))}
            <Row selected={manualSel} label="⌨ Enter manually" width={30} aside="type a URL + model id" />
          </Box>
        )}
        {error ? <Text color={theme.danger}>{`⚠ ${error}`}</Text> : null}
        <Hint keys={[["↑↓", "move"], ["Enter", "select"], ["r", "rescan"], ["Esc", "back"]]} />
      </Frame>
    );
  }

  if (step === "localendpoint") {
    return (
      <Frame>
        <Text color={theme.title} bold>Local endpoint</Text>
        <Box marginTop={1} flexDirection="column" alignItems="center">
          <Text color={theme.dim}>Your OpenAI-compatible server (Ollama, LM Studio, vLLM)</Text>
          <Box marginTop={1}>
            <FieldBox label="url" value={localBaseUrl} focused placeholder={DEFAULT_LOCAL_BASE_URL} />
          </Box>
          {error ? <Text color={theme.danger}>{`⚠ ${error}`}</Text> : <Text> </Text>}
        </Box>
        <Hint keys={[["Enter", "continue"], ["Esc", "back"]]} />
      </Frame>
    );
  }

  if (step === "localmodel") {
    return (
      <Frame>
        <Text color={theme.title} bold>Local model</Text>
        <Box marginTop={1} flexDirection="column" alignItems="center">
          <Text color={theme.dim}>The model id your server serves (e.g. qwen3:30b, llama3.3)</Text>
          <Box marginTop={1}>
            <FieldBox label="model" value={localModel} focused placeholder="qwen3:30b" />
          </Box>
          <Box marginTop={1}><Text color={theme.dim}>A capable ~30B+ model gives the best extraction quality.</Text></Box>
          {error ? <Text color={theme.danger}>{`⚠ ${error}`}</Text> : <Text> </Text>}
        </Box>
        <Hint keys={[["Enter", "continue"], ["Esc", "back"]]} />
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

  if (step === "connect") {
    return (
      <Frame>
        <Text color={theme.title} bold>✓ Server running</Text>
        <Box marginTop={1} flexDirection="column" alignItems="center">
          <Text color={theme.value}>{`${serverUrl}/mcp`}</Text>
          <Box marginTop={1} flexDirection="column">
            <Text color={theme.value}>Point your agent (e.g. Hermes) at that URL, then turn on</Text>
            <Text color={theme.value}>capture so your turns flow into the graph — for Hermes,</Text>
            <Text color={theme.value}>Settings → hermes capture.</Text>
          </Box>
          <Box marginTop={1}><Text color={theme.dim}>Exact connect + capture steps in the README:</Text></Box>
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
