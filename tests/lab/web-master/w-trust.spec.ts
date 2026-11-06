import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";
import { launchChrome } from "../../browser/fixtures/chrome.ts";
import type { LaunchedChrome } from "../../browser/fixtures/chrome.ts";
import type { LoadedExtension } from "../../browser/fixtures/extension-loaders.ts";
import { test } from "../../e2e/fixtures/native-dialogs.ts";
import { FsaRun, MARKER, onboard, pair, thumbprint } from "./fsa-harness.ts";
import type { FsaWindow } from "./fsa-harness.ts";
import { background, provisionWorker, startWorker } from "./lifecycle-harness.ts";
import { SITE, startStandIn } from "./stand-in.ts";
import type { StandIn } from "./stand-in.ts";
import { startTarget } from "./target-server.ts";
import type { Target } from "./target-server.ts";
import {
  clearOrigin,
  done,
  hostileSite,
  masterKey,
  openLinked,
  provision,
  provisioned,
  scripts,
  submit,
  updatedSite,
} from "./trust-harness.ts";
import type { Provision } from "./trust-harness.ts";
import { deadline, refusals } from "./trust-refusals.ts";

/*
 * Cell W.trust of docs/poc/thin-worker/PLAN.md §4 (fast track): a site update and a cache-only
 * clear keep the master identity; a site-data clear fails closed until the onboarding script pins
 * a new key; changed same-origin code holding the real key stays inside the worker's limits.
 */

interface Cell {
  site: StandIn;
  target: Target;
  outside: Target;
  master: LaunchedChrome;
  root: string;
  worker: LoadedExtension;
  page: Page;
  pinned: Provision;
  identity: string;
  evidence: Record<string, unknown>;
}

let shared: Cell | undefined;
const cell = (): Cell => {
  if (!shared) throw new Error("The W.trust setup did not run.");
  return shared;
};

/** Closes the page and opens it again, as a person reopening the site after a change. */
async function reopen(c: Cell, ready = "ready"): Promise<Page> {
  await c.page.close();
  c.page = await openLinked(c.master, c.site.origin, c.worker, ready);
  return c.page;
}

/** An honest job of the page: accepted, run to DONE, one POST. */
async function honestJob(c: Cell) {
  const jobId = randomUUID();
  const reply = await submit(c.page, c.target.origin, jobId);
  expect(reply.status).toBe("ACCEPTED");
  await done(c.worker, jobId);
  expect(c.target.count(jobId)).toBe(1);
  return jobId;
}

test.beforeAll(async () => {
  const site = await startStandIn();
  const target = await startTarget();
  const outside = await startTarget();
  const master = await launchChrome({ silentDebugger: false });
  const { root, id } = await provisionWorker();
  const worker = await startWorker(root, id);
  const page = await openLinked(master, site.origin, worker);
  // The onboarding script pins the master key and the allowlist; the page has no say in either.
  const pinned = { masterKey: await pair(page), allowlist: [target.origin] };
  await provision(worker, pinned);
  const identity = await thumbprint(page);
  const evidence = { chrome: master.version, workerFlags: worker.chrome.flags, identity };
  shared = { site, target, outside, master, root, worker, page, pinned, identity, evidence };
});

