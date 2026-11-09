import { rm } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "@playwright/test";
import type { Browser, CDPSession, Page } from "@playwright/test";
import { launchChrome, test } from "../../browser/fixtures/chrome.ts";
import type { LaunchedChrome, StrictChrome } from "../../browser/fixtures/chrome.ts";
import { beginLease, hostMode, launchBareWorker } from "./host-harness.ts";
import { stopInteract } from "./interact-harness.ts";
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
 * W7.hidden: does a hidden master (background tab, minimized window, minimized with a Document
 * Picture-in-Picture window open) keep its link, its 1 s lease renewals, and its frames? Chrome
 * throttles timers of hidden pages, and intensively (one wake-up a minute) after five minutes;
 * a control tab with no WebRTC shows that throttling happens in this very browser.
 * Host only, throwaway roots, and long: RECNRUN_W7_HOST=1 RECNRUN_W7_HIDDEN=1.
 */

const enabled = hostMode() && process.env.RECNRUN_W7_HIDDEN === "1";
test.skip(!enabled, "The hidden-master cell runs with RECNRUN_W7_HOST=1 RECNRUN_W7_HIDDEN=1");

const HIDE_MS = Number(process.env.RECNRUN_W7_HIDDEN_MS ?? 390_000);
const INTENSIVE_AFTER_MS = 300_000;
const SAMPLE_MS = 30_000;
const MODES = ["tab", "minimized", "pip"] as const;
type Mode = (typeof MODES)[number];
test.setTimeout(MODES.length * (HIDE_MS + 120_000) + 180_000);

interface Cell {
  site: StandIn;
  target: Target;
  relay: LabSignalRelay;
  master: LaunchedChrome;
  browser: Browser;
  page: Page;
  control: Page;
  cdp: CDPSession;
  root: string;
  worker?: StrictChrome;
}

interface Sample {
  at: number;
  visibility: string;
  renewing: boolean;
  channel: string;
  frame: number;
  revoked: string[];
}

interface LabWindow {
  __probe: { ticks: number[] };
  lab: {
    interactSession(name: string): {
      renewing?: boolean;
      state?: string;
      pushes?: { type: string; reason?: string }[];
    };
    interactLatest(name: string): { frameSeq: number } | null;
  };
  documentPictureInPicture?: {
    window: Window | null;
    requestWindow(options: { width: number; height: number }): Promise<Window>;
  };
}

const PROBE = `(() => {
  window.__probe = { ticks: [] };
  setInterval(() => window.__probe.ticks.push(Date.now()), 1000);
})()`;

/** The 1 s ticks that fired at or after `since`, their longest gap, and the page's visibility. */
const ticksAfter = (page: Page, since: number) =>
  page.evaluate((from) => {
    const ticks = (window as unknown as LabWindow).__probe.ticks;
    const late = ticks.filter((tick) => tick >= from);
    const maxGap = late
      .slice(1)
      .reduce((gap, tick, i) => Math.max(gap, tick - (late[i] ?? tick)), 0);
    return { ticks: late.length, maxGap, visibility: document.visibilityState };
  }, since);

const sample = (page: Page): Promise<Sample> =>
  page.evaluate((name) => {
    const { lab } = window as unknown as LabWindow;
    const session = lab.interactSession(name);
    const pushes = session.pushes ?? [];
    return {
      at: Date.now(),
      visibility: document.visibilityState,
      renewing: Boolean(session.renewing),
      channel: String(session.state),
      frame: lab.interactLatest(name)?.frameSeq ?? 0,
      revoked: pushes.filter((p) => p.type === "INTERACT_REVOKED").map((p) => String(p.reason)),
    };
  }, NAME);

/** A tab in the master's own window: a new CDP page can land in a window of its own. */
async function openTab(opener: Page, url: string): Promise<Page> {
  const opened = opener.context().waitForEvent("page");
  await opener.evaluate((href) => void window.open(href, "_blank"), url);
  const tab = await opened;
  await tab.waitForLoadState();
  const [mine, its] = await Promise.all([windowOf(opener), windowOf(tab)]);
  if (mine !== its) throw new Error(`${url} opened in window ${its}, not the master's ${mine}`);
  return tab;
}

async function windowOf(page: Page): Promise<number> {
  const cdp = await page.context().newCDPSession(page);
  const { windowId } = await cdp.send("Browser.getWindowForTarget");
  await cdp.detach();
  return windowId;
}

async function setup(): Promise<Cell> {
  const site = await startStandIn();
  const target = await startTarget();
  const relay = await startLabSignalRelay();
  const master = await launchChrome({ silentDebugger: false });
  // Playwright's default focus emulation makes every page count as captured, hence visible.
  await master.browser.close();
  const browser = await chromium.connectOverCDP(master.wsEndpoint, { noDefaults: true });
  const context = browser.contexts()[0] ?? (await browser.newContext());
  const page = await context.newPage();
  await page.goto(`${site.origin}/`);
  const key = await pageSigner(page);
  const { root, id } = await provisionWorker();
  const flagged = await startWorker(root, id, false);
  await provision(flagged, {
    masterKey: key.publicKey,
    allowlist: [target.origin],
    interactEnabled: true,
  });
  await background(flagged, `lab.signal(${JSON.stringify(relay.origin)})`);
  await flagged.close();
  const control = await openTab(page, `${target.origin}/interact`);
  const cdp = await context.newCDPSession(page);
  return { site, target, relay, master, browser, page, control, cdp, root };
}

