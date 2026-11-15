import { describe, expect, test } from "vitest";
import { createLyrics, parseLrc } from "../src/hub/lyrics.js";

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status });

describe("parseLrc", () => {
  test("turns timestamped lines into ordered lines and skips the rest", () => {
    const lines = parseLrc("[ar:Alguém]\n[00:12.50] segunda\n[00:05.00]primeira\n\n[01:01.00]  ");

    expect(lines).toEqual([
      { t: 5, text: "primeira" },
      { t: 12.5, text: "segunda" },
      { t: 61, text: "" },
    ]);
  });
});

describe("lyrics", () => {
  test("asks lrclib with only title, artist and duration and parses both versions", async () => {
    const urls: string[] = [];
    const reader = createLyrics({
      fetch: (async (input: RequestInfo | URL) => {
        urls.push(String(input));
        return json({ syncedLyrics: "[00:01.00] oi", plainLyrics: "oi" });
      }) as typeof fetch,
    });

    const result = await reader({ title: "Não Me Siga", artist: "zNesha", duration: 130 });

    expect(result).toEqual({ synced: [{ t: 1, text: "oi" }], plain: "oi" });
    expect(urls[0]).toMatch(/^https:\/\/lrclib\.net\/api\/get\?/);
    expect(urls[0]).toContain("duration=130");
  });

  test("caches the last track so polling does not hit the network again", async () => {
    let calls = 0;
    const reader = createLyrics({ fetch: (async () => (calls += 1, json({ plainLyrics: "x" }))) as typeof fetch });

    await reader({ title: "a", artist: "b", duration: 1 });
    await reader({ title: "a", artist: "b", duration: 1 });

    expect(calls).toBe(1);
  });

  test("turns 404, network errors and odd shapes into no lyrics", async () => {
    const empty = { synced: null, plain: null };

    expect(await createLyrics({ fetch: (async () => json({}, 404)) as typeof fetch })({ title: "a", artist: "b", duration: 0 })).toEqual(empty);
    expect(
      await createLyrics({ fetch: (async () => { throw new Error("offline"); }) as typeof fetch })({ title: "a", artist: "b", duration: 0 }),
    ).toEqual(empty);
    expect(await createLyrics({ fetch: (async () => json({ syncedLyrics: 5 })) as typeof fetch })({ title: "a", artist: "b", duration: 0 })).toEqual(empty);
  });
});
