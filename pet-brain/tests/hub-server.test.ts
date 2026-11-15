import { request as httpRequest } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import WebSocket from "ws";
import type { HubCore, HubEvent, HubSnapshot } from "../src/hub/core.js";
import { buildMcpConfig } from "../src/hub/mcp-config.js";
import { createHubServer, type HubServer } from "../src/hub/server.js";
import { loadConfig } from "../src/config.js";
import { UserFacingError } from "../src/errors.js";

const TOKEN = "a".repeat(64);

const SNAPSHOT: HubSnapshot = {
  state: { name: "Bit", busy: false, stats: { notes: 2, links: 1, level: 1 }, approvals: [], brain: null, reminders: 0 },
  history: [{ role: "pet", text: "oi", ts: "2026-11-09T00:00:00.000Z" }],
};

interface FakeCore extends HubCore {
  chats: string[];
  decisions: Array<[string, boolean]>;
  refreshes: number;
  reminderCalls: string[];
  habitCalls: string[];
  emit(event: HubEvent): void;
}

function fakeCore(): FakeCore {
  let listeners: Array<(event: HubEvent) => void> = [];
  const core: FakeCore = {
    chats: [],
    decisions: [],
    refreshes: 0,
    reminderCalls: [],
    habitCalls: [],
    listHabits: async () => [{ id: "b".repeat(16), name: "beber água", everyMinutes: 60, nextAt: "2026-11-10T13:00:00.000Z", doneToday: 2 }],
    addHabit: async (name, everyMinutes) => void core.habitCalls.push(`add:${name}:${everyMinutes}`),
    doneHabit: async (id) => void core.habitCalls.push(`done:${id}`),
    removeHabit: async (id) => void core.habitCalls.push(`remove:${id}`),
    listReminders: async () => [{ id: "a".repeat(16), text: "água", dueAt: "2026-11-10T12:30:00.000Z" }],
    addReminder: async (text, inMinutes) => void core.reminderCalls.push(`add:${text}:${inMinutes}`),
    cancelReminder: async (id) => void core.reminderCalls.push(`cancel:${id}`),
    emit: (event) => listeners.forEach((listener) => listener(event)),
    chat: async (text) => void core.chats.push(text),
    decide: async (id, approved) => void core.decisions.push([id, approved]),
    refresh: async () => {
      core.refreshes += 1;
    },
    tick: async () => undefined,
    snapshot: async () => SNAPSHOT,
    subscribe: (listener) => {
      listeners = [...listeners, listener];
      return () => {
        listeners = listeners.filter((current) => current !== listener);
      };
    },
  };
  return core;
}

let uiDir: string;
let core: FakeCore;
let server: HubServer;
let port: number;
let clock: number;
const sockets: WebSocket[] = [];

async function start(overrides: Partial<Parameters<typeof createHubServer>[0]> = {}): Promise<void> {
  server = createHubServer({
    core,
    token: TOKEN,
    uiDir,
    host: "127.0.0.1",
    port: 0,
    pollMs: 20,
    authTimeoutMs: 80,
    now: () => clock,
    ...overrides,
  });
  port = await server.listen();
}

interface Client {
  socket: WebSocket;
  next(): Promise<Record<string, unknown>>;
  closed: Promise<number>;
}

function open(headers: Record<string, string> = {}): Promise<Client> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers });
    sockets.push(socket);
    const queue: Array<Record<string, unknown>> = [];
    const waiters: Array<(message: Record<string, unknown>) => void> = [];
    socket.on("message", (data) => {
      const message = JSON.parse(String(data)) as Record<string, unknown>;
      const waiter = waiters.shift();
      if (waiter !== undefined) waiter(message);
      else queue.push(message);
    });
    const closed = new Promise<number>((done) => socket.on("close", (code) => done(code)));
    socket.on("open", () =>
      resolve({
        socket,
        closed,
        next: () => {
          const ready = queue.shift();
          return ready !== undefined ? Promise.resolve(ready) : new Promise((take) => waiters.push(take));
        },
      }),
    );
    socket.on("error", reject);
  });
}

