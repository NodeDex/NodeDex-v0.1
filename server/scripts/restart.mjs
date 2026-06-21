#!/usr/bin/env node
// scripts/restart.mjs — stop any running nodedex server(s), then start one.
//
// Codifies the manual stop-start dance and its hard-won lesson: kill ALL nodedex
// server.ts processes BY COMMAND-LINE (not just the :3001 listener — stale
// NON-listening servers held the DB lock and caused the "restart doesn't take"
// trap). With the EADDRINUSE-exit guard now in the server, zombies no longer
// accumulate; this just makes the clean stop+start one command.
//
//   node scripts/restart.mjs          # stop all, then start in the FOREGROUND
//   node scripts/restart.mjs --stop   # just stop (no start)
//
import { spawn, execFileSync } from "child_process";
import { fileURLToPath } from "url";

const serverDir = fileURLToPath(new URL("..", import.meta.url)); // Nodedex/server/
const isWin = process.platform === "win32";

function killServers() {
  try {
    if (isWin) {
      const ps = "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | " +
        "Where-Object { $_.CommandLine -like '*src/server.ts*' } | " +
        "ForEach-Object { Stop-Process -Id $_.ProcessId -Force }";
      execFileSync("powershell", ["-NoProfile", "-Command", ps], { stdio: "ignore" });
    } else {
      execFileSync("pkill", ["-f", "src/server.ts"], { stdio: "ignore" });
    }
  } catch { /* none running (pkill exits non-zero with no match) */ }
}

const stopOnly = process.argv.includes("--stop");
console.error("[restart] stopping any nodedex server.ts process(es)...");
killServers();

if (stopOnly) { console.error("[restart] stopped."); process.exit(0); }

// brief pause so the port + DB lock free before the new process opens them
await new Promise((r) => setTimeout(r, 1500));

console.error("[restart] starting server (foreground; Ctrl+C for a graceful stop)...");
const child = spawn(process.execPath, ["--env-file=.env", "--import=tsx/esm", "src/server.ts"], {
  cwd: serverDir,
  stdio: "inherit",
});
child.on("exit", (code) => process.exit(code ?? 0));
