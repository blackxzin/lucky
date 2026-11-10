import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { loadConfig } from "../src/config.js";
import { startHub } from "../src/hub/run.js";

const OWNER_ONLY = 0o600;
const UI_DIR = join(import.meta.dirname, "..", "ui");

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });
}

describe("startHub (smoke)", () => {
  let home: string;
  let url: string;
  let configDir: string;
  let stateDir: string;

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), "pet-run-"));
    configDir = join(home, "config");
    stateDir = join(home, "state");
    const config = loadConfig(
      {
        PET_VAULT_DIR: join(home, "vault"),
        PET_STATE_DIR: stateDir,
        PET_CONFIG_DIR: configDir,
        PET_HUB_PORT: String(await freePort()),
      },
      home,
    );
    url = await startHub(config, { entry: join(home, "index.js"), uiDir: UI_DIR });
  });

  afterAll(() => rm(home, { recursive: true, force: true }));

  test("serves the UI on the loopback address it reports", async () => {
    const response = await fetch(url);

    expect(url.startsWith("http://127.0.0.1:")).toBe(true);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("<title>Pet</title>");
  });

  test("creates a token readable only by the owner and demands it on /api/pending", async () => {
    const token = (await readFile(join(configDir, "token"), "utf8")).trim();

    expect((await stat(join(configDir, "token"))).mode & 0o777).toBe(OWNER_ONLY);
    expect((await fetch(`${url}/api/pending`)).status).toBe(401);
    const authorized = await fetch(`${url}/api/pending`, { headers: { Authorization: `Bearer ${token}` } });
    expect(authorized.status).toBe(200);
    expect(await authorized.json()).toMatchObject({ approvals: [], busy: false });
  });

  test("writes the agent configs private to the owner and without the token", async () => {
    const token = (await readFile(join(configDir, "token"), "utf8")).trim();

    for (const file of [join(stateDir, "mcp.json"), join(stateDir, "agent-cwd", "opencode.json")]) {
      expect((await stat(file)).mode & 0o777).toBe(OWNER_ONLY);
      expect(await readFile(file, "utf8")).not.toContain(token);
    }
  });
});
