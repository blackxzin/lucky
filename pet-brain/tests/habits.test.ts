import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createHabitStore, type HabitStore } from "../src/habits/store.js";
import { call, connect, createSandbox, type Sandbox } from "./helpers.js";

let dir: string;
let clock: Date;
let store: HabitStore;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pet-habits-"));
  clock = new Date(2026, 10, 10, 12, 0, 0);
  store = createHabitStore({ dir, now: () => clock });
});
afterEach(() => rm(dir, { recursive: true, force: true }));

const advance = (minutes: number): void => {
  clock = new Date(clock.getTime() + minutes * 60_000);
};

describe("habit store", () => {
  test("adds a habit that is first due after its interval", async () => {
    const habit = await store.add({ name: "  beber   água ", everyMinutes: 60 });

    expect(habit).toMatchObject({ name: "beber água", everyMinutes: 60, doneToday: 0 });
    expect(await store.takeDue()).toEqual([]);
    advance(61);
    expect((await store.takeDue()).map((item) => item.name)).toEqual(["beber água"]);
  });

  test("delivering reschedules, so it nudges once per interval", async () => {
    await store.add({ name: "alongar", everyMinutes: 30 });
    advance(31);

    expect(await store.takeDue()).toHaveLength(1);
    expect(await store.takeDue()).toEqual([]);
    advance(30);
    expect(await store.takeDue()).toHaveLength(1);
  });

  test("done counts today, postpones the next nudge and resets on a new day", async () => {
    const { id } = await store.add({ name: "água", everyMinutes: 60 });

    advance(50);
    expect(await store.done(id)).toBe(true);
    expect(await store.done(id)).toBe(true);
    expect((await store.list())[0]?.doneToday).toBe(2);
    advance(30); // passou do horário original, mas o "feito" adiou
    expect(await store.takeDue()).toEqual([]);

    advance(24 * 60);
    expect((await store.list())[0]?.doneToday).toBe(0);
  });

  test("stays quiet at night but keeps the schedule moving", async () => {
    await store.add({ name: "água", everyMinutes: 60 });
    clock = new Date(2026, 10, 10, 23, 30, 0);

    expect(await store.takeDue()).toEqual([]);
    clock = new Date(2026, 10, 11, 8, 0, 0);
    expect(await store.takeDue()).toHaveLength(1);
  });

  test("removes a habit and reports a missing one", async () => {
    const { id } = await store.add({ name: "água", everyMinutes: 60 });

    expect(await store.remove(id)).toBe(true);
    expect(await store.remove(id)).toBe(false);
    expect(await store.done(id)).toBe(false);
  });

  test.each([
    [{ name: "", everyMinutes: 60 }, /nome/],
    [{ name: "água", everyMinutes: 2 }, /intervalo/],
    [{ name: "água", everyMinutes: 60 * 25 }, /intervalo/],
    [{ name: "token sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789", everyMinutes: 60 }, /segredo/],
  ])("refuses a bad habit %#", async (input, message) => {
    await expect(store.add(input)).rejects.toThrow(message);
  });

  test("refuses invalid ids without touching the disk", async () => {
    await expect(store.remove("../etc/passwd")).rejects.toThrow(/inválido/);
    await expect(store.done("nope")).rejects.toThrow(/inválido/);
  });
});

describe("habit tools", () => {
  let sandbox: Sandbox;
  beforeEach(async () => {
    sandbox = await createSandbox();
  });
  afterEach(() => sandbox.cleanup());

  test("the pet can create and list habits", async () => {
    const client = await connect(sandbox.deps());

    const created = await call(client, "habit_add", { name: "beber água", everyMinutes: 90 });
    const listed = await call(client, "habit_list");

    expect(created.isError).toBe(false);
    expect(created.text).toContain("a cada 90 min");
    expect(listed.text).toContain("beber água: a cada 90 min, feito 0x hoje");
  });

  test("a too-short interval comes back as an error", async () => {
    const client = await connect(sandbox.deps());

    expect((await call(client, "habit_add", { name: "água", everyMinutes: 1 })).isError).toBe(true);
  });
});
