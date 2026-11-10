import { appendFile, chmod, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

const MAX_ACTION_CHARS = 2000;
const PRIVATE_FILE_MODE = 0o600;
const PRIVATE_DIR_MODE = 0o700;

export type AuditDecision = "auto" | "requested" | "approved" | "sent" | "granted" | "denied";

export interface AuditEntry {
  tool: string;
  action: string;
  decision: AuditDecision;
  approvalId?: string;
}

export interface AuditLog {
  record(entry: AuditEntry): Promise<void>;
}

/** Log JSONL fora do cofre. Se não der pra gravar, o erro sobe e a ação não roda (falha fechada). */
export function createAuditLog(options: { path: string; now?: () => Date }): AuditLog {
  const { path, now = () => new Date() } = options;

  return {
    record: async (entry) => {
      const line = JSON.stringify({ ts: now().toISOString(), ...entry, action: entry.action.slice(0, MAX_ACTION_CHARS) });
      await mkdir(dirname(path), { recursive: true, mode: PRIVATE_DIR_MODE });
      await appendFile(path, `${line}\n`, { encoding: "utf8", mode: PRIVATE_FILE_MODE });
      await chmod(path, PRIVATE_FILE_MODE);
    },
  };
}
