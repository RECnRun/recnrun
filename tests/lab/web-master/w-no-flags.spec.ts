import { randomUUID } from "node:crypto";
import { access, readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { Page } from "@playwright/test";
import { expect, launchChrome, test } from "../../browser/fixtures/chrome.ts";
import type { LaunchedChrome, StrictChrome } from "../../browser/fixtures/chrome.ts";
import { relayLink, startLabSignalRelay } from "./lab-signal-relay.ts";
import type { LabSignalRelay } from "./lab-signal-relay.ts";
import {
  background,
  call,
  jobOps,
  provisionWorker,
  startWorker,
  until,
} from "./lifecycle-harness.ts";
import type { JobStatus } from "./lifecycle-harness.ts";
import { firstFrame, observeStart, pageSigner } from "./observe-harness.ts";
import { startStandIn } from "./stand-in.ts";
import type { StandIn } from "./stand-in.ts";
import { startTarget } from "./target-server.ts";
import type { Target } from "./target-server.ts";
import { NAME, provision } from "./trust-harness.ts";
import { BLUE, masterShows, op, writeEvidence } from "./visual-harness.ts";

/*
 * W6.16 of docs/poc/thin-worker/W6-PLAN.md, Linux lab evidence only (not macOS): the provisioned
 * worker root runs with neither `--remote-debugging-port` nor `--enable-unsafe-extension-debugging`
 * (nor `--silent-debugger-extension-api`), so nothing can attach to it. Its link and readouts go
 * through the LAB-ONLY loopback relay; the job, capture, and frames take the product path.
 */

const FORBIDDEN = /--remote-debugging|--enable-unsafe-extension-debugging|--silent-debugger/;

interface Cell {
  site: StandIn;
  target: Target;
  relay: LabSignalRelay;
  master: LaunchedChrome;
  page: Page;
  root: string;
  worker?: StrictChrome;
}

let shared: Cell | undefined;

test.beforeAll(async () => {
  const site = await startStandIn();
  const target = await startTarget();
  const relay = await startLabSignalRelay();
  const master = await launchChrome({ silentDebugger: false });
  const context = master.browser.contexts()[0] ?? (await master.browser.newContext());
  const page = await context.newPage();
  await page.goto(`${site.origin}/`);
  await expect(page.locator("#status")).toHaveText("ready");
  const key = await pageSigner(page);
  // Provisioned as today, with the flags; the bare launch below reuses the root.
  const { root, id } = await provisionWorker();
  const flagged = await startWorker(root, id);
  await provision(flagged, { masterKey: key.publicKey, allowlist: [target.origin] });
  await background(flagged, `lab.signal(${JSON.stringify(relay.origin)})`);
  await flagged.close();
  shared = { site, target, relay, master, page, root };
});

test.afterAll(async () => {
  const c = shared;
  if (!c) return;
  await c.worker?.close();
  await c.master.close();
  await c.relay.close();
  await c.target.close();
  await c.site.close();
  await rm(c.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const jobStatus = async (page: Page, jobId: string) =>
  (await call<{ jobs: JobStatus[] }>(page, "jobStatus", NAME, [jobId])).jobs[0];

/** The provisioned root started bare; answers its command line and whether a port file exists. */
async function launchBare(c: Cell) {
  const worker = await launchChrome({ cdp: false, userDataDir: c.root, silentDebugger: false });
  c.worker = worker;
  const cmdline = (await readFile(`/proc/${worker.pid}/cmdline`, "utf8")).split("\0");
  return { worker, cmdline };
}

const portFileExists = (root: string) =>
  access(join(root, "DevToolsActivePort")).then(
    () => true,
    () => false,
  );

/** Submits through the link, observes the running job live, and waits for DONE. */
async function observedJob(c: Cell) {
  const jobId = randomUUID();
  const origin = c.target.origin;
  const ops = [
    op("navigate", { url: `${origin}/visual/late` }),
    op("wait", { selector: "#late", state: "attached" }, 20_000),
    ...jobOps(origin, jobId),
  ];
  const job = { jobId, origins: [origin], ops };
  expect(await call<{ status: string }>(c.page, "submit", NAME, job)).toMatchObject({
    status: "ACCEPTED",
  });
  await until(
    () => jobStatus(c.page, jobId),
    (status) => status?.ops[0]?.state === "DONE",
    15_000,
  );
  const requested = performance.now();
  expect(await observeStart(c.page, jobId, "live")).toMatchObject({ ok: true });
  await firstFrame(c.page);
  await masterShows(c.page, BLUE);
  const firstFrameMs = Math.round(performance.now() - requested);
  const done = await until(
    () => jobStatus(c.page, jobId),
    (status) => status?.state === "DONE",
    60_000,
  );
  expect(done?.ops.map((entry) => entry.state)).toEqual(ops.map(() => "DONE"));
  return { jobId, firstFrameMs, state: done?.state };
}

/** The job's result file in the worker's own Downloads. */
const resultState = async (jobId: string) => {
  const file = join(homedir(), "Downloads", "RECnRun", "jobs", `${jobId}.json`);
  const text = await until(
    () => readFile(file, "utf8").catch(() => ""),
    (value) => value.includes('"DONE"'),
    10_000,
  );
  return (JSON.parse(text) as { state: string }).state;
};

test("W6.16: a worker with no debugging flag links, streams, and finishes its job", async () => {
  const c = shared;
  if (!c) throw new Error("The W6.16 setup did not run.");
  const { worker, cmdline } = await launchBare(c);
  expect(cmdline.filter((flag) => FORBIDDEN.test(flag))).toEqual([]);
  const linkStarted = performance.now();
  expect(await relayLink(c.page, c.relay, NAME)).toMatchObject({ ok: true });
  const linkMs = Math.round(performance.now() - linkStarted);
  // No port file: no CDP endpoint exists for anything to attach to.
  const portFile = await portFileExists(c.root);
  expect(portFile).toBe(false);
  const job = await observedJob(c);
  expect(c.target.count(job.jobId)).toBe(1);
  const resultFile = await resultState(job.jobId);
  // The worker's own metrics posts are the only readout of its side.
  await delay(1_500);
  const sent = c.relay.metrics.at(-1)?.body as
    | { sent?: number; maxBuffered?: number; drops?: unknown }
    | undefined;
  expect(sent?.sent ?? 0).toBeGreaterThan(0);
  await writeEvidence("w-no-flags.json", {
    label: "LAB-ONLY: Linux Docker, Google Chrome Stable; not macOS",
    chrome: worker.version,
    workerFlags: cmdline.slice(1),
    devToolsActivePort: portFile,
    relayPolls: c.relay.polls(),
    linkMs,
    ...job,
    posts: c.target.count(job.jobId),
    resultFile,
    metricsPosts: c.relay.metrics.length,
    workerTransport: { sent: sent?.sent, maxBuffered: sent?.maxBuffered, drops: sent?.drops },
  });
});
