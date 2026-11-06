import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { Page, TestInfo } from "@playwright/test";
import type { LaunchedChrome } from "../../browser/fixtures/chrome.ts";
import { expect } from "@playwright/test";
import { test } from "../../e2e/fixtures/native-dialogs.ts";
import type { Native } from "../../e2e/fixtures/native-dialogs.ts";
import { discards, install, installState, launchApp, uninstall } from "./fsa-app.ts";
import {
  FsaRun,
  MARKER,
  evidenceDirectory,
  launchMaster,
  onboard,
  openPage,
  pair,
  waitReady,
  restoredAt,
  thumbprint,
  visit,
} from "./fsa-harness.ts";
import type { FsaWindow, Step } from "./fsa-harness.ts";
import { startStandIn } from "./stand-in.ts";
import type { StandIn } from "./stand-in.ts";

/*
 * Cell W.fsa of docs/poc/thin-worker/PLAN.md §4 (fast track): the stand-in page picks the
 * rendezvous folder once and keeps read and write access, with no gesture after onboarding, across
 * a page close and two Chrome restarts of the same root. Variant `tab` decides; `app` is recorded.
 */

interface Cell {
  site: StandIn;
  native: Native;
  root: string;
  folder: string;
  log: FsaRun;
  master?: LaunchedChrome;
  pipe: boolean;
}

let standIn: StandIn | undefined;

test.beforeAll(async () => {
  standIn = await startStandIn();
});

test.afterAll(async () => {
  await standIn?.close();
});

async function prepare(variant: string, native: Native, testInfo: TestInfo): Promise<Cell> {
  const site = standIn;
  if (!site) throw new Error("The HTTPS stand-in did not start.");
  const root = await mkdtemp(join(tmpdir(), `recnrun-fsa-${variant}-`));
  const folder = join(homedir(), "RECnRun", "rendezvous");
  await rm(folder, { recursive: true, force: true });
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, MARKER), JSON.stringify({ id: randomUUID() }));
  const log = new FsaRun(variant, await evidenceDirectory(), testInfo);
  // CDP's PWA domain needs a client allowed unsafe operations: the pipe, not the port.
  const pipe = variant === "app";
  return { site, native, root, folder, log, pipe };
}

async function cleanUp(cell: Cell): Promise<void> {
  await cell.master?.close();
  await rm(cell.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  await rm(cell.folder, { recursive: true, force: true });
}

/** Quits Chrome (SIGTERM, its orderly quit) and starts it again on the same root. */
async function restart(cell: Cell): Promise<LaunchedChrome> {
  await cell.master?.close();
  cell.master = await launchMaster(cell.root, cell.pipe);
  return cell.master;
}

const step = (cell: Cell, page: Page, label: string, mayRestore: boolean) =>
  visit(cell.log, {
    page,
    native: cell.native,
    folder: cell.folder,
    label,
    mayRestore,
    chromePid: cell.master?.pid ?? 0,
  });

/** The technical pass of one visit: granted, marker read, file written, same identity. */
function assertKept(result: Step, onboardingThumbprint: string): void {
  expect(result.error).toBeUndefined();
  expect(result.permission).toBe("granted");
  expect(result.marker).toBe(true);
  expect(result.written).toBe(true);
  expect(result.thumbprint).toBe(onboardingThumbprint);
}

test("W.fsa tab: the folder grant survives a page close and two Chrome restarts", async ({
  native,
}, testInfo) => {
  const cell = await prepare("tab", native, testInfo);
  try {
    let page = await openPage(await restart(cell), cell.site.origin);
    await pair(page);
    const identity = await thumbprint(page);
    await onboard(page, native, cell.folder, cell.log);
    const results = [await step(cell, page, "onboarding", false)];
    await page.reload();
    await waitReady(page);
    results.push(await step(cell, page, "onboarding-reload", true));
    await page.close();
    page = await openPage(cell.master as LaunchedChrome, cell.site.origin);
    results.push(await step(cell, page, "onboarding-reopen", !restoredAt(cell.log)));
    // From here on, onboarding is over: a page close and two restarts with no gesture.
    await page.close();
    page = await openPage(cell.master as LaunchedChrome, cell.site.origin);
    results.push(await step(cell, page, "reopen", false));
    page = await openPage(await restart(cell), cell.site.origin);
    // Reading B of the brief: a restore Chrome offers only after a restart is onboarding friction.
    results.push(await step(cell, page, "restart-1", !restoredAt(cell.log)));
    page = await openPage(await restart(cell), cell.site.origin);
    results.push(await step(cell, page, "restart-2", false));
    const path = await cell.log.save({
      chrome: cell.master?.version,
      flags: cell.master?.flags,
      identity,
      restoreAnsweredAt: restoredAt(cell.log) ?? "never",
    });
    testInfo.annotations.push({ type: "evidence", description: path });
    for (const result of results) assertKept(result, identity);
  } finally {
    await cleanUp(cell);
  }
});

/** Opens the app as its shortcut would, and records the grant with no gesture at all. */
async function appVisit(cell: Cell, master: LaunchedChrome, label: string) {
  const { page, standalone } = await launchApp(master, cell.site.origin);
  const result = await step(cell, page, label, false);
  result.standalone = standalone;
  return { page, result };
}

test("W.fsa app: the installed app keeps the folder grant across two Chrome restarts", async ({
  native,
}, testInfo) => {
  const cell = await prepare("app", native, testInfo);
  const observed: Record<string, unknown> = {};
  try {
    const master = await restart(cell);
    const tab = await openPage(master, cell.site.origin);
    await pair(tab);
    const identity = await thumbprint(tab);
    await install(master, cell.site.origin);
    cell.log.gesture("install", "omnibox install icon, then Install (CDP PWA.install here)");
    observed.installState = await installState(master, cell.site.origin);
    observed.persistTab = await tab.evaluate(() =>
      (window as unknown as FsaWindow).lab.fsa.persist(),
    );
    await onboard(tab, native, cell.folder, cell.log);
    const results = [await step(cell, tab, "onboarding", false)];
    await tab.close();
    let app = await appVisit(cell, master, "app-launch");
    results.push(app.result);
    observed.persistApp = await app.page.evaluate(() =>
      (window as unknown as FsaWindow).lab.fsa.persist(),
    );
    observed.discards = await discards(master);
    for (const label of ["restart-1", "restart-2"]) {
      app = await appVisit(cell, await restart(cell), label);
      results.push(app.result);
    }
    observed.installStateAfter = await installState(
      cell.master as LaunchedChrome,
      cell.site.origin,
    );
    await uninstall(cell.master as LaunchedChrome, cell.site.origin);
    const after = await openPage(cell.master as LaunchedChrome, cell.site.origin);
    observed.afterUninstall = await after.evaluate(() =>
      (window as unknown as FsaWindow).lab.fsa.status(),
    );
    const path = await cell.log.save({ chrome: cell.master?.version, identity, ...observed });
    testInfo.annotations.push({ type: "evidence", description: path });
    for (const result of results) assertKept(result, identity);
  } finally {
    await cleanUp(cell);
  }
});
