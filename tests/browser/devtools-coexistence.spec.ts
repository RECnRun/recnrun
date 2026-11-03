import type { Page } from "@playwright/test";
import { serviceWorkersGone } from "../experiments/e3-loads.ts";
import {
  APP,
  call,
  prepareFixture,
  reportOf,
  tabOf,
  targetsLeft,
} from "../experiments/page-loads.ts";
import type { Run } from "../experiments/page-loads.ts";
import { expect, test as base } from "./fixtures/chrome.ts";
import { ISOLATOR_PATH } from "./fixtures/extension.ts";
import { loadUnpackedOverCdp } from "./fixtures/extension-loaders.ts";
import type { LoadedExtension } from "./fixtures/extension-loaders.ts";
import {
  clickAt,
  findWindow,
  focus,
  keepDisplayOnFailure,
  pixelAt,
  until,
  windowGone,
  windowOrigin,
  xdotool,
} from "./fixtures/x-display.ts";
import type { Rgb } from "./fixtures/x-display.ts";

/*
 * Lab form of MANUAL_VALIDATION.md M-P0.a (closing the debugger infobar) and M-P1.a (DevTools on
 * a managed target), on the container's Xvfb display. Playwright's own CDP session stays attached
 * to every target throughout (E3's confound), so these are lab answers, not the strict manual run.
 */

const RUN = Date.now().toString(36);
const SW_PAGE = `${APP}/sw.html?sw=classic`;
const BROWSER_WINDOW = "^Fixture service worker - Google Chrome$";
// Where the infobar's blue Cancel pill sits from the browser window's corner: read by hand from a
// scrot of the container's display (Google Chrome 156.0.8078.79, window 1050x1420 at 10,10),
// inside the pill left of its label, which read (11, 87, 208) there and white once it closed.
const CANCEL = { x: 688, y: 113 };
const pillBlue = ([red, , blue]: Rgb) => blue > 180 && red < 60;

interface Armed {
  run: Run;
  page: Page;
  tabId: number;
  marker: string;
}

interface Journal {
  tabDetached?: { reason: string; at: number };
}

// The infobar needs --silent-debugger-extension-api left out; the isolator loads as E0's method (a).
const test = base.extend<{ extension: LoadedExtension }>({
  extension: async ({ headless }, use, testInfo) => {
    if (headless) throw new Error("Browser tests run Chrome headed; set use.headless to false.");
    const extension = await loadUnpackedOverCdp(ISOLATOR_PATH, { silentDebugger: false });
    try {
      await use(extension);
    } finally {
      // Before Chrome closes, so a failure keeps what its windows showed.
      await keepDisplayOnFailure(testInfo).catch(() => undefined);
      await extension.close();
    }
  },
});

// E3: Playwright's HAR tracer reads preload response bodies and closes Chrome's connection.
test.use({ trace: { mode: "retain-on-failure", snapshots: false } });

test.beforeEach(async ({ extension }, testInfo) => {
  testInfo.annotations.push({ type: "chrome", description: extension.chrome.version });
  await prepareFixture(extension);
});

function databaseOf(report: unknown): unknown {
  return (report as { worker?: { database?: unknown } } | undefined)?.worker?.database;
}

/** A new tab armed with `pauseBeforeScript` that registered the classic service worker, marked. */
async function openArmed(extension: LoadedExtension, name: string): Promise<Armed> {
  const [context] = extension.chrome.browser.contexts();
  if (!context) throw new Error("Chrome has no default browser context");
  const run: Run = { extension, context };
  const page = await run.context.newPage();
  const marker = `devtools-${name}-${RUN}`;
  const tabId = await tabOf(extension, page, `about:blank#recnrun-${marker}`);
  await call(extension, `setMarker(${JSON.stringify(marker)})`);
  await call(extension, `arm(${JSON.stringify({ tabId, pauseBeforeScript: true })})`);
  expect(databaseOf(await reportOf(page, SW_PAGE))).toBe(`__rec:${marker}:fixture-sw`);
  return { run, page, tabId, marker };
}

async function journal(armed: Armed): Promise<Journal> {
  return call<Journal>(armed.run.extension, "journal()");
}

/** Reloads the armed page and returns the database its service worker reports. */
async function reloaded(armed: Armed): Promise<unknown> {
  await armed.page.reload();
  const report = armed.page.locator("#report[data-ready]");
  await report.waitFor();
  return databaseOf(JSON.parse((await report.textContent()) ?? "null"));
}

/**
 * Stops the app's service workers through the isolator's `closeTarget`. Seen once in seven runs, a
 * worker whose close answered `ok` was still listed 45 s later, so a stop that does not take within
 * 5 s is sent again.
 */
async function stopWorkers(run: Run): Promise<void> {
  for (let tries = 5; tries > 0; tries--) {
    for (const { id } of await targetsLeft(run, "service_worker")) {
      await call(run.extension, `closeTarget(${JSON.stringify({ targetId: id })})`);
    }
    if (await serviceWorkersGone(run, 5_000)) return;
  }
  throw new Error("the app's service worker still ran after five stops");
}

/**
 * The database after the isolator stops the worker and the page reloads, then after the origin is
 * cleared so the page registers a new worker. E3: a navigation-restarted worker is never held, so
 * only the new registration says whether the bootstrap still reaches a worker.
 */
async function nextStarts(armed: Armed): Promise<{ restarted: unknown; registered: unknown }> {
  await stopWorkers(armed.run);
  const restarted = await reloaded(armed);
  await call(armed.run.extension, `clearOrigin({ tabId: ${armed.tabId} })`);
  await stopWorkers(armed.run);
  return { restarted, registered: await reloaded(armed) };
}

