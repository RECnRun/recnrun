import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";
import type { LaunchedChrome } from "../../browser/fixtures/chrome.ts";
import { test } from "../../e2e/fixtures/native-dialogs.ts";
import type { Native } from "../../e2e/fixtures/native-dialogs.ts";
import { launchMaster, openPage } from "./fsa-harness.ts";
import { aimable, clickAt } from "./interact-click-harness.ts";
import { until } from "./lifecycle-harness.ts";
import {
  banner,
  clickButton,
  count,
  labListing,
  launcherLog,
  masterFingerprint,
  naturalSize,
  panelSize,
  resizePanel,
  resizeWindow,
  rootProcesses,
  startLauncher,
  waitDetail,
} from "./owner-flow-harness.ts";
import type { Launcher } from "./owner-flow-harness.ts";
import { OWNER_PORT, startOwnerServer } from "./owner-serve.ts";
import { startTarget } from "./target-server.ts";
import type { Target } from "./target-server.ts";

/*
 * The owner flow of owner-flow plan v3 as one journey: the owner page in a master Chrome, the real
 * launcher.sh in the container, its headless worker with no CDP, and a fixture page driven by hand.
 */

const LAB = join(homedir(), "RECnRun-lab");
const OWNER = `http://127.0.0.1:${OWNER_PORT}`;
const timings: Record<string, number> = {};
const started = Date.now();
const mark = (step: string) => {
  timings[step] = Date.now() - started;
};

test.skip(process.env.RECNRUN_TEST_CONTAINER !== "1", "The launcher runs only in the container.");

/** Clicks the fixture's counter through the frame; resolves the hit the fixture recorded. */
async function clickRegisters(page: Page, target: Target) {
  const before = target.hits.length;
  await aimable(page);
  await clickAt(page, { x: 0.5, y: 0.5 });
  await expect.poll(() => target.hits.length, { timeout: 15_000 }).toBeGreaterThan(before);
  const hit = target.hits.at(-1);
  expect(hit?.id).toBe("count");
  return hit;
}

/** Resizes the panel and checks the fixture's viewport and the JPEG follow it exactly. */
async function resizeTo(page: Page, target: Target, width: number, height: number) {
  await resizePanel(page, width, height);
  await expect.poll(() => naturalSize(page), { timeout: 20_000 }).toEqual({ width, height });
  const hit = await clickRegisters(page, target);
  expect({ w: hit?.w, h: hit?.h }).toEqual({ w: width, h: height });
}

/** Resizes the master window; the panel follows it, and the worker's viewport the panel. */
async function followWindow(page: Page, width: number, height: number) {
  await resizeWindow(page, width, height);
  await expect
    .poll(() => page.evaluate(() => innerWidth), { timeout: 5_000 })
    .toBeLessThan(width + 1);
  const panel = await panelSize(page);
  await expect.poll(() => naturalSize(page), { timeout: 20_000 }).toEqual(panel);
  return panel;
}

async function launchAndConnect(page: Page, button: "Launch" | "Reconnect") {
  await expect(banner(page)).toHaveText("Ready", { timeout: 60_000 });
  await clickButton(page, button);
  await waitDetail(page, /^(launched|refused)/, 120_000);
  await expect(page.locator("section p").nth(1)).toHaveText(/^launched/);
}

async function stopLauncher(launcher: Launcher): Promise<number | null> {
  launcher.child.kill("SIGINT");
  return launcher.exited;
}

interface Journey {
  page: Page;
  target: Target;
  fp: string;
  launchers: Launcher[];
}

/** Steps 1 to 4: the folder chosen through Chrome's picker, then the launcher paired and ready. */
async function onboard(
  master: LaunchedChrome,
  native: Native,
  target: Target,
  launchers: Launcher[],
): Promise<Journey> {
  const page = await openPage(master, OWNER);
  await expect(banner(page)).toHaveText(/^Choose/);
  mark("choose-banner");
  const dialogs = await native.dialogs(page);
  await clickButton(page, "Choose folder");
  await dialogs.chooseFolder(join(LAB, "workspace"));
  await dialogs.answerWritePrompt("allow");
  await expect(banner(page)).toHaveText("Start the launcher", { timeout: 15_000 });
  mark("folder-chosen");
  const fp = await masterFingerprint(page);
  launchers.push(startLauncher(LAB, target.origin, fp));
  await expect(banner(page)).toHaveText("Ready", { timeout: 60_000 });
  expect(launchers[0]?.output()).toContain(`paired=${fp}`);
  mark("ready");
  return { page, target, fp, launchers };
}

