import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { MaestriClient } from "../src/maestri/client.js";
import { createApprovalStore, type ApprovalStore } from "../src/pc/approvals.js";
import type { AuditEntry } from "../src/pc/audit.js";
import { createHabitStore } from "../src/habits/store.js";
import { createReminderStore } from "../src/reminders/store.js";
import type { ProcessOptions, ProcessResult, ProcessRunner } from "../src/proc/run.js";
import { createServer, type ServerDeps } from "../src/server.js";

export function fakeMaestri(overrides: Partial<MaestriClient> = {}): MaestriClient {
  return {
    list: async () => "You: Brain\nAgents: OpenCode",
    ask: async (agent, prompt) => `${agent} got: ${prompt}`,
    check: async (agent) => `screen of ${agent}`,
    raw: async (agent, input) => `raw to ${agent}: ${input}`,
    notify: async () => "",
    ...overrides,
  };
}

export interface RunCall {
  bin: string;
  args: readonly string[];
  opts: ProcessOptions;
}

export function fakeRun(result: Partial<ProcessResult> = {}) {
  const calls: RunCall[] = [];
  const run: ProcessRunner = async (bin, args, opts) => {
    calls.push({ bin, args, opts });
    return { exitCode: 0, stdout: "", stderr: "", timedOut: false, truncated: false, ...result };
  };
  return { run, calls };
}

export interface Sandbox {
  home: string;
  vaultRoot: string;
  approvals: ApprovalStore;
  audited: AuditEntry[];
  deps(overrides?: Partial<ServerDeps>): ServerDeps;
  cleanup(): Promise<void>;
}

export async function createSandbox(): Promise<Sandbox> {
  const home = await mkdtemp(join(tmpdir(), "pet-home-"));
  const vaultRoot = join(home, "pet-vault");
  const approvals = createApprovalStore({ dir: join(home, "state", "approvals") });
  const audited: AuditEntry[] = [];

  return {
    home,
    vaultRoot,
    approvals,
    audited,
    deps: (overrides = {}) => ({
      maestri: fakeMaestri(),
      vaultRoot,
      homeDir: home,
      run: fakeRun().run,
      approvals,
      audit: { record: async (entry) => void audited.push(entry), recent: async () => [], between: async () => [] },
      reminders: createReminderStore({ dir: join(home, "state", "reminders") }),
      habits: createHabitStore({ dir: join(home, "state", "habits") }),
      opencodeBin: "opencode",
      ...overrides,
    }),
    cleanup: () => rm(home, { recursive: true, force: true }),
  };
}

export async function connect(deps: ServerDeps): Promise<Client> {
  const server = createServer(deps);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

type RawResult = { isError?: boolean; content: Array<{ type: string; text?: string }> };

export async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = (await client.callTool({ name, arguments: args })) as RawResult;
  return { isError: result.isError === true, text: result.content.map((c) => c.text ?? "").join("\n") };
}

export function approvalIdIn(text: string): string {
  const id = /\b[a-f0-9]{16}\b/.exec(text)?.[0];
  if (id === undefined) throw new Error(`no approval id in: ${text}`);
  return id;
}
