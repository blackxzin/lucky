import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { findSecret } from "../vault/secrets.js";

const MIN_CHARS = 3;
const MAX_CHARS = 2000;
const MAX_ENTRIES = 200;
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_RESULTS = 20;
const PRIVATE_FILE_MODE = 0o600;
const PRIVATE_DIR_MODE = 0o700;

const fileSchema = z.object({ entries: z.array(z.object({ text: z.string(), at: z.string() })) });

export interface ClipboardEntry {
  text: string;
  at: string;
}

export interface ClipboardStore {
  /** Guarda o que foi copiado. `false` se foi ignorado (curto, longo demais, parece segredo ou repete o último). */
  add(text: string): Promise<boolean>;
  /** Mais recentes primeiro; todas as palavras da busca precisam aparecer. Sem busca, devolve os últimos. */
  search(query: string, limit?: number): Promise<ClipboardEntry[]>;
  /** Apaga tudo. Devolve quantas entradas existiam. */
  clear(): Promise<number>;
}

/**
 * Histórico do que foi copiado, só no disco do dono (arquivo 0600), por 7 dias e até 200 itens.
 * Segredos (chaves, tokens) e textos grandes nunca entram; quem decide se o histórico existe é o dono, ligando PET_CLIPBOARD.
 */
export function createClipboardStore(options: { path: string; now?: () => Date }): ClipboardStore {
  const { path, now = () => new Date() } = options;
  let queue: Promise<unknown> = Promise.resolve();

  const load = async (): Promise<ClipboardEntry[]> => {
    try {
      const cutoff = now().getTime() - MAX_AGE_MS;
      return fileSchema
        .parse(JSON.parse(await readFile(path, "utf8")))
        .entries.filter((entry) => Date.parse(entry.at) >= cutoff);
    } catch {
      return [];
    }
  };

  const save = async (entries: readonly ClipboardEntry[]): Promise<void> => {
    await mkdir(dirname(path), { recursive: true, mode: PRIVATE_DIR_MODE });
    const temporary = `${path}.${randomBytes(4).toString("hex")}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify({ entries }), { mode: PRIVATE_FILE_MODE, flag: "wx" });
      await rename(temporary, path);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  };

  /** Escritas em fila: duas cópias seguidas não se atropelam. */
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const next = queue.then(work, work);
    queue = next.catch(() => undefined);
    return next;
  };

  return {
    add: (raw) =>
      serial(async () => {
        const text = raw.trim();
        if (text.length < MIN_CHARS || text.length > MAX_CHARS || findSecret(text) !== undefined) return false;
        const entries = await load();
        if (entries.at(-1)?.text === text) return false;
        await save([...entries, { text, at: now().toISOString() }].slice(-MAX_ENTRIES));
        return true;
      }),

    search: async (query, limit = MAX_RESULTS) => {
      const words = query.toLowerCase().split(/\s+/).filter((word) => word !== "");
      const found = (await load()).filter((entry) => words.every((word) => entry.text.toLowerCase().includes(word)));
      return found.reverse().slice(0, Math.min(Math.max(1, limit), MAX_RESULTS));
    },

    clear: () =>
      serial(async () => {
        const count = (await load()).length;
        await save([]);
        return count;
      }),
  };
}
