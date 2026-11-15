import { ProcError, type ProcessRunner } from "../proc/run.js";

export const MEDIA_ACTIONS = ["status", "play-pause", "next", "previous", "volume-up", "volume-down"] as const;
export type MediaAction = (typeof MEDIA_ACTIONS)[number];

export type MediaStatus =
  | { available: false }
  | { available: true; playing: boolean; title: string; artist: string; volume: number };

export type MediaController = (action: MediaAction) => Promise<MediaStatus>;

const PLAYERCTL = "playerctl";
const TIMEOUT_MS = 2000;
const VOLUME_STEP = "0.05";
const MAX_FIELD_CHARS = 200;
const FIELD_SEPARATOR = "\t";

/** Comandos fixos: o pedido do cliente só escolhe uma destas chaves, nunca monta argumento. */
const ACTION_ARGS: Readonly<Record<Exclude<MediaAction, "status">, readonly string[]>> = {
  "play-pause": ["play-pause"],
  next: ["next"],
  previous: ["previous"],
  "volume-up": ["volume", `${VOLUME_STEP}+`],
  "volume-down": ["volume", `${VOLUME_STEP}-`],
};

const clean = (text: string | undefined): string => (text ?? "").trim().slice(0, MAX_FIELD_CHARS);

/** Controla o player de música do PC (MPRIS) pelo playerctl. Sem player ou sem playerctl, responde "indisponível". */
export function createMedia(deps: { run: ProcessRunner }): MediaController {
  const playerctl = (args: readonly string[]) => deps.run(PLAYERCTL, args, { timeoutMs: TIMEOUT_MS });

  const readStatus = async (): Promise<MediaStatus> => {
    const meta = await playerctl(["metadata", "--format", `{{status}}${FIELD_SEPARATOR}{{title}}${FIELD_SEPARATOR}{{artist}}`]);
    if (meta.exitCode !== 0) return { available: false };
    const [status, title, artist] = meta.stdout.split(FIELD_SEPARATOR);
    const level = await playerctl(["volume"]);
    const volume = Number.parseFloat(level.stdout);
    return {
      available: true,
      playing: clean(status) === "Playing",
      title: clean(title),
      artist: clean(artist),
      volume: Number.isFinite(volume) ? Math.min(1, Math.max(0, volume)) : 0,
    };
  };

  return async (action) => {
    try {
      if (action !== "status") await playerctl(ACTION_ARGS[action]);
      return await readStatus();
    } catch (error) {
      if (error instanceof ProcError) return { available: false };
      throw error;
    }
  };
}
