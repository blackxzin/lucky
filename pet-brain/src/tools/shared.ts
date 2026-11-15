import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { UserFacingError } from "../errors.js";
import type { MaestriClient } from "../maestri/client.js";
import type { ApprovalStore } from "../pc/approvals.js";
import type { AuditLog } from "../pc/audit.js";
import type { HabitStore } from "../habits/store.js";
import type { ProcessRunner } from "../proc/run.js";
import type { ReminderStore } from "../reminders/store.js";

export interface ServerDeps {
  maestri: MaestriClient;
  vaultRoot: string;
  homeDir: string;
  run: ProcessRunner;
  approvals: ApprovalStore;
  audit: AuditLog;
  reminders: ReminderStore;
  habits: HabitStore;
  opencodeBin: string;
  /** Só para testes: troca o fetch usado pelas ferramentas de consulta. */
  fetch?: typeof fetch;
}

export type ToolRegistrar = (server: McpServer, deps: ServerDeps) => void;

export interface ToolResult {
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

/** Erro de uso de uma tool, com mensagem feita para o modelo ler. */
export class ToolError extends UserFacingError {}

const ok = (text: string): ToolResult => ({ content: [{ type: "text", text }] });

/** Erros viram resultado de tool (isError) em vez de derrubar o server. */
export async function guarded(action: () => Promise<string>): Promise<ToolResult> {
  try {
    return ok(await action());
  } catch (error: unknown) {
    if (error instanceof UserFacingError) return { ...ok(error.message), isError: true };
    // Erros inesperados (fs, etc.) podem conter caminhos da máquina: detalhe só no stderr.
    process.stderr.write(`pet-brain: erro inesperado: ${error instanceof Error ? error.stack : String(error)}\n`);
    return { ...ok("Erro interno no pet-brain. Veja o log (stderr) do server."), isError: true };
  }
}

export function truncate(text: string, maxChars: number): string {
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n… (cortado)` : text;
}