async function authed(): Promise<Client> {
  const client = await open();
  client.socket.send(JSON.stringify({ type: "auth", token: TOKEN }));
  expect((await client.next()).type).toBe("hello");
  return client;
}

const get = (path: string, init: RequestInit = {}) => fetch(`http://127.0.0.1:${port}${path}`, init);

beforeEach(async () => {
  uiDir = await mkdtemp(join(tmpdir(), "pet-ui-"));
  await writeFile(join(uiDir, "index.html"), "<!doctype html><title>pet</title>");
  await writeFile(join(uiDir, "app.js"), "// app");
  await writeFile(join(uiDir, "style.css"), "body{}");
  await writeFile(join(uiDir, "secret.txt"), "nope");
  core = fakeCore();
  clock = 1_000_000;
});

afterEach(async () => {
  sockets.splice(0).forEach((socket) => socket.terminate());
  await server.close();
  await rm(uiDir, { recursive: true, force: true });
});

describe("hub http", () => {
  test("serves the UI with strict headers", async () => {
    await start();

    const response = await get("/");

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("<title>pet</title>");
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(response.headers.get("content-security-policy")).toContain("default-src 'self'");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  test("serves only the whitelisted assets", async () => {
    await start();

    expect((await get("/app.js")).headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect((await get("/style.css")).status).toBe(200);
    expect((await get("/secret.txt")).status).toBe(404);
    expect((await get("/..%2Fpackage.json")).status).toBe(404);
    expect((await get("/app.js?x=1")).status).toBe(200);
  });

  test("never serves the token and rejects other methods", async () => {
    await start();

    expect((await get("/token")).status).toBe(404);
    expect((await get("/", { method: "POST" })).status).toBe(405);
  });
});

function getWithHost(path: string, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, path, headers: { Host: host } }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", reject);
    req.end();
  });
}

describe("hub host check (DNS rebinding)", () => {
  test("serves only the configured host names", async () => {
    await start();

    expect(await getWithHost("/", `127.0.0.1:${port}`)).toBe(200);
    expect(await getWithHost("/", `localhost:${port}`)).toBe(200);
    expect(await getWithHost("/", `evil.example:${port}`)).toBe(421);
  });

  test("refuses the websocket for a foreign Host even with a matching Origin", async () => {
    await start();

    await expect(open({ Host: "evil.example", Origin: "http://evil.example" })).rejects.toThrow(/421/);
  });

  test("CSP pins websocket traffic to the same origin", async () => {
    await start();

    const csp = (await get("/")).headers.get("content-security-policy") ?? "";

    expect(csp).toContain("connect-src 'self'");
    expect(csp).not.toMatch(/\bws:|\bwss:/);
  });
});

