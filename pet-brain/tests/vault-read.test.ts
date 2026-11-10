import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { appendJournal } from "../src/vault/journal.js";
import { listNotes, readNote, searchNotes, vaultStats } from "../src/vault/read.js";
import { findSecret } from "../src/vault/secrets.js";
import { VaultError, writeNote } from "../src/vault/vault.js";

let vaultRoot: string;
let outside: string;

beforeEach(async () => {
  vaultRoot = await mkdtemp(join(tmpdir(), "pet-vault-"));
  outside = await mkdtemp(join(tmpdir(), "pet-outside-"));
});

afterEach(async () => {
  await rm(vaultRoot, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

const note = (path: string, content: string, links: string[] = []) => writeNote({ vaultRoot, path, content, links });

describe("readNote", () => {
  test("returns the note text", async () => {
    await note("facts/cafe.md", "Gosta de café.");

    const result = await readNote({ vaultRoot, path: "facts/cafe" });

    expect(result.path).toBe("facts/cafe.md");
    expect(result.content).toContain("Gosta de café.");
    expect(result.truncated).toBe(false);
  });

  test("reports a missing note as not_found", async () => {
    await expect(readNote({ vaultRoot, path: "nope.md" })).rejects.toMatchObject({ kind: "not_found" });
  });

  test("reports not_found when the vault does not exist yet", async () => {
    await expect(readNote({ vaultRoot: join(vaultRoot, "missing"), path: "a.md" })).rejects.toMatchObject({
      kind: "not_found",
    });
  });

  test.each(["../x.md", "/etc/passwd", ".obsidian/app.md"])("rejects path %j", async (path) => {
    await expect(readNote({ vaultRoot, path })).rejects.toBeInstanceOf(VaultError);
  });

  test("refuses a symlink that points outside the vault", async () => {
    await writeFile(join(outside, "secret.md"), "segredo", "utf8");
    await symlink(join(outside, "secret.md"), join(vaultRoot, "n.md"));
    await symlink(outside, join(vaultRoot, "dir"));

    await expect(readNote({ vaultRoot, path: "n.md" })).rejects.toBeInstanceOf(VaultError);
    await expect(readNote({ vaultRoot, path: "dir/secret.md" })).rejects.toBeInstanceOf(VaultError);
  });

  test("truncates a huge note", async () => {
    await writeFile(join(vaultRoot, "big.md"), "a".repeat(300 * 1024), "utf8");

    const result = await readNote({ vaultRoot, path: "big.md" });

    expect(result.truncated).toBe(true);
    expect(result.content.length).toBe(256 * 1024);
  });
});

describe("listNotes", () => {
  test("lists markdown notes, skipping hidden folders, symlinks and other files", async () => {
    await note("b.md", "x");
    await note("facts/a.md", "x");
    await mkdir(join(vaultRoot, ".obsidian"));
    await writeFile(join(vaultRoot, ".obsidian/app.md"), "x", "utf8");
    await writeFile(join(vaultRoot, "image.png"), "x", "utf8");
    await writeFile(join(outside, "o.md"), "x", "utf8");
    await symlink(outside, join(vaultRoot, "link"));

    expect(await listNotes(vaultRoot)).toEqual(["b.md", "facts/a.md"]);
  });

  test("returns an empty list when the vault does not exist", async () => {
    expect(await listNotes(join(vaultRoot, "missing"))).toEqual([]);
  });
});

describe("searchNotes", () => {
  test("ranks notes by matches and returns a snippet", async () => {
    await note("facts/cafe.md", "Lucas gosta de café sem açúcar.\nCafé todo dia.");
    await note("facts/cha.md", "Chá só às vezes. Café nunca à noite.");
    await note("facts/outro.md", "Nada a ver.");

    const hits = await searchNotes({ vaultRoot, query: "cafe" });

    expect(hits.map((hit) => hit.path)).toEqual(["facts/cafe.md", "facts/cha.md"]);
    expect(hits[0]?.snippet).toBe("Lucas gosta de café sem açúcar.");
  });

  test("ignores accents and case, and honours the limit", async () => {
    await note("a.md", "AÇÚCAR");
    await note("b.md", "acucar acucar");

    const hits = await searchNotes({ vaultRoot, query: "Açucar", limit: 1 });

    expect(hits.map((hit) => hit.path)).toEqual(["b.md"]);
  });

  test("returns nothing for a blank query", async () => {
    await note("a.md", "x");

    expect(await searchNotes({ vaultRoot, query: "   " })).toEqual([]);
  });
});

describe("vaultStats", () => {
  test("counts notes and links and derives a level", async () => {
    expect(await vaultStats(vaultRoot)).toEqual({ notes: 0, links: 0, level: 1 });

    await note("a.md", "x", ["b", "c"]);
    await note("b.md", "ver [[a]]");

    const stats = await vaultStats(vaultRoot);
    expect(stats.notes).toBe(2);
    expect(stats.links).toBe(3);
    expect(stats.level).toBeGreaterThan(1);
  });
});

describe("appendJournal", () => {
  const at = (hour: number, minute: number) => () => new Date(2026, 10, 9, hour, minute);

  test("creates the day note and appends entries in order", async () => {
    const first = await appendJournal({ vaultRoot, text: "Pediu pizza.", now: at(9, 5) });
    await appendJournal({ vaultRoot, text: "Rodou\nos   testes.", now: at(14, 30) });

    const text = await readFile(join(vaultRoot, "journal/2026-11-09.md"), "utf8");
    expect(first.path).toBe("journal/2026-11-09.md");
    expect(text).toContain("# Diário 2026-11-09\n\n- 09:05 Pediu pizza.\n- 14:30 Rodou os testes.\n");
    expect(text.match(/^---$/gm)).toHaveLength(2);
  });
});

describe("findSecret", () => {
  test.each([
    "minha chave sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAA",
    "ghp_0123456789abcdefghijklmnopqrstuvwxyz",
    "-----BEGIN OPENSSH PRIVATE KEY-----",
    "AKIAIOSFODNN7EXAMPLE",
    "password: hunter2hunter2",
  ])("flags %j", (text) => {
    expect(findSecret(text)).toBeDefined();
  });

  test("lets ordinary text through", () => {
    expect(findSecret("Lucas trocou a senha do wifi ontem e gosta de café.")).toBeUndefined();
  });
});
