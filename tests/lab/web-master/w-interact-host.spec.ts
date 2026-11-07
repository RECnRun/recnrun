import { rm } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import type { Page } from "@playwright/test";
import { expect, launchChrome, test } from "../../browser/fixtures/chrome.ts";
import type { LaunchedChrome, StrictChrome } from "../../browser/fixtures/chrome.ts";
import {
  beginLease,
  captureDisplay,
  commandLine,
  hostMode,
  launchBareWorker,
} from "./host-harness.ts";
import {
  centreOf,
  dragOn,
  fraction,
  layoutOf,
  moveOn,
  nth,
  pressOn,
  rectOf,
  reports,
} from "./interact-drag-harness.ts";
import type { Layout } from "./interact-drag-harness.ts";
import { clickAt } from "./interact-click-harness.ts";
import { stopInteract } from "./interact-harness.ts";
import { reportsOf, scrolled, wheelAt } from "./interact-input-harness.ts";
import { relayLink, startLabSignalRelay } from "./lab-signal-relay.ts";
import type { LabSignalRelay } from "./lab-signal-relay.ts";
import { background, provisionWorker, startWorker } from "./lifecycle-harness.ts";
import { pageSigner } from "./observe-harness.ts";
import { startStandIn } from "./stand-in.ts";
import type { StandIn } from "./stand-in.ts";
import { startTarget } from "./target-server.ts";
import type { Target } from "./target-server.ts";
import { NAME, provision } from "./trust-harness.ts";

/*
 * M-TW.16 of docs/poc/thin-worker/MANUAL_VALIDATION.md: the W7 interaction cell on a macOS host,
 * throwaway roots only. The stand-in serves plain http on 127.0.0.1 (no Chrome policy, no CA).
 * The worker runs with --silent-debugger-extension-api and no other debugging flag; its link goes
 * through the lab's loopback relay, as in W6.16.
 */

test.skip(!hostMode(), "The host cell runs with RECNRUN_W7_HOST=1");
test.describe.configure({ mode: "serial" });

const FORBIDDEN = /--remote-debugging|--enable-unsafe-extension-debugging/;
const FIELD = { x: 0.4, y: 0.375 };
const TYPED = "Olá ação 123";
const SLIDER_TARGET = 70;

interface Cell {
  site: StandIn;
  target: Target;
  relay: LabSignalRelay;
  master: LaunchedChrome;
  page: Page;
  root: string;
  worker?: StrictChrome;
}

async function setup(headless: boolean): Promise<Cell> {
  const site = await startStandIn();
  const target = await startTarget();
  const relay = await startLabSignalRelay();
  const master = await launchChrome({ silentDebugger: false });
  const context = master.browser.contexts()[0] ?? (await master.browser.newContext());
  const page = await context.newPage();
  await page.goto(`${site.origin}/`);
  await expect(page.locator("#status")).toHaveText("ready");
  const key = await pageSigner(page);
  // Provisioned with the lab flags; the bare launch below reuses the root.
  const { root, id } = await provisionWorker();
  const flagged = await startWorker(root, id, headless);
  const allowlist = [target.origin];
  await provision(flagged, { masterKey: key.publicKey, allowlist, interactEnabled: true });
  await background(flagged, `lab.signal(${JSON.stringify(relay.origin)})`);
  await flagged.close();
  return { site, target, relay, master, page, root };
}

