import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { judged } from "./downloads-verdicts.ts";
import type { Sample } from "./downloads-verdicts.ts";
import { recordText, rootIds, runCatalog, waitForToken } from "./e4-launcher.ts";
import type { CatalogRun, RecordEntry } from "./e4-launcher.ts";
import {
  bootstrapTabs,
  bootstrapUrl,
  presenceOf,
  readRegistryIn,
  storedOf,
} from "./e4-profiles.ts";
import type { E4Environment, E4Profile, E4Session } from "./e4-profiles.ts";

/*
 * E4's launcher at work, for the samples in ../e4-samples.ts: it opens each profile's bootstrap page
 * with a token, scans candidate Downloads folders for the presence that carries it, keeps what it
 * learned in its record, and runs catalog.sh once per root; each profile then reads its own root.
 */

const SCAN_MS = 15_000;
const DEFAULT = "<default Downloads>";

/** Each folder's label, so no observation carries a path. */
export type Labels = Map<string, string>;

export const labelOf = (labels: Labels, path: string | null | undefined) =>
  path ? (labels.get(path) ?? "<another folder>") : null;

export const scrub = (text: string, labels: Labels) =>
  [...labels].reduce((out, [path, label]) => out.replaceAll(path, label), text);

export interface Peer {
  profile: E4Profile;
  profileId: string;
  /** Where its Chrome downloads: the harness's ground truth, never the launcher's input. */
  downloads: string;
}

export async function withSession(
  environment: E4Environment,
  run: (session: E4Session, labels: Labels) => Promise<Sample>,
): Promise<Sample> {
  const session = await environment.session();
  try {
    return await run(session, new Map([[session.defaultDownloads, DEFAULT]]));
  } finally {
    await session.dispose();
  }
}

/** A profile on `downloads` (the default when undefined), once its worker announced it there. */
export async function announced(
  session: E4Session,
  name: string,
  downloads?: string,
): Promise<Peer> {
  const profile = await session.launch(name, downloads);
  const where = downloads ?? session.defaultDownloads;
  const { presence } = await presenceOf(profile, where);
  if (!presence) throw new Error(`${name} wrote no presence in the folder its Chrome downloads to`);
  return { profile, profileId: presence.profileId, downloads: where };
}

interface Discovered {
  peer: Peer;
  token: string;
  /** The candidate the scan found the token in. */
  root?: string;
  observation: Record<string, unknown>;
}

/** The launcher's bootstrap: opens the profile's page with a fresh token, then scans the candidates. */
export async function discover(
  session: E4Session,
  peer: Peer,
  candidates: readonly string[],
  labels: Labels,
): Promise<Discovered> {
  const token = randomUUID();
  const opened = await session.open(peer.profile, bootstrapUrl(token));
  const found = await waitForToken(candidates, token, SCAN_MS);
  const tabs = await bootstrapTabs(peer.profile);
  const { root: ownRoot } = await storedOf(peer.profile);
  const observation = {
    opened,
    bootstrapTabs: tabs.length,
    scanned: candidates.map((each) => labelOf(labels, each)),
    foundIn: labelOf(labels, found?.downloads),
    ownRoot: labelOf(labels, ownRoot),
  };
  return { peer, token, root: found?.downloads, observation };
}

export const names = (peers: readonly Peer[], ids: readonly string[]) =>
  ids.map((id) => peers.find((peer) => peer.profileId === id)?.profile.name ?? "<unknown>").sort();

/** A catalog run without paths: exit code, scrubbed stderr, and the profiles and roots it listed. */
export function runSummary(run: CatalogRun, peers: readonly Peer[], labels: Labels) {
  const listed = Object.values(run.registry?.peers ?? {});
  return {
    code: run.code,
    stderr: peers
      .reduce(
        (text, peer) => text.replaceAll(peer.profileId, peer.profile.name),
        scrub(run.stderr, labels),
      )
      .trim(),
    listed: names(
      peers,
      listed.map((peer) => peer.profileId),
    ),
    roots: Object.fromEntries(listed.map((peer) => [names(peers, [peer.profileId])[0], peer.root])),
  };
}

/** Writes the record, runs catalog.sh once per distinct root, and returns each run by root. */
export async function catalogEach(session: E4Session, entries: readonly RecordEntry[]) {
  await writeFile(session.record, recordText(entries));
  const roots = [...new Set(entries.flatMap((entry) => entry.downloadsRoot ?? []))];
  const runs = new Map<string, CatalogRun>();
  for (const root of roots) runs.set(root, await runCatalog(session.record, root));
  return { runs, ids: rootIds(await readFile(session.record, "utf8")) };
}

/** Problems unless every run wrote a registry and every profile reads all of them from its own root. */
export async function published(
  peers: readonly Peer[],
  runs: ReadonlyMap<string, CatalogRun>,
  labels: Labels,
) {
  const problems: string[] = [];
  const everyone = names(
    peers,
    peers.map((peer) => peer.profileId),
  ).join(",");
  const catalog: Record<string, unknown> = {};
  for (const [root, run] of runs) {
    const summary = runSummary(run, peers, labels);
    catalog[labelOf(labels, root) ?? "?"] = summary;
    if (run.code !== 0) problems.push(`catalog.sh exited ${run.code} for ${labelOf(labels, root)}`);
    if (summary.listed.join(",") !== everyone) {
      problems.push(`the registry in ${labelOf(labels, root)} lists ${summary.listed.join(",")}`);
    }
  }
  const reads: Record<string, unknown> = {};
  for (const peer of peers) {
    const own = await readRegistryIn(peer.profile);
    const listed = names(
      peers,
      own.peers.map((each) => each.profileId),
    );
    reads[peer.profile.name] = { reason: own.reason, listed };
    if (own.reason !== "fresh" || listed.join(",") !== everyone) {
      problems.push(
        `${peer.profile.name} read ${own.reason} with ${listed.join(",") || "no peer"}`,
      );
    }
  }
  return { problems, catalog, reads };
}

/** Discovers every profile among the candidates, records each root it found, and publishes. */
export async function discoverAndPublish(
  session: E4Session,
  peers: readonly Peer[],
  candidates: readonly string[],
  labels: Labels,
): Promise<Sample> {
  const problems: string[] = [];
  const discovery: Record<string, unknown> = {};
  const entries: RecordEntry[] = [];
  for (const peer of peers) {
    const found = await discover(session, peer, candidates, labels);
    discovery[peer.profile.name] = found.observation;
    if (found.root !== peer.downloads) {
      problems.push(`${peer.profile.name}'s token was not found in its own Downloads folder`);
    }
    entries.push({
      userDataDir: peer.profile.root,
      profileId: peer.profileId,
      downloadsRoot: found.root,
    });
  }
  if (problems.length > 0) return judged(problems, { discovery });
  const { runs, ids } = await catalogEach(session, entries);
  const result = await published(peers, runs, labels);
  const rootIdsByLabel = Object.fromEntries(
    [...ids].map(([path, id]) => [labelOf(labels, path), id]),
  );
  const observation = {
    discovery,
    rootIds: rootIdsByLabel,
    catalog: result.catalog,
    reads: result.reads,
  };
  return judged(result.problems, observation);
}
