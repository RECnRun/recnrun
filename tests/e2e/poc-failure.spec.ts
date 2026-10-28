import type { Page, Worker } from "@playwright/test";
import { appLog, requestsOf } from "./fixtures/app.ts";
import { expect, test } from "./fixtures/extension.ts";
import {
  barrierLeft,
  closeTab,
  failNext,
  identityFor,
  incognitoWindows,
  journalOf,
  nextWorker,
  startWithIdentity,
} from "./fixtures/identity.ts";
import { stopWorker } from "./fixtures/restart.ts";
import { openSite } from "./fixtures/session.ts";
import { APP, managedWindow, workspacePanel } from "./fixtures/workspace.ts";

test.use({ incognitoAccess: true });

/** Starts with an identity, the restore held long enough to break the start; never rejects. */
function startHeld(serviceWorker: Worker, run: string, delay = 2_000) {
  const target = `${APP}/app/redirect?run=${run}`;
  return startWithIdentity(serviceWorker, target, identityFor(run), delay).then(
    () => "started",
    (error: unknown) => String(error),
  );
}

/** Resolves once the start waits at its restore step, the page behind the barrier. */
async function atRestore(serviceWorker: Worker) {
  await expect
    .poll(() => journalOf(serviceWorker))
    .toMatchObject({ step: "restore", status: "running" });
}

/** The dashboard names the step; Chrome holds no barrier and no window; the app never ran. */
async function provedUnreleased(site: Page, serviceWorker: Worker, run: string, error: RegExp) {
  await expect(workspacePanel(site).getByRole("alert")).toHaveText(
    new RegExp(`^Start with an identity failed at the restore step\\. ${error.source}`),
  );
  // Saved next to the test's results, for a person to look at.
  await site.screenshot({ path: test.info().outputPath("failure.png") });
  await expect.poll(() => incognitoWindows(serviceWorker)).toBe(0);
  expect(await barrierLeft(serviceWorker)).toEqual({ rules: 0, scripts: 0 });
  const entries = await appLog(run);
  // Only the barrier's script-free document loaded; the reload that releases the app never came.
  expect(requestsOf(entries)).toEqual(["/app/redirect document", "/app/ document"]);
  expect(entries.some(({ kind }) => kind === "report")).toBe(false);
}

test("an injected restore failure is shown, and nothing is released", async ({
  context,
  serviceWorker,
}) => {
  const site = await openSite(context, "/");
  const run = `failure-restore-${Date.now()}`;
  await failNext(serviceWorker, "restore");
  expect(await startHeld(serviceWorker, run, 0)).toContain(
    "The test build failed the restore step.",
  );
  await provedUnreleased(site, serviceWorker, run, /The test build failed the restore step\./);
});

test("a tab closed during the start is shown as a failure, and nothing is released", async ({
  context,
  serviceWorker,
}) => {
  const site = await openSite(context, "/");
  const run = `failure-tab-${Date.now()}`;
  const starting = startHeld(serviceWorker, run);
  await atRestore(serviceWorker);
  const managed = await managedWindow(serviceWorker);
  if (!managed) throw new Error("No managed window");
  await closeTab(serviceWorker, managed.tabId);
  expect(await starting).not.toBe("started");
  await provedUnreleased(
    site,
    serviceWorker,
    run,
    /The page closed before its data was restored\./,
  );
});

test.describe("with a DevTools port", () => {
  test.use({ remoteDebuggingPort: 9335 });

  test("a service worker stopped during the start is recovered as a failure, and nothing is released", async ({
    context,
    serviceWorker,
    remoteDebuggingPort,
  }) => {
    if (remoteDebuggingPort === undefined) throw new Error("No DevTools port");
    const site = await openSite(context, "/");
    const run = `failure-worker-${Date.now()}`;
    const starting = startHeld(serviceWorker, run);
    await atRestore(serviceWorker);
    await stopWorker(remoteDebuggingPort);
    expect(await starting).not.toBe("started");
    // The reloaded dashboard's first request wakes a new worker, which recovers before it answers.
    await site.reload();
    const worker = await nextWorker(context);
    await provedUnreleased(
      site,
      worker,
      run,
      /Interrupted: RECnRun restarted before the start finished\./,
    );
  });
});
