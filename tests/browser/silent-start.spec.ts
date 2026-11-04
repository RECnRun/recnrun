import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import * as v from "valibot";
import { connectWebSocket } from "./fixtures/cdp-client.ts";
import { expect, test } from "./fixtures/chrome.ts";
import { attachExtension, extensionPath, launchForUnpacked } from "./fixtures/extension-loaders.ts";
import type { LoadedExtension } from "./fixtures/extension-loaders.ts";

/*
 * POC PLAN.md P2.2 on Google Chrome Stable: the poc-d0 build, installed with
 * `Extensions.loadUnpacked` (diagnostic), announces its profile through Downloads as its worker
 * starts, with no folder chosen and no page open, keeps announcing it with no CDP client on the
 * worker (CHROMIUM.md group 12), and opens no dashboard by itself.
 */

const POC_EXTENSION_ID = "omllgeochjfpkjbkpcgjmnnbncdpiedd";
// PRESENCE_TTL_MS of apps/extension/src/p2p/folder-rendezvous.ts.
const PRESENCE_TTL_MS = 60_000;
const APPEAR_MS = 10_000;
// Two TTLs plus one refresh period's slack, so a third rewrite has time to land.
const MEASURE_MS = 2 * PRESENCE_TTL_MS + 5_000;
const MAX_GAP_MS = PRESENCE_TTL_MS;
const MIN_REWRITES = 3;
const SAMPLE_MS = 1_000;
const KEYS = ["profileId", "displayName", "fingerprint", "createdAt", "expiresAt", "namespace"];

// PresenceSchema plus the namespace and the boot; strict, so a path or root key fails it.
const RegistrationSchema = v.strictObject({
  profileId: v.pipe(v.string(), v.uuid()),
  displayName: v.pipe(v.string(), v.nonEmpty()),
  fingerprint: v.pipe(v.string(), v.regex(/^[0-9A-F:]+$/)),
  createdAt: v.number(),
  expiresAt: v.number(),
  namespace: v.literal("lab"),
  boot: v.pipe(v.string(), v.uuid()),
});

type Registration = v.InferOutput<typeof RegistrationSchema>;

interface Seen {
  text: string;
  presence: Registration;
  mtimeMs: number;
}

/** Chrome's own download folder for the root, written before its first launch. */
async function prepareRoot(): Promise<{ root: string; downloads: string }> {
  const root = await mkdtemp(join(tmpdir(), "recnrun-silent-"));
  const downloads = join(root, "downloads");
  const preferences = {
    download: { prompt_for_download: false, default_directory: downloads, directory_upgrade: true },
  };
  await mkdir(join(root, "Default"), { recursive: true });
  await writeFile(join(root, "Default", "Preferences"), JSON.stringify(preferences));
  return { root, downloads };
}

/** The presence under the root's Downloads folder, read from disk only, never through Chrome. */
async function readPresence(downloads: string): Promise<Seen | undefined> {
  const peers = join(downloads, "RECnRun/poc/lab/peers");
  const folders = await readdir(peers).catch(() => []);
  expect(folders.length, `one profile under ${peers}`).toBeLessThanOrEqual(1);
  if (folders[0] === undefined) return undefined;
  const path = join(peers, folders[0], "presence.json");
  try {
    const [text, info] = await Promise.all([readFile(path, "utf8"), stat(path)]);
    const parsed = v.safeParse(RegistrationSchema, JSON.parse(text));
    return parsed.success ? { text, presence: parsed.output, mtimeMs: info.mtimeMs } : undefined;
  } catch {
    // Absent, or caught between Chrome's rename and its write.
    return undefined;
  }
}

/** The first presence written at or after `since`, polled on disk until `ms` pass. */
async function presenceAfter(downloads: string, since: number, ms = APPEAR_MS) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const seen = await readPresence(downloads);
    if (seen && seen.presence.createdAt >= since) return seen;
    await delay(SAMPLE_MS / 10);
  }
  return undefined;
}

/** Checks the first presence after an install: on time, the registration's keys, no path. */
function checkFirst(found: Seen | undefined, installedAt: number): Seen {
  expect(found, `a presence within ${APPEAR_MS} ms of the install`).toBeDefined();
  const { text } = found as Seen;
  expect(Object.keys(JSON.parse(text) as object)).toEqual([...KEYS, "boot"]);
  expect(text).not.toMatch(/"(path|root)"/);
  const afterMs = (found as Seen).presence.createdAt - installedAt;
  test.info().annotations.push({ type: "presence", description: `+${afterMs} ms ${text}` });
  return found as Seen;
}

/** The time between consecutive writes, by the createdAt each carries. */
function gapsOf(writes: Seen[]): number[] {
  const created = writes.map((each) => each.presence.createdAt);
  return created.slice(1).map((at, index) => at - (created[index] as number));
}

