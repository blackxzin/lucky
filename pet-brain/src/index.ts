#!/usr/bin/env node
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { runApprovalCli } from "./cli/approvals.js";
import { loadConfig, type Config } from "./config.js";
import { startHub } from "./hub/run.js";
import { createMaestriClient } from "./maestri/client.js";
import { createApprovalStore } from "./pc/approvals.js";
import { createAuditLog } from "./pc/audit.js";
import { createHabitStore } from "./habits/store.js";
import { createReminderStore } from "./reminders/store.js";
import { spawnRunner } from "./proc/run.js";
import { createServer } from "./server.js";

const ENTRY = fileURLToPath(import.meta.url);
const UI_DIR = join(dirname(ENTRY), "..", "ui");

function stores(config: Config) {
  return {
    approvals: createApprovalStore({ dir: join(config.stateDir, "approvals") }),
    audit: createAuditLog({ path: join(config.stateDir, "audit.log") }),
  };
}

async function serveMcp(config: Config): Promise<void> {
  const server = createServer({
    maestri: createMaestriClient({ bin: config.maestriBin }),
    vaultRoot: config.vaultRoot,
    homeDir: config.homeDir,
    run: spawnRunner,
    opencodeBin: config.opencodeBin,
    reminders: createReminderStore({ dir: join(config.stateDir, "reminders") }),
    habits: createHabitStore({ dir: join(config.stateDir, "habits") }),
    ...stores(config),
  });
  await server.connect(new StdioServerTransport());
  // stdout é o canal do protocolo MCP; logs vão só no stderr.
  process.stderr.write(`pet-brain pronto (cofre: ${config.vaultRoot}, maestri: ${config.maestriBin})\n`);
}

async function serveHub(config: Config): Promise<void> {
  const url = await startHub(config, { entry: ENTRY, uiDir: UI_DIR });
  process.stderr.write(`[pet-hub] pronto em ${url}\n`);
}

async function approvalCli(config: Config, args: string[]): Promise<number> {
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await runApprovalCli(args, {
      ...stores(config),
      io: {
        isInteractive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
        ask: (question) => terminal.question(question),
        write: (line) => void process.stdout.write(`${line}\n`),
      },
    });
  } finally {
    terminal.close();
  }
}

async function main(): Promise<void> {
  const config = loadConfig(process.env, homedir());
  const [command, ...rest] = process.argv.slice(2);
  if (command === undefined) return serveMcp(config);
  if (command === "hub") return serveHub(config);
  process.exitCode = await approvalCli(config, [command, ...rest]);
}

main().catch((error: unknown) => {
  process.stderr.write(`pet-brain falhou: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
