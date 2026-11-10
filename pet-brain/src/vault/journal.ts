import { splitFrontmatter, VaultError } from "./paths.js";
import { readNote } from "./read.js";
import { writeNote } from "./vault.js";

const JOURNAL_FOLDER = "journal";

const pad = (value: number): string => String(value).padStart(2, "0");

/** Dia e hora locais: o diário segue o dia de quem usa o pet, não UTC. */
function localStamp(date: Date): { day: string; time: string } {
  return {
    day: `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
    time: `${pad(date.getHours())}:${pad(date.getMinutes())}`,
  };
}

async function existingBody(vaultRoot: string, path: string): Promise<string | undefined> {
  try {
    const note = await readNote({ vaultRoot, path });
    if (note.truncated) throw new VaultError(`O diário de hoje está grande demais para receber mais entradas: ${path}`);
    return splitFrontmatter(note.content).body.trim();
  } catch (error: unknown) {
    if (error instanceof VaultError && error.kind === "not_found") return undefined;
    throw error;
  }
}

/** Acrescenta uma linha ao diário do dia (`journal/AAAA-MM-DD.md`). Memória bruta, antes de consolidar. */
export async function appendJournal(input: {
  vaultRoot: string;
  text: string;
  now?: () => Date;
}): Promise<{ path: string }> {
  const { vaultRoot, now = () => new Date() } = input;
  const date = now();
  const { day, time } = localStamp(date);
  const path = `${JOURNAL_FOLDER}/${day}.md`;

  const body = (await existingBody(vaultRoot, path)) ?? `# Diário ${day}\n`;
  const entry = `- ${time} ${input.text.replace(/\s+/g, " ").trim()}`;
  const result = await writeNote({ vaultRoot, path, content: `${body}\n${entry}`, now: () => date });
  return { path: result.path };
}
