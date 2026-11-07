import { rm } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import type { Page } from "@playwright/test";
import { expect, launchChrome, test } from "../../browser/fixtures/chrome.ts";
import type { LaunchedChrome } from "../../browser/fixtures/chrome.ts";
import type { LoadedExtension } from "../../browser/fixtures/extension-loaders.ts";
import { ended, signer } from "./admission-harness.ts";
import type { Signer } from "./admission-harness.ts";
import {
  OTHER,
  interactStart,
  interactState,
  prepare,
  raw,
  released,
  sendStart,
  session,
  stopInteract,
  unsigned,
} from "./interact-harness.ts";
import { background, call, link, provisionWorker, startWorker } from "./lifecycle-harness.ts";
import { letRun, pageSigner, startHeld } from "./observe-harness.ts";
import { startStandIn } from "./stand-in.ts";
import type { StandIn } from "./stand-in.ts";
import { startTarget } from "./target-server.ts";
import type { Target } from "./target-server.ts";
import { NAME, done, openLinked, provision, submit } from "./trust-harness.ts";
import { visualOps } from "./visual-harness.ts";

/*
 * Slice A of docs/poc/thin-worker/W7-PLAN.md: a signed start bound to its link, a 3 s lease
 * renewed each second, and one admission shared by jobs and interaction.
 */

interface Cell {
  site: StandIn;
  target: Target;
  master: LaunchedChrome;
  worker: LoadedExtension;
  page: Page;
  root: string;
  key: Signer;
}

let shared: Cell | undefined;
const cell = (): Cell => {
  if (!shared) throw new Error("The W7.A setup did not run.");
  return shared;
};

test.beforeAll(async () => {
  const site = await startStandIn();
  const target = await startTarget();
  const master = await launchChrome({ silentDebugger: false });
  const { root, id } = await provisionWorker();
  const worker = await startWorker(root, id);
  const page = await openLinked(master, site.origin, worker);
  expect(await link(page, worker, OTHER)).toBe(true);
  const key = await pageSigner(page);
  await provision(worker, { masterKey: key.publicKey, allowlist: [target.origin] });
  shared = { site, target, master, worker, page, root, key };
});

