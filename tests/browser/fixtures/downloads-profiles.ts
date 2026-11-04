import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "@playwright/test";
import type { Browser, BrowserContext, Worker } from "@playwright/test";
import { recordText, runCatalog } from "../../experiments/fixtures/e4-launcher.ts";
import type { CatalogRun } from "../../experiments/fixtures/e4-launcher.ts";
import { writeDownloadsPreference } from "../../host/fixtures/roots.ts";
import { pairingSection } from "../../e2e/fixtures/profiles.ts";
import type { Profile } from "../../e2e/fixtures/profiles.ts";
import { type CdpClient, connectWebSocket } from "./cdp-client.ts";
import { extensionPath, launchForUnpacked } from "./extension-loaders.ts";
import type { LaunchedChrome } from "./chrome.ts";

/*
 * POC profiles that pair over Downloads (POC PLAN.md P3.2): poc-d0 on throwaway roots that share
 * one Downloads folder, a stand-in launcher that reruns catalog.sh, and the process controls the
 * mesh, restart, and hierarchy cases need. No picker, no gesture: each worker pairs by itself.
 */

// The id the POC manifests pin with apps/extension/scripts/poc-key.mjs.
export const POC_EXTENSION_ID = "omllgeochjfpkjbkpcgjmnnbncdpiedd";
const EXTENSION_URL = `chrome-extension://${POC_EXTENSION_ID}/`;
const READY_MS = 15_000;
const POLL_MS = 100;
// Registry entries expire with their presence (60 s), so the stand-in launcher refreshes it often.
const CATALOG_EVERY_MS = 2_000;

/** Where the roots live and how Chrome starts on one: the lab's temporary folder, or the host's. */
export interface DownloadsPlatform {
  makeFolder(name: string): Promise<string>;
  removeFolder(path: string): Promise<void>;
  launch(root: string): Promise<LaunchedChrome>;
  /** The Downloads folder every profile shares; `written` puts it in each root's Preferences. */
  shared(): Promise<{ downloads: string; written: boolean }>;
  /** Runs after every profile stopped and every folder is gone. */
  cleanup?(): Promise<void>;
}

/** One POC profile; `context` and `serviceWorker` are stale while it is detached or stopped. */
export interface DownloadsProfile {
  name: string;
  root: string;
  /** Alias of `root`, as tests/e2e's Profile names it. */
  dir: string;
  profileId: string;
  chrome: LaunchedChrome;
  context: BrowserContext;
  serviceWorker: Worker;
}

export interface DownloadsGroup {
  /** The shared Downloads folder: catalog.sh's root, and every presence's and signal's. */
  downloads: string;
  /** The launcher record catalog.sh reads: one block naming the shared root. */
  record: string;
  profiles: DownloadsProfile[];
  /** poc-d0 on a fresh root, attached through Playwright. */
  launch(name: string): Promise<DownloadsProfile>;
  /** One catalog.sh run, after any run in flight; a non-zero exit throws. */
  catalog(): Promise<CatalogRun>;
  /** Reruns catalog.sh every `everyMs` until `dispose` or the returned stop, which rethrows a failure. */
  startCatalog(everyMs?: number): () => Promise<void>;
  /** SIGTERM, Chrome's own orderly quit; the root stays for a relaunch. */
  quit(profile: DownloadsProfile): Promise<void>;
  /** SIGKILL to the PID this group spawned, as a crash; the root stays. */
  kill(profile: DownloadsProfile): Promise<void>;
  /**
   * Chrome again on the profile's root, poc-d0 installed again (CHROMIUM.md group 9); with
   * `attach: false` no client stays on it, so `context` and `serviceWorker` stay stale until `attach`.
   */
  relaunch(profile: DownloadsProfile, options?: { attach?: boolean }): Promise<void>;
  /** Closes the extension's pages and drops Playwright's connection, so the worker may stop (group 12). */
  detach(profile: DownloadsProfile): Promise<void>;
  attach(profile: DownloadsProfile): Promise<void>;
  dispose(): Promise<void>;
}

interface ChromeGlobal {
  chrome: {
    storage: Record<"local" | "session", { get(key: string): Promise<Record<string, unknown>> }>;
  };
}

/** The worker's stored value under `key`, in local or session storage. */
export const storedIn = (worker: Worker, area: "local" | "session", key: string) =>
  worker.evaluate(
    async ([where, name]) =>
      (await (globalThis as unknown as ChromeGlobal).chrome.storage[where].get(name))[name],
    [area, key] as const,
  );

/** Polls `read` until it gives a value or `ms` pass. */
async function until<T>(read: () => Promise<T | undefined>, what: string, ms = READY_MS) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read().catch(() => undefined);
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`${what} within ${ms} ms`);
    await delay(POLL_MS);
  }
}

const installed = (id: string) => {
  if (id !== POC_EXTENSION_ID)
    throw new Error(`poc-d0 installed as ${id}, not ${POC_EXTENSION_ID}`);
};

