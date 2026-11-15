import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { UserFacingError } from "../errors.js";
import { findSecret } from "../vault/secrets.js";

const ID_PATTERN = /^[a-f0-9]{16}$/;
const ID_BYTES = 8;
const MAX_NAME_CHARS = 60;
const MAX_HABITS = 20;
const MIN_EVERY_MINUTES = 5;
const MAX_EVERY_MINUTES = 24 * 60;
const MS_PER_MINUTE = 60_000;
const RECORD_SUFFIX = ".json";
const PRIVATE_FILE_MODE = 0o600;
const PRIVATE_DIR_MODE = 0o700;
/** Entre estas horas o pet não cutuca: o horário só avança para a próxima janela. */
const QUIET_FROM_HOUR = 23;
const QUIET_UNTIL_HOUR = 7;

export class HabitError extends UserFacingError {}

const storedSchema = z.object({
  id: z.string().regex(ID_PATTERN),
  name: z.string().min(1).max(MAX_NAME_CHARS),
  everyMinutes: z.number().int().min(MIN_EVERY_MINUTES).max(MAX_EVERY_MINUTES),
  nextAt: z.string().refine((value) => !Number.isNaN(Date.parse(value))),
  /** Dia (local, AAAA-MM-DD) a que `doneCount` se refere. */
  doneDate: z.string(),
  doneCount: z.number().int().min(0),
});
type Stored = z.infer<typeof storedSchema>;

export interface Habit {
  id: string;
  name: string;
  everyMinutes: number;
  nextAt: string;
  doneToday: number;
}

export interface HabitStore {
  add(input: { name: string; everyMinutes: number }): Promise<Habit>;
  list(): Promise<Habit[]>;
  /** Marca como feito hoje e adia a próxima cutucada. `false` se o hábito não existe. */
  done(id: string): Promise<boolean>;
  remove(id: string): Promise<boolean>;
  /** Hábitos cuja hora chegou (fora do horário de silêncio). Cada um é reagendado ao ser entregue. */
  takeDue(): Promise<Habit[]>;
}

const pad = (value: number): string => String(value).padStart(2, "0");
const dayKey = (date: Date): string => `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
const isQuiet = (date: Date): boolean => date.getHours() >= QUIET_FROM_HOUR || date.getHours() < QUIET_UNTIL_HOUR;

export function createHabitStore(options: { dir: string; now?: () => Date }): HabitStore {
  const { dir, now = () => new Date() } = options;
  const pathOf = (id: string): string => join(dir, `${id}${RECORD_SUFFIX}`);

  const toHabit = (stored: Stored): Habit => ({
    id: stored.id,
    name: stored.name,
    everyMinutes: stored.everyMinutes,
    nextAt: stored.nextAt,
    doneToday: stored.doneDate === dayKey(now()) ? stored.doneCount : 0,
  });

  const read = async (path: string): Promise<Stored | undefined> => {
    try {
      return storedSchema.parse(JSON.parse(await readFile(path, "utf8")));
    } catch (error: unknown) {
      if (error instanceof SyntaxError || error instanceof z.ZodError || (error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  };

  const readAll = async (): Promise<Stored[]> => {
    const names = await readdir(dir).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    const found = await Promise.all(names.filter((name) => name.endsWith(RECORD_SUFFIX)).map((name) => read(join(dir, name))));
    return found.flatMap((item) => (item === undefined ? [] : [item])).sort((a, b) => a.name.localeCompare(b.name));
  };

  const write = async (stored: Stored): Promise<void> => {
    await mkdir(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
    const temp = `${pathOf(stored.id)}.tmp`;
    await writeFile(temp, JSON.stringify(stored), { mode: PRIVATE_FILE_MODE });
    await rename(temp, pathOf(stored.id));
  };

  const later = (everyMinutes: number): string => new Date(now().getTime() + everyMinutes * MS_PER_MINUTE).toISOString();

  return {
    add: async ({ name, everyMinutes }) => {
      const clean = name.replace(/\s+/g, " ").trim();
      if (clean === "" || clean.length > MAX_NAME_CHARS) throw new HabitError(`O nome do hábito precisa ter de 1 a ${String(MAX_NAME_CHARS)} caracteres.`);
      if (!Number.isInteger(everyMinutes) || everyMinutes < MIN_EVERY_MINUTES || everyMinutes > MAX_EVERY_MINUTES) {
        throw new HabitError(`O intervalo precisa ficar entre ${String(MIN_EVERY_MINUTES)} minutos e 24 horas.`);
      }
      const secret = findSecret(clean);
      if (secret !== undefined) throw new HabitError(`O hábito parece conter um segredo (${secret}). Não vou guardar.`);
      if ((await readAll()).length >= MAX_HABITS) throw new HabitError(`Já são ${String(MAX_HABITS)} hábitos. Apague algum antes.`);

      const stored: Stored = {
        id: randomBytes(ID_BYTES).toString("hex"),
        name: clean,
        everyMinutes,
        nextAt: later(everyMinutes),
        doneDate: dayKey(now()),
        doneCount: 0,
      };
      await write(stored);
      return toHabit(stored);
    },

    list: async () => (await readAll()).map(toHabit),

    done: async (id) => {
      if (!ID_PATTERN.test(id)) throw new HabitError("Id de hábito inválido.");
      const stored = await read(pathOf(id));
      if (stored === undefined) return false;
      const today = dayKey(now());
      await write({ ...stored, doneDate: today, doneCount: (stored.doneDate === today ? stored.doneCount : 0) + 1, nextAt: later(stored.everyMinutes) });
      return true;
    },

    remove: async (id) => {
      if (!ID_PATTERN.test(id)) throw new HabitError("Id de hábito inválido.");
      return rm(pathOf(id)).then(
        () => true,
        (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return false;
          throw error;
        },
      );
    },

    takeDue: async () => {
      const current = now();
      const due = (await readAll()).filter((stored) => Date.parse(stored.nextAt) <= current.getTime());
      const delivered: Habit[] = [];
      for (const stored of due) {
        await write({ ...stored, nextAt: later(stored.everyMinutes) });
        if (!isQuiet(current)) delivered.push(toHabit(stored));
      }
      return delivered;
    },
  };
}
