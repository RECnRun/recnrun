import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { bindingProblems, bindingsOf, labelled } from "../e8-chain.ts";
import type { Binding } from "../e8-chain.ts";
import { POC_EXTENSION_ID } from "../file-access.ts";
import { NAMESPACE, runProfiles } from "./e8-discovery.ts";
import { recordText } from "./e4-launcher.ts";
import type { RecordEntry } from "./e4-launcher.ts";
import type { E4Session, LaunchOptions } from "./e4-profiles.ts";
import { announced } from "./e4-run.ts";
import type { Labels, Peer } from "./e4-run.ts";

/*
 * E8's discovery scenes: profiles in the roots of a throwaway HOME, and profiles.sh run on them with
 * that HOME and Chrome prefix, so no real root is read. Chrome writes a profile's preferences
 * lazily, so a scan is repeated until it sees what the scene holds, and says how long that took.
 */

const SETTLE_MS = 40_000;
const SETTLE_POLL_MS = 500;

export interface Scene {
  session: E4Session;
  labels: Labels;
  home: string;
  /** The harness's name for each profile id, so observations carry no uuid. */
  names: Map<string, string>;
}

export async function sceneOf(session: E4Session, labels: Labels): Promise<Scene> {
  const home = await session.folder("home");
  labels.set(home, "<home>");
  return { session, labels, home, names: new Map() };
}

/** The OS default root of the scene's HOME on Linux, created, labelled `<default root>`. */
export async function defaultRoot(scene: Scene): Promise<string> {
  const root = join(scene.home, ".config", "google-chrome");
  await mkdir(root, { recursive: true });
  scene.labels.set(root, "<default root>");
  return root;
}

/** A root outside HOME that only the record can name. */
export async function recordedRoot(scene: Scene, label = "<recorded root>"): Promise<string> {
  const root = await scene.session.folder("root");
  scene.labels.set(root, label);
  return root;
}

/** A profile with the extension in `root`, downloading to a folder of its own, once it published. */
export async function start(
  scene: Scene,
  name: string,
  options: LaunchOptions & { root: string },
): Promise<Peer> {
  const downloads = await scene.session.folder(`downloads-${name}`);
  scene.labels.set(downloads, `<downloads of ${name}>`);
  const peer = await announced(scene.session, name, downloads, options);
  scene.names.set(peer.profileId, name);
  return peer;
}

export const writeRecord = (scene: Scene, entries: readonly RecordEntry[]) =>
  writeFile(scene.session.record, recordText(entries));

const ranOk = async (scene: Scene, command: string, args: readonly string[]) => {
  const result = await runProfiles(scene.home, command, args);
  if (result.code !== 0) throw new Error(`${command} exited ${result.code}: ${result.stderr}`);
  return result.stdout;
};

/** profiles_in_root: the directory names of a root, in the order printed. */
export async function profilesIn(scene: Scene, root: string): Promise<string[]> {
  return (await ranOk(scene, "profiles_in_root", [root])).split("\n").filter((line) => line !== "");
}

/** chrome_roots: the roots printed, labelled, in order. */
export async function rootsOf(scene: Scene): Promise<string[]> {
  const out = await ranOk(scene, "chrome_roots", [scene.session.record]);
  return labelled(out, scene.labels);
}

/** extension_in_profile: its exit code and what it printed (nothing when it exits 1). */
export async function extensionIn(scene: Scene, root: string, directory: string) {
  const { code, stdout } = await runProfiles(scene.home, "extension_in_profile", [
    root,
    directory,
    POC_EXTENSION_ID,
  ]);
  return { code, printed: stdout.trim() };
}

async function bindOnce(scene: Scene): Promise<{ stdout: string; seen: Binding[] }> {
  const args = [scene.session.record, NAMESPACE, POC_EXTENSION_ID];
  const stdout = await ranOk(scene, "bind_profiles", args);
  return { stdout, seen: bindingsOf(stdout, scene.labels, scene.names) };
}

/** What a profile of this scene should bind to: the root and folder it launched on, `distinct`. */
export function expectedBinding(scene: Scene, peer: Peer): Binding {
  const label = (path: string) => scene.labels.get(path) ?? "<another folder>";
  return {
    profile: peer.profile.name,
    root: label(peer.profile.root),
    profileDirectory: peer.profile.profileDirectory,
    downloadsRoot: label(peer.downloads),
    state: "distinct",
  };
}

export interface Settled {
  problems: string[];
  seen: Binding[];
  stdout: string;
  /** Milliseconds until bind_profiles listed what the scene holds (the whole wait when it never did). */
  visibleMs: number;
}

/** Repeats bind_profiles until it matches `expected` or the wait ends; the last answer is kept. */
export async function settled(scene: Scene, expected: readonly Binding[]): Promise<Settled> {
  const started = Date.now();
  for (;;) {
    const { stdout, seen } = await bindOnce(scene);
    const problems = bindingProblems(seen, expected);
    const visibleMs = Date.now() - started;
    if (problems.length === 0 || visibleMs > SETTLE_MS)
      return { problems, seen, stdout, visibleMs };
    await delay(SETTLE_POLL_MS);
  }
}

/** The display name Chrome keeps for a profile in `Local State`, or null while it has none. */
export async function displayNameOf(root: string, directory: string): Promise<string | null> {
  const text = await readFile(join(root, "Local State"), "utf8").catch(() => "{}");
  const state = JSON.parse(text) as {
    profile?: { info_cache?: Record<string, { name?: string }> };
  };
  return state.profile?.info_cache?.[directory]?.name ?? null;
}
