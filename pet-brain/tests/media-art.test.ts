import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createMediaArt } from "../src/hub/media-art.js";

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("rest")]);

let root: string;
let allowed: string;
let outside: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "pet-art-"));
  allowed = join(root, "allowed");
  outside = join(root, "outside");
  await mkdir(allowed);
  await mkdir(outside);
});
afterEach(() => rm(root, { recursive: true, force: true }));

describe("media art", () => {
  test("returns a data url for an image inside an allowed folder", async () => {
    await writeFile(join(allowed, "cover"), PNG);

    const data = await createMediaArt([allowed])(pathToFileURL(join(allowed, "cover")).href);

    expect(data).toBe(`data:image/png;base64,${PNG.toString("base64")}`);
  });

  test("refuses a file outside the allowed folders", async () => {
    await writeFile(join(outside, "cover.png"), PNG);

    expect(await createMediaArt([allowed])(pathToFileURL(join(outside, "cover.png")).href)).toBeUndefined();
  });

  test("refuses a symlink that escapes the allowed folder", async () => {
    await writeFile(join(outside, "secret.png"), PNG);
    await symlink(join(outside, "secret.png"), join(allowed, "link.png"));

    expect(await createMediaArt([allowed])(pathToFileURL(join(allowed, "link.png")).href)).toBeUndefined();
  });

  test("refuses a file that is not an image, whatever its name", async () => {
    await writeFile(join(allowed, "cover.png"), "token=segredo");

    expect(await createMediaArt([allowed])(pathToFileURL(join(allowed, "cover.png")).href)).toBeUndefined();
  });

  test("refuses a file that is too big", async () => {
    await writeFile(join(allowed, "big.png"), Buffer.concat([PNG, Buffer.alloc(3 * 1024 * 1024)]));

    expect(await createMediaArt([allowed])(pathToFileURL(join(allowed, "big.png")).href)).toBeUndefined();
  });

  test("ignores anything that is not a file url or does not exist", async () => {
    const art = createMediaArt([allowed]);

    expect(await art("https://i.scdn.co/image/x")).toBeUndefined();
    expect(await art(pathToFileURL(join(allowed, "nope.png")).href)).toBeUndefined();
  });
});
