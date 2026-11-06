import { cp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  launchForUnpacked,
  attachExtension,
  extensionPath,
} from "../browser/fixtures/extension-loaders.ts";
import type { LoadedExtension } from "../browser/fixtures/extension-loaders.ts";
import { POC_EXTENSION_ID } from "./file-access.ts";
import { judged } from "./fixtures/downloads-verdicts.ts";
import type { Sample, VerdictTarget } from "./fixtures/downloads-verdicts.ts";
import { presenceIn } from "./fixtures/e4-launcher.ts";
import type { E4Environment } from "./fixtures/e4-profiles.ts";
import { withSession } from "./fixtures/e4-run.ts";
import type { Peer } from "./fixtures/e4-run.ts";
import {
  defaultRoot,
  displayNameOf,
  expectedBinding,
  extensionIn,
  profilesIn,
  recordedRoot,
  rootsOf,
  sceneOf,
  settled,
  start,
  writeRecord,
} from "./fixtures/e8-scene.ts";
import type { Scene } from "./fixtures/e8-scene.ts";
import { recordCell } from "./e8-samples.ts";

/*
 * The samples of E8's eight discovery hypotheses (POC PLAN.md P4.2): real profiles started in a
 * throwaway HOME, left open or quit, and profiles.sh run on that HOME. Lab only: the host twin
 * measures the Downloads-root cells.
 */

/** Each cell and its topology: the profiles and roots it starts, never a path. */
export const E8_DISCOVERY_CELLS = {
  "E8.discovery.chromeClosed": "two profiles of one root, both quit before the scan",
  "E8.discovery.defaultOpen": "Default open, a secondary profile of its root quit",
  "E8.discovery.secondaryOpen": "a secondary profile open, Default quit",
  "E8.discovery.severalRoots": "the OS default root and a root only the record names",
  "E8.discovery.fixedId": "the pinned id in two roots, a profile without the extension",
  "E8.discovery.unpackedPaths": "the build loaded from two different folders in two roots",
  "E8.discovery.extensionUpdated": "the build reloaded from a copy with a bumped version",
  "E8.discovery.extensionRemoved": "the extension uninstalled from one of two profiles",
} as const;
export type E8DiscoveryHypothesis = keyof typeof E8_DISCOVERY_CELLS;

export const recordDiscovery = (
  hypothesis: E8DiscoveryHypothesis,
  target: VerdictTarget,
  take: () => Promise<Sample>,
) => recordCell(hypothesis, E8_DISCOVERY_CELLS[hypothesis], target, take);

const SECONDARY = "Profile 2";

const same = (what: string, got: unknown, want: unknown): string[] =>
  JSON.stringify(got) === JSON.stringify(want)
    ? []
    : [`${what} was ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`];

const inScene = (
  environment: E4Environment,
  run: (scene: Scene) => Promise<Sample>,
): Promise<Sample> =>
  withSession(environment, async (session, labels) => run(await sceneOf(session, labels)));

/** Scans for `peers` in order, plus what the cell checks itself. */
async function scanned(scene: Scene, peers: readonly Peer[], extra: Record<string, unknown> = {}) {
  const result = await settled(
    scene,
    peers.map((peer) => expectedBinding(scene, peer)),
  );
  const { problems, seen, visibleMs } = result;
  return { problems, observation: { bindings: seen, visibleMs, ...extra } };
}

/** E8.discovery.chromeClosed: both profiles of the OS default root quit; their presences stay. */
export const chromeClosedSample = (environment: E4Environment) =>
  inScene(environment, async (scene) => {
    const root = await defaultRoot(scene);
    const first = await start(scene, "A", { root });
    await scene.session.quit(first.profile);
    const second = await start(scene, "B", { root, profileDirectory: SECONDARY });
    await scene.session.quit(second.profile);
    await writeRecord(scene, []);
    const directories = await profilesIn(scene, root);
    const { problems, observation } = await scanned(scene, [first, second], { directories });
    return judged(
      [...problems, ...same("profiles", directories, ["Default", SECONDARY])],
      observation,
    );
  });

/** E8.discovery.defaultOpen: Default open beside a secondary profile that quit and left its presence. */
export const defaultOpenSample = (environment: E4Environment) =>
  inScene(environment, async (scene) => {
    const root = await defaultRoot(scene);
    const secondary = await start(scene, "B", { root, profileDirectory: SECONDARY });
    await scene.session.quit(secondary.profile);
    const first = await start(scene, "A", { root });
    await writeRecord(scene, []);
    const { problems, observation } = await scanned(scene, [first, secondary]);
    return judged(problems, observation);
  });

