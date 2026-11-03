import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, expect, test, type Browser, type TestInfo } from "@playwright/test";
import { cliOpen, type CliOpen } from "./fixtures/cli-open.ts";
import { chromeStrings } from "./fixtures/chrome-strings.ts";
import {
  bannerShown,
  enableRemoteDebugging,
  startChrome,
  watchDialogs,
  type PersonChrome,
} from "./fixtures/person-chrome.ts";
import {
  expectPassedAndInspect,
  pickStatusAssertion,
  startRecording,
  startRun,
  stopAndSave,
  useForm,
} from "./fixtures/ui-steps.ts";
import { click, listWindows, pause, screenshot } from "./fixtures/x11.ts";

/*
 * M-F2.a on Linux: a person starts Google Chrome, turns remote debugging on at chrome://inspect,
 * runs `recnrun open`, records on the fixture, answers Chrome's "Allow remote debugging?"
 * dialog, adds an assertion with the picker, stops, restarts the service, replays, clicks the
 * replay's tab, and reads the run's diagnostics. xdotool and scrot stand in for the person
 * where CDP cannot reach: Chrome's own page, dialog, banner, and tab strip.
 */

const OUTSIDE_CONTAINER =
  "tests/desktop drives Chrome's own windows with xdotool and scrot on the test container's Xvfb display; run `vp run test:desktop`.";
/** Chrome's tab strip at the window's size: the first tab starts after the tab search button. */
const TAB_STRIP = { left: 40, pitch: 238, y: 19 };
const DIALOG_WORDS =
  /Allow remote debugging\?|external app wants|Only web developers|Turn off in settings|automated test software|started debugging this browser/;

interface Setup {
  home: string;
  chrome: PersonChrome;
  cli: CliOpen;
  browser: Browser;
}

const shot = (info: TestInfo, name: string) => screenshot(info.outputPath(`${name}.png`));

/** Clicks the strip's `index`th tab, the replay's, as a person checking on it would. */
async function clickTab(chrome: PersonChrome, index: number): Promise<void> {
  const { x, y } = chrome.geometry;
  await click(x + TAB_STRIP.left + (index - 0.5) * TAB_STRIP.pitch, y + TAB_STRIP.y);
}

/** When the stored run ended, from its summary.json. */
async function runEndedAt(home: string, flowId: string, runId: string): Promise<string> {
  const file = join(home, ".recnrun", "flows", flowId, "runs", runId, "summary.json");
  return (JSON.parse(await readFile(file, "utf8")) as { endedAt: string }).endedAt;
}

/** The whole display and its windows as they were when the body threw, before anything closes. */
async function keepFailureEvidence(info: TestInfo): Promise<void> {
  await shot(info, "failure").catch(() => undefined);
  const windows = await listWindows().catch(() => "");
  await writeFile(info.outputPath("windows.txt"), windows).catch(() => undefined);
}

async function tearDown(setup: Partial<Setup>): Promise<void> {
  await setup.cli?.stop();
  await setup.browser?.close().catch(() => undefined);
  await setup.chrome?.close();
  if (setup.home) await rm(setup.home, { recursive: true, force: true });
}

test("a person records and replays through Chrome's own setup and dialog", async ({
  headless,
}, info) => {
  test.skip(process.env.RECNRUN_TEST_CONTAINER !== "1" || !process.env.DISPLAY, OUTSIDE_CONTAINER);
  if (headless) throw new Error("Chrome shows its dialogs only when headed.");
  const setup: Partial<Setup> = {};
  const notes: string[] = [];
  try {
    setup.home = await mkdtemp(join(tmpdir(), "recnrun-desktop-"));
    setup.chrome = await startChrome(setup.home);
    await shot(info, "01-chrome-started");
    const endpoint = await enableRemoteDebugging(setup.chrome);
    await pause(500);
    await shot(info, "02-remote-debugging-enabled");
    notes.push(`DevToolsActivePort named ${endpoint}`);

    setup.cli = await cliOpen(setup.home);
    notes.push(`recnrun open printed ${setup.cli.url}`);
    const dialogs = watchDialogs(setup.chrome, (name) => info.outputPath(`${name}.png`));
    setup.browser = await chromium.connectOverCDP(endpoint, { timeout: 60_000 });
    expect(dialogs.count).toBe(1);
    const [context] = setup.browser.contexts();
    if (!context) throw new Error("Chrome has no default context.");

    const ui = await context.newPage();
    await ui.goto(setup.cli.url);
    // Once, before the service's first connection; raising it later would cover a dialog.
    await ui.bringToFront();
    await ui.getByRole("link", { name: "Setup" }).click();
    await expect(ui.getByRole("region", { name: "Chrome" })).toContainText("Connected");
    await ui.getByRole("link", { name: "Flows" }).click();
    const recorded = await startRecording(ui, context);
    notes.push(`dialogs after the recording started: ${dialogs.count}`);
    await useForm(recorded);
    await expect(ui.getByRole("list", { name: "Suggested steps" })).toContainText("click");
    expect(await bannerShown(setup.chrome)).toBe(true);
    await shot(info, "03-banner");
    await pickStatusAssertion(ui, recorded);
    notes.push(`dialogs after the picker: ${dialogs.count}`);
    await shot(info, "04-assertion-picked");
    const flowId = await stopAndSave(ui);

    // Leaving the page first keeps its WebSocket from reporting the service's exit.
    await ui.goto("about:blank");
    notes.push(`the first recnrun open exited with ${await setup.cli.stop()} on SIGTERM`);
    setup.cli = await cliOpen(setup.home);
    await ui.goto(setup.cli.url);
    const replay = await startRun(ui, context);
    const tabs = context.pages().length;
    await clickTab(setup.chrome, tabs);
    const clickedAt = new Date().toISOString();
    await shot(info, "05-replay-tab-clicked");
    expect(await replay.evaluate(() => document.visibilityState)).toBe("visible");
    const runId = await expectPassedAndInspect(ui);
    notes.push(`dialogs after the replay: ${dialogs.count}`);
    await ui.screenshot({ path: info.outputPath("06-timeline.png"), fullPage: true });
    await shot(info, "06-timeline-display");
    expect(ui.url()).toContain(`#/runs/${encodeURIComponent(runId)}`);
    const endedAt = await runEndedAt(setup.home, flowId, runId);
    notes.push(`tab ${tabs} of ${tabs} clicked at ${clickedAt}; the run ended at ${endedAt}`);
    expect(clickedAt < endedAt).toBe(true);
    await dialogs.stop();
    expect(dialogs.count).toBeGreaterThanOrEqual(2);
    await ui.goto("about:blank");

    const words = await chromeStrings(DIALOG_WORDS);
    const report = [
      `Chrome asked "Allow remote debugging?" ${dialogs.count} times; see dialog-*.png.`,
      "Its words, from /opt/google/chrome/locales/en-US.pak:",
      ...words.map((line) => `  ${line}`),
      ...notes,
    ];
    await writeFile(info.outputPath("dialog.txt"), `${report.join("\n")}\n`);
    expect(words).toContain("Allow remote debugging?");
  } catch (error) {
    // info.status still reads "passed" inside the body, so the failure is kept on the throw.
    await keepFailureEvidence(info);
    throw error;
  } finally {
    await tearDown(setup);
  }
});
