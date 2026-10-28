import type { BrowserContext, Worker } from "@playwright/test";
import { BLANK } from "./fixtures/captures.ts";
import { expect, test } from "./fixtures/extension.ts";
import {
  barrierLeft,
  delayStep,
  incognitoWindows,
  journalOf,
  nextWorker,
  replayStale,
  staleDelivered,
} from "./fixtures/identity.ts";
import { keep } from "./fixtures/keep.ts";
import { identitiesAt, lifecycleDriver, lifecycleSetUp, nextPageAt } from "./fixtures/lifecycle.ts";
import { marked, readMarker, writeMarker } from "./fixtures/markers.ts";
import { stopWorker } from "./fixtures/restart.ts";
import { holding, inspect, writeSentinels } from "./fixtures/sentinels.ts";
import { APP } from "./fixtures/workspace.ts";

test.use({ incognitoAccess: true });

/** A holds `A:1` and is saved; B is open holding `B:1`, never saved. */
async function aSavedBOpen(context: BrowserContext, serviceWorker: Worker) {
  const setup = await lifecycleSetUp(context, serviceWorker);
  const { identities, next } = setup;
  await identities.open("A");
  await writeMarker(await next(), "A:1");
  await identities.open("B");
  await writeMarker(await next(), "B:1");
  return setup;
}

/** Runs `command` until the service worker is stopped at `step`; resolves with how it ended. */
async function stoppedAt(
  serviceWorker: Worker,
  port: number,
  step: string,
  command: () => Promise<unknown>,
) {
  await delayStep(serviceWorker, step, 5_000);
  const running = command().then(
    () => "finished",
    (error: unknown) => String(error),
  );
  await expect.poll(() => journalOf(serviceWorker)).toMatchObject({ step, status: "running" });
  await stopWorker(port);
  return running;
}

test.describe("with a DevTools port", () => {
  test.use({ remoteDebuggingPort: 9336 });

  test("an extension restart during the capture or the restore is recovered, and the identities resume", async ({
    context,
    serviceWorker,
    remoteDebuggingPort,
  }) => {
    if (remoteDebuggingPort === undefined) throw new Error("No DevTools port");
    const { driver, identities, next, tab } = await aSavedBOpen(context, serviceWorker);
    // The command's own reply dies with the worker; the next command wakes a new one.
    const wake = async () => {
      await driver.command({ type: "workspace-status" });
      return nextWorker(context);
    };

    const duringCapture = await stoppedAt(serviceWorker, remoteDebuggingPort, "capture", () =>
      identities.open("A"),
    );
    expect(duringCapture).not.toBe("finished");
    let worker = await wake();
    expect(await journalOf(worker)).toMatchObject({
      step: "capture",
      status: "failed",
      error: "Interrupted: RECnRun restarted before the switch finished.",
    });
    // Nothing had closed yet, so B's window stays open with its data.
    expect(await incognitoWindows(worker)).toBe(1);
    if (tab.page) expect(await readMarker(tab.page)).toEqual(marked("B:1"));
    await identities.open("A");
    expect(await readMarker(await next())).toEqual(marked("A:1"));

    const duringRestore = await stoppedAt(worker, remoteDebuggingPort, "restore", () =>
      identities.open("B"),
    );
    expect(duringRestore).not.toBe("finished");
    worker = await wake();
    expect(await journalOf(worker)).toMatchObject({ step: "restore", status: "failed" });
    await expect.poll(() => incognitoWindows(worker)).toBe(0);
    expect(await barrierLeft(worker)).toEqual({ rules: 0, scripts: 0 });
    await identities.resume("B");
    expect(await readMarker(await next())).toEqual(marked("B:1"));
    await keep("lifecycle-extension-restart", { duringCapture, duringRestore });
  });
});

test("stale replies of an earlier operation reach every link and are dropped", async ({
  context,
  serviceWorker,
}) => {
  await replayStale(serviceWorker, true);
  const { identities, next } = await aSavedBOpen(context, serviceWorker);
  await identities.open("A");
  let page = await next();
  expect(await readMarker(page)).toEqual(marked("A:1"));
  await writeMarker(page, "A:2");
  await identities.open("B");
  page = await next();
  expect(await readMarker(page)).toEqual(marked("B:1"));
  const delivered = await staleDelivered(serviceWorker);
  expect(delivered).toBeGreaterThan(0);
  await identities.open("A");
  expect(await readMarker(await next())).toEqual(marked("A:2"));
  await keep("lifecycle-stale-replies", { delivered: await staleDelivered(serviceWorker) });
});

test("after a browser restart the saved identities resume, and the normal profile keeps its data", async ({
  context,
  serviceWorker,
  relaunch,
}) => {
  const run = `restart-${Date.now()}`;
  const before = await context.newPage();
  await writeSentinels(before, APP, `tag=normal-${run}&run=${run}`);
  const sentinels = await inspect(before, APP, run);
  expect(sentinels).toMatchObject(holding(`normal-${run}`, APP));
  const { identities } = await aSavedBOpen(context, serviceWorker);
  const restarted = await relaunch();
  const driver = await lifecycleDriver(restarted.context, restarted.serviceWorker);
  const again = identitiesAt(driver.command, BLANK, identities.ids);
  const status = (await driver.command({ type: "workspace-status" })) as {
    managed?: unknown;
    identities: { label: string; lastCapture?: unknown }[];
  };
  expect(await incognitoWindows(restarted.serviceWorker)).toBe(0);
  expect(
    status.identities.map(({ label, lastCapture }) => [label, lastCapture !== undefined]),
  ).toEqual([
    ["A", true],
    ["B", false],
  ]);
  // B was open but never saved, so Chrome discarded its data with the Incognito session.
  await expect(again.resume("B")).rejects.toThrow("RECnRun has no saved data for this identity.");
  await again.resume("A");
  const page = await nextPageAt(restarted.context, BLANK);
  expect(await readMarker(page)).toEqual(marked("A:1"));
  // Session cookies and sessionStorage end with any browser session; the rest must stay.
  const { cookies: _session, serverCookies: _server, sessionStorage: _tab, ...kept } = sentinels;
  const normal = await restarted.context.newPage();
  expect(await inspect(normal, APP, run)).toMatchObject(kept);
});
