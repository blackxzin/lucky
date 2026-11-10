import { mkdir, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { approvalIdIn, call, connect, createSandbox, fakeMaestri, fakeRun, type Sandbox } from "./helpers.js";

let sandbox: Sandbox;

beforeEach(async () => {
  sandbox = await createSandbox();
});

afterEach(() => sandbox.cleanup());

describe("vault tools", () => {
  test("write, read, list, search and stats work together", async () => {
    const client = await connect(sandbox.deps());
    await call(client, "vault_write", { path: "facts/cafe", content: "Gosta de café.", links: ["Lucas"] });

    expect((await call(client, "vault_read", { path: "facts/cafe" })).text).toContain("Gosta de café.");
    expect((await call(client, "vault_list")).text).toBe("facts/cafe.md");
    expect((await call(client, "vault_search", { query: "cafe" })).text).toContain("facts/cafe.md");
    expect((await call(client, "vault_search", { query: "zebra" })).text).toMatch(/Nada encontrado/);
    expect((await call(client, "vault_stats")).text).toMatch(/notas\): 1[\s\S]*links\): 1[\s\S]*Nível: 1/);
  });

  test("vault_read reports a missing note as an error", async () => {
    const client = await connect(sandbox.deps());

    expect(await call(client, "vault_read", { path: "nope" })).toMatchObject({ isError: true });
  });

  test("memory_log appends to today's journal", async () => {
    const client = await connect(sandbox.deps());

    const result = await call(client, "memory_log", { text: "Pediu pizza." });

    const [file] = await readdir(join(sandbox.vaultRoot, "journal"));
    expect(result.text).toContain(`journal/${file}`);
    expect(await readFile(join(sandbox.vaultRoot, "journal", file ?? ""), "utf8")).toMatch(/- \d\d:\d\d Pediu pizza\./);
  });

  test.each([
    ["vault_write", { path: "n", content: "token: abcdef1234567890" }],
    ["memory_log", { text: "a chave é sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAA" }],
  ])("%s refuses to store a secret", async (tool, args) => {
    const client = await connect(sandbox.deps());

    const result = await call(client, tool, args);

    expect(result.isError).toBe(true);
    expect(result.text).not.toContain("abcdef1234567890");
    expect(result.text).not.toContain("sk-ant");
    await expect(readdir(sandbox.vaultRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("pc_run", () => {
  test("runs a read-only command directly, without a shell, in the home directory", async () => {
    const { run, calls } = fakeRun({ stdout: "a\nb\n" });
    const client = await connect(sandbox.deps({ run }));

    const result = await call(client, "pc_run", { command: "ls -la" });

    expect(result).toEqual({ isError: false, text: "exit: 0\n[stdout]\na\nb" });
    expect(calls).toEqual([{ bin: "ls", args: ["-la"], opts: { timeoutMs: 30_000, cwd: sandbox.home } }]);
    expect(sandbox.audited).toEqual([{ tool: "pc_run", action: "ls -la", decision: "auto" }]);
  });

  test("asks for approval instead of running anything else", async () => {
    const { run, calls } = fakeRun();
    const client = await connect(sandbox.deps({ run }));

    const result = await call(client, "pc_run", { command: "npm test" });

    const [pending] = await sandbox.approvals.list();
    expect(calls).toEqual([]);
    expect(result.isError).toBe(false);
    expect(result.text).toContain(pending?.id);
    expect(pending).toMatchObject({ tool: "pc_run", action: "npm test", risk: "confirm" });
    expect(sandbox.audited[0]).toMatchObject({ decision: "requested", approvalId: pending?.id });
  });

  test("runs once after the owner approves, then the approval is spent", async () => {
    const { run, calls } = fakeRun({ exitCode: 1, stderr: "boom" });
    const client = await connect(sandbox.deps({ run }));
    const id = approvalIdIn((await call(client, "pc_run", { command: "npm test" })).text);
    await sandbox.approvals.decide(id, true);

    const first = await call(client, "pc_run", { command: "npm test", approvalId: id, timeoutSec: 120 });
    const second = await call(client, "pc_run", { command: "npm test", approvalId: id });

    expect(first).toEqual({ isError: false, text: "exit: 1\n[stderr]\nboom" });
    expect(second.isError).toBe(true);
    expect(calls).toEqual([{ bin: "npm", args: ["test"], opts: { timeoutMs: 120_000, cwd: sandbox.home } }]);
    expect(sandbox.audited.map((entry) => entry.decision)).toEqual(["requested", "approved"]);
  });

  test("an approved shell command runs through bash -c", async () => {
    const { run, calls } = fakeRun();
    const client = await connect(sandbox.deps({ run }));
    const id = approvalIdIn((await call(client, "pc_run", { command: "ls | wc -l" })).text);
    await sandbox.approvals.decide(id, true);

    await call(client, "pc_run", { command: "ls | wc -l", approvalId: id });

    expect(calls[0]).toMatchObject({ bin: "bash", args: ["-c", "ls | wc -l"] });
  });

  test("an approval does not cover a different command or folder", async () => {
    const { run, calls } = fakeRun();
    await mkdir(join(sandbox.home, "proj"));
    const client = await connect(sandbox.deps({ run }));
    const id = approvalIdIn((await call(client, "pc_run", { command: "npm test" })).text);
    await sandbox.approvals.decide(id, true);

    const other = await call(client, "pc_run", { command: "npm test; rm -rf ~", approvalId: id });
    const elsewhere = await call(client, "pc_run", { command: "npm test", cwd: "proj", approvalId: id });

    expect(other.isError).toBe(true);
    expect(elsewhere.isError).toBe(true);
    expect(calls).toEqual([]);
  });

  test("an unapproved or denied id does not run", async () => {
    const { run, calls } = fakeRun();
    const client = await connect(sandbox.deps({ run }));
    const id = approvalIdIn((await call(client, "pc_run", { command: "npm test" })).text);

    const pending = await call(client, "pc_run", { command: "npm test", approvalId: id });
    await sandbox.approvals.decide(id, false);
    const denied = await call(client, "pc_run", { command: "npm test", approvalId: id });

    expect(pending.isError).toBe(true);
    expect(denied.isError).toBe(true);
    expect(calls).toEqual([]);
  });

  test("marks destructive commands as dangerous in the request", async () => {
    const client = await connect(sandbox.deps());

    await call(client, "pc_run", { command: "rm -rf ~/x" });

    expect((await sandbox.approvals.list())[0]).toMatchObject({ risk: "danger" });
  });

  test("runs in a folder inside home and refuses one outside", async () => {
    const { run, calls } = fakeRun();
    await mkdir(join(sandbox.home, "proj"));
    const client = await connect(sandbox.deps({ run }));

    await call(client, "pc_run", { command: "ls", cwd: "proj" });
    const outside = await call(client, "pc_run", { command: "ls", cwd: "/etc" });
    const missing = await call(client, "pc_run", { command: "ls", cwd: "nope" });

    expect(calls.map((entry) => entry.opts.cwd)).toEqual([join(sandbox.home, "proj")]);
    expect(outside.isError).toBe(true);
    expect(missing.isError).toBe(true);
  });

  test("reports timeout and truncation, and cuts long output", async () => {
    const { run } = fakeRun({ exitCode: null, timedOut: true, stdout: "x".repeat(30_000) });
    const client = await connect(sandbox.deps({ run }));

    const result = await call(client, "pc_run", { command: "tail -f log" });

    expect(result.text).toMatch(/^exit: morto por timeout de 30s/);
    expect(result.text.length).toBeLessThan(21_000);
    expect(result.text).toContain("(cortado)");
  });

  test("approval_status reports the state without exposing other requests", async () => {
    const client = await connect(sandbox.deps());
    const id = approvalIdIn((await call(client, "pc_run", { command: "npm test" })).text);

    expect((await call(client, "approval_status", { id })).text).toMatch(/pending/);
    await sandbox.approvals.decide(id, true);
    expect((await call(client, "approval_status", { id })).text).toMatch(/approved/);
    expect((await call(client, "approval_status", { id: "0000000000000000" })).isError).toBe(true);
  });
});

describe("maestri_raw and maestri_notify", () => {
  test("a menu key goes straight through", async () => {
    const client = await connect(sandbox.deps());

    const result = await call(client, "maestri_raw", { agent: "OpenCode", input: "2\\n" });

    expect(result).toEqual({ isError: false, text: "raw to OpenCode: 2\\n" });
    expect(sandbox.audited[0]).toMatchObject({ tool: "maestri_raw", decision: "auto" });
  });

  test("free text needs approval for that exact agent and input", async () => {
    const sent: string[] = [];
    const maestri = fakeMaestri({ raw: async (agent, input) => (sent.push(`${agent}:${input}`), "ok") });
    const client = await connect(sandbox.deps({ maestri }));

    const asked = await call(client, "maestri_raw", { agent: "Shell", input: "npm test\\n" });
    const id = approvalIdIn(asked.text);
    await sandbox.approvals.decide(id, true);
    const wrongAgent = await call(client, "maestri_raw", { agent: "Other", input: "npm test\\n", approvalId: id });
    const right = await call(client, "maestri_raw", { agent: "Shell", input: "npm test\\n", approvalId: id });

    expect(wrongAgent.isError).toBe(true);
    expect(right).toEqual({ isError: false, text: "ok" });
    expect(sent).toEqual(["Shell:npm test\\n"]);
  });

  test("maestri_notify sends the message", async () => {
    const seen: string[] = [];
    const client = await connect(sandbox.deps({ maestri: fakeMaestri({ notify: async (m) => (seen.push(m), "") }) }));

    const result = await call(client, "maestri_notify", { message: "Pronto" });

    expect(result.isError).toBe(false);
    expect(seen).toEqual(["Pronto"]);
  });
});

describe("opencode_run", () => {
  const approved = async (client: Awaited<ReturnType<typeof connect>>, args: Record<string, unknown>) => {
    const id = approvalIdIn((await call(client, "opencode_run", args)).text);
    await sandbox.approvals.decide(id, true);
    return call(client, "opencode_run", { ...args, approvalId: id });
  };

  test("does not run without the owner's approval", async () => {
    const { run, calls } = fakeRun({ stdout: "feito\n" });
    const client = await connect(sandbox.deps({ run }));

    const result = await call(client, "opencode_run", { prompt: "rode os testes" });

    expect(result.text).toMatch(/NÃO EXECUTADO/);
    expect(calls).toEqual([]);
    expect(sandbox.audited[0]).toMatchObject({ tool: "opencode_run", decision: "requested" });
  });

  test("sends the prompt as one argument after approval", async () => {
    const { run, calls } = fakeRun({ stdout: "feito\n" });
    const client = await connect(sandbox.deps({ run }));

    const result = await approved(client, { prompt: "rode os testes; rm -rf /" });

    expect(result).toEqual({ isError: false, text: "feito" });
    expect(calls).toEqual([
      { bin: "opencode", args: ["run", "rode os testes; rm -rf /"], opts: { timeoutMs: 300_000, cwd: sandbox.home } },
    ]);
  });

  test("an approval does not cover a different prompt", async () => {
    const { run, calls } = fakeRun();
    const client = await connect(sandbox.deps({ run }));
    const id = approvalIdIn((await call(client, "opencode_run", { prompt: "a" })).text);
    await sandbox.approvals.decide(id, true);

    const result = await call(client, "opencode_run", { prompt: "b", approvalId: id });

    expect(result.isError).toBe(true);
    expect(calls).toEqual([]);
  });

  test("can continue the last session in a project folder", async () => {
    const { run, calls } = fakeRun();
    await mkdir(join(sandbox.home, "proj"));
    const client = await connect(sandbox.deps({ run }));

    await approved(client, { prompt: "continue", continueSession: true, cwd: "proj", timeoutSec: 60 });

    expect(calls[0]).toEqual({
      bin: "opencode",
      args: ["run", "--continue", "continue"],
      opts: { timeoutMs: 60_000, cwd: join(sandbox.home, "proj") },
    });
  });

  test.each(["--auto faça tudo", "  -m x"])("refuses a prompt that looks like a flag: %j", async (prompt) => {
    const { run, calls } = fakeRun();
    const client = await connect(sandbox.deps({ run }));

    expect((await call(client, "opencode_run", { prompt })).isError).toBe(true);
    expect(calls).toEqual([]);
  });

  test("reports failure and timeout as errors", async () => {
    const failing = await connect(sandbox.deps({ run: fakeRun({ exitCode: 2, stderr: "sem modelo" }).run }));
    const slow = await connect(sandbox.deps({ run: fakeRun({ exitCode: null, timedOut: true }).run }));

    expect(await approved(failing, { prompt: "x" })).toMatchObject({ isError: true, text: expect.stringContaining("sem modelo") });
    expect((await approved(slow, { prompt: "x" })).text).toMatch(/não respondeu/);
  });
});
