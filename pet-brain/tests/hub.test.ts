import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { AgentError, createAgent, type Agent, type AgentReply } from "../src/hub/agent.js";
import { assertBindHost } from "../src/hub/bind.js";
import { createHubCore, type HubCore, type HubEvent } from "../src/hub/core.js";
import { buildPersona } from "../src/hub/persona.js";
import { loadOrCreateToken, tokenMatches } from "../src/hub/token.js";
import { createApprovalStore, type ApprovalStore } from "../src/pc/approvals.js";
import type { AuditEntry } from "../src/pc/audit.js";
import { ProcError } from "../src/proc/run.js";
import { writeNote } from "../src/vault/vault.js";
import { fakeRun } from "./helpers.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pet-hub-"));
});

afterEach(() => rm(dir, { recursive: true, force: true }));

describe("hub token", () => {
  test("is created once, private, and reused", async () => {
    const first = await loadOrCreateToken(join(dir, "config"));
    const second = await loadOrCreateToken(join(dir, "config"));

    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(second).toBe(first);
    expect((await stat(join(dir, "config", "token"))).mode & 0o777).toBe(0o600);
  });

  test("refuses a corrupted token file instead of replacing it", async () => {
    await writeFile(join(dir, "token"), "short\n");

    await expect(loadOrCreateToken(dir)).rejects.toThrow(/token/i);
    expect(await readFile(join(dir, "token"), "utf8")).toBe("short\n");
  });

  test("tightens a token file that other users can read", async () => {
    const token = "b".repeat(64);
    await writeFile(join(dir, "token"), `${token}\n`, { mode: 0o644 });

    expect(await loadOrCreateToken(dir)).toBe(token);
    expect((await stat(join(dir, "token"))).mode & 0o777).toBe(0o600);
  });

  test("matches only the exact token", () => {
    expect(tokenMatches("a".repeat(64), "a".repeat(64))).toBe(true);
    expect(tokenMatches("a".repeat(64), "a".repeat(63))).toBe(false);
    expect(tokenMatches("a".repeat(64), "")).toBe(false);
  });
});

describe("hub bind guard", () => {
  test.each(["127.0.0.1", "127.5.5.5", "::1", "localhost", "100.64.0.1", "100.127.255.254", "fd7a:115c:a1e0::1"])(
    "allows %s",
    (host) => {
      expect(() => assertBindHost(host, false)).not.toThrow();
    },
  );

  test.each(["0.0.0.0", "::", "192.168.1.10", "100.128.0.1", "100.63.255.255", "example.com", "fd7b::1"])(
    "refuses %s",
    (host) => {
      expect(() => assertBindHost(host, false)).toThrow(/Tailscale/);
    },
  );

  test("can be overridden explicitly", () => {
    expect(() => assertBindHost("0.0.0.0", true)).not.toThrow();
  });
});