/** Gives Chrome its own download behavior back, then installs poc-d0 over CDP. */
async function install(chrome: LaunchedChrome): Promise<void> {
  // connectOverCDP routes every download to its own folder; Chrome's own must take the writes.
  await chrome.cdp.send("Browser.setDownloadBehavior", { behavior: "default" });
  const path = extensionPath("poc-d0");
  installed((await chrome.cdp.send("Extensions.loadUnpacked", { path })).id);
}

/** Gives Chrome its own download behavior back over a client of its own, then runs `then` on it. */
async function overOwnClient(wsEndpoint: string, then?: (client: CdpClient) => Promise<void>) {
  const client = await connectWebSocket(wsEndpoint);
  try {
    await client.send("Browser.setDownloadBehavior", { behavior: "default" });
    await then?.(client);
  } finally {
    client.close();
  }
}

/** Installs poc-d0 over a client of its own once Playwright let go, so no client meets its worker. */
async function installUnattended(chrome: LaunchedChrome): Promise<void> {
  // Closed first: its connection keeps a worker running (group 12), and one it saw start then left stalled for a minute (E5).
  await chrome.browser.close();
  await overOwnClient(chrome.wsEndpoint, async (client) => {
    const path = extensionPath("poc-d0");
    installed((await client.send<{ id: string }>("Extensions.loadUnpacked", { path })).id);
  });
}

/** Playwright's default context of `browser` and the poc-d0 worker in it. */
async function connected(browser: Browser) {
  const [context] = browser.contexts();
  if (!context) throw new Error("Chrome has no default browser context");
  const ours = (worker: Worker) => worker.url().startsWith(EXTENSION_URL);
  const running = context.serviceWorkers().find(ours);
  const serviceWorker =
    running ??
    (await context.waitForEvent("serviceworker", { predicate: ours, timeout: READY_MS }));
  return { context, serviceWorker };
}

async function profileIdOf(worker: Worker): Promise<string> {
  const read = async () => {
    const identity = (await storedIn(worker, "local", "profileIdentity")) as
      | { profileId?: string }
      | undefined;
    return identity?.profileId;
  };
  return until(read, "poc-d0 stored no profile id");
}

/** Waits until the process this group spawned is gone. */
async function exited(chrome: LaunchedChrome): Promise<void> {
  await until(
    async () => (chrome.exited() ? true : undefined),
    `Chrome ${chrome.pid} did not exit`,
  );
}

/** A loop of `run` every `everyMs`; the stop ends it and rethrows the first failure. */
function loop(run: () => Promise<unknown>, everyMs: number): () => Promise<void> {
  const abort = new AbortController();
  let failure: unknown;
  const done = (async () => {
    while (!abort.signal.aborted) {
      await run().catch((error: unknown) => (failure ??= error));
      await delay(everyMs, undefined, { signal: abort.signal }).catch(() => undefined);
    }
  })();
  return async () => {
    abort.abort();
    await done;
    if (failure !== undefined) throw failure;
  };
}

/** A group over `platform`: what it launched is stopped, and what it made removed, on dispose. */
export async function createDownloadsGroup(platform: DownloadsPlatform): Promise<DownloadsGroup> {
  const folders: string[] = [];
  const folder = async (name: string) => {
    const path = await platform.makeFolder(name);
    folders.push(path);
    return path;
  };
  const { downloads, written } = await platform.shared();
  const record = join(await folder("launcher"), "record");
  await writeFile(record, recordText([{ downloadsRoot: downloads }]));
  const profiles: DownloadsProfile[] = [];
  const browsers = new Map<DownloadsProfile, Browser>();
  const loops: (() => Promise<void>)[] = [];
  let queue: Promise<unknown> = Promise.resolve();
  const catalog = (): Promise<CatalogRun> => {
    const run = queue.then(async () => {
      const result = await runCatalog(record, downloads);
      if (result.code !== 0) throw new Error(`catalog.sh exited ${result.code}: ${result.stderr}`);
      return result;
    });
    queue = run.catch(() => undefined);
    return run;
  };
  const start = async (chrome: LaunchedChrome) => {
    try {
      await install(chrome);
      return { chrome, ...(await connected(chrome.browser)) };
    } catch (error) {
      await chrome.close();
      throw error;
    }
  };
  const disconnect = async (profile: DownloadsProfile) => {
    await browsers
      .get(profile)
      ?.close()
      .catch(() => undefined);
    browsers.delete(profile);
  };
  const quit = async (profile: DownloadsProfile) => {
    await disconnect(profile);
    await profile.chrome.close();
  };
  return {
    downloads,
    record,
    profiles,
    catalog,
    startCatalog: (everyMs = CATALOG_EVERY_MS) => {
      const stop = loop(catalog, everyMs);
      loops.push(stop);
      return stop;
    },
    launch: async (name) => {
      const root = await folder(`profile-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`);
      await writeDownloadsPreference(root, written ? downloads : undefined);
      const started = await start(await platform.launch(root));
      const profileId = await profileIdOf(started.serviceWorker);
      const profile = { name, root, dir: root, profileId, ...started };
      profiles.push(profile);
      return profile;
    },
    quit,
    kill: async (profile) => {
      process.kill(profile.chrome.pid, "SIGKILL");
      await exited(profile.chrome);
      await quit(profile);
    },
    relaunch: async (profile, { attach = true } = {}) => {
      const chrome = await platform.launch(profile.root);
      if (attach) return void Object.assign(profile, await start(chrome));
      await installUnattended(chrome).catch(async (error: unknown) => {
        await chrome.close();
        throw error;
      });
      profile.chrome = chrome;
    },
    detach: async (profile) => {
      // Chrome quits with its last window, so the tabs that are not the extension's stay.
      const pages = profile.context.pages().filter((page) => page.url().startsWith(EXTENSION_URL));
      for (const page of pages) await page.close();
      await disconnect(profile);
      await profile.chrome.browser.close().catch(() => undefined);
    },
    attach: async (profile) => {
      const browser = await chromium.connectOverCDP(profile.chrome.wsEndpoint);
      browsers.set(profile, browser);
      // The connection routes every download to Playwright's folder again, as at launch.
      await overOwnClient(profile.chrome.wsEndpoint);
      Object.assign(profile, await connected(browser));
    },
    dispose: async () => {
      for (const stop of loops) await stop().catch(() => undefined);
      for (const profile of profiles) await quit(profile).catch(() => undefined);
      for (const path of folders.reverse()) await platform.removeFolder(path);
      await platform.cleanup?.();
    },
  };
}