describe("hub websocket", () => {
  test("greets an authenticated client with the snapshot", async () => {
    await start();
    const client = await open();

    client.socket.send(JSON.stringify({ type: "auth", token: TOKEN }));

    expect(await client.next()).toEqual({ type: "hello", ...SNAPSHOT });
  });

  test("closes a client that sends the wrong token", async () => {
    await start();
    const client = await open();

    client.socket.send(JSON.stringify({ type: "auth", token: "b".repeat(64) }));

    expect(await client.closed).toBe(4401);
  });

  test("closes a client that never authenticates", async () => {
    await start();

    expect(await (await open()).closed).toBe(4401);
  });

  test("an idle unauthenticated socket counts as a failed attempt", async () => {
    await start({ authTimeoutMs: 20 });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await (await open()).closed;
    }

    await expect(open()).rejects.toThrow(/429/);
  });

  test("limits unauthenticated sockets per address so they cannot fill the hub", async () => {
    await start({ authTimeoutMs: 5000 });
    await open();
    await open();

    await expect(open()).rejects.toThrow(/429/);
  });

  test("ignores chat before authentication", async () => {
    await start();
    const client = await open();

    client.socket.send(JSON.stringify({ type: "chat", text: "rm -rf" }));

    expect(await client.closed).toBe(4401);
    expect(core.chats).toEqual([]);
  });

  test("locks an address out after repeated bad tokens, then lets it back", async () => {
    // Prazo longo: sob carga o prazo de 80ms vence antes da mensagem chegar e a mesma tentativa contaria duas vezes.
    await start({ authTimeoutMs: 5000 });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const client = await open();
      client.socket.send(JSON.stringify({ type: "auth", token: "wrong" }));
      await client.closed;
    }

    await expect(open()).rejects.toThrow(/429/);

    clock += 61_000;
    await authed();
  });

  test("forwards chat and decisions to the core", async () => {
    await start();
    const client = await authed();

    client.socket.send(JSON.stringify({ type: "chat", text: "oi" }));
    client.socket.send(JSON.stringify({ type: "decide", id: "0123456789abcdef", approved: true }));
    client.socket.send(JSON.stringify({ type: "ping" }));

    expect(await client.next()).toEqual({ type: "pong" });
    expect(core.chats).toEqual(["oi"]);
    expect(core.decisions).toEqual([["0123456789abcdef", true]]);
  });

  test("answers garbage with an error and keeps the connection", async () => {
    await start();
    const client = await authed();

    client.socket.send("not json");
    client.socket.send(JSON.stringify({ type: "decide", id: "../../etc", approved: true }));

    expect((await client.next()).type).toBe("error");
    expect((await client.next()).type).toBe("error");
    expect(core.decisions).toEqual([]);
  });

  test("broadcasts core events to authenticated clients only", async () => {
    await start();
    const client = await authed();
    const stranger = await open();
    const received: unknown[] = [];
    stranger.socket.on("message", (data) => received.push(String(data)));

    core.emit({ type: "message", message: { role: "pet", text: "pronto", ts: "t" } });

    expect(await client.next()).toEqual({ type: "message", message: { role: "pet", text: "pronto", ts: "t" } });
    expect(received).toEqual([]);
  });

  test("polls for new approvals while someone is connected", async () => {
    await start();
    await authed();

    await new Promise((resolve) => setTimeout(resolve, 70));

    expect(core.refreshes).toBeGreaterThan(0);
  });

  test("rejects a page from another origin", async () => {
    await start();

    await expect(open({ Origin: "http://evil.example" })).rejects.toThrow(/403/);
    await authedFrom({ Origin: `http://127.0.0.1:${port}` });
  });

  test("rejects other paths", async () => {
    await start();

    await expect(
      new Promise((resolve, reject) => {
        const socket = new WebSocket(`ws://127.0.0.1:${port}/other`);
        sockets.push(socket);
        socket.on("open", resolve);
        socket.on("error", reject);
      }),
    ).rejects.toThrow(/404/);
  });
});

async function authedFrom(headers: Record<string, string>): Promise<void> {
  const client = await open(headers);
  client.socket.send(JSON.stringify({ type: "auth", token: TOKEN }));
  expect((await client.next()).type).toBe("hello");
}

describe("mcp config for the agent", () => {
  test("points the agent at this same pet-brain build with the same folders", () => {
    const config = loadConfig({ PET_VAULT_DIR: "/data/vault", MAESTRI_CLI: "/opt/maestri" }, "/home/u");

    expect(buildMcpConfig(config, { node: "/usr/bin/node", entry: "/app/dist/index.js" })).toEqual({
      mcpServers: {
        "pet-brain": {
          command: "/usr/bin/node",
          args: ["/app/dist/index.js"],
          env: {
            PET_VAULT_DIR: "/data/vault",
            PET_STATE_DIR: "/home/u/.local/state/pet-brain",
            MAESTRI_CLI: "/opt/maestri",
            OPENCODE_BIN: "opencode",
          },
        },
      },
    });
  });
});

