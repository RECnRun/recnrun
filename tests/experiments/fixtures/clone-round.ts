import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { backgroundLog, pinOf, within } from "../../browser/fixtures/trust.ts";
import { linkedPeers, openViews, storedIn } from "../../browser/fixtures/downloads-profiles.ts";
import type { DownloadsProfile } from "../../browser/fixtures/downloads-profiles.ts";
import type { Profile } from "../../e2e/fixtures/profiles.ts";
import { createClone, folderOf, openClone, readJson } from "./clones.ts";
import type { CloneHost, Created } from "./clones.ts";

/*
 * One round of the matrix: A and B made from the base and opened by the launcher's scripts, attached
 * for reading, linked with the master and each other, with the sizes and times the scripts and the
 * links showed.
 */

const LINK_MS = 90_000;

/** A clone of a round: what the scripts printed and what the attached Chrome shows. */
export interface RoundClone {
  name: string;
  id: string;
  root: string;
  downloads: string;
  token: string;
  profile: DownloadsProfile;
  view: Profile;
  log: string[];
  created: Created;
  /** open-clone start to its ack. */
  readyMs: number;
  /** The ack to the first verified link with the master. */
  linkMs: number;
}

export interface Round {
  host: CloneHost;
  clonesDir: string;
  clones: RoundClone[];
}

/** The display name the clone bootstrap gives a profile (clone-provisioning.ts). */
const displayNameOf = (profileId: string) => `Profile ${profileId.slice(0, 4).toUpperCase()}`;

/** Where the ack of `token` sits under a clone's Downloads root. */
export const ackFile = (downloads: string, id: string, token: string) =>
  join(folderOf(downloads), "acks", id, `${token}.json`);

const linkedWith = async (profile: DownloadsProfile, peer: string) =>
  (await linkedPeers(profile)).includes(peer) ? true : undefined;

/** The ack to the first moment the clone holds a verified link with the master. */
async function linkTime(host: CloneHost, clone: DownloadsProfile, ackAt: number) {
  const linked = await within(() => linkedWith(clone, host.master.profileId), LINK_MS);
  if (!linked) throw new Error(`${clone.name} did not link with the master within ${LINK_MS} ms`);
  return Date.now() - ackAt;
}

/** Created, opened, attached, and linked with the master. */
export async function bringUp(
  host: CloneHost,
  clonesDir: string,
  name: string,
): Promise<RoundClone> {
  const created = await createClone(host, clonesDir, name);
  const opened = await openClone(host, clonesDir, name);
  const { root: downloads = "", token = "" } = opened.fields;
  if (opened.code !== 0)
    throw new Error(`open-clone ${name} exited ${opened.code}: ${opened.stderr}`);
  host.track(downloads);
  const id = created.instanceId;
  const ack = await readJson(ackFile(downloads, id, token));
  const profile = await host.attach(created.root, displayNameOf(id), id);
  const linkMs = await linkTime(host, profile, Number(ack.createdAt));
  const view = await openViews(profile, host.baseURL);
  const log = backgroundLog(profile.context);
  return {
    name,
    id,
    root: created.root,
    downloads,
    token,
    profile,
    view,
    log,
    created,
    readyMs: opened.ms,
    linkMs,
  };
}

const store = (profile: DownloadsProfile, items: Record<string, unknown>) =>
  profile.serviceWorker.evaluate(
    (values) =>
      (
        globalThis as unknown as {
          chrome: { storage: { local: { set(v: unknown): Promise<void> } } };
        }
      ).chrome.storage.local.set(values),
    items,
  );

/** The master's side of the binding, which the local channel writes in the product: its workers and its own record. */
export async function bindMaster(
  host: CloneHost,
  workers: Pick<DownloadsProfile, "profileId" | "name">[],
) {
  const master = host.master.profile;
  if (!master) return;
  const presence = await readJson(
    join(folderOf(host.master.downloads), "peers", master.profileId, "presence.json"),
  );
  const identity = (presence.identity as { key: string }).key;
  const boundAt = Date.now();
  const boundWorkers: Record<string, unknown> = {};
  for (const worker of workers) {
    const pin = await within(async () => pinOf(master, worker), LINK_MS);
    if (!pin) throw new Error(`The master pinned no key for ${worker.name}.`);
    boundWorkers[worker.profileId] = { identity: pin.identity, boundAt, source: "pairing" };
  }
  await store(master, { boundWorkers });
  await store(master, { role: { role: "master", profileId: master.profileId, identity } });
}

/** Everything the clones of a round are linked with: the master and each other. */
export async function waitLinked(host: CloneHost, clones: RoundClone[]) {
  for (const clone of clones) {
    const others = clones.filter((each) => each !== clone).map((each) => each.id);
    for (const peer of [host.master.profileId, ...others]) {
      if (!(await within(() => linkedWith(clone.profile, peer), LINK_MS)))
        throw new Error(`${clone.name} did not link with ${peer}`);
    }
  }
}

/** A and B, up, linked, and (where the master is attached) bound to it. */
export async function openRound(host: CloneHost): Promise<Round> {
  const clonesDir = await host.clonesDir();
  const clones = [await bringUp(host, clonesDir, "A"), await bringUp(host, clonesDir, "B")];
  await waitLinked(host, clones);
  await bindMaster(
    host,
    clones.map((clone) => clone.profile),
  );
  return { host, clonesDir, clones };
}

/** A clone's local storage value under `key`. */
export const localOf = (clone: DownloadsProfile, key: string) =>
  storedIn(clone.serviceWorker, "local", key);

/** The text of a file, empty when it is gone. */
export const textOf = (path: string) => readFile(path, "utf8").catch(() => "");

/** What a reopen printed and left: the same marker, one record block, and the clone attached again. */
export interface Reopened {
  code: number;
  stderr: string;
  ms: number;
  markerBefore: string;
  markerAfter: string;
  blocks: number;
}

/** Stops the clone's Chrome and opens the same clone again through the launcher's reopen path. */
export async function reopen(round: Round, clone: RoundClone): Promise<Reopened> {
  const { host, clonesDir } = round;
  const marker = join(clone.root, ".recnrun-clone");
  const markerBefore = await textOf(marker);
  await host.stop(clone.profile);
  const run = await openClone(host, clonesDir, clone.name);
  const blocks = (await textOf(host.record))
    .split("\n")
    .filter((line) => line === `profileId=${clone.id}`).length;
  if (run.code === 0) {
    clone.profile = await host.attach(clone.root, clone.profile.name, clone.id);
    clone.view = await openViews(clone.profile, host.baseURL);
    clone.log = backgroundLog(clone.profile.context);
  }
  return {
    code: run.code,
    stderr: run.stderr,
    ms: run.ms,
    markerBefore,
    markerAfter: await textOf(marker),
    blocks,
  };
}
