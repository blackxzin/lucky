import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  assertRealPathInside,
  isInside,
  isMissing,
  readRegularFile,
  resolveNotePath,
  splitFrontmatter,
  VaultError,
} from "./paths.js";

export { VaultError } from "./paths.js";

const CREATED_LINE_PATTERN = /^created: (\S+)\s*$/;
const MAX_HEAD_BYTES = 64 * 1024;
const UNSAFE_LINK_PATTERN = /[[\]|\n\r]/;

export interface WriteNoteInput {
  vaultRoot: string;
  /** Caminho relativo ao cofre, ex.: "facts/cafe.md". */
  path: string;
  content: string;
  /** Nomes de notas relacionadas; viram [[wikilinks]]. */
  links?: readonly string[];
  now?: () => Date;
}

export interface WriteNoteResult {
  path: string;
  created: boolean;
}

function extractCreated(head: string): string | undefined {
  const value = splitFrontmatter(head)
    .frontmatter.map((line) => CREATED_LINE_PATTERN.exec(line)?.[1])
    .find((match) => match !== undefined);
  return value !== undefined && !Number.isNaN(Date.parse(value)) ? value : undefined;
}

function renderNote(content: string, links: readonly string[], created: string, updated: string): string {
  const frontmatter = ["---", `created: ${created}`, `updated: ${updated}`, "---", ""];
  const body = [content.trim(), ""];
  const related = links.length > 0 ? ["## Relacionadas", "", ...links.map((link) => `- [[${link}]]`), ""] : [];
  return [...frontmatter, ...body, ...related].join("\n");
}

export async function writeNote(input: WriteNoteInput): Promise<WriteNoteResult> {
  const { vaultRoot, content, links = [], now = () => new Date() } = input;

  const unsafeLink = links.find((link) => link.trim() === "" || UNSAFE_LINK_PATTERN.test(link));
  if (unsafeLink !== undefined) {
    throw new VaultError(`Link inválido: ${JSON.stringify(unsafeLink)}`);
  }

  const { absolute, relativePath } = resolveNotePath(vaultRoot, input.path);
  const directory = dirname(absolute);

  // Valida o trecho que já existe antes do mkdir, pra não criar pastas através de um symlink.
  await mkdir(vaultRoot, { recursive: true });
  await assertExistingAncestorInside(vaultRoot, directory, input.path);
  await mkdir(directory, { recursive: true });
  await assertRealPathInside(vaultRoot, directory, input.path);

  const existingHead = await readRegularFile(absolute, input.path, MAX_HEAD_BYTES);
  const timestamp = now().toISOString();
  const created = (existingHead === undefined ? undefined : extractCreated(existingHead.text)) ?? timestamp;

  const temporary = join(directory, `.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, renderNote(content, links, created, timestamp), { encoding: "utf8", flag: "wx" });
    await rename(temporary, absolute);
  } catch (error: unknown) {
    await rm(temporary, { force: true });
    throw error;
  }

  return { path: relativePath, created: existingHead === undefined };
}

async function assertExistingAncestorInside(vaultRoot: string, directory: string, notePath: string): Promise<void> {
  const root = resolve(vaultRoot);
  let current = directory;
  while (isInside(root, current)) {
    try {
      await assertRealPathInside(vaultRoot, current, notePath);
      return;
    } catch (error: unknown) {
      if (!isMissing(error)) throw error;
      current = dirname(current);
    }
  }
}