async function teardown(c: Cell) {
  await c.worker?.close().catch(() => undefined);
  await c.master.close().catch(() => undefined);
  await c.relay.close();
  await c.target.close();
  await c.site.close();
  await rm(c.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

const lease = (c: Cell, path: string) => beginLease(c.page, `${c.target.origin}${path}`);
const end = async (c: Cell) => {
  expect(await stopInteract(c.page)).toMatchObject({ ok: true });
};

async function counterClick(c: Cell) {
  await lease(c, "/interact");
  await clickAt(c.page, { x: 0.5, y: 0.5 });
  await expect.poll(() => c.target.hits.filter((hit) => hit.id === "count").length).toBe(1);
  await delay(500);
  expect(c.target.hits.filter((hit) => hit.id === "count")).toHaveLength(1);
  await end(c);
}

async function typedText(c: Cell) {
  await lease(c, "/interact/form");
  await clickAt(c.page, FIELD);
  await expect.poll(() => reportsOf(c.target.reports, "mouseup").length).toBe(1);
  await c.page.keyboard.type(TYPED);
  await c.page.keyboard.press("Backspace");
  await c.page.keyboard.press("Enter");
  const submits = () => reportsOf(c.target.reports, "submit");
  await expect.poll(() => submits().at(-1)?.value).toBe("Olá ação 12");
  await delay(500);
  expect(submits()).toHaveLength(1);
  await end(c);
}

async function wheel(c: Cell) {
  await lease(c, "/interact/scroll");
  await wheelAt(c.page, { x: 0.25, y: 0.6 }, 300);
  await expect.poll(() => scrolled(c.target.reports).page).toBeGreaterThan(0);
  await end(c);
}

const thumbAt = (layout: Layout, value: number) => {
  const r = rectOf(layout, "slider");
  return fraction(layout, r.left + 10 + (value / 100) * (r.width - 20), r.top + r.height / 2);
};

async function slider(c: Cell) {
  const since = Date.now();
  await lease(c, "/interact/drag");
  const layout = await layoutOf(c.target, "/interact/drag", since);
  await dragOn(c.page, thumbAt(layout, 0), thumbAt(layout, SLIDER_TARGET));
  await expect.poll(() => reports(c.target, "change", since).length).toBe(1);
  const value = nth(reports(c.target, "change", since), 0).value as number;
  console.log(`W7.host slider ${value} for ${SLIDER_TARGET}`);
  expect(Math.abs(value - SLIDER_TARGET)).toBeLessThanOrEqual(1);
  await end(c);
}

/** The master goes away with the button down: the page must see the button released. */
async function closeMidDrag(c: Cell) {
  const since = Date.now();
  await lease(c, "/interact/drag");
  const layout = await layoutOf(c.target, "/interact/drag", since);
  await pressOn(c.page, centreOf(layout, "canvas"));
  await moveOn(c.page, fraction(layout, rectOf(layout, "canvas").left + 90, 300));
  await expect.poll(() => reports(c.target, "strokestart", since).length).toBe(1);
  const closed = Date.now();
  await c.page.close();
  await expect
    .poll(() => reports(c.target, "pointerup", closed).length, { timeout: 5_000 })
    .toBe(1);
  const ms = nth(reports(c.target, "pointerup", closed), 0).at - closed;
  console.log(`W7.host master-close-release-ms ${ms}`);
  expect(ms).toBeLessThanOrEqual(1_500);
}

async function runCell(headless: boolean) {
  const c = await setup(headless);
  try {
    expect(c.site.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const worker = await launchBareWorker(c.root, headless);
    c.worker = worker;
    const flags = await commandLine(worker.pid);
    expect(flags.filter((flag) => FORBIDDEN.test(flag))).toEqual([]);
    expect(flags.some((flag) => flag.startsWith("--silent-debugger-extension-api"))).toBe(true);
    console.log(
      `W7.host chrome=${worker.version} platform=${process.platform} headless=${headless}`,
    );
    expect(await relayLink(c.page, c.relay, NAME)).toMatchObject({ ok: true });
    await counterClick(c);
    await typedText(c);
    await wheel(c);
    await slider(c);
    await lease(c, "/interact/drag");
    if (!headless) {
      const file = test.info().outputPath("display.png");
      await captureDisplay(file);
      console.log(`W7.host screenshot ${file}`);
    }
    await end(c);
    await closeMidDrag(c);
  } finally {
    await teardown(c);
  }
}

test("M-TW.16: a headed worker with only the silent flag takes the master's input", async () => {
  await runCell(false);
});

test("M-TW.16: a headless worker with only the silent flag takes the master's input", async () => {
  await runCell(true);
});
