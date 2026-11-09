import { rm } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import type { Page } from "@playwright/test";
import { expect, launchChrome, test } from "../../browser/fixtures/chrome.ts";
import type { LaunchedChrome } from "../../browser/fixtures/chrome.ts";
import type { LoadedExtension } from "../../browser/fixtures/extension-loaders.ts";
import {
  aimable,
  aimedAt,
  clickAt,
  letterbox,
  pointer,
  tabState,
} from "./interact-click-harness.ts";
import { interactStart, released, stopInteract } from "./interact-harness.ts";
import { pressAt, releasedState, reportsOf } from "./interact-input-harness.ts";
import { background, call, provisionWorker, startWorker, until } from "./lifecycle-harness.ts";
import { pageSigner } from "./observe-harness.ts";
import { startStandIn } from "./stand-in.ts";
import type { StandIn } from "./stand-in.ts";
import { startTarget } from "./target-server.ts";
import type { Target } from "./target-server.ts";
import { NAME, openLinked, provision } from "./trust-harness.ts";

/*
 * W7 fixes, review findings 1, 2, 5, and 6: the worker's own Chrome calls slowed, hung, or
 * refused from inside its service worker, so a revoke races a dispatch, an open hangs, a close
 * fails, and a release cannot be confirmed. Findings 3 and 4: the frame an event may aim at is
 * the one on screen, and the view it was drawn from must still be the view now.
 */

interface Cell {
  site: StandIn;
  target: Target;
  master: LaunchedChrome;
  worker: LoadedExtension;
  page: Page;
  root: string;
}

let shared: Cell | undefined;
const cell = (): Cell => {
  if (!shared) throw new Error("The W7 race setup did not run.");
  return shared;
};

