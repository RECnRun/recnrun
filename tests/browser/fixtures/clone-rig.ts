import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Browser, Page, TestInfo } from "@playwright/test";
import { runScript, NAMESPACE } from "../../experiments/fixtures/clones.ts";
import type { CloneHost } from "../../experiments/fixtures/clones.ts";
import { namespaceFolder, runCatalog } from "../../experiments/fixtures/e4-launcher.ts";
import { attachTo, endChrome, isChildProcess } from "./clone-attach.ts";
import type { Processes } from "./clone-attach.ts";
import { loop } from "./catalog-loop.ts";
import { readOrAbsent } from "./absence.ts";
import {
  POC_EXTENSION_ID,
  createDownloadsGroup,
  nameProfile,
  openViews,
  tempPlatform,
} from "./downloads-profiles.ts";
import type { DownloadsProfile } from "./downloads-profiles.ts";
import { chromesOf, installProfile, skeleton } from "./launcher-rig.ts";
import { within } from "./trust.ts";

/*
 * The lab scene of the clone matrix (POC PLAN.md P5.5): a real base (poc-d0 loaded unpacked, Developer
 * mode kept, the Downloads root pinned inside the root), made a template by base.sh, quit, and frozen;
 * a master on a root of its own; and the launcher's Chrome wrapper, which also opens a debugging port
 * on every Chrome the scripts start so the lab can read what it cannot read from files.
 */

const DEBUGGING = ["--remote-debugging-port=0", "--silent-debugger-extension-api"];
const BASE = "base-v1";
const CATALOG_EVERY_MS = 2_000;
const ENDPOINT_MS = 30_000;

const processes: Processes = {
  alive: chromesOf,
  pidOf: async (root) => {
    for (const pid of await chromesOf(root)) {
      const line = await readFile(`/proc/${pid}/cmdline`, "utf8").catch(() => "");
      if (!isChildProcess(line)) return pid;
    }
    return undefined;
  },
};

async function expectScript(file: string, args: string[], env: NodeJS.ProcessEnv) {
  const run = await runScript(file, args, env);
  if (run.code !== 0) throw new Error(`${file} ${args[0]} exited ${run.code}: ${run.stderr}`);
  return run;
}

/** The lab's base: installed by CDP, then templated, quit, and frozen by the launcher's own scripts. */
async function frozenBase(dir: string, env: NodeJS.ProcessEnv) {
  const bases = join(dir, "bases");
  await mkdir(bases);
  const root = join(bases, BASE);
  await installProfile(root, join(root, "downloads"), join(dir, "base.record"), "Default");
  await expectScript("base.sh", ["template", bases, BASE, NAMESPACE], env);
  await expectScript("base.sh", ["quit", bases, BASE], env);
  // A debugging port file is a lab artifact; the owner's base never has one.
  await rm(join(root, "DevToolsActivePort"), { force: true });
  await expectScript("base.sh", ["freeze", bases, BASE, NAMESPACE, POC_EXTENSION_ID], env);
  return bases;
}

export interface LabClones extends CloneHost {
  /** Saves evidence of a failed run. */
  keep(): Promise<void>;
  /** A clone root whose Chrome no CDP client reached: `dispose` still ends it. */
  watch(root: string): void;
  /** SIGTERM to the Chrome of a watched root, then until nothing names it. */
  quit(root: string): Promise<void>;
  dispose(): Promise<void>;
}

const masterBlock = (root: string, profileId: string, downloads: string) =>
  [
    `userDataDir=${root}`,
    "profileDirectory=Default",
    `profileId=${profileId}`,
    `namespace=${NAMESPACE}`,
    "role=master",
    `downloadsRoot=${downloads}`,
  ].join("\n");

/** The base, the master, and the catalog loop the launcher would run over the record. */
export async function labClones(
  testInfo: TestInfo,
  baseURL: string,
  flags: readonly string[] = DEBUGGING,
): Promise<LabClones> {
  const { dir, env, dispose: removeDir } = await skeleton(undefined, flags);
  const browsers = new Map<DownloadsProfile, Browser>();
  const group = await createDownloadsGroup(tempPlatform("recnrun-clones-master"));
  const folders: string[] = [group.downloads];
  const record = join(dir, "launcher.record");
  let stopCatalog: () => Promise<void> = async () => undefined;
  const roots: string[] = [];
  const dispose = async () => {
    await stopCatalog().catch(() => undefined);
    for (const [, browser] of browsers) await browser.close().catch(() => undefined);
    for (const root of roots) await endChrome(root, processes).catch(() => undefined);
    await group.dispose().catch(() => undefined);
    await removeDir();
  };
  try {
    const bases = await frozenBase(dir, env);
    const profile = await group.launch("Master");
    const view = await openViews(profile, baseURL);
    await nameProfile(view);
    const present = join(
      namespaceFolder(group.downloads),
      "peers",
      profile.profileId,
      "presence.json",
    );
    await within(() => readOrAbsent(() => readFile(present)), ENDPOINT_MS);
    await writeFile(record, `${masterBlock(profile.root, profile.profileId, group.downloads)}\n`);
    const pass = async () => {
      for (const downloads of folders) {
        await mkdir(namespaceFolder(downloads), { recursive: true });
        const run = await runCatalog(record, downloads);
        if (run.code !== 0) throw new Error(`catalog.sh exited ${run.code}: ${run.stderr}`);
      }
    };
    await pass();
    stopCatalog = loop(pass, CATALOG_EVERY_MS);
    let rounds = 0;
    return {
      env,
      bases,
      base: BASE,
      record,
      baseURL,
      master: { profileId: profile.profileId, downloads: group.downloads, profile, view },
      clonesDir: async () => {
        // A round starts from the master's block alone, as a launcher with no clones yet.
        folders.length = 1;
        await writeFile(
          record,
          `${masterBlock(profile.root, profile.profileId, group.downloads)}\n`,
        );
        const path = join(dir, `clones-${++rounds}`);
        await mkdir(path);
        return path;
      },
      commandLines: async (root) =>
        Promise.all(
          (await chromesOf(root)).map(async (pid) =>
            (await readFile(`/proc/${pid}/cmdline`, "utf8").catch(() => "")).replaceAll("\0", " "),
          ),
        ),
      attach: async (root, name, instanceId) => {
        if (!roots.includes(root)) roots.push(root);
        return attachTo(root, { name, instanceId }, processes, browsers);
      },
      stop: async (clone) => {
        await browsers
          .get(clone)
          ?.close()
          .catch(() => undefined);
        browsers.delete(clone);
        await endChrome(clone.root, processes);
      },
      track: (downloads) => void folders.push(downloads),
      shoot: async (page: Page, name: string) => {
        await testInfo.attach(name, {
          body: await page.screenshot({ fullPage: true }),
          contentType: "image/png",
        });
      },
      keep: async () => undefined,
      watch: (root) => void (roots.includes(root) || roots.push(root)),
      quit: (root) => endChrome(root, processes),
      dispose,
    };
  } catch (error) {
    await dispose();
    throw error;
  }
}
