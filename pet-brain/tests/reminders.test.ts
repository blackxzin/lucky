import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createAuditLog } from "../src/pc/audit.js";
import { createReminderStore, ReminderError } from "../src/reminders/store.js";
import { maybeWriteDigest } from "../src/vault/digest.js";
import { readNote } from "../src/vault/read.js";
import { call, connect, createSandbox, type Sandbox } from "./helpers.js";

const NOW = new Date("2026-11-10T12:00:00.000Z");
const minutes = (count: number): Date => new Date(NOW.getTime() + count * 60_000);

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pet-rem-"));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

describe("reminder store", () => {
  const store = () => createReminderStore({ dir: join(dir, "reminders"), now: () => NOW });

  test("lists pending reminders by due time", async () => {
    const reminders = store();
    await reminders.add({ text: "depois", dueAt: minutes(30) });
    await reminders.add({ text: "antes", dueAt: minutes(5) });

    expect((await reminders.list()).map((item) => item.text)).toEqual(["antes", "depois"]);
  });

  test("cancels a pending reminder by id", async () => {
    const reminders = store();
    const keep = await reminders.add({ text: "fica", dueAt: minutes(10) });
    const drop = await reminders.add({ text: "sai", dueAt: minutes(5) });

    expect(await reminders.remove(drop.id)).toBe(true);

    expect((await reminders.list()).map((item) => item.id)).toEqual([keep.id]);
    expect(await reminders.remove(drop.id)).toBe(false);
  });

  test("refuses an id that is not a reminder id", async () => {
    await expect(store().remove("../../etc/passwd")).rejects.toThrow(ReminderError);
  });

  test("hands out a due reminder exactly once", async () => {
    const reminders = store();
    await reminders.add({ text: "agua", dueAt: minutes(1) });
    const later = createReminderStore({ dir: join(dir, "reminders"), now: () => minutes(2) });

    expect((await later.takeDue()).map((item) => item.text)).toEqual(["agua"]);
    expect(await later.takeDue()).toEqual([]);
    expect(await later.list()).toEqual([]);
  });

  test("keeps reminders that are not due yet", async () => {
    const reminders = store();
    await reminders.add({ text: "futuro", dueAt: minutes(60) });

    expect(await reminders.takeDue()).toEqual([]);
    expect(await reminders.list()).toHaveLength(1);
  });

  test.each([
    ["past time", { text: "x", dueAt: minutes(-1) }, /futuro/],
    ["empty text", { text: "  ", dueAt: minutes(5) }, /texto/],
    ["long text", { text: "a".repeat(201), dueAt: minutes(5) }, /texto/],
    ["too far away", { text: "x", dueAt: minutes(60 * 24 * 400) }, /1 ano/],
    ["a secret", { text: "token: abcdefgh12345678", dueAt: minutes(5) }, /segredo/i],
  ])("rejects %s", async (_label, input, message) => {
    await expect(store().add(input)).rejects.toThrow(message);
    await expect(store().add(input)).rejects.toBeInstanceOf(ReminderError);
  });

  test("refuses to pile up reminders without limit", async () => {
    const reminders = store();
    for (let index = 0; index < 100; index += 1) await reminders.add({ text: `r${index}`, dueAt: minutes(5 + index) });

    await expect(reminders.add({ text: "extra", dueAt: minutes(500) })).rejects.toThrow(/lembretes/);
  });

  test("ignores files that are not reminders", async () => {
    const reminders = store();
    await reminders.add({ text: "ok", dueAt: minutes(5) });
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(dir, "reminders", "lixo.json"), "{nao e json");

    expect((await reminders.list()).map((item) => item.text)).toEqual(["ok"]);
  });
});

describe("reminder tools", () => {
  let sandbox: Sandbox;
  beforeEach(async () => {
    sandbox = await createSandbox();
  });
  afterEach(() => sandbox.cleanup());

  test("reminder_add schedules and reminder_list shows it", async () => {
    const client = await connect(sandbox.deps());

    const added = await call(client, "reminder_add", { text: "tomar água", inMinutes: 10 });
    const listed = await call(client, "reminder_list");

    expect(added.isError).toBe(false);
    expect(listed.text).toContain("tomar água");
  });

  test("needs exactly one of inMinutes or at", async () => {
    const client = await connect(sandbox.deps());

    expect((await call(client, "reminder_add", { text: "x" })).isError).toBe(true);
    expect((await call(client, "reminder_add", { text: "x", inMinutes: 5, at: "2099-01-01T10:00:00-03:00" })).isError).toBe(true);
  });

  test("at needs a time zone, so the time is never guessed", async () => {
    const client = await connect(sandbox.deps());

    const result = await call(client, "reminder_add", { text: "x", at: "2099-01-01T10:00:00" });

    expect(result.isError).toBe(true);
  });
});

