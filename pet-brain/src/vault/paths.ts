import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { UserFacingError } from "../errors.js";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";

export const NOTE_EXTENSION = ".md";
export const FRONTMATTER_FENCE = "---";
const MAX_FRONTMATTER_LINES = 200;

export type VaultErrorKind = "invalid" | "not_found";

export class VaultError extends UserFacingError {
  readonly kind: VaultErrorKind;

  constructor(message: string, kind: VaultErrorKind = "invalid") {
    super(message);
    this.kind = kind;
  }
}

export function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

export function isInside(root: string, target: string): boolean {
  return target === root || target.startsWith(root + sep);
}

export function isHiddenName(name: string): boolean {
  return name.startsWith(".");
}

function assertNotHidden(segments: readonly string[], notePath: string): void {
  if (segments.some(isHiddenName)) {
    throw new VaultError(`Pastas e arquivos ocultos (ex.: .obsidian) não são acessíveis: ${notePath}`);
  }
}

export function resolveNotePath(vaultRoot: string, notePath: string): { absolute: string; relativePath: string } {
  if (notePath.trim() === "") throw new VaultError("O caminho da nota não pode ser vazio.");
  if (notePath.includes("\0")) throw new VaultError("O caminho da nota contém caractere inválido.");
  if (isAbsolute(notePath)) throw new VaultError("O caminho da nota deve ser relativo ao cofre.");

  const withExtension = extname(notePath) === NOTE_EXTENSION ? notePath : `${notePath}${NOTE_EXTENSION}`;
  const root = resolve(vaultRoot);
  const absolute = resolve(root, withExtension);
  if (!isInside(root, absolute) || absolute === root) {
    throw new VaultError(`Caminho fora do cofre: ${notePath}`);
  }

  const relativePath = relative(root, absolute).split(sep).join("/");
  assertNotHidden(relativePath.split("/"), notePath);
  return { absolute, relativePath };
}

/** Confere o caminho real: um symlink dentro do cofre não pode levar pra fora nem pra pasta oculta. */
export async function assertRealPathInside(vaultRoot: string, directory: string, notePath: string): Promise<void> {
  const [realRoot, realDirectory] = await Promise.all([realpath(vaultRoot), realpath(directory)]);
  if (!isInside(realRoot, realDirectory)) {
    throw new VaultError(`Caminho fora do cofre (symlink): ${notePath}`);
  }
  assertNotHidden(relative(realRoot, realDirectory).split(sep), notePath);
}

export interface BoundedText {
  text: string;
  truncated: boolean;
}

/** Lê no máximo `maxBytes` de um arquivo comum, sem seguir symlink. `undefined` se ele não existe. */
export async function readRegularFile(
  absolute: string,
  notePath: string,
  maxBytes: number,
): Promise<BoundedText | undefined> {
  try {
    const stats = await lstat(absolute);
    if (!stats.isFile()) {
      throw new VaultError(`Já existe algo nesse caminho que não é um arquivo comum: ${notePath}`);
    }
    const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const { buffer, bytesRead } = await handle.read(Buffer.alloc(maxBytes), 0, maxBytes, 0);
      return { text: buffer.subarray(0, bytesRead).toString("utf8"), truncated: stats.size > maxBytes };
    } finally {
      await handle.close();
    }
  } catch (error: unknown) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

export interface ParsedNote {
  /** Linhas entre as cercas `---`; vazio se a nota não tem frontmatter. */
  frontmatter: readonly string[];
  body: string;
}

/** Parser por linhas (limitado), tolera CRLF. Sem cerca de fechamento, tudo é corpo. */
export function splitFrontmatter(text: string): ParsedNote {
  const head = text.split(/\r?\n/, MAX_FRONTMATTER_LINES + 1);
  if (head[0] !== FRONTMATTER_FENCE) return { frontmatter: [], body: text };
  const end = head.indexOf(FRONTMATTER_FENCE, 1);
  if (end === -1) return { frontmatter: [], body: text };

  const body = text.split(/\r?\n/).slice(end + 1).join("\n");
  return { frontmatter: head.slice(1, end), body };
}
