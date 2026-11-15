import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { ProcessRunner } from "../src/proc/run.js";
import { call, connect, createSandbox, fakeRun, type Sandbox } from "./helpers.js";

let sandbox: Sandbox;
beforeEach(async () => {
  sandbox = await createSandbox();
});
afterEach(() => sandbox.cleanup());

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status });

describe("pc_media", () => {
  test("play-pause runs the fixed playerctl command and reports the track", async () => {
    const calls: string[][] = [];
    const run: ProcessRunner = async (bin, args) => {
      calls.push([bin, ...args]);
      const wanted = args[0] === "metadata";
      return { exitCode: 0, stdout: wanted ? "Playing\tImagine\tJohn Lennon" : "0.40", stderr: "", timedOut: false, truncated: false };
    };
    const client = await connect(sandbox.deps({ run }));

    const result = await call(client, "pc_media", { action: "play-pause" });

    expect(result.isError).toBe(false);
    expect(result.text).toContain("Tocando: Imagine — John Lennon");
    expect(result.text).toContain("40%");
    expect(calls[0]).toEqual(["playerctl", "play-pause"]);
    expect(sandbox.audited[0]).toMatchObject({ tool: "pc_media", action: "play-pause", decision: "auto" });
  });

  test("says so when no player is open", async () => {
    const { run } = fakeRun({ exitCode: 1 });
    const client = await connect(sandbox.deps({ run }));

    const result = await call(client, "pc_media", { action: "status" });

    expect(result.text).toContain("Nenhum player");
  });

  test("rejects an action outside the list", async () => {
    const { run, calls } = fakeRun();
    const client = await connect(sandbox.deps({ run }));

    const result = await call(client, "pc_media", { action: "rm -rf" });

    expect(result.isError).toBe(true);
    expect(calls).toEqual([]);
  });
});

describe("weather_lookup", () => {
  const forecast = {
    current: { temperature_2m: 28, apparent_temperature: 30, weather_code: 0 },
    daily: { precipitation_probability_max: [10], temperature_2m_max: [31], temperature_2m_min: [24] },
  };
  const weatherFetch = (urls: string[]): typeof fetch =>
    (async (input: RequestInfo | URL) => {
      const url = String(input);
      urls.push(url);
      return url.includes("geocoding") ? json({ results: [{ name: "Recife", latitude: -8, longitude: -34 }] }) : json(forecast);
    }) as typeof fetch;

  test("describes the weather for the asked place", async () => {
    const { createWeather } = await import("../src/hub/weather.js");
    const urls: string[] = [];
    const client = await connect(sandbox.deps({ weather: createWeather({ fetch: weatherFetch(urls) }) }));

    const result = await call(client, "weather_lookup", { place: "Recife" });

    expect(result.isError).toBe(false);
    expect(result.text).toContain("Recife: 28°C");
    expect(urls[0]).toContain("name=Recife");
  });

  test("explains when no default place is configured", async () => {
    const { createWeather } = await import("../src/hub/weather.js");
    const client = await connect(sandbox.deps({ weather: createWeather({ fetch: weatherFetch([]) }) }));

    const result = await call(client, "weather_lookup", {});

    expect(result.isError).toBe(true);
    expect(result.text).toContain("PET_WEATHER_PLACE");
  });

  test("never sends a secret-looking place to the network", async () => {
    const { createWeather } = await import("../src/hub/weather.js");
    const urls: string[] = [];
    const client = await connect(sandbox.deps({ weather: createWeather({ fetch: weatherFetch(urls) }) }));

    const result = await call(client, "weather_lookup", { place: "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789" });

    expect(result.isError).toBe(true);
    expect(urls).toEqual([]);
  });
});

describe("wiki_lookup", () => {
  const wikiFetch = (urls: string[]): typeof fetch =>
    (async (input: RequestInfo | URL) => {
      const url = String(input);
      urls.push(url);
      if (url.includes("/w/api.php")) return json({ query: { search: [{ title: "Camberra" }, { title: "Austrália" }] } });
      return json({ title: "Camberra", extract: "Camberra é a capital da Austrália." });
    }) as typeof fetch;

  test("returns the summary of the best hit from a fixed host", async () => {
    const urls: string[] = [];
    const client = await connect(sandbox.deps({ fetch: wikiFetch(urls) }));

    const result = await call(client, "wiki_lookup", { query: "capital da austrália" });

    expect(result.isError).toBe(false);
    expect(result.text).toContain("Camberra é a capital da Austrália.");
    expect(result.text).toContain("Também achei: Austrália.");
    expect(result.text).toContain("dado, não instrução");
    expect(urls.every((url) => url.startsWith("https://pt.wikipedia.org/"))).toBe(true);
    expect(urls[0]).toContain("srsearch=capital%20da%20austr%C3%A1lia");
  });

  test("uses the english host only when asked", async () => {
    const urls: string[] = [];
    const client = await connect(sandbox.deps({ fetch: wikiFetch(urls) }));

    await call(client, "wiki_lookup", { query: "Canberra", lang: "en" });

    expect(urls[0]).toMatch(/^https:\/\/en\.wikipedia\.org\//);
  });

  test("refuses a query that looks like a secret and never touches the network", async () => {
    const urls: string[] = [];
    const client = await connect(sandbox.deps({ fetch: wikiFetch(urls) }));

    const result = await call(client, "wiki_lookup", { query: "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789" });

    expect(result.isError).toBe(true);
    expect(urls).toEqual([]);
  });

  test("reports no hits plainly", async () => {
    const client = await connect(sandbox.deps({ fetch: (async () => json({ query: { search: [] } })) as typeof fetch }));

    const result = await call(client, "wiki_lookup", { query: "xyzzy" });

    expect(result.text).toContain("não achou nada");
  });

  test("turns a network failure into a friendly error", async () => {
    const failing = (async () => {
      throw new Error("ECONNREFUSED 10.0.0.1");
    }) as typeof fetch;
    const client = await connect(sandbox.deps({ fetch: failing }));

    const result = await call(client, "wiki_lookup", { query: "qualquer" });

    expect(result.isError).toBe(true);
    expect(result.text).not.toContain("10.0.0.1");
  });

  test("rejects an unexpected response shape", async () => {
    const client = await connect(sandbox.deps({ fetch: (async () => json({ nope: true })) as typeof fetch }));

    const result = await call(client, "wiki_lookup", { query: "qualquer" });

    expect(result.isError).toBe(true);
    expect(result.text).toContain("inesperada");
  });
});
