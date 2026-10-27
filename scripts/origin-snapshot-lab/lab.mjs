// Launches a disposable Chromium with the lab extension and wraps its `globalThis.lab` handle.
import { chromium } from "@playwright/test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { APP } from "./fixture/server.mjs";

const extensionPath = fileURLToPath(new URL("extension", import.meta.url));
const artifacts = fileURLToPath(new URL("../../.artifacts/origin-snapshot-lab/", import.meta.url));

/** Writes one experiment's evidence as JSON under .artifacts/origin-snapshot-lab. */
export function writeEvidence(name, value) {
  mkdirSync(artifacts, { recursive: true });
  const file = join(artifacts, `${name}.json`);
  writeFileSync(file, JSON.stringify(value, null, 2));
  return file;
}

function handle(worker) {
  const call = (method, args) =>
    worker.evaluate(([name, values]) => globalThis.lab[name](...values), [method, args]);
  return new Proxy(
    {},
    { get: (_, method) => (method === "then" ? undefined : (...args) => call(method, args)) },
  );
}

/** A temporary copy of the lab extension whose manifest `edit` changed; delete it after use. */
export function extensionCopy(edit) {
  const copy = mkdtempSync(join(tmpdir(), "recnrun-origin-lab-extension-"));
  cpSync(extensionPath, copy, { recursive: true });
  const file = join(copy, "manifest.json");
  writeFileSync(file, JSON.stringify(edit(JSON.parse(readFileSync(file, "utf8")))));
  return copy;
}

/**
 * A Chromium with a temporary profile and the lab extension; headed unless LAB_HEADLESS=1.
 * Playwright turns the back/forward cache off; `bfcache: true` keeps Chrome's default. The gate
 * content script is registered for `origin` (the fixture by default).
 */
export async function launchLab({
  extension = extensionPath,
  args = [],
  bfcache = false,
  origin = APP,
} = {}) {
  const profile = mkdtempSync(join(tmpdir(), "recnrun-origin-lab-"));
  const context = await chromium.launchPersistentContext(profile, {
    channel: "chromium",
    headless: process.env.LAB_HEADLESS === "1",
    ignoreDefaultArgs: bfcache ? ["--disable-back-forward-cache"] : [],
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, ...args],
  });
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
  const lab = handle(worker);
  await lab.ready();
  await lab.register(origin);
  const close = async () => {
    await context.close();
    rmSync(profile, { recursive: true, force: true });
  };
  return { context, worker, lab, version: context.browser()?.version(), close };
}

/** What the observer of the tab's current document saw, once its IndexedDB read finished. */
export async function observed(page) {
  await page.waitForFunction(() => window.__observed?.tIdb !== undefined && window.app);
  return page.evaluate(() => window.__observed);
}

/** Writes `marker` as the app would, once app.js published window.app (after a switch commits). */
export async function write(page, marker) {
  await page.waitForFunction(() => window.app);
  await page.evaluate((value) => window.app.write(value), marker);
}

/** Opens the fixture app in a new tab and returns the page and its tab id. */
export async function openApp({ context, lab }, path = "/app") {
  const page = await context.newPage();
  await page.goto(`${APP}${path}`);
  await observed(page);
  return { page, tabId: await lab.tabIdFor(page.url()) };
}

/** Whether the observer saw exactly `marker` everywhere, or nothing at all when it is null. */
export function sawIdentity(seen, marker) {
  if (marker === null) {
    return seen.ls === null && seen.ss === null && seen.idb?.missing === true;
  }
  return seen.ls === marker && seen.ss === marker && seen.idb?.marker === marker;
}

export const brief = (seen) => ({ ls: seen.ls, ss: seen.ss, idb: seen.idb, href: seen.href });

export function stats(values) {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) return {};
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  return { n: sorted.length, min: sorted[0], median: at(0.5), p95: at(0.95), max: sorted.at(-1) };
}
