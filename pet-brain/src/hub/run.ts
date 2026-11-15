import { chmod, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Config } from "../config.js";
import { createApprovalStore } from "../pc/approvals.js";
import { createAuditLog } from "../pc/audit.js";
import { createHabitStore } from "../habits/store.js";
import { createReminderStore } from "../reminders/store.js";
import { spawnRunner } from "../proc/run.js";
import { maybeWriteDigest } from "../vault/digest.js";
import { createAgent } from "./agent.js";
import { assertBindHost } from "./bind.js";
import { createSystemSources } from "./alert-sources.js";
import { createAlerts } from "./alerts.js";
import { createFallbackAgent } from "./fallback-agent.js";
import { createHubCore } from "./core.js";
import { buildMcpConfig } from "./mcp-config.js";
import { createMedia } from "./media.js";
import { buildOpenCodeConfig, createOpenCodeAgent } from "./opencode-agent.js";
import { buildPersona } from "./persona.js";
import { createHubServer } from "./server.js";
import { loadOrCreateToken, tokenPath } from "./token.js";

const REMINDER_TICK_MS = 15_000;
const DIGEST_TICK_MS = 60 * 60 * 1000;
const PRIVATE_DIR_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

export interface HubRuntime {
  entry: string;
  uiDir: string;
}

/** Sobe o hub e devolve a URL. Fica vivo até o processo terminar. */
export async function startHub(config: Config, runtime: HubRuntime): Promise<string> {
  assertBindHost(config.hubHost, config.allowAnyHost);
  const token = await loadOrCreateToken(config.configDir);

  const agentCwd = join(config.stateDir, "agent-cwd");
  await mkdir(agentCwd, { recursive: true, mode: PRIVATE_DIR_MODE });
  const mcpConfigPath = join(config.stateDir, "mcp.json");
  const mcpConfig = buildMcpConfig(config, { node: process.execPath, entry: runtime.entry });
  await writeFile(mcpConfigPath, JSON.stringify(mcpConfig, null, 2), { mode: PRIVATE_FILE_MODE });
  await chmod(mcpConfigPath, PRIVATE_FILE_MODE);

  // Reserva: OpenCode só com o pet-brain, numa pasta de config vazia (sem MCPs globais do dono).
  const persona = buildPersona(config.petName);
  const opencodeHome = join(config.stateDir, "opencode-home");
  await mkdir(opencodeHome, { recursive: true, mode: PRIVATE_DIR_MODE });
  const opencodeConfig = buildOpenCodeConfig(config, { node: process.execPath, entry: runtime.entry }, persona);
  const opencodeConfigPath = join(agentCwd, "opencode.json");
  await writeFile(opencodeConfigPath, JSON.stringify(opencodeConfig, null, 2), { mode: PRIVATE_FILE_MODE });
  await chmod(opencodeConfigPath, PRIVATE_FILE_MODE);

  const run = spawnRunner;
  const approvals = createApprovalStore({ dir: join(config.stateDir, "approvals") });
  const audit = createAuditLog({ path: join(config.stateDir, "audit.log") });
  const claude = createAgent({ bin: config.agentBin, run, mcpConfigPath, systemPrompt: persona, cwd: agentCwd });
  const opencode = createOpenCodeAgent({
    bin: config.opencodeBin,
    run,
    model: config.opencodeModel,
    cwd: agentCwd,
    configHome: opencodeHome,
  });
  const agent = createFallbackAgent(claude, opencode);
  const reminders = createReminderStore({ dir: join(config.stateDir, "reminders") });
  const habits = createHabitStore({ dir: join(config.stateDir, "habits") });
  const core = createHubCore({
    agent,
    approvals,
    audit,
    reminders,
    habits,
    alerts: createAlerts(createSystemSources(homedir())),
    vaultRoot: config.vaultRoot,
    petName: config.petName,
  });
  const server = createHubServer({
    core,
    token,
    uiDir: runtime.uiDir,
    host: config.hubHost,
    port: config.hubPort,
    media: createMedia({ run }),
  });
  /** Uma execução por rótulo: se a anterior ainda não acabou, esta é pulada (o resumo diário não escreve duas vezes). */
  const running = new Set<string>();
  const background = (task: () => Promise<unknown>, label: string): void => {
    if (running.has(label)) return;
    running.add(label);
    task()
      .catch((error: unknown) => process.stderr.write(`[pet-hub] ${label}: ${error instanceof Error ? error.message : String(error)}\n`))
      .finally(() => running.delete(label));
  };
  const timers = [
    setInterval(() => background(() => core.tick(), "falha nos lembretes"), REMINDER_TICK_MS),
    setInterval(() => background(() => maybeWriteDigest({ audit, vaultRoot: config.vaultRoot }), "falha no resumo diário"), DIGEST_TICK_MS),
  ];
  timers.forEach((timer) => timer.unref());
  background(() => maybeWriteDigest({ audit, vaultRoot: config.vaultRoot }), "falha no resumo diário");

  const port = await server.listen();
  process.stderr.write(`[pet-hub] token em ${tokenPath(config.configDir)}\n`);
  return `http://${config.hubHost.includes(":") ? `[${config.hubHost}]` : config.hubHost}:${port}`;
}
