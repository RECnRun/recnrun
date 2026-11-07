import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { Page } from "@playwright/test";
import { expect, launchChrome, test } from "../../browser/fixtures/chrome.ts";
import type { LaunchedChrome } from "../../browser/fixtures/chrome.ts";
import type { LoadedExtension } from "../../browser/fixtures/extension-loaders.ts";
import {
  background,
  call,
  jobOps,
  killWorker,
  link,
  masterPages,
  provisionWorker,
  startWorker,
  until,
} from "./lifecycle-harness.ts";
import type { JobStatus } from "./lifecycle-harness.ts";
import { startStandIn } from "./stand-in.ts";
import type { StandIn } from "./stand-in.ts";
import { startTarget } from "./target-server.ts";
import type { Target } from "./target-server.ts";

/*
 * Cell W.lifecycle of docs/poc/thin-worker/PLAN.md §4 (fast track): the stand-in page sends a
 * signed whole job to a worker on a root of its own; the job finishes with no master page, the
 * reopened page reconciles with JOB_STATUS, and a worker killed between effect and ledger write
 * reports OUTCOME_UNKNOWN, never a replay. The harness relays the SDP, as in W.rtc.
 */

const NAME = "worker";
const DONE_MS = 30_000;
const RECONNECT_BUDGET_MS = 60_000;
// The headless-worker project runs this cell with the worker root under --headless.
const headless = () => test.info().project.name === "headless-worker";

interface Cell {
  site: StandIn;
  target: Target;
  master: LaunchedChrome;
  root: string;
  id: string;
  worker: LoadedExtension;
  page?: Page;
  jobIds: string[];
  evidence: Record<string, unknown>;
}

let shared: Cell | undefined;
const cell = (): Cell => {
  if (!shared) throw new Error("The W.lifecycle setup did not run.");
  return shared;
};

const knob = (worker: LoadedExtension, value: unknown) =>
  background(worker, `lab.setKnob(${JSON.stringify(value)})`);
const ledger = (worker: LoadedExtension, jobId: string) =>
  background<JobStatus | undefined>(worker, `lab.job(${JSON.stringify(jobId)})`);
const states = (status: { ops: { state: string }[] }) => status.ops.map((op) => op.state);

async function openMaster(c: Cell): Promise<Page> {
  const context = c.master.browser.contexts()[0] ?? (await c.master.browser.newContext());
  const page = await context.newPage();
  await page.goto(`${c.site.origin}/`);
  await expect(page.locator("#status")).toHaveText("ready");
  expect(await link(page, c.worker, NAME)).toBe(true);
  c.page = page;
  return page;
}

async function submit(c: Cell, page: Page, jobId: string) {
  const job = { jobId, origins: [c.target.origin], ops: jobOps(c.target.origin, jobId) };
  const reply = await call<{ status: string }>(page, "submit", NAME, job);
  expect(reply.status).toBe("ACCEPTED");
  c.jobIds.push(jobId);
}

async function barrierReached(c: Cell, index: number, phase: string) {
  const read = () =>
    background<{ reached: { index: number; phase: string } | null }>(c.worker, "lab.state()");
  await until(
    read,
    (state) => state.reached?.index === index && state.reached.phase === phase,
    DONE_MS,
  );
}

/** Closes the only master page and waits until the worker sees its link close. */
async function closeMaster(c: Cell) {
  const closedAt = Date.now();
  await c.page?.close();
  c.page = undefined;
  expect(await masterPages(c.master, c.site.origin)).toBe(0);
  const read = () => background<{ linkClosedAt: number | null }>(c.worker, "lab.state()");
  const { linkClosedAt } = await until(read, (state) => state.linkClosedAt !== null, DONE_MS);
  return { closedAt, linkClosedAt: linkClosedAt ?? 0 };
}

async function resultFile(c: Cell, jobId: string): Promise<JobStatus & { path: string }> {
  const path = await until(
    () => background<string | null>(c.worker, `lab.resultFile(${JSON.stringify(jobId)})`),
    (value) => value !== null,
    DONE_MS,
  );
  if (path === null) throw new Error("no result file");
  return { ...(JSON.parse(await readFile(path, "utf8")) as JobStatus), path };
}

async function reopenAndReconcile(c: Cell) {
  const reopenedAt = Date.now();
  const page = await openMaster(c);
  const jobs = await call<JobStatus[]>(page, "reconcile", NAME);
  const reconnectMs = Date.now() - reopenedAt;
  expect(reconnectMs).toBeLessThan(RECONNECT_BUDGET_MS);
  expect(await call<number>(page, "sent")).toBe(0);
  return { page, jobs, reconnectMs };
}

