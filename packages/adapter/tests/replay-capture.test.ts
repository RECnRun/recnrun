import { describe, expect, test } from "vite-plus/test";
import { capturePage, captureWith, type CaptureSession } from "../src/replay-capture.ts";
import { createPageDriver } from "../src/replay.ts";
import { fakePage } from "./replay-page.ts";
import { within } from "./within.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const PNG = Buffer.from([137, 80, 78, 71]);
const HTML = "<!DOCTYPE html><html><body>Box</body></html>";
const ANSWERS: Record<string, unknown> = {
  "DOM.getDocument": { root: { nodeId: 7, nodeName: "#document" } },
  "DOM.getOuterHTML": { outerHTML: HTML },
  "Page.captureScreenshot": { data: PNG.toString("base64") },
};

/** A CDP session that answers from `answers`; a missing answer, or a detach when `detaches` is false, never settles. */
function fakeSession(answers: Record<string, unknown> = ANSWERS, detaches = true) {
  const sent: string[] = [];
  let detached = 0;
  const session: CaptureSession = {
    send(method, params) {
      sent.push(`${method} ${JSON.stringify(params)}`);
      return method in answers ? Promise.resolve(answers[method]) : new Promise(() => {});
    },
    detach: () => {
      detached += 1;
      return detaches ? Promise.resolve() : new Promise(() => {});
    },
  };
  return { session, sent, detached: () => detached };
}

describe("captureWith", () => {
  test("serializes the document and screenshots the tab over its CDP session", async () => {
    const { session, sent, detached } = fakeSession();
    const capture = await captureWith(session, "http://127.0.0.1:4600/", 1000);
    expect(capture).toEqual({
      tab: true,
      url: "http://127.0.0.1:4600/",
      html: { ok: true, value: HTML },
      screenshot: { ok: true, value: PNG },
    });
    expect(sent).toEqual([
      'DOM.getDocument {"depth":0}',
      'DOM.getOuterHTML {"nodeId":7}',
      'Page.captureScreenshot {"format":"png"}',
    ]);
    expect(detached()).toBe(1);
  });

  test("a reply that does not match its schema fails only its own part", async () => {
    const { session } = fakeSession({ ...ANSWERS, "DOM.getOuterHTML": { outerHTML: 3 } });
    const capture = await captureWith(session, "http://127.0.0.1:4600/", 1000);
    expect(capture).toMatchObject({
      html: { ok: false, message: expect.stringContaining("DOM.getOuterHTML answered") },
      screenshot: { ok: true },
    });
  });

  test("a renderer that never answers fails both parts within the budget", async () => {
    const { session, detached } = fakeSession({});
    const started = Date.now();
    const capture = await captureWith(session, "about:blank", 50);
    expect(capture).toMatchObject({
      html: { ok: false, message: expect.stringContaining("No answer") },
      screenshot: { ok: false },
    });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(detached()).toBe(1);
  });

  test("a detach Chrome never answers does not hold the capture past its budget", async () => {
    const { session } = fakeSession(ANSWERS, false);
    const capture = await within(captureWith(session, "http://127.0.0.1:4600/", 50), 1_000);
    expect(capture).toMatchObject({ tab: true, html: { ok: true }, screenshot: { ok: true } });
  });
});

describe("capturePage", () => {
  test("a session that opens after the deadline is detached, not leaked", async () => {
    const { page } = fakePage({ url: "http://127.0.0.1:4600/" });
    const { session, detached } = fakeSession();
    const context = { newCDPSession: () => sleep(60).then(() => session) };
    Object.assign(page, { context: () => context });
    await expect(capturePage(page, 20)).rejects.toThrow("No answer within 20 ms.");
    await sleep(80);
    expect(detached(), "the late session is detached").toBe(1);
  });
});

describe("the page driver's capture", () => {
  test("has no tab to capture before the first write, and never opens one", async () => {
    let opened = 0;
    const driver = createPageDriver(async () => {
      opened += 1;
      return fakePage().page;
    });
    expect(await driver.capture({ timeoutMs: 100 })).toEqual({ tab: false });
    expect(opened).toBe(0);
  });

  test("captures the current tab through a CDP session of its own", async () => {
    const { page } = fakePage();
    const { session } = fakeSession();
    const pages: unknown[] = [];
    const context = { newCDPSession: (of: unknown) => (pages.push(of), Promise.resolve(session)) };
    Object.assign(page, { context: () => context });
    const driver = createPageDriver(async () => page);
    await driver.act({ kind: "navigate", url: "http://127.0.0.1:4600/" }, { timeoutMs: 500 });
    const capture = await driver.capture({ timeoutMs: 1000 });
    expect(capture).toMatchObject({ tab: true, url: "http://127.0.0.1:4600/", html: { ok: true } });
    expect(pages).toEqual([page]);
  });
});
