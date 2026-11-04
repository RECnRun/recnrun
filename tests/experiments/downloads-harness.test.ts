import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { createDownloadsGroup } from "../browser/fixtures/downloads-profiles.ts";
import type { DownloadsPlatform } from "../browser/fixtures/downloads-profiles.ts";
import { CdpDetachedError } from "../browser/fixtures/cdp-client.ts";
import { within } from "./fixtures/e5-observe.ts";
import { launcherIo } from "./fixtures/e4-launcher.ts";

// Codex P3 finding 5: a harness failure is never a passing verdict; only absence is a timeout.
let scratch = "";
const errno = (code: string) => Object.assign(new Error(code), { code });

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "recnrun-downloads-harness-"));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(scratch, { recursive: true, force: true });
});

function platform(): DownloadsPlatform {
  return {
    makeFolder: (name) => mkdtemp(join(scratch, `${name}-`)),
    removeFolder: (path) => rm(path, { recursive: true, force: true }),
    launch: () => Promise.reject(new Error("no Chrome in this test")),
    shared: async () => ({ downloads: await mkdtemp(join(scratch, "downloads-")), written: true }),
  };
}

describe("catalog loop", () => {
  test("a catalog failure surfaces on dispose after the folders are removed", async () => {
    const group = await createDownloadsGroup(platform());
    vi.spyOn(launcherIo, "execFile").mockImplementation((_file, _args, callback) => {
      callback(Object.assign(new Error("exit 73"), { code: 73 }), "", "cannot write");
    });
    group.startCatalog(20);
    await new Promise((resolve) => setTimeout(resolve, 300));
    await expect(group.dispose()).rejects.toThrow(/catalog\.sh exited 73/);
    await expect(group.dispose()).resolves.toBeUndefined();
  });

  test("a group whose catalog never failed disposes quietly", async () => {
    const group = await createDownloadsGroup(platform());
    await expect(group.dispose()).resolves.toBeUndefined();
  });
});

describe("within", () => {
  test("an observation that throws something unexpected is a harness error", async () => {
    await expect(
      within(() => Promise.reject(new TypeError("worker.evaluate is not a function")), 200),
    ).rejects.toThrow("worker.evaluate is not a function");
  });

  test.each([
    ["a file not there yet", errno("ENOENT")],
    ["a file half written", new SyntaxError("Unexpected end of JSON input")],
    ["a replaced worker", new CdpDetachedError("Runtime.evaluate")],
    ["a stopped worker", new Error("Target page, context or browser has been closed")],
  ])("%s counts as nothing observed yet", async (_name, error) => {
    await expect(within(() => Promise.reject(error), 100)).resolves.toBeUndefined();
  });
});
