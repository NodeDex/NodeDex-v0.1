// try-setup-gate-live.mjs — does the setup gate actually work against the LIVE server?
// A real MCP client over HTTP, exactly as an agent connects. Run from server/:
//   node scripts/try-setup-gate-live.mjs
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const connect = async () => {
  const c = new Client({ name: "setup-gate-live", version: "0.0.0" });
  await c.connect(new StreamableHTTPClientTransport(new URL("http://127.0.0.1:3001/mcp")));
  return c;
};
const textOf = (r) => (r.content ?? []).map((p) => p.text ?? "").join("\n");
const hasNotice = (r) => textOf(r).includes("SETUP INCOMPLETE");

const client = await connect();

// 0. What the agent sees at connect (the advisory floor — this is the channel that decays)
const tools = (await client.listTools()).tools.map((t) => t.name);
console.log(`connected — ${tools.length} tools, onboard present: ${tools.includes("workspace_onboard")}\n`);

// 1. An ordinary read — the FIRST thing any agent does. Does the gate ride it?
const tree = await client.callTool({ name: "workspace_tree", arguments: {} });
console.log("① workspace_tree (a plain read):");
console.log(`   setup notice present: ${hasNotice(tree) ? "YES ✓" : "NO ✗"}`);
if (hasNotice(tree)) {
  const notice = textOf(tree).split("\n").find((l) => l.includes("SETUP INCOMPLETE"));
  console.log(`   → "${notice.slice(0, 100)}…"`);
}

// 2. Another read — it must keep riding (this is what "cannot decay" means)
const stats = await client.callTool({ name: "workspace_stats", arguments: {} });
console.log(`\n② workspace_stats (a second read): notice still there: ${hasNotice(stats) ? "YES ✓" : "NO ✗"}`);

// 3. The agent does what the notice says.
const onboard = await client.callTool({ name: "workspace_onboard", arguments: {} });
const payload = JSON.parse(textOf(onboard).split("\n")[0]).data;
console.log(`\n③ workspace_onboard:`);
console.log(`   nags about itself: ${hasNotice(onboard) ? "YES ✗" : "NO ✓ (exempt, as designed)"}`);
console.log(`   asks WHERE the standing channel is: ${/re-read into (your )?context EVERY TURN/i.test(payload.step_1_find_your_standing_channel) ? "YES ✓" : "NO ✗"}`);
console.log(`   prefers AGENTS.md (cross-tool): ${/AGENTS\.md/.test(payload.where_to_write) ? "YES ✓" : "NO ✗"}`);
console.log(`   consent-gated: ${/ASK permission/i.test(payload.step_2_explain_and_ask) ? "YES ✓" : "NO ✗"}`);
console.log(`   hands over the block: ${payload.reflex_block?.includes("nodedex:protocol:begin") ? "YES ✓" : "NO ✗"}`);
console.log(`   block size: ${payload.reflex_block?.length} chars (~${Math.round((payload.reflex_block?.length ?? 0) / 4)} tokens/turn, forever)`);

// 4. The notice must now be gone — this session AND every future one.
const after = await client.callTool({ name: "workspace_tree", arguments: {} });
console.log(`\n④ workspace_tree again: notice gone: ${!hasNotice(after) ? "YES ✓" : "NO ✗"}`);
await client.close();

const fresh = await connect();
const later = await fresh.callTool({ name: "workspace_stats", arguments: {} });
console.log(`⑤ a NEW session (new client): notice gone: ${!hasNotice(later) ? "YES ✓ (persisted, not in-memory)" : "NO ✗"}`);
await fresh.close();

console.log("\n── the reflex the agent is told to persist ──");
console.log(payload.reflex_block);
