import { execFile } from "node:child_process";
import { mkdtemp, rm, rmdir } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { promisify } from "node:util";
import { expect, resolveChromePath, test } from "../browser/fixtures/chrome.ts";
import { launchProbe } from "./fixtures/downloads.ts";
import { E2_CELLS, missingVerdicts } from "./fixtures/downloads-e2.ts";
import type { DownloadsEnvironment } from "./fixtures/downloads-cells.ts";
import { recordE2 } from "./fixtures/downloads-verdicts.ts";
import { pressIn, screenshot, windowNames } from "./fixtures/x-windows.ts";
import { appendVerdict, readVerdicts } from "./verdicts.ts";

/*
 * E2 (POC PLAN.md P1.3): the D0 build writes a probe through chrome.downloads and reads it back
 * through file://. A failed hypothesis is a verdict; the last test fails only when one left none.
 */

async function chromeVersion(): Promise<string> {
  return (await promisify(execFile)(resolveChromePath(), ["--version"])).stdout.trim();
}

/** Removes the default cell's files and their now-empty folders, up to the container's Downloads. */
async function cleanDefault(paths: string[]) {
  const downloads = join(homedir(), "Downloads");
  for (const path of paths) {
    await rm(path, { force: true });
    for (let folder = dirname(path); folder.startsWith(`${downloads}/`); folder = dirname(folder)) {
      if (
        !(await rmdir(folder).then(
          () => true,
          () => false,
        ))
      )
        break;
    }
  }
  return { removed: paths.map((path) => relative(homedir(), path)) };
}

const lab: DownloadsEnvironment = {
  target: { environment: "lab", chrome: chromeVersion, append: appendVerdict },
  launch: async (preferences) => {
    const root = await mkdtemp(join(tmpdir(), "recnrun-e2-"));
    const removeRoot = () =>
      rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    try {
      const probe = await launchProbe(root, preferences);
      const close = async () => {
        await probe.loaded.close();
        await removeRoot();
      };
      return { ...probe, root, close };
    } catch (error) {
      await removeRoot();
      throw error;
    }
  },
  defaultDestination: (namespace) => `RECnRun/poc/${namespace}/probe.json`,
  cleanDefault,
  display: {
    names: windowNames,
    press: pressIn,
    screenshot: async (name) => {
      const path = test.info().outputPath(name);
      await screenshot(path);
      return relative(process.cwd(), path);
    },
  },
  noDisplay: "",
};

test.describe("E2: probe write and real path in Google Chrome Stable", () => {
  for (const [hypothesis, cell] of Object.entries(E2_CELLS)) {
    test(hypothesis, async () => {
      await recordE2(hypothesis, lab.target, () => cell(lab));
    });
  }

  test("every E2 hypothesis left a verdict", async () => {
    expect(missingVerdicts(await readVerdicts())).toEqual([]);
  });
});
