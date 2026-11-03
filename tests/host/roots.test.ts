import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";
import { HOST_FOLDER, hostRoots, rootFor } from "./fixtures/roots.ts";

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
