import type { Captured, PageCapture } from "@recnrun/engine";
import type { Page } from "playwright-core";
import * as v from "valibot";
import { withDeadline } from "./capture-documents.ts";
import type { ReplayPage } from "./replay-page.ts";

/** The CDP session of one tab, as Playwright's `CDPSession` offers it; unit tests fake it. */
export interface CaptureSession {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  detach(): Promise<void>;
}

const DocumentReply = v.object({ root: v.object({ nodeId: v.number() }) });
const OuterHtmlReply = v.object({ outerHTML: v.string() });
const ScreenshotReply = v.object({ data: v.string() });

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

async function part<T>(read: () => Promise<T>): Promise<Captured<T>> {
  try {
    return { ok: true, value: await read() };
  } catch (error) {
    return { ok: false, message: messageOf(error) };
  }
}

type Send = CaptureSession["send"];

async function ask<T>(
  send: Send,
  schema: v.GenericSchema<unknown, T>,
  method: string,
  params: Record<string, unknown>,
): Promise<T> {
  const parsed = v.safeParse(schema, await send(method, params));
  if (!parsed.success) throw new Error(`${method} answered ${v.summarize(parsed.issues)}`);
  return parsed.output;
}

// DOM.getOuterHTML serializes the tree in the browser, so no page script runs or can lie about it.
async function documentHtml(send: Send): Promise<string> {
  const { root } = await ask(send, DocumentReply, "DOM.getDocument", { depth: 0 });
  const { outerHTML } = await ask(send, OuterHtmlReply, "DOM.getOuterHTML", {
    nodeId: root.nodeId,
  });
  return outerHTML;
}

async function screenshotPng(send: Send): Promise<Uint8Array> {
  const { data } = await ask(send, ScreenshotReply, "Page.captureScreenshot", { format: "png" });
  return Buffer.from(data, "base64");
}

const DETACH_TIMEOUT_MS = 1_000;

// A detach Chrome never answers must not hold the capture; the session is gone with its tab anyway.
const detach = (session: CaptureSession, budgetMs: number) =>
  withDeadline(session.detach(), Math.max(1, Math.min(DETACH_TIMEOUT_MS, budgetMs))).catch(
    () => undefined,
  );

/** Captures a tab's serialized DOM and screenshot over its own CDP session within `timeoutMs`. */
export async function captureWith(
  session: CaptureSession,
  url: string,
  timeoutMs: number,
): Promise<PageCapture> {
  const end = Date.now() + timeoutMs;
  const send: CaptureSession["send"] = (method, params) =>
    withDeadline(session.send(method, params), Math.max(1, end - Date.now()));
  try {
    const html = await part(() => documentHtml(send));
    const screenshot = await part(() => screenshotPng(send));
    return { tab: true, url, html, screenshot };
  } finally {
    await detach(session, timeoutMs);
  }
}

/** Opens a CDP session on the replay's current tab and captures it, all within one `timeoutMs`. */
export async function capturePage(page: ReplayPage, timeoutMs: number): Promise<PageCapture> {
  const end = Date.now() + timeoutMs;
  const opening = page.context().newCDPSession(page as Page) as Promise<CaptureSession>;
  let expired = false;
  // A session that opens past the deadline serves no capture; it is detached instead of leaked.
  void opening.then(
    (session) => (expired ? detach(session, DETACH_TIMEOUT_MS) : undefined),
    () => undefined,
  );
  try {
    const session = await withDeadline(opening, timeoutMs);
    return await captureWith(session, page.url(), Math.max(1, end - Date.now()));
  } catch (error) {
    expired = true;
    throw error;
  }
}
