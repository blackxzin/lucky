import { describe, expect, test } from "vitest";
import {
  createMaestriClient,
  execFileRunner,
  MaestriError,
  type CommandRunner,
} from "../src/maestri/client.js";

type Call = { bin: string; args: readonly string[]; timeoutMs: number };

function fakeRunner(result: { stdout?: string; error?: unknown }) {
  const calls: Call[] = [];
  const run: CommandRunner = async (bin, args, opts) => {
    calls.push({ bin, args, timeoutMs: opts.timeoutMs });
    if (result.error) throw result.error;
    return { stdout: result.stdout ?? "", stderr: "" };
  };
  return { run, calls };
}

describe("maestri client", () => {
  test("list runs `maestri list` and returns stdout", async () => {
    const { run, calls } = fakeRunner({ stdout: "You: Brain\nAgents: OpenCode\n" });
    const client = createMaestriClient({ bin: "maestri", run });

    const output = await client.list();

    expect(output).toBe("You: Brain\nAgents: OpenCode\n");
    expect(calls).toEqual([{ bin: "maestri", args: ["list"], timeoutMs: 15_000 }]);
  });

  test("ask passes agent and prompt as separate args with the given timeout", async () => {
    const { run, calls } = fakeRunner({ stdout: "done" });
    const client = createMaestriClient({ bin: "/opt/maestri", run });

    const output = await client.ask("OpenCode @ Work", "fix bug; rm -rf /", 300);

    expect(output).toBe("done");
    expect(calls).toEqual([
      { bin: "/opt/maestri", args: ["ask", "OpenCode @ Work", "fix bug; rm -rf /"], timeoutMs: 300_000 },
    ]);
  });

  test("ask uses a 120s default timeout", async () => {
    const { run, calls } = fakeRunner({ stdout: "" });
    const client = createMaestriClient({ bin: "maestri", run });

    await client.ask("OpenCode", "hi");

    expect(calls[0]?.timeoutMs).toBe(120_000);
  });

  test("check runs `maestri check <agent>`", async () => {
    const { run, calls } = fakeRunner({ stdout: "screen" });
    const client = createMaestriClient({ bin: "maestri", run });

    const output = await client.check("OpenCode");

    expect(output).toBe("screen");
    expect(calls[0]?.args).toEqual(["check", "OpenCode"]);
  });

  test("rejects agent names that would be parsed as a flag", async () => {
    const { run, calls } = fakeRunner({ stdout: "" });
    const client = createMaestriClient({ bin: "maestri", run });

    await expect(client.check("--raw")).rejects.toMatchObject({ kind: "invalid_argument" });
    await expect(client.ask("--batch", "{}")).rejects.toMatchObject({ kind: "invalid_argument" });
    expect(calls).toHaveLength(0);
  });

  test("rejects prompts that would be parsed as a flag", async () => {
    const { run, calls } = fakeRunner({ stdout: "" });
    const client = createMaestriClient({ bin: "maestri", run });

    await expect(client.ask("OpenCode", "--raw")).rejects.toMatchObject({ kind: "invalid_argument" });
    expect(calls).toHaveLength(0);
  });

  test("maps a missing binary to not_found", async () => {
    const { run } = fakeRunner({ error: Object.assign(new Error("spawn maestri ENOENT"), { code: "ENOENT" }) });
    const client = createMaestriClient({ bin: "maestri", run });

    const error = await client.list().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(MaestriError);
    expect(error).toMatchObject({ kind: "not_found" });
    expect((error as MaestriError).message).toMatch(/MAESTRI_CLI/);
  });

  test("maps a timeout to a hint that says not to resend the prompt", async () => {
    const { run } = fakeRunner({ error: Object.assign(new Error("killed"), { killed: true, signal: "SIGTERM" }) });
    const client = createMaestriClient({ bin: "maestri", run });

    const error = await client.ask("OpenCode", "long task", 1).catch((e: unknown) => e);

    expect(error).toMatchObject({ kind: "timeout" });
    expect((error as MaestriError).message).toMatch(/maestri_check/);
  });

  test("maps a non-zero exit to failed, including stderr and a debug hint", async () => {
    const { run } = fakeRunner({ error: Object.assign(new Error("exit 1"), { code: 1, stderr: "pipe closed" }) });
    const client = createMaestriClient({ bin: "maestri", run });

    const error = await client.list().catch((e: unknown) => e);

    expect(error).toMatchObject({ kind: "failed" });
    expect((error as MaestriError).message).toMatch(/pipe closed/);
    expect((error as MaestriError).message).toMatch(/maestri debug/);
  });
});

