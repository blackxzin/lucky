import { UserFacingError } from "../errors.js";
import type { Approval, ApprovalStore } from "../pc/approvals.js";
import type { AuditLog } from "../pc/audit.js";
import { vaultStats, type VaultStats } from "../vault/read.js";
import type { Agent } from "./agent.js";

const MAX_HISTORY = 50;
/** Um rodando mais os que esperam. Acima disso o hub recusa em vez de acumular. */
const MAX_PENDING_JOBS = 5;
const NEW_SESSION_COMMAND = "/novo";
const CONSOLIDATE_COMMAND = "/consolidar";
const CONSOLIDATE_PROMPT =
  "Consolide a memória: liste as notas de journal/ com vault_list, leia as mais recentes e transforme o que for " +
  "fato durável em notas próprias (vault_write) com links entre elas. No fim, diga em uma frase o que aprendeu.";

export type Role = "user" | "pet" | "system";

export interface ChatMessage {
  role: Role;
  text: string;
  ts: string;
}

export type PendingApproval = Pick<Approval, "id" | "tool" | "action" | "risk" | "reason" | "expiresAt">;

export interface HubState {
  name: string;
  busy: boolean;
  stats: VaultStats;
  approvals: PendingApproval[];
}

export type HubEvent = { type: "message"; message: ChatMessage } | { type: "state"; state: HubState };

export interface HubSnapshot {
  state: HubState;
  history: ChatMessage[];
}

export interface HubCore {
  chat(text: string): Promise<void>;
  decide(id: string, approved: boolean): Promise<void>;
  /** Relê as aprovações pendentes e avisa os clientes se algo mudou. */
  refresh(): Promise<void>;
  snapshot(): Promise<HubSnapshot>;
  subscribe(listener: (event: HubEvent) => void): () => void;
}

export interface HubCoreOptions {
  agent: Agent;
  approvals: ApprovalStore;
  audit: AuditLog;
  vaultRoot: string;
  petName: string;
  now?: () => Date;
}

function toPending(approval: Approval): PendingApproval {
  const { id, tool, action, risk, reason, expiresAt } = approval;
  return { id, tool, action, risk, reason, expiresAt };
}

export function createHubCore(options: HubCoreOptions): HubCore {
  const { agent, approvals, audit, vaultRoot, petName, now = () => new Date() } = options;

  let listeners: ReadonlyArray<(event: HubEvent) => void> = [];
  let history: readonly ChatMessage[] = [];
  let sessionId: string | undefined;
  let pendingJobs = 0;
  let running = false;
  let tail: Promise<void> = Promise.resolve();
  let lastApprovalKey = "";

  const emit = (event: HubEvent): void => listeners.forEach((listener) => listener(event));

  const say = (role: Role, text: string): void => {
    const message: ChatMessage = { role, text, ts: now().toISOString() };
    history = [...history, message].slice(-MAX_HISTORY);
    emit({ type: "message", message });
  };

  const readState = async (): Promise<HubState> => {
    const [stats, pending] = await Promise.all([vaultStats(vaultRoot), approvals.list()]);
    return { name: petName, busy: running, stats, approvals: pending.map(toPending) };
  };

  const emitState = async (): Promise<void> => {
    const state = await readState();
    lastApprovalKey = state.approvals.map((approval) => approval.id).join(",");
    emit({ type: "state", state });
  };

  const describe = (error: unknown): string => {
    if (error instanceof UserFacingError) return error.message;
    process.stderr.write(`[pet-hub] erro inesperado: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    return "Erro interno no hub. Veja o terminal onde ele está rodando.";
  };

  const askAgent = async (prompt: string): Promise<void> => {
    running = true;
    try {
      await emitState();
      const reply = await agent.send(prompt, sessionId);
      sessionId = reply.sessionId ?? sessionId;
      say("pet", reply.text);
    } catch (error: unknown) {
      say("system", describe(error));
    } finally {
      running = false;
      await emitState().catch((error: unknown) => void describe(error));
    }
  };

  /** Fila de um só: duas mensagens nunca rodam o agente ao mesmo tempo na mesma sessão. */
  const enqueue = (prompt: string): Promise<void> => {
    pendingJobs += 1;
    const job = tail.then(() => askAgent(prompt)).finally(() => {
      pendingJobs -= 1;
    });
    tail = job;
    return job;
  };

  return {
    subscribe: (listener) => {
      listeners = [...listeners, listener];
      return () => {
        listeners = listeners.filter((current) => current !== listener);
      };
    },

    snapshot: async () => ({ state: await readState(), history: [...history] }),

    refresh: async () => {
      const key = (await approvals.list()).map((approval) => approval.id).join(",");
      if (key !== lastApprovalKey) await emitState();
    },

    chat: async (text) => {
      const trimmed = text.trim();
      if (trimmed === "") return;

      if (trimmed === NEW_SESSION_COMMAND) {
        sessionId = undefined;
        say("system", "Conversa nova. A memória do cofre continua.");
        return;
      }
      if (pendingJobs >= MAX_PENDING_JOBS) {
        say("system", "Muita coisa na fila. Espera eu terminar o que já pediu.");
        return;
      }

      say("user", trimmed);
      await enqueue(trimmed === CONSOLIDATE_COMMAND ? CONSOLIDATE_PROMPT : trimmed);
    },

    decide: async (id, approved) => {
      try {
        const decided = await approvals.decide(id, approved);
        await audit.record({ tool: decided.tool, action: decided.action, decision: approved ? "granted" : "denied", approvalId: id });
      } catch (error: unknown) {
        say("system", describe(error));
        return;
      }

      say("system", approved ? `Pedido ${id} aprovado.` : `Pedido ${id} negado.`);
      await emitState();
      if (sessionId === undefined) return;

      await enqueue(
        approved
          ? `O dono aprovou o pedido ${id}. Execute de novo a mesma chamada, com os mesmos argumentos e approvalId "${id}".`
          : `O dono negou o pedido ${id}. Não tente de novo nem procure outro jeito de fazer a mesma coisa.`,
      );
    },
  };
}
