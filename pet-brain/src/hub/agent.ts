import { z } from "zod";
import { UserFacingError } from "../errors.js";
import { ProcError, type ProcessRunner } from "../proc/run.js";

const AGENT_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_ERROR_DETAIL_CHARS = 500;
const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MCP_SERVER_NAME = "pet-brain";

export class AgentError extends UserFacingError {}

export interface AgentReply {
  text: string;
  sessionId: string | undefined;
  /** Quem respondeu, quando há mais de um agente. */
  via?: string | undefined;
}

export interface Agent {
  send(prompt: string, sessionId?: string): Promise<AgentReply>;
}

export interface AgentOptions {
  bin: string;
  run: ProcessRunner;
  mcpConfigPath: string;
  systemPrompt: string;
  /** Pasta neutra: o agente não herda CLAUDE.md nem configurações de projeto. */
  cwd: string;
}

const outputSchema = z.object({
  result: z.string().optional(),
  session_id: z.string().optional(),
  is_error: z.boolean().optional(),
});

function validSession(id: string | undefined): string | undefined {
  return id !== undefined && SESSION_ID_PATTERN.test(id) ? id : undefined;
}

function parseOutput(stdout: string): z.infer<typeof outputSchema> {
  try {
    return outputSchema.parse(JSON.parse(stdout));
  } catch {
    throw new AgentError("Não entendi a resposta do agente. Tente de novo.");
  }
}

/**
 * Cérebro do pet: o Claude Code em modo headless, sem ferramentas próprias, só com o MCP pet-brain.
 * Tudo que ele faz no PC passa pelas travas e pela auditoria do MCP.
 */
export function createAgent(options: AgentOptions): Agent {
  const baseArgs = [
    "-p",
    "--output-format",
    "json",
    "--tools",
    "",
    "--mcp-config",
    options.mcpConfigPath,
    "--strict-mcp-config",
    "--allowedTools",
    `mcp__${MCP_SERVER_NAME}`,
    "--setting-sources",
    "",
    "--system-prompt",
    options.systemPrompt,
  ];

  return {
    send: async (prompt, sessionId) => {
      const resume = validSession(sessionId);
      const args = resume === undefined ? baseArgs : [...baseArgs, "--resume", resume];

      const result = await options
        .run(options.bin, args, { timeoutMs: AGENT_TIMEOUT_MS, cwd: options.cwd, input: prompt })
        .catch((error: unknown) => {
          if (error instanceof ProcError) {
            throw new AgentError(`CLI do agente não encontrada ("${options.bin}"). Instale o Claude Code ou defina PET_AGENT_BIN.`);
          }
          throw error;
        });

      if (result.timedOut) throw new AgentError("O agente demorou demais e foi interrompido.");
      if (result.exitCode !== 0) {
        const detail = (result.stderr.trim() || result.stdout.trim() || "sem detalhes").slice(0, MAX_ERROR_DETAIL_CHARS);
        throw new AgentError(`O agente falhou: ${detail}`);
      }

      const output = parseOutput(result.stdout);
      const text = output.result?.trim() ?? "";
      if (output.is_error === true) throw new AgentError(`O agente falhou: ${text.slice(0, MAX_ERROR_DETAIL_CHARS)}`);
      return { text: text === "" ? "(sem resposta)" : text, sessionId: validSession(output.session_id) };
    },
  };
}
