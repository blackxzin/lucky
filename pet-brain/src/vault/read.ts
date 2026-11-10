import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  assertRealPathInside,
  isHiddenName,
  isMissing,
  NOTE_EXTENSION,
  readRegularFile,
  resolveNotePath,
  splitFrontmatter,
  VaultError,
} from "./paths.js";

export const MAX_NOTE_READ_BYTES = 256 * 1024;
const MAX_NOTES = 5000;
const MAX_QUERY_TERMS = 10;
const MAX_TERM_HITS = 20;
const PATH_MATCH_BONUS = 5;
const MAX_SNIPPET_CHARS = 200;
const DEFAULT_SEARCH_LIMIT = 10;
const WIKILINK_PATTERN = /\[\[[^\]\n]+\]\]/g;
const XP_PER_NOTE = 10;
const XP_PER_LINK = 3;
const XP_LEVEL_SCALE = 20;

export interface ReadNoteResult {
  path: string;
  content: string;
  truncated: boolean;
}

export interface SearchHit {
  path: string;
  score: number;
  snippet: string;
}

export interface VaultStats {
  /** Notas = neurônios. */
  notes: number;
  /** Wikilinks = sinapses. */
  links: number;
  level: number;
}

export async function readNote(input: { vaultRoot: string; path: string }): Promise<ReadNoteResult> {
  const { absolute, relativePath } = resolveNotePath(input.vaultRoot, input.path);
  const notFound = new VaultError(`Nota não encontrada: ${input.path}`, "not_found");

  try {
    await assertRealPathInside(input.vaultRoot, dirname(absolute), input.path);
  } catch (error: unknown) {
    throw isMissing(error) ? notFound : error;
  }

  const file = await readRegularFile(absolute, input.path, MAX_NOTE_READ_BYTES);
  if (file === undefined) throw notFound;
  return { path: relativePath, content: file.text, truncated: file.truncated };
}

async function walk(directory: string, prefix: string): Promise<string[]> {
  const entries = (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => !isHiddenName(entry.name) && !entry.isSymbolicLink())
    .sort((a, b) => a.name.localeCompare(b.name));

  const found: string[][] = [];
  for (const entry of entries) {
    const relativePath = `${prefix}${entry.name}`;
    if (entry.isDirectory()) found.push(await walk(join(directory, entry.name), `${relativePath}/`));
    else if (entry.isFile() && entry.name.endsWith(NOTE_EXTENSION)) found.push([relativePath]);
  }
  return found.flat();
}

/** Caminhos relativos de todas as notas, sem entrar em pastas ocultas nem seguir symlinks. */
export async function listNotes(vaultRoot: string): Promise<string[]> {
  try {
    return (await walk(vaultRoot, "")).sort().slice(0, MAX_NOTES);
  } catch (error: unknown) {
    if (isMissing(error)) return [];
    throw error;
  }
}

async function readAll(vaultRoot: string): Promise<Array<{ path: string; text: string }>> {
  const notes: Array<{ path: string; text: string }> = [];
  for (const path of await listNotes(vaultRoot)) {
    const file = await readRegularFile(join(vaultRoot, path), path, MAX_NOTE_READ_BYTES);
    if (file !== undefined) notes.push({ path, text: file.text });
  }
  return notes;
}

function fold(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  for (let at = haystack.indexOf(needle); at !== -1 && count < MAX_TERM_HITS; at = haystack.indexOf(needle, at + needle.length)) {
    count += 1;
  }
  return count;
}

function scoreNote(path: string, body: string, terms: readonly string[]): number {
  const foldedBody = fold(body);
  const foldedPath = fold(path);
  return terms.reduce(
    (score, term) => score + countOccurrences(foldedBody, term) + (foldedPath.includes(term) ? PATH_MATCH_BONUS : 0),
    0,
  );
}

function snippetFor(body: string, terms: readonly string[]): string {
  const line = body.split("\n").find((candidate) => terms.some((term) => fold(candidate).includes(term)));
  return (line ?? "").trim().slice(0, MAX_SNIPPET_CHARS);
}

export async function searchNotes(input: { vaultRoot: string; query: string; limit?: number }): Promise<SearchHit[]> {
  const terms = [...new Set(fold(input.query).split(/\s+/).filter((term) => term !== ""))].slice(0, MAX_QUERY_TERMS);
  if (terms.length === 0) return [];

  return (await readAll(input.vaultRoot))
    .map(({ path, text }) => {
      const { body } = splitFrontmatter(text);
      return { path, score: scoreNote(path, body, terms), snippet: snippetFor(body, terms) };
    })
    .filter((hit) => hit.score > 0)
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .slice(0, input.limit ?? DEFAULT_SEARCH_LIMIT);
}

export function levelFor(notes: number, links: number): number {
  const xp = notes * XP_PER_NOTE + links * XP_PER_LINK;
  return 1 + Math.floor(Math.sqrt(xp / XP_LEVEL_SCALE));
}

export async function vaultStats(vaultRoot: string): Promise<VaultStats> {
  const notes = await readAll(vaultRoot);
  const links = notes.reduce((total, note) => total + (note.text.match(WIKILINK_PATTERN)?.length ?? 0), 0);
  return { notes: notes.length, links, level: levelFor(notes.length, links) };
}
