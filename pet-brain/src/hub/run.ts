import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "../config.js";
import { createApprovalStore } from "../pc/approvals.js";
import { createAuditLog } from "../pc/audit.js";
import { spawnRunner } from "../proc/run.js";
import { createAgent } from "./agent.js";
import { assertBindHost } from "./bind.js";
import { createHubCore } from "./core.js";
import { buildMcpConfig } from "./mcp-config.js";
import { buildPersona } from "./persona.js";
import { createHubServer } from "./server.js";
import { loadOrCreateToken, tokenPath } from "./token.js";

const PRIVATE_DIR_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

export interface HubRuntime {
  entry: string;
  uiDir: string;
}

/** Sobe o hub e devolve a URL. Fica vivo até o processo terminar. */
export async function startHub(config: Config, runtime: HubRuntime): Promise<string> {
  assertBindHost(config.hubHost, config.allowAnyHost);
  const token = await loadOrCreateToken(config.configDir);

  const agentCwd = join(config.stateDir, "agent-cwd");
  await mkdir(agentCwd, { recursive: true, mode: PRIVATE_DIR_MODE });
  const mcpConfigPath = join(config.stateDir, "mcp.json");
  const mcpConfig = buildMcpConfig(config, { node: process.execPath, entry: runtime.entry });
  await writeFile(mcpConfigPath, JSON.stringify(mcpConfig, null, 2), { mode: PRIVATE_FILE_MODE });
  await chmod(mcpConfigPath, PRIVATE_FILE_MODE);

  const run = spawnRunner;
  const approvals = createApprovalStore({ dir: join(config.stateDir, "approvals") });
  const audit = createAuditLog({ path: join(config.stateDir, "audit.log") });
  const agent = createAgent({
    bin: config.agentBin,
    run,
    mcpConfigPath,
    systemPrompt: buildPersona(config.petName),
    cwd: agentCwd,
  });
  const core = createHubCore({ agent, approvals, audit, vaultRoot: config.vaultRoot, petName: config.petName });
  const server = createHubServer({
    core,
    token,
    uiDir: runtime.uiDir,
    host: config.hubHost,
    port: config.hubPort,
  });
  const port = await server.listen();
  process.stderr.write(`[pet-hub] token em ${tokenPath(config.configDir)}\n`);
  return `http://${config.hubHost.includes(":") ? `[${config.hubHost}]` : config.hubHost}:${port}`;
}
