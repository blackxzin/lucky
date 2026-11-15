import { describe, expect, test } from "vitest";
import { createMedia } from "../src/hub/media.js";
import type { ProcessResult, ProcessRunner } from "../src/proc/run.js";

const ok = (stdout: string): ProcessResult => ({ exitCode: 0, stdout, stderr: "", timedOut: false, truncated: false });
const fail: ProcessResult = { exitCode: 1, stdout: "", stderr: "No players found", timedOut: false, truncated: false };

function runner(handler: (args: readonly string[]) => ProcessResult): { run: ProcessRunner; calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    run: async (_bin, args) => {
      calls.push([...args]);
      return handler(args);
    },
  };
}

const playing = (args: readonly string[]): ProcessResult => {
  if (args[0] === "volume" && args.length === 1) return ok("0.6\n");
  if (args[0] === "shuffle" && args.length === 1) return ok("On\n");
  if (args[0] === "loop" && args.length === 1) return ok("None\n");
  return ok("Playing\tOne For The Road\tArctic Monkeys\thttps://i.scdn.co/image/abc\t200000000\t75000000\n");
};
const isRead = (args: readonly string[]): boolean => args[0] === "metadata" || (args.length === 1 && ["volume", "shuffle", "loop"].includes(args[0] ?? ""));

describe("media", () => {
  test("reads the current player", async () => {
    const { run } = runner(playing);

    expect(await createMedia({ run })("status")).toEqual({
      available: true,
      playing: true,
      title: "One For The Road",
      artist: "Arctic Monkeys",
      volume: 0.6,
      position: 75,
      length: 200,
      artUrl: "https://i.scdn.co/image/abc",
      shuffle: true,
      loop: "none",
    });
  });

  test("keeps only https and file cover urls and tolerates missing fields", async () => {
    const meta = (art: string) => (args: readonly string[]) => (args[0] === "metadata" ? ok(`Playing\tX\tY\t${art}\t\t`) : ok(""));

    expect(await createMedia({ run: runner(meta("http://evil.example/a.png")).run })("status")).toMatchObject({ artUrl: "", length: 0, position: 0 });
    expect(await createMedia({ run: runner(meta("file:///tmp/a.png")).run })("status")).toMatchObject({ artUrl: "file:///tmp/a.png" });
    expect(await createMedia({ run: runner(meta("javascript:alert(1)")).run })("status")).toMatchObject({ artUrl: "" });
  });

  test("toggles shuffle and cycles repeat with fixed commands", async () => {
    const { run, calls } = runner(playing);
    const media = createMedia({ run });

    await media("shuffle");
    await media("loop");

    expect(calls.filter((args) => !isRead(args))).toEqual([["shuffle", "Toggle"], ["loop", "Playlist"]]);
  });

  test("repeat goes playlist to track and track to none", async () => {
    const withLoop = (mode: string) => runner((args) => (args[0] === "loop" && args.length === 1 ? ok(mode) : playing(args)));
    const playlist = withLoop("Playlist");
    const track = withLoop("Track");

    await createMedia({ run: playlist.run })("loop");
    await createMedia({ run: track.run })("loop");

    expect(playlist.calls.filter((args) => args.length === 2 && args[0] === "loop")).toEqual([["loop", "Track"]]);
    expect(track.calls.filter((args) => args.length === 2 && args[0] === "loop")).toEqual([["loop", "None"]]);
  });

  test("maps each action to a fixed playerctl command", async () => {
    const { run, calls } = runner(playing);
    const media = createMedia({ run });

    await media("play-pause");
    await media("next");
    await media("previous");
    await media("volume-up");
    await media("volume-down");

    const actions = calls.filter((args) => !isRead(args));
    expect(actions).toEqual([["play-pause"], ["next"], ["previous"], ["volume", "0.05+"], ["volume", "0.05-"]]);
  });

  test("seek runs playerctl position only for a whole number inside the limit", async () => {
    const { run, calls } = runner(playing);
    const media = createMedia({ run });

    await media.seek(75);
    await media.seek(-5);
    await media.seek(1.5);
    await media.seek(999_999_999);

    expect(calls.filter((args) => args[0] === "position")).toEqual([["position", "75"]]);
  });

  test("reports no player instead of failing", async () => {
    const { run } = runner(() => fail);

    expect(await createMedia({ run })("status")).toEqual({ available: false });
  });

  test("reports paused", async () => {
    const { run } = runner((args) => (args[0] === "volume" ? ok("0.3") : ok("Paused\tX\tY")));

    expect(await createMedia({ run })("status")).toMatchObject({ available: true, playing: false, volume: 0.3 });
  });
});
