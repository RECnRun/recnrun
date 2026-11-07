import { rm } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import type { Page } from "@playwright/test";
import { expect, launchChrome, test } from "../../browser/fixtures/chrome.ts";
import type { LaunchedChrome } from "../../browser/fixtures/chrome.ts";
import type { LoadedExtension } from "../../browser/fixtures/extension-loaders.ts";
import { ended, settle, signer, submitDirect } from "./admission-harness.ts";
import type { Signer } from "./admission-harness.ts";
import { background, call, provisionWorker, startWorker, until } from "./lifecycle-harness.ts";
import {
  RATE_WINDOW_MS,
  awayOps,
  flow,
  letRun,
  firstFrame,
  masterEvents,
  masterStats,
  observeStart,
  observeStats,
  pageSigner,
  sendSigned,
  startHeld,
  unprovenLink,
} from "./observe-harness.ts";
import { startStandIn } from "./stand-in.ts";
import type { StandIn } from "./stand-in.ts";
import { startTarget } from "./target-server.ts";
import type { Target } from "./target-server.ts";
import { NAME, done, fields, openLinked, provision } from "./trust-harness.ts";
import {
  BLUE,
  masterShows,
  visual,
  visualOps,
  visualStats,
  writeEvidence,
} from "./visual-harness.ts";

/*
 * Slice C of docs/poc/thin-worker/W6-PLAN.md (Gate G3): the master asks for frames with signed,
 * closed OBSERVE_* requests; the worker refuses anything else, caps what it sends, and stops on
 * a document off the job's origins or a lost debugger.
 */

interface Cell {
  site: StandIn;
  target: Target;
  master: LaunchedChrome;
  worker: LoadedExtension;
  page: Page;
  root: string;
  key: Signer;
  jobId: string;
  evidence: Record<string, unknown>;
}

let shared: Cell | undefined;
const cell = (): Cell => {
  if (!shared) throw new Error("The W6.C setup did not run.");
  return shared;
};

test.beforeAll(async () => {
  const site = await startStandIn();
  const target = await startTarget();
  const master = await launchChrome({ silentDebugger: false });
  const { root, id } = await provisionWorker();
  const worker = await startWorker(root, id);
  const page = await openLinked(master, site.origin, worker);
  const key = await pageSigner(page);
  await provision(worker, { masterKey: key.publicKey, allowlist: [target.origin] });
  const evidence = { chrome: master.version };
  shared = { site, target, master, worker, page, root, key, jobId: "", evidence };
});

