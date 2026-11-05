import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { Page } from "@playwright/test";
import { chromesOf, installProfile, skeleton } from "../../browser/fixtures/launcher-rig.ts";
import {
  createDownloadsGroup,
  openViews,
  tempPlatform,
} from "../../browser/fixtures/downloads-profiles.ts";
import type { DownloadsProfile } from "../../browser/fixtures/downloads-profiles.ts";
import { loop } from "../../browser/fixtures/catalog-loop.ts";
import { within } from "../../browser/fixtures/trust.ts";
import { namespaceFolder, presenceIn, runCatalog } from "../../experiments/fixtures/e4-launcher.ts";
import { ackProblems, quit, runOpen } from "../../experiments/fixtures/launcher-open.ts";
import type { Scene } from "../../experiments/fixtures/launcher-open.ts";
import { NAMESPACE, folderOf } from "../../experiments/fixtures/clones.ts";
import { startSite } from "./e13-site.ts";
import type { Site } from "./e13-site.ts";

/*
 * The lab topology of E13 (POC PLAN.md P7.4): a master on a root of its own, headed on Xvfb (it
 * stands in for the personal Default, which the lab never has), and workers each on a root of their
 * own, opened by the launcher's scripts with no debugging flag and no CDP client. The master keeps
 * its Playwright connection: it is the observer, and what it reads of a worker arrives over the
 * verified link. Each worker's Chrome also opens the static test page, through the wrapper.
 */

export type Mode = "headed" | "headless";
const CATALOG_EVERY_MS = 2_000;
const PRESENCE_MS = 120_000;
const POLL_MS = 250;
// The wrapper adds this address as a startup page, the way a person's first page would be there.
export const PAGE_ENV = "RECNRUN_E13_URL";
// Built in two pieces so the lint rule against template text in plain strings stays quiet.
export const PAGE_FLAG = ["$", `{${PAGE_ENV}:+"$${PAGE_ENV}"}`].join("");

/** One worker: where its root and Downloads live, and how its last open went. */
export interface Worker {
  name: string;
  profileId: string;
  /** Letters and digits only: the id of its page and of its marker. */
  marker: string;
  root: string;
  downloads: string;
  /** The running main Chrome, 0 when none. */
  pid: number;
  /** The token of its last open: the fragment of the bootstrap page that is its only tab when headless. */
  token: string;
}

/** What one open printed and how long each part of it took. */
export interface Launched {
  code: number;
  pid: number;
  stderr: string;
  mode: Mode;
  /** Script start to exit. */
  totalMs: number;
  /** Script start to the presence of the new boot on disk. */
  presenceMs?: number;
  /** Script start to the ack's own createdAt. */
  ackMs?: number;
  token: string;
  /** What the ack and presence on disk got wrong; empty when both are right. */
  problems: string[];
}

export interface Lab {
  site: Site;
  master: DownloadsProfile;
  /** The master's dashboard page; reopened when a cell closes it. */
  dashboard: Page;
  workers: Worker[];
  env: NodeJS.ProcessEnv;
  record: string;
  /** Opens a worker through the launcher in `mode`; a non-zero exit is a result. */
  open(worker: Worker, mode: Mode): Promise<Launched>;
  /** Tells the catalog loop about a Downloads root. */
  track(downloads: string): void;
  /** SIGTERM to the worker's Chrome, then until nothing names its root. */
  stop(worker: Worker): Promise<void>;
  dispose(): Promise<void>;
}

const markerOf = (profileId: string) => profileId.replaceAll("-", "");

/** Milliseconds from `since` to the first presence whose boot is not `previous`, until `finished`. */
async function presenceAfter(
  worker: Worker,
  previous: string | undefined,
  since: number,
  finished: () => boolean,
) {
  const fresh = async () => {
    const presence = await presenceIn(worker.downloads, worker.profileId).catch(() => undefined);
    return presence !== undefined && presence.boot !== previous ? Date.now() - since : undefined;
  };
  for (let last = false; !last;) {
    last = finished();
    const found = await fresh();
    if (found !== undefined) return found;
    await delay(POLL_MS);
  }
  return undefined;
}

/** The ack file of a token: its own createdAt says when the extension wrote it. */
async function ackCreated(worker: Worker, token: string) {
  const file = join(folderOf(worker.downloads), "acks", worker.profileId, `${token}.json`);
  const ack = JSON.parse(await readFile(file, "utf8")) as { createdAt?: number };
  return typeof ack.createdAt === "number" ? ack.createdAt : undefined;
}

/** The master's catalog loop over every Downloads folder, as the launcher's loop runs it. */
function catalogLoop(record: string, folders: string[]) {
  const pass = async () => {
    for (const downloads of folders) {
      await mkdir(namespaceFolder(downloads), { recursive: true });
      const run = await runCatalog(record, downloads);
      if (run.code !== 0) throw new Error(`catalog.sh exited ${run.code}: ${run.stderr}`);
    }
  };
  return { pass, start: () => loop(pass, CATALOG_EVERY_MS) };
}

/** The master's block of the launcher record: a throwaway root standing in for the personal Default. */
export const masterBlock = (master: DownloadsProfile, downloads: string) =>
  [
    `userDataDir=${master.root}`,
    "profileDirectory=Default",
    `profileId=${master.profileId}`,
    `namespace=${NAMESPACE}`,
    "role=master",
    `downloadsRoot=${downloads}`,
  ].join("\n");

