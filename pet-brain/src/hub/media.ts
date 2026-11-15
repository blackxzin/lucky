import { ProcError, type ProcessRunner } from "../proc/run.js";

export const MEDIA_ACTIONS = ["status", "play-pause", "next", "previous", "volume-up", "volume-down", "shuffle", "loop"] as const;
export type MediaAction = (typeof MEDIA_ACTIONS)[number];

export type LoopMode = "none" | "track" | "playlist";

export type MediaStatus =
  | { available: false }
  | {
      available: true;
      playing: boolean;
      title: string;
      artist: string;
      volume: number;
      /** Segundos já tocados e duração total (0 quando o player não informa). */
      position: number;
      length: number;
      /** Só https ou file: qualquer outra coisa vira vazio. A UI busca a capa por aqui. */
      artUrl: string;
      shuffle: boolean;
      loop: LoopMode;
    };

export type MediaController = (action: MediaAction) => Promise<MediaStatus>;

const PLAYERCTL = "playerctl";
const TIMEOUT_MS = 2000;
const VOLUME_STEP = "0.05";
const MAX_FIELD_CHARS = 200;
const MAX_ART_URL_CHARS = 600;
const MICROS_PER_SECOND = 1_000_000;
const FIELD_SEPARATOR = "\t";
const METADATA_FORMAT = ["{{status}}", "{{title}}", "{{artist}}", "{{mpris:artUrl}}", "{{mpris:length}}", "{{position}}"].join(FIELD_SEPARATOR);

/** Comandos fixos: o pedido do cliente só escolhe uma destas chaves, nunca monta argumento. */
const ACTION_ARGS: Readonly<Record<Exclude<MediaAction, "status" | "loop">, readonly string[]>> = {
  "play-pause": ["play-pause"],
  next: ["next"],
  previous: ["previous"],
  "volume-up": ["volume", `${VOLUME_STEP}+`],
  "volume-down": ["volume", `${VOLUME_STEP}-`],
  shuffle: ["shuffle", "Toggle"],
};

/** Ciclo do botão de repetir: nada → lista → faixa → nada. */
const NEXT_LOOP: Readonly<Record<LoopMode, string>> = { none: "Playlist", playlist: "Track", track: "None" };

const clean = (text: string | undefined): string => (text ?? "").trim().slice(0, MAX_FIELD_CHARS);

const parseLoop = (text: string): LoopMode => {
  const value = text.trim().toLowerCase();
  return value === "track" || value === "playlist" ? value : "none";
};

const seconds = (micros: string | undefined): number => {
  const value = Number.parseInt((micros ?? "").trim(), 10);
  return Number.isFinite(value) && value > 0 ? Math.round(value / MICROS_PER_SECOND) : 0;
};

const safeArtUrl = (text: string | undefined): string => {
  const url = (text ?? "").trim();
  return url.length <= MAX_ART_URL_CHARS && (url.startsWith("https://") || url.startsWith("file://")) ? url : "";
};

/** Controla o player de música do PC (MPRIS) pelo playerctl. Sem player ou sem playerctl, responde "indisponível". */
export function createMedia(deps: { run: ProcessRunner }): MediaController {
  const playerctl = (args: readonly string[]) => deps.run(PLAYERCTL, args, { timeoutMs: TIMEOUT_MS });

  const readLoop = async (): Promise<LoopMode> => parseLoop((await playerctl(["loop"])).stdout);

  const readStatus = async (): Promise<MediaStatus> => {
    const meta = await playerctl(["metadata", "--format", METADATA_FORMAT]);
    if (meta.exitCode !== 0) return { available: false };
    const [status, title, artist, artUrl, length, position] = meta.stdout.split(FIELD_SEPARATOR);
    const [level, shuffle, loop] = await Promise.all([playerctl(["volume"]), playerctl(["shuffle"]), readLoop()]);
    const volume = Number.parseFloat(level.stdout);
    return {
      available: true,
      playing: clean(status) === "Playing",
      title: clean(title),
      artist: clean(artist),
      volume: Number.isFinite(volume) ? Math.min(1, Math.max(0, volume)) : 0,
      position: seconds(position),
      length: seconds(length),
      artUrl: safeArtUrl(artUrl),
      shuffle: shuffle.stdout.trim().toLowerCase() === "on",
      loop,
    };
  };

  return async (action) => {
    try {
      if (action === "loop") await playerctl(["loop", NEXT_LOOP[await readLoop()]]);
      else if (action !== "status") await playerctl(ACTION_ARGS[action]);
      return await readStatus();
    } catch (error) {
      if (error instanceof ProcError) return { available: false };
      throw error;
    }
  };
}
