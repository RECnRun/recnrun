import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, test } from "../../browser/fixtures/chrome.ts";
import type { LaunchedChrome } from "../../browser/fixtures/chrome.ts";
import type { LoadedExtension } from "../../browser/fixtures/extension-loaders.ts";
import { ended } from "./admission-harness.ts";
import type { Signer } from "./admission-harness.ts";
import { launchMaster, openPage } from "./fsa-harness.ts";
import {
  background,
  call,
  killWorker,
  link,
  provisionWorker,
  startWorker,
  until,
} from "./lifecycle-harness.ts";
import {
  firstFrame,
  letRun,
  masterEvents,
  observeStart,
  observeStats,
  pageSigner,
  postOps,
  sendSigned,
  startHeld,
} from "./observe-harness.ts";
import { startStandIn } from "./stand-in.ts";
import type { StandIn } from "./stand-in.ts";
import { startTarget } from "./target-server.ts";
import type { Target } from "./target-server.ts";
import { NAME, openLinked, provision } from "./trust-harness.ts";
import { BLUE, masterShows, visualOps, writeEvidence } from "./visual-harness.ts";

/*
 * Slice C of docs/poc/thin-worker/W6-PLAN.md (Gate G3), the lifecycle: the master killed, the
 * master reopened on its own profile, the worker restarted, nothing stored, and the bounded grant.
 */

interface Cell {
  site: StandIn;
  target: Target;
  masterDir: string;
  master: LaunchedChrome;
  worker: LoadedExtension;
  page: Page;
  root: string;
  id: string;
  key: Signer;
  jobId: string;
  evidence: Record<string, unknown>;
}

let shared: Cell | undefined;
const cell = (): Cell => {
  if (!shared) throw new Error("The W6.C lifecycle setup did not run.");
  return shared;
};

test.beforeAll(async () => {
  const site = await startStandIn();
  const target = await startTarget();
  const masterDir = await mkdtemp(join(tmpdir(), "recnrun-lab-master-"));
  const master = await launchMaster(masterDir);
  const { root, id } = await provisionWorker();
  const worker = await startWorker(root, id);
  const page = await openLinked(master, site.origin, worker);
  const key = await pageSigner(page);
  await provision(worker, { masterKey: key.publicKey, allowlist: [target.origin] });
  const evidence = { chrome: master.version };
  shared = { site, target, masterDir, master, worker, page, root, id, key, jobId: "", evidence };
});

