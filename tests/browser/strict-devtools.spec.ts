import { control } from "../experiments/page-loads.ts";
import { expect, test } from "./fixtures/strict-lab.ts";
import type { LabJournal, StrictExtension } from "./fixtures/strict-lab.ts";
import {
  APP,
  armHere,
  databaseOf,
  devtoolsTargets,
  nextStarts,
  visit,
} from "./fixtures/strict-steps.ts";
import type { StrictTab } from "./fixtures/strict-steps.ts";
import { navigate, press } from "./fixtures/strict-ui.ts";
import {
  findWindow,
  focus,
  pixelAt,
  until,
  windowGone,
  windowOrigin,
  xdotool,
} from "./fixtures/x-display.ts";

/*
 * The strict form of devtools-coexistence.spec.ts (M-P0.a, M-P1.a): Chrome runs with no remote
 * debugging flag, so no CDP client but the isolator exists, and the isolator is force-installed by
 * policy. What differs from the CDP run: navigation is typed in the omnibox, commands go through
 * the managed policy, answers come from the journal the isolator posts, and DevTools is detected
 * through the isolator's own chrome.debugger.getTargets(), not the harness's Target.getTargets.
 */

const RUN = Date.now().toString(36);
const CHROME_WINDOW = " - Google Chrome$";
// The CDP run's Cancel pill, from the browser window's corner (devtools-coexistence.spec.ts).
const CANCEL = { x: 688, y: 113 };

test.use({
  strictOptions: {
    silentDebugger: false,
    lab: { marker: `devtools-${RUN}`, arm: { origin: APP, pauseBeforeScript: true, clear: true } },
  },
});

/** The window's tab, armed by the lab, after it registered the classic service worker, marked. */
async function openArmed(strict: StrictExtension): Promise<StrictTab> {
  test.info().annotations.push({ type: "chrome", description: strict.chrome.version });
  await control("/__network?mode=online");
  await control("/__ledger/reset");
  const tab = await armHere(strict, await findWindow(CHROME_WINDOW));
  expect(databaseOf(await visit(tab))).toBe(`__rec:${tab.marker}:fixture-sw`);
  return tab;
}

const detached = (strict: StrictExtension) => strict.sink.journal?.routeA.tabDetached;

async function devtoolsShows(strict: StrictExtension, app: string, ms?: number): Promise<void> {
  const shown = () => devtoolsTargets(strict).some((url) => url.includes(app));
  await strict.sink.until(shown, `a devtools:// ${app} target`, ms);
}

async function devtoolsClosed(strict: StrictExtension, ms?: number): Promise<void> {
  await strict.sink.until(() => devtoolsTargets(strict).length === 0, "DevTools to close", ms);
}

/** F12 until the docked DevTools opens or closes, three times at most (the CDP run's retry). */
async function toggleDevtools(tab: StrictTab, open: boolean): Promise<void> {
  for (let tries = 3; ; tries--) {
    await press(tab.window, "F12");
    try {
      if (open) return await devtoolsShows(tab.strict, "devtools_app.html", 3_000);
      return await devtoolsClosed(tab.strict, 3_000);
    } catch (error) {
      if (tries === 1) throw error;
    }
  }
}

async function cancelShown(window: string): Promise<boolean> {
  const origin = await windowOrigin(window);
  const [red, , blue] = await pixelAt(origin.x + CANCEL.x, origin.y + CANCEL.y);
  return blue > 180 && red < 60;
}

test("strict: infobar Cancel", async () => {
  test.skip(
    true,
    "Chrome shows no debugger infobar for a policy-installed extension: debugger_api.cc sets suppress_warning when Manifest::IsPolicyLocation (crbug.com/41302695), so there is no Cancel to press.",
  );
});

test("strict: DevTools on the armed tab, docked, with no other CDP client", async ({ strict }) => {
  const tab = await openArmed(strict);
  // Observed: no infobar with --silent-debugger-extension-api left out, as the skip above says.
  expect(await cancelShown(tab.window)).toBe(false);
  await toggleDevtools(tab, true);
  expect(detached(strict)).toBeUndefined();
  const marked = `__rec:${tab.marker}:fixture-sw`;
  // Observed: DevTools auto-attaches to the page's worker and resumes its restart, unmarked.
  expect(await nextStarts(tab)).toEqual({ restarted: "fixture-sw", registered: marked });
  await toggleDevtools(tab, false);
  expect(detached(strict)).toBeUndefined();
  // Observed: alone, the isolator bootstraps and releases the restarted worker (E8 b-restart).
  expect(await nextStarts(tab)).toEqual({ restarted: marked, registered: marked });
});

/** Inspects the app's worker on serviceworker-internals, whose registration is listed last. */
async function inspectAppWorker(tab: StrictTab): Promise<void> {
  await press(tab.window, "ctrl+t");
  await navigate(tab.window, "chrome://serviceworker-internals");
  const listed = (journal: LabJournal) =>
    journal.targets.some(({ url }) => url.startsWith("chrome://serviceworker-internals"));
  await tab.strict.sink.until(listed, "serviceworker-internals to open");
  await press(tab.window, "ctrl+f");
  await xdotool("type", "Inspect");
  // shift+Return wraps from the first match to the last; ctrl+Return clicks the match.
  await press(tab.window, "shift+Return", "ctrl+Return");
}

test("strict: DevTools on the worker from serviceworker-internals, with no other CDP client", async ({
  strict,
}, testInfo) => {
  const tab = await openArmed(strict);
  await inspectAppWorker(tab);
  await devtoolsShows(strict, "worker_app.html");
  const devtools = await findWindow("^DevTools");
  const title = await xdotool("getwindowname", devtools);
  testInfo.annotations.push({ type: "devtools window", description: title });
  // The app's worker, not an extension's: inspecting one marks it attached in getTargets().
  const extensions = strict.sink.journal?.targets.filter(
    ({ url, attached }) => attached && url.startsWith("chrome-extension://"),
  );
  expect(extensions).toEqual([]);
  expect(detached(strict)).toBeUndefined();
  await press(tab.window, "ctrl+1");
  const marked = `__rec:${tab.marker}:fixture-sw`;
  // Observed: the worker's DevTools resumes its restart, unmarked.
  expect(await nextStarts(tab)).toEqual({ restarted: "fixture-sw", registered: marked });
  await devtoolsShows(strict, "worker_app.html");
  await focus(devtools);
  await xdotool("key", "ctrl+w");
  await devtoolsClosed(strict);
  await until(() => windowGone("^DevTools"), "the DevTools window to close");
  expect(detached(strict)).toBeUndefined();
  // Observed: with DevTools gone the restart is marked again, as on the armed tab.
  expect(await nextStarts(tab)).toEqual({ restarted: marked, registered: marked });
});