describe("daily digest", () => {
  const FIRST_DAY = new Date(2026, 10, 9, 15, 0, 0);
  const NEXT_DAY = new Date(2026, 10, 10, 9, 0, 0);

  test("writes counts per tool for yesterday and never copies action text", async () => {
    const audit = createAuditLog({ path: join(dir, "audit.log"), now: () => FIRST_DAY });
    await audit.record({ tool: "pc_run", action: "ls /secreto-do-dono", decision: "auto" });
    await audit.record({ tool: "pc_run", action: "rm x", decision: "requested" });
    await audit.record({ tool: "maestri_ask", action: "pergunta", decision: "sent" });

    const written = await maybeWriteDigest({ audit, vaultRoot: join(dir, "vault"), now: () => NEXT_DAY });

    expect(written).toBe(true);
    const note = await readNote({ vaultRoot: join(dir, "vault"), path: "journal/2026-11-09-resumo.md" });
    expect(note.content).toContain("pc_run");
    expect(note.content).toContain("pc_run (auto): 1");
    expect(note.content).toContain("pc_run (requested): 1");
    expect(note.content).not.toContain("secreto-do-dono");
  });

  test("does nothing twice and does nothing on a quiet day", async () => {
    const audit = createAuditLog({ path: join(dir, "audit.log"), now: () => FIRST_DAY });
    const options = { audit, vaultRoot: join(dir, "vault"), now: () => NEXT_DAY };
    expect(await maybeWriteDigest(options)).toBe(false);

    await audit.record({ tool: "pc_run", action: "ls", decision: "auto" });
    expect(await maybeWriteDigest(options)).toBe(true);
    expect(await maybeWriteDigest(options)).toBe(false);
  });
});

describe("audit tail and ranges", () => {
  test("recent reads only the tail of a big log and never returns a half line", async () => {
    const path = join(dir, "audit.log");
    const audit = createAuditLog({ path, now: () => NOW });
    const filler = "x".repeat(1500);
    for (let index = 0; index < 400; index += 1) await audit.record({ tool: `t${index}`, action: filler, decision: "auto" });

    const recent = await audit.recent(10_000);

    expect(recent.length).toBeGreaterThan(10);
    expect(recent.length).toBeLessThan(400);
    expect(recent.at(-1)?.tool).toBe("t399");
    expect(recent.every((entry) => entry.tool.startsWith("t"))).toBe(true);
  });

  test("keeps approvalId and skips corrupt or wrongly shaped lines", async () => {
    const path = join(dir, "audit.log");
    await writeFile(
      path,
      [
        "{not json",
        JSON.stringify({ ts: "2026-11-10T10:00:00.000Z", tool: "pc_run", decision: "weird" }),
        JSON.stringify({ ts: "2026-11-10T10:00:01.000Z", tool: "pc_run", action: "ls", decision: "granted", approvalId: "abc" }),
        "",
      ].join("\n"),
    );

    const records = await createAuditLog({ path }).recent(10);

    expect(records).toEqual([{ ts: "2026-11-10T10:00:01.000Z", tool: "pc_run", action: "ls", decision: "granted", approvalId: "abc" }]);
  });

  test("between returns only entries inside the range", async () => {
    const path = join(dir, "audit.log");
    const lines = ["09:00", "10:00", "11:00"].map((time) =>
      JSON.stringify({ ts: `2026-11-10T${time}:00.000Z`, tool: time, action: "", decision: "auto" }),
    );
    await writeFile(path, `${lines.join("\n")}\n`);

    const records = await createAuditLog({ path }).between(new Date("2026-11-10T10:00:00.000Z"), new Date("2026-11-10T11:00:00.000Z"));

    expect(records.map((entry) => entry.tool)).toEqual(["10:00"]);
  });

  test("between on a missing file is empty", async () => {
    expect(await createAuditLog({ path: join(dir, "nada.log") }).between(new Date(0), new Date())).toEqual([]);
  });
});

describe("reminder store errors", () => {
  test("a reminder that cannot be read is an error, not a silent skip", async () => {
    const store = createReminderStore({ dir: join(dir, "rem"), now: () => NOW });
    const reminder = await store.add({ text: "x", dueAt: new Date(NOW.getTime() + 60_000) });
    await chmod(join(dir, "rem", `${reminder.id}.json`), 0o000);

    await expect(store.list()).rejects.toThrow();

    await chmod(join(dir, "rem", `${reminder.id}.json`), 0o600);
  });

  test("a stray file in the folder is ignored", async () => {
    const store = createReminderStore({ dir: join(dir, "rem2"), now: () => NOW });
    await store.add({ text: "ok", dueAt: new Date(NOW.getTime() + 60_000) });
    await writeFile(join(dir, "rem2", "lixo.json"), "{ nao e json");

    expect((await store.list()).map((entry) => entry.text)).toEqual(["ok"]);
  });
});

describe("audit recent", () => {
  test("returns the last entries, newest last, and survives a missing file", async () => {
    const audit = createAuditLog({ path: join(dir, "audit.log"), now: () => NOW });
    expect(await audit.recent(5)).toEqual([]);

    for (const tool of ["a", "b", "c"]) await audit.record({ tool, action: "x", decision: "auto" });

    expect((await audit.recent(2)).map((entry) => entry.tool)).toEqual(["b", "c"]);
  });
});
