import { appendFile, chmod, mkdir, open, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";

const MAX_ACTION_CHARS = 2000;
const PRIVATE_FILE_MODE = 0o600;
const PRIVATE_DIR_MODE = 0o700;
/** `recent` lê só o fim do arquivo: o log só cresce e /status não pode reler tudo a cada chamada. */
const TAIL_BYTES = 256 * 1024;

export type AuditDecision = "auto" | "requested" | "approved" | "sent" | "granted" | "denied";

export interface AuditEntry {
  tool: string;
  action: string;
  decision: AuditDecision;
  approvalId?: string;
}

export type AuditRecord = AuditEntry & { ts: string };

export interface AuditLog {
  record(entry: AuditEntry): Promise<void>;
  /** Últimas entradas, da mais antiga à mais nova. Arquivo ausente vale como log vazio. */
  recent(limit: number): Promise<AuditRecord[]>;
  /** Entradas com `from <= ts < to`, da mais antiga à mais nova. Lê o arquivo todo: para uso raro (resumo diário). */
  between(from: Date, to: Date): Promise<AuditRecord[]>;
}

const recordSchema = z.object({
  ts: z.string().refine((value) => !Number.isNaN(Date.parse(value))),
  tool: z.string(),
  decision: z.enum(["auto", "requested", "approved", "sent", "granted", "denied"]),
  action: z.string().optional(),
  approvalId: z.string().optional(),
});

/** Linha corrompida (disco cheio no meio da escrita, edição à mão) é pulada: um erro não pode esconder o resto do log. */
function parseRecord(line: string): AuditRecord[] {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return [];
  }
  const parsed = recordSchema.safeParse(raw);
  if (!parsed.success) return [];
  const { ts, tool, decision, action, approvalId } = parsed.data;
  return [{ ts, tool, decision, action: action ?? "", ...(approvalId === undefined ? {} : { approvalId }) }];
}

const isMissing = (error: unknown): boolean => (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";

async function readTail(path: string, maxBytes: number): Promise<string> {
  const handle = await open(path, "r").catch((error: unknown) => {
    if (isMissing(error)) return undefined;
    throw error;
  });
  if (handle === undefined) return "";
  try {
    const { size } = await handle.stat();
    const start = Math.max(0, size - maxBytes);
    const buffer = Buffer.alloc(size - start);
    await handle.read(buffer, 0, buffer.length, start);
    const text = buffer.toString("utf8");
    // Começou no meio de uma linha: descarta o pedaço inicial.
    return start === 0 ? text : text.slice(text.indexOf("\n") + 1);
  } finally {
    await handle.close();
  }
}

/** Log JSONL fora do cofre. Se não der pra gravar, o erro sobe e a ação não roda (falha fechada). */
export function createAuditLog(options: { path: string; now?: () => Date }): AuditLog {
  const { path, now = () => new Date() } = options;

  return {
    recent: async (limit) => (await readTail(path, TAIL_BYTES)).split("\n").filter((line) => line !== "").flatMap(parseRecord).slice(-limit),

    between: async (from, to) => {
      const text = await readFile(path, "utf8").catch((error: unknown) => {
        if (isMissing(error)) return "";
        throw error;
      });
      return text
        .split("\n")
        .filter((line) => line !== "")
        .flatMap(parseRecord)
        .filter((entry) => Date.parse(entry.ts) >= from.getTime() && Date.parse(entry.ts) < to.getTime());
    },

    record: async (entry) => {
      const line = JSON.stringify({ ts: now().toISOString(), ...entry, action: entry.action.slice(0, MAX_ACTION_CHARS) });
      await mkdir(dirname(path), { recursive: true, mode: PRIVATE_DIR_MODE });
      await appendFile(path, `${line}\n`, { encoding: "utf8", mode: PRIVATE_FILE_MODE });
      await chmod(path, PRIVATE_FILE_MODE);
    },
  };
}