test.beforeAll(async () => {
  const site = await startStandIn();
  const target = await startTarget();
  const master = await launchChrome({ silentDebugger: false });
  const { root, id } = await provisionWorker();
  const worker = await startWorker(root, id, false);
  const page = await openLinked(master, site.origin, worker);
  const key = await pageSigner(page);
  const allowlist = [target.origin];
  await provision(worker, { masterKey: key.publicKey, allowlist, interactEnabled: true });
  shared = { site, target, master, worker, page, root };
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

const FIELD = { x: 0.4, y: 0.375 };
const DOWN = { button: "left", clickCount: 1, modifiers: 0 };

/** Replaces one chrome API method in the worker's service worker until `restore`. */
const fault = (c: Cell, api: string, method: string, body: string) =>
  background(
    c.worker,
    `(() => { const api = chrome.${api}; globalThis.__real ??= {};
      globalThis.__real["${api}.${method}"] ??= api.${method};
      const real = globalThis.__real["${api}.${method}"].bind(api);
      api.${method} = ${body}; return true; })()`,
  );
const restore = (c: Cell, api: string, method: string) =>
  background(
    c.worker,
    `(() => { chrome.${api}.${method} = globalThis.__real["${api}.${method}"]; return true; })()`,
  );

async function begin(c: Cell) {
  const started = await interactStart(c.page, `${c.target.origin}/interact/form`);
  expect(started, JSON.stringify(started)).toMatchObject({ ok: true });
  expect(await call(c.page, "interactObserve", NAME)).toMatchObject({ ok: true });
  await letterbox(c.page);
  return aimable(c.page);
}

test("a stop while a down's document is read dispatches nothing", async () => {
  const c = cell();
  const frame = await begin(c);
  const since = Date.now();
  // The down's document read answers 800 ms late; the stop arrives during it.
  const slow = `(target, method, params) => method === "Page.getFrameTree"
    ? new Promise((go) => setTimeout(go, 800)).then(() => real(target, method, params))
    : real(target, method, params)`;
  expect(await fault(c, "debugger", "sendCommand", slow)).toBe(true);
  const down = pointer(c.page, "pointerDown", { ...aimedAt(frame, FIELD), ...DOWN });
  await delay(200);
  expect(await stopInteract(c.page)).toMatchObject({ ok: true });
  expect(await down).toMatchObject({ ok: false, code: "SESSION_REVOKED" });
  await restore(c, "debugger", "sendCommand");
  await released(c.worker);
  await delay(300);
  expect(reportsOf(c.target.reports, "mousedown", since)).toHaveLength(0);
});

test("a tab create that never answers fails the start, and the claim frees", async () => {
  const c = cell();
  expect(await fault(c, "tabs", "create", "() => new Promise(() => undefined)")).toBe(true);
  const started = await interactStart(c.page, `${c.target.origin}/interact/form`);
  await restore(c, "tabs", "create");
  expect(started).toMatchObject({ ok: false, code: "TAB_FAILED" });
  await released(c.worker);
});

test("a tab that cannot be closed keeps the claim until it is gone", async () => {
  const c = cell();
  await begin(c);
  const refused = `() => Promise.reject(new Error("refused by the lab"))`;
  expect(await fault(c, "tabs", "remove", refused)).toBe(true);
  expect(await stopInteract(c.page)).toMatchObject({ ok: true });
  await delay(600);
  const held = await releasedState(c.worker);
  expect(held.claim).not.toBeNull();
  expect(held.tab).not.toBeNull();
  const busy = await interactStart(c.page, `${c.target.origin}/interact/form`);
  expect(busy).toMatchObject({ ok: false, code: "BUSY" });
  await restore(c, "tabs", "remove");
  const state = await released(c.worker);
  expect(state.claim).toBeNull();
  expect((await releasedState(c.worker)).tab).toBeNull();
});

test("a release the dead man cannot confirm revokes and closes the tab", async () => {
  const c = cell();
  await begin(c);
  const ups = reportsOf(c.target.reports, "mouseup").length;
  await clickAt(c.page, FIELD);
  await expect.poll(() => reportsOf(c.target.reports, "mouseup").length).toBe(ups + 1);
  expect(await call(c.page, "interactKeepalive", false)).toBe(true);
  const downs = reportsOf(c.target.reports, "mousedown").length;
  await pressAt(c.page, FIELD);
  await expect.poll(() => reportsOf(c.target.reports, "mousedown").length).toBe(downs + 1);
  const failing = `(target, method, params) => params?.type === "mouseReleased"
    ? Promise.reject(new Error("refused by the lab")) : real(target, method, params)`;
  expect(await fault(c, "debugger", "sendCommand", failing)).toBe(true);
  const revoked = await until(
    () => releasedState(c.worker),
    (state) => (state.stats.revoked.INPUT_STATE_UNKNOWN ?? 0) > 0,
    3_000,
  );
  await restore(c, "debugger", "sendCommand");
  expect(revoked.stats.revoked.INPUT_STATE_UNKNOWN).toBe(1);
  await released(c.worker);
  expect((await releasedState(c.worker)).tab).toBeNull();
  await c.page.mouse.up();
  expect(await call(c.page, "interactKeepalive", true)).toBe(true);
});

const shownSeq = (page: Page) => call<number | null>(page, "shownFrame", NAME);
const newestArrival = async (page: Page) => {
  const { arrivals } = await call<{ arrivals: { frameSeq: number }[] }>(page, "visualStats");
  return arrivals.at(-1)?.frameSeq ?? 0;
};

test("a frame becomes aimable only once the image presents it", async () => {
  const c = cell();
  const frame = await begin(c);
  // The master's decode answers 1.5 s late: the frames that arrive meanwhile are not on screen.
  await c.page.evaluate(() => {
    const proto = HTMLImageElement.prototype;
    const real = Object.getOwnPropertyDescriptor(proto, "decode");
    Object.assign(window, { realDecode: real });
    const decode = real?.value as (this: HTMLImageElement) => Promise<void>;
    proto.decode = function delayed(this: HTMLImageElement) {
      return new Promise((go) => setTimeout(go, 1_500)).then(() => decode.call(this));
    };
  });
  await until(
    () => newestArrival(c.page),
    (seq) => seq > frame.frameSeq,
    5_000,
  );
  expect(await shownSeq(c.page)).toBe(frame.frameSeq);
  await c.page.evaluate(() => {
    const { realDecode } = window as unknown as { realDecode: PropertyDescriptor };
    Object.defineProperty(HTMLImageElement.prototype, "decode", realDecode);
  });
  await aimable(c.page, (next) => next.frameSeq > frame.frameSeq);
  expect(await stopInteract(c.page)).toMatchObject({ ok: true });
  await released(c.worker);
});

test("an event sent after a resize, before any frame of it, is refused", async () => {
  const c = cell();
  const frame = await begin(c);
  const since = Date.now();
  const tabId = (await tabState(c.worker)).tab?.tabId;
  // No new frame is drawn: the screencast stops and the quiet restart is a no-op.
  const still = `(target, method, params) => method === "Page.startScreencast"
    ? Promise.resolve({}) : real(target, method, params)`;
  expect(await fault(c, "debugger", "sendCommand", still)).toBe(true);
  const stop = `chrome.debugger.sendCommand({ tabId: ${tabId} }, "Page.stopScreencast").then(() => true)`;
  expect(await background(c.worker, stop)).toBe(true);
  const width = (frame.geometry?.deviceWidth ?? 0) - 160;
  const resize = `lab.interact.resize(${width}, ${Math.round((width * 9) / 16)})`;
  expect(await background(c.worker, resize)).toBe(true);
  const down = await pointer(c.page, "pointerDown", { ...aimedAt(frame, FIELD), ...DOWN });
  expect(down).toMatchObject({ ok: false, code: "VIEWPORT_CHANGED" });
  await restore(c, "debugger", "sendCommand");
  expect(await background(c.worker, "lab.interact.resize(0, 0)")).toBe(true);
  await delay(300);
  expect(reportsOf(c.target.reports, "mousedown", since)).toHaveLength(0);
  expect(await stopInteract(c.page)).toMatchObject({ ok: true });
  await released(c.worker);
});