/** The display name Chrome gave the profile, then an owner's rename; neither may reach a binding. */
async function renamed(root: string, directory: string, name: string) {
  const path = join(root, "Local State");
  const state = JSON.parse(await readFile(path, "utf8").catch(() => "{}")) as {
    profile?: { info_cache?: Record<string, { name?: string }> };
  };
  const entry = state.profile?.info_cache?.[directory];
  if (!entry) return false;
  entry.name = name;
  await writeFile(path, JSON.stringify(state));
  return true;
}

/** E8.discovery.secondaryOpen: only the secondary profile is open; the binding names its directory. */
export const secondaryOpenSample = (environment: E4Environment) =>
  inScene(environment, async (scene) => {
    const root = await defaultRoot(scene);
    const first = await start(scene, "A", { root });
    await scene.session.quit(first.profile);
    const second = await start(scene, "B", { root, profileDirectory: SECONDARY });
    await writeRecord(scene, []);
    const open = await scanned(scene, [first, second]);
    await scene.session.quit(second.profile);
    const chromeName = await displayNameOf(root, SECONDARY);
    const rename = "Work display name";
    const didRename = await renamed(root, SECONDARY, rename);
    const after = await scanned(scene, [first, second]);
    const used = after.observation.bindings.some((binding) =>
      [chromeName, rename].includes(binding.profileDirectory),
    );
    const problems = [
      ...open.problems,
      ...after.problems,
      ...(used ? ["a binding carries a display name instead of the directory name"] : []),
    ];
    const names = { directory: SECONDARY, chromeName, renamedTo: didRename ? rename : null };
    return judged(problems, { open: open.observation, afterRename: after.observation, names });
  });

/** E8.discovery.severalRoots: the OS default root and one only the record names, a profile in each. */
export const severalRootsSample = (environment: E4Environment) =>
  inScene(environment, async (scene) => {
    const first = await defaultRoot(scene);
    const second = await recordedRoot(scene);
    const a = await start(scene, "A", { root: first });
    const b = await start(scene, "B", { root: second });
    await scene.session.quit(b.profile);
    await writeRecord(scene, [{ userDataDir: second, profileId: b.profileId }]);
    const roots = await rootsOf(scene);
    const { problems, observation } = await scanned(scene, [a, b], { roots });
    return judged(
      [...problems, ...same("roots", roots, ["<default root>", "<recorded root>"])],
      observation,
    );
  });

/** A plain Chrome profile of `root`, no extension, started and quit so Chrome writes its files. */
async function profileWithout(root: string, directory: string) {
  const chrome = await launchForUnpacked({
    userDataDir: root,
    args: [`--profile-directory=${directory}`],
  });
  await chrome.close();
}

/** E8.discovery.fixedId: the pinned id reads as unpacked in two roots and not in a profile without it. */
export const fixedIdSample = (environment: E4Environment) =>
  inScene(environment, async (scene) => {
    const first = await defaultRoot(scene);
    const second = await recordedRoot(scene);
    await profileWithout(first, "Profile 3");
    const a = await start(scene, "A", { root: first });
    const b = await start(scene, "B", { root: second });
    await scene.session.quit(a.profile);
    await scene.session.quit(b.profile);
    await writeRecord(scene, [{ userDataDir: second, profileId: b.profileId }]);
    const has = await extensionIn(scene, first, "Default");
    const hasToo = await extensionIn(scene, second, "Default");
    const lacks = await extensionIn(scene, first, "Profile 3");
    const ids = [a.profile.installed.extensionId, b.profile.installed.extensionId];
    const { problems, observation } = await scanned(scene, [a, b]);
    return judged(
      [
        ...problems,
        ...same("the profile with the extension", has, { code: 0, printed: "unpacked" }),
        ...same("the profile in the other root", hasToo, { code: 0, printed: "unpacked" }),
        ...same("the profile without it", lacks, { code: 1, printed: "" }),
        ...same("ids", ids, [POC_EXTENSION_ID, POC_EXTENSION_ID]),
      ],
      { ...observation, has, hasToo, lacks, sameId: ids[0] === ids[1] },
    );
  });

/** A copy of the build in a folder of the session, so Chrome sees a path of its own. */
async function buildCopy(scene: Scene, name: string, version?: string) {
  const folder = await scene.session.folder(`build-${name}`);
  await cp(extensionPath("poc-d0"), folder, { recursive: true });
  if (version) {
    const path = join(folder, "manifest.json");
    const manifest = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    await writeFile(path, JSON.stringify({ ...manifest, version }));
  }
  return folder;
}