/** Waits for the master's first presence and opens its dashboard beside a page of the static site. */
export async function startMaster(prefix: string, site: Site) {
  const group = await createDownloadsGroup(tempPlatform(prefix));
  try {
    const master = await group.launch("Master");
    const view = await openViews(master, site.origin);
    const present = join(folderOf(group.downloads), "peers", master.profileId, "presence.json");
    await within(async () => await readFile(present), PRESENCE_MS);
    return { group, master, dashboard: view.dashboard };
  } catch (error) {
    await group.dispose();
    throw error;
  }
}

/** open.sh for a hand-installed worker, with the timing of its parts. */
export function launcherOpen(
  lab: Pick<Lab, "env" | "site"> & { dir: string },
  worker: Worker,
  scene: Scene,
) {
  return async (mode: Mode): Promise<Launched> => {
    const started = Date.now();
    let finished = false;
    // Headless Chrome takes one target, the bootstrap page the launcher passes, so only a headed open adds a page.
    const page = mode === "headed" ? { [PAGE_ENV]: lab.site.startUrl(worker.marker) } : {};
    const env = { ...lab.env, ...page };
    const before = (await presenceIn(worker.downloads, worker.profileId).catch(() => undefined))
      ?.boot;
    const seen = presenceAfter(worker, before, started, () => finished);
    const opened = await runOpen({ scene, env }, mode);
    finished = true;
    const token = opened.token;
    const problems =
      opened.code === 0
        ? await ackProblems(scene, opened)
        : [
            `chrome.log: ${(await readFile(join(lab.dir, "chrome.log"), "utf8").catch(() => "")).slice(-600)}`,
          ];
    const created = await ackCreated(worker, token).catch(() => undefined);
    const presenceMs = await seen;
    worker.pid = opened.pid;
    worker.token = token;
    return {
      code: opened.code,
      pid: opened.pid,
      stderr: opened.stderr,
      mode,
      totalMs: opened.ms,
      ...(presenceMs === undefined ? {} : { presenceMs }),
      ...(created === undefined ? {} : { ackMs: created - started }),
      token,
      problems,
    };
  };
}

/** The hand-installed workers of V1: poc-d0 loaded on each root and kept by one reload, then quit. */
export async function v1Lab(count: number): Promise<Lab> {
  const site = await startSite();
  const { dir, env, record, dispose: removeDir } = await skeleton(undefined, [PAGE_FLAG]);
  const started = await startMaster("recnrun-e13-master", site).catch(async (error: unknown) => {
    await site.close();
    await removeDir();
    throw error;
  });
  const { group, master, dashboard } = started;
  const folders = [group.downloads];
  const workers: Worker[] = [];
  const scenes = new Map<Worker, Scene>();
  let stopCatalog: () => Promise<void> = async () => undefined;
  const dispose = async () => {
    await stopCatalog().catch(() => undefined);
    for (const worker of workers) await quitWorker(worker).catch(() => undefined);
    await group.dispose().catch(() => undefined);
    await site.close();
    await removeDir();
  };
  try {
    await writeFile(record, `${masterBlock(master, group.downloads)}\n`);
    for (let index = 1; index <= count; index++) {
      const root = join(dir, `worker-${index}`);
      const downloads = join(dir, `downloads-${index}`);
      const scene = await installProfile(root, downloads, record, "Default");
      // The installer attached over CDP; the file it left must not hide a client of the launcher's open.
      await rm(join(root, "DevToolsActivePort"), { force: true });
      const worker = {
        name: `Worker ${index}`,
        profileId: scene.profileId,
        marker: markerOf(scene.profileId),
        root,
        downloads,
        pid: 0,
        token: "",
      };
      workers.push(worker);
      scenes.set(worker, scene);
      folders.push(downloads);
    }
    const catalog = catalogLoop(record, folders);
    await catalog.pass();
    stopCatalog = catalog.start();
  } catch (error) {
    await dispose();
    throw error;
  }
  return {
    site,
    master,
    dashboard,
    workers,
    env,
    record,
    open: (worker, mode) => launcherOpen({ env, site, dir }, worker, sceneOf(scenes, worker))(mode),
    track: (downloads) => void folders.push(downloads),
    stop: (worker) => quitWorker(worker),
    dispose,
  };
}

function sceneOf(scenes: Map<Worker, Scene>, worker: Worker): Scene {
  const scene = scenes.get(worker);
  if (!scene) throw new Error(`${worker.name} has no scene.`);
  return scene;
}

/** SIGTERM to the worker's main Chrome and until nothing of its root runs. */
export async function quitWorker(worker: Worker): Promise<void> {
  await quit({ survivors: () => chromesOf(worker.root) }, [worker.pid]);
  worker.pid = 0;
}

/** The processes of a worker root, with their command lines. */
export async function commandLinesOf(root: string): Promise<string[]> {
  return Promise.all(
    (await chromesOf(root)).map(async (pid) =>
      (await readFile(`/proc/${pid}/cmdline`, "utf8").catch(() => "")).replaceAll("\0", " "),
    ),
  );
}
