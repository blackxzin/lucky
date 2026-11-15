import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import type { ClipboardStore } from "./store.js";

const RESTART_MS = 5000;
const MAX_CLIP_BYTES = 4000;

/**
 * O wl-paste roda este script a cada cópia, com o conteúdo na entrada. Quem copia de gerenciador de senhas
 * (marca passwordManagerHint) é ignorado; o resto sai em base64, uma linha por cópia, para não quebrar com quebras de linha.
 */
const WATCH_SCRIPT = `if wl-paste --list-types 2>/dev/null | grep -qi passwordmanagerhint; then exit 0; fi; head -c ${String(MAX_CLIP_BYTES)} | base64 -w0; echo`;

export interface ClipboardWatch {
  stop(): void;
}

/** Vigia a área de transferência (Wayland, via wl-paste) e guarda cada cópia de texto no histórico do dono. */
export function startClipboardWatch(options: {
  store: ClipboardStore;
  logError: (message: string, error: unknown) => void;
  spawnProcess?: typeof spawn;
}): ClipboardWatch {
  const { store, logError, spawnProcess = spawn } = options;
  let child: ChildProcess | undefined;
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;

  const start = (): void => {
    const proc = spawnProcess("wl-paste", ["--type", "text", "--watch", "sh", "-c", WATCH_SCRIPT], { stdio: ["ignore", "pipe", "ignore"] });
    child = proc;
    if (proc.stdout !== null) {
      createInterface({ input: proc.stdout }).on("line", (line) => {
        const text = Buffer.from(line.trim(), "base64").toString("utf8");
        store.add(text).catch((error: unknown) => logError("falha ao guardar a cópia", error));
      });
    }
    proc.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        stopped = true;
        logError("histórico de cópias desligado: wl-paste (wl-clipboard) não está instalado", error);
      }
    });
    proc.on("exit", () => {
      if (!stopped) timer = setTimeout(start, RESTART_MS);
    });
  };

  start();
  return {
    stop: () => {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
      child?.kill();
    },
  };
}
