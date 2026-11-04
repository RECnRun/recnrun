import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import * as v from "valibot";
import { expect, test } from "./fixtures/chrome.ts";
import { attachExtension, extensionPath, launchForUnpacked } from "./fixtures/extension-loaders.ts";
import type { LoadedExtension } from "./fixtures/extension-loaders.ts";

/*
 * POC PLAN.md P2.2 on Google Chrome Stable: the poc-d0 build, installed with
 * `Extensions.loadUnpacked` (diagnostic), announces its profile through Downloads as its worker
 * starts, with no folder chosen and no page open, and opens no dashboard by itself.
 */

const POC_EXTENSION_ID = "omllgeochjfpkjbkpcgjmnnbncdpiedd";
// PRESENCE_TTL_MS of apps/extension/src/p2p/folder-rendezvous.ts.
const PRESENCE_TTL_MS = 60_000;
const APPEAR_MS = 10_000;
const REWRITE_MS = PRESENCE_TTL_MS / 2 + 5_000;
const POLL_MS = 100;
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

/** Launches Chrome on the root and installs poc-d0; the worker starts with the install. */
async function install(root: string): Promise<{ loaded: LoadedExtension; installedAt: number }> {
  const chrome = await launchForUnpacked({ userDataDir: root });
  try {
    // connectOverCDP routes every download to its own folder; Chrome's own must take the first write.
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

/** Every extension page Chrome lists that is the dashboard. */
async function dashboards(loaded: LoadedExtension): Promise<string[]> {
  const { targetInfos } = await loaded.chrome.cdp.send("Target.getTargets");
  const url = `chrome-extension://${POC_EXTENSION_ID}/dashboard.html`;
  return targetInfos.map((target) => target.url).filter((each) => each.startsWith(url));
}

const storedProfileId = (loaded: LoadedExtension) =>
  loaded.evaluateInBackground(
    "chrome.storage.local.get('profileIdentity').then((items) => items.profileIdentity?.profileId)",
  );

/** The presence this profile wrote at or after `since`, polled until `ms` pass. */
async function presenceAfter(
  loaded: LoadedExtension,
  downloads: string,
  since: number,
  ms: number,
): Promise<{ text: string; presence: Registration } | undefined> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const profileId = await storedProfileId(loaded).catch(() => undefined);
    const path = join(downloads, `RECnRun/poc/lab/peers/${String(profileId)}/presence.json`);
    const text = typeof profileId === "string" ? await readFile(path, "utf8").catch(() => "") : "";
    const parsed = v.safeParse(RegistrationSchema, text ? JSON.parse(text) : undefined);
    if (parsed.success && parsed.output.createdAt >= since)
      return { text, presence: parsed.output };
    await delay(POLL_MS);
  }
  return undefined;
}

/** Waits for the first presence after the install and checks it: no dashboard, no path. */
async function firstPresence(loaded: LoadedExtension, downloads: string, installedAt: number) {
  const found = await presenceAfter(loaded, downloads, installedAt, APPEAR_MS);
  const appearedMs = Date.now() - installedAt;
  expect.soft(await dashboards(loaded), "no dashboard after the install").toEqual([]);
  expect(found, `a presence within ${APPEAR_MS} ms of the install`).toBeDefined();
  const { text = "", presence } = found ?? {};
  expect(Object.keys(JSON.parse(text) as object)).toEqual([...KEYS, "boot"]);
  expect(text).not.toMatch(/"(path|root)"/);
  test.info().annotations.push({ type: "presence", description: text });
  return { presence: presence as Registration, appearedMs };
}

test("the poc-d0 worker announces its profile through Downloads and opens no dashboard", async () => {
  test.setTimeout(150_000);
  const testInfo = test.info();
  const { root, downloads } = await prepareRoot();
  try {
    const first = await install(root);
    let boot: string;
    try {
      const { presence, appearedMs } = await firstPresence(
        first.loaded,
        downloads,
        first.installedAt,
      );
      boot = presence.boot;
      const rewritten = await presenceAfter(
        first.loaded,
        downloads,
        presence.createdAt + 1,
        REWRITE_MS,
      );
      const rewriteMs = rewritten ? rewritten.presence.createdAt - presence.createdAt : -1;
      expect(rewritten, `rewritten within ${REWRITE_MS} ms`).toBeDefined();
      expect(rewritten?.presence.boot).toBe(boot);
      expect(await dashboards(first.loaded), "no dashboard after the rewrite").toEqual([]);
      const learned = await first.loaded.evaluateInBackground(
        "chrome.storage.session.get('pocDownloadsRoot').then((items) => items.pocDownloadsRoot)",
      );
      expect(learned).toBe(downloads);
      testInfo.annotations.push({
        type: "install",
        description: `appeared ${appearedMs} ms, rewritten after ${rewriteMs} ms`,
      });
    } finally {
      await first.loaded.chrome.close();
    }

    // Extensions.loadUnpacked does not survive a relaunch (CHROMIUM.md group 9): install again.
    const again = await install(root);
    try {
      const { presence, appearedMs } = await firstPresence(
        again.loaded,
        downloads,
        again.installedAt,
      );
      expect(presence.boot, "a new browser session has a new boot").not.toBe(boot);
      testInfo.annotations.push({ type: "relaunch", description: `appeared ${appearedMs} ms` });
    } finally {
      await again.loaded.chrome.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
  console.log(testInfo.annotations.map((each) => `${each.type}: ${each.description}`).join("\n"));
});
