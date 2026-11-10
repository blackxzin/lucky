import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { UserFacingError } from "../errors.js";

const execFileAsync = promisify(execFile);

const DEFAULT_LIST_TIMEOUT_MS = 15_000;
const DEFAULT_ASK_TIMEOUT_SEC = 120;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const MAX_ERROR_DETAIL_CHARS = 2000;
const MAX_BUFFER_ERROR_CODE = "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";

export type MaestriErrorKind = "not_found" | "timeout" | "failed" | "invalid_argument";

export class MaestriError extends UserFacingError {
  readonly kind: MaestriErrorKind;

  constructor(kind: MaestriErrorKind, message: string) {
    super(message);
    this.kind = kind;
  }
}

export interface CommandResult {
  stdout: string;
  stderr: string;
}

export type CommandRunner = (
  bin: string,
  args: readonly string[],
  opts: { timeoutMs: number },
) => Promise<CommandResult>;

export interface MaestriClient {
  list(): Promise<string>;
  ask(agent: string, prompt: string, timeoutSec?: number): Promise<string>;
  check(agent: string): Promise<string>;
  /** Digita direto no terminal do agente. Quem chama é responsável por aprovar antes. */
  raw(agent: string, input: string): Promise<string>;
  notify(message: string): Promise<string>;
}

export interface MaestriClientOptions {
  bin: string;
  run?: CommandRunner;
  listTimeoutMs?: number;
}

/** Roda o binário direto (sem shell), então nada nos argumentos é interpretado. */
export const execFileRunner: CommandRunner = async (bin, args, opts) => {
  const { stdout, stderr } = await execFileAsync(bin, [...args], {
    timeout: opts.timeoutMs,
    // SIGTERM pode ser ignorado pelo processo; SIGKILL garante que o timeout vale.
    killSignal: "SIGKILL",
    maxBuffer: MAX_OUTPUT_BYTES,
    encoding: "utf8",
  });
  return { stdout, stderr };
};

function assertNotFlag(label: string, value: string): void {
  if (value.trim() === "") {
    throw new MaestriError("invalid_argument", `${label} não pode ser vazio.`);
  }
  if (value.trimStart().startsWith("-")) {
    throw new MaestriError(
      "invalid_argument",
      `${label} não pode começar com "-" (seria lido como flag pelo maestri).`,
    );
  }
}

function field(error: unknown, key: string): unknown {
  return typeof error === "object" && error !== null ? (error as Record<string, unknown>)[key] : undefined;
}

function toMaestriError(error: unknown, bin: string, timeoutMs: number): MaestriError {
  if (error instanceof MaestriError) return error;

  if (field(error, "code") === "ENOENT") {
    return new MaestriError(
      "not_found",
      `CLI do maestri não encontrada ("${bin}"). Rode o pet-brain dentro de um terminal do Maestri ou defina MAESTRI_CLI.`,
    );
  }

  if (field(error, "killed") === true) {
    return new MaestriError(
      "timeout",
      `O maestri não respondeu em ${Math.round(timeoutMs / 1000)}s. NÃO reenvie o prompt: use maestri_check para ver o progresso do agente.`,
    );
  }

  if (field(error, "code") === MAX_BUFFER_ERROR_CODE) {
    return new MaestriError(
      "failed",
      `A saída do maestri passou do limite de ${MAX_OUTPUT_BYTES / 1024}KB. Peça uma resposta mais curta ou use maestri_check.`,
    );
  }

  return new MaestriError(
    "failed",
    `maestri falhou: ${failureDetail(error)}\nRode \`maestri debug\` para ver a causa.`,
  );
}

/** Nunca usa error.message: o execFile coloca os argumentos (o prompt inteiro) nela. */
function failureDetail(error: unknown): string {
  const output = [field(error, "stderr"), field(error, "stdout")].find(
    (text): text is string => typeof text === "string" && text.trim() !== "",
  );
  if (output !== undefined) return output.trim().slice(0, MAX_ERROR_DETAIL_CHARS);

  const code = field(error, "code");
  return typeof code === "number" || typeof code === "string" ? `código de saída ${code}` : "erro desconhecido";
}

export function createMaestriClient(options: MaestriClientOptions): MaestriClient {
  const { bin, run = execFileRunner, listTimeoutMs = DEFAULT_LIST_TIMEOUT_MS } = options;

  const exec = async (args: readonly string[], timeoutMs: number): Promise<string> => {
    try {
      const { stdout } = await run(bin, args, { timeoutMs });
      return stdout;
    } catch (error: unknown) {
      throw toMaestriError(error, bin, timeoutMs);
    }
  };

  return {
    list: () => exec(["list"], listTimeoutMs),

    ask: async (agent, prompt, timeoutSec = DEFAULT_ASK_TIMEOUT_SEC) => {
      assertNotFlag("agent", agent);
      assertNotFlag("prompt", prompt);
      return exec(["ask", agent, prompt], timeoutSec * 1000);
    },

    check: async (agent) => {
      assertNotFlag("agent", agent);
      return exec(["check", agent], listTimeoutMs);
    },

    raw: async (agent, input) => {
      assertNotFlag("agent", agent);
      if (input === "") throw new MaestriError("invalid_argument", "input não pode ser vazio.");
      // O input é o valor de --raw, então pode começar com "-" sem virar flag.
      return exec(["ask", agent, "--raw", input], listTimeoutMs);
    },

    notify: async (message) => {
      assertNotFlag("message", message);
      return exec(["notify", message], listTimeoutMs);
    },
  };
}
