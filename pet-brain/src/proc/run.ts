import { spawn } from "node:child_process";
import { UserFacingError } from "../errors.js";

const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;

export class ProcError extends UserFacingError {
  readonly kind: "not_found";

  constructor(bin: string) {
    super(`Programa não encontrado: "${bin}".`);
    this.kind = "not_found";
  }
}

export interface ProcessResult {
  /** `null` se o processo foi morto (timeout ou excesso de saída). */
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
}

export interface ProcessOptions {
  timeoutMs: number;
  cwd?: string;
  /** Texto enviado no stdin. Usado para prompts, que assim nunca viram argumento. */
  input?: string;
  maxOutputBytes?: number;
  /** Variáveis somadas ao ambiente do filho. */
  env?: Readonly<Record<string, string>>;
}

export type ProcessRunner = (bin: string, args: readonly string[], opts: ProcessOptions) => Promise<ProcessResult>;

/** Roda o binário direto, sem shell. Timeout e excesso de saída matam o grupo inteiro com SIGKILL. */
export const spawnRunner: ProcessRunner = (bin, args, opts) =>
  new Promise((resolve, reject) => {
    const limit = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    // detached: o filho vira líder de grupo, então o kill alcança também os netos (ex.: bash -c).
    const child = spawn(bin, [...args], {
      cwd: opts.cwd,
      env: opts.env === undefined ? process.env : { ...process.env, ...opts.env },
      detached: true, stdio: ["pipe", "pipe", "pipe"] });

    const chunks: { stdout: Buffer[]; stderr: Buffer[] } = { stdout: [], stderr: [] };
    let received = 0;
    let timedOut = false;
    let truncated = false;

    const killGroup = (): void => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };

    const collect = (stream: "stdout" | "stderr") => (chunk: Buffer) => {
      const room = limit - received;
      if (room <= 0) return;
      chunks[stream].push(chunk.subarray(0, room));
      received += chunk.length;
      if (received >= limit) {
        truncated = true;
        killGroup();
      }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killGroup();
    }, opts.timeoutMs);

    child.stdout.on("data", collect("stdout"));
    child.stderr.on("data", collect("stderr"));
    // Um filho que fecha o stdin cedo gera EPIPE; não é erro nosso.
    child.stdin.on("error", () => undefined);
    child.stdin.end(opts.input ?? "");

    child.on("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(error.code === "ENOENT" ? new ProcError(bin) : error);
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        exitCode: timedOut || truncated ? null : code,
        stdout: Buffer.concat(chunks.stdout).toString("utf8"),
        stderr: Buffer.concat(chunks.stderr).toString("utf8"),
        timedOut,
        truncated,
      });
    });
  });
