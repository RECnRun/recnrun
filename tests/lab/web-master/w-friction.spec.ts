import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestInfo } from "@playwright/test";
import { expect } from "@playwright/test";
import type { LaunchedChrome } from "../../browser/fixtures/chrome.ts";
import type { LoadedExtension } from "../../browser/fixtures/extension-loaders.ts";
import { test } from "../../e2e/fixtures/native-dialogs.ts";
import type { Native } from "../../e2e/fixtures/native-dialogs.ts";
import { install, launchApp } from "./fsa-app.ts";
import { FsaRun, launchMaster, onboard, openPage, visit } from "./fsa-harness.ts";
import {
  FrictionLog,
  SHARED,
  STORE,
  clickPair,
  evidence,
  firstJob,
  rendezvous,
  saveEvidence,
} from "./friction-harness.ts";
import type { Gesture } from "./friction-harness.ts";
import { provisionWorker, startWorker } from "./lifecycle-harness.ts";
import { startStandIn } from "./stand-in.ts";
import type { StandIn } from "./stand-in.ts";
import { startTarget } from "./target-server.ts";
import type { Target } from "./target-server.ts";

/*
 * Cell W.friction of docs/poc/thin-worker/PLAN.md §4 (recorded, not deciding): gestures from a
 * clean master profile to the first job result, for the website in a tab, the website as an
 * installed app, and the Store path simulated as in P6.2. Shared steps are listed apart.
 */

interface Lab {
  site: StandIn;
  target: Target;
  workerRoot: string;
  worker: LoadedExtension;
}

interface Path {
  native: Native;
  log: FrictionLog;
  root: string;
  folder: string;
  master?: LaunchedChrome;
}

let shared: Lab | undefined;
const lab = (): Lab => {
  if (!shared) throw new Error("The W.friction setup did not run.");
  return shared;
};
const totals: Record<string, Gesture[]> = {};

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  const site = await startStandIn();
  const target = await startTarget();
  const { root, id } = await provisionWorker();
  shared = { site, target, workerRoot: root, worker: await startWorker(root, id) };
});

test.afterAll(async () => {
  const c = shared;
  if (!c) return;
  await c.worker.close().catch(() => undefined);
  await c.target.close();
  await c.site.close();
  await rm(c.workerRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

async function startPath(variant: string, native: Native, testInfo: TestInfo): Promise<Path> {
  const fsa = new FsaRun(`friction-${variant}`, await evidence(), testInfo);
  const root = await mkdtemp(join(tmpdir(), `recnrun-friction-${variant}-`));
  return { native, log: new FrictionLog(fsa), root, folder: await rendezvous() };
}

async function endPath(path: Path, variant: string, extra: Record<string, unknown>) {
  totals[variant] = path.log.gestures;
  await saveEvidence(`w-friction-${variant}`, { variant, gestures: path.log.gestures, ...extra });
  await path.master?.close();
  await rm(path.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  await rm(path.folder, { recursive: true, force: true });
}

test("W.friction tab: gestures from a clean profile to the first job result", async ({
  native,
}, testInfo) => {
  const c = lab();
  const path = await startPath("tab", native, testInfo);
  path.master = await launchMaster(path.root);
  // install.sh ends by opening the start page: no gesture of the owner.
  let page = await openPage(path.master, c.site.origin);
  const masterKey = await clickPair(page, path.log);
  await onboard(page, native, path.folder, path.log.fsa);
  await path.log.adopt();
  // The restore prompt that makes the grant persistent comes at the first reopen (W2).
  await page.close();
  page = await openPage(path.master, c.site.origin);
  const label = "onboarding-reopen";
  const step = await visit(path.log.fsa, {
    page,
    native,
    folder: path.folder,
    label,
    mayRestore: true,
    chromePid: path.master.pid,
  });
  expect(step.permission).toBe("granted");
  await path.log.adopt();
  const result = await firstJob(path.log, { page, worker: c.worker, target: c.target, masterKey });
  await endPath(path, "tab", { result, restore: step.prompt });
  expect(path.log.gestures).toHaveLength(7);
});

test("W.friction app: gestures from a clean profile to the first job result", async ({
  native,
}, testInfo) => {
  const c = lab();
  const path = await startPath("app", native, testInfo);
  // CDP's PWA domain needs the pipe (W.fsa app).
  path.master = await launchMaster(path.root, true);
  const tab = await openPage(path.master, c.site.origin);
  await install(path.master, c.site.origin);
  await path.log.gesture("install", "omnibox install icon (PWA.install here)");
  await path.log.gesture("install", "install dialog: Install (PWA.install here)");
  const masterKey = await clickPair(tab, path.log);
  await onboard(tab, native, path.folder, path.log.fsa);
  await path.log.adopt();
  // The omnibox install moves the tab into the app window; the lab launches it instead.
  await tab.close();
  const { page, standalone } = await launchApp(path.master, c.site.origin);
  expect(standalone).toBe(true);
  const result = await firstJob(path.log, { page, worker: c.worker, target: c.target, masterKey });
  await endPath(path, "app", { result, standalone });
  expect(path.log.gestures).toHaveLength(7);
});

test("W.friction: each website path needs fewer gestures than the Store path", async () => {
  const counts = {
    tab: totals.tab?.length ?? Number.NaN,
    app: totals.app?.length ?? Number.NaN,
    store: STORE.length,
  };
  await saveEvidence("w-friction", { counts, shared: SHARED, store: STORE });
  expect(counts.store).toBe(8);
  expect(counts.tab).toBeLessThan(counts.store);
  expect(counts.app).toBeLessThan(counts.store);
});
