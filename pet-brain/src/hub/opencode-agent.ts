import type { Config } from "../config.js";
import { ProcError, type ProcessRunner } from "../proc/run.js";
import { AgentError, type Agent } from "./agent.js";

const AGENT_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_ERROR_DETAIL_CHARS = 500;
const PET_AGENT = "pet";
const MCP_SERVER_NAME = "pet-brain";
const ANSI_PATTERN = /\u001b\[[0-9;]*[A-Za-z]/g;
/** Não deixa o OpenCode importar CLAUDE.md nem skills do ~/.claude do dono. */
const ISOLATION_ENV = { OPENCODE_DISABLE_CLAUDE_CODE: "1", OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: "1" };
/** Ferramentas próprias do OpenCode. Desligadas: o pet só age pelo MCP, que tem as travas. */
const BUILT_IN_TOOLS = [
  "bash", "edit", "multiedit", "write", "read", "grep", "glob", "list", "webfetch", "websearch", "codesearch",
  "patch", "todowrite", "todoread", "task", "skill", "lsp", "question",
];

export interface OpenCodeAgentOptions {
  bin: string;
  run: ProcessRunner;
  model: string;
  cwd: string;
  /** Pasta XDG_CONFIG_HOME vazia: o OpenCode não carrega MCPs nem plugins globais do dono. */
  configHome: string;
}

export interface OpenCodeConfig {
  $schema: string;
  mcp: Record<string, { type: "local"; command: string[]; environment: Record<string, string>; enabled: boolean }>;
  tools: Record<string, boolean>;
  permission: Record<string, "deny">;
  agent: Record<string, { description: string; mode: "primary"; prompt: string }>;
}

/** Config do OpenCode para o pet: só o MCP pet-brain, sem ferramentas próprias, com a persona. */
export function buildOpenCodeConfig(
  config: Pick<Config, "vaultRoot" | "stateDir" | "maestriBin" | "opencodeBin">,
  runtime: { node: string; entry: string },
  persona: string,
): OpenCodeConfig {
  return {
    $schema: "https://opencode.ai/config.json",
    mcp: {
      [MCP_SERVER_NAME]: {
        type: "local",
        command: [runtime.node, runtime.entry],
        environment: {
          PET_VAULT_DIR: config.vaultRoot,
          PET_STATE_DIR: config.stateDir,
          MAESTRI_CLI: config.maestriBin,
          OPENCODE_BIN: config.opencodeBin,
        },
        enabled: true,
      },
    },
    tools: Object.fromEntries(BUILT_IN_TOOLS.map((tool) => [tool, false])),
    permission: { bash: "deny", edit: "deny", webfetch: "deny" },
    agent: { [PET_AGENT]: { description: "Pet assistente do dono", mode: "primary", prompt: persona } },
  };
}

/** Cérebro reserva do pet: o OpenCode em modo headless, sem histórico entre mensagens. */
export function createOpenCodeAgent(options: OpenCodeAgentOptions): Agent {
  return {
    send: async (prompt) => {
      // Começa com texto fixo: assim a mensagem nunca é lida como flag, mesmo se começar com "-".
      const message = `Mensagem do dono:\n${prompt}`;
      const args = ["run", "--standalone", "--agent", PET_AGENT, "--model", options.model, message];

      const result = await options
        .run(options.bin, args, { timeoutMs: AGENT_TIMEOUT_MS, cwd: options.cwd, env: { ...ISOLATION_ENV, XDG_CONFIG_HOME: options.configHome } })
        .catch((error: unknown) => {
          if (error instanceof ProcError) {
            throw new AgentError(`CLI do OpenCode não encontrada ("${options.bin}"). Instale o OpenCode ou defina OPENCODE_BIN.`);
          }
          throw error;
        });

      if (result.timedOut) throw new AgentError("O OpenCode demorou demais e foi interrompido.");
      if (result.exitCode !== 0) {
        // Só o stderr: o stdout pode trazer texto do modelo (e do cofre), e esta mensagem vai para o chat de todos os clientes.
        const detail = (result.stderr.trim() || "sem detalhes").slice(0, MAX_ERROR_DETAIL_CHARS);
        throw new AgentError(`O OpenCode falhou: ${detail}`);
      }
      const text = result.stdout.replace(ANSI_PATTERN, "").trim();
      return { text: text === "" ? "(sem resposta)" : text, sessionId: undefined };
    },
  };
}
