import { describe, expect, test } from "vite-plus/test";
import { captureWith, type CaptureSession } from "../src/replay-capture.ts";
import { createPageDriver } from "../src/replay.ts";
import { fakePage } from "./replay-page.ts";

const PNG = Buffer.from([137, 80, 78, 71]);
const HTML = "<!DOCTYPE html><html><body>Box</body></html>";
const ANSWERS: Record<string, unknown> = {
  "DOM.getDocument": { root: { nodeId: 7, nodeName: "#document" } },
  "DOM.getOuterHTML": { outerHTML: HTML },
  "Page.captureScreenshot": { data: PNG.toString("base64") },
};

/** A CDP session that answers from `answers`; a missing answer never settles. */
function fakeSession(answers: Record<string, unknown> = ANSWERS) {
  const sent: string[] = [];
  let detached = 0;
  const session: CaptureSession = {
    send(method, params) {
      sent.push(`${method} ${JSON.stringify(params)}`);
      return method in answers ? Promise.resolve(answers[method]) : new Promise(() => {});
    },
    detach: () => {
      detached += 1;
      return Promise.resolve();
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
