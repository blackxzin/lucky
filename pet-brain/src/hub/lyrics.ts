import { z } from "zod";

export interface LyricLine {
  /** Segundo em que a linha começa. */
  t: number;
  text: string;
}

export interface LyricsResult {
  synced: LyricLine[] | null;
  plain: string | null;
}

export interface LyricsQuery {
  title: string;
  artist: string;
  duration: number;
}

export type LyricsReader = (query: LyricsQuery) => Promise<LyricsResult>;

const LRCLIB_URL = "https://lrclib.net/api/get";
const TIMEOUT_MS = 5000;
const MAX_LYRICS_CHARS = 60_000;
const NONE: LyricsResult = { synced: null, plain: null };

const responseSchema = z.object({ syncedLyrics: z.string().nullish(), plainLyrics: z.string().nullish() });

const LRC_LINE = /^\[(\d{1,3}):(\d{2}(?:\.\d{1,3})?)\]\s*(.*)$/;

/** Letra com horário ([mm:ss.xx] texto) vira linhas em ordem; o que não casar com o formato é ignorado. */
export function parseLrc(text: string): LyricLine[] {
  const lines: LyricLine[] = [];
  for (const raw of text.split("\n")) {
    const match = LRC_LINE.exec(raw.trim());
    if (match === null) continue;
    lines.push({ t: Number(match[1]) * 60 + Number(match[2]), text: (match[3] ?? "").trim() });
  }
  return lines.sort((a, b) => a.t - b.t);
}

/**
 * Busca a letra no LRCLIB (serviço público, sem chave). Só título, artista e duração saem do PC, para um host fixo.
 * Qualquer falha (rede, 404, formato estranho) vira "sem letra": a aba de música nunca quebra por isso.
 */
export function createLyrics(deps: { fetch?: typeof fetch } = {}): LyricsReader {
  const fetchFn = deps.fetch ?? fetch;
  let last: { key: string; result: LyricsResult } | undefined;

  return async ({ title, artist, duration }) => {
    const key = `${title}\u0000${artist}\u0000${String(duration)}`;
    if (last?.key === key) return last.result;
    const params = new URLSearchParams({ track_name: title, artist_name: artist });
    if (duration > 0) params.set("duration", String(duration));
    let result = NONE;
    try {
      const response = await fetchFn(`${LRCLIB_URL}?${params.toString()}`, { signal: AbortSignal.timeout(TIMEOUT_MS), redirect: "error" });
      if (response.ok) {
        const parsed = responseSchema.safeParse(await response.json());
        if (parsed.success) {
          const synced = parsed.data.syncedLyrics ? parseLrc(parsed.data.syncedLyrics.slice(0, MAX_LYRICS_CHARS)) : [];
          const plain = parsed.data.plainLyrics?.trim().slice(0, MAX_LYRICS_CHARS) ?? "";
          result = { synced: synced.length > 0 ? synced : null, plain: plain === "" ? null : plain };
        }
      }
    } catch {
      result = NONE;
    }
    last = { key, result };
    return result;
  };
}