test.afterAll(async () => {
  const c = shared;
  if (!c) return;
  await writeEvidence("w-observe.json", c.evidence);
  await c.worker.close().catch(() => undefined);
  await c.master.close();
  await c.target.close();
  await c.site.close();
  await rm(c.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

test.describe.configure({ mode: "serial" });

const visualJob = (c: Cell) =>
  startHeld(c.worker, c.key, c.target.origin, () => visualOps(c.target.origin));

test("W6.14: a running job sends no frame until the master asks", async () => {
  const c = cell();
  c.jobId = await visualJob(c);
  await delay(2_000);
  const stats = await observeStats(c.worker);
  expect(stats.sent).toBe(0);
  expect(stats.session).toBeNull();
  expect((await masterStats(c.page)).frames).toBe(0);
  expect((await visualStats(c.worker)).produced).toBe(0);
});

test("W6.13: a signed start shows frames within the mode's caps", async () => {
  const c = cell();
  expect(await observeStart(c.page, c.jobId, "live")).toMatchObject({ ok: true });
  await firstFrame(c.page);
  await masterShows(c.page, BLUE);
  const { sessions } = await masterStats(c.page);
  const live = await flow(c.page, c.worker, 3_000);
  expect(await call(c.page, "observeMode", NAME, "thumbnail")).toMatchObject({ ok: true });
  await delay(1_500);
  const thumbnail = await flow(c.page, c.worker, 3_000);
  const { session } = await observeStats(c.worker);
  // Both ends of 3 s included: one frame at the start, then one per interval.
  expect(live.sent).toBeLessThanOrEqual(16);
  expect(live.size[0]).toBeLessThanOrEqual(960);
  expect(live.size[1]).toBeLessThanOrEqual(540);
  expect(thumbnail.sent).toBeLessThanOrEqual(4);
  expect(thumbnail.sent).toBeGreaterThan(0);
  expect(thumbnail.size[0]).toBeLessThanOrEqual(480);
  expect(thumbnail.size[1]).toBeLessThanOrEqual(270);
  expect(Math.max(live.bytesPerSecond, thumbnail.bytesPerSecond)).toBeLessThanOrEqual(1_048_576);
  expect((session?.authorizedUntil ?? Infinity) - (session?.startedAt ?? 0)).toBeLessThanOrEqual(
    600_000,
  );
  // Master: request built to frame shown; worker: request accepted to frame handed to the link.
  const workerFirstMs = (session?.firstFrameAt ?? 0) - (session?.startedAt ?? 0);
  c.evidence.caps = { firstFrameMs: sessions[0]?.firstFrameMs, workerFirstMs, live, thumbnail };
});

// Built when sent: the worker refuses an issuedAt more than 30 s off its clock as malformed.
const REFUSALS: [string, () => Record<string, unknown>, string][] = [
  ["a field outside the schema", () => ({ url: "https://example.test/" }), "INVALID_REQUEST"],
  [
    "an expired ttl",
    () => ({ issuedAt: Date.now() - 20_000, expiresAt: Date.now() - 1 }),
    "EXPIRED",
  ],
  ["another worker", () => ({ workerId: "pppppppppppppppppppppppppppppppp" }), "WRONG_WORKER"],
  ["an old boot", () => ({ bootId: crypto.randomUUID() }), "OLD_BOOT"],
  ["an unknown job", () => ({ jobId: crypto.randomUUID() }), "UNKNOWN_JOB"],
  ["another tab", () => ({ targetId: 999_999 }), "WRONG_TARGET"],
];

test("W6.13: wrong, replayed, expired, or stale requests are refused and send no frame", async () => {
  const c = cell();
  const status = await call<Record<string, unknown>>(
    c.page,
    "observeSigned",
    NAME,
    "OBSERVE_STATUS",
  );
  expect(await call(c.page, "observeSendRaw", NAME, status)).toMatchObject({ ok: true });
  expect(await call(c.page, "observeSendRaw", NAME, status)).toMatchObject({ code: "REPLAY" });
  expect(await call(c.page, "observeStop", NAME)).toMatchObject({ ok: true });
  const stoppedEpoch = (await call<{ sessionEpoch: number }>(c.page, "observeSession", NAME))
    .sessionEpoch;
  await delay(RATE_WINDOW_MS);
  const [shown, before] = [await masterStats(c.page), await observeStats(c.worker)];
  const codes: Record<string, string | undefined> = {};
  for (const [name, overrides, code] of REFUSALS) {
    const fresh = { sessionEpoch: Date.now(), ...overrides() };
    codes[name] = (await sendSigned(c.page, "OBSERVE_START", fresh)).code;
    expect(codes[name]).toBe(code);
  }
  const other = await signer();
  codes.otherKey = (
    await sendSigned(c.page, "OBSERVE_START", { sessionEpoch: Date.now() }, other)
  ).code;
  codes.oldEpoch = (await sendSigned(c.page, "OBSERVE_START", { sessionEpoch: stoppedEpoch })).code;
  expect(codes).toMatchObject({ otherKey: "UNPINNED_MASTER", oldEpoch: "OLD_EPOCH" });
  await delay(1_500);
  const after = await observeStats(c.worker);
  expect(after.gate.sent).toBe(before.gate.sent);
  expect((await masterStats(c.page)).frames).toBe(shown.frames);
  const counted = Object.values(after.refused).reduce((sum, n) => sum + n, 0);
  expect(counted - Object.values(before.refused).reduce((sum, n) => sum + n, 0)).toBe(8);
  c.evidence.refusals = { codes, refused: after.refused };
});

test("W6.13: requests over the rate are refused", async () => {
  const c = cell();
  await delay(RATE_WINDOW_MS);
  const codes: (string | undefined)[] = [];
  for (let index = 0; index < 25; index += 1) {
    codes.push((await sendSigned(c.page, "OBSERVE_START", { jobId: crypto.randomUUID() })).code);
  }
  expect(codes.filter((code) => code === "UNKNOWN_JOB")).toHaveLength(20);
  expect(codes.filter((code) => code === "RATE_LIMITED")).toHaveLength(5);
  await delay(RATE_WINDOW_MS);
});

test("W6.15: frames on a link whose proof was never checked are not shown", async () => {
  const c = cell();
  const workerId = await background<string>(c.worker, "lab.id()");
  await unprovenLink(c.page, c.worker, "spare");
  const [shown, before] = [await masterStats(c.page), await observeStats(c.worker)];
  expect(await observeStart(c.page, c.jobId, "live", { name: "spare", workerId })).toMatchObject({
    ok: true,
  });
  await until(
    () => observeStats(c.worker),
    (stats) => stats.gate.sent > before.gate.sent + 3,
    15_000,
  );
  const stats = await masterStats(c.page);
  expect(stats.frames).toBe(shown.frames);
  expect((stats.drops.unproven ?? 0) - (shown.drops.unproven ?? 0)).toBeGreaterThan(3);
  expect(await call(c.page, "observeStop", "spare")).toMatchObject({ ok: true });
  await letRun(c.worker);
  await settle(c.worker);
  c.evidence.unproven = { drops: stats.drops };
});

test("W6.13: a redirect off the job's origins stops the stream before its first frame", async () => {
  const c = cell();
  const jobId = await startHeld(c.worker, c.key, c.target.origin, () => awayOps(c.target.origin));
  expect(await observeStart(c.page, jobId, "live")).toMatchObject({ ok: true });
  await firstFrame(c.page);
  await masterShows(c.page, BLUE);
  await letRun(c.worker);
  const stats = await until(
    () => observeStats(c.worker),
    (value) => value.errors.some((error) => error.code === "TARGET_OFF_POLICY"),
    15_000,
  );
  await ended(c.worker, jobId);
  await delay(1_000);
  // The master's last image is still the fixture: no frame of the redirected document arrived.
  await masterShows(c.page, BLUE, 1_000);
  const events = await masterEvents(c.page);
  expect(events.errors.map((error) => error.code)).toContain("TARGET_OFF_POLICY");
  expect(stats.session).toBeNull();
  c.evidence.offPolicy = { policyDrops: stats.policyDrops, ended: stats.ended.at(-1) };
});

test("W6.12: a lost debugger is reported once and the worker runs the next job", async () => {
  const c = cell();
  const jobId = await startHeld(c.worker, c.key, c.target.origin, () => visualOps(c.target.origin));
  expect(await observeStart(c.page, jobId, "live")).toMatchObject({ ok: true });
  await firstFrame(c.page);
  await masterShows(c.page, BLUE);
  const { errors } = await observeStats(c.worker);
  const { starts } = await visualStats(c.worker);
  await visual(c.worker, "fault", "chrome-url");
  await until(
    () => observeStats(c.worker),
    (value) => value.errors.length > errors.length,
    15_000,
  );
  await delay(2_000);
  const later = await observeStats(c.worker);
  expect(later.errors.slice(errors.length).map((error) => error.code)).toEqual(["CDP_DETACHED"]);
  expect((await visualStats(c.worker)).starts).toBe(starts);
  await letRun(c.worker);
  await ended(c.worker, jobId);
  const next = await c.key.sign(fields(c.target.origin));
  expect((await submitDirect(c.worker, next)).status).toBe("ACCEPTED");
  await done(c.worker, String(next.jobId));
  expect(c.target.count(String(next.jobId))).toBe(1);
  c.evidence.detach = { errors: later.errors.slice(errors.length), ended: later.ended.at(-1) };
});