describe("hub pending-approvals endpoint (for the phone notification)", () => {
  const PENDING = {
    id: "a1b2c3d4e5f60718",
    tool: "pc_run",
    action: "rm -rf /segredo-do-dono",
    risk: "danger" as const,
    reason: "apaga arquivos",
    expiresAt: "2026-11-10T00:10:00.000Z",
  };

  function api(headers: Record<string, string> = {}, method = "GET", query = ""): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const req = httpRequest({ host: "127.0.0.1", port, path: `/api/pending${query}`, method, headers }, (res) => {
        let body = "";
        res.on("data", (chunk: Buffer) => (body += String(chunk)));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      });
      req.on("error", reject);
      req.end();
    });
  }

  const bearer = (token: string): Record<string, string> => ({ Authorization: `Bearer ${token}` });

  beforeEach(async () => {
    core.snapshot = async () => ({ ...SNAPSHOT, state: { ...SNAPSHOT.state, approvals: [PENDING] } });
    await start();
  });

  test("answers with ids and risk only, never the action text", async () => {
    const response = await api(bearer(TOKEN));

    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({
      approvals: [{ id: PENDING.id, tool: "pc_run", risk: "danger" }],
      busy: false,
      sig: `0:${PENDING.id}`,
    });
    expect(response.body).not.toContain("segredo-do-dono");
  });

  test.each([
    ["no token", {}],
    ["a wrong token", bearer("b".repeat(64))],
    ["a token in the wrong scheme", { Authorization: TOKEN }],
  ])("refuses %s", async (_label, headers) => {
    const response = await api(headers);

    expect(response.status).toBe(401);
    expect(response.body).not.toContain(PENDING.id);
  });

  test("locks the address out after repeated wrong tokens", async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) await api(bearer("c".repeat(64)));

    expect((await api(bearer(TOKEN))).status).toBe(429);
  });

  test("accepts only GET", async () => {
    expect((await api(bearer(TOKEN), "POST")).status).toBe(405);
  });

  describe("long-poll with ?since=", () => {
    const stateWith = (busy: boolean): HubSnapshot["state"] => ({ ...SNAPSHOT.state, busy, approvals: [PENDING] });

    beforeEach(async () => {
      await server.close();
      await start({ pendingWaitMs: 300 });
    });

    test("answers at once when the state already differs from the client's", async () => {
      const response = await api(bearer(TOKEN), "GET", "?since=stale");

      expect(JSON.parse(response.body).busy).toBe(false);
    });

    test("holds the request and answers when the state changes", async () => {
      const waiting = api(bearer(TOKEN), "GET", `?since=0:${PENDING.id}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
      core.emit({ type: "state", state: stateWith(true) });

      expect(JSON.parse((await waiting).body)).toMatchObject({ busy: true, sig: `1:${PENDING.id}` });
    });

    test("answers with the same state when nothing changes before the wait ends", async () => {
      const started = Date.now();
      const response = await api(bearer(TOKEN), "GET", `?since=0:${PENDING.id}`);

      expect(Date.now() - started).toBeGreaterThanOrEqual(250);
      expect(JSON.parse(response.body).sig).toBe(`0:${PENDING.id}`);
    });

    test("still refuses a wrong token without waiting", async () => {
      const started = Date.now();
      const response = await api(bearer("d".repeat(64)), "GET", `?since=0:${PENDING.id}`);

      expect(response.status).toBe(401);
      expect(Date.now() - started).toBeLessThan(250);
    });
  });
});

describe("hub devices", () => {
  async function authedAs(device: string): Promise<Client> {
    const client = await open();
    client.socket.send(JSON.stringify({ type: "auth", token: TOKEN, device }));
    expect((await client.next()).type).toBe("hello");
    return client;
  }

  test("announces which devices are connected", async () => {
    await start();
    const pc = await authedAs("pc");
    expect(await pc.next()).toEqual({ type: "peers", devices: ["pc"] });

    const phone = await authedAs("phone");

    expect(await phone.next()).toEqual({ type: "peers", devices: ["pc", "phone"] });
    expect(await pc.next()).toEqual({ type: "peers", devices: ["pc", "phone"] });
    phone.socket.close();
    expect(await pc.next()).toEqual({ type: "peers", devices: ["pc"] });
  });

  test("relays a signal to the other devices but not back to the sender", async () => {
    await start();
    const pc = await authedAs("pc");
    await pc.next();
    const phone = await authedAs("phone");
    await phone.next();
    await pc.next();

    phone.socket.send(JSON.stringify({ type: "signal", kind: "poke" }));

    expect(await pc.next()).toEqual({ type: "signal", kind: "poke", from: "phone" });
    phone.socket.send(JSON.stringify({ type: "ping" }));
    expect((await phone.next()).type).toBe("pong");
  });

  test("relays a scare to the other device", async () => {
    await start();
    const pc = await authedAs("pc");
    await pc.next();
    const phone = await authedAs("phone");
    await phone.next();
    await pc.next();

    pc.socket.send(JSON.stringify({ type: "signal", kind: "scare" }));

    expect(await phone.next()).toEqual({ type: "signal", kind: "scare", from: "pc" });
  });

  test("tells every device who is asleep, and clears it when they wake or leave", async () => {
    await start();
    const pc = await authedAs("pc");
    await pc.next();
    const phone = await authedAs("phone");
    await phone.next();
    await pc.next();

    phone.socket.send(JSON.stringify({ type: "sleep", asleep: true }));
    expect(await pc.next()).toEqual({ type: "asleep", devices: ["phone"] });
    expect(await phone.next()).toEqual({ type: "asleep", devices: ["phone"] });

    phone.socket.send(JSON.stringify({ type: "sleep", asleep: false }));
    expect(await pc.next()).toEqual({ type: "asleep", devices: [] });
    await phone.next();

    phone.socket.send(JSON.stringify({ type: "sleep", asleep: true }));
    await pc.next();
    await phone.next();
    phone.socket.close();
    expect(await pc.next()).toEqual({ type: "peers", devices: ["pc"] });
    expect(await pc.next()).toEqual({ type: "asleep", devices: [] });
  });

  test("ignores a sleep report from a socket that never said which device it is", async () => {
    await start();
    const anonymous = await open();
    anonymous.socket.send(JSON.stringify({ type: "auth", token: TOKEN }));
    await anonymous.next();

    anonymous.socket.send(JSON.stringify({ type: "sleep", asleep: true }));
    anonymous.socket.send(JSON.stringify({ type: "ping" }));

    expect((await anonymous.next()).type).toBe("pong");
  });

  test("rejects an unknown signal or device name", async () => {
    await start();
    const client = await authedAs("pc");
    await client.next();

    client.socket.send(JSON.stringify({ type: "signal", kind: "explode" }));

    expect((await client.next()).type).toBe("error");
    const bad = await open();
    bad.socket.send(JSON.stringify({ type: "auth", token: TOKEN, device: "../etc" }));
    expect(await bad.closed).toBe(4401);
  });

  test("answers media requests through the injected controller", async () => {
    const calls: string[] = [];
    await start({
      media: async (action) => {
        calls.push(action);
        return { available: true, playing: true, title: "One For The Road", artist: "Arctic Monkeys", volume: 0.6 };
      },
    });
    const client = await authedAs("pc");
    await client.next();

    client.socket.send(JSON.stringify({ type: "media", action: "next" }));

    expect(await client.next()).toEqual({
      type: "media",
      available: true,
      playing: true,
      title: "One For The Road",
      artist: "Arctic Monkeys",
      volume: 0.6,
    });
    expect(calls).toEqual(["next"]);
  });

  test("refuses media when no controller is configured or the action is unknown", async () => {
    await start();
    const client = await authedAs("pc");
    await client.next();

    client.socket.send(JSON.stringify({ type: "media", action: "status" }));
    expect((await client.next()).type).toBe("error");
    client.socket.send(JSON.stringify({ type: "media", action: "rm -rf" }));
    expect((await client.next()).type).toBe("error");
  });
});

describe("hub reminders", () => {
  async function authedClient(): Promise<Client> {
    const client = await open();
    client.socket.send(JSON.stringify({ type: "auth", token: TOKEN }));
    expect((await client.next()).type).toBe("hello");
    return client;
  }

  test("lists the pending reminders on request", async () => {
    await start();
    const client = await authedClient();

    client.socket.send(JSON.stringify({ type: "reminders" }));

    expect(await client.next()).toEqual({
      type: "reminders",
      items: [{ id: "a".repeat(16), text: "água", dueAt: "2026-11-10T12:30:00.000Z" }],
    });
  });

  test("adds and cancels through the core", async () => {
    await start();
    const client = await authedClient();

    client.socket.send(JSON.stringify({ type: "reminder_add", text: "água", inMinutes: 30 }));
    client.socket.send(JSON.stringify({ type: "reminder_cancel", id: "b".repeat(16) }));
    client.socket.send(JSON.stringify({ type: "ping" }));

    expect((await client.next()).type).toBe("pong");
    expect(core.reminderCalls).toEqual(["add:água:30", "cancel:" + "b".repeat(16)]);
  });

  test("rejects malformed reminder requests", async () => {
    await start();
    const client = await authedClient();

    client.socket.send(JSON.stringify({ type: "reminder_add", text: "x", inMinutes: 0 }));
    expect((await client.next()).type).toBe("error");
    client.socket.send(JSON.stringify({ type: "reminder_cancel", id: "../x" }));
    expect((await client.next()).type).toBe("error");
  });

  test("tells the sender when the core refuses a reminder", async () => {
    await start();
    core.addReminder = async () => Promise.reject(new UserFacingError("Lembrete no passado."));
    const client = await authedClient();

    client.socket.send(JSON.stringify({ type: "reminder_add", text: "x", inMinutes: 5 }));

    expect(await client.next()).toEqual({ type: "error", text: "Lembrete no passado." });
  });
});

describe("hub habits", () => {
  async function authedClient(): Promise<Client> {
    const client = await open();
    client.socket.send(JSON.stringify({ type: "auth", token: TOKEN }));
    expect((await client.next()).type).toBe("hello");
    return client;
  }

  test("lists the habits on request", async () => {
    await start();
    const client = await authedClient();

    client.socket.send(JSON.stringify({ type: "habits" }));

    expect(await client.next()).toMatchObject({ type: "habits", items: [{ name: "beber água", doneToday: 2 }] });
  });

  test("changes go through the core and every client gets the fresh list", async () => {
    await start();
    const first = await authedClient();
    const second = await authedClient();

    first.socket.send(JSON.stringify({ type: "habit_add", name: "alongar", everyMinutes: 45 }));

    expect((await first.next()).type).toBe("habits");
    expect((await second.next()).type).toBe("habits");
    first.socket.send(JSON.stringify({ type: "habit_done", id: "b".repeat(16) }));
    first.socket.send(JSON.stringify({ type: "habit_remove", id: "b".repeat(16) }));
    expect((await first.next()).type).toBe("habits");
    expect((await first.next()).type).toBe("habits");
    expect(core.habitCalls).toEqual(["add:alongar:45", "done:" + "b".repeat(16), "remove:" + "b".repeat(16)]);
  });

  test("rejects malformed habit requests", async () => {
    await start();
    const client = await authedClient();

    client.socket.send(JSON.stringify({ type: "habit_add", name: "x", everyMinutes: 1 }));
    expect((await client.next()).type).toBe("error");
    client.socket.send(JSON.stringify({ type: "habit_done", id: "../x" }));
    expect((await client.next()).type).toBe("error");
  });
});
