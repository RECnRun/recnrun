import { extensionPath } from "../browser/fixtures/extension-loaders.ts";
import { observe } from "../experiments/e1-samples.ts";
import { cacheSample, fetchSample, LISTING_REASON } from "../experiments/e3-samples.ts";
import type { E3Cells } from "../experiments/e3-samples.ts";
import { requireBuild } from "../experiments/file-access.ts";
import {
  expectEveryHypothesis,
  recordHypothesis,
  recordUnavailable,
} from "../experiments/outcome.ts";
import type { Cell, Sample } from "../experiments/outcome.ts";
import { openHostExtension, test } from "./fixtures/host-chrome.ts";
import { evidence, installedChromeVersion } from "./fixtures/host-env.ts";

/*
 * E3's host twin (POC PLAN.md P1.4): the installed Google Chrome of this Mac on throwaway roots,
 * reading file:// in the extension page and in the offscreen document. The directory listing is
 * recorded `unavailable` without reading a folder, so no host path lands in a verdict.
 */

const EXPERIMENT = "E3";
const HYPOTHESES = [
  "E3.page.fetch",
  "E3.offscreen.fetch",
  "E3.page.cache",
  "E3.offscreen.cache",
  "E3.directoryListing",
];
const VARIANT = "poc-d0";
const PATH = extensionPath(VARIANT);

async function cell(hypothesis: string): Promise<Cell> {
  const chrome = `Google Chrome ${await installedChromeVersion()}`;
  const fixed = { variant: VARIANT, topology: "single-root", debugger: "none" } as const;
  const install = { install: "loadUnpacked", label: "diagnostic", externalClient: true } as const;
  return { experiment: EXPERIMENT, hypothesis, chrome, environment: "host", ...install, ...fixed };
}

let roots = 0;

const hostCells: E3Cells = {
  fresh: async () => {
    roots += 1;
    const host = await openHostExtension(`e3-${roots}`, { path: PATH });
    try {
      const installed = await observe(host, () => host.quit());
      const dispose = async () => {
        await installed.quit().catch(() => undefined);
        await host.close();
      };
      return { ...installed, root: host.root, dispose };
    } catch (error) {
      await host.close();
      throw error;
    }
  },
};

test.describe("E3 on the host: file:// reads of the poc-d0 build", () => {
  test.describe.configure({ timeout: 600_000 });
  const directory = () => evidence().directory;
  const record = async (hypothesis: string, take: () => Promise<Sample>) => {
    await recordHypothesis(await cell(hypothesis), take, { directory: directory() });
  };

  test.beforeAll(async () => {
    await requireBuild(PATH, VARIANT);
  });

  test("E3.page.fetch: fetch(file://) in the extension page reads the probe", async () => {
    await record("E3.page.fetch", () => fetchSample(hostCells, "page"));
  });

  test("E3.offscreen.fetch: fetch(file://) in the offscreen document reads the probe", async () => {
    await record("E3.offscreen.fetch", () => fetchSample(hostCells, "offscreen"));
  });

  test("E3.page.cache: the page sees every change A→B→C→D on its first read", async () => {
    await record("E3.page.cache", () => cacheSample(hostCells, "page"));
  });

  test("E3.offscreen.cache: the offscreen document sees every change A→B→C→D on its first read", async () => {
    await record("E3.offscreen.cache", () => cacheSample(hostCells, "offscreen"));
  });

  test("E3.directoryListing: unavailable, no folder is read on the host", async () => {
    await recordUnavailable(await cell("E3.directoryListing"), LISTING_REASON, directory());
  });

  test("every E3 hypothesis left a verdict", async () => {
    await expectEveryHypothesis(EXPERIMENT, HYPOTHESES, directory());
  });
});