describe("execFileRunner", () => {
  test("runs a real process without a shell and captures stdout", async () => {
    const result = await execFileRunner(process.execPath, ["-e", "console.log(process.argv[1])", "a; echo b"], {
      timeoutMs: 10_000,
    });

    expect(result.stdout).toBe("a; echo b\n");
  });

  test("a process that outlives the timeout surfaces as a timeout error", async () => {
    const client = createMaestriClient({ bin: process.execPath, run: execFileRunner, listTimeoutMs: 10_000 });

    // `node list` nunca termina aqui: o arquivo "list" não existe, então usamos -e via env
    const slow = createMaestriClient({
      bin: process.execPath,
      run: (bin, _args, opts) => execFileRunner(bin, ["-e", "setTimeout(() => {}, 30000)"], opts),
      listTimeoutMs: 200,
    });

    await expect(slow.list()).rejects.toMatchObject({ kind: "timeout" });
    await expect(client.list()).rejects.toMatchObject({ kind: "failed" });
  });
});

describe("maestri client hardening", () => {
  test("kills a process that ignores SIGTERM and reports a timeout", async () => {
    const stubborn = createMaestriClient({
      bin: process.execPath,
      run: (bin, _args, opts) =>
        execFileRunner(bin, ["-e", "process.on('SIGTERM', () => {}); setTimeout(() => {}, 30000)"], opts),
      listTimeoutMs: 300,
    });
    const started = Date.now();

    await expect(stubborn.list()).rejects.toMatchObject({ kind: "timeout" });
    expect(Date.now() - started).toBeLessThan(3000);
  });

  test("never echoes the prompt back when the CLI fails silently", async () => {
    const { run } = fakeRunner({
      error: Object.assign(new Error("Command failed: maestri ask OpenCode SECRET-PROMPT"), { code: 3, stderr: "" }),
    });
    const client = createMaestriClient({ bin: "maestri", run });

    const error = (await client.ask("OpenCode", "SECRET-PROMPT").catch((e: unknown) => e)) as MaestriError;

    expect(error.kind).toBe("failed");
    expect(error.message).not.toMatch(/SECRET-PROMPT/);
    expect(error.message).toMatch(/3/);
  });

  test("falls back to stdout when stderr is empty, truncated", async () => {
    const { run } = fakeRunner({ error: Object.assign(new Error("x"), { code: 1, stderr: "", stdout: "E".repeat(10_000) }) });
    const client = createMaestriClient({ bin: "maestri", run });

    const error = (await client.list().catch((e: unknown) => e)) as MaestriError;

    expect(error.message).toMatch(/EEEE/);
    expect(error.message.length).toBeLessThan(3000);
  });

  test("reports output over the size limit clearly", async () => {
    const { run } = fakeRunner({ error: Object.assign(new Error("x"), { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" }) });
    const client = createMaestriClient({ bin: "maestri", run });

    await expect(client.list()).rejects.toThrow(/limite/);
  });

  test("rejects a prompt that hides a flag behind leading spaces", async () => {
    const { run } = fakeRunner({ stdout: "" });
    const client = createMaestriClient({ bin: "maestri", run });

    await expect(client.ask("OpenCode", "  --raw")).rejects.toMatchObject({ kind: "invalid_argument" });
  });
});

describe("maestri raw and notify", () => {
  test("raw sends the input as the value of --raw", async () => {
    const { run, calls } = fakeRunner({ stdout: "ok" });
    const client = createMaestriClient({ bin: "maestri", run });

    await client.raw("OpenCode", "-la\\n");

    expect(calls[0]?.args).toEqual(["ask", "OpenCode", "--raw", "-la\\n"]);
  });

  test("raw rejects an empty input and a flag-like agent", async () => {
    const { run, calls } = fakeRunner({ stdout: "" });
    const client = createMaestriClient({ bin: "maestri", run });

    await expect(client.raw("OpenCode", "")).rejects.toBeInstanceOf(MaestriError);
    await expect(client.raw("--batch", "x")).rejects.toBeInstanceOf(MaestriError);
    expect(calls).toEqual([]);
  });

  test("notify sends the message and refuses flags", async () => {
    const { run, calls } = fakeRunner({ stdout: "" });
    const client = createMaestriClient({ bin: "maestri", run });

    await client.notify("Testes passaram");

    expect(calls[0]?.args).toEqual(["notify", "Testes passaram"]);
    await expect(client.notify("--help")).rejects.toBeInstanceOf(MaestriError);
  });
});