test.afterAll(async () => {
  const c = shared;
  if (!c) return;
  await writeEvidence("w-observe-life.json", c.evidence);
  await c.worker.close().catch(() => undefined);
  await c.master.close();
  await c.target.close();
  await c.site.close();
  for (const directory of [c.root, c.masterDir]) {
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test.describe.configure({ mode: "serial" });

const lastEnd = async (worker: LoadedExtension) => (await observeStats(worker)).ended.at(-1);

test("W6.09: a killed master stops the stream within the lease; the job posts once", async () => {
  const c = cell();
  c.jobId = await startHeld(c.worker, c.key, c.target.origin, (jobId) =>
    postOps(c.target.origin, jobId),
  );
  expect(await observeStart(c.page, c.jobId, "thumbnail")).toMatchObject({ ok: true });
  await firstFrame(c.page);
  const killedAt = Date.now();
  process.kill(c.master.pid, "SIGKILL");
  const stats = await until(
    () => observeStats(c.worker),
    (value) => value.session === null,
    15_000,
  );
  const end = stats.ended.at(-1);
  expect(end?.reason).toBe("LEASE_EXPIRED");
  const stopMs = (end?.at ?? 0) - killedAt;
  // A lease of 3 s from the last renewal (at most 1 s before the kill), checked every 250 ms.
  expect(stopMs).toBeLessThanOrEqual(3_250);
  expect(stats.gate.pending).toBe(false);
  await letRun(c.worker);
  expect((await ended(c.worker, c.jobId)).state).toBe("DONE");
  expect(c.target.count(c.jobId)).toBe(1);
  await c.master.close();
  c.evidence.masterGone = { stopMs, end, posts: c.target.count(c.jobId) };
});

test("W6.10: a reopened master reconciles, starts anew, and duplicates nothing", async () => {
  const c = cell();
  c.master = await launchMaster(c.masterDir);
  c.page = await openPage(c.master, c.site.origin);
  expect(await link(c.page, c.worker, NAME)).toBe(true);
  // The key the profile kept, not a new one: the worker's pin still holds.
  const pinned = c.key.publicKey;
  c.key = await pageSigner(c.page);
  expect(c.key.publicKey).toEqual(pinned);
  const status = await call<{ jobs: { state: string }[] }>(c.page, "jobStatus", NAME, [c.jobId]);
  expect(status.jobs[0]?.state).toBe("DONE");
  const jobId = await startHeld(c.worker, c.key, c.target.origin, () => visualOps(c.target.origin));
  const started = Date.now();
  expect(await observeStart(c.page, jobId, "live")).toMatchObject({ ok: true });
  await firstFrame(c.page);
  await masterShows(c.page, BLUE);
  const resumeMs = Date.now() - started;
  const finished = await sendSigned(c.page, "OBSERVE_STATUS", { jobId: c.jobId });
  expect(finished.code).toBe("JOB_FINISHED");
  await letRun(c.worker);
  await ended(c.worker, jobId);
  expect(c.target.count(c.jobId)).toBe(1);
  c.evidence.reopen = { reconciled: status.jobs[0]?.state, resumeMs, finished: finished.code };
});

test("W6.14: neither side keeps a frame after streaming", async () => {
  const c = cell();
  const worker = await background<{ jpegIn: string[]; caches: string[]; downloads: string[] }>(
    c.worker,
    "lab.scan()",
  );
  const master = await call<{
    jpegIn: string[];
    caches: string[];
    opfs: string[];
    databases: { name: string; stores: string[] }[];
  }>(c.page, "scan");
  expect(worker.jpegIn).toEqual([]);
  expect(worker.caches).toEqual([]);
  expect(worker.downloads.filter((name) => /\.jpe?g$/i.test(name))).toEqual([]);
  expect(master.jpegIn).toEqual([]);
  expect(master.caches).toEqual([]);
  expect(master.opfs).toEqual([]);
  expect(master.databases).toEqual([{ name: "recnrun-lab", stores: ["keys"] }]);
  c.evidence.scan = { worker, master };
});

test("W6.13: a restarted worker refuses its old boot and sends nothing", async () => {
  const c = cell();
  const before = await call<{ bootId: string }>(c.page, "jobStatus", NAME, []);
  await killWorker(c.worker);
  c.worker = await startWorker(c.root, c.id);
  expect(await link(c.page, c.worker, NAME)).toBe(true);
  const after = await call<{ bootId: string }>(c.page, "jobStatus", NAME, []);
  expect(after.bootId).not.toBe(before.bootId);
  const old = { bootId: before.bootId, sessionEpoch: Date.now() };
  expect((await sendSigned(c.page, "OBSERVE_START", old)).code).toBe("OLD_BOOT");
  const stats = await observeStats(c.worker);
  expect(stats.refused).toEqual({ OLD_BOOT: 1 });
  expect(stats.gate.sent).toBe(0);
  c.evidence.restart = { before: before.bootId, after: after.bootId, refused: stats.refused };
});

test("W6.13: the grant ends at its bound even while the master renews", async () => {
  const c = cell();
  await background(c.worker, "lab.observe.limit({ maxAuthMs: 4000 })");
  const jobId = await startHeld(c.worker, c.key, c.target.origin, () => visualOps(c.target.origin));
  expect(await observeStart(c.page, jobId, "thumbnail")).toMatchObject({ ok: true });
  await firstFrame(c.page);
  await until(
    () => observeStats(c.worker),
    (value) => value.session === null,
    15_000,
  );
  const end = await lastEnd(c.worker);
  expect(end?.reason).toBe("AUTHORIZATION_EXPIRED");
  const events = await until(
    () => masterEvents(c.page),
    (value) => (value.renewals.refused.NO_SESSION ?? 0) > 0,
    5_000,
  );
  expect(events.renewals.ok).toBeGreaterThan(0);
  await letRun(c.worker);
  await ended(c.worker, jobId);
  c.evidence.grant = { end, renewals: events.renewals };
});
