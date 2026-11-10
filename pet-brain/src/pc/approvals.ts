import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { UserFacingError } from "../errors.js";

const ID_PATTERN = /^[a-f0-9]{16}$/;
const ID_BYTES = 8;
const DEFAULT_TTL_MS = 10 * 60 * 1000;
const PRUNE_AFTER_MS = 24 * 60 * 60 * 1000;
const PRIVATE_FILE_MODE = 0o600;
const PRIVATE_DIR_MODE = 0o700;
const RECORD_SUFFIX = ".json";

export class ApprovalError extends UserFacingError {}

const storedSchema = z.object({
  id: z.string().regex(ID_PATTERN),
  tool: z.string(),
  action: z.string(),
  risk: z.enum(["confirm", "danger"]),
  reason: z.string(),
  status: z.enum(["pending", "approved", "denied", "used"]),
  createdAt: z.string(),
  expiresAt: z.string(),
});

type Stored = z.infer<typeof storedSchema>;
export type ApprovalStatus = Stored["status"] | "expired";
export type Approval = Omit<Stored, "status"> & { status: ApprovalStatus };

export interface ApprovalRequest {
  tool: string;
  action: string;
  risk: "confirm" | "danger";
  reason: string;
}

export interface ApprovalStore {
  request(input: ApprovalRequest): Promise<Approval>;
  get(id: string): Promise<Approval | undefined>;
  /** Pedidos pendentes e ainda válidos, do mais antigo ao mais novo. */
  list(): Promise<Approval[]>;
  decide(id: string, approved: boolean): Promise<Approval>;
  /** Gasta uma aprovação. Só passa se foi aprovada, não venceu e cobre exatamente esta ação. */
  consume(id: string, tool: string, action: string): Promise<void>;
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

export function createApprovalStore(options: { dir: string; ttlMs?: number; now?: () => Date }): ApprovalStore {
  const { dir, ttlMs = DEFAULT_TTL_MS, now = () => new Date() } = options;
  const recordPath = (id: string): string => join(dir, `${id}${RECORD_SUFFIX}`);

  const view = (stored: Stored): Approval => {
    const isLive = stored.status === "pending" || stored.status === "approved";
    return isLive && now().getTime() > Date.parse(stored.expiresAt) ? { ...stored, status: "expired" } : stored;
  };

  const save = async (stored: Stored, path = recordPath(stored.id)): Promise<void> => {
    await mkdir(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
    const temporary = join(dir, `.${stored.id}.${randomBytes(4).toString("hex")}.tmp`);
    await writeFile(temporary, JSON.stringify(stored), { encoding: "utf8", mode: PRIVATE_FILE_MODE, flag: "wx" });
    await rename(temporary, path);
  };

  const load = async (path: string): Promise<Stored | undefined> => {
    try {
      const parsed = storedSchema.safeParse(JSON.parse(await readFile(path, "utf8")));
      return parsed.success ? parsed.data : undefined;
    } catch (error: unknown) {
      if (isMissing(error) || error instanceof SyntaxError) return undefined;
      throw error;
    }
  };

  const get = async (id: string): Promise<Approval | undefined> => {
    if (!ID_PATTERN.test(id)) return undefined;
    const stored = await load(recordPath(id));
    return stored === undefined ? undefined : view(stored);
  };

  const all = async (): Promise<Approval[]> => {
    try {
      const names = (await readdir(dir)).filter((name) => ID_PATTERN.test(name.slice(0, -RECORD_SUFFIX.length)) && name.endsWith(RECORD_SUFFIX));
      const loaded = await Promise.all(names.map((name) => load(join(dir, name))));
      return loaded.filter((stored): stored is Stored => stored !== undefined).map(view);
    } catch (error: unknown) {
      if (isMissing(error)) return [];
      throw error;
    }
  };

  const prune = async (): Promise<void> => {
    const cutoff = now().getTime() - PRUNE_AFTER_MS;
    const stale = (await all()).filter((approval) => Date.parse(approval.expiresAt) < cutoff);
    await Promise.all(stale.map((approval) => rm(recordPath(approval.id), { force: true })));
  };

  const mustGet = async (id: string): Promise<Approval> => {
    const approval = await get(id);
    if (approval === undefined) throw new ApprovalError("Aprovação não encontrada. Confira o id.");
    return approval;
  };

  return {
    get,

    list: async () =>
      (await all())
        .filter((approval) => approval.status === "pending")
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),

    request: async (input) => {
      await prune();
      const created = now();
      const stored: Stored = {
        ...input,
        id: randomBytes(ID_BYTES).toString("hex"),
        status: "pending",
        createdAt: created.toISOString(),
        expiresAt: new Date(created.getTime() + ttlMs).toISOString(),
      };
      await save(stored);
      return stored;
    },

    decide: async (id, approved) => {
      const approval = await mustGet(id);
      if (approval.status !== "pending") {
        throw new ApprovalError(`Esse pedido não está mais pendente (estado: ${approval.status}).`);
      }
      const decided: Stored = { ...approval, status: approved ? "approved" : "denied" };
      await save(decided);
      return decided;
    },

    consume: async (id, tool, action) => {
      const approval = await mustGet(id);
      if (approval.status !== "approved") {
        throw new ApprovalError(`A aprovação ${id} não pode ser usada (estado: ${approval.status}).`);
      }
      if (approval.tool !== tool || approval.action !== action) {
        throw new ApprovalError(`A aprovação ${id} foi dada para outra ação. Ela vale só para a ação exata que foi mostrada ao dono.`);
      }

      // O rename é atômico: de vários consumidores simultâneos, só um consegue reivindicar o registro.
      const claim = join(dir, `.${id}.claim`);
      try {
        await rename(recordPath(id), claim);
      } catch (error: unknown) {
        if (isMissing(error)) throw new ApprovalError(`A aprovação ${id} já foi usada.`);
        throw error;
      }
      const claimed = await load(claim);
      if (claimed?.status !== "approved") {
        await rename(claim, recordPath(id));
        throw new ApprovalError(`A aprovação ${id} já foi usada.`);
      }
      await save({ ...claimed, status: "used" });
      await rm(claim, { force: true });
    },
  };
}
