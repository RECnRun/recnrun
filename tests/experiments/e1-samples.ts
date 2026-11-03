import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { join } from "node:path";
import { connectWebSocket } from "../browser/fixtures/cdp-client.ts";
import type { CdpClient } from "../browser/fixtures/cdp-client.ts";
import { attachExtension, launchForUnpacked } from "../browser/fixtures/extension-loaders.ts";
import type { LoadedExtension, UnpackedOptions } from "../browser/fixtures/extension-loaders.ts";
import {
  accessAfter,
  fileAccessPref,
  POC_EXTENSION_ID,
  readFromExtension,
  withoutHostPermissions,
  writeProbe,
} from "./file-access.ts";
import type { FileRead } from "./file-access.ts";
import { extensionState, toggleSwitch } from "./extensions-page.ts";
import type { Switch, ToggleMethod } from "./extensions-page.ts";
import type { Sample } from "./outcome.ts";

/*
 * The unpacked samples of E1, shared by the lab spec and its host twin: each takes a fresh root
 * with the build installed by `Extensions.loadUnpacked`, and only the click method differs.
 */

/** A running install with a CDP client of the sample's own. */
export interface Installed {
  extensionId: string;
  client: CdpClient;
  /** Stops this Chrome; the root stays for the next launch or the pref read. */
  quit(): Promise<void>;
}

export interface Fresh {
  root: string;
  first: Installed;
  /** Launches the same root with the same flags and installs the same path again. */
  reinstall(): Promise<Installed>;
  /** Launches the same root with the same flags, installs nothing, and says whether the build runs. */
  relaunch(extensionId: string): Promise<boolean>;
  /** Removes the root; every Chrome on it has quit. */
  dispose(): Promise<void>;
}

export interface E1Cells {
  /** The build under test; the control installs a patched copy of it. */
  build: string;
  /** A fresh root with the build at `build` installed. */
  fresh(build: string): Promise<Fresh>;
  /** Tried in order until one flips the toggle; the lab starts with a real pointer. */
  methods: readonly ToggleMethod[];
}

export async function observe(
  loaded: LoadedExtension,
  quit: () => Promise<void> = () => loaded.close(),
): Promise<Installed> {
  const client = await connectWebSocket(loaded.chrome.wsEndpoint);
  const stop = async (): Promise<void> => {
    client.close();
    await quit();
  };
  return { extensionId: loaded.extensionId, client, quit: stop };
}

/** Launches with `options` and installs nothing: does the build at `extensionId` still run? */
export async function runsAfterRelaunch(options: UnpackedOptions, extensionId: string) {
  const chrome = await launchForUnpacked(options);
  try {
    await (await attachExtension(chrome, extensionId)).close();
    return true;
  } catch {
    await chrome.close();
    return false;
  }
}

async function withFresh(
  cells: E1Cells,
  run: (fresh: Fresh, probe: string) => Promise<Sample>,
  build = cells.build,
): Promise<Sample> {
  const fresh = await cells.fresh(build);
  try {
    return await run(fresh, await writeProbe(fresh.root));
  } finally {
    await fresh.first.quit().catch(() => undefined);
    await fresh.dispose();
  }
}

const describeRead = (read: FileRead) =>
  `fileSchemeAccess ${String(read.fileSchemeAccess)}, fetch ${read.fetch.ok ? "read the probe" : `failed (${read.fetch.name}: ${read.fetch.message})`}`;

interface Progress {
  probe: string;
  steps: string[];
  methods: string[];
}

const LABELS = { fileAccess: '"Allow access to file URLs"', developerMode: "Developer mode" };

/** One switch at chrome://extensions; a gesture only when it was not already at `target`. */
async function flip(
  installed: Installed,
  cells: E1Cells,
  progress: Progress,
  { name, target }: { name: Switch; target: boolean },
) {
  const { client, extensionId } = installed;
  const { method, missed } = await toggleSwitch(
    client,
    extensionId,
    { name, target },
    cells.methods,
  );
  if (!method) return;
  progress.methods.push(
    missed.length > 0 ? `${method} (after ${missed.join(", ")} missed)` : method,
  );
  progress.steps.push(`${method}: ${LABELS[name]} ${target ? "on" : "off"} at chrome://extensions`);
}

/**
 * Developer mode on (Load unpacked needs it, and a reload of an unpacked build without it disables
 * the build), then the file toggle, then the extension's own report once it has reloaded.
 */
async function setAccess(
  installed: Installed,
  cells: E1Cells,
  target: boolean,
  progress: Progress,
) {
  await flip(installed, cells, progress, { name: "developerMode", target: true });
  await flip(installed, cells, progress, { name: "fileAccess", target });
  return accessAfter(installed.client, installed.extensionId, progress.probe, target);
}

const newProgress = (probe: string): Progress => ({ probe, steps: [], methods: [] });

/** The install alone, no gesture: what does the extension report and can it read the probe? */
export const defaultSample = (cells: E1Cells): Promise<Sample> =>
  withFresh(cells, async ({ root, first }, probe) => {
    const { extensionId } = first;
    const read = await readFromExtension(first.client, extensionId, probe);
    await first.quit();
    const pref = await fileAccessPref(root, extensionId);
    const pinned = extensionId === POC_EXTENSION_ID;
    const observation = { extensionId, pinned, ...read, pref, gestures: 0 };
    const ok = read.fileSchemeAccess === false && !read.fetch.ok;
    if (ok) return { ok, observation, steps: [] };
    return { ok, error: `after the install, ${describeRead(read)}`, observation, steps: [] };
  });

