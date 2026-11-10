import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
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

const at = (iso: string) => () => new Date(iso);

describe("writeNote", () => {
  test("creates a note with frontmatter and content, creating folders as needed", async () => {
    const result = await writeNote({
      vaultRoot,
      path: "facts/cafe.md",
      content: "Lucas gosta de café sem açúcar.",
      now: at("2026-11-09T12:00:00.000Z"),
    });

    const text = await readFile(join(vaultRoot, "facts/cafe.md"), "utf8");
    expect(result).toEqual({ path: "facts/cafe.md", created: true });
    expect(text).toBe(
      [
        "---",
        "created: 2026-11-09T12:00:00.000Z",
        "updated: 2026-11-09T12:00:00.000Z",
        "---",
        "",
        "Lucas gosta de café sem açúcar.",
        "",
      ].join("\n"),
    );
  });

  test("adds .md when the path has no extension", async () => {
    const result = await writeNote({ vaultRoot, path: "facts/cafe", content: "x" });

    expect(result.path).toBe("facts/cafe.md");
    expect(await readdir(join(vaultRoot, "facts"))).toEqual(["cafe.md"]);
  });

  test("appends wikilinks to related notes", async () => {
    await writeNote({ vaultRoot, path: "facts/cafe.md", content: "x", links: ["Lucas", "projects/pet-brain"] });

    const text = await readFile(join(vaultRoot, "facts/cafe.md"), "utf8");
    expect(text).toContain("\n## Relacionadas\n\n- [[Lucas]]\n- [[projects/pet-brain]]\n");
  });

  test("keeps the original created date when a note is rewritten", async () => {
    await writeNote({ vaultRoot, path: "n.md", content: "v1", now: at("2026-01-01T00:00:00.000Z") });

    const result = await writeNote({ vaultRoot, path: "n.md", content: "v2", now: at("2026-02-02T00:00:00.000Z") });

    const text = await readFile(join(vaultRoot, "n.md"), "utf8");
    expect(result.created).toBe(false);
    expect(text).toContain("created: 2026-01-01T00:00:00.000Z");
    expect(text).toContain("updated: 2026-02-02T00:00:00.000Z");
    expect(text).toContain("v2");
    expect(text).not.toContain("v1");
  });

  test("leaves no temp files behind", async () => {
    await writeNote({ vaultRoot, path: "n.md", content: "x" });

    expect(await readdir(vaultRoot)).toEqual(["n.md"]);
  });

  test.each(["../escape.md", "a/../../escape.md", "/etc/passwd.md", ""])(
    "rejects path %j that leaves the vault",
    async (path) => {
      await expect(writeNote({ vaultRoot, path, content: "x" })).rejects.toBeInstanceOf(VaultError);
    },
  );

  test("rejects a path that escapes the vault through a symlink", async () => {
    await symlink(outside, join(vaultRoot, "link"));

    await expect(writeNote({ vaultRoot, path: "link/evil.md", content: "x" })).rejects.toBeInstanceOf(VaultError);
    expect(await readdir(outside)).toEqual([]);
  });

  test("rejects writing into Obsidian's config folder", async () => {
    await mkdir(join(vaultRoot, ".obsidian"));

    await expect(writeNote({ vaultRoot, path: ".obsidian/app.md", content: "x" })).rejects.toBeInstanceOf(VaultError);
  });

  test("rejects links that would break out of the wikilink syntax", async () => {
    await expect(writeNote({ vaultRoot, path: "n.md", content: "x", links: ["a]] [[b"] })).rejects.toBeInstanceOf(
      VaultError,
    );
  });
});

describe("writeNote hardening", () => {
  const write = (path: string, text: string) => writeFile(join(vaultRoot, path), text, "utf8");

  test("does not take `created` from the body of a note", async () => {
    await write("n.md", "---\ntitle: x\n---\n\ncreated: FAKE\n---\n");

    await writeNote({ vaultRoot, path: "n.md", content: "v2", now: at("2026-02-02T00:00:00.000Z") });

    expect(await readFile(join(vaultRoot, "n.md"), "utf8")).toContain("created: 2026-02-02T00:00:00.000Z");
  });

  test("keeps `created` from a CRLF note", async () => {
    await write("n.md", "---\r\ncreated: 2026-01-01T00:00:00.000Z\r\n---\r\n\r\nold\r\n");

    await writeNote({ vaultRoot, path: "n.md", content: "v2", now: at("2026-02-02T00:00:00.000Z") });

    expect(await readFile(join(vaultRoot, "n.md"), "utf8")).toContain("created: 2026-01-01T00:00:00.000Z");
  });

  test("ignores a `created` value that is not a date", async () => {
    await write("n.md", "---\ncreated: banana\n---\n");

    await writeNote({ vaultRoot, path: "n.md", content: "v2", now: at("2026-02-02T00:00:00.000Z") });

    expect(await readFile(join(vaultRoot, "n.md"), "utf8")).toContain("created: 2026-02-02T00:00:00.000Z");
  });

  test("stays fast on a huge unterminated frontmatter", async () => {
    await write("n.md", "---\n" + "created: x\n".repeat(20_000));
    const started = Date.now();

    await writeNote({ vaultRoot, path: "n.md", content: "v2" });

    expect(Date.now() - started).toBeLessThan(500);
  });

  test("refuses to read through a symlink at the note path", async () => {
    await writeFile(join(outside, "secret.md"), "---\ncreated: 2020-01-01T00:00:00.000Z\n---\n", "utf8");
    await symlink(join(outside, "secret.md"), join(vaultRoot, "n.md"));

    await expect(writeNote({ vaultRoot, path: "n.md", content: "x" })).rejects.toBeInstanceOf(VaultError);
    expect(await readFile(join(outside, "secret.md"), "utf8")).toContain("2020-01-01");
  });

  test("rejects a visible symlink that points into a hidden folder", async () => {
    await mkdir(join(vaultRoot, ".obsidian"));
    await symlink(join(vaultRoot, ".obsidian"), join(vaultRoot, "notes"));

    await expect(writeNote({ vaultRoot, path: "notes/app.md", content: "x" })).rejects.toBeInstanceOf(VaultError);
    expect(await readdir(join(vaultRoot, ".obsidian"))).toEqual([]);
  });

  test.each(["a/../.obsidian/x.md", ".md", "a\0b.md"])("rejects path %j", async (path) => {
    await expect(writeNote({ vaultRoot, path, content: "x" })).rejects.toBeInstanceOf(VaultError);
  });
});
