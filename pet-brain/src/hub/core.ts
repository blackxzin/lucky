import { UserFacingError } from "../errors.js";
import type { Habit, HabitStore } from "../habits/store.js";
import type { Approval, ApprovalStore } from "../pc/approvals.js";
import type { AuditLog } from "../pc/audit.js";
import type { Reminder, ReminderStore } from "../reminders/store.js";
import { vaultStats, type VaultStats } from "../vault/read.js";
import type { Agent } from "./agent.js";
import type { Alerts } from "./alerts.js";

const MAX_HISTORY = 50;
/** Um rodando mais os que esperam. Acima disso o hub recusa em vez de acumular. */
const MAX_PENDING_JOBS = 5;
const NEW_SESSION_COMMAND = "/novo";
const CONSOLIDATE_COMMAND = "/consolidar";
const STATUS_COMMAND = "/status";
const STATUS_ACTIONS = 8;
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
  /** Agente que respondeu por último ("claude" ou "opencode"); null enquanto nenhum respondeu. */
  brain: string | null;
  /** Lembretes ainda não vencidos. */
  reminders: number;
}

export type HubEvent = { type: "message"; message: ChatMessage } | { type: "state"; state: HubState };

export interface HubSnapshot {
  state: HubState;
  history: ChatMessage[];
}

export interface HubCore {
  chat(text: string): Promise<void>;
  decide(id: string, approved: boolean): Promise<void>;
  /** Entrega lembretes vencidos no chat. Chamado de tempos em tempos pelo hub. */
  tick(): Promise<void>;
  /** Relê as aprovações pendentes e avisa os clientes se algo mudou. */
  refresh(): Promise<void>;
  snapshot(): Promise<HubSnapshot>;
  listReminders(): Promise<Reminder[]>;
  /** Agenda um lembrete daqui a `inMinutes`; todos os clientes recebem o estado novo. */
  addReminder(text: string, inMinutes: number): Promise<void>;
  cancelReminder(id: string): Promise<void>;
  listHabits(): Promise<Habit[]>;
  addHabit(name: string, everyMinutes: number): Promise<void>;
  doneHabit(id: string): Promise<void>;
  removeHabit(id: string): Promise<void>;
  subscribe(listener: (event: HubEvent) => void): () => void;
}

export interface HubCoreOptions {
  agent: Agent;
  approvals: ApprovalStore;
  audit: AuditLog;
  reminders: ReminderStore;
  habits: HabitStore;
  /** Avisos do próprio PC (disco, bateria, memória). Sem isso o pet só fala quando falam com ele. */
  alerts?: Alerts;
  vaultRoot: string;
  petName: string;
  now?: () => Date;
}

function toPending(approval: Approval): PendingApproval {
  const { id, tool, action, risk, reason, expiresAt } = approval;
  return { id, tool, action, risk, reason, expiresAt };
}

const MS_PER_MINUTE = 60_000;

