import { join } from "node:path";

export type Risk = "safe" | "confirm" | "danger";

export interface Classification {
  risk: Risk;
  reason: string;
  /** Presente quando o comando roda direto, sem shell. Ausente = precisa de `bash -c`. */
  argv?: string[];
}

/** Caracteres que o shell interpreta fora de aspas. Com qualquer um deles, o comando precisa de shell. */
const SHELL_META = new Set("|&;<>()$`\\\n\r*?[]{}!#~");
/** Dentro de aspas duplas o shell ainda expande estes. */
const DOUBLE_QUOTE_META = new Set("$`\\!");

const DANGER_PATTERNS: readonly RegExp[] = [
  /(?:^|[\s;&|(])(?:rm|rmdir|sudo|doas|su|dd|shred|truncate|kill|pkill|killall|shutdown|reboot|poweroff|halt|systemctl|pacman|yay|paru|apt|apt-get|dnf|chmod|chown|mv|mount|umount|crontab)(?:\s|$)/,
  /(?:^|[\s;&|(])mkfs/,
  /\bgit\s+push\b.*(?:--force|\s-f\b|\s\+)/,
  /\bgit\s+(?:reset\s+--hard|clean)\b/,
  />\s*\/dev\//,
  /\b(?:curl|wget)\b.*\|\s*(?:ba|z|da)?sh\b/,
  /:\(\)\s*\{/,
];

const SENSITIVE_PATH_PATTERN =
  /(?:^|\/)(?:\.ssh|\.gnupg|\.aws|\.kube|\.docker|\.netrc|\.npmrc|\.pgpass|\.env(?:\.[\w.-]+)?|pet-brain|shadow|sudoers|id_[a-z0-9]+|\.?credentials(?:\.\w+)?|hosts\.yml|\.[a-z_]*history|\.claude|\.config\/(?:gh|op)|secrets?(?:\.\w+)?|[\w.-]*token[\w.-]*|[\w.-]*\.pem|[\w.-]*\.key|keyrings?)(?:\/|$)/i;

type ArgsCheck = (args: readonly string[]) => boolean;

const anyArgs: ArgsCheck = () => true;
const noArgs: ArgsCheck = (args) => args.length === 0;
const GIT_READ_SUBCOMMANDS = new Set(["status", "log", "diff", "show"]);
const GIT_WRITE_FLAG = /^(?:--output|-o$|--ext-diff|--textconv)/;
const GREP_RECURSIVE_FLAG = /^(?:-[a-zA-Z]*[rR]|--(?:dereference-)?recursive)/;
const noFlags: ArgsCheck = (args) => args.every((arg) => !arg.startsWith("-"));
const PS_SAFE_ARGS = new Set(["aux", "ux", "-e", "-ef", "-A", "-f"]);

/** Somente leitura. Ficam de fora os que executam ou escrevem via flag (find, rg, tree, env, sed, awk...). */
const SAFE_COMMANDS: ReadonlyMap<string, ArgsCheck> = new Map<string, ArgsCheck>([
  ["ls", anyArgs],
  ["cat", anyArgs],
  ["head", anyArgs],
  ["tail", anyArgs],
  ["wc", anyArgs],
  // `file -C` grava um arquivo compilado; sem flags ele só lê.
  ["file", noFlags],
  ["stat", anyArgs],
  // Recursivo varreria a home inteira (chaves incluídas) sem citar nenhum caminho sensível.
  ["grep", (args) => !args.some((arg) => GREP_RECURSIVE_FLAG.test(arg))],
  ["du", anyArgs],
  ["df", anyArgs],
  ["free", anyArgs],
  ["uname", anyArgs],
  ["which", anyArgs],
  ["echo", anyArgs],
  ["pwd", noArgs],
  ["whoami", noArgs],
  ["id", noArgs],
  ["uptime", noArgs],
  ["hostname", noArgs],
  ["date", (args) => args.every((arg) => arg.startsWith("+"))],
  ["ps", (args) => args.every((arg) => PS_SAFE_ARGS.has(arg))],
  [
    "git",
    ([subcommand, ...rest]) =>
      subcommand !== undefined && GIT_READ_SUBCOMMANDS.has(subcommand) && !rest.some((arg) => GIT_WRITE_FLAG.test(arg)),
  ],
]);

function expandHome(token: string, homeDir: string): string | undefined {
  if (!token.startsWith("~")) return token;
  if (token === "~") return homeDir;
  return token.startsWith("~/") ? join(homeDir, token.slice(2)) : undefined;
}

/** Divide em argumentos como o shell faria, mas só nos casos em que não há nada para o shell interpretar. */
export function tokenize(command: string, homeDir: string): string[] | undefined {
  const tokens: string[] = [];
  let current = "";
  let hasToken = false;
  let isHomeCandidate = false;
  let quote: "'" | '"' | undefined;

  const flush = (): boolean => {
    if (!hasToken) return true;
    const expanded = isHomeCandidate ? expandHome(current, homeDir) : current;
    if (expanded === undefined) return false;
    tokens.push(expanded);
    current = "";
    hasToken = false;
    isHomeCandidate = false;
    return true;
  };

  for (const char of command) {
    if (quote !== undefined) {
      if (char === quote) quote = undefined;
      else if (quote === '"' && DOUBLE_QUOTE_META.has(char)) return undefined;
      else current += char;
    } else if (char === "'" || char === '"') {
      quote = char;
      hasToken = true;
    } else if (char === " " || char === "\t") {
      if (!flush()) return undefined;
    } else if (char === "~" && !hasToken) {
      current += char;
      hasToken = true;
      isHomeCandidate = true;
    } else if (SHELL_META.has(char)) {
      return undefined;
    } else {
      current += char;
      hasToken = true;
    }
  }

  if (quote !== undefined || !flush()) return undefined;
  return tokens;
}

function isSafeArgv(argv: readonly string[]): boolean {
  const [bin, ...args] = argv;
  return bin !== undefined && (SAFE_COMMANDS.get(bin)?.(args) ?? false);
}

export function classifyCommand(command: string, homeDir: string): Classification {
  const argv = tokenize(command, homeDir);
  const runnable = argv !== undefined && argv.length > 0 ? { argv } : {};

  if (DANGER_PATTERNS.some((pattern) => pattern.test(command))) {
    return { risk: "danger", reason: "comando destrutivo ou com privilégio", ...runnable };
  }
  const touchesSensitive = (argv ?? command.split(/\s+/)).some((arg) => SENSITIVE_PATH_PATTERN.test(arg));
  if (touchesSensitive) {
    return { risk: "danger", reason: "mexe em caminho sensível (chaves, tokens, .env)", ...runnable };
  }
  if (argv === undefined) return { risk: "confirm", reason: "usa recursos de shell (pipe, redirecionamento, expansão)" };
  if (argv.length === 0) return { risk: "confirm", reason: "comando vazio" };
  if (!isSafeArgv(argv)) return { risk: "confirm", reason: "fora da lista de comandos somente-leitura", argv };
  return { risk: "safe", reason: "somente leitura", argv };
}

/** Escolha de menu e navegação: dígitos, s/n, Enter, Tab, ESC e setas. Qualquer outra coisa é digitar no terminal. */
const SAFE_RAW_INPUT = /^(?:\d{1,2}|[yYnNsS])?(?:\\e\[[ABCDZ]|\\e|\\t)*(?:\\n)?$/;

export function classifyRawInput(input: string): Classification {
  if (SAFE_RAW_INPUT.test(input)) return { risk: "safe", reason: "tecla de menu" };
  if (DANGER_PATTERNS.some((pattern) => pattern.test(input.replaceAll("\\n", "\n")))) {
    return { risk: "danger", reason: "digita comando destrutivo no terminal" };
  }
  return { risk: "confirm", reason: "digita texto livre no terminal" };
}

/** Um caminho que passa por pasta ou arquivo de segredo (chaves, tokens, estado do próprio pet). */
export function isSensitivePath(path: string): boolean {
  return SENSITIVE_PATH_PATTERN.test(path);
}
