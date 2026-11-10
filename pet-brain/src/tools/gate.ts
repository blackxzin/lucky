import type { Classification } from "../pc/policy.js";
import type { ServerDeps } from "./shared.js";

export interface GatedAction {
  tool: string;
  /** Texto exato mostrado ao dono. A aprovação vale só para ele. */
  action: string;
  classification: Classification;
  approvalId: string | undefined;
  execute: () => Promise<string>;
}

/**
 * Seguro roda direto. O resto só roda com uma aprovação dada pelo dono (hub ou CLI) para esta ação exata.
 * O modelo não tem como aprovar: nenhuma tool muda o estado de um pedido.
 */
export async function gated(deps: Pick<ServerDeps, "approvals" | "audit">, input: GatedAction): Promise<string> {
  const { tool, action, classification, approvalId, execute } = input;

  if (classification.risk === "safe") {
    await deps.audit.record({ tool, action, decision: "auto" });
    return execute();
  }

  if (approvalId !== undefined) {
    await deps.approvals.consume(approvalId, tool, action);
    await deps.audit.record({ tool, action, decision: "approved", approvalId });
    return execute();
  }

  const request = await deps.approvals.request({ tool, action, risk: classification.risk, reason: classification.reason });
  await deps.audit.record({ tool, action, decision: "requested", approvalId: request.id });
  return [
    `NÃO EXECUTADO. Precisa de aprovação do dono (${classification.reason}).`,
    `Pedido: ${request.id}`,
    "Avise o dono em uma frase o que você quer rodar e por quê. Ele aprova no app do pet.",
    `Depois da aprovação, chame ${tool} de novo com os mesmos argumentos e approvalId "${request.id}".`,
    "Não tente outro caminho para fazer a mesma coisa.",
  ].join("\n");
}