export function createHubCore(options: HubCoreOptions): HubCore {
  const { agent, approvals, audit, reminders, habits, alerts, vaultRoot, petName, now = () => new Date() } = options;

  let listeners: ReadonlyArray<(event: HubEvent) => void> = [];
  let history: readonly ChatMessage[] = [];
  let sessionId: string | undefined;
  let pendingJobs = 0;
  let running = false;
  let tail: Promise<void> = Promise.resolve();
  let lastApprovalKey = "";
  let lastVia: string | undefined;

  const emit = (event: HubEvent): void => listeners.forEach((listener) => listener(event));

  const say = (role: Role, text: string): void => {
    const message: ChatMessage = { role, text, ts: now().toISOString() };
    history = [...history, message].slice(-MAX_HISTORY);
    emit({ type: "message", message });
  };

  const readState = async (): Promise<HubState> => {
    const [stats, pending, upcoming] = await Promise.all([vaultStats(vaultRoot), approvals.list(), reminders.list()]);
    return { name: petName, busy: running, stats, approvals: pending.map(toPending), brain: lastVia ?? null, reminders: upcoming.length };
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

  /** Quando o cérebro troca (Claude <-> OpenCode) o dono fica sabendo e a troca vai pro log. */
  const announceAgentSwitch = async (via: string | undefined): Promise<void> => {
    if (via === undefined || via === lastVia) return;
    const previous = lastVia;
    lastVia = via;
    if (previous === undefined && via === "claude") return;
    say(
      "system",
      via === "claude" ? "Claude voltou a responder." : "Claude indisponível; estou respondendo pelo OpenCode (sem o histórico longo).",
    );
    // A auditoria falha fechada, mas a troca já aconteceu e a resposta do pet não pode se perder por causa dela.
    await audit.record({ tool: "agent", action: `${previous ?? "inicio"} -> ${via}`, decision: "auto" }).catch((error: unknown) => void describe(error));
  };

  const askAgent = async (prompt: string): Promise<void> => {
    running = true;
    try {
      await emitState();
      const reply = await agent.send(prompt, sessionId);
      sessionId = reply.sessionId ?? sessionId;
      await announceAgentSwitch(reply.via);
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

  const pad = (value: number): string => String(value).padStart(2, "0");

  /** Resumo sem o texto das ações: comandos podem ter segredos e o histórico vai a todos os clientes. */
  const statusText = async (): Promise<string> => {
    const [pending, upcoming, recent] = await Promise.all([approvals.list(), reminders.list(), audit.recent(STATUS_ACTIONS)]);
    const actions = recent.map((entry) => {
      const at = new Date(entry.ts);
      return `- ${pad(at.getHours())}:${pad(at.getMinutes())} ${entry.tool} (${entry.decision})`;
    });
    return [
      `Status: ${running ? "pensando" : "livre"} · cérebro: ${lastVia ?? "ainda não usado"}`,
      `Aprovações pendentes: ${pending.length} · lembretes: ${upcoming.length}`,
      actions.length === 0 ? "Nenhuma ação registrada ainda." : `Últimas ações:\n${actions.join("\n")}`,
    ].join("\n");
  };

  return {
    tick: async () => {
      for (const reminder of await reminders.takeDue()) say("pet", `⏰ Lembrete: ${reminder.text}`);
      for (const habit of await habits.takeDue()) say("pet", `🌱 Hora do hábito: ${habit.name} (hoje: ${String(habit.doneToday)}x)`);
      for (const warning of (await alerts?.check()) ?? []) say("pet", `⚠️ ${warning}`);
    },

    subscribe: (listener) => {
      listeners = [...listeners, listener];
      return () => {
        listeners = listeners.filter((current) => current !== listener);
      };
    },

    snapshot: async () => ({ state: await readState(), history: [...history] }),

    listReminders: () => reminders.list(),

    addReminder: async (text, inMinutes) => {
      await reminders.add({ text, dueAt: new Date(now().getTime() + inMinutes * MS_PER_MINUTE) });
      await emitState();
    },

    cancelReminder: async (id) => {
      await reminders.remove(id);
      await emitState();
    },

    listHabits: () => habits.list(),

    addHabit: async (name, everyMinutes) => void (await habits.add({ name, everyMinutes })),

    doneHabit: async (id) => {
      if (!(await habits.done(id))) throw new UserFacingError("Esse hábito não existe mais.");
    },

    removeHabit: async (id) => void (await habits.remove(id)),

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
      if (trimmed === STATUS_COMMAND) {
        say("system", await statusText().catch(describe));
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
      // Sem nenhuma resposta ainda não há conversa a retomar. Só o OpenCode respondendo também conta: ele nunca devolve sessão.
      if (lastVia === undefined && sessionId === undefined) return;

      await enqueue(
        approved
          ? `O dono aprovou o pedido ${id}. Execute de novo a mesma chamada, com os mesmos argumentos e approvalId "${id}".`
          : `O dono negou o pedido ${id}. Não tente de novo nem procure outro jeito de fazer a mesma coisa.`,
      );
    },
  };
}
