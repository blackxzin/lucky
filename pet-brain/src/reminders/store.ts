import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { UserFacingError } from "../errors.js";
import { findSecret } from "../vault/secrets.js";

const ID_PATTERN = /^[a-f0-9]{16}$/;
const ID_BYTES = 8;
const MAX_TEXT_CHARS = 200;
const MAX_PENDING = 100;
const MAX_AHEAD_MS = 365 * 24 * 60 * 60 * 1000;
const RECORD_SUFFIX = ".json";
const TAKEN_SUFFIX = ".taken";
const PRIVATE_FILE_MODE = 0o600;
const PRIVATE_DIR_MODE = 0o700;

export class ReminderError extends UserFacingError {}

const storedSchema = z.object({
  id: z.string().regex(ID_PATTERN),
  text: z.string().min(1).max(MAX_TEXT_CHARS),
  dueAt: z.string().refine((value) => !Number.isNaN(Date.parse(value))),
});

export type Reminder = z.infer<typeof storedSchema>;

export interface ReminderStore {
  add(input: { text: string; dueAt: Date }): Promise<Reminder>;
  /** Lembretes que ainda não venceram, do mais próximo ao mais distante. */
  list(): Promise<Reminder[]>;
  /** Entrega cada lembrete vencido uma única vez, mesmo com dois processos olhando a pasta. */
  takeDue(): Promise<Reminder[]>;
  /** Cancela um lembrete pendente. `false` se ele não existe (já venceu ou foi cancelado). */
  remove(id: string): Promise<boolean>;
}

async function readReminder(path: string): Promise<Reminder | undefined> {
  try {
    return storedSchema.parse(JSON.parse(await readFile(path, "utf8")));
  } catch (error: unknown) {
    // Arquivo estranho ou que sumiu (outro processo o levou): ignora em vez de travar todos os lembretes.
    // Qualquer outro erro (permissão, disco) sobe: engolir faria o lembrete nunca disparar, sem aviso.
    if (error instanceof SyntaxError || error instanceof z.ZodError || (error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export function createReminderStore(options: { dir: string; now?: () => Date }): ReminderStore {
  const { dir, now = () => new Date() } = options;

  const readAll = async (): Promise<Array<{ reminder: Reminder; path: string }>> => {
    const names = await readdir(dir).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    const entries = await Promise.all(
      names
        .filter((name) => name.endsWith(RECORD_SUFFIX))
        .map(async (name) => {
          const path = join(dir, name);
          const reminder = await readReminder(path);
          return reminder === undefined ? [] : [{ reminder, path }];
        }),
    );
    return entries.flat().sort((a, b) => Date.parse(a.reminder.dueAt) - Date.parse(b.reminder.dueAt));
  };

  return {
    add: async ({ text, dueAt }) => {
      const clean = text.replace(/\s+/g, " ").trim();
      if (clean === "" || clean.length > MAX_TEXT_CHARS) {
        throw new ReminderError(`O texto do lembrete precisa ter de 1 a ${MAX_TEXT_CHARS} caracteres.`);
      }
      const secret = findSecret(clean);
      if (secret !== undefined) throw new ReminderError(`O lembrete parece conter um segredo (${secret}). Não vou guardar.`);
      const delta = dueAt.getTime() - now().getTime();
      if (Number.isNaN(delta) || delta <= 0) throw new ReminderError("O horário do lembrete precisa estar no futuro.");
      if (delta > MAX_AHEAD_MS) throw new ReminderError("O lembrete pode ser no máximo daqui a 1 ano.");
      if ((await readAll()).length >= MAX_PENDING) throw new ReminderError(`Já são ${MAX_PENDING} lembretes pendentes. Espere alguns vencerem.`);

      const reminder: Reminder = { id: randomBytes(ID_BYTES).toString("hex"), text: clean, dueAt: dueAt.toISOString() };
      await mkdir(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
      const path = join(dir, `${reminder.id}${RECORD_SUFFIX}`);
      const temp = `${path}.tmp`;
      await writeFile(temp, JSON.stringify(reminder), { mode: PRIVATE_FILE_MODE });
      await rename(temp, path);
      return reminder;
    },

    list: async () => (await readAll()).map((entry) => entry.reminder),

    remove: async (id) => {
      if (!ID_PATTERN.test(id)) throw new ReminderError("Id de lembrete inválido.");
      return rm(join(dir, `${id}${RECORD_SUFFIX}`)).then(
        () => true,
        (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return false;
          throw error;
        },
      );
    },

    takeDue: async () => {
      const limit = now().getTime();
      const due = (await readAll()).filter((entry) => Date.parse(entry.reminder.dueAt) <= limit);
      const taken = await Promise.all(
        due.map(async ({ reminder, path }) => {
          // rename é atômico: só um processo ganha o lembrete. ENOENT = outro processo ganhou.
          const claimed = await rename(path, `${path}${TAKEN_SUFFIX}`).then(
            () => true,
            (error: NodeJS.ErrnoException) => {
              if (error.code === "ENOENT") return false;
              throw error;
            },
          );
          // Limpeza é só arrumação: se falhar, o lembrete já foi reivindicado e precisa ser entregue.
          if (claimed) await rm(`${path}${TAKEN_SUFFIX}`, { force: true }).catch(() => undefined);
          return claimed ? [reminder] : [];
        }),
      );
      return taken.flat();
    },
  };
}
