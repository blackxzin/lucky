import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerMaestriTools } from "./tools/maestri.js";
import { registerPcTools } from "./tools/pc.js";
import { registerReminderTools } from "./tools/reminders.js";
import type { ServerDeps } from "./tools/shared.js";
import { registerVaultTools } from "./tools/vault.js";

export type { ServerDeps } from "./tools/shared.js";

const SERVER_NAME = "pet-brain";
const SERVER_VERSION = "0.2.0";

export function createServer(deps: ServerDeps): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  registerMaestriTools(server, deps);
  registerVaultTools(server, deps);
  registerPcTools(server, deps);
  registerReminderTools(server, deps);
  return server;
}
