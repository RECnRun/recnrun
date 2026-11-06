import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";
import {
  HOST_FOLDER,
  ROOT_MARKER,
  chromeRoot,
  hostRoots,
  removeHostRoot,
  rootFor,
  writeDownloadsPreference,
} from "./fixtures/roots.ts";

// POC PLAN.md §8: host roots live under ~/Documents/RECnRun/poc-downloads-launcher/ and nowhere else.
let scratch = "";
let folder = "";
let outside = "";

beforeEach(() => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "recnrun-host-roots-")));
  folder = join(scratch, "poc-downloads-launcher");
  outside = join(scratch, "elsewhere");
  mkdirSync(folder);
  mkdirSync(outside);
});

afterEach(() => rmSync(scratch, { recursive: true, force: true }));

describe("host roots guard", () => {
  test("defaults to the POC folder under ~/Documents", () => {
    expect(HOST_FOLDER).toMatch(/\/Documents\/RECnRun\/poc-downloads-launcher$/);
  });

  test("refuses an unset or empty variable", () => {
    expect(() => hostRoots(undefined, folder)).toThrow(/RECNRUN_HOST_ROOTS is not set/);
    expect(() => hostRoots("", folder)).toThrow(/RECNRUN_HOST_ROOTS is not set/);
  });

  test("refuses a folder outside the POC folder, and the folder's parent", () => {
    expect(() => hostRoots(outside, folder)).toThrow(/outside/);
    expect(() => hostRoots(scratch, folder)).toThrow(/outside/);
  });

  test("refuses a symlink inside the folder that points outside", () => {
    const link = join(folder, "escape");
    symlinkSync(outside, link);
    expect(() => hostRoots(link, folder)).toThrow(/outside/);
  });

  test("refuses `..` segments and relative paths even when they land inside", () => {
    mkdirSync(join(folder, "a"));
    expect(() => hostRoots(join(folder, "a") + "/../a", folder)).toThrow(/\.\./);
    expect(() => hostRoots("poc-downloads-launcher", folder)).toThrow(/absolute/);
  });

  test("refuses a folder that does not exist", () => {
    expect(() => hostRoots(join(folder, "missing"), folder)).toThrow(/does not exist/);
  });

  test("accepts the POC folder and a folder inside it", () => {
    mkdirSync(join(folder, "inner"));
    expect(hostRoots(folder, folder)).toBe(folder);
    expect(hostRoots(join(folder, "inner"), folder)).toBe(join(folder, "inner"));
  });

  test("creates <roots>/roots/<run>/<name> and refuses names that leave it", async () => {
    const roots = hostRoots(folder, folder);
    await expect(rootFor(roots, "run-1", "a", folder)).resolves.toBe(
      join(folder, "roots", "run-1", "a"),
    );
    await expect(rootFor(roots, "run-1", "../a", folder)).rejects.toThrow(/name/);
    await expect(rootFor(roots, "..", "a", folder)).rejects.toThrow(/name/);
  });

  test("refuses a roots folder that a symlink sends outside", async () => {
    symlinkSync(outside, join(folder, "roots"));
    await expect(rootFor(folder, "run-1", "a", folder)).rejects.toThrow(/outside/);
    expect(readdirSync(outside)).toEqual([]);
  });
});

describe("host root ownership", () => {
  const run = () => join(folder, "roots", "run-1");

  test("refuses a leaf symlink back to the POC folder, and the folder survives", async () => {
    mkdirSync(run(), { recursive: true });
    symlinkSync(folder, join(run(), "a"));
    await expect(rootFor(folder, "run-1", "a", folder)).rejects.toThrow(/exists/);
    expect(existsSync(join(folder, "roots"))).toBe(true);
  });

  test("refuses a leaf symlink to the roots folder", async () => {
    mkdirSync(run(), { recursive: true });
    symlinkSync(join(folder, "roots"), join(run(), "a"));
    await expect(rootFor(folder, "run-1", "a", folder)).rejects.toThrow(/exists/);
  });

  test("refuses a run folder that a symlink sends back to the POC folder", async () => {
    mkdirSync(join(folder, "roots"));
    symlinkSync(folder, run());
    await expect(rootFor(folder, "run-1", "a", folder)).rejects.toThrow(/symlink/);
    expect(existsSync(join(folder, "a"))).toBe(false);
  });

  test("refuses a populated root that already exists, so every root starts fresh", async () => {
    mkdirSync(join(run(), "a"), { recursive: true });
    writeFileSync(join(run(), "a", "Local State"), "{}");
    await expect(rootFor(folder, "run-1", "a", folder)).rejects.toThrow(/exists/);
  });

  test("marks a new root with its run id and removes only a marked one", async () => {
    const root = await rootFor(folder, "run-1", "a", folder);
    expect(readFileSync(join(root, ROOT_MARKER), "utf8")).toBe("run-1");
    await removeHostRoot(root, "run-1", folder);
    expect(existsSync(root)).toBe(false);
  });

  test("refuses to remove a root without the marker or with another run's marker", async () => {
    const unmarked = join(run(), "b");
    mkdirSync(unmarked, { recursive: true });
    await expect(removeHostRoot(unmarked, "run-1", folder)).rejects.toThrow(/marker/);
    expect(existsSync(unmarked)).toBe(true);
    const root = await rootFor(folder, "run-1", "a", folder);
    await expect(removeHostRoot(root, "run-2", folder)).rejects.toThrow(/run run-2/);
    expect(existsSync(root)).toBe(true);
    writeFileSync(join(root, ROOT_MARKER), "run-0");
    await expect(removeHostRoot(root, "run-1", folder)).rejects.toThrow(/marker/);
    expect(existsSync(root)).toBe(true);
  });

  test("refuses to remove a root that is a symlink", async () => {
    const root = await rootFor(folder, "run-1", "a", folder);
    symlinkSync(root, join(run(), "link"));
    await expect(removeHostRoot(join(run(), "link"), "run-1", folder)).rejects.toThrow(/symlink/);
    expect(existsSync(root)).toBe(true);
  });
});

// The P2.2 presence leaked into ~/Downloads from host roots that left Chrome its own default.
describe("host Chrome roots pin their Downloads folder", () => {
  test("writes download.default_directory = <root>/downloads before the first launch", async () => {
    const root = await chromeRoot(folder, "host-run", "a", folder);
    const preferences = join(root, "Default", "Preferences");
    expect(existsSync(preferences)).toBe(true);
    expect(JSON.parse(readFileSync(preferences, "utf8"))).toEqual({
      download: {
        prompt_for_download: false,
        default_directory: join(root, "downloads"),
        directory_upgrade: true,
      },
    });
  });

  test("writes the preference through the injected file calls", async () => {
    const calls: unknown[] = [];
    const fs = {
      mkdir: async (path: string) => void calls.push(["mkdir", path]),
      writeFile: async (path: string, data: string) => void calls.push(["writeFile", path, data]),
    };
    await writeDownloadsPreference("/r", "/r/downloads", fs);
    expect(calls).toEqual([
      ["mkdir", "/r/Default"],
      [
        "writeFile",
        "/r/Default/Preferences",
        '{"download":{"prompt_for_download":false,"default_directory":"/r/downloads","directory_upgrade":true}}',
      ],
    ]);
  });
});