test.afterAll(async () => {
  const c = shared;
  if (!c) return;
  const directory = join(".artifacts/evidence", process.env.RECNRUN_RUN_ID ?? "local");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "w-trust.json"), `${JSON.stringify(c.evidence, null, 2)}\n`);
  console.log(JSON.stringify(c.evidence, null, 2));
  await c.worker.close().catch(() => undefined);
  await c.master.close();
  await c.target.close();
  await c.outside.close();
  await c.site.close();
  await rm(c.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

test.describe.configure({ mode: "serial" });

test("W.trust 1: a site update keeps the key and the worker still runs its jobs", async () => {
  const c = cell();
  const before = await honestJob(c);
  c.site.serve(await updatedSite("v2"));
  const page = await reopen(c);
  const served = await scripts(page);
  expect(served).toContain("/master-v2.js");
  expect(await thumbprint(page)).toBe(c.identity);
  const after = await honestJob(c);
  c.evidence.update = { before, after, served };
});

test("W.trust 2: a cache-only clear keeps the key and the worker still runs its jobs", async () => {
  const c = cell();
  await clearOrigin(c.page, c.site.origin, "cache");
  const page = await reopen(c);
  expect(await thumbprint(page)).toBe(c.identity);
  c.evidence.cacheClear = { jobId: await honestJob(c) };
});

test("W.trust 3: changed same-origin code with the real key stays inside the worker's limits", async () => {
  const c = cell();
  c.site.serve(await hostileSite());
  const page = await reopen(c, "ready hostile");
  expect(await thumbprint(page)).toBe(c.identity);
  const outcomes = await refusals(page, c);
  expect(c.outside.posts).toHaveLength(0);
  expect(await provisioned(c.worker)).toEqual(c.pinned);
  c.evidence.hostile = outcomes;
});

test("W.trust 3b: the worker stops a job at its deadline", async () => {
  const c = cell();
  c.site.serve(await hostileSite());
  const page = await reopen(c, "ready hostile");
  c.evidence.deadline = await deadline(page, c);
});

const persist = (p: Page) => p.evaluate(() => (window as unknown as FsaWindow).lab.fsa.persist());
const fsa = (p: Page) => p.evaluate(() => (window as unknown as FsaWindow).lab.fsa.status());

/** A fresh rendezvous folder with its marker, as the onboarding script leaves it. */
async function rendezvous(): Promise<string> {
  const folder = join(homedir(), "RECnRun", "rendezvous");
  await rm(folder, { recursive: true, force: true });
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, MARKER), JSON.stringify({ id: randomUUID() }));
  return folder;
}

/** After the clear: no key, no folder, no signing, and no new key until the owner asks. */
async function lostEverything(c: Cell, page: Page) {
  await expect(page.locator("#identity")).toHaveText("Pair again");
  await delay(2_000);
  expect(await masterKey(page)).toBeNull();
  const lost = { fsa: await fsa(page) };
  expect(lost.fsa.handle).toBe(false);
  await expect(submit(page, c.target.origin)).rejects.toThrow(/PAIR_AGAIN/);
  return lost;
}

/** A new key the owner made with "Pair again" is refused until the onboarding script pins it. */
async function newKeyRefused(c: Cell, page: Page, log: FsaRun) {
  const sent = c.target.posts.length;
  await page.click("#pair");
  log.gesture("pair again", "click Pair again");
  await expect(page.locator("#identity")).toHaveText("paired");
  const fresh = await thumbprint(page);
  expect(fresh).not.toBe(c.identity);
  const jobId = randomUUID();
  const unpinned = await submit(page, c.target.origin, jobId);
  expect(unpinned.status).toBe("UNPINNED_MASTER");
  await delay(2_000);
  expect(c.target.posts.length).toBe(sent);
  expect(await background(c.worker, `lab.job(${JSON.stringify(jobId)})`)).toBeUndefined();
  return { fresh, unpinned };
}

test("W.trust 4: a site-data clear fails closed until the onboarding script pins a new key", async ({
  native,
}, testInfo) => {
  const c = cell();
  const folder = await rendezvous();
  const directory = join(".artifacts/evidence", process.env.RECNRUN_RUN_ID ?? "local", "w-trust");
  await mkdir(directory, { recursive: true });
  const log = new FsaRun("trust", directory, testInfo);
  c.site.serve(SITE);
  let page = await reopen(c);
  await onboard(page, native, folder, log);
  const before = { fsa: await fsa(page), storage: await persist(page) };
  expect(before.fsa.permission).toBe("granted");
  await clearOrigin(page, c.site.origin, "all");
  page = await reopen(c);
  const lost = await lostEverything(c, page);
  const refused = await newKeyRefused(c, page, log);
  await onboard(page, native, folder, log);
  const newKey = await masterKey(page);
  if (!newKey) throw new Error("no key after Pair again");
  // The onboarding script, outside the page's power, pins the new key: service comes back.
  await provision(c.worker, { ...c.pinned, masterKey: newKey });
  const repaired = await honestJob(c);
  await rm(folder, { recursive: true, force: true });
  c.evidence.siteDataClear = { before, lost, ...refused, repaired, gestures: log.gestures };
});
