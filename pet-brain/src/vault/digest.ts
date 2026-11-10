import type { AuditLog } from "../pc/audit.js";
import { VaultError } from "./paths.js";
import { readNote } from "./read.js";
import { writeNote } from "./vault.js";

const pad = (value: number): string => String(value).padStart(2, "0");
const dayOf = (date: Date): string => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

/**
 * Resumo do dia anterior em `journal/AAAA-MM-DD-resumo.md`, só com contagens por ferramenta.
 * O texto das ações não vai pro cofre: comandos podem conter segredos.
 */
export async function maybeWriteDigest(input: { audit: AuditLog; vaultRoot: string; now?: () => Date }): Promise<boolean> {
  const { audit, vaultRoot, now = () => new Date() } = input;
  // Dia civil anterior, pelo calendário local: subtrair 24h erra nos dias de 23h/25h do horário de verão.
  const start = new Date(now());
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  start.setDate(start.getDate() - 1);
  const day = dayOf(start);
  const path = `journal/${day}-resumo.md`;

  const exists = await readNote({ vaultRoot, path }).then(
    () => true,
    (error: unknown) => {
      if (error instanceof VaultError && error.kind === "not_found") return false;
      throw error;
    },
  );
  if (exists) return false;

  const counts = new Map<string, number>();
  for (const entry of await audit.between(start, end)) {
    const key = `${entry.tool} (${entry.decision})`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  if (counts.size === 0) return false;

  const lines = [...counts].sort(([a], [b]) => a.localeCompare(b)).map(([key, total]) => `- ${key}: ${total}`);
  await writeNote({ vaultRoot, path, content: [`# Resumo ${day}`, "", "Ações do pet no dia (só contagens):", ...lines].join("\n"), links: [] });
  return true;
}