async function devtoolsTargets(armed: Armed): Promise<string[]> {
  const { targetInfos } = await armed.run.extension.chrome.cdp.send("Target.getTargets");
  return targetInfos.filter(({ url }) => url.startsWith("devtools://")).map(({ url }) => url);
}

async function devtoolsShows(armed: Armed, app: string, ms?: number): Promise<void> {
  const shown = async () => (await devtoolsTargets(armed)).some((url) => url.includes(app));
  await until(shown, `a devtools:// ${app} target`, ms);
}

async function devtoolsClosed(armed: Armed, ms?: number): Promise<void> {
  await until(async () => (await devtoolsTargets(armed)).length === 0, "DevTools to close", ms);
}

/**
 * Presses F12 in the browser window until the docked DevTools opens or closes: a press sometimes
 * reaches no view right after a reload (seen once in three runs), so it goes again, three times.
 */
async function toggleDevtools(armed: Armed, id: string, open: boolean): Promise<void> {
  for (let tries = 3; ; tries--) {
    await focus(id);
    await xdotool("key", "F12");
    try {
      if (open) return await devtoolsShows(armed, "devtools_app.html", 3_000);
      return await devtoolsClosed(armed, 3_000);
    } catch (error) {
      if (tries === 1) throw error;
    }
  }
}

async function cancelShown(id: string): Promise<boolean> {
  const origin = await windowOrigin(id);
  return pillBlue(await pixelAt(origin.x + CANCEL.x, origin.y + CANCEL.y));
}

test("infobar shows after arm and Cancel detaches (Playwright's CDP session stays attached)", async ({
  extension,
}) => {
  const armed = await openArmed(extension, "cancel");
  const id = await findWindow(BROWSER_WINDOW);
  // A pointer left over the pill changes its color; no --sync, which waits forever at 0,0.
  await xdotool("mousemove", "0", "0");
  await until(() => cancelShown(id), "the infobar's Cancel");
  const origin = await windowOrigin(id);
  await clickAt({ x: origin.x + CANCEL.x, y: origin.y + CANCEL.y });
  await until(async () => !(await cancelShown(id)), "the infobar to close");
  expect((await journal(armed)).tabDetached?.reason).toBe("canceled_by_user");
  // The worker that took the bootstrap keeps it until it stops.
  expect(await reloaded(armed)).toBe(`__rec:${armed.marker}:fixture-sw`);
  // Fail-closed answer: with the tab detached nothing reaches the next worker, so it runs unmarked.
  await stopWorkers(armed.run);
  expect(await reloaded(armed)).toBe("fixture-sw");
  const rearmed = { ...armed, marker: `${armed.marker}-again` };
  await call(extension, `disarm({ tabId: ${armed.tabId} })`);
  await call(extension, `setMarker(${JSON.stringify(rearmed.marker)})`);
  await call(extension, `arm(${JSON.stringify({ tabId: armed.tabId, pauseBeforeScript: true })})`);
  await until(() => cancelShown(id), "the infobar to show again");
  expect(await nextStarts(rearmed)).toEqual({
    restarted: "fixture-sw",
    registered: `__rec:${rearmed.marker}:fixture-sw`,
  });
});

test("DevTools on the armed tab, docked, next to Playwright's CDP session", async ({
  extension,
}) => {
  const armed = await openArmed(extension, "tab");
  const id = await findWindow(BROWSER_WINDOW);
  await toggleDevtools(armed, id, true);
  // Observed: Chrome keeps the extension's tab session; no replaced_with_devtools detach.
  expect((await journal(armed)).tabDetached).toBeUndefined();
  const marked = `__rec:${armed.marker}:fixture-sw`;
  expect(await nextStarts(armed)).toEqual({ restarted: "fixture-sw", registered: marked });
  await toggleDevtools(armed, id, false);
  expect((await journal(armed)).tabDetached).toBeUndefined();
  expect(await nextStarts(armed)).toEqual({ restarted: "fixture-sw", registered: marked });
});

test("DevTools on the worker from serviceworker-internals, next to Playwright's CDP session", async ({
  extension,
}) => {
  const armed = await openArmed(extension, "worker");
  const internals = await armed.run.context.newPage();
  await internals.goto("chrome://serviceworker-internals");
  const registration = internals.locator(".serviceworker-registration", { hasText: APP });
  await registration.getByRole("button", { name: "Inspect" }).click();
  await devtoolsShows(armed, "worker_app.html");
  const devtools = await findWindow("^DevTools$");
  // Observed: the tab session stays, and its auto-attach still reaches the next new worker.
  expect((await journal(armed)).tabDetached).toBeUndefined();
  const marked = `__rec:${armed.marker}:fixture-sw`;
  expect(await nextStarts(armed)).toEqual({ restarted: "fixture-sw", registered: marked });
  // Observed: the window outlives its worker's registration, still listed as a devtools:// target.
  await devtoolsShows(armed, "worker_app.html");
  await focus(devtools);
  // Observed: the undocked worker DevTools window closes on ctrl+w.
  await xdotool("key", "ctrl+w");
  await devtoolsClosed(armed);
  await until(() => windowGone("^DevTools$"), "the DevTools window to close");
  expect((await journal(armed)).tabDetached).toBeUndefined();
  expect(await nextStarts(armed)).toEqual({ restarted: "fixture-sw", registered: marked });
});
