import { readdir, readFile, statfs } from "node:fs/promises";
import { join } from "node:path";
import type { AlertSources } from "./alerts.js";

const POWER_DIR = "/sys/class/power_supply";
const MEMINFO = "/proc/meminfo";

const readText = (path: string): Promise<string | undefined> => readFile(path, "utf8").catch(() => undefined);

/** Lê o PC de verdade: disco da home, primeira bateria (se houver) e memória disponível. */
export function createSystemSources(homeDir: string): AlertSources {
  return {
    diskUsed: async () => {
      const stats = await statfs(homeDir);
      return stats.blocks === 0 ? undefined : 1 - stats.bavail / stats.blocks;
    },

    battery: async () => {
      const names = await readdir(POWER_DIR).catch(() => []);
      const name = names.find((entry) => entry.startsWith("BAT"));
      if (name === undefined) return undefined;
      const [capacity, status] = await Promise.all([readText(join(POWER_DIR, name, "capacity")), readText(join(POWER_DIR, name, "status"))]);
      const percent = Number.parseInt(capacity ?? "", 10);
      if (!Number.isFinite(percent)) return undefined;
      return { percent, charging: status?.trim() === "Charging" || status?.trim() === "Full" };
    },

    memoryFree: async () => {
      const text = await readText(MEMINFO);
      const total = /MemTotal:\s+(\d+)/.exec(text ?? "")?.[1];
      const available = /MemAvailable:\s+(\d+)/.exec(text ?? "")?.[1];
      if (total === undefined || available === undefined) return undefined;
      return Number(available) / Number(total);
    },
  };
}
