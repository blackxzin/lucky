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

const playing = (args: readonly string[]): ProcessResult =>
  args[0] === "volume" && args.length === 1 ? ok("0.6\n") : ok("Playing\tOne For The Road\tArctic Monkeys\n");

describe("media", () => {
  test("reads the current player", async () => {
    const { run } = runner(playing);

    expect(await createMedia({ run })("status")).toEqual({
      available: true,
      playing: true,
      title: "One For The Road",
      artist: "Arctic Monkeys",
      volume: 0.6,
    });
  });

  test("maps each action to a fixed playerctl command", async () => {
    const { run, calls } = runner(playing);
    const media = createMedia({ run });

    await media("play-pause");
    await media("next");
    await media("previous");
    await media("volume-up");
    await media("volume-down");

    const actions = calls.filter((args) => args[0] !== "metadata" && !(args[0] === "volume" && args.length === 1));
    expect(actions).toEqual([["play-pause"], ["next"], ["previous"], ["volume", "0.05+"], ["volume", "0.05-"]]);
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
