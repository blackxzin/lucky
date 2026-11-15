import { readFile, realpath, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";

/** Lê a capa do álbum que o player deixou em disco e devolve como data URL, ou undefined se não for seguro. */
export type MediaArtReader = (url: string) => Promise<string | undefined>;

const MAX_ART_BYTES = 3 * 1024 * 1024;

const sniffType = (bytes: Buffer): string | undefined => {
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return "image/jpeg";
  if (bytes.subarray(0, 4).toString("latin1") === "RIFF" && bytes.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  if (bytes.subarray(0, 4).toString("latin1") === "GIF8") return "image/gif";
  return undefined;
};

const isInside = (child: string, parent: string): boolean => child === parent || child.startsWith(parent.endsWith("/") ? parent : `${parent}/`);

/**
 * Só abre file: dentro das pastas permitidas (temporários do navegador, runtime, cache), de verdade (após resolver
 * links), com tamanho limitado e só se os primeiros bytes forem mesmo de imagem. Nunca devolve texto de outro arquivo.
 */
export function createMediaArt(allowedDirs: readonly string[]): MediaArtReader {
  let last: { url: string; data: string } | undefined;

  const resolveAllowed = async (): Promise<string[]> => {
    const real = await Promise.all(allowedDirs.map((dir) => realpath(dir).catch(() => undefined)));
    return real.filter((dir): dir is string => dir !== undefined);
  };

  return async (url) => {
    if (last?.url === url) return last.data;
    if (!url.startsWith("file://")) return undefined;
    try {
      const path = await realpath(fileURLToPath(url));
      if (!(await resolveAllowed()).some((dir) => isInside(path, dir))) return undefined;
      const info = await stat(path);
      if (!info.isFile() || info.size > MAX_ART_BYTES) return undefined;
      const bytes = await readFile(path);
      const type = sniffType(bytes);
      if (type === undefined) return undefined;
      const data = `data:${type};base64,${bytes.toString("base64")}`;
      last = { url, data };
      return data;
    } catch {
      return undefined;
    }
  };
}
