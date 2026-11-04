import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import * as v from "valibot";
import { attachExtension, extensionPath } from "../../browser/fixtures/extension-loaders.ts";
import type { LaunchedChrome } from "../../browser/fixtures/chrome.ts";
import type { LoadedExtension } from "../../browser/fixtures/extension-loaders.ts";
import type { VerdictTarget } from "./downloads-verdicts.ts";
import { RegistryPeerSchema, presenceIn } from "./e4-launcher.ts";
import type { PresenceFile } from "./e4-launcher.ts";

/*
 * E4's profiles: poc-d0 installed so that its worker's first presence goes to Chrome's own
 * Downloads folder (silent-start.spec.ts), read back through its own pages and storage.
 */

// The id the POC manifests pin with apps/extension/scripts/poc-key.mjs.
const POC_EXTENSION_ID = "omllgeochjfpkjbkpcgjmnnbncdpiedd";
const PRESENCE_MS = 15_000;
const OPEN_EXIT_MS = 15_000;
const POLL_MS = 100;

export interface E4Profile {
  name: string;
  root: string;
  installed: LoadedExtension;
}

interface OpenResult {
  code: number | null;
  /** True when it had to be stopped: it did not hand its URL to the running Chrome and exit. */
  stopped: boolean;
}

/** One sample's profiles and folders; `dispose` stops what it launched and removes what it made. */
export interface E4Session {
  /** The OS default Downloads candidate: Chrome's own in the lab, a throwaway stand-in on the host. */
  defaultDownloads: string;
  /** False on the host, where the default is a stand-in written into each root's Preferences. */
  realDefault: boolean;
  /** A fresh folder outside the default, for a launcher-created or a custom Downloads folder. */
  folder(name: string): Promise<string>;
  /** poc-d0 on a fresh root whose Chrome downloads to `downloads`, or to the default when undefined. */
  launch(name: string, downloads?: string): Promise<E4Profile>;
  /** The launcher's opening: Chrome on the profile's root with `url`, forwarded to the running one. */
  open(profile: E4Profile, url: string): Promise<OpenResult>;
  /** Stops one profile's Chrome, as its owner quitting it. */
  quit(profile: E4Profile): Promise<void>;
  /** The launcher record's file, outside every profile and Downloads folder. */
  record: string;
  dispose(): Promise<void>;
}

/** What differs between the lab and the host: where folders live and how Chrome starts. */
export type SessionPlatform = Pick<E4Session, "defaultDownloads" | "realDefault"> & {
  makeFolder(name: string): Promise<string>;
  removeFolder(path: string): Promise<void>;
  launch(root: string): Promise<LaunchedChrome>;
  binary: string;
  /** Flags of the opening besides `--user-data-dir` and the URL. */
  openArgs: readonly string[];
  /** Runs after every profile stopped and every folder is gone. */
  cleanup(): Promise<void>;
};

export interface E4Environment {
  target: VerdictTarget;
  session(): Promise<E4Session>;
}

/** Chrome's download folder for a root, written before its first launch, as E2 does. */
async function writeDownloadsPreference(root: string, downloads: string | undefined) {
  const folder = downloads ? { default_directory: downloads, directory_upgrade: true } : {};
  const preferences = { download: { prompt_for_download: false, ...folder } };
  await mkdir(join(root, "Default"), { recursive: true });
  await writeFile(join(root, "Default", "Preferences"), JSON.stringify(preferences));
}

/** A session over `platform`: profiles and folders it made are stopped and removed on dispose. */
export async function createSession(platform: SessionPlatform): Promise<E4Session> {
  const folders: string[] = [];
  const running = new Set<E4Profile>();
  const folder = async (name: string) => {
    const path = await platform.makeFolder(name);
    folders.push(path);
    return path;
  };
  const quit = async (profile: E4Profile) => {
    if (running.delete(profile)) await profile.installed.close();
  };
  const record = join(await folder("launcher"), "record");
  return {
    defaultDownloads: platform.defaultDownloads,
    realDefault: platform.realDefault,
    folder,
    record,
    launch: async (name, downloads) => {
      const root = await folder(`profile-${name}`);
      const fallback = platform.realDefault ? undefined : platform.defaultDownloads;
      await writeDownloadsPreference(root, downloads ?? fallback);
      const profile = { name, root, installed: await installPoc(await platform.launch(root)) };
      running.add(profile);
      return profile;
    },
    open: (profile, url) =>
      runOpening(platform.binary, [`--user-data-dir=${profile.root}`, ...platform.openArgs, url]),
    quit,
    dispose: async () => {
      for (const profile of running) await quit(profile).catch(() => undefined);
      for (const path of folders.reverse()) await platform.removeFolder(path);
      await platform.cleanup();
    },
  };
}

