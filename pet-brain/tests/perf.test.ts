import { describe, expect, test } from "vitest";
import { createPerf } from "../src/hub/perf.js";

function files(map: Record<string, string>) {
  return {
    readText: async (path: string) => map[path],
    listDir: async (path: string) => Object.keys(map).filter((key) => key.startsWith(`${path}/`)).map((key) => key.slice(path.length + 1).split("/")[0] ?? "").filter((v, i, a) => a.indexOf(v) === i),
    sleep: async () => undefined,
  };
}

const sources = { diskUsed: async () => 0.42, battery: async () => ({ percent: 80, charging: false }), memoryFree: async () => 0.5 };

describe("perf", () => {
  test("reads cpu between two samples, memory, disk, battery, temperature and uptime", async () => {
    let stat = 0;
    const base = files({
      "/proc/meminfo": "MemTotal: 16777216 kB\nMemAvailable: 8388608 kB\n",
      "/proc/uptime": "3600.55 123.4\n",
      "/sys/class/hwmon/hwmon0/temp1_input": "45000\n",
      "/sys/class/hwmon/hwmon1/temp1_input": "61000\n",
    });
    const readText = async (path: string) => {
      if (path === "/proc/stat") {
        stat += 1;
        return stat === 1 ? "cpu 100 0 100 800 0 0 0 0\n" : "cpu 200 0 200 1000 0 0 0 0\n";
      }
      return base.readText(path);
    };

    const sample = await createPerf("/home/u", { ...base, readText, sources })();

    expect(sample.cpu).toBeCloseTo(0.5, 5);
    expect(sample.memory).toBeCloseTo(0.5, 5);
    expect(sample.memoryTotalGb).toBeCloseTo(16, 5);
    expect(sample.disk).toBe(0.42);
    expect(sample.battery).toEqual({ percent: 80, charging: false });
    expect(sample.tempC).toBe(61);
    expect(sample.uptimeSeconds).toBe(3600);
  });

  test("uses the previous sample on the next call and survives missing files", async () => {
    const reads: string[] = [];
    const perf = createPerf("/home/u", {
      readText: async (path) => {
        reads.push(path);
        return path === "/proc/stat" ? `cpu ${String(reads.length * 100)} 0 0 ${String(reads.length * 100)} 0 0 0 0\n` : undefined;
      },
      listDir: async () => [],
      sleep: async () => undefined,
      sources: { diskUsed: async () => { throw new Error("x"); }, battery: async () => undefined, memoryFree: async () => undefined },
    });

    const first = await perf();
    const second = await perf();

    expect(first.cpu).toBeCloseTo(0.5, 5);
    expect(second.cpu).toBeCloseTo(0.5, 5);
    expect(second).toMatchObject({ memory: undefined, disk: undefined, tempC: undefined, battery: undefined, uptimeSeconds: undefined });
  });
});
