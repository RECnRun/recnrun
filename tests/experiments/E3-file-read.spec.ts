import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { resolveChromePath, test } from "../browser/fixtures/chrome.ts";
import { extensionPath, loadUnpacked } from "../browser/fixtures/extension-loaders.ts";
import { observe } from "./e1-samples.ts";
import {
  cacheSample,
  fetchSample,
  LISTING_REASON,
  listingObservation,
  recordUnavailableSeen,
} from "./e3-samples.ts";
import type { E3Cells } from "./e3-samples.ts";
import { requireBuild } from "./file-access.ts";
import { expectEveryHypothesis, recordHypothesis } from "./outcome.ts";
import type { Cell } from "./outcome.ts";

/*
 * E3 (POC PLAN.md P1.4) in the lab: file:// reads in the poc-d0 build's extension page and in its
 * offscreen document, repeated reads of a changed file, and what a directory URL returns.
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
  const chrome = (await promisify(execFile)(resolveChromePath(), ["--version"])).stdout.trim();
  const fixed = { variant: VARIANT, topology: "single-root", debugger: "none" } as const;
  const install = { install: "loadUnpacked", label: "diagnostic", externalClient: true } as const;
  return { experiment: EXPERIMENT, hypothesis, chrome, environment: "lab", ...install, ...fixed };
}

const labCells: E3Cells = {
  fresh: async () => {
    const root = await mkdtemp(join(tmpdir(), "recnrun-e3-"));
    const remove = () =>
      rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    try {
      const installed = await observe(await loadUnpacked(PATH, { userDataDir: root }));
      const dispose = async () => {
        await installed.quit();
        await remove();
      };
      return { ...installed, root, dispose };
    } catch (error) {
      await remove();
      throw error;
    }
  },
};

test.describe("E3: file:// reads of the poc-d0 build in Google Chrome Stable", () => {
  test.beforeAll(async () => {
    await requireBuild(PATH, VARIANT);
  });

  test("E3.page.fetch: fetch(file://) in the extension page reads the probe", async () => {
    await recordHypothesis(await cell("E3.page.fetch"), () => fetchSample(labCells, "page"));
  });

  test("E3.offscreen.fetch: fetch(file://) in the offscreen document reads the probe", async () => {
    await recordHypothesis(await cell("E3.offscreen.fetch"), () =>
      fetchSample(labCells, "offscreen"),
    );
  });

  test("E3.page.cache: the page sees every change A→B→C→D on its first read", async () => {
    await recordHypothesis(await cell("E3.page.cache"), () => cacheSample(labCells, "page"));
  });

  test("E3.offscreen.cache: the offscreen document sees every change A→B→C→D on its first read", async () => {
    await recordHypothesis(await cell("E3.offscreen.cache"), () =>
      cacheSample(labCells, "offscreen"),
    );
  });

  test("E3.directoryListing: unavailable, with what a directory URL returns", async () => {
    const seen = await listingObservation(labCells);
    await recordUnavailableSeen(await cell("E3.directoryListing"), LISTING_REASON, seen);
  });

  test("every E3 hypothesis left a verdict", async () => {
    await expectEveryHypothesis(EXPERIMENT, HYPOTHESES);
  });
});
