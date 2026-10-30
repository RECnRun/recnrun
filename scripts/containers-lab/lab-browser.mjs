// Launches a disposable Chromium with the lab extension (branded Chrome 137+ ignores
// --load-extension) and wraps the extension's `globalThis.lab` handle.
import { chromium } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { APP } from "./fixture-server.mjs";

const extensionPath = fileURLToPath(new URL("extension", import.meta.url));
const artifacts = fileURLToPath(new URL("../../.artifacts/containers-lab/", import.meta.url));

/** Writes one experiment's evidence as JSON under .artifacts/containers-lab. */
export function writeEvidence(name, value) {
  mkdirSync(artifacts, { recursive: true });
  writeFileSync(join(artifacts, `${name}.json`), JSON.stringify(value, null, 2));
  return join(artifacts, `${name}.json`);
}

function labHandle(worker) {
  const call = (method, ...args) =>
    worker.evaluate(([name, values]) => globalThis.lab[name](...values), [method, args]);
  return new Proxy(
    {},
    {
      get:
        (_, method) =>
        (...args) =>
          call(method, ...args),
    },
  );
}

/** The lab handle through an extension page, which also wakes a stopped service worker. */
export async function pageLab(context, extensionId) {
  const page = await context.newPage();
  // A reloading extension blocks its pages for a moment.
  for (let attempt = 0; ; attempt += 1) {
    try {
      await page.goto(`chrome-extension://${extensionId}/blank.html`);
      break;
    } catch (error) {
      if (attempt === 20) throw error;
      await page.waitForTimeout(500);
    }
  }
  const call = async (method, ...args) => {
    const { value, error } = await page.evaluate(
      ([name, values]) => chrome.runtime.sendMessage({ lab: name, args: values }),
      [method, args],
    );
    if (error) throw new Error(error);
    return value;
  };
  return new Proxy(
    {},
    { get: (_, method) => (method === "then" ? undefined : (...args) => call(method, ...args)) },
  );
}

/** The extension's current service worker; `after` skips one that has stopped. */
export async function labWorker(context, after) {
  const running = context.serviceWorkers().find((worker) => worker !== after);
  const worker = running ?? (await context.waitForEvent("serviceworker", (next) => next !== after));
  const lab = labHandle(worker);
  await lab.ready();
  return { worker, lab };
}

/**
 * A Chromium with a temporary profile; `close()` removes it unless `keep`. `profile` reopens a
 * kept one, `args` adds switches such as --restore-last-session, and `extension` loads another
 * directory than the lab's (a copy whose manifest names a real site).
 */
export async function launchLab({
  headless = true,
  profile = mkdtempSync(join(tmpdir(), "recnrun-containers-")),
  args = [],
  extension = extensionPath,
} = {}) {
  const context = await chromium.launchPersistentContext(profile, {
    channel: "chromium",
    headless,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, ...args],
  });
  const { worker, lab } = await labWorker(context);
  const version =
    context.browser()?.version() ?? (await worker.evaluate(() => navigator.userAgent));
  const close = async ({ keep = false } = {}) => {
    await context.close();
    if (!keep) rmSync(profile, { recursive: true, force: true });
  };
  return { context, worker, lab, version, profile, close };
}

/** Opens a tab in the group titled `title` (undefined: ungrouped) and returns its page and id. */
export async function openTab({ context, lab }, title, path = "/") {
  const token = randomUUID();
  const opened = context.waitForEvent("page", (page) => page.url().includes(token));
  const tabId = await lab.openTab(title, token);
  const page = await opened;
  await page.goto(`${APP}${path}`);
  return { page, tabId };
}

/**
 * Signs in through the fixture's form: POST /login answers 302 with the session cookie, and the
 * server renders /home for whoever the redirected request carried. Returns that rendered user.
 */
export async function signIn(page, user) {
  await page.goto(`${APP}/login-form?user=${encodeURIComponent(user)}`);
  await page.click("button");
  return readAfterReloads(page, "**/home");
}

/** Reads #user once `url` loads, through the reloads N1r may start (they abort the first load). */
export async function readAfterReloads(page, url) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await page.waitForURL(url);
      return await page.textContent("#user");
    } catch (error) {
      if (attempt === 2) throw error;
    }
  }
}

/** The identity the app sees for this page, by a fresh request. */
export const whoAmI = (page) => page.evaluate(async () => (await (await fetch("/me")).json()).user);
