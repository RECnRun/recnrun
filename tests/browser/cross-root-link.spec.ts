import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { bindHierarchy } from "../e2e/fixtures/hierarchy.ts";
import { listOf } from "../e2e/fixtures/mesh.ts";
import type { Profile } from "../e2e/fixtures/profiles.ts";
import { namespaceFolder, recordText, runCatalog } from "../experiments/fixtures/e4-launcher.ts";
import { labEnvironment } from "../experiments/fixtures/e4-lab.ts";
import { expectEveryHypothesis, recordHypothesis } from "../experiments/outcome.ts";
import type { Cell, Sample } from "../experiments/outcome.ts";
import { sized } from "../experiments/samples.ts";
import { expect, test } from "./fixtures/chrome.ts";
import { loop } from "./fixtures/catalog-loop.ts";
import {
  createDownloadsGroup,
  linkedPeers,
  nameProfile,
  openViews,
  tempPlatform,
  waitForMesh,
} from "./fixtures/downloads-profiles.ts";
import type { DownloadsGroup, DownloadsProfile } from "./fixtures/downloads-profiles.ts";
import { isActive, openTab, sendOverLink } from "./fixtures/master-restart.ts";
import { backgroundLog, within } from "./fixtures/trust.ts";

/*
 * POC PLAN.md P5.5 run A on Google Chrome Stable: a master and a worker on two roots, each
 * downloading into a Downloads folder of its own (a clone's <root>/downloads), link through the
 * catalog once one launcher record names both folders, since registry.json maps each root id to
 * its path. The master's command runs in the worker; the worker's command on the master is
 * refused. The control: one record per folder, so neither catalog lists the other root, and no
 * link forms within the settle time plus a presence TTL.
 */

const EXPERIMENT = "P5.5";
const CELLS = [
  "P5.5.crossRoot.link",
  "P5.5.crossRoot.commands",
  "P5.5.crossRoot.unlisted",
] as const;
const LINK_MS = 60_000;
const LOGGED_MS = 15_000;
// PRESENCE_TTL_MS of apps/extension/src/p2p/folder-rendezvous.ts.
const PRESENCE_TTL_MS = 60_000;
// A few catalog runs (2 s) and Downloads polls (1 s) beyond the TTL.
const SETTLE_MS = 5_000;
const CATALOG_EVERY_MS = 2_000;

interface Side {
  group: DownloadsGroup;
  profile: DownloadsProfile;
  view: Profile;
  log: string[];
}

interface Scene {
  master: Side;
  worker: Side;
  dispose(): Promise<void>;
}

/** One profile on a fresh root whose Downloads folder no other root shares. */
async function sideOf(prefix: string, name: string, baseURL: string): Promise<Side> {
  const group = await createDownloadsGroup(tempPlatform(prefix));
  try {
    const profile = await group.launch(name);
    const view = await openViews(profile, baseURL);
    await nameProfile(view);
    return { group, profile, view, log: backgroundLog(profile.context) };
  } catch (error) {
    await group.dispose();
    throw error;
  }
}

/** One catalog.sh pass per Downloads folder from `record`, as the launcher's loop runs it. */
async function catalogPass(record: string, folders: string[]) {
  for (const downloads of folders) {
    await mkdir(namespaceFolder(downloads), { recursive: true });
    const run = await runCatalog(record, downloads);
    if (run.code !== 0) throw new Error(`catalog.sh exited ${run.code}: ${run.stderr}`);
  }
}

/**
 * The two sides, cataloged by one record naming both folders (`shared`), or by one record per
 * folder, each naming its own only.
 */
async function sceneOf(baseURL: string, shared: boolean): Promise<Scene> {
  const master = await sideOf("recnrun-cross-master", "Master", baseURL);
  const worker = await sideOf("recnrun-cross-worker", "Worker", baseURL).catch(async (error) => {
    await master.group.dispose();
    throw error;
  });
  const folders = [master.group.downloads, worker.group.downloads];
  const both = join(dirname(master.group.record), "both.record");
  await writeFile(both, recordText(folders.map((downloadsRoot) => ({ downloadsRoot }))));
  const passes = shared
    ? [() => catalogPass(both, folders)]
    : [master, worker].map((side) => () => catalogPass(side.group.record, [side.group.downloads]));
  for (const pass of passes) await pass();
  const stops = passes.map((pass) => loop(pass, CATALOG_EVERY_MS));
  return {
    master,
    worker,
    dispose: async () => {
      const failures: unknown[] = [];
      for (const stop of stops) await stop().catch((error: unknown) => failures.push(error));
      for (const side of [worker, master]) await side.group.dispose();
      // A failed catalog run is a harness error: the sample measured nothing (outcome.ts).
      if (failures.length > 0) throw failures[0];
    },
  };
}

