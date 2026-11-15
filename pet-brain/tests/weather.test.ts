import { describe, expect, test } from "vitest";
import { createWeather, describeWeather } from "../src/hub/weather.js";

const json = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200 });

const forecast = {
  current: { temperature_2m: 29.6, apparent_temperature: 33.2, weather_code: 61 },
  daily: { precipitation_probability_max: [70], temperature_2m_max: [31.4], temperature_2m_min: [24.1] },
};

function fakeFetch(urls: string[]): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    urls.push(url);
    return url.includes("geocoding") ? json({ results: [{ name: "Fortaleza", latitude: -3.7, longitude: -38.5, admin1: "Ceará" }] }) : json(forecast);
  }) as typeof fetch;
}

describe("weather", () => {
  test("geocodes the place and reads the forecast from fixed hosts", async () => {
    const urls: string[] = [];
    const info = await createWeather({ fetch: fakeFetch(urls), defaultPlace: "Fortaleza" })();

    expect(info).toMatchObject({ place: "Fortaleza, Ceará", tempC: 30, feelsC: 33, label: "chuva", rainChance: 70, maxC: 31, minC: 24 });
    expect(urls[0]).toMatch(/^https:\/\/geocoding-api\.open-meteo\.com\//);
    expect(urls[1]).toMatch(/^https:\/\/api\.open-meteo\.com\//);
    expect(describeWeather(info!)).toContain("chance de chuva 70%");
  });

  test("does not guess a place when none is configured or asked", async () => {
    const urls: string[] = [];

    expect(await createWeather({ fetch: fakeFetch(urls) })()).toBeUndefined();
    expect(urls).toEqual([]);
  });

  test("answers undefined for an unknown place and caches for 15 minutes", async () => {
    const urls: string[] = [];
    let clock = new Date("2026-11-15T10:00:00Z");
    const weather = createWeather({ fetch: fakeFetch(urls), defaultPlace: "Fortaleza", now: () => clock });

    await weather();
    await weather();
    expect(urls).toHaveLength(2);
    clock = new Date("2026-11-15T10:20:00Z");
    await weather();
    expect(urls).toHaveLength(4);

    const none = createWeather({ fetch: (async () => json({})) as typeof fetch });
    expect(await none("lugar nenhum")).toBeUndefined();
  });
});