/** Ensures the opposite state first (a gesture only when needed), then toggles to `target`. */
export const toggleSample = (cells: E1Cells, target: boolean): Promise<Sample> =>
  withFresh(cells, async ({ root, first }, probe) => {
    const { extensionId } = first;
    const progress = newProgress(probe);
    const initial = await readFromExtension(first.client, extensionId, probe);
    if (initial.fileSchemeAccess !== !target) await setAccess(first, cells, !target, progress);
    const after = await setAccess(first, cells, target, progress);
    await first.quit();
    const pref = await fileAccessPref(root, extensionId);
    const { steps, methods } = progress;
    const observation = {
      extensionId,
      initial,
      after,
      methods,
      pref,
      gestures: steps.length,
      steps,
    };
    const read = after.fetch.ok && after.fetch.matches;
    const ok = after.fileSchemeAccess === target && read === target;
    if (ok) return { ok, observation, steps };
    return {
      ok,
      error: `after the toggle ${target ? "on" : "off"}, ${describeRead(after)}`,
      observation,
      steps,
    };
  });

/** Revokes, quits, relaunches the root, and installs the same path: does the revoke survive? */
export const reinstallSample = (cells: E1Cells): Promise<Sample> =>
  withFresh(cells, async (fresh, probe) => {
    const { root, first } = fresh;
    const { extensionId } = first;
    const progress = newProgress(probe);
    const initial = await readFromExtension(first.client, extensionId, probe);
    const revoked =
      initial.fileSchemeAccess === false ? initial : await setAccess(first, cells, false, progress);
    await first.quit();
    const prefAfterQuit = await fileAccessPref(root, extensionId);
    const runsAfterRelaunch = await fresh.relaunch(extensionId);
    const prefAfterRelaunch = await fileAccessPref(root, extensionId);
    const again = await fresh.reinstall();
    let reinstalled: FileRead;
    try {
      reinstalled = await readFromExtension(again.client, again.extensionId, probe);
    } finally {
      await again.quit();
    }
    const prefAfterReinstall = await fileAccessPref(root, extensionId);
    const { steps, methods } = progress;
    const observation = {
      extensionId,
      reinstalledId: again.extensionId,
      initial,
      revoked,
      reinstalled,
      prefAfterQuit,
      runsAfterRelaunch,
      prefAfterRelaunch,
      prefAfterReinstall,
      methods,
      gestures: steps.length,
      steps,
    };
    const problems: string[] = [];
    if (revoked.fileSchemeAccess !== false)
      problems.push(`the revoke did not take: ${describeRead(revoked)}`);
    if (reinstalled.fileSchemeAccess !== initial.fileSchemeAccess)
      problems.push(`the revoke survived the reinstall: ${describeRead(reinstalled)}`);
    if (problems.length === 0) return { ok: true, observation, steps };
    return { ok: false, error: problems.join("; "), observation, steps };
  });

/**
 * The control: the same build with no `host_permissions`. Access is on from the install, so a
 * failed read is the missing `file:///*` alone, with no gesture.
 */
export async function noHostPermissionSample(cells: E1Cells): Promise<Sample> {
  const directory = await mkdtemp(join(tmpdir(), "recnrun-e1-build-"));
  try {
    const build = await withoutHostPermissions(cells.build, directory);
    return await withFresh(
      cells,
      async ({ first }, probe) => {
        const { extensionId } = first;
        const read = await readFromExtension(first.client, extensionId, probe);
        const removed = { host_permissions: "removed from the manifest" };
        const observation = { extensionId, removed, ...read, gestures: 0 };
        const ok = read.fileSchemeAccess === true && !read.fetch.ok;
        if (ok) return { ok, observation, steps: [] };
        return {
          ok,
          error: `without host_permissions, ${describeRead(read)}`,
          observation,
          steps: [],
        };
      },
      build,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/**
 * With Developer mode off, as `Extensions.loadUnpacked` leaves a fresh root, the file toggle
 * reloads the unpacked build and Chrome disables it as an unsupported developer extension.
 */
export const noDeveloperModeSample = (cells: E1Cells): Promise<Sample> =>
  withFresh(cells, async ({ first }, probe) => {
    const { client, extensionId } = first;
    const progress = newProgress(probe);
    const before = await extensionState(client, extensionId);
    await flip(first, cells, progress, { name: "fileAccess", target: false });
    let after = await extensionState(client, extensionId);
    for (let tries = 20; tries > 0 && (after as { state?: string }).state === "ENABLED"; tries--) {
      await delay(250);
      after = await extensionState(client, extensionId);
    }
    const { steps, methods } = progress;
    const observation = { extensionId, before, after, methods, gestures: steps.length, steps };
    const { state, disableReasons } = after as { state?: string; disableReasons?: string[] };
    const ok =
      state === "DISABLED" && Boolean(disableReasons?.includes("unsupportedDeveloperExtension"));
    if (ok) return { ok, observation, steps };
    return { ok, error: `after the toggle: ${JSON.stringify(after)}`, observation, steps };
  });
