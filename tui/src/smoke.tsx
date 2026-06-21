// smoke.tsx — render the app against the live server for a few seconds, then
// self-unmount and exit. Runtime smoke only (not part of the app).
// Feeds a non-TTY stdin so input stays disabled headlessly (real terminals get
// a TTY and full key handling); this isolates the render + live-data path.
import React from "react";
import { PassThrough } from "node:stream";
import { render } from "ink";
import { App } from "./App.js";

const stdin = new PassThrough();
const { unmount, waitUntilExit } = render(<App />, { stdin: stdin as any, exitOnCtrlC: false });
setTimeout(() => unmount(), 3500);
await waitUntilExit();
console.log("\n[smoke] rendered + unmounted cleanly");