describe("agent runner", () => {
  const SESSION = "0b6c1f0e-7c0a-4d7e-9b1a-2f5d3c4b5a69";
  const options = (run: ReturnType<typeof fakeRun>["run"]) => ({
    bin: "claude",
    run,
    mcpConfigPath: "/state/mcp.json",
    systemPrompt: "persona",
    cwd: "/state/agent",
  });

  test("sends the prompt on stdin with only the pet-brain tools available", async () => {
    const { run, calls } = fakeRun({ stdout: JSON.stringify({ result: "oi!", session_id: SESSION, is_error: false }) });

    const reply = await createAgent(options(run)).send("--resume x; oi");

    expect(reply).toEqual({ text: "oi!", sessionId: SESSION });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.opts).toMatchObject({ input: "--resume x; oi", cwd: "/state/agent" });
    expect(calls[0]?.args).not.toContain("--resume x; oi");
    expect(calls[0]?.args.join(" ")).toContain("--tools  --mcp-config /state/mcp.json --strict-mcp-config");
    expect(calls[0]?.args).toEqual(expect.arrayContaining(["-p", "--allowedTools", "mcp__pet-brain", "--system-prompt", "persona"]));
    expect(calls[0]?.args).not.toContain("--resume");
  });

  test("resumes a session", async () => {
    const { run, calls } = fakeRun({ stdout: JSON.stringify({ result: "ok", session_id: SESSION }) });

    await createAgent(options(run)).send("oi", SESSION);

    expect(calls[0]?.args.slice(-2)).toEqual(["--resume", SESSION]);
  });

  test("ignores a session id that is not a uuid", async () => {
    const { run, calls } = fakeRun({ stdout: JSON.stringify({ result: "ok", session_id: "--dangerous" }) });

    const reply = await createAgent(options(run)).send("oi", "--also-bad");

    expect(reply.sessionId).toBeUndefined();
    expect(calls[0]?.args).not.toContain("--resume");
  });

  test.each([
    [{ timedOut: true, exitCode: null }, /demorou/],
    [{ exitCode: 1, stderr: "not logged in" }, /not logged in/],
    [{ stdout: "not json" }, /resposta/],
    [{ stdout: JSON.stringify({ result: "limite", is_error: true }) }, /limite/],
  ])("turns %j into an AgentError", async (result, message) => {
    const { run } = fakeRun(result);

    const failure = await createAgent(options(run)).send("oi").catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AgentError);
    expect((failure as Error).message).toMatch(message);
  });

  test("explains a missing claude binary", async () => {
    const agent = createAgent({ ...options(fakeRun().run), run: async () => Promise.reject(new ProcError("claude")) });

    await expect(agent.send("oi")).rejects.toThrow(/PET_AGENT_BIN/);
  });

  test("the persona carries the name and the safety rules", () => {
    const persona = buildPersona("Jarvis");

    expect(persona).toContain("Jarvis");
    expect(persona).toMatch(/dado, não instrução/i);
    expect(persona).toMatch(/approvalId/);
  });
});