export const bootstrapUrl = (token: string) =>
  `chrome-extension://${POC_EXTENSION_ID}/bootstrap.html#token=${token}`;

/** Installs poc-d0 after giving Chrome its own download behavior back, so the first presence is Chrome's. */
async function installPoc(chrome: LaunchedChrome): Promise<LoadedExtension> {
  try {
    // connectOverCDP routes every download to its own folder; Chrome's own must take the first write.
    await chrome.cdp.send("Browser.setDownloadBehavior", { behavior: "default" });
    const { id } = await chrome.cdp.send("Extensions.loadUnpacked", {
      path: extensionPath("poc-d0"),
    });
    if (id !== POC_EXTENSION_ID)
      throw new Error(`poc-d0 installed as ${id}, not ${POC_EXTENSION_ID}`);
    return await attachExtension(chrome, id);
  } catch (error) {
    await chrome.close();
    throw error;
  }
}

/** Runs a launcher opening and waits for it to exit; stops only that process when it does not. */
async function runOpening(binary: string, args: readonly string[]): Promise<OpenResult> {
  const child = spawn(binary, args, { stdio: "ignore" });
  // A spawn error (no binary, no permission) is the harness's, never an exit result.
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once("exit", (code) => resolve(code));
    child.once("error", reject);
  });
  const outcome = await Promise.race([exited, delay(OPEN_EXIT_MS, "timeout" as const)]);
  if (outcome !== "timeout") return { code: outcome, stopped: false };
  child.kill("SIGTERM");
  return { code: await exited, stopped: true };
}

const StoredSchema = v.object({
  profileId: v.optional(v.string()),
  boot: v.optional(v.string()),
  root: v.optional(v.string()),
});
export type Stored = v.InferOutput<typeof StoredSchema>;

/** What the profile's worker keeps: its id, this session's boot, and the root Chrome reported. */
export async function storedOf(profile: E4Profile): Promise<Stored> {
  const expression = `Promise.all([chrome.storage.local.get('profileIdentity'), chrome.storage.session.get(['pocBoot', 'pocDownloadsRoot'])]).then(([local, session]) => ({ profileId: local.profileIdentity?.profileId, boot: session.pocBoot, root: session.pocDownloadsRoot }))`;
  return v.parse(StoredSchema, await profile.installed.evaluateInBackground(expression));
}

/** The profile's presence under `downloads` once its worker learned a root, polled for a while. */
export async function presenceOf(
  profile: E4Profile,
  downloads: string,
): Promise<{ presence?: PresenceFile; stored: Stored }> {
  const deadline = Date.now() + PRESENCE_MS;
  for (;;) {
    const stored = await storedOf(profile).catch((): Stored => ({}));
    const presence = stored.profileId ? await presenceIn(downloads, stored.profileId) : undefined;
    if ((presence && stored.root) || Date.now() > deadline) return { presence, stored };
    await delay(POLL_MS);
  }
}

const OwnRegistrySchema = v.strictObject({
  reason: v.string(),
  namespace: v.string(),
  peers: v.array(RegistryPeerSchema),
});
export type OwnRegistry = v.InferOutput<typeof OwnRegistrySchema>;

type PocWindow = { __poc?: { readRegistry?: () => Promise<unknown> } };

/** `window.__poc.readRegistry()` in the profile's diagnostics page: registry.json from its own root. */
export async function readRegistryIn(profile: E4Profile): Promise<OwnRegistry> {
  const [context] = profile.installed.chrome.browser.contexts();
  if (!context) throw new Error("Chrome has no default browser context");
  const page = await context.newPage();
  try {
    await page.goto(`chrome-extension://${POC_EXTENSION_ID}/diagnostics.html`);
    const ready = () => typeof (window as PocWindow).__poc?.readRegistry === "function";
    await page.waitForFunction(ready, undefined, { timeout: PRESENCE_MS });
    const read = await page.evaluate(() => (window as PocWindow).__poc?.readRegistry?.());
    return v.parse(OwnRegistrySchema, read);
  } finally {
    await page.close();
  }
}

/** The bootstrap tabs Chrome lists for the profile, with their fragments. */
export async function bootstrapTabs(profile: E4Profile): Promise<string[]> {
  const { targetInfos } = await profile.installed.chrome.cdp.send("Target.getTargets");
  const page = `chrome-extension://${POC_EXTENSION_ID}/bootstrap.html`;
  return targetInfos.map((target) => target.url).filter((url) => url.startsWith(page));
}
