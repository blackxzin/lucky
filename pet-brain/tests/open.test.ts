import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { approvalIdIn, call, connect, createSandbox, fakeRun, type Sandbox } from "./helpers.js";

let sandbox: Sandbox;
beforeEach(async () => {
  sandbox = await createSandbox();
});
afterEach(() => sandbox.cleanup());

const opened = (calls: ReturnType<typeof fakeRun>["calls"]) => calls.map((entry) => [entry.bin, ...entry.args]);
/** Lançador desacoplado: o alvo vai como argumento posicional, fora do texto do script. */
const launch = (...target: string[]) => ["setsid", "-f", "sh", "-c", 'exec "$@" >/dev/null 2>&1 </dev/null', "sh", ...target];

describe("pc_open_app", () => {
  test("launches an allowed app detached, without a shell", async () => {
    const { run, calls } = fakeRun();
    const client = await connect(sandbox.deps({ run }));

    const result = await call(client, "pc_open_app", { app: "firefox" });

    expect(result.isError).toBe(false);
    expect(opened(calls)).toEqual([launch("firefox")]);
    expect(sandbox.audited[0]).toMatchObject({ tool: "pc_open_app", action: "firefox", decision: "auto" });
  });

  test("refuses an app that is not on the list", async () => {
    const { run, calls } = fakeRun();
    const client = await connect(sandbox.deps({ run }));

    expect((await call(client, "pc_open_app", { app: "rm" })).isError).toBe(true);
    expect(calls).toEqual([]);
  });
});

describe("pc_search", () => {
  test("opens a search page built by the tool", async () => {
    const { run, calls } = fakeRun();
    const client = await connect(sandbox.deps({ run }));

    await call(client, "pc_search", { query: "receita de bolo & café" });

    expect(opened(calls)).toEqual([launch("xdg-open", "https://duckduckgo.com/?q=receita%20de%20bolo%20%26%20caf%C3%A9")]);
  });

  test("can search on YouTube", async () => {
    const { run, calls } = fakeRun();
    const client = await connect(sandbox.deps({ run }));

    await call(client, "pc_search", { query: "arctic monkeys", engine: "youtube" });

    expect(opened(calls)).toEqual([launch("xdg-open", "https://www.youtube.com/results?search_query=arctic%20monkeys")]);
  });

  test("never sends a secret to a search engine", async () => {
    const { run, calls } = fakeRun();
    const client = await connect(sandbox.deps({ run }));

    const result = await call(client, "pc_search", { query: "token: abcdefghijkl123456" });

    expect(result.isError).toBe(true);
    expect(calls).toEqual([]);
  });
});

describe("pc_open_url", () => {
  test("opens a known site straight away", async () => {
    const { run, calls } = fakeRun();
    const client = await connect(sandbox.deps({ run }));

    await call(client, "pc_open_url", { url: "https://www.youtube.com/watch?v=abc" });

    expect(opened(calls)).toEqual([launch("xdg-open", "https://www.youtube.com/watch?v=abc")]);
  });

  test("asks the owner before opening an unknown site, then opens it once", async () => {
    const { run, calls } = fakeRun();
    const client = await connect(sandbox.deps({ run }));
    const url = "https://exemplo-qualquer.com.br/pagina";

    const asked = await call(client, "pc_open_url", { url });
    expect(asked.text).toContain("NÃO EXECUTADO");
    expect(calls).toEqual([]);

    await sandbox.approvals.decide(approvalIdIn(asked.text), true);
    await call(client, "pc_open_url", { url, approvalId: approvalIdIn(asked.text) });

    expect(opened(calls)).toEqual([launch("xdg-open", url)]);
  });

  test.each(["http://www.youtube.com/", "javascript:alert(1)", "file:///etc/passwd", "https://user:pass@www.youtube.com/", "https://www.youtube.com/?t=ghp_" + "a".repeat(36)])(
    "refuses %s",
    async (url) => {
      const { run, calls } = fakeRun();
      const client = await connect(sandbox.deps({ run }));

      expect((await call(client, "pc_open_url", { url })).isError).toBe(true);
      expect(calls).toEqual([]);
    },
  );
});

describe("whatsapp_draft", () => {
  test("opens the chat with the text typed but never sends it", async () => {
    const { run, calls } = fakeRun();
    const client = await connect(sandbox.deps({ run }));

    const result = await call(client, "whatsapp_draft", { phone: "5511999998888", text: "to chegando, 10 min" });

    expect(result.text).toMatch(/enter|enviar/i);
    expect(opened(calls)).toEqual([launch("xdg-open", "https://web.whatsapp.com/send?phone=5511999998888&text=to%20chegando%2C%2010%20min")]);
  });

  test.each(["+55 11 99999-8888", "abc", "123", "5511999998888; rm"])("refuses the phone %j", async (phone) => {
    const { run, calls } = fakeRun();
    const client = await connect(sandbox.deps({ run }));

    expect((await call(client, "whatsapp_draft", { phone, text: "oi" })).isError).toBe(true);
    expect(calls).toEqual([]);
  });

  test("refuses a draft that holds a secret", async () => {
    const { run, calls } = fakeRun();
    const client = await connect(sandbox.deps({ run }));

    expect((await call(client, "whatsapp_draft", { phone: "5511999998888", text: "senha: abcdefgh1234" })).isError).toBe(true);
    expect(calls).toEqual([]);
  });
});