async function teardown(c: Cell) {
  await c.worker?.close().catch(() => undefined);
  await c.browser.close().catch(() => undefined);
  await c.master.close().catch(() => undefined);
  await c.relay.close();
  await c.target.close();
  await c.site.close();
  await rm(c.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

async function windowState(c: Cell, windowState: "minimized" | "normal") {
  const { windowId } = await c.cdp.send("Browser.getWindowForTarget");
  await c.cdp.send("Browser.setWindowBounds", { windowId, bounds: { windowState } });
}

/** Opens a Document Picture-in-Picture window from a real click (it needs user activation). */
async function openPip(page: Page): Promise<boolean> {
  await page.evaluate(() => {
    const button = document.createElement("button");
    button.id = "pip";
    button.textContent = "PiP";
    button.style.cssText = "position:fixed;left:0;top:0;z-index:99";
    button.addEventListener("click", () => {
      const pip = (window as unknown as LabWindow).documentPictureInPicture;
      void pip?.requestWindow({ width: 320, height: 180 });
    });
    document.body.append(button);
  });
  await page.click("#pip");
  await delay(1_000);
  return page.evaluate(() =>
    Boolean((window as unknown as LabWindow).documentPictureInPicture?.window),
  );
}

/** Shows a page Notification from the hidden master; answers "show", "error", or "none". */
const notify = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<string>((resolve) => {
        const note = new Notification("RECnRun lab", { body: "W7.hidden: master is hidden" });
        note.addEventListener("show", () => resolve("show"));
        note.addEventListener("error", () => resolve("error"));
        setTimeout(() => resolve("none"), 5_000);
        setTimeout(() => note.close(), 3_000);
      }),
  );

async function hide(c: Cell, mode: Mode): Promise<() => Promise<void>> {
  if (mode === "tab") {
    const cover = await openTab(c.page, "about:blank");
    await cover.bringToFront();
    return () => cover.close();
  }
  const pip = mode === "pip" ? await openPip(c.page) : undefined;
  if (pip !== undefined) console.log(`W7.hidden pip window open=${pip}`);
  await windowState(c, "minimized");
  return () => windowState(c, "normal");
}

async function phase(c: Cell, mode: Mode) {
  await beginLease(c.page, `${c.target.origin}/interact`);
  const before = (await sample(c.page)).revoked.length;
  const show = await hide(c, mode);
  const hiddenAt = Date.now();
  const samples: Sample[] = [];
  let note = "skipped";
  while (Date.now() - hiddenAt < HIDE_MS) {
    await delay(SAMPLE_MS);
    samples.push(await sample(c.page));
    if (mode === "minimized" && note === "skipped") note = await notify(c.page);
  }
  const late = hiddenAt + INTENSIVE_AFTER_MS;
  const gaps = {
    master: await ticksAfter(c.page, late),
    control: await ticksAfter(c.control, late),
  };
  await show();
  report(
    mode,
    samples.map((s) => ({ ...s, revoked: s.revoked.slice(before) })),
    gaps,
    note,
  );
  await stopInteract(c.page).catch(() => undefined);
}

function report(mode: Mode, samples: Sample[], gaps: Record<string, unknown>, note: string) {
  const first = samples[0];
  const last = samples.at(-1);
  const line = {
    mode,
    visibility: [...new Set(samples.map((s) => s.visibility))],
    renewingAtEnd: last?.renewing,
    channelAtEnd: last?.channel,
    framesWhileHidden: (last?.frame ?? 0) - (first?.frame ?? 0),
    frameSeqBySample: samples.map((s) => s.frame),
    revoked: last?.revoked,
    ticksAfter5min: gaps,
    notification: note,
  };
  console.log(`W7.hidden ${JSON.stringify(line)}`);
}

test("W7.hidden: link, lease and frames of a hidden master", async () => {
  const c = await setup();
  try {
    c.worker = await launchBareWorker(c.root, false);
    const linked = await relayLink(c.page, c.relay, NAME);
    console.log(`W7.hidden chrome=${c.worker.version} linked=${JSON.stringify(linked)}`);
    await c.page.evaluate(PROBE);
    await c.control.evaluate(PROBE);
    await c.page.context().grantPermissions(["notifications"], { origin: c.site.origin });
    await c.page.bringToFront();
    for (const mode of MODES) {
      await phase(c, mode);
      await c.page.bringToFront();
      // A lease needs painted frames: wait until the restored window shows the master again.
      await c.page.waitForFunction(() => document.visibilityState === "visible");
    }
  } finally {
    await teardown(c);
  }
});