/** Every rewrite of the presence for MEASURE_MS after `from`, from its content and mtime on disk only. */
async function watchRewrites(downloads: string, first: Seen, from: number): Promise<Seen[]> {
  const writes = [first];
  const end = from + MEASURE_MS;
  while (Date.now() < end) {
    await delay(SAMPLE_MS);
    const last = writes.at(-1) as Seen;
    const seen = await readPresence(downloads);
    if (seen && seen.presence.createdAt > last.presence.createdAt) {
      expect(seen.presence.boot, "the same browser session keeps its boot").toBe(
        first.presence.boot,
      );
      expect(seen.presence.profileId).toBe(first.presence.profileId);
      expect(seen.presence.expiresAt).toBeGreaterThan(last.presence.expiresAt);
      expect(seen.mtimeMs).toBeGreaterThan(last.mtimeMs);
      writes.push(seen);
    }
    const quiet = Date.now() - (writes.at(-1) as Seen).presence.createdAt;
    if (quiet > MAX_GAP_MS) {
      throw new Error(
        `no rewrite for ${quiet} ms; rewrite gaps ${gapsOf(writes).join(", ") || "none"} ms`,
      );
    }
  }
  return writes;
}

/** Every dashboard tab, listed over a fresh browser-target client that attaches to nothing. */
async function dashboardsOver(wsEndpoint: string): Promise<string[]> {
  const client = await connectWebSocket(wsEndpoint);
  try {
    const { targetInfos } = await client.send<{ targetInfos: { url: string }[] }>(
      "Target.getTargets",
    );
    const url = `chrome-extension://${POC_EXTENSION_ID}/dashboard.html`;
    return targetInfos.map((target) => target.url).filter((each) => each.startsWith(url));
  } finally {
    client.close();
  }
}

/** Installs poc-d0, drops every CDP client once it wrote, and watches the presence on disk for two TTLs. */
async function unattended(root: string, downloads: string) {
  const chrome = await launchForUnpacked({ userDataDir: root });
  try {
    // connectOverCDP routes every download to its own folder; Chrome's own must take the writes.
    await chrome.cdp.send("Browser.setDownloadBehavior", { behavior: "default" });
    const installedAt = Date.now();
    const { id } = await chrome.cdp.send("Extensions.loadUnpacked", {
      path: extensionPath("poc-d0"),
    });
    expect(id).toBe(POC_EXTENSION_ID);
    const first = checkFirst(await presenceAfter(downloads, installedAt), installedAt);
    // Playwright auto-attaches to every service worker, and an attached worker never idles out.
    await chrome.browser.close();
    const detachedAt = Date.now();
    expect(chrome.exited(), "Chrome runs on without a CDP client").toBe(false);
    const writes = await watchRewrites(downloads, first, detachedAt);
    expect(await dashboardsOver(chrome.wsEndpoint), "no dashboard after the install").toEqual([]);
    return { writes, detachedAt };
  } finally {
    await chrome.close();
  }
}

/** Launches Chrome on the root, installs poc-d0, and attaches to its worker. */
async function install(root: string): Promise<{ loaded: LoadedExtension; installedAt: number }> {
  const chrome = await launchForUnpacked({ userDataDir: root });
  try {
    await chrome.cdp.send("Browser.setDownloadBehavior", { behavior: "default" });
    const installedAt = Date.now();
    const { id } = await chrome.cdp.send("Extensions.loadUnpacked", {
      path: extensionPath("poc-d0"),
    });
    expect(id).toBe(POC_EXTENSION_ID);
    return { loaded: await attachExtension(chrome, id), installedAt };
  } catch (error) {
    await chrome.close();
    throw error;
  }
}

test("the poc-d0 worker announces its profile through Downloads, unattended, and opens no dashboard", async () => {
  test.setTimeout(240_000);
  const testInfo = test.info();
  const { root, downloads } = await prepareRoot();
  try {
    const { writes, detachedAt } = await unattended(root, downloads);
    const { profileId, boot } = (writes[0] as Seen).presence;
    const measured = Date.now() - detachedAt;
    const tail = Date.now() - (writes.at(-1) as Seen).presence.createdAt;
    const gaps = gapsOf(writes);
    const rewrites = writes.filter((each) => each.presence.createdAt > detachedAt).length;
    const report = `rewrite gaps ${gaps.join(", ")} ms; ${rewrites} rewrites in the ${measured} ms with no CDP client, the last ${tail} ms before the end`;
    expect(rewrites, report).toBeGreaterThanOrEqual(MIN_REWRITES);
    expect(measured, report).toBeGreaterThanOrEqual(2 * PRESENCE_TTL_MS);
    expect(Math.max(tail, ...gaps), report).toBeLessThanOrEqual(MAX_GAP_MS);
    testInfo.annotations.push({ type: "unattended", description: report });

    // Extensions.loadUnpacked does not survive a relaunch (CHROMIUM.md group 9): install again.
    const again = await install(root);
    try {
      const { presence } = checkFirst(
        await presenceAfter(downloads, again.installedAt),
        again.installedAt,
      );
      expect(presence.boot, "a new browser session has a new boot").not.toBe(boot);
      expect(presence.profileId).toBe(profileId);
      expect(await dashboardsOver(again.loaded.chrome.wsEndpoint), "no dashboard").toEqual([]);
      const learned = () =>
        again.loaded.evaluateInBackground(
          "chrome.storage.session.get('pocDownloadsRoot').then((items) => items.pocDownloadsRoot)",
        );
      await expect.poll(learned, { timeout: APPEAR_MS }).toBe(downloads);
    } finally {
      await again.loaded.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
  console.log(testInfo.annotations.map((each) => `${each.type}: ${each.description}`).join("\n"));
});
