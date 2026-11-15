import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AlertSources } from "./alerts.js";
import { createSystemSources } from "./alert-sources.js";

export interface PerfSample {
  /** Uso de CPU entre duas leituras, de 0 a 1. */
  cpu: number | undefined;
  /** Memória em uso, de 0 a 1, e total em GB. */
  memory: number | undefined;
  memoryTotalGb: number | undefined;
  disk: number | undefined;
  /** Temperatura mais alta que o PC informa, em °C. */
  tempC: number | undefined;
  battery: { percent: number; charging: boolean } | undefined;
  uptimeSeconds: number | undefined;
}

export type PerfReader = () => Promise<PerfSample>;

interface PerfDeps {
  sources: AlertSources;
  readText: (path: string) => Promise<string | undefined>;
  listDir: (path: string) => Promise<string[]>;
  sleep: (ms: number) => Promise<void>;
}

const SAMPLE_GAP_MS = 150;
const KB_PER_GB = 1024 * 1024;
const MILLIDEGREES = 1000;
const MAX_PLAUSIBLE_TEMP_C = 150;
const HWMON_DIR = "/sys/class/hwmon";
const THERMAL_DIR = "/sys/class/thermal";

interface CpuTimes {
  total: number;
  idle: number;
}

function parseCpu(stat: string | undefined): CpuTimes | undefined {
  const line = stat?.split("\n").find((entry) => entry.startsWith("cpu "));
  if (line === undefined) return undefined;
  const fields = line.trim().split(/\s+/).slice(1).map(Number);
  if (fields.length < 4 || fields.some((value) => !Number.isFinite(value))) return undefined;
  const idle = (fields[3] ?? 0) + (fields[4] ?? 0);
  return { total: fields.reduce((sum, value) => sum + value, 0), idle };
}

const realDeps = (homeDir: string): PerfDeps => ({
  sources: createSystemSources(homeDir),
  readText: (path) => readFile(path, "utf8").catch(() => undefined),
  listDir: (path) => readdir(path).catch(() => []),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
});

/** Lê CPU, memória, disco, temperatura e bateria do PC. Só leitura de /proc e /sys: nada é executado. */
export function createPerf(homeDir: string, overrides: Partial<PerfDeps> = {}): PerfReader {
  const deps: PerfDeps = { ...realDeps(homeDir), ...overrides };
  let previous: CpuTimes | undefined;

  const readCpu = async (): Promise<number | undefined> => {
    const first = previous ?? parseCpu(await deps.readText("/proc/stat"));
    if (previous === undefined) await deps.sleep(SAMPLE_GAP_MS);
    const second = parseCpu(await deps.readText("/proc/stat"));
    previous = second;
    if (first === undefined || second === undefined) return undefined;
    const total = second.total - first.total;
    return total <= 0 ? 0 : Math.min(1, Math.max(0, 1 - (second.idle - first.idle) / total));
  };

  const readMemory = async (): Promise<Pick<PerfSample, "memory" | "memoryTotalGb">> => {
    const text = await deps.readText("/proc/meminfo");
    const total = Number(/MemTotal:\s+(\d+)/.exec(text ?? "")?.[1]);
    const available = Number(/MemAvailable:\s+(\d+)/.exec(text ?? "")?.[1]);
    if (!Number.isFinite(total) || !Number.isFinite(available) || total <= 0) return { memory: undefined, memoryTotalGb: undefined };
    return { memory: 1 - available / total, memoryTotalGb: total / KB_PER_GB };
  };

  const readTemperature = async (): Promise<number | undefined> => {
    const files: string[] = [];
    for (const hwmon of await deps.listDir(HWMON_DIR)) {
      const dir = join(HWMON_DIR, hwmon);
      (await deps.listDir(dir)).filter((name) => /^temp\d+_input$/.test(name)).forEach((name) => files.push(join(dir, name)));
    }
    if (files.length === 0) {
      (await deps.listDir(THERMAL_DIR)).filter((name) => name.startsWith("thermal_zone")).forEach((name) => files.push(join(THERMAL_DIR, name, "temp")));
    }
    const values = (await Promise.all(files.map((file) => deps.readText(file))))
      .map((text) => Number.parseInt(text ?? "", 10) / MILLIDEGREES)
      .filter((value) => Number.isFinite(value) && value > 0 && value < MAX_PLAUSIBLE_TEMP_C);
    return values.length === 0 ? undefined : Math.max(...values);
  };

  return async () => {
    const [cpu, mem, disk, battery, tempC, uptime] = await Promise.all([
      readCpu(),
      readMemory(),
      deps.sources.diskUsed().catch(() => undefined),
      deps.sources.battery().catch(() => undefined),
      readTemperature(),
      deps.readText("/proc/uptime"),
    ]);
    const seconds = Number.parseFloat(uptime ?? "");
    return { cpu, ...mem, disk, tempC, battery, uptimeSeconds: Number.isFinite(seconds) ? Math.floor(seconds) : undefined };
  };
}
