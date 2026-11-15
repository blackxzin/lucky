import { isAbsolute, join } from "node:path";

const DEFAULT_HUB_PORT = 8787;
const MAX_PORT = 65_535;
const MAX_PET_NAME_CHARS = 24;

export interface Config {
  vaultRoot: string;
  maestriBin: string;
  opencodeBin: string;
  /** CLI do agente que pensa pelo pet no hub (Claude Code). */
  agentBin: string;
  /** Modelo do OpenCode que assume o chat quando o Claude falha (provider/modelo). */
  opencodeModel: string;
  /** Aprovações e log de auditoria. Fora do cofre, para o modelo não ler nem escrever. */
  stateDir: string;
  /** Token do hub. */
  configDir: string;
  hubHost: string;
  hubPort: number;
  allowAnyHost: boolean;
  petName: string;
  homeDir: string;
  /** Lugar do tempo (ex.: "Fortaleza"). Sem ele o pet não adivinha onde o dono mora. */
  weatherPlace: string | undefined;
  /** Histórico do que o dono copia: desligado por padrão (PET_CLIPBOARD=1 liga). */
  clipboardEnabled: boolean;
}

type Env = Readonly<Record<string, string | undefined>>;

function nonEmpty(value: string | undefined): string | undefined {
  return value !== undefined && value.trim() !== "" ? value : undefined;
}

function absoluteDir(env: Env, key: string, fallback: string): string {
  const value = nonEmpty(env[key]) ?? fallback;
  if (!isAbsolute(value)) throw new Error(`${key} precisa ser um caminho absoluto (recebido: "${value}").`);
  return value;
}

function port(env: Env): number {
  const raw = nonEmpty(env.PET_HUB_PORT);
  if (raw === undefined) return DEFAULT_HUB_PORT;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > MAX_PORT) {
    throw new Error(`PET_HUB_PORT precisa ser uma porta entre 1 e ${MAX_PORT} (recebido: "${raw}").`);
  }
  return value;
}

function petName(env: Env): string {
  const name = (nonEmpty(env.PET_NAME) ?? "Bit").trim();
  if (name.length > MAX_PET_NAME_CHARS || /[\n\r]/.test(name)) {
    throw new Error(`PET_NAME precisa ter até ${MAX_PET_NAME_CHARS} caracteres, em uma linha.`);
  }
  return name;
}

const MAX_PLACE_CHARS = 60;

function weatherPlace(env: Env): string | undefined {
  const place = nonEmpty(env.PET_WEATHER_PLACE)?.trim();
  if (place === undefined) return undefined;
  if (place.length > MAX_PLACE_CHARS || /[\n\r]/.test(place)) {
    throw new Error(`PET_WEATHER_PLACE precisa ter até ${MAX_PLACE_CHARS} caracteres, em uma linha.`);
  }
  return place;
}

const MODEL_PATTERN = /^[a-z0-9][\w.-]*\/[\w.:/-]+$/i;
const DEFAULT_OPENCODE_MODEL = "opencode/big-pickle";

function opencodeModel(env: Env): string {
  const model = nonEmpty(env.PET_OPENCODE_MODEL) ?? DEFAULT_OPENCODE_MODEL;
  if (!MODEL_PATTERN.test(model)) throw new Error(`PET_OPENCODE_MODEL precisa ser provider/modelo (recebido: "${model}").`);
  return model;
}

export function loadConfig(env: Env, homeDir: string): Config {
  return {
    vaultRoot: absoluteDir(env, "PET_VAULT_DIR", join(homeDir, "pet-vault")),
    maestriBin: nonEmpty(env.MAESTRI_CLI) ?? "maestri",
    opencodeBin: nonEmpty(env.OPENCODE_BIN) ?? "opencode",
    agentBin: nonEmpty(env.PET_AGENT_BIN) ?? "claude",
    opencodeModel: opencodeModel(env),
    stateDir: absoluteDir(env, "PET_STATE_DIR", join(homeDir, ".local", "state", "pet-brain")),
    configDir: absoluteDir(env, "PET_CONFIG_DIR", join(homeDir, ".config", "pet-brain")),
    hubHost: nonEmpty(env.PET_HUB_HOST) ?? "127.0.0.1",
    hubPort: port(env),
    allowAnyHost: env.PET_HUB_ALLOW_ANY_HOST === "1",
    petName: petName(env),
    homeDir,
    weatherPlace: weatherPlace(env),
    clipboardEnabled: env.PET_CLIPBOARD === "1",
  };
}
