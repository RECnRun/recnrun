import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";
import { DOWNLOADS_MARKER, openDefaultWorkspace } from "./fixtures/default-downloads.ts";

// Codex P1 finding 2: the E2 default-location cell writes only into a folder it owns under ~/Downloads.
const RUN = "host-2026-11-04T00-00-00.000Z";
let scratch = "";
let downloads = "";
let elsewhere = "";
const launcher = () => join(downloads, "RECnRun", "poc-downloads-launcher");

beforeEach(() => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "recnrun-host-downloads-")));
  downloads = join(scratch, "Downloads");
  elsewhere = join(scratch, "elsewhere");
  mkdirSync(downloads);
  mkdirSync(elsewhere);
});

afterEach(() => rmSync(scratch, { recursive: true, force: true }));

describe("the default-location workspace", () => {
  test("creates a marked folder of its own before anything is downloaded", async () => {
    const workspace = await openDefaultWorkspace(RUN, downloads);
    expect(workspace.folder).toBe(join(launcher(), RUN));
    expect(readFileSync(join(workspace.folder, DOWNLOADS_MARKER), "utf8")).toBe(RUN);
    expect(workspace.relative("probe-x.json")).toBe(
      `RECnRun/poc-downloads-launcher/${RUN}/probe-x.json`,
    );
  });

  test("refuses a symlinked ancestor and writes nothing through it", async () => {
    symlinkSync(elsewhere, join(downloads, "RECnRun"));
    await expect(openDefaultWorkspace(RUN, downloads)).rejects.toThrow(/symlink/);
    expect(readdirSync(elsewhere)).toEqual([]);
  });

  test("refuses a Downloads folder that is itself a symlink", async () => {
    const linked = join(scratch, "linked-downloads");
    symlinkSync(elsewhere, linked);
    await expect(openDefaultWorkspace(RUN, linked)).rejects.toThrow(/symlink/);
    expect(readdirSync(elsewhere)).toEqual([]);
  });

  test("refuses a run folder that already exists", async () => {
    mkdirSync(join(launcher(), RUN), { recursive: true });
    writeFileSync(join(launcher(), RUN, "owner.txt"), "keep");
    await expect(openDefaultWorkspace(RUN, downloads)).rejects.toThrow(/already exists/);
    expect(readFileSync(join(launcher(), RUN, "owner.txt"), "utf8")).toBe("keep");
  });

  test("cleans what Chrome left even when the write failed, and the folders it created", async () => {
    const workspace = await openDefaultWorkspace(RUN, downloads);
    writeFileSync(join(workspace.folder, "Unconfirmed 1.crdownload"), "partial");
    await expect(workspace.clean([])).resolves.toMatchObject({ left: [] });
    expect(readdirSync(downloads)).toEqual([]);
  });

  test("keeps the parents the owner already had", async () => {
    mkdirSync(join(downloads, "RECnRun"));
    const workspace = await openDefaultWorkspace(RUN, downloads);
    const probe = join(workspace.folder, "probe-x.json");
    writeFileSync(probe, "{}");
    const cleaned = await workspace.clean([probe]);
    expect(cleaned.removed).toEqual([
      `Downloads/RECnRun/poc-downloads-launcher/${RUN}/probe-x.json`,
    ]);
    expect(readdirSync(downloads)).toEqual(["RECnRun"]);
    expect(readdirSync(join(downloads, "RECnRun"))).toEqual([]);
  });

  test("refuses to clean a folder that lost its marker", async () => {
    const workspace = await openDefaultWorkspace(RUN, downloads);
    unlinkSync(join(workspace.folder, DOWNLOADS_MARKER));
    writeFileSync(join(workspace.folder, "probe-x.json"), "{}");
    await expect(workspace.clean([])).rejects.toThrow(/marker/);
    expect(existsSync(join(workspace.folder, "probe-x.json"))).toBe(true);
  });

  test("fails on a reported path outside its folder after removing its own files", async () => {
    const workspace = await openDefaultWorkspace(RUN, downloads);
    const inside = join(workspace.folder, "probe-x.json");
    const outside = join(elsewhere, "probe-x.json");
    writeFileSync(inside, "{}");
    writeFileSync(outside, "owner");
    await expect(workspace.clean([inside, outside])).rejects.toThrow(/outside/);
    expect(existsSync(workspace.folder)).toBe(false);
    expect(readFileSync(outside, "utf8")).toBe("owner");
  });
});