/** E8.discovery.unpackedPaths: one build loaded from two folders keeps one id and binds in both. */
export const unpackedPathsSample = (environment: E4Environment) =>
  inScene(environment, async (scene) => {
    const first = await defaultRoot(scene);
    const second = await recordedRoot(scene);
    const buildA = await buildCopy(scene, "a");
    const buildB = await buildCopy(scene, "b");
    const a = await start(scene, "A", { root: first, build: buildA });
    const b = await start(scene, "B", { root: second, build: buildB });
    await scene.session.quit(a.profile);
    await scene.session.quit(b.profile);
    await writeRecord(scene, [{ userDataDir: second, profileId: b.profileId }]);
    const ids = [a.profile.installed.extensionId, b.profile.installed.extensionId];
    const { problems, observation } = await scanned(scene, [a, b]);
    const distinctPaths = new Set([buildA, buildB, extensionPath("poc-d0")]).size;
    return judged(
      [
        ...problems,
        ...same("ids", ids, [POC_EXTENSION_ID, POC_EXTENSION_ID]),
        ...same("paths", distinctPaths, 3),
      ],
      { ...observation, sameId: ids[0] === ids[1], distinctPaths },
    );
  });

const versionOf = (extension: LoadedExtension) =>
  extension.evaluateInBackground("chrome.runtime.getManifest().version");

/** Loads `path` again in the running profile and waits until its worker reports `version`. */
async function reloaded(peer: Peer, path: string, version: string): Promise<LoadedExtension> {
  const { chrome } = peer.profile.installed;
  const { id } = await chrome.cdp.send("Extensions.loadUnpacked", { path });
  if (id !== POC_EXTENSION_ID) throw new Error(`the reload gave ${id}, not ${POC_EXTENSION_ID}`);
  const deadline = Date.now() + 20_000;
  for (;;) {
    const extension = await attachExtension(chrome, id).catch(() => undefined);
    if (extension && (await versionOf(extension).catch(() => "")) === version) return extension;
    if (Date.now() > deadline) throw new Error(`the worker never reported ${version}`);
    await delay(500);
  }
}

/** E8.discovery.extensionUpdated: the same key from a copy with a bumped version keeps the id and the binding. */
export const extensionUpdatedSample = (environment: E4Environment) =>
  inScene(environment, async (scene) => {
    const root = await defaultRoot(scene);
    const older = await buildCopy(scene, "old", "0.1.0");
    const newer = await buildCopy(scene, "new", "0.1.1");
    const a = await start(scene, "A", { root, build: older });
    const before = await versionOf(a.profile.installed);
    a.profile.installed = await reloaded(a, newer, "0.1.1");
    await scene.session.quit(a.profile);
    await writeRecord(scene, []);
    const state = await extensionIn(scene, root, "Default");
    const { problems, observation } = await scanned(scene, [a]);
    return judged(
      [...problems, ...same("the extension", state, { code: 0, printed: "unpacked" })],
      { ...observation, before, after: "0.1.1", state },
    );
  });

/** E8.discovery.extensionRemoved: a profile whose extension is gone is not bound, whatever it left behind. */
export const extensionRemovedSample = (environment: E4Environment) =>
  inScene(environment, async (scene) => {
    const first = await defaultRoot(scene);
    const second = await recordedRoot(scene);
    const a = await start(scene, "A", { root: first });
    const b = await start(scene, "B", { root: second });
    await writeRecord(scene, [{ userDataDir: second, profileId: b.profileId }]);
    // The extension's own call, since it is the only uninstall that needs no gesture or new CDP method.
    const uninstall = await a.profile.installed
      .evaluateInBackground("chrome.management.uninstallSelf({ showConfirmDialog: false })")
      .then(
        () => "called",
        (error: unknown) => String(error),
      );
    await scene.session.quit(a.profile);
    await scene.session.quit(b.profile);
    const gone = await extensionIn(scene, first, "Default");
    const left = await presenceIn(a.downloads, a.profileId);
    const { problems, observation } = await scanned(scene, [b]);
    return judged(
      [
        ...problems,
        ...same("extension_in_profile of the profile without it", gone, { code: 1, printed: "" }),
        ...(left ? [] : ["the removed profile's presence was gone, so the cell shows no leftover"]),
      ],
      { ...observation, uninstall, gone, presenceLeft: left !== undefined },
    );
  });
