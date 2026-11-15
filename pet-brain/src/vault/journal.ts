import { splitFrontmatter, VaultError } from "./paths.js";
import { readNote } from "./read.js";
import { findSecret } from "./secrets.js";
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

/** Acrescenta uma linha a uma nota (criando com `heading` se não existir). O resto do conteúdo fica como está. */
export async function appendNoteLine(input: {
  vaultRoot: string;
  path: string;
  heading: string;
  entry: string;
  now: () => Date;
}): Promise<{ path: string }> {
  const { vaultRoot, path, heading, entry, now } = input;
  const date = now();
  const body = (await existingBody(vaultRoot, path)) ?? heading;
  const result = await writeNote({ vaultRoot, path, content: `${body}\n${entry}`, now: () => date });
  return { path: result.path };
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
  return appendNoteLine({
    vaultRoot,
    path: `${JOURNAL_FOLDER}/${day}.md`,
    heading: `# Diário ${day}\n`,
    entry: `- ${time} ${input.text.replace(/\s+/g, " ").trim()}`,
    now: () => date,
  });
}

const INBOX_PATH = "inbox.md";
const MAX_CAPTURE_CHARS = 500;

/** Captura rápida: joga uma ideia no `inbox.md` do cérebro do pet, com dia e hora, sem passar pelo modelo. */
export async function appendInbox(input: { vaultRoot: string; text: string; now?: () => Date }): Promise<{ path: string }> {
  const { vaultRoot, now = () => new Date() } = input;
  const text = input.text.replace(/\s+/g, " ").trim().slice(0, MAX_CAPTURE_CHARS);
  if (text === "") throw new VaultError("Nada para anotar.");
  if (findSecret(text) !== undefined) throw new VaultError("Isso parece um segredo (senha ou chave). Não anotei.");
  const date = now();
  const { day, time } = localStamp(date);
  return appendNoteLine({ vaultRoot, path: INBOX_PATH, heading: "# Inbox\n", entry: `- ${day} ${time} ${text}`, now: () => date });
}
