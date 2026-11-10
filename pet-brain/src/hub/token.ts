import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const TOKEN_BYTES = 32;
const TOKEN_PATTERN = /^[a-f0-9]{64}$/;
const TOKEN_FILE = "token";
const PRIVATE_FILE_MODE = 0o600;
const PRIVATE_DIR_MODE = 0o700;

export function tokenPath(configDir: string): string {
  return join(configDir, TOKEN_FILE);
}

async function readToken(path: string): Promise<string | undefined> {
  try {
    return (await readFile(path, "utf8")).trim();
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** Lê o token do hub ou cria um na primeira vez. Nunca troca um arquivo estranho por conta própria. */
export async function loadOrCreateToken(configDir: string): Promise<string> {
  const path = tokenPath(configDir);
  const existing = await readToken(path);
  if (existing !== undefined) {
    if (!TOKEN_PATTERN.test(existing)) {
      throw new Error(`O arquivo de token (${path}) está corrompido. Apague-o para gerar outro.`);
    }
    // Outro usuário da máquina não pode ler o token, mesmo que o arquivo tenha sido criado à mão.
    await chmod(path, PRIVATE_FILE_MODE);
    return existing;
  }

  const token = randomBytes(TOKEN_BYTES).toString("hex");
  await mkdir(configDir, { recursive: true, mode: PRIVATE_DIR_MODE });
  await writeFile(path, `${token}\n`, { encoding: "utf8", mode: PRIVATE_FILE_MODE, flag: "wx" });
  return token;
}

/** Compara os hashes em tempo constante, então nem o tamanho do token vaza. */
export function tokenMatches(expected: string, received: string): boolean {
  const digest = (value: string): Buffer => createHash("sha256").update(value, "utf8").digest();
  return timingSafeEqual(digest(expected), digest(received));
}
