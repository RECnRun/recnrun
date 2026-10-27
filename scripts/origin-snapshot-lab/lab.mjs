// Launches a disposable Chromium with the lab extension and wraps its `globalThis.lab` handle.
import { chromium } from "@playwright/test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { APP, SSO } from "./fixture/server.mjs";

const extensionPath = fileURLToPath(new URL("extension", import.meta.url));
export const artifacts = fileURLToPath(
  new URL("../../.artifacts/origin-snapshot-lab/", import.meta.url),
);

/** Writes one experiment's evidence as JSON under .artifacts/origin-snapshot-lab. */
export function writeEvidence(name, value) {
  mkdirSync(artifacts, { recursive: true });
  const file = join(artifacts, `${name}.json`);
  writeFileSync(file, JSON.stringify(value, null, 2));
  return file;
}

export function handle(worker) {
  const call = (method, args) =>
    worker.evaluate(([name, values]) => globalThis.lab[name](...values), [method, args]);
  return new Proxy(
    {},
    { get: (_, method) => (method === "then" ? undefined : (...args) => call(method, args)) },
  );
}

/** Host access for the site's origin and each cookie host, its subdomains included. */
export const hostPermissions = (origin, cookieHosts) => [
  `${origin}/*`,
  ...cookieHosts.flatMap((host) => [`*://${host}/*`, `*://*.${host}/*`]),
];

/** `<url> [--with-host <host>]... [--incognito]`; vp run passes the `--` separator through. */
const FLAGS = ["--", "--incognito", "--force-clear"];

export function parseSite(argv, usage) {
  const cookieHosts = [];
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--with-host") cookieHosts.push(argv[(index += 1)]);
    else if (!FLAGS.includes(argv[index])) positional.push(argv[index]);
  }
  if (positional.length !== 1 || cookieHosts.some((host) => !/^[\w.-]+$/.test(host ?? ""))) {
    throw new Error(usage);
  }
  return {
    url: positional[0],
    cookieHosts,
    incognito: argv.includes("--incognito"),
    forceClear: argv.includes("--force-clear"),
  };
}

/**
 * The lab extension for the person's own Chrome, in `dir`: host access to the site and its cookie
 * hosts, and a preset.json the service worker applies whenever it starts (Experiment G).
 */
export function writeUnpacked(
  { url, cookieHosts, forceClear = false },
  dir = join(artifacts, "unpacked"),
) {
  rmSync(dir, { recursive: true, force: true });
  cpSync(extensionPath, dir, { recursive: true });
  const file = join(dir, "manifest.json");
  const manifest = JSON.parse(readFileSync(file, "utf8"));
  const host_permissions = hostPermissions(new URL(url).origin, cookieHosts);
  writeFileSync(file, JSON.stringify({ ...manifest, host_permissions }, null, 2));
  writeFileSync(
    join(dir, "preset.json"),
    JSON.stringify({ url, cookieHosts, forceClear }, null, 2),
  );
  return dir;
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
 * Changes the extension in chrome://extensions, as the user would, and returns the service worker
 * of the reloaded extension. Developer mode first, or Chromium disables the reloaded unpacked one.
 */
async function throughExtensionsPage(context, worker, change) {
  const reloaded = context.waitForEvent("serviceworker");
  const page = await context.newPage();
  await page.goto("chrome://extensions/");
  await page.evaluate(
    async ([extensionId, name]) => {
      const developer = globalThis.chrome.developerPrivate;
      await developer.updateProfileConfiguration({ inDeveloperMode: true });
      if (name === "reload") await developer.reload(extensionId, { failQuietly: true });
      else await developer.updateExtensionConfiguration({ extensionId, incognitoAccess: true });
    },
    [new URL(worker.url()).host, change],
  );
  const next = await reloaded;
  await page.close();
  return next;
}

// A profile's Preferences cannot carry "Allow in Incognito": macOS keeps it in Secure Preferences.
const allowIncognito = (context, worker) => throughExtensionsPage(context, worker, "incognito");

/** Reloads the extension: its worker starts again with empty memory, as after Chrome stops it. */
export async function restartExtension({ context, worker }) {
  const next = await throughExtensionsPage(context, worker, "reload");
  const lab = handle(next);
  await lab.ready();
  return { worker: next, lab };
}

async function extensionWorker(context, incognito) {
  const first = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
  return incognito ? allowIncognito(context, first) : first;
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
  incognito = false,
} = {}) {
  const profile = mkdtempSync(join(tmpdir(), "recnrun-origin-lab-"));
  const context = await chromium.launchPersistentContext(profile, {
    channel: "chromium",
    headless: process.env.LAB_HEADLESS === "1",
    ignoreDefaultArgs: bfcache ? ["--disable-back-forward-cache"] : [],
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, ...args],
  });
  const worker = await extensionWorker(context, incognito);
  const lab = handle(worker);
  await lab.ready();
  await lab.register(origin);
  const close = async () => {
    await context.close();
    rmSync(profile, { recursive: true, force: true });
  };
  return { context, worker, lab, version: context.browser()?.version(), close };
}

/** The fixture's sign-in page, or the SSO app's session once the silent sign-in settled. */
export async function ssoSession(page) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const found = await page
      .evaluate(() =>
        document.title === "SSO login" ? { login: true } : (window.__session ?? null),
      )
      .catch(() => null);
    if (found) return found;
    await page.waitForTimeout(100);
  }
  throw new Error(`no session or login page at ${page.url()}`);
}

/** The person signs in at the fixture's sign-in server, by hand in a real run. */
export async function signIn(page, user) {
  const back = encodeURIComponent(`${APP}/sso-app`);
  await page.goto(`${SSO}/realms/lab/login?user=${user}&return=${back}`);
  return ssoSession(page);
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

/** Opens `url` in a new incognito window, as the user would, and returns its page and tab id. */
export async function openIncognito({ context, worker }, url) {
  const known = new Set(context.pages());
  const tabId = await worker.evaluate(async (address) => {
    const created = await chrome.windows.create({ incognito: true, url: address });
    return created.tabs?.[0]?.id;
  }, url);
  const deadline = Date.now() + 10000;
  let page;
  while (!page && Date.now() < deadline) {
    page = context.pages().find((each) => !known.has(each));
    if (!page) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!page) throw new Error(`no page shows ${url} in the incognito window`);
  return { page, tabId };
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