test.afterAll(async () => {
  const c = shared;
  if (!c) return;
  await c.worker.close().catch(() => undefined);
  await c.master.close();
  await c.target.close();
  await c.site.close();
  await rm(c.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

test.describe.configure({ mode: "serial" });

const url = (c: Cell) => `${c.target.origin}/`;
const enable = (c: Cell) =>
  provision(c.worker, {
    masterKey: c.key.publicKey,
    allowlist: [c.target.origin],
    interactEnabled: true,
  });

test.beforeEach(() => enable(cell()));

test("interaction is off by default and only for allowlisted origins", async () => {
  const c = cell();
  await provision(c.worker, { masterKey: c.key.publicKey, allowlist: [c.target.origin] });
  expect(await interactStart(c.page, url(c))).toMatchObject({
    ok: false,
    code: "INTERACT_DISABLED",
  });
  await enable(c);
  expect(await interactStart(c.page, "http://127.0.0.1:9/")).toMatchObject({
    code: "ORIGIN_DENIED",
  });
  const state = await interactState(c.worker);
  expect(state).toMatchObject({ lease: null, claim: null, stats: { started: 0 } });
});

test("N14: unsigned, forged, and transplanted starts are refused with no effect", async () => {
  const c = cell();
  const { start } = await prepare(c.page, url(c));
  if (!start) throw new Error("no start prepared");
  expect(await raw(c.page, unsigned(start))).toMatchObject({ code: "INVALID_REQUEST" });
  expect(await raw(c.page, { ...start, signature: "AAAA" })).toMatchObject({
    code: "BAD_SIGNATURE",
  });
  const forged = await (await signer()).sign(unsigned(start));
  expect(await raw(c.page, forged)).toMatchObject({ code: "BAD_SIGNATURE" });
  // A's start carried to B, B's nonce signed over A's fingerprints, A's nonce over B's.
  expect(await raw(c.page, start, OTHER)).toMatchObject({ code: "LINK_MISMATCH" });
  const ownA = await call<Record<string, string>>(c.page, "interactFingerprints", NAME);
  const ownB = await call<Record<string, string>>(c.page, "interactFingerprints", OTHER);
  const onB = await prepare(c.page, url(c), ownA, OTHER);
  expect(await raw(c.page, onB.start, OTHER)).toMatchObject({ code: "LINK_MISMATCH" });
  const onA = await prepare(c.page, url(c), ownB);
  expect(await raw(c.page, onA.start)).toMatchObject({ code: "LINK_MISMATCH" });
  expect(await interactState(c.worker)).toMatchObject({ lease: null, claim: null });
  // The refusals spent nothing: A's own start still claims, and B cannot act on A's lease.
  const reply = await sendStart(c.page, start);
  expect(reply).toMatchObject({ ok: true, leaseMs: 3_000, renewMs: 1_000 });
  const renewOnB = { type: "INTERACT_RENEW", leaseId: reply.leaseId, seq: 50 };
  expect(await raw(c.page, renewOnB, OTHER)).toMatchObject({ code: "LINK_MISMATCH" });
  expect((await interactState(c.worker)).lease?.leaseId).toBe(reply.leaseId);
  expect(await stopInteract(c.page)).toMatchObject({ ok: true });
  await released(c.worker);
});

test("N4: a resent start and a replayed seq are refused; the replay revokes", async () => {
  const c = cell();
  const { start } = await prepare(c.page, url(c));
  expect(await sendStart(c.page, start)).toMatchObject({ ok: true });
  expect(await raw(c.page, start)).toMatchObject({ code: "REPLAY" });
  await delay(1_500);
  await call(c.page, "interactPause", NAME);
  const { lease, seq } = await session(c.page);
  expect(seq).toBeGreaterThan(0);
  const replayed = { type: "INTERACT_RENEW", leaseId: lease?.leaseId, seq };
  expect(await raw(c.page, replayed)).toMatchObject({ code: "SEQ_REPLAY" });
  const next = { ...replayed, seq: seq + 1 };
  expect(await raw(c.page, next)).toMatchObject({ code: "SESSION_REVOKED", reason: "SEQ_REPLAY" });
  await released(c.worker);
});

test("N9: with no renewal the lease expires and later input is refused", async () => {
  const c = cell();
  expect(await interactStart(c.page, url(c))).toMatchObject({ ok: true });
  // Renewals keep it past its 3 s lease.
  await delay(4_000);
  expect((await interactState(c.worker)).lease).not.toBeNull();
  await call(c.page, "interactPause", NAME);
  await delay(3_600);
  const state = await interactState(c.worker);
  expect(state).toMatchObject({ lease: null, claim: null });
  expect(state.stats.revoked.LEASE_EXPIRED).toBe(1);
  const { pushes } = await session(c.page);
  expect(pushes.at(-1)).toMatchObject({ type: "INTERACT_REVOKED", reason: "LEASE_EXPIRED" });
  const event = await call(c.page, "interactEvent", NAME, "pointerDown");
  expect(event).toMatchObject({ code: "SESSION_REVOKED", reason: "LEASE_EXPIRED" });
});

test("N1: a start while a job runs is BUSY", async () => {
  const c = cell();
  const jobId = await startHeld(c.worker, c.key, c.target.origin, () => visualOps(c.target.origin));
  expect(await interactStart(c.page, url(c))).toMatchObject({ ok: false, code: "BUSY" });
  expect((await interactState(c.worker)).claim).toBe(jobId);
  await letRun(c.worker);
  await ended(c.worker, jobId);
});

test("N2: a job while interacting is BUSY and leaves no ledger entry", async () => {
  const c = cell();
  const started = await interactStart(c.page, url(c));
  expect(started).toMatchObject({ ok: true });
  expect((await interactState(c.worker)).claim).toBe(started.interactId);
  const busy = await submit(c.page, c.target.origin);
  expect(busy.status).toBe("BUSY");
  expect(await background(c.worker, `lab.job(${JSON.stringify(busy.jobId)})`)).toBeFalsy();
  expect(await stopInteract(c.page)).toMatchObject({ ok: true });
  await released(c.worker);
  const accepted = await submit(c.page, c.target.origin);
  expect(accepted.status).toBe("ACCEPTED");
  await done(c.worker, String(accepted.jobId));
});

test("N3: of two concurrent starts on two links one wins", async () => {
  const c = cell();
  const replies = await Promise.all([
    interactStart(c.page, url(c)),
    interactStart(c.page, url(c), OTHER),
  ]);
  expect(replies.map((reply) => reply.code ?? "ok").sort()).toEqual(["BUSY", "ok"]);
  const winner = replies[0].ok ? NAME : OTHER;
  expect(await stopInteract(c.page, winner)).toMatchObject({ ok: true });
  await released(c.worker);
});

test("N15: a latched worker stop revokes and refuses starts until cleared", async () => {
  const c = cell();
  const ready = await prepare(c.page, url(c));
  expect(await interactStart(c.page, url(c), OTHER)).toMatchObject({ ok: true });
  expect(await background(c.worker, "lab.interact.stop()")).toBe(true);
  // The revocation is pushed after the hook answers, so the page may see it a moment later.
  await expect
    .poll(async () => (await session(c.page, OTHER)).pushes.at(-1)?.reason)
    .toBe("WORKER_STOP");
  const { lease, seq } = await session(c.page, OTHER);
  const renew = { type: "INTERACT_RENEW", leaseId: lease?.leaseId, seq: seq + 1 };
  expect(await raw(c.page, renew, OTHER)).toMatchObject({
    code: "SESSION_REVOKED",
    reason: "WORKER_STOP",
  });
  expect(await sendStart(c.page, ready.start)).toMatchObject({ code: "WORKER_STOPPED" });
  expect(await interactStart(c.page, url(c))).toMatchObject({ code: "WORKER_STOPPED" });
  expect(await background(c.worker, "lab.interact.clear()")).toBe(true);
  expect(await interactStart(c.page, url(c))).toMatchObject({ ok: true });
  expect(await stopInteract(c.page)).toMatchObject({ ok: true });
  await released(c.worker);
});

test("a second input channel is refused, and closing input revokes its lease", async () => {
  const c = cell();
  expect(await call(c.page, "interactDuplicate", NAME)).toBe(true);
  expect(await interactStart(c.page, url(c))).toMatchObject({ ok: true });
  await call(c.page, "interactClose", NAME);
  const state = await released(c.worker);
  expect(state.stats.revoked.LINK_CLOSED).toBe(1);
});
