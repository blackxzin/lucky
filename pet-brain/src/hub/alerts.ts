const PERCENT = 100;

/** Leituras do PC. Cada uma devolve `undefined` quando não se aplica (ex.: PC de mesa sem bateria). */
export interface AlertSources {
  /** Fração do disco usada, de 0 a 1. */
  diskUsed(): Promise<number | undefined>;
  battery(): Promise<{ percent: number; charging: boolean } | undefined>;
  /** Fração da memória ainda disponível, de 0 a 1. */
  memoryFree(): Promise<number | undefined>;
}

export interface Alerts {
  /** Mensagens de alertas que acabaram de começar. Cada alerta avisa uma vez e só volta depois de normalizar. */
  check(): Promise<string[]>;
}

interface Rule {
  key: string;
  /** `true` dispara, `false` normalizou, `undefined` está na faixa do meio (mantém o estado). */
  evaluate(sources: AlertSources): Promise<{ state: boolean | undefined; message: string } | undefined>;
}

const DISK_ON = 0.92;
const DISK_OFF = 0.9;
const BATTERY_ON = 20;
const BATTERY_OFF = 25;
const MEMORY_ON = 0.08;
const MEMORY_OFF = 0.12;

const band = (value: number, on: number, off: number, dir: "high" | "low"): boolean | undefined => {
  if (dir === "high") return value >= on ? true : value < off ? false : undefined;
  return value <= on ? true : value > off ? false : undefined;
};

const RULES: readonly Rule[] = [
  {
    key: "disk",
    evaluate: async (sources) => {
      const used = await sources.diskUsed();
      if (used === undefined) return undefined;
      return { state: band(used, DISK_ON, DISK_OFF, "high"), message: `Disco quase cheio: ${String(Math.round(used * PERCENT))}% usado.` };
    },
  },
  {
    key: "battery",
    evaluate: async (sources) => {
      const battery = await sources.battery();
      if (battery === undefined) return undefined;
      const state = battery.charging ? false : band(battery.percent, BATTERY_ON, BATTERY_OFF, "low");
      return { state, message: `Bateria do PC em ${String(battery.percent)}%. Liga o carregador.` };
    },
  },
  {
    key: "memory",
    evaluate: async (sources) => {
      const free = await sources.memoryFree();
      if (free === undefined) return undefined;
      return { state: band(free, MEMORY_ON, MEMORY_OFF, "low"), message: `Memória no limite: só ${String(Math.round(free * PERCENT))}% livre.` };
    },
  },
];

export function createAlerts(sources: AlertSources): Alerts {
  const active = new Set<string>();
  return {
    check: async () => {
      const fresh: string[] = [];
      for (const rule of RULES) {
        // Uma leitura que falha não pode derrubar os outros alertas nem o tick dos lembretes.
        const reading = await rule.evaluate(sources).catch(() => undefined);
        if (reading === undefined || reading.state === undefined) continue;
        if (reading.state && !active.has(rule.key)) {
          active.add(rule.key);
          fresh.push(reading.message);
        } else if (!reading.state) {
          active.delete(rule.key);
        }
      }
      return fresh;
    },
  };
}
