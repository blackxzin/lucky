import { mkdir, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { loadConfig } from "../src/config.js";
import { MaestriError, type MaestriClient } from "../src/maestri/client.js";
import { call, connect as connectWith, createSandbox, fakeMaestri, type Sandbox } from "./helpers.js";

let sandbox: Sandbox;
let vaultRoot: string;

beforeEach(async () => {
  sandbox = await createSandbox();
  vaultRoot = sandbox.vaultRoot;
  await mkdir(vaultRoot);
});

afterEach(() => sandbox.cleanup());

const connect = (maestri: MaestriClient) => connectWith(sandbox.deps({ maestri }));

describe("MCP server", () => {
  test("exposes every tool", async () => {
    const client = await connect(fakeMaestri());

    const { tools } = await client.listTools();

    expect(tools.map((t) => t.name).sort()).toEqual([
      "approval_status",
      "habit_add",
      "habit_list",
      "maestri_ask",
      "maestri_check",
      "maestri_list",
      "maestri_notify",
      "maestri_raw",
      "memory_log",
      "opencode_run",
      "pc_media",
      "pc_open_app",
      "pc_open_url",
      "pc_run",
      "pc_search",
      "reminder_add",
      "reminder_list",
      "vault_list",
      "vault_read",
      "vault_search",
      "vault_stats",
      "vault_write",
      "whatsapp_draft",
      "wiki_lookup",
    ]);
  });

  test("maestri_list returns the CLI output", async () => {
    const client = await connect(fakeMaestri());

    expect(await call(client, "maestri_list")).toEqual({ isError: false, text: "You: Brain\nAgents: OpenCode" });
  });

  test("maestri_ask forwards agent, prompt and timeout", async () => {
    const seen: unknown[] = [];
    const client = await connect(
      fakeMaestri({
        ask: async (...args) => {
          seen.push(args);
          return "ok";
        },
      }),
    );

    const result = await call(client, "maestri_ask", { agent: "OpenCode", prompt: "run tests", timeoutSec: 300 });

    expect(result).toEqual({ isError: false, text: "ok" });
    expect(seen).toEqual([["OpenCode", "run tests", 300]]);
  });

  test("maestri_check returns the agent screen", async () => {
    const client = await connect(fakeMaestri());

    expect(await call(client, "maestri_check", { agent: "OpenCode" })).toEqual({
      isError: false,
      text: "screen of OpenCode",
    });
  });

  test("a CLI failure comes back as a tool error, not a crash", async () => {
    const client = await connect(
      fakeMaestri({
        list: async () => {
          throw new MaestriError("not_found", "maestri não encontrado");
        },
      }),
    );

    expect(await call(client, "maestri_list")).toEqual({ isError: true, text: "maestri não encontrado" });
  });

  test("rejects a timeout above the 10 minute cap", async () => {
    const client = await connect(fakeMaestri());

    const outcome = await call(client, "maestri_ask", { agent: "A", prompt: "p", timeoutSec: 6000 }).catch(() => ({
      isError: true,
    }));

    expect(outcome.isError).toBe(true);
  });

  test("vault_write writes the note inside the vault", async () => {
    const client = await connect(fakeMaestri());

    const result = await call(client, "vault_write", {
      path: "facts/cafe.md",
      content: "Gosta de café.",
      links: ["Lucas"],
    });

    const text = await readFile(join(vaultRoot, "facts/cafe.md"), "utf8");
    expect(result.isError).toBe(false);
    expect(result.text).toMatch(/facts\/cafe\.md/);
    expect(text).toContain("Gosta de café.");
    expect(text).toContain("[[Lucas]]");
  });

  test("vault_write refuses to leave the vault", async () => {
    const client = await connect(fakeMaestri());

    const result = await call(client, "vault_write", { path: "../oops.md", content: "x" });

    expect(result.isError).toBe(true);
    expect(await readdir(vaultRoot)).toEqual([]);
  });
});

describe("MCP server hardening", () => {
  test("does not leak host paths from unexpected errors", async () => {
    const client = await connect(
      fakeMaestri({
        list: async () => {
          throw new Error("EACCES: permission denied, open '/home/u/secret'");
        },
      }),
    );

    const result = await call(client, "maestri_list");

    expect(result.isError).toBe(true);
    expect(result.text).not.toMatch(/\/home\/u/);
  });

  test("vault_write rejects whitespace-only content", async () => {
    const client = await connect(fakeMaestri());

    const outcome = await call(client, "vault_write", { path: "n.md", content: "   \n" }).catch(() => ({
      isError: true,
    }));

    expect(outcome.isError).toBe(true);
    expect(await readdir(vaultRoot)).toEqual([]);
  });
});

describe("loadConfig", () => {
  test("defaults live under the home directory", () => {
    expect(loadConfig({}, "/home/u")).toEqual({
      vaultRoot: "/home/u/pet-vault",
      maestriBin: "maestri",
      opencodeBin: "opencode",
      agentBin: "claude",
      opencodeModel: "opencode/big-pickle",
      stateDir: "/home/u/.local/state/pet-brain",
      configDir: "/home/u/.config/pet-brain",
      hubHost: "127.0.0.1",
      hubPort: 8787,
      allowAnyHost: false,
      petName: "Bit",
      homeDir: "/home/u",
    });
  });

  test("honours the environment", () => {
    const config = loadConfig(
      {
        PET_VAULT_DIR: "/data/vault",
        MAESTRI_CLI: "/opt/maestri/bin/maestri",
        OPENCODE_BIN: "/opt/oc",
        PET_AGENT_BIN: "/opt/claude",
        PET_STATE_DIR: "/data/state",
        PET_CONFIG_DIR: "/data/config",
        PET_HUB_HOST: "100.101.102.103",
        PET_HUB_PORT: "9000",
        PET_HUB_ALLOW_ANY_HOST: "1",
        PET_NAME: "Jarvis",
      },
      "/home/u",
    );

    expect(config).toMatchObject({
      vaultRoot: "/data/vault",
      maestriBin: "/opt/maestri/bin/maestri",
      opencodeBin: "/opt/oc",
      agentBin: "/opt/claude",
      stateDir: "/data/state",
      configDir: "/data/config",
      hubHost: "100.101.102.103",
      hubPort: 9000,
      allowAnyHost: true,
      petName: "Jarvis",
    });
  });

  test.each([
    [{ PET_VAULT_DIR: "vault" }, /PET_VAULT_DIR/],
    [{ PET_STATE_DIR: "state" }, /PET_STATE_DIR/],
    [{ PET_HUB_PORT: "abc" }, /PET_HUB_PORT/],
    [{ PET_HUB_PORT: "70000" }, /PET_HUB_PORT/],
    [{ PET_NAME: "x".repeat(50) }, /PET_NAME/],
  ])("rejects %j", (env, message) => {
    expect(() => loadConfig(env, "/home/u")).toThrow(message);
  });
});