const removeTree = (path: string) =>
  rm(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });

/** The lab: roots and one shared Downloads folder under the temporary folder, Chrome on PATH. */
export function tempPlatform(prefix: string): DownloadsPlatform {
  const made: string[] = [];
  return {
    makeFolder: (name) => mkdtemp(join(tmpdir(), `${prefix}-${name}-`)),
    removeFolder: removeTree,
    launch: (root) => launchForUnpacked({ userDataDir: root }),
    shared: async () => {
      const downloads = await mkdtemp(join(tmpdir(), `${prefix}-downloads-`));
      made.push(downloads);
      return { downloads, written: true };
    },
    cleanup: async () => {
      for (const path of made) await removeTree(path);
    },
  };
}

type PeerLinks = Record<string, { state: string; verified: boolean }>;

/** The peers `profile` holds a verified, connected link with, from its session storage. */
export async function linkedPeers(profile: DownloadsProfile): Promise<string[]> {
  const links = (await storedIn(profile.serviceWorker, "session", "peerLinks")) as
    | PeerLinks
    | undefined;
  return Object.entries(links ?? {})
    .flatMap(([peer, link]) => (link.verified && link.state === "connected" ? [peer] : []))
    .sort();
}

/** Waits until each profile is linked with every other one; answers how long that took. */
export async function waitForMesh(profiles: DownloadsProfile[], ms = 60_000): Promise<number> {
  const started = Date.now();
  const missing = async () => {
    const gaps: string[] = [];
    for (const profile of profiles) {
      const linked = await linkedPeers(profile);
      const others = profiles.filter(
        (other) => other !== profile && !linked.includes(other.profileId),
      );
      if (others.length > 0)
        gaps.push(`${profile.name} lacks ${others.map((each) => each.name).join(", ")}`);
    }
    return gaps;
  };
  const whole = async () => ((await missing()).length === 0 ? Date.now() - started : undefined);
  try {
    return await until(whole, "the mesh did not form", ms);
  } catch (error) {
    const gaps = await missing().catch(() => ["their links could not be read"]);
    throw new Error(`${(error as Error).message}: ${gaps.join("; ")}`);
  }
}

/** The profile as tests/e2e's helpers take it: a tab at an address of its own and a dashboard. */
export async function openViews(profile: DownloadsProfile, baseURL: string): Promise<Profile> {
  const site = await profile.context.newPage();
  await site.goto(new URL(`/privacy/?${encodeURIComponent(profile.name)}`, baseURL).href);
  const dashboard = await profile.context.newPage();
  await dashboard.goto(`${EXTENSION_URL}dashboard.html`);
  const { name, dir, context, serviceWorker } = profile;
  return { name, dir, context, serviceWorker, site, dashboard };
}

/** Saves the profile's name from its dashboard, as a person would, before its peers meet it. */
export async function nameProfile(view: Profile): Promise<void> {
  await pairingSection(view.dashboard).getByLabel("This profile").fill(view.name);
  await view.dashboard.getByRole("button", { name: "Save name" }).click();
  const saved = async () => {
    const identity = (await storedIn(view.serviceWorker, "local", "profileIdentity")) as
      | { displayName?: string }
      | undefined;
    return identity?.displayName === view.name ? true : undefined;
  };
  await until(saved, `${view.name} was not saved`);
}
