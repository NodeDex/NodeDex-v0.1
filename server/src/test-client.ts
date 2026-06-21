import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { spawn } from "child_process";
import path from "path";

import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function main() {
  console.log("Starting MCP Test Client...");

  // Path to the compiled server (or tsx execution)
  const serverPath = path.resolve(__dirname, "server.ts");

  const transport = new StdioClientTransport({
    command: "npx",
    args: ["tsx", serverPath],
    env: {
      ...process.env,
      // Pass the API key if it exists in the environment,
      // otherwise semantic search won't work, but it won't crash
      GEMINI_API_KEY: process.env.GEMINI_API_KEY || "", 
    }
  });

  const client = new Client(
    {
      name: "test-client",
      version: "1.0.0",
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  console.log("Connecting to server...");
  await client.connect(transport);
  console.log("Connected!");

  // List tools
  const toolsInfo = await client.listTools();
  console.log(`\nServer supports ${toolsInfo.tools.length} tools.`);

  // Test 1: Auto-Recall (Empty DB)
  console.log("\n--- Test 1: Auto-Recall (Empty DB) ---");
  const recallEmpty = await client.callTool({
    name: "workspace_auto_recall",
    arguments: {
      message: "What is the cost of Vapi?",
    }
  });
  console.log(recallEmpty.content[0].text);

  // Test 2: Remember
  console.log("\n--- Test 2: Remember a Fact ---");
  const rememberRes = await client.callTool({
    name: "workspace_remember",
    arguments: {
      label: "Vapi Pricing",
      type: "fact",
      essence: "Vapi costs $0.05 per minute for voice agents.",
      content: JSON.stringify({ is_a: "pricing", has: { cost: "$0.05/min" } })
    }
  });
  const parsedData = JSON.parse(rememberRes.content[0].text as string);
  const blockId = parsedData.data ? parsedData.data.id : parsedData.id;
  console.log(`Saved Block ID: ${blockId}`);

  // Test 3: Auto-Recall (Populated DB)
  console.log("\n--- Test 3: Auto-Recall (Populated DB) ---");
  const recallPopulated = await client.callTool({
    name: "workspace_auto_recall",
    arguments: {
      message: "What is the cost of Vapi?",
    }
  });
  console.log(recallPopulated.content[0].text);

  // Test 4: Auto-Reflect
  console.log("\n--- Test 4: Auto-Reflect (Async processing) ---");
  const reflectRes = await client.callTool({
    name: "workspace_auto_reflect",
    arguments: {
      response: "I decided to use Twilio because of its global reach.",
      loaded_blocks: [blockId]
    }
  });
  console.log(reflectRes.content[0].text);

  // Wait 1 sec for async auto-reflect to finish
  await new Promise(r => setTimeout(r, 1000));

  // Test 5: Search
  console.log("\n--- Test 5: Search for Twilio decision ---");
  const searchRes = await client.callTool({
    name: "workspace_search",
    arguments: {
      query: "Twilio global reach decision",
    }
  });
  console.log(searchRes.content[0].text);

  console.log("\nDisconnecting...");
  await client.close();
}

main().catch(console.error);
