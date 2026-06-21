// serverstab.tsx — the Servers pane: discover / connect / launch / stop / swap.
// The TUI's process-management surface (user-approved boundary crossing). All
// the fencing lives in servers.ts; this is the UI over it.
//
// Model: a PORT is just an access point; the DB is the content. So you pick a
// DB (from the ones on disk) and run it on a port — many ports each with their
// own DB, or reuse one port with a different DB ("swap").
//
// DB picker is a SELECT-then-ACT flow (no hotkey/filter collisions): ↑/↓ pick a
// db (or "＋ new db"), type to filter, Enter opens an action menu (launch / rename
// / delete). Delete is a two-step typed confirm.
import React, { useCallback, useEffect, useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import { Panel } from "./components.js";
import { theme, glyph, trunc, relTime } from "./theme.js";
import { useTermSize } from "./hooks.js";
import { getBase, setBase, probeServer } from "./api.js";
import {
  discover,
  listDbs,
  launchServer,
  genToken,
  stopServer,
  swapDb,
  addPin,
  saveLastServer,
  managedDbPath,
  resolveNewDbPath,
  renameDb,
  deleteDb,
  scanFreePorts,
  type ServerEntry,
  type DbFile,
} from "./servers.js";

type InputMode = null | "launch-port" | "launch-bind" | "add-url";
type Picker = null | { kind: "launch"; port?: number } | { kind: "swap"; url: string; port: number };
// Sub-view inside the picker. "list" picks a db; Enter opens "menu"; the others are
// the typed flows. delete is two-step: confirm, then type "delete <name>".
type DbView =
  | { mode: "list" }
  | { mode: "menu"; db: DbFile; sel: number }
  | { mode: "new"; buf: string }
  | { mode: "rename"; db: DbFile; buf: string }
  | { mode: "delete1"; db: DbFile }
  | { mode: "delete2"; db: DbFile; buf: string };

function sizeStr(d: DbFile): string {
  if (d.empty) return "empty";
  return d.sizeKB >= 1024 ? `${(d.sizeKB / 1024).toFixed(1)}M` : `${d.sizeKB}K`;
}

function windowAround<T>(items: T[], sel: number, h: number): { slice: T[]; off: number } {
  if (items.length <= h) return { slice: items, off: 0 };
  const off = Math.min(Math.max(0, sel - Math.floor(h / 2)), items.length - h);
  return { slice: items.slice(off, off + h), off };
}

export function ServersTab({
  isActive,
  onConnect,
  onCapture,
}: {
  isActive: boolean;
  onConnect: () => void;
  onCapture: (v: boolean) => void;
}) {
  const { columns, rows } = useTermSize();
  const [servers, setServers] = useState<ServerEntry[] | null>(null);
  const [idx, setIdx] = useState(0);
  const [mode, setMode] = useState<InputMode>(null);
  const [buf, setBuf] = useState("");
  const [notice, setNotice] = useState("");
  const [freePorts, setFreePorts] = useState<number[]>([]);
  // db picker (shared by launch + swap)
  const [picker, setPicker] = useState<Picker>(null);
  const [dbs, setDbs] = useState<DbFile[]>([]);
  const [dbFilter, setDbFilter] = useState("");
  const [dbIdx, setDbIdx] = useState(0);            // 0 = "＋ new db", 1.. = fdbs[dbIdx-1]
  const [chosenDb, setChosenDb] = useState("");
  const [launchPort, setLaunchPort] = useState(0);  // port chosen, pending the bind-mode choice
  const [dbView, setDbView] = useState<DbView>({ mode: "list" });
  const seq = useRef(0);

  const rescan = useCallback(() => {
    const s = ++seq.current;
    discover().then((list) => { if (s === seq.current) setServers(list); });
  }, []);

  // Scan for launchable ports (bindable + nothing answering). Cheaper than discovery's
  // per-port HTTP probe, but it momentarily binds — so run it on load + manual rescan +
  // after a launch, NOT on the 3s auto-poll.
  const scanFree = useCallback(() => { scanFreePorts().then(setFreePorts).catch(() => { /* */ }); }, []);

  useEffect(() => {
    rescan();
    scanFree();
    const id = setInterval(rescan, 3000);
    return () => clearInterval(id);
  }, [rescan, scanFree]);

  // a picker OR a text-input mode owns the keyboard
  useEffect(() => { onCapture(picker !== null || mode !== null); }, [picker, mode, onCapture]);

  // a notice is transient feedback — clear it after a few seconds so the help line
  // (which shares its row) always comes back.
  useEffect(() => {
    if (!notice) return;
    const id = setTimeout(() => setNotice(""), 5000);
    return () => clearTimeout(id);
  }, [notice]);

  const list = servers ?? [];
  const sel = list[Math.min(idx, Math.max(0, list.length - 1))];
  const activeUrl = getBase();

  const fdbs = dbFilter
    ? dbs.filter((d) => d.name.toLowerCase().includes(dbFilter.toLowerCase()))
    : dbs;
  // dbIdx 0 = the "＋ new db" entry; 1..fdbs.length = real dbs.
  const selDb: DbFile | undefined = dbIdx >= 1 ? fdbs[dbIdx - 1] : undefined;
  const maxDbIdx = fdbs.length; // entries = 1 (new) + fdbs.length, last index = fdbs.length

  const freePort = (): number => {
    const up = new Set(list.filter((s) => s.up).map((s) => s.port));
    return [3001, 3002, 3003, 3004, 3005, 3099].find((p) => !up.has(p)) ?? 3099;
  };

  const openPicker = (p: Exclude<Picker, null>) => {
    setDbs(listDbs());
    setDbFilter("");
    setDbIdx(0);
    setDbView({ mode: "list" });
    setPicker(p);
  };

  // Resolve a chosen db into a launch (→ pick a port) or a swap (→ relaunch on the port).
  const onDbChosen = (dbPath: string) => {
    const p = picker;
    setPicker(null);
    setDbFilter("");
    setDbView({ mode: "list" });
    if (!p) return;
    if (p.kind === "launch") {
      setChosenDb(dbPath);
      // Default to the port the user was ON when they pressed [l] (if it's a free/down
      // candidate), else the first already-scanned free port. NO async re-scan here — the
      // old code overwrote the field ~1s later, clobbering whatever the user had typed.
      const def = p.port ?? freePorts[0] ?? freePort();
      setBuf(String(def));
      setMode("launch-port");
      return;
    }
    // swap: stop the managed server on this port, relaunch it on the new db. If it's the
    // server we're CONNECTED to, wait for the new one to come up and RE-CONNECT.
    const dbName = dbPath.split(/[\\/]/).pop();
    const wasConnected = p.url === getBase();
    setNotice(`swapping :${p.port} → ${dbName} …`);
    void swapDb(p.url, p.port, dbPath).then(async (r) => {
      if (r.ok && wasConnected) {
        const deadline = Date.now() + 10000;
        while (Date.now() < deadline) {
          if ((await probeServer(p.url)).up) break;
          await new Promise((res) => setTimeout(res, 250));
        }
        setBase(p.url);
        onConnect();
      }
      setNotice(r.ok ? `:${p.port} now running ${dbName}${wasConnected ? " (reconnected)" : ""}` : `swap failed: ${r.error}`);
      rescan();
    });
  };

  const refreshDbs = () => setDbs(listDbs());

  // Apply the active typed db op (new / rename / delete). Errors keep the prompt open.
  const submitDbView = () => {
    const v = dbView;
    if (v.mode === "new") {
      const r = resolveNewDbPath(v.buf);
      if (!r.ok) { setNotice(r.error!); return; }       // stay in the prompt
      onDbChosen(r.path!);                               // → launch-port (server creates it) / swap
      return;
    }
    if (v.mode === "rename") {
      const r = renameDb(v.db.path, v.buf);
      if (!r.ok) { setNotice(r.error!); return; }
      refreshDbs(); setDbView({ mode: "list" });
      setNotice(`renamed → ${(r.path ?? "").split(/[\\/]/).pop()}`);
      return;
    }
    if (v.mode === "delete2") {
      const expected = `delete ${v.db.name}`;
      if (v.buf.trim() !== expected) { setDbView({ mode: "list" }); setNotice(`didn't match "${expected}" — cancelled`); return; }
      const r = deleteDb(v.db.path);
      if (r.ok) { refreshDbs(); setDbIdx(0); setDbView({ mode: "list" }); setNotice(`deleted ${v.db.name}`); }
      else setNotice(r.error!);                          // stay so the error is visible
      return;
    }
  };

  const connect = (s: ServerEntry) => {
    setBase(s.url);
    saveLastServer({ url: s.url, port: s.port, managed: s.managed, dbPath: s.managed ? managedDbPath(s.url) : undefined });
    setNotice(`connected → ${s.url}`);
    onConnect();
  };

  const submitInput = () => {
    const val = buf.trim();
    if (mode === "launch-port") {
      const port = Number(val);
      if (!Number.isFinite(port) || port <= 0) { setNotice("invalid port"); return; }
      setLaunchPort(port);
      setMode("launch-bind"); // ask local vs docker/remote before actually launching
      return;
    }
    if (mode === "add-url") {
      setMode(null);
      if (!val) return;
      const url = val.startsWith("http") ? val : `http://127.0.0.1:${val}`;
      addPin(url); setNotice(`pinned ${url}`); rescan();
      return;
    }
  };

  // Actually launch (after the bind-mode choice). network → bind 0.0.0.0 + a generated token
  // so a Docker/remote agent can reach it; local → default localhost bind, no token.
  const doLaunch = (network: boolean) => {
    setMode(null);
    const port = launchPort;
    const token = network ? genToken() : undefined;
    const r = launchServer({ port, dbPath: chosenDb, bindHost: network ? "0.0.0.0" : undefined, token });
    const db = chosenDb.split(/[\\/]/).pop();
    setNotice(
      !r.ok
        ? `launch failed: ${r.error}`
        : network
          ? `launching :${port} → ${db} on 0.0.0.0 · agent → http://host.docker.internal:${port}/mcp · token: ${token}`
          : `launching :${port} → ${db} (localhost, reviewer OFF) · log ${r.logPath?.split(/[\\/]/).pop()}`
    );
    setTimeout(() => { rescan(); scanFree(); }, 1800);
  };

  // The action menu's entries (label depends on launch vs swap).
  const menuActions = (kind: "launch" | "swap"): { id: "use" | "rename" | "delete"; label: string }[] => [
    { id: "use", label: kind === "swap" && picker?.kind === "swap" ? `run on :${picker.port}` : "launch a server with this db" },
    { id: "rename", label: "rename" },
    { id: "delete", label: "delete" },
  ];

  useInput(
    (input, key) => {
      // 1. DB PICKER — select-then-act sub-views
      if (picker) {
        const v = dbView;

        // action menu (↑↓ pick, enter act, esc back to list)
        if (v.mode === "menu") {
          const actions = menuActions(picker.kind);
          if (key.escape) { setDbView({ mode: "list" }); return; }
          if (key.upArrow || input === "k") { setDbView({ ...v, sel: Math.max(0, v.sel - 1) }); return; }
          if (key.downArrow || input === "j") { setDbView({ ...v, sel: Math.min(actions.length - 1, v.sel + 1) }); return; }
          if (key.return) {
            const a = actions[v.sel].id;
            if (a === "use") onDbChosen(v.db.path);
            else if (a === "rename") setDbView({ mode: "rename", db: v.db, buf: v.db.name.replace(/\.db$/i, "") });
            else setDbView({ mode: "delete1", db: v.db });
          }
          return;
        }

        // delete step 1 (enter → step 2, esc → back to menu)
        if (v.mode === "delete1") {
          if (key.escape) { setDbView({ mode: "menu", db: v.db, sel: 2 }); return; }
          if (key.return) setDbView({ mode: "delete2", db: v.db, buf: "" });
          return;
        }

        // typed flows: new / rename / delete2
        if (v.mode === "new" || v.mode === "rename" || v.mode === "delete2") {
          if (key.escape) {
            setDbView(v.mode === "new" ? { mode: "list" } : { mode: "menu", db: v.db, sel: v.mode === "delete2" ? 2 : 1 });
            setNotice("cancelled");
            return;
          }
          if (key.return) { submitDbView(); return; }
          if (key.backspace || key.delete) { setDbView({ ...v, buf: v.buf.slice(0, -1) }); return; }
          if (input && !key.ctrl && !key.meta) { setDbView({ ...v, buf: v.buf + input }); }
          return;
        }

        // list (default): ↑↓ pick, type filter, enter → new/menu, esc close
        if (key.escape) { setPicker(null); setDbFilter(""); setNotice("cancelled"); return; }
        if (key.return) {
          if (dbIdx === 0) setDbView({ mode: "new", buf: "" });
          else if (selDb) setDbView({ mode: "menu", db: selDb, sel: 0 });
          return;
        }
        if (key.downArrow) { setDbIdx((i) => Math.min(i + 1, maxDbIdx)); return; }
        if (key.upArrow) { setDbIdx((i) => Math.max(0, i - 1)); return; }
        if (key.backspace || key.delete) { setDbFilter((f) => f.slice(0, -1)); setDbIdx(0); return; }
        if (input && !key.ctrl && !key.meta) { setDbFilter((f) => f + input); setDbIdx(0); }
        return;
      }

      // 2a. launch bind-mode choice (local vs docker/remote) — single-key l/d, not text
      if (mode === "launch-bind") {
        if (key.escape) { setMode(null); setNotice("cancelled"); return; }
        const kk = input.toLowerCase();
        if (kk === "l") { doLaunch(false); return; }
        if (kk === "d") { doLaunch(true); return; }
        return;
      }

      // 2. text-input modes (port / url)
      if (mode) {
        if (key.escape) { setMode(null); setBuf(""); setNotice("cancelled"); }
        else if (key.return) submitInput();
        else if (key.backspace || key.delete) setBuf((b) => b.slice(0, -1));
        else if (input && !key.ctrl && !key.meta) setBuf((b) => b + input);
        return;
      }

      // 3. server list navigation + commands
      const last = Math.max(0, list.length - 1);
      const k = input.toLowerCase();
      if (input === "j" || key.downArrow) { setIdx((i) => Math.min(i + 1, last)); return; }
      if (input === "k" || key.upArrow) { setIdx((i) => Math.max(0, i - 1)); return; }
      if (input === "g") { setIdx(0); return; }
      if (input === "G") { setIdx(last); return; }
      if ((key.return || k === "s") && sel?.up) { connect(sel); return; }
      if (k === "l") {
        // If the highlighted row is a free/down port, carry it so the launch defaults THERE.
        const preferPort = sel && !sel.up && sel.port ? sel.port : undefined;
        openPicker({ kind: "launch", port: preferPort });
        return;
      }
      if (k === "c") {
        if (sel?.managed) openPicker({ kind: "swap", url: sel.url, port: sel.port! });
        else setNotice("change-db only works on a server this TUI launched (managed)");
        return;
      }
      if (k === "x" && sel) {
        const r = stopServer(sel.url);
        setNotice(r.ok ? `stopping ${sel.url}` : `can't stop: ${r.error}`);
        setTimeout(rescan, 800);
        return;
      }
      if (k === "a") { setMode("add-url"); setBuf(""); return; }
      if (k === "r") { rescan(); scanFree(); setNotice("rescanning…"); return; }
    },
    { isActive }
  );

  const listH = Math.max(6, rows - (rows < 30 ? 12 : 20));

  // ─── db picker view ──────────────────────────────────────────────────────
  if (picker) {
    const nameW = Math.max(20, columns - 36);
    const dbRows = listH - 1; // leave a row for the "＋ new db" entry
    const w = windowAround(fdbs, Math.max(0, dbIdx - 1), dbRows);
    const title = `select db — ${picker.kind === "swap" ? `swap onto :${picker.port}` : "launch"} (${fdbs.length})`;
    return (
      <Box flexDirection="column">
        <Panel title={title} hot minHeight={listH + 2}>
          {/* ＋ new db — always the first, selectable row */}
          <Box>
            <Text bold={dbIdx === 0} color={dbIdx === 0 ? theme.accent : theme.ok}>
              {`${dbIdx === 0 ? "▸" : " "}＋ create new db…`}
            </Text>
          </Box>
          {fdbs.length === 0 ? (
            <Text color={theme.dim}>{dbFilter ? `no db matches "${dbFilter}"` : "no .db files found in C:/tmp or data/"}</Text>
          ) : (
            w.slice.map((d, i) => {
              const realIdx = w.off + i;            // index in fdbs
              const isSel = dbIdx === realIdx + 1;
              return (
                <Box key={d.path}>
                  <Text bold={isSel} color={isSel ? theme.accent : undefined}>
                    {`${isSel ? "▸" : " "}${trunc(d.name, nameW).padEnd(nameW)}`}
                  </Text>
                  <Text color={d.empty ? theme.dim : theme.label}>{`  ${sizeStr(d).padStart(6)}`}</Text>
                  <Text color={theme.dim}>{`  ${relTime(new Date(d.mtime).toISOString())} ago`}</Text>
                </Box>
              );
            })
          )}
        </Panel>

        {dbView.mode === "menu" ? (
          <Box borderStyle="round" borderColor={theme.accent} paddingX={1} flexDirection="column">
            <Text color={theme.label}>{`${dbView.db.name} —`}</Text>
            {menuActions(picker.kind).map((a, i) => (
              <Text key={a.id} bold={dbView.sel === i} color={dbView.sel === i ? (a.id === "delete" ? theme.danger : theme.accent) : theme.dim}>
                {`${dbView.sel === i ? " ▸ " : "   "}${a.label}`}
              </Text>
            ))}
            <Text color={theme.dim}>{" ↑↓ pick · enter · esc back"}</Text>
          </Box>
        ) : dbView.mode === "new" ? (
          <Box borderStyle="round" borderColor={theme.warn} paddingX={1} flexDirection="column">
            <Text color={theme.warn}>{`new db name: `}<Text color={theme.accent}>{dbView.buf}</Text>▌  <Text color={theme.dim}>(enter create · esc cancel)</Text></Text>
            {notice ? <Text color={theme.dim}>{` ${notice}`}</Text> : null}
          </Box>
        ) : dbView.mode === "rename" ? (
          <Box borderStyle="round" borderColor={theme.warn} paddingX={1} flexDirection="column">
            <Text color={theme.warn}>{`rename "${dbView.db.name}" → `}<Text color={theme.accent}>{dbView.buf}</Text>▌  <Text color={theme.dim}>(enter · esc)</Text></Text>
            {notice ? <Text color={theme.dim}>{` ${notice}`}</Text> : null}
          </Box>
        ) : dbView.mode === "delete1" ? (
          <Box borderStyle="round" borderColor={theme.danger} paddingX={1}>
            <Text color={theme.danger}>{`${glyph.warn} delete "${dbView.db.name}"? This PERMANENTLY removes the db file. `}<Text color={theme.label}>[enter] continue · esc back</Text></Text>
          </Box>
        ) : dbView.mode === "delete2" ? (
          <Box borderStyle="round" borderColor={theme.danger} paddingX={1} flexDirection="column">
            <Text color={theme.danger}>{`to confirm, type exactly:  `}<Text color={theme.label}>{`delete ${dbView.db.name}`}</Text></Text>
            <Text color={theme.accent}>{`  ${dbView.buf}`}▌  <Text color={theme.dim}>(enter · esc)</Text></Text>
            {notice ? <Text color={theme.dim}>{` ${notice}`}</Text> : null}
          </Box>
        ) : (
          <Text color={notice ? theme.accent : theme.dim}>
            {notice ? ` ${notice}` : ` / ${dbFilter}▌   ↑↓ pick · type to filter · enter → actions · esc`}
          </Text>
        )}
      </Box>
    );
  }

  // ─── server list view ────────────────────────────────────────────────────
  const rowOf = (s: ServerEntry, i: number) => {
    const isSel = i === idx;
    const isConn = s.url === activeUrl;
    const dot = isConn ? glyph.up : s.up ? "○" : "✕";
    const dotColor = isConn ? theme.accent : s.up ? theme.ok : theme.dim;
    const portStr = (s.port ? `:${s.port}` : s.url).padEnd(6);
    const idCol = s.up ? (s.db ?? "?") : "(down)";
    const tags = [isConn ? "connected" : "", s.managed ? "managed" : s.up ? "external" : ""]
      .filter(Boolean).join(" · ");
    return (
      <Box key={s.url}>
        <Text color={dotColor}>{`${isSel ? "▸" : " "}${dot} `}</Text>
        <Text bold={isSel} color={isSel ? theme.accent : undefined}>{portStr}</Text>
        <Text>{`  ${trunc(idCol, 24).padEnd(25)}`}</Text>
        <Text color={theme.label}>{s.up && typeof s.blocks === "number" ? `${String(s.blocks).padStart(5)} blk  ` : "            "}</Text>
        <Text color={theme.dim}>{trunc(tags, Math.max(10, columns - 52))}</Text>
      </Box>
    );
  };

  const promptLabel = mode === "launch-port" ? "port:" : mode === "add-url" ? "pin url (or port):" : "";

  return (
    <Box flexDirection="column">
      <Panel title={`servers (${list.filter((s) => s.up).length} up / ${list.length})`} hot minHeight={listH + 2}>
        {servers === null ? (
          <Text color={theme.dim}>scanning ports…</Text>
        ) : list.length === 0 ? (
          <Text color={theme.dim}>no servers found — [l] launch one, or [a] add a url</Text>
        ) : (
          list.slice(0, listH).map(rowOf)
        )}
      </Panel>
      {!mode && (
        <Text color={theme.dim}>
          {` ${glyph.up} free to launch: `}
          <Text color={freePorts.length ? theme.ok : theme.dim}>{freePorts.length ? freePorts.join(" ") : "scanning…"}</Text>
          <Text color={theme.dim}>{`   press [l] to launch on one`}</Text>
        </Text>
      )}
      {mode === "launch-bind" ? (
        <Box borderStyle="round" borderColor={theme.warn} paddingX={1} flexDirection="column">
          <Text color={theme.warn}>{`launch :${launchPort} — where will your agent run?`}</Text>
          <Text color={theme.dim}>{`  [l] this machine (localhost)   [d] Docker / another machine (0.0.0.0 + token)   ·   esc cancel`}</Text>
        </Box>
      ) : mode ? (
        <Box borderStyle="round" borderColor={theme.warn} paddingX={1}>
          <Text color={theme.warn}>{`${promptLabel} `}</Text>
          <Text color={theme.accent}>{buf}</Text>
          <Text color={theme.dim}>
            {mode === "launch-port" && freePorts.length
              ? `▌  (free: ${freePorts.join(" ")} · enter ok · esc)`
              : "▌  (enter ok · esc cancel)"}
          </Text>
        </Box>
      ) : (
        <>
          <Text color={theme.dim}> [enter/s] connect  [l] launch  [c] change db (swap)  [x] stop  [a] add url  [r] rescan</Text>
          <Text color={notice ? theme.accent : theme.dim}>
            {notice
              ? ` ${notice}`
              : " a port is just an access point; pick a db to run on it. launched servers run reviewer-OFF and die on quit."}
          </Text>
        </>
      )}
    </Box>
  );
}
