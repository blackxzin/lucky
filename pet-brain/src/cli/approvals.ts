import { UserFacingError } from "../errors.js";
import type { Approval, ApprovalStore } from "../pc/approvals.js";
import type { AuditLog } from "../pc/audit.js";

const ID_PATTERN = /^[a-f0-9]{16}$/;
const CONFIRM_WORD = "sim";

export interface CliIo {
  /** stdin e stdout são um terminal de verdade. */
  isInteractive: boolean;
  ask(question: string): Promise<string>;
  write(line: string): void;
}

export interface ApprovalCliDeps {
  approvals: ApprovalStore;
  audit: Pick<AuditLog, "record">;
  io: CliIo;
}

function describe(approval: Approval): string {
  return [
    `Pedido ${approval.id} [${approval.risk === "danger" ? "PERIGOSO" : "confirmar"}]`,
    `  ferramenta: ${approval.tool}`,
    `  ação:       ${approval.action}`,
    `  motivo:     ${approval.reason}`,
    `  vence em:   ${approval.expiresAt}`,
  ].join("\n");
}

async function pending({ approvals, io }: ApprovalCliDeps): Promise<number> {
  const waiting = await approvals.list();
  if (waiting.length === 0) {
    io.write("Nenhum pedido esperando.");
    return 0;
  }
  waiting.forEach((approval) => io.write(describe(approval)));
  return 0;
}

async function decide(deps: ApprovalCliDeps, id: string | undefined, approved: boolean): Promise<number> {
  const { approvals, audit, io } = deps;
  if (id === undefined || !ID_PATTERN.test(id)) {
    io.write("Passe o id do pedido (16 caracteres). Veja com: pet-brain pending");
    return 1;
  }
  const approval = await approvals.get(id);
  if (approval === undefined || approval.status !== "pending") {
    io.write(`Pedido ${id} não está pendente (${approval?.status ?? "não existe"}).`);
    return 1;
  }

  if (approved) {
    // Aprovar exige um humano no teclado: um agente rodando com pipes não passa daqui.
    if (!io.isInteractive) {
      io.write("Aprovar só funciona num terminal interativo. Use a interface do pet ou rode num terminal.");
      return 1;
    }
    io.write(describe(approval));
    const answer = await io.ask(`Digite "${CONFIRM_WORD}" para aprovar: `);
    if (answer.trim().toLowerCase() !== CONFIRM_WORD) {
      io.write("Nada aprovado.");
      return 1;
    }
  }

  await approvals.decide(id, approved);
  await audit.record({
    tool: approval.tool,
    action: approval.action,
    decision: approved ? "granted" : "denied",
    approvalId: id,
  });
  io.write(`Pedido ${id} ${approved ? "aprovado" : "negado"}.`);
  return 0;
}

/** Devolve o código de saída do processo. */
export async function runApprovalCli(args: readonly string[], deps: ApprovalCliDeps): Promise<number> {
  const [command, id] = args;
  try {
    if (command === "pending") return await pending(deps);
    if (command === "approve") return await decide(deps, id, true);
    if (command === "deny") return await decide(deps, id, false);
    deps.io.write("Uso: pet-brain [hub | pending | approve <id> | deny <id>]");
    return 1;
  } catch (error: unknown) {
    deps.io.write(error instanceof UserFacingError ? error.message : "Erro inesperado ao tratar o pedido.");
    return 1;
  }
}
