import { execFile } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Page } from "@playwright/test";
import { expect, launchChrome, test } from "../../browser/fixtures/chrome.ts";
import type { LaunchedChrome } from "../../browser/fixtures/chrome.ts";
import type { LoadedExtension } from "../../browser/fixtures/extension-loaders.ts";
import { ended } from "./admission-harness.ts";
import type { Gesture } from "./friction-harness.ts";
import { background, call, link, provisionWorker, startWorker } from "./lifecycle-harness.ts";
import { letRun, observeStats, pageSigner } from "./observe-harness.ts";
import { startStandIn } from "./stand-in.ts";
import type { StandIn } from "./stand-in.ts";
import { startTarget } from "./target-server.ts";
import type { Target } from "./target-server.ts";
import { provision } from "./trust-harness.ts";
import { BLUE, cardShows, startVisualJob, writeEvidence } from "./visual-harness.ts";

/*
 * W6.E friction (W6-PLAN.md slice E), in W.friction's counting style: the gestures and Chrome
 * prompts it takes, after onboarding, to observe a worker that is already linked. Target: the
 * Observe click itself and nothing else.
 */

const run = promisify(execFile);
const NAME = "w0";

interface Cell {
  site: StandIn;
  target: Target;
  master: LaunchedChrome;
  page: Page;
  worker: LoadedExtension;
  root: string;
}

let shared: Cell | undefined;

test.afterAll(async () => {
  const c = shared;
  if (!c) return;
  await c.worker.close().catch(() => undefined);
  await c.master.close();
  await rm(c.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  await c.target.close();
  await c.site.close();
});

/** Visible X windows of the display: a new dialog window would add one. */
async function windows(): Promise<number> {
  const { stdout } = await run("xdotool", ["search", "--onlyvisible", "--name", ".*"]).catch(
    () => ({ stdout: "" }),
  );
  return stdout.split("\n").filter(Boolean).length;
}

/** The whole Xvfb display: permission bubbles and infobars are not X windows. */
async function screenshot(name: string): Promise<string> {
  const directory = join(".artifacts/evidence", process.env.RECNRUN_RUN_ID ?? "local");
  await mkdir(directory, { recursive: true });
  const path = join(directory, `w6-observe-friction-${name}.png`);
  await run("scrot", ["-o", path]);
  return path;
}

/** A linked, provisioned worker running a job held on the blue page: onboarding is behind us. */
async function onboarded(): Promise<Cell & { jobId: string }> {
  const site = await startStandIn();
  const target = await startTarget();
  const master = await launchChrome({ silentDebugger: false });
  const context = master.browser.contexts()[0] ?? (await master.browser.newContext());
  const page = await context.newPage();
  await page.goto(`${site.origin}/`);
  await expect(page.locator("#status")).toHaveText("ready");
  const key = await pageSigner(page);
  const { root, id } = await provisionWorker();
  const worker = await startWorker(root, id);
  shared = { site, target, master, page, worker, root };
  await provision(worker, { masterKey: key.publicKey, allowlist: [target.origin] });
  expect(await link(page, worker, NAME)).toBe(true);
  const jobId = await startVisualJob(worker, key, target.origin, 2);
  await call(page, "dashboardAdd", NAME, jobId);
  return { ...shared, jobId };
}

const tabsOf = (worker: LoadedExtension) =>
  background<number>(worker, "chrome.tabs.query({}).then((tabs) => tabs.length)");

test("W6.E friction: observing a linked worker takes the Observe click and no prompt", async () => {
  const c = await onboarded();
  const prompts = { dialogs: 0, popups: 0 };
  c.page.on("dialog", (dialog) => {
    prompts.dialogs += 1;
    void dialog.dismiss();
  });
  c.page.context().on("page", () => void (prompts.popups += 1));
  const before = { windows: await windows(), workerTabs: await tabsOf(c.worker) };
  const gestures: Gesture[] = [];
  const card = c.page.getByRole("listitem").filter({ hasText: `${NAME} · ` });
  gestures.push({
    step: "observe",
    gesture: "dashboard: click Observe",
    screenshot: await screenshot("before"),
  });
  await card.getByRole("button", { name: "Observe" }).click();
  await cardShows(c.page, NAME, BLUE);
  const after = { windows: await windows(), workerTabs: await tabsOf(c.worker) };
  const shot = await screenshot("after");
  expect((await observeStats(c.worker)).session?.mode).toBe("thumbnail");
  await letRun(c.worker);
  expect((await ended(c.worker, c.jobId)).state).toBe("DONE");
  const record = {
    chrome: c.master.version,
    gestures,
    prompts: { ...prompts, newWindows: after.windows - before.windows },
    workerTabs: { before: before.workerTabs, after: after.workerTabs },
    screenshots: { after: shot },
  };
  await writeEvidence("w6-observe-friction.json", record);
  expect(gestures.length).toBe(1);
  expect(record.prompts).toEqual({ dialogs: 0, popups: 0, newWindows: 0 });
  expect(after.workerTabs).toBe(before.workerTabs);
});