/** Steps 5 and 6: a click through the frame, the worker's flags, then two panel sizes. */
async function launchAndResize({ page, target }: Journey) {
  await page.getByRole("textbox", { name: "Target URL" }).fill(`${target.origin}/interact`);
  await launchAndConnect(page, "Launch");
  await clickRegisters(page, target);
  mark("launched-click");
  const worker = await rootProcesses(LAB);
  expect(worker.some((line) => line.includes("--headless=new"))).toBe(true);
  for (const line of worker) {
    expect(line).not.toContain("--remote-debugging");
    expect(line).not.toContain("--enable-unsafe-extension-debugging");
  }
  const large = await followWindow(page, 1400, 900);
  const small = await followWindow(page, 1000, 700);
  expect(small).not.toEqual(large);
  mark("followed-window");
  await resizeTo(page, target, 1280, 720);
  mark("resized-1280x720");
  await resizeTo(page, target, 800, 600);
  mark("resized-800x600");
}

/** Step 7: a reload, then Reconnect, with no new provisioning in the launcher's log. */
async function reloadAndReconnect({ page, target }: Journey) {
  const provisioned = count(await launcherLog(LAB), "provisioned generation");
  await page.reload();
  await page.getByRole("textbox", { name: "Target URL" }).fill(`${target.origin}/interact`);
  await launchAndConnect(page, "Reconnect");
  await clickRegisters(page, target);
  expect(count(await launcherLog(LAB), "provisioned generation")).toBe(provisioned);
  mark("reloaded-reconnected");
}

/** Steps 8 and 9: SIGINT leaves no process under the roots; a new launcher reconnects. */
async function stopAndRestart(journey: Journey) {
  const { page, target, fp, launchers } = journey;
  expect(await stopLauncher(launchers[0] as Launcher)).toBe(130);
  await expect(banner(page)).toHaveText("Start the launcher", { timeout: 20_000 });
  expect(
    await until(
      () => rootProcesses(LAB),
      (left) => left.length === 0,
      20_000,
    ),
  ).toEqual([]);
  mark("stopped");
  launchers.push(startLauncher(LAB, target.origin, fp));
  await launchAndConnect(page, "Reconnect");
  await clickRegisters(page, target);
  mark("restarted-reconnected");
}

async function keepRecord(launchers: Launcher[], path: string, master: LaunchedChrome) {
  const page = master.browser
    .contexts()[0]
    ?.pages()
    .find((open) => open.url().startsWith(OWNER));
  const view = await page
    ?.evaluate(() => {
      const { lab } = window as unknown as { lab: Record<string, (name?: string) => unknown> };
      return { view: lab.interactView?.(), detail: document.querySelector("section")?.textContent };
    })
    .catch(String);
  const log = await launcherLog(LAB);
  const output = launchers.map((launcher) => launcher.output()).join("\n---\n");
  const listing = await labListing(LAB);
  const record = {
    timings,
    provisioned: count(log, "provisioned generation"),
    output,
    log,
    listing,
    view,
  };
  await writeFile(path, `${JSON.stringify(record, null, 2)}\n`);
  console.log(JSON.stringify({ timings, provisioned: record.provisioned }));
  for (const launcher of launchers) launcher.child.kill("SIGINT");
  await Promise.all(launchers.map((launcher) => launcher.exited));
}

test("W.owner-flow: choose, start the launcher, launch, resize, reconnect, stop, restart", async ({
  native,
}, testInfo) => {
  test.setTimeout(600_000);
  await rm(LAB, { recursive: true, force: true });
  await mkdir(join(LAB, "workspace"), { recursive: true });
  const target = await startTarget();
  const owner = await startOwnerServer();
  const userDataDir = await mkdtemp(join(tmpdir(), "recnrun-owner-master-"));
  const master = await launchMaster(userDataDir);
  const launchers: Launcher[] = [];
  try {
    const journey = await onboard(master, native, target, launchers);
    await launchAndResize(journey);
    await reloadAndReconnect(journey);
    await stopAndRestart(journey);
  } finally {
    const path = testInfo.outputPath("w-owner-flow.json");
    await keepRecord(launchers, path, master);
    await testInfo.attach("w-owner-flow", { path, contentType: "application/json" });
    await master.close();
    await owner.close();
    await target.close();
    await rm(userDataDir, { recursive: true, force: true });
  }
});
