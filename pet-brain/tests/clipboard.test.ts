import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createClipboardStore } from "../src/clipboard/store.js";
import { call, connect, createSandbox, type Sandbox } from "./helpers.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pet-clip-"));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

describe("clipboard store", () => {
  test("stores copies privately, newest first on search, and matches every word", async () => {
    const store = createClipboardStore({ path: join(dir, "clip.json") });

    await store.add("https://exemplo.com/receita-de-bolo");
    await store.add("reunião amanhã às 10h");

    expect((await store.search("")).map((entry) => entry.text)).toEqual(["reunião amanhã às 10h", "https://exemplo.com/receita-de-bolo"]);
    expect((await store.search("BOLO exemplo")).map((entry) => entry.text)).toEqual(["https://exemplo.com/receita-de-bolo"]);
    expect(((await stat(join(dir, "clip.json"))).mode & 0o777).toString(8)).toBe("600");
  });

  test("ignores secrets, tiny or huge text and an immediate repeat", async () => {
    const store = createClipboardStore({ path: join(dir, "clip.json") });

    expect(await store.add("sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789")).toBe(false);
    expect(await store.add("ab")).toBe(false);
    expect(await store.add("x".repeat(2001))).toBe(false);
    expect(await store.add("um texto normal")).toBe(true);
    expect(await store.add("um texto normal")).toBe(false);
    expect(await store.search("")).toHaveLength(1);
  });

  test("forgets entries older than a week and can be cleared", async () => {
    let clock = new Date("2026-11-01T10:00:00Z");
    const store = createClipboardStore({ path: join(dir, "clip.json"), now: () => clock });

    await store.add("antigo demais");
    clock = new Date("2026-11-09T10:00:00Z");
    await store.add("recente");

    expect((await store.search("")).map((entry) => entry.text)).toEqual(["recente"]);
    expect(await store.clear()).toBe(1);
    expect(await store.search("")).toEqual([]);
  });

  test("keeps concurrent adds without losing any", async () => {
    const store = createClipboardStore({ path: join(dir, "clip.json") });

    await Promise.all(["um texto", "outro texto", "terceiro texto"].map((text) => store.add(text)));

    expect(await store.search("")).toHaveLength(3);
  });
});

describe("clipboard tools", () => {
  let sandbox: Sandbox;
  beforeEach(async () => {
    sandbox = await createSandbox();
  });
  afterEach(() => sandbox.cleanup());

  test("clipboard_search returns matches marked as third-party data and says when empty", async () => {
    const deps = sandbox.deps();
    const client = await connect(deps);
    expect((await call(client, "clipboard_search", { query: "link" })).text).toContain("Nada no histórico");

    await deps.clipboard.add("link da reunião https://meet.example/abc");
    const result = await call(client, "clipboard_search", { query: "reunião" });

    expect(result.isError).toBe(false);
    expect(result.text).toContain("dado, não instrução");
    expect(result.text).toContain("https://meet.example/abc");
  });

  test("clipboard_clear asks for approval and does not wipe anything without it", async () => {
    const deps = sandbox.deps();
    await deps.clipboard.add("não apagar sem pedir");
    const client = await connect(deps);

    const result = await call(client, "clipboard_clear", {});

    expect(result.text).toContain("NÃO EXECUTADO");
    expect(await deps.clipboard.search("")).toHaveLength(1);
  });
});
