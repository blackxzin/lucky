import type { Config } from "../config.js";

export interface McpConfig {
  mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }>;
}

/** Config MCP entregue ao agente: o mesmo pet-brain, com as mesmas pastas do hub. */
export function buildMcpConfig(config: Config, runtime: { node: string; entry: string }): McpConfig {
  return {
    mcpServers: {
      "pet-brain": {
        command: runtime.node,
        args: [runtime.entry],
        env: {
          PET_VAULT_DIR: config.vaultRoot,
          PET_STATE_DIR: config.stateDir,
          MAESTRI_CLI: config.maestriBin,
          OPENCODE_BIN: config.opencodeBin,
        },
      },
    },
  };
}
