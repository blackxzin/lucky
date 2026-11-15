import { z } from "zod";

export interface WeatherInfo {
  place: string;
  tempC: number;
  feelsC: number;
  label: string;
  emoji: string;
  /** Chance de chuva hoje, em %. */
  rainChance: number | undefined;
  maxC: number;
  minC: number;
}

/** Sem lugar configurado ou achado, devolve undefined. `place` troca o lugar padrão (pergunta pontual do dono). */
export type WeatherReader = (place?: string) => Promise<WeatherInfo | undefined>;

const GEOCODE_URL = "https://geocoding-api.open-meteo.com/v1/search";
const FORECAST_URL = "https://api.open-meteo.com/v1/forecast";
const TIMEOUT_MS = 6000;
const CACHE_MS = 15 * 60 * 1000;
const MAX_PLACE_CHARS = 60;

const geocodeSchema = z.object({
  results: z.array(z.object({ name: z.string(), latitude: z.number(), longitude: z.number(), admin1: z.string().optional() })).optional(),
});
const forecastSchema = z.object({
  current: z.object({ temperature_2m: z.number(), apparent_temperature: z.number(), weather_code: z.number() }),
  daily: z.object({
    precipitation_probability_max: z.array(z.number().nullable()).optional(),
    temperature_2m_max: z.array(z.number()),
    temperature_2m_min: z.array(z.number()),
  }),
});

/** Códigos WMO do Open-Meteo. */
function describeCode(code: number): { label: string; emoji: string } {
  if (code === 0) return { label: "céu limpo", emoji: "☀️" };
  if (code <= 2) return { label: "poucas nuvens", emoji: "🌤️" };
  if (code === 3) return { label: "nublado", emoji: "☁️" };
  if (code === 45 || code === 48) return { label: "neblina", emoji: "🌫️" };
  if (code >= 51 && code <= 57) return { label: "garoa", emoji: "🌦️" };
  if (code >= 61 && code <= 67) return { label: "chuva", emoji: "🌧️" };
  if (code >= 71 && code <= 77) return { label: "neve", emoji: "❄️" };
  if (code >= 80 && code <= 82) return { label: "pancadas de chuva", emoji: "🌧️" };
  if (code >= 95) return { label: "tempestade", emoji: "⛈️" };
  return { label: "tempo instável", emoji: "🌥️" };
}

async function getJson(fetchFn: typeof fetch, url: string): Promise<unknown> {
  const response = await fetchFn(url, { signal: AbortSignal.timeout(TIMEOUT_MS), redirect: "error" });
  if (!response.ok) throw new Error(`HTTP ${String(response.status)}`);
  return response.json();
}

/**
 * Tempo pelo Open-Meteo (público, sem chave). Só o NOME do lugar e as coordenadas dele saem do PC, para hosts fixos.
 * O lugar padrão vem da config (PET_WEATHER_PLACE): sem ele o pet não adivinha onde o dono mora.
 */
export function createWeather(deps: { fetch?: typeof fetch; defaultPlace?: string; now?: () => Date }): WeatherReader {
  const fetchFn = deps.fetch ?? fetch;
  const now = deps.now ?? (() => new Date());
  const cache = new Map<string, { at: number; info: WeatherInfo | undefined }>();

  const lookup = async (place: string): Promise<WeatherInfo | undefined> => {
    const geo = geocodeSchema.parse(await getJson(fetchFn, `${GEOCODE_URL}?${new URLSearchParams({ name: place, count: "1", language: "pt" }).toString()}`));
    const found = geo.results?.[0];
    if (found === undefined) return undefined;
    const params = new URLSearchParams({
      latitude: String(found.latitude),
      longitude: String(found.longitude),
      current: "temperature_2m,apparent_temperature,weather_code",
      daily: "precipitation_probability_max,temperature_2m_max,temperature_2m_min",
      timezone: "auto",
      forecast_days: "1",
    });
    const forecast = forecastSchema.parse(await getJson(fetchFn, `${FORECAST_URL}?${params.toString()}`));
    const { label, emoji } = describeCode(forecast.current.weather_code);
    return {
      place: found.admin1 === undefined ? found.name : `${found.name}, ${found.admin1}`,
      tempC: Math.round(forecast.current.temperature_2m),
      feelsC: Math.round(forecast.current.apparent_temperature),
      label,
      emoji,
      rainChance: forecast.daily.precipitation_probability_max?.[0] ?? undefined,
      maxC: Math.round(forecast.daily.temperature_2m_max[0] ?? forecast.current.temperature_2m),
      minC: Math.round(forecast.daily.temperature_2m_min[0] ?? forecast.current.temperature_2m),
    };
  };

  return async (place) => {
    const wanted = (place ?? deps.defaultPlace ?? "").trim().slice(0, MAX_PLACE_CHARS);
    if (wanted === "") return undefined;
    const key = wanted.toLowerCase();
    const hit = cache.get(key);
    if (hit !== undefined && now().getTime() - hit.at < CACHE_MS) return hit.info;
    const info = await lookup(wanted);
    cache.set(key, { at: now().getTime(), info });
    return info;
  };
}

export function describeWeather(info: WeatherInfo): string {
  const rain = info.rainChance === undefined ? "" : `, chance de chuva ${String(info.rainChance)}%`;
  return `${info.emoji} ${info.place}: ${String(info.tempC)}°C (sensação ${String(info.feelsC)}°C), ${info.label}. Hoje ${String(info.minC)}° a ${String(info.maxC)}°${rain}.`;
}
