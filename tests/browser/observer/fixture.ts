import { readFile } from "node:fs/promises";
import type { CDPSession, Page } from "@playwright/test";
import { expect, test as base } from "../fixtures/chrome.ts";
import type { LaunchedChrome } from "../fixtures/chrome.ts";
import { createObserver, currentRunId, evidenceName } from "./observer.ts";
import type { Observer } from "./observer.ts";
import { hashValue } from "./redact.ts";

export { expect } from "../fixtures/chrome.ts";
export type { Observer } from "./observer.ts";

async function firstPage(chrome: LaunchedChrome): Promise<Page> {
  const [context] = chrome.browser.contexts();
  if (!context) throw new Error("Chrome has no default browser context");
  return context.pages()[0] ?? context.newPage();
}

/**
 * Chrome's `chrome` fixture plus an `observer` started on its first page. Teardown writes the
 * evidence set even when the test failed; `observer.page` is the page to drive.
 */
export const test = base.extend<{ observer: Observer }>({
  observer: async ({ chrome }, use, testInfo) => {
    const observer = createObserver({
      cdp: chrome.cdp,
      page: await firstPage(chrome),
      runId: currentRunId(),
      name: evidenceName(testInfo),
    });
    await observer.start();
    try {
      await use(observer);
    } finally {
      await observer.finish();
    }
  },
});

/** Raw values of the browser's cookies named `names`, kept in memory only, to check redaction. */
export async function cookieValues(cdp: CDPSession, names: readonly string[]): Promise<string[]> {
  const { cookies } = await cdp.send("Storage.getCookies");
  return cookies.filter((cookie) => names.includes(cookie.name)).map((cookie) => cookie.value);
}

/**
 * The evidence files exist and hold none of `secrets` in clear, while their hashes are present,
 * so the observer did see them (PLAN.md P0.7).
 */
export async function expectRedactedEvidence(files: string[], secrets: string[]): Promise<void> {
  expect(secrets.length, "raw cookie values to look for").toBeGreaterThan(0);
  const contents = await Promise.all(files.map((file) => readFile(file, "utf8")));
  for (const [index, content] of contents.entries()) {
    expect(content.length, `${files[index]} is not empty`).toBeGreaterThan(0);
    for (const secret of secrets) {
      expect(content.includes(secret), `a raw cookie value in ${files[index]}`).toBe(false);
    }
  }
  const all = contents.join("\n");
  for (const secret of secrets) expect(all).toContain(hashValue(secret));
}