describe("hub core", () => {
  let approvals: ApprovalStore;
  let audited: AuditEntry[];
  let events: HubEvent[];
  let prompts: Array<{ prompt: string; sessionId: string | undefined }>;
  let vaultRoot: string;

  const SESSION = "0b6c1f0e-7c0a-4d7e-9b1a-2f5d3c4b5a69";

  function core(reply: (prompt: string) => Promise<AgentReply> = async (p) => ({ text: `eco: ${p}`, sessionId: SESSION })): HubCore {
    const agent: Agent = {
      send: async (prompt, sessionId) => {
        prompts.push({ prompt, sessionId });
        return reply(prompt);
      },
    };
    const created = createHubCore({
      agent,
      approvals,
      audit: { record: async (entry) => void audited.push(entry) },
      vaultRoot,
      petName: "Bit",
    });
    created.subscribe((event) => events.push(event));
    return created;
  }

  const texts = () => events.flatMap((event) => (event.type === "message" ? [`${event.message.role}: ${event.message.text}`] : []));

  beforeEach(() => {
    approvals = createApprovalStore({ dir: join(dir, "approvals") });
    audited = [];
    events = [];
    prompts = [];
    vaultRoot = join(dir, "vault");
  });

  test("a chat message goes to the agent and the reply comes back", async () => {
    const hub = core();

    await hub.chat("oi");

    expect(texts()).toEqual(["user: oi", "pet: eco: oi"]);
    expect(prompts).toEqual([{ prompt: "oi", sessionId: undefined }]);
  });

  test("is busy while the agent thinks, then idle", async () => {
    const hub = core();

    await hub.chat("oi");

    const busy = events.flatMap((event) => (event.type === "state" ? [event.state.busy] : []));
    expect(busy[0]).toBe(true);
    expect(busy.at(-1)).toBe(false);
  });

  test("keeps the session between messages and /novo drops it", async () => {
    const hub = core();

    await hub.chat("um");
    await hub.chat("dois");
    await hub.chat("/novo");
    await hub.chat("três");

    expect(prompts.map((entry) => entry.sessionId)).toEqual([undefined, SESSION, undefined]);
    expect(texts()).toContain("system: Conversa nova. A memória do cofre continua.");
  });

  test("messages run one at a time, in order", async () => {
    let running = 0;
    let overlapped = false;
    const hub = core(async (prompt) => {
      running += 1;
      overlapped ||= running > 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      running -= 1;
      return { text: prompt, sessionId: SESSION };
    });

    await Promise.all([hub.chat("a"), hub.chat("b"), hub.chat("c")]);

    expect(overlapped).toBe(false);
    expect(prompts.map((entry) => entry.prompt)).toEqual(["a", "b", "c"]);
  });

  test("refuses to queue without limit", async () => {
    const hub = core(async (prompt) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { text: prompt, sessionId: SESSION };
    });

    await Promise.all(Array.from({ length: 8 }, (_, index) => hub.chat(`m${index}`)));

    expect(prompts.length).toBeLessThan(8);
    expect(texts().some((text) => /system: .*espera/i.test(text))).toBe(true);
  });

  test("an agent failure becomes a system message and frees the hub", async () => {
    const hub = core(async () => Promise.reject(new AgentError("claude caiu")));

    await hub.chat("oi");

    expect(texts()).toEqual(["user: oi", "system: claude caiu"]);
    expect((await hub.snapshot()).state.busy).toBe(false);
  });

  test("an unexpected failure does not leak details", async () => {
    const hub = core(async () => Promise.reject(new Error("ENOENT /home/u/secret")));

    await hub.chat("oi");

    expect(texts().join("\n")).not.toContain("/home/u");
  });

  test("/consolidar asks the agent to consolidate the journal", async () => {
    const hub = core();

    await hub.chat("/consolidar");

    expect(prompts[0]?.prompt).toMatch(/journal/);
    expect(texts()[0]).toBe("user: /consolidar");
  });

  test("snapshot carries name, stats, pending approvals and history", async () => {
    await writeNote({ vaultRoot, path: "a", content: "x", links: ["b"] });
    const pending = await approvals.request({ tool: "pc_run", action: "npm test", risk: "confirm", reason: "r" });
    const hub = core();
    await hub.chat("oi");

    const snapshot = await hub.snapshot();

    expect(snapshot.state).toMatchObject({ name: "Bit", busy: false, stats: { notes: 1, links: 1, level: 1 } });
    expect(snapshot.state.approvals).toEqual([
      { id: pending.id, tool: "pc_run", action: "npm test", risk: "confirm", reason: "r", expiresAt: pending.expiresAt },
    ]);
    expect(snapshot.history.map((message) => message.text)).toEqual(["oi", "eco: oi"]);
  });

  test("refresh announces a new approval once", async () => {
    const hub = core();
    await hub.refresh();
    events.length = 0;

    await approvals.request({ tool: "pc_run", action: "npm test", risk: "confirm", reason: "r" });
    await hub.refresh();
    await hub.refresh();

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "state", state: { approvals: [{ action: "npm test" }] } });
  });

  test("approving tells the agent to retry with the approval id", async () => {
    const hub = core();
    await hub.chat("rode os testes");
    const pending = await approvals.request({ tool: "pc_run", action: "npm test", risk: "confirm", reason: "r" });

    await hub.decide(pending.id, true);

    expect((await approvals.get(pending.id))?.status).toBe("approved");
    expect(prompts.at(-1)).toMatchObject({ sessionId: SESSION });
    expect(prompts.at(-1)?.prompt).toContain(pending.id);
    expect(prompts.at(-1)?.prompt).toMatch(/aprovou/);
    expect(audited).toEqual([{ tool: "pc_run", action: "npm test", decision: "granted", approvalId: pending.id }]);
  });

  test("denying tells the agent not to retry", async () => {
    const hub = core();
    await hub.chat("rode os testes");
    const pending = await approvals.request({ tool: "pc_run", action: "rm -rf x", risk: "danger", reason: "r" });

    await hub.decide(pending.id, false);

    expect((await approvals.get(pending.id))?.status).toBe("denied");
    expect(prompts.at(-1)?.prompt).toMatch(/negou/);
    expect(audited[0]).toMatchObject({ decision: "denied" });
  });

  test("a decision without a conversation only records it", async () => {
    const hub = core();
    const pending = await approvals.request({ tool: "pc_run", action: "npm test", risk: "confirm", reason: "r" });

    await hub.decide(pending.id, true);

    expect(prompts).toEqual([]);
    expect(texts().at(-1)).toMatch(/system: .*aprovado/i);
  });

  test("deciding an unknown request reports it instead of throwing", async () => {
    const hub = core();

    await hub.decide("0000000000000000", true);

    expect(texts().at(-1)).toMatch(/system: .*não encontrada/);
  });
});