test.beforeAll(async () => {
  const site = await startStandIn();
  const target = await startTarget();
  const master = await launchChrome({ silentDebugger: false });
  const { root, id } = await provisionWorker();
  const worker = await startWorker(root, id, headless());
  shared = { site, target, master, root, id, worker, jobIds: [], evidence: {} };
  const masterKey = await call<JsonWebKey>(await openMaster(shared), "pair");
  const provision = { masterKey, allowlist: [target.origin] };
  await background(worker, `lab.provision(${JSON.stringify(provision)})`);
  shared.evidence.chrome = master.version;
  shared.evidence.workerFlags = worker.chrome.flags;
  shared.evidence.workerHeadless = headless();
});

test.afterAll(async () => {
  const c = shared;
  if (!c) return;
  const directory = join(".artifacts/evidence", process.env.RECNRUN_RUN_ID ?? "local");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "w-lifecycle.json"), `${JSON.stringify(c.evidence, null, 2)}\n`);
  console.log(JSON.stringify(c.evidence, null, 2));
  await c.worker.close().catch(() => undefined);
  await c.master.close();
  await c.target.close();
  await c.site.close();
  await rm(c.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

test.describe.configure({ mode: "serial" });

test("W.lifecycle 1: the remaining mutation runs after the page closes between ops", async () => {
  const c = cell();
  const jobId = randomUUID();
  await knob(c.worker, { index: 2, phase: "between" });
  await submit(c, c.page ?? (await openMaster(c)), jobId);
  await barrierReached(c, 2, "between");
  expect(c.target.count(jobId)).toBe(0);
  const closed = await closeMaster(c);
  await background(c.worker, "lab.release()");
  const done = await until(
    () => ledger(c.worker, jobId),
    (job) => job?.state === "DONE",
    DONE_MS,
  );
  const [post] = c.target.posts.filter((entry) => entry.text === jobId);
  expect(post?.at).toBeGreaterThan(closed.linkClosedAt);
  expect(await masterPages(c.master, c.site.origin)).toBe(0);
  expect(done && states(done)).toEqual(["DONE", "DONE", "DONE", "DONE", "DONE"]);
  const file = await resultFile(c, jobId);
  expect(file.state).toBe("DONE");
  c.evidence.betweenOps = { jobId, ...closed, postAt: post?.at, file: file.path, ops: file.ops };
});

test("W.lifecycle 2: the reopened page reconciles every outcome and repeats nothing", async () => {
  const c = cell();
  const [jobId] = c.jobIds;
  await knob(c.worker, null);
  const { page, jobs, reconnectMs } = await reopenAndReconcile(c);
  expect(jobs).toHaveLength(1);
  expect(jobs[0]?.jobId).toBe(jobId);
  expect(jobs[0]?.state).toBe("DONE");
  expect(JSON.stringify(jobs[0]?.ops[4]?.result)).toContain(`received ${jobId}`);
  await expect(page.locator("#journal")).toContainText(`${jobId} DONE`);
  expect(await background<unknown[]>(c.worker, "lab.jobs()")).toHaveLength(1);
  expect(c.target.count(jobId ?? "")).toBe(1);
  c.evidence.reopen = { reconnectMs, jobs };
});

test("W.lifecycle 3: a worker killed between effect and ledger write reports OUTCOME_UNKNOWN", async () => {
  const c = cell();
  const jobId = randomUUID();
  await knob(c.worker, { index: 2, phase: "afterEffect" });
  await submit(c, c.page ?? (await openMaster(c)), jobId);
  await closeMaster(c);
  await barrierReached(c, 2, "afterEffect");
  await until(
    () => Promise.resolve(c.target.count(jobId)),
    (count) => count === 1,
    DONE_MS,
  );
  const killedPid = c.worker.chrome.pid;
  await killWorker(c.worker);
  c.worker = await startWorker(c.root, c.id, headless());
  const recovered = await ledger(c.worker, jobId);
  expect(recovered && [recovered.state, ...states(recovered)]).toEqual([
    "INTERRUPTED",
    "DONE",
    "DONE",
    "OUTCOME_UNKNOWN",
    "SKIPPED",
    "SKIPPED",
  ]);
  await knob(c.worker, null);
  c.evidence.killed = { jobId, killedPid, recovered, ...(await reconcileUnknown(c, jobId)) };
});

async function reconcileUnknown(c: Cell, jobId: string) {
  const { page, jobs, reconnectMs } = await reopenAndReconcile(c);
  expect(jobs.map((job) => [job.jobId, job.state])).toEqual([[jobId, "INTERRUPTED"]]);
  await expect(page.locator("#journal")).toContainText(`${jobId} INTERRUPTED`);
  await expect(page.locator("#journal")).toContainText("click unknown");
  // No replay: the POST count stays 1 after the restart and the reconcile.
  await delay(3_000);
  expect(c.target.count(jobId)).toBe(1);
  expect(await call<number>(page, "sent")).toBe(0);
  const file = await resultFile(c, jobId);
  expect(file.state).toBe("INTERRUPTED");
  return { reconnectMs, file: file.path };
}