/** The first line `side` logs from line `from` on that contains `text`, waiting for it. */
const logged = (side: Side, text: string, from = 0) =>
  within(async () => side.log.slice(from).find((line) => line.includes(text)), LOGGED_MS);

/** The master's Show tab runs in the worker; the worker's command on the master is refused. */
async function commands({ master, worker }: Scene, baseURL: string): Promise<Sample> {
  await bindHierarchy(master.view, [worker.view]);
  const from = master.log.length;
  const url = new URL("/privacy/?behind-worker", baseURL).href;
  const shown = await openTab(worker.profile, url);
  const item = listOf(master.view, worker.view).getByRole("listitem").filter({ hasText: url });
  await item.getByRole("button", { name: "Show tab" }).click();
  const ran = await within(
    async () => ((await isActive(worker.profile, shown)) ? true : undefined),
    LOGGED_MS,
  );
  const result = await logged(master, "received COMMAND_RESULT", from);
  const target = await openTab(master.profile, new URL("/privacy/?behind-master", baseURL).href);
  await sendOverLink(worker.profile, master.profile, { type: "ACTIVATE_TAB", tabId: target });
  const refusal = `REFUSED ACTIVATE_TAB from ${worker.profile.profileId}: not the bound master`;
  const refused = await logged(master, refusal, from);
  const checks = {
    workerShowedTab: ran === true,
    masterGotCommandResult: result !== undefined,
    masterRefusedWorker: refused !== undefined,
    masterTabStayedBehind: !(await isActive(master.profile, target)),
  };
  const failed = Object.entries(checks).flatMap(([name, ok]) => (ok ? [] : [name]));
  const observation = { checks, result, refused };
  return failed.length === 0
    ? { ok: true, observation }
    : { ok: false, error: failed.join(", "), observation };
}

/** One linked sample: the link, then the commands over it, each a sample of its own cell. */
async function linkSample(baseURL: string): Promise<{ link: Sample; commands: Sample }> {
  const scene = await sceneOf(baseURL, true);
  try {
    const started = Date.now();
    const formed = await waitForMesh([scene.master.profile, scene.worker.profile], LINK_MS).then(
      (ms) => ({ ms }),
      (error: unknown) => ({ error: (error as Error).message }),
    );
    if ("error" in formed) {
      const link = { ok: false, error: formed.error, observation: { watchedMs: LINK_MS } };
      return { link, commands: { ok: false, error: "no link", observation: {} } };
    }
    const link = {
      ok: true,
      observation: { linkedMs: formed.ms, sinceSetupMs: Date.now() - started },
    };
    return { link, commands: await commands(scene, baseURL) };
  } finally {
    await scene.dispose();
  }
}

/** The control: neither catalog lists the other root, so no link forms within SETTLE + TTL. */
async function unlistedSample(baseURL: string): Promise<Sample> {
  const scene = await sceneOf(baseURL, false);
  try {
    const watchedMs = SETTLE_MS + PRESENCE_TTL_MS;
    const sides = [scene.master.profile, scene.worker.profile];
    const linked = await within(async () => {
      const links = await Promise.all(sides.map(linkedPeers));
      return links.some((each) => each.length > 0) ? links : undefined;
    }, watchedMs);
    return linked === undefined
      ? { ok: true, observation: { watchedMs } }
      : { ok: false, error: "a link formed", observation: { watchedMs, linked } };
  } finally {
    await scene.dispose();
  }
}

test("peers in two Downloads roots link through the catalog's root paths, and not without them", async ({
  baseURL,
}) => {
  if (!baseURL) throw new Error("Set use.baseURL to the website preview.");
  test.setTimeout(900_000);
  const chrome = await labEnvironment.target.chrome();
  const cell = (hypothesis: string, topology: string): Cell => ({
    experiment: EXPERIMENT,
    hypothesis,
    chrome,
    environment: "lab",
    install: "loadUnpacked",
    label: "diagnostic",
    externalClient: true,
    variant: "poc-d0",
    topology,
    debugger: "none",
  });
  const [link, commanded, unlisted] = CELLS;
  const shared = "two roots, a Downloads folder each, one record naming both";
  const linked: { link: Sample; commands: Sample }[] = [];
  await recordHypothesis(cell(link, shared), async () => {
    const sample = await linkSample(baseURL);
    linked.push(sample);
    return sample.link;
  });
  expect(linked).toHaveLength(sized(3));
  await recordHypothesis(cell(commanded, `${shared}, the first bound as master`), async () => {
    const next = linked.shift();
    if (!next) throw new Error("No linked sample is left for the commands cell.");
    return next.commands;
  });
  const apart = "two roots, a Downloads folder each, one record per folder";
  await recordHypothesis(cell(unlisted, apart), () => unlistedSample(baseURL));
  await expectEveryHypothesis(EXPERIMENT, CELLS);
});
