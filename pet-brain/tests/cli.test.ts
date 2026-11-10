import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { runApprovalCli, type CliIo } from "../src/cli/approvals.js";
import type { ApprovalStore } from "../src/pc/approvals.js";
import type { AuditEntry } from "../src/pc/audit.js";
import { createSandbox, type Sandbox } from "./helpers.js";

let sandbox: Sandbox;
let approvals: ApprovalStore;
let audited: AuditEntry[];

function io(overrides: Partial<CliIo> = {}): CliIo & { out: string[] } {
  const out: string[] = [];
  return {
    out,
    isInteractive: true,
    ask: async () => "sim",
    write: (line) => void out.push(line),
    ...overrides,
  };
}

const run = (args: string[], cliIo: CliIo) =>
  runApprovalCli(args, { approvals, audit: { record: async (entry) => void audited.push(entry) }, io: cliIo });

const request = () => approvals.request({ tool: "pc_run", action: "rm -rf build", risk: "danger", reason: "apaga arquivos" });

beforeEach(async () => {
  sandbox = await createSandbox();
  approvals = sandbox.approvals;
  audited = [];
});

afterEach(() => sandbox.cleanup());

describe("approval CLI", () => {
  test("pending lists what is waiting", async () => {
    const { id } = await request();
    const cli = io();

    expect(await run(["pending"], cli)).toBe(0);
    expect(cli.out.join("\n")).toContain(id);
    expect(cli.out.join("\n")).toContain("rm -rf build");
  });

  test("pending says so when nothing is waiting", async () => {
    const cli = io();

    await run(["pending"], cli);

    expect(cli.out.join("\n")).toMatch(/Nenhum pedido/);
  });

  test("approve shows the action, asks, then approves and audits", async () => {
    const { id } = await request();
    const questions: string[] = [];
    const cli = io({
      ask: async (question) => {
        questions.push(question);
        return "sim";
      },
    });

    expect(await run(["approve", id], cli)).toBe(0);
    expect(cli.out.join("\n")).toContain("rm -rf build");
    expect(questions).toHaveLength(1);
    expect((await approvals.get(id))?.status).toBe("approved");
    expect(audited).toEqual([{ tool: "pc_run", action: "rm -rf build", decision: "granted", approvalId: id }]);
  });

  test("approve does nothing when the answer is not sim", async () => {
    const { id } = await request();

    expect(await run(["approve", id], io({ ask: async () => "s" }))).toBe(1);
    expect((await approvals.get(id))?.status).toBe("pending");
    expect(audited).toEqual([]);
  });

  test("approve refuses to run without a terminal, so a piped agent cannot approve itself", async () => {
    const { id } = await request();
    const cli = io({ isInteractive: false });

    expect(await run(["approve", id], cli)).toBe(1);
    expect(cli.out.join("\n")).toMatch(/terminal/);
    expect((await approvals.get(id))?.status).toBe("pending");
  });

  test("deny works without a terminal and audits", async () => {
    const { id } = await request();

    expect(await run(["deny", id], io({ isInteractive: false }))).toBe(0);
    expect((await approvals.get(id))?.status).toBe("denied");
    expect(audited[0]?.decision).toBe("denied");
  });

  test.each([[["approve"]], [["approve", "nope"]], [["approve", "0123456789abcdef"]], [["what"]]])(
    "%j fails with a readable message",
    async (args) => {
      const cli = io();

      expect(await run(args, cli)).toBe(1);
      expect(cli.out.join("\n")).not.toBe("");
    },
  );
});
